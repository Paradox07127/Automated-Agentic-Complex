"""The one performance on the user's return from an absence: its row by the time away and the agent work that ended
meanwhile, played as chooser clips through Spatial's admission."""
import datetime
import json
from pathlib import Path
import shutil
import tempfile
import time
import unittest

import support
import test_spatial

from character.returning import Return  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from motion.chooser import MotionChooser  # noqa: E402
from observation import spatial  # noqa: E402
from observation.user_now import UserNow  # noqa: E402
from test_server import EVENTS, HOOK, UI  # noqa: E402

WAVE, CROSSFADE = 2.0, 0.25  # the demo pack's wave clip and its crossfade


def greeting_pack(root):
    """The demo pack with wave mapped to the greet intent and nod to acknowledge, under root."""
    pack = Path(root) / "greeting"
    shutil.copytree(test_spatial.PACK, pack)
    path = pack / "c7" / "animation" / "intent-motion-map.json"
    table = json.loads(path.read_text(encoding="utf-8"))
    table["clips"]["wave"]["intents"] = ["greet"]
    table["clips"]["nod"]["intents"] = ["acknowledge"]
    path.write_text(json.dumps(table), encoding="utf-8")
    return pack


class ReturnCase(test_spatial.SpatialCase):
    """A chooser on a Spatial whose renderer can face; the user leaves and comes back on its clock."""
    pack = None  # the character directory; None: greeting_pack

    def setUp(self):
        super().setUp()
        self.spatial._next_tick = self.now + 10 ** 6  # no random tick
        self.stage, self.greet = "normal", True
        self.spatial.stage = lambda: self.stage
        self.registry.consumed = self.spatial.consumed
        self.registry.on_intent = self.spatial.motion_intent
        self.at = {}  # behavior_id -> clock time the fake renderer got it
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.spatial.use_motion(MotionChooser(self.pack or greeting_pack(tmp.name)))
        self.spatial.set_capabilities("aster", {"face": None})
        self.returning = Return(self.spatial, lambda: self.greet, clock=lambda: self.now)
        self.spatial.consumed.seen = self.returning.ended
        self.run_clock(1)
        self.absences = 0

    def flush(self):
        super().flush()
        for message in self.sent:
            self.at.setdefault(message["behavior_id"], self.now)

    def run_clock(self, seconds):
        """The motion clock's wakes over `seconds`."""
        for _ in range(round(seconds / spatial.MOTION_WAKE)):
            self.now += spatial.MOTION_WAKE
            self.spatial.motion_step()
            self.flush()

    def jump(self, to):
        """The clock jumps to `to`; the fake renderer expires what ran out meanwhile."""
        self.now = to
        for behavior_id, message in list(self.unity.items()):
            if message["expires_at_ms"] <= self.now * 1000:
                self.receipt(behavior_id, "expired")

    def leave(self):
        self.stage = "offstage"
        self.left = self.now
        self.run_clock(1)

    def done(self, run):
        """A role run's done while she is away."""
        self.jump(self.now + 5)
        self.registry.set_role_focus({**test_spatial.role("done"), "run_id": run}, generation=self.generation)
        self.flush()

    def back(self, away_s, stage="engaged"):
        """The user comes back away_s after leaving; returns what the return sent, as (type, clip), from then until
        the clock ran 10 s."""
        self.jump(self.left + away_s)
        self.stage = stage
        self.absences += 1
        mark = len(self.sent)
        self.returning.returned({"revision": 1, "ts": self.now, "name": "user.return",
                                 "data": {"absence_id": f"a-{self.absences}", "away_s": away_s}})
        self.flush()
        self.run_clock(10)
        self.played = [m for m in self.sent[mark:] if m["trigger"]["source"] == "user"]
        return [(m["type"], (m.get("clip") or {}).get("id")) for m in self.played]

    def last(self):
        return self.spatial.diag()["return"]


