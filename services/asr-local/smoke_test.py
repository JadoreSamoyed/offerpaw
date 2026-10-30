"""Real-model smoke test, optionally paced in real time; never calls a cloud API."""
import argparse
import asyncio
import base64
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

ROOT = Path(__file__).resolve().parents[2]
SPEC = json.loads(Path(__file__).with_name("model.json").read_text(encoding="utf-8"))


def load_wave(path, rate):
    with wave.open(str(path), "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError("Test WAV must be mono PCM16")
        native_rate = source.getframerate()
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2")
    if rate != native_rate:
        # Offline fixture conversion only. The production server uses sherpa's continuous resampler.
        positions = np.arange(round(len(samples) * rate / native_rate)) * native_rate / rate
        samples = np.rint(np.interp(positions, np.arange(len(samples)), samples)).astype("<i2")
    return samples


async def exercise(url, token, path, rate, expected, realtime):
    samples = load_wave(path, rate)
    step = rate // 50
    energy = [np.sqrt(np.mean(samples[i:i + step].astype(np.float64) ** 2)) / 32768
              for i in range(0, len(samples), step)]
    voiced = [i for i, rms in enumerate(energy) if rms > 0.008]
    speech_end = min(len(samples) / rate, (voiced[-1] + 1) * 0.02) if voiced else 0
    audio = np.concatenate([samples, np.zeros(int(rate * 1.6), dtype="<i2")]).astype("<i2").tobytes()
    async with connect(url, max_size=65536, compression=None, proxy=None) as ws:
        await ws.send(json.dumps({"type": "session.start", "sampleRate": rate, "token": token, "generation": 0}))
        ready = json.loads(await ws.recv())
        assert ready["type"] == "session.ready", ready
        silence = base64.b64encode(bytes(step * 2)).decode("ascii")
        await ws.send(json.dumps({"type": "audio.append", "seq": 9, "generation": 0, "audio": silence}))
        # An acknowledged reset must change the generation before accepting fresh audio.
        await ws.send(json.dumps({"type": "session.clear", "generation": 1}))
        cleared = json.loads(await ws.recv())
        assert cleared["type"] == "session.ready" and cleared["generation"] == 1, cleared
        # A late old-generation frame cannot corrupt the new sequence or recognizer.
        await ws.send(json.dumps({"type": "audio.append", "seq": 999, "generation": 0, "audio": silence}))
        started = time.perf_counter()
        events = []

        async def receive():
            async for raw in ws:
                event = json.loads(raw)
                event["receivedMs"] = round((time.perf_counter() - started) * 1000, 1)
                events.append(event)
                assert event["type"] != "error", event
                assert event.get("generation") == 1, event
                if event["type"] == "session.stopped":
                    return

        receiver = asyncio.create_task(receive())
        for seq, offset in enumerate(range(0, len(audio), step * 2)):
            if realtime:
                available = min(offset + step * 2, len(audio)) / 2 / rate
                await asyncio.sleep(max(0, started + available - time.perf_counter()))
            await ws.send(json.dumps({"type": "audio.append", "seq": seq,
                                      "audio": base64.b64encode(audio[offset:offset + step * 2]).decode("ascii")}))
            if not realtime:
                await asyncio.sleep(0)
        await ws.send(json.dumps({"type": "session.stop"}))
        await asyncio.wait_for(receiver, 60)
        finals = [event for event in events if event["type"] == "transcript.final"]
        partials = [event for event in events if event["type"] == "transcript.partial"]
        text = "".join(event["text"] for event in finals)
        assert len(partials) >= 2, f"No streaming partial updates: {events}"
        assert finals and re.search(r"[\u4e00-\u9fff]", text), f"No Chinese final: {events}"
        assert expected.casefold() in text.casefold(), f"Expected {expected!r}; got {text!r}"
        assert len({event["id"] for event in finals}) == len(finals), "Duplicate final segment ID"
        result = {"sampleRate": rate, "model": ready.get("model"), "audioSeconds": round(len(samples) / rate, 3),
                  "elapsedSeconds": round(time.perf_counter() - started, 3),
                  "partialCount": len(partials), "finalText": text, "events": events}
        if realtime:
            result["estimatedSpeechEndMs"] = round(speech_end * 1000, 1)
            result["lastFinalAfterEstimatedSpeechEndMs"] = round(finals[-1]["receivedMs"] - speech_end * 1000, 1)
            result["measurementNote"] = "20ms paced frames; last final minus last source 20ms frame with RMS>0.008; synthetic/file playback, not microphone measurement"
        return result


async def check_protocol(url, token):
    if token:
        async with connect(url, proxy=None) as ws:
            await ws.send(json.dumps({"type": "session.start", "sampleRate": 24000, "token": "wrong-token"}))
            error = json.loads(await ws.recv())
            assert error.get("code") == "unauthorized", error
    try:
        async with connect(url, origin="https://example.test", proxy=None):
            raise AssertionError("A browser Origin must be rejected")
    except InvalidStatus as error:
        assert error.response.status_code == 403, error
    async with connect(url, proxy=None) as ws:
        await ws.send(json.dumps({"type": "session.start", "sampleRate": 123, "token": token}))
        error = json.loads(await ws.recv())
        assert error.get("code") == "invalid_request", error


async def main(args):
    process = None
    logfile = None
    token = os.getenv("LOCAL_ASR_TOKEN", "")
    url = args.url
    if not url:
        token = secrets.token_urlsafe(32)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        url = f"ws://127.0.0.1:{port}"
        logfile = (ROOT / ".cache" / "asr" / "smoke-server.log").open("w", encoding="utf-8")
        command = [sys.executable, "-X", "utf8", str(Path(__file__).with_name("server.py")), "--port", str(port)]
        if args.model_dir:
            command += ["--model-dir", str(args.model_dir.resolve())]
        process = subprocess.Popen(command,
                                   stdout=logfile, stderr=logfile,
                                   env={**os.environ, "LOCAL_ASR_TOKEN": token},
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    try:
        if process:
            for _ in range(120):
                if process.poll() is not None:
                    raise RuntimeError("Sidecar failed to start; see .cache/asr/smoke-server.log")
                try:
                    async with connect(url, proxy=None):
                        pass
                    break
                except OSError:
                    await asyncio.sleep(1)
            else:
                raise TimeoutError("Model did not become ready within 120s")
        results = []
        await check_protocol(url, token)
        for rate in args.sample_rates:
            result = await exercise(url, token, args.wav, rate, args.expect, args.realtime)
            results.append(result)
            print(json.dumps({key: value for key, value in result.items() if key != "events"}, ensure_ascii=False), flush=True)
        output = ROOT / ".cache" / "asr" / "smoke-results.json"
        output.write_text(json.dumps({"input": str(args.wav), "model": results[0]["model"], "results": results}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"PASS: real Chinese partial/final inference, reset generation and input resampling. Report: {output}", flush=True)
    finally:
        if process:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if logfile:
            logfile.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help="Existing sidecar; otherwise start an isolated temporary server")
    parser.add_argument("--model-dir", type=Path, help="Candidate model for an isolated test server")
    parser.add_argument("--wav", type=Path, default=ROOT / ".cache" / "asr" / SPEC["name"] / SPEC["testAudio"])
    parser.add_argument("--expect", default=SPEC.get("testExpected", "研究感兴趣"))
    parser.add_argument("--sample-rates", nargs="+", type=int, default=[16000, 24000])
    parser.add_argument("--realtime", action="store_true", help="Pace 20ms chunks and estimate endpoint latency")
    asyncio.run(main(parser.parse_args()))
