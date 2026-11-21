"""Episode store, recall and timeline regressions; generation is tested in test_character_agent_semantic."""
import datetime
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from personal import episodes
from personal.episodes import Episodes
from sessions import threads
from infra.store import checkpoint,open_store
from observation.blacklist import entry_hides
from api.views import _episode_json
from test_c6_fixtures import FIXTURES, mismatches
from support import add_episode
SPAN=600  # fixture interval, not a generation schedule

T0 = datetime.datetime(2026, 10, 24, 10, 0).timestamp()  # a local ten-minute boundary


PORT = {"subject": "服务器测试", "outcome": "卡在端口占用", "unresolved": ["端口为什么被占用"]}


def add(episodes, start, end, title="调试服务器", description="你在修复测试失败。", projects=(PORT,), **kw):
    return add_episode(episodes, start, end, title, description, projects, **kw)


class EpisodesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.episodes = Episodes(self.db, clock=lambda: T0 + 9999)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_episode_response_pins_the_thread_fields(self):
        fixture=json.loads((FIXTURES/'episodes.json').read_text(encoding="utf-8"))['episodes'][0]['threads'][0]
        loose=json.loads((FIXTURES/'loose-fields.json').read_text(encoding="utf-8"))
        nullable=[p.removeprefix('episodes[].threads[].') for p in loose['nullable']['episodes.json']
                  if p.startswith('episodes[].threads[].')]
        ident=add(self.episodes,T0,T0+600,projects=[{'subject':'修端口','goal':'通过测试','constraints':['本机'],
            'decisions':[{'decision':'重跑','reason':'核验'}],'outcome':'待核验','unresolved':['端口'],
            'next_steps':['重跑'],'evidence':['source-one']}],requires=['page_text'])
        row=_episode_json(self.episodes.get(ident))['threads'][0]
        self.assertEqual(mismatches(fixture,row,nullable+['session','status','blocked'],[]),[])
        self.assertEqual((row['source_ids'],row['evidence']),(['source-one'],[1]))

    def fts(self):
        return self.db.execute("SELECT COUNT(*) FROM episodes_fts").fetchone()[0]

    def test_between(self):
        first = add(self.episodes, T0, T0 + 600, apps=["Code", "x.Code"], hosts=["github.com"])
        add(self.episodes, T0 + 600, T0 + 900, "看文档", apps=["Safari"])
        [row] = self.episodes.between(T0 - 100, T0 + 1)
        self.assertEqual((row["id"], row["start"], row["end"], row["title"], row["version"]),
                         (first, T0, T0 + 600, "调试服务器", 3))
        self.assertEqual(([t["subject"] for t in row["threads"]], row["open_questions"]),
                         (["服务器测试"], ["端口为什么被占用"]))
        self.assertEqual((row["apps"], row["hosts"], row["created_at"]), (["Code", "x.Code"], ["github.com"], T0 + 9999))
        self.assertEqual([r["title"] for r in self.episodes.between(T0, T0 + 2000)], ["调试服务器", "看文档"])
        self.assertEqual(self.episodes.between(T0 + 900, T0 + 1000), [])

    def test_search_finds_chinese_bigrams_of_title_description_and_threads(self):
        add(self.episodes, T0, T0 + 600, apps=["Code"])
        add(self.episodes, T0 + 600, T0 + 1200, "看视频", "你在放松。", projects=(), apps=["Safari"])
        self.assertEqual([r["title"] for r in self.episodes.search("端口占用")], ["调试服务器"])
        self.assertEqual([r["title"] for r in self.episodes.search("放松")], ["看视频"])
        self.assertEqual(self.episodes.search("！"), [])
        self.assertEqual(self.fts(), 2)

    def test_deletes_take_their_index_rows(self):
        code = add(self.episodes, T0, T0 + 600, apps=["Code", "x.Code"])
        safari = add(self.episodes, T0 + 600, T0 + 1200, apps=["Safari", "com.apple.Safari"], hosts=["github.com"])
        notes = add(self.episodes, T0 + 1200, T0 + 1800, apps=["Notes"])
        self.assertEqual(self.episodes.delete_since(T0 + 1500), [notes])
        self.assertEqual(self.fts(), 2)
        hides = lambda window: entry_hides("domains", "github.com", window)  # noqa: E731
        self.assertEqual(self.episodes.delete_matching(hides), [safari])
        self.assertEqual([r["apps"] for r in self.episodes.between(0, T0 + 9999)], [["Code", "x.Code"]])
        self.assertEqual(self.fts(), 1)
        hides = lambda window: entry_hides("bundle_ids", "x.Code", window)  # noqa: E731
        self.assertEqual(self.episodes.delete_matching(hides), [code])
        self.assertEqual(self.episodes.delete_since(T0 + 9999), [])
        self.assertEqual(self.fts(), 0)
        add(self.episodes, T0, T0 + 600, apps=["Code"])
        self.assertEqual(self.episodes.clear(), 1)
        self.assertEqual((self.fts(), self.episodes.between(0, T0 + 9999), self.episodes.search("端口")), (0, [], []))

    def test_a_title_pattern_takes_episodes_whose_source_windows_it_matches(self):
        secret = add(self.episodes, T0, T0 + 600, apps=["Code"], titles=["病历 - 张三.pdf", "server.py"])
        named = add(self.episodes, T0 + 600, T0 + 1200, "看病历", apps=["Code"])
        kept = add(self.episodes, T0 + 1200, T0 + 1800, apps=["Code"], titles=["server.py"])
        hides = lambda window: entry_hides("title_patterns", "病历", window)  # noqa: E731
        self.assertEqual(self.episodes.delete_matching(hides), [secret, named])
        self.assertEqual([r["id"] for r in self.episodes.between(0, T0 + 9999)], [kept])
        self.assertEqual(self.fts(), 1)

    def test_a_revoked_permission_takes_the_episodes_whose_threads_require_it(self):
        typed = add(self.episodes, T0, T0 + 600, requires=["page_text", "typed_text"])
        page = add(self.episodes, T0 + 600, T0 + 1200, requires=["page_text"])
        self.assertEqual(self.episodes.delete_permissions({"typed_text"}, dry=True), [typed])
        self.assertEqual(self.episodes.delete_permissions({"typed_text"}), [typed])
        self.assertEqual([r["id"] for r in self.episodes.between(0, T0 + 9999)], [page])

    def test_a_deleted_episode_leaves_no_index_bytes_in_the_file_or_the_wal(self):
        path = Path(self.tmp.name) / "agentd.sqlite"
        marker = b"zqxmarker9137"
        add(self.episodes, T0, T0 + 600, apps=["Code"])
        add(self.episodes, T0 + 600, T0 + 1200, description="你在看 zqxmarker9137。", apps=["Code"])
        self.assertEqual(self.episodes.delete_since(T0 + 900), [2])
        checkpoint(self.episodes)
        wal = Path(f"{path}-wal")
        self.assertNotIn(marker, wal.read_bytes() if wal.exists() else b"")
        self.assertNotIn(marker, path.read_bytes())
        self.assertEqual(self.fts(), 1)

    def test_corrections_come_newest_first_up_to_limit_and_go_with_clear(self):
        first = add(self.episodes, T0, T0 + 600, apps=["Code"])
        second = add(self.episodes, T0 + 600, T0 + 1200, "看文档", apps=["Safari"])
        times = iter([T0 + 1, T0 + 2, T0 + 3])
        self.episodes.clock = lambda: next(times)
        self.assertEqual(self.episodes.edit(first, "修端口", "你在修端口。")["title"], "修端口")
        self.episodes.edit(second, "读文档", "你在读文档。")
        self.episodes.edit(first, "修好端口", "你修好了端口。")
        self.assertIsNone(self.episodes.edit(999, "x", "y"))
        self.assertEqual(self.episodes.corrections(limit=2), [
            {"episode_id": first, "at": T0 + 3, "old_title": "修端口", "old_description": "你在修端口。",
             "new_title": "修好端口", "new_description": "你修好了端口。"},
            {"episode_id": second, "at": T0 + 2, "old_title": "看文档", "old_description": "你在修复测试失败。",
             "new_title": "读文档", "new_description": "你在读文档。"}])
        self.assertEqual(len(self.episodes.corrections()), 3)
        self.assertEqual(self.episodes.get(first)["edited"], True)
        self.assertEqual(self.episodes.get(second)["edited"], True)
        self.assertIsNone(self.episodes.get(999))
        self.episodes.clear()
        self.assertEqual(self.episodes.corrections(), [])

    def test_a_deleted_id_is_never_given_again(self):
        add(self.episodes, T0, T0 + 600, apps=["Code"])
        last = add(self.episodes, T0 + 600, T0 + 1200, apps=["Code"])
        self.assertEqual(self.episodes.delete_since(T0 + 900), [last])
        self.assertEqual(add(self.episodes, T0 + 600, T0 + 1200, apps=["Code"]), last + 1)


