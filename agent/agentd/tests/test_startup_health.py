"""agentd answers /health while it starts, runs without an optional subsystem that fails, and answers 500 on a failure."""
import ast
import http.client
import inspect
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

AGENTD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENTD))

from observation.blacklist import Blacklist  # noqa: E402
from support import deny_blacklist  # noqa: E402
from observation.capture import CaptureManager  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from daemon.main import main  # noqa: E402
from api.handler import Handler  # noqa: E402
from infra import paths  # noqa: E402
from infra.tokens import write_secret  # noqa: E402
import test_character_agent_semantic as fixture  # noqa: E402
from character_agent.services.observation import ObservationService  # noqa: E402
from support import serve_in_thread  # noqa: E402

TOKENS = {"hook_token": "hook-token", "ui_token": "ui-token", "events_token": "events-token",
          "integration_token": "integration-token"}

# Runs main() with a task recovery that waits for a file and an observation service that fails to start, as asked by env.
MAIN = """
import os, sys, time
sys.path.insert(0, os.environ["TEST_AGENTD"])
import server
from character_agent.services.observation import ObservationService
release = os.environ.get("TEST_RELEASE")
if release:
    recover = server.AgentdServer.recover_tasks
    def slow(self):
        while not os.path.exists(release):
            time.sleep(.02)
        return recover(self)
    server.AgentdServer.recover_tasks = slow
if os.environ.get("TEST_BREAK_OBSERVATIONS"):
    def broken(self):
        raise RuntimeError("observation start fixture")
    ObservationService.start = broken
server.main()
"""


