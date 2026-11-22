import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import c1  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[3] / "protocol" / "C1-agent-events" / "fixtures"

HOLD = {"event": "behavior", "seq": 7, "behavior_id": "b-e1-1", "type": "hold_window_edge",
        "target": {"kind": "window", "window_id": 4242, "side": "left"},
        "trigger": {"source": "tick", "event": None}, "display_session": None, "turn_id": None,
        "turn_generation": 3, "priority": 0, "expires_at_ms": 1760900600000, "intensity": 0.6,
        "channels": ["full_body", "left_hand", "contact"], "exit": ["target_gone", "user_drag"],
        "replaces": None, "trace_id": "t-1"}
REACTION = {"event": "session_reaction", "seq": 8, "display_session": "claude:B", "state": "error",
            "turn_generation": 3}


class FixtureTest(unittest.TestCase):
    def test_every_shared_fixture_is_valid(self):
        files = sorted(FIXTURES.glob("*.json"))
        self.assertGreaterEqual(len(files), 8)
        for path in files:
            with self.subTest(path.name):
                self.assertEqual(c1.check_file(json.loads(path.read_text(encoding="utf-8"))), [])


class MessageTest(unittest.TestCase):
    def broken(self, change, message=HOLD):
        bad = copy.deepcopy(message)
        change(bad)
        return c1.check_message(bad)

    def test_a_valid_behavior_passes(self):
        self.assertEqual(c1.check_message(HOLD), [])

    def test_unknown_type_channel_exit_and_priority_fail(self):
        self.assertTrue(self.broken(lambda m: m.update(type="dance")))
        self.assertTrue(self.broken(lambda m: m.update(channels=["tail"])))
        self.assertTrue(self.broken(lambda m: m.update(channels=[])))
        self.assertTrue(self.broken(lambda m: m.update(exit=["sunset"])))
        self.assertTrue(self.broken(lambda m: m.update(priority=4)))
        self.assertTrue(self.broken(lambda m: m.update(intensity=1.5)))
        self.assertTrue(self.broken(lambda m: m["trigger"].update(source="radio")))

    def test_target_must_fit_the_type(self):
        self.assertTrue(self.broken(lambda m: m.update(target=None)))
        self.assertTrue(self.broken(lambda m: m["target"].update(side="up")))
        self.assertTrue(self.broken(lambda m: m.update(target={"kind": "session", "display_session": "claude:A"})))
        attend = {**HOLD, "type": "attend_session",
                  "target": {"kind": "session", "display_session": "claude:A", "window_id": 77},
                  "display_session": "claude:A", "channels": ["eyes", "head"]}
        self.assertEqual(c1.check_message(attend), [])
        self.assertEqual(c1.check_message({**attend, "target": {**attend["target"], "window_id": None}}), [])
        self.assertTrue(self.broken(lambda m: m.update(display_session=None), attend))
        self.assertTrue(self.broken(lambda m: m["target"].pop("window_id"), attend))  # where to look
        self.assertTrue(self.broken(lambda m: m["target"].update(window_id="77"), attend))
        sit = {**HOLD, "type": "sit", "target": None, "channels": ["full_body", "contact"]}
        self.assertEqual(c1.check_message(sit), [])  # on the screen bottom edge

    def test_a_short_walk_may_go_toward_a_window(self):
        walk = {**HOLD, "type": "short_walk", "target": {"kind": "window", "window_id": 202, "side": None},
                "trigger": {"source": "user", "event": "focus_change"}, "channels": ["full_body"],
                "exit": ["user_typing", "user_drag"]}
        self.assertEqual(c1.check_message(walk), [])
        self.assertTrue(self.broken(lambda m: m["target"].pop("window_id"), walk))
        self.assertTrue(self.broken(lambda m: m.update(target={"kind": "session", "display_session": "claude:A",
                                                               "window_id": 202}), walk))

    def test_sit_variant_must_be_known(self):
        sit = {**HOLD, "type": "sit", "target": None, "channels": ["full_body", "contact"]}
        for variant in ("still", "read", "tea", "ground", None):
            with self.subTest(variant):
                self.assertEqual(c1.check_message({**sit, "variant": variant}), [])
        self.assertTrue(self.broken(lambda m: m.update(variant="dance"), sit))
        self.assertTrue(self.broken(lambda m: m.update(variant=""), sit))
        self.assertTrue(self.broken(lambda m: m.update(variant="read")))  # a hold has no variant

    def test_sit_takes_an_object_target(self):
        sit = {**HOLD, "type": "sit", "target": {"kind": "object", "object_id": "stool_a"},
               "channels": ["full_body", "contact"], "variant": "tea"}
        self.assertEqual(c1.check_message(sit), [])
        self.assertEqual(self.broken(lambda m: m["target"].update(object_id=None), sit), [])  # the renderer picks the object
        self.assertTrue(self.broken(lambda m: m["target"].pop("object_id"), sit))
        self.assertTrue(self.broken(lambda m: m["target"].update(object_id=7), sit))
        self.assertTrue(self.broken(lambda m: m.update(type="observe", variant=None, channels=["eyes", "head"]), sit))

    def test_typing_lowers_activity(self):
        typing = {**HOLD, "type": "accompany", "target": None, "trigger": {"source": "user", "event": "typing"},
                  "intensity": 0.3, "channels": ["eyes", "head"], "exit": ["user_typing"]}
        self.assertEqual(c1.check_message(typing), [])
        self.assertTrue(self.broken(lambda m: m.update(intensity=0.5), typing))
        self.assertTrue(self.broken(lambda m: m.update(type="short_walk", target=None), typing))

    def test_receipts_cancels_and_clause_intents(self):
        receipt = {"event": "receipt", "behavior_id": "b-e1-1", "phase": "blocked", "reason": "target_gone",
                   "at_ms": 1760900000500, "turn_generation": 3}
        self.assertEqual(c1.check_message(receipt), [])
        self.assertTrue(self.broken(lambda m: m.update(phase="done"), receipt))
        self.assertTrue(self.broken(lambda m: m.update(reason="tired"), receipt))
        cancel = {"event": "behavior_cancel", "seq": 9, "behavior_id": "b-e1-1", "reason": "switch_off",
                  "turn_generation": 3}
        self.assertEqual(c1.check_message(cancel), [])
        self.assertTrue(self.broken(lambda m: m.update(reason="bored"), cancel))
        clause = {"event": "clause_intent", "seq": 10, "line_id": "l1", "utterance_id": "u1", "clause_id": "c1",
                  "spoken_text_revision": 1, "intent": "explain", "turn_generation": 3, "trace_id": "t-2"}
        self.assertEqual(c1.check_message(clause), [])
        self.assertTrue(self.broken(lambda m: m.update(intent="wave"), clause))
        self.assertTrue(self.broken(lambda m: m.update(utterance_id=None), clause))  # clause_id without utterance
        # The renderer matches (utterance_id, clause_id, spoken_text_revision): a rewrite keeps the clause_ids.
        self.assertTrue(self.broken(lambda m: m.pop("spoken_text_revision"), clause))
        self.assertTrue(self.broken(lambda m: m.update(spoken_text_revision=0), clause))
        self.assertTrue(self.broken(lambda m: m.update(spoken_text_revision=None), clause))
        text_only = {**clause, "utterance_id": None, "clause_id": None, "spoken_text_revision": None}
        self.assertEqual(c1.check_message(text_only), [])
        self.assertTrue(self.broken(lambda m: m.update(spoken_text_revision=1), text_only))

    def test_a_text_line_starts_and_ends_with_a_hold(self):
        started = {"event": "text_line", "seq": 11, "line_id": "l1", "turn_generation": 3, "trace_id": "t-2",
                   "state": "started"}
        ended = {**started, "seq": 12, "state": "ended", "hold_ms": 840}
        self.assertEqual(c1.check_message(started), [])
        self.assertEqual(c1.check_message(ended), [])
        self.assertEqual(c1.check_message({**ended, "hold_ms": 0}), [])
        self.assertTrue(self.broken(lambda m: m.pop("state"), started))
        self.assertTrue(self.broken(lambda m: m.update(state="paused"), started))
        self.assertTrue(self.broken(lambda m: m.update(hold_ms=840), started))  # only ended holds
        self.assertTrue(self.broken(lambda m: m.pop("hold_ms"), ended))
        self.assertTrue(self.broken(lambda m: m.update(hold_ms=3001), ended))
        self.assertTrue(self.broken(lambda m: m.update(hold_ms=-1), ended))
        self.assertTrue(self.broken(lambda m: m.pop("line_id"), started))
        self.assertTrue(self.broken(lambda m: m.pop("turn_generation"), started))

    def test_a_session_reaction_names_a_session_and_its_ending(self):
        self.assertEqual(c1.check_message(REACTION), [])
        self.assertEqual(c1.check_message({**REACTION, "state": "done"}), [])
        self.assertTrue(self.broken(lambda m: m.update(state="awaiting_approval"), REACTION))
        self.assertTrue(self.broken(lambda m: m.update(display_session=None), REACTION))
        self.assertTrue(self.broken(lambda m: m.pop("turn_generation"), REACTION))
        self.assertTrue(self.broken(lambda m: m.pop("seq"), REACTION))

    def test_a_character_switch_cancels_a_behavior(self):
        cancel = {"event": "behavior_cancel", "seq": 9, "behavior_id": "b-e1-1", "reason": "character_switch",
                  "turn_generation": 4}
        self.assertEqual(c1.check_message(cancel), [])
        self.assertEqual(c1.check_file({"description": "x", "messages": [HOLD, cancel]}), [])
        self.assertTrue(self.broken(lambda m: m.update(reason="character_change"), cancel))

    def test_snapshot_carries_every_running_behavior(self):
        listen = {**HOLD, "seq": 8, "behavior_id": "b-e1-2", "type": "listen", "target": {"kind": "user"},
                  "priority": 2, "channels": ["eyes", "head", "mouth"], "exit": ["speech_end"]}
        snapshot = {"event": "snapshot", "seq": 12, "turn_generation": 3, "behaviors": [HOLD, listen]}
        self.assertEqual(c1.check_message(snapshot), [])
        self.assertEqual(c1.check_message({**snapshot, "behaviors": []}), [])
        self.assertTrue(self.broken(lambda m: m.pop("behaviors"), snapshot))
        self.assertTrue(self.broken(lambda m: m.update(behaviors=None), snapshot))
        self.assertTrue(self.broken(lambda m: m["behaviors"][1].update(type="dance"), snapshot))
        self.assertTrue(self.broken(lambda m: m.update(behavior=HOLD, behaviors=[]), snapshot))  # the old field

    def test_a_snapshot_never_resumes_an_ended_behavior(self):
        lost = {"event": "receipt", "behavior_id": "b-e1-1", "phase": "cancelled", "reason": "connection_lost",
                "at_ms": 1760900000500, "turn_generation": 3}
        running = {**lost, "phase": "running", "reason": None}
        snapshot = {"event": "snapshot", "seq": 12, "turn_generation": 3, "behaviors": [HOLD]}
        self.assertTrue(c1.check_file({"description": "x", "messages": [HOLD, running, lost, snapshot]}))
        renewed = {**snapshot, "behaviors": [{**HOLD, "behavior_id": "b-e1-2", "seq": 11}]}
        self.assertEqual(c1.check_file({"description": "x", "messages": [HOLD, running, lost, renewed]}), [])

    def test_lost_connection_is_its_own_cancel_reason(self):
        lost = {"event": "receipt", "behavior_id": "b-e1-1", "phase": "cancelled", "reason": "connection_lost",
                "at_ms": 1760900000500, "turn_generation": 3}
        self.assertEqual(c1.check_message(lost), [])
        self.assertTrue(self.broken(lambda m: m.update(reason="connection_lost", phase="completed"), lost))

    def test_a_user_play_ends_a_behavior_as_cancelled_only(self):
        played = {"event": "receipt", "behavior_id": "b-e1-1", "phase": "cancelled", "reason": "user_play",
                  "at_ms": 1760900000500, "turn_generation": 3}
        self.assertEqual(c1.check_message(played), [])
        for phase in ("completed", "expired", "rejected"):
            with self.subTest(phase):
                self.assertTrue(self.broken(lambda m: m.update(phase=phase), played))

    def test_switches_are_the_full_object_of_booleans(self):
        good = {"stay_in_place": False, "sit_window_top": True, "hold_window_edge": True,
                "fullscreen_give_way": True}
        self.assertEqual(c1.check_switches(good), [])
        self.assertEqual(c1.check_switches({**good, "bust_framing": True}), [])
        for bad in ({k: v for k, v in good.items() if k != "sit_window_top"}, {**good, "fly": True},
                    {**good, "stay_in_place": 1}, {**good, "bust_framing": "yes"}, [], None):
            with self.subTest(bad=bad):
                self.assertTrue(c1.check_switches(bad))

    def test_a_running_behavior_is_renewed_not_resent(self):
        sit = {**HOLD, "type": "sit", "target": None, "channels": ["full_body", "contact"]}
        again = {**sit, "seq": 8, "behavior_id": "b-e1-2"}
        self.assertTrue(c1.check_file({"description": "x", "messages": [sit, again]}))
        renewal = {**again, "replaces": "b-e1-1"}
        self.assertEqual(c1.check_file({"description": "x", "messages": [sit, renewal]}), [])
        ended = {"event": "receipt", "behavior_id": "b-e1-1", "phase": "completed", "reason": None,
                 "at_ms": 1760900000500, "turn_generation": 3}
        prepared = {**ended, "phase": "prepared"}
        self.assertEqual(c1.check_file({"description": "x", "messages": [sit, prepared, ended, again]}), [])

    def test_receipts_start_prepared_running_or_rejected_and_stop_at_a_terminal_phase(self):
        def receipt(phase, reason=None):
            return {"event": "receipt", "behavior_id": "b-e1-1", "phase": phase, "reason": reason,
                    "at_ms": 1760900000500, "turn_generation": 3}
        good = [HOLD, receipt("prepared"), receipt("running"), receipt("completed")]
        self.assertEqual(c1.check_file({"description": "x", "messages": good}), [])
        # A target already in place starts running in the same frame.
        self.assertEqual(c1.check_file({"description": "x", "messages": [HOLD, receipt("running")]}), [])
        self.assertTrue(c1.check_file({"description": "x", "messages": [HOLD, receipt("completed")]}))
        self.assertTrue(c1.check_file({"description": "x", "messages": good + [receipt("cancelled")]}))
        rejected = [HOLD, receipt("rejected", "busy")]
        self.assertEqual(c1.check_file({"description": "x", "messages": rejected}), [])

    def test_one_clause_intent_per_clause_and_revision(self):
        clause = {"event": "clause_intent", "seq": 1, "line_id": "l1", "utterance_id": "u1", "clause_id": "c1",
                  "spoken_text_revision": 1, "intent": "explain", "turn_generation": 3, "trace_id": "t-2"}
        twice = [clause, {**clause, "seq": 2, "intent": "greet"}]
        self.assertTrue(c1.check_file({"description": "x", "messages": twice}))
        rewritten = [clause, {**clause, "seq": 2, "spoken_text_revision": 2}]
        self.assertEqual(c1.check_file({"description": "x", "messages": rewritten}), [])

    def file(self, *messages):
        return c1.check_file({"description": "x", "messages": list(messages)})

    @staticmethod
    def receipt(phase, at_ms, reason=None, behavior_id="b-e1-1", gen=3):
        return {"event": "receipt", "behavior_id": behavior_id, "phase": phase, "reason": reason, "at_ms": at_ms,
                "turn_generation": gen}

    def test_receipts_follow_expires_at(self):
        end = HOLD["expires_at_ms"]
        self.assertEqual(self.file(HOLD, self.receipt("running", end - 50), self.receipt("expired", end)), [])
        self.assertTrue(self.file(HOLD, self.receipt("running", end - 50), self.receipt("expired", end - 1)))
        self.assertTrue(self.file(HOLD, self.receipt("running", end - 50), self.receipt("completed", end + 1)))

    def test_a_renewal_starts_running(self):
        sit = {**HOLD, "type": "sit", "target": None, "channels": ["full_body", "contact"]}
        renewal = {**sit, "seq": 8, "behavior_id": "b-e1-2", "replaces": "b-e1-1"}
        at = HOLD["expires_at_ms"] - 1000
        good = [sit, self.receipt("running", at - 5000), renewal, self.receipt("running", at, behavior_id="b-e1-2")]
        self.assertEqual(self.file(*good), [])
        prepared = good[:3] + [self.receipt("prepared", at, behavior_id="b-e1-2")]
        self.assertTrue(self.file(*prepared))

    def test_a_session_without_a_window_is_blocked(self):
        attend = {**HOLD, "type": "attend_session",
                  "target": {"kind": "session", "display_session": "claude:A", "window_id": None},
                  "display_session": "claude:A", "channels": ["eyes", "head"]}
        at = HOLD["expires_at_ms"] - 1000
        blocked = [attend, self.receipt("prepared", at - 10), self.receipt("blocked", at, "target_gone")]
        self.assertEqual(self.file(*blocked), [])
        self.assertTrue(self.file(attend, self.receipt("prepared", at - 10), self.receipt("running", at)))

    def test_a_receipt_carries_its_behaviors_turn_generation(self):
        at = HOLD["expires_at_ms"] - 1000
        self.assertTrue(self.file(HOLD, self.receipt("rejected", at, "stale", gen=4)))

    def test_a_displaced_behavior_is_announced(self):
        idle = {**HOLD, "seq": 8, "behavior_id": "b-e1-2", "type": "idle", "target": None,
                "channels": ["full_body"], "priority": 3}
        self.assertTrue(self.file(HOLD, idle))  # full_body overlaps: the hold would stay in every array
        self.assertEqual(self.file(HOLD, {**idle, "replaces": "b-e1-1"}), [])
        cancel = {"event": "behavior_cancel", "seq": 8, "behavior_id": "b-e1-1", "reason": "replaced",
                  "turn_generation": 3}
        self.assertEqual(self.file(HOLD, cancel, {**idle, "seq": 9}), [])
        listen = {**idle, "type": "listen", "target": {"kind": "user"}, "channels": ["eyes", "head", "mouth"]}
        self.assertEqual(self.file(HOLD, listen), [])  # no overlap: both run

    def test_an_exit_cancel_names_a_condition_agentd_judges(self):
        cancel = {"event": "behavior_cancel", "seq": 9, "behavior_id": "b-e1-1", "reason": "exit",
                  "condition": "speech_end", "turn_generation": 3}
        self.assertEqual(c1.check_message(cancel), [])
        for condition in ("speech_start", "session_state", "focus_change", "user_typing"):
            self.assertEqual(c1.check_message({**cancel, "condition": condition}), [])
        self.assertTrue(self.broken(lambda m: m.pop("condition"), cancel))
        self.assertTrue(self.broken(lambda m: m.update(condition=None), cancel))
        self.assertTrue(self.broken(lambda m: m.update(condition="user_drag"), cancel))  # the renderer judges it
        self.assertTrue(self.broken(lambda m: m.update(condition="target_gone"), cancel))
        self.assertTrue(self.broken(lambda m: m.update(reason="replaced"), cancel))  # condition only with exit
        replaced = {k: v for k, v in cancel.items() if k != "condition"}
        self.assertEqual(c1.check_message({**replaced, "reason": "replaced"}), [])

    def test_an_exit_cancel_fits_the_behaviors_exit_and_the_receipt_table(self):
        listen = {**HOLD, "type": "listen", "target": {"kind": "user"}, "priority": 2, "channels": ["eyes", "head"],
                  "exit": ["speech_end"]}
        walk = {**HOLD, "type": "short_walk", "target": None, "channels": ["full_body"],
                "exit": ["user_typing", "user_drag"]}
        at = HOLD["expires_at_ms"] - 1000
        running = self.receipt("running", at - 10)
        ended = {"event": "behavior_cancel", "seq": 8, "behavior_id": "b-e1-1", "reason": "exit",
                 "condition": "speech_end", "turn_generation": 3}
        typed = {**ended, "condition": "user_typing"}
        self.assertEqual(self.file(listen, running, ended, self.receipt("completed", at)), [])
        self.assertEqual(self.file(walk, running, typed, self.receipt("cancelled", at)), [])
        self.assertTrue(self.file(listen, running, {**ended, "condition": "focus_change"}))  # not in its exit
        self.assertTrue(self.file(walk, running, ended))
        self.assertTrue(self.file(listen, running, ended, self.receipt("cancelled", at)))  # speech_end completes
        self.assertTrue(self.file(walk, running, typed, self.receipt("completed", at)))  # user_typing interrupts
        switched = {**ended, "reason": "switch_off"}
        switched.pop("condition")
        self.assertEqual(self.file(walk, running, switched, self.receipt("cancelled", at)), [])

    def test_a_file_checks_order_and_references(self):
        receipt = {"event": "receipt", "behavior_id": "b-e1-9", "phase": "running", "reason": None,
                   "at_ms": 1760900000500, "turn_generation": 3}
        self.assertTrue(c1.check_file({"description": "x", "messages": [HOLD, receipt]}))  # unknown behavior_id
        later = {**HOLD, "behavior_id": "b-e1-2", "seq": 7}
        self.assertTrue(c1.check_file({"description": "x", "messages": [HOLD, later]}))  # seq not increasing


