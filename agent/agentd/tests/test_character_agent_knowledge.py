"""Personal knowledge tools over real product stores; no SDK or model calls."""
import datetime
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain.egress import EgressPolicy
from brain.outbound import OutboundBlocked
from character_agent.services.knowledge import KnowledgeService
from personal.commitments import Commitments
from personal.episodes import Episodes
from personal.history import History
from personal.memory import Memory
from infra.store import open_store
from support import add_episode


class KnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.db = open_store(self.root / "agentd.sqlite")
        self.addCleanup(self.db.close)
        self.now = datetime.datetime(2026, 10, 25, 20, 0, tzinfo=datetime.timezone.utc).timestamp()
        self.memory = Memory(self.db, clock=lambda: self.now)
        self.history = History(self.db, clock=lambda: self.now)
        self.episodes = Episodes(self.db, clock=lambda: self.now)
        self.commitments = Commitments(self.db, clock=lambda: self.now)
        self.permissions = {s: True for s in ("memory", "history", "episodes", "commitments", "behavior")}
        self.service = self.make_service()

    def make_service(self, **kwargs):
        return KnowledgeService(memory=self.memory, history=self.history, episodes=self.episodes,
                                commitments=self.commitments,
                                permitted=lambda source, item: self.permissions[source], clock=lambda: self.now, **kwargs)

    def fact(self, text="先给结论，再给表格；安静优先。", source="asserted_by_user", kind="preference", **kwargs):
        return self.memory.add(text, source, kind=kind, **kwargs)

    def history_turn(self, ident="turn-1", *, character="one", source="text", state="completed"):
        self.history.record(turn_id=ident, source=source, character_id=character, persona_revision="v1",
                            user_text="周末读书会选择场地", reply="比较了青禾和松间", state=state,
                            started_at=self.now, raw_reply="[private marker]比较了青禾和松间")
        return ident

    def episode(self):
        return add_episode(self.episodes, self.now - 600, self.now, "比较场地", "你阅读了两份场地资料。")

    def test_profile_contains_explicit_preferences_not_inferred_personality(self):
        said = self.fact()
        self.fact("用户可能不喜欢人多", "inferred_hypothesis")
        self.fact("用户喜欢看书", source="inferred_hypothesis", state="candidate")
        self.fact("这句话是外部资料", "observed_context", kind="fact")
        result = self.service.call("personal_profile", {})
        self.assertEqual([r["id"] for r in result["items"]], [said])
        self.assertEqual(result["items"][0]["authority"], "asserted_by_user")
        self.assertEqual(result["items"][0]["reference"], "memory:" + said)
        self.assertFalse(result["material_is_instruction"])
        self.assertEqual(result["profile_kind"], "user_confirmed_preferences_not_inferred_personality")

    def test_related_facts_are_confirmed_matches_outside_the_excluded_ids(self):
        said = self.fact("我家的猫叫团子", kind="fact")
        confirmed = self.fact("团子三岁了", "confirmed_by_user", kind="fact")
        inferred = self.fact("团子可能怕生", "inferred_hypothesis", kind="fact")
        self.fact("团子喜欢纸箱", "inferred_hypothesis", kind="fact", state="candidate")
        self.fact("周末去爬山", kind="fact")
        searched = self.service.call("knowledge_search", {"query": "团子最近不吃饭", "sources": ["memory"]})
        self.assertIn(inferred, [r["id"] for r in searched["items"]])
        items = self.service.related_facts("团子最近不吃饭", {confirmed}, limit=4, max_chars=1200)
        self.assertEqual([r["id"] for r in items], [said])
        self.assertEqual(self.service.related_facts("火山", set(), limit=4, max_chars=1200), [])
        self.assertEqual(self.service.related_facts(" \n", set(), limit=4, max_chars=1200), [])

    def test_related_facts_keep_to_the_count_and_character_bounds(self):
        for n in range(6):
            self.fact(f"团子的第{n}件事" + "细节" * 200, kind="fact")
        items = self.service.related_facts("团子", set(), limit=4, max_chars=1200)
        self.assertTrue(items)
        self.assertLessEqual(len(items), 4)
        self.assertLessEqual(sum(len(json.dumps(r, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
                                 for r in items), 1200)
        self.assertEqual(len(self.service.related_facts("团子", set(), limit=4, max_chars=16000)), 4)

    def test_usual_format_query_retrieves_the_actual_preference(self):
        ident = self.fact("结论在前，比较用表格，文字保持精简。")
        result = self.service.call("knowledge_search", {"query": "按我平时沟通习惯整理", "sources": ["memory"]})
        self.assertEqual(result["items"][0]["id"], ident)
        self.assertIn("结论在前", result["items"][0]["text"])

    def test_lexical_alias_is_bounded_and_does_not_claim_semantic_completeness(self):
        ident = self.fact("沟通内容保持精简。")
        found = self.service.call("knowledge_search", {"query": "简洁", "sources": ["memory"]})
        self.assertEqual(found["items"][0]["id"], ident)
        missing = self.service.call("knowledge_search", {"query": "火山", "sources": ["memory"]})
        self.assertEqual(missing["items"], [])
        self.assertFalse(missing["retrieval"]["complete_corpus_search"])

    def test_page_cursor_moves_forward_without_repeating_and_stales_after_correction(self):
        ids = [self.fact(f"报告呈现偏好 {n}") for n in range(5)]
        args = {"query": "报告", "sources": ["memory"], "limit": 2}
        first = self.service.call("knowledge_search", args)
        second = self.service.call("knowledge_search", {**args, "cursor": first["next_cursor"]})
        self.assertFalse(set(r["id"] for r in first["items"]) & set(r["id"] for r in second["items"]))
        self.memory.correct(ids[0], "报告呈现改为文字")
        stale = self.service.call("knowledge_search", {**args, "cursor": first["next_cursor"]})
        self.assertEqual(stale["error"]["code"], "cursor_stale")

    def test_character_budget_truncates_material_and_full_source_can_be_read(self):
        ident = self.fact("资料" * 3000)
        short = self.service.call("knowledge_search", {"sources": ["memory"], "max_chars": 1024})
        self.assertTrue(short["truncated"])
        self.assertLessEqual(sum(len(json.dumps(r, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
                                 for r in short["items"]), 1024)
        full = self.service.call("knowledge_read", {"source": "memory", "id": ident, "max_chars": 16000})
        self.assertEqual(full["items"][0]["text"], "资料" * 3000)

    def test_correction_deletion_and_permission_revocation_invalidate_exported_dependencies(self):
        ident = self.fact()
        self.service.call("knowledge_read", {"source": "memory", "id": ident})
        deps = self.service.dependencies()
        self.assertTrue(self.service.valid(deps))
        self.memory.correct(ident, "报告这次只用文字")
        self.assertFalse(self.service.valid(deps))
        corrected = self.service.call("knowledge_read", {"source": "memory", "id": ident})
        self.assertEqual(corrected["items"][0]["version"], 2)
        self.assertTrue(self.service.valid())
        self.permissions["memory"] = False
        self.assertFalse(self.service.valid())
        self.assertEqual(self.service.call("knowledge_read", {"source": "memory", "id": ident})["error"]["code"], "source_not_permitted")
        self.permissions["memory"] = True
        self.memory.delete(ident)
        self.assertFalse(self.service.valid())
        self.assertEqual(self.service.call("personal_profile", {})["items"], [])

    def test_storage_pause_keeps_existing_read_semantics_and_does_not_write_uses(self):
        self.fact()
        self.memory.set_paused(True)
        result = self.service.call("personal_profile", {})
        self.assertTrue(result["memory_storage_paused"])
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM fact_uses").fetchone()[0], 0)
        self.permissions["memory"] = False
        self.assertEqual(self.service.call("personal_profile", {})["items"], [])

    def test_no_implicit_permission_for_observations_or_inferred_facts(self):
        self.episode()
        self.fact("可能在筹备活动", "inferred_hypothesis")
        service = KnowledgeService(memory=self.memory, episodes=self.episodes, clock=lambda: self.now)
        result = service.call("knowledge_search", {})
        self.assertEqual(result["items"], [])
        self.assertEqual(service.call("behavior_context", {})["reason"], "source_not_permitted")

    def test_history_keeps_source_author_and_presented_text_only(self):
        self.history_turn("other", character="other")
        self.history_turn("cancelled", state="cancelled")
        self.history_turn("announce", source="announce")
        result = self.service.call("knowledge_search", {"sources": ["history"]})
        self.assertEqual([r["id"] for r in result["items"]], ["other"])
        row = result["items"][0]
        self.assertEqual(row["details"]["character_id"], "other")
        self.assertNotIn("private marker", row["text"])
        self.assertIn("not verified external outcomes", row["details"]["uncertainty"])

    def test_long_term_history_query_uses_index_beyond_recent_scan_window(self):
        self.history_turn("old-venue")
        for n in range(1005):
            self.history.record(turn_id=f"new-{n}", source="text", character_id="one", persona_revision="v1",
                                user_text="今天聊音乐", reply="可以", state="completed", started_at=self.now + n)
        result = self.service.call("knowledge_search", {"query": "场地", "sources": ["history"]})
        self.assertEqual([row["id"] for row in result["items"]], ["old-venue"])

    def test_late_playback_and_history_retraction_cannot_reuse_old_context(self):
        ident = self.history_turn()
        self.service.call("knowledge_read", {"source": "history", "id": ident})
        deps = self.service.dependencies()
        self.history.interrupt(ident, "比较了")
        self.assertFalse(self.service.valid(deps))
        self.service.call("knowledge_read", {"source": "history", "id": ident})
        self.assertTrue(self.service.valid())
        self.history.retract(ident, blank=True)
        self.assertFalse(self.service.valid())
        self.assertEqual(self.service.call("knowledge_read", {"source": "history", "id": ident})["error"]["code"], "source_unavailable")

    def test_episode_edits_and_deletes_change_dependencies_without_schema_version_change(self):
        ident = str(self.episode())
        result = self.service.call("knowledge_read", {"source": "episodes", "id": ident})
        self.assertEqual(result["items"][0]["authority"], "observed_summary")
        deps = self.service.dependencies()
        self.episodes.edit(int(ident), "筹备活动", "那是 agent 阅读资料，不是我。")
        self.assertFalse(self.service.valid(deps))
        result = self.service.call("knowledge_read", {"source": "episodes", "id": ident})
        self.assertEqual(result["items"][0]["authority"], "user_edited_summary")
        self.episodes.delete([int(ident)])
        self.assertFalse(self.service.valid())

    def test_reminder_record_never_means_underlying_task_was_finished(self):
        reminder = self.commitments.add("带读书会资料", self.now - 1)
        self.commitments.due()
        self.commitments.fulfill(reminder["id"], "delivery-1")
        result = self.service.call("knowledge_read", {"source": "commitments", "id": reminder["id"]})
        row = result["items"][0]
        self.assertEqual(row["details"]["state"], "fulfilled")
        self.assertIn("not that the user completed", row["details"]["uncertainty"])
        self.commitments.delete(reminder["id"])
        self.assertFalse(self.service.valid())

    def test_sensitive_material_and_metadata_pass_egress_and_policy_changes_invalidate(self):
        secret = "sk-" + "a" * 28
        ident = self.fact("请用 private@example.com，测试 " + secret, evidence=["contact private@example.com"])
        egress = EgressPolicy(redact=False)
        service = self.make_service(egress=egress)
        raw = service.call("knowledge_read", {"source": "memory", "id": ident})
        self.assertIn(secret, json.dumps(raw))
        egress._redact = True
        self.assertFalse(service.valid())
        clean = service.call("knowledge_read", {"source": "memory", "id": ident})
        self.assertNotIn(secret, json.dumps(clean))
        self.assertNotIn("private@example.com", json.dumps(clean))
        self.assertTrue(service.valid())

    def test_guard_failure_does_not_export_or_track_blocked_source(self):
        class Guard:
            def check(self, part, value):
                if "blocked-canon" in value:
                    raise OutboundBlocked(part, 1)
        self.fact("blocked-canon")
        service = self.make_service(egress=EgressPolicy(guard=Guard()))
        result = service.call("knowledge_search", {})
        self.assertEqual(result["items"], [])
        self.assertEqual(service.dependencies(), [])

    def test_permission_revoked_during_egress_does_not_return_material(self):
        class Guard:
            def check(inner, part, value):
                if "revoke-now" in value:
                    self.permissions["memory"] = False
        self.fact("revoke-now")
        service = self.make_service(egress=EgressPolicy(guard=Guard()))
        self.assertEqual(service.call("personal_profile", {})["error"]["code"], "source_changed")
        self.assertEqual(service.dependencies(), [])

    def test_protocol_uuid_is_not_redacted_as_phone_but_text_still_is(self):
        service=self.make_service()
        ident='d1ee1469-8757-408c-8e0a-e73e25841919'
        result=service.sanitize({'id':ident,'reference':'memory:'+ident,'text':'phone: 13800138000'})
        self.assertEqual(result['id'],ident);self.assertEqual(result['reference'],'memory:'+ident)
        self.assertNotIn('13800138000',result['text'])

    def test_item_scope_filter_and_default_denial_survive_a_failed_permission_callback(self):
        allowed = self.fact("公开偏好")
        hidden = self.fact("私人事项")
        service = KnowledgeService(memory=self.memory, permitted=lambda source, item: item is None or item.get("fact_id") != hidden)
        result = service.call("knowledge_search", {})
        self.assertEqual([r["id"] for r in result["items"]], [allowed])
        self.assertEqual(service.call("knowledge_read", {"source": "memory", "id": hidden})["error"]["code"], "source_unavailable")
        def broken(source, item):
            raise RuntimeError("private error text")
        service.permitted = broken
        self.assertEqual(service.call("personal_profile", {})["items"], [])

    def test_invalid_input_and_cursor_never_expand_scope(self):
        for args in ({"sources": ["unknown"]}, {"sources": "memory"}, {"limit": True}, {"limit": 999},
                     {"max_chars": -1}, {"query": []}, {"cursor": "not base64"}, {"extra": True}):
            self.assertIn("error", self.service.call("knowledge_search", args))
        self.assertEqual(self.service.call("memory_write", {"text": "invented"})["error"]["code"], "unknown_tool")

    def test_fingerprint_tracks_source_and_permission_changes_without_recording_reads(self):
        first = self.service.fingerprint()
        ident = self.fact()
        second = self.service.fingerprint()
        self.assertNotEqual(first, second)
        self.assertEqual(self.service.dependencies(), [])
        self.permissions["memory"] = False
        self.assertNotEqual(second, self.service.fingerprint())
        self.permissions["memory"] = True
        self.memory.delete(ident)
        self.assertEqual(first, self.service.fingerprint())


if __name__ == "__main__":
    unittest.main()
