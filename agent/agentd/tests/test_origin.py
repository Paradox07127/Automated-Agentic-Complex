import http.server
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import codex_hook_forward  # noqa: E402
from sessions.events import normalize_claude, normalize_codex  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from infra.tokens import write_secret  # noqa: E402
from support import enable_plugins, serve_in_thread  # noqa: E402

HOOK, UI = "hook-token", "ui-token"
EXAMPLES = Path(__file__).resolve().parents[1] / "config-examples"


# A process on a fresh pty (the agent) runs a hook whose stdin/stdout (and maybe stderr) are not the terminal.
TTY_PROBE = r"""
import json, os, pty, sys
sys.path.insert(0, sys.argv[1])
keep_stderr, out = sys.argv[2] == "1", sys.argv[3]
pid, master = pty.fork()
if pid == 0:
    expected = os.ttyname(0)
    hook = os.fork()
    if hook == 0:
        null = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1) if keep_stderr else (0, 1, 2):
            os.dup2(null, fd)
        import codex_hook_forward
        with open(out, "w") as stream:
            json.dump({"expected": expected, "got": codex_hook_forward._tty()}, stream)
        os._exit(0)
    os.waitpid(hook, 0)
    os._exit(0)
try:
    while os.read(master, 1024):
        pass
except OSError:
    pass
os.waitpid(pid, 0)
"""


class TtyTest(unittest.TestCase):
    def probe(self, keep_stderr):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "tty.json"
            subprocess.run([sys.executable, "-c", TTY_PROBE, str(Path(codex_hook_forward.__file__).parent),
                            "1" if keep_stderr else "0", str(out)], timeout=20, check=True)
            return json.loads(out.read_text(encoding="utf-8"))

    @unittest.skipIf(sys.platform == "win32", "the test needs POSIX signals, pty or time.tzset")
    def test_hook_reports_the_real_terminal_device(self):
        for keep_stderr in (False, True):
            with self.subTest(keep_stderr=keep_stderr):
                result = self.probe(keep_stderr)
                self.assertRegex(result["expected"], r"^/dev/(?:tty[a-z]\w*|pts/\d+)$")
                self.assertEqual(result["got"], result["expected"])

    def test_no_terminal_is_none(self):
        with mock.patch.object(codex_hook_forward.os, "isatty", return_value=False), \
                mock.patch.object(codex_hook_forward.subprocess, "run",
                                  return_value=subprocess.CompletedProcess([], 0, stdout="??\n")):
            self.assertIsNone(codex_hook_forward._tty())

    def test_windows_has_no_terminal_device(self):
        """A console std fd on Windows has no os.ttyname, and there is no ps."""
        with mock.patch.object(codex_hook_forward.os, "name", "nt"), \
                mock.patch.object(codex_hook_forward.os, "isatty", return_value=True), \
                mock.patch.object(codex_hook_forward.os, "ttyname", side_effect=AttributeError, create=True), \
                mock.patch.object(codex_hook_forward.subprocess, "run", side_effect=FileNotFoundError):
            self.assertIsNone(codex_hook_forward._tty())


