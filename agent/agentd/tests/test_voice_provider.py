from argparse import Namespace
from dataclasses import FrozenInstanceError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import socket
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voice.speech import SpeechRelay  # noqa: E402
from voice.tts_ensure import NEGATIVE, TtsEnsurer  # noqa: E402
from voice.voice_provider import (IDLE, STATES, NoVoice, RemoteWsVoice, VoiceProvider,  # noqa: E402
                            VoiceState, make_provider, observe, step)
from support import serve_in_thread

EVENTS = ("ensure_started", "ensure_ready", "ensure_failed", "speech_complete", "speech_cancelled",
          "speech_failed", "reset", "probe_started", "probe_ready", "probe_cold", "probe_unreachable")


def state(name="unknown", reason=None, since=0.0, last_ok=None, retry_after=None):
    return VoiceState("remote-ws", name, reason, since, last_ok, retry_after)


class Clock:
    def __init__(self, now=100.0):
        self.now = now

    def __call__(self):
        return self.now


class Probe(VoiceProvider):
    name = "probe"


class StepTest(unittest.TestCase):
    def test_table_from_every_state_but_off(self):
        expected = {"ensure_started": "probing", "ensure_ready": "ready", "speech_complete": "ready",
                    "speech_cancelled": "ready", "ensure_failed": "unreachable", "speech_failed": "unreachable",
                    "reset": "unknown", "probe_started": "probing", "probe_ready": "ready", "probe_cold": "cold",
                    "probe_unreachable": "unreachable"}
        for start in STATES:
            if start == "off":
                continue
            for event, to in expected.items():
                with self.subTest(start=start, event=event):
                    self.assertEqual(step(state(start), event, 5.0, reason="x").state, to)

    def test_off_ignores_every_event(self):
        off = VoiceState("none", "off", "not_configured", 0.0, None, None)
        for event in EVENTS:
            with self.subTest(event=event):
                self.assertEqual(step(off, event, 5.0, reason="x", retry_after=9.0), off)

    def test_ensure_failed_takes_retry_after_from_the_ensurer(self):
        s = step(state("probing"), "ensure_failed", 5.0, reason="fail ssh", retry_after=95.0)
        self.assertEqual((s.state, s.reason, s.retry_after, s.since), ("unreachable", "ensure:fail ssh", 95.0, 5.0))

    def test_ensure_failed_without_reported_retry_keeps_none(self):
        self.assertIsNone(step(state(), "ensure_failed", 5.0, reason="timeout").retry_after)

    def test_speech_failed_reason_is_the_code(self):
        s = step(state("ready", last_ok=1.0), "speech_failed", 5.0, reason="http_503")
        self.assertEqual((s.state, s.reason, s.last_ok), ("unreachable", "http_503", 1.0))

    def test_success_records_last_ok_and_clears_reason(self):
        for event in ("ensure_ready", "speech_complete", "speech_cancelled"):
            with self.subTest(event=event):
                s = step(state("unreachable", reason="unreachable"), event, 7.0)
                self.assertEqual((s.state, s.reason, s.last_ok), ("ready", None, 7.0))

    def test_retry_after_follows_the_ensurer_window(self):
        failed = state("unreachable", reason="ensure:timeout", retry_after=95.0)
        self.assertEqual(step(failed, "speech_complete", 6.0).retry_after, 95.0)
        self.assertEqual(step(failed, "speech_failed", 6.0, reason="unreachable").retry_after, 95.0)
        for event in ("ensure_started", "ensure_ready", "reset"):
            with self.subTest(event=event):
                self.assertIsNone(step(failed, event, 6.0).retry_after)

    def test_probe_events_keep_retry_after(self):
        failed = state("unreachable", reason="ensure:timeout", retry_after=95.0)
        for event in ("probe_started", "probe_ready", "probe_cold", "probe_unreachable"):
            with self.subTest(event=event):
                self.assertEqual(step(failed, event, 6.0, reason="x").retry_after, 95.0)

    def test_probe_failure_reason(self):
        for event, to in (("probe_cold", "cold"), ("probe_unreachable", "unreachable")):
            with self.subTest(event=event):
                s = step(state("probing"), event, 6.0, reason="ConnectionRefusedError")
                self.assertEqual((s.state, s.reason, s.since), (to, "probe:ConnectionRefusedError", 6.0))
        ready = step(state("probing", reason="x"), "probe_ready", 6.0)
        self.assertEqual((ready.state, ready.reason, ready.last_ok), ("ready", None, 6.0))

    def test_reset_goes_to_unknown(self):
        s = step(state("unreachable", reason="ensure:timeout", last_ok=2.0, retry_after=95.0), "reset", 6.0)
        self.assertEqual((s.state, s.reason, s.retry_after, s.since), ("unknown", None, None, 6.0))

    def test_since_moves_only_on_a_state_change(self):
        ready = step(state(), "ensure_ready", 5.0)
        again = step(ready, "speech_complete", 9.0)
        self.assertEqual((again.since, again.last_ok), (5.0, 9.0))

    def test_step_is_pure(self):
        s = state()
        step(s, "ensure_ready", 5.0)
        self.assertEqual(s, state())
        with self.assertRaises(FrozenInstanceError):
            s.state = "ready"


