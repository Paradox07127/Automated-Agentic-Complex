from argparse import Namespace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voice import speech as speech_module  # noqa: E402
from voice.speech import SpeechRelay  # noqa: E402
from infra.service_ensure import ServiceEnsurer  # noqa: E402
from voice.voice_provider import make_provider  # noqa: E402
from support import serve_in_thread  # noqa: E402

_spec = importlib.util.spec_from_file_location("c2_validate", ROOT / "protocol/C2-speech-stream/validate.py")
c2 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(c2)


def _cues(ids, index, start, revision, source):
    return {"event": "cues", **ids, "segment_index": index, "revision": revision, "source": source,
            "items": [{"start": start, "end": start + 9600, "vowel": "a", "weight": 0.8}]}


V2_FIELDS = ("utterance_id", "clause_id", "clause_index", "spoken_text_revision", "voice_profile_id",
             "interrupt_policy", "turn_generation", "trace_id")


def upstream_lines(body, segments=2, end="complete", cues=False):
    """A C2 stream as the ws service would send it, echoing the request ids."""
    ids = {k: body[k] for k in ("session_epoch", "turn_id", "speech_id")}
    lines = [{"event": "speech.begin", **ids, "schema": "endfield-speech-timeline-v1",
              "clock": {"unit": "sample", "sample_rate": 48000, "origin": "first_pcm_sample"},
              "format": "pcm_s16le", "channels": 1, "lang": "zh",
              "engine": {"gpt_sovits_commit": "1b47ca07", "variant": "v5dev"},
              "expires_at_ms": body["expires_at_ms"]}]
    if "utterance_id" in body:  # a clause request: its clause fields come back in the begin
        lines[0].update({k: body[k] for k in V2_FIELDS}, schema="endfield-speech-timeline-v2")
    start = 0
    for index in range(segments):
        lines.append({"event": "segment", **ids, "segment_index": index, "norm_text": "你好",
                      "phones": ["n", "i3", "h", "ao3"], "word2ph": [2, 2], "start_sample": start,
                      "semantic_tokens": 20, "token_hop_samples": 1920, "speech_samples": 38400,
                      "tail_silence_samples": 6400})
        lines.append({"event": "audio", **ids, "segment_index": index, "start_sample": start,
                      "samples": 44800, "pcm_base64": "AAAA"})
        if cues:
            lines.append(_cues(ids, index, start, 1, "mrte-attn"))
        start += 44800
    if cues:
        lines += [_cues(ids, index, index * 44800, 2, "mfa") for index in range(segments)]
    if end == "complete":
        lines.append({"event": "complete", **ids, "total_samples": start, "segments": segments,
                      "cues_complete": cues})
    for seq, line in enumerate(lines):
        line["seq"] = seq
    return lines


class FakeTTS(ThreadingHTTPServer):
    def __init__(self, segments=2, end="complete", delay=0.0, cues=False, status=200, fail=None):
        """fail: request number (from 0) -> 500 (refused), "drop" (the stream stops without an end), or a callable
        that rewrites the lines sent."""
        self.segments, self.end, self.delay, self.cues, self.bodies = segments, end, delay, cues, []
        self.status, self.auth = status, []
        self.fail = fail or {}
        self.lock = threading.Lock()
        self.active = self.max_active = 0  # requests synthesizing at once
        super().__init__(("127.0.0.1", 0), _TTSHandler)


class _TTSHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with self.server.lock:
            fail = self.server.fail.get(len(self.server.bodies))
            self.server.bodies.append((self.path, body))
            self.server.active += 1
            self.server.max_active = max(self.server.max_active, self.server.active)
        left = []

        def leave():  # synthesis is over once the last line is out or the stream is cut
            if not left:
                left.append(True)
                with self.server.lock:
                    self.server.active -= 1

        self.server.auth.append(self.headers.get("Authorization"))
        status = 500 if fail == 500 else self.server.status
        if status != 200:
            leave()
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        # The service echoes whatever ids it is given; use foreign ones to prove the rewrite.
        echoed = {**body, "session_epoch": "upstream", "turn_id": "upstream"}
        if "utterance_id" in body:
            echoed.update(turn_generation=99, trace_id="upstream")
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        lines = upstream_lines(echoed, self.server.segments, None if fail == "drop" else self.server.end,
                               self.server.cues)
        if callable(fail):
            lines = fail(lines)
        try:
            for n, line in enumerate(lines):
                if n == len(lines) - 1:
                    leave()
                self.wfile.write((json.dumps(line) + "\n").encode())
                self.wfile.flush()
                time.sleep(self.server.delay)
        except OSError:
            pass
        finally:
            leave()


def wait_until(check, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.02)
    return False


