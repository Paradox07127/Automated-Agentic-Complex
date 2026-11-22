"""Her own day: the activity scheduler, the looser sit variants and guard, and the no-interrupt zone that stays."""
from pathlib import Path
import random
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character import behavior, routine  # noqa: E402
from character.behavior import Behavior  # noqa: E402
from character.routine import ACTS, NO_REPEAT, Routine  # noqa: E402
from observation import spatial  # noqa: E402
from observation.spatial import Spatial  # noqa: E402
from sessions.registry import Registry  # noqa: E402

KINDS = ("idle", "observe", "short_walk", "sit", "hold_window_edge", "climb_window_top")


def local(hour, minute=0):
    return time.mktime((2026, 10, 19, hour, minute, 0, 0, 0, -1))


def situation(**over):
    return {"fullscreen": False, "user_speaking": False, "speaking": False, "voicing": False, "line_id": None,
            "typing": False, "session": None, "state": "idle", "related": [], "window_id": 101,
            "activity": "editing_code", "idle_s": 1.0, **over}


class RoutineTest(unittest.TestCase):
    def draws(self, hour, activity, trials=400):
        rng, picked = random.Random(7), []
        for _ in range(trials):
            r = Routine(rng=rng)
            picked.append(r.choose(local(hour), KINDS, {"activity": activity, "working": False})[0])
        return picked

    def test_tea_comes_under_any_foreground_and_more_in_the_afternoon(self):
        for activity in ("editing_code", "reading", "comparing_sources", "unknown", None):
            with self.subTest(activity=activity):
                morning = self.draws(10, activity).count("tea")
                afternoon = self.draws(15, activity).count("tea")
                self.assertGreater(morning, 0)
                self.assertGreater(afternoon, morning)

    def test_no_activity_twice_within_twenty_minutes(self):
        r, now, starts = Routine(rng=random.Random(3)), local(9), {}
        r.advance(now, False)
        for _ in range(300):
            name, act, duration = r.choose(now, KINDS, {"activity": "editing_code", "working": False})
            if name in ACTS:
                for before in starts.get(name, []):
                    self.assertGreaterEqual(now - before, NO_REPEAT, name)
                starts.setdefault(name, []).append(now)
            self.assertLessEqual(len(r.recent()), routine.RECENT)
            now += duration
            r.advance(now, act.sitting)
            r.end(now)
        self.assertGreaterEqual(len(starts), 6, "she does many different things")

    def test_a_celebration_is_followed_by_a_tea_break(self):
        r = Routine(rng=random.Random(5))
        r.after_celebration(local(10))
        self.assertEqual(r.choose(local(10, 1), KINDS, {"activity": "editing_code", "working": False})[0], "tea")

    def test_no_sitting_activity_without_a_sit_and_nothing_without_a_kind(self):
        r = Routine(rng=random.Random(1))
        for _ in range(50):
            name, act, _ = r.choose(local(15), ("idle", "observe"), {"activity": "typing", "working": False})
            self.assertIn(act.kind, ("idle", "observe"))
            r.end(local(15))
        self.assertIsNone(Routine().choose(local(15), (), {"activity": None, "working": False}))

    def test_guard_now_and_then_while_she_stands_and_the_user_is_there(self):
        r, now, guards = Routine(rng=random.Random(11)), local(9), []
        r.advance(now, False)
        while now < local(21):
            name, act, duration = r.choose(now, KINDS, {"activity": "editing_code", "working": False})
            if name == "guard":
                guards.append(now)
            now += duration
            r.advance(now, act.sitting)
            r.end(now)
        self.assertGreaterEqual(len(guards), 12 // 2)  # 12 hours, about one an hour
        self.assertLessEqual(len(guards), 12 * 2)
        away = Routine(rng=random.Random(11))
        away.see(presence="afk")
        for _ in range(100):
            self.assertNotEqual(away.choose(local(15), KINDS, {"activity": "away", "working": False})[0], "guard")
            away.end(local(15))


class SitVariantTest(unittest.TestCase):
    def test_every_variant_under_any_activity(self):
        rng = random.Random(2)
        for activity in ("editing_code", "reading", "watching_video", "typing", None):
            with self.subTest(activity=activity):
                seen = {spatial.sit_variant(activity, rng) for _ in range(200)}
                self.assertEqual(seen, {"tea", "read", "still", None})

    def test_the_activity_still_weighs_its_own_variant_up(self):
        rng = random.Random(2)
        reading = [spatial.sit_variant("reading", rng) for _ in range(400)]
        self.assertGreater(reading.count("read"), reading.count("tea"))


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.now, self.emitted = local(15), []
        self.state = self.sit()

    def sit(self, **over):
        return {"hour": 15, "focus_state": "idle", "pending": 0, "presence": "active", "presence_s": 30.0,
                "category": "coding", **over}

    def make(self, **kw):
        return Behavior(lambda: self.state, lambda a, m: self.emitted.append((a, m)), clock=lambda: self.now,
                        rng=random.Random(4), **kw)

    def run_tool(self, b, seconds, **over):
        for _ in range(int(seconds / behavior.POLL)):
            self.now += behavior.POLL
            self.state = self.sit(focus_state="running_tool", busy_since=self.start, **over)
            b.poll()

    def test_a_long_tool_run_raises_a_guard_that_ends_on_its_own(self):
        b, self.start = self.make(), self.now
        self.run_tool(b, behavior.GUARD_TOOL_AFTER - 10)
        self.assertNotIn("guard", [a for a, _ in self.emitted])
        self.run_tool(b, 15)
        self.assertEqual(self.emitted[-1][0], "guard")
        self.run_tool(b, behavior.GUARD_FOR[1] + 10)
        self.assertNotEqual(self.emitted[-1][0], "guard")

    def test_the_guard_gives_way_at_once_when_the_user_is_needed(self):
        for needs in ("awaiting_approval", "awaiting_input", "error"):
            with self.subTest(needs=needs):
                self.emitted = []
                b, self.start = self.make(), self.now
                self.run_tool(b, behavior.GUARD_TOOL_AFTER + 5)
                self.assertEqual(self.emitted[-1][0], "guard")
                self.now += behavior.POLL
                self.state = self.sit(focus_state=needs, pending=int(needs == "awaiting_approval"))
                b.poll()
                self.assertNotEqual(self.emitted[-1][0], "guard")

    def test_a_routine_guard_shows_and_yields_to_the_user(self):
        r = Routine(rng=random.Random(1))
        b = self.make(routine=r)
        r._start("guard", ACTS["guard"], self.now, 60.0)
        self.now += behavior.POLL
        b.poll()
        self.assertEqual(self.emitted[-1][0], "guard")
        self.now += behavior.POLL
        self.state = self.sit(focus_state="awaiting_input")
        b.poll()
        self.assertNotEqual(self.emitted[-1][0], "guard")
        self.assertIsNone(r.doing(self.now))

    def test_no_new_guard_in_the_no_interrupt_zone(self):
        for over in ({"meeting": True}, {"fullscreen": True}, {"typing": True},
                     {"presence": "afk", "presence_s": 60.0}):
            with self.subTest(over=over):
                self.emitted = []
                b, self.start = self.make(), self.now
                self.run_tool(b, behavior.GUARD_TOOL_AFTER + 30, **over)
                self.assertNotIn("guard", [a for a, _ in self.emitted])
                self.assertNotIn("fly", [a for a, _ in self.emitted])

    def test_a_session_done_offers_tea(self):
        r = Routine(rng=random.Random(5))
        b = self.make(routine=r)
        b.event("session_done")
        self.assertEqual(r.choose(self.now + 30, KINDS, {"activity": "editing_code", "working": False})[0], "tea")


class DayTest(unittest.TestCase):
    """A day with an injected clock: Spatial plays her routine; the host is a no-op that lets behaviors run out."""

    def spatial(self, rng):
        self.registry, self.now = Registry(epoch=7), local(9)
        self.s = situation()
        made = Spatial(lambda: dict(self.s), self.registry.publish_event, lambda: 1, 7, clock=lambda: self.now,
                       rng=rng, session_settle=0, session_min_hold=0, recovery_delay=0,
                       routine=Routine(rng=rng))
        made.begin()
        return made

    def test_she_sits_about_half_the_day(self):
        sp = self.spatial(random.Random(21))
        # the user's day: coding with sessions at work, reading, a video in the afternoon, some typing
        day = [(9, "editing_code", "running_tool", False), (10, "reading", None, False),
               (11, "editing_code", "thinking", True), (12, "away", None, False), (13, "editing_code", "running_tool", False),
               (14, "watching_video", None, False), (15, "comparing_sources", None, False),
               (16, "editing_code", "running_tool", False), (17, "typing", None, True), (18, "reading", None, False),
               (19, "watching_video", None, False), (20, "editing_code", "running_tool", False),
               (21, "reading", None, False), (22, "unknown", None, False)]
        seated, polls, kinds = 0, 0, set()
        for hour, activity, state, typing in day:
            self.s.update(activity=activity, session="codex:A" if state else None, state=state or "idle",
                          typing=typing)
            while self.now < local(hour + 1):
                self.now += 5.0
                sp.poll()
                running = {b["type"] for b in sp.running()}
                kinds |= running
                seated += bool(running & {"sit", "climb_window_top"})
                polls += 1
        share = seated / polls
        self.assertGreaterEqual(share, 0.35)
        self.assertLessEqual(share, 0.55)
        self.assertTrue({"sit", "short_walk", "observe", "climb_window_top"} <= kinds, kinds)

    def test_the_no_interrupt_zone_holds(self):
        for over, banned in (({"fullscreen": True}, set(KINDS) - {"idle"}), ({"activity": "meeting"}, set(KINDS)),
                             ({"activity": "switching"}, set(KINDS)),
                             ({"typing": True}, {"sit", "short_walk", "climb_window_top"})):
            with self.subTest(over=over):
                sp = self.spatial(random.Random(3))
                self.s.update(over)
                for _ in range(720):
                    self.now += 5.0
                    sp.poll()
                    self.assertFalse({b["type"] for b in sp.running() if b["trigger"]["source"] == "tick"} & banned)

    def test_night_quiet_is_a_rest_and_no_routine(self):
        sp = self.spatial(random.Random(3))
        self.now = local(23, 30)
        sp._next_tick = self.now
        self.s.update(activity="unknown", idle_s=spatial.QUIET)
        for _ in range(120):
            self.now += 5.0
            sp.poll()
        self.assertEqual([(b["type"], b["trigger"]["event"]) for b in sp.running()], [("sit", "rest")])


if __name__ == "__main__":
    unittest.main()
