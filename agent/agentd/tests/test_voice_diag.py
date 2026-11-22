"""agentd builds its voice through make_provider and shows the provider's state in /diag/state connections.tts."""
import http.client
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

AGENTD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENTD))

from daemon.agentd_server import AgentdServer  # noqa: E402
from infra.secrets import MemorySecrets
from voice.credential import TtsCredential
from api.handler import Handler  # noqa: E402
from voice.speech import SpeechRelay  # noqa: E402
from voice.tts_ensure import NEGATIVE, TtsEnsurer  # noqa: E402
from voice.voice_provider import NoVoice, RemoteWsVoice  # noqa: E402
from support import serve_in_thread  # noqa: E402

TOKENS = {"hook_token": "hook-token", "ui_token": "ui-token", "events_token": "events-token"}

# Runs main(); TEST_BREAK_VOICE makes building the voice provider raise.
MAIN = """
import os, sys
sys.path.insert(0, os.environ["TEST_AGENTD"])
import server
import daemon.main
if os.environ.get("TEST_BREAK_VOICE"):
    def broken(*args):
        raise RuntimeError("voice start fixture")
    daemon.main.make_provider = broken
from infra.secrets import MemorySecrets
server.main(MemorySecrets())
"""


def request(port, method, path, token=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        conn.request(method, path, None, {"Authorization": f"Bearer {token}"} if token else {})
        response = conn.getresponse()
        return response.status, json.loads(response.read())
    finally:
        conn.close()


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


class DiagTtsTest(unittest.TestCase):
    def setUp(self):
        with patch('socketserver.TCPServer.server_bind'), patch('socketserver.TCPServer.server_activate'), \
                patch.object(AgentdServer, '_tick_loop'):
            self.server = AgentdServer(("127.0.0.1", 0), **TOKENS)
        self.addCleanup(self.server.server_close)

    def tts(self):
        return self.server._diag_connections()["tts"]

    def test_transition_published_once(self):
        clock = Clock()
        relay = SpeechRelay("http://127.0.0.1:9", epoch=1, character="voice_a", language="zh")
        self.server.voice = RemoteWsVoice(relay, clock=clock)
        before = self.server.feed.seq
        for kind, attrs in (("speech.failed", {"reason": "unreachable"}),
                            ("speech.failed", {"reason": "unreachable"}),
                            ("speech.finished", {"total_samples": 10}),
                            ("speech.finished", {"total_samples": 10})):
            self.server.on_speech_event(kind, "fixture", attrs)
        events = [e['data'] for e in self.server.feed.since(before) if e['event'] == 'voice_state']
        self.assertEqual([{k:v for k,v in e.items() if k != 'seq'} for e in events], [
            {"provider":"remote-ws", "state":"unreachable", "reason":"unreachable", "retry_after_s":None},
            {"provider":"remote-ws", "state":"ready", "reason":None, "retry_after_s":None}])
        clock.now += 601
        self.server.voice.state()
        self.server.voice.state()
        states = [e['data']['state'] for e in self.server.feed.since(before) if e['event'] == 'voice_state']
        self.assertEqual(states, ['unreachable', 'ready', 'cold'])

    def test_default_server_has_no_voice_and_keeps_the_legacy_keys(self):
        self.assertIsInstance(self.server.voice, NoVoice)
        self.assertEqual(self.tts(), {"configured": False, "result": None, "at": None, "provider": "none",
                                      "state": "off", "reason": "not_configured", "retry_after_s": None})

    def test_speech_events_reach_the_provider_and_the_legacy_result(self):
        relay = SpeechRelay("http://127.0.0.1:9", epoch=1, character="voice_a", language="zh")
        self.server.voice, self.server.speech = RemoteWsVoice(relay), relay
        self.assertEqual(self.tts(), {"configured": True, "result": None, "at": None, "provider": "remote-ws",
                                      "state": "unknown", "reason": None, "retry_after_s": None})
        self.server.on_speech_event("speech.failed", "s1", {"reason": "unreachable"})
        tts = self.tts()
        self.assertEqual((tts["result"], tts["state"], tts["reason"]), ("unreachable", "unreachable", "unreachable"))
        self.server.on_speech_event("speech.finished", "s2", {"total_samples": 10})
        tts = self.tts()
        self.assertEqual((tts["result"], tts["state"], tts["reason"]), ("complete", "ready", None))

    def test_retry_after_counts_down_the_ensurers_negative_cache(self):
        clock = Clock()
        ensurer = TtsEnsurer("ws", "script", clock=clock)
        relay = SpeechRelay("http://127.0.0.1:9", epoch=1, character="voice_a", language="zh", ensurer=ensurer)
        self.server.voice = RemoteWsVoice(relay, ensurer, clock=clock)
        ensurer.on_change("ensure_failed", "fail ssh", clock.now + NEGATIVE)
        clock.now += 30
        tts = self.tts()
        self.assertEqual((tts["state"], tts["reason"], tts["retry_after_s"]),
                         ("unreachable", "ensure:fail ssh", NEGATIVE - 30))


class Recording(RemoteWsVoice):
    """RemoteWsVoice whose reset and probe are recorded; probe touches no network."""
    def __init__(self, relay, calls):
        super().__init__(relay)
        self.calls = calls

    def reset(self, why):
        self.calls.append(("reset", why))
        super().reset(why)

    def probe(self):
        self.calls.append(("probe",))


class VoiceResetTest(unittest.TestCase):
    def setUp(self):
        self.server = AgentdServer(("127.0.0.1", 0), **TOKENS)
        self.addCleanup(self.server.server_close)
        thread = serve_in_thread(self.server)
        self.addCleanup(thread.join, 2)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_port

    def test_without_the_ui_token_is_unauthorized(self):
        for token in (None, "hook-token"):
            with self.subTest(token=token):
                self.assertEqual(request(self.port, "POST", "/voice/reset", token)[0], 401)

    def test_resets_then_probes_and_returns_the_wire(self):
        relay = SpeechRelay("http://127.0.0.1:9", epoch=1, character="voice_a", language="zh")
        calls = []
        self.server.voice = Recording(relay, calls)
        self.server.voice.on_speech("speech.failed", {"reason": "unreachable"})
        status, body = request(self.port, "POST", "/voice/reset", "ui-token")
        self.assertEqual(status, 200)
        self.assertEqual(calls, [("reset", "user"), ("probe",)])
        self.assertEqual(body, {"tts": {"provider": "remote-ws", "state": "unknown", "reason": None,
                                        "retry_after_s": None}})

    def test_no_voice_answers_off(self):
        status, body = request(self.port, "POST", "/voice/reset", "ui-token")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"tts": {"provider": "none", "state": "off", "reason": "not_configured",
                                        "retry_after_s": None}})