class RecallTest(unittest.TestCase):
    NOW = datetime.datetime(2026, 10, 24, 15, 30).timestamp()  # local time

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.episodes = Episodes(self.db)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_time_range_reads_the_time_words_in_local_time(self):
        at = lambda day, hour: datetime.datetime(2026, 10, day, hour).timestamp()  # noqa: E731
        self.assertEqual(episodes.time_range("刚才在干嘛", self.NOW), (self.NOW - 1800, self.NOW, "刚才半小时"))
        self.assertEqual(episodes.time_range("昨天下午我在弄什么", self.NOW), (at(23, 12), at(23, 18), "昨天下午"))
        self.assertEqual(episodes.time_range("下午", self.NOW), (at(24, 12), self.NOW, "今天下午"))
        self.assertIsNone(episodes.time_range("今晚", self.NOW))  # it has not started: not a question about the past
        start, end, label = episodes.time_range("今天下午", self.NOW)
        self.assertEqual((start, end, label), (at(24, 12), self.NOW, "今天下午"))
        self.assertIsNone(episodes.time_range("我在干嘛", self.NOW))

    def test_a_time_word_recalls_at_most_six_episodes_of_its_range_first_and_last_kept(self):
        start = datetime.datetime(2026, 10, 23, 12, 0).timestamp()
        ids = [add(self.episodes, start + i * SPAN, start + (i + 1) * SPAN, f"第{i}段") for i in range(10)]
        label, rows, overview = self.episodes.recall("昨天下午我在弄什么", self.NOW)
        self.assertEqual(label, "昨天下午")
        self.assertEqual(len(rows), 6)
        self.assertEqual((rows[0]["id"], rows[-1]["id"]), (ids[0], ids[-1]))
        self.assertEqual([r["start"] for r in rows], sorted(r["start"] for r in rows))
        self.assertTrue(overview.startswith("12:00–12:10 第0段"))
        self.assertEqual(self.episodes.recall("前天上午呢", self.NOW), ("前天上午", [], None))

    def test_without_a_time_word_only_episodes_sharing_two_words_come_back(self):
        add(self.episodes, self.NOW - 9000, self.NOW - 8400, "修登录bug", "你在排查登录接口的报错。",
            projects=[{"subject": "登录接口", "outcome": "改了重试"}])
        add(self.episodes, self.NOW - 8400, self.NOW - 7800, "看视频", "你在放松。", projects=())
        label, rows, overview = self.episodes.recall("那个登录 bug 后来怎么样了", self.NOW)
        self.assertEqual((label, [r["title"] for r in rows], overview), (None, ["修登录bug"], None))
        self.assertTrue(self.episodes.search("你在干嘛呢"))  # 「你在」 matches both in the index
        self.assertEqual(self.episodes.recall("你在干嘛呢", self.NOW), (None, [], None))


