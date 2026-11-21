"""Work-memory store: session summaries, task cards, day summaries and the chat injection text."""
import datetime
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from infra.data_lifecycle import DataLifecycle
from infra.store import open_store
from personal.worklog import WorkLog

T0 = datetime.datetime(2026, 11, 4, 10, 0).timestamp()
TODAY = "2026-11-04"
TABLES = ("session_summaries", "task_cards", "day_summaries")
L1 = {"title": "修 HostLink 断线重连", "goal": "断线后自动恢复会话", "goal_authority": "user_said", "did": [],
      "outcome": "swift test 通过", "status": "done", "blockers": [], "next_steps": [], "task_hint": "HostLink",
      "project": "Endfield", "user_facts": []}


def card(title, **fields):
    return {"title": title, "goal": "目标", "goal_authority": "inferred", "status": "active",
            "status_authority": "inferred", "progress": "进展", "next_step": "下一步", "blockers": [],
            "project": "Endfield", "first_at": T0, "last_at": T0, "requires": [], **fields}


class WorkLogStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "agentd.sqlite"
        self.db = open_store(self.path)
        self.log = WorkLog(self.db, lambda: "aster", clock=lambda: T0 + 60)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def count(self, table):
        return self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]

    def segment(self, key="s1", start=T0, requires=("page_text",)):
        return self.log.add_segment("agent_session", key, start, start + 600, input_sha256="h", requires=requires,
                                    sources=["obs-1"], agent="claude", project="Endfield", cwd="/w")

    def test_open_store_creates_the_three_tables(self):
        names = {r[0] for r in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertLessEqual(set(TABLES), names)

    def test_data_lifecycle_clears_the_three_tables(self):
        self.log.complete_segment(self.segment(), L1)
        self.log.upsert_task(card("任务"))
        self.log.put_day("day", TODAY, {"timezone": "Asia/Shanghai", "headline": "h", "body": {}, "inject": "i",
                                        "partial": True, "sources": [], "requires": []})
        lifecycle = DataLifecycle([self.db])
        self.assertTrue(all(lifecycle.counts()[t] == 1 for t in TABLES))
        lifecycle.clear()
        self.assertEqual([self.count(t) for t in TABLES], [0, 0, 0])

    def test_segment_completes_and_waits_for_a_task(self):
        ident = self.segment()
        self.assertTrue(ident.startswith("ses-"))
        self.assertEqual(self.segment(), ident)
        self.assertEqual(self.log.pending_sessions(), [])
        self.assertTrue(self.log.complete_segment(ident, L1, run_id="run", model="haiku"))
        [row] = self.log.pending_sessions()
        self.assertEqual((row["title"], row["status"], row["state"], row["body"]["outcome"], row["day"]),
                         (L1["title"], "done", "completed", "swift test 通过", TODAY))
        task = self.log.upsert_task(card("HostLink 断线", requires=[]))
        self.assertTrue(self.log.assign(ident, task))
        self.assertEqual(self.log.pending_sessions(), [])
        [listed] = self.log.tasks()
        self.assertEqual((listed["sessions"], listed["requires"], listed["last_at"]), (1, ["page_text"], T0 + 600))
        self.assertEqual([s["id"] for s in self.log.sessions_on(TODAY)], [ident])

    def test_a_result_asked_for_before_a_delete_is_not_stored(self):
        ident = self.segment()
        asked = self.log.generation
        self.log.delete_permissions({"typed_text"})
        self.assertFalse(self.log.complete_segment(ident, L1, generation=asked))
        self.assertIsNone(self.log.upsert_task(card("任务"), generation=asked))
        self.assertEqual(self.count("task_cards"), 0)

    def test_merge_moves_sessions_and_drops_the_source_card(self):
        ident = self.segment()
        self.log.complete_segment(ident, L1)
        a, b = self.log.upsert_task(card("A", first_at=T0 - 100)), self.log.upsert_task(card("B"))
        self.log.assign(ident, a)
        self.assertTrue(self.log.merge_tasks(a, b))
        [task] = self.log.tasks()
        self.assertEqual((task["id"], task["sessions"], task["first_at"], task["revision"]), (b, 1, T0 - 100, 2))

    def test_edit_task_marks_the_user_correction(self):
        ident = self.log.upsert_task(card("旧标题"))
        status, task = self.log.edit_task(ident, 1, title="新标题", status="done")
        self.assertEqual(status, "ok")
        self.assertEqual((task["title"], task["status"], task["status_authority"], task["goal_authority"],
                          task["edited"], task["revision"]), ("新标题", "done", "user_corrected", "inferred", True, 2))
        self.log.upsert_task(card("模型标题", id=ident, status="active"))
        [task] = self.log.tasks()
        self.assertEqual((task["title"], task["status"], task["revision"]), ("新标题", "done", 3))
        self.assertEqual(self.log.edit_task("task-none", 1, title="x"), ("missing", None))

    def test_edit_task_with_a_stale_revision_is_a_conflict_and_changes_nothing(self):
        ident = self.log.upsert_task(card("标题"))
        self.log.upsert_task(card("标题二", id=ident))
        status, task = self.log.edit_task(ident, 1, goal="用户的目标")
        self.assertEqual((status, task["revision"], task["goal"]), ("conflict", 2, "目标"))
        [stored] = self.log.tasks()
        self.assertEqual((stored["goal"], stored["goal_authority"], stored["edited"], stored["revision"]),
                         ("目标", "inferred", False, 2))

    def test_inject_fits_the_limit_and_lists_at_most_ten_cards(self):
        for i in range(12):
            self.log.upsert_task(card(f"任务{i:02d}" + "很长的标题" * 30, last_at=T0 + i))
        self.log.upsert_task(card("搁置的", status="parked", last_at=T0 + 99))
        self.log.put_day("day", TODAY, {"timezone": "Asia/Shanghai", "headline": "h", "body": {},
                                        "inject": "今天在修 HostLink", "partial": True, "sources": [],
                                        "requires": []})
        text = self.log.inject(T0 + 3600)
        self.assertLessEqual(len(text), 2000)
        self.assertIn("今天在修 HostLink", text)
        self.assertLessEqual(text.count("任务"), 10)
        self.assertNotIn("搁置的", text)
        self.db.execute("UPDATE task_cards SET title = substr(title, 1, 4)")
        self.db.commit()
        listed = self.log.inject(T0 + 3600)
        self.assertEqual([f"任务{i:02d}" in listed for i in range(12)], [False, False] + [True] * 10)

    def test_inject_without_a_day_summary_says_so(self):
        self.log.upsert_task(card("修端口", next_step="重跑测试"))
        text = self.log.inject(T0 + 3600)
        self.assertIn("not summarized yet", text)
        self.assertIn("修端口", text)
        self.assertIn("重跑测试", text)
        self.assertEqual(WorkLog(self.db, lambda: "birch").inject(T0), "")

    def test_inject_skips_a_card_line_that_does_not_fit_whole(self):
        self.log.upsert_task(card("短卡", last_at=T0))
        self.log.upsert_task(card("超长" * 1100, last_at=T0 + 1))
        text = self.log.inject(T0 + 3600)
        self.assertLessEqual(len(text), 2000)
        self.assertNotIn("超长", text)
        self.assertIn("- 短卡 (Endfield, active): 进展; next step: 下一步", text.split("\n"))

    def test_inject_puts_yesterday_before_the_cards(self):
        for i in range(10):
            self.log.upsert_task(card(f"任务{i:02d}" + "标题" * 100, last_at=T0 + i))
        self.log.put_day("day", "2026-11-03", {"timezone": "Asia/Shanghai", "headline": "昨天修了端口", "body": {},
                                               "inject": "i", "partial": False, "sources": [], "requires": []})
        text = self.log.inject(T0 + 3600)
        self.assertLessEqual(len(text), 2000)
        self.assertIn("Yesterday: 昨天修了端口", text)
        self.assertLess(text.index("Yesterday: "), text.index("\n- "))

    def test_inject_ranks_cards_by_project_then_recency_then_next_step(self):
        self.log.upsert_task(card("别的项目", project="Other", last_at=T0 + 50))
        self.log.upsert_task(card("旧的有下一步", last_at=T0 - 3 * 86400))
        self.log.upsert_task(card("新的没下一步", next_step="", last_at=T0 + 40))
        self.log.upsert_task(card("新的有下一步甲", last_at=T0 + 10))
        self.log.upsert_task(card("新的有下一步乙", last_at=T0 + 20))
        text = self.log.inject(T0 + 3600, projects={"Endfield"})
        titles = [line[2:line.index(" (")] for line in text.split("\n") if line.startswith("- ")]
        self.assertEqual(titles, ["新的有下一步乙", "新的有下一步甲", "新的没下一步", "旧的有下一步", "别的项目"])

    def test_inject_leaves_out_a_card_without_progress_or_next_step(self):
        self.log.upsert_task(card("空卡", progress="", next_step=""))
        self.log.upsert_task(card("有进展", next_step=""))
        text = self.log.inject(T0 + 3600)
        self.assertNotIn("空卡", text)
        self.assertIn("有进展", text)

    def test_delete_permissions_removes_rows_that_required_the_revoked_consent(self):
        typed = self.segment("typed", requires=["typed_text", "page_text"])
        kept = self.segment("page", start=T0 + 700)
        for ident in (typed, kept):
            self.log.complete_segment(ident, L1)
        typed_task = self.log.upsert_task(card("打字任务", requires=["typed_text"]))
        page_task = self.log.upsert_task(card("页面任务", requires=["page_text"]))
        self.log.assign(kept, typed_task)
        for date, requires in (("2026-11-03", ["typed_text"]), (TODAY, ["page_text"])):
            self.log.put_day("day", date, {"timezone": "Asia/Shanghai", "headline": "h", "body": {}, "inject": "i",
                                           "partial": False, "sources": [], "requires": requires})
        deleted = self.log.delete_permissions({"typed_text"})
        self.assertEqual(set(deleted), {typed, typed_task, "day-2026-11-03"})
        self.assertEqual([s["id"] for s in self.log.sessions_on(TODAY)], [kept])
        self.assertEqual([t["id"] for t in self.log.tasks()], [page_task])
        self.assertIsNone(self.log.day("2026-11-03"))
        self.assertIsNotNone(self.log.day(TODAY))
        self.assertEqual([s["id"] for s in self.log.pending_sessions()], [kept])

    def test_delete_matching_removes_rows_a_hidden_title_appears_in(self):
        hidden = self.log.add_segment("foreground", "Secret|plan.doc", T0, T0 + 600, input_sha256="h",
                                      requires=[], sources=[])
        kept = self.segment()
        self.log.complete_segment(kept, L1)
        task = self.log.upsert_task(card("看 Secret 文档"))
        hides = lambda item: "Secret" in (item["app"] or "") or "Secret" in (item["title"] or "")  # noqa: E731
        self.assertEqual(set(self.log.delete_matching(hides)), {hidden, task})
        self.assertEqual([s["id"] for s in self.log.sessions_on(TODAY)], [kept])

    def test_clear_empties_the_three_tables(self):
        self.log.complete_segment(self.segment(), L1)
        self.log.upsert_task(card("任务"))
        before = self.log.generation
        self.assertEqual(self.log.clear(), {"session_summaries": 1, "task_cards": 1, "day_summaries": 0})
        self.assertEqual([self.count(t) for t in TABLES], [0, 0, 0])
        self.assertEqual(self.log.generation, before + 1)


if __name__ == "__main__":
    unittest.main()
