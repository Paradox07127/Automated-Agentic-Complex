"""T1 in the server: one typed turn can be followed from its input to the TTS; a cut turn shows its cancel."""
import base64
import datetime
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from urllib.parse import quote
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation.attention import AttentionStore  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from support import deny_blacklist  # noqa: E402
from observation.capture import CaptureManager  # noqa: E402
from infra.store import open_store  # noqa: E402
from personal.history import History  # noqa: E402
import test_capture  # noqa: E402
import test_character_agent_integration  # noqa: E402
import test_server  # noqa: E402
from test_server import EVENTS, UI, Script, ScriptedMouth  # noqa: E402
from test_turn import relay_for, wait_for  # noqa: E402
from traces.trace_format import validate_stream  # noqa: E402
from traces.trace_store import TraceStore, new_span_id  # noqa: E402

REPLY = ["[intent:greet]你来了", "，管理员。"]
# A turn of the mouth double; the character agent's context and model span are HarnessTurnTest's.
CHAIN = ["input.received", "line.parsed", "turn.settled"]


def avatar_event(producer="avatar", seq=1):
    return {"v": 1, "event_id": str(uuid.uuid4()), "trace_id": str(uuid.uuid4()), "turn_id": None,
            "turn_generation": None, "span_id": new_span_id(), "parent_span_id": None, "causation_id": None,
            "producer": producer, "producer_epoch": 2, "seq": seq, "kind": "playback.started",
            "t_wall": datetime.datetime.now().astimezone().isoformat(timespec="milliseconds"), "t_mono_ms": 5,
            "status": "ok", "attrs": {"speech_id": "s1", "clause_id": None}}


class TraceServerCase(test_server.FeedServerCase):
    request, lines_until_final = test_server.SayTest.request, test_server.SayTest.lines_until_final

    def setUp(self):
        super().setUp()
        self.data = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.data.cleanup)
        self.db = Path(self.data.name) / "agentd.sqlite"
        self.server.trace = TraceStore(open_store(self.db), producer_epoch=self.server.registry.epoch)
        self.server.events_token = EVENTS
        self.use_mouth(REPLY)

    def use_mouth(self, chunks, delay=0.0):
        self.server.mouth = ScriptedMouth(Script(chunks, delay), character="aster")

    def use_attention(self):
        self.server.attention = AttentionStore(Path(self.data.name) / "attention.sqlite",
                                               Blacklist(deny_blacklist(Path(self.data.name) / "blacklist.json")))

    def line(self, text, **extra):
        conn, response = self.open_feed()
        status, body = self.request("POST", "/say", {"text": text, "source": "text", **extra})
        self.assertEqual(status, 202)
        self.lines_until_final(response)
        conn.close()
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        return body

    def only_turn(self):
        status, body = self.request("GET", "/trace/turns")
        self.assertEqual(status, 200)
        [turn] = body["turns"]
        return turn

    def events(self, trace_id, with_text=False):
        status, body = self.request("GET", f"/trace/turns/{trace_id}{'?with_text=1' if with_text else ''}")
        self.assertEqual(status, 200)
        self.assertEqual(validate_stream(body["events"]), [])
        return body["events"]

    def of(self, events, kind):
        return [e for e in events if e["kind"] == kind]