class PerformActionTest(unittest.TestCase):
    """C1 v2.6: a perform plays a generated motion or one of the character's game actions, never both."""
    ACTION = {"event": "behavior", "seq": 4, "behavior_id": "b-ga-0123456789abcdef", "type": "perform", "target": None,
              "trigger": {"source": "agent", "event": None}, "display_session": None, "turn_id": None,
              "turn_generation": 2, "priority": 1, "expires_at_ms": 1760900010000, "intensity": 1.0,
              "channels": ["full_body"], "exit": [], "replaces": None, "trace_id": "t-1",
              "action": {"id": "dialog_single_wave1", "length_s": 2.4}}
    MOTION = {"id": "gm-0123456789abcdef", "meta_sha256": "a" * 64, "keys_sha256": "b" * 64, "rig_sha256": "c" * 64,
              "length_s": 3.0}

    def broken(self, change):
        bad = copy.deepcopy(self.ACTION)
        change(bad)
        return c1.check_message(bad)

    def test_the_v2_6_fixture_passes_and_its_invalid_sample_fails(self):
        self.assertEqual(c1.check_file(json.loads((FIXTURES / "14b-perform-action.json").read_text(encoding="utf-8"))), [])
        self.assertTrue(c1.check_file(json.loads((FIXTURES / "invalid" / "14b-perform-motion-and-action.json")
                                                 .read_text(encoding="utf-8"))))

    def test_an_action_perform_passes(self):
        self.assertEqual(c1.check_message(self.ACTION), [])

    def test_motion_and_action_together_or_neither_fail(self):
        self.assertTrue(self.broken(lambda m: m.update(motion=self.MOTION)))
        self.assertTrue(self.broken(lambda m: m.pop("action")))

    def test_the_action_object_follows_the_contract(self):
        for action in (None, "dialog_single_wave1", {"id": "", "length_s": 2.4}, {"id": 5, "length_s": 2.4},
                       {"id": "a" * 65, "length_s": 2.4}, {"length_s": 2.4}, {"id": "wave"},
                       {"id": "wave", "length_s": 0.1}, {"id": "wave", "length_s": 10.5},
                       {"id": "wave", "length_s": True}):
            with self.subTest(action=action):
                self.assertTrue(self.broken(lambda m: m.update(action=action)))
        self.assertTrue(c1.check_message({**self.ACTION, "type": "think"}))  # action is only valid on perform


