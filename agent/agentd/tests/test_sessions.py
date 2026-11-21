import http.client
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sessions.approvals import ApprovalBroker  # noqa: E402
from character.gate import Gate  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from sessions.own import LINES_KEPT, CodexProcess, OwnSession, SessionManager, child_env, real_argv  # noqa: E402
from infra.store import open_store  # noqa: E402
from sessions.tasks import TaskLedger  # noqa: E402
import test_server  # noqa: E402
from support import serve_in_thread  # noqa: E402

HOOK, UI = "hook-token", "ui-token"
FAKES = Path(__file__).resolve().parent / "fakes"
# A codex app-server stand-in for one turn/start behaviour (argv: mode, log of received lines, go file).
SCRIPTED_CODEX = r'''
import json, os, sys, time
mode, log, go = sys.argv[1:4]

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def wait_go():
    while not os.path.exists(go):
        time.sleep(0.02)

started = {"method": "turn/started", "params": {"threadId": "thr-1", "turn": {"id": "turn-1", "status": "inProgress"}}}
for line in sys.stdin:
    with open(log, "a") as f:
        f.write(line)
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        emit({"id": msg["id"], "result": {}})
    elif method in ("thread/start", "thread/resume"):
        emit({"id": msg["id"], "result": {"thread": {"id": "thr-1"}}})
    elif method == "turn/start" and mode == "answer":
        emit({"id": msg["id"], "result": {"turn": {"id": "turn-1", "status": "inProgress"}}})
        emit(started)
        emit({"method": "turn/completed", "params": {"threadId": "thr-1", "turn": {
            "id": "turn-1", "status": "completed", "items": [], "error": None}}})
    elif method == "turn/start" and mode == "error":
        emit({"id": msg["id"], "error": {"code": -32000, "message": "rejected"}})
    elif method == "turn/start" and mode == "interrupt":
        emit({"id": msg["id"], "result": {"turn": {"id": "turn-1", "status": "inProgress"}}})
        wait_go()
        emit(started)
    elif method == "turn/start" and mode in ("fileChange", "fileChangeRc"):
        emit({"id": msg["id"], "result": {"turn": {"id": "turn-1", "status": "inProgress"}}})
        emit(started)
        second = "/Users/me/.zshrc" if mode == "fileChangeRc" else "/repo/b.txt"
        emit({"method": "item/started", "params": {"threadId": "thr-1", "turnId": "turn-1", "item": {
            "type": "fileChange", "id": "f1", "status": "inProgress", "changes": [
                {"path": "/repo/a.txt", "kind": {"type": "add"}, "diff": "+alpha"},
                {"path": second, "kind": {"type": "update", "move_path": None}, "diff": "-old\n+new"}]}}})
        emit({"id": 100, "method": "item/fileChange/requestApproval", "params": {
            "threadId": "thr-1", "turnId": "turn-1", "itemId": "f1", "reason": "needs write"}})
        wait_go()
        emit({"method": "turn/completed", "params": {"threadId": "thr-1", "turn": {
            "id": "turn-1", "status": "completed", "items": [], "error": None}}})
    elif method == "turn/start" and mode == "commandArray":
        emit({"id": msg["id"], "result": {"turn": {"id": "turn-1", "status": "inProgress"}}})
        emit(started)
        emit({"id": 100, "method": "item/commandExecution/requestApproval", "params": {
            "threadId": "thr-1", "turnId": "turn-1", "itemId": "c1", "command": ["bash", "-lc", "rm -rf ~"]}})
        wait_go()
        emit({"method": "turn/completed", "params": {"threadId": "thr-1", "turn": {
            "id": "turn-1", "status": "completed", "items": [], "error": None}}})
    elif method == "turn/start" and mode == "stale":
        emit({"id": msg["id"], "result": {"turn": {"id": "turn-2", "status": "inProgress"}}})
        emit({"method": "turn/started", "params": {"threadId": "thr-1", "turn": {"id": "turn-2", "status": "inProgress"}}})
        emit({"method": "item/completed", "params": {"item": {"type": "agentMessage", "text": "旧的"}}})
        emit({"method": "turn/completed", "params": {"threadId": "thr-1", "turn": {
            "id": "turn-1", "status": "completed", "items": [], "error": None}}})
        wait_go()
        emit({"method": "item/completed", "params": {"item": {"type": "agentMessage", "text": "新的"}}})
        emit({"method": "turn/completed", "params": {"threadId": "thr-1", "turn": {
            "id": "turn-2", "status": "completed", "items": [], "error": None}}})
    elif method == "turn/interrupt":
        emit({"id": msg["id"], "result": {}})
        emit({"method": "turn/completed", "params": {"threadId": "thr-1", "turn": {
            "id": "turn-1", "status": "interrupted", "items": [], "error": None}}})
'''
# An own-session backend for close() (argv: folder, kind); writes <folder>/<pid> with the pids it owns.
CLOSE_BACKEND = r'''
import os, signal, subprocess, sys
folder, kind = sys.argv[1:3]
pids = [os.getpid()]
if kind == "grandchild":
    pids.append(subprocess.Popen(["sleep", "60"]).pid)
else:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
path = os.path.join(folder, str(os.getpid()))
with open(path + ".tmp", "w") as f:
    f.write(" ".join(map(str, pids)))
os.replace(path + ".tmp", path)
sys.stdin.read()
'''


def fake_argv(target, settings=None, resume=None, mode="read_only"):
    if target == "codex":
        return [sys.executable, str(FAKES / "fake_codex.py")]
    return [sys.executable, str(FAKES / "fake_claude.py"), "--settings", settings] + (
        ["--resume", resume] if resume else [])


