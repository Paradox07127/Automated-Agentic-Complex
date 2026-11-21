from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import socket
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from support import serve_in_thread  # noqa: E402


def stream():
    return [
        {"event": "speech.begin", "schema": "endfield-speech-timeline-v2",
         "clock": {"sample_rate": 48000}, "format": "pcm_s16le", "channels": 1},
        {"event": "audio", "start_sample": 0, "samples": 4, "pcm_base64": "AAAAAAAAAAA="},
        {"event": "audio", "start_sample": 4, "samples": 4, "pcm_base64": "AAAAAAAAAAA="},
        {"event": "complete", "total_samples": 8},
    ]


class FakeTTS(ThreadingHTTPServer):
    def __init__(self, lines=None, status=200, health_status=200, blocked=False):
        self.lines = stream() if lines is None else lines
        self.status, self.health_status, self.blocked = status, health_status, blocked
        self.requests = []
        self.release = threading.Event()
        super().__init__(("127.0.0.1", 0), _TTSHandler)
        self.url = f"http://127.0.0.1:{self.server_port}/tts"


class _TTSHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.server.requests.append(("GET", self.path, self.headers.get("Authorization"), None))
        self.send_response(self.server.health_status)
        self.end_headers()
        self.wfile.write(b'{"status":"running"}')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append(("POST", self.path, self.headers.get("Authorization"), body))
        if self.server.blocked:
            self.server.release.wait(2)
        try:
            self.send_response(self.server.status)
            self.end_headers()
            if self.server.status == 200:
                for line in self.server.lines:
                    self.wfile.write(line if isinstance(line, bytes) else (json.dumps(line) + "\n").encode())
                    self.wfile.flush()
        except OSError:
            pass


