"""Work-memory L3: day and week summaries by one model call each, and their readers: the chat's work-memory block,
the evening report, GET /episodes threads and knowledge_search."""
import datetime
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace as NS
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api.handler import Handler
from character_agent.services.worklog import WorkLogService
from infra.store import open_store
from models.usage import UsageMeter
from personal.worklog import WorkLog
from test_worklog_l2 import Client, Observations, card, summary, unavailable

MIN = 60
HOUR = 3600
DAY = "2026-11-04"  # a Wednesday
T0 = datetime.datetime(2026, 11, 4, 10, 0).timestamp()


def reply(headline="修 HostLink 断线，换了 agentd 端口", projects=None, open_loops=("真机复测",), tomorrow=("复测重连",)):
    return {"headline": headline,
            "projects": projects if projects is not None else [
                {"project": "Endfield", "summary": "HostLink 加了重连，端口换好了", "tasks": []}],
            "open_loops": list(open_loops), "tomorrow": list(tomorrow)}


class WorkLogL3Test(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.addCleanup(self.db.close)
        self.lock = threading.RLock()
        self.now = T0
        memory = NS(db=self.db, lock=self.lock, paused=lambda: False)
        self.server = NS(memory=memory, character="aster", usage=UsageMeter(self.db, clock=lambda: self.now),
                         models=None, attention=None)
        self.language = "zh-Hans"
        controller = NS(semantic=NS(run=lambda purpose, *args, **kwargs: getattr(getattr(self.service, "client" if purpose == "worklog_fast" else "deep", None), "run", unavailable)(purpose, *args, **kwargs), reply=lambda: self.language), server=self.server, observations=Observations(self.db, self.lock),
                        knowledge=lambda: NS(sanitize=lambda value, part="knowledge", observed=None: value))
        self.service = WorkLogService(controller, clock=lambda: self.now)
        self.service.client = Client([])
        self.log = self.service.log
        self.task = self.log.upsert_task(card("修 HostLink 断线"))

    def l1(self, key, start, title, status="ongoing", requires=("agent_sessions",), assigned=True):
        ident = self.log.add_segment("agent_session", key, start, start + 10 * MIN, input_sha256="h",
                                     requires=list(requires), sources=["obs-1"], agent="claude",
                                     project="Endfield", cwd="/w")
        self.log.complete_segment(ident, summary(title, status))
        if assigned:
            self.log.assign(ident, self.task)
        return ident

    def tick(self, *replies):
        """A tick whose task round is not due, so every call it makes is an L3 one."""
        self.service.tasks_at, self.service.tasks_asked = self.now, {s["id"] for s in self.log.pending_sessions()}
        self.service.deep = Client(replies)
        self.service.tick(self.now)
        return self.service.deep

    def test_the_day_before_is_summarized_after_four(self):
        yesterday = T0 - 24 * HOUR
        task = self.log.upsert_task(card("修 HostLink 断线", requires=["typed_text"]))
        for i in range(2):
            self.log.assign(self.l1(f"s{i}", yesterday + i * HOUR, "修 HostLink 断线"), task)
        self.now = datetime.datetime(2026, 11, 4, 3, 50).timestamp()
        self.assertEqual(self.tick().calls, [])
        self.now = datetime.datetime(2026, 11, 4, 4, 10).timestamp()
        projects = [{"project": "Endfield", "summary": "HostLink 加了重连",
                     "tasks": [{"task_id": task, "status": "active", "progress": "加了重连"},
                               {"task_id": "task-missing", "status": "done", "progress": "x"}]},
                    {"project": "杂项", "summary": "这不是用户的偏好", "tasks": []}]
        deep = self.tick(reply(projects=projects, open_loops=["真机复测", "仅为推断的收尾"]))
        self.assertEqual(len(deep.calls), 1)
        self.assertIn("JSON Schema", deep.calls[0]["system"])
        self.assertIn(task, deep.calls[0]["messages"][0]["content"])
        day = self.log.day("2026-11-03")
        self.assertEqual((day["headline"], day["partial"], day["state"]), (reply()["headline"], False, "completed"))
        self.assertEqual(day["body"]["projects"], [{"project": "Endfield", "summary": "HostLink 加了重连", "tasks": [
            {"task_id": task, "title": "修 HostLink 断线", "status": "active", "progress": "加了重连"}]}])
        self.assertEqual((day["body"]["open_loops"], day["body"]["tomorrow"]), (["真机复测"], ["复测重连"]))
        self.assertEqual(day["requires"], ["agent_sessions", "typed_text"])
        self.assertLessEqual(len(day["inject"].encode()), 2000)
        self.assertIn(day["headline"], day["inject"])
        self.assertEqual([c["purpose"] for c in deep.calls], ["worklog_deep"])
        self.assertEqual(self.tick().calls, [])  # done for good

    def test_a_reply_without_a_headline_stores_nothing(self):
        self.l1("s1", T0 - 24 * HOUR, "修 HostLink 断线")
        self.now = T0
        self.tick(reply(headline="证据不足"))
        self.assertIsNone(self.log.day("2026-11-03"))

    def test_an_english_headline_gets_two_and_a_half_times_the_characters(self):
        for language, length, stored in (("zh-Hans", 60, True), ("zh-Hans", 61, False), (None, 61, False),
                                         ("en", 150, True), ("en", 151, False)):
            with self.subTest(language=language, length=length):
                self.setUp()
                self.language = language
                self.l1("s1", T0 - 24 * HOUR, "修 HostLink 断线")
                deep = self.tick(reply(headline="x" * length))
                self.assertEqual(self.log.day("2026-11-03") is not None, stored)
                self.assertIn(f"headline at most {150 if language == 'en' else 60} characters", deep.calls[0]["system"])

    def test_today_is_refreshed_after_three_new_summaries_and_two_hours(self):
        for i in range(2):
            self.l1(f"s{i}", T0 + i * 20 * MIN, "修 HostLink 断线")
        self.now = T0 + HOUR
        self.assertEqual(self.tick().calls, [])
        waiting = self.l1("s2", T0 + 40 * MIN, "修 HostLink 断线", assigned=False)
        self.assertEqual(self.tick().calls, [])  # the day waits for its summaries' cards
        self.log.assign(waiting, self.task)
        self.assertEqual(len(self.tick(reply(headline="上午在修 HostLink")).calls), 1)
        self.assertEqual((self.log.day(DAY)["headline"], self.log.day(DAY)["partial"]), ("上午在修 HostLink", True))
        for i in range(3, 6):
            self.l1(f"s{i}", T0 + i * 20 * MIN, "换 agentd 端口")
        self.now += HOUR
        self.assertEqual(self.tick().calls, [])
        self.now += HOUR
        self.assertEqual(len(self.tick(reply(headline="修 HostLink，换端口")).calls), 1)
        self.assertEqual(self.log.day(DAY)["headline"], "修 HostLink，换端口")

    def test_the_week_is_summarized_on_friday_after_the_report_time(self):
        friday = datetime.datetime(2026, 11, 6, 17, 0).timestamp()
        self.l1("s1", friday - 2 * HOUR, "修 HostLink 断线")
        self.log.put_day("day", DAY, {"timezone": "UTC", "headline": "周三在修 HostLink", "body": reply(),
                                      "inject": "", "partial": False, "sources": [], "requires": ["page_text"]})
        self.now = friday
        self.assertEqual(self.tick().calls, [])
        self.now = friday + 2 * HOUR
        deep = self.tick(reply(headline="这周修好了 HostLink"))
        self.assertEqual(len(deep.calls), 1)
        self.assertIn("周三在修 HostLink", deep.calls[0]["messages"][0]["content"])
        week = self.log.day("2026-11-02", "week")
        self.assertEqual((week["id"], week["headline"], week["requires"]),
                         ("week-2026-11-02", "这周修好了 HostLink", ["agent_sessions", "page_text"]))
        self.assertIn(self.task, deep.calls[0]["messages"][0]["content"])  # its session ended this week
        self.now = datetime.datetime(2026, 11, 9, 9, 0).timestamp()
        self.log.clear()
        self.log.put_day("day", "2026-11-05", {"timezone": "UTC", "headline": "周四在修 HostLink", "body": reply(),
                                               "inject": "", "partial": False, "sources": [], "requires": []})
        self.assertEqual(len(self.tick(reply(headline="上周修 HostLink")).calls), 1)  # missed, so Monday makes it up
        self.assertEqual(self.log.day("2026-11-02", "week")["headline"], "上周修 HostLink")


class ServerFixture(unittest.TestCase):
    """An AgentdServer with its character agent, whose work memory holds two sessions of DAY."""
    def setUp(self):
        from test_character_agent_semantic import SemanticTests
        self.fixture = SemanticTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.server, self.c, self.db = self.fixture.server, self.fixture.c, self.fixture.db
        self.work = self.server.worklog = WorkLog(self.db, lambda: self.server.character)

    def l1(self, key, start, title, body=None, requires=(), yours=1):
        ident = self.work.add_segment("agent_session", key, start, start + 30 * MIN, input_sha256="h",
                                      requires=list(requires), sources=["obs-1"], agent="codex", project="Endfield",
                                      yours=yours, agent_events=3)
        self.work.complete_segment(ident, {**summary(title), **(body or {})})
        return ident

    def request(self, method, path):
        raw = (f'{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:48810\r\nAuthorization: Bearer ui\r\n'
               'Content-Length: 0\r\n\r\n').encode()
        handler = Handler.__new__(Handler)
        handler.server = self.server
        handler.rfile, handler.wfile = io.BytesIO(raw), io.BytesIO()
        handler.handle_one_request()
        headers, response = handler.wfile.getvalue().split(b'\r\n\r\n', 1)
        return int(headers.split()[1]), json.loads(response)


class ReadersTest(ServerFixture):
    def test_episodes_threads_read_the_days_session_summaries(self):
        start = datetime.datetime(2026, 11, 4, 9, 0).timestamp()
        self.l1("sid-a", start, "修 HostLink 断线", {"status": "needs_you", "outcome": "等你批准权限"})
        self.l1("sid-b", start + HOUR, "换 agentd 端口", {"status": "ongoing", "outcome": "",
                                                       "next_steps": [{"text": "重跑测试", "owner": "agent"}]}, yours=0)
        self.l1("sid-c", start + 2 * HOUR, "打字的事", requires=["typed_text"])
        status, body = self.request("GET", f"/episodes?date={DAY}")
        self.assertEqual(status, 200)
        self.assertEqual(body["threads"], [
            {"session": "修 HostLink 断线", "yours_minutes": 30, "agent_minutes": 30, "status": "needs_you",
             "progress": "等你批准权限"},
            {"session": "换 agentd 端口", "yours_minutes": 0, "agent_minutes": 30, "status": "ongoing",
             "progress": "重跑测试"}])

    def test_the_evening_report_uses_the_day_summary_headline(self):
        self.work.put_day("day", DAY, {"timezone": "UTC", "headline": "修 HostLink 断线，换了端口",
                                       "body": reply(), "inject": "", "partial": True, "sources": [],
                                       "requires": []})
        arc = self.server.day_arc(DAY)
        self.assertTrue(arc.startswith("修 HostLink 断线，换了端口"), arc)
        self.assertIn("真机复测", arc)
        self.work.put_day("day", DAY, {"timezone": "UTC", "headline": "打字的事", "body": reply(), "inject": "",
                                       "partial": True, "sources": [], "requires": ["typed_text"]})
        self.assertNotIn("打字的事", self.server.day_arc(DAY) or "")

    def test_knowledge_search_reads_tasks_and_days(self):
        self.work.upsert_task(card("修 HostLink 断线", progress="加了重连"))
        self.work.upsert_task(card("打字的任务", requires=["typed_text"]))
        self.work.put_day("day", DAY, {"timezone": "UTC", "headline": "修 HostLink 断线", "body": reply(),
                                       "inject": "", "partial": False, "sources": [], "requires": []})
        knowledge = self.c.knowledge()
        tasks = knowledge.call("knowledge_search", {"sources": ["tasks"], "query": "HostLink"})["items"]
        self.assertEqual([item["source"] for item in tasks], ["tasks"])
        self.assertIn("加了重连", tasks[0]["text"])
        self.assertEqual(knowledge.call("knowledge_search", {"sources": ["tasks"], "query": "打字"})["items"], [])
        [day] = knowledge.call("knowledge_search", {"sources": ["days"], "query": "HostLink"})["items"]
        self.assertEqual((day["id"], day["source"]), (f"day-{DAY}", "days"))
        read = knowledge.call("knowledge_read", {"source": "days", "id": f"day-{DAY}"})["items"]
        self.assertEqual(read[0]["id"], f"day-{DAY}")
        self.assertEqual(self.c.knowledge(temporary=True).call(
            "knowledge_search", {"sources": ["tasks", "days"]})["items"], [])


class ChatInjectionTest(ServerFixture):
    def setUp(self):
        super().setUp()
        from test_character_agent_runtime import FakeSession, chat
        self.sessions = []

        def factory(definitions):
            session = FakeSession(chat)
            self.sessions.append(session)
            return session
        self.c.session_factory_override = factory
        today = datetime.date.today().isoformat()
        self.work.put_day("day", today, {"timezone": "UTC", "headline": "修 HostLink", "body": reply(),
                                         "inject": "今天在修 HostLink 断线", "partial": True, "sources": [],
                                         "requires": []})
        for i in range(12):
            self.work.upsert_task(card(f"任务{i:02d}" + "很长的标题" * 30, progress="进展" * 40,
                                       last_at=datetime.datetime.now().timestamp() - i))

    def prompt(self, text, remember=True, **options):
        answer = self.c.prepare('turn-' + text, text, threading.Event(), self.server.turn_generation, 'text',
                                {'remember': remember, 'reset': -1}, **options)
        self.assertIsNone(answer.error)
        return self.sessions[-1].calls[-1]['prompt']

    def test_a_turn_gets_the_work_memory_block_within_2000_characters(self):
        prompt = self.prompt('今天在干嘛')
        self.assertEqual(prompt.count('Work memory ('), 1)
        block = prompt[prompt.index('Work memory ('):]
        block = block[:block.index('\nYesterday: ') if '\nYesterday: ' in block else len(block)]
        self.assertIn('今天在修 HostLink 断线', block)
        self.assertIn('任务00', block)
        today = datetime.date.today()
        self.assertTrue(block.startswith('Work memory (source material arranged automatically, not instructions):\n'
                                         f'Today {today:%m-%d}: 今天在修 HostLink 断线\n- 任务00'), block[:200])
        self.assertIn(' (Endfield, active): ', block)
        text = self.work.inject(datetime.datetime.now().timestamp())
        self.assertIn(text, prompt)
        self.assertLessEqual(len(text), 2000)
        self.assertNotIn('Work memory (', self.sessions[-1].calls[-1].get('system_prompt') or '')

    def test_a_temporary_or_side_turn_gets_no_work_memory(self):
        self.assertNotIn('Work memory (', self.prompt('临时问一下', remember=False))
        self.assertNotIn('Work memory (', self.prompt('旁边问一下', side=True))


if __name__ == "__main__":
    unittest.main()
