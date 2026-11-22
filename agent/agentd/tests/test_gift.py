import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain.language import ReplyLanguage  # noqa: E402
from character.gate import Gate  # noqa: E402
from personal.history import History  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from infra.store import open_store  # noqa: E402
from traces.trace_store import TraceStore, new_trace_id  # noqa: E402
import test_server  # noqa: E402
from support import serve_in_thread  # noqa: E402


class GiftSourceTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db = open_store(Path(tmp.name) / "agentd.sqlite")
        self.addCleanup(self.db.close)

    def test_gift_is_a_persisted_conversation_source(self):
        history = History(self.db, character_id="aster")
        conversation = history.conversations.active
        event_id = history.record(turn_id="gift-line", source="gift", character_id="aster", persona_revision="1",
                                  user_text="（送了你一份礼物）", reply="谢谢你。", state="completed", started_at=time.time())
        [turn] = history.conversations.turns(conversation)["turns"]
        self.assertEqual((turn["event_id"], turn["source"], turn["user_text"]),
                         (event_id, "gift", "（送了你一份礼物）"))

    def test_gift_is_a_trace_source(self):
        trace = TraceStore(self.db, 1)
        self.assertIsNotNone(trace.emit("input.received", new_trace_id(), turn_id="gift-line",
                                       turn_generation=1,
                                       attrs={"source": "gift", "action_ids": ["receive_gift"]},
                                       texts={"text": "（送了你一份礼物）"}))