class OriginTest(unittest.TestCase):
    def test_kind_from_env_and_tty(self):
        with mock.patch.object(codex_hook_forward, "_tty", return_value="/dev/ttys004"):
            tmux = codex_hook_forward.origin({"TMUX": "/private/tmp/tmux-501/default,123,0", "TMUX_PANE": "%3",
                                              "TERM_PROGRAM": "tmux"})
            terminal = codex_hook_forward.origin({"TERM_PROGRAM": "iTerm.app"})
        self.assertEqual({k: tmux[k] for k in ("kind", "tmux_socket", "tmux_pane", "tty")},
                         {"kind": "tmux", "tmux_socket": "/private/tmp/tmux-501/default", "tmux_pane": "%3",
                          "tty": "/dev/ttys004"})
        self.assertEqual((terminal["kind"], terminal["term_program"]), ("terminal", "iTerm.app"))
        with mock.patch.object(codex_hook_forward, "_tty", return_value=None):
            desktop = codex_hook_forward.origin({"CLAUDE_CODE_ENTRYPOINT": "claude-desktop"})
            unknown = codex_hook_forward.origin({})
        self.assertEqual((desktop["kind"], desktop["entrypoint"]), ("desktop", "claude-desktop"))
        self.assertEqual(unknown, {"kind": "unknown", "term_program": None, "tty": None, "tmux_pane": None,
                                   "tmux_socket": None, "pid": unknown["pid"], "entrypoint": None,
                                   "bundle_id": None, "wezterm_pane": None, "kitty_window_id": None,
                                   "kitty_listen_on": None})
        self.assertIsInstance(unknown["pid"], int)

    def test_terminal_specific_ids_come_from_env(self):
        env = {"TERM_PROGRAM": "vscode", "__CFBundleIdentifier": "com.todesktop.230313mzl4w4u92",
               "WEZTERM_PANE": "7", "KITTY_WINDOW_ID": "3", "KITTY_LISTEN_ON": "unix:/tmp/kitty-501"}
        with mock.patch.object(codex_hook_forward, "_tty", return_value="/dev/ttys001"):
            o = codex_hook_forward.origin(env)
        self.assertEqual({k: o[k] for k in ("kind", "term_program", "bundle_id", "wezterm_pane", "kitty_window_id",
                                            "kitty_listen_on", "entrypoint")},
                         {"kind": "terminal", "term_program": "vscode", "bundle_id": "com.todesktop.230313mzl4w4u92",
                          "wezterm_pane": "7", "kitty_window_id": "3", "kitty_listen_on": "unix:/tmp/kitty-501",
                          "entrypoint": None})

    def test_events_keep_only_valid_origin_fields(self):
        good = {"kind": "tmux", "term_program": "tmux", "tty": "/dev/ttys004", "tmux_pane": "%3",
                "tmux_socket": "/private/tmp/tmux-501/default", "pid": 4321, "entrypoint": "cli",
                "bundle_id": "com.googlecode.iterm2", "wezterm_pane": None, "kitty_window_id": None,
                "kitty_listen_on": None}
        event = normalize_codex({"hook_event_name": "SessionStart", "session_id": "S", "agentd_origin": good})
        self.assertEqual(event.origin, good)
        bad = normalize_claude({"hook_event_name": "SessionStart", "session_id": "S", "agentd_origin": {
            "kind": "spaceship", "tty": "/etc/passwd", "pid": "12", "tmux_pane": "x" * 999, "extra": 1}})
        self.assertEqual(bad.origin, {"kind": "unknown", "term_program": None, "tty": None, "tmux_pane": None,
                                      "tmux_socket": None, "pid": None, "entrypoint": None, "bundle_id": None,
                                      "wezterm_pane": None, "kitty_window_id": None, "kitty_listen_on": None})
        self.assertIsNone(normalize_claude({"hook_event_name": "Stop", "session_id": "S"}).origin)

    def test_claude_example_sends_origin_from_command_hooks_without_duplicates(self):
        hooks = json.loads((EXAMPLES / "claude-settings.agentd.json").read_text(encoding="utf-8"))["hooks"]
        [entry] = hooks["UserPromptSubmit"][0]["hooks"]
        self.assertEqual(entry["type"], "command")
        self.assertIn("--endpoint /hook/claude", entry["command"])
        self.assertLessEqual(entry["timeout"], 5)
        for name, groups in hooks.items():
            self.assertEqual(len([h for g in groups for h in g["hooks"]]), 1, name)