class TypedTurnTest(TraceServerCase):
    def test_trace_cap_keeps_the_root_and_terminal_without_dangling_cause(self):
        self.server.trace.daily_cap = 1
        said = self.line("到达 trace 容量上限")
        events = self.events(said["trace_id"])
        self.assertEqual([e["kind"] for e in events], ["input.received", "turn.settled"])
        self.assertEqual(events[1]["causation_id"], events[0]["event_id"])

    def test_exact_turn_lookup_can_find_older_turn_and_rejects_blank_id(self):
        self.server.history = History(self.server.trace.db, lock=self.server.trace.lock, character_id=self.server.character)
        old = self.line("找回旧 trace")
        newer = self.line("较新的 trace")
        self.assertNotEqual(old["line_id"], newer["line_id"])
        status, body = self.request("GET", f"/trace/turns?limit=1&turn_id={old['line_id']}")
        self.assertEqual(status, 200)
        [row] = body["turns"]
        self.assertEqual(row["turn_id"], old["line_id"])
        self.assertEqual(row["turn_state"], "completed")
        self.assertEqual(row["conversation_id"], self.server.history.conversations.active)
        self.assertEqual(self.request("GET", f"/trace/turns?trace_id={row['trace_id']}"), (200, body))
        self.assertEqual(self.request("GET", "/trace/turns?turn_id="), (400, {"error": "invalid_query"}))

    def test_turn_list_rows_carry_their_owning_conversation(self):
        unowned = self.line("历史之外的一轮")
        self.server.history = History(self.server.trace.db, lock=self.server.trace.lock, character_id=self.server.character)
        owned = self.line("存进对话的一轮")
        status, body = self.request("GET", "/trace/turns")
        self.assertEqual(status, 200)
        owners = {row["turn_id"]: row["conversation_id"] for row in body["turns"]}
        self.assertEqual(owners, {owned["line_id"]: self.server.history.conversations.active,
                                  unowned["line_id"]: None})

    def test_typed_turn_runs_from_input_to_the_parsed_line(self):
        said = self.line("你好")
        turn = self.only_turn()
        self.assertEqual((turn["turn_id"], turn["source"]), (said["line_id"], "text"))
        events = self.events(turn["trace_id"])
        self.assertEqual([e["kind"] for e in events if e["kind"] in CHAIN], CHAIN)
        self.assertTrue(all(e["turn_id"] == said["line_id"] and e["turn_generation"] == said["generation"]
                            for e in events))
        self.assertTrue(all(e["causation_id"] == prev["event_id"] for prev, e in zip(events, events[1:])))
        self.assertNotIn("text", [k for e in events for k in e])
        [parsed] = self.of(events, "line.parsed")
        self.assertEqual((parsed["attrs"]["line_id"], parsed["attrs"]["intents"], parsed["attrs"]["target"],
                          parsed["attrs"]["first_sentence_only"], parsed["attrs"]["text"]["len"]),
                         (said["line_id"], ["greet"], None, False, len("你来了，管理员。")))
        full = self.events(turn["trace_id"], with_text=True)
        self.assertEqual(self.of(full, "input.received")[0]["text"], {"text": "你好"})
        self.assertEqual(self.of(full, "line.parsed")[0]["text"], {"text": "你来了，管理员。"})
        self.assertEqual(self.server.trace_errors, 0)

    def test_voice_timing_lands_on_the_turns_input_received(self):
        timing = {"pressed_ms": 1760000000000, "released_ms": 1760000001200, "final_ms": 1760000001500}
        conn, response = self.open_feed()
        status, _ = self.request("POST", "/say", {"text": "你好", "source": "voice", "voice_timing": timing})
        self.assertEqual(status, 202)
        self.lines_until_final(response)
        conn.close()
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        [received] = self.of(self.events(self.only_turn()["trace_id"]), "input.received")
        self.assertEqual((received["attrs"]["source"], received["attrs"]["voice_timing"]), ("voice", timing))

    def test_speech_joins_the_trace_as_the_tts_producer(self):
        tts, relay = relay_for(self)
        relay.on_event = self.server.on_speech_event
        self.server.speech = relay
        said = self.line("你好")
        turn = self.only_turn()
        self.assertTrue(wait_for(lambda: self.of(self.events(turn["trace_id"]), "speech.finished")))
        events = self.events(turn["trace_id"])
        [requested] = self.of(events, "speech.requested")
        [first] = self.of(events, "speech.first_audio")
        [finished] = self.of(events, "speech.finished")
        speech_id = requested["attrs"]["speech_id"]
        self.assertEqual((requested["producer"], requested["attrs"]["line_id"], requested["attrs"]["clause_id"]),
                         ("agentd", said["line_id"], tts.bodies[0][1]["clause_id"]))
        self.assertEqual((first["producer"], first["attrs"]["speech_id"]), ("tts", speech_id))
        self.assertEqual((finished["producer"], finished["status"], finished["attrs"]["total_samples"]),
                         ("tts", "ok", 89600))
        self.assertIsInstance(finished["duration_ms"], int)
        self.assertEqual({requested["span_id"], first["span_id"], finished["span_id"]}, {requested["span_id"]})
        self.assertEqual((first["causation_id"], finished["causation_id"]), (requested["event_id"], first["event_id"]))
        self.assertEqual([b["text"] for _, b in tts.bodies], ["你来了，管理员。"])
        self.assertEqual(self.only_turn()["result"], "unknown")
        self.assertEqual(self.server.trace_errors, 0)

    def test_each_clause_of_a_line_is_requested_with_its_clause_id(self):
        tts, relay = relay_for(self)
        relay.on_event = self.server.on_speech_event
        self.server.speech = relay
        self.use_mouth(["[intent:greet]你来了，管理员。", "今天的测试都过了。"])
        self.line("你好")
        turn = self.only_turn()
        self.assertTrue(wait_for(lambda: len(self.of(self.events(turn["trace_id"]), "speech.finished")) == 2))
        events = self.events(turn["trace_id"])
        self.assertEqual(len(tts.bodies), 2)
        utterance_id = tts.bodies[0][1]["utterance_id"]
        clauses = [f"{utterance_id}.c0", f"{utterance_id}.c1"]
        self.assertEqual([(r["attrs"]["speech_id"], r["attrs"]["clause_id"])
                          for r in self.of(events, "speech.requested")],
                         [(b["speech_id"], b["clause_id"]) for _, b in tts.bodies])
        self.assertEqual([b["clause_id"] for _, b in tts.bodies], clauses)
        self.assertEqual([f["attrs"]["clause_id"] for f in self.of(events, "speech.finished")], clauses)

    def test_tts_refusing_before_begin_ends_the_speech_as_failed(self):
        # A 401 or 500 before any line still gives the feed and the trace an end.
        tts, relay = relay_for(self, status=401)
        relay.on_event = self.server.on_speech_event
        self.server.speech = relay
        conn, response = self.open_feed()
        self.addCleanup(conn.close)
        self.request("POST", "/say", {"text": "你好", "source": "text"})
        event = self.next_event(response)
        while event["event"] != "speech_failed":
            event = self.next_event(response)
        data = json.loads(event["data"])
        speech_id = data["speech_id"]
        self.assertEqual({k: data[k] for k in ("speech_id", "reason")}, {"speech_id": speech_id, "reason": "http_401"})
        turn = self.only_turn()
        self.assertTrue(wait_for(lambda: self.of(self.events(turn["trace_id"]), "speech.finished")))
        [finished] = self.of(self.events(turn["trace_id"]), "speech.finished")
        self.assertEqual((finished["producer"], finished["status"], finished["attrs"]["total_samples"],
                          finished["attrs"]["reason"]), ("tts", "failed", 0, "http_401"))
        self.assertFalse(relay.busy())
        self.assertEqual(self.server.trace_errors, 0)

    def test_barge_in_while_generating_shows_the_cancel_and_its_ack(self):
        self.use_mouth(["[intent:explain]一"] + ["二"] * 50, delay=0.05)
        conn, response = self.open_feed()
        status, said = self.request("POST", "/say", {"text": "说个长的", "source": "text"})
        self.next_event(response)
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "barge_in"})[0], 202)
        self.lines_until_final(response)
        conn.close()
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        turn = self.only_turn()
        self.assertEqual(turn["result"], "interrupted")
        events = self.events(turn["trace_id"])
        [requested] = self.of(events, "cancel.requested")
        [acked] = self.of(events, "cancel.acked")
        self.assertEqual(requested["attrs"], {"by": "ptt", "target": "turn"})
        self.assertEqual((acked["attrs"]["target"], acked["span_id"]), ("turn", requested["span_id"]))
        self.assertIsInstance(acked["duration_ms"], int)
        self.assertEqual(requested["turn_generation"], said["generation"])
        self.assertEqual(self.server.trace_errors, 0)

    def test_new_line_supersedes_the_one_still_generating(self):
        self.use_mouth(["[intent:explain]一"] + ["二"] * 50, delay=0.05)
        conn, response = self.open_feed()
        first = self.request("POST", "/say", {"text": "说个长的", "source": "text"})[1]
        self.next_event(response)
        self.use_mouth(REPLY)
        self.request("POST", "/say", {"text": "算了", "source": "text"})
        conn.close()
        self.assertTrue(wait_for(lambda: len(self.request("GET", "/trace/turns")[1]["turns"]) == 2
                                 and not self.server._live_lines))
        turns = {t["turn_id"]: t for t in self.request("GET", "/trace/turns")[1]["turns"]}
        self.assertEqual(turns[first["line_id"]]["result"], "interrupted")
        events = self.events(turns[first["line_id"]]["trace_id"])
        self.assertEqual(self.of(events, "cancel.requested")[0]["attrs"]["by"], "supersede")
        self.assertEqual(len(self.of(events, "cancel.acked")), 1)
        self.assertEqual(self.server.trace_errors, 0)


