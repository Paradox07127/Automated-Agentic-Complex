"""avatar_motions_list and avatar_motion: the character plays one of her own package actions by id, never generated."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import c1  # noqa: E402
from infra.secrets import MemorySecrets  # noqa: E402
from infra.store import open_store  # noqa: E402
from motion.performer import Performer  # noqa: E402
from motion.settings import MotionSettings  # noqa: E402
from tool_gateway.registry import BUILTIN, REGISTRY  # noqa: E402
from traces.trace_format import validate_stream  # noqa: E402
from traces.trace_store import TraceStore, new_trace_id  # noqa: E402
import test_character_agent_integration as integration  # noqa: E402

ROWS = [
    {"id": "wave", "name": "Wave", "description": "waves her hand", "section": "talk", "tags": ["greet"], "clips": ["a"]},
    {"id": "nod", "name": "Nod", "description": "nods", "section": "react", "clips": ["b"]},
    {"id": "gone", "name": "Gone", "section": "idle", "clips": ["a"]},
    {"id": "lost", "name": "Lost", "section": "idle", "clips": ["a", "missing"]},
    {"id": "dance", "name": "Dance", "section": "idle", "clips": ["long"]},
]
CLIPS = [{"name": "a", "length": 2.0}, {"name": "b", "length": 1.5}, {"name": "long", "length": 30.0}]


class NoGenerator:
    def __getattr__(self, name):
        raise AssertionError(f"the motion service was touched: {name}")


class AvatarMotionToolTest(integration.IntegrationFixture):
    def setUp(self):
        super().setUp()
        package = self.root / "pkg"
        animation = package / "runtime" / "characters" / "t" / "c7" / "animation"
        animation.mkdir(parents=True)
        (animation / "actions.json").write_text(json.dumps({"schema": "x", "actions": ROWS}), encoding="utf-8")
        (animation / "clip-catalog.json").write_text(json.dumps({"schema": "x", "clips": CLIPS}), encoding="utf-8")
        self.server.trace = TraceStore(open_store(self.root / "trace.sqlite"), producer_epoch=self.server.registry.epoch)
        self.server.motion = Performer(MotionSettings(self.root, MemorySecrets()), self.server.registry.publish_event,
                                       lambda: package, self.root / "cache", offer=self.server.spatial.offer,
                                       trace=self.server._trace, client=NoGenerator(), service_url=None)
        self.addCleanup(setattr, self.server.spatial, "chooser", self.server.spatial.chooser)
        self.server.spatial.chooser = SimpleNamespace(pack=SimpleNamespace(missing={"gone"}),
                                                      switches={"wave": True, "nod": False, "gone": False})
        for name in ("start", "gesture", "_work", "_perform", "request"):
            guard = patch.object(Performer, name, side_effect=AssertionError(f"Performer.{name} was called"))
            guard.start()
            self.addCleanup(guard.stop)

    def native(self, name, args, run_id="turn-motion"):
        return self.controller._native(name, args, run_id=run_id, is_current=lambda: True)

    def behaviors(self):
        return [e for e in self.server.registry.intents if e.get("event") == "behavior"]

    def test_the_list_holds_only_playable_rows_the_user_left_on(self):
        self.assertEqual(self.native("avatar_motions_list", {}), {"motions": [
            {"id": "wave", "name": "Wave", "description": "waves her hand", "section": "talk", "tags": ["greet"],
             "length_s": 2.0}]})

    def test_a_listed_id_publishes_one_action_perform_on_the_turn_trace(self):
        trace = self.server._open_trace("turn-motion", self.server.turn_generation, "text", "挥个手")
        result = self.native("avatar_motion", {"action_id": "wave", "reason": "打招呼"})
        self.assertTrue(result["accepted"], result)
        self.assertRegex(result["behavior_id"], r"^b-ga-[0-9a-f]{16}$")
        self.assertEqual(result["length_s"], 2.0)
        [behavior] = self.behaviors()
        self.assertEqual(c1.check_message(behavior), [])
        self.assertEqual((behavior["behavior_id"], behavior["type"], behavior["action"], behavior["trace_id"]),
                         (result["behavior_id"], "perform", {"id": "wave", "length_s": 2.0}, trace["trace_id"]))
        events = self.server.trace.turn(trace["trace_id"])["events"]
        self.assertEqual([e["kind"] for e in events], ["input.received", "motion.matched", "behavior.dispatched"])
        self.assertEqual(events[2]["turn_id"], "turn-motion")
        self.assertEqual(events[2]["attrs"], {"behavior_id": result["behavior_id"], "behavior_type": "perform"})
        self.assertEqual(events[1]["attrs"], {"action_id": "wave", "group": "tool", "length_s": 2.0, "seconds": 2.0,
                                              "prompt": None})
        self.assertEqual(validate_stream(events), [])

    def test_an_unlisted_or_switched_off_id_publishes_nothing(self):
        for action_id, reason in (("bow", "unknown_action"), ("dance", "unknown_action"), ("lost", "unknown_action"),
                                  ("gone", "unknown_action"), ("nod", "switched_off")):
            with self.subTest(action_id=action_id):
                self.assertEqual(self.native("avatar_motion", {"action_id": action_id, "reason": "试试"}),
                                 {"accepted": False, "reason": reason})
        self.assertEqual(self.behaviors(), [])

    def test_bad_arguments_are_refused(self):
        for args in ({}, {"action_id": "wave"}, {"action_id": "", "reason": "x"}, {"action_id": "w" * 65, "reason": "x"},
                     {"action_id": "wave", "reason": ""}, {"action_id": "wave", "reason": "x" * 201},
                     {"action_id": "wave", "reason": "x", "seconds": 3}):
            with self.subTest(args=args):
                self.assertEqual(self.native("avatar_motion", args), {"error": {"code": "invalid_arguments"}})
        self.assertEqual(self.native("avatar_motions_list", {"section": "talk"}), {"error": {"code": "invalid_arguments"}})
        self.assertEqual(self.behaviors(), [])

    def test_a_refusal_from_spatial_comes_back_as_its_reason(self):
        self.server.turn_generation += 1
        trace = self.server._open_trace("turn-motion", self.server.turn_generation - 1, "text", "挥个手")
        self.assertEqual(self.native("avatar_motion", {"action_id": "wave", "reason": "打招呼"}),
                         {"accepted": False, "reason": "stale"})
        self.assertEqual(self.behaviors(), [])
        kinds = [e["kind"] for e in self.server.trace.turn(trace["trace_id"])["events"]]
        self.assertEqual(kinds, ["input.received", "motion.fallback"])

    def test_play_action_never_reaches_the_generator(self):
        self.assertEqual(self.server.motion.play_action("bow", generation=self.server.turn_generation, trace_id=new_trace_id()),
                         {"accepted": False, "reason": "unknown_action"})
        result = self.server.motion.play_action("wave", generation=self.server.turn_generation, trace_id=new_trace_id())
        self.assertTrue(result["accepted"], result)
        self.assertEqual(len(self.behaviors()), 1)


class RegistryTest(unittest.TestCase):
    def test_both_tools_are_offered_like_avatar_face(self):
        face = BUILTIN["avatar_face"]
        for name, effect in (("avatar_motion", "embodied"), ("avatar_motions_list", "read")):
            with self.subTest(name=name):
                spec = BUILTIN[name]
                self.assertEqual((spec.family, spec.effect, spec.grant, spec.callers, spec.modes, spec.receipt),
                                 (face.family, effect, "none", face.callers, face.modes, False))
        names = [d["name"] for d in REGISTRY.native_definitions(desktop=False)]
        self.assertEqual(names, ["avatar_face", "avatar_facing_status", "avatar_motions_list", "avatar_motion",
                                 "avatar_outfits_list", "avatar_outfit"])
        tool = next(d for d in REGISTRY.native_definitions(desktop=False) if d["name"] == "avatar_motion")
        self.assertEqual(tool["input_schema"]["required"], ["action_id", "reason"])
        self.assertIn("avatar_motions_list", tool["description"])


if __name__ == "__main__":
    unittest.main()