class RowTest(ReturnCase):
    def test_under_two_minutes_nothing(self):
        self.leave()
        self.assertEqual(self.back(110), [])
        self.assertEqual(self.last(), {"row": None, "away_s": 110, "ended": 0, "played": [], "why": "short"})

    def test_two_to_ten_minutes_without_work_ended_looks_at_the_user_and_welcomes_a_little(self):
        self.leave()
        self.assertEqual(self.back(300), [("face", None), ("perform", "nod")])
        face, nod = self.played
        self.assertEqual((face["facing_yaw"], face["trigger"]["event"]), (0.0, "user_return"))
        self.assertEqual((nod["layer"], nod["priority"]), ("base", spatial.RETURN_PRIORITY))
        self.assertGreater(spatial.RETURN_PRIORITY, 0)  # the chooser's idle tiers send at 0
        self.assertEqual(self.last(), {"row": "look_welcome", "away_s": 300, "ended": 0,
                                       "played": ["face", "welcome"], "why": None})
        self.assertValid()

    def test_two_to_ten_minutes_with_work_ended_looks_at_the_user_and_reports(self):
        self.leave()
        self.done("r1")
        self.assertEqual(self.back(300), [("face", None), ("perform", "point")])
        self.assertEqual(self.last(), {"row": "look_report", "away_s": 300, "ended": 1,
                                       "played": ["face", "report"], "why": None})
        self.assertValid()

    def test_ten_minutes_or_more_without_work_ended_welcomes_fully(self):
        self.leave()
        self.assertEqual(self.back(600), [("perform", "wave")])
        self.assertEqual(self.last()["row"], "welcome")
        self.assertValid()

    def test_ten_minutes_or_more_with_work_ended_welcomes_then_reports_once_the_welcome_played(self):
        self.leave()
        self.done("r1")
        self.assertEqual(self.back(1800), [("perform", "wave"), ("perform", "point")])
        wave, point = self.played
        self.assertGreaterEqual(self.at[point["behavior_id"]] - self.at[wave["behavior_id"]], WAVE - CROSSFADE - 0.01)
        self.assertEqual(point["replaces"], wave["behavior_id"])
        self.assertEqual(self.last(), {"row": "welcome_report", "away_s": 1800, "ended": 1,
                                       "played": ["welcome", "report"], "why": None})
        mark = len(self.sent)
        self.run_clock(30)  # over: her own clips again, idle tiers too
        events = [m["trigger"]["event"] for m in self.sent[mark:] if m["type"] == "perform"]
        self.assertIn("idle.t1", events)
        self.assertValid()

    def test_a_terminal_before_the_absence_is_not_work_ended_meanwhile(self):
        self.jump(self.now + 5)
        self.registry.set_role_focus(test_spatial.role("done"), generation=self.generation)
        self.flush()
        self.run_clock(60)
        self.leave()
        self.assertEqual(self.back(900), [("perform", "wave")])
        self.assertEqual(self.last()["ended"], 0)


class OneWelcomeTest(ReturnCase):
    pack = None  # set in setUp: the greeting pack without the acknowledge intent

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.pack = greeting_pack(self.tmp)
        path = self.pack / "c7" / "animation" / "intent-motion-map.json"
        table = json.loads(path.read_text(encoding="utf-8"))
        table["clips"]["nod"]["intents"] = []
        path.write_text(json.dumps(table), encoding="utf-8")
        super().setUp()

    def test_the_small_welcome_is_the_one_the_pack_has(self):
        self.leave()
        self.assertEqual(self.back(300), [("face", None), ("perform", "wave")])
        self.assertValid()


class NoWelcomeTest(ReturnCase):
    """The plain demo pack maps no greet or acknowledge intent: she only looks at the user."""
    pack = test_spatial.PACK

    def test_a_pack_without_welcome_intents_looks_at_the_user_only(self):
        self.leave()
        self.assertEqual(self.back(300), [("face", None)])
        self.assertEqual((self.last()["played"], self.last()["why"]), (["face"], "no_clip"))


class NoPerformanceTest(ReturnCase):
    def test_quiet_or_offstage_at_the_return_plays_nothing(self):
        for stage in ("quiet", "offstage"):
            with self.subTest(stage=stage):
                self.leave()
                self.assertEqual(self.back(900, stage=stage), [])
                self.assertEqual((self.last()["row"], self.last()["why"]), ("welcome", "stage"))

    def test_greet_on_resume_off_plays_nothing(self):
        self.greet = False
        self.leave()
        self.assertEqual(self.back(300), [])
        self.assertEqual((self.last()["row"], self.last()["why"]), ("look_welcome", "greet_off"))


class EndedTest(ReturnCase):
    def test_a_done_resent_during_the_absence_counts_once(self):
        self.leave()
        self.done("r1")
        self.registry.set_quiet(True)  # the same terminal goes out again
        self.registry.set_quiet(False)
        self.assertEqual(self.back(900), [("perform", "wave"), ("perform", "point")])
        self.assertEqual(self.last()["ended"], 1)

    def test_each_run_that_ended_counts(self):
        self.leave()
        self.done("r1")
        self.done("r2")
        self.back(900)
        self.assertEqual(self.last()["ended"], 2)


class AbsenceTest(ReturnCase):
    def test_a_second_absence_later_performs_again(self):
        for _ in range(2):
            self.leave()
            self.done(f"r{self.absences}")
            self.assertEqual(self.back(900), [("perform", "wave"), ("perform", "point")])
            self.run_clock(60)

    def test_one_absence_of_lock_and_sleep_returns_once(self):
        user = UserNow(clock=lambda: self.now)
        user.subscribe(lambda event: event["name"] == "user.return" and self.returning.returned(event))
        self.spatial.stage = lambda: user.snapshot()["stage"]
        mark = len(self.sent)

        def beat(step, **fields):
            self.now += step
            user.coarse({"ts": self.now, "idle_s": 0, **fields})
            self.flush()

        for _ in range(10):
            beat(1)
        for _ in range(2):
            beat(1, edge="lock")
            beat(300, edge="sleep")
            beat(1200, edge="wake")
            beat(1, edge="unlock")
            for _ in range(10):
                beat(1)
            self.run_clock(10)
        returns = [e for e in user.events() if e["name"] == "user.return"]
        self.assertEqual(len(returns), 2)
        waves = [m for m in self.sent[mark:] if m["trigger"]["source"] == "user"]
        self.assertEqual([(m["type"], m["clip"]["id"]) for m in waves], [("perform", "wave")] * 2)


