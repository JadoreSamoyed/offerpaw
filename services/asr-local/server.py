"""Streaming Chinese/English ASR sidecar. Recognition stays in this process."""
import argparse
import asyncio
import base64
import binascii
import hmac
import ipaddress
import json
import logging
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import sherpa_onnx
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed
from hybrid import HybridRecognizer, HybridRecognitionSession
from health import readiness_response
from speakers import SpeakerSession, make_extractor, normalize_embedding, MODEL_ID, DEFAULT_MODEL_PATH

LOG = logging.getLogger("local-asr")
ROOT = Path(__file__).resolve().parents[2]
MODEL_NAME = json.loads(Path(__file__).with_name("model.json").read_text(encoding="utf-8"))["name"]


def make_recognizer(model_dir, threads=2, endpoint_silence=0.55, enable_endpoint_detection=True):
    model_dir = Path(model_dir)
    if (model_dir / "text").exists() or (model_dir / "endpoint").exists():
        return HybridRecognizer(
            make_recognizer(model_dir / "text", threads, endpoint_silence, False),
            make_recognizer(model_dir / "endpoint", threads, endpoint_silence, True),
        )
    paraformer = not (model_dir / "joiner.int8.onnx").is_file()
    files = ("tokens.txt", "encoder.int8.onnx", "decoder.int8.onnx") if paraformer else (
        "tokens.txt", "encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx")
    for filename in files:
        if not (model_dir / filename).is_file():
            raise FileNotFoundError(f"Missing {model_dir / filename}; run scripts/setup-local-asr.ps1")
    options = dict(
        tokens=str(model_dir / "tokens.txt"),
        encoder=str(model_dir / "encoder.int8.onnx"),
        decoder=str(model_dir / ("decoder.int8.onnx" if paraformer else "decoder.onnx")),
        num_threads=threads, sample_rate=16000, feature_dim=80,
        decoding_method="greedy_search", provider="cpu",
        enable_endpoint_detection=enable_endpoint_detection,
        rule1_min_trailing_silence=1.2,
        # sherpa 1.13.8 Paraformer timestamps a nonblank at the START of its
        # 600 ms chunk, then tests endpoints AFTER advancing that chunk. Without
        # compensating this bias, a 550 ms rule cuts even continuously spoken text.
        # online-recognizer-paraformer-impl.h: last_non_blank_frame_index.
        rule2_min_trailing_silence=endpoint_silence + (0.6 if paraformer else 0),
        rule3_min_utterance_length=20.0,
    )
    if paraformer:
        return sherpa_onnx.OnlineRecognizer.from_paraformer(**options)
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        **options, joiner=str(model_dir / "joiner.int8.onnx"))


class RecognitionSession:
    """Called only on the dedicated inference worker, in audio order."""

    def __init__(self, recognizer, sample_rate, generation, speaker=None):
        self.recognizer = recognizer
        self.sample_rate = sample_rate
        self.speaker = speaker
        self.clear(generation)

    def clear(self, generation):
        self.stream = self.recognizer.create_stream()
        self.generation = generation
        self.session_id = uuid.uuid4().hex
        self.segment = 0
        self.last_text = ""
        if self.speaker is not None:
            self.speaker.reset_segment()

    def event(self, kind, text):
        metadata = self.speaker.classify(final=kind == "transcript.final") if self.speaker is not None else {
            "speaker": "unknown", "speakerReason": "unavailable"}
        return {"type": kind, "id": f"{self.session_id}-{self.segment}",
                "text": text, "generation": self.generation, **metadata,
                "speakerSource": "voice" if self.speaker is not None else "unavailable"}

    def append(self, pcm):
        # Keeping ONE stream is important: sherpa's resampler retains phase across frames.
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        events = []
        step = max(1, self.sample_rate // 10)
        for offset in range(0, len(samples), step):
            frame = samples[offset:offset + step]
            if self.speaker is not None:
                self.speaker.append(memoryview(pcm)[offset * 2:(offset + len(frame)) * 2])
            self.stream.accept_waveform(self.sample_rate, frame)
            events.extend(self.decode())
        return events

    def decode(self, finish=False):
        events = []
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)
            text = self.recognizer.get_result(self.stream).strip()
            if text and text != self.last_text:
                events.append(self.event("transcript.partial", text))
                self.last_text = text
            if not finish and self.recognizer.is_endpoint(self.stream):
                if text:
                    events.append(self.event("transcript.final", text))
                self.recognizer.reset(self.stream)
                self.segment += 1
                self.last_text = ""
                if self.speaker is not None:
                    self.speaker.reset_segment()
        return events

    def stop(self):
        # Supply right context before input_finished so the last words aren't truncated.
        self.stream.accept_waveform(self.sample_rate, np.zeros(int(self.sample_rate * 0.8), dtype=np.float32))
        self.stream.input_finished()
        if self.recognizer.config.model_config.paraformer.encoder:
            # input_finished alone does not enable Paraformer's short final block.
            self.stream.set_option("is_final", "1")
        events = self.decode(finish=True)
        text = self.recognizer.get_result(self.stream).strip()
        if text:
            events.append(self.event("transcript.final", text))
        return events


