"""Fake-only hybrid session checks; no model loading or inference."""
import importlib.util
import unittest
from pathlib import Path

import numpy as np


module_spec = importlib.util.spec_from_file_location("hybrid_under_test", Path(__file__).with_name("hybrid.py"))
hybrid = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(hybrid)

RATE = 16000
FRAME = RATE // 10


def pcm(*markers):
    return np.concatenate([np.full(FRAME, marker, dtype="<i2") for marker in markers]).tobytes()


class FakeStream:
    def __init__(self, recognizer, number):
        self.recognizer = recognizer
        self.number = number
        self.options = {}
        self.finished = False
        self.accepted = []
        self.pending = np.empty(0, dtype=np.float32)
        self.text = ""
        self.decodes = 0
        self.log("create")

    def log(self, operation, *values):
        self.recognizer.log.append((self.recognizer.role, self.number, operation, *values))

    def accept_waveform(self, rate, samples):
        assert not self.finished, "audio appended to a finished stream"
        assert rate == RATE
        self.accepted.append(samples)
        self.pending = np.concatenate([self.pending, samples])
        self.log("accept", len(samples))

    def set_option(self, key, value):
        self.options[key] = value
        self.log("option", key, value)

    def input_finished(self):
        self.finished = True
        self.log("finished")


class FakeRecognizer:
    def __init__(self, role, log, endpoint_after=3, words=None):
        self.role = role
        self.log = log
        self.endpoint_after = endpoint_after
        self.words = words or {}
        self.streams = []
        self.decode_samples = FRAME if role == "endpoint" else 2 * FRAME

    def create_stream(self):
        stream = FakeStream(self, len(self.streams))
        self.streams.append(stream)
        return stream

    def is_ready(self, stream):
        return len(stream.pending) >= self.decode_samples or (
            stream.options.get("is_final") == "1" and len(stream.pending) > 0)

    def decode_stream(self, stream):
        assert self.is_ready(stream)
        count = min(len(stream.pending), self.decode_samples)
        samples = stream.pending[:count]
        stream.pending = stream.pending[count:]
        stream.decodes += 1
        stream.log("decode", count, stream.options.get("is_final", "0"))
        if self.role == "text":
            for value in samples[::FRAME]:
                marker = round(float(value) * 32768)
                if marker:
                    stream.text += self.words.get(marker, str(marker))

    def get_result(self, stream):
        return stream.text

    def is_endpoint(self, stream):
        assert self.role == "endpoint", "text model's endpoint must never be used"
        return self.endpoint_after is not None and stream.decodes >= self.endpoint_after


