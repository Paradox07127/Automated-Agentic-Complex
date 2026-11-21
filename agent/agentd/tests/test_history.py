import hashlib
from pathlib import Path
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain import characters  # noqa: E402
from personal.history import History  # noqa: E402
from infra.store import open_store  # noqa: E402

NAMES = {"aster": "示例甲", "voice_a_alt": "别人"}


class HistoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "agentd.db"
        self.db = open_store(self.path)
        self.now = 1000.0
        self.history = History(self.db, clock=lambda: self.now)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def add(self, user_text, reply, state="completed", character_id="aster", source="text"):
        self.now += 1
        return self.history.record(turn_id=f"t-{user_text}", source=source, character_id=character_id,
                                   persona_revision="abc", user_text=user_text, reply=reply, state=state,
                                   started_at=self.now - 0.5)

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_store_file_is_private_and_wal(self):
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(self.db.execute("PRAGMA journal_mode").fetchone()[0], "wal")

    def test_record_writes_one_row_with_its_event_id(self):
        event_id = self.add("你好", "你好呀")
        self.assertEqual([r["event_id"] for r in self.history.export()], [event_id])
        row = self.history.export()[0]
        self.assertEqual((row["turn_id"], row["source"], row["character_id"], row["persona_revision"]),
                         ("t-你好", "text", "aster", "abc"))
        self.assertEqual((row["user_text"], row["reply"], row["state"]), ("你好", "你好呀", "completed"))
        self.assertEqual((row["started_at"], row["ended_at"]), (1000.5, 1001.0))
        self.assertNotEqual(self.add("再来", "好"), event_id)

    def test_record_rejects_unknown_source_and_state(self):
        with self.assertRaises(ValueError):
            self.add("a", "b", source="email")
        with self.assertRaises(ValueError):
            self.add("a", "b", state="done")
        self.assertEqual(self.history.export(), [])

    def test_window_keeps_completed_turns_in_order(self):
        self.add("一", "壹")
        self.add("二", "贰", state="cancelled")
        self.add("三", "叁", state="failed")
        self.add("四", "肆")
        self.add("五", "伍", state="interrupted")
        self.assertEqual(self.history.window("aster", 8, NAMES), [
            [{"role": "user", "content": "一"}, {"role": "assistant", "content": "壹"}],
            [{"role": "user", "content": "四"}, {"role": "assistant", "content": "肆"}],
            [{"role": "user", "content": "五"}, {"role": "assistant", "content": "伍"}]])

    def test_window_keeps_the_last_max_turns(self):
        for i in range(5):
            self.add(f"问{i}", f"答{i}")
        window = self.history.window("aster", 3, NAMES)
        self.assertEqual([turn[0]["content"] for turn in window], ["问2", "问3", "问4"])

    def test_window_labels_other_speakers(self):
        self.add("一", "壹", character_id="voice_a_alt")
        self.add("二", "贰", character_id="stranger")
        self.add("三", "叁")
        replies = [turn[1]["content"] for turn in self.history.window("aster", 8, NAMES)]
        self.assertEqual(replies, ["(said by 别人) 壹", "(said by stranger) 贰", "叁"])

    def test_page_walks_back_from_the_newest(self):
        for i in range(5):
            self.add(f"问{i}", f"答{i}")
        rows, cursor = self.history.page(limit=2)
        self.assertEqual([r["user_text"] for r in rows], ["问4", "问3"])
        self.assertEqual(set(rows[0]), {"id", "event_id", "turn_id", "source", "character_id", "persona_revision",
                                        "user_text", "reply", "state", "started_at", "ended_at", "raw_reply",
                                        "conversation_id"})
        rows, cursor = self.history.page(before=cursor, limit=2)
        self.assertEqual([r["user_text"] for r in rows], ["问2", "问1"])
        rows, cursor = self.history.page(before=cursor, limit=2)
        self.assertEqual(([r["user_text"] for r in rows], cursor), (["问0"], None))
        rows, cursor = self.history.page(limit=5)
        self.assertEqual((len(rows), cursor), (5, None))

    def test_the_first_conversation_is_new_and_takes_its_first_line_as_title(self):
        title = lambda: self.db.execute("SELECT title FROM conversations WHERE id=?",  # noqa: E731
                                        (self.history.conversations.active,)).fetchone()[0]
        self.assertEqual(title(), "新对话")
        self.add("帮我看看日程\n第二行", "好")
        self.assertEqual(title(), "帮我看看日程")

    def test_page_rows_carry_their_conversation_id_or_none_without_a_link(self):
        unlinked = self.add("一", "壹")
        self.db.execute("DELETE FROM conversation_turns WHERE event_id = ?", (unlinked,))
        self.db.commit()
        self.add("二", "贰")
        rows, _ = self.history.page()
        self.assertEqual([(r["user_text"], r["conversation_id"]) for r in rows],
                         [("二", self.history.conversations.active), ("一", None)])

    def test_page_limit_is_bounded(self):
        for limit in (0, 201):
            with self.assertRaises(ValueError):
                self.history.page(limit=limit)
        self.assertEqual(self.history.page(limit=200), ([], None))

    def test_clear_and_export(self):
        self.add("一", "壹")
        self.add("二", "贰")
        self.assertEqual([r["user_text"] for r in self.history.export()], ["一", "二"])
        self.assertEqual(self.history.clear(), 2)
        self.assertEqual(self.history.export(), [])
        self.assertEqual(self.history.window("aster", 8, NAMES), [])

    def test_retract_leaves_the_window_and_blank_empties_the_words(self):
        self.add("我养了一只猫", "你养了一只猫啊")
        self.add("你好", "你好呀")
        self.add("天气", "晴")
        self.assertEqual(self.history.retract("t-我养了一只猫", blank=True), 1)
        self.assertEqual(self.history.retract("t-你好"), 1)
        self.assertEqual([(r["user_text"], r["reply"], r["raw_reply"], r["state"]) for r in self.history.export()],
                         [("", "", None, "cancelled"), ("你好", "你好呀", None, "cancelled"),
                          ("天气", "晴", None, "completed")])
        self.assertEqual([user["content"] for user, _ in self.history.window("aster", 8, NAMES)], ["天气"])

    def test_window_with_ids_names_each_turn(self):
        self.add("天气", "晴")
        self.add("部署", "部署好了")
        self.assertEqual([(turn_id, turn[0]["content"]) for turn_id, turn in
                          self.history.window("aster", 8, {}, with_ids=True)], [("t-天气", "天气"), ("t-部署", "部署")])

    def test_window_leaves_out_a_turn_with_nothing_heard(self):
        self.add("天气", "")
        self.add("部署", "部署好了")
        self.history.interrupt("t-部署", " ")
        self.add("测试", "都过了")
        self.assertEqual([user["content"] for user, _ in self.history.window("aster", 8, {})], ["测试"])

    def test_interrupt_takes_a_cancelled_row_only_for_a_line_cut_while_it_streamed(self):
        self.add("部署", "部署好了，后面还有很多", state="cancelled")
        self.history.interrupt("t-部署", "部署好了")
        self.assertEqual(self.history.export()[0]["state"], "cancelled")
        self.history.interrupt("t-部署", "部署好了", cut=True)
        [row] = self.history.export()
        self.assertEqual((row["state"], row["reply"], row["raw_reply"]), ("interrupted", "部署好了", "部署好了"))
        self.assertEqual(self.history.window("aster", 8, {})[0][1]["content"], "部署好了")
        self.assertEqual([r["turn_id"] for r in self.history.search("部署", skip_recent=0)], ["t-部署"])

    def test_interrupt_takes_an_interrupted_row_again_and_a_cancelled_one_only_when_cut(self):
        self.add("部署", "部署好了，后面还有很多", state="interrupted")
        self.add("天气", "晴天，后面还有很多")
        self.history.retract("t-天气")
        self.history.interrupt("t-部署", "部署好了，后面")
        self.history.interrupt("t-天气", "晴天")
        self.assertEqual([(r["state"], r["reply"]) for r in self.history.export()],
                         [("interrupted", "部署好了，后面"), ("cancelled", "晴天，后面还有很多")])
        self.assertEqual(self.history.search("很多", skip_recent=0), [])

    def resumed(self):
        self.now += 1
        return self.history.record(turn_id="t-resume", source="text", character_id="aster", persona_revision="abc",
                                   user_text="提醒我月底前续费", reply="好的", state="completed",
                                   started_at=self.now - 0.5, resume_run_id="character-1")

    def test_a_resumed_row_shows_no_user_text_to_the_ui_with_the_same_keys(self):
        self.add("你好", "你好呀")
        self.resumed()
        rows, _ = self.history.page()
        self.assertEqual([(r["user_text"], r["reply"]) for r in rows], [("", "好的"), ("你好", "你好呀")])
        self.assertEqual(set(rows[0]), set(rows[1]))
        turns = self.history.conversations.turns(self.history.conversations.active)["turns"]
        self.assertEqual([(r["user_text"], r["reply"]) for r in turns], [("你好", "你好呀"), ("", "好的")])
        self.assertEqual(set(turns[0]), set(turns[1]))

    def test_a_resumed_row_keeps_its_words_for_the_window_and_search(self):
        self.resumed()
        self.assertEqual(self.history.window("aster", 8, NAMES)[0][0]["content"], "提醒我月底前续费")
        self.assertEqual([r["turn_id"] for r in self.history.search("续费", skip_recent=0)], ["t-resume"])
        self.assertEqual(self.history.page(stored=True)[0][0]["user_text"], "提醒我月底前续费")

    def test_a_resumed_row_is_interrupted_and_retracted_by_its_own_turn_id(self):
        self.resumed()
        self.assertEqual(self.history.interrupt("t-resume", "听到的半句"), 1)
        self.assertEqual([(r["state"], r["reply"]) for r in self.history.export()], [("interrupted", "听到的半句")])
        self.assertEqual(self.history.retract("t-resume", blank=True), 1)
        self.assertEqual([(r["state"], r["user_text"], r["reply"]) for r in self.history.export()],
                         [("cancelled", "", "")])

    def test_store_overwrites_what_it_deletes(self):
        self.assertEqual(self.db.execute("PRAGMA secure_delete").fetchone()[0], 1)

    def test_rows_survive_a_reopen(self):
        event_id = self.add("你好", "你好呀")
        self.db.close()
        self.db = open_store(self.path)
        history = History(self.db)
        self.assertEqual([r["event_id"] for r in history.export()], [event_id])
        self.assertEqual(history.window("aster", 8, NAMES)[0][1]["content"], "你好呀")

    def test_persona_revision_is_the_card_hash(self):
        digest = hashlib.sha256(characters.card_path("aster").read_bytes()).hexdigest()[:12]
        self.assertEqual(characters.revision("aster"), digest)


if __name__ == "__main__":
    unittest.main()
