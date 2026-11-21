"""History.search over a persistent FTS5 index, bigrams for CJK, words for the rest, ranked by bm25."""
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from personal.history import History, terms  # noqa: E402
from infra.store import SCHEMA, open_store  # noqa: E402

DAY = 86400.0
FIELDS = {"id", "turn_id", "character_id", "source", "user_text", "reply", "started_at"}


class HistorySearchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "agentd.db"
        self.db = open_store(self.path)
        self.now = 1_760_000_000.0
        self.history = History(self.db, clock=lambda: self.now)
        self.n = 0

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def add(self, user_text, reply, state="completed", source="text", character_id="aster"):
        self.n += 1
        self.now += 60
        turn_id = f"t-{self.n}"
        self.history.record(turn_id=turn_id, source=source, character_id=character_id, persona_revision="abc",
                            user_text=user_text, reply=reply, state=state, started_at=self.now - 1)
        return turn_id

    def month(self):
        """30 days of small talk with a few turns worth finding; the newest 8 turns are small talk and one 部署."""
        marked = {}
        start = self.now
        for day in range(30):
            self.now = start + day * DAY
            for i in range(4):
                self.add(f"第{day}天第{i}轮闲聊", "嗯嗯，记下了")
            if day == 3:
                marked["deploy"] = self.add("帮我部署一下服务", "好的，开始部署")
            if day == 5:
                marked["split"] = self.add("部门开会了", "署名写谁")
            if day == 8:
                marked["code"] = self.add("构建报错 E1203", "E1203 是签名过期")
            if day == 10:
                marked["stale"] = self.add("dispatch 返回 decision_stale", "那张卡片过期了")
            if day == 12:
                marked["pnpm"] = self.add("pnpm 装不上怎么办", "试试换个源")
            if day == 14:
                marked["npm"] = self.add("npm 又装不了", "清一下缓存")
            if day == 15:
                marked["fast"] = self.add("pnpm 真的很快 pnpm", "是的")
        for i in range(7):
            self.add(f"最后几轮{i}", "好")
        marked["recent"] = self.add("再部署一次", "好")
        return marked

    def turn_ids(self, query, **kwargs):
        return [hit["turn_id"] for hit in self.history.search(query, **kwargs)]

    def test_terms_are_cjk_bigrams_and_lowercase_words(self):
        self.assertEqual(terms("Pnpm 装不上 E1203, 部 decision_stale"),
                         ["pnpm", "装不", "不上", "e1203", "部", "decision", "stale"])
        self.assertEqual(terms("…！"), [])

    def test_two_character_query_finds_the_turn_and_not_its_single_characters(self):
        marked = self.month()
        self.assertEqual(self.turn_ids("部署"), [marked["deploy"]])
        hit = self.history.search("部署")[0]
        self.assertEqual(set(hit), FIELDS)
        self.assertEqual((hit["user_text"], hit["reply"], hit["character_id"]),
                         ("帮我部署一下服务", "好的，开始部署", "aster"))

    def test_error_codes_are_found(self):
        marked = self.month()
        self.assertEqual(self.turn_ids("E1203"), [marked["code"]])
        self.assertEqual(self.turn_ids("decision_stale"), [marked["stale"]])

    def test_mixed_query_ranks_the_turn_with_both_first(self):
        marked = self.month()
        self.assertEqual(self.turn_ids("pnpm 装不上")[0], marked["pnpm"])

    def test_the_newest_turns_are_skipped(self):
        marked = self.month()
        self.assertNotIn(marked["recent"], self.turn_ids("部署"))
        self.assertCountEqual(self.turn_ids("部署", skip_recent=0), [marked["recent"], marked["deploy"]])

    def test_an_empty_query_finds_nothing(self):
        self.month()
        self.assertEqual(self.history.search("，。！"), [])

    def test_cancelled_and_failed_turns_are_not_indexed(self):
        self.add("取消的部署", "x", state="cancelled")
        self.add("失败的部署", "x", state="failed")
        self.assertEqual(self.history.search("部署", skip_recent=0), [])

    def test_retracted_turn_is_not_found(self):
        marked = self.month()
        self.assertEqual(self.history.retract(marked["code"]), 1)
        self.assertEqual(self.history.search("E1203"), [])

    def test_interrupted_turn_is_found_only_by_what_was_heard(self):
        turn_id = self.add("讲讲 kubernetes", "kubernetes 的调度器很复杂")
        self.assertEqual(self.history.interrupt(turn_id, "kubernetes 的"), 1)
        self.assertEqual(self.history.search("调度", skip_recent=0), [])
        hits = self.history.search("kubernetes", skip_recent=0)
        self.assertEqual([(h["turn_id"], h["reply"]) for h in hits], [(turn_id, "kubernetes 的")])

    def test_clear_empties_the_index(self):
        self.month()
        self.history.clear()
        self.assertEqual(self.history.search("部署", skip_recent=0), [])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM history_fts").fetchone()[0], 0)

    def test_only_typed_and_spoken_turns_are_found(self):
        typed = self.add("帮我部署一下服务", "好")
        spoken = self.add("部署好了吗", "好了", source="voice")
        self.add("要不要部署", "嗯", source="proactive")
        self.add("部署完成", "嗯", source="announce")
        self.assertCountEqual(self.turn_ids("部署", skip_recent=0), [typed, spoken])
        self.assertEqual({hit["source"] for hit in self.history.search("部署", skip_recent=0)}, {"text", "voice"})

    def test_other_characters_turns_are_left_out(self):
        own = self.add("帮我部署一下服务", "好")
        other = self.add("部署好了吗", "好了", character_id="birch")
        self.assertEqual(self.turn_ids("部署", skip_recent=0, character_id="aster"), [own])
        self.assertCountEqual(self.turn_ids("部署", skip_recent=0), [own, other])

    def test_skip_recent_counts_only_this_characters_typed_and_spoken_turns(self):
        deploy = self.add("帮我部署一下服务", "好")
        self.add("闲聊", "好")
        for i in range(3):
            self.add(f"闲聊{i}", "好", character_id="birch")
            self.add(f"主动{i}", "好", source="proactive")
        self.assertEqual(self.turn_ids("部署", skip_recent=1, character_id="aster"), [deploy])
        self.assertEqual(self.turn_ids("部署", skip_recent=2, character_id="aster"), [])

    def test_rows_from_before_the_index_are_backfilled(self):
        self.db.close()
        path = Path(self.tmp.name) / "old.db"
        old = sqlite3.connect(str(path))
        old.execute(SCHEMA[0])
        for i, (user_text, state) in enumerate((("老的部署记录", "completed"), ("被打断的 E1203", "interrupted"),
                                                ("撤回的部署", "cancelled"))):
            old.execute("INSERT INTO history_turns (event_id, turn_id, source, character_id, user_text, reply,"
                        " state, started_at, ended_at) VALUES (?, ?, 'text', 'aster', ?, '好', ?, ?, ?)",
                        (f"e{i}", f"old-{i}", user_text, state, 100.0 + i, 101.0 + i))
        old.commit()
        old.close()
        self.db = open_store(path)
        history = History(self.db)
        self.assertEqual([h["turn_id"] for h in history.search("部署", skip_recent=0)], ["old-0"])
        self.assertEqual([h["turn_id"] for h in history.search("e1203", skip_recent=0)], ["old-1"])
        History(self.db)  # a second start indexes nothing twice
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM history_fts").fetchone()[0], 2)


if __name__ == "__main__":
    unittest.main()