class VoiceSettingsTest(unittest.TestCase):
    def setUp(self):
        with patch('socketserver.TCPServer.server_bind'), patch('socketserver.TCPServer.server_activate'), \
                patch.object(AgentdServer, '_tick_loop'):
            self.server = AgentdServer(("127.0.0.1", 0), **TOKENS)
        self.addCleanup(self.server.server_close)
        self.server.speech = SpeechRelay("http://127.0.0.1/tts", epoch=1, character="voice_a", language="zh",
                                         token="old-token")

    def request(self, path, body, token="ui-token"):
        payload = json.dumps(body).encode()
        auth = f"Authorization: Bearer {token}\r\n" if token else ""
        raw = (f"POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth}Content-Type: application/json\r\n"
               f"Content-Length: {len(payload)}\r\n\r\n").encode() + payload
        handler = Handler.__new__(Handler)
        handler.server = self.server
        handler.rfile, handler.wfile = io.BytesIO(raw), io.BytesIO()
        handler.handle_one_request()
        headers, response = handler.wfile.getvalue().split(b"\r\n\r\n", 1)
        return int(headers.split()[1]), json.loads(response)

    def test_voice_settings_require_ui_token(self):
        for path in ("/voice/test", "/voice/token"):
            for token in (None, "hook-token", "events-token"):
                with self.subTest(path=path, token=token):
                    self.assertEqual(self.request(path, {"token": "new-token"}, token)[0], 401)

    def test_voice_test_uses_relay_defaults_without_publishing_audio(self):
        relay = self.server.speech
        before = relay.stream_state()
        reply = {"ok": True, "first_audio_ms": 12, "total_ms": 25, "reason": None}
        with patch("api.speech.check", create=True, return_value=reply) as check:
            self.assertEqual(self.request("/voice/test", {}), (200, reply))
        check.assert_called_once_with("http://127.0.0.1:80/tts", "old-token", "voice_a", "zh")
        self.assertEqual(relay.stream_state(), before)
        self.assertEqual(relay.since(0), [])

    def test_voice_test_overrides_are_not_saved(self):
        relay = self.server.speech
        reply = {"ok": False, "first_audio_ms": None, "total_ms": None, "reason": "http_401"}
        with patch("api.speech.check", create=True, return_value=reply) as check:
            self.assertEqual(self.request("/voice/test", {"url": "http://tts.example/override", "token": "test-token"}),
                             (200, reply))
        check.assert_called_once_with("http://tts.example/override", "test-token", "voice_a", "zh")
        self.assertEqual((relay.base, relay.token), ("/tts", "old-token"))

    def test_the_saved_token_goes_only_to_the_relay_address(self):
        with patch("api.speech.check", create=True, return_value={"ok": False}) as check:
            for url in ("http://tts.example/tts", "http://127.0.0.1:81/tts", "https://127.0.0.1/tts", "http://",
                        "http://127.0.0.1/other", "http://127.0.0.1:80/tts"):
                self.request("/voice/test", {"url": url})
        self.assertEqual([call.args[1] for call in check.call_args_list],
                         [None, None, None, None, "old-token", "old-token"])

    def test_voice_test_rejects_non_string_fields(self):
        for body in ([], {"url": None}, {"url": 7}, {"token": 7}):
            with self.subTest(body=body):
                self.assertEqual(self.request("/voice/test", body)[0], 400)

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_voice_token_is_private_and_replaces_relay_token(self):
        relay = self.server.speech
        with tempfile.TemporaryDirectory() as tmp:
            credential = self.server.tts_credential = TtsCredential(Path(tmp) / "tts-token", MemorySecrets())
            credential.put("old-token")
            self.assertEqual(self.request("/voice/token", {"token": "new-token"}),
                             (200, {"ok": True}))
            self.assertEqual(credential.get(), "new-token")
            self.assertEqual(credential.ref.stat().st_mode & 0o777, 0o600)
            self.assertEqual(relay.token, "new-token")
            self.server.speech = None
            self.assertEqual(self.request("/voice/token", {"token": " next-token\n"}), (200, {"ok": True}))
            self.assertEqual(credential.get(), "next-token")
            self.server.speech = relay
            relay.token = "new-token"
            with patch("api.speech.check", create=True, return_value={"ok": True}) as check:
                self.assertEqual(self.request("/voice/test", {}), (200, {"ok": True}))
            check.assert_called_once_with("http://127.0.0.1:80/tts", "new-token", "voice_a", "zh")

    def test_voice_token_rejects_empty_and_non_string_tokens(self):
        relay = self.server.speech
        with tempfile.TemporaryDirectory() as tmp:
            credential = self.server.tts_credential = TtsCredential(Path(tmp) / "tts-token", MemorySecrets())
            credential.put("old-token")
            for body in ({}, [], {"token": ""}, {"token": "  "}, {"token": None}, {"token": 7}):
                with self.subTest(body=body):
                    self.assertEqual(self.request("/voice/token", body)[0], 400)
                    self.assertEqual(credential.get(), "old-token")
                    self.assertEqual(relay.token, "old-token")