class SpeechRelayTest(unittest.TestCase):
    def test_http_and_https_endpoints_without_user_information(self):
        for url in ("ftp://tts.example", "http://", "tts.example:9888", "http://user:pw@tts.example:9888"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                SpeechRelay(url, epoch=1, character="voice_a", language="zh")
        for url in ("http://127.0.0.1:9888", "http://localhost:9888", "http://[::1]:9888", "http://192.168.1.5:9888",
                    "http://tts.example:9888", "https://tts.example", "https://192.168.1.5:9888"):
            with self.subTest(url=url):
                relay = SpeechRelay(url, epoch=1, character="voice_a", language="zh")
                self.assertIn(relay.scheme, ("http", "https"))

    def relay(self, token=None, **fake):
        tts = FakeTTS(**fake)
        serve_in_thread(tts)
        self.addCleanup(tts.server_close)
        self.addCleanup(tts.shutdown)
        return tts, SpeechRelay(f"http://127.0.0.1:{tts.server_port}", epoch=1792300000, character="voice_a",
                                language="zh", token=token)

    def failures(self, relay):
        seen = []
        relay.on_event = lambda kind, speech_id, attrs: seen.append((kind, speech_id, attrs))
        return seen

    def test_token_goes_as_a_bearer_header(self):
        tts, relay = self.relay(token="tok-1")
        relay.speak("line-1", "一")
        self.collect(relay, 1)
        _, bare = self.relay()
        bare.speak("line-1", "一")
        self.collect(bare, 1)
        self.assertEqual(tts.auth, ["Bearer tok-1"])

    def test_refused_before_begin_reports_speech_failed_once(self):
        # No line ever reached /speech, so the end has to be told some other way.
        for status in (401, 500):
            with self.subTest(status=status):
                tts, relay = self.relay(status=status)
                seen = self.failures(relay)
                speech_id = relay.speak("line-1", "一")
                self.assertTrue(wait_until(lambda: seen))
                self.assertEqual(seen, [("speech.failed", speech_id, {"reason": f"http_{status}"})])
                self.assertFalse(relay.busy())
                self.assertEqual(relay.since(0), [])

    def test_unreachable_service_reports_speech_failed(self):
        relay = SpeechRelay("http://127.0.0.1:9", epoch=1, character="voice_a", language="zh")
        seen = self.failures(relay)
        speech_id = relay.speak("line-1", "x")
        self.assertTrue(wait_until(lambda: seen))
        self.assertEqual(seen, [("speech.failed", speech_id, {"reason": "unreachable"})])

    def test_cut_before_begin_is_not_a_failure(self):
        tts, relay = self.relay(delay=0.2)
        seen = self.failures(relay)
        relay.speak("line-1", "一")
        relay.speak("line-2", "二")
        self.collect(relay, 1)
        time.sleep(0.3)
        self.assertNotIn("speech.failed", [kind for kind, _, _ in seen])

    def collect(self, relay, speeches, timeout=5.0):
        """Lines from the relay's buffer until `speeches` streams have ended."""
        lines, seq, deadline = [], 0, time.monotonic() + timeout
        while time.monotonic() < deadline:
            for item in relay.since(seq):
                seq = item["seq"]
                lines.append(item["data"])
            if sum(l["event"] in ("complete", "cancelled") for l in lines) >= speeches:
                return lines
            relay.wait(seq, 0.1)
        self.fail(f"only {len(lines)} lines arrived")

    def test_forwarded_stream_is_valid_c2_with_our_ids(self):
        tts, relay = self.relay()
        before = time.time() * 1000
        speech_id = relay.speak("line-1", "你好，管理员。")
        lines = self.collect(relay, 1)
        self.assertIsNone(c2.check([json.dumps(l) for l in lines]))
        self.assertEqual({(l["session_epoch"], l["turn_id"], l["speech_id"]) for l in lines},
                         {("1792300000", "line-1", speech_id)})
        path, body = tts.bodies[0]
        self.assertEqual(path, "/speech_stream")
        self.assertEqual((body["character"], body["language"], body["text"], body["allow_unvalidated_pilot"],
                          body["accelerated"], body["session_epoch"], body["turn_id"]),
                         ("voice_a", "zh", "你好，管理员。", True, True, "1792300000", "line-1"))
        self.assertGreater(body["expires_at_ms"], before)

    def test_cues_revisions_pass_through_with_only_ids_rewritten(self):
        tts, relay = self.relay(cues=True)
        speech_id = relay.speak("line-1", "你好")
        lines = self.collect(relay, 1)
        self.assertIsNone(c2.check([json.dumps(l) for l in lines]))
        sent = upstream_lines({**tts.bodies[0][1], "session_epoch": "upstream", "turn_id": "upstream"}, cues=True)
        strip = lambda l: {k: v for k, v in l.items() if k not in ("session_epoch", "turn_id")}
        self.assertEqual([strip(l) for l in lines if l["event"] == "cues"],
                         [strip(l) for l in sent if l["event"] == "cues"])
        self.assertEqual([(l["revision"], l["source"]) for l in lines if l["event"] == "cues"],
                         [(1, "mrte-attn"), (1, "mrte-attn"), (2, "mfa"), (2, "mfa")])
        self.assertTrue(lines[-1]["cues_complete"])
        self.assertEqual({l["speech_id"] for l in lines}, {speech_id})

    def test_cancel_ends_the_stream_with_client_cancel(self):
        _, relay = self.relay(segments=20, delay=0.05)
        relay.speak("line-1", "很长的一句")
        time.sleep(0.4)
        relay.cancel()
        lines = self.collect(relay, 1)
        last = lines[-1]
        self.assertEqual((last["event"], last["reason"]), ("cancelled", "client_cancel"))
        self.assertEqual(last["last_sample_sent"], sum(l["samples"] for l in lines if l["event"] == "audio"))
        self.assertIsNone(c2.check([json.dumps(l) for l in lines]))
        self.assertLess(len(lines), 30)

    def test_new_speech_supersedes_the_running_one(self):
        _, relay = self.relay(segments=20, delay=0.05)
        relay.speak("line-1", "第一句")
        time.sleep(0.3)
        relay.speak("line-2", "第二句")
        lines = self.collect(relay, 2)
        first = [l for l in lines if l["turn_id"] == "line-1"]
        second = [l for l in lines if l["turn_id"] == "line-2"]
        self.assertEqual((first[-1]["event"], first[-1]["reason"]), ("cancelled", "superseded"))
        self.assertEqual(second[-1]["event"], "complete")
        self.assertIsNone(c2.check([json.dumps(l) for l in second]))
        self.assertIsNone(c2.check([json.dumps(l) for l in first]))
        # The first stream ends before the second begins, so the renderer never sees them interleaved.
        self.assertLess(lines.index(first[-1]), lines.index(second[0]))

    def test_upstream_without_an_end_is_closed_as_error(self):
        _, relay = self.relay(end=None)
        relay.speak("line-1", "x")
        lines = self.collect(relay, 1)
        self.assertEqual((lines[-1]["event"], lines[-1]["reason"]), ("cancelled", "error"))
        self.assertIsNone(c2.check([json.dumps(l) for l in lines]))

    def test_a_stream_line_that_is_no_c2_line_ends_the_stream_as_error(self):
        bad = {"not an object": [], "text seq": {"seq": "1"}, "text samples": {"samples": "480"},
               "skipped seq": {"seq": 2}, "unknown event": {"event": "chunk"}}
        for name, change in bad.items():
            with self.subTest(name):
                edit = (lambda c: lambda lines: [lines[0], c if isinstance(c, list) else {**lines[2], "seq": 1, **c}])(change)
                _, relay = self.relay(fail={0: edit})
                speech_id = relay.speak("line-1", "x")
                lines = self.collect(relay, 1)
                self.assertTrue(relay._speeches[speech_id].done.is_set())
                self.assertEqual([l["event"] for l in lines], ["speech.begin", "cancelled"])
                self.assertEqual((lines[-1]["seq"], lines[-1]["reason"]), (1, "error"))
                self.assertIsNone(c2.check([json.dumps(l) for l in lines]))

    def test_a_foreign_speech_id_from_the_tts_is_replaced_by_ours(self):
        _, relay = self.relay(fail={0: lambda lines: [{**l, "speech_id": "foreign"} for l in lines]})
        speech_id = relay.speak("line-1", "x")
        self.assertEqual({l["speech_id"] for l in self.collect(relay, 1)}, {speech_id})

    def test_cancel_by_speech_id(self):
        _, relay = self.relay(segments=20, delay=0.05)
        self.assertEqual(relay.cancel_speech("nope"), "unknown")
        speech_id = relay.speak("line-1", "很长的一句")
        time.sleep(0.3)
        self.assertEqual(relay.cancel_speech(speech_id), "cancelled")
        lines = self.collect(relay, 1)
        self.assertEqual((lines[-1]["event"], lines[-1]["reason"]), ("cancelled", "client_cancel"))
        self.assertEqual(relay.cancel_speech(speech_id), "ended")

    def test_cancel_without_id_stops_the_playing_speech_only(self):
        _, relay = self.relay(segments=20, delay=0.05)
        self.assertFalse(relay.cancel())
        relay.speak("line-1", "很长的一句")
        time.sleep(0.3)
        self.assertTrue(relay.cancel())
        lines = self.collect(relay, 1)
        self.assertEqual((lines[-1]["event"], lines[-1]["reason"]), ("cancelled", "client_cancel"))
        self.assertFalse(relay.cancel())

    def test_cancel_after_complete_while_unity_still_plays(self):
        _, relay = self.relay(segments=1)  # 44800 samples: 0.933 s of audio, synthesized at once
        now = [100.0]
        relay.clock = lambda: now[0]
        relay.speak("line-1", "一句")
        self.collect(relay, 1)
        before = len(relay.since(0))
        now[0] += 0.9
        self.assertTrue(relay.cancel())
        self.assertEqual(relay.interrupted(), "line-1")
        self.assertFalse(relay.cancel())
        self.assertEqual(len(relay.since(0)), before)  # the stream already ended: no second end line
        # Control: past the estimated playback there is nothing to cancel.
        relay.speak("line-2", "又一句")
        self.collect(relay, 2)
        now[0] += 0.94
        self.assertFalse(relay.cancel())
        self.assertIsNone(relay.interrupted())

    def test_cancel_by_id_after_complete_while_unity_still_plays(self):
        _, relay = self.relay(segments=1)
        now = [100.0]
        relay.clock = lambda: now[0]
        speech_id = relay.speak("line-1", "一句")
        self.collect(relay, 1)
        now[0] += 0.9
        self.assertEqual(relay.cancel_speech(speech_id), "cancelled")
        self.assertEqual(relay.interrupted(), "line-1")
        # Control: past the estimated playback the speech is over.
        speech_id = relay.speak("line-2", "又一句")
        self.collect(relay, 2)
        now[0] += 0.94
        self.assertEqual(relay.cancel_speech(speech_id), "ended")
        self.assertIsNone(relay.interrupted())

    def test_busy_until_estimated_playback_ends(self):
        _, relay = self.relay(segments=1)
        now = [100.0]
        relay.clock = lambda: now[0]
        self.assertFalse(relay.busy())
        relay.speak("line-1", "一句")
        self.assertTrue(relay.busy())  # still synthesizing
        self.collect(relay, 1)
        now[0] += 0.9
        self.assertTrue(relay.busy())  # complete, the renderer still plays
        now[0] += 0.04
        self.assertFalse(relay.busy())
        relay.speak("line-2", "又一句")
        self.collect(relay, 2)
        relay.cancel()
        self.assertFalse(relay.busy())

    def test_cancel_by_old_speech_id_leaves_the_current_one_alone(self):
        _, relay = self.relay(segments=20, delay=0.05)
        old = relay.speak("line-1", "一")
        time.sleep(0.2)
        relay.speak("line-2", "二")
        self.assertEqual(relay.cancel_speech(old), "ended")
        lines = self.collect(relay, 2)
        self.assertEqual(lines[-1]["event"], "complete")

    def test_a_speech_stuck_before_its_socket_does_not_hold_the_lock(self):
        tts, relay = self.relay()
        gate = threading.Event()
        self.addCleanup(gate.set)
        real = speech_module.http.client.HTTPConnection.connect
        connects = []

        def held(conn):  # only the first speech hangs in connect
            connects.append(conn)
            if len(connects) == 1:
                gate.wait(5)
            return real(conn)
        with mock.patch.object(speech_module.http.client.HTTPConnection, "connect", held):
            stuck = relay.speak("line-1", "一")
            self.assertTrue(wait_until(lambda: connects))
            threading.Thread(target=relay.cancel, daemon=True).start()
            self.assertTrue(wait_until(lambda: relay._speeches[stuck].reason))
            started = time.monotonic()
            relay.busy()
            relay.receipt(stuck, "started", 0, 48000)
            self.assertLess(time.monotonic() - started, 0.1)
            relay.speak("line-2", "二")
            lines = self.collect(relay, 1)
            gate.set()
            self.assertTrue(relay._speeches[stuck].done.wait(2))
        self.assertEqual(relay._speeches[stuck].state, "cancelled")
        self.assertEqual({item["data"]["turn_id"] for item in relay.since(0)}, {"line-2"})
        self.assertEqual(lines[-1]["event"], "complete")

    def test_cancel_returns_once_the_end_line_is_out_so_it_precedes_the_next_begin(self):
        _, relay = self.relay(segments=20, delay=0.05)
        relay.speak("line-1", "很长的一句")
        self.assertTrue(wait_until(lambda: relay.since(0)))
        relay.cancel()
        self.assertEqual(relay.since(0)[-1]["data"]["event"], "cancelled")
        relay.speak("line-2", "又一句")
        lines = self.collect(relay, 2, timeout=10.0)
        first = [l for l in lines if l["turn_id"] == "line-1"]
        second = [l for l in lines if l["turn_id"] == "line-2"]
        self.assertEqual((first[-1]["event"], first[-1]["reason"]), ("cancelled", "client_cancel"))
        self.assertLess(lines.index(first[-1]), lines.index(second[0]))

    def test_unreachable_service_forwards_nothing(self):
        relay = SpeechRelay("http://127.0.0.1:9", epoch=1, character="voice_a", language="zh")
        relay.speak("line-1", "x")
        time.sleep(0.3)
        self.assertEqual(relay.since(0), [])


class ReceiptTest(unittest.TestCase):
    """The renderer's playback receipts decide busy; 44800 samples per segment are 0.933 s of audio."""
    collect = SpeechRelayTest.collect

    def spoken(self, text="一句", segments=1, generation=None, relay=None):
        """A synthesized speech on a relay with a hand-moved clock: (relay, now, speech_id)."""
        if relay is None:
            tts = FakeTTS(segments=segments)
            serve_in_thread(tts)
            self.addCleanup(tts.server_close)
            self.addCleanup(tts.shutdown)
            self.now = [100.0]
            relay = SpeechRelay(f"http://127.0.0.1:{tts.server_port}", epoch=1, character="voice_a", language="zh",
                                clock=lambda: self.now[0])
            self.ended = 0
        speech_id = relay.speak(f"line-{self.ended + 1}", text, generation)
        self.ended += 1
        self.collect(relay, self.ended)
        return relay, speech_id

    def test_buffering_past_the_estimate_is_still_busy(self):
        relay, speech_id = self.spoken()
        self.assertEqual(relay.receipt(speech_id, "started", 0, 48000), (True, None))
        self.now[0] += 0.5
        self.assertEqual(relay.receipt(speech_id, "buffering", 24000, 48000), (True, None))
        self.now[0] += 1.0  # past first audio + 0.933 s
        self.assertTrue(relay.busy())
        self.assertEqual(relay.receipt(speech_id, "ended", 44800, 48000), (True, None))
        self.assertFalse(relay.busy())
        self.assertEqual(relay._current.playback_ended_at, self.now[0])

    def test_failed_playback_frees_at_once(self):
        relay, speech_id = self.spoken()
        relay.receipt(speech_id, "started", 0, 48000)
        self.assertTrue(relay.busy())
        self.assertEqual(relay.receipt(speech_id, "failed", 100, 48000, "device_lost"), (True, None))
        self.assertFalse(relay.busy())

    def test_silence_after_a_receipt_counts_as_lost(self):
        relay, speech_id = self.spoken()
        relay.receipt(speech_id, "started", 0, 48000)
        self.now[0] += speech_module.RECEIPT_STALE + 0.9
        self.assertTrue(relay.busy())  # still within the audio left plus the slack
        self.now[0] += 0.1
        self.assertFalse(relay.busy())
        self.assertEqual(relay._current.played, "unknown")
        self.assertEqual(relay.receipt(speech_id, "ended", 44800, 48000), (False, "already_ended"))

    def test_connection_lost_is_unknown_not_a_user_interrupt(self):
        relay, speech_id = self.spoken()
        relay.receipt(speech_id, "started", 0, 48000)
        self.assertEqual(relay.receipt(speech_id, "interrupted", 9600, 48000, "connection_lost"), (True, None))
        self.assertEqual(relay._current.played, "unknown")
        self.assertFalse(relay._current.interrupted)
        self.assertIsNone(relay.interrupted())
        self.assertFalse(relay.busy())

    def test_interrupt_after_synthesis_ended_counts(self):
        relay, speech_id = self.spoken()
        relay.receipt(speech_id, "started", 0, 48000)
        self.assertEqual(relay.receipt(speech_id, "interrupted", 20000, 48000, "barge_in"), (True, None))
        self.assertEqual(relay.interrupted(), "line-1")
        self.assertFalse(relay.busy())

    def test_old_speech_receipt_leaves_the_new_turn_alone(self):
        relay, old = self.spoken(generation=1)
        relay.generation = 2
        relay, new = self.spoken(generation=2, relay=relay)
        relay.receipt(new, "started", 0, 48000)
        self.assertEqual(relay.receipt(old, "buffering", 4800, 48000), (False, "superseded"))
        # An old speech's end still settles that speech (what the user heard of it), never the new one.
        self.assertEqual(relay.receipt(old, "interrupted", 22400, 48000, "barge_in"), (True, None))
        self.assertEqual(relay.heard(old)[0], relay.heard(old)[1][:round(len(relay.heard(old)[1]) / 2)])
        self.assertEqual(relay._current.played, "started")
        self.assertTrue(relay.busy())
        # Control: the same receipt for the current speech applies.
        self.assertEqual(relay.receipt(new, "ended", 44800, 48000), (True, None))
        self.assertFalse(relay.busy())

    def test_unknown_id_and_second_end(self):
        relay, speech_id = self.spoken()
        self.assertEqual(relay.receipt("nope", "started", 0, 48000), (False, "unknown_speech"))
        self.assertEqual(relay.receipt(speech_id, "ended", 44800, 48000), (True, None))
        self.assertEqual(relay.receipt(speech_id, "ended", 44800, 48000), (False, "already_ended"))

    def test_heard_is_the_played_share_of_the_text(self):
        relay, speech_id = self.spoken(text="一二三四五六")
        self.assertEqual(relay.heard(speech_id), ("一二三四五六", "一二三四五六"))
        relay.receipt(speech_id, "started", 0, 48000)
        relay.receipt(speech_id, "interrupted", 22400, 48000, "barge_in")
        self.assertEqual(relay.heard(speech_id), ("一二三", "一二三四五六"))

    def test_heard_of_a_speech_cut_while_synthesizing_is_not_the_whole_text(self):
        relay, speech_id = self.spoken(text="一二三四五六七八九十" * 2)
        speech = relay._speeches[speech_id]
        speech.total_samples, speech.sent_samples = None, 4800  # interrupted before `complete`
        relay.receipt(speech_id, "interrupted", 4800, 48000, "barge_in")
        self.assertNotEqual(relay.heard(speech_id)[0], speech.text)


TRACE = "7d0c2f1e-5a3b-4c6d-8e9f-0a1b2c3d4e5f"


class UtteranceTest(unittest.TestCase):
    """One line spoken clause by clause, one C2 stream per clause."""
    relay = SpeechRelayTest.relay
    failures = SpeechRelayTest.failures
    collect = SpeechRelayTest.collect

    def streams(self, lines):
        """Forwarded lines per speech_id, in the order the streams began."""
        out = {}
        for line in lines:
            out.setdefault(line["speech_id"], []).append(line)
        return out

    def states(self, relay, utterance_id, count):
        """Each clause's end state once all `count` clauses have one."""
        settled = lambda: [c["state"] for c in relay.utterance(utterance_id)]
        self.assertTrue(wait_until(lambda: len(settled()) == count and None not in settled()))
        return settled()

    def spoken(self, relay, texts, **begin):
        utterance_id = relay.begin_utterance("line-1", **begin)
        ids = [relay.add_clause(utterance_id, text) for text in texts]
        relay.end_utterance(utterance_id)
        return utterance_id, ids

    def test_clauses_go_in_order_one_at_a_time_as_valid_v2_streams(self):
        tts, relay = self.relay(delay=0.01)
        texts = ["嗯，我们先看看报错吧。", "然后再说，", "好吗？"]
        utterance_id, ids = self.spoken(relay, texts, generation=7, trace_id=TRACE)
        lines = self.collect(relay, 3)
        streams = self.streams(lines)
        self.assertEqual(list(streams), ids)
        self.assertEqual([l["speech_id"] for l in lines], sorted((l["speech_id"] for l in lines), key=ids.index))
        for stream in streams.values():
            self.assertIsNone(c2.check([json.dumps(l) for l in stream]))
        self.assertEqual([(s[0]["schema"], s[0]["clause_index"], s[0]["turn_generation"], s[0]["trace_id"],
                           s[0]["utterance_id"], s[0]["turn_id"]) for s in streams.values()],
                         [("endfield-speech-timeline-v2", i, 7, TRACE, utterance_id, "line-1") for i in range(3)])
        bodies = [body for _, body in tts.bodies]
        self.assertEqual([b["text"] for b in bodies], texts)
        self.assertEqual([b["speech_id"] for b in bodies], ids)
        self.assertEqual(len(set(ids)), 3)
        for index, body in enumerate(bodies):
            self.assertEqual({k: body[k] for k in V2_FIELDS},
                             {"utterance_id": utterance_id, "clause_id": f"{utterance_id}.c{index}",
                              "clause_index": index, "spoken_text_revision": 1,
                              "voice_profile_id": "voice_a.zh.default", "interrupt_policy": "immediate",
                              "turn_generation": 7, "trace_id": TRACE})
        self.assertEqual(tts.max_active, 1)
        self.assertEqual(self.states(relay, utterance_id, 3), ["ready"] * 3)
        self.assertEqual([c["text"] for c in relay.utterance(utterance_id)], texts)

    def test_a_bad_stream_line_ends_the_utterance_and_the_next_one_still_synthesizes(self):
        tts, relay = self.relay(fail={0: lambda lines: [lines[0], []]})
        first, _ = self.spoken(relay, ["甲乙丙丁，"])
        self.assertIn(self.states(relay, first, 1)[0], ("failed", "cancelled"))
        second, _ = self.spoken(relay, ["一二三四五六"])
        self.assertEqual(self.states(relay, second, 1), ["ready"])
        self.assertEqual(len(tts.bodies), 2)

    def test_clause_ref_names_a_clause_as_c1_clause_intent_does(self):
        _, relay = self.relay()
        utterance_id, ids = self.spoken(relay, ["你好，管理员。", "今天先看构建。"])
        self.assertEqual([relay.clause_ref(i) for i in ids],
                         [{"utterance_id": utterance_id, "clause_id": f"{utterance_id}.c{index}",
                           "spoken_text_revision": 1} for index in range(2)])
        self.assertIsNone(relay.clause_ref(relay.speak("line-2", "嗯。")))  # a whole line is no clause
        self.assertIsNone(relay.clause_ref("unknown"))

    def test_a_failed_clause_is_skipped_and_the_rest_still_go(self):
        for fail, ends, states in (({0: 500}, 2, ["failed", "ready", "ready"]),
                                   ({1: "drop"}, 3, ["ready", "failed", "ready"])):
            with self.subTest(fail=fail):
                tts, relay = self.relay(fail=fail)
                seen = self.failures(relay)
                utterance_id, ids = self.spoken(relay, ["第一个分句，", "第二个分句，", "第三个分句。"])
                streams = self.streams(self.collect(relay, ends))
                self.assertEqual(self.states(relay, utterance_id, 3), states)
                self.assertEqual(len(tts.bodies), 3)
                for stream in streams.values():
                    self.assertIsNone(c2.check([json.dumps(l) for l in stream]))
                if 0 in fail:
                    self.assertNotIn(ids[0], streams)
                    self.assertIn(("speech.failed", ids[0], {"reason": "http_500"}), seen)
                else:
                    last = streams[ids[1]][-1]
                    self.assertEqual((last["event"], last["reason"]), ("cancelled", "error"))
                    self.assertEqual(streams[ids[2]][-1]["event"], "complete")

    def test_immediate_cut_ends_the_current_stream_and_drops_the_queue(self):
        for how in ("by_id", "current"):
            with self.subTest(how=how):
                tts, relay = self.relay(segments=10, delay=0.03)
                utterance_id, _ = self.spoken(relay, ["第一个分句，", "第二个分句，", "第三个分句。"])
                self.assertTrue(wait_until(lambda: relay.since(0)))
                self.assertTrue(relay.busy())
                if how == "by_id":
                    self.assertTrue(relay.cancel_utterance(utterance_id, "client_cancel"))
                else:
                    self.assertTrue(relay.cancel())
                lines = self.collect(relay, 1)
                self.assertEqual((lines[-1]["event"], lines[-1]["reason"]), ("cancelled", "client_cancel"))
                self.assertIsNone(c2.check([json.dumps(l) for l in lines]))
                self.assertEqual(self.states(relay, utterance_id, 3), ["cancelled"] * 3)
                self.assertFalse(relay.busy())
                time.sleep(0.2)
                self.assertEqual(len(tts.bodies), 1)

    def test_clause_end_cut_lets_the_current_stream_finish_and_drops_the_queue(self):
        for how in ("by_id", "current"):
            with self.subTest(how=how):
                tts, relay = self.relay(segments=10, delay=0.02)
                utterance_id, _ = self.spoken(relay, ["第一个分句，", "第二个分句，", "第三个分句。"],
                                              interrupt_policy="clause_end")
                self.assertTrue(wait_until(lambda: relay.since(0)))
                if how == "by_id":
                    self.assertTrue(relay.cancel_utterance(utterance_id, "client_cancel"))
                else:
                    self.assertTrue(relay.cancel())
                lines = self.collect(relay, 1)
                self.assertEqual(lines[-1]["event"], "complete")
                self.assertNotIn("cancelled", [l["event"] for l in lines])
                self.assertIsNone(c2.check([json.dumps(l) for l in lines]))
                self.assertEqual(self.states(relay, utterance_id, 3), ["ready", "cancelled", "cancelled"])
                time.sleep(0.2)
                self.assertEqual(len(tts.bodies), 1)

    def test_a_new_utterance_ends_the_old_one_by_the_old_ones_policy(self):
        for policy, end, first_state in (("immediate", "cancelled", "cancelled"),
                                         ("clause_end", "complete", "ready")):
            with self.subTest(policy=policy):
                tts, relay = self.relay(segments=10, delay=0.02)
                old = relay.begin_utterance("line-1", interrupt_policy=policy)
                relay.add_clause(old, "旧台词第一句，")
                relay.add_clause(old, "旧台词第二句。")
                self.assertTrue(wait_until(lambda: relay.since(0)))
                new = relay.begin_utterance("line-2")
                relay.add_clause(new, "新台词的一句。")
                relay.end_utterance(new)
                lines = self.collect(relay, 2)
                first = [l for l in lines if l["turn_id"] == "line-1"]
                second = [l for l in lines if l["turn_id"] == "line-2"]
                self.assertEqual(first[-1]["event"], end)
                if end == "cancelled":
                    self.assertEqual(first[-1]["reason"], "superseded")
                self.assertEqual(second[-1]["event"], "complete")
                self.assertLess(lines.index(first[-1]), lines.index(second[0]))
                self.assertEqual([b["text"] for _, b in tts.bodies], ["旧台词第一句，", "新台词的一句。"])
                self.assertEqual(self.states(relay, old, 2), [first_state, "cancelled"])
                self.assertEqual(self.states(relay, new, 1), ["ready"])

    def test_heard_is_the_ended_clauses_and_the_heard_share_of_the_interrupted_one(self):
        _, relay = self.relay(segments=1)
        utterance_id, ids = self.spoken(relay, ["甲乙丙丁，", "一二三四五六"])
        self.collect(relay, 2)
        self.assertEqual(relay.heard_utterance(utterance_id), "")  # synthesized, but the renderer reported nothing
        relay.receipt(ids[0], "started", 0, 48000)
        relay.receipt(ids[0], "ended", 44800, 48000)
        relay.receipt(ids[1], "started", 0, 48000)
        self.assertTrue(relay.busy())
        relay.receipt(ids[1], "interrupted", 22400, 48000, "barge_in")
        self.assertEqual(relay.heard_utterance(utterance_id), "甲乙丙丁，一二三")
        self.assertFalse(relay.busy())

    def test_clause_end_supersede_keeps_the_streaming_clause_across_a_generation_bump(self):
        # The clause streaming now goes on to its end although turn_generation moved.
        tts, relay = self.relay(segments=10, delay=0.02)
        relay.generation = 1
        old = relay.begin_utterance("line-1", generation=1, interrupt_policy="clause_end")
        relay.add_clause(old, "旧台词第一句，")
        relay.add_clause(old, "旧台词第二句。")
        self.assertTrue(wait_until(lambda: relay.since(0)))
        new = relay.begin_utterance("line-2", generation=2)
        relay.generation = 2
        relay.add_clause(new, "新台词的一句。")
        relay.end_utterance(new)
        lines = self.collect(relay, 2)
        first = [l for l in lines if l["turn_id"] == "line-1"]
        self.assertEqual(first[-1]["event"], "complete")
        self.assertNotIn("cancelled", [l["event"] for l in first])
        self.assertEqual(self.states(relay, old, 2), ["ready", "cancelled"])
        self.assertEqual([b["text"] for _, b in tts.bodies], ["旧台词第一句，", "新台词的一句。"])

    def test_clause_end_cut_drops_a_synthesized_clause_after_the_one_playing(self):
        tts, relay = self.relay(segments=1)  # 0.933 s of audio per clause
        now = [100.0]
        relay.clock = lambda: now[0]
        utterance_id = relay.begin_utterance("line-1", interrupt_policy="clause_end")
        for text in ("甲乙丙丁，", "一二三四五六"):
            relay.add_clause(utterance_id, text)
        self.collect(relay, 2)  # both synthesized, the line still streams
        now[0] += 0.5  # the first clause plays, the second waits in the renderer
        self.assertTrue(relay.cancel())
        self.assertEqual([c["state"] for c in relay.utterance(utterance_id)], ["ready", "cancelled"])
        self.assertTrue(relay.busy())
        now[0] += 0.44  # past the first clause's estimate, inside where the second would play
        self.assertFalse(relay.busy())
        self.assertEqual(relay.heard_utterance(utterance_id), "")  # an estimate is not a receipt
        relay.receipt(relay.utterance(utterance_id)[0]["speech_id"], "ended", 44800, 48000)
        self.assertEqual(relay.heard_utterance(utterance_id), "甲乙丙丁，")
        self.assertEqual(relay.interrupted(), "line-1")

    def test_clause_end_supersede_cuts_after_the_playing_clause_not_the_streaming_one(self):
        tts, relay = self.relay(segments=10, delay=0.02)
        relay.generation = 1
        old = relay.begin_utterance("line-1", generation=1, interrupt_policy="clause_end")
        ids = [relay.add_clause(old, text) for text in ("甲乙丙丁，", "一二三四，", "五六七八。")]
        streamed = lambda: {item["data"]["speech_id"] for item in relay.since(0)}
        self.assertTrue(wait_until(lambda: ids[2] in streamed()))
        relay.receipt(ids[0], "started", 0, 48000)  # the renderer plays clause 1; clause 2 waits there, clause 3 streams
        new = relay.begin_utterance("line-2", generation=2)
        relay.generation = 2
        self.assertEqual([c["state"] for c in relay.utterance(old)], ["ready", "cancelled", "cancelled"])
        relay.receipt(ids[0], "ended", 44800, 48000)  # clause 1 plays to its end
        self.assertEqual(relay.heard_utterance(old), "甲乙丙丁，")
        relay.add_clause(new, "新台词。")
        relay.end_utterance(new)
        lines = [l for l in self.collect(relay, 4) if l["speech_id"] == ids[2]]
        self.assertEqual((lines[-1]["event"], lines[-1]["reason"]), ("cancelled", "superseded"))

    def test_immediate_cancel_cuts_a_clause_end_stream(self):
        tts, relay = self.relay(segments=10, delay=0.03)
        utterance_id, _ = self.spoken(relay, ["第一个分句，", "第二个分句，", "第三个分句。"],
                                      interrupt_policy="clause_end")
        self.assertTrue(wait_until(lambda: relay.since(0)))
        self.assertTrue(relay.cancel(immediate=True))
        lines = self.collect(relay, 1)
        self.assertEqual((lines[-1]["event"], lines[-1]["reason"]), ("cancelled", "client_cancel"))
        self.assertEqual(self.states(relay, utterance_id, 3), ["cancelled"] * 3)
        self.assertFalse(relay.busy())

    def test_cancel_by_clause_id_cuts_its_utterance(self):
        tts, relay = self.relay(segments=10, delay=0.03)
        utterance_id, ids = self.spoken(relay, ["第一个分句，", "第二个分句，", "第三个分句。"],
                                        interrupt_policy="clause_end")
        self.assertTrue(wait_until(lambda: relay.since(0)))
        self.assertEqual(relay.cancel_speech(ids[0]), "cancelled")
        lines = self.collect(relay, 1)
        self.assertEqual((lines[-1]["event"], lines[-1]["reason"]), ("cancelled", "client_cancel"))
        self.assertEqual(self.states(relay, utterance_id, 3), ["cancelled"] * 3)
        time.sleep(0.2)
        self.assertEqual(len(tts.bodies), 1)
        self.assertEqual(relay.cancel_speech(ids[0]), "ended")


class _PortTTS(FakeTTS):
    """A FakeTTS on a given port."""
    def __init__(self, port, **fake):
        self.port = port
        super().__init__(**fake)

    def server_bind(self):
        self.server_address = ("127.0.0.1", self.port)
        super().server_bind()


class EnsureTest(unittest.TestCase):
    """A TTS that is down at the first connect is started by the ensurer and tried once more."""
    collect = SpeechRelayTest.collect
    failures = SpeechRelayTest.failures

    def setUp(self):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        self.port = probe.getsockname()[1]
        probe.close()  # nothing listens there until the ensurer starts the fake TTS
        self.tts = None

    def tearDown(self):
        if self.tts is not None:
            self.tts.shutdown()
            self.tts.server_close()

    def start_tts(self):
        self.tts = _PortTTS(self.port)
        serve_in_thread(self.tts)

    def relay(self, run, ensurer=True):
        self.run = FakeRun(run)
        self.ensurer = ServiceEnsurer("tts", "ws", "ensure.sh", run=self.run) if ensurer else None
        return SpeechRelay(f"http://127.0.0.1:{self.port}", epoch=1, character="voice_a", language="zh",
                           ensurer=self.ensurer)

    def test_unreachable_tts_is_started_and_the_speech_is_voiced(self):
        def run():
            self.start_tts()
            return "ready 3\n", 0
        relay = self.relay(run)
        seen = self.failures(relay)
        speech_id = relay.speak("line-1", "你好")
        lines = self.collect(relay, 1)
        self.assertEqual(lines[-1]["event"], "complete")
        self.assertTrue(any(l["event"] == "audio" for l in lines))
        self.assertNotIn(("speech.failed", speech_id, {"reason": "unreachable"}), seen)
        self.assertEqual(len(self.run.calls), 1)

    def test_tunnel_that_drops_the_connection_is_started_and_the_speech_is_voiced(self):
        # ssh -L accepts locally and then closes when nothing listens on ws, so connect() itself succeeds.
        tunnel = socket.socket()
        tunnel.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        tunnel.bind(("127.0.0.1", self.port))
        tunnel.listen()

        def drop():
            while True:
                try:
                    conn, _ = tunnel.accept()
                except OSError:
                    return
                conn.recv(65536)
                conn.close()
        threading.Thread(target=drop, daemon=True).start()

        def run():
            try:
                tunnel.shutdown(socket.SHUT_RDWR)  # release a blocked accept on Linux too
            except OSError:  # macOS refuses shutdown on a listening socket (ENOTCONN)
                pass
            tunnel.close()
            self.start_tts()
            return "ready 3\n", 0
        relay = self.relay(run)
        seen = self.failures(relay)
        speech_id = relay.speak("line-1", "你好")
        lines = self.collect(relay, 1)
        self.assertEqual(lines[-1]["event"], "complete")
        self.assertNotIn(("speech.failed", speech_id, {"reason": "unreachable"}), seen)
        self.assertEqual(len(self.run.calls), 1)

    def test_failed_ensure_reports_unreachable_without_a_retry(self):
        connects = []
        relay = self.relay(lambda: ("fail gpu busy\n", 1))
        real = speech_module.http.client.HTTPConnection.connect

        def counted(conn):
            connects.append(conn)
            return real(conn)
        with mock.patch.object(speech_module.http.client.HTTPConnection, "connect", counted):
            seen = self.failures(relay)
            speech_id = relay.speak("line-1", "你好")
            self.assertTrue(wait_until(lambda: seen))
        self.assertEqual(seen, [("speech.failed", speech_id, {"reason": "unreachable"})])
        self.assertEqual(len(connects), 1)
        self.assertEqual(len(self.run.calls), 1)

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_a_speech_after_a_failed_ensure_fails_at_once_without_another_ensure(self):
        relay = self.relay(lambda: ("fail gpu busy\n", 1))
        seen = self.failures(relay)
        first = relay.speak("line-1", "你好")
        self.assertTrue(wait_until(lambda: seen))
        started = time.monotonic()
        second = relay.speak("line-2", "你好")
        self.assertTrue(wait_until(lambda: len(seen) == 2, timeout=1.0))
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertEqual(seen, [("speech.failed", first, {"reason": "unreachable"}),
                                ("speech.failed", second, {"reason": "unreachable"})])
        self.assertEqual(len(self.run.calls), 1)

    @unittest.skipIf(sys.platform == "win32", "timing bound tuned on macOS")
    def test_a_cancelled_speech_does_not_wait(self):
        gate = threading.Event()
        self.addCleanup(gate.set)

        def run():
            gate.wait(5)
            return "ready 3\n", 0
        relay = self.relay(run)
        speech = speech_module._Speech("line-1", "s1")
        speech.reason = "client_cancel"
        started = time.monotonic()
        relay._run(speech, "你好")
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertEqual(speech.state, "cancelled")
        self.assertEqual(self.run.calls, [])

    def stuck_relay(self):
        """A relay whose TTS is down and whose ensure never ends."""
        ensurer = StuckEnsurer()
        self.addCleanup(ensurer.gate.set)
        return ensurer, SpeechRelay(f"http://127.0.0.1:{self.port}", epoch=1, character="voice_a", language="zh",
                                    ensurer=ensurer)

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_a_speech_cut_while_ensuring_ends_at_once(self):
        ensurer, relay = self.stuck_relay()
        speech_id = relay.speak("line-1", "你好")
        self.assertTrue(ensurer.waiting.wait(2))
        self.assertEqual(relay.cancel_speech(speech_id), "cancelled")
        self.assertTrue(relay._speeches[speech_id].done.wait(1))
        self.assertEqual(relay._speeches[speech_id].state, "cancelled")

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_an_utterance_cut_while_waiting_for_the_one_before_ends_at_once(self):
        ensurer, relay = self.stuck_relay()
        first = relay.begin_utterance("line-1", interrupt_policy="clause_end")
        relay.add_clause(first, "旧台词的一句。")
        self.assertTrue(ensurer.waiting.wait(2))
        second = relay.begin_utterance("line-2")  # clause_end: the first one's clause keeps ensuring
        relay.add_clause(second, "新台词的一句。")
        relay.cancel_utterance(second)
        self.assertTrue(relay._utterances[second].finished.wait(1))
        self.assertFalse(relay._utterances[first].finished.is_set())
        self.assertIsNone(relay.utterance(first)[0]["state"])

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_the_utterance_after_a_cut_waiter_still_waits_for_the_one_it_waited_for(self):
        ensurer, relay = self.stuck_relay()
        first = relay.begin_utterance("line-1", interrupt_policy="clause_end")
        relay.add_clause(first, "旧台词的一句。")
        self.assertTrue(ensurer.waiting.wait(2))
        second = relay.begin_utterance("line-2")
        relay.add_clause(second, "新台词的一句。")
        relay.cancel_utterance(second)
        self.assertTrue(relay._utterances[second].finished.wait(1))
        third = relay.begin_utterance("line-3")
        relay.add_clause(third, "第三句。")
        time.sleep(0.6)
        self.assertEqual(len(relay._utterances[third].queue), 1)  # not requested while the first one synthesizes
        ensurer.gate.set()
        self.assertTrue(relay._utterances[first].finished.wait(2))
        self.assertTrue(wait_until(lambda: not relay._utterances[third].queue, timeout=2.0))

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_without_an_ensurer_unreachable_is_reported_at_once(self):
        relay = self.relay(lambda: self.fail("no ensurer runs"), ensurer=False)
        seen = self.failures(relay)
        speech_id = relay.speak("line-1", "你好")
        self.assertTrue(wait_until(lambda: seen, timeout=1.0))
        self.assertEqual(seen, [("speech.failed", speech_id, {"reason": "unreachable"})])


class RemoteFailureTest(unittest.TestCase):
    """A remote TTS that fails before its first line fails the line; agentd asks no other TTS address."""

    def tts(self, **fake):
        tts = FakeTTS(**fake)
        serve_in_thread(tts)
        self.addCleanup(tts.server_close)
        self.addCleanup(tts.shutdown)
        return tts

    def test_a_5xx_fails_the_line_without_asking_another_address(self):
        tts, other = self.tts(status=503), self.tts()
        args = Namespace(tts_url=f"http://127.0.0.1:{tts.server_port}", tts_ensure_host=None, tts_ensure_script=None,
                         character="voice_a",
                         fallback_tts_url=f"http://127.0.0.1:{other.server_port}")
        voice = make_provider(args, Namespace(voice=lambda character: None), 1, "tok-1")
        relay, seen = voice.relay(), []
        relay.on_event = lambda kind, speech_id, attrs: (seen.append((kind, speech_id, attrs)),
                                                         voice.on_speech(kind, attrs))
        speech_id = relay.speak("line-1", "你好")
        self.assertTrue(wait_until(lambda: not relay.busy() and seen))
        self.assertEqual(other.bodies, [])
        self.assertEqual(len(tts.bodies), 1)
        self.assertEqual(seen, [("speech.failed", speech_id, {"reason": "http_503"})])
        self.assertEqual((voice.state().state, voice.state().reason), ("unreachable", "http_503"))
        self.assertEqual(relay.since(0), [])

    def test_a_tts_host_that_does_not_answer_is_given_up_after_the_connect_timeout(self):
        relay = SpeechRelay("http://192.0.2.1:9880", epoch=1, character="voice_a", language="zh")  # TEST-NET-1
        seen = SpeechRelayTest.failures(self, relay)
        with mock.patch("voice.speech.CONNECT_S", 0.2):
            started = time.monotonic()
            speech_id = relay.speak("line-1", "你好")
            self.assertTrue(wait_until(lambda: seen))
        self.assertEqual(seen, [("speech.failed", speech_id, {"reason": "unreachable"})])
        self.assertLess(time.monotonic() - started, 5)


class FakeRun:
    """subprocess.run for the ensurer: answer() gives (stdout, returncode)."""
    def __init__(self, answer):
        self.answer, self.calls = answer, []

    def __call__(self, command, **_kwargs):
        self.calls.append(command)
        stdout, code = self.answer()
        return subprocess.CompletedProcess(command, code, stdout, "")


class StuckEnsurer:
    """An ensure that never ends: wait_ready holds for its whole timeout and answers not ready."""
    def __init__(self):
        self.waiting = threading.Event()  # a worker called wait_ready
        self.gate = threading.Event()  # set: wait_ready returns at once

    def request(self):
        pass

    def wait_ready(self, timeout):
        self.waiting.set()
        self.gate.wait(timeout)
        return False


if __name__ == "__main__":
    unittest.main()