class ObserveTest(unittest.TestCase):
    def test_ready_turns_cold_after_idle(self):
        ready = state("ready", since=10.0, last_ok=10.0)
        self.assertEqual(observe(ready, 10.0 + IDLE), ready)
        cold = observe(ready, 10.0 + IDLE + 1)
        self.assertEqual((cold.state, cold.since, cold.last_ok), ("cold", 10.0 + IDLE, 10.0))

    def test_only_ready_turns_cold(self):
        for name in ("unknown", "probing", "unreachable", "cold"):
            with self.subTest(state=name):
                self.assertEqual(observe(state(name, last_ok=0.0), IDLE * 3).state, name)

    def test_retry_after_clears_once_past(self):
        failed = state("unreachable", reason="ensure:timeout", retry_after=95.0)
        self.assertEqual(observe(failed, 95.0), failed)
        later = observe(failed, 95.5)
        self.assertEqual((later.state, later.reason, later.retry_after), ("unreachable", "ensure:timeout", None))


class WireTest(unittest.TestCase):
    def test_wire_keys_and_countdown(self):
        failed = state("unreachable", reason="ensure:timeout", retry_after=95.0)
        self.assertEqual(failed.wire(50.0), {"provider": "remote-ws", "state": "unreachable",
                                              "reason": "ensure:timeout", "retry_after_s": 45.0})

    def test_wire_without_or_past_retry(self):
        self.assertIsNone(state().wire(1.0)["retry_after_s"])
        self.assertIsNone(state(retry_after=5.0).wire(6.0)["retry_after_s"])


class NoVoiceTest(unittest.TestCase):
    def test_not_configured_by_default(self):
        voice = NoVoice()
        self.assertEqual(voice.name, "none")
        self.assertIsNone(voice.relay())
        self.assertIsNone(voice.ensurer)
        self.assertEqual(voice.state().wire(0.0), {"provider": "none", "state": "off", "reason": "not_configured",
                                                   "retry_after_s": None})

    def test_start_failed_reason(self):
        self.assertEqual(NoVoice("start_failed").state().reason, "start_failed")

    def test_events_leave_it_off(self):
        voice, changes = NoVoice(clock=Clock()), []
        voice.on_change = changes.append
        before = voice.state()
        voice.on_speech("speech.finished", {})
        voice.on_speech("speech.failed", {"reason": "unreachable"})
        voice.reset("user")
        self.assertEqual(voice.state(), before)
        self.assertEqual(changes, [])


