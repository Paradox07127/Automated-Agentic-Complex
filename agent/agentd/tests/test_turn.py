"""One turn_generation runs through the line, the look and the speech; a newer turn drops older results."""
import base64
import http.client
import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation.blacklist import Blacklist  # noqa: E402
from support import deny_blacklist  # noqa: E402
from observation.capture import CaptureManager  # noqa: E402
import daemon.speech_control as agentd  # noqa: E402
from voice.speech import SpeechRelay  # noqa: E402
import test_capture  # noqa: E402
import test_server  # noqa: E402
import test_speech  # noqa: E402
from support import serve_in_thread  # noqa: E402


class GatedTTS(test_speech.FakeTTS):
    """FakeTTS that sends nothing until the test sets its gate."""

    def __init__(self, **fake):
        super().__init__(**fake)
        self.gate = threading.Event()
        self.RequestHandlerClass = _GatedHandler


class _GatedHandler(test_speech._TTSHandler):
    def do_POST(self):
        self.server.gate.wait(5)
        super().do_POST()


class TimedTTS(test_speech.FakeTTS):
    """FakeTTS that notes when each request arrives."""

    def __init__(self, **fake):
        super().__init__(**fake)
        self.times = []
        self.RequestHandlerClass = _TimedHandler


class _TimedHandler(test_speech._TTSHandler):
    def do_POST(self):
        self.server.times.append(time.monotonic())
        super().do_POST()


class TimedMouth(test_server.FakeMouth):
    """FakeMouth that notes when each delta goes out."""

    def stream(self, text, context):
        self.times = []
        for chunk in super().stream(text, context):
            self.times.append(time.monotonic())
            yield chunk


class FlipMouth(test_server.FakeMouth):
    """FakeMouth that calls after_first once its first delta has gone out."""

    def __init__(self, chunks, after_first):
        super().__init__(chunks)
        self.after_first = after_first

    def stream(self, text, context):
        for i, chunk in enumerate(super().stream(text, context)):
            yield chunk
            if i == 0:
                self.after_first()


class BlockedMouth(test_server.FakeMouth):
    """FakeMouth whose stream sends nothing until cancel_active aborts it, as a provider stream waits for its
    next delta."""

    def __init__(self):
        super().__init__(["这句不会说完。"])
        self.started, self.release, self.aborts, self.open = threading.Event(), threading.Event(), 0, False

    def stream(self, text, context):
        self.calls.append((text, context))
        self.open = True
        self.started.set()
        self.release.wait(5)
        self.open = False
        yield from self.chunks

    def cancel_active(self):
        """As Mouth.cancel_active: aborts the stream open now; with none open it does nothing."""
        if self.open:
            self.aborts += 1
            self.release.set()


class FakeEnsurer:
    def __init__(self):
        self.requests = 0

    def request(self):
        self.requests += 1


def relay_for(case,tts_class=test_speech.FakeTTS, clock=time.monotonic, **fake):
    tts = tts_class(**fake)
    serve_in_thread(tts)
    case.addCleanup(tts.server_close)
    case.addCleanup(tts.shutdown)
    return tts, SpeechRelay(f"http://127.0.0.1:{tts.server_port}", epoch=1, character="voice_a", language="zh",
                            clock=clock)


def wait_for(predicate, seconds=5.0):
    deadline = time.monotonic() + seconds
    while not predicate() and time.monotonic() < deadline:
        time.sleep(0.01)
    return predicate()


