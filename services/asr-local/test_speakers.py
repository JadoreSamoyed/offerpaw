"""Offline lifecycle/gating tests; these do not measure speaker accuracy."""
import unittest

import numpy as np

from speakers import SpeakerSession, normalize_embedding


def pcm(seconds, rate=16000, amplitude=0.2):
    count = int(seconds * rate)
    return (np.sin(np.arange(count) * 2 * np.pi * 200 / rate) * amplitude * 32767).astype("<i2").tobytes()


class FakeStream:
    def __init__(self):
        self.finished = False

    def accept_waveform(self, sample_rate, waveform):
        self.rate = sample_rate
        self.samples = waveform

    def input_finished(self):
        self.finished = True


class FakeExtractor:
    dim = 3

    def __init__(self, outputs=None):
        self.outputs = list(outputs or [[1, 0, 0]])
        self.calls = []
        self.ready = True

    def create_stream(self):
        return FakeStream()

    def is_ready(self, stream):
        return self.ready and stream.finished

    def compute(self, stream):
        self.calls.append(stream)
        return self.outputs.pop(0) if len(self.outputs) > 1 else self.outputs[0]


class SpeakerTests(unittest.TestCase):
    def test_unenrolled_speech_is_unknown_and_never_runs_model(self):
        model = FakeExtractor()
        session = SpeakerSession(model, 16000)
        session.append(pcm(8))
        self.assertEqual(session.classify(final=True)["speakerReason"], "not_enrolled")
        self.assertEqual(model.calls, [])

    def test_short_and_quiet_speech_do_not_guess_even_at_final(self):
        model = FakeExtractor()
        session = SpeakerSession(model, 16000, [1, 0, 0])
        session.append(pcm(1))
        self.assertEqual(session.classify(final=True)["speaker"], "unknown")
        session.append(pcm(6, amplitude=0))
        self.assertEqual(session.classify(final=True)["speaker"], "unknown")
        self.assertEqual(model.calls, [])

    def test_candidate_other_and_gray_zone_use_actual_vectors(self):
        for output, speaker in [([1, 0, 0], "candidate"), ([0, 1, 0], "interviewer"),
                                ([0.45, np.sqrt(1 - 0.45 ** 2), 0], "unknown")]:
            session = SpeakerSession(FakeExtractor([output]), 24000, [1, 0, 0])
            session.append(pcm(2, rate=24000))
            result = session.classify()
            self.assertEqual(result["speaker"], speaker)
            self.assertEqual(result["speakerVoicedMs"], 2000)

    def test_endpoint_reuses_fresh_inference_instead_of_adding_latency(self):
        model = FakeExtractor()
        session = SpeakerSession(model, 16000, [1, 0, 0])
        session.append(pcm(2))
        before = session.classify()
        session.append(pcm(0.5, amplitude=0))
        self.assertEqual(session.classify(final=True), before)
        self.assertEqual(len(model.calls), 1)
        session.append(pcm(0.8))
        session.classify()
        self.assertEqual(len(model.calls), 2)

    def test_reset_drops_audio_and_cached_role_but_keeps_candidate(self):
        session = SpeakerSession(FakeExtractor(), 16000, [1, 0, 0])
        session.append(pcm(2))
        self.assertEqual(session.classify()["speaker"], "candidate")
        session.reset_segment()
        self.assertEqual(session.classify()["speaker"], "unknown")
        self.assertEqual(session.buffer_samples, 0)
        np.testing.assert_array_equal(session.candidate_embedding, [1, 0, 0])

    def test_mixed_roles_within_one_segment_are_not_interviewer(self):
        session = SpeakerSession(FakeExtractor([[1, 0, 0], [0, 1, 0]]), 16000, [1, 0, 0])
        session.append(pcm(2))
        self.assertEqual(session.classify()["speaker"], "candidate")
        session.append(pcm(1.3))
        self.assertEqual(session.classify()["speakerReason"], "mixed_speakers")
        session.append(pcm(1.3))
        self.assertEqual(session.classify(final=True)["speaker"], "unknown")

    def test_enrollment_has_minimum_active_speech_and_rejects_mixed_voices(self):
        session = SpeakerSession(FakeExtractor(), 16000)
        session.append(pcm(4))
        session.append(pcm(5, amplitude=0))
        with self.assertRaisesRegex(ValueError, "5"):
            session.enroll()
        session = SpeakerSession(FakeExtractor([[1, 0, 0], [0, 1, 0]]), 16000)
        session.append(pcm(6))
        with self.assertRaisesRegex(ValueError, "不一致"):
            session.enroll()
        self.assertIsNone(session.candidate_embedding)

    def test_enrollment_averages_normalized_windows_and_clears_audio(self):
        model = FakeExtractor([[2, 0, 0], [0.9, 0.1, 0]])
        session = SpeakerSession(model, 16000)
        session.append(pcm(6))
        profile = session.enroll()
        self.assertEqual(profile["version"], 1)
        self.assertEqual(profile["model"], "campplus-zh-v1")
        self.assertEqual(profile["voicedMs"], 6000)
        self.assertAlmostEqual(float(np.linalg.norm(profile["embedding"])), 1, places=6)
        self.assertEqual(len(model.calls), 2)
        self.assertEqual(session.buffer_samples, 0)
        self.assertEqual(session.total_samples, 0)

    def test_buffer_and_inference_window_are_bounded_for_long_answers(self):
        model = FakeExtractor()
        session = SpeakerSession(model, 16000, [1, 0, 0])
        for _ in range(100):
            session.append(pcm(0.5))
        self.assertEqual(session.buffer_samples, 12 * 16000)
        self.assertEqual(sum(map(len, session.chunks)), 12 * 16000)
        session.classify()
        self.assertEqual(len(model.calls[0].samples), 3 * 16000)

    def test_hostile_profile_vectors_and_malformed_pcm_are_rejected(self):
        for embedding in [[0, 0, 0], [1, 0], [[1, 0, 0]], [float("nan"), 0, 1],
                          [float("inf"), 0, 0], [1001, 0, 0]]:
            with self.assertRaises(ValueError):
                normalize_embedding(embedding, 3)
        session = SpeakerSession(FakeExtractor(), 16000)
        for chunk in [b"a", "abc", [1, 2]]:
            with self.assertRaises(ValueError):
                session.append(chunk)
        session.append(b"")
        self.assertEqual(session.total_samples, 0)

    def test_profiles_and_buffers_are_isolated_across_sessions(self):
        model = FakeExtractor()
        first = SpeakerSession(model, 16000, [1, 0, 0])
        second = SpeakerSession(model, 16000, [0, 1, 0])
        first.append(pcm(2))
        self.assertEqual(first.classify()["speaker"], "candidate")
        self.assertEqual(second.classify()["speaker"], "unknown")
        second.append(pcm(2))
        self.assertEqual(second.classify()["speaker"], "interviewer")


if __name__ == "__main__":
    unittest.main()