class PlayerPrimitivesTest(unittest.TestCase):
    """C1 v2.7: agentd picks every clip; the renderer plays it on a layer, starts it at a boundary and reports back."""
    LOOP = {**{k: v for k, v in PerformActionTest.ACTION.items() if k != "action"}, "behavior_id": "b-e7-1",
            "clip": {"id": "idle_stand_a"}, "layer": "base", "start": "now", "blend_s": 0.4, "loop": True, "ttl_s": 30}
    WAVE = {**{k: v for k, v in LOOP.items() if k != "loop"}, "seq": 5, "behavior_id": "b-e7-2",
            "clip": {"id": "react_wave"}, "layer": "overlay", "channels": ["head", "left_hand", "right_hand"]}
    SNAPSHOT = {"event": "snapshot", "seq": 1, "turn_generation": 2, "behaviors": [],
                "reactions": {"click": [{"clip": "react_click_a", "weight": 2, "layer": "overlay"},
                                        {"clip": "react_click_b", "weight": 0.5, "layer": "base"}]},
                "stage": {"level": "quiet", "revision": 4}, "consumed": ["occ-1", "occ-2"]}

    def broken(self, change, message=None):
        bad = copy.deepcopy(self.LOOP if message is None else message)
        change(bad)
        return c1.check_message(bad)

    def test_a_clip_perform_with_every_play_field_passes(self):
        self.assertEqual(c1.check_message(self.LOOP), [])
        self.assertEqual(c1.check_message(self.WAVE), [])
        bare = {k: v for k, v in self.LOOP.items() if k not in ("layer", "start", "blend_s", "loop", "ttl_s")}
        self.assertEqual(c1.check_message(bare), [])  # base, now, no loop
        for start in ("now", "sync", "cycle_end", "after_exit"):
            self.assertEqual(c1.check_message({**self.LOOP, "start": start}), [], start)
        self.assertEqual(c1.check_message({**self.LOOP, "blend_s": 0}), [])
        self.assertEqual(c1.check_message({**self.LOOP, "blend_s": 2, "ttl_s": 0.5}), [])
        self.assertEqual(c1.check_message({**self.LOOP, "ttl_s": 120, "loop": False}), [])

    def test_the_clip_names_one_clip(self):
        for clip in (None, "idle_stand_a", {}, {"id": ""}, {"id": 3}, {"id": "a" * 65}):
            with self.subTest(clip=clip):
                self.assertTrue(self.broken(lambda m: m.update(clip=clip)))
        self.assertEqual(self.broken(lambda m: m.update(clip={"id": "a" * 64})), [])

    def test_a_perform_carries_exactly_one_payload(self):
        self.assertTrue(self.broken(lambda m: m.update(action={"id": "wave", "length_s": 2.4})))
        self.assertTrue(self.broken(lambda m: m.update(motion=PerformActionTest.MOTION)))
        self.assertTrue(self.broken(lambda m: m.pop("clip")))
        self.assertTrue(c1.check_message({**self.LOOP, "type": "idle", "layer": None}))

    def test_the_play_fields_follow_the_contract(self):
        for change in ({"layer": "top"}, {"layer": None}, {"start": "later"}, {"start": None}, {"blend_s": -0.1},
                       {"blend_s": 2.5}, {"blend_s": True}, {"blend_s": "1"}, {"loop": 1}, {"loop": None},
                       {"ttl_s": 0.4}, {"ttl_s": 121}, {"ttl_s": False}, {"ttl_s": None}):
            with self.subTest(change=change):
                self.assertTrue(self.broken(lambda m: m.update(change)))

    def test_only_a_base_perform_loops(self):
        self.assertTrue(self.broken(lambda m: m.update(loop=True), self.WAVE))
        self.assertTrue(self.broken(lambda m: m.update(loop=False), self.WAVE))

    def test_each_layer_owns_its_channels(self):
        self.assertTrue(self.broken(lambda m: m.update(channels=["full_body"]), self.WAVE))
        self.assertTrue(self.broken(lambda m: m.update(channels=["full_body", "head", "left_hand", "right_hand"]),
                                    self.WAVE))
        self.assertTrue(self.broken(lambda m: m.update(channels=["head"]), self.WAVE))
        self.assertTrue(self.broken(lambda m: m.update(channels=["head", "left_hand", "right_hand"])))

    def test_the_play_fields_are_only_valid_on_perform(self):
        idle = {**HOLD, "type": "idle", "target": None, "channels": ["full_body"]}
        self.assertEqual(c1.check_message(idle), [])
        for field in ({"clip": {"id": "idle_stand_a"}}, {"layer": "base"}, {"start": "now"}, {"blend_s": 0.4},
                      {"loop": True}, {"ttl_s": 30}):
            with self.subTest(field=field):
                self.assertTrue(c1.check_message({**idle, **field}))

    def test_a_cancel_aborts_or_fades_out(self):
        cancel = {"event": "behavior_cancel", "seq": 9, "behavior_id": "b-e7-2", "reason": "replaced",
                  "turn_generation": 2}
        self.assertEqual(c1.check_message({**cancel, "mode": "abort"}), [])
        self.assertEqual(c1.check_message({**cancel, "mode": "fade_out"}), [])
        self.assertEqual(c1.check_message({**cancel, "mode": "fade_out", "fade_s": 0.05}), [])
        self.assertEqual(c1.check_message({**cancel, "mode": "fade_out", "fade_s": 2}), [])
        self.assertTrue(c1.check_message({**cancel, "mode": "fade"}))
        self.assertTrue(c1.check_message({**cancel, "mode": None}))
        self.assertTrue(c1.check_message({**cancel, "fade_s": 0.3}))
        self.assertTrue(c1.check_message({**cancel, "mode": "abort", "fade_s": 0.3}))
        self.assertTrue(c1.check_message({**cancel, "mode": "fade_out", "fade_s": 0.04}))
        self.assertTrue(c1.check_message({**cancel, "mode": "fade_out", "fade_s": 2.1}))
        exit_cancel = {**cancel, "reason": "exit", "condition": "speech_end", "mode": "fade_out", "fade_s": 0.3}
        self.assertEqual(c1.check_message(exit_cancel), [])

    def test_a_snapshot_carries_reactions_stage_and_consumed(self):
        self.assertEqual(c1.check_message(self.SNAPSHOT), [])
        every = {t: [{"clip": "c", "weight": 1, "layer": "overlay"}] for t in
                 ("click", "pat", "pinch", "drag_lift", "drop", "attention_left", "attention_right", "point_at",
                  "present", "hover")}
        self.assertEqual(c1.check_message({**self.SNAPSHOT, "reactions": every}), [])
        self.assertEqual(c1.check_message({**self.SNAPSHOT, "reactions": {}, "consumed": []}), [])
        for level in ("offstage", "normal", "engaged"):
            self.assertEqual(c1.check_message({**self.SNAPSHOT, "stage": {"level": level, "revision": 0}}), [])
        self.assertEqual(c1.check_message({**self.SNAPSHOT, "consumed": [f"occ-{n}" for n in range(64)]}), [])

    def test_reactions_name_known_triggers_and_weighted_clips(self):
        bad = ({"tap": [{"clip": "c", "weight": 1, "layer": "overlay"}]}, {"attention_side": []}, {"click": []},
               {"click": {"clip": "c", "weight": 1, "layer": "overlay"}}, [],
               {"click": [{"clip": "c", "weight": 0, "layer": "overlay"}]},
               {"click": [{"clip": "c", "weight": -1, "layer": "overlay"}]},
               {"click": [{"clip": "c", "weight": True, "layer": "overlay"}]},
               {"click": [{"clip": "c", "weight": 1, "layer": "top"}]},
               {"click": [{"clip": "c", "weight": 1}]}, {"click": [{"clip": "", "weight": 1, "layer": "base"}]},
               {"click": [{"clip": "a" * 65, "weight": 1, "layer": "base"}]},
               {"click": [{"weight": 1, "layer": "base"}]})
        for reactions in bad:
            with self.subTest(reactions=reactions):
                self.assertTrue(self.broken(lambda m: m.update(reactions=reactions), self.SNAPSHOT))

    def test_stage_and_consumed_follow_the_contract(self):
        for stage in ({"level": "away", "revision": 1}, {"level": "quiet"}, {"level": "quiet", "revision": -1},
                      {"level": "quiet", "revision": True}, {"level": "quiet", "revision": 1.5}, "quiet", None):
            with self.subTest(stage=stage):
                self.assertTrue(self.broken(lambda m: m.update(stage=stage), self.SNAPSHOT))
        for consumed in (None, "occ-1", [""], [7], ["a" * 65], [f"occ-{n}" for n in range(65)]):
            with self.subTest(consumed=consumed):
                self.assertTrue(self.broken(lambda m: m.update(consumed=consumed), self.SNAPSHOT))

    def test_a_session_reaction_may_name_its_occurrence(self):
        self.assertEqual(c1.check_message({**REACTION, "occurrence_id": "occ-1"}), [])
        self.assertEqual(c1.check_message({**REACTION, "occurrence_id": "a" * 64}), [])
        for occurrence in ("", "a" * 65, 7, None):
            with self.subTest(occurrence=occurrence):
                self.assertTrue(c1.check_message({**REACTION, "occurrence_id": occurrence}))

    def test_a_short_walk_may_go_to_a_screen_edge(self):
        walk = {**HOLD, "type": "short_walk", "channels": ["full_body"], "exit": ["user_drag"]}
        for side in ("nearest", "left", "right"):
            self.assertEqual(c1.check_message({**walk, "target": {"kind": "edge", "side": side}}), [], side)
        for target in ({"kind": "edge"}, {"kind": "edge", "side": None}, {"kind": "edge", "side": "top"}):
            with self.subTest(target=target):
                self.assertTrue(c1.check_message({**walk, "target": target}))
        observe = {**walk, "type": "observe", "channels": ["eyes", "head"], "target": {"kind": "edge", "side": "left"}}
        self.assertTrue(c1.check_message(observe))

    def test_an_edge_walk_the_renderer_cannot_do_is_rejected_unsupported(self):
        walk = {**HOLD, "type": "short_walk", "channels": ["full_body"], "exit": ["user_drag"],
                "target": {"kind": "edge", "side": "nearest"}}
        at = HOLD["expires_at_ms"] - 1000
        self.assertEqual(c1.check_file({"description": "x", "messages": [
            walk, MessageTest.receipt("rejected", at, "unsupported")]}), [])
        self.assertTrue(c1.check_file({"description": "x", "messages": [
            walk, MessageTest.receipt("prepared", at - 10), MessageTest.receipt("blocked", at, "unsupported")]}))

    def test_click_and_give_way_cancel_a_behavior(self):
        for reason in ("user_click", "give_way"):
            receipt = MessageTest.receipt("cancelled", 1760900000500, reason)
            self.assertEqual(c1.check_message(receipt), [], reason)

    def test_an_overlay_runs_beside_a_base_perform(self):
        self.assertEqual(c1.check_file({"description": "x", "messages": [self.LOOP, self.WAVE]}), [])
        other = {**self.LOOP, "seq": 5, "behavior_id": "b-e7-3", "clip": {"id": "idle_stand_b"}}
        self.assertTrue(c1.check_file({"description": "x", "messages": [self.LOOP, other]}))  # both full_body
        self.assertEqual(c1.check_file({"description": "x", "messages": [self.LOOP, {**other, "replaces": "b-e7-1"}]}),
                         [])

    def test_a_ttl_expires_a_perform_before_expires_at(self):
        at = self.LOOP["expires_at_ms"] - 60000
        receipts = [MessageTest.receipt("running", at, behavior_id="b-e7-1", gen=2),
                    MessageTest.receipt("expired", at + 30000, behavior_id="b-e7-1", gen=2)]
        self.assertEqual(c1.check_file({"description": "x", "messages": [self.LOOP, *receipts]}), [])
        no_ttl = {k: v for k, v in self.LOOP.items() if k != "ttl_s"}
        self.assertTrue(c1.check_file({"description": "x", "messages": [no_ttl, *receipts]}))


