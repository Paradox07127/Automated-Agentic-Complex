import json
import os
from pathlib import Path
import signal
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sessions.approvals import ApprovalBroker  # noqa: E402
from sessions.dispatch import Dispatcher  # noqa: E402
from sessions.lifecycle import SessionRun  # noqa: E402
from sessions.own import DETAIL_MAX, MODES, ClaudeProcess, CodexProcess, OwnSession, SessionManager  # noqa: E402
from infra.store import open_store  # noqa: E402
from sessions.tasks import TaskLedger  # noqa: E402

HOOK = "hook-token"


def script_argv(script):
    return lambda *_, **__: [sys.executable, "-c", script]


def exists(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


class OwnSessionTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        self.folder = self.tmp.name
        self.broker = ApprovalBroker()
        self.announced = []

    def manager(self, argv=None):
        manager = SessionManager(self.broker, self.announced.append, Path(self.folder), "http://127.0.0.1:1", HOOK, 10,
                                 **({"argv": argv} if argv is not None else {}))
        self.addCleanup(manager.close, 0)
        return manager

    def ledger(self, *task_ids):
        db = open_store(Path(self.folder) / "tasks.sqlite")
        self.addCleanup(db.close)
        tasks = TaskLedger(db)
        for task_id in task_ids:
            tasks.create(task_id, "claude", self.folder, "t", "read_only")
            tasks.transition(task_id, "approved")
        return tasks

    def wait(self, predicate, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.02)
        self.fail("timed out")


class PermissionSettingsTest(OwnSessionTestCase):
    def test_each_mode_asks_for_what_it_does_not_grant(self):
        manager = self.manager()
        expected = {"read_only": ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"], "workspace_write": ["Bash"]}
        self.assertEqual(set(manager.settings_paths), set(MODES))
        for mode, ask in expected.items():
            with self.subTest(mode=mode):
                settings = json.loads(manager.settings_paths[mode].read_text(encoding="utf-8"))
                self.assertEqual(settings["permissions"], {"ask": ask})
                self.assertEqual(settings["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"], 10)

    def test_a_session_starts_with_the_settings_of_its_mode(self):
        seen = []

        def argv(target, settings=None, resume=None, mode="read_only"):
            seen.append((mode, settings))
            return [sys.executable, "-c", "import sys; sys.stdin.read()"]
        manager = self.manager(argv)
        for mode in MODES:
            manager.create("claude", self.folder, "x", mode=mode)
        self.assertEqual(seen, [(mode, str(manager.settings_paths[mode])) for mode in MODES])


class ReaderTest(OwnSessionTestCase):
    def ends_in_error(self, script):
        manager = self.manager(script_argv(script))
        session = manager.create("claude", self.folder, "x")
        self.wait(lambda: not session.busy)
        self.assertEqual(session.state, "error")

    def test_undecodable_output_ends_the_turn(self):
        self.ends_in_error("import sys; sys.stdin.readline(); sys.stdout.buffer.write(b'\\xff\\n'); sys.stdout.flush()")

    def test_a_message_the_handler_cannot_read_ends_the_turn(self):
        with self.assertLogs("sessions.own", "ERROR"):
            self.ends_in_error("import sys; sys.stdin.readline(); print('{\"type\": \"assistant\", \"message\": \"x\"}',"
                               " flush=True)")

    def test_an_old_process_exit_does_not_end_the_turn_that_replaced_it(self):
        manager = self.manager()
        session = OwnSession("claude", self.folder, "x")
        manager.sessions[session.session_id] = session
        old, new = unittest.mock.Mock(), unittest.mock.Mock()
        session.backend = old

        def replaced(*_):
            # message() replacing the dead process and starting a turn, between the exit's check and its end.
            session.backend, session.busy, session.run = new, True, SessionRun()
        self.broker.cancel_session = replaced
        manager.exited(session, old)
        self.assertTrue(session.busy)

    def test_a_session_deleted_while_reaped_does_not_break_the_reaper(self):
        manager = self.manager()
        session = OwnSession("claude", self.folder, "x")
        manager.sessions[session.session_id] = session
        backend = session.backend = unittest.mock.Mock()
        original = manager.cancel_computer

        def cancel(target, reason):
            if reason == "own_idle":
                self.assertEqual(manager.manage(session.session_id, {"expected_version": session.revision},
                                                delete=True), (200, {"deleted": True}))
            original(target, reason)
        manager.cancel_computer = cancel
        manager.reap(now=time.monotonic() + manager.idle_after + 1)
        backend.stop.assert_called_once_with()

    def test_a_failed_turn_announces_its_text(self):
        manager = self.manager()
        session = OwnSession("claude", self.folder, "x")
        manager.sessions[session.session_id] = session
        session.busy = True
        manager.turn_ended(session, "failed", "API Error: overloaded")
        [announcement] = self.announced
        self.assertEqual((announcement["kind"], announcement["detail"]), ("session_failed", "API Error: overloaded"))


# The CLI stand-in starts a child that outlives it, writes its pid to argv[1], and exits.
LEAVES_A_CHILD = r'''
import os, subprocess, sys
sys.stdin.readline()
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                         stdout=subprocess.DEVNULL if sys.argv[2] == "detached" else None)
with open(sys.argv[1] + ".tmp", "w") as f:
    f.write(str(child.pid))
os.replace(sys.argv[1] + ".tmp", sys.argv[1])
'''


class ProcessGroupTest(OwnSessionTestCase):
    def child_of(self, kind):
        pid_file = Path(self.folder) / f"{kind}.pid"
        manager = self.manager(lambda *_, **__: [sys.executable, "-c", LEAVES_A_CHILD, str(pid_file), kind])
        session = manager.create("claude", self.folder, "x")
        self.wait(pid_file.exists)
        pid = int(pid_file.read_text(encoding="utf-8"))
        self.addCleanup(self.kill, pid)
        self.wait(lambda: session.backend is not None and not session.backend.alive())
        return manager, session, pid

    @staticmethod
    def kill(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    @unittest.skipIf(sys.platform == "win32", "POSIX process groups")
    def test_close_stops_what_the_cli_left_running(self):
        manager, _, pid = self.child_of("inherits_stdout")
        manager.close(2)
        self.wait(lambda: not exists(pid))

    @unittest.skipIf(sys.platform == "win32", "POSIX process groups")
    def test_a_cli_that_exits_takes_what_it_left_running(self):
        _, session, pid = self.child_of("detached")
        self.wait(lambda: not session.busy)
        self.wait(lambda: not exists(pid))

    def test_a_start_that_fails_after_spawn_leaves_no_child(self):
        made = []

        class Recorded(ClaudeProcess):
            def __init__(self, *args):
                super().__init__(*args)
                made.append(self)
        manager = self.manager(script_argv("import sys; sys.stdin.read()"))
        original = manager.add_line

        def add_line(session, role, text):
            if role == "user":
                raise sqlite3.OperationalError("database is locked")
            original(session, role, text)
        manager.add_line = add_line
        with unittest.mock.patch("sessions.own.ClaudeProcess", Recorded):
            session = manager.create("claude", self.folder, "x")
        self.assertEqual(session.state, "error")
        [backend] = made
        self.assertIsNotNone(backend.proc.poll())

    def test_a_group_that_cannot_be_tracked_leaves_no_child(self):
        procs = []

        def track(proc):
            procs.append(proc)
            raise OSError("job assignment failed")
        manager = self.manager(script_argv("import sys; sys.stdin.read()"))
        with unittest.mock.patch("sessions.own.track_group", track):
            session = manager.create("claude", self.folder, "x")
        self.assertEqual(session.state, "error")
        [proc] = procs
        self.assertIsNotNone(proc.poll())


class AdmissionTest(OwnSessionTestCase):
    def test_reset_admits_no_session_after_its_snapshot(self):
        tasks = self.ledger("t1")
        manager = self.manager()
        manager.tasks = tasks
        made, errors = [], []
        original = manager._stop

        def paused(timeout):
            original(timeout)
            try:
                manager.create("claude", self.folder, "late", origin="t1")
            except RuntimeError as error:
                errors.append(error)
        manager._stop = paused
        with unittest.mock.patch("sessions.own.ClaudeProcess", lambda *args: made.append(args)):
            manager.stop_all(0)
        self.assertEqual((made, len(errors), manager.sessions), ([], 1, {}))
        task = tasks.get("t1")
        self.assertEqual((task["state"], task["result"]), ("cancelled", {"reason": "closed"}))

    def test_a_dispatched_task_does_not_stay_running_after_close(self):
        tasks = self.ledger("t1")
        manager = self.manager()
        manager.tasks = tasks
        manager.close(0)
        with self.assertRaises(RuntimeError):
            manager.create("claude", self.folder, "late", origin="t1")
        self.assertEqual(tasks.get("t1")["state"], "cancelled")

    def test_a_dispatch_allowed_after_close_reports_start_failed(self):
        tasks = self.ledger()
        manager = self.manager()
        manager.tasks = tasks
        dispatcher = Dispatcher(self.broker, manager)
        dispatcher.tasks = tasks
        manager.close(0)
        request = dispatcher.propose("claude", self.folder, "x")
        self.assertEqual(self.broker.decide(request.request_id, request.generation, "allow"), (True, None))
        self.wait(lambda: self.announced)
        self.assertEqual(self.announced[0]["kind"], "dispatch_failed")
        self.assertEqual(tasks.get(request.request_id)["state"], "cancelled")


class CodexApprovalTest(OwnSessionTestCase):
    def setUp(self):
        super().setUp()
        self.manager_ = self.manager()
        self.session = OwnSession("codex", self.folder, "x")
        self.session.native_id = "thr-1"
        self.manager_.sessions[self.session.session_id] = self.session
        self.session.busy, self.session.run = True, SessionRun()
        self.session.run.phase = "running"
        self.backend = CodexProcess.__new__(CodexProcess)
        self.backend.manager, self.backend.session, self.backend.changes = self.manager_, self.session, {}
        self.written = []
        self.backend.write = self.written.append

    def answer(self, method, params, decision=None):
        """Codex's request answered on its own thread; decision answers the card it opens, if any."""
        message = {"id": 7, "method": method, "params": params}
        thread = threading.Thread(target=self.backend._approval, args=(message, self.session.run))
        thread.start()
        card = None
        if decision is not None:
            self.wait(self.broker.pending)
            [card] = self.broker.pending()
            self.broker.decide(card["request_id"], card["generation"], decision)
        thread.join(5)
        self.assertFalse(thread.is_alive())
        [reply] = self.written
        self.assertEqual(reply["id"], 7)
        return card, reply

    def test_a_permissions_request_too_long_to_show_is_declined(self):
        permissions = {"fileSystem": {"write": [f"/repo/dir{i}" for i in range(1000)]}}
        _, reply = self.answer("item/permissions/requestApproval", {"reason": "needs write", "permissions": permissions})
        self.assertEqual(reply["result"], {"permissions": {}, "scope": "turn"})
        self.assertEqual(self.broker.pending(), [])

    def test_a_clipped_permissions_card_says_so_and_shows_every_permission(self):
        permissions = {"fileSystem": {"write": ["/repo"]}}
        card, reply = self.answer("item/permissions/requestApproval", {"reason": "r" * 10000, "permissions": permissions},
                                  decision="allow")
        self.assertEqual((card["summary_truncated"], card["summary_length"]), (True, 10000 + 1 + len(json.dumps(permissions))))
        self.assertEqual(len(card["tool_summary"]), DETAIL_MAX)
        self.assertTrue(card["tool_summary"].startswith(json.dumps(permissions)))
        self.assertEqual(reply["result"], {"permissions": permissions, "scope": "turn"})

    def test_a_form_with_fields_is_declined_without_a_card(self):
        _, reply = self.answer("mcpServer/elicitation/request", {
            "serverName": "other", "message": "Your name?", "mode": "form",
            "requestedSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}})
        self.assertEqual(reply["result"], {"action": "decline", "content": None})
        self.assertEqual(self.broker.pending(), [])

    def test_a_file_change_without_its_kind_is_declined(self):
        self.backend.changes["f1"] = [{"path": "/repo/a.txt", "diff": "+a"}]
        with self.assertLogs("sessions.own", "ERROR"):
            _, reply = self.answer("item/fileChange/requestApproval", {"itemId": "f1"})
        self.assertEqual(reply["result"], {"decision": "decline"})

    def test_a_large_diff_is_clipped_on_the_card(self):
        self.backend.changes["f1"] = [{"path": "/repo/a.txt", "kind": {"type": "add"}, "diff": "+" * 100000}]
        card, reply = self.answer("item/fileChange/requestApproval", {"itemId": "f1"}, decision="deny")
        self.assertEqual((len(card["tool_summary"]), card["summary_truncated"]), (DETAIL_MAX, True))
        self.assertEqual(reply["result"], {"decision": "decline"})

    def test_a_request_handled_after_its_turn_ended_is_declined(self):
        self.manager_.turn_ended(self.session, "completed", None)
        _, reply = self.answer("item/commandExecution/requestApproval", {"itemId": "c1", "command": "ls"})
        self.assertEqual(reply["result"], {"decision": "decline"})
        self.assertEqual(self.broker.pending(), [])


if __name__ == "__main__":
    unittest.main()