class GiftTest(unittest.TestCase):
    request = test_server.SayTest.request
    next_item = test_server.FeedServerCase.next_item

    def setUp(self):
        self.server = AgentdServer(("127.0.0.1", 0), test_server.HOOK, test_server.UI,
                                   events_token=test_server.EVENTS, tick_interval=0.01)
        self.server.mouth = test_server.FakeMouth(["谢谢你的礼物。"])
        self.server.mouth.model = "gift-test-model"
        self.server.speech = test_server.FakeRelay()
        self.server.character_agent = test_server.KernelLines(self.server)
        self.rows = []
        self.server.history = SimpleNamespace(record=lambda **row: self.rows.append(row), conversations=SimpleNamespace(active=None))
        self.thread = serve_in_thread(self.server)
        self.addCleanup(self.stop)

    def stop(self):
        self.server.resetting = False
        self.server.switch = None
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def wait_for(self, predicate):
        deadline = time.monotonic() + 2
        while not predicate() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(predicate())

    def feed(self, event):
        return [{k: v for k, v in item["data"].items() if k != "seq"}
                for item in self.server.feed.since(0) if item["event"] == event]

    def gift(self, body=None):
        return self.request("POST", "/interaction/gift", {} if body is None else body)

    def test_idle_gift_is_one_answer_and_a_current_conversation_turn(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = open_store(Path(tmp) / "agentd.sqlite")
            try:
                history = self.server.history = History(db)
                conversation = history.conversations.active
                trace = self.server.trace = TraceStore(db, 1)
                conn, response = test_server.FeedServerCase.open_feed(self)
                try:
                    status, body = self.gift({"action_id": "receive_gift"})
                    self.assertEqual(status, 202)
                    self.assertEqual(set(body), {"gift_id"})
                    self.assertRegex(body["gift_id"], r"^[0-9a-f]+$")
                    events = []
                    while not events or events[-1]["event"] != "gift" \
                            or json.loads(events[-1]["data"])["state"] != "answered":
                        events.append(test_server.FeedServerCase.next_event(self, response))
                    self.wait_for(lambda: not self.server._live_lines)
                finally:
                    conn.close()
                gifts = [json.loads(item["data"]) for item in events if item["event"] == "gift"]
                self.assertEqual([g["state"] for g in gifts], ["queued", "answered"])
                line_id = gifts[-1]["line_id"]
                self.assertEqual(self.feed("gift"), [
                    {"gift_id": body["gift_id"], "state": "queued", "count": 1, "line_id": None},
                    {"gift_id": body["gift_id"], "state": "answered", "count": 1, "line_id": line_id}])
                self.assertEqual({line["line_id"] for line in self.feed("line")}, {line_id})
                self.assertEqual(sum(line["final"] for line in self.feed("line")), 1)
                [turn] = history.conversations.turns(conversation)["turns"]
                self.assertEqual((turn["turn_id"], turn["source"], turn["user_text"], turn["reply"], turn["state"]),
                                 (line_id, "gift", "（送了你一份礼物）", "谢谢你的礼物。", "completed"))
                self.assertEqual(self.server.mouth.calls[0][0], "（送了你一份礼物）")
                self.assertIn(("speak", line_id, "谢谢你的礼物。"), self.server.speech.calls)
                roots = [json.loads(row[0]) for row in trace.db.execute(
                    "SELECT event FROM trace_events WHERE kind='input.received'")]
                self.assertEqual(len(roots), 1)
                self.assertEqual((roots[0]["attrs"]["source"], roots[0]["attrs"]["action_ids"]),
                                 ("gift", ["receive_gift"]))
                self.assertNotIn("receive_gift", json.dumps(self.server.feed.since(0), ensure_ascii=False))
                self.assertNotIn("receive_gift", json.dumps(turn, ensure_ascii=False))
                self.assertEqual(self.server.trace_errors, 0)
            finally:
                self.server.trace = self.server.history = None
                db.close()

    def test_busy_gift_keeps_the_live_line_and_answers_after_it(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        mouth = self.server.mouth
        stream = mouth.stream

        def held(text, context):
            if text == "继续说":
                entered.set()
                release.wait(2)
            yield from stream(text, context)

        mouth.stream = held
        status, current = self.request("POST", "/say", {"text": "继续说"})
        self.assertEqual(status, 202)
        self.assertTrue(entered.wait(2))
        cancel, generation = self.server._line_cancel, self.server.turn_generation
        calls = list(self.server.speech.calls)
        status, gift = self.gift()
        self.assertEqual(status, 202)
        self.assertFalse(cancel.is_set())
        self.assertEqual((self.server.turn_generation, self.server.speech.calls), (generation, calls))
        self.assertEqual(self.feed("gift"), [
            {"gift_id": gift["gift_id"], "state": "queued", "count": 1, "line_id": None}])
        release.set()
        self.wait_for(lambda: len(self.rows) == 2 and not self.server._live_lines)
        self.assertEqual([(row["turn_id"], row["source"], row["state"]) for row in self.rows],
                         [(current["line_id"], "text", "completed"),
                          (self.feed("gift")[-1]["line_id"], "gift", "completed")])
        lines = self.feed("line")
        end = next(i for i, line in enumerate(lines) if line["line_id"] == current["line_id"] and line["final"])
        self.assertTrue(all(line["line_id"] != current["line_id"] for line in lines[end + 1:]))
        self.assertEqual(self.server.speech.calls, calls + [
            ("speak", current["line_id"], "谢谢你的礼物。"),
            ("speak", self.feed("gift")[-1]["line_id"], "谢谢你的礼物。")])

    def test_three_waiting_gifts_merge_into_one_answer(self):
        self.server.speech.playing = True
        ids = []
        for action in ("receive_gift", "interact_receive_gift", "library_interact_receive_gift"):
            status, body = self.gift({"action_id": action})
            self.assertEqual(status, 202)
            ids.append(body["gift_id"])
        self.assertEqual(len(set(ids)), 1)
        self.assertEqual([g["count"] for g in self.feed("gift")], [1, 2, 3])
        self.assertTrue(all(g["line_id"] is None and g["state"] == "queued" for g in self.feed("gift")))
        self.assertEqual((self.rows, self.server.mouth.calls, self.server.speech.calls), ([], [], []))
        self.server.speech.playing = False
        self.wait_for(lambda: len(self.rows) == 1 and not self.server._live_lines)
        self.assertEqual((self.rows[0]["source"], self.rows[0]["user_text"]), ("gift", "（送了你 3 份礼物）"))
        self.assertEqual(len(self.server.mouth.calls), 1)
        self.assertEqual(self.feed("gift")[-1],
                         {"gift_id": ids[0], "state": "answered", "count": 3, "line_id": self.rows[0]["turn_id"]})

    def test_switch_and_reset_hold_gifts_until_the_tick_can_answer(self):
        for field, value in (("switch", {"expires_at": time.time() + 30}), ("resetting", True)):
            with self.subTest(field=field):
                setattr(self.server, field, value)
                before = len(self.rows)
                status, gift = self.gift()
                self.assertEqual(status, 202)
                time.sleep(0.03)
                self.assertEqual(len(self.rows), before)
                self.assertEqual(self.feed("gift")[-1]["state"], "queued")
                setattr(self.server, field, None if field == "switch" else False)
                self.wait_for(lambda: len(self.rows) == before + 1 and not self.server._live_lines)
                self.assertEqual((self.feed("gift")[-1]["gift_id"], self.feed("gift")[-1]["state"]),
                                 (gift["gift_id"], "answered"))

    def test_invalid_body_is_rejected_without_queuing(self):
        for body in (None, [], "gift", 1, {"action_id": "a" * 65}, {"action_id": "礼" * 22},
                     {"other": "receive_gift"}, {"action_id": 1}, {"action_id": None},
                     {"action_id": "receive_gift", "other": True}):
            with self.subTest(body=body):
                self.assertEqual(self.request("POST", "/interaction/gift", body),
                                 (400, {"error": "invalid_payload"}))
        self.assertEqual((self.feed("gift"), self.rows), ([], []))

    def test_action_id_accepts_64_bytes_and_empty_strings(self):
        self.server.speech.playing = True
        for action in ("a" * 64, "礼" * 21 + "a", ""):
            with self.subTest(action=action):
                self.assertEqual(self.gift({"action_id": action})[0], 202)

    def test_gift_bypasses_gate_and_proactive_budgets_and_feedback(self):
        self.server.gate = Gate(enabled=False)
        self.server.proactive = SimpleNamespace(voiced=mock.Mock(), said=mock.Mock())
        with mock.patch.object(self.server.gate, "commit") as commit:
            status, _ = self.gift()
            self.assertEqual(status, 202)
            self.wait_for(lambda: self.rows and not self.server._live_lines)
            line_id = self.rows[0]["turn_id"]
            self.assertEqual((self.server.gate._count, self.server.gate._last), (0, {}))
            commit.assert_not_called()
            self.server.proactive.voiced.assert_not_called()
            self.assertNotIn(line_id, self.server._proactive_lines)
            self.assertEqual(self.request("POST", "/feedback", {"line_id": line_id, "value": "useful"}),
                             (404, {"error": "unknown_line"}))

    def test_gift_uses_text_voice_rules(self):
        self.server.avatar["visible"] = False
        self.server.gate.meeting = True
        for muted in (False, True):
            with self.subTest(muted=muted):
                self.server.muted = muted
                before = len(self.rows)
                self.assertEqual(self.gift()[0], 202)
                self.wait_for(lambda: len(self.rows) == before + 1 and not self.server._live_lines)
                line_id = self.rows[-1]["turn_id"]
                self.assertEqual({line["speak"] for line in self.feed("line") if line["line_id"] == line_id},
                                 {not muted})
                self.assertEqual(any(c[0] == "speak" and c[1] == line_id for c in self.server.speech.calls), not muted)

    def test_gift_text_follows_the_reply_language(self):
        for code, text in (("en", "(gave you a gift)"), ("zh-Hans", "（送了你一份礼物）")):
            with self.subTest(code=code):
                self.server.character_agent.settings = SimpleNamespace(snapshot=lambda: {"reply_language": code})
                before = len(self.rows)
                self.assertEqual(self.gift()[0], 202)
                self.wait_for(lambda: len(self.rows) == before + 1 and not self.server._live_lines)
                self.assertEqual((self.rows[-1]["source"], self.rows[-1]["user_text"]), ("gift", text))

    def test_tick_without_a_waiting_gift_never_asks_the_runtime(self):
        public = mock.Mock(return_value={"ready": True})
        self.server.character_agent = SimpleNamespace(busy=lambda: False, public=public,
                                                      close=mock.Mock())
        self.server._gift_due()
        time.sleep(0.03)  # the 0.01 s tick runs _gift_due too
        public.assert_not_called()

    def test_gift_notifies_the_enabled_character_agent(self):
        prepared = test_server.FakeMouth(["谢谢你的礼物。"])
        prepared.final_item_id = None
        self.server.mouth.history = []
        agent = self.server.character_agent = SimpleNamespace(
            busy=lambda: False, prepare=mock.Mock(return_value=prepared),
            delivered=mock.Mock(), close=mock.Mock(), public=lambda discover=False, *, wait=True: {"ready": True, "routes": {"chat": {"ready": True}}},
            reply_language=ReplyLanguage(), settings=SimpleNamespace(snapshot=lambda: {"reply_language": "zh-Hans"}))
        self.assertEqual(self.gift()[0], 202)
        self.wait_for(lambda: agent.delivered.called)
        self.assertEqual((agent.prepare.call_args.args[1], agent.prepare.call_args.args[4]),
                         ("（送了你一份礼物）", "gift"))
        self.assertEqual(self.server.mouth.calls, [])


if __name__ == "__main__":
    unittest.main()