def request(port, method, path, token=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    if body is not None:
        headers["Content-Type"] = "application/json"
    try:
        conn.request(method, path, body, headers)
        response = conn.getresponse()
        return response.status, json.loads(response.read())
    finally:
        conn.close()


class MainStartupTest(unittest.TestCase):
    def start(self, **env):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        home = Path(self.tmp.name)
        (home / ".claude").mkdir()
        self.state = home / "state"
        # /health answers during recovery, before ui-runtime.json names the port, so the port is picked first.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.process = subprocess.Popen(
            [sys.executable, "-I", "-c", MAIN, "--port", str(self.port), "--state-dir", str(self.state), "--no-proactive",
             "--mute", "--plugin-on", "screen_awareness", "--plugin-on", "personal_agent", "--plugin-on", "coding_sessions", "--ledger-root", str(home / "no-ledger")],
            env={**os.environ, "HOME": str(home), "TEST_AGENTD": str(AGENTD), **env},
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.addCleanup(self.stop)
        deadline = time.monotonic() + 10
        while self.process.poll() is None and time.monotonic() < deadline:
            try:
                request(self.port, "GET", "/health")
                return
            except OSError:
                time.sleep(.02)
        self.process.kill()
        self.fail("agentd never answered /health:\n" + self.process.communicate()[0].decode(errors="replace"))

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.output = self.process.communicate(timeout=10)[0].decode(errors="replace")
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.output = self.process.communicate()[0].decode(errors="replace")

    def ready(self):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            status, body = request(self.port, "GET", "/health")
            if body["status"] == "ok":
                # ui-runtime.json is written only once agentd is ready
                self.ui = json.loads((self.state / "ui-runtime.json").read_text(encoding="utf-8"))["ui_token"]
                return status, body
            time.sleep(.02)
        self.fail(f"agentd did not become ready: {body}")

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_health_answers_starting_until_recovery_finishes_and_other_routes_wait(self):
        release = Path(tempfile.mkdtemp()) / "release"
        self.addCleanup(lambda: (release.unlink(missing_ok=True), release.parent.rmdir()))
        self.start(TEST_RELEASE=str(release))
        deadline = time.monotonic() + 10
        while request(self.port, "GET", "/health")[1].get("stage") != "recovery" and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertEqual(request(self.port, "GET", "/health"),
                         (200, {"status": "starting", "stage": "recovery", "degraded": [], "c6_contract": "v1"}))
        # The token check comes first; the ui token is not published until ready, the hook token is.
        self.assertEqual(request(self.port, "GET", "/state")[0], 401)
        hook = (self.state / "hook.token").read_text(encoding="utf-8").strip()
        self.assertEqual(request(self.port, "POST", "/hook/claude", hook, b"{}"), (503, {"error": "starting"}))
        self.assertFalse((self.state / "ui-runtime.json").exists())
        release.touch()
        self.assertEqual(self.ready(), (200, {"status": "ok", "degraded": [], "c6_contract": "v1"}))
        self.assertEqual(request(self.port, "GET", "/state", self.ui)[0], 200)
        self.stop()
        self.assertEqual(self.process.returncode, 0, self.output)

    def test_observation_start_failure_leaves_agentd_running_and_named_in_health(self):
        self.start(TEST_BREAK_OBSERVATIONS="1")
        status, body = self.ready()
        self.assertEqual(status, 200)
        self.assertEqual(body["degraded"], ["observations"])
        self.assertEqual(request(self.port, "GET", "/state", self.ui)[0], 200)
        self.stop()
        self.assertIn("observation start fixture", self.output)


class RuntimePublicationTest(unittest.TestCase):
    def test_health_waits_for_both_runtime_files_while_published_tokens_work(self):
        # Execute main's publication statements without binding a socket or starting its services.
        source, first_line = inspect.getsourcelines(main)
        tree = ast.parse("".join(source))
        ast.increment_lineno(tree, first_line - 1)
        statements = tree.body[0].body
        start = next(i for i, node in enumerate(statements)
                     if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
                     and node.value.value == "publishing")
        end = next(i for i in range(start + 1, len(statements))
                   if isinstance(statements[i], ast.Expr) and isinstance(statements[i].value, ast.Call)
                   and isinstance(statements[i].value.func, ast.Name) and statements[i].value.func.id == "print")
        publication = compile(ast.Module(body=statements[start:end], type_ignores=[]), inspect.getfile(main), "exec")
        server = SimpleNamespace(startup_stage="behavior", degraded=[], server_port=12345)

        def response(path):
            replies = []
            handler = SimpleNamespace(server=server, command="GET", path=path,
                                      _json=lambda code, body: replies.append((code, body)))
            handler._dispatch = lambda: Handler._health(handler) if path == "/health" else handler._json(200, {})
            Handler.do_GET(handler)
            return replies[0]

        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            published = []

            def checked_write(path, text):
                self.assertEqual(response("/health")[1]["status"], "starting",
                                 f"health became ok before writing {path.name}")
                self.assertFalse(path.exists())
                write_secret(path, text)
                published.append(path)
                for runtime in published:
                    value = json.loads(runtime.read_text(encoding="utf-8"))
                    token_key = runtime.name.replace("-runtime.json", "_token")
                    self.assertEqual(value, {"schema": 1, "base_url": "http://127.0.0.1:12345",
                                             token_key: TOKENS[token_key]})
                    self.assertEqual(response("/state")[0], 200, f"{runtime.name} published while routes still wait")
                self.assertEqual(response("/health")[1]["status"], "starting")

            exec(publication, {"server": server, "state_dir": state_dir, "paths": paths, "json": json,
                               "write_secret": checked_write, **TOKENS})
            self.assertEqual([path.name for path in published],
                             ["ui-runtime.json", "events-runtime.json", "integration-runtime.json"])
            self.assertEqual(response("/health"), (200, {"status": "ok", "degraded": [], "c6_contract": "v1"}))


class HandlerStartupTest(unittest.TestCase):
    def setUp(self):
        self.server = AgentdServer(("127.0.0.1", 0), **TOKENS)
        self.server.handle_error = lambda *_: None
        self.addCleanup(self.server.server_close)
        thread = serve_in_thread(self.server)
        self.addCleanup(thread.join, 2)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_port

    def test_every_method_waits_while_starting(self):
        self.server.startup_stage, self.server.degraded = "sessions", ["speech"]
        self.assertEqual(request(self.port, "GET", "/health"),
                         (200, {"status": "starting", "stage": "sessions", "degraded": ["speech"], "c6_contract": "v1"}))
        for method, path, token, body in (("GET", "/state", TOKENS["ui_token"], None),
                                          ("POST", "/hook/claude", TOKENS["hook_token"], b"{}"),
                                          ("PUT", "/memory/paused", TOKENS["ui_token"], b"{}"),
                                          ("PATCH", "/memory/facts/a", TOKENS["ui_token"], b"{}"),
                                          ("DELETE", "/attention", TOKENS["ui_token"], None)):
            with self.subTest(method=method, path=path):
                self.assertEqual(request(self.port, method, path, token, body), (503, {"error": "starting"}))

    def test_ready_health_names_degraded_subsystems(self):
        self.assertEqual(request(self.port, "GET", "/health"), (200, {"status": "ok", "degraded": [], "c6_contract": "v1"}))
        self.server.degraded = ["observations"]
        self.assertEqual(request(self.port, "GET", "/health"),
                         (200, {"status": "ok", "degraded": ["observations"], "c6_contract": "v1"}))

    def test_put_patch_and_delete_answer_500_when_their_handler_raises(self):
        with mock.patch("api.handler.Handler._dispatch", side_effect=RuntimeError("fixture")):
            for method, path, body in (("PUT", "/memory/paused", b"{}"), ("PATCH", "/memory/facts/a", b"{}"),
                                       ("DELETE", "/attention", None)):
                with self.subTest(method=method):
                    self.assertEqual(request(self.port, method, path, TOKENS["ui_token"], body),
                                     (500, {"error": "internal_error", "route": f"{method} {path}"}))


class ObservationRestartTest(unittest.TestCase):
    setUp = fixture.SemanticTests.setUp
    tearDown = fixture.SemanticTests.tearDown
    factory = fixture.SemanticTests.factory

    def test_restart_skips_hook_preview_metadata_python_cannot_parse(self):
        self.server.capture = CaptureManager(self.server.feed, Blacklist(deny_blacklist(self.root / 'blacklist.json')), lambda: None, None,
                                             share_text=True, vision=object())
        self.server.share_typed_text = True
        self.server.sync_privacy()
        ident = self.c.observations.ingest('native_ax', 'Compile failed', source_key='editor',
                                           metadata={'app': 'Xcode', 'coverage': {'status': 'complete', 'scope': 'window'}})
        # SQLite's json_extract reads JSON5 that json.loads refuses.
        self.db.execute("UPDATE observation_frames SET metadata=? WHERE id=?", ("{kind:'agent',role:'tool',}", ident))
        self.db.commit()
        restarted = ObservationService(self.c)
        self.assertEqual(restarted.evidence_unit(ident), ident)


if __name__ == "__main__":
    unittest.main()
