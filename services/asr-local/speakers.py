"""Local acoustic candidate verification with a deliberately uncertain result.

This is a two-party interview aid, not general diarization: a sufficiently
different voice is labelled ``interviewer`` under that two-party assumption.
Short/quiet speech, uncertain cosine scores, and conflicting recent windows
remain ``unknown``. The classifier cannot reliably separate overlapping voices.
Call on the ASR inference worker, feed precisely the same segment audio as ASR,
and reset_segment at every ASR endpoint (including endpoints without text).

Only a normalized embedding needs to leave this module. No audio is uploaded or
persisted here. ``python speakers.py --download`` installs a checksum-pinned
28.3 MB model; runtime construction never downloads anything.
"""
import argparse
from collections import deque
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SPEC = json.loads(Path(__file__).with_name("speaker-model.json").read_text(encoding="utf-8"))
DEFAULT_MODEL_PATH = ROOT / ".cache" / "asr" / SPEC["path"]
MODEL_ID = SPEC["id"]
DIMENSION = SPEC["embeddingDimension"]


def make_extractor(model_path=DEFAULT_MODEL_PATH, threads=1):
    """Create the sherpa 1.13.8 extractor; the installer verifies its checksum."""
    import sherpa_onnx
    model_path = Path(model_path)
    if not model_path.is_file():
        raise FileNotFoundError("Speaker model missing; run services/asr-local/speakers.py --download")
    if type(threads) is not int or threads < 1:
        raise ValueError("Speaker threads must be a positive integer")
    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(model_path), num_threads=threads, debug=False, provider="cpu")
    if not config.validate():
        raise ValueError("Invalid speaker embedding model configuration")
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
    if extractor.dim != DIMENSION:
        raise ValueError("Unsupported speaker embedding dimension")
    return extractor


def normalize_embedding(value, dimension=DIMENSION):
    vector = np.asarray(value, dtype=np.float32)
    if vector.shape != (dimension,) or not np.isfinite(vector).all():
        raise ValueError(f"Speaker embedding must contain {dimension} finite values")
    # Bound before norm to prevent overflow from untrusted serialized vectors.
    if np.max(np.abs(vector)) > 1000:
        raise ValueError("Speaker embedding values are out of range")
    norm = float(np.linalg.norm(vector))
    if norm < 1e-6:
        raise ValueError("Speaker embedding must not be zero")
    return vector / norm