class LocalMotionsTest(unittest.TestCase):
    """C1 v2.8: reaction entries with a chain, a held loop and stroke times, the new triggers, and clips within a sit."""
    PAT = {"clip": "pat_start", "weight": 1, "layer": "overlay", "chain": ["pat_loop", "pat_end"], "hold": "pat_loop"}
    SIT = {**HOLD, "type": "sit", "target": None, "channels": ["full_body", "contact"], "exit": ["user_drag"],
           "behavior_id": "b-e8-1", "seq": 2}
    WITHIN = {**PlayerPrimitivesTest.LOOP, "behavior_id": "b-e8-2", "seq": 3, "turn_generation": SIT["turn_generation"],
              "within": "b-e8-1"}

    def table(self, reactions):
        return c1.check_message({**PlayerPrimitivesTest.SNAPSHOT, "reactions": reactions})

    def test_held_chains_on_the_triggers_with_an_end_pass(self):
        for trigger in ("pat", "present", "drag_lift", "attention_left", "attention_right"):
            self.assertEqual(self.table({trigger: [self.PAT]}), [], trigger)
        self.assertEqual(self.table({"pat": [{**self.PAT, "hold": "pat_start"}]}), [])
        self.assertEqual(self.table({"click": [{k: v for k, v in self.PAT.items() if k != "hold"}]}), [])
        self.assertEqual(self.table({"present": [{**self.PAT, "stroke_s": {"pat_start": 0, "pat_end": 1.18}}]}), [])
        every = {t: [{"clip": "c", "weight": 1, "layer": "overlay"}] for t in
                 ("click_head", "click_cheek", "click_hand", "click_repeat", "pinch_annoyed")}
        self.assertEqual(self.table(every), [])

    def test_chain_hold_and_stroke_s_follow_the_contract(self):
        bad = ({"pat": [{**self.PAT, "chain": []}]}, {"pat": [{**self.PAT, "chain": "pat_loop"}]},
               {"pat": [{**self.PAT, "chain": [f"c{n}" for n in range(9)], "hold": "c0"}]},
               {"pat": [{**self.PAT, "chain": ["pat_loop", ""]}]},
               {"pat": [{k: v for k, v in self.PAT.items() if k != "chain"}]},
               {"pat": [{**self.PAT, "hold": "other"}]}, {"pat": [{**self.PAT, "hold": None}]},
               {"click": [self.PAT]}, {"drop": [self.PAT]}, {"click_repeat": [self.PAT]},
               {"pat": [{**self.PAT, "stroke_s": {"pat_start": 1}}]},
               {"present": [{**self.PAT, "stroke_s": {"other": 1}}]},
               {"present": [{**self.PAT, "stroke_s": {"pat_start": -1}}]},
               {"present": [{**self.PAT, "stroke_s": {"pat_start": True}}]},
               {"present": [{**self.PAT, "stroke_s": [2.45]}]})
        for reactions in bad:
            with self.subTest(reactions=reactions):
                self.assertTrue(self.table(reactions))

    def test_hold_s_times_the_loops_of_the_list_but_the_hold_on_any_trigger(self):
        timed = {"clip": "angry_start", "weight": 1, "layer": "overlay", "chain": ["angry_loop", "angry_end"],
                 "hold_s": {"angry_loop": 4}}
        self.assertEqual(self.table({"click_repeat": [timed], "click": [{**timed, "hold_s": {"angry_start": 0.5}}]}), [])
        after = {**self.PAT, "chain": ["pat_loop", "pat_end", "rest_loop"], "hold_s": {"rest_loop": 2.5}}
        self.assertEqual(self.table({"pat": [after]}), [])
        for hold_s in ({"other": 4}, {"pat_loop": 4}, {"pat_end": 0}, {"pat_end": -1}, {"pat_end": True},
                       {"pat_end": "4"}, [4]):
            with self.subTest(hold_s=hold_s):
                self.assertTrue(self.table({"pat": [{**self.PAT, "hold_s": hold_s}]}))

    def test_a_clip_within_a_running_sit_passes_beside_it(self):
        file = lambda *m: c1.check_file({"description": "x", "messages": list(m)})  # noqa: E731
        self.assertEqual(c1.check_message(self.WITHIN), [])
        self.assertEqual(file(self.SIT, self.WITHIN), [])
        climb = {**self.SIT, "type": "climb_window_top", "target": {"kind": "window", "window_id": 7, "side": None}}
        self.assertEqual(file(climb, self.WITHIN), [])
        self.assertTrue(file(self.WITHIN))  # no sit was sent
        cancel = {"event": "behavior_cancel", "seq": 3, "behavior_id": "b-e8-1", "reason": "expired",
                  "turn_generation": self.SIT["turn_generation"]}
        self.assertTrue(file(self.SIT, cancel, {**self.WITHIN, "seq": 4}))  # the sit no longer runs
        other = {k: v for k, v in self.WITHIN.items() if k != "within"}
        self.assertTrue(file(self.SIT, other))  # a plain clip perform still displaces the sit unannounced
        self.assertEqual(c1.check_message(MessageTest.receipt("rejected", 1760900000500, "target_gone")), [])

    def test_a_clip_within_a_sit_ends_with_it(self):
        file = lambda *m: c1.check_file({"description": "x", "messages": list(m)})  # noqa: E731
        stand = {**{k: v for k, v in self.WITHIN.items() if k != "within"}, "behavior_id": "b-e8-3", "seq": 5,
                 "replaces": None}
        cancel = {"event": "behavior_cancel", "seq": 4, "behavior_id": "b-e8-1", "reason": "expired",
                  "turn_generation": self.SIT["turn_generation"]}
        ended = {"event": "receipt", "behavior_id": "b-e8-1", "phase": "completed", "reason": None,
                 "at_ms": 1760900000500, "turn_generation": self.SIT["turn_generation"]}
        running = {**ended, "phase": "running", "at_ms": 1760900000100}
        self.assertEqual(file(self.SIT, self.WITHIN, cancel, stand), [])
        self.assertEqual(file(self.SIT, running, self.WITHIN, ended, stand), [])
        resit = {**self.SIT, "behavior_id": "b-e8-4", "seq": 4, "replaces": "b-e8-1"}
        again = {**self.WITHIN, "behavior_id": "b-e8-5", "seq": 5, "within": "b-e8-4"}
        self.assertEqual(file(self.SIT, self.WITHIN, resit, again), [])

    def test_within_is_a_behavior_id_on_a_base_clip_perform_only(self):
        overlay = {k: v for k, v in self.WITHIN.items() if k != "loop"}
        for bad in ({**self.WITHIN, "within": ""}, {**self.WITHIN, "within": 3}, {**self.WITHIN, "within": "b" * 65},
                    {**overlay, "layer": "overlay", "channels": ["head", "left_hand", "right_hand"]}):
            with self.subTest(bad=bad):
                self.assertTrue(c1.check_message(bad))
        action = {**{k: v for k, v in self.WITHIN.items() if k not in ("clip", "loop", "ttl_s")},
                  "action": {"id": "wave", "length_s": 2.4}}
        self.assertTrue(c1.check_message(action))
        self.assertTrue(c1.check_message({**self.SIT, "within": "b-e8-1"}))

    def test_a_player_fixture_may_end_a_pat_or_a_present(self):
        basic = copy.deepcopy(PlayerFixtureTest.BASIC)
        for trigger in ("pat", "present"):
            fixture = copy.deepcopy(basic)
            fixture["steps"].append({"t_ms": 400, "local": {"input": trigger, "end": True}})
            self.assertEqual(c1.check_player_fixture(fixture), [], trigger)
        for local in ({"input": "click", "end": True}, {"input": "drag_lift", "end": True},
                      {"input": "pat", "end": False}, {"input": "pat", "end": 1}):
            fixture = copy.deepcopy(basic)
            fixture["steps"].append({"t_ms": 400, "local": local})
            with self.subTest(local=local):
                self.assertTrue(c1.check_player_fixture(fixture))


