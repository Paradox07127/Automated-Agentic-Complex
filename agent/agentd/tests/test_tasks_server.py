import datetime
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
import unittest.mock

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from daemon.agentd_server import AgentdServer  # noqa: E402
from personal.rituals import Rituals  # noqa: E402
from sessions import day_summary  # noqa: E402
from sessions.events import normalize_claude  # noqa: E402
from sessions.own import SessionManager  # noqa: E402
from sessions.tasks import verify_argv  # noqa: E402
from infra.store import open_store  # noqa: E402
from sessions.tasks import TaskLedger  # noqa: E402
import test_server  # noqa: E402
from support import enable_plugins, serve_in_thread  # noqa: E402

HOOK, UI = "hook-token", "ui-token"


def no_network(*_, **__):
    raise AssertionError("network call")


class TaskServerTest(unittest.TestCase):
    """One task_id from the dispatch card through its session to a verified result."""
    request = test_server.SayTest.request

    def setUp(self):
        enable_plugins(self)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "agentd.sqlite"
        process = unittest.mock.patch("sessions.own.ClaudeProcess", test_server.FakeProcess)
        process.start()
        self.addCleanup(process.stop)
        self.server = self.start()

    def start(self):
        """A server with its own ledger on the shared db, as main() builds one."""
        server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
        db = open_store(self.path)
        self.addCleanup(db.close)
        manager = SessionManager(server.broker, server.announce, Path(self.tmp.name),
                                 f"http://127.0.0.1:{server.server_port}", HOOK, 10)
        self.addCleanup(manager.close, 0)
        server.tasks = server.dispatcher.tasks = manager.tasks = TaskLedger(db)
        server.sessions = server.dispatcher.sessions = manager
        thread = serve_in_thread(server)

        def stop():
            server.shutdown()
            server.server_close()
            thread.join(2)
        self.addCleanup(stop)
        return server

    def announced(self, server=None):
        return [i["data"] for i in (server or self.server).feed.since(0) if i["event"] == "announce"]

    def tasks(self):
        status, body = self.request("GET", "/tasks")
        self.assertEqual(status, 200)
        return {t["task_id"]: t for t in body["tasks"]}

    def until(self, task_id, *states):
        for _ in range(300):
            task = self.tasks().get(task_id)
            if task is not None and task["state"] in states:
                return task
            time.sleep(0.01)
        self.fail(f"{task_id} is {task and task['state']}")

    def dispatch(self, verify_cmd=None, mode=None):
        """POST /say → card → allow; the task once it runs and its session."""
        body = {"text": "让 claude 改一下 README", "cwd": self.tmp.name}
        if verify_cmd is not None:
            body["verify_cmd"] = verify_cmd
        status, said = self.request("POST", "/say", body)
        self.assertEqual(status, 202)
        request_id = said["request_id"]
        [card] = self.request("GET", "/approvals")[1]["approvals"]
        self.assertEqual(card["dispatch"]["verify_cmd"], verify_cmd)
        self.assertEqual(self.tasks()[request_id]["state"], "proposed")
        decision = {"decision": "allow", "generation": card["generation"], **({"mode": mode} if mode else {})}
        self.assertEqual(self.request("POST", f"/approvals/{request_id}/decision", decision)[0], 200)
        task = self.until(request_id, "running")
        session = self.server.sessions.sessions[task["session_id"]]
        return task, session

    def end_turn(self, session, status, text=None):
        self.server.sessions.turn_ended(session, status, text, backend=session.backend)

    def test_a_returned_task_without_verify_cmd_needs_review(self):
        task, session = self.dispatch()
        self.assertEqual((task["title"], task["mode"], task["target"], task["cwd"]),
                         ("改一下 README", "read_only", "claude", self.tmp.name))
        self.assertEqual(session.to_dict()["task_id"], task["task_id"])
        self.end_turn(session, "completed", "改好了")
        self.assertEqual(self.until(task["task_id"], "needs_review")["result"]["reason"], "no_verify_cmd")
        for _ in range(100):
            if self.announced():
                break
            time.sleep(0.01)
        [review] = self.announced()
        self.assertEqual((review["kind"], review["level"], review["headline"], review["detail"], review["state"]),
                         ("dispatch_review", "P2", "claude 回话了，结果待你确认", "改好了", "terminal"))

    def verified(self, code):
        calls = []

        def runner(argv, cwd, timeout):
            calls.append((argv, cwd))
            return code, b"out"
        with unittest.mock.patch("sessions.tasks.run_verify", runner):
            task, session = self.dispatch(verify_cmd="git status --short", mode="workspace_write")
            self.assertEqual(task["mode"], "workspace_write")
            self.end_turn(session, "completed", "改好了")
            task = self.until(task["task_id"], "succeeded", "failed")
            for _ in range(100):
                if self.announced():
                    break
                time.sleep(0.01)
        self.assertEqual(calls, [(verify_argv("git status --short"), self.tmp.name)])
        return task, self.announced()

    def test_a_passing_verify_cmd_succeeds_and_is_announced_done(self):
        task, [done] = self.verified(0)
        self.assertEqual((task["state"], task["result"]["exit_code"]), ("succeeded", 0))
        self.assertEqual((done["kind"], done["level"], done["headline"]),
                         ("dispatch_done", "P0", "claude 的任务完成了，验证通过"))

    def test_a_failing_verify_cmd_fails_the_task(self):
        task, [failed] = self.verified(1)
        self.assertEqual((task["state"], task["result"]["exit_code"]), ("failed", 1))
        self.assertEqual((failed["kind"], failed["level"], failed["headline"]),
                         ("dispatch_failed", "P1", "claude 的任务验证没过"))

    def test_a_failed_turn_fails_the_task_and_an_interrupted_one_cancels_it(self):
        task, session = self.dispatch()
        self.end_turn(session, "failed")
        self.assertEqual(self.until(task["task_id"], "failed")["state"], "failed")
        self.assertEqual([a["kind"] for a in self.announced()], ["dispatch_failed"])
        task, session = self.dispatch()
        self.end_turn(session, "interrupted")
        self.assertEqual(self.until(task["task_id"], "cancelled")["result"], {"reason": "interrupted"})
        time.sleep(0.1)
        self.assertEqual([a["kind"] for a in self.announced()], ["dispatch_failed"])

    def test_read_only_card_refuses_a_verify_cmd_outside_its_presets(self):
        self.assertEqual(self.request("POST", "/say", {"text": "让 claude 跑测试", "cwd": self.tmp.name,
                                                       "verify_cmd": "pytest"}),
                         (400, {"error": "invalid_verify_cmd"}))
        self.assertEqual(self.request("POST", "/say", {"text": "让 claude 跑测试", "cwd": self.tmp.name,
                                                       "verify_cmd": 1}),
                         (400, {"error": "invalid_payload", "field": "verify_cmd"}))
        self.assertEqual((self.server.broker.pending(), self.tasks()), ([], {}))

    def test_a_restart_interrupts_a_running_task_with_one_announcement(self):
        task, _ = self.dispatch()
        second = self.start()
        second.recover_tasks()
        [interrupted] = self.announced(second)
        self.assertEqual((interrupted["kind"], interrupted["level"], interrupted["headline"], interrupted["state"]),
                         ("task_interrupted", "P1", "「改一下 README」因服务重启而中断", "terminal"))
        self.assertEqual(second.tasks.get(task["task_id"])["state"], "interrupted")
        third = self.start()
        third.recover_tasks()
        self.assertEqual(self.announced(third), [])

    def test_a_restart_expires_a_card_not_yet_allowed(self):
        self.request("POST", "/say", {"text": "让 claude 改一下 README", "cwd": self.tmp.name})
        second = self.start()
        second.recover_tasks()
        self.assertEqual([(a["kind"], a["level"], a["headline"]) for a in self.announced(second)],
                         [("task_expired", "P2", "「改一下 README」尚未开始即已过期")])

    def test_accept_and_reject_settle_only_a_task_that_needs_review(self):
        accepted, session = self.dispatch()
        self.assertEqual(self.request("POST", f"/tasks/{accepted['task_id']}/accept"),
                         (409, {"error": "invalid_state"}))
        self.end_turn(session, "completed", "改好了")
        delivery = self.until(accepted["task_id"], "needs_review")["result"]["delivery_id"]
        status, body = self.request("POST", f"/tasks/{accepted['task_id']}/accept")
        self.assertEqual((status, body["task"]["state"], body["task"]["result"]["delivery_id"]), (200, "succeeded", delivery))
        [attrs] = self.server.tasks.db.execute("SELECT attrs_json FROM task_events WHERE task_id = ? AND kind = 'succeeded'",
                                               (accepted["task_id"],)).fetchone()
        self.assertEqual(json.loads(attrs), {"source": "user", "delivery_id": delivery})
        self.assertEqual(self.request("POST", f"/tasks/{accepted['task_id']}/reject"),
                         (409, {"error": "invalid_state"}))
        rejected, session = self.dispatch()
        self.end_turn(session, "completed", "改好了")
        self.until(rejected["task_id"], "needs_review")
        self.assertEqual(self.request("POST", f"/tasks/{rejected['task_id']}/reject")[1]["task"]["state"], "failed")
        self.assertEqual(self.request("POST", "/tasks/nope/accept"), (404, {"error": "unknown_task"}))
        self.assertEqual(self.request("POST", f"/tasks/{rejected['task_id']}/accept", token=HOOK)[0], 401)

    def test_tasks_and_capabilities_need_the_ui_token(self):
        self.assertEqual(self.request("GET", "/tasks", token=HOOK)[0], 401)
        self.assertEqual(self.request("GET", "/capabilities", token=HOOK)[0], 401)

    def test_day_segments_and_evening_ritual_only_read_external_activity_with_consent(self):
        root = Path(self.tmp.name) / "ledger"
        at = datetime.datetime(2026, 10, 22, 10).astimezone()
        for project, sid in (("-w-alpha", "A1"), ("-w-beta", "B1")):
            folder = root / project / "2026-10-22"
            folder.mkdir(parents=True)
            (folder / f"{sid}.jsonl").write_text(json.dumps(
                {"timestamp": at.isoformat(), "event_name": "session.start", "severity_text": "INFO",
                 "attributes": {"session.id": sid}}) + "\n", encoding="utf-8")
        self.server.ledger_root = root
        own = {"session_id": "own:1", "cwd": "/w/alpha", "title": "fix", "state": "awaiting_input",
               "last_line": None, "started_at": at.timestamp(), "updated_at": at.timestamp()}
        # busy keeps the reaper off the fake until the cleanup takes it out again
        self.server.sessions.sessions["own:1"] = type("Own", (), {"busy": True, "to_dict": lambda _: own})()
        self.addCleanup(self.server.sessions.sessions.pop, "own:1")
        self.server.registry.ingest(normalize_claude({
            "hook_event_name": "Notification", "notification_type": "idle_prompt",
            "session_id": "external-hook", "cwd": "/w/external-waiting",
        }))
        policy = Path(self.tmp.name) / "config.json"
        self.server.privacy_config = policy
        self.server.share_agent_sessions = True  # the saved config can still revoke the startup grant
        db = open_store(self.path)
        self.addCleanup(db.close)
        ritual = Rituals(db, clock=lambda: at.replace(hour=20).timestamp(), summary=self.server.day_session_summary)

        def save_policy(observe, share):
            policy.write_text(json.dumps({"observe_activity": observe, "share_agent_sessions": share}), encoding="utf-8")

        def rows():
            status, body = self.request("GET", "/day/segments?date=2026-10-22")
            self.assertEqual(status, 200)
            self.assertEqual(body["date"], "2026-10-22")
            return [(g["project"], [s["session_id"] for s in g["sessions"]],
                     [o["session_id"] for o in g["own"]]) for g in body["projects"]]

        def report():
            kind, data = ritual.pick()
            self.assertEqual(kind, "report")
            self.assertEqual(data["own_sessions"], 1)
            self.assertIn("alpha", data["waiting"])
            return data

        for observe, share in ((False, False), (False, True), (True, False), (True, True)):
            with self.subTest(observe=observe, share=share):
                save_policy(observe, share)
                allowed = share
                with unittest.mock.patch.object(day_summary, "_ledger_paths", wraps=day_summary._ledger_paths) as paths:
                    self.assertEqual(rows(), [("-w-alpha", ["A1"], ["own:1"]), ("-w-beta", ["B1"], [])]
                                     if allowed else [("-w-alpha", [], ["own:1"])])
                    data = report()
                    self.assertEqual(data["sessions"], 2 if allowed else 0)
                    self.assertEqual("external-waiting" in data["waiting"], allowed)
                    self.assertEqual([call.args[0] for call in paths.call_args_list], [root if allowed else None] * 2)

        self.server.set_paused_until(self.server.clock() + 120)
        self.assertEqual(rows(), [("-w-alpha", [], ["own:1"])])
        self.assertEqual(report()["sessions"], 0)
        self.server.set_paused_until(None)
        with unittest.mock.patch.dict("infra.plugins.resolved", coding_sessions=False):
            self.assertEqual(rows(), [("-w-alpha", [], ["own:1"])])
            self.assertEqual(report()["sessions"], 0)

        def revoke_during_read(ledger_root, day):
            found = real_paths(ledger_root, day)
            if ledger_root is not None:
                save_policy(True, False)
            return found

        real_paths = day_summary._ledger_paths
        with unittest.mock.patch.object(day_summary, "_ledger_paths", side_effect=revoke_during_read):
            self.assertEqual(rows(), [("-w-alpha", [], ["own:1"])])
            save_policy(True, True)
            self.assertEqual(report()["sessions"], 0)
        self.assertEqual(rows(), [("-w-alpha", [], ["own:1"])])
        self.assertEqual(self.request("GET", "/day/segments?date=2026-13-01"), (400, {"error": "invalid_date"}))
        self.assertEqual(self.request("GET", "/day/segments?date=2026-10-22", token=None)[0], 401)

    def test_capabilities_reads_existing_state_only(self):
        with unittest.mock.patch.object(httpx.Client, "send", no_network), \
                unittest.mock.patch.object(httpx.AsyncClient, "send", no_network):
            status, body = self.request("GET", "/capabilities")
        self.assertEqual(status, 200)
        self.assertEqual(body["items"]["mouth"], {"state": "unavailable", "reason": "no_llm"})
        self.assertEqual(body["items"]["voice"], {"state": "unavailable", "reason": "no_tts"})
        self.assertIsInstance(body["at"], str)


if __name__ == "__main__":
    unittest.main()
