"""The GET body of each route_registry entry with a `response` fixture has the keys and JSON types an in-process agentd answers with."""
import datetime
from fnmatch import fnmatch
import io
import json
from pathlib import Path
import re
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from infra.secrets import MemorySecrets
from support import enable_plugins
from brain.egress import EgressPolicy  # noqa: E402
from brain.provider import Mouth  # noqa: E402
from character_agent.integration import CharacterAgentController  # noqa: E402
from character_agent.services.observation_briefs import window  # noqa: E402
from character.character_state import CharacterState  # noqa: E402
from personal.commitments import Commitments  # noqa: E402
from personal.episodes import Episodes  # noqa: E402
from sessions.events import normalize_claude  # noqa: E402
from sessions.own import OwnSession, SessionManager  # noqa: E402
from personal.history import History  # noqa: E402
from personal.memory import Memory  # noqa: E402
from fsutil import atomic_write_json  # noqa: E402
from models.model_backends import ModelSettings  # noqa: E402
from models.usage import UsageMeter  # noqa: E402
from observation.attention import AttentionStore  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from support import add_episode, deny_blacklist  # noqa: E402
from observation.capture import CaptureManager  # noqa: E402
from personal.rituals import Rituals  # noqa: E402
from character.proactive import Proactive  # noqa: E402
from route_registry import REGISTRY  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from infra.store import open_store  # noqa: E402
from sessions.tasks import TaskLedger  # noqa: E402
from test_character_agent_runtime import FakeSession  # noqa: E402
from observation.user_now import UserNow  # noqa: E402
from test_plugin_routes import request
from test_worklog_http import seed_worklog
from traces.trace_store import TraceStore  # noqa: E402
from voice.speech import SpeechRelay  # noqa: E402
from api.handler import Handler  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[3] / "protocol" / "C6-agentd-api" / "fixtures"
HOOK, UI, EVENTS = "hook-token", "ui-token", "events-token"
TOKENS = {"hook_token": HOOK, "ui_token": UI, "events_token": EVENTS}
PROFILE = "00000000-0000-4000-8000-000000000001"