class LookTraceTest(TraceServerCase):
    def test_look_with_an_image_settles_ready(self):
        self.use_attention()
        self.server.capture = CaptureManager(self.server.feed, Blacklist(deny_blacklist(Path(self.data.name) / "blacklist.json")),
                                             lambda: test_capture.CODE, None, vision=test_capture.FakeVision())
        conn, response = self.open_feed()
        status, said = self.request("POST", "/say", {"text": "看一下", "source": "text", "look": True})
        self.assertEqual((status, said["command"]), (202, "look"))
        [request] = [i["data"] for i in self.server.feed.since(0) if i["event"] == "request"]
        image = base64.b64encode(test_capture.png()).decode()
        self.assertEqual(self.request("POST", "/context/image", {"request_id": request["request_id"],
                                                                 "window_id": 2, "png_base64": image})[0], 202)
        self.lines_until_final(response)
        conn.close()
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        events = self.events(self.only_turn()["trace_id"])
        [asked] = self.of(events, "observation.requested")
        self.assertEqual(asked["attrs"], {"request_id": request["request_id"], "mode": "image", "purpose": "current",
                                          "window_id": 2})
        [settled] = self.of(events, "observation.settled")
        self.assertEqual((settled["attrs"], settled["status"], settled["span_id"]),
                         ({"request_id": request["request_id"], "state": "ready"}, "ok", asked["span_id"]))
        self.assertGreaterEqual(settled["duration_ms"], 0)
        self.assertEqual(self.server.trace_errors, 0)

    def test_refused_look_settles_at_once(self):
        self.server.capture = CaptureManager(self.server.feed, Blacklist(deny_blacklist(Path(self.data.name) / "blacklist.json")),
                                             lambda: test_capture.CODE, None)
        self.line("看一下", look=True)
        events = self.events(self.only_turn()["trace_id"])
        self.assertEqual(self.of(events, "observation.requested"), [])
        [settled] = self.of(events, "observation.settled")
        self.assertEqual((settled["attrs"]["state"], settled["status"], settled["duration_ms"]), ("unavailable", "ok", 0))
        self.assertEqual(self.server.trace_errors, 0)


