"""Serial streaming text recognition with a separate endpoint recognizer.

Construct the text recognizer with its own endpoint detection disabled. All
session methods must run on the sidecar's existing inference worker; this module
does not create threads, wait for audio, or perform any model/network loading.
"""
import uuid

import numpy as np


class HybridRecognizer:
    def __init__(self, text_recognizer, endpoint_recognizer):
        self.text_recognizer = text_recognizer
        self.endpoint_recognizer = endpoint_recognizer


class _AcousticEndpointGuard:
    """Veto token-blank endpoints while audio still has appreciable energy.

    This is an endpoint safeguard, not speech or speaker classification. The
    existing model still decides ordinary endpoints; its 550 ms blank rule
    normally already includes the 200 ms quiet evidence required here. The
    20-second cap matches the recognizer's utterance limit and keeps noise from
    retaining one stream indefinitely. No PCM is retained by this guard.
    """
    MIN_RMS = 0.006
    QUIET_SECONDS = 0.2
    MAX_SEGMENT_SECONDS = 20.0

    def __init__(self, sample_rate):
        self.frame_samples = max(1, sample_rate // 50)
        self.quiet_required = max(1, round(sample_rate * self.QUIET_SECONDS))
        self.segment_limit = max(1, round(sample_rate * self.MAX_SEGMENT_SECONDS))
        self.segment_samples = 0
        self.quiet_samples = 0
        self.pending_samples = 0
        self.pending_energy = 0.0

    def append(self, samples):
        self.segment_samples += len(samples)
        offset = 0
        while offset < len(samples):
            count = min(len(samples) - offset, self.frame_samples - self.pending_samples)
            chunk = samples[offset:offset + count]
            self.pending_energy += float(np.dot(chunk, chunk))
            self.pending_samples += count
            offset += count
            # Fresh sound must veto a cut even in an incomplete 20 ms frame.
            quiet = self.pending_energy < self.MIN_RMS ** 2 * self.pending_samples
            if not quiet:
                self.quiet_samples = 0
            if self.pending_samples == self.frame_samples:
                if quiet:
                    self.quiet_samples += self.pending_samples
                self.pending_samples = 0
                self.pending_energy = 0.0

    def allows(self, model_endpoint):
        return self.segment_samples >= self.segment_limit or (
            model_endpoint and self.quiet_samples >= self.quiet_required)


class HybridRecognitionSession:
    def __init__(self, bundle, sample_rate, generation, speaker=None):
        if type(sample_rate) is not int or sample_rate <= 0:
            raise ValueError("sample_rate must be a positive integer")
        self.bundle = bundle
        self.sample_rate = sample_rate
        self.frame_samples = max(1, sample_rate // 10)
        self.speaker = speaker
        self.clear(generation)

    def _new_streams(self):
        # Recreating both streams also discards Paraformer's is_final option,
        # feature/CIF caches, and finished-input state from the previous segment.
        self.endpoint_stream = self.bundle.endpoint_recognizer.create_stream()
        self.text_stream = self.bundle.text_recognizer.create_stream()
        self.endpoint_guard = _AcousticEndpointGuard(self.sample_rate)
        self.last_text = ""
        if self.speaker is not None:
            self.speaker.reset_segment()

    def clear(self, generation):
        self._new_streams()
        self.generation = generation
        self.session_id = uuid.uuid4().hex
        self.segment = 0
        self.stopped = False

    def event(self, kind, text):
        metadata = self.speaker.classify(final=kind == "transcript.final") if self.speaker is not None else {
            "speaker": "unknown", "speakerReason": "unavailable"}
        return {"type": kind, "id": f"{self.session_id}-{self.segment}",
                "text": text, "generation": self.generation, **metadata,
                "speakerSource": "voice" if self.speaker is not None else "unavailable"}

    def _decode_text(self):
        events = []
        recognizer = self.bundle.text_recognizer
        while recognizer.is_ready(self.text_stream):
            recognizer.decode_stream(self.text_stream)
            text = recognizer.get_result(self.text_stream).strip()
            if text and text != self.last_text:
                events.append(self.event("transcript.partial", text))
                self.last_text = text
        return events

    def _finish_text(self):
        # input_finished alone does not enable Paraformer's final short chunk.
        # No extra silence or real-time wait is needed at a detected endpoint.
        self.text_stream.set_option("is_final", "1")
        self.text_stream.input_finished()
        events = self._decode_text()
        text = self.bundle.text_recognizer.get_result(self.text_stream).strip()
        if text:
            events.append(self.event("transcript.final", text))
        return events

    def append(self, pcm):
        if self.stopped:
            raise RuntimeError("Cannot append audio after session.stop")
        if len(pcm) % 2:
            raise ValueError("Audio must be PCM16LE mono")
        # Convert once; both streams receive the same bounded float32 frame view.
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
        samples /= 32768.0
        events = []
        detector = self.bundle.endpoint_recognizer
        for offset in range(0, len(samples), self.frame_samples):
            frame = samples[offset:offset + self.frame_samples]
            self.endpoint_guard.append(frame)
            if self.speaker is not None:
                self.speaker.append(memoryview(pcm)[offset * 2:(offset + len(frame)) * 2])
            self.endpoint_stream.accept_waveform(self.sample_rate, frame)
            self.text_stream.accept_waveform(self.sample_rate, frame)
            while detector.is_ready(self.endpoint_stream):
                detector.decode_stream(self.endpoint_stream)
            events.extend(self._decode_text())
            if self.endpoint_guard.allows(detector.is_endpoint(self.endpoint_stream)):
                events.extend(self._finish_text())
                self.segment += 1
                self._new_streams()
                # Continue this packet with the fresh streams: an endpoint in a
                # 500 ms packet must not discard the remaining 100 ms frames.
        return events

    def stop(self):
        if self.stopped:
            return []
        self.stopped = True
        # Explicit stop follows the production sidecar's 0.8 s right-context
        # convention. Only the text model needs this final padding.
        self.text_stream.accept_waveform(
            self.sample_rate, np.zeros(int(self.sample_rate * 0.8), dtype=np.float32))
        return self._finish_text()