class ProviderTest(unittest.TestCase):
    def test_starts_unknown_with_its_name(self):
        s = Probe(clock=Clock(3.0)).state()
        self.assertEqual((s.provider, s.state, s.since), ("probe", "unknown", 3.0))

    def test_on_speech_maps_relay_events(self):
        clock = Clock()
        voice = Probe(clock=clock)
        voice.on_speech("speech.failed", {"reason": "bad_stream"})
        self.assertEqual((voice.state().state, voice.state().reason), ("unreachable", "bad_stream"))
        voice.on_speech("speech.finished", {"cancelled": True})
        self.assertEqual((voice.state().state, voice.state().last_ok), ("ready", 100.0))
        clock.now = 200.0
        voice.on_speech("speech.finished", {"total_samples": 10})
        self.assertEqual(voice.state().last_ok, 200.0)
        voice.on_speech("speech.first_audio", {})
        self.assertEqual(voice.state().state, "ready")

    def test_on_change_once_per_change(self):
        clock = Clock()
        voice, changes = Probe(clock=clock), []
        voice.on_change = changes.append
        voice.on_speech("speech.finished", {})
        voice.on_speech("speech.finished", {})
        self.assertEqual([c.state for c in changes], ["ready"])
        clock.now = 100.0 + IDLE + 1
        voice.state()
        voice.state()
        self.assertEqual([c.state for c in changes], ["ready", "cold"])
        voice.reset("user")
        self.assertEqual([c.state for c in changes], ["ready", "cold", "unknown"])


class EnsureRun:
    """Stands in for subprocess.run under TtsEnsurer: answers `stdout` with `code` and counts its calls."""
    def __init__(self, stdout, code):
        self.stdout, self.code, self.calls = stdout, code, 0

    def __call__(self, command, **kwargs):
        self.calls += 1
        return subprocess.CompletedProcess(command, self.code, self.stdout, "")


class Repository:
    def __init__(self, voices):
        self.voices = voices

    def voice(self, character):
        return self.voices.get(character)


def args(tts_url="http://127.0.0.1:9888", host=None, script=None, character="aster"):
    return Namespace(tts_url=tts_url, tts_ensure_host=host, tts_ensure_script=script, character=character)


class RemoteWsVoiceTest(unittest.TestCase):
    def test_ensure_outcomes_drive_the_state(self):
        clock = Clock()
        ensurer = TtsEnsurer("tts-host", "ensure.sh", run=EnsureRun("fail down\n", 1), clock=clock)
        voice, changes = RemoteWsVoice(object(), ensurer, clock=clock), []
        voice.on_change = changes.append
        ensurer.request()
        self.assertFalse(ensurer.wait_ready(5))
        self.assertEqual([c.state for c in changes], ["probing", "unreachable"])
        self.assertEqual(voice.state().wire(clock.now), {"provider": "remote-ws", "state": "unreachable",
                                                         "reason": "ensure:fail down", "retry_after_s": 90.0})
        clock.now = 130.0
        self.assertEqual(voice.state().wire(clock.now)["retry_after_s"], 60.0)

    def test_ensure_ready_is_ready(self):
        clock = Clock()
        ensurer = TtsEnsurer("tts-host", "ensure.sh", run=EnsureRun("ready 3\n", 0), clock=clock)
        voice = RemoteWsVoice(object(), ensurer, clock=clock)
        ensurer.request()
        self.assertTrue(ensurer.wait_ready(5))
        self.assertEqual((voice.state().state, voice.state().last_ok), ("ready", 100.0))

    def test_reset_clears_the_negative_cache(self):
        clock, run = Clock(), EnsureRun("fail down\n", 1)
        ensurer = TtsEnsurer("tts-host", "ensure.sh", run=run, clock=clock)
        voice = RemoteWsVoice(object(), ensurer, clock=clock)
        ensurer.request()
        ensurer.wait_ready(5)
        voice.reset("user")
        self.assertEqual((voice.state().state, voice.state().retry_after), ("unknown", None))
        ensurer.request()
        ensurer.wait_ready(5)
        self.assertEqual(run.calls, 2)

    def test_relay_and_ensurer(self):
        relay = object()
        voice = RemoteWsVoice(relay, clock=Clock())
        self.assertEqual((voice.name, voice.relay(), voice.ensurer), ("remote-ws", relay, None))
        voice.reset("user")
        self.assertEqual(voice.state().state, "unknown")