def span(i, title, threads=()):
    """The i-th ten-minute episode from T0, as between() returns it."""
    return {"start": T0 + i * SPAN, "end": T0 + (i + 1) * SPAN, "title": title, "threads": list(threads)}


class DayArcTest(unittest.TestCase):
    def test_no_episodes_is_none(self):
        self.assertIsNone(threads.day_arc([]))

    def test_neighbours_with_one_title_merge_from_first_start_to_last_end(self):
        arc = threads.day_arc([span(0, "调试服务器"), span(1, "调试服务器"), span(2, "看文档"), span(3, "调试服务器")])
        self.assertEqual(arc, "10:00–10:20 调试服务器; 10:20–10:30 看文档; 10:30–10:40 调试服务器")

    def test_more_than_eight_spans_keep_eight_with_first_and_last(self):
        arc = threads.day_arc([span(i, f"事{i:02d}") for i in range(12)])
        parts = arc.split("; ")
        self.assertEqual(len(parts), threads.ARC_MAX)
        self.assertEqual((parts[0], parts[-1]), ("10:00–10:10 事00", "11:50–12:00 事11"))
        self.assertEqual(parts, sorted(parts))

    def test_a_long_arc_is_cut(self):
        arc = threads.day_arc([span(i, f"{i}" + "长" * 200) for i in range(4)])
        self.assertEqual(len(arc), threads.ARC_CHARS)
        self.assertTrue(arc.startswith("10:00–10:10 0" + "长" * 200 + "; 10:10–10:20 1"))

