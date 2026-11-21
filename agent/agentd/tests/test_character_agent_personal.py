import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character_agent.services.knowledge import KnowledgeService
from character_agent.services.personal import activity_assessment, persona_personal_instructions


class PersonalContextTests(unittest.TestCase):
    def test_personal_instructions_preserve_role_card_and_support_non_task_conversation(self):
        card = {"name": "角色甲", "identity": "原有身份", "personality": "原有个性"}
        before = copy.deepcopy(card)
        instructions = persona_personal_instructions(card)
        self.assertEqual(card, before)
        for text in ("personal assistant", "you take both chat and real work", "need no task", "your fiction",
                     "no real history with the user", "Explicit corrections win", "receipts and checks"):
            self.assertIn(text, instructions)

    def test_activity_snapshot_is_provisional_scoped_and_expires(self):
        snapshot = {"at": 100, "mode": "reading", "state": "searching", "thread": "场地比较",
                    "evidence": ["obs-1"], "emotion": "anxious", "personality": "introverted"}
        result = activity_assessment(snapshot, now=150)
        self.assertTrue(result["available"])
        self.assertEqual(result["authority"], "inferred_hypothesis")
        self.assertEqual(result["expires_at"], 220)
        self.assertEqual(result["assessment"]["evidence"], ["obs-1"])
        self.assertNotIn("emotion", result["assessment"])
        self.assertNotIn("personality", result["assessment"])
        self.assertFalse(activity_assessment(snapshot, now=220)["available"])

    def test_unavailable_undated_future_or_infinite_context_is_not_given_a_fresh_query_time(self):
        for snapshot in ({"available": False}, {"state": "searching"}, {"at": 200}, {"at": float("nan")},
                         {"at": True}, {"at": 100, "expires_at": float("inf")}):
            self.assertFalse(activity_assessment(snapshot, now=100)["available"])

    def test_unknown_assessment_labels_are_not_upgraded_to_psychological_claims(self):
        result = activity_assessment({"at": 100, "state": "depressed", "mode": "personality-analysis", "expires_at": 99999}, now=100)
        self.assertEqual(result["assessment"], {"state": "unknown", "mode": "other"})
        self.assertEqual(result["expires_at"], 220)

    def test_behavior_tool_honors_availability_consent_ttl_and_dependency_invalidation(self):
        now, permission = [150], [True]
        snapshot = {"observed_at": 100, "state": "searching", "source_refs": ["obs-1"]}
        service = KnowledgeService(permitted=lambda source, item: permission[0],
                                   behavior_context=lambda: snapshot, clock=lambda: now[0])
        result = service.call("behavior_context", {})
        self.assertTrue(result["available"])
        self.assertEqual(result["items"][0]["authority"], "inferred_hypothesis")
        self.assertTrue(service.valid())
        permission[0] = False
        self.assertFalse(service.valid())
        self.assertFalse(service.call("behavior_context", {})["available"])
        permission[0] = True
        now[0] = 221
        self.assertFalse(service.valid())
        self.assertFalse(service.call("behavior_context", {})["available"])
        snapshot.update(available=False, observed_at=221)
        self.assertFalse(service.call("behavior_context", {})["available"])


if __name__ == "__main__":
    unittest.main()