def kind(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    return {str: "string", list: "array", dict: "object"}[type(value)]


def mismatches(fixture, real, nullable, free_keys, path=""):
    """Differences in key sets (objects layer by layer, arrays by their first item) and JSON types."""
    name = path or "$"
    # "[" escaped: fnmatch reads "[]" as a character class, so "turns[].id" would never match.
    if (fixture is None or real is None) and any(fnmatch(path, p.replace("[", "[[]")) for p in nullable):
        return []
    if kind(fixture) != kind(real):
        return [f"{name}: fixture {kind(fixture)}, agentd {kind(real)}"]
    if isinstance(fixture, list):
        return mismatches(fixture[0], real[0], nullable, free_keys, path + "[]") if fixture and real else []
    if not isinstance(fixture, dict):
        return []
    if path in free_keys:
        sample = next(iter(fixture.values()), None)
        return [problem for key, value in real.items() if sample is not None
                for problem in mismatches(sample, value, nullable, free_keys, f"{path}.{key}")]
    found = []
    if set(fixture) != set(real):
        found.append(f"{name}: keys only in fixture {sorted(set(fixture) - set(real))}, "
                     f"only in agentd {sorted(set(real) - set(fixture))}")
    for key in sorted(set(fixture) & set(real)):
        found += mismatches(fixture[key], real[key], nullable, free_keys, f"{path}.{key}" if path else key)
    return found


class C6FixtureTest(unittest.TestCase):
    def setUp(self):
        enable_plugins(self)
        self.tmp = tempfile.TemporaryDirectory()
        state = Path(self.tmp.name)
        # One signed-in profile, so the array item is compared too.
        atomic_write_json(state / "chatgpt-auth.json", {"host_id": "urn:uuid:" + PROFILE, "active": PROFILE, "profiles": {
            PROFILE: {"label": "连接 1", "email": "user@example.com", "expires_at": 9999999999,
                      "scopes": ["chatgpt.tokens.use.direct"]}}})
        with patch.object(AgentdServer, "server_bind"), patch.object(AgentdServer, "server_activate"):
            self.server = AgentdServer(("127.0.0.1", 48810), HOOK, UI, events_token=EVENTS)
        self.server._stopped.set()
        self.server._ticker.join(2)
        self.server.server_port = 48810
        credentials = MemorySecrets()
        credentials.put("chatgpt-" + PROFILE, b'{"access_token":"fake"}')
        self.server.models = ModelSettings(state, credentials)
        self.server.models.save({"provider": "anthropic"})
        self.seed(state)

    def tearDown(self):
        self.server.server_close()
        self.server.models.auth.cancel()
        self.server.character_agent.store.close()
        self.server.character_agent.workspace.close()
        self.db.close()
        self.tmp.cleanup()

    def seed(self, state):
        """One row in each list the snapshot, conversation, agent work, state and presence routes answer, so their
        items are compared too."""
        self.db, lock = open_store(state / "agentd.sqlite"), threading.RLock()
        server = self.server
        server.history = History(self.db, lock=lock)
        server.tasks = TaskLedger(self.db, lock=lock)
        server.memory = Memory(self.db, lock=lock)
        server.egress = EgressPolicy()
        server.mouth = Mouth()
        server.state = CharacterState(self.db, lambda cid: None)
        server.state.use(server.character)
        server.state.on_event("dispatch_done")
        server.registry.ingest(normalize_claude({"hook_event_name": "UserPromptSubmit", "session_id": "s1",
                                                 "cwd": "/Users/demo/work/orbit"}))
        controller = server.character_agent = CharacterAgentController(server, state)
        # A logged-in local Codex row as DiscoveryService._inspect builds it, so selected_runtime and
        # installed_runtimes are filled without probing this Mac.
        controller.discovery = SimpleNamespace(scan=lambda refresh=False: {"runtimes": [
            {"backend": "codex", "runtime_source": "local_cli", "path": "/synthetic/codex", "version": "0.50.0",
             "entry_supported": True, "boundary_verified": None, "reason": None,
             "compatibility": {"strategy": "runtime_capabilities", "version_required": False,
                               "policy_verification": "on_session_start"},
             "authenticated": True, "auth_mode": "existing_login", "auth_method": "chatgpt"}], "scanned_at": 0})
        conversation = server.history.conversations.active
        server.history.record(turn_id="tr1", source="text", character_id=server.character, persona_revision="1",
                              user_text="你好", reply="在呢", state="completed", started_at=time.time())
        jobs = controller.jobs.store
        goal = jobs.create_goal("周报", "每周五整理提交")
        jobs.submit("整理本周提交", {"user_request": "整理本周提交"}, goal["goal_id"], conversation_id=conversation)
        # Created after the job, so the delivered task is the first /agent/tasks row.
        server.tasks.create("a" * 32, "character", self.tmp.name, "整理周报", "workspace_write")
        for task_state in ("approved", "running", "returned", "verifying", "needs_review"):
            server.tasks.transition("a" * 32, task_state)
        server.commitments = Commitments(self.db, lock=lock)
        server.commitments.add("提醒喝水", time.time() + 3600)
        server.schedules_store().add('日报', '总结仓库变化',
            {'kind': 'daily', 'at': '18:30', 'weekdays': [1, 2, 3, 4, 5]}, enabled=True)
        runs = controller.store
        runs.begin("run-1", conversation, server.character, 1, delivery_eligible=True)
        runs.finish("run-1", "completed", task_id="a" * 32, result={"artifacts": [
            {"artifact_id": "art-1", "path": "周报.md", "absolute_path": "/tmp/周报.md", "version": 1,
             "self_checked": True, "sha256": "0" * 64}]})
        with self.assertRaisesRegex(ValueError, "interaction_pending"):
            controller.interactions.ask("run-1", [{"id": "scope", "question": "包含外部会话吗？",
                                                   "options": [{"label": "包含"}]}],
                                        valid=lambda: True, character_id=server.character)
        self.assertIsNotNone(controller.deliveries.produce("run-1"))
        server.broker.open("claude", "session", tool_name="Read", tool_summary="file")
        self.params = {"conversation_id": conversation}
        seed_worklog(server, self.db)
        self.params["task_id"] = "task-hostlink"
        self.seed_day(state, lock)
        self.seed_observation()
        server.trace = TraceStore(self.db, producer_epoch=server.registry.epoch)
        server.trace.emit("input.received", "5b0f3c1e-8a2d-4f6b-9c7e-1d2a3b4c5d6e", turn_id="tr1", turn_generation=1, attrs={"source": "text"}, texts={"text": "你好"})

    def seed_day(self, state, lock):
        """Today's rows for the memory, episode, day and summary run routes, which read today without a date."""
        server = self.server
        nine = datetime.datetime.combine(datetime.date.today(), datetime.time(9)).timestamp()
        server.share_page_text = True
        self.params["fact_id"] = server.memory.add("回答先给结论", "asserted_by_user")
        server.memory.record_uses([(self.params["fact_id"], 1)], "line-1", "injected")
        server.memory.add("周报按项目分组", "inferred_hypothesis", state="candidate")
        server.episodes = Episodes(self.db, lock=lock)
        add_episode(server.episodes, nine, nine + 600, "写周报", "你在「周报」里发了消息。",
                    [{"subject": "周报", "goal": "核对分组", "outcome": "待确认分组", "evidence": ["source-one"]}],
                    requires=["page_text"], apps=["Code"], hosts=["github.com"], titles=["周报.md"],
                    run_id="native-extract")
        turn = server.character_agent.memory_journal.turn("native-extract", "", "codex", "native", server.character,
                                                          {}, purpose="memory_extract")
        turn.open(lambda: True)
        turn.finish("committed", "")
        folder = state / "ledger" / "-Users-demo-work-orbit" / datetime.date.today().isoformat()
        folder.mkdir(parents=True)
        (folder / "s1.jsonl").write_text(json.dumps({
            "timestamp": datetime.datetime.fromtimestamp(nine).astimezone().isoformat(), "event_name": "gate.result",
            "severity_text": "INFO", "attributes": {"session.id": "s1", "outcome": "pass"}}) + "\n", encoding="utf-8")
        server.ledger_root = state / "ledger"
        server.sessions = SessionManager(server.broker, lambda *a, **k: None, state, "http://127.0.0.1:48810",
                                         HOOK, 60)
        own = OwnSession("codex", "/Users/demo/work/orbit", "整理周报")
        own.state, own.last_line, own.origin = "awaiting_input", "待确认分组", "a" * 32
        server.sessions.sessions[own.session_id] = own

    def seed_observation(self):
        """An analysed page with one task rejected, a newer unanalysed page, and yesterday's brief, so the observation
        routes' lists, queue counts and corrections are filled; their model calls go to a fake session."""
        server, now = self.server, time.time()
        controller, observations = server.character_agent, server.character_agent.observations
        page = {"type": "page", "ts": now, "url_host": "github.com", "title": "CI 运行", "tab_id": 3}
        first = observations.ingest("browser", "构建失败：render_test 超时", metadata=page, at=now - 60,
                                    source_key="browser:s:3:page")

        def script(session, prompt, options):
            evidence = json.loads(prompt)["evidence"]
            if "observations" in evidence:
                quote = [{"observation_id": first, "quote": "render_test"}]
                task = {"title": "修复渲染测试", "objective": "让 CI 通过", "current_step": "查看失败日志",
                        "state": "investigating", "unresolved": ["超时原因"], "next_steps": ["本地重跑"],
                        "confidence": 0.6, "evidence": quote}
                value = {"observed_facts": [{"text": "CI 构建失败", "evidence": quote}],
                         "work_events": [{"title": "CI 失败", "summary": "render_test 超时", "task_key": "fix-render-test",
                                          "state": "investigating", "evidence": quote}],
                         "task_updates": [{**task, "task_key": "fix-render-test"}, {**task, "task_key": "other-task"}],
                         "uncertainties": ["未看到本地日志"], "evidence_requests": []}
            else:
                refs = [{"source_id": source["source_id"], "quote": "预算报告"} for source in evidence["sources"]]
                value = {"observed_details": [{"detail": "在改预算报告", "evidence": refs[:1]}],
                         "recurring_problems": [{"problem": "预算报告反复返工", "optimization": "先定模板", "evidence": refs}],
                         "next_steps": [{"action": "核对来源", "reason": "数据待核验", "evidence": refs[:1]}],
                         "unknowns": ["覆盖不全"]}
            yield {"type": "result", "success": True, "final_text": json.dumps(value, ensure_ascii=False), "model": "fixture"}
        controller.session_factory_override = lambda definitions: FakeSession(script)
        self.assertEqual(observations.run_once()["state"], "completed")
        rejected = next(t for t in observations.context()["tasks"] if t["task_key"] == "other-task")
        observations.correct_task(rejected["id"], 1, action="reject")
        self.assertTrue(observations.ingest("browser", "本地重跑通过", metadata=page, source_key="browser:s:3:page"))
        zone = "America/New_York"  # observation_briefs DEFAULTS
        yesterday = (datetime.datetime.now(ZoneInfo(zone)).date() - datetime.timedelta(days=1)).isoformat()
        start = window("daily", yesterday, zone)[1] + 3600
        # Two episodes two hours apart, so the brief may call one problem recurring.
        for n, doc in enumerate(("预算报告.md", "预算报告-v2.md")):
            run = f"c6-brief-episode-run-{n}"
            server.memory.db.execute(
                "INSERT INTO memory_agent_runs(run_id,backend,model,character_id,started_at,state,prompt_version,input_sha256)"
                " VALUES(?,?,?,?,?,'completed','fixture','fixture')",
                (run, "codex", "fixture", server.character, start + n * 7200))
            server.memory.db.commit()
            add_episode(server.episodes, start + n * 7200, start + n * 7200 + 120, doc, f"{doc} 检查", run_id=run)
        self.assertEqual(controller.observation_briefs.run_once("daily", yesterday)["state"], "completed")
        controller.session_factory_override = None

    def assert_fixture(self, name, real):
        fixture = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
        loose = json.loads((FIXTURES / "loose-fields.json").read_text(encoding="utf-8"))
        self.assertEqual(mismatches(fixture, real, loose["nullable"].get(name, []),
                                    loose["free_keys"].get(name, [])), [])

    def test_observation_state_unauthorized_matches_fixture(self):
        self.server.share_page_text = False
        status, real = self.get("/observation/state", UI)
        self.assertEqual(status, 200)
        fixture = FIXTURES.parents[1] / "ui-bridge" / "responses" / "observation-state-unauthorized.json"
        self.assertEqual(real, json.loads(fixture.read_text(encoding="utf-8")))

    def test_task_understanding_with_observation_frames_matches_fixture(self):
        status, real = self.get("/task-understanding", UI)
        self.assertEqual(status, 200)
        self.assertTrue(real["hypotheses"])
        self.assert_fixture("task-understanding.json", real)

    def test_state_and_presence_idle_and_running_match_fixtures(self):
        controller = self.server.character_agent
        # Retire the seeded question before testing an active tool run and then idle.
        controller.interactions.invalidate(run_ids=["run-1"])
        controller.store.begin("wire-run", self.params["conversation_id"], self.server.character, 1)
        controller.store.event("wire-run", "running", {"backend": "codex"})
        controller.store.event("wire-run", "tool_started", {"tool": "knowledge_search", "tool_call_id": "tool-1"})
        for idle in (False, True):
            with self.subTest(idle=idle):
                if idle:
                    controller.store.finish("wire-run", "cancelled")
                    self.server.registry.sessions.clear()
                controller.refresh_presentation()
                for path, stem, key in (("/state", "state", "focus"), ("/desktop/presence", "desktop-presence", "role")):
                    status, real = self.get(path, UI)
                    self.assertEqual(status, 200)
                    self.assertEqual(real[key]["state"], "idle" if idle else "running_tool")
                    self.assert_fixture(stem + ("-idle" if idle else "") + ".json", {key: real[key]} if idle else real)

    def test_episode_threads_match_fixture(self):
        fixture = json.loads((FIXTURES / "episodes.json").read_text(encoding="utf-8"))["episodes"][0]
        start = datetime.datetime.combine(datetime.date.today(), datetime.time(10)).timestamp()
        project = {k: v for k, v in fixture["threads"][0].items()
                   if k in ("subject", "goal", "constraints", "decisions", "outcome", "unresolved", "next_steps")}
        ident = add_episode(self.server.episodes, start, start + 60, "周报", "核对分组",
                            [{**project, "evidence": ["source-one"]}], requires=["page_text"])
        status, real = self.get("/episodes", UI)
        self.assertEqual(status, 200)
        [episode] = [episode for episode in real["episodes"] if episode["id"] == ident]
        self.assertEqual(episode["version"], 3)
        self.assert_fixture("episodes.json", {**real, "episodes": [episode]})

    def test_day_segments_compares_own_session_rows(self):
        with patch.object(self.server, "share_agent_sessions", True):
            status, real = self.get("/day/segments", UI)
        self.assertEqual(status, 200)
        self.assertTrue(any(project["own"] for project in real["projects"]))
        self.assert_fixture("day-segments.json", real)

    def get(self, path, token):
        auth = "" if token is None else f"Authorization: Bearer {token}\r\n"
        raw = f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:48810\r\n{auth}\r\n".encode()
        handler = Handler.__new__(Handler)
        handler.server = self.server
        handler.rfile, handler.wfile = io.BytesIO(raw), io.BytesIO()
        handler.handle_one_request()
        headers, response = handler.wfile.getvalue().split(b"\r\n\r\n", 1)
        return int(headers.split()[1]), json.loads(response)

    def seed_diagnostics(self):
        """Fill optional blocks and list items without replacing the diagnostic serializers."""
        server, now = self.server, time.time()
        state = Path(self.tmp.name)
        blacklist = Blacklist(deny_blacklist(state / "blacklist.json"))
        attention = server.attention = AttentionStore(state / "attention.sqlite", blacklist)
        self.addCleanup(attention.close)
        front = {"window_id": 101, "app": "Code", "bundle_id": "com.microsoft.VSCode", "title": "diagnostics.ts"}
        beat = {"ts": now, "front": front, "mouse": None, "idle_s": 0.0, "locked": False,
                "asleep": False, "focus_role": None, "secure_input": False}
        for offset in range(-240, 1, 5):
            attention.ingest({**beat, "ts": now + offset})
        for kind in ("heartbeat", "page", "selection"):
            attention.ingest_browser({"type": kind, "ts": now, "url_host": "github.com", "title": "CI results",
                                      "text": "render_test passed"})
        server._browser_at = now
        server.proactive = Proactive(attention, server.gate, server.feed.publish, lambda *a, **k: None,
                                     lambda: False, judge=object())
        server._last_judge = {"backend": "rules", "answers": [{"id": "want_comment", "value": False, "prob": 1.0}],
                              "at": datetime.datetime.fromtimestamp(now).astimezone().isoformat()}
        capture = server.capture = CaptureManager(server.feed, blacklist, lambda: front, None, share_text=True,
                                                  budget_db=self.db)
        request_id = capture._request(101, "text", "look")
        capture._settle(request_id, "failed", "timeout")
        capture._request(101, "text", "focus")
        server._assembled = (now, [{"type": "window_text", "observation_id": None,
                                    "at": datetime.datetime.fromtimestamp(now).astimezone().isoformat()}])
        server._turn_trace = {"turn_id": "tr1", "trace_id": "trace-1", "source": "text", "generation": 1,
                              "marks": [("input.received", 1.0), ("model.started", 1.1)], "done": True}
        server._speech_failed = {"speech_id": "speech-1", "reason": "connection_lost",
                                 "at": datetime.datetime.fromtimestamp(now).astimezone().isoformat()}
        server.speech = SpeechRelay("http://127.0.0.1:1", epoch=1, character=server.character, language="zh")
        server.gate.commit("comment")
        server.registry.activity, server.registry.mood = "relax", "neutral"
        server.hook_files = {"claude": state / "claude-hooks.json", "codex": state / "codex-hooks.json"}
        server.hook_seen = {"claude": now, "codex": now}
        server.usage = UsageMeter(self.db)
        server.usage.record("fixture", "mouth", SimpleNamespace(input_tokens=100, cache_creation_input_tokens=0,
                            cache_read_input_tokens=20, output_tokens=10), provider="anthropic")
        server.rituals = Rituals(self.db)
        server.rituals.begin("morning", "line-morning")
        server.rituals.settled("line-morning", "completed")
        server.rituals.set_pending("water", {"minutes": 30})
        server.stage_times.event("model.finished", "ok", "tr1", 3120, {})
        spatial = server.spatial
        spatial.set_capabilities(server.character, {"climb_window_top": "motion_missing", "sit": None})
        spec = {"type": "sit", "target": None, "trigger": {"source": "tick", "event": None},
                "display_session": None, "turn_id": None, "priority": 1, "channels": ["full_body"],
                "exit": ["user_drag"], "intensity": 0.5, "lifetime": 120}
        spatial._send(spec, server.spatial_situation(), now)
        behavior_id = next(iter(spatial.active))
        spatial.receipt({"behavior_id": behavior_id, "turn_generation": server.turn_generation, "phase": "running"})
        spatial._unsupported["climb_window_top"] = now + 1800

    @unittest.skipIf(sys.platform == "win32", "the test keeps an SQLite file open while deleting or replacing it, which Windows refuses (WinError 32)")
    def test_diag_state_matches_fixture(self):
        """diag-state.json was captured from this seed through Handler._diag_state with socket transport stubbed."""
        # /diag/state has no registry response entry; keep this contract test explicit.
        fixture = json.loads((FIXTURES / "diag-state.json").read_text(encoding="utf-8"))
        loose = json.loads((FIXTURES / "loose-fields.json").read_text(encoding="utf-8"))
        for populated in (False, True):
            with self.subTest(populated=populated):
                if populated:
                    self.seed_diagnostics()
                status, real = self.get("/diag/state", UI)
                self.assertEqual(status, 200)
                self.assertIsInstance(real["gate"].get("companion_mode"), bool)
                self.assertIn("held", real["proactive"])
                self.assertEqual(mismatches(fixture, real, loose["nullable"]["diag-state.json"],
                                            loose["free_keys"]["diag-state.json"]), [])

    def test_user_coarse_fixtures(self):
        policy = Path(self.tmp.name) / "privacy.json"
        policy.write_text('{"sense_input_counts": true}', encoding="utf-8")
        self.server.privacy_config = policy
        beat = json.loads((FIXTURES / "user-coarse-minimal.json").read_text(encoding="utf-8"))
        self.server.clock = lambda: beat["ts"]
        self.server.user_now = UserNow(clock=self.server.clock)  # the fixture's absence id comes from this start
        full = json.loads((FIXTURES / "user-coarse-reply.json").read_text(encoding="utf-8"))
        minimal = {"presence": "present", "stage": "normal", "doing": "idle", "absence": None, "revision": 1, "typing": True}
        for name, expected in (("minimal", (200, minimal)), ("full", (200, full)),
                               ("invalid", (400, {"error": "invalid_coarse"}))):
            with self.subTest(name=name):
                beat = json.loads((FIXTURES / f"user-coarse-{name}.json").read_text(encoding="utf-8"))
                self.assertEqual(request(self.server, "POST", "/user/coarse", beat), expected)
        reply = json.loads((FIXTURES / "user-now.json").read_text(encoding="utf-8"))
        status, real = self.get("/user/now", UI)
        self.assertIsInstance(real["snapshot"]["flags"].pop("late_night"), bool)  # the local hour of the fixture ts
        reply["snapshot"]["flags"].pop("late_night")
        self.assertEqual((status, real), (200, reply))

    def test_get_bodies_match_fixtures(self):
        loose = json.loads((FIXTURES / "loose-fields.json").read_text(encoding="utf-8"))
        backed = [r for r in REGISTRY if r.method == "GET" and r.response is not None]
        self.assertTrue(backed)
        for route in backed:
            path = re.sub(r":(\w+)", lambda m: self.params[m[1]], (route.templates or (route.path,))[0])
            name = route.response
            with self.subTest(method=route.method, path=path):
                self.assertEqual(route.method, "GET")
                status, real = self.get(path, TOKENS[route.tokens[0]] if route.tokens else None)
                self.assertEqual(status, 200)
                fixture = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
                self.assertEqual(mismatches(fixture, real, loose["nullable"].get(name, []),
                                            loose["free_keys"].get(name, [])), [])
                if name == "memory.json":
                    self.assertEqual(len(real["facts"]), 2)
                    for fact in real["facts"]:
                        self.assert_fixture(name, {**real, "facts": [fact]})


if __name__ == "__main__":
    unittest.main()