class VoiceCheckTest(unittest.TestCase):
    def setUp(self):
        from voice.voice_test import check
        self.check = check

    def tts(self, **options):
        tts = FakeTTS(**options)
        self.addCleanup(tts.server_close)
        thread = serve_in_thread(tts)
        self.addCleanup(thread.join, 2)
        self.addCleanup(tts.shutdown)
        self.addCleanup(tts.release.set)
        return tts

    def check_lines(self, lines):
        health, response = io.BytesIO(b'{}'), io.BytesIO(b"".join(
            line if isinstance(line, bytes) else (json.dumps(line) + "\n").encode() for line in lines))
        health.status = response.status = 200
        with patch("voice.voice_test.http.client.HTTPConnection") as connection:
            connection.return_value.getresponse.side_effect = [health, response]
            return self.check("http://127.0.0.1:9", "token", "voice_a", "zh")

    def test_valid_v2_stream_and_clause_request(self):
        tts = self.tts()
        before = int(time.time() * 1000)
        result = self.check(tts.url + "/", "test-token", "si", "ja")
        self.assertEqual(set(result), {"ok", "first_audio_ms", "total_ms", "reason"})
        self.assertTrue(result["ok"])
        self.assertIsNone(result["reason"])
        self.assertIsInstance(result["first_audio_ms"], int)
        self.assertGreaterEqual(result["first_audio_ms"], 0)
        self.assertGreaterEqual(result["total_ms"], result["first_audio_ms"])
        self.assertEqual([(method, path) for method, path, _, _ in tts.requests],
                         [("GET", "/tts/health"), ("POST", "/tts/speech_stream")])
        self.assertEqual(tts.requests[-1][2], "Bearer test-token")
        body = tts.requests[-1][3]
        self.assertEqual(set(body), {"character", "language", "text", "allow_unvalidated_pilot", "accelerated",
                                    "session_epoch", "turn_id", "speech_id", "expires_at_ms", "utterance_id",
                                    "clause_id", "clause_index", "spoken_text_revision", "voice_profile_id",
                                    "interrupt_policy", "turn_generation", "trace_id"})
        self.assertEqual((body["character"], body["language"]), ("si", "ja"))
        self.assertTrue(body["text"])
        self.assertLessEqual(len(body["text"]), 50)
        self.assertIs(body["allow_unvalidated_pilot"], True)
        self.assertIs(body["accelerated"], True)
        self.assertEqual((body["clause_index"], body["spoken_text_revision"], body["turn_generation"]), (0, 1, 0))
        self.assertEqual(body["interrupt_policy"], "immediate")
        self.assertEqual(body["voice_profile_id"], "si.ja.default")
        self.assertGreater(body["expires_at_ms"], before)
        for field in ("session_epoch", "turn_id", "speech_id", "utterance_id", "clause_id", "trace_id"):
            self.assertIsInstance(body[field], str)
            self.assertTrue(body[field])

    def test_v1_stream_with_optional_segment_and_cues(self):
        lines = stream()
        lines[0]["schema"] = "endfield-speech-timeline-v1"
        lines.insert(1, {"event": "segment"})
        lines.insert(-1, {"event": "cues"})
        self.assertTrue(self.check_lines(lines)["ok"])

    def test_unauthorized(self):
        result = self.check(self.tts(status=401).url, "wrong-token", "voice_a", "zh")
        self.assertEqual(result, {"ok": False, "first_audio_ms": None, "total_ms": None, "reason": "http_401"})

    def test_http_errors_from_health_and_speech(self):
        for options in ({"status": 503}, {"health_status": 503}):
            with self.subTest(options=options):
                tts = self.tts(**options)
                self.assertEqual(self.check(tts.url, "token", "voice_a", "zh")["reason"], "http_503")
                if "health_status" in options:
                    self.assertEqual(len(tts.requests), 1)

    def test_audio_gap(self):
        lines = stream()
        lines[2]["start_sample"] = 5
        result = self.check(self.tts(lines=lines).url, "token", "voice_a", "zh")
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "bad_stream")
        self.assertIsInstance(result["first_audio_ms"], int)
        self.assertIsNone(result["total_ms"])

    def test_invalid_url(self):
        for url in ("ftp://x", "http://", "https://[", "http://localhost:invalid", "http://local host:9888"):
            with self.subTest(url=url):
                self.assertEqual(self.check(url, "token", "voice_a", "zh"),
                                 {"ok": False, "first_audio_ms": None, "total_ms": None, "reason": "invalid_url"})

    def test_address_rule_is_the_relay_s(self):
        with patch("voice.voice_test.http.client.HTTPConnection") as connect:
            self.assertNotEqual(self.check("http://tts.example/tts", "token", "voice_a", "zh")["reason"], "invalid_url")
            connect.assert_called_once_with("tts.example", 80, timeout=30)
        with patch("voice.voice_test.http.client.HTTPSConnection") as connect:
            self.assertEqual(self.check("https://user:pw@tts.example", "token", "voice_a", "zh")["reason"], "invalid_url")
            connect.assert_not_called()

    def test_closed_port_is_unreachable(self):
        with socket.socket() as closed:
            closed.bind(("127.0.0.1", 0))
            port = closed.getsockname()[1]
        result = self.check(f"http://127.0.0.1:{port}", "token", "voice_a", "zh")
        self.assertEqual(result, {"ok": False, "first_audio_ms": None, "total_ms": None, "reason": "unreachable"})

    def test_invalid_begin(self):
        for change in ({"event": "audio"}, {"schema": "unknown"}, {"clock": {"sample_rate": 24000}},
                       {"clock": None}, {"format": "float32"}, {"channels": 2}):
            with self.subTest(change=change):
                lines = stream()
                lines[0].update(change)
                self.assertEqual(self.check_lines(lines)["reason"], "bad_stream")

    def test_invalid_lines_and_missing_complete(self):
        for lines in ([], [b"not json\n"], [[]], stream()[:-1],
                      [stream()[0], {"event": "cancelled"}], [stream()[0], stream()[0]],
                      [stream()[0], {"event": "complete", "total_samples": 0}]):
            with self.subTest(lines=lines):
                self.assertEqual(self.check_lines(lines)["reason"], "bad_stream")

    def test_invalid_sample_counts(self):
        for index, change in ((1, {"samples": -4}), (1, {"samples": "4"}), (1, {"start_sample": False}),
                              (3, {"total_samples": 7}), (3, {"total_samples": "8"})):
            with self.subTest(index=index, change=change):
                lines = stream()
                lines[index].update(change)
                self.assertEqual(self.check_lines(lines)["reason"], "bad_stream")

    def test_timeout(self):
        result = self.check(self.tts(blocked=True).url, "token", "voice_a", "zh", timeout=.05)
        self.assertEqual(result, {"ok": False, "first_audio_ms": None, "total_ms": None, "reason": "timeout"})


if __name__ == "__main__":
    unittest.main()