class HybridTests(unittest.TestCase):
    def setUp(self):
        self.log = []
        self.text = FakeRecognizer("text", self.log)
        self.endpoint = FakeRecognizer("endpoint", self.log)
        self.bundle = hybrid.HybridRecognizer(self.text, self.endpoint)
        self.session = hybrid.HybridRecognitionSession(self.bundle, RATE, 7)

    def finals(self, events):
        return [event for event in events if event["type"] == "transcript.final"]

    def test_endpoint_drains_short_chunk_before_final(self):
        self.text.words = {1: "技", 2: "术", 3: "难题"}
        events = self.session.append(pcm(1, 2, 3))
        self.assertEqual([event["text"] for event in events], ["技术", "技术难题", "技术难题"])
        self.assertEqual([event["type"] for event in events],
                         ["transcript.partial", "transcript.partial", "transcript.final"])
        self.assertEqual(len({event["id"] for event in events}), 1)
        self.assertTrue(all(event["generation"] == 7 for event in events))
        self.assertEqual(self.text.streams[0].options, {"is_final": "1"})
        self.assertTrue(self.text.streams[0].finished)
        self.assertEqual(self.text.streams[1].options, {})
        self.assertFalse(self.text.streams[1].finished)
        self.assertEqual(len(self.endpoint.streams), 2)

    def test_final_is_unique_and_stop_is_idempotent(self):
        events = self.session.append(pcm(1, 2, 3))
        events += self.session.stop()
        events += self.session.stop()
        self.assertEqual([event["text"] for event in self.finals(events)], ["123"])
        self.assertEqual(self.session.stop(), [])
        with self.assertRaisesRegex(RuntimeError, "session.stop"):
            self.session.append(pcm(4))

    def test_clear_discards_pending_audio_and_changes_generation_and_id(self):
        self.endpoint.endpoint_after = None
        self.session.append(pcm(1, 2, 3))  # "12" is partial; frame 3 is still pending.
        old_id = self.session.session_id
        self.session.clear(8)
        self.endpoint.endpoint_after = 3
        events = self.session.append(pcm(4, 5, 6))
        self.assertEqual([event["text"] for event in self.finals(events)], ["456"])
        self.assertNotEqual(self.session.session_id, old_id)
        self.assertTrue(all(event["generation"] == 8 for event in events))
        self.assertTrue(all(event["id"] == f"{self.session.session_id}-0" for event in events))
        self.assertFalse(self.text.streams[0].finished, "clear must not publish old text as final")

    def test_500ms_packet_is_split_and_post_endpoint_audio_is_preserved(self):
        events = self.session.append(pcm(1, 2, 3, 4, 5))
        events += self.session.append(pcm(6))
        finals = self.finals(events)
        self.assertEqual([event["text"] for event in finals], ["123", "456"])
        self.assertNotEqual(finals[0]["id"], finals[1]["id"])
        text_frames = [frame for stream in self.text.streams for frame in stream.accepted]
        endpoint_frames = [frame for stream in self.endpoint.streams for frame in stream.accepted]
        self.assertEqual([len(frame) for frame in text_frames], [FRAME] * 6)
        self.assertTrue(all(left is right for left, right in zip(text_frames, endpoint_frames)))
        np.testing.assert_array_equal(np.concatenate(text_frames),
                                      np.frombuffer(pcm(1, 2, 3, 4, 5, 6), dtype="<i2").astype(np.float32) / 32768)
        self.assertTrue(all(frame.dtype == np.float32 for frame in text_frames))

    def test_endpoint_and_text_decoding_are_serial_and_flush_precedes_stream_recreation(self):
        self.session.append(pcm(1, 2, 3))
        self.assertLess(self.log.index(("endpoint", 0, "decode", FRAME, "0")),
                        self.log.index(("text", 0, "decode", 2 * FRAME, "0")))
        final_option = self.log.index(("text", 0, "option", "is_final", "1"))
        finished = self.log.index(("text", 0, "finished"))
        tail_decode = self.log.index(("text", 0, "decode", FRAME, "1"))
        self.assertLess(final_option, finished)
        self.assertLess(finished, tail_decode)
        self.assertLess(tail_decode, self.log.index(("endpoint", 1, "create")))
        self.assertLess(tail_decode, self.log.index(("text", 1, "create")))

    def test_stop_only_pads_text_model_and_finishes_short_utterance(self):
        self.session.append(pcm(1))
        endpoint_input = len(self.endpoint.streams[0].accepted)
        events = self.session.stop()
        self.assertEqual([event["text"] for event in self.finals(events)], ["1"])
        self.assertEqual(len(self.endpoint.streams[0].accepted), endpoint_input)
        tail = self.text.streams[0].accepted[-1]
        self.assertEqual(len(tail), int(RATE * 0.8))
        self.assertTrue(np.all(tail == 0))
        self.assertEqual(self.session.stop(), [])

    def test_shared_models_keep_each_session_streams_separate(self):
        other = hybrid.HybridRecognitionSession(self.bundle, RATE, 9)
        self.session.append(pcm(1))
        other_events = other.append(pcm(2, 3, 4))
        events = self.session.append(pcm(5, 6))
        self.assertEqual([event["text"] for event in self.finals(events)], ["156"])
        self.assertEqual([event["text"] for event in self.finals(other_events)], ["234"])
        self.assertNotEqual(events[-1]["id"], other_events[-1]["id"])
        self.assertEqual(events[-1]["generation"], 7)
        self.assertEqual(other_events[-1]["generation"], 9)

    def test_empty_audio_is_noop_and_incomplete_pcm_is_rejected(self):
        before = list(self.log)
        self.assertEqual(self.session.append(b""), [])
        with self.assertRaisesRegex(ValueError, "PCM16"):
            self.session.append(b"\0")
        self.assertEqual(self.log, before)

    def test_speaker_windows_follow_endpoints_inside_one_packet(self):
        class FakeSpeaker:
            def __init__(self):
                self.history = []
                self.frames = []

            def reset_segment(self):
                self.frames = []

            def append(self, audio):
                self.frames.append(round(float(np.frombuffer(audio, dtype="<i2")[0])))

            def classify(self, final=False):
                self.history.append((final, tuple(self.frames)))
                return {"speaker": "candidate" if self.frames[0] == 1 else "interviewer"}

        speaker = FakeSpeaker()
        session = hybrid.HybridRecognitionSession(self.bundle, RATE, 2, speaker)
        events = session.append(pcm(1, 2, 3, 4, 5)) + session.append(pcm(6))
        finals = self.finals(events)
        self.assertEqual([event["speaker"] for event in finals], ["candidate", "interviewer"])
        self.assertEqual([frames for final, frames in speaker.history if final], [(1, 2, 3), (4, 5, 6)])
        self.assertTrue(all(event["speakerSource"] == "voice" for event in events))
        session.append(pcm(7))
        session.clear(3)
        self.assertEqual(speaker.frames, [])

    def test_missing_speaker_model_never_infers_identity_from_text(self):
        events = self.session.append(pcm(1, 2, 3))
        self.assertTrue(all(event["speaker"] == "unknown" for event in events))
        self.assertTrue(all(event["speakerSource"] == "unavailable" for event in events))

    def test_token_blank_endpoint_during_speech_is_vetoed_until_actual_quiet(self):
        self.text.words = {10000: "你", 11000: "为什么", 12000: "选择星河"}
        events = self.session.append(pcm(10000, 11000, 12000))
        self.assertEqual(self.finals(events), [], "model blanks must not split ongoing speech")
        self.assertEqual(len(self.text.streams), 1)
        events += self.session.append(pcm(0, 0))
        self.assertEqual([event["text"] for event in self.finals(events)], ["你为什么选择星河"])
        self.assertEqual(len(self.text.streams), 2)
        self.assertEqual(self.session.endpoint_guard.segment_samples, 0)
        self.assertEqual(self.session.endpoint_guard.quiet_samples, 0)

    def test_real_short_pause_accepts_existing_endpoint_without_an_extra_wait(self):
        self.endpoint.endpoint_after = 4
        events = self.session.append(pcm(10000, 11000, 0, 0))
        self.assertEqual(len(self.finals(events)), 1)
        self.assertEqual(len(self.text.streams[0].accepted), 4)
        self.assertEqual(self.session.segment, 1)

    def test_brief_midphrase_pause_does_not_release_a_stale_token_endpoint(self):
        events = self.session.append(pcm(10000, 11000, 12000))
        events += self.session.append(np.zeros(round(RATE * 0.12), dtype="<i2").tobytes())
        events += self.session.append(pcm(13000))
        self.assertEqual(self.finals(events), [])
        self.assertEqual(len(self.text.streams), 1)

    def test_quiet_evidence_alone_never_creates_a_premature_endpoint(self):
        self.endpoint.endpoint_after = None
        events = self.session.append(pcm(10000, 0, 0, 0, 0))
        self.assertEqual(self.finals(events), [])
        self.assertEqual(self.session.segment, 0)

    def test_continuous_noise_cannot_hold_a_stream_beyond_twenty_seconds(self):
        self.endpoint.endpoint_after = None  # Also exercise the bounded fallback.
        events = []
        for _ in range(39):
            events += self.session.append(pcm(*([10000] * 5)))
        self.assertEqual(self.finals(events), [])
        events += self.session.append(pcm(*([10000] * 5)))
        self.assertEqual(len(self.finals(events)), 1)
        self.assertEqual(len(self.text.streams[0].accepted), 200)
        self.assertEqual(self.session.endpoint_guard.segment_samples, 0)

    def test_clear_resets_guard_and_stop_flushes_even_while_sound_is_present(self):
        self.session.append(pcm(0, 0))
        self.session.clear(8)
        self.assertEqual(self.session.endpoint_guard.quiet_samples, 0)
        self.assertEqual(self.session.endpoint_guard.segment_samples, 0)
        events = self.session.append(pcm(10000))
        self.assertEqual(self.finals(events), [])
        events += self.session.stop()
        self.assertEqual([event["text"] for event in self.finals(events)], ["10000"])
        self.assertEqual(self.session.stop(), [])

    def test_guard_tracks_short_packets_and_new_sound_vetoes_stale_quiet(self):
        guard = hybrid._AcousticEndpointGuard(RATE)
        quiet = np.zeros(RATE // 1000, dtype=np.float32)
        for _ in range(200):
            guard.append(quiet)
        self.assertTrue(guard.allows(True))
        self.assertFalse(guard.allows(False))
        guard.append(np.full(RATE // 1000, 0.1, dtype=np.float32))
        self.assertFalse(guard.allows(True), "1 ms of new sound must invalidate stale quiet")


if __name__ == "__main__":
    unittest.main()
