"""The focus session the user starts: the gate, her activity, the command, the end recap and a restart."""
import datetime
from pathlib import Path
import tempfile
import unittest

import test_server
from brain.parser import parse_command
from character.behavior import Behavior
from character.focus import Focus
from character.gate import Gate

NOON = datetime.datetime(2026, 10, 18, 12, 0, 0)
GUILT = ("分心", "走神", "摸鱼", "偷懒", "离开", "没专注", "浪费")


class FocusTest(unittest.TestCase):
    def test_focus_blocks_proactive_but_passes_p1(self):
        gate = Gate(enabled=True, same_cooldown=0, cross_cooldown=0)
        gate.set_companion(True)
        gate.focus = True
        for kind in ("comment", "alert", "break", "back", "stuck", "dispatch_review"):
            self.assertEqual(gate.admit(kind, "P2", NOON), (False, "focus"), kind)
        self.assertEqual(gate.check("comment", NOON), "focus")
        self.assertEqual(gate.admit("session_failed", "P1", NOON), (True, None))
        self.assertIsNone(gate.check("focus_done", NOON, level="P1"))
        self.assertEqual(gate.admit("reminder_due", "P0", NOON), (True, None))
        gate.focus = False
        self.assertEqual(gate.admit("comment", "P2", NOON), (True, None))

    def test_recap_names_no_leisure_minutes(self):
        ended = {"start": 0.0, "end": 1500.0, "counts": {"sessions": 0, "approvals": 0, "reminders": 0},
                 "categories": {"game": 600.0, "media": 300.0, "coding": 600.0}}
        self.assertEqual(Focus().recap(ended), "这次专注了 25 分钟：写代码 10 分钟。休息 5 分钟？")

    def test_recap_is_in_the_reply_language(self):
        ended = {"start": 0.0, "end": 1500.0, "counts": {"sessions": 2, "approvals": 0, "reminders": 1},
                 "categories": {"coding": 600.0, "game": 300.0}}
        for language, text in (
                ("zh-Hans", "这次专注了 25 分钟：完成了 2 个 agent 会话，送达了 1 条提醒；写代码 10 分钟。休息 5 分钟？"),
                (None, "这次专注了 25 分钟：完成了 2 个 agent 会话，送达了 1 条提醒；写代码 10 分钟。休息 5 分钟？"),
                ("en", "Focused for 25 min: agent sessions done: 2, reminders delivered: 1; coding 10 min. "
                       "Take a 5-minute break?"),
                ("ja", "今回は 25 分集中したね：agent セッション 2 件完了、リマインド 1 件送信；コーディング 10 分。5 分休憩する？")):
            with self.subTest(language=language):
                self.assertEqual(Focus(language=lambda: language).recap(ended), text)

    def test_focus_ends_with_recap_counts_only(self):
        server = test_server.ServerTest()
        server.setUp()
        now = [1000.0]
        server.server.clock = lambda: now[0]
        try:
            self.assertEqual(server.request("POST", "/focus", {"minutes": 4})[0], 400)
            status, body = server.request("POST", "/focus", {"minutes": 25})
            self.assertEqual(status, 200)
            self.assertEqual(body["focus"]["minutes"], 25)
            self.assertEqual(server.request("POST", "/focus", {"minutes": 25}), (409, {"error": "focus_running"}))
            self.assertTrue(server.server.gate.focus)
            self.assertEqual(server.request("GET", "/desktop/presence")[1]["focus"],
                             {"until": body["focus"]["until"], "minutes": 25})
            self.assertTrue(server.server.situation()["focus"])
            for session in ("a", "b"):
                server.hook("claude", "UserPromptSubmit", session=session, prompt="x")
                server.hook("claude", "Stop", session=session)
            card = server.server.broker.open("claude", "a", tool_name="Read", tool_summary="file")
            self.assertEqual(server.server.broker.decide(card.request_id, card.generation, "allow"), (True, None))
            server.server.focus.count("reminders")
            for second in range(0, 600, 2):  # ten active minutes writing code, while observation is on
                server.server.focus.beat("coding", 1000.0 + second, True)
            now[0] += 12 * 60
            status, body = server.request("DELETE", "/focus")
            self.assertEqual((status, body), (200, {"focus": None}))
            self.assertFalse(server.server.gate.focus)
            announced = [i["data"] for i in server.server.feed.since(0) if i["event"] == "announce"][-1]
            self.assertEqual((announced["kind"], announced["level"]), ("focus_done", "P1"))
            self.assertEqual(announced["headline"], "这次专注了 12 分钟：完成了 2 个 agent 会话，处理了 1 张审批，"
                                                    "送达了 1 条提醒；写代码 10 分钟。休息 5 分钟？")
            for word in GUILT:
                self.assertNotIn(word, announced["headline"])
            self.assertEqual(server.request("DELETE", "/focus"), (409, {"error": "no_focus"}))
            self.assertIsNone(server.request("GET", "/focus")[1]["focus"])
        finally:
            server.tearDown()
            server.doCleanups()

    def test_focus_runs_out_on_the_tick(self):
        now = [1000.0]
        focus = Focus(clock=lambda: now[0])
        focus.start(5)
        self.assertIsNone(focus.due())
        now[0] += 300
        ended = focus.due()
        self.assertEqual(ended["minutes"], 5)
        self.assertFalse(focus.running())
        self.assertEqual(focus.recap(ended), "这次专注了 5 分钟。休息 5 分钟？")

    def test_focus_language_is_not_a_timer_command(self):
        for prompt in ("陪我专注 25 分钟", "陪我专注二十五分钟吧", "专注 50 分钟", "结束专注"):
            self.assertIsNone(parse_command(prompt))

    def test_say_does_not_start_a_focus_timer(self):
        server = test_server.ServerTest()
        server.setUp()
        try:
            server.server.mouth = test_server.FakeMouth(["可以。"])
            server.server.character_agent = test_server.KernelLines(server.server)
            status, body = server.request("POST", "/say", {"text": "陪我专注 25 分钟"})
            self.assertEqual(status, 202)
            self.assertIn("line_id", body)
            self.assertFalse(server.server.focus.running())
        finally:
            server.tearDown()
            server.doCleanups()

    def test_focus_survives_restart(self):
        now = [1000.0]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "focus.json"
            first = Focus(path, clock=lambda: now[0])
            started = first.start(30)
            first.count("sessions")
            now[0] += 600
            again = Focus(path, clock=lambda: now[0])
            self.assertTrue(again.running())
            self.assertEqual(again.public(), started)
            self.assertEqual(again.session["counts"]["sessions"], 1)
            now[0] += 1200
            self.assertFalse(Focus(path, clock=lambda: now[0]).running())  # its window ended while agentd was down


class FocusBehaviorTest(unittest.TestCase):
    def test_she_thinks_through_focus(self):
        situation = {"hour": 14, "focus_state": "idle", "pending": 0, "presence": "active", "presence_s": 60.0,
                     "category": "coding", "focus": True}
        emitted = []
        behavior = Behavior(lambda: dict(situation), lambda a, m: emitted.append((a, m)))
        behavior.tick()
        self.assertEqual(emitted[-1][0], "think")
        situation["focus"] = False
        behavior.tick()
        self.assertEqual(emitted[-1][0], "relax")


if __name__ == "__main__":
    unittest.main()