class TurnTest(test_server.FeedServerCase):
    request = test_server.SayTest.request
    say = test_server.SayTest.say
    lines_until_final = test_server.SayTest.lines_until_final
    collect = test_speech.SpeechRelayTest.collect

    def setUp(self):
        super().setUp()
        self.server.mouth = test_server.FakeMouth(["[intent:greet]好。"])
        self.server.character_agent = test_server.KernelLines(self.server)

    def cancel(self, **body):
        return self.request("POST", "/turn/cancel", {"reason": "barge_in", **body})

    def relay_events(self, relay):
        return [item["data"]["event"] for item in relay.since(0)]

    def test_cancel_while_generating_ends_the_line_and_sends_no_speech(self):
        self.server.mouth = test_server.FakeMouth(["[intent:explain]一"] + ["二"] * 50, delay=0.05)
        self.server.speech = test_server.FakeRelay()
        conn, response = self.open_feed()
        status, said = self.say("说个长的")
        self.next_event(response)
        status, cut = self.cancel()
        self.assertEqual(status, 202)
        self.assertEqual(cut["generation"], said["generation"] + 1)
        self.assertTrue(cut["cancelled"]["line"])
        events = self.lines_until_final(response)
        conn.close()
        self.assertTrue(events[-1]["cancelled"])
        self.assertLess(len(events), 10)
        time.sleep(0.3)
        later = [i for i in self.server.feed.since(events[-1]["seq"]) if i["event"] == "line"]
        self.assertEqual(later, [])
        self.assertNotIn("speak", [c[0] for c in self.server.speech.calls])

    def test_cancel_before_first_audio_ends_the_stream_with_cancelled(self):
        tts, relay = relay_for(self, delay=0.3)
        self.server.speech = relay
        self.say("你好")
        self.assertTrue(wait_for(lambda: "speech.begin" in self.relay_events(relay)))
        status, cut = self.cancel()
        self.assertEqual((status, cut["cancelled"]["speech"]), (202, True))
        lines = self.collect(relay, 1)
        self.assertEqual(lines[-1]["event"], "cancelled")
        self.assertNotIn("audio", [l["event"] for l in lines])
        time.sleep(0.8)  # FakeTTS would have sent its audio by now
        self.assertEqual(len(relay.since(0)), len(lines))

    def test_cancel_while_playing_cuts_the_speech(self):
        tts, relay = relay_for(self, segments=4)
        self.server.speech = relay
        self.say("你好")
        self.assertTrue(wait_for(lambda: "complete" in self.relay_events(relay)))
        self.assertTrue(relay.busy())
        status, cut = self.cancel()
        self.assertEqual((status, cut["cancelled"]["speech"]), (202, True))
        self.assertFalse(relay.busy())

    def test_cancel_after_playback_cuts_nothing_but_bumps_the_generation(self):
        now = [0.0]
        tts, relay = relay_for(self, clock=lambda: now[0])
        self.server.speech = relay
        status, said = self.say("你好")
        self.assertTrue(wait_for(lambda: "complete" in self.relay_events(relay)))
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        now[0] = 100.0  # past the playback estimate
        self.assertEqual(self.cancel(), (202, {"generation": said["generation"] + 1,
                                              "cancelled": {"line": False, "speech": False, "observation": False}}))
        self.assertEqual(self.server.turn_generation, said["generation"] + 1)

    def test_a_character_line_stays_live_until_its_turn_settles(self):
        settled, live = self.server._turn_settled, []
        self.server._turn_settled = lambda *args, **kwargs: (live.append(bool(self.server._live_lines)),
                                                             settled(*args, **kwargs))
        self.say("你好")
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.assertEqual(live, [True])

    def test_late_observation_is_refused_and_the_line_calls_no_model(self):
        self.server.capture = CaptureManager(self.server.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")),
                                             lambda: test_capture.CODE, None, vision=test_capture.FakeVision())
        conn, response = self.open_feed()
        status, said = self.say("看一下")
        self.assertEqual((status, said["command"]), (202, "look"))
        [request] = [i["data"] for i in self.server.feed.since(0) if i["event"] == "request"]
        status, cut = self.cancel()
        self.assertEqual((status, cut["cancelled"]["observation"], cut["cancelled"]["line"]), (202, True, True))
        image = base64.b64encode(test_capture.png()).decode()
        self.assertEqual(self.request("POST", "/context/image", {"request_id": request["request_id"],
                                                                 "window_id": 2, "png_base64": image})[0], 404)
        events = self.lines_until_final(response)
        conn.close()
        self.assertTrue(events[-1]["cancelled"])
        self.assertEqual(self.server.mouth.calls, [])
        record = self.server.capture.observation(request["request_id"])
        self.assertEqual((record["status"], record["reason"]), ("cancelled", "turn_cancelled"))

    def test_shutdown_settles_pending_look_without_starting_model(self):
        capture = self.server.capture = CaptureManager(
            self.server.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")), lambda: test_capture.CODE, None,
            vision=test_capture.FakeVision())
        status, said = self.say("看一下")
        self.assertEqual((status, said["command"]), (202, "look"))
        [request] = [item["data"] for item in self.server.feed.since(0) if item["event"] == "request"]
        request_id = request["request_id"]
        self.assertEqual(capture.result(request_id), "pending")

        self.server.shutdown_cleanly(timeout=1)

        self.assertEqual(capture.result(request_id), "cancelled")
        self.assertEqual(capture.image(request_id, 2, test_capture.png())[0], 404)
        self.assertFalse(self.server._live_lines)
        [line] = [item["data"] for item in self.server.feed.since(0) if item["event"] == "line"]
        self.assertEqual((line["line_id"], line["final"], line["cancelled"]), (said["line_id"], True, True))
        self.assertEqual(self.server.say("你好"), (503, {"error": "shutting_down"}))
        self.assertFalse(self.server.start_line("late-proactive", "你好"))
        self.assertEqual(self.server.mouth.calls, [])

    def test_stale_cancel_leaves_the_new_turn_alone(self):
        self.server.mouth = test_server.FakeMouth(["一", "二。"], delay=0.05)
        self.server.speech = test_server.FakeRelay()
        conn, response = self.open_feed()
        first = self.say("一")[1]
        self.lines_until_final(response)
        second = self.say("二")[1]
        self.assertEqual(second["generation"], first["generation"] + 1)
        self.assertEqual(self.cancel(generation=first["generation"]),
                         (409, {"error": "stale_generation", "generation": second["generation"]}))
        events = self.lines_until_final(response)
        conn.close()
        self.assertEqual((events[-1]["line_id"], events[-1]["cancelled"]), (second["line_id"], False))
        self.assertTrue(wait_for(lambda: ("speak", second["line_id"], "一二。") in self.server.speech.calls))

    def test_no_asr_result_keeps_the_old_speech_cancelled(self):
        tts, relay = relay_for(self, delay=0.3)
        self.server.speech = relay
        line_id = self.say("你好")[1]["line_id"]
        self.assertTrue(wait_for(lambda: "speech.begin" in self.relay_events(relay)))
        self.assertEqual(self.cancel()[0], 202)
        self.collect(relay, 1)
        time.sleep(0.8)  # no /say follows: the user said nothing
        self.assertEqual(len(tts.bodies), 1)
        self.assertEqual(self.relay_events(relay)[-1], "cancelled")
        self.assertFalse(relay.busy())
        self.assertEqual(relay.interrupted(), line_id)

    def test_say_line_and_state_carry_the_generation(self):
        conn, response = self.open_feed()
        status, said = self.say("你好")
        self.assertEqual(status, 202)
        events = self.lines_until_final(response)
        conn.close()
        self.assertEqual({e["generation"] for e in events}, {said["generation"]})
        status, state = self.request("GET", "/state")
        self.assertEqual(state["turn_generation"], said["generation"])
        self.assertEqual(self.say("停下")[0], 200)
        self.assertEqual(self.request("GET", "/state")[1]["turn_generation"], said["generation"] + 1)

    def test_turn_cancel_payload_and_auth(self):
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "boom"}),
                         (400, {"error": "invalid_payload"}))
        self.assertEqual(self.cancel(generation="1")[0], 400)
        self.assertEqual(self.cancel(generation=True)[0], 400)
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "client_cancel"}, token="events")[0], 401)
        # No mouth and no TTS: only the generation moves.
        self.server.mouth = None
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "client_cancel", "generation": 0}),
                         (202, {"generation": 1, "cancelled": {"line": False, "speech": False,
                                                               "observation": False}}))

    def test_a_cancel_naming_a_line_cuts_only_while_that_line_streams_or_speaks(self):
        self.assertEqual(self.cancel(line_id="")[0], 400)
        self.assertEqual(self.cancel(line_id=7)[0], 400)
        self.assertEqual(self.cancel(line_id="x" * 65)[0], 400)
        self.server.mouth = test_server.FakeMouth(["一"] + ["二"] * 50, delay=0.05)
        conn, response = self.open_feed()
        said = self.say("说个长的")[1]
        self.next_event(response)
        self.assertEqual(self.cancel(line_id="earlier"), (409, {"error": "stale_line"}))
        self.assertEqual(self.server.turn_generation, said["generation"])
        status, cut = self.cancel(line_id=said["line_id"])
        self.assertEqual((status, cut["cancelled"]["line"]), (202, True))
        self.assertTrue(self.lines_until_final(response)[-1]["cancelled"])
        conn.close()

        self.server.mouth = test_server.FakeMouth(["好。"])
        tts, relay = relay_for(self, segments=4)
        self.server.speech = relay
        said = self.say("你好")[1]
        self.assertTrue(wait_for(lambda: "complete" in self.relay_events(relay) and not self.server._live_lines))
        self.assertEqual(self.cancel(line_id="earlier"), (409, {"error": "stale_line"}))
        self.assertTrue(relay.busy())
        status, cut = self.cancel(line_id=said["line_id"])
        self.assertEqual((status, cut["cancelled"]["speech"]), (202, True))
        self.assertEqual(self.cancel(line_id=said["line_id"]), (409, {"error": "stale_line"}))

    def test_first_clause_goes_to_tts_while_the_model_still_streams(self):
        tts, relay = relay_for(self, tts_class=TimedTTS)
        self.server.speech = relay
        self.server.mouth = TimedMouth(["[intent:greet]你来了，管理员。", "今天的测试", "都过了。"], delay=0.4)
        self.say("你好")
        self.assertTrue(wait_for(lambda: len(tts.bodies) == 2 and not self.server._live_lines))
        self.assertLess(tts.times[0], self.server.mouth.times[-1])
        self.assertEqual([b["text"] for _, b in tts.bodies], ["你来了，管理员。", "今天的测试都过了。"])
        self.assertEqual({b["turn_id"] for _, b in tts.bodies}, {self.server._turn_trace["turn_id"]})
        # Control: a muted line sends nothing.
        self.assertEqual(self.say("静音")[0], 200)
        self.server.mouth = TimedMouth(["[intent:greet]你来了，管理员。", "今天的测试", "都过了。"], delay=0.1)
        self.say("你好")
        self.assertTrue(wait_for(lambda: self.server.mouth.calls and not self.server._live_lines))
        self.assertEqual(len(tts.bodies), 2)

    def test_interrupt_policy_follows_the_source(self):
        tts, relay = relay_for(self)
        self.server.speech = relay
        self.say("你好")
        self.assertTrue(wait_for(lambda: len(tts.bodies) == 1 and not self.server._live_lines))
        self.server.start_line("p1", "（主动搭话）")
        self.assertTrue(wait_for(lambda: len(tts.bodies) == 2 and not self.server._live_lines))
        self.server.gate.enabled, self.server.gate.quiet = True, (0, 0)
        self.server.announce({"ts": 1.0, "level": "P0", "kind": "dispatch_done", "headline": "codex 的任务完成了",
                              "project": "/repo", "session_id": None, "detail": None})
        self.assertTrue(wait_for(lambda: len(tts.bodies) == 3))
        self.assertEqual([(b["text"], b["interrupt_policy"]) for _, b in tts.bodies],
                         [("好。", "immediate"), ("好。", "clause_end"), ("codex 的任务完成了", "clause_end")])
        self.assertEqual(tts.bodies[2][1]["turn_generation"], self.server.turn_generation)
        self.assertGreater(self.server.turn_generation, 0)

    def speech_cancelled(self):
        return [i for i in self.server.registry.intents_since(0) if i.get("event") == "speech_cancelled"]

    def test_turn_cancel_tells_events_speech_cancelled_with_the_new_generation(self):
        tts, relay = relay_for(self, segments=20, delay=0.05)
        self.server.speech = relay
        status, cut = self.cancel()  # nothing speaks
        self.assertEqual(status, 202)
        [event] = self.speech_cancelled()
        self.assertEqual({k: event[k] for k in ("session_epoch", "turn_generation", "speech_id", "reason")},
                         {"session_epoch": "1", "turn_generation": cut["generation"], "speech_id": None,
                          "reason": "client_cancel"})
        self.say("你好")
        self.assertTrue(wait_for(lambda: "speech.begin" in self.relay_events(relay)))
        speech_id = tts.bodies[0][1]["speech_id"]
        status, cut = self.cancel()
        self.assertEqual((status, cut["cancelled"]["speech"]), (202, True))
        self.assertEqual([(e["turn_generation"], e["speech_id"]) for e in self.speech_cancelled()],
                         [(cut["generation"] - 2, None), (cut["generation"], speech_id)])
        # On the wire: `event: speech_cancelled`, the fields at the top level of data.
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("GET", "/events?after=0", headers={"Authorization": f"Bearer {test_server.UI}"})
        response = conn.getresponse()
        events = []
        while len(events) < 2:
            event = self.next_event(response)
            if event["event"] not in ("intent", "clause_intent"):
                events.append(event)
        conn.close()
        self.assertEqual([e["event"] for e in events], ["speech_cancelled"] * 2)
        self.assertEqual(json.loads(events[1]["data"]),
                         {"seq": int(events[1]["id"]), "session_epoch": "1", "turn_generation": cut["generation"],
                          "speech_id": speech_id, "utterance_id": relay.utterance_of(speech_id),
                          "reason": "client_cancel"})

    def test_a_new_line_superseding_an_immediate_line_tells_events_speech_cancelled(self):
        tts, relay = relay_for(self, segments=20, delay=0.05)
        self.server.speech = relay
        self.say("你好")
        self.assertTrue(wait_for(lambda: "speech.begin" in self.relay_events(relay)))
        old = self.server._voiced[1]
        status, said = self.say("再说一句")
        self.assertEqual(status, 202)
        [event] = self.speech_cancelled()
        self.assertEqual((event["reason"], event["turn_generation"], event["utterance_id"], event["speech_id"]),
                         ("superseded", said["generation"], old, tts.bodies[0][1]["speech_id"]))

    def test_a_new_line_superseding_a_proactive_line_tells_events_nothing(self):
        tts, relay = relay_for(self, segments=20, delay=0.05)
        self.server.speech = relay
        self.server.start_line("p1", "（主动搭话）")
        self.assertTrue(wait_for(lambda: "speech.begin" in self.relay_events(relay)))
        self.assertEqual(self.server._voiced[2], "clause_end")
        self.say("再说一句")
        self.assertTrue(wait_for(lambda: len(tts.bodies) == 2))
        self.assertEqual(self.speech_cancelled(), [])

    def test_mute_and_hiding_tell_events_the_utterance_they_cut(self):
        tts, relay = relay_for(self, segments=20, delay=0.05)
        self.server.speech = relay
        self.say("你好")
        self.assertTrue(wait_for(lambda: "speech.begin" in self.relay_events(relay)))
        muted = self.server._voiced[1]
        self.assertEqual(self.say("静音")[0], 200)
        self.assertEqual(self.say("取消静音")[0], 200)
        self.server.start_line("p1", "（主动搭话）")
        self.assertTrue(wait_for(lambda: self.relay_events(relay).count("speech.begin") == 2))
        hidden = self.server._voiced[1]
        self.server.set_avatar(False, "user")
        self.assertEqual([(e["reason"], e["utterance_id"]) for e in self.speech_cancelled()],
                         [("client_cancel", muted), ("client_cancel", hidden)])
        self.assertNotIn(None, (muted, hidden))

    def blocked_line(self):
        """A line said whose model stream waits for its next delta; its BlockedMouth."""
        mouth = self.server.mouth = BlockedMouth()
        self.addCleanup(mouth.release.set)
        self.assertEqual(self.say("说个长的")[0], 202)
        self.assertTrue(mouth.started.wait(2))
        return mouth

    def test_stop_command_aborts_the_model_stream(self):
        mouth = self.blocked_line()
        self.assertEqual(self.say("停下")[0], 200)
        self.assertEqual(mouth.aborts, 1)
        self.assertTrue(wait_for(lambda: not self.server._mouth_lock.locked(), 1))

    def test_typed_input_aborts_the_old_model_stream(self):
        mouth = self.blocked_line()
        self.assertEqual(self.say("再说一句")[0], 202)
        self.assertEqual(mouth.aborts, 1)
        self.assertTrue(wait_for(lambda: not self.server._live_lines and not self.server._mouth_lock.locked(), 1))

    def test_character_switch_aborts_the_model_stream(self):
        mouth = self.blocked_line()
        self.assertEqual(self.server.prepare_switch("birch")[0], 200)
        self.assertEqual(mouth.aborts, 1)
        self.assertTrue(wait_for(lambda: not self.server._mouth_lock.locked(), 1))

    def test_barge_in_warms_the_tts_unless_muted(self):
        ensurer = self.server.tts_ensurer = FakeEnsurer()
        self.assertEqual(self.cancel()[0], 202)
        self.assertEqual(ensurer.requests, 1)
        muted = self.server.tts_ensurer = FakeEnsurer()
        self.assertEqual(self.say("静音")[0], 200)
        self.assertEqual(self.cancel()[0], 202)
        self.assertEqual(muted.requests, 0)

    def test_barge_in_cuts_a_proactive_line_at_once(self):
        tts, relay = relay_for(self, segments=20, delay=0.05)
        self.server.speech = relay
        self.server.start_line("p1", "（主动搭话）")
        self.assertTrue(wait_for(lambda: "audio" in self.relay_events(relay)))
        self.assertEqual(tts.bodies[0][1]["interrupt_policy"], "clause_end")
        self.assertEqual(self.cancel()[0], 202)
        lines = self.collect(relay, 1)
        self.assertEqual((lines[-1]["event"], lines[-1]["reason"]), ("cancelled", "client_cancel"))
        self.assertLess(len(lines), 30)

    def test_a_proactive_line_that_fails_its_delivery_check_is_never_voiced(self):
        tts, relay = relay_for(self)
        self.server.speech = relay
        rows = []
        self.server.history = SimpleNamespace(record=lambda **row: rows.append(row), conversations=SimpleNamespace(active=None))
        for holds in (False, True):
            with self.subTest(holds=holds):
                still, checked, sent = [True], [], len(tts.bodies)
                self.server.mouth = FlipMouth(["好久", "没动了。"], lambda: still.__setitem__(0, holds))
                recheck = lambda: checked.append(still[0]) or still[0]
                line_id = f"p-{holds}"
                self.assertTrue(self.server.claim_line(line_id, "（主动搭话）", recheck))
                self.assertTrue(wait_for(lambda: not self.server._live_lines))
                time.sleep(0.2)  # a clause sent to TTS would have arrived by now
                self.assertEqual(checked, [True, holds])  # before the kernel runs, then before the first clause
                [final] = [i["data"] for i in self.server.feed.since(0)
                           if i["event"] == "line" and i["data"]["line_id"] == line_id and i["data"]["final"]]
                self.assertEqual((final["cancelled"], rows[-1]["turn_id"], rows[-1]["state"]),
                                 (not holds, line_id, "completed" if holds else "cancelled"))
                self.assertEqual([b["text"] for _, b in tts.bodies[sent:]], ["好久没动了。"] if holds else [])

    def test_a_line_cancelled_by_its_delivery_check_leaves_the_mouth_window(self):
        _, relay = relay_for(self)
        self.server.speech = relay

        class WindowMouth(test_server.FakeMouth):
            """Appends the turn once its stream finishes, as the real mouth does."""
            history = []

            def stream(self, text, context):
                yield from super().stream(text, context)
                self.history.append([{"role": "user", "content": text}, {"role": "assistant", "content": "好久没动了。"}])

        self.server.mouth = WindowMouth(["好久没动了。"])
        self.assertTrue(self.server.claim_line("p-window", "（主动搭话）", lambda: False))
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.assertEqual(self.server.mouth.history, [])

    def test_a_line_cancelled_for_a_changed_fact_takes_only_itself_out_of_the_mouth_window(self):
        self.server.speech = test_server.FakeRelay()
        reads = []
        # The first read is the text the second line used; every later one sees the correction.
        self.server.memory = SimpleNamespace(
            text=lambda fact_id: reads.append(fact_id) or ("我养了一只狗" if len(reads) > 1 else "我养了一只猫"),
            touch=lambda fact_ids: None, record_uses=lambda used, line_id, mode: None)

        class FactMouth(test_server.FakeMouth):
            """Appends the turn once its stream finishes; injects the fact for 猫."""

            def __init__(self, chunks):
                super().__init__(chunks)
                self.history = []

            def pick_facts(self, query, derived=False):
                facts = [{"fact_id": "f1", "version": 1}] if "猫" in query else []
                return {"trusted": facts, "low_trust": []}

            def stream(self, text, context):
                yield from super().stream(text, context)
                self.history.append([{"role": "user", "content": text}, {"role": "assistant", "content": "好。"}])

        mouth = self.server.mouth = FactMouth(["[intent:greet]好。"])
        for text in ("你好", "我的猫"):
            self.assertEqual(self.say(text)[0], 202)
            self.assertTrue(wait_for(lambda: not self.server._live_lines))
        finals = [i["data"] for i in self.server.feed.since(0) if i["event"] == "line" and i["data"]["final"]]
        self.assertEqual([final["error"] for final in finals], [None, "memory_changed"])
        self.assertEqual([user["content"] for user, _ in mouth.history], ["你好"])

    def test_every_cut_is_one_full_row_of_the_table(self):
        self.assertEqual(set(agentd.CUTS), {"barge_in", "client_cancel", "stop", "supersede", "switch",
                                            "memory_changed", "context_cleared", "mute", "hide", "tap",
                                            "barge_in_keep", "stop_keep"})
        for kind, row in agentd.CUTS.items():
            with self.subTest(kind=kind):
                self.assertEqual(set(row), {"by", "line", "look", "new_turn", "speech", "relay_reason", "notify",
                                            "slots", "warm"})

    def test_client_cancel_drops_the_slotted_announcements(self):
        self.server.gate.enabled, self.server.gate.quiet = True, (0, 0)
        relay = self.server.speech = test_server.FakeRelay()
        relay.playing = True
        self.server.announce({"ts": 1.0, "level": "P1", "kind": "gate_fail", "headline": "A 门禁失败",
                              "project": "/repo", "session_id": "A", "detail": None})
        self.assertTrue(self.server._announce_slots)
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "client_cancel"})[0], 202)
        relay.playing = False
        self.server._announce_due()
        self.assertEqual([call for call in relay.calls if call[0] == "speak"], [])

    def test_a_stop_or_a_switch_cancels_the_pending_look_and_new_input_keeps_it(self):
        capture = self.server.capture = CaptureManager(
            self.server.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")), lambda: test_capture.CODE, None,
            vision=test_capture.FakeVision())
        cancelled, real = [], capture.cancel
        capture.cancel = lambda request_id, reason: cancelled.append(request_id) or real(request_id, reason)

        def drain_lines():
            self.server.cancel_turn("client_cancel")
            self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.addCleanup(drain_lines)

        def requests():
            return [i["data"]["request_id"] for i in self.server.feed.since(0) if i["event"] == "request"]
        # The switch goes last: an open switch refuses every /say after it.
        cuts = (("new_input", lambda: self.say("看一下")), ("stop", lambda: self.say("停下")),
                ("switch", lambda: self.server.prepare_switch("birch")))
        for name, cut in cuts:
            with self.subTest(cut=name):
                self.assertEqual(self.say("看一下")[1].get("command"), "look")
                pending = requests()[-1]
                cut()
                if name == "new_input":  # its image still comes in (test_capture: each look waits for its own)
                    self.assertNotIn(pending, cancelled)
                    self.assertEqual(capture.result(pending), "pending")
                else:
                    self.assertEqual(cancelled[-1:], [pending])

    def test_stale_look_does_not_read_capture(self):
        for initially_stale in (True, False):
            with self.subTest(initially_stale=initially_stale):
                cancel = threading.Event()
                reads = []
                if initially_stale:
                    cancel.set()

                def result(request_id):
                    reads.append(request_id)
                    return "pending"

                self.server.capture = SimpleNamespace(
                    share_text=False, vision=None, result=result,
                    observation=lambda _: self.fail("a stale look accessed observation data"))
                waited = self.server._await_look("view-1", cancel, self.server.turn_generation, lambda _: cancel.set())
                self.assertEqual(waited, "view-1")
                self.assertEqual(reads, [] if initially_stale else ["view-1"])

    def test_a_cancel_of_the_old_generation_leaves_a_line_said_meanwhile_alone(self):
        server, main = self.server, threading.current_thread()
        rows = []
        server.history = SimpleNamespace(record=lambda **row: rows.append(row), conversations=SimpleNamespace(active=None))
        turn_lock, announce_lock = server._turn_lock, server._announce_lock
        settled, said = threading.Event(), []  # settled: the /say returned, or waits for the turn lock

        def say():
            said.append(server.say("你好"))
            settled.set()
        sayer = threading.Thread(target=say, daemon=True)

        class TurnLock:
            def __enter__(lock):
                if not turn_lock.acquire(blocking=False):
                    if threading.current_thread() is sayer:
                        settled.set()
                    turn_lock.acquire()

            def __exit__(lock, *exc):
                turn_lock.release()

        class AnnounceLock:
            """The barge-in's slot clearing runs the /say first, from a thread of its own."""
            armed = True

            def __enter__(lock):
                if lock.armed and threading.current_thread() is main:
                    lock.armed = False
                    sayer.start()
                    settled.wait(5)
                announce_lock.acquire()

            def __exit__(lock, *exc):
                announce_lock.release()
        server._turn_lock, server._announce_lock = TurnLock(), AnnounceLock()
        generation = server.turn_generation
        self.assertEqual(server.cancel_turn("barge_in", generation)[:2], ("cancelled", generation + 1))
        sayer.join(5)
        [(status, body)] = said
        self.assertEqual(status, 202)
        self.assertTrue(wait_for(lambda: not server._live_lines))
        [final] = [i["data"] for i in server.feed.since(0)
                   if i["event"] == "line" and i["data"]["line_id"] == body["line_id"] and i["data"]["final"]]
        self.assertFalse(final["cancelled"])
        self.assertEqual(rows[-1]["state"], "completed")


class LateSpeechTest(unittest.TestCase):
    collect = test_speech.SpeechRelayTest.collect

    def test_lines_arriving_after_the_generation_moved_are_dropped(self):
        tts, relay = relay_for(self, tts_class=GatedTTS)
        relay.generation = 1
        relay.speak("t1", "你好", generation=1)
        relay.generation = 2
        tts.gate.set()
        self.assertTrue(relay._current.done.wait(5))
        self.assertEqual(relay.since(0), [])
        self.assertFalse(relay.busy())
        # Control: an announcement has no generation and is never compared.
        relay.speak("announce-1", "你好")
        self.assertEqual(self.collect(relay, 1)[-1]["event"], "complete")

    def test_stream_cut_mid_way_ends_as_superseded(self):
        tts, relay = relay_for(self, delay=0.2)
        relay.generation = 1
        relay.speak("t1", "你好", generation=1)
        self.assertTrue(wait_for(lambda: relay.since(0)))
        relay.generation = 2
        lines = self.collect(relay, 1)
        self.assertEqual([l["event"] for l in lines], ["speech.begin", "cancelled"])
        self.assertEqual(lines[-1]["reason"], "superseded")


if __name__ == "__main__":
    unittest.main()