class ServerCase(unittest.TestCase):
    """agentd with the greeting pack's chooser, the user just back."""

    def setUp(self):
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI, events_token=EVENTS)
        self.thread = support.serve_in_thread(self.server)
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.server.spatial.observe = lambda: test_spatial.situation()
        self.server.spatial.use_motion(MotionChooser(greeting_pack(tmp.name)))
        self.server.spatial.stage = lambda: "engaged"
        self.server.spatial.motion_step()
        self.config = Path(tmp.name) / "config.json"

    def back(self, away_s=900, ts=None):
        self.server.user_event({"revision": 1, "ts": time.time() if ts is None else ts, "name": "user.return",
                                "data": {"absence_id": "a-1", "away_s": away_s}})
        return self.server.spatial.diag()["return"]


class GreetSettingTest(ServerCase):
    def test_the_saved_greet_on_resume_switch_decides(self):
        self.server.privacy_config = str(self.config)
        for saved, off in (({"greet_on_resume": False}, True), ({"greet_on_resume": True}, False), ({}, False)):
            with self.subTest(saved=saved):
                self.config.write_text(json.dumps(saved), encoding="utf-8")
                self.assertEqual(self.back()["why"] == "greet_off", off)

    def test_without_saved_settings_she_greets(self):
        self.assertEqual(self.back()["played"], ["welcome"])

    def test_a_terminal_while_away_picks_the_report_row(self):
        now = time.time()
        self.server.spatial.consumed.take("done-x")
        record = self.back(ts=now + 1)
        # the report follows on the motion clock, which this server does not run
        self.assertEqual((record["row"], record["ended"], record["played"]), ("welcome_report", 1, ["welcome"]))
        self.assertTrue(self.server.returning.welcomed_on(datetime.date.fromtimestamp(now + 1)))


if __name__ == "__main__":
    unittest.main()


class ReviewTest(ReturnCase):
    """Real event orders and chooser states around a return."""

    def wave_ran(self, played):
        """Whether the wave the return sent ran its length before anything replaced it."""
        [wave] = [m for m in played if m.get("clip") == {"id": "wave"}]
        after = [m for m in self.sent if m.get("replaces") == wave["behavior_id"]]
        return not after or self.at[after[0]["behavior_id"]] - self.at[wave["behavior_id"]] >= WAVE - CROSSFADE - 0.01

    def test_the_stage_change_after_the_return_does_not_cut_the_welcome(self):
        self.registry.set_quiet(True)
        self.leave()
        self.jump(self.left + 600)
        self.stage = "engaged"
        mark = len(self.sent)
        self.returning.returned({"revision": 1, "ts": self.now, "name": "user.return",
                                 "data": {"absence_id": "a-1", "away_s": 600}})
        seq = self.registry.intent_seq
        self.registry.set_quiet(False)  # stage.engaged follows user.return in one user_now commit
        self.assertGreater(self.registry.intent_seq, seq)
        self.flush()
        self.run_clock(10)
        self.assertTrue(self.wave_ran(self.sent[mark:]), self.sent[mark:])

    def returned_at(self, away_s):
        self.jump(self.left + away_s)
        self.stage = "engaged"
        self.returning.returned({"revision": 1, "ts": self.now, "name": "user.return",
                                 "data": {"absence_id": "a-1", "away_s": away_s}})
        self.flush()

    def test_the_quiet_stage_mid_return_ends_it_without_the_report(self):
        self.leave()
        self.done("r1")
        mark = len(self.sent)
        self.returned_at(900)
        self.run_clock(0.2)
        self.stage = "quiet"
        self.spatial.stage_event("stage.quiet")
        self.run_clock(10)
        self.assertNotIn({"id": "point"}, [m.get("clip") for m in self.sent[mark:]])

    def test_a_return_while_a_session_loop_blends_in_plays_or_leaves_no_trace(self):
        self.leave()
        self.jump(self.left + 900)
        self.stage = "engaged"
        self.registry.set_role_focus(test_spatial.role("thinking"), generation=self.generation)
        self.run_clock(spatial.MOTION_WAKE)
        mark = len(self.sent)
        self.returning.returned({"revision": 1, "ts": self.now, "name": "user.return",
                                 "data": {"absence_id": "a-1", "away_s": 900}})
        self.run_clock(10)
        waves = [m for m in self.sent[mark:] if m.get("clip") == {"id": "wave"}]
        played = "welcome" in self.last()["played"]
        self.assertEqual([m["trigger"]["source"] for m in waves], ["user"] if played else [])
        self.assertNotEqual(self.spatial.chooser.semantic, "greet")

