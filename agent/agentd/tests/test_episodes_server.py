"""GET /episodes?date= lists one day's episodes, DELETE /episodes/<id> takes one and the facts drawn from it."""
import datetime
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation.attention import AttentionStore  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from support import add_episode, deny_blacklist  # noqa: E402
from personal.episodes import Episodes  # noqa: E402
from personal.memory import Memory  # noqa: E402
from infra.store import open_store  # noqa: E402
import test_server  # noqa: E402

DAY1, DAY2 = "2026-10-22", "2026-10-23"


def at(day, hour, minute=0):
    return datetime.datetime.combine(datetime.date.fromisoformat(day), datetime.time(hour, minute)).timestamp()


def iso(ts):
    return datetime.datetime.fromtimestamp(ts).astimezone().isoformat(timespec="milliseconds")


def add(episodes, start, end, title, **kw):
    return add_episode(episodes, start, end, title, "你在写代码。", [{"subject": "测试", "outcome": "跑通了"}], **kw)


class EpisodesDayTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(tmp.cleanup)
        self.db = open_store(Path(tmp.name) / "agentd.sqlite")
        self.addCleanup(self.db.close)
        self.episodes = Episodes(self.db, clock=lambda: at(DAY2, 23))

    def test_day_lists_the_episodes_that_start_that_day_oldest_first(self):
        late = add(self.episodes, at(DAY2, 23, 50), at(DAY2, 23, 59), "晚", apps=["Code"], titles=["a.py"],
                   requires=["typed_text"])
        add(self.episodes, at(DAY1, 23, 55), at(DAY2, 0, 5), "跨夜", apps=["Code"])
        early = add(self.episodes, at(DAY2, 0, 0), at(DAY2, 0, 10), "早", apps=["Safari"], hosts=["github.com"])
        rows = self.episodes.day(datetime.date.fromisoformat(DAY2))
        self.assertEqual([r["id"] for r in rows], [early, late])
        thread = {"subject": "测试", "outcome": "跑通了", "requires": ["typed_text"], "scope_ids": [], "topic": "测试",
                  "session": "测试", "status": "unknown", "progress": "跑通了", "blocked": False}
        self.assertEqual(rows[1], {"id": late, "start": at(DAY2, 23, 50), "end": at(DAY2, 23, 59), "title": "晚",
                                   "description": "你在写代码。", "threads": [thread],
                                   "open_questions": [], "apps": ["Code"], "hosts": [], "created_at": at(DAY2, 23),
                                   "presence": "unknown", "user_actions": [], "agent_actions": [], "version": 3,
                                   "run_id": None, "edited": False, "owner": None, "outcome": None, "titles": ["a.py"],
                                   "typed": True})
        self.assertEqual(rows[0]["typed"], False)

    def test_delete_returns_the_ids_it_took(self):
        first = add(self.episodes, at(DAY2, 10), at(DAY2, 10, 10), "一")
        second = add(self.episodes, at(DAY2, 11), at(DAY2, 11, 10), "二")
        self.assertEqual(self.episodes.delete([first, 999]), [first])
        self.assertEqual([r["id"] for r in self.episodes.between(0, at(DAY2, 23))], [second])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM episodes_fts").fetchone()[0], 1)


