"""Unified reset from the control panel: POST /reset stops the writers, clears every user-data store and checks it."""
import http.client
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation.attention import AttentionStore  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from support import add_episode, deny_blacklist  # noqa: E402
from brain.egress import EgressPolicy  # noqa: E402
from observation.capture import CaptureManager  # noqa: E402
from character.character_state import CharacterState  # noqa: E402
from personal.schedules import Schedules
from personal.commitments import Commitments  # noqa: E402
from personal.episodes import Episodes  # noqa: E402
from personal.worklog import WorkLog  # noqa: E402
from character.proactive_log import ProactiveLog  # noqa: E402
from character.gate import Gate  # noqa: E402
from personal.history import History  # noqa: E402
from character.judge import Judge, RulesBackend  # noqa: E402
from personal.memory import Memory  # noqa: E402
from personal.rituals import Rituals
from character.proactive import Proactive  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from sessions.own import OwnSession, SessionManager  # noqa: E402
from support import enable_plugins
from infra.store import open_store  # noqa: E402
from sessions.tasks import TaskLedger  # noqa: E402
from test_sessions import fake_argv  # noqa: E402
from test_turn import relay_for  # noqa: E402
from test_server import KernelLines  # noqa: E402
from traces.trace_store import TraceStore  # noqa: E402
from support import serve_in_thread  # noqa: E402

HOOK, UI = "hook-token", "ui-token"
CONFIRM = {"confirm": "delete all local data"}
CLEARED = {"agentd.sqlite": ("history_turns", "own_sessions", "trace_events", "facts", "fact_uses", "fact_sightings", "fact_marks", "ritual_log", "character_state", "character_state_log",
                            "desk_log",
                            "tasks", "task_events", "commitments", "schedules", "schedule_runs", "ritual_pending", "own_session_lines",
                            "idempotency_receipts", "episodes",
                            "summary_corrections", "session_summaries", "task_cards", "day_summaries", "proactive_log",
                            "agent_memory_processed", "memory_tombstones", "memory_agent_runs", "memory_agent_events", "personal_goals", "personal_jobs",
                            "personal_job_events", "personal_job_leases", "conversations", "conversation_turns",
                            "conversation_settings", "session_management", "personal_job_runs", "personal_deliveries",
                            "personal_delivery_events", "observation_briefs", "observation_brief_failures", "observation_content", "observation_frames", "observation_analyses", "observation_work_events", "observation_processed", "observation_input_identity", "observation_aliases"),
           "attention.sqlite": ("events", "context", "events_raw")}
KEPT = ("memory_settings", "capture_budget", "model_usage", "gate_day")
LOGS = ("capture.jsonl", "capture-judge.jsonl", "proactive-judge.jsonl")