class OriginServerTest(unittest.TestCase):
    def setUp(self):
        enable_plugins(self, "coding_sessions")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
        from sessions.own import SessionManager
        self.server.sessions = SessionManager(self.server.broker, self.server.announce, Path(self.tmp.name),
                                              f"http://127.0.0.1:{self.server.server_port}", HOOK, hook_timeout=10)
        serve_in_thread(self.server)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.token = Path(self.tmp.name) / "hook.token"
        write_secret(self.token, HOOK + "\n")

    def forward(self, endpoint, payload, env):
        argv = ["--url", f"http://127.0.0.1:{self.server.server_port}", "--token-file", str(self.token),
                "--endpoint", endpoint]
        with mock.patch.dict("os.environ", env, clear=True), \
                mock.patch.object(codex_hook_forward, "_tty", return_value="/dev/ttys009"):
            return codex_hook_forward.main(argv, io.BytesIO(json.dumps(payload).encode()))

    def sessions(self):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("GET", "/sessions", headers={"Authorization": f"Bearer {UI}"})
        data = json.loads(conn.getresponse().read())
        conn.close()
        return {s["session_id"]: s for s in data["sessions"]}

    def test_forwarded_origin_is_listed_and_the_last_one_wins(self):
        self.assertEqual(self.forward("/hook/claude", {"hook_event_name": "SessionStart", "session_id": "T",
                                                       "cwd": "/repo"}, {"TERM_PROGRAM": "Apple_Terminal"}), 0)
        self.assertEqual(self.sessions()["claude:T"]["origin"]["kind"], "terminal")
        self.forward("/hook/claude", {"hook_event_name": "UserPromptSubmit", "session_id": "T", "prompt": "hi"},
                     {"TMUX": "/tmp/tmux-501/default,1,0", "TMUX_PANE": "%1"})
        origin = self.sessions()["claude:T"]["origin"]
        self.assertEqual((origin["kind"], origin["tmux_pane"], origin["tty"]), ("tmux", "%1", "/dev/ttys009"))
        self.post_http({"hook_event_name": "Stop", "session_id": "T"})
        self.assertEqual(self.sessions()["claude:T"]["origin"]["kind"], "tmux")
        self.forward("/hook/codex", {"hook_event_name": "SessionStart", "session_id": "X"}, {})
        self.assertEqual(self.sessions()["codex:X"]["origin"]["kind"], "terminal")
        self.assertEqual(self.sessions()["codex:X"]["capabilities"], ["observe", "navigate"])

    def post_http(self, payload):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("POST", "/hook/claude", json.dumps(payload).encode(),
                     {"Authorization": f"Bearer {HOOK}", "Content-Type": "application/json"})
        conn.getresponse().read()
        conn.close()

    def test_external_session_carries_its_last_hook_time(self):
        before = time.time()
        self.post_http({"hook_event_name": "Stop", "session_id": "O"})
        observed = self.sessions()["claude:O"]["observed_at"]
        self.assertIsInstance(observed, float)
        self.assertGreaterEqual(observed, before - 1)

    def test_session_without_origin_is_unknown(self):
        self.post_http({"hook_event_name": "Stop", "session_id": "H"})
        self.assertEqual(self.sessions()["claude:H"]["capabilities"], ["observe"])
        self.assertEqual(self.sessions()["claude:H"]["origin"],
                         {"kind": "unknown", "term_program": None, "tty": None, "tmux_pane": None,
                          "tmux_socket": None, "pid": None, "entrypoint": None, "bundle_id": None,
                          "wezterm_pane": None, "kitty_window_id": None, "kitty_listen_on": None})