class RefusedTraceTest(TraceServerCase):
    def test_an_event_the_store_refuses_is_counted_and_logged_with_its_kind(self):
        import contextlib
        import io
        from traces.trace_store import new_trace_id
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            refused = self.server._trace("behavior.receipt", new_trace_id(), turn_id=None, turn_generation=3,
                                         attrs={"behavior_id": "b-1-1", "behavior_type": "idle", "phase": "running",
                                                "reason": None})
        self.assertEqual((refused, self.server.trace_errors), (None, 1))
        self.assertIn("agentd: trace behavior.receipt refused: invalid behavior.receipt event: turn_id and "
                      "turn_generation must both be null or both be set", err.getvalue())

    def test_the_log_line_names_a_refused_value_without_quoting_it(self):
        import contextlib
        import io
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.server._trace("behavior.receipt", "她说的私事\n第二行", attrs={"behavior_id": "b-1-1",
                                                                          "behavior_type": "idle", "phase": "running"})
        self.assertEqual(self.server.trace_errors, 1)
        self.assertIn("bad trace_id", err.getvalue())
        self.assertNotIn("私事", err.getvalue())
        self.assertEqual(err.getvalue().count("\n"), 1)


class TraceEndpointTest(TraceServerCase):
    def test_posted_events_from_avatar_are_stored(self):
        status, body = self.request("POST", "/trace/events", {"events": [avatar_event(),
                                                                         avatar_event("agentd", 2)]})
        self.assertEqual((status, body["accepted"]), (200, 1))
        self.assertEqual(body["rejected"], [{"index": 1, "error": "producer_not_allowed"}])
        [stored] = self.request("GET", "/trace/export")[1]["events"]
        self.assertIn("t_recv_wall", stored)
        self.assertEqual(self.request("POST", "/trace/events", {"events": [avatar_event(seq=i + 1)
                                                                           for i in range(201)]}),
                         (413, {"error": "too_many"}))
        self.assertEqual(self.request("POST", "/trace/events", {"events": {}}), (400, {"error": "invalid_payload"}))
        self.assertEqual(self.request("POST", "/trace/events", {"events": []}, EVENTS)[0], 401)
        self.assertEqual(self.server.trace_errors, 0)

    def test_reads_need_the_ui_token_and_a_store(self):
        self.line("你好")
        trace_id = self.only_turn()["trace_id"]
        for path in ("/trace/turns", f"/trace/turns/{trace_id}", "/trace/decisions", "/trace/export"):
            self.assertEqual(self.request("GET", path, token=EVENTS)[0], 401, path)
        self.assertEqual(self.request("GET", "/trace/turns?limit=0"), (400, {"error": "invalid_query"}))
        self.assertEqual(self.request("GET", f"/trace/turns/{uuid.uuid4()}"), (404, {"error": "unknown_trace"}))
        self.assertEqual(self.request("GET", "/trace/decisions?kind=gate.decided"), (200, {"events": []}))
        exported = self.request("GET", "/trace/export")[1]["events"]
        received = [e for e in exported if e["kind"] == "input.received"][0]
        self.assertEqual(received["attrs"]["text"], {"len": 2})
        self.assertNotIn("text", received)
        exported = self.request("GET", "/trace/export?with_text=1")[1]["events"]
        self.assertEqual([e for e in exported if e["kind"] == "input.received"][0]["text"], {"text": "你好"})
        self.server.trace = None
        self.assertEqual(self.request("GET", "/trace/turns"), (503, {"error": "no_trace"}))
        self.assertEqual(self.request("POST", "/trace/events", {"events": []}), (503, {"error": "no_trace"}))
        self.assertEqual(self.server.trace_errors, 0)

    def test_decisions_filter_by_trace_id_and_reject_an_empty_id(self):
        wanted, other = str(uuid.uuid4()), str(uuid.uuid4())
        self.server.trace.emit("approval.opened", wanted, attrs={"request_id": "r1", "tool": "Bash"})
        self.server.trace.emit("approval.opened", other, attrs={"request_id": "r2", "tool": "Bash"})
        status, body = self.request("GET", f"/trace/decisions?trace_id={wanted}")
        self.assertEqual((status, [e["trace_id"] for e in body["events"]]), (200, [wanted]))
        self.assertEqual(self.request("GET", "/trace/decisions?request_id="), (400, {"error": "invalid_query"}))

    def test_events_read_a_range_by_kind_page_by_page_without_full_text(self):
        now = [time.time()]
        self.server.trace = TraceStore(open_store(self.db), producer_epoch=self.server.registry.epoch,
                                       clock=lambda: now[0])
        wall = lambda t: quote(datetime.datetime.fromtimestamp(t).astimezone().isoformat(timespec="milliseconds"))  # noqa: E731
        start, signal = now[0], {"source": "coarse", "key": "typing", "value": True, "revision": 1}
        ids = []
        for step, (kind, attrs, extra) in enumerate([
                ("signal.changed", signal, {}),
                ("input.received", {"source": "text"},
                 {"turn_id": "t1", "turn_generation": 1, "texts": {"text": "今天下午三点和医生的约"}}),
                ("stage.changed", {"from": "normal", "to": "quiet", "revision": 1}, {})]):
            now[0] = start + step
            ids.append(self.server.trace.emit(kind, str(uuid.uuid4()), attrs=attrs, **extra))
        now[0] = start + 60
        later = self.server.trace.emit("signal.changed", str(uuid.uuid4()), attrs=signal)
        span = f"since={wall(start - 1)}&until={wall(start + 10)}"

        status, body = self.request("GET", f"/trace/events?{span}&with_text=1")
        self.assertEqual(status, 200, body)
        self.assertEqual(([e["event_id"] for e in body["events"]], body["cursor"]), (ids, None))
        self.assertEqual(body["events"][1]["attrs"]["text"], {"len": 11, "head": "今天下午三点和医"})
        self.assertNotIn("text", body["events"][1])
        self.assertNotIn("医生的约", json.dumps(body, ensure_ascii=False))
        self.assertEqual([e["event_id"] for e in self.request("GET", "/trace/events")[1]["events"]], [*ids, later])
        status, body = self.request("GET", f"/trace/events?{span}&kinds=signal.changed,stage.changed")
        self.assertEqual((status, [e["event_id"] for e in body["events"]]), (200, [ids[0], ids[2]]))

        status, first = self.request("GET", f"/trace/events?{span}&limit=2")
        self.assertEqual((status, [e["event_id"] for e in first["events"]]), (200, ids[:2]))
        self.assertIsInstance(first["cursor"], str)
        status, rest = self.request("GET", f"/trace/events?{span}&limit=2&cursor={first['cursor']}")
        self.assertEqual((status, [e["event_id"] for e in rest["events"]], rest["cursor"]), (200, ids[2:], None))

        for bad in ("kinds=signal.changed,nope", "kinds=", "since=2026-11-22T10:00:00", "cursor=x", "cursor=",
                    "limit=0", "limit=201"):
            self.assertEqual(self.request("GET", f"/trace/events?{bad}"), (400, {"error": "invalid_query"}), bad)
        self.assertEqual(self.request("GET", "/trace/events", token=EVENTS)[0], 401)
        self.server.trace = None
        self.assertEqual(self.request("GET", "/trace/events"), (503, {"error": "no_trace"}))

    def test_delete_attention_clears_the_trace(self):
        self.use_attention()
        self.line("你好")
        status, body = self.request("DELETE", "/attention")
        self.assertEqual(status, 200)
        self.assertGreater(body["trace_deleted"], 0)
        self.assertEqual(self.request("GET", "/trace/export")[1], {"events": []})
        self.assertEqual(self.request("GET", "/trace/turns")[1], {"turns": []})
        self.assertEqual(self.server.trace_errors, 0)

    def test_a_line_cut_by_delete_attention_stores_no_trace_after_the_clear(self):
        self.use_attention()
        self.use_mouth(["[intent:explain]第一段", "第二段", "第三段。"])
        stream, cleared = self.server.mouth.stream, []

        def cleared_mid_line(text, context):
            for n, delta in enumerate(stream(text, context)):
                if n == 1:
                    cleared.append(self.request("DELETE", "/attention")[0])
                yield delta

        self.server.mouth.stream = cleared_mid_line
        said = self.line("你看我在看什么")
        self.assertEqual(cleared, [200])
        kinds = open_store(self.db).execute("SELECT kind FROM trace_events WHERE turn_id = ?",
                                            (said["line_id"],)).fetchall()
        self.assertEqual(kinds, [])
        self.server.mouth.stream = stream
        self.line("你好")
        turn = self.only_turn()
        self.assertEqual([e["kind"] for e in self.events(turn["trace_id"])], CHAIN)
        self.assertEqual(self.server.trace_errors, 0)

    def test_a_trace_opened_before_delete_attention_writes_nothing_after_it(self):
        self.use_attention()
        _, self.server.speech = relay_for(self)
        trace = self.server._open_trace("l1", self.server.turn_generation, "text", "你好")
        self.assertEqual(self.request("DELETE", "/attention")[0], 200)
        self.assertIsNone(self.server._step(trace, "model.started", new_span_id(),
                                            attrs={"model": "m", "call": "character_agent"}))
        self.server._tts_event({"trace": trace, "span": new_span_id(), "at": time.monotonic(), "last": None},
                               "speech.first_audio", "s1", {}, time.monotonic())
        self.assertEqual(self.request("GET", "/trace/export")[1], {"events": []})