class SpeakerSession:
    """Bounded per-session PCM and a throttled CPU-only verification decision.

    Thresholds are conservative initial operating points, not calibrated
    probabilities. Enrollment is explicit; arbitrary first speech is never
    silently treated as the candidate. A profile survives reset_segment.
    """
    MIN_VOICED_SECONDS = 1.6
    MIN_ENROLL_VOICED_SECONDS = 5.0
    WINDOW_SECONDS = 3.0
    RETRY_SECONDS = 1.2
    BUFFER_SECONDS = 12.0
    FRAME_SECONDS = 0.02
    MIN_FRAME_RMS = 0.006
    CANDIDATE_THRESHOLD = 0.55
    OTHER_THRESHOLD = 0.35

    def __init__(self, extractor, sample_rate, candidate_embedding=None):
        if type(sample_rate) is not int or sample_rate not in (8000, 16000, 24000, 32000, 44100, 48000):
            raise ValueError("Unsupported speaker sample rate")
        self.extractor = extractor
        self.sample_rate = sample_rate
        self.dimension = int(extractor.dim)
        self.candidate_embedding = None
        if candidate_embedding is not None:
            self.candidate_embedding = normalize_embedding(candidate_embedding, self.dimension)
        self.reset_segment()

    def reset_segment(self):
        self.chunks = deque()
        self.buffer_samples = 0
        self.total_samples = 0
        self.last_compute_at = -1
        self.last_result = self._result("unknown", "insufficient_audio")
        self.last_decisive_speaker = None
        self.conflicting_speakers = False

    def set_candidate(self, embedding):
        self.candidate_embedding = normalize_embedding(embedding, self.dimension)
        self.reset_segment()

    def append(self, pcm):
        if not isinstance(pcm, (bytes, bytearray, memoryview)) or len(pcm) % 2:
            raise ValueError("Speaker audio must be PCM16LE mono")
        if not pcm:
            return
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        self.chunks.append(samples)
        self.buffer_samples += len(samples)
        self.total_samples += len(samples)
        capacity = int(self.BUFFER_SECONDS * self.sample_rate)
        while self.buffer_samples > capacity:
            excess = self.buffer_samples - capacity
            first = self.chunks.popleft()
            if len(first) > excess:
                self.chunks.appendleft(first[excess:])
                self.buffer_samples -= excess
            else:
                self.buffer_samples -= len(first)

    def _result(self, speaker, reason, similarity=None, voiced_ms=0):
        result = {"speaker": speaker, "speakerReason": reason, "speakerVoicedMs": voiced_ms}
        if similarity is not None:
            # A cosine score is not a calibrated confidence probability.
            result["candidateSimilarity"] = round(float(similarity), 4)
        return result

    def _audio(self):
        if not self.chunks:
            return np.empty(0, dtype=np.float32)
        return np.concatenate(tuple(self.chunks))

    def _voiced(self, samples):
        """Remove silence for length checks and embedding input, not speech VAD.

        Energy gating rejects quiet input; it cannot prove that a signal is
        speech. Classification must only be attached to actual ASR text.
        """
        size = max(1, int(self.FRAME_SECONDS * self.sample_rate))
        usable = len(samples) // size * size
        if not usable:
            return np.empty(0, dtype=np.float32)
        frames = samples[:usable].reshape(-1, size)
        rms = np.sqrt(np.mean(np.square(frames), axis=1))
        voiced = frames[rms >= self.MIN_FRAME_RMS]
        return np.ascontiguousarray(voiced.reshape(-1))

    def _embedding(self, samples):
        stream = self.extractor.create_stream()
        stream.accept_waveform(sample_rate=self.sample_rate, waveform=np.ascontiguousarray(samples))
        stream.input_finished()
        if not self.extractor.is_ready(stream):
            raise ValueError("Not enough speech for speaker embedding")
        return normalize_embedding(self.extractor.compute(stream), self.dimension)

    def enroll(self):
        """Explicitly enroll current audio; return a versioned serializable profile.

        Average up to four disjoint speech windows, so the profile is less
        dependent on one word. Reject strongly inconsistent enrollment windows.
        Five seconds of energy-qualified audio normally needs 8–10 s of reading.
        """
        voiced = self._voiced(self._audio())
        seconds = len(voiced) / self.sample_rate
        if seconds < self.MIN_ENROLL_VOICED_SECONDS:
            raise ValueError("请连续朗读 8–10 秒，至少需要 5 秒清晰语音")
        count = min(4, max(2, int(seconds / 2.5)))
        windows = np.array_split(voiced, count)
        embeddings = [self._embedding(window) for window in windows]
        for index, left in enumerate(embeddings):
            for right in embeddings[index + 1:]:
                if float(np.dot(left, right)) < self.OTHER_THRESHOLD:
                    raise ValueError("登记语音不一致，请由本人独自重新朗读")
        profile = normalize_embedding(np.mean(embeddings, axis=0), self.dimension)
        result = {"version": 1, "model": MODEL_ID, "embedding": profile.tolist(),
                  "voicedMs": int(seconds * 1000)}
        self.set_candidate(profile)
        return result

    def classify(self, final=False):
        """Return a role estimate, reusing fresh results at an ASR endpoint.

        ``final`` never reduces the minimum speech requirement or forces an
        extra inference on a fresh result. No artificial silence is appended.
        """
        if self.candidate_embedding is None:
            return self._result("unknown", "not_enrolled")
        if self.last_compute_at >= 0 and (
                self.total_samples - self.last_compute_at < self.RETRY_SECONDS * self.sample_rate):
            return dict(self.last_result)
        voiced = self._voiced(self._audio())
        voiced = voiced[-int(self.WINDOW_SECONDS * self.sample_rate):]
        voiced_ms = int(len(voiced) * 1000 / self.sample_rate)
        if len(voiced) < self.MIN_VOICED_SECONDS * self.sample_rate:
            return self._result("unknown", "insufficient_audio", voiced_ms=voiced_ms)
        embedding = self._embedding(voiced)
        score = float(np.clip(np.dot(embedding, self.candidate_embedding), -1, 1))
        self.last_compute_at = self.total_samples
        if score >= self.CANDIDATE_THRESHOLD:
            speaker, reason = "candidate", "candidate_match"
        elif score <= self.OTHER_THRESHOLD:
            speaker, reason = "interviewer", "different_speaker"
        else:
            speaker, reason = "unknown", "ambiguous"
        if speaker != "unknown":
            if self.last_decisive_speaker and self.last_decisive_speaker != speaker:
                self.conflicting_speakers = True
            self.last_decisive_speaker = speaker
        if self.conflicting_speakers:
            speaker, reason = "unknown", "mixed_speakers"
        self.last_result = self._result(speaker, reason, score, voiced_ms)
        return dict(self.last_result)


def download_model():
    from install_speaker_model import install_speaker_model
    return install_speaker_model()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    if args.download:
        download_model()
    else:
        parser.print_help()