class EpisodesServerTest(test_server.FeedServerCase):
    request = test_server.SayTest.request

    def setUp(self):
        super().setUp()
        self.server.character_agent = None  # these routes' paths without a character agent
        self.db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.addCleanup(self.db.close)
        self.episodes = self.server.episodes = Episodes(self.db, clock=lambda: at(DAY2, 23))
        self.memory = self.server.memory = Memory(self.db)
        self.server.share_page_text = True

    def test_get_lists_only_that_day_oldest_first(self):
        late = add(self.episodes, at(DAY2, 15), at(DAY2, 15, 10), "下午", apps=["Code"])
        add(self.episodes, at(DAY1, 9), at(DAY1, 9, 10), "昨天", apps=["Code"])
        early = add(self.episodes, at(DAY2, 9), at(DAY2, 9, 10), "上午", apps=["Code"])
        status, body = self.request("GET", f"/episodes?date={DAY2}")
        self.assertEqual((status, body["date"], body["enabled"]), (200, DAY2, True))
        self.assertEqual([e["id"] for e in body["episodes"]], [early, late])
        first = body["episodes"][0]
        self.assertEqual((first["start"], first["end"], first["created_at"]),
                         (iso(at(DAY2, 9)), iso(at(DAY2, 9, 10)), iso(at(DAY2, 23))))
        self.assertEqual((first["title"], first["apps"]), ("上午", ["Code"]))
        self.assertEqual(body["threads"], [])

    def test_get_brings_every_field_companion_decodes(self):
        add(self.episodes, at(DAY2, 9), at(DAY2, 9, 10), "修端口", apps=["Code"])
        status, body = self.request("GET", f"/episodes?date={DAY2}")
        self.assertEqual(status, 200)
        [episode] = body["episodes"]
        self.assertTrue({"id", "start", "end", "title", "description", "threads", "apps", "hosts", "typed"}
                        <= set(episode))
        self.assertIsInstance(episode["id"], int)
        self.assertTrue(all(isinstance(episode[k], str) for k in ("start", "end", "title", "description")))
        self.assertTrue(all(isinstance(episode[k], list) for k in ("threads", "apps", "hosts")))
        self.assertIsInstance(episode["typed"], bool)
        self.assertTrue(all(isinstance(t["topic"], str) and isinstance(t["progress"], str)
                            for t in episode["threads"]))

    def test_get_rejects_a_bad_date_and_needs_the_ui_token(self):
        for day in ("2026-13-01", "20261023", "2026-W43-4", "x"):
            self.assertEqual(self.request("GET", f"/episodes?date={day}"), (400, {"error": "invalid_date"}))
        self.assertEqual(self.request("GET", f"/episodes?date={DAY2}", token="nope")[0], 401)

    def test_get_without_page_text_is_disabled_and_empty(self):
        add(self.episodes, at(DAY2, 9), at(DAY2, 9, 10), "上午", apps=["Code"])
        self.server.share_page_text = False
        self.assertEqual(self.request("GET", f"/episodes?date={DAY2}"),
                         (200, {"date": DAY2, "enabled": False, "episodes": [], "threads": []}))

    def test_get_without_episodes_is_503(self):
        self.server.episodes = None
        self.assertEqual(self.request("GET", f"/episodes?date={DAY2}"), (503, {"error": "no_episodes"}))

    def test_delete_takes_the_episode_the_facts_drawn_from_it_and_the_batch_they_share(self):
        gone = add(self.episodes, at(DAY2, 9), at(DAY2, 9, 10), "上午", apps=["Code"])
        kept = add(self.episodes, at(DAY2, 10), at(DAY2, 10, 10), "中午", apps=["Code"])
        drawn = self.memory.add("常在上午写代码", "inferred_hypothesis", evidence=[f"episode:{gone}@{DAY2}"])
        both = self.memory.add("喜欢写测试", "observed_context",
                               evidence=[f"episode:{kept}@{DAY2}", f"episode:{gone}@{DAY2}"])
        other = self.memory.add("用 Code 写代码", "observed_context", evidence=[f"episode:{kept}@{DAY2}"])
        said = self.memory.add("我叫小明", "asserted_by_user")
        # both also names kept: its episode and the facts drawn from it go with the batch
        self.assertEqual(self.request("DELETE", f"/episodes/{gone}"), (200, {"deleted": 1, "facts": 3}))
        self.assertEqual(self.episodes.between(0, at(DAY2, 23)), [])
        left = {f["fact_id"] for f in self.memory.active()}
        self.assertEqual(left & {drawn, both, other, said}, {said})
        deleted = {i["data"]["fact_id"] for i in self.server.feed.since(0)
                   if i["event"] == "memory" and i["data"]["action"] == "deleted"}
        self.assertEqual(deleted, {drawn, both, other})

    def test_delete_of_an_unknown_or_non_numeric_id_is_404(self):
        self.assertEqual(self.request("DELETE", "/episodes/42"), (404, {"error": "unknown_episode"}))
        self.assertEqual(self.request("DELETE", "/episodes/abc")[0], 404)
        self.assertEqual(self.request("DELETE", "/episodes/1", token="nope")[0], 401)