PLAYER = FIXTURES / "player"
INVALID = FIXTURES / "invalid"


class PlayerFixtureTest(unittest.TestCase):
    """The player fixtures: timed C1 messages and local inputs in, the renderer's motion_state sequence out."""
    BASIC = {"name": "x", "character": None,
             "steps": [{"t_ms": 0, "c1": PlayerPrimitivesTest.LOOP}, {"t_ms": 200, "local": {"input": "click"}}],
             "expect": [{"t_ms_max": 100, "motion_state": {"behavior_id": "b-e7-1", "origin": "agent",
                                                           "phase": "started", "resting": True, "busy": False}},
                        {"t_ms_max": 300, "motion_state": {"behavior_id": None, "origin": "local",
                                                           "phase": "started", "resting": False, "busy": True}}]}

    def broken(self, change):
        bad = copy.deepcopy(self.BASIC)
        change(bad)
        return c1.check_player_fixture(bad)

    def test_every_player_fixture_is_valid(self):
        files = sorted(PLAYER.glob("*.json"))
        self.assertGreaterEqual(len(files), 6)
        for path in files:
            with self.subTest(path.name):
                self.assertEqual(c1.check_player_fixture(json.loads(path.read_text(encoding="utf-8"))), [])

    def test_a_minimal_fixture_passes(self):
        self.assertEqual(c1.check_player_fixture(self.BASIC), [])
        self.assertEqual(c1.check_player_fixture({**self.BASIC, "poses": []}), [])
        self.assertEqual(c1.check_player_fixture({**self.BASIC, "character": "aster"}), [])
        user = copy.deepcopy(self.BASIC)
        user["expect"][1]["motion_state"]["origin"] = "user"  # a user play: null behavior_id, no cycle_end
        self.assertEqual(c1.check_player_fixture(user), [])

    def test_the_fixture_shape(self):
        for change in (lambda f: f.pop("name"), lambda f: f.update(name=""), lambda f: f.pop("character"),
                       lambda f: f.update(character=""), lambda f: f.update(steps=[]), lambda f: f.update(expect=[]),
                       lambda f: f.update(poses=[{"t_ms": 0}]), lambda f: f.update(poses=None),
                       lambda f: f.update(extra=1)):
            with self.subTest(change=change):
                self.assertTrue(self.broken(change))
        self.assertTrue(c1.check_player_fixture([]))

    def test_steps_are_timed_c1_messages_or_local_inputs(self):
        for change in (lambda f: f["steps"][1].update(c1=PlayerPrimitivesTest.WAVE),
                       lambda f: f["steps"][1].pop("t_ms"), lambda f: f["steps"][1].update(t_ms=-1),
                       lambda f: f["steps"][0].update(t_ms=300), lambda f: f["steps"][1].update(t_ms=1.5),
                       lambda f: f["steps"][1].update(local={"input": "tap"}),
                       lambda f: f["steps"][1].update(local={"input": "click", "x": 1}),
                       lambda f: f["steps"][0]["c1"].update(layer="top"),
                       lambda f: f["steps"].append({"t_ms": 400, "c1": MessageTest.receipt("running", 1)})):
            with self.subTest(change=change):
                self.assertTrue(self.broken(change))

    def test_expectations_are_motion_states_without_the_clip(self):
        for change in (lambda f: f["expect"][0]["motion_state"].update(clip="idle_stand_a"),
                       lambda f: f["expect"][0]["motion_state"].pop("busy"),
                       lambda f: f["expect"][0]["motion_state"].update(phase="running"),
                       lambda f: f["expect"][0]["motion_state"].update(origin="user"),  # with a behavior_id
                       lambda f: f["expect"][1]["motion_state"].update(origin="user", phase="cycle_end"),
                       lambda f: f["expect"][0]["motion_state"].update(origin="remote"),
                       lambda f: f["expect"][0]["motion_state"].update(resting=1),
                       lambda f: f["expect"][0]["motion_state"].update(behavior_id=None),  # agent needs its behavior
                       lambda f: f["expect"][0]["motion_state"].update(behavior_id="b-e7-9"),  # never sent
                       lambda f: f["expect"][1].update(t_ms_max=50), lambda f: f["expect"][0].pop("t_ms_max"),
                       lambda f: f["expect"][0].update(note="x")):
            with self.subTest(change=change):
                self.assertTrue(self.broken(change))


