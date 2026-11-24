from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sessions.approvals import ApprovalBroker  # noqa: E402
from brain.parser import parse_command  # noqa: E402
from sessions.dispatch import Dispatcher  # noqa: E402
from infra.store import open_store  # noqa: E402
from sessions.tasks import TaskLedger  # noqa: E402


class FakeSessions:
    def __init__(self, fail=None):
        self.created, self.modes, self.announced = [], [], []
        self.fail = fail
        self.done = threading.Event()
        self.heard = threading.Event()
        self.language = None

    def reply_language(self):
        return self.language

    def create(self, target, cwd, prompt, origin=None, mode="read_only"):
        if self.fail is not None:
            raise self.fail
        self.created.append((target, cwd, prompt))
        self.modes.append(mode)
        self.done.set()

    def announce(self, announcement):
        self.announced.append(announcement)
        self.heard.set()


class DispatchTest(unittest.TestCase):
    def setUp(self):
        self.broker = ApprovalBroker(hook_timeout=5.5, margin=0.5)
        self.sessions = FakeSessions()

    def dispatcher(self):
        return Dispatcher(self.broker, self.sessions)

    def test_parser_proposes_dispatch_only_for_named_agents(self):
        self.assertEqual(parse_command("让 Codex 查一下这个仓库的测试怎么跑"),
                         {"action": "dispatch", "target": "codex", "prompt": "查一下这个仓库的测试怎么跑"})
        self.assertEqual(parse_command("示例甲，让claude总结一下 README。"),
                         {"action": "dispatch", "target": "claude", "prompt": "总结一下 README。"})
        self.assertIsNone(parse_command("让我想想"))
        self.assertIsNone(parse_command("让 Codex"))

    def test_card_shows_target_cwd_and_full_prompt(self):
        self.dispatcher().propose("codex", "/repo", "查一下测试怎么跑")
        [card] = self.broker.pending()
        self.assertEqual((card["kind"], card["tool_name"]), ("dispatch", "codex"))
        self.assertEqual(card["dispatch"], {"target": "codex", "cwd": "/repo", "prompt": "查一下测试怎么跑",
                                            "source": "text", "utterance": None,
                                            "modes": ["read_only", "workspace_write"], "mode": "read_only",
                                            "verify_cmd": None, "cwd_from": None})

    def test_nothing_runs_without_a_click(self):
        self.dispatcher().propose("claude", "/repo", "x")
        [card] = self.broker.pending()
        self.broker.decide(card["request_id"], card["generation"], "deny")
        time.sleep(0.2)
        self.assertEqual(self.sessions.created, [])
        dispatcher = self.dispatcher()
        dispatcher.window = 0.1
        dispatcher.propose("claude", "/repo", "y")
        time.sleep(0.4)
        self.assertEqual(self.sessions.created, [])

    def test_card_says_where_its_cwd_came_from(self):
        cwd_from = {"source": "focus", "display_session": "claude:B", "state": "error"}
        self.dispatcher().propose("codex", "/repo", "x", cwd_from=cwd_from)
        [card] = self.broker.pending()
        self.assertEqual(card["dispatch"]["cwd_from"], cwd_from)

    def test_dispatch_card_outlives_the_hook_window(self):
        request = self.dispatcher().propose("codex", "/repo", "x")
        self.assertGreater(request.deadline - request.created, 500)

    def test_expiry_is_announced(self):
        dispatcher = self.dispatcher()
        dispatcher.window = 0.1
        request = dispatcher.propose("codex", "/repo", "x")
        self.assertTrue(self.sessions.heard.wait(2))
        [announcement] = self.sessions.announced
        self.assertIsInstance(announcement.pop("ts"), float)
        self.assertEqual(announcement, {"kind": "dispatch_closed", "level": "P2",
                                        "headline": "派给 codex 的活过期了，没有开始",
                                        "project": "/repo", "session_id": None, "detail": None,
                                        "origin": request.request_id})
        self.assertEqual(self.sessions.created, [])

    def test_headlines_follow_the_reply_language(self):
        for code, headline in (("en", "The job for codex expired before it started"),
                               ("zh-Hans", "派给 codex 的活过期了，没有开始")):
            with self.subTest(code=code):
                self.sessions = FakeSessions()
                self.sessions.language = code
                dispatcher = self.dispatcher()
                dispatcher.window = 0.1
                dispatcher.propose("codex", "/repo", "x")
                self.assertTrue(self.sessions.heard.wait(2))
                self.assertEqual([a["headline"] for a in self.sessions.announced], [headline])
        self.sessions = FakeSessions(fail=OSError("disk full"))
        self.sessions.language = "en"
        request = self.dispatcher().propose("codex", "/repo", "x")
        self.broker.decide(request.request_id, request.generation, "allow")
        self.assertTrue(self.sessions.heard.wait(2))
        self.assertEqual([a["headline"] for a in self.sessions.announced], ["codex's task could not start"])

    def test_deny_is_not_announced(self):
        seen = []
        dispatcher = self.dispatcher()
        dispatcher.on_decision = lambda kind, attrs, key: seen.append(kind)
        request = dispatcher.propose("codex", "/repo", "x")
        self.broker.decide(request.request_id, request.generation, "deny")
        deadline = time.monotonic() + 2
        while "dispatch.decided" not in seen and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.1)
        self.assertEqual(seen, ["dispatch.proposed", "dispatch.decided"])
        self.assertEqual(self.sessions.announced, [])

    def test_a_failed_start_is_announced(self):
        self.sessions = FakeSessions(fail=OSError("disk full"))
        seen = []
        dispatcher = self.dispatcher()
        dispatcher.on_decision = lambda kind, attrs, key: seen.append((kind, attrs))
        request = dispatcher.propose("codex", "/repo", "x")
        self.broker.decide(request.request_id, request.generation, "allow")
        self.assertTrue(self.sessions.heard.wait(2))
        [announcement] = self.sessions.announced
        self.assertIsInstance(announcement.pop("ts"), float)
        self.assertEqual(announcement, {"kind": "dispatch_failed", "level": "P1",
                                        "headline": "codex 的任务没能开始",
                                        "project": "/repo", "session_id": None, "detail": None,
                                        "origin": request.request_id})
        deadline = time.monotonic() + 2
        while len(seen) < 3 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(seen[-1], ("dispatch.failed", {"request_id": request.request_id, "error": "OSError"}))

    def test_allow_starts_an_own_session(self):
        self.dispatcher().propose("codex", "/repo", "查一下测试怎么跑")
        [card] = self.broker.pending()
        self.broker.decide(card["request_id"], card["generation"], "allow")
        self.assertTrue(self.sessions.done.wait(2))
        self.assertEqual(self.sessions.created, [("codex", "/repo", "查一下测试怎么跑")])
        self.assertEqual(self.sessions.modes, ["read_only"])

    def test_chosen_mode_reaches_the_session(self):
        seen = []
        dispatcher = self.dispatcher()
        dispatcher.on_decision = lambda kind, attrs, key: seen.append((kind, attrs))
        request = dispatcher.propose("codex", "/repo", "改测试")
        self.assertEqual(self.broker.decide(request.request_id, request.generation, "allow", mode="workspace_write"),
                         (True, None))
        self.assertTrue(self.sessions.done.wait(2))
        self.assertEqual(self.sessions.modes, ["workspace_write"])
        self.assertEqual(seen[-1], ("dispatch.decided", {"request_id": request.request_id, "decision": "allow",
                                                         "mode": "workspace_write"}))

    def test_unsupported_mode_leaves_the_card_pending(self):
        request = self.dispatcher().propose("codex", "/repo", "改测试")
        for mode in ("bypassPermissions", "danger-full-access", "bypass", ["read_only"], 1):
            with self.subTest(mode=mode):
                self.assertEqual(self.broker.decide(request.request_id, request.generation, "allow", mode=mode),
                                 (False, "unsupported_mode"))
                self.assertEqual(request.status, "pending")

    def test_mode_on_a_tool_card_is_invalid(self):
        request = self.broker.open("claude", "A", "Bash", tool_summary="ls")
        self.assertEqual(self.broker.decide(request.request_id, request.generation, "allow", mode="read_only"),
                         (False, "invalid_mode"))
        self.assertEqual(request.status, "pending")

    def test_proposal_and_answer_are_reported(self):
        seen = []
        dispatcher = self.dispatcher()
        dispatcher.on_decision = lambda kind, attrs, key: seen.append((kind, attrs, key))
        request = dispatcher.propose("codex", "/repo", "查一下测试怎么跑")
        self.broker.decide(request.request_id, request.generation, "allow")
        self.assertTrue(self.sessions.done.wait(2))
        self.assertEqual([(kind, attrs["request_id"], attrs.get("decision"), key) for kind, attrs, key in seen],
                         [("dispatch.proposed", request.request_id, None, request.request_id),
                          ("dispatch.decided", request.request_id, "allow", request.request_id)])
        self.assertNotIn("查一下测试怎么跑", str(seen))

    def test_a_task_that_cannot_be_stored_leaves_no_card(self):
        class Locked:
            def create(self, *args, **kwargs):
                raise sqlite3.OperationalError("database is locked")
        dispatcher = self.dispatcher()
        dispatcher.tasks = Locked()
        with self.assertRaises(sqlite3.OperationalError):
            dispatcher.propose("codex", "/repo", "x")
        self.assertEqual(self.broker.pending(), [])

    def test_a_dispatch_retired_by_shutdown_cancels_its_task(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        db = open_store(Path(folder.name) / "tasks.sqlite")
        self.addCleanup(db.close)
        dispatcher = self.dispatcher()
        dispatcher.tasks = TaskLedger(db)
        request = dispatcher.propose("codex", "/repo", "x")
        self.broker.cancel_all("shutdown")
        deadline = time.monotonic() + 2
        while dispatcher.tasks.get(request.request_id)["state"] == "proposed" and time.monotonic() < deadline:
            time.sleep(0.01)
        task = dispatcher.tasks.get(request.request_id)
        self.assertEqual((task["state"], task["result"]), ("cancelled", {"reason": "shutdown"}))

    def test_a_failing_decision_callback_changes_nothing(self):
        dispatcher = self.dispatcher()
        dispatcher.on_decision = lambda *_: 1 / 0
        request = dispatcher.propose("codex", "/repo", "x")
        self.broker.decide(request.request_id, request.generation, "allow")
        self.assertTrue(self.sessions.done.wait(2))


if __name__ == "__main__":
    unittest.main()
