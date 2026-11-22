import datetime
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import support  # noqa: E402
from character.gate import Gate  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from motion.chooser import MotionChooser  # noqa: E402
from test_server import HOOK, UI, FakeMouth, FakeRelay, KernelLines  # noqa: E402
from test_spatial import PACK, situation  # noqa: E402
from personal.memory import Memory  # noqa: E402
from character.proactive import Proactive  # noqa: E402
from brain.persona import PROMPT_USER  # noqa: E402
from personal.rituals import KINDS, TAP, TAPS, TEMPLATES, Rituals  # noqa: E402
from infra.store import open_store  # noqa: E402

DAY = datetime.date(2026, 10, 22)
REPORT = {"sessions": 2, "agents_done": 3, "agents_failed": 1, "gates_green": 1, "gates_red": 0, "guard_blocks": 0,
          "own_sessions": 0, "waiting": [{"name": "repo-x", "state": "awaiting_approval"},
                                         {"name": "repo-y", "state": "awaiting_approval", "word": "waiting for confirmation in Claude Code"}]}
EMPTY = {"sessions": 0, "agents_done": 0, "agents_failed": 0, "gates_green": 0, "gates_red": 0, "guard_blocks": 0,
         "own_sessions": 0, "waiting": []}


def at(hour, minute=0, day=DAY):
    """Local clock time of day at hour:minute."""
    return time.mktime(datetime.datetime.combine(day, datetime.time(hour, minute)).timetuple())


class RitualsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "agentd.sqlite"
        self.now = at(8)
        self.summary = REPORT
        self.changes = 0
        self.r = self.rituals()

    def rituals(self, **kwargs):
        db = open_store(self.path)
        self.addCleanup(db.close)
        return Rituals(db, clock=lambda: self.now, summary=lambda day: self.summary, on_change=self.changed, **kwargs)

    def changed(self):
        self.changes += 1

    def say(self, kind, state="completed", line_id=None):
        """pick() names kind; its line then settles in state."""
        picked = self.r.pick()
        self.assertIsNotNone(picked)
        self.assertEqual(picked[0], kind)
        line_id = line_id or f"l-{self.now}"
        self.r.begin(kind, line_id)
        self.r.settled(line_id, state)
        return picked[1]

    def test_kinds_by_priority(self):
        self.assertEqual(KINDS, ("break", "water", "birthday", "morning", "report"))
        self.assertEqual(set(TEMPLATES), set(KINDS))

    def test_a_tap_line_says_how_many_clicks(self):
        for text in (TAP.format(count=1, user_title=PROMPT_USER), TAPS.format(count=3, user_title=PROMPT_USER)):
            self.assertTrue(text.startswith(f"(Situation, not words from {PROMPT_USER}:"), "a cue she perceives, not his words")
            self.assertIn("topic", text)  # an ongoing conversation goes on
        self.assertIn("touched you 3 times in a row", TAPS.format(count=3, user_title=PROMPT_USER))
        self.assertNotIn("{", TAP.format(count=1, user_title=PROMPT_USER))  # tap formats TAP with count too

    def test_ritual_is_a_history_and_trace_source(self):
        from personal import history
        from traces import trace_format
        for source in ("ritual", "tap"):
            self.assertIn(source, history.SOURCES)
            self.assertTrue(trace_format.KINDS["input.received"]["source"](source))

    def test_first_tap_of_the_day_says_good_morning_then_nothing(self):
        data = self.say("morning")
        self.assertIn("{weekday}", TEMPLATES["morning"])
        TEMPLATES["morning"].format(**data, user_title=PROMPT_USER)
        self.now += 10
        self.assertIsNone(self.r.pick())
        self.assertEqual(self.r.pending(), [])

    def test_before_five_there_is_no_morning(self):
        self.now = at(4, 59)
        self.assertIsNone(self.r.pick())
        self.now = at(5)
        self.assertEqual(self.r.pick()[0], "morning")

    def test_report_after_the_report_time(self):
        self.say("morning")
        self.now = at(17, 29)
        self.assertIsNone(self.r.pick())
        self.now = at(17, 30)
        data = self.say("report")
        text = TEMPLATES["report"].format(**data, user_title=PROMPT_USER)
        self.assertIn("repo-x", text)
        self.assertIn("repo-x waiting for approval", text)
        self.assertIn("repo-y waiting for confirmation in Claude Code", text, "an observed session waits in its own app")
        for harness in ("gate", "guard"):  # the harness handles its gates and guards itself
            self.assertNotIn(harness, text)
        self.now += 10
        self.assertIsNone(self.r.pick())

    def test_first_tap_after_the_report_time_skips_the_morning(self):
        self.now = at(18)
        self.assertEqual(self.r.pending(), ["report"])
        self.say("report")
        self.assertIsNone(self.r.pick())

    def test_report_needs_a_session_event_today(self):
        self.summary = EMPTY
        self.now = at(18)
        self.assertIsNone(self.r.pick())
        self.assertEqual(self.r.pending(), [])

    def test_a_day_with_episodes_and_no_session_has_a_report(self):
        days = []
        self.r = self.rituals(arc=lambda day: days.append(day) or "10:00–10:40 调试服务器；10:40–11:00 看文档")
        self.now = at(18)
        for summary in (EMPTY, None):
            with self.subTest(summary=summary):
                self.summary = summary
                kind, data = self.r.pick()
                self.assertEqual(kind, "report")
                self.assertEqual((data["sessions"], data["own_sessions"], data["waiting"]), (0, 0, "none"))
                text = TEMPLATES["report"].format(**data, user_title=PROMPT_USER)
                self.assertEqual(data["arc"], "10:00–10:40 调试服务器；10:40–11:00 看文档")
                self.assertNotIn("调试服务器", text)  # observed: the line's live material carries it
                self.assertIn("What happened today is in the live material", text)
                self.assertIn("Today 0 sessions were opened", text)
        self.assertEqual(days[0], DAY.isoformat())

    def test_no_episodes_and_no_session_event_has_no_report(self):
        self.r = self.rituals(arc=lambda day: None)
        self.summary = EMPTY
        self.now = at(18)
        self.assertEqual(self.r.pending(), [])

    def test_a_report_without_episodes_says_there_is_no_record(self):
        self.r = self.rituals(arc=lambda day: None)
        self.now = at(18)
        kind, data = self.r.pick()
        self.assertEqual((kind, data["arc"], data["sessions"]), ("report", "no record", 2))

    def test_report_time_is_configurable(self):
        self.r = self.rituals(report_time="12:00")
        self.now = at(12)
        self.assertEqual(self.r.pick()[0], "report")

    def test_break_comes_before_the_morning(self):
        self.r.set_pending("break", {"minutes": 50})
        self.assertEqual(self.r.pending(), ["break", "morning"])
        data = self.say("break")
        self.assertIn("50", TEMPLATES["break"].format(**data, user_title=PROMPT_USER))
        self.assertEqual(self.r.pending(), ["morning"])
        self.say("morning")

    def test_a_cancelled_line_stays_pending_and_waits_sixty_seconds(self):
        self.now = at(4)  # before the morning window: break is the only kind
        self.r.set_pending("break", {"minutes": 50})
        self.say("break", "cancelled")
        self.assertEqual(self.r.pending(), ["break"])
        self.now += 59
        self.assertIsNone(self.r.pick())
        self.now += 1
        self.say("break", "failed", line_id="l-2")
        self.now += 60
        self.say("break", line_id="l-3")
        self.assertEqual(self.r.pending(), [])

    def test_a_cancelled_morning_is_said_again_later_the_same_day(self):
        self.say("morning", "cancelled")
        self.now += 30
        self.assertIsNone(self.r.pick())
        self.now += 30
        self.say("morning")

    def test_a_restart_reads_the_log_back(self):
        self.r.set_pending("break", {"minutes": 50})
        self.say("break")
        self.say("morning", line_id="l-m")
        self.r = self.rituals()
        self.assertIsNone(self.r.pick())
        self.assertEqual(self.r.pending(), [])
        self.assertEqual([entry["kind"] for entry in self.r.today()], ["break", "morning"])
        # The next day starts over.
        self.now = at(8, day=DAY + datetime.timedelta(days=1))
        self.assertEqual(self.r.pick()[0], "morning")
        self.assertEqual(self.r.today(), [])

    def test_a_cancelled_line_is_held_across_a_restart(self):
        self.say("morning", "cancelled")
        self.r = self.rituals()
        self.now += 30
        self.assertIsNone(self.r.pick())

    def test_water_is_stale_after_two_hours(self):
        self.now = at(1)
        self.r.set_pending("water", {"minutes": 90})
        self.now += 2 * 3600 - 1
        self.assertEqual(self.r.pending(), ["water"])
        self.now += 1
        self.assertEqual(self.r.pending(), [])
        self.assertIsNone(self.r.pick())

    def test_clear_pending(self):
        self.now = at(4)
        self.r.set_pending("break", {"minutes": 50})
        self.r.clear_pending("break")
        self.assertIsNone(self.r.pick())

    def pending_rows(self):
        return self.r.db.execute("SELECT COUNT(*) FROM ritual_pending").fetchone()[0]

    def test_a_pending_break_survives_a_restart(self):
        self.now = at(4)
        self.r.set_pending("break", {"minutes": 50})
        self.r = self.rituals()
        self.assertEqual(self.r.pending(), ["break"])
        self.assertEqual(self.r.pick(), ("break", {"minutes": 50}))

    def test_a_cleared_reminder_is_gone_after_a_restart(self):
        self.now = at(4)
        self.r.set_pending("break", {"minutes": 50})
        self.r.clear_pending("break")
        self.r = self.rituals()
        self.assertEqual(self.r.pending(), [])

    def test_a_said_reminder_is_gone_after_a_restart(self):
        self.now = at(4)
        self.r.set_pending("break", {"minutes": 50})
        self.say("break")
        self.r = self.rituals()
        self.assertEqual(self.r.pending(), [])

    def test_clear_deletes_the_stored_reminders(self):
        self.r.set_pending("break", {"minutes": 50})
        self.r.set_pending("water", {"minutes": 90})
        self.r.clear()
        self.assertEqual(self.pending_rows(), 0)

    def test_a_restart_drops_a_break_of_an_earlier_day(self):
        self.now = at(23)
        self.r.set_pending("break", {"minutes": 50})
        self.now = at(0, 30, day=DAY + datetime.timedelta(days=1))
        self.r = self.rituals()
        self.assertEqual(self.r.pending(), [])
        self.assertEqual(self.pending_rows(), 0)

    def test_a_restart_keeps_water_until_it_is_stale(self):
        self.now = at(23, 30)
        self.r.set_pending("water", {"minutes": 90})
        self.now = at(0, 30, day=DAY + datetime.timedelta(days=1))  # another day, one hour later
        self.r = self.rituals()
        self.assertEqual(self.r.pick(), ("water", {"minutes": 90}))
        self.now = at(1, 30, day=DAY + datetime.timedelta(days=1))
        self.r = self.rituals()
        self.assertEqual(self.r.pending(), [])
        self.assertEqual(self.pending_rows(), 0)

    def test_changes_are_announced(self):
        self.r.set_pending("break", {"minutes": 50})
        self.r.clear_pending("break")
        self.say("morning")
        self.assertEqual(self.changes, 3)

    def test_birthday_from_a_confirmed_fact(self):
        db = open_store(self.path)
        self.addCleanup(db.close)
        memory = Memory(db)
        memory.add("管理员的生日是 10 月 22 日", "confirmed_by_user", kind="birthday")
        self.r = self.rituals(memory=memory)
        self.assertEqual(self.r.pending(), ["birthday", "morning"])
        self.say("birthday")
        self.now = at(8, day=DAY + datetime.timedelta(days=1))
        self.assertEqual(self.r.pending(), ["morning"])
        for text in ("生日：1990-10-23", "10/23 是我生日"):
            with self.subTest(text=text):
                memory.clear("all")
                memory.add(text, "confirmed_by_user", kind="birthday")
                self.assertEqual(self.r.pending(), ["birthday", "morning"])