def generation_of(message):
    generation = message.get("generation", 0)
    if type(generation) is not int or generation < 0 or generation > 2**53 - 1:
        raise ValueError("generation must be a non-negative safe integer")
    return generation


def candidate_embedding(message):
    profile = message.get("voiceProfile")
    if profile is None:
        return None
    if (not isinstance(profile, dict) or type(profile.get("version")) is not int or
            profile.get("version") != 1 or profile.get("model") != MODEL_ID or
            not isinstance(profile.get("embedding"), list) or
            any(type(value) not in (int, float) for value in profile["embedding"])):
        raise ValueError("Invalid voice profile")
    return normalize_embedding(profile["embedding"])


async def run_server(args):
    # A single bounded worker serializes shared model access and keeps JSON/socket I/O responsive.
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr-inference")
    loop = asyncio.get_running_loop()

    async def infer(function, *values):
        return await loop.run_in_executor(executor, function, *values)

    recognizer = await infer(make_recognizer, args.model_dir, args.threads, args.endpoint_silence)
    # Optional model: ordinary/manual ASR remains usable when voice enrollment is unavailable.
    extractor = await infer(make_extractor) if DEFAULT_MODEL_PATH.is_file() else None
    session_factory = HybridRecognitionSession if isinstance(recognizer, HybridRecognizer) else RecognitionSession
    model_name = args.model_dir.name
    active = 0

    async def send(socket, event):
        await socket.send(json.dumps(event, ensure_ascii=False))

    async def handler(socket):
        nonlocal active
        if active >= args.max_sessions:
            await send(socket, {"type": "error", "code": "capacity", "message": "Local ASR is busy"})
            await socket.close(code=1013, reason="Local ASR capacity")
            return
        active += 1
        session = None
        speaker = None
        enrolling = False
        last_seq = -1
        try:
            raw = await asyncio.wait_for(socket.recv(), timeout=10)
            message = json.loads(raw)
            if not isinstance(message, dict) or message.get("type") != "session.start":
                raise ValueError("First message must be session.start")
            if args.token and (not isinstance(message.get("token"), str) or
                               not hmac.compare_digest(message["token"], args.token)):
                await send(socket, {"type": "error", "code": "unauthorized", "message": "Invalid local ASR token"})
                await socket.close(code=1008, reason="Unauthorized")
                return
            rate = message.get("sampleRate")
            if type(rate) is not int or rate not in (8000, 16000, 24000, 32000, 44100, 48000):
                raise ValueError("sampleRate must be 8000, 16000, 24000, 32000, 44100 or 48000")
            embedding = candidate_embedding(message)
            if type(message.get("enrollSpeaker", False)) is not bool:
                raise ValueError("enrollSpeaker must be boolean")
            enrolling = message.get("enrollSpeaker", False) and extractor is not None
            if extractor is not None:
                speaker = await infer(SpeakerSession, extractor, rate, embedding)
            session = await infer(session_factory, recognizer, rate, generation_of(message), speaker)
            await send(socket, {"type": "session.ready", "sampleRate": rate,
                                "generation": session.generation, "model": model_name,
                                "speakerSupported": extractor is not None})
            async for raw in socket:
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise ValueError("Messages must be JSON objects")
                kind = message.get("type")
                if kind == "audio.append":
                    if "generation" in message and generation_of(message) != session.generation:
                        continue  # Discard queued audio from before a clear.
                    seq = message.get("seq")
                    if type(seq) is not int or seq < 0 or seq <= last_seq:
                        raise ValueError("audio seq must be a strictly increasing non-negative integer")
                    encoded = message.get("audio")
                    if not isinstance(encoded, str) or len(encoded) > 64000:
                        raise ValueError("audio must be base64 PCM16LE mono")
                    pcm = base64.b64decode(encoded, validate=True)
                    if len(pcm) == 0 or len(pcm) % 2 or len(pcm) > rate:
                        raise ValueError("Audio frame must contain 1-500 ms of PCM16LE mono")
                    last_seq = seq
                    if enrolling:
                        await infer(speaker.append, pcm)
                    else:
                        for event in await infer(session.append, pcm):
                            await send(socket, event)
                elif kind == "session.clear":
                    await infer(session.clear, generation_of(message))
                    last_seq = -1  # Both restarting at 0 and continuing sequence are valid.
                    await send(socket, {"type": "session.ready", "sampleRate": rate,
                                        "generation": session.generation, "model": model_name,
                                        "speakerSupported": extractor is not None})
                elif kind == "speaker.enroll.finish":
                    if "generation" in message and generation_of(message) != session.generation:
                        continue
                    if not enrolling or speaker is None:
                        await send(socket, {"type": "speaker.enrollment.failed", "code": "invalid_audio",
                                            "generation": session.generation})
                        continue
                    try:
                        profile = await infer(speaker.enroll)
                    except ValueError as error:
                        code = "too_short" if "至少" in str(error) else "inconsistent" if "不一致" in str(error) else "invalid_audio"
                        await infer(speaker.reset_segment)
                        await send(socket, {"type": "speaker.enrollment.failed", "code": code,
                                            "generation": session.generation})
                        continue
                    enrolling = False
                    await infer(session.clear, session.generation)
                    await send(socket, {"type": "speaker.enrolled", "profile": profile,
                                        "generation": session.generation})
                elif kind == "speaker.enroll.cancel":
                    if "generation" in message and generation_of(message) != session.generation:
                        continue
                    enrolling = False
                    await infer(session.clear, session.generation)
                elif kind == "session.stop":
                    if not enrolling:
                        for event in await infer(session.stop):
                            await send(socket, event)
                    await send(socket, {"type": "session.stopped", "generation": session.generation})
                    await socket.close(code=1000, reason="Session stopped")
                    return
                else:
                    raise ValueError("Unknown message type")
        except ConnectionClosed:
            pass
        except (ValueError, TypeError, binascii.Error, asyncio.TimeoutError) as error:
            await send(socket, {"type": "error", "code": "invalid_request", "message": str(error) or "Handshake timed out"})
            await socket.close(code=1008, reason="Invalid request")
        except Exception:
            LOG.exception("Local ASR session failed")
            try:
                await send(socket, {"type": "error", "code": "recognition_failed", "message": "Local ASR recognition failed"})
                await socket.close(code=1011, reason="Recognition failed")
            except ConnectionClosed:
                pass
        finally:
            active -= 1

    try:
        async with serve(handler, args.host, args.port, max_size=65536, max_queue=8,
                         ping_interval=20, ping_timeout=20, compression=None,
                         process_request=lambda connection, request: readiness_response(
                             connection, request, model_name, extractor is not None),
                         origins=[None]):
            LOG.info("Ready ws://%s:%s model=%s endpoint_silence=%.2fs token=%s",
                     args.host, args.port, model_name, args.endpoint_silence, bool(args.token))
            await asyncio.Future()
    finally:
        executor.shutdown(wait=True, cancel_futures=True)


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.getenv("LOCAL_ASR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("LOCAL_ASR_PORT", "8765")))
    parser.add_argument("--model-dir", type=Path, default=Path(os.getenv("LOCAL_ASR_MODEL_DIR", str(ROOT / ".cache" / "asr" / MODEL_NAME))))
    parser.add_argument("--threads", type=int, default=int(os.getenv("LOCAL_ASR_THREADS", "2")))
    parser.add_argument("--endpoint-silence", type=float, default=float(os.getenv("LOCAL_ASR_ENDPOINT_SILENCE", "0.55")))
    parser.add_argument("--max-sessions", type=int, default=2)
    args = parser.parse_args()
    args.token = os.getenv("LOCAL_ASR_TOKEN", "")
    try:
        local = args.host == "localhost" or ipaddress.ip_address(args.host).is_loopback
    except ValueError:
        local = False
    if not local and len(args.token) < 32:
        parser.error("Non-loopback binding requires LOCAL_ASR_TOKEN with at least 32 characters")
    if args.threads < 1 or args.max_sessions < 1 or not 0.2 <= args.endpoint_silence <= 3.0:
        parser.error("threads/max-sessions must be positive; endpoint-silence must be 0.2-3 seconds")
    return args


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        asyncio.run(run_server(parse_args()))
    except KeyboardInterrupt:
        pass