class FailOpenTest(unittest.TestCase):
    """The forwarder never slows the agent down: exit 0, nothing printed, within its time budget."""
    PAYLOAD = json.dumps({"hook_event_name": "PreToolUse", "session_id": "F", "tool_name": "Bash"}).encode()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.token = Path(self.tmp.name) / "hook.token"
        write_secret(self.token, HOOK + "\n")

    def listener(self, listen=True):
        """listen=False: a port nothing listens on (a bound socket without listen() is not refused on macOS)."""
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        url = f"http://127.0.0.1:{sock.getsockname()[1]}"
        if listen:
            sock.listen(4)
            self.addCleanup(sock.close)
        else:
            sock.close()
        return sock, url

    def run_forwarder(self, url, token=None, stdin=PAYLOAD):
        """The script as a hook runs it: its own process, stdin, stdout and stderr on pipes."""
        start = time.monotonic()
        done = subprocess.run([sys.executable, "-I", codex_hook_forward.__file__, "--url", url, "--token-file",
                               str(token or self.token), "--endpoint", "/hook/claude", "--timeout", "0.8"],
                              input=stdin, capture_output=True, timeout=10)
        return (done.returncode, done.stdout, done.stderr), time.monotonic() - start

    @unittest.skipIf(sys.platform == "win32", "the test needs POSIX signals, pty or time.tzset")
    def test_agentd_down_returns_at_once(self):
        _, url = self.listener(listen=False)
        result, elapsed = self.run_forwarder(url)
        self.assertEqual(result, (0, b"", b""))
        self.assertLess(elapsed, 0.3)

    def test_hung_agentd_returns_within_a_second(self):
        _, url = self.listener()  # the backlog accepts; nothing ever answers
        result, elapsed = self.run_forwarder(url)
        self.assertEqual(result, (0, b"", b""))
        self.assertLess(elapsed, 1.0)

    def test_missing_or_unreadable_token_prints_nothing(self):
        _, url = self.listener()
        unreadable = Path(self.tmp.name) / "locked.token"
        write_secret(unreadable, HOOK)
        unreadable.chmod(0)
        for token in (Path(self.tmp.name) / "missing.token", unreadable, Path(self.tmp.name)):
            with self.subTest(token=token.name):
                self.assertEqual(self.run_forwarder(url, token=token)[0], (0, b"", b""))

    def test_bad_stdin_prints_nothing(self):
        _, url = self.listener(listen=False)
        for stdin in (b"", b"not json", b"\xff\xfe", b"[" * 100000, b"[1, 2]"):
            with self.subTest(stdin=stdin[:8]):
                self.assertEqual(self.run_forwarder(url, stdin=stdin)[0], (0, b"", b""))

    def test_garbage_reply_prints_nothing(self):
        sock, url = self.listener()

        def answer():
            conn, _ = sock.accept()
            with conn:
                conn.recv(65536)
                conn.sendall(b"garbage\r\n\r\n")

        threading.Thread(target=answer, daemon=True).start()
        self.assertEqual(self.run_forwarder(url)[0], (0, b"", b""))

    def test_slow_ps_is_cut_short(self):
        bin_dir = Path(self.tmp.name) / "bin"
        bin_dir.mkdir()
        (bin_dir / "ps").write_text("#!/bin/sh\nexec /bin/sleep 5\n", encoding="utf-8")
        (bin_dir / "ps").chmod(0o755)
        start = time.monotonic()
        with mock.patch.dict("os.environ", {"PATH": f"{bin_dir}:{os.environ.get('PATH', '')}"}), \
                mock.patch.object(codex_hook_forward.os, "isatty", return_value=False):
            self.assertIsNone(codex_hook_forward.origin({})["tty"])
        self.assertLess(time.monotonic() - start, 0.4)

    def test_observe_flag_sends_the_header(self):
        seen = []

        class Recorder(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                seen.append((self.path, self.headers.get("X-Agentd-Observe")))
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
        serve_in_thread(server)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        argv = ["--url", f"http://127.0.0.1:{server.server_port}", "--token-file", str(self.token),
                "--endpoint", "/hook/claude"]
        with mock.patch.object(codex_hook_forward, "_tty", return_value=None):
            for extra in ([], ["--observe"]):
                self.assertEqual(codex_hook_forward.main(argv + extra, io.BytesIO(self.PAYLOAD)), 0)
        self.assertEqual(seen, [("/hook/claude", None), ("/hook/claude", "1")])


if __name__ == "__main__":
    unittest.main()