class ScheduleResetTest(unittest.TestCase):
    def test_reset_clears_schedules_and_runs(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as root:
            db = open_store(Path(root) / 'agentd.sqlite')
            self.addCleanup(db.close)
            with patch.object(AgentdServer, 'server_bind'), patch.object(AgentdServer, 'server_activate'):
                server = AgentdServer(('127.0.0.1', 48810), HOOK, UI)
            self.addCleanup(server.server_close)
            server._stopped.set(); server._ticker.join(2)
            server.memory = Memory(db)
            schedules = Schedules(db, lock=server.memory.lock)
            item = schedules.add('日报', '总结提交', {'kind': 'daily', 'at': '18:30', 'weekdays': [1, 2, 3, 4, 5]})
            schedules.run_now(item['schedule_id'])
            status, body = server.reset()
            self.assertEqual(status, 200, body)
            for table in ('schedules', 'schedule_runs'):
                self.assertEqual(body['deleted'][table], 1)
                self.assertEqual(body['rows'][table], 0)

    def test_reset_retires_dispatch_cards_before_it_stops_sessions(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as root:
            db = open_store(Path(root) / 'agentd.sqlite')
            self.addCleanup(db.close)
            with patch.object(AgentdServer, 'server_bind'), patch.object(AgentdServer, 'server_activate'):
                server = AgentdServer(('127.0.0.1', 48810), HOOK, UI)
            self.addCleanup(server.server_close)
            server._stopped.set(); server._ticker.join(2)
            server.memory = Memory(db)
            card = server.broker.open("agentd", "d-1", "codex", tool_summary="x", kind="dispatch",
                                      dispatch={"target": "codex", "cwd": root, "prompt": "x"}, window=600.0)
            seen = []

            class Sessions:
                store = None

                def stop_all(self, timeout):
                    seen.append(card.status)  # an allow on a card still pending here would start a session
            server.sessions = Sessions()
            status, body = server.reset()
            self.assertEqual(status, 200, body)
            self.assertEqual(seen, ["cancelled"])


class ResetTest(unittest.TestCase):
    def setUp(self):
        enable_plugins(self)
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.state = state = Path(self.tmp.name)
        self.db = state / "agentd.sqlite"
        server = self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
        server.character = "aster"  # these fixtures start as aster and switch to birch
        server.character_agent = KernelLines(server)
        server.broker.window = 5.0
        server.history = History(open_store(self.db), character_id=server.character)
        server.memory = Memory(open_store(self.db))
        server.rituals = Rituals(open_store(self.db))
        server.trace = TraceStore(open_store(self.db), producer_epoch=server.registry.epoch)
        server.sessions = server.dispatcher.sessions = SessionManager(
            server.broker, server.announce, state, f"http://127.0.0.1:{server.server_port}", HOOK, hook_timeout=10,
            argv=fake_argv, store=open_store(self.db))
        server.attention = AttentionStore(state / "attention.sqlite", Blacklist(deny_blacklist(state / "blacklist.json")))
        server.capture = CaptureManager(server.feed, server.attention.blacklist, server.attention.focus,
                                        state / "capture.jsonl", judge_log=state / "capture-judge.jsonl",
                                        budget_db=open_store(self.db))
        server.proactive = Proactive(server.attention, server.gate, server.feed.publish, server.start_line,
                                     server.busy, judge=Judge(RulesBackend(), state / "proactive-judge.jsonl"))
        server.egress = EgressPolicy()
        server.state = CharacterState(open_store(self.db), lambda cid: None)
        server.state.use("aster")
        server.load_receipts(open_store(self.db))
        self.thread = serve_in_thread(server)

    def tearDown(self):
        self.server.sessions.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.tmp.cleanup()

    def request(self, method, path, body=None, token=UI):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        conn.request(method, path, body=None if body is None else json.dumps(body).encode(), headers=headers)
        response = conn.getresponse()
        data = json.loads(response.read() or b"null")
        conn.close()
        return response.status, data

    def count(self, name, table):
        db = sqlite3.connect(str(self.state / name))
        try:
            return db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        finally:
            db.close()

    def turn(self, text, history=None):
        (history or self.server.history).record(
            turn_id="t", source="text", character_id="aster", persona_revision=None, user_text=text,
            reply=f"回{text}", state="completed", started_at=time.time())

    def seed(self):
        server, now = self.server, time.time()
        self.turn("你好")
        session = OwnSession("claude", self.tmp.name, "看一下仓库")
        server.sessions.sessions[session.session_id] = session
        server.sessions.save(session)
        server.sessions.add_line(session, "user", "看一下仓库")
        server._open_trace("line-1", 1, "text", "你好")
        fact=server.memory.add("管理员喜欢猫", "asserted_by_user")
        server.memory.record_uses([(fact,1)],"seed-memory-line","injected")
        server.memory.set_mark(fact, "locked", True)
        with server.memory.lock:
            server.memory._sight(fact, [{"source_id": "seed", "at": 1}], 0.9); server.memory.db.commit()
        server.rituals.set_pending("water",{"minutes":90})
        server.rituals.begin("morning","seed-ritual")
        server.rituals.settled("seed-ritual","completed")
        server.memory.set_paused(False)
        server.attention.ingest({"ts": now, "idle_s": 0, "front": {"app": "Xcode", "window_id": 7}})
        server.attention.ingest_browser({"type": "page", "ts": now, "url_host": "a.com", "title": "A",
                                         "text": "正文"})
        server.attention.ingest_events([{"ts": now, "kind": "value", "app": "Xcode", "value": "写一半"}])
        server.capture.budget.reserve("budget-1")
        db = open_store(self.db)
        TaskLedger(db).create("task-1", "claude", self.tmp.name, "看一下仓库", "read_only")
        Commitments(db).add("喝水", now + 600)
        schedules = Schedules(db)
        schedule = schedules.add('日报', '总结提交', {'kind': 'daily', 'at': '18:30', 'weekdays': [1, 2, 3, 4, 5]})
        schedules.run_now(schedule['schedule_id'])
        Gate(db=db).commit("comment")
        episodes = Episodes(db)
        edited = add_episode(episodes, now - 600, now, "写代码", "你在写代码。", apps=["Xcode"])
        episodes.edit(edited, "改过", "你改过了。")
        ProactiveLog(db).shown("line-p", "line", "comment", None, "在忙什么", None, None, now)
        work = WorkLog(db, lambda: "aster")
        ses = work.add_segment("agent_session", "sid-1", now - 600, now, input_sha256="h", requires=[], sources=["obs-1"])
        work.complete_segment(ses, {"title": "写代码", "goal": "g", "goal_authority": "user_said", "did": [], "outcome": "o",
                                    "status": "done", "blockers": [], "next_steps": [], "task_hint": None,
                                    "project": None, "user_facts": []})
        work.upsert_task({"project": None, "title": "写代码", "goal": "g", "goal_authority": "inferred", "status": "active",
                          "status_authority": "inferred", "progress": "p", "next_step": None, "blockers": [],
                          "first_at": now, "last_at": now, "requires": []})
        work.put_day("day", "2026-11-04", {"timezone": "UTC", "headline": "h", "body": {}, "inject": "i", "partial": True,
                                           "sources": [], "requires": []})
        from character_agent.services.jobs import JobStore
        jobs = JobStore(Memory(db))
        goal = jobs.create_goal('测试目标', '保留来源并验证删除')
        jobs.submit('测试后台工作', {'user_request': '测试数据'}, goal['goal_id'])
        jobs.claim()
        db.execute("INSERT INTO personal_deliveries(delivery_id,canonical_task_id,run_id,character_id,generation,revision,state,outcome,verification_source,title,payload,produced_at) VALUES('delivery-reset','task:task-1','reset-run','aster',1,1,'produced','needs_review','unverified','synthetic result','{}',?)", (now,))
        db.execute("INSERT INTO personal_delivery_events VALUES('delivery-reset',1,'produced',?,'product')", (now,))
        db.execute("INSERT INTO observation_briefs VALUES('brief-reset','aster','daily','2026-10-30','America/New_York',?,?,?,'completed',1,'{}','[]',0)", (now-86400,now,now))
        db.execute("INSERT INTO observation_brief_failures VALUES('brief-reset','invalid_brief_shape','observed_details[0].detail',?)", (now,))
        db.execute("INSERT INTO observation_content VALUES('hash-reset','complete evidence',NULL,?)",(now,))
        db.execute("INSERT INTO observation_frames VALUES('obs-reset','aster',?,'native_ax','editor','v1',1,'[]','{}','hash-reset',NULL)",(now,))
        db.execute("INSERT INTO observation_analyses VALUES('analysis-reset','aster',?,'run-reset','{}','[]')",(now,))
        db.execute("INSERT INTO observation_processed VALUES('obs-reset','analysis-reset',?)",(now,))
        db.execute("INSERT INTO observation_input_identity VALUES('event-reset','obs-reset')")
        db.execute("INSERT INTO observation_aliases VALUES('alias-reset','obs-reset')")
        db.execute("INSERT INTO observation_work_events VALUES('work-reset','aster',?,'task','{}','[]','analysis-reset')",(now,))
        db.execute("INSERT INTO agent_memory_processed VALUES('synthetic-source','digest')")
        db.execute("INSERT INTO memory_tombstones VALUES('digest',?)",(now,))
        db.execute("INSERT INTO desk_log (kind, at) VALUES ('pat', ?)", (now,))
        db.execute("INSERT INTO memory_agent_runs VALUES('memory-run','codex','native','aster',?,NULL,'running','v1','digest','{}',NULL)", (now,))
        db.execute("INSERT INTO memory_agent_events VALUES('memory-run',1,?,'proposal','{}')", (now,))
        db.execute("INSERT INTO model_usage (day, model, call, calls, input_tokens, cache_creation_input_tokens,"
                   " cache_read_input_tokens, output_tokens, cost_usd) VALUES ('2026-10-19', 'm', 'mouth', 1, 1, 0,"
                   " 0, 1, 0.1)")
        db.commit()
        db.close()
        server.capture._log("deny", 7, "daily_cap")
        server._proactive_lines.append("old-line")
        server.proactive._judge_lines["old-line"] = "j2"
        server.capture.judge.feedback("j1", "useful")
        server.proactive.judge.feedback("j2", "useful")
        server.state.on_event("dispatch_done")
        server.state.flush()
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
        conn.request("POST", "/say", body=json.dumps({"text": ""}).encode(),
                     headers={"Authorization": f"Bearer {UI}", "Content-Type": "application/json",
                              "Idempotency-Key": "seed-key"})
        conn.getresponse().read()
        conn.close()

    def test_reset_empties_every_store_and_log_and_keeps_settings(self):
        self.seed()
        for name, tables in CLEARED.items():
            for table in tables:
                self.assertGreater(self.count(name, table), 0, table)
        for log in LOGS:
            self.assertGreater((self.state / log).stat().st_size, 0, log)
        status, body = self.request("POST", "/reset", CONFIRM)
        self.assertEqual(status, 200, body)
        self.assertFalse(self.server.feedback("old-line", "useful"))
        self.assertEqual(self.server.proactive._judge_lines, {})
        self.assertEqual(body["rows"], {t: 0 for tables in CLEARED.values() for t in tables})
        self.assertEqual(set(body["deleted"]), set(body["rows"]))
        self.assertTrue(all(n > 0 for n in body["deleted"].values()), body["deleted"])
        self.assertEqual(sorted(body["logs"]), sorted(LOGS))
        for name, tables in CLEARED.items():
            for table in tables:
                self.assertEqual(self.count(name, table), 0, table)
        for log in LOGS:
            self.assertEqual((self.state / log).stat().st_size, 0, log)
        for table in KEPT:
            self.assertGreater(self.count("agentd.sqlite", table), 0, table)
        self.assertEqual(self.server.sessions.sessions, {})
        self.assertFalse(self.server.sessions.closed)
        self.assertEqual(self.server.rituals.today(),[])
        self.assertEqual(self.server.rituals._pending,{})
        self.assertEqual(self.server._receipts, {})
        items = self.server.feed.since(0)
        self.assertEqual([i["event"] for i in items], ["reset"])
        self.assertIn("at", items[0]["data"])

    def test_reset_leaves_no_character_state_that_comes_back(self):
        from types import SimpleNamespace as NS
        from character.desk_log import TICK, DeskLog
        from character.focus import Focus
        from character.signals import Signals
        from character.thoughts import Thoughts
        from infra import paths
        from sessions.events import normalize_claude
        from sessions.registry import Registry
        from test_check_result import SWIFT
        from test_proactive import analysis, work_event
        from test_thoughts import FakeSemantic
        server, now, clock = self.server, time.time(), [time.time()]
        server.desk = DeskLog(open_store(self.db), clock=lambda: clock[0])
        server.desk.span("visible", True)
        server.focus = Focus(paths.focus(self.state))
        server.focus_start(25)
        for _ in range(2):  # found blocked twice: stuck
            server.proactive.interpreted(analysis(now, [work_event("render", "blocked")], [("render", "blocked")]))
        self.assertIsNotNone(server.proactive._work_stuck(now))
        gate, registry, posts = Gate(enabled=True), Registry(coalesce=0), []
        signals = server.signals = Signals(gate, NS(post=posts.append, log=None), registry)
        gate.typing = True
        for name, body in (("UserPromptSubmit", {}), ("PostToolUseFailure", {"tool_name": "Bash",
                           "tool_input": {"command": "swift test"}, **SWIFT}), ("Stop", {})):
            event = normalize_claude({"hook_event_name": name, "session_id": "A", "cwd": "/work/Endfield", **body})
            before = registry.sessions.get(event.key)
            signals.on_hook(event, body)
            registry.ingest(event)
            signals.on_transition(before and before.state, registry.sessions[event.key].to_dict(), event)
        self.assertIsNotNone(signals._held)
        jobs, published = [], []
        server.thoughts = Thoughts(Gate(enabled=True), lambda event, data: published.append(data), FakeSemantic(),
                                   spawn=jobs.append, presence=lambda: "present")
        server.thoughts.notice("started")
        status, body = self.request("POST", "/reset", CONFIRM)
        self.assertEqual(status, 200, body)
        jobs.pop()()  # the thought asked for before the reset
        self.assertEqual(published, [])
        gate.typing = False
        signals.tick(time.time() + 10)
        self.assertEqual(posts, [])
        self.assertIsNone(server.proactive._work_stuck(now))
        self.assertFalse(server.focus.running())
        self.assertFalse(paths.focus(self.state).exists())
        self.assertFalse(server.gate.focus)
        reset_at = clock[0]
        server.desk.tick()  # the span still visible starts again on a fresh row
        server.desk.count("pat")
        clock[0] += TICK
        server.desk.tick()
        self.assertEqual(server.desk.db.execute("SELECT kind, at, until FROM desk_log ORDER BY id").fetchall(),
                         [("visible", reset_at, clock[0]), ("pat", reset_at, None)])

    def test_reset_empties_the_history_index(self):
        self.seed()
        self.assertGreater(self.count("agentd.sqlite", "history_fts"), 0)
        status, body = self.request("POST", "/reset", CONFIRM)
        self.assertEqual(status, 200, body)
        self.assertNotIn("history_fts", body["rows"])
        self.assertEqual(self.count("agentd.sqlite", "history_fts"), 0)
        self.assertEqual(self.server.history.search("你好", skip_recent=0), [])

    def test_reset_classifies_and_clears_owned_jobs_and_interactions(self):
        from character_agent.integration import CharacterAgentController
        from infra.data_lifecycle import DataLifecycle, USER_DATA, FTS, RETAINED
        controller = self.server.character_agent = CharacterAgentController(self.server, self.state)
        self.addCleanup(controller.store.close); self.addCleanup(controller.workspace.close)
        conversation = self.server.history.conversations.active
        job = controller.jobs.store.submit('核查', {'user_request': 'private-job-text'},
            conversation_id=conversation, source_turn_id='turn')
        controller.store.begin(job['run_id'], conversation, 'aster', 0)
        controller.interactions.wait_seconds = 0
        with self.assertRaisesRegex(ValueError, 'interaction_pending'):
            controller.interactions.ask(job['run_id'], [{'id': 'q', 'question': 'private-question-text'}],
                valid=lambda: True, character_id='aster')
        status, body = self.request('POST', '/reset', CONFIRM)
        self.assertEqual(status, 200, body)
        lifecycle = DataLifecycle([self.server.memory.db])
        tables = {r[0] for r in self.server.memory.db.execute("SELECT name FROM sqlite_master WHERE type='table'")
            if not r[0].startswith('sqlite_') and not any(r[0].startswith(fts + '_') for fts in FTS)}
        self.assertFalse(tables - USER_DATA - FTS - RETAINED)
        self.assertTrue(all(value == 0 for value in lifecycle.counts().values()))
        self.assertTrue(all(value == 0 for value in controller.data_counts().values()))

    def test_reset_clears_private_run_items(self):
        from character_agent.integration import CharacterAgentController
        from test_run_items import item
        controller = self.server.character_agent = CharacterAgentController(self.server, self.state)
        self.addCleanup(controller.store.close); self.addCleanup(controller.workspace.close)
        controller.store.begin('run', 'conversation', 'aster', 0)
        controller.store.item(item())
        self.assertEqual(len(controller.store.items('run')), 1)
        status, body = self.request('POST', '/reset', CONFIRM)
        self.assertEqual(status, 200, body)
        self.assertEqual(controller.store.db.execute('SELECT COUNT(*) FROM character_run_items').fetchone()[0], 0)

    def test_reset_empties_the_episodes_and_their_index(self):
        self.seed()
        self.assertGreater(self.count("agentd.sqlite", "episodes_fts"), 0)
        status, body = self.request("POST", "/reset", CONFIRM)
        self.assertEqual(status, 200, body)
        self.assertEqual((body["deleted"]["episodes"], body["rows"]["episodes"]), (1, 0))
        self.assertNotIn("episodes_fts", body["rows"])
        self.assertEqual((self.count("agentd.sqlite", "episodes"), self.count("agentd.sqlite", "episodes_fts")), (0, 0))

    def test_reset_deletes_candidate_facts_and_passes_the_id_sequence(self):
        self.seed()
        self.server.memory.add("可能常在晚上写代码", "inferred_hypothesis", evidence=["episode:1@2026-10-23"],
                               state="candidate")
        self.assertGreater(self.count("agentd.sqlite", "sqlite_sequence"), 0)
        status, body = self.request("POST", "/reset", CONFIRM)
        self.assertEqual(status, 200, body)
        self.assertEqual((body["rows"]["facts"], self.count("agentd.sqlite", "facts")), (0, 0))

    def test_unknown_shared_table_cannot_be_silently_skipped(self):
        self.seed()
        db=open_store(self.db)
        try:
            db.execute("CREATE TABLE future_user_data (text TEXT)")
            db.execute("INSERT INTO future_user_data VALUES ('synthetic')");db.commit()
            status,body=self.request("POST","/reset",CONFIRM)
            self.assertEqual((status,body),(500,{"error":"reset_schema_unclassified"}))
            self.assertGreater(self.count("agentd.sqlite","facts"),0)
            self.assertEqual(self.count("agentd.sqlite","future_user_data"),1)
        finally: db.close()

    def test_reset_clears_commitments(self):
        db = open_store(self.db)
        Commitments(db).add("喝水", time.time() + 600, created_line="line-1")
        db.close()
        status, body = self.request("POST", "/reset", CONFIRM)
        self.assertEqual((status, body["deleted"]["commitments"], body["rows"]["commitments"]), (200, 1, 0), body)
        self.assertEqual(self.count("agentd.sqlite", "commitments"), 0)

    def test_reset_clears_character_state(self):
        self.server.state.on_event("dispatch_done")
        self.server.state.flush()
        db = open_store(self.db)
        db.execute("INSERT INTO character_state VALUES ('birch', 0.5, 0.4, '[]', ?)", (time.time(),))
        db.commit()
        db.close()
        self.assertEqual(self.count("agentd.sqlite", "character_state"), 2)
        status, body = self.request("POST", "/reset", CONFIRM)
        self.assertEqual((status, body["deleted"]["character_state"], body["rows"]["character_state"]), (200, 2, 0),
                         body)
        after = self.server.state.snapshot()
        self.assertEqual((after["character_id"], after["valence"], after["causes"]), ("aster", 0.2, []))
        self.server.state.flush()  # what is written from here has nothing from before the reset
        db = sqlite3.connect(str(self.db))
        try:
            rows = db.execute("SELECT character_id, valence, causes FROM character_state").fetchall()
        finally:
            db.close()
        self.assertEqual(rows, [("aster", 0.2, "[]")])

    def test_writes_are_refused_while_reset_runs_and_work_after(self):
        inside, release = threading.Event(), threading.Event()
        clear = self.server.history.clear

        def held():
            inside.set()
            release.wait(5)
            return clear()

        self.server.history.clear = held
        epoch = self.server.feed.stream_epoch
        result = {}
        resetter = threading.Thread(target=lambda: result.update(
            zip(("status", "body"), self.request("POST", "/reset", CONFIRM))))
        resetter.start()
        try:
            self.assertTrue(inside.wait(5))
            refused = (503, {"error": "resetting"})
            beat = {"ts": time.time(), "idle_s": 0, "front": {"app": "Xcode", "window_id": 7}}
            self.assertEqual(self.request("POST", "/say", {"text": "你好"}), refused)
            self.assertEqual(self.request("POST", "/hook/claude", {"hook_event_name": "Stop", "session_id": "A"},
                                          token=HOOK), refused)
            self.assertEqual(self.request("POST", "/context/attention", beat), refused)
            self.assertEqual(self.request("DELETE", "/memory?scope=all"), refused)
            self.assertEqual(self.request("PUT", "/memory/paused", {"paused": True}), refused)
            switches = {"stay_in_place": True, "sit_window_top": True, "hold_window_edge": True,
                        "fullscreen_give_way": True}
            self.assertEqual(self.request("PUT", "/behavior/switches", switches), refused)
            receipt = {"behavior_id": "b-1-1", "phase": "running", "reason": None, "at_ms": 1, "turn_generation": 0}
            self.assertEqual(self.request("POST", "/behavior/receipts", receipt), refused)
            self.assertEqual(self.request("POST", "/character/prepare", {"id": "birch"}), refused)
            self.assertEqual(self.request("POST", "/character/commit", {"switch_id": "k2-0"}), refused)
            self.assertEqual(self.request("POST", "/character/abort", {"switch_id": "k2-0"}), refused)
            self.assertEqual(self.request("GET", "/state")[0], 200)
            self.assertEqual(self.request("POST", "/reset", CONFIRM), (409, {"error": "resetting"}))
        finally:
            release.set()
            resetter.join(10)
        self.assertEqual(result["status"], 200, result.get("body"))
        self.assertNotEqual(self.server.feed.stream_epoch, epoch)
        beat = {"ts": time.time(), "idle_s": 0, "front": {"app": "Xcode", "window_id": 7}}
        self.assertEqual(self.request("POST", "/context/attention", beat), (200, {}))
        self.assertEqual(self.request("DELETE", "/memory?scope=facts"),
                         (200, {"facts_deleted": 0, "history_deleted": 0}))
        status, body = self.request("POST", "/sessions", {"target": "claude", "cwd": self.tmp.name, "prompt": "再来"})
        self.assertEqual((status, body["state"]), (201, "accepted"))

    def test_a_writer_during_reset_leaves_only_whole_rows_after_the_clear(self):
        writer, stop, written = History(open_store(self.db)), threading.Event(), []

        def write():
            index = 0
            while not stop.is_set():
                self.turn(f"w{index}", writer)
                written.append(index)
                index += 1
                time.sleep(0.001)

        self.turn("旧的")
        thread = threading.Thread(target=write)
        thread.start()
        while len(written) < 20:
            time.sleep(0.005)
        status, body = self.request("POST", "/reset", CONFIRM)
        stop.set()
        thread.join(5)
        rows = History(open_store(self.db)).export()
        self.assertTrue(all(r["user_text"] and r["reply"] == f"回{r['user_text']}" for r in rows))
        indexes = [int(r["user_text"][1:]) for r in rows]
        # Only writes after the clear are left, each whole, none missing between them.
        self.assertEqual(indexes, list(range(len(written) - len(rows), len(written))))
        if status == 200:
            self.assertEqual(body["rows"]["history_turns"], 0)
        else:
            self.assertEqual((status, body["error"]), (500, "reset_incomplete"))
            # Tables are counted one at a time while the writer runs, so its row may show in any table it writes.
            left = {table for table, count in body["rows"].items() if count}
            self.assertTrue(left)
            self.assertLessEqual(left, {"history_turns", "conversation_turns", "conversations", "conversation_settings"})

    def test_a_line_that_outlives_the_reset_deadline_writes_nothing_after_it(self):
        entered, release = threading.Event(), threading.Event()

        class SlowMouth:
            history = []

            def stream(self, text, context):
                entered.set()
                release.wait(5)  # the model call does not yield before reset gives up waiting
                yield "晚到的回复。"

        self.server.mouth = SlowMouth()
        self.assertEqual(self.request("POST", "/say", {"text": "你好"})[0], 202)
        self.assertTrue(entered.wait(5))
        status, body = self.server.reset(timeout=0.2)
        self.assertEqual((status, body["rows"]["history_turns"], body["rows"]["trace_events"]), (200, 0, 0))
        self.assertTrue(self.server._live_lines)
        release.set()
        deadline = time.monotonic() + 5
        while self.server._live_lines and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(self.server._live_lines)
        self.assertEqual((self.count("agentd.sqlite", "history_turns"), self.count("agentd.sqlite", "trace_events")),
                         (0, 0))

    def test_reset_aborts_an_open_character_switch(self):
        status, body = self.request("POST", "/character/prepare", {"id": "birch"})
        self.assertEqual(status, 200, body)
        self.assertEqual(self.request("POST", "/reset", CONFIRM)[0], 200)
        state = self.request("GET", "/state")[1]
        self.assertEqual((state["switching"], state["character"], state["character_generation"]),
                         (None, "aster", 0))
        self.assertEqual(self.request("POST", "/character/commit", {"switch_id": body["switch_id"]}),
                         (404, {"error": "unknown_switch"}))

    def test_cards_from_before_the_reset_leave_the_model_context(self):
        broker, secret = self.server.broker, "cat ~/私密笔记.txt"
        card = broker.open("claude", "A", tool_name="Bash", tool_summary=secret)
        broker.decide(card.request_id, card.generation, "allow")
        self.assertIn(secret, self.server._approvals_context(self.server.registry.snapshot()))
        self.assertEqual(self.request("POST", "/reset", CONFIRM)[0], 200)
        self.assertEqual(broker.recent(600), [])
        self.assertNotIn(secret, self.server._approvals_context(self.server.registry.snapshot()))
        after = broker.open("claude", "A", tool_name="Bash", tool_summary="make all")
        broker.decide(after.request_id, after.generation, "deny")
        self.assertEqual([r["request_id"] for r in broker.recent(600)], [after.request_id])

    def test_a_line_from_before_the_reset_leaves_the_feed_and_turn_state_alone(self):
        entered, release = threading.Event(), threading.Event()

        class Mouth:
            history = []

            def pick_facts(self, query, derived=False, character_id=None):
                entered.set()
                release.wait(5)  # the line picks its facts only after the reset is done
                return {"trusted": [], "low_trust": []}

            def stream(self, text, context):
                yield "晚到的回复。"
                self.history.append([{"role": "user", "content": text}, {"role": "assistant", "content": "晚到的回复。"}])

        self.server.mouth = Mouth()
        self.server.speech = relay_for(self)[1]  # a voiced line keeps its window turn in _line_entries
        self.server.cancel_turn = lambda reason: None  # a line that began after reset's cancel is not stale
        self.assertEqual(self.request("POST", "/say", {"text": "你好"})[0], 202)
        self.assertTrue(entered.wait(5))
        self.assertEqual(self.server.reset(timeout=0.2)[0], 200)
        after = self.server.feed.since(0)[-1]["seq"] if self.server.feed.since(0) else 0
        release.set()
        deadline = time.monotonic() + 5
        while self.server._live_lines and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(self.server._live_lines)
        self.assertEqual([i["event"] for i in self.server.feed.since(after)], [])
        self.assertIsNone(self.server._turn_facts)
        self.assertEqual(dict(self.server._line_entries), {})
        self.assertEqual(self.server.mouth.history, [])

    def test_reset_needs_the_exact_confirmation_and_the_ui_token(self):
        self.turn("留着")
        refused = (400, {"error": "confirmation_required"})
        self.assertEqual(self.request("POST", "/reset", {"confirm": "yes"}), refused)
        self.assertEqual(self.request("POST", "/reset", {**CONFIRM, "also": 1}), refused)
        self.assertEqual(self.request("POST", "/reset"), refused)
        self.assertEqual(self.request("POST", "/reset", CONFIRM, token=None)[0], 401)
        self.assertEqual(self.request("POST", "/reset", CONFIRM, token=HOOK)[0], 401)
        self.assertEqual(self.count("agentd.sqlite", "history_turns"), 1)

    def test_deleted_rows_leave_no_bytes_in_the_file_or_the_wal(self):
        marker = "reset-marker-" + "5f3e9c" * 8
        for _ in range(20):
            self.turn(marker)
        status, body = self.request("POST", "/reset", CONFIRM)
        self.assertEqual(status, 200, body)
        wal = Path(f"{self.db}-wal")
        self.assertTrue(not wal.exists() or wal.stat().st_size == 0, wal.stat().st_size)
        self.assertNotIn(marker.encode(), bytes(self.db.read_bytes()))

    def assert_gone(self, marker):
        wal = Path(f"{self.db}-wal")
        self.assertNotIn(marker.encode(), wal.read_bytes() if wal.exists() else b"")
        self.assertNotIn(marker.encode(), self.db.read_bytes())

    def test_clearing_the_chat_leaves_no_bytes_in_the_file_or_the_wal(self):
        marker = "partial-marker-" + "9d2a71" * 8
        for n in range(20):
            self.turn(marker)
            self.server._open_trace(f"line-{n}", 1, "text", marker)
        self.assertIn(marker.encode(), self.db.read_bytes() + Path(f"{self.db}-wal").read_bytes())
        self.assertEqual(self.server.clear_history(), 20)
        self.assert_gone(marker)

    def test_deleting_a_fact_leaves_no_bytes_of_it_or_the_turns_that_said_it(self):
        marker = "fact-marker-" + "3b8e04" * 8
        status, body = self.request("POST", "/memory/facts", {"text": marker})
        self.assertEqual(status, 201)
        for n in range(20):
            self.turn(marker)
        self.server.memory.record_uses([(body["fact_id"], 1)], "t", "mentioned")
        self.assertIn(marker.encode(), self.db.read_bytes() + Path(f"{self.db}-wal").read_bytes())
        self.assertEqual(self.request("DELETE", f"/memory/facts/{body['fact_id']}?expected_version=1&cascade="), (200, {"deleted": True}))
        self.assert_gone(marker)

    def test_a_blacklisted_app_leaves_no_bytes_of_its_episodes(self):
        marker = "episode-marker-" + "6c1f58" * 8
        db = open_store(self.db)
        self.addCleanup(db.close)
        episodes = self.server.episodes = Episodes(db)
        now = time.time()
        for n in range(20):
            add_episode(episodes, now - 600 * (n + 1), now - 600 * n, "写代码", marker, apps=["x.Marker"])
        self.assertIn(marker.encode(), self.db.read_bytes() + Path(f"{self.db}-wal").read_bytes())
        body = {"field": "bundle_ids", "value": "x.Marker", "delete_existing": True}
        self.assertEqual(self.request("POST", "/blacklist", body)[0], 200)
        self.assertEqual(episodes.between(0, now), [])
        self.assert_gone(marker)

    def consent(self, page_text, typed_text):
        config = self.state / "config.json"
        config.write_text(json.dumps({"share_page_text": page_text, "share_typed_text": typed_text}), encoding="utf-8")
        self.server.share_page_text = self.server.share_typed_text = True
        self.server.privacy_config = str(config)

    def episodes_with(self, *markers, typed=False):
        """20 episodes per marker, its description; the store, with the ids of each marker's episodes."""
        db = open_store(self.db)
        self.addCleanup(db.close)
        episodes = self.server.episodes = Episodes(db)
        now, ids = time.time(), []
        for m, marker in enumerate(markers):
            ids.append([add_episode(episodes, now - 600 * (20 * m + n + 1), now - 600 * (20 * m + n), "写代码",
                                    f"你在写 {marker}", [{"subject": "写代码"}], apps=["Xcode"],
                                    requires=["page_text", "typed_text"] if typed and m == 0 else ["page_text"])
                        for n in range(20)])
        for marker in markers:
            self.assertIn(marker.encode(), self.db.read_bytes() + Path(f"{self.db}-wal").read_bytes())
        return episodes, ids

    def test_revoking_page_text_leaves_no_bytes_of_the_episodes(self):
        marker = "pagemarker" + "4d7a19" * 8
        self.consent(True, True)
        self.server.sync_privacy()
        episodes, _ = self.episodes_with(marker)
        self.consent(False, True)
        self.server.sync_privacy()
        self.assertEqual(episodes.between(0, time.time()), [])
        self.assert_gone(marker)

    def test_revoking_page_text_takes_the_work_memory_built_on_it(self):
        self.consent(True, True)
        self.server.sync_privacy()
        db = open_store(self.db)
        work = self.server.worklog = WorkLog(db, lambda: "aster")
        now = time.time()
        kept = work.add_segment("agent_session", "s-plain", now - 600, now, input_sha256="h", requires=[], sources=[])
        work.add_segment("agent_session", "s-page", now - 600, now, input_sha256="h", requires=["page_text"], sources=[])
        self.consent(False, True)
        self.server.sync_privacy()
        self.assertEqual([r[0] for r in db.execute("SELECT id FROM session_summaries")], [kept])

    def test_revoking_page_text_takes_the_stuck_work_proactive_kept(self):
        from test_proactive import analysis, work_event
        self.consent(True, True)
        self.server.sync_privacy()
        now = time.time()
        for _ in range(2):
            self.server.proactive.interpreted(analysis(now, [work_event("render", "blocked")], [("render", "blocked")]))
        self.assertIsNotNone(self.server.proactive._work_stuck(now))
        self.consent(False, True)
        self.server.sync_privacy()
        self.assertIsNone(self.server.proactive._work_stuck(now))

    def test_revoking_typed_text_takes_only_the_episodes_with_typed_text(self):
        typed, plain = "typedmarker" + "81c3e2" * 8, "plainmarker" + "0b9f47" * 8
        self.consent(True, True)
        self.server.sync_privacy()
        episodes, (_, kept) = self.episodes_with(typed, plain, typed=True)
        self.consent(True, False)
        self.server.sync_privacy()
        self.assertEqual(sorted(e["id"] for e in episodes.between(0, time.time())), kept)
        self.assert_gone(typed)

    def test_a_sync_returns_after_a_revocation_the_ticker_is_still_applying(self):
        """The ticker's sync_privacy can find the revocation first; a turn's sync_privacy then must not return before
        the episodes are gone."""
        typed = "typedmarker" + "5e07a3" * 8
        self.consent(True, True)
        self.server.sync_privacy()
        episodes, _ = self.episodes_with(typed, typed=True)
        entered, release = threading.Event(), threading.Event()

        def cancel(*args, **kwargs):
            if not entered.is_set():
                entered.set()
                release.wait(10)
        try:
            with patch.object(self.server.character_agent, "cancel", side_effect=cancel):
                self.consent(True, False)
                self.assertTrue(entered.wait(10))
                self.server.sync_privacy()
                self.assertEqual(episodes.between(0, time.time()), [])
        finally:
            release.set()

    def test_delete_attention_leaves_no_bytes_of_the_episodes(self):
        marker = "attentionmarker" + "e25d60" * 8
        episodes, _ = self.episodes_with(marker)
        self.server.trace = None  # the trace's checkpoint would empty the shared WAL too
        self.assertEqual(self.request("DELETE", "/attention")[0], 200)
        self.assertEqual(episodes.between(0, time.time()), [])
        self.assert_gone(marker)

    def test_page_text_off_at_startup_clears_the_episodes(self):
        from daemon.main import startup_privacy
        marker = "startupmarker" + "7f20a8" * 8
        episodes, _ = self.episodes_with(marker)
        self.consent(False, True)
        startup_privacy(self.server)
        self.assertEqual(episodes.between(0, time.time()), [])
        self.assert_gone(marker)

    def test_typed_text_off_at_startup_takes_only_the_episodes_with_typed_text(self):
        from daemon.main import startup_privacy
        typed, plain = "startuptyped" + "39ab5c" * 8, "startupplain" + "c6e014" * 8
        episodes, (_, kept) = self.episodes_with(typed, plain, typed=True)
        self.consent(True, False)
        startup_privacy(self.server)
        self.assertEqual(sorted(e["id"] for e in episodes.between(0, time.time())), kept)
        self.assert_gone(typed)


if __name__ == "__main__":
    unittest.main()