def codex_reply(session, prompt, options):
    yield {"type": "ready", "model": "gpt-test", "effort": "low", "tool_names": []}
    yield {"type": "text_delta", "text": "Hello"}
    yield {"type": "result", "success": True, "final_text": "Hello", "session_id": "thread-1",
           "usage": {"input_tokens": 2, "output_tokens": 1, "cache_read_input_tokens": 5, "reasoning_output_tokens": 7}}


class HarnessTurnTest(test_character_agent_integration.IntegrationFixture):
    """A character agent turn: its context goes into the trace before the harness's model span."""

    def setUp(self):
        super().setUp()
        # Pi has no default model; the trace format rejects a model span without one.
        self.controller.configure({"provider": "deepseek", "model": "deepseek-chat"})
        self.server.trace = TraceStore(open_store(self.root / "trace.sqlite"), producer_epoch=self.server.registry.epoch)

    def stored(self):
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        rows = self.server.trace.db.execute("SELECT event FROM trace_events ORDER BY id").fetchall()
        return [json.loads(row[0]) for row in rows]

    def test_harness_turn_traces_its_context_then_one_model_span(self):
        self.script = codex_reply
        body, _ = self.line("帮我查一下天气")
        events = self.stored()
        chain = ["context.assembled", "model.started", "model.first_token", "model.finished"]
        marks = [e for e in events if e["kind"] in chain]
        self.assertEqual([e["kind"] for e in marks], chain)
        self.assertEqual(len({e["span_id"] for e in marks[1:]}), 1)
        self.assertEqual(marks[1]["attrs"]["call"], "character_agent")
        self.assertEqual([e["t_mono_ms"] for e in events], sorted(e["t_mono_ms"] for e in events))
        self.assertEqual(self.server.trace_errors, 0)
        finished = marks[-1]["attrs"]
        self.assertEqual((finished.get("cached_tokens"), finished.get("reasoning_tokens")), (5, 7))
        row = self.controller.store.db.execute("SELECT metadata FROM character_run_events WHERE run_id=? AND kind=?",
                                               (body["run_id"], "running")).fetchone()
        running = json.loads(row[0])
        for key in ("context_build_ms", "lock_wait_ms", "look_wait_ms"):
            self.assertIsInstance(running.get(key), int, key)

    def test_a_turn_on_the_harness_default_model_keeps_its_model_span(self):
        self.controller.configure({"provider": "deepseek", "model": ""})
        self.line("帮我查一下天气")
        events = self.stored()
        self.assertEqual([e["attrs"]["model"] for e in events if e["kind"] == "model.started"], ["default"])
        self.assertEqual(self.server.trace_errors, 0)

    def test_token_details_the_harness_did_not_give_stay_out(self):
        self.line("帮我查一下天气")
        [finished] = [e for e in self.stored() if e["kind"] == "model.finished"]
        self.assertNotIn("cached_tokens", finished["attrs"])
        self.assertNotIn("reasoning_tokens", finished["attrs"])
        self.assertNotIn("cost_usd", finished["attrs"])

    def test_the_harness_reported_cost_lands_on_model_finished(self):
        def script(session, prompt, options):
            for event in codex_reply(session, prompt, options):
                yield {**event, "cost_usd": 0.0123} if event["type"] == "result" else event

        self.script = script
        self.line("帮我查一下天气")
        [finished] = [e for e in self.stored() if e["kind"] == "model.finished"]
        self.assertEqual((finished["attrs"]["cost_usd"], finished["attrs"]["cached_tokens"]), (0.0123, 5))

    def test_the_harness_runs_with_the_turns_trace_id_for_its_log_lines(self):
        from traces.trace_store import TURN_TRACE
        seen = []

        def script(session, prompt, options):
            seen.append(TURN_TRACE.get())
            yield from codex_reply(session, prompt, options)

        self.script = script
        body, _ = self.line("帮我查一下天气")
        self.stored()
        self.assertEqual(seen, [body["trace_id"]])
        self.assertIsNone(TURN_TRACE.get())

    def test_tool_failure_and_turn_completion_are_separate_and_private(self):
        def script(session, prompt, options):
            yield {"type": "item", "item_id": "call", "kind": "tool_call", "status": "started",
                   "name": "desktop_observe", "args": {"window": "PRIVATE WINDOW LABEL"}}
            yield {"type": "item", "item_id": "result", "kind": "tool_result", "status": "completed",
                   "parent_item_id": "call", "result": {"error": {"code": "permission_timeout",
                   "message": "PRIVATE TOOL OUTPUT"}}}
            yield from codex_reply(session, prompt, options)

        self.script = script
        self.line("你好")
        events = self.stored()
        [started] = [e for e in events if e["kind"] == "tool.started"]
        [tool] = [e for e in events if e["kind"] == "tool.settled"]
        [turn] = [e for e in events if e["kind"] == "turn.settled"]
        self.assertEqual(started["span_id"], tool["span_id"])
        self.assertEqual(tool["attrs"], {"tool": "desktop_observe", "call_id": "call",
                                         "outcome": "failed", "error_code": "permission_timeout"})
        self.assertEqual(turn["attrs"]["state"], "completed")
        self.assertNotIn("PRIVATE", json.dumps(events))
        self.assertEqual(validate_stream(events), [])

    def test_avatar_tool_and_real_c1_receipt_handler_share_the_turn_trace(self):
        generation = self.server.turn_generation
        trace = self.server._open_trace("turn-face", generation, "text", "测试右转")
        self.server.spatial.set_capabilities(self.server.character, {"face": None})
        facing = self.controller._native("avatar_face", {"yaw_degrees": 25, "reason": "测试", "hold_seconds": 20},
                                         run_id="turn-face", is_current=lambda: True)
        self.assertTrue(facing["accepted"], facing)
        body = {"behavior_id": facing["behavior_id"], "reason": None, "at_ms": 1, "turn_generation": generation}
        for phase in ("prepared", "running", "completed"):
            self.assertEqual(self.request("POST", "/behavior/receipts", {**body, "phase": phase}),
                             (200, {"applied": True, "why": None}))
        self.assertEqual(self.request("POST", "/behavior/receipts", {**body, "phase": "completed"}),
                         (200, {"applied": False, "why": "after_terminal"}))
        events = self.server.trace.turn(trace["trace_id"])["events"]
        self.assertEqual([e["kind"] for e in events], ["input.received", "behavior.dispatched", *["behavior.receipt"] * 3])
        self.assertTrue(all(e["turn_id"] == "turn-face" for e in events))
        self.assertEqual([e["attrs"]["phase"] for e in events[2:]], ["prepared", "running", "completed"])
        self.assertEqual(validate_stream(events), [])

        next_face = self.controller._native("avatar_face", {"yaw_degrees": 25, "reason": "测试"},
                                            run_id="turn-face", is_current=lambda: True)
        self.assertTrue(next_face["accepted"], next_face)
        with self.server._write_lock:
            self.server.trace_generation += 1
            self.server.trace.clear()
        body["behavior_id"] = next_face["behavior_id"]
        self.assertEqual(self.request("POST", "/behavior/receipts", {**body, "phase": "running"}),
                         (200, {"applied": True, "why": None}))
        self.assertEqual(self.server.trace.turn(trace["trace_id"])["events"], [])

    def test_automatic_text_turn_motion_receipts_share_the_original_trace_and_settle(self):
        generation = self.server.turn_generation
        trace = self.server._open_trace("turn-think", generation, "text", "核对预算")
        self.server.spatial._next_tick = self.server.clock() + 600
        self.server.busy = lambda: True
        self.server.spatial.poll()
        [think] = self.server.spatial.running()
        self.assertEqual((think["type"], think["trace_id"], think["turn_id"]), ("think", trace["trace_id"], "turn-think"))
        body = {"behavior_id": think["behavior_id"], "reason": None, "at_ms": 1, "turn_generation": generation}
        for phase in ("prepared", "running"):
            self.assertEqual(self.request("POST", "/behavior/receipts", {**body, "phase": phase}),
                             (200, {"applied": True, "why": None}))
        self.server.busy = lambda: False
        self.server.spatial.poll()
        self.assertEqual(self.server.spatial.running(), [])
        self.assertEqual(self.request("POST", "/behavior/receipts", {**body, "phase": "completed"}),
                         (200, {"applied": True, "why": None}))
        events = self.server.trace.turn(trace["trace_id"])["events"]
        self.assertEqual([e["kind"] for e in events], ["input.received", *["behavior.receipt"] * 3])
        self.assertEqual([e["attrs"]["phase"] for e in events[1:]], ["prepared", "running", "completed"])
        self.assertTrue(all(e["turn_id"] == "turn-think" for e in events))
        self.assertEqual(validate_stream(events), [])


if __name__ == "__main__":
    unittest.main()