class StartupCancellationTest(unittest.TestCase):
    def test_delayed_old_process_exit_does_not_finish_the_replacement_turn(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as folder:
            manager=SessionManager(ApprovalBroker(),lambda _:None,Path(folder),"http://127.0.0.1:1",HOOK,10)
            session=OwnSession("claude",folder,"old task")
            old=unittest.mock.Mock();old.alive.return_value=False
            session.backend=old;manager.sessions[session.session_id]=session
            sent=[]
            class Replacement:
                def __init__(self,*_):manager.exited(session,old)
                def alive(self):return True
                def send(self,text):sent.append((text,session.busy))
                def interrupt(self):pass
                def stop(self,timeout=0):pass
            with unittest.mock.patch("sessions.own.ClaudeProcess",Replacement):
                self.assertEqual(manager.message(session.session_id,"new task"),"started")
            self.assertEqual(sent,[("new task",True)])
            self.assertEqual(session.run.phase,"running")
            manager.close(0)

    def test_interrupt_reaches_a_cli_blocked_in_initialize(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as folder:
            log=Path(folder)/"handshake.log"
            # The log appears whole (temp file, then rename): the test reads it as soon as it exists.
            script=("import os,pathlib,sys,time\n"
                    "for line in sys.stdin:\n"
                    f" pathlib.Path({str(log)+'.tmp'!r}).write_text(line)\n"
                    f" os.replace({str(log)+'.tmp'!r},{str(log)!r})\n"
                    " time.sleep(30)\n")
            manager=SessionManager(ApprovalBroker(),lambda _:None,Path(folder),"http://127.0.0.1:1",HOOK,10,
                                   argv=lambda *_,**__: [sys.executable,"-u","-c",script])
            manager.check_codex_version=lambda:None
            errors=[]
            def create():
                try:manager.create("codex",folder,"never send")
                except Exception as error:errors.append(error)
            thread=threading.Thread(target=create);thread.start()
            try:
                deadline=time.monotonic()+3;handshake=None
                while handshake is None and time.monotonic()<deadline:
                    try:handshake=log.read_text(encoding="utf-8")
                    # PermissionError: on Windows the child's rename can still hold the new name open.
                    except (FileNotFoundError,PermissionError):time.sleep(0.01)
                self.assertIsNotNone(handshake)
                sid=next(iter(manager.sessions));session=manager.sessions[sid]
                self.assertEqual(json.loads(handshake)["method"],"initialize")
                backend=session.run.backend
                self.assertEqual(manager.interrupt(sid),"interrupted")
                thread.join(2)
                self.assertFalse(thread.is_alive());self.assertFalse(backend.alive())
                self.assertFalse(session.busy);self.assertEqual(errors,[])
                self.assertNotIn('turn/start',log.read_text(encoding="utf-8"))
            finally:
                manager.close(0);thread.join(2)

    def test_interrupt_close_and_reset_fence_a_late_constructor(self):
        for action in ("interrupt", "close", "reset"):
            with self.subTest(action=action), tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as folder:
                manager=SessionManager(ApprovalBroker(),lambda _:None,Path(folder),"http://127.0.0.1:1",HOOK,10)
                entered,release=threading.Event(),threading.Event()
                sent,stopped,errors=[],[],[]
                class SlowProcess:
                    def __init__(self,*_):
                        entered.set()
                        if not release.wait(3):
                            raise TimeoutError("test startup gate")
                    def alive(self): return True
                    def send(self,text): sent.append(text)
                    def interrupt(self): sent.append("interrupt")
                    def stop(self,timeout=0): stopped.append(timeout)
                def create():
                    try: manager.create("claude",folder,"late task")
                    except Exception as error: errors.append(error)
                with unittest.mock.patch("sessions.own.ClaudeProcess",SlowProcess):
                    thread=threading.Thread(target=create);thread.start()
                    try:
                        self.assertTrue(entered.wait(2));sid=next(iter(manager.sessions))
                        if action=="interrupt": self.assertEqual(manager.interrupt(sid),"interrupted")
                        elif action=="close": manager.close(0)
                        else: manager.stop_all(0)
                    finally:
                        release.set();thread.join(3)
                self.assertFalse(thread.is_alive());self.assertEqual(errors,[])
                self.assertEqual(sent,[]);self.assertEqual(len(stopped),1)
                if action=="interrupt": self.assertFalse(manager.sessions[sid].busy)
                if action=="reset": self.assertEqual(manager.sessions,{})
                manager.close(0)


class SessionsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
        self.server.broker.window = 5.0
        self.server.sessions = SessionManager(
            self.server.broker, self.server.announce, Path(self.tmp.name),
            f"http://127.0.0.1:{self.server.server_port}", HOOK, hook_timeout=10, argv=fake_argv)
        self.server.dispatcher.sessions = self.server.sessions
        self.thread = serve_in_thread(self.server)
        self.stored = []  # managers with a store, made by stored_manager

    def tearDown(self):
        for manager in self.stored:
            manager.close()
            manager.store.close()
        self.server.sessions.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.tmp.cleanup()

    def request(self, method, path, body=None, token=UI, key=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
        conn.request(method, path, body=None if body is None else json.dumps(body).encode(),
                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                              **({"Idempotency-Key": key} if key else {})})
        response = conn.getresponse()
        data = json.loads(response.read() or b"null")
        conn.close()
        return response.status, data

    def wait(self, predicate, timeout=8.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(0.02)
        self.fail("timed out")

    def announcements(self):
        return [i["data"] for i in self.server.feed.since(0) if i["event"] == "announce"]

    def own(self, session_id):
        return next(s for s in self.request("GET", "/sessions")[1]["sessions"] if s["session_id"] == session_id)

    def idle(self, session_id):
        return self.wait(lambda: self.own(session_id)["state"] in ("done", "idle", "error") and self.own(session_id))

    def stored_manager(self, path, argv=fake_argv):
        manager = SessionManager(self.server.broker, self.server.announce, Path(self.tmp.name),
                                 f"http://127.0.0.1:{self.server.server_port}", HOOK, hook_timeout=10, argv=argv,
                                 store=open_store(path))
        self.stored.append(manager)
        return manager

    def ledger(self):
        """One TaskLedger for the server, its dispatcher and its sessions, as main() shares it."""
        db = open_store(Path(self.tmp.name) / "tasks.sqlite")
        self.addCleanup(db.close)
        tasks = self.server.tasks = self.server.dispatcher.tasks = self.server.sessions.tasks = TaskLedger(db)
        return tasks

    def dispatched_task(self, task_id):
        """The ledger with the allowed task a session created with origin=task_id runs."""
        tasks = self.ledger()
        tasks.create(task_id, "codex", self.tmp.name, "t", "read_only")
        tasks.transition(task_id, "approved")
        return tasks

    def create(self, target, prompt):
        status, body = self.request("POST", "/sessions", {"target": target, "cwd": self.tmp.name, "prompt": prompt})
        self.assertEqual(status, 201)
        return body["session_id"]

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_same_idempotency_key_runs_a_command_once(self):
        body = {"target": "claude", "cwd": self.tmp.name, "prompt": "第一问"}
        first = self.request("POST", "/sessions", body, key="k-create")
        self.assertEqual(first[0], 201)
        self.assertEqual(first[1]["state"], "accepted")  # accepted, not done: the turn is reported in /sessions
        self.assertEqual(self.request("POST", "/sessions", body, key="k-create"), first)
        self.assertEqual(len(self.server.sessions.sessions), 1)
        sid = first[1]["session_id"]
        self.wait(lambda: self.server.sessions.sessions[sid].state == "done")
        ask = self.request("POST", f"/sessions/{sid}/messages", {"text": "追问"}, key="k-ask")
        self.assertEqual(ask, (202, {"state": "accepted"}))
        self.assertEqual(self.request("POST", f"/sessions/{sid}/messages", {"text": "追问"}, key="k-ask"), ask)
        self.assertEqual(self.request("POST", "/sessions", {**body, "prompt": "别的"}, key="k-create"),
                         (409, {"error": "idempotency_conflict"}))
        self.assertEqual(self.request("POST", "/sessions", body, key="x" * 129)[0], 400)
        # Without a key every request runs.
        self.assertEqual(self.request("POST", "/sessions", body)[0], 201)
        self.assertEqual(len(self.server.sessions.sessions), 2)

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_two_follow_up_turns_in_one_session(self):
        for target in ("claude", "codex"):
            with self.subTest(target=target):
                start = len(self.announcements())
                sid = self.create(target, "第一问")
                self.assertTrue(sid.startswith("own:"))
                self.assertEqual(self.idle(sid)["last_line"], "答：第一问")
                self.assertEqual(self.request("POST", f"/sessions/{sid}/messages", {"text": "第二问"}),
                                 (202, {"state": "accepted"}))
                self.assertEqual(self.idle(sid)["last_line"], "答：第二问")
                time.sleep(0.2)
                # A completed turn of a session no card started is not announced.
                self.assertEqual(self.announcements()[start:], [])
                session = self.own(sid)
                self.assertEqual((session["own"], session["target"], session["cwd"]), (True, target, self.tmp.name))

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_a_dispatched_first_turn_is_returned_not_done(self):
        manager = self.server.sessions
        tasks = self.dispatched_task("r1")
        reply = "I could not create output.txt because write permission was denied."
        session = manager.create("codex", self.tmp.name, reply, origin="r1")
        self.wait(lambda: not session.busy and self.announcements())
        [returned] = self.announcements()
        self.assertEqual((returned["kind"], returned["level"], returned["headline"], returned["detail"]),
                         ("dispatch_review", "P2", "codex 回话了，结果待你确认", f"答：{reply}"))
        self.assertEqual((session.state, tasks.get("r1")["state"]), ("done", "needs_review"))
        self.assertEqual(manager.message(session.session_id, "为什么"), "started")
        self.wait(lambda: not session.busy)
        time.sleep(0.2)
        self.assertEqual([a["kind"] for a in self.announcements()], ["dispatch_review"])

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_exit_of_codex_cancels_its_pending_card(self):
        errors = []
        with unittest.mock.patch("threading.excepthook", errors.append):
            session = self.server.sessions.create("codex", self.tmp.name, "写文件")
            [card] = self.wait(self.server.broker.pending)
            session.backend.proc.kill()
            self.wait(lambda: not session.busy)
            self.assertEqual(self.server.broker._requests[card["request_id"]].status, "cancelled")
            self.assertEqual(self.server.broker.decide(card["request_id"], card["generation"], "allow"),
                             (False, "cancelled"))
            time.sleep(0.3)  # the card's waiting reply meets the closed pipe
        self.assertEqual(errors, [])
        self.assertEqual([a["kind"] for a in self.announcements()], ["session_failed"])

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_lines_show_the_whole_conversation(self):
        for target in ("claude", "codex"):
            with self.subTest(target=target):
                sid = self.create(target, "第一问\n补充说明")
                self.idle(sid)
                self.request("POST", f"/sessions/{sid}/messages", {"text": "第二问"})
                self.idle(sid)
                status, body = self.request("GET", f"/sessions/{sid}/lines")
                self.assertEqual(status, 200)
                self.assertEqual([(l["role"], l["text"]) for l in body["lines"]],
                                 [("user", "第一问\n补充说明"), ("agent", "答：第一问\n补充说明"),
                                  ("user", "第二问"), ("agent", "答：第二问")])
                self.assertEqual(body["next"], body["lines"][-1]["seq"])
                status, more = self.request("GET", f"/sessions/{sid}/lines?after={body['lines'][1]['seq']}")
                self.assertEqual([l["text"] for l in more["lines"]], ["第二问", "答：第二问"])
                self.assertEqual(self.own(sid)["title"], "第一问")

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_tool_lines_and_card_display_session(self):
        for target in ("claude", "codex"):
            with self.subTest(target=target):
                sid = self.create(target, "写文件")
                card = self.wait(lambda: self.request("GET", "/approvals")[1]["approvals"])[0]
                self.assertEqual(card["display_session"], sid)
                self.request("POST", f"/approvals/{card['request_id']}/decision",
                             {"decision": "deny", "generation": card["generation"]})
                self.idle(sid)
                roles = [l["role"] for l in self.request("GET", f"/sessions/{sid}/lines")[1]["lines"]]
                self.assertIn("tool", roles)

    def test_external_title_is_null(self):
        self.request("POST", "/hook/claude", {"hook_event_name": "UserPromptSubmit", "session_id": "ext",
                                              "cwd": "/repo", "prompt": "hi"}, token=HOOK)
        [external] = self.request("GET", "/sessions")[1]["sessions"]
        self.assertIsNone(external["title"])

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_interrupt_mid_turn(self):
        for target in ("claude", "codex"):
            with self.subTest(target=target):
                sid = self.create(target, "慢慢说")
                self.wait(lambda: (self.own(sid)["last_line"] or "").startswith("第"))
                self.assertEqual(self.request("POST", f"/sessions/{sid}/messages", {"text": "x"}),
                                 (409, {"error": "busy"}))
                self.assertEqual(self.request("POST", f"/sessions/{sid}/interrupt"), (202, {"state": "accepted"}))
                self.assertEqual(self.idle(sid)["state"], "idle")
                self.assertEqual(self.request("POST", f"/sessions/{sid}/interrupt"), (409, {"error": "idle"}))
                self.assertEqual(self.request("POST", f"/sessions/{sid}/messages", {"text": "还在吗"}),
                                 (202, {"state": "accepted"}))
                self.assertEqual(self.idle(sid)["last_line"], "答：还在吗")

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_write_request_opens_a_card_and_deny_stops_it(self):
        for target in ("claude", "codex"):
            with self.subTest(target=target):
                sid = self.create(target, "写文件")
                card = self.wait(lambda: self.request("GET", "/approvals")[1]["approvals"])[0]
                self.assertEqual(card["kind"], "tool")
                deny = {"decision": "deny", "generation": card["generation"]}
                self.assertEqual(self.request("POST", f"/approvals/{card['request_id']}/decision", deny)[0], 200)
                self.assertEqual(self.idle(sid)["last_line"], "没有写：被拒绝了")

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_late_progress_does_not_reopen_a_finished_turn(self):
        manager = self.server.sessions
        progress = manager.progress
        landed = threading.Event()

        def late(session, state, text, **kwargs):
            # The approval thread's update after its reply: held until the turn it belongs to has ended.
            if state == "running_tool" and "_approval" in threading.current_thread().name:
                deadline = time.monotonic() + 8
                while session.busy and time.monotonic() < deadline:
                    time.sleep(0.01)
                try:
                    return progress(session, state, text, **kwargs)
                finally:
                    landed.set()
            return progress(session, state, text, **kwargs)
        manager.progress = late
        sid = self.create("codex", "写文件")
        card = self.wait(lambda: self.request("GET", "/approvals")[1]["approvals"])[0]
        self.request("POST", f"/approvals/{card['request_id']}/decision",
                     {"decision": "deny", "generation": card["generation"]})
        self.assertTrue(landed.wait(10))
        self.assertEqual(self.own(sid)["state"], "done")

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_allowed_write_runs(self):
        sid = self.create("codex", "写文件")
        card = self.wait(lambda: self.request("GET", "/approvals")[1]["approvals"])[0]
        self.assertIn("touch x.txt", card["tool_summary"])
        allow = {"decision": "allow", "generation": card["generation"]}
        self.request("POST", f"/approvals/{card['request_id']}/decision", allow)
        self.assertEqual(self.idle(sid)["last_line"], "已写入 x.txt")

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_idle_session_is_reclaimed_and_resumed(self):
        for target in ("claude", "codex"):
            with self.subTest(target=target):
                sid = self.create(target, "第一问")
                self.idle(sid)
                manager = self.server.sessions
                manager.reap(now=time.monotonic() + manager.idle_after + 1)
                self.assertFalse(manager.alive(sid))
                self.assertEqual(self.request("POST", f"/sessions/{sid}/messages", {"text": "第二问"}),
                                 (202, {"state": "accepted"}))
                self.assertEqual(self.idle(sid)["last_line"], "答：第二问")
                self.assertTrue(manager.resumed(sid))

    def test_a_stopped_child_leaves_no_pipe_open(self):
        for target in ("claude", "codex"):
            with self.subTest(target=target):
                sid = self.create(target, "第一问")
                self.idle(sid)
                proc = self.server.sessions.sessions[sid].backend.proc
                self.server.sessions.reap(now=time.monotonic() + self.server.sessions.idle_after + 1)
                deadline = time.monotonic() + 5
                while not (proc.stdin.closed and proc.stdout.closed) and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertEqual((proc.stdin.closed, proc.stdout.closed), (True, True))

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_dispatch_card_allow_creates_an_own_session(self):
        tasks = self.ledger()
        self.request("POST", "/hook/claude", {"hook_event_name": "UserPromptSubmit", "session_id": "ext",
                                              "cwd": self.tmp.name, "prompt": "hi"}, token=HOOK)
        status, body = self.request("POST", "/say", {"text": "让 Codex 看看测试", "source": "text"})
        self.assertEqual(status, 202)
        card = self.request("GET", "/approvals")[1]["approvals"][0]
        self.request("POST", f"/approvals/{card['request_id']}/decision",
                     {"decision": "allow", "generation": card["generation"]})
        own = self.wait(lambda: [s for s in self.request("GET", "/sessions")[1]["sessions"] if s["own"]])
        self.assertEqual(own[0]["target"], "codex")
        self.idle(own[0]["session_id"])
        [review] = self.wait(lambda: self.announcements())
        self.assertEqual((review["kind"], review["detail"]), ("dispatch_review", "答：看看测试"))
        task = tasks.get(card["request_id"])
        self.assertEqual((task["state"], task["session_id"]), ("needs_review", own[0]["session_id"]))
        self.assertEqual(own[0]["task_id"], card["request_id"])

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_own_session_survives_a_restart(self):
        path = Path(self.tmp.name) / "agentd.db"
        first = self.stored_manager(path)
        session = first.create("claude", self.tmp.name, "第一问")
        self.wait(lambda: session.state == "done")
        native_id = session.native_id
        self.assertTrue(native_id)
        first.close()
        argvs = []

        def recording_argv(target, settings=None, resume=None, mode="read_only"):
            argvs.append(fake_argv(target, settings, resume, mode))
            return argvs[-1]

        second = self.stored_manager(path, argv=recording_argv)
        self.assertIn(session.session_id, second.sessions)
        restored = second.sessions[session.session_id]
        self.assertEqual((restored.target, restored.cwd, restored.title, restored.state, restored.native_id,
                          restored.last_line), ("claude", self.tmp.name, "第一问", "done", native_id, "答：第一问"))
        self.assertEqual((restored.started_at, restored.updated_at), (session.started_at, session.updated_at))
        self.assertEqual((restored.busy, restored.backend), (False, None))
        self.assertEqual(second.message(session.session_id, "第二问"), "started")
        self.wait(lambda: restored.state == "done")
        self.assertEqual(argvs[0][-2:], ["--resume", native_id])
        self.assertTrue(second.resumed(session.session_id))
        self.assertEqual(restored.last_line, "答：第二问")

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_restored_session_continues_the_transcript_seq(self):
        path = Path(self.tmp.name) / "agentd.db"
        first = self.stored_manager(path)
        session = first.create("claude", self.tmp.name, "第一问")
        self.wait(lambda: session.state == "done")
        read, cursor = first.lines(session.session_id, 0)
        self.assertTrue(read)
        first.close()
        second = self.stored_manager(path)
        restored = second.sessions[session.session_id]
        self.assertEqual(second.message(session.session_id, "第二问"), "started")
        self.wait(lambda: restored.state == "done")
        lines, _ = second.lines(session.session_id, cursor)  # Companion polls on with its old cursor
        self.assertEqual([line["text"] for line in lines], ["第二问", "答：第二问"])

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_stored_seq_keeps_up_with_lines_added_mid_turn(self):
        path = Path(self.tmp.name) / "agentd.db"
        first = self.stored_manager(path)
        session = first.create("claude", self.tmp.name, "第一问")
        self.wait(lambda: session.state == "done")
        self.assertEqual(first.message(session.session_id, "慢"), "started")
        handed = self.wait(lambda: session.seq if session.seq >= 6 else None)
        second = self.stored_manager(path)  # the first one never got to end the turn
        self.assertGreaterEqual(second.sessions[session.session_id].seq, handed)

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_session_cut_off_mid_turn_comes_back_as_error(self):
        path = Path(self.tmp.name) / "agentd.db"
        first = self.stored_manager(path)
        session = first.create("claude", self.tmp.name, "第一问")
        self.wait(lambda: session.state == "done")
        self.assertEqual(first.message(session.session_id, "慢"), "started")
        second = self.stored_manager(path)  # the first one never got to end the turn
        self.assertIn(session.session_id, second.sessions)
        restored = second.sessions[session.session_id]
        self.assertEqual((restored.state, restored.last_line), ("error", "答：第一问"))

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_dispatched_session_keeps_the_card_request_id_as_origin(self):
        manager = self.stored_manager(Path(self.tmp.name) / "agentd.db")
        self.server.dispatcher.sessions = manager
        request = self.server.dispatcher.propose("codex", self.tmp.name, "看看测试")
        [card] = self.server.broker.pending()
        self.server.broker.decide(card["request_id"], card["generation"], "allow")
        [session] = self.wait(lambda: list(manager.sessions.values()))
        self.wait(lambda: session.state == "done")
        rows = manager.store.execute("SELECT session_id, origin FROM own_sessions").fetchall()
        self.assertEqual(rows, [(session.session_id, request.request_id)])
        self.assertEqual(request.request_id, card["request_id"])

    def own_session(self, origin):
        own = OwnSession("codex", self.tmp.name, "看看测试")
        own.origin = origin
        self.server.sessions.sessions[own.session_id] = own
        return own

    def announced(self, **announcement):
        self.server.announce({"ts": time.time(), "level": "P2", "headline": "codex 的任务完成了",
                              "project": self.tmp.name, "detail": None, **announcement})
        return self.announcements()[-1]

    def test_an_own_session_announcement_carries_its_dispatch_card_as_origin(self):
        request = self.server.dispatcher.propose("codex", self.tmp.name, "看看测试")
        own = self.own_session(request.request_id)
        self.assertEqual(self.announced(kind="dispatch_done", session_id=own.session_id)["origin"], request.request_id)

    def test_a_reminder_announcement_keeps_its_own_origin(self):
        own = self.own_session("r-card")
        self.assertEqual(self.announced(kind="reminder_due", level="P0", session_id=own.session_id,
                                        origin="c-reminder")["origin"], "c-reminder")

    def test_an_undispatched_session_announcement_has_a_null_origin(self):
        own = self.own_session(None)
        self.server.sessions.turn_ended(own, "failed", None)
        [announced] = self.announcements()
        self.assertEqual(announced["kind"], "session_failed")
        self.assertIn("origin", announced)
        self.assertIsNone(announced["origin"])

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_external_sessions_are_listed_and_own_claude_is_not_doubled(self):
        self.request("POST", "/hook/claude", {"hook_event_name": "UserPromptSubmit", "session_id": "ext",
                                              "cwd": "/repo", "prompt": "hi"}, token=HOOK)
        sid = self.create("claude", "写文件")
        self.wait(lambda: self.request("GET", "/approvals")[1]["approvals"])
        sessions = self.request("GET", "/sessions")[1]["sessions"]
        self.assertEqual(sorted((s["own"], s["target"]) for s in sessions), [(False, "claude"), (True, "claude")])
        self.assertEqual(self.own(sid)["state"], "awaiting_approval")
        external = next(s for s in sessions if not s["own"])
        self.assertEqual((external["session_id"], external["cwd"]), ("claude:ext", "/repo"))

    def test_hooks_of_an_own_codex_thread_change_nothing(self):
        own = OwnSession("codex", self.tmp.name, "看看")
        own.native_id = "thr-own"
        self.server.sessions.sessions[own.session_id] = own
        before = self.request("GET", "/state")[1]["sessions"]
        for name, extra in (("SessionStart", {}), ("UserPromptSubmit", {"prompt": "看看"}),
                            ("PermissionRequest", {"tool_name": "Bash", "tool_input": {"command": "ls"}}),
                            ("Stop", {})):
            self.assertEqual(self.request("POST", "/hook/codex", {"hook_event_name": name, "session_id": "thr-own",
                                                                  "cwd": self.tmp.name, **extra}, token=HOOK),
                             (200, {}))
        self.assertEqual(self.request("GET", "/state")[1]["sessions"], before)
        self.assertEqual([s["session_id"] for s in self.request("GET", "/sessions")[1]["sessions"]],
                         [own.session_id])
        self.request("POST", "/hook/codex", {"hook_event_name": "UserPromptSubmit", "session_id": "thr-ext",
                                             "cwd": self.tmp.name, "prompt": "hi"}, token=HOOK)
        self.assertEqual(sorted(s["session_id"] for s in self.request("GET", "/sessions")[1]["sessions"]),
                         sorted(["codex:thr-ext", own.session_id]))

    def test_bad_requests(self):
        self.assertEqual(self.request("POST", "/sessions", {"target": "gpt", "cwd": "/", "prompt": "x"}),
                         (400, {"error": "invalid_session", "field": "target"}))
        self.assertEqual(self.request("POST", "/sessions", {"target": "codex", "cwd": "/", "prompt": " "}),
                         (400, {"error": "invalid_session", "field": "prompt"}))
        self.assertEqual(self.request("POST", "/sessions", {"target": "codex", "cwd": "/no/such/dir", "prompt": "x"}),
                         (400, {"error": "invalid_session", "field": "cwd"}))
        self.request("POST", "/hook/claude", {"hook_event_name": "UserPromptSubmit", "session_id": "ext",
                                              "cwd": "/repo", "prompt": "hi"}, token=HOOK)
        self.assertEqual(self.request("POST", "/sessions/claude:ext/messages", {"text": "x"}), (409, {"error": "not_own"}))
        self.assertEqual(self.request("POST", "/sessions/claude:ext/interrupt"), (409, {"error": "not_own"}))
        self.assertEqual(self.request("POST", "/sessions/claude:nope/interrupt"), (404, {"error": "unknown_session"}))
        self.assertEqual(self.request("GET", "/sessions/claude:ext/lines"), (200, {"lines": [], "next": 0}))
        self.assertEqual(self.request("GET", "/sessions/own:00/lines")[0], 404)
        self.assertEqual(self.request("POST", "/sessions/own:00/messages", {"text": "x"}), (404, {"error": "unknown_session"}))
        self.assertEqual(self.request("POST", "/sessions/own:00/interrupt"), (404, {"error": "unknown_session"}))
        self.assertEqual(self.request("GET", "/sessions", token=HOOK)[0], 401)

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_backend_that_fails_to_start_ends_the_turn(self):
        self.server.sessions.argv = lambda target, settings=None, resume=None, mode="read_only": [
            "/nonexistent/agentd-test-cli"]
        self.assertEqual(self.request("POST", "/sessions", {"target": "claude", "cwd": self.tmp.name,
                                                            "prompt": "第一问"}), (502, {"error": "start_failed"}))
        [session_id] = self.server.sessions.sessions
        session = self.own(session_id)
        self.assertEqual(session["state"], "error")
        lines = self.request("GET", f"/sessions/{session_id}/lines")[1]["lines"]
        self.assertEqual([line["role"] for line in lines], ["error"])
        failed = self.announcements()[-1]
        self.assertEqual((failed["kind"], failed["level"], failed["headline"]),
                         ("session_failed", "P1", "claude 的会话出错了"))
        # Not stuck busy: the next message tries again.
        self.assertEqual(self.request("POST", f"/sessions/{session_id}/messages", {"text": "再试"}),
                         (502, {"error": "start_failed"}))
        self.server.sessions.argv = fake_argv
        self.assertEqual(self.request("POST", f"/sessions/{session_id}/messages", {"text": "再试"})[0], 202)
        self.assertEqual(self.idle(session_id)["state"], "done")

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_start_failure_words_follow_the_reply_language(self):
        self.server.sessions.argv = lambda target, settings=None, resume=None, mode="read_only": [
            "/nonexistent/agentd-test-cli"]
        for code, text, headline in (("en", "claude failed to start (FileNotFoundError)", "claude's session hit an error"),
                                     ("zh-Hans", "claude 启动失败（FileNotFoundError）", "claude 的会话出错了")):
            with self.subTest(code=code):
                self.server.sessions.reply_language = lambda: code
                before = set(self.server.sessions.sessions)
                self.assertEqual(self.request("POST", "/sessions", {"target": "claude", "cwd": self.tmp.name,
                                                                    "prompt": "第一问"})[0], 502)
                [session_id] = set(self.server.sessions.sessions) - before
                lines = self.request("GET", f"/sessions/{session_id}/lines")[1]["lines"]
                self.assertEqual([line["text"] for line in lines], [text])
                self.assertEqual(self.announcements()[-1]["headline"], headline)

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_codex_that_fails_its_handshake_is_stopped(self):
        pid_file = Path(self.tmp.name) / "codex.pid"
        script = (f"import os, sys, time; open({str(pid_file)!r}, 'w').write(str(os.getpid())); "
                  "sys.stdin.readline(); print('{\"id\": 1, \"error\": {\"message\": \"no\"}}', flush=True); "
                  "time.sleep(30)")
        self.server.sessions.argv = lambda target, settings=None, resume=None: [sys.executable, "-c", script]
        self.assertEqual(self.request("POST", "/sessions", {"target": "codex", "cwd": self.tmp.name,
                                                            "prompt": "第一问"}), (502, {"error": "start_failed"}))
        [session_id] = self.server.sessions.sessions
        self.assertEqual(self.own(session_id)["state"], "error")
        pid = int(pid_file.read_text(encoding="utf-8"))
        self.wait(lambda: subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True,
                                         text=True, encoding="utf-8").stdout.strip() in ("", "Z"))

    def scripted(self, mode):
        tmp = Path(self.tmp.name)
        script, log, go = tmp / "scripted_codex.py", tmp / f"{mode}.log", tmp / f"{mode}.go"
        script.write_text(SCRIPTED_CODEX, encoding="utf-8")
        self.server.sessions.argv = lambda target, settings=None, resume=None: [
            sys.executable, str(script), mode, str(log), str(go)]
        return log, go

    def received(self, log):
        return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []

    def test_rejected_codex_turn_start_frees_the_session(self):
        self.scripted("error")
        manager = self.server.sessions
        session = manager.create("codex", self.tmp.name, "第一问")
        self.wait(lambda: not session.busy, timeout=3.0)
        self.assertIn("error", [line["role"] for line in manager.lines(session.session_id, 0)[0]])
        self.assertEqual(manager.message(session.session_id, "再试"), "started")

    def test_cancelled_queued_codex_sender_never_writes_turn_start(self):
        log,_=self.scripted("answer")
        entered,release=threading.Event(),threading.Event()
        original=CodexProcess._start_turn
        def delayed(backend,text,run):
            entered.set();release.wait(3);original(backend,text,run)
        with unittest.mock.patch.object(CodexProcess,"_start_turn",delayed):
            manager=self.server.sessions;session=manager.create("codex",self.tmp.name,"do not send")
            try:
                self.assertTrue(entered.wait(2));self.assertEqual(manager.interrupt(session.session_id),"interrupted")
            finally: release.set()
            self.wait(lambda:not session.busy,timeout=3)
        self.assertFalse(any(m.get("method")=="turn/start" for m in self.received(log)))

    def test_codex_turn_start_timeout_frees_the_session(self):
        self.scripted("timeout")
        manager = self.server.sessions
        with unittest.mock.patch.object(CodexProcess.call, "__defaults__", (0.3,)):
            session = manager.create("codex", self.tmp.name, "第一问")
            self.wait(lambda: not session.busy, timeout=3.0)
        self.assertEqual(session.backend.pending, {})

    def test_interrupt_before_turn_started_is_sent_when_it_starts(self):
        log, go = self.scripted("interrupt")
        manager = self.server.sessions
        session = manager.create("codex", self.tmp.name, "第一问")
        # Exercise an already-sent start whose reply is blocked. Startup cancellation
        # before sending is a different invariant, covered by the constructor tests.
        self.wait(lambda: [m for m in self.received(log) if m.get("method") == "turn/start"], timeout=3.0)
        self.assertEqual(manager.interrupt(session.session_id), "interrupted")
        # Asked to stop is not stopped; the backend has not confirmed yet.
        listed = session.to_dict()
        self.assertEqual(listed["capabilities"], ["observe", "resume", "control"])  # no fork, no terminal
        self.assertTrue(listed["cancel_requested"])
        self.assertNotIn(listed["state"], ("idle", "done"))
        go.touch()
        sent = self.wait(lambda: [m for m in self.received(log) if m.get("method") == "turn/interrupt"], timeout=3.0)
        self.assertEqual(sent[0]["params"]["turnId"], "turn-1")
        self.wait(lambda: not session.busy, timeout=3.0)
        self.assertEqual((session.state, session.to_dict()["cancel_requested"]), ("idle", False))

    def test_completion_of_another_turn_does_not_end_this_one(self):
        # A late or wrong-turn completion settles nothing and announces nothing.
        log, go = self.scripted("stale")
        manager = self.server.sessions
        self.dispatched_task("r1")
        before = len(self.announcements())
        session = manager.create("codex", self.tmp.name, "第一问", origin="r1")
        self.wait(lambda: [l for l in session.lines if l["text"] == "旧的"], timeout=3.0)
        time.sleep(0.3)
        self.assertTrue(session.busy)
        self.assertEqual(len(self.announcements()), before)
        go.touch()
        self.wait(lambda: not session.busy and self.announcements()[before:], timeout=3.0)
        [done] = self.announcements()[before:]
        self.assertEqual((done["kind"], done["detail"]), ("dispatch_review", "新的"))

    def test_file_change_card_shows_the_changes_and_closes_with_the_turn(self):
        log, go = self.scripted("fileChange")
        broker = self.server.broker
        session = self.server.sessions.create("codex", self.tmp.name, "写文件")
        [card] = self.wait(lambda: broker.pending(), timeout=3.0)
        self.assertEqual(card["tool_summary"], "add /repo/a.txt\n+alpha\n\nupdate /repo/b.txt\n-old\n+new")
        go.touch()
        self.wait(lambda: not broker.pending(), timeout=3.0)
        reply = self.wait(lambda: [m for m in self.received(log) if m.get("id") == 100], timeout=3.0)
        self.assertEqual(reply[0]["result"], {"decision": "decline"})
        self.wait(lambda: not session.busy, timeout=3.0)

    def test_unsupported_mode_creates_no_session(self):
        for mode in ("bypassPermissions", "bypass", "danger-full-access", "default", None, ["read_only"], 1):
            with self.subTest(mode=mode):
                self.assertEqual(self.request("POST", "/sessions", {"target": "claude", "cwd": self.tmp.name,
                                                                    "prompt": "x", "mode": mode}),
                                 (400, {"error": "unsupported_mode"}))
        self.assertEqual(self.server.sessions.sessions, {})

    def test_mode_sets_the_claude_permission_mode(self):
        argvs = []

        def recording_argv(target, settings=None, resume=None, mode="read_only"):
            argvs.append(real_argv(target, settings, resume, mode))
            return fake_argv(target, settings, resume, mode)
        self.server.sessions.argv = recording_argv
        status, body = self.request("POST", "/sessions", {"target": "claude", "cwd": self.tmp.name, "prompt": "第一问",
                                                          "mode": "workspace_write"})
        self.assertEqual(status, 201)
        self.assertEqual(self.idle(body["session_id"])["mode"], "workspace_write")
        self.assertEqual(self.idle(self.create("claude", "第一问"))["mode"], "read_only")
        self.assertEqual([argv[argv.index("--permission-mode") + 1] for argv in argvs], ["acceptEdits", "default"])
        self.assertNotIn("--dangerously-skip-permissions", sum(argvs, []))

    def test_codex_sandbox_follows_the_mode_and_survives_resume(self):
        log, _ = self.scripted("answer")
        manager = self.server.sessions
        default = manager.create("codex", self.tmp.name, "第一问")
        self.wait(lambda: not default.busy, timeout=3.0)
        write = manager.create("codex", self.tmp.name, "第一问", mode="workspace_write")
        self.wait(lambda: not write.busy, timeout=3.0)
        starts = [m["params"] for m in self.received(log) if m.get("method") == "thread/start"]
        self.assertEqual(starts, [{"cwd": self.tmp.name, "sandbox": "read-only"},
                                  {"cwd": self.tmp.name, "sandbox": "workspace-write"}])
        manager.reap(now=time.monotonic() + manager.idle_after + 1)
        self.wait(lambda: not manager.alive(write.session_id), timeout=3.0)
        self.assertEqual(manager.message(write.session_id, "第二问"), "started")
        self.wait(lambda: not write.busy, timeout=3.0)
        [resume] = [m["params"] for m in self.received(log) if m.get("method") == "thread/resume"]
        self.assertEqual(resume, {"threadId": "thr-1", "sandbox": "workspace-write"})
        with self.assertRaises(ValueError):
            manager.create("codex", self.tmp.name, "x", mode="bypassPermissions")

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_mode_survives_a_restart(self):
        path = Path(self.tmp.name) / "agentd.db"
        first = self.stored_manager(path)
        session = first.create("claude", self.tmp.name, "第一问", mode="workspace_write")
        self.wait(lambda: session.state == "done")
        first.close()
        modes = []

        def recording_argv(target, settings=None, resume=None, mode="read_only"):
            modes.append(mode)
            return fake_argv(target, settings, resume, mode)
        second = self.stored_manager(path, argv=recording_argv)
        restored = second.sessions[session.session_id]
        self.assertEqual(restored.mode, "workspace_write")
        self.assertEqual(second.message(session.session_id, "第二问"), "started")
        self.wait(lambda: restored.state == "done")
        self.assertEqual(modes, ["workspace_write"])

    def stored_session(self, manager):
        """A session manager knows and has saved, without a process."""
        session = OwnSession("claude", self.tmp.name, "看一下仓库")
        manager.sessions[session.session_id] = session
        manager.save(session)
        return session

    def stored_lines(self, manager, session_id):
        return manager.store.execute("SELECT COUNT(*) FROM own_session_lines WHERE session_id = ?",
                                     (session_id,)).fetchone()[0]

    def test_lines_survive_a_restart(self):
        path = Path(self.tmp.name) / "agentd.db"
        first = self.stored_manager(path)
        session = self.stored_session(first)
        for role, text in (("user", "第一问"), ("assistant", "答一"), ("tool", "ls")):
            first.add_line(session, role, text)
        before = first.lines(session.session_id, 0)
        second = self.stored_manager(path)
        lines, cursor = second.lines(session.session_id, 0)
        self.assertEqual([(l["seq"], l["role"], l["text"]) for l in lines],
                         [(1, "user", "第一问"), (2, "assistant", "答一"), (3, "tool", "ls")])
        self.assertEqual((lines, cursor), before)
        second.add_line(second.sessions[session.session_id], "user", "第二问")
        self.assertEqual([l["seq"] for l in second.lines(session.session_id, 0)[0]], [1, 2, 3, 4])

    def test_only_the_last_lines_kept_are_stored(self):
        path = Path(self.tmp.name) / "agentd.db"
        first = self.stored_manager(path)
        session = self.stored_session(first)
        for n in range(LINES_KEPT + 5):
            first.add_line(session, "assistant", f"行{n}")
        self.assertEqual(self.stored_lines(first, session.session_id), LINES_KEPT)
        lines, cursor = self.stored_manager(path).lines(session.session_id, 0)
        self.assertEqual((len(lines), lines[0]["seq"], cursor), (LINES_KEPT, 6, LINES_KEPT + 5))

    def test_clear_deletes_the_stored_lines(self):
        manager = self.stored_manager(Path(self.tmp.name) / "agentd.db")
        session = self.stored_session(manager)
        manager.add_line(session, "user", "第一问")
        manager.add_line(session, "assistant", "答一")
        manager.clear()
        self.assertEqual(self.stored_lines(manager, session.session_id), 0)

    def test_codex_file_change_can_be_allowed_for_the_session(self):
        log, go = self.scripted("fileChange")
        broker = self.server.broker
        session = self.server.sessions.create("codex", self.tmp.name, "写文件")
        [card] = self.wait(lambda: broker.pending(), timeout=3.0)
        self.assertEqual(card["options"], ["allow", "allow_session", "deny"])
        self.assertEqual(card["session_scope"], {"kind": "same_files", "detail": "/repo/a.txt\n/repo/b.txt"})
        self.assertEqual(broker.decide(card["request_id"], card["generation"], "allow_session"), (True, None))
        go.touch()  # the stand-in reads its stdin again only after the go file
        reply = self.wait(lambda: [m for m in self.received(log) if m.get("id") == 100], timeout=3.0)
        self.assertEqual(reply[0]["result"], {"decision": "acceptForSession"})
        self.wait(lambda: not session.busy, timeout=3.0)

    def test_codex_file_change_to_a_shell_start_file_is_marked_dangerous(self):
        log, go = self.scripted("fileChangeRc")
        broker = self.server.broker
        self.server.sessions.create("codex", self.tmp.name, "写文件")
        [card] = self.wait(lambda: broker.pending(), timeout=3.0)
        self.assertEqual((card["dangerous"], card["danger_rule"], card["options"]),
                         (True, "sensitive_path", ["allow", "allow_session", "deny"]))
        self.assertEqual(broker.decide(card["request_id"], card["generation"], "deny"), (True, None))
        go.touch()

    def test_codex_command_array_is_judged_as_one_command(self):
        log, go = self.scripted("commandArray")
        broker = self.server.broker
        self.server.sessions.create("codex", self.tmp.name, "删目录")
        [card] = self.wait(lambda: broker.pending(), timeout=3.0)
        self.assertEqual((card["dangerous"], card["danger_rule"]), (True, "rm_recursive"))
        self.assertEqual(broker.decide(card["request_id"], card["generation"], "deny"), (True, None))
        go.touch()

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_codex_command_card_offers_no_session_choice(self):
        sid = self.create("codex", "写文件")
        card = self.wait(lambda: self.request("GET", "/approvals")[1]["approvals"])[0]
        self.assertEqual((card["options"], card["session_scope"]), (["allow", "deny"], None))
        decide = f"/approvals/{card['request_id']}/decision"
        self.assertEqual(self.request("POST", decide, {"decision": "allow_session", "generation": card["generation"]}),
                         (400, {"ok": False, "error": "scope_unavailable"}))
        self.request("POST", decide, {"decision": "allow", "generation": card["generation"]})
        self.assertEqual(self.idle(sid)["last_line"], "已写入 x.txt")

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_relative_state_dir_gives_an_absolute_settings_path(self):
        relative = Path(os.path.relpath(self.tmp.name))
        manager = SessionManager(self.server.broker, self.server.announce, relative, "http://127.0.0.1:1", HOOK,
                                 hook_timeout=10, argv=fake_argv)
        self.assertTrue(manager.settings_path.is_absolute())
        self.assertEqual(manager.settings_path, Path(self.tmp.name).resolve() / "own-claude-settings.json")

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_barge_in_on_an_announcement_leaves_the_session_running(self):
        relay = self.server.speech = test_server.FakeRelay()
        sid = self.create("claude", "慢慢说")
        self.wait(lambda: (self.own(sid)["last_line"] or "").startswith("第"))
        self.server.announce({"ts": 1.0, "level": "P0", "kind": "dispatch_done", "headline": "claude 的任务完成了",
                              "project": self.tmp.name, "session_id": sid, "detail": None})
        relay.playing = True
        self.assertEqual([call[0] for call in relay.calls], ["speak"])
        self.assertEqual(self.server.cancel_turn("barge_in")[0], "cancelled")
        self.assertEqual(relay.calls[-1], ("cancel", "client_cancel", True))
        time.sleep(0.3)
        session = self.server.sessions.sessions[sid]
        self.assertEqual((session.busy, session.cancel_requested), (True, False))
        self.assertTrue(self.server.sessions.alive(sid))
        self.assertEqual(self.own(sid)["state"], "thinking")

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_settings_file_is_private_and_child_env_is_scrubbed(self):
        self.idle(self.create("claude", "第一问"))
        [settings] = Path(self.tmp.name).glob("own-claude-settings.json")
        self.assertEqual(stat.S_IMODE(settings.stat().st_mode), 0o600)
        hooks = json.loads(settings.read_text(encoding="utf-8"))["hooks"]
        self.assertEqual(hooks["PermissionRequest"][0]["hooks"][0]["timeout"], 10)
        self.assertEqual(child_env({"PATH": "/bin", "ANTHROPIC_API_KEY": "k", "AGENTD_HOOK_TOKEN": "t"}),
                         {"PATH": "/bin"})


class LatestAnnouncementTest(unittest.TestCase):
    """While speech plays, an own session's announcements keep only its newest valid state."""
    request, wait = SessionsTest.request, SessionsTest.wait

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        gate = Gate(enabled=True, quiet=(0, 0), same_cooldown=0, cross_cooldown=0)
        # The ticker never runs by itself: each test runs the ticks it means.
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI, gate=gate, tick_interval=3600)
        self.server.broker.window = 5.0
        self.server.sessions = SessionManager(
            self.server.broker, self.server.announce, Path(self.tmp.name),
            f"http://127.0.0.1:{self.server.server_port}", HOOK, hook_timeout=10, argv=fake_argv)
        self.relay = self.server.speech = test_server.FakeRelay()
        self.thread = serve_in_thread(self.server)
        # An own Claude session in a turn, as its CLI's hooks name it.
        self.session = OwnSession("claude", self.tmp.name, "写文件")
        self.session.native_id, self.session.busy = "native-1", True
        self.server.sessions.sessions[self.session.session_id] = self.session

    def tearDown(self):
        self.server.sessions.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.tmp.cleanup()

    def hook(self, name, **extra):
        return self.request("POST", "/hook/claude", {"hook_event_name": name, "session_id": "native-1",
                                                     "cwd": self.tmp.name, **extra}, token=HOOK)

    def announce(self, kind, headline):
        self.server.announce({"ts": time.time(), "level": "P1", "kind": kind, "headline": headline,
                              "project": self.tmp.name, "session_id": self.session.session_id, "detail": None})

    def spoken(self):
        return [text for what, _, text in self.relay.calls if what == "speak"]

    def test_only_the_terminal_state_is_voiced_after_speech_ends(self):
        self.relay.playing = True
        write = {"tool_name": "Write", "tool_input": {"file_path": "x.txt", "content": "hi"}}
        asking = threading.Thread(target=self.hook, args=("PermissionRequest",), kwargs=write)
        asking.start()
        [card] = self.wait(self.server.broker.pending)
        listed = self.request("GET", "/sessions")[1]["sessions"]
        self.assertEqual([s["state"] for s in listed if s["session_id"] == self.session.session_id],
                         ["awaiting_approval"])
        self.request("POST", f"/approvals/{card['request_id']}/decision",
                     {"decision": "allow", "generation": card["generation"]})
        asking.join(5)
        self.hook("PostToolUse", **write)
        self.announce("gate_fail", "门禁失败")
        self.server.sessions.turn_ended(self.session, "failed", None)  # session_failed, P1
        self.hook("Stop")
        self.announce("ci_fail", "CI失败")  # late progress of the ended turn
        self.server._announce_due()
        self.assertEqual(self.relay.calls, [])
        self.relay.playing = False
        self.server._announce_due()
        self.assertEqual(self.spoken(), ["claude 的会话出错了"])
        for _ in range(3):
            self.server._announce_due()
        self.assertEqual(self.spoken(), ["claude 的会话出错了"])

    def test_a_ledger_line_naming_the_native_session_shares_the_own_sessions_slot(self):
        self.relay.playing = True
        ledger = {"level": "P1", "project": self.tmp.name, "session_id": "native-1", "detail": None}
        self.server.announce({**ledger, "ts": time.time(), "kind": "gate_fail", "headline": "门禁失败"})
        self.server.sessions.turn_ended(self.session, "failed", None)  # session_failed under own:…
        self.server.announce({**ledger, "ts": time.time(), "kind": "ci_fail", "headline": "CI失败"})
        self.relay.playing = False
        for _ in range(3):
            self.server._announce_due()
        self.assertEqual(self.spoken(), ["claude 的会话出错了"])

    def test_a_new_turn_lets_its_progress_be_voiced(self):
        self.server.sessions.turn_ended(self.session, "failed", None)  # speech idle: voiced at once
        self.announce("gate_fail", "门禁失败")
        self.assertEqual(self.spoken(), ["claude 的会话出错了"])
        self.assertEqual(self.request("POST", f"/sessions/{self.session.session_id}/messages", {"text": "慢慢说"}),
                         (202, {"state": "accepted"}))
        self.announce("ci_fail", "CI失败")
        self.assertEqual(self.spoken(), ["claude 的会话出错了", "CI失败"])


class CloseTest(unittest.TestCase):
    """SessionManager.close leaves no process behind."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        self.pids = Path(self.tmp.name) / "pids"
        self.pids.mkdir()

    def started(self, kind, count):
        """A manager with count busy sessions on CLOSE_BACKEND, and every pid they started."""
        argv = lambda target, settings=None, resume=None, mode="read_only": [  # noqa: E731
            sys.executable, "-c", CLOSE_BACKEND, str(self.pids), kind]
        manager = SessionManager(ApprovalBroker(), lambda announcement: None, Path(self.tmp.name),
                                 "http://127.0.0.1:1", HOOK, hook_timeout=10, argv=argv)
        for i in range(count):
            manager.create("claude", self.tmp.name, f"任务{i}")
        deadline = time.monotonic() + 10
        while len(files := [f for f in self.pids.iterdir() if f.name.isdigit()]) < count:
            self.assertLess(time.monotonic(), deadline, "backends did not start")
            time.sleep(0.02)
        pids = [int(pid) for f in files for pid in f.read_text(encoding="utf-8").split()]
        self.addCleanup(self.kill, pids)
        return manager, pids

    @staticmethod
    def kill(pids):
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def assertGone(self, pids, within=1.0):
        # An orphaned grandchild is reaped by launchd, not at once.
        deadline = time.monotonic() + within
        while (alive := [pid for pid in pids if exists(pid)]) and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(alive, [])

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_close_stops_the_child_and_what_it_started(self):
        manager, pids = self.started("grandchild", 1)
        self.assertEqual(len(pids), 2)
        manager.close(2)
        self.assertGone(pids)

    @unittest.skipIf(sys.platform == "win32", "the test needs POSIX signals, pty or time.tzset")
    def test_children_that_ignore_sigterm_are_killed_within_one_shared_timeout(self):
        manager, pids = self.started("ignore_term", 2)
        start = time.monotonic()
        manager.close(1.0)
        self.assertLess(time.monotonic() - start, 1.6)
        self.assertGone(pids)

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_nothing_starts_once_closed(self):
        manager, pids = self.started("grandchild", 1)
        manager.close(2)
        self.assertGone(pids)
        late = manager.create("claude", self.tmp.name, "关了之后")
        self.assertEqual(manager.message(late.session_id, "还在吗"), "closed")
        self.assertIsNone(late.backend)


def exists(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


class MainWiringTest(unittest.TestCase):
    def test_main_gives_the_session_manager_the_reply_language(self):
        import ast
        from types import SimpleNamespace
        import daemon.main as module
        tree = ast.parse(Path(module.__file__).read_text(encoding="utf-8"))
        assignment = next(n for n in ast.walk(tree) if isinstance(n, ast.Assign)
                          and any(isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name)
                                  and t.value.id == "server" and t.attr == "sessions" for t in n.targets))
        with tempfile.TemporaryDirectory() as directory:
            server = SimpleNamespace(broker=None, announce=None, server_port=1, dispatcher=SimpleNamespace(),
                                     reply_language_code=lambda: "en")
            scope = {**vars(module), "server": server, "state_dir": Path(directory), "hook_token": "hook",
                     "args": SimpleNamespace(hook_timeout=5, computer_control_socket=None),
                     "open_store": lambda db: None, "db": None}
            exec(compile(ast.Module(body=[assignment], type_ignores=[]), module.__file__, "exec"), scope)
        self.assertEqual(server.sessions.reply_language(), "en")


if __name__ == "__main__":
    unittest.main()