class EpisodeV2EndpointsTest(test_server.FeedServerCase):
    """An episode's outcome and edited flag, its evidence, the user's edit, a day's runs."""
    request = test_server.SayTest.request

    def setUp(self):
        super().setUp()
        self.server.character_agent = None  # these routes' paths without a character agent
        state = Path(self.tmp.name)
        self.now = at(DAY2, 23)
        self.server.clock = lambda: self.now
        self.server.share_page_text = True
        self.server.attention = AttentionStore(state / "attention.sqlite", Blacklist(deny_blacklist(state / "blacklist.json")),
                                               clock=self.server.clock)
        self.addCleanup(self.server.attention.close)
        self.db = open_store(state / "agentd.sqlite")
        self.addCleanup(self.db.close)
        self.episodes = self.server.episodes = Episodes(self.db, clock=lambda: self.now)

    def episode(self, title="上午", hour=9):
        """An episode of DAY2 at hour; its id."""
        episode_id = add(self.episodes, at(DAY2, hour), at(DAY2, hour, 10), title, apps=["Code"])
        self.now = at(DAY2, hour, 11)
        return episode_id

    def corrections(self):
        return [row[0] for row in self.db.execute("SELECT episode_id FROM summary_corrections ORDER BY id")]

    def test_get_brings_each_episodes_outcome_and_edited(self):
        ran = self.episode()
        old = self.episode("旧的", hour=10)
        status, body = self.request("GET", f"/episodes?date={DAY2}")
        self.assertEqual(status, 200)
        self.assertEqual([(e["id"], e["outcome"], e["edited"]) for e in body["episodes"]],
                         [(ran, None, False), (old, None, False)])

    def test_evidence_of_an_episode_without_a_memory_run_is_gone(self):
        self.assertEqual(self.request("GET", f"/episodes/{self.episode()}/evidence"),
                         (410, {"error": "evidence_expired"}))

    def test_evidence_needs_a_known_episode_page_text_and_the_ui_token(self):
        episode_id = self.episode()
        unknown = (404, {"error": "unknown_episode"})
        self.assertEqual(self.request("GET", "/episodes/999/evidence"), unknown)
        self.assertEqual(self.request("GET", "/episodes/abc/evidence"), unknown)
        self.assertEqual(self.request("GET", f"/episodes/{episode_id}/evidence", token="nope")[0], 401)
        self.assertEqual(self.request("DELETE", f"/episodes/{episode_id}/evidence")[0], 404)
        self.server.share_page_text = False
        self.assertEqual(self.request("GET", f"/episodes/{episode_id}/evidence"), (403, {"error": "page_text_off"}))

    def test_patch_rewrites_the_title_description_and_index_and_records_the_correction(self):
        episode_id = self.episode("写代码")
        status, body = self.request("PATCH", f"/episodes/{episode_id}",
                                    {"title": "  重构日志模块  ", "description": "你在重构日志模块。"})
        self.assertEqual(status, 200)
        [listed] = self.request("GET", f"/episodes?date={DAY2}")[1]["episodes"]
        self.assertEqual(body, {"episode": listed})
        self.assertEqual((listed["title"], listed["description"], listed["edited"], listed["outcome"]),
                         ("重构日志模块", "你在重构日志模块。", True, None))
        self.assertEqual([e["id"] for e in self.episodes.search("日志")], [episode_id])
        self.assertEqual(self.episodes.search("写代码"), [])
        self.assertEqual(self.db.execute("SELECT episode_id, at, old_title, old_description, new_title,"
                                         " new_description FROM summary_corrections").fetchall(),
                         [(episode_id, self.now, "写代码", "你在写代码。", "重构日志模块", "你在重构日志模块。")])

    def test_patch_refuses_a_bad_title_or_description_an_unknown_id_and_without_consent(self):
        episode_id = self.episode()
        patch = lambda title="修端口", description="你在修端口。", path=f"/episodes/{episode_id}", **kw: \
            self.request("PATCH", path, {"title": title, "description": description}, **kw)  # noqa: E731
        for title in ("一" * 121, "   ", "", 5):
            with self.subTest(title=title):
                self.assertEqual(patch(title=title), (400, {"error": "invalid_title"}))
        for description in ("", "  ", "一" * 12001, None):
            with self.subTest(description=description):
                self.assertEqual(patch(description=description), (400, {"error": "invalid_description"}))
        self.assertEqual(patch(title="一" * 120, description="一" * 12000)[0], 200)
        self.assertEqual(patch(path="/episodes/999"), (404, {"error": "unknown_episode"}))
        self.assertEqual(patch(path="/episodes/abc"), (404, {"error": "unknown_episode"}))
        self.assertEqual(patch(token="nope")[0], 401)
        self.server.share_page_text = False
        self.assertEqual(patch(), (403, {"error": "page_text_off"}))
        self.server.share_page_text, self.server.resetting = True, True
        self.assertEqual(patch(), (503, {"error": "resetting"}))
        self.assertEqual(len(self.corrections()), 1)

    def test_deleting_an_episode_or_the_attention_takes_its_corrections(self):
        gone = self.episode("上午", hour=9)
        kept = self.episode("中午", hour=12)
        for episode_id in (gone, kept):
            self.assertEqual(self.request("PATCH", f"/episodes/{episode_id}",
                                          {"title": "改过", "description": "你改过了。"})[0], 200)
        self.assertEqual(self.request("DELETE", f"/episodes/{gone}")[0], 200)
        self.assertEqual(self.corrections(), [kept])
        self.server.trace = None
        self.assertEqual(self.request("DELETE", "/attention")[0], 200)
        self.assertEqual(self.corrections(), [])

    def test_runs_lists_native_generation_for_one_day_without_content(self):
        from character_agent.services.memory_service import MemoryJournal
        from types import SimpleNamespace
        memory=Memory(self.db,lock=self.episodes.lock)
        journal=MemoryJournal(memory,clock=lambda:self.now)
        self.server.character_agent=SimpleNamespace(memory_journal=journal,close=lambda:None)
        self.now=at(DAY2,10)
        turn=journal.turn('native-extract','', 'codex','native','aster',{'private':'原始证据'},purpose='memory_extract')
        turn.open(lambda:True);turn.finish('committed','原始输出')
        self.now=at(DAY2,11)
        other=journal.turn('native-state','', 'pi','native','aster',{},purpose='observation_interpret')
        other.open(lambda:True);other.finish('completed','{}')
        status,body=self.request('GET',f'/summary/runs?date={DAY2}')
        self.assertEqual(status,200);self.assertEqual([r['run_id'] for r in body['runs']],['native-extract'])
        self.assertEqual(body['runs'][0]['kind'],'memory_extract');self.assertEqual(body['runs'][0]['outcome'],'committed')
        self.assertNotIn('原始',json.dumps(body,ensure_ascii=False))
        state=self.request('GET',f'/summary/runs?date={DAY2}&kinds=observation_interpret')[1]['runs']
        self.assertEqual([r['run_id'] for r in state],['native-state'])

    def test_runs_lists_user_vision_beside_observation_vision(self):
        from character_agent.services.memory_service import MemoryJournal
        from types import SimpleNamespace
        journal=MemoryJournal(Memory(self.db,lock=self.episodes.lock),clock=lambda:self.now)
        self.server.character_agent=SimpleNamespace(memory_journal=journal,close=lambda:None)
        for hour,run_id,purpose in ((10,'shot-auto','observation_vision'),(11,'shot-user','user_vision')):
            self.now=at(DAY2,hour)
            turn=journal.turn(run_id,'','pi','native','aster',{},purpose=purpose)
            turn.open(lambda:True);turn.finish('completed','{}')
        status,body=self.request('GET',f'/summary/runs?date={DAY2}&kinds=user_vision')
        self.assertEqual(status,200);self.assertEqual([(r['run_id'],r['kind']) for r in body['runs']],[('shot-user','user_vision')])
        both=self.request('GET',f'/summary/runs?date={DAY2}&kinds=observation_vision,user_vision')[1]['runs']
        self.assertEqual([r['run_id'] for r in both],['shot-user','shot-auto'])

    def test_runs_refuses_bad_kinds_a_bad_date_and_other_tokens(self):
        for kinds in ("bogus", "episode,bogus", "episode,"):
            with self.subTest(kinds=kinds):
                self.assertEqual(self.request("GET", f"/summary/runs?date={DAY2}&kinds={kinds}"),
                                 (400, {"error": "invalid_kinds"}))
        self.assertEqual(self.request("GET", "/summary/runs?date=20261023"), (400, {"error": "invalid_date"}))
        self.assertEqual(self.request("GET", f"/summary/runs?date={DAY2}", token="nope")[0], 401)


if __name__ == "__main__":
    unittest.main()
