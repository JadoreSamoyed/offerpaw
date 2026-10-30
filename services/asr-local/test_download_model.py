"""Offline downloader regression tests: python -m unittest discover -s services/asr-local -p test_download_model.py."""
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE = Path(__file__).with_name("download_model.py")
module_spec = importlib.util.spec_from_file_location("download_model_under_test", MODULE)
downloader = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(downloader)


def digest(data):
    return hashlib.sha256(data).hexdigest()


class Response(io.BytesIO):
    def __init__(self, body, status=200, headers=None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {}


class InterruptedResponse(Response):
    def read(self, size=-1):
        if self.tell():
            raise OSError("simulated connection interruption")
        return super().read(4)


def archive_bytes(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:bz2") as archive:
        for name, body in entries:
            entry = tarfile.TarInfo(name)
            entry.size = len(body)
            archive.addfile(entry, io.BytesIO(body))
    return output.getvalue()


class DownloaderTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="asr-download-test-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.cache = self.directory / "cache"
        self.cache.mkdir()
        self.cache_patch = patch.object(downloader, "CACHE", self.cache)
        self.cache_patch.start()
        self.addCleanup(self.cache_patch.stop)
        # Unexpected URL opens fail locally: these tests never reach the network.
        self.network_patch = patch.object(downloader.urllib.request, "urlopen",
                                          side_effect=AssertionError("Network disabled in unit tests"))
        self.urlopen = self.network_patch.start()
        self.addCleanup(self.network_patch.stop)
        self.sleep_patch = patch.object(downloader.time, "sleep")
        self.sleep = self.sleep_patch.start()
        self.addCleanup(self.sleep_patch.stop)
        self.output_patch = patch("builtins.print")
        self.output_patch.start()
        self.addCleanup(self.output_patch.stop)
        self.data = b"0123456789abcdef"
        self.destination = self.cache / "encoder.int8.onnx"

    def respond(self, response):
        self.urlopen.side_effect = None
        self.urlopen.return_value = response

    def download(self):
        downloader.download_file("https://models.invalid/model", self.destination,
                                 len(self.data), digest(self.data))

    def asset_spec(self):
        self.files = {"tokens.txt": b"tokens", "encoder.int8.onnx": b"encoder",
                      "decoder.int8.onnx": b"decoder", "test_wavs/0.wav": b"test audio"}
        return {"name": "test-model", "files": list(self.files)[:-1],
                "testAudio": "test_wavs/0.wav", "assets": [
                    {"path": name, "bytes": len(body), "sha256": digest(body),
                     "url": "https://models.invalid/" + name}
                    for name, body in self.files.items()]}

    def tar_spec(self, body):
        return {"name": "test-model", "files": ["tokens.txt"], "testAudio": "test_wavs/0.wav",
                "url": "https://models.invalid/archive", "archiveBytes": len(body), "sha256": digest(body)}

    def test_partial_download_resumes_with_206(self):
        partial = self.destination.with_suffix(".onnx.part")
        partial.write_bytes(self.data[:4])
        self.respond(Response(self.data[4:], 206, {"Content-Range": "bytes 4-15/16"}))
        self.download()
        self.assertEqual(self.urlopen.call_args.args[0].get_header("Range"), "bytes=4-")
        self.assertEqual(self.destination.read_bytes(), self.data)
        self.assertFalse(partial.exists())

    def test_server_ignoring_range_200_restarts_instead_of_appending(self):
        self.destination.with_suffix(".onnx.part").write_bytes(self.data[:4])
        self.respond(Response(self.data, 200))
        self.download()
        self.assertEqual(self.urlopen.call_args.args[0].get_header("Range"), "bytes=4-")
        self.assertEqual(self.destination.read_bytes(), self.data)

    def test_interrupted_connection_retries_from_saved_offset(self):
        self.urlopen.side_effect = [InterruptedResponse(self.data),
                                   Response(self.data[4:], 206, {"Content-Range": "bytes 4-15/16"})]
        self.download()
        self.assertIsNone(self.urlopen.call_args_list[0].args[0].get_header("Range"))
        self.assertEqual(self.urlopen.call_args_list[1].args[0].get_header("Range"), "bytes=4-")
        self.assertEqual(self.destination.read_bytes(), self.data)
        self.sleep.assert_called_once_with(1)

    def test_wrong_content_range_is_rejected_before_appending(self):
        partial = self.destination.with_suffix(".onnx.part")
        partial.write_bytes(self.data[:4])
        self.respond(Response(self.data[3:], 206, {"Content-Range": "bytes 3-15/16"}))
        with self.assertRaisesRegex(RuntimeError, "byte range"):
            self.download()
        self.assertEqual(partial.read_bytes(), self.data[:4])
        self.assertFalse(self.destination.exists())

    def test_bad_hash_never_replaces_existing_destination(self):
        old = b"previously installed model"
        self.destination.write_bytes(old)
        self.respond(Response(b"x" * len(self.data)))
        with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
            self.download()
        self.assertEqual(self.destination.read_bytes(), old)

    def test_verified_destination_does_not_download(self):
        self.destination.write_bytes(self.data)
        self.download()
        self.urlopen.assert_not_called()

    def test_same_size_corrupt_destination_is_repaired(self):
        self.destination.write_bytes(b"x" * len(self.data))
        self.respond(Response(self.data))
        self.download()
        self.assertEqual(self.destination.read_bytes(), self.data)
        self.urlopen.assert_called_once()

    def test_assets_already_correct_are_verified_without_download(self):
        spec = self.asset_spec()
        model = self.cache / spec["name"]
        for name, body in self.files.items():
            path = model / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        with patch.object(downloader, "SPEC", spec):
            downloader.main()
            self.assertTrue(downloader.installed_model_is_verified(model))
        self.urlopen.assert_not_called()
        installed = json.loads((self.cache / "installed-model.json").read_text(encoding="utf-8"))
        self.assertEqual(installed["source"], spec)

    def test_bad_asset_hash_does_not_publish_installation(self):
        spec = self.asset_spec()
        self.respond(Response(b"xxxxxx"))  # Correct tokens.txt size, wrong pinned digest.
        with patch.object(downloader, "SPEC", spec):
            with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                downloader.main()
        self.assertFalse((self.cache / spec["name"] / "tokens.txt").exists())
        self.assertFalse((self.cache / "installed-model.json").exists())

    def test_asset_path_traversal_is_rejected_without_download(self):
        spec = self.asset_spec()
        for unsafe in ("../outside.bin", str(self.directory / "outside.bin")):
            with self.subTest(path=unsafe):
                spec["assets"][0]["path"] = unsafe
                with patch.object(downloader, "SPEC", spec):
                    with self.assertRaisesRegex(RuntimeError, "asset path"):
                        downloader.main()
        self.urlopen.assert_not_called()
        self.assertFalse((self.cache / "outside.bin").exists())
        self.assertFalse((self.directory / "outside.bin").exists())
        self.assertFalse((self.cache / "installed-model.json").exists())

    def test_archive_path_traversal_is_rejected_without_writing_outside_model(self):
        body = archive_bytes([("test-model/../../outside.bin", b"must not escape")])
        spec = self.tar_spec(body)
        self.respond(Response(body))
        with patch.object(downloader, "SPEC", spec):
            with self.assertRaisesRegex(RuntimeError, "archive path"):
                downloader.main()
        self.assertFalse((self.directory / "outside.bin").exists())
        self.assertFalse((self.cache / "installed-model.json").exists())

    def test_verified_archive_is_retained_and_repairs_tampered_installed_file(self):
        body = archive_bytes([("test-model/tokens.txt", b"tokens"),
                              ("test-model/test_wavs/0.wav", b"test audio")])
        spec = self.tar_spec(body)
        self.respond(Response(body))
        with patch.object(downloader, "SPEC", spec):
            downloader.main()
            model = self.cache / spec["name"]
            self.assertTrue(downloader.installed_model_is_verified(model))
            archive = self.cache / (spec["name"] + ".tar.bz2")
            self.assertEqual(archive.read_bytes(), body)
            self.urlopen.reset_mock()
            self.urlopen.side_effect = AssertionError("Verified archive must be reused")
            # A correct install does not even reopen the archive for extraction.
            with patch.object(downloader.tarfile, "open", side_effect=AssertionError("Unexpected extraction")):
                downloader.main()
            (model / "tokens.txt").write_bytes(b"broken")
            self.assertFalse(downloader.installed_model_is_verified(model))
            downloader.main()
            self.assertEqual((model / "tokens.txt").read_bytes(), b"tokens")
            self.assertTrue(downloader.installed_model_is_verified(model))
        self.urlopen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
