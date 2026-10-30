"""Download and verify the pinned public model; never reads application secrets."""
import hashlib
import json
import shutil
import tarfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = json.loads(Path(__file__).with_name("model.json").read_text(encoding="utf-8"))
CACHE = ROOT / ".cache" / "asr"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def download_file(url, destination, size, digest):
    """Resume interrupted public downloads, then verify the full pinned artifact."""
    if destination.is_file() and destination.stat().st_size == size and sha256(destination) == digest:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    for attempt in range(3):
        offset = partial.stat().st_size if partial.is_file() else 0
        if offset >= size:
            offset = 0
        request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-"} if offset else {})
        try:
            with urllib.request.urlopen(request, timeout=60) as source:
                resumed = offset > 0 and source.status == 206
                if resumed and not source.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
                    raise RuntimeError("Unexpected download byte range; not installed")
                with partial.open("ab" if resumed else "wb") as target:
                    shutil.copyfileobj(source, target, 1024 * 1024)
            if partial.stat().st_size != size or sha256(partial) != digest:
                raise RuntimeError(f"Download size/SHA-256 mismatch: {destination.name}; not installed")
            partial.replace(destination)
            return
        except (OSError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def installed_model_is_verified(model):
    """A manifest alone isn't sufficient: rehash every installed file each run."""
    try:
        installed = json.loads((CACHE / "installed-model.json").read_text(encoding="utf-8"))
        if installed["source"] != SPEC:
            return False
        files = installed["files"]
        if not isinstance(files, list) or not files:
            return False
        verified = set()
        for entry in files:
            relative = entry["path"]
            if not isinstance(relative, str) or relative in verified:
                return False
            path = (model / relative).resolve()
            if not path.is_relative_to(model.resolve()) or not path.is_file():
                return False
            if path.stat().st_size != entry["bytes"] or sha256(path) != entry["sha256"]:
                return False
            verified.add(relative)
        return set(SPEC["files"] + [SPEC["testAudio"]]).issubset(verified)
    except (OSError, ValueError, TypeError, KeyError):
        return False


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    model = CACHE / SPEC["name"]
    if SPEC.get("assets"):
        manifest = []
        for asset in SPEC["assets"]:
            destination = (model / asset["path"]).resolve()
            if not destination.is_relative_to(model.resolve()):
                raise RuntimeError("Unexpected model asset path")
            print(f'Verifying/downloading {asset["path"]} ({asset["bytes"]:,} bytes)...', flush=True)
            download_file(asset["url"], destination, asset["bytes"], asset["sha256"])
            manifest.append({key: asset[key] for key in ("path", "bytes", "sha256")})
        required = set(SPEC["files"] + [SPEC["testAudio"]])
        if not required.issubset({entry["path"] for entry in manifest}):
            raise RuntimeError("Required model assets missing from pinned manifest")
        (CACHE / "installed-model.json").write_text(json.dumps({
            "source": SPEC, "files": manifest,
        }, indent=2) + "\n", encoding="utf-8")
        print(f"Verified and installed model: {model}", flush=True)
        return
    archive = CACHE / (SPEC["name"] + ".tar.bz2")
    print(f'Verifying/downloading {SPEC["archiveBytes"]:,} bytes from official k2-fsa release...', flush=True)
    download_file(SPEC["url"], archive, SPEC["archiveBytes"], SPEC["sha256"])
    if installed_model_is_verified(model):
        print(f"Verified existing archive and all installed model files; extraction skipped: {model}", flush=True)
        return
    manifest = []
    with tarfile.open(archive, "r:bz2") as bundle:
        for member in bundle.getmembers():
            # Extract only regular files beneath the expected archive root; never links.
            destination = (CACHE / member.name).resolve()
            if not destination.is_relative_to(model.resolve()):
                raise RuntimeError(f"Unexpected archive path: {member.name}")
            if not member.isfile():
                if member.isdir():
                    continue
                raise RuntimeError(f"Unsupported archive entry: {member.name}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            with bundle.extractfile(member) as source, destination.open("wb") as target:
                shutil.copyfileobj(source, target)
            manifest.append({"path": destination.relative_to(model).as_posix(),
                             "bytes": destination.stat().st_size, "sha256": sha256(destination)})
    for filename in SPEC["files"] + [SPEC["testAudio"]]:
        if not (model / filename).is_file():
            raise RuntimeError(f"Required file missing: {filename}")
    (CACHE / "installed-model.json").write_text(json.dumps({
        "source": SPEC, "files": manifest,
    }, indent=2) + "\n", encoding="utf-8")
    print(f"Verified and installed model: {model}", flush=True)


if __name__ == "__main__":
    main()
    from install_speaker_model import install_speaker_model
    install_speaker_model()
