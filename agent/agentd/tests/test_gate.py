import contextlib
import datetime
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character.gate import Gate  # noqa: E402
from infra.store import open_store  # noqa: E402

NOON = datetime.datetime(2026, 10, 18, 12, 0, 0)


def at(base=NOON, **delta):
    return base + datetime.timedelta(**delta)


class GateTest(unittest.TestCase):
    def test_companion_follows_proactive_speech_until_set(self):
        g = Gate(enabled=True, quiet=(0, 0))
        self.assertTrue(g.companion)
        self.assertIsNone(g.check("comment", NOON))
        self.assertIsNone(g.check("stuck", NOON))
        self.assertFalse(Gate(enabled=False).companion)
        g.set_companion(False)
        self.assertEqual(g.check("comment", NOON), "companion_off")
        self.assertEqual(g.check("stuck", NOON), "companion_off")
        g.set_muted({"comment"})
        self.assertEqual(g.check("comment", NOON), "companion_off")
        g.enabled = False
        self.assertEqual(g.check("comment", NOON), "disabled")

    def gate(self, **config):
        gate = Gate(**{"enabled": True, **config})
        gate.set_companion(True)
        return gate

    def test_master_switch_is_off_by_default(self):
        self.assertEqual(Gate().admit("gate_fail", "P1", NOON), (False, "disabled"))
        self.assertEqual(self.gate().admit("gate_fail", "P1", NOON), (True, None))

    def test_p0_passes_every_rule(self):
        g = Gate(daily_limit=0)
        g.meeting = g.user_speaking = g.fullscreen = True
        self.assertEqual(g.admit("approval", "P0", NOON), (True, None))
        self.assertEqual(g.admit("approval", "P0", NOON), (True, None))

    def test_quiet_hours_cross_midnight(self):
        g = self.gate()
        late = datetime.datetime(2026, 10, 18, 22, 0)
        early = datetime.datetime(2026, 10, 19, 7, 59)
        self.assertEqual(g.admit("gate_fail", "P1", late), (False, "quiet_hours"))
        self.assertEqual(g.admit("gate_fail", "P1", early), (False, "quiet_hours"))
        self.assertEqual(g.admit("gate_fail", "P1", at(early, minutes=1)), (True, None))

    def test_same_category_cooldown(self):
        g = self.gate()
        self.assertTrue(g.admit("gate_fail", "P1", NOON)[0])
        self.assertEqual(g.admit("gate_fail", "P1", at(seconds=599)), (False, "same_cooldown"))
        self.assertEqual(g.admit("gate_fail", "P1", at(seconds=600)), (True, None))

    def test_cross_category_cooldown(self):
        g = self.gate()
        self.assertTrue(g.admit("gate_fail", "P1", NOON)[0])
        self.assertEqual(g.admit("guard_block", "P1", at(seconds=29)), (False, "cross_cooldown"))
        self.assertEqual(g.admit("guard_block", "P1", at(seconds=30)), (True, None))

    def test_daily_limit_resets_on_a_new_local_day(self):
        g = self.gate(daily_limit=2, cross_cooldown=0)
        self.assertTrue(g.admit("a", "P1", NOON)[0])
        self.assertTrue(g.admit("b", "P1", at(minutes=1))[0])
        self.assertEqual(g.admit("c", "P1", at(minutes=2)), (False, "daily_limit"))
        self.assertEqual(g.admit("c", "P1", at(days=1)), (True, None))

    def test_user_speaking_blocks(self):
        g = self.gate()
        g.user_speaking = True
        self.assertEqual(g.admit("gate_fail", "P1", NOON), (False, "user_speaking"))

    def test_fullscreen_blocks(self):
        g = self.gate()
        g.fullscreen = True
        self.assertEqual(g.admit("gate_fail", "P1", NOON), (False, "fullscreen"))

    def test_meeting_switch_blocks(self):
        g = self.gate()
        g.meeting = True
        self.assertEqual(g.admit("gate_fail", "P1", NOON), (False, "meeting"))

    def test_manual_meeting_mode_blocks_all_but_p0(self):
        g = self.gate()
        g.meeting_manual = True
        self.assertEqual(g.admit("comment", "P2", NOON), (False, "meeting"))
        self.assertEqual(g.admit("gate_fail", "P0", NOON), (True, None))
        g.meeting_manual = False
        self.assertEqual(g.admit("comment", "P2", NOON), (True, None))

    def test_focus_blocks_all_but_p0_and_p1(self):
        g = self.gate(same_cooldown=0, cross_cooldown=0)
        g.focus = True
        self.assertEqual(g.admit("comment", "P2", NOON), (False, "focus"))
        self.assertEqual(g.check("comment", NOON), "focus")
        self.assertEqual(g.check("comment", NOON, level="P1"), None)
        self.assertEqual(g.admit("gate_fail", "P1", NOON), (True, None))
        self.assertEqual(g.admit("gate_fail", "P0", NOON), (True, None))
        g.meeting_manual = True
        self.assertEqual(g.admit("gate_fail", "P1", NOON), (False, "meeting"))

    def test_muted_kind_is_blocked_until_unmuted(self):
        g = self.gate(same_cooldown=0, cross_cooldown=0)
        g.set_muted({"comment"})
        self.assertEqual(g.admit("comment", "P2", NOON), (False, "muted"))
        self.assertEqual(g.check("comment", NOON), "muted")
        self.assertEqual(g.admit("back", "P2", NOON), (True, None))
        self.assertEqual(g.admit("comment", "P1", NOON), (True, None))
        self.assertEqual(g.admit("comment", "P0", NOON), (True, None))
        g.set_muted(set())
        self.assertEqual(g.admit("comment", "P2", NOON), (True, None))

    def test_equal_quiet_hours_mean_none(self):
        g = self.gate(quiet=(9, 9))
        for hour in (0, 9, 23):
            self.assertIsNone(g.check("comment", NOON.replace(hour=hour)))

    def test_report_records_a_decision_without_counting_it(self):
        g, seen = self.gate(), []
        g.on_decision = lambda kind, attrs, key: seen.append((kind, attrs, key))
        g.report("back", "P2", "cannot_interrupt", key="line-1")
        self.assertEqual(seen, [("gate.decided", {"kind": "back", "level": "P2", "speak": False,
                                                  "reason": "cannot_interrupt"}, "line-1")])
        self.assertEqual((g._count, g._blocked, g._last), (0, 0, {}))

    def test_rejected_attempts_do_not_start_cooldowns(self):
        g = self.gate()
        g.fullscreen = True
        g.admit("gate_fail", "P1", NOON)
        g.fullscreen = False
        self.assertEqual(g.admit("gate_fail", "P1", at(seconds=1)), (True, None))

    def test_every_admit_is_reported_as_a_decision(self):
        g, seen = self.gate(), []
        g.on_decision = lambda kind, attrs, key: seen.append((kind, attrs, key))
        g.admit("comment", "P2", NOON, key="line-1")
        g.admit("comment", "P2", at(seconds=1))
        g.admit("approval", "P0", at(seconds=2))
        self.assertEqual(seen[0], ("gate.decided", {"kind": "comment", "level": "P2", "speak": True, "reason": None},
                                   "line-1"))
        self.assertEqual(seen[1][:2], ("gate.decided", {"kind": "comment", "level": "P2", "speak": False,
                                                        "reason": "same_cooldown"}))
        self.assertEqual(seen[2][1]["speak"], True)
        self.assertRegex(seen[1][2], r"^[0-9a-f]{16}$")
        self.assertNotEqual(seen[1][2], seen[2][2])

    def test_check_gives_the_reason_admit_would_without_counting_or_reporting(self):
        g, seen = self.gate(daily_limit=2), []
        g.on_decision = lambda *args: seen.append(args)
        cases = (({"enabled": False}, None, "disabled"), ({"meeting": True}, None, "meeting"),
                 ({"user_speaking": True}, None, "user_speaking"), ({"fullscreen": True}, None, "fullscreen"),
                 ({}, datetime.datetime(2026, 10, 18, 23, 0), "quiet_hours"), ({}, None, None))
        for flags, now, reason in cases:
            with self.subTest(flags=flags, now=now):
                g.enabled, g.meeting, g.user_speaking, g.fullscreen = True, False, False, False
                for name, value in flags.items():
                    setattr(g, name, value)
                self.assertEqual(g.check("comment", now or NOON), reason)
        self.assertEqual((seen, g._count, g._last, g._last_any), ([], 0, {}, None))
        self.assertEqual(g.admit("comment", "P2", NOON), (True, None))
        self.assertEqual(g.check("comment", at(seconds=1)), "same_cooldown")
        self.assertEqual(g.check("other", at(seconds=1)), "cross_cooldown")
        self.assertEqual(g.admit("other", "P2", at(seconds=30)), (True, None))
        self.assertEqual((g.check("third", at(minutes=1)), g.admit("third", "P2", at(minutes=1))),
                         ("daily_limit", (False, "daily_limit")))
        self.assertEqual((len(seen), g._count), (3, 2))

    def test_a_failing_decision_callback_changes_nothing(self):
        g = self.gate()
        g.on_decision = lambda *_: 1 / 0
        self.assertEqual(g.admit("gate_fail", "P1", NOON), (True, None))
        self.assertEqual(g.admit("gate_fail", "P1", at(seconds=1)), (False, "same_cooldown"))

    def test_state_scale_only_lengthens_the_comment_cooldown(self):
        scale = [1.5]
        g = self.gate(state_scale=lambda: scale[0], cross_cooldown=0)
        g.scale["comment"] = 2  # three unanswered lines
        self.assertTrue(g.admit("comment", "P2", NOON)[0])
        self.assertEqual(g.check("comment", at(seconds=1799)), "same_cooldown")
        self.assertIsNone(g.check("comment", at(seconds=1800)))
        scale[0] = 0.5  # below 1 counts as 1
        self.assertEqual(g.check("comment", at(seconds=1199)), "same_cooldown")
        self.assertIsNone(g.check("comment", at(seconds=1200)))
        scale[0] = 1.5  # other categories and the other rules keep their own numbers
        self.assertTrue(g.admit("gate_fail", "P1", NOON)[0])
        self.assertEqual(g.check("gate_fail", at(seconds=599)), "same_cooldown")
        self.assertIsNone(g.check("gate_fail", at(seconds=600)))
        g2 = self.gate(state_scale=lambda: 1.5)
        self.assertTrue(g2.admit("comment", "P2", NOON)[0])
        self.assertEqual(g2.check("other", at(seconds=29)), "cross_cooldown")
        self.assertIsNone(g2.check("other", at(seconds=30)))