class VoiceStartupTest(unittest.TestCase):
    def start(self, *extra, **env):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        (home / ".claude").mkdir()
        self.state = home / "state"
        self.process = subprocess.Popen(
            [sys.executable, "-I", "-c", MAIN, "--port", "0", "--state-dir", str(self.state), "--no-proactive",
             "--mute", "--plugin-off", "screen_awareness", "--ledger-root", str(home / "no-ledger"), *extra],
            env={**os.environ, "HOME": str(home), "TEST_AGENTD": str(AGENTD),
                 "AAC_TTS_TOKEN_FILE": str(home / "no-tts.token"), **env},
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.addCleanup(self.stop)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and self.process.poll() is None:
            try:
                runtime = json.loads((self.state / "ui-runtime.json").read_text(encoding="utf-8"))
                self.port, self.ui = int(runtime["base_url"].rsplit(":", 1)[1]), runtime["ui_token"]
                status, body = request(self.port, "GET", "/health")
                if body["status"] == "ok":
                    return body["degraded"], self.tts()
            except OSError:
                pass
            time.sleep(.02)
        self.process.kill()
        self.fail("agentd did not become ready:\n" + self.process.communicate()[0].decode(errors="replace"))

    def tts(self):
        return request(self.port, "GET", "/diag/state", self.ui)[1]["connections"]["tts"]

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.output = self.process.communicate(timeout=10)[0].decode(errors="replace")
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.output = self.process.communicate()[0].decode(errors="replace")

    def test_without_tts_url_the_voice_is_not_configured(self):
        degraded, tts = self.start()
        self.assertEqual(degraded, [])
        self.assertEqual((tts["configured"], tts["provider"], tts["state"], tts["reason"]),
                         (False, "none", "off", "not_configured"))

    def test_with_tts_url_the_voice_is_remote_ws_and_probed_once(self):
        degraded, tts = self.start("--tts-url", "http://127.0.0.1:9", "--tts-ensure-host", "ws",
                                   "--tts-ensure-script", "/srv/tts/ondemand.sh")
        self.assertEqual(degraded, [])
        deadline = time.monotonic() + 10
        while tts["state"] == "probing" and time.monotonic() < deadline:
            time.sleep(.02)
            tts = self.tts()
        self.assertEqual((tts["configured"], tts["provider"], tts["state"], tts["reason"]),
                         (True, "remote-ws", "cold", "probe:ConnectionRefusedError"))

    def test_a_start_failure_is_degraded_and_text_only(self):
        degraded, tts = self.start("--tts-url", "http://127.0.0.1:9", TEST_BREAK_VOICE="1")
        self.assertEqual(degraded, ["speech"])
        self.assertEqual((tts["configured"], tts["provider"], tts["state"], tts["reason"]),
                         (False, "none", "off", "start_failed"))
        self.stop()
        self.assertIn("voice start fixture", self.output)


if __name__ == "__main__":
    unittest.main()
