import copy
from datetime import datetime, timedelta
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from infra.store import open_store  # noqa: E402
from traces.trace_store import TraceStore, new_span_id, new_trace_id  # noqa: E402
from traces.trace_format import validate_stream  # noqa: E402

SAMPLE = Path(__file__).with_name("trace-sample.ndjson")
DAY = 86400


def sample():
    return [json.loads(line) for line in SAMPLE.read_text(encoding="utf-8").splitlines() if line.strip()]


def epoch(wall):
    return datetime.fromisoformat(wall).timestamp()


def shifted(wall, ms):
    return (datetime.fromisoformat(wall) + timedelta(milliseconds=ms)).isoformat(timespec="milliseconds")


class TraceStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = open_store(Path(self.tmp.name) / "agentd.db")
        self.now = epoch("2026-10-19T09:12:04.901-04:00")
        self.mono = 100.0
        self.trace = self.make()

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def make(self, **kwargs):
        return TraceStore(self.db, 3, clock=lambda: self.now, mono=lambda: self.mono, **kwargs)

    def rows(self):
        return self.db.execute("SELECT COUNT(*) FROM trace_events").fetchone()[0]

    def kinds(self):
        return [e["kind"] for e in self.trace.export()]

    def put(self, event):
        """Store an event as-is, the way agentd and the tts forwarder write theirs."""
        event = dict(event)
        text = event.pop("text", None)
        self.db.execute("INSERT INTO trace_events (event_id, trace_id, turn_id, producer, producer_epoch, seq, kind,"
                        " status, t_wall, t_recv_wall, day, stored_at, event, text)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (event["event_id"], event["trace_id"], event["turn_id"], event["producer"],
                         event["producer_epoch"], event["seq"], event["kind"], event["status"], event["t_wall"],
                         event.get("t_recv_wall"), "2026-10-19", self.now, json.dumps(event, ensure_ascii=False),
                         None if text is None else json.dumps(text, ensure_ascii=False)))
        self.db.commit()

    def input(self, text="你看我这段代码哪里有问题", source="text"):
        trace_id = new_trace_id()
        self.trace.emit("input.received", trace_id, turn_id="t1", turn_generation=1, attrs={"source": source},
                        texts={"text": text})
        return trace_id

    def test_ids_have_the_format(self):
        self.assertRegex(new_trace_id(), r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$")
        self.assertRegex(new_span_id(), r"^[0-9a-f]{16}$")

    def test_turn_orders_by_skew_corrected_time(self):
        events = sample()
        # Avatar's clock runs 600 ms ahead of agentd's.
        for e in events:
            if e["producer"] == "avatar":
                e["t_wall"] = shifted(e["t_wall"], 600)
                del e["t_recv_wall"]
            else:
                self.put(e)
        avatar = [e for e in events if e["producer"] == "avatar"]
        self.now = epoch("2026-10-19T09:12:04.901-04:00")
        self.assertEqual(self.trace.ingest(avatar[:2]), {"accepted": 2, "rejected": []})
        self.now = epoch("2026-10-19T09:12:07.820-04:00")
        self.assertEqual(self.trace.ingest(avatar[2:]), {"accepted": 2, "rejected": []})
        trace_id = events[0]["trace_id"]
        turn = self.trace.turn(trace_id)
        self.assertEqual(turn["trace_id"], trace_id)
        self.assertEqual(turn["skew_ms"], {"agentd/3": 0, "tts/1": 0, "avatar/2": -570})
        expected = [e["event_id"] for e in events if e["trace_id"] == trace_id]
        self.assertEqual([e["event_id"] for e in turn["events"]], expected)
        self.assertNotIn("text", turn["events"][0])
        self.assertEqual(self.trace.turn(trace_id, with_text=True)["events"][0]["text"],
                         {"text": "你看我这段代码哪里有问题"})

    def test_emit_keeps_len_and_head_in_attrs_and_full_text_aside(self):
        trace_id = self.input()
        long = "长" * 4100
        self.trace.emit("speech.requested", trace_id, turn_id="t1", turn_generation=1,
                        attrs={"speech_id": "s1", "clause_id": None, "line_id": "l1"}, texts={"text": long})
        plain, full = self.trace.turn(trace_id)["events"], self.trace.turn(trace_id, with_text=True)["events"]
        self.assertEqual(plain[0]["attrs"]["text"], {"len": 12, "head": "你看我这段代码哪"})
        self.assertNotIn("text", plain[0])
        self.assertEqual(full[0]["text"], {"text": "你看我这段代码哪里有问题"})
        self.assertEqual(plain[1]["attrs"]["text"], {"len": 4100, "head": "长" * 8})
        self.assertEqual(full[1]["text"]["text"], "长" * 4000)
        stored = self.db.execute("SELECT event, text FROM trace_events ORDER BY id").fetchone()
        self.assertNotIn("你看我这段代码哪里", stored[0])
        self.assertEqual(json.loads(stored[1]), {"text": "你看我这段代码哪里有问题"})
        self.assertEqual([e["seq"] for e in plain], [1, 2])
        self.assertEqual(plain[0]["producer"], "agentd")
        self.assertEqual(plain[0]["producer_epoch"], 3)
        self.assertEqual(plain[0]["t_mono_ms"], 100000)
        self.assertAlmostEqual(epoch(plain[0]["t_wall"]), self.now, places=3)

    def test_emit_rejects_an_invalid_event(self):
        with self.assertRaises(ValueError):
            self.trace.emit("input.received", new_trace_id(), attrs={"source": "telepathy", "text": None})
        with self.assertRaises(ValueError):
            self.trace.emit("model.finished", new_trace_id(), attrs={"model": "m", "input_tokens": 1,
                                                                     "output_tokens": 1, "stop_reason": "end"})
        self.assertEqual(self.rows(), 0)

    def test_ingest(self):
        with self.assertRaises(ValueError) as raised:
            self.trace.ingest([{}] * 201)
        self.assertEqual(str(raised.exception), "too_many")
        events = sample()
        avatar = events[9]
        own = copy.deepcopy(events[0])
        bad = copy.deepcopy(avatar)
        bad["event_id"] = "d0d0d0d0-0000-4000-8000-000000000001"
        del bad["trace_id"]
        companion = copy.deepcopy(events[0])
        companion.update(producer="companion", producer_epoch=1, seq=1,
                         event_id="d0d0d0d0-0000-4000-8000-000000000002")
        companion["attrs"]["text"] = {"len": 4100, "head": "一" * 8}
        companion["text"] = {"text": "一" * 4100}
        result = self.trace.ingest([avatar, own, avatar, bad, "x", companion])
        self.assertEqual(result, {"accepted": 2, "rejected": [
            {"index": 1, "error": "producer_not_allowed"},
            {"index": 2, "error": "duplicate_event_id"},
            {"index": 3, "error": "missing trace_id"},
            {"index": 4, "error": "not an object"},
        ]})
        stored = self.trace.export(with_text=True)
        self.assertEqual([e["event_id"] for e in stored], [avatar["event_id"], companion["event_id"]])
        self.assertRegex(stored[0]["t_recv_wall"], r"\.\d{3}(Z|[+-]\d{2}:\d{2})$")
        self.assertAlmostEqual(epoch(stored[0]["t_recv_wall"]), self.now, places=3)
        self.assertEqual(stored[1]["text"]["text"], "一" * 4000)

    def test_daily_cap_keeps_decisions_and_ends_and_reports_drops(self):
        self.trace = self.make(daily_cap=5, dropped_every=3)
        trace_id = new_trace_id()

        def started(status="ok"):
            self.trace.emit("model.started", trace_id, status=status, attrs={"model": "m", "call": "character_agent"})

        for _ in range(5):
            started()
        first_drop = self.now
        self.trace.emit("model.first_token", trace_id)
        self.now += 1
        self.trace.emit("gate.decided", trace_id, status="blocked",
                        attrs={"kind": "comment", "level": "P2", "speak": False, "reason": None})
        started(status="failed")
        self.trace.emit("playback.ended", trace_id, attrs={"speech_id": "s", "clause_id": None}, duration_ms=5)
        self.assertEqual(self.kinds(), ["model.started"] * 5 + ["gate.decided", "model.started", "playback.ended"])
        self.assertEqual(self.trace.export()[6]["status"], "failed")

        motion = sample()[10]
        self.assertEqual(self.trace.ingest([motion]), {"accepted": 1, "rejected": []})
        started()
        dropped = self.trace.export()[-1]
        self.assertEqual(dropped["kind"], "trace.dropped")
        self.assertEqual(dropped["attrs"]["count"], 3)
        self.assertAlmostEqual(epoch(dropped["attrs"]["since"]), first_drop, places=3)
        self.assertIsNone(dropped["turn_id"])
        self.assertNotEqual(dropped["trace_id"], trace_id)
        self.assertEqual(self.rows(), 9)

        started()
        self.now += DAY
        started()
        self.assertEqual(self.kinds()[-2:], ["trace.dropped", "model.started"])
        self.assertEqual(self.trace.export()[-2]["attrs"]["count"], 1)
        self.assertEqual(validate_stream(self.trace.export(with_text=True)), [])

    def test_past_the_cap_the_motion_lane_keeps_its_inputs_and_only_agentd_writes_it(self):
        self.trace = self.make(daily_cap=1, dropped_every=1000)
        trace_id = new_trace_id()
        self.trace.emit("signal.changed", trace_id,
                        attrs={"source": "coarse", "key": "presence", "value": "present", "revision": 1})
        self.trace.emit("stage.changed", trace_id, attrs={"from": "normal", "to": "quiet", "revision": 1})
        self.trace.emit("motion.chosen", trace_id, attrs={"clip": "c", "why": "idle.t1", "layer": "base",
                                                          "behavior_id": None, "t_s": 1.5})
        self.trace.emit("motion.state", trace_id, attrs={"origin": "local", "phase": "started", "clip": "c",
                                                         "behavior_id": None})
        self.trace.emit("behavior.refused", trace_id, attrs={
            "behavior_type": "perform", "trigger_source": "tick", "trigger_event": "idle.t1", "priority": 0,
            "channels": ["full_body"], "reason": "busy"})
        self.assertEqual(self.kinds(), ["signal.changed", "stage.changed"])
        state = {**sample()[10], "event_id": "d0d0d0d0-0000-4000-8000-000000000003", "kind": "motion.state",
                 "attrs": {"origin": "local", "phase": "started", "clip": "c", "behavior_id": None}}
        self.assertEqual(self.trace.ingest([state]), {"accepted": 0, "rejected": [{"index": 0,
                                                                                    "error": "kind_not_allowed"}]})

    def test_rows_are_kept_by_default_whatever_their_age(self):
        self.input()
        self.now += 400 * DAY
        self.input()
        self.assertEqual(self.rows(), 2)

    def test_retention_7d_deletes_rows_eight_days_old_on_write(self):
        self.trace = self.make(retention=lambda: 7 * DAY)
        self.input()
        self.now += 8 * DAY
        self.input()
        self.assertEqual(self.rows(), 1)

    def test_rows_older_than_seven_days_are_deleted_on_write(self):
        self.trace = self.make(retention=lambda: 7 * DAY)
        self.input()
        self.now += 7 * DAY - 1
        self.input()
        self.assertEqual(self.rows(), 2)
        self.now += 3601
        self.input()
        self.assertEqual(self.rows(), 2)
        self.assertEqual(self.trace.clear(), 2)
        self.assertEqual(self.rows(), 0)

    def test_turns_list_each_input_with_its_result(self):
        results = {}
        for result in ("completed", "blocked", "interrupted", "failed", "open"):
            self.now += 10
            trace_id = self.input(text=f"{result}这一轮说了什么", source="voice" if result == "open" else "text")
            results[trace_id] = result
            self.now += 2
            if result == "completed":
                self.trace.emit("model.finished", trace_id, attrs={"model": "m", "input_tokens": 1,
                                                                   "output_tokens": 1, "stop_reason": "end"},
                                duration_ms=2000)
                self.trace.emit("speech.requested", trace_id, attrs={"speech_id": "s", "clause_id": None, "line_id": "l"},
                                texts={"text": "hello"})
                self.trace.emit("line.parsed", trace_id, attrs={"line_id": "l", "intents": [], "target": None,
                                                               "first_sentence_only": False}, texts={"text": "hello"})
                self.trace.emit("playback.ended", trace_id, attrs={"speech_id": "s", "clause_id": None}, duration_ms=1)
            elif result == "blocked":
                self.trace.emit("gate.decided", trace_id, status="blocked",
                                attrs={"kind": "comment", "level": "P2", "speak": False, "reason": None})
            elif result == "interrupted":
                self.trace.emit("cancel.requested", trace_id, attrs={"by": "ptt", "target": "turn"})
            elif result == "failed":
                self.trace.emit("model.started", trace_id, status="failed", attrs={"model": "m", "call": "character_agent"})
        rows = self.trace.turns()
        self.assertEqual([r["result"] for r in rows], ["open", "failed", "interrupted", "blocked", "completed"])
        self.assertEqual({r["trace_id"]: r["result"] for r in rows}, results)
        self.assertEqual(rows[1]["head"], "failed这一")
        self.assertEqual((rows[1]["len"], rows[1]["producers"]), (len("failed这一轮说了什么"), ["agentd"]))
        self.assertEqual(rows[1]["turn_id"], "t1")
        self.assertEqual(rows[1]["source"], "text")
        self.assertEqual(rows[1]["duration_ms"], 2000)
        self.assertEqual(rows[0]["duration_ms"], 0)
        self.assertAlmostEqual(epoch(rows[0]["started_at"]), self.now - 2, places=3)
        self.assertEqual([r["result"] for r in self.trace.turns(source="voice")], ["open"])
        self.assertEqual([r["result"] for r in self.trace.turns(result="blocked")], ["blocked"])
        self.assertEqual(len(self.trace.turns(limit=2)), 2)
        since = rows[1]["started_at"]
        self.assertEqual([r["result"] for r in self.trace.turns(since=since)], ["open", "failed"])
        with self.assertRaises(ValueError):
            self.trace.turns(limit=0)

    def test_result_requires_turn_closure_and_all_matching_playback_receipts(self):
        trace_id = self.input()
        result = lambda: self.trace.turns()[0]["result"]
        self.assertEqual(result(), "open")
        self.trace.emit("model.finished", trace_id, attrs={"model": "m", "input_tokens": 1,
                                                          "output_tokens": 1, "stop_reason": "end"}, duration_ms=1)
        self.assertEqual(result(), "unknown")
        self.trace.emit("line.parsed", trace_id, attrs={"line_id": "l", "intents": [], "target": None,
                                                       "first_sentence_only": False}, texts={"text": "hello"})
        self.assertEqual(result(), "text_generated")
        for speech_id in ("s1", "s2"):
            self.trace.emit("speech.requested", trace_id, attrs={"speech_id": speech_id, "clause_id": None, "line_id": "l"},
                            texts={"text": "hello"})
        self.assertEqual(result(), "unknown")
        self.trace.emit("playback.ended", trace_id, attrs={"speech_id": "s1", "clause_id": None}, duration_ms=1)
        self.assertEqual(result(), "unknown")
        self.trace.emit("playback.ended", trace_id, attrs={"speech_id": "s2", "clause_id": None}, duration_ms=1)
        self.assertEqual(result(), "completed")

    def test_connection_lost_is_unknown_not_a_user_interrupt(self):
        trace_id = self.input()
        self.trace.emit("playback.interrupted", trace_id, status="cancelled",
                        attrs={"speech_id": "s", "clause_id": None, "reason": "connection_lost", "planned_ms": None},
                        duration_ms=1)
        self.assertEqual(self.trace.turns()[0]["result"], "unknown")

    def test_decisions_filter_by_kind_or_prefix(self):
        trace_id = self.input()
        self.trace.emit("gate.decided", trace_id, attrs={"kind": "comment", "level": "P2", "speak": True,
                                                         "reason": None})
        self.trace.emit("dispatch.proposed", trace_id, attrs={"request_id": "r1"})
        self.trace.emit("approval.opened", trace_id, attrs={"request_id": "r2", "tool": "Bash"})
        self.now += 5
        self.trace.emit("dispatch.decided", trace_id, attrs={"request_id": "r1", "decision": "allow"})
        self.trace.emit("model.started", trace_id, attrs={"model": "m", "call": "character_agent"})
        kinds = lambda **kw: [e["kind"] for e in self.trace.decisions(**kw)]  # noqa: E731
        self.assertEqual(kinds(), ["dispatch.decided", "approval.opened", "dispatch.proposed", "gate.decided"])
        self.assertEqual(kinds(kind="dispatch"), ["dispatch.decided", "dispatch.proposed"])
        self.assertEqual(kinds(kind="approval.opened"), ["approval.opened"])
        self.assertEqual(kinds(limit=1), ["dispatch.decided"])
        since = self.trace.decisions()[0]["t_wall"]
        self.assertEqual(kinds(since=since), ["dispatch.decided"])

    def test_decisions_filter_by_trace_and_request(self):
        first, second = new_trace_id(), new_trace_id()
        self.trace.emit("approval.opened", first, attrs={"request_id": "r1", "tool": "Bash"})
        self.trace.emit("dispatch.proposed", second, attrs={"request_id": "r2"})
        self.trace.emit("approval.decided", second, attrs={"request_id": "r1", "tool": "Bash", "by": "card",
                                                                    "decision": "allow"}, duration_ms=5)
        kinds = lambda **kw: [e["kind"] for e in self.trace.decisions(**kw)]  # noqa: E731
        self.assertEqual(kinds(trace_id=second), ["approval.decided", "dispatch.proposed"])
        self.assertEqual(kinds(request_id="r1"), ["approval.decided", "approval.opened"])
        self.assertEqual(kinds(trace_id=first, request_id="r1"), ["approval.opened"])
        self.assertEqual(kinds(kind="approval", trace_id=second), ["approval.decided"])
        self.assertEqual(kinds(kind="dispatch", request_id="r1"), [])

    def test_export_drops_text_and_heads_unless_asked(self):
        self.input()
        nested = {"text": {"len": 3, "head": "秘密的"}, "inner": [{"len": 2, "head": "密码"}]}
        self.trace.emit("dispatch.proposed", new_trace_id(), attrs={"request_id": "r1", "detail": nested})
        plain = json.dumps(self.trace.export(), ensure_ascii=False)
        self.assertNotIn('"head"', plain)
        self.assertNotIn('"text": {"text"', plain)
        self.assertNotIn("你看", plain)
        exported = self.trace.export()
        self.assertEqual(exported[0]["attrs"]["text"], {"len": 12})
        self.assertEqual(exported[1]["attrs"]["detail"], {"text": {"len": 3}, "inner": [{"len": 2}]})
        full = self.trace.export(with_text=True)
        self.assertEqual(full[0]["attrs"]["text"]["head"], "你看我这段代码哪")
        self.assertEqual(full[0]["text"], {"text": "你看我这段代码哪里有问题"})

    def test_emitted_events_form_a_valid_stream(self):
        trace_id = self.input()
        root = self.trace.export()[0]
        span = new_span_id()
        started = self.trace.emit("model.started", trace_id, turn_id="t1", turn_generation=1, span_id=span,
                                  parent_span_id=root["span_id"], causation_id=root["event_id"],
                                  attrs={"model": "m", "call": "character_agent"})
        self.trace.emit("model.finished", trace_id, turn_id="t1", turn_generation=1, span_id=span,
                        parent_span_id=root["span_id"], causation_id=started,
                        attrs={"model": "m", "input_tokens": 1, "output_tokens": 2, "stop_reason": "end_turn"},
                        duration_ms=300)
        self.trace.emit("line.parsed", trace_id, turn_id="t1", turn_generation=1, causation_id=started,
                        attrs={"line_id": "l1", "intents": [], "target": None, "first_sentence_only": False},
                        texts={"text": "好"})
        self.assertEqual(validate_stream(self.trace.export(with_text=True)), [])

    def test_forget_blanks_the_words_of_those_turns_and_keeps_their_events(self):
        cat = self.input(text="我养了一只猫，记得吗")
        root = self.trace.export()[0]
        self.trace.emit("line.parsed", cat, turn_id="t1", turn_generation=1, parent_span_id=root["span_id"],
                        causation_id=root["event_id"],
                        attrs={"line_id": "t1", "intents": [], "target": None, "first_sentence_only": False},
                        texts={"text": "你养了一只猫啊。"})
        self.now += 1
        hello = new_trace_id()
        self.trace.emit("input.received", hello, turn_id="t2", turn_generation=2, attrs={"source": "text"},
                        texts={"text": "你好"})
        self.assertEqual(self.trace.forget(["t1"]), 2)
        forgotten = self.db.execute("SELECT event, text FROM trace_events WHERE turn_id = 't1'").fetchall()
        self.assertEqual([text for _, text in forgotten], [None, None])
        self.assertTrue(all("猫" not in event for event, _ in forgotten))
        events = self.trace.turn(cat, with_text=True)["events"]
        self.assertEqual([e["kind"] for e in events], ["input.received", "line.parsed"])
        self.assertEqual(events[0]["attrs"]["text"], {"len": 10, "head": ""})
        self.assertEqual(events[1]["attrs"]["text"], {"len": 8, "head": ""})
        self.assertEqual(validate_stream(events), [])
        self.assertEqual(self.trace.turn(hello, with_text=True)["events"][0]["text"], {"text": "你好"})
        self.assertEqual(self.rows(), 3)
        self.assertEqual({r["turn_id"]: r["head"] for r in self.trace.turns()}, {"t1": "", "t2": "你好"})
        self.assertEqual(self.trace.forget([]), 0)


if __name__ == "__main__":
    unittest.main()
