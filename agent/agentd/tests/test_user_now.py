import datetime
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation.user_now import UserNow  # noqa: E402
from traces.motion_lane import MotionLane  # noqa: E402

COUNTS = {"key_idle_s": 0, "pointer_idle_s": 0, "keys_10s": 12, "keys_60s": 60}


class UserNowTest(unittest.TestCase):
    def setUp(self):
        self.ts = datetime.datetime(2026, 11, 21, 12).timestamp()
        self.now = UserNow(clock=lambda: self.ts)

    def beat(self, step=0, idle_s=0, **fields):
        self.ts += step
        self.now.coarse({"ts": self.ts, "idle_s": idle_s, **fields})
        return self.now.snapshot()

    def beats(self, seconds, step=1, **fields):
        for _ in range(int(seconds / step)):
            state = self.beat(step, **fields)
        return state

    def tick(self, step):
        self.ts += step
        self.now.tick(self.ts)
        return self.now.snapshot()

    def names(self, prefix=""):
        return [e["name"] for e in self.now.events() if e["name"].startswith(prefix)]

    def returns(self):
        return [e["data"] for e in self.now.events() if e["name"] == "user.return"]

    def test_away_and_one_return_from_the_backdated_start(self):
        start = self.ts
        self.beat()
        for idle in range(1, 183):
            self.assertEqual(self.beat(1, idle_s=idle)["presence"], "present")
        away = self.beat(1, idle_s=183)  # 180 s idle, then the 3 s enter hold
        self.assertEqual(away["presence"], "away")
        self.assertIsInstance(away["absence"]["id"], str)
        self.assertEqual(away["absence"]["since"], start)
        for idle in range(184, 300):
            self.assertEqual(self.beat(1, idle_s=idle)["absence"], away["absence"])
        self.assertEqual(self.beat(1)["presence"], "away")
        back = self.beats(5)  # away leaves after 5 s of input
        self.assertEqual((back["presence"], back["absence"]), ("present", None))
        self.assertEqual(self.returns(), [{"absence_id": away["absence"]["id"], "away_s": self.ts - start}])
        self.beats(10)
        self.assertEqual(len(self.returns()), 1)

    def test_watching_a_meeting_or_a_fullscreen_game_without_input_is_not_away(self):
        for fields in ({"front_video": True}, {"camera_active": True}, {"mic_active": True},
                       {"fullscreen": True, "front_gpu": 0.9}):
            self.setUp()
            self.beats(10, idle_s=0, **fields)
            for second in range(300):
                state = self.beat(1, idle_s=float(second), **fields)
            self.assertEqual(state["presence"], "present", fields)
            self.assertIsNone(state["absence"], fields)
            self.beat(1, idle_s=0, **fields)
            self.assertEqual(self.returns(), [], fields)

    def test_lock_sleep_wake_unlock_is_one_absence(self):
        start = self.ts
        self.beat(idle_s=0)
        locked = self.beat(1, idle_s=1, edge="lock")
        self.assertEqual(locked["presence"], "locked")
        self.assertEqual(locked["absence"]["since"], start)
        asleep = self.beat(1, idle_s=2, edge="sleep")
        self.assertEqual((asleep["presence"], asleep["absence"]), ("asleep", locked["absence"]))
        self.assertEqual(self.tick(600)["presence"], "asleep")  # no beats while asleep: the edge holds
        woke = self.beat(1, idle_s=0, edge="wake")
        self.assertEqual((woke["presence"], woke["absence"]), ("locked", locked["absence"]))
        self.assertEqual(self.beats(3)["presence"], "locked")
        back = self.beat(1, edge="unlock")
        self.assertEqual((back["presence"], back["absence"]), ("present", None))
        self.assertEqual(self.returns(), [{"absence_id": locked["absence"]["id"], "away_s": self.ts - start}])

    def test_ten_second_lock_is_one_short_absence(self):
        self.beat(edge="lock")
        self.beats(9, locked=True)
        self.beat(1, edge="unlock")
        self.assertEqual([r["away_s"] for r in self.returns()], [10])

    def test_a_beat_gap_is_unknown_not_away(self):
        self.beat()
        self.assertEqual(self.tick(5)["presence"], "present")
        gap = self.tick(2)
        self.assertEqual((gap["presence"], gap["absence"], gap["stage"]), ("unknown", None, "normal"))
        self.assertEqual(self.beat(1)["presence"], "present")
        self.assertEqual(self.returns(), [])
        self.assertIn("user.enter.unknown", self.names())

    def test_a_gap_after_a_lock_edge_stays_locked(self):
        self.beat(edge="lock")
        self.assertEqual(self.tick(7)["presence"], "locked")
        self.now = UserNow(clock=lambda: self.ts)
        self.beat(locked=True)  # locked without an edge
        self.assertEqual(self.tick(7)["presence"], "unknown")

    def test_voice_only_meeting_and_sharing(self):
        meeting = self.beat(mic_active=True)
        self.assertEqual((meeting["doing"], meeting["stage"]), ("meeting", "quiet"))
        self.assertEqual(self.beat(1, camera_active=True)["doing"], "meeting")
        shared = self.beat(1, mic_active=True, screen_captured=True)
        self.assertEqual((shared["doing"], shared["stage"]), ("sharing", "offstage"))
        self.assertEqual(self.names("stage."), ["stage.quiet", "stage.offstage"])

    def test_fullscreen_game_by_gpu_beats(self):
        for load in (.6, .1, .6, .1):
            self.assertEqual(self.beat(1, front_gpu=load, fullscreen=True)["doing"], "idle")
        self.beat(1, front_gpu=.6, fullscreen=True)  # 3 busy of the last 5: the enter hold starts
        self.assertEqual(self.beats(2, front_gpu=.6, fullscreen=True)["doing"], "idle")
        game = self.beat(1, front_gpu=.6, fullscreen=True)
        self.assertEqual((game["doing"], game["stage"]), ("gaming", "offstage"))
        self.assertEqual(self.beats(5, front_gpu=.6)["doing"], "gaming")  # not fullscreen: leaves after 5 s
        self.assertEqual(self.beat(1, front_gpu=.6)["doing"], "idle")
        self.assertEqual(self.beats(10, front_gpu=.4, fullscreen=True)["doing"], "idle")

    def test_content_kinds_with_hold(self):
        self.beat()
        for kind in ("reading", "browsing", "game"):
            with self.subTest(kind=kind):
                for _ in range(6):
                    self.now.content(self.ts, kind)
                    state = self.beat(1)
                self.assertEqual(state["doing"], {"game": "gaming"}.get(kind, kind))
                self.assertEqual(state["stage"], "normal")

    def test_typing_needs_key_counts(self):
        state = self.beat()
        self.assertIsNone(state["typing"])
        typing = self.beat(1, input=COUNTS)
        self.assertTrue(typing["typing"])
        self.assertEqual(typing["stage"], "quiet")
        self.assertTrue(self.beat(1, input={**COUNTS, "keys_10s": 2, "key_idle_s": 4})["typing"])
        self.assertFalse(self.beat(1, input={**COUNTS, "keys_10s": 0, "key_idle_s": 5})["typing"])
        self.assertIsNone(self.beat(1)["typing"])

    def test_input_active_uses_idle_seconds(self):
        self.assertTrue(self.beat(idle_s=2)["input_active"])
        self.assertFalse(self.beat(1, idle_s=3)["input_active"])

    def test_focused_needs_switch_counts_and_the_same_activity(self):
        self.assertIsNone(self.beat()["flags"]["focused"])
        calm = {**COUNTS, "keys_10s": 0, "switches_60s": 0}
        self.assertFalse(self.beats(600, step=5, input=calm)["flags"]["focused"])
        focused = self.beat(5, input=calm)  # 600 s after the first calm beat
        self.assertTrue(focused["flags"]["focused"])
        self.assertEqual(focused["stage"], "quiet")
        self.assertTrue(self.beats(60, step=5, input={**calm, "switches_60s": 3})["flags"]["focused"])
        self.assertFalse(self.beat(5, input={**calm, "switches_60s": 3})["flags"]["focused"])
        self.assertIsNone(self.beat(5)["flags"]["focused"])
        self.beats(300, step=5, input=calm)
        self.beat(5, input=calm, camera_active=True)  # another activity starts the 600 s again
        self.assertFalse(self.beats(595, step=5, input=calm, camera_active=True)["flags"]["focused"])
        self.assertTrue(self.beat(5, input=calm, camera_active=True)["flags"]["focused"])

    def test_flags(self):
        state = self.beat(fullscreen=True, front_audio_out=True, user_speaking=True)
        self.assertEqual(state["flags"], {"fullscreen": True, "music": True, "late_night": False,
                                          "user_speaking": True, "focused": None})
        self.assertFalse(self.beat(1, front_audio_out=True, front_video=True)["flags"]["music"])
        self.ts = datetime.datetime(2026, 11, 21, 23, 30).timestamp()
        self.assertTrue(self.beat()["flags"]["late_night"])

    def test_stage_table_first_row_wins(self):
        def fresh():
            self.now = UserNow(clock=lambda: self.ts)
            self.beat()

        def away():
            self.beat(idle_s=200)
            return self.beats(3, idle_s=200)

        def tapped_while_sharing():
            self.beat(screen_captured=True)
            self.now.engage("tap", self.ts)
            return self.now.snapshot()

        def returned_while_typing():
            self.beat(edge="lock")
            return self.beat(1, edge="unlock", input=COUNTS)

        def returned():
            self.beat(edge="lock")
            return self.beat(1, edge="unlock")

        def manual_meeting():
            self.now.set_overrides(meeting_manual=True)
            return self.now.snapshot()

        def dnd():
            self.now.set_overrides(dnd_until=self.ts + 600)
            return self.now.snapshot()

        def engaged(kind):
            self.now.engage(kind, self.ts)
            return self.now.snapshot()

        def sustained(seconds):
            return self.beats(seconds, idle_s=1)

        def content(kind):
            for _ in range(4):
                self.now.content(self.ts, kind)
                state = self.beat(1)
            return state

        rows = [
            ("sharing", lambda: self.beat(screen_captured=True), "offstage"),
            ("tapped while sharing", tapped_while_sharing, "offstage"),
            ("away", away, "offstage"),
            ("locked", lambda: self.beat(1, edge="lock"), "offstage"),
            ("asleep", lambda: self.beat(1, edge="sleep"), "offstage"),
            ("fullscreen video", lambda: self.beats(4, front_video=True, fullscreen=True), "offstage"),
            ("meeting", lambda: self.beat(mic_active=True), "quiet"),
            ("manual meeting", manual_meeting, "quiet"),
            ("dnd", dnd, "quiet"),
            ("typing", lambda: self.beat(1, input=COUNTS), "quiet"),
            ("sustained input without counts", lambda: sustained(60), "quiet"),
            ("short input without counts", lambda: sustained(50), "normal"),
            ("windowed video", lambda: self.beats(4, front_video=True), "quiet"),
            ("returned while typing", returned_while_typing, "quiet"),
            ("returned", returned, "engaged"),
            ("talked", lambda: engaged("talk"), "engaged"),
            ("tapped", lambda: engaged("tap"), "engaged"),
            ("unknown", lambda: self.tick(7), "normal"),
            ("reading", lambda: content("reading"), "normal"),
            ("browsing", lambda: content("browsing"), "normal"),
            ("idle", lambda: self.beat(1), "normal"),
            ("fullscreen work app", lambda: self.beats(4, fullscreen=True), "normal"),
        ]
        for name, steps, stage in rows:
            with self.subTest(row=name):
                fresh()
                self.assertEqual(steps()["stage"], stage)

    def test_engagement_and_return_expire_after_a_minute(self):
        self.beat()
        self.now.engage("talk", self.ts)
        self.assertEqual(self.tick(60)["stage"], "engaged")
        self.assertEqual(self.tick(1)["stage"], "normal")
        self.beat(edge="lock")
        self.assertEqual(self.beat(1, edge="unlock")["stage"], "engaged")
        self.assertEqual(self.beats(60, idle_s=3)["stage"], "engaged")
        self.assertEqual(self.beat(1, idle_s=3)["stage"], "normal")

    def test_manual_meeting_is_an_override_not_a_pause(self):
        self.beat()
        self.now.set_overrides(meeting_manual=True)
        state = self.now.snapshot()
        self.assertEqual((state["doing"], state["stage"], state["paused"]), ("meeting", "quiet", False))
        self.assertTrue(state["overrides"]["meeting_manual"])
        self.assertEqual(self.beat(1, edge="lock")["presence"], "locked")
        self.beat(1, edge="unlock")
        for _ in range(5):  # the content path is paused during a manual meeting
            self.now.content(self.ts, "reading")
            self.beat(1)
        self.now.set_overrides(meeting_manual=False)
        self.assertEqual(self.beat(1)["doing"], "idle")

    def test_dnd_is_quiet_until_it_ends(self):
        self.beat()
        self.now.set_overrides(dnd_until=self.ts + 60)
        state = self.now.snapshot()
        self.assertEqual((state["stage"], state["paused"], state["overrides"]["dnd_until"]),
                         ("quiet", False, self.ts + 60))
        self.assertTrue(self.beat(1, fullscreen=True)["flags"]["fullscreen"])
        self.assertEqual(self.beats(58, idle_s=3)["stage"], "quiet")
        ended = self.beat(1, idle_s=3)
        self.assertEqual((ended["stage"], ended["overrides"]["dnd_until"]), ("normal", None))

    def test_pause_freezes_the_observed_state(self):
        self.beat(mic_active=True)
        self.now.pause(self.ts + 60)
        frozen = dict(self.now.snapshot())
        self.assertTrue(frozen.pop("paused"))
        for state in (self.beat(1, edge="lock", screen_captured=True), self.tick(10)):
            self.assertEqual({k: v for k, v in state.items() if k not in ("paused", "revision")},
                             {k: v for k, v in frozen.items() if k != "revision"})
        self.now.content(self.ts, "reading")
        self.assertEqual(self.now.snapshot()["doing"], "meeting")
        ended = self.tick(50)
        self.assertEqual((ended["paused"], ended["presence"], ended["doing"]), (False, "unknown", "idle"))

    def test_reading_never_judges(self):
        state = self.beat(idle_s=170)
        self.now.engage("tap", self.ts)
        engaged = self.now.snapshot()
        events = self.now.events()
        self.ts += 120
        self.assertEqual(self.now.snapshot(), engaged)
        self.assertEqual(self.now.events(), events)
        self.assertEqual(engaged["revision"], state["revision"] + 1)
        self.assertEqual(self.tick(0)["presence"], "unknown")

    def test_revision_events_and_subscribers(self):
        seen = []

        def subscriber(event):
            free = self.now._lock.acquire(blocking=False)
            if free:
                self.now._lock.release()
            seen.append((event, free))

        self.now.subscribe(subscriber)
        state = self.beat(mic_active=True)
        self.assertEqual(state["revision"], 1)
        self.assertEqual([e for e, _ in seen], self.now.events())
        self.assertTrue(all(free for _, free in seen))
        self.assertEqual([e["name"] for e, _ in seen],
                         ["user.leave.unknown", "user.enter.present", "user.leave.idle", "user.enter.meeting",
                          "stage.quiet"])
        self.assertEqual({e["revision"] for e, _ in seen}, {1})
        self.assertEqual(set(seen[0][0]), {"revision", "ts", "name", "data"})
        self.assertEqual(self.beat(1, mic_active=True)["revision"], 1)
        with self.assertRaises(TypeError):
            state["stage"] = "normal"
        with self.assertRaises(TypeError):
            state["flags"]["fullscreen"] = True

    def test_each_committed_change_is_traced_once_and_the_stage_goes_on_in_its_last_signal_s_trace(self):
        written = []

        def emit(kind, trace_id, causation_id=None, attrs=None):
            written.append({"event_id": f"e{len(written) + 1}", "kind": kind, "trace_id": trace_id,
                            "causation_id": causation_id, "attrs": attrs})
            return written[-1]["event_id"]

        self.now = UserNow(clock=lambda: self.ts, lane=MotionLane(emit))
        self.beat(mic_active=True)
        signals = [(e["attrs"]["source"], e["attrs"]["key"], e["attrs"]["value"], e["attrs"]["revision"])
                   for e in written if e["kind"] == "signal.changed"]
        self.assertEqual(signals, [("coarse", "presence", "present", 1), ("coarse", "doing", "meeting", 1),
                                   ("coarse", "input_active", True, 1)])
        *_, last, stage = written
        self.assertEqual(stage["kind"], "stage.changed")
        self.assertEqual(stage["attrs"], {"from": "normal", "to": "quiet", "revision": 1})
        self.assertEqual((stage["trace_id"], stage["causation_id"]), (last["trace_id"], last["event_id"]))
        self.assertEqual(len({e["trace_id"] for e in written}), 3)  # each signal its own trace
        self.assertEqual({e["causation_id"] for e in written[:3]}, {None})
        self.assertEqual(self.now.lane.newest, (stage["trace_id"], stage["event_id"]))
        self.beat(1, mic_active=True, idle_s=1)  # a new sample, nothing judged differently
        self.assertEqual(len(written), 4)
        self.now.set_overrides(dnd_until=self.ts + 600)
        self.now.content(self.ts, "reading")
        self.now.pause(self.ts + 60)
        self.assertEqual([(e["attrs"]["source"], e["attrs"]["key"], e["attrs"]["value"]) for e in written[4:]],
                         [("override", "dnd", True), ("pause", "paused", True)])

    def test_events_are_a_bounded_ring(self):
        for i in range(40):
            self.beat(1, mic_active=i % 2 == 0)
        self.assertEqual(len(self.now.events(100)), 20)
        self.assertEqual(len(self.now.events(3)), 3)
        self.assertEqual(self.now.events(0), [])
        self.assertEqual(self.now.events()[-1]["revision"], self.now.snapshot()["revision"])

    def test_absence_ids_are_unique_across_restarts(self):
        ids = []
        for _ in range(2):
            self.now = UserNow(clock=lambda: self.ts)
            for _ in range(2):
                ids.append(self.beat(1, edge="lock")["absence"]["id"])
                self.beat(1, edge="unlock")
        self.assertTrue(all(isinstance(i, str) for i in ids))
        self.assertEqual(len(set(ids)), 4)


if __name__ == "__main__":
    unittest.main()
