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


if __name__ == "__main__":
    unittest.main()