class GateDayStoreTest(unittest.TestCase):
    """The day's count and refusals are a spent budget: they outlive a restart, the cooldowns do not."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "agentd.sqlite"

    def gate(self):
        db = open_store(self.path)
        self.addCleanup(db.close)
        return Gate(enabled=True, db=db)

    def days(self):
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            return [row[0] for row in db.execute("SELECT day FROM gate_day ORDER BY day")]

    def test_today_count_and_refusals_survive_a_restart(self):
        now = datetime.datetime.now()
        g = self.gate()
        for _ in range(3):
            g.commit("comment", now)
        g.meeting = True
        g.set_companion(True)
        self.assertEqual(g.admit("comment", "P2", now), (False, "meeting"))
        again = self.gate()
        self.assertEqual((again._day, again._count, again._blocked), (now.date(), 3, 1))
        self.assertEqual((again._last, again._last_any), ({}, None))
        again.commit("comment", at(now, days=1))
        self.assertEqual((again._count, again._blocked), (1, 0))

    def test_a_count_from_another_day_starts_over(self):
        self.gate().commit("comment", at(datetime.datetime.now(), days=-1))
        again = self.gate()
        self.assertEqual((again._day, again._count, again._blocked), (None, 0, 0))

    def test_mutes_survive_a_restart(self):
        self.gate().set_muted({"comment", "stuck"})
        again = self.gate()
        self.assertEqual(again.muted, {"comment", "stuck"})
        again.set_muted({"stuck"})
        self.assertEqual(self.gate().muted, {"stuck"})

    def test_companion_persistence_round_trip(self):
        g = self.gate()
        self.assertTrue(g.companion)  # no stored choice: on with proactive speech
        g.set_companion(False)
        again = self.gate()
        self.assertFalse(again.companion)
        self.assertEqual(again.check("comment", NOON), "companion_off")
        again.set_companion(True)
        self.assertTrue(self.gate().companion)
        self.assertTrue(g.companion)

    def test_quiet_hours_are_stored_and_read_live(self):
        g, other = self.gate(), self.gate()
        self.assertEqual(g.quiet, (22, 8))
        self.assertEqual(other.check("comment", NOON.replace(hour=22)), "quiet_hours")
        g.set_quiet(23, 7)
        self.assertEqual(other.quiet, (23, 7))
        self.assertIsNone(other.check("comment", NOON.replace(hour=22)))
        self.assertEqual(other.check("comment", NOON.replace(hour=6)), "quiet_hours")
        self.assertIsNone(other.check("comment", NOON.replace(hour=7)))
        g.set_quiet(0, 0)
        self.assertIsNone(self.gate().check("comment", NOON.replace(hour=23)))

    def test_only_the_last_seven_days_are_kept(self):
        g, now = self.gate(), datetime.datetime.now()
        for back in range(9, -1, -1):
            g.commit("comment", at(now, days=-back))
        self.assertEqual(self.days(), [at(now, days=-back).date().isoformat() for back in range(6, -1, -1)])


if __name__ == "__main__":
    unittest.main()