class TapDeliveryTest(unittest.TestCase):
    """Proactive with deliver="tap": break and water become pending instead of being said."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = open_store(Path(tmp.name) / "agentd.sqlite")
        self.addCleanup(db.close)
        self.now = at(3)  # no morning: only break and water can be pending
        self.r = Rituals(db, clock=lambda: self.now, summary=lambda day: EMPTY)
        self.claims, self.published = [], []
        self.p = Proactive(None, Gate(enabled=True, quiet=(0, 0)), lambda e, d: self.published.append((e, d)),
                           None, lambda: False, clock=lambda: self.now,
                           claim=lambda *args: self.claims.append(args) or True,
                           break_minutes=50, water_minutes=90, deliver="tap",
                           on_pending=self.r.set_pending, on_clear=self.r.clear_pending, absence=lambda: self.absence)
        self.absence = None  # user_now's open absence

    def desk(self, minutes, idle_s=0.0, keys=30):
        """A heartbeat every 30 s for `minutes` minutes."""
        for _ in range(round(minutes * 2)):
            self.now += 30.0
            self.p.beat({"ts": self.now, "front": {}, "mouse": None, "idle_s": idle_s, "locked": False,
                         "asleep": False, "input": {"keys_60s": keys}})

    def test_a_due_break_is_pending_not_said(self):
        self.desk(50)
        self.assertEqual(self.r.pending(), [])
        self.desk(0.5)
        self.assertEqual(self.r.pending(), ["break"])
        self.assertEqual(self.r.pick(), ("break", {"minutes": 50}))
        self.assertEqual((self.claims, [e for e, _ in self.published]), ([], []))

    def test_an_absence_clears_the_break(self):
        self.desk(50.5)
        self.assertEqual(self.r.pending(), ["break"])
        self.desk(0.5, idle_s=300.0)  # idle seconds alone are no absence
        self.assertEqual(self.r.pending(), ["break"])
        self.absence = {"id": "1", "since": self.now}
        self.desk(0.5)
        self.assertEqual(self.r.pending(), [])

    def test_water_after_ninety_active_minutes(self):
        self.desk(90)  # time between beats: 89 min 30 s so far
        self.assertNotIn("water", self.r.pending())
        self.desk(0.5)
        self.assertIn("water", self.r.pending())
        self.assertEqual(self.r.pending()[0], "break")
        self.assertEqual(self.r.pick(), ("break", {"minutes": 50}))
        # Active time adds up across an absence; the absence itself does not count.
        self.r.clear_pending("water")
        self.desk(45)
        self.absence = {"id": "1", "since": self.now}
        self.desk(10)
        self.absence = None
        self.desk(45)
        self.assertNotIn("water", self.r.pending())
        self.desk(0.5)
        self.assertIn("water", self.r.pending())


class ReturnWelcomeTapTest(unittest.TestCase):
    """The first tap of a day on which her return performance welcomed the user: no morning greeting."""

    def setUp(self):
        support.enable_plugins(self)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.server = server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
        thread = support.serve_in_thread(server)
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        server.character = "aster"
        server.mouth = FakeMouth(["早上好。"])
        server.speech = FakeRelay()
        server.gate = Gate(enabled=True, quiet=(0, 0))
        server.character_agent = KernelLines(server)
        server.history = SimpleNamespace(record=lambda **row: None, conversations=SimpleNamespace(active=None))
        db = open_store(Path(tmp.name) / "agentd.sqlite")
        self.addCleanup(db.close)
        self.now = time.mktime(datetime.datetime.now().replace(hour=8, minute=0, second=0, microsecond=0).timetuple())
        server.rituals = Rituals(db, clock=lambda: self.now, summary=lambda day: None, on_change=server.ritual_check)
        server.spatial.observe = lambda: situation()
        server.spatial.use_motion(MotionChooser(PACK))
        server.spatial.motion_step()

    def back(self, stage):
        self.server.spatial.stage = lambda: stage
        self.server.user_event({"revision": 1, "ts": self.now - 60, "name": "user.return",
                                "data": {"absence_id": "a-1", "away_s": 900}})

    def tap(self):
        kind = support.request(self, "POST", "/interaction/tap", {"at": "2026-10-22T08:00:00+08:00"})[1]["kind"]
        deadline = time.monotonic() + 2
        while self.server._live_lines and time.monotonic() < deadline:  # the line settles before the store closes
            time.sleep(0.01)
        return kind

    def test_a_welcome_that_played_today_leaves_no_morning_greeting(self):
        self.back("engaged")
        self.assertEqual(self.server.spatial.diag()["return"]["played"], ["welcome"])
        self.assertEqual(self.tap(), "tap")

    def test_a_return_without_a_welcome_keeps_the_morning(self):
        self.back("quiet")
        self.assertEqual(self.tap(), "morning")


if __name__ == "__main__":
    unittest.main()