class InvalidFixtureTest(unittest.TestCase):
    def test_every_invalid_fixture_fails(self):
        files = sorted(INVALID.glob("*.json"))
        self.assertGreaterEqual(len(files), 8)
        for path in files:
            with self.subTest(path.name):
                self.assertTrue(c1.check_file(json.loads(path.read_text(encoding="utf-8"))))

    def test_each_player_primitive_sample_fails_on_its_rule(self):
        words = {"perform-overlay-on-full-body": "overlay", "perform-two-payloads": "exactly one",
                 "perform-loop-on-overlay": "loop", "perform-unknown-start": "start",
                 "snapshot-unknown-reaction-trigger": "reactions", "cancel-fade-s-without-fade-out": "fade_s",
                 "snapshot-hold-on-click": "hold", "snapshot-hold-not-in-list": "hold",
                 "snapshot-stroke-off-present": "stroke_s", "perform-within-on-overlay": "within",
                 "perform-within-no-sit": "within", "snapshot-hold-s-not-in-list": "hold_s",
                 "snapshot-hold-s-on-the-hold": "hold_s", "snapshot-hold-s-not-positive": "hold_s",
                 "receipt-user-play-not-cancelled": "user_play"}
        for name, word in words.items():
            with self.subTest(name):
                problems = c1.check_file(json.loads((INVALID / f"{name}.json").read_text(encoding="utf-8")))
                self.assertEqual(len(problems), 1, problems)
                self.assertIn(word, problems[0])


if __name__ == "__main__":
    unittest.main()