class Health(BaseHTTPRequestHandler):
    status = 200
    seen = []

    def do_GET(self):
        self.seen.append((self.path, self.headers.get("Authorization")))
        self.send_response(self.status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


class ProbeTest(unittest.TestCase):
    def tts(self, status):
        handler = type("H", (Health,), {"status": status, "seen": []})
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        serve_in_thread(httpd)
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        return f"http://127.0.0.1:{httpd.server_address[1]}/tts", handler.seen

    def voice(self, url, ensurer=None):
        relay = SpeechRelay(url, epoch=1, character="voice_a", language="zh", token="secret")
        voice, changes = RemoteWsVoice(relay, ensurer, clock=Clock()), []
        voice.on_change = changes.append
        return voice, changes

    def test_success_is_ready_and_sends_the_token(self):
        url, seen = self.tts(200)
        voice, changes = self.voice(url)
        voice.probe().join(5)
        self.assertEqual([c.state for c in changes], ["probing", "ready"])
        self.assertEqual((voice.state().state, voice.state().last_ok), ("ready", 100.0))
        self.assertEqual(seen, [("/tts/health", "Bearer secret")])

    def test_failure_with_an_ensurer_is_cold(self):
        url, _ = self.tts(503)
        voice, changes = self.voice(url, TtsEnsurer("tts-host", "ensure.sh", run=EnsureRun("ready 1\n", 0)))
        voice.probe().join(5)
        self.assertEqual([c.state for c in changes], ["probing", "cold"])
        self.assertEqual(voice.state().reason, "probe:http_503")

    def test_failure_without_an_ensurer_is_unreachable(self):
        with socket.socket() as closed:
            closed.bind(("127.0.0.1", 0))
            port = closed.getsockname()[1]
        voice, changes = self.voice(f"http://127.0.0.1:{port}")
        voice.probe().join(5)
        self.assertEqual([c.state for c in changes], ["probing", "unreachable"])
        self.assertEqual(voice.state().reason, "probe:ConnectionRefusedError")

    def test_probe_keeps_retry_after(self):
        url, _ = self.tts(503)
        clock = Clock()
        ensurer = TtsEnsurer("tts-host", "ensure.sh", run=EnsureRun("fail down\n", 1), clock=clock)
        voice = RemoteWsVoice(SpeechRelay(url, epoch=1, character="voice_a", language="zh"), ensurer, clock=clock)
        ensurer.request()
        ensurer.wait_ready(5)
        voice.probe().join(5)
        self.assertEqual((voice.state().state, voice.state().retry_after), ("cold", 100.0 + NEGATIVE))

    def test_a_failed_probe_writes_no_negative_cache(self):
        url, _ = self.tts(503)
        run = EnsureRun("ready 1\n", 0)
        ensurer = TtsEnsurer("tts-host", "ensure.sh", run=run)
        voice, _ = self.voice(url, ensurer)
        voice.probe().join(5)
        ensurer.request()
        self.assertTrue(ensurer.wait_ready(5))
        self.assertEqual(run.calls, 1)


class MakeProviderTest(unittest.TestCase):
    def test_no_tts_url_is_not_configured(self):
        for url in ("", None):
            with self.subTest(url=url):
                voice = make_provider(args(tts_url=url), Repository({}), 7, None)
                self.assertIsInstance(voice, NoVoice)
                self.assertEqual(voice.state().reason, "not_configured")

    def test_tts_url_builds_the_relay_without_ensurer(self):
        voice = make_provider(args(), Repository({"aster": ("voice_a", "ja")}), 7, "secret")
        self.assertIsInstance(voice, RemoteWsVoice)
        relay = voice.relay()
        self.assertIsInstance(relay, SpeechRelay)
        self.assertEqual((relay.port, relay.epoch, relay.character, relay.language, relay.token, relay.ensurer),
                         (9888, "7", "voice_a", "ja", "secret", None))
        self.assertIsNone(voice.ensurer)

    def test_unknown_voice_falls_back_to_the_character_in_chinese(self):
        relay = make_provider(args(character="birch"), Repository({}), 7, None).relay()
        self.assertEqual((relay.character, relay.language), ("birch", "zh"))

    def test_ensure_host_and_script_add_the_ensurer(self):
        voice = make_provider(args(host="tts-host", script="ensure.sh"), Repository({}), 7, None)
        self.assertIsInstance(voice.ensurer, TtsEnsurer)
        self.assertEqual((voice.ensurer.host, voice.ensurer.script), ("tts-host", "ensure.sh"))
        self.assertIs(voice.relay().ensurer, voice.ensurer)
        self.assertIsNone(make_provider(args(host="tts-host"), Repository({}), 7, None).ensurer)


if __name__ == "__main__":
    unittest.main()
