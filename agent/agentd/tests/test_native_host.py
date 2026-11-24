from contextlib import redirect_stderr
import http.server
import io
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agentd"))
sys.path.insert(0, str(ROOT / "browser"))

from observation.attention import AttentionStore  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
import native_host  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from support import deny_blacklist, enable_plugins, serve_in_thread  # noqa: E402

HOOK, UI = "hook-token", "ui-token"
ORIGIN = "chrome-extension://oahafcajijleoficnkbfaedkmnkhnief/"


def frame(obj):
    raw = json.dumps(obj).encode()
    return struct.pack("=I", len(raw)) + raw


def unframe(data):
    out = []
    while data:
        (size,), data = struct.unpack("=I", data[:4]), data[4:]
        out.append(json.loads(data[:size]))
        data = data[size:]
    return out


class StandaloneNativeHostTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        self.rules = {"mode": "deny", "domains": ["ICBC.com.cn", "straße.de"], "title_patterns": ["private", "工资"]}
        self.config = {"type": "config", "enabled": False, "text_enabled": False, **self.rules, "allow_domains": []}
        self.messages = [{"type": kind, "url_host": "github.com", "title": "PR", "text": "secret"}
                         for kind in ("heartbeat", "page", "selection", "metrics", "selection_cleared")]
        self.requests = []

        def urlopen(request, timeout):
            self.requests.append(request)
            return io.BytesIO(b'{"enabled": true, "text_enabled": true}')

        patch = mock.patch.object(native_host.OPENER, "open", side_effect=urlopen)
        patch.start()
        self.addCleanup(patch.stop)

    def write_state(self, state):
        (state / "blacklist.json").write_text(json.dumps(self.rules), encoding="utf-8")
        (state / "hook.token").write_text(HOOK + "\n", encoding="utf-8")
        (state / "hook.token").chmod(0o600)
        (state / "ui-runtime.json").write_text(json.dumps({"base_url": "http://127.0.0.1:48820"}), encoding="utf-8")

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_runs_without_agentd_code_or_process(self):
        script = self.state / "native_host.py"
        script.write_text(Path(native_host.__file__).read_text(encoding="utf-8"), encoding="utf-8")
        (self.state / "extension-origin").write_bytes(Path(native_host.__file__).with_name("extension-origin").read_bytes())
        result = subprocess.run([sys.executable, "-I", str(script), "--state-dir", str(self.state), ORIGIN],
                                input=b"", capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(unframe(result.stdout), [{"type": "config", "enabled": False, "text_enabled": False,
                                                  "domains": [], "title_patterns": [], "mode": "allow",
                                                  "allow_domains": []}])
        self.assertEqual(result.stderr.decode().splitlines(), ["agentd is not running"])
        self.assertFalse((self.state / "blacklist.json").exists())

    def test_only_registered_chrome_origin_serves(self):
        for chrome_args, allowed in (([], False), (["chrome-extension://other/"], False),
                                     ([ORIGIN, "--parent-window=0"], True)):
            with self.subTest(chrome_args=chrome_args), mock.patch.object(native_host, "serve") as serve, \
                    mock.patch.object(sys, "argv", ["native_host", "--state-dir", str(self.state), *chrome_args]):
                if allowed:
                    native_host.main()
                    serve.assert_called_once()
                else:
                    with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                        native_host.main()
                    serve.assert_not_called()

    def test_windows_token_file_allows_host_initialization(self):
        self.write_state(self.state)
        (self.state / "hook.token").chmod(0o666)
        stdout = io.BytesIO()
        windows_os = os if os.name == "nt" else SimpleNamespace(name="nt", O_RDONLY=os.O_RDONLY, open=os.open,
                                                                fstat=os.fstat, close=os.close, fdopen=os.fdopen)
        with mock.patch.object(native_host, "os", windows_os):
            native_host.serve(self.state, io.BytesIO(), stdout)
        self.assertTrue(unframe(stdout.getvalue())[0]["enabled"])
        self.assertEqual(self.requests[0].get_header("Authorization"), "Bearer " + HOOK)

    def test_shutdown_stops_authenticated_posts_and_policy_refresh(self):
        with subprocess.Popen([sys.executable, "-I", "-c", "pass"]) as process:
            process.wait()
        for missing in (False, True):
            with self.subTest(missing=missing):
                self.write_state(self.state)
                record = self.state / "ui-runtime.json"
                live = {"base_url": "http://127.0.0.1:48810", "pid": os.getpid()}
                record.write_text(json.dumps(live), encoding="utf-8")
                self.requests.clear()
                stdout = io.BytesIO()

                def messages():
                    self.assertTrue(unframe(stdout.getvalue())[0]["enabled"])
                    self.assertEqual(self.requests[0].get_header("Authorization"), "Bearer " + HOOK)
                    if missing:
                        record.unlink()
                    else:
                        record.write_text(json.dumps({**live, "pid": process.pid}), encoding="utf-8")
                    yield self.messages[0]
                    yield {"type": "policy"}
                    yield self.messages[0]
                    yield None

                with mock.patch.object(native_host, "read_message", side_effect=messages()):
                    native_host.serve(self.state, io.BytesIO(), stdout)
                self.assertEqual([r.selector for r in self.requests], ["/context/browser/policy"])
                self.assertFalse(unframe(stdout.getvalue())[-1]["enabled"])

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_unavailable_discovery_files_disable_and_recover(self):
        for filename in ("ui-runtime.json", "hook.token"):
            for problem in ("missing", "unreadable") + (("no_base_url",) if filename == "ui-runtime.json" else ()):
                with self.subTest(filename=filename, problem=problem):
                    state = self.state / (filename + "-" + problem)
                    state.mkdir()
                    self.write_state(state)
                    path = state / filename
                    contents = path.read_text(encoding="utf-8")
                    if problem == "missing":
                        path.unlink()
                    elif problem == "no_base_url":
                        path.write_text("{}", encoding="utf-8")
                    else:
                        path.chmod(0)
                    self.requests.clear()
                    stdout, stderr = io.BytesIO(), io.StringIO()

                    def messages():
                        self.assertEqual(unframe(stdout.getvalue()), [self.config])
                        self.assertEqual(stderr.getvalue().splitlines(), ["agentd is not running"])
                        self.assertEqual(self.requests, [])
                        yield self.messages[0]
                        self.assertEqual(self.requests, [])
                        if path.exists():
                            path.chmod(0o600)
                        path.write_text(contents, encoding="utf-8")
                        path.chmod(0o600)
                        (state / "ui-runtime.json").write_text(json.dumps({"base_url": "http://127.0.0.1:48821"}), encoding="utf-8")
                        (state / "hook.token").write_text(" replacement-token \n", encoding="utf-8")
                        yield {"type": "policy"}
                        yield self.messages[1]
                        yield None

                    incoming = messages()
                    with redirect_stderr(stderr), mock.patch.object(native_host, "read_message",
                                                                    side_effect=lambda _: next(incoming)):
                        native_host.serve(state, io.BytesIO(), stdout)
                    configs = unframe(stdout.getvalue())
                    self.assertEqual(len(configs), 2)
                    self.assertTrue(configs[1]["enabled"])
                    self.assertEqual(stderr.getvalue().splitlines(), ["agentd is not running"])
                    self.assertEqual([r.full_url for r in self.requests],
                                     ["http://127.0.0.1:48821/context/browser/policy",
                                      "http://127.0.0.1:48821/context/browser"])
                    self.assertTrue(all(r.get_header("Authorization") == "Bearer replacement-token"
                                        for r in self.requests))
                    self.assertEqual(json.loads(self.requests[1].data), self.messages[1])

    def test_discovery_address_other_than_loopback_port_gets_no_request(self):
        self.write_state(self.state)
        for base in ("http://example.com:80", "https://127.0.0.1:48820", "http://u@127.0.0.1:48820",
                     "http://127.0.0.1:48820/", "http://127.0.0.1:48820/x", "http://127.0.0.1:48820?q",
                     "http://127.0.0.1:48820#f", "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:65536",
                     "http://localhost:48820", "http://127.0.0.1:48820\n"):
            with self.subTest(base=base):
                (self.state / "ui-runtime.json").write_text(json.dumps({"base_url": base}), encoding="utf-8")
                self.requests.clear()
                stdout = io.BytesIO()
                with redirect_stderr(io.StringIO()):
                    native_host.serve(self.state, io.BytesIO(b"".join(frame(m) for m in self.messages)), stdout)
                self.assertEqual(self.requests, [])
                self.assertFalse(unframe(stdout.getvalue())[0]["enabled"])

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_unsafe_hook_tokens_disable_the_host(self):
        for problem in ("mode", "symlink", "hardlink", "fifo", "directory", "owner"):
            with self.subTest(problem=problem):
                state = self.state / problem
                state.mkdir()
                self.write_state(state)
                path = state / "hook.token"
                if problem == "mode":
                    path.chmod(0o640)
                elif problem == "hardlink":
                    os.link(path, state / "other.token")
                elif problem in ("symlink", "fifo", "directory"):
                    path.rename(state / "other.token")
                    if problem == "symlink":
                        path.symlink_to(state / "other.token")
                    elif problem == "fifo":
                        os.mkfifo(path)
                    else:
                        path.mkdir()
                stdout, stderr = io.BytesIO(), io.StringIO()
                uid = os.getuid() + (1 if problem == "owner" else 0)
                with redirect_stderr(stderr), mock.patch("os.getuid", return_value=uid):
                    native_host.serve(state, io.BytesIO(b"".join(frame(m) for m in self.messages)), stdout)
                self.assertEqual(unframe(stdout.getvalue()), [self.config])
                self.assertEqual(stderr.getvalue().splitlines(), ["agentd is not running"])
                self.assertEqual(self.requests, [])

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_unavailable_blacklist_drops_every_message_and_recovers(self):
        for problem in ("missing", "unreadable", "invalid_json", "not_object", "bad_pattern"):
            with self.subTest(problem=problem):
                state = self.state / problem
                state.mkdir()
                self.write_state(state)
                path = state / "blacklist.json"
                if problem == "missing":
                    path.unlink()
                elif problem == "unreadable":
                    path.chmod(0)
                elif problem == "bad_pattern":
                    path.write_text(json.dumps({**self.rules, "title_patterns": ["("]}), encoding="utf-8")
                else:
                    path.write_text("{" if problem == "invalid_json" else "[]", encoding="utf-8")
                self.requests.clear()
                stdout = io.BytesIO()

                def messages():
                    yield from self.messages
                    self.assertEqual([r for r in self.requests if r.get_method() == "POST"], [])
                    if problem == "missing":
                        self.assertFalse(path.exists())
                    if path.exists():
                        path.chmod(0o600)
                    path.write_text(json.dumps(self.rules), encoding="utf-8")
                    yield {"type": "policy"}
                    yield self.messages[0]
                    yield None

                incoming = messages()
                with mock.patch.object(native_host, "read_message", side_effect=lambda _: next(incoming)):
                    native_host.serve(state, io.BytesIO(), stdout)
                configs = unframe(stdout.getvalue())
                self.assertEqual((configs[0]["domains"], configs[0]["title_patterns"]), ([], []))
                self.assertEqual((configs[1]["domains"], configs[1]["title_patterns"]),
                                 (self.rules["domains"], self.rules["title_patterns"]))
                self.assertEqual([json.loads(r.data) for r in self.requests if r.get_method() == "POST"],
                                 [self.messages[0]])

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_blacklist_is_read_only_and_matches_browser_rules(self):
        allow = {"domains": ["GitHub.com", "icbc.com.cn"], "bundle_ids": ["com.apple.Safari"]}
        for rules in (self.rules, {**self.rules, "mode": "allow", "allow": allow}, {**self.rules, "mode": "allow"},
                      {**self.rules, "mode": "other", "allow": allow}):
            with self.subTest(rules=rules):
                self.requests.clear()
                self.rules = rules
                self.write_state(self.state)
                path = self.state / "blacklist.json"
                contents = path.read_bytes()
                path.chmod(0o644)
                oracle_path = self.state / "oracle.json"
                oracle_path.write_bytes(contents)
                oracle = Blacklist(oracle_path)
                messages = [{"type": kind, "url_host": host, "title": title}
                            for kind in ("page", "heartbeat")
                            for host, title in (("icbc.COM.cn", "PR"), ("M.icbc.com.cn", "PR"), ("noticbc.com.cn", "PR"),
                                                ("icbc.com.cn.", "PR"), ("m.icbc.com.cn.", "PR"), ("github.com.", "PR"),
                                                ("icbc.com.cn.evil", "PR"), ("STRASSE.DE", "PR"),
                                                ("github.com", "a private PR"), ("github.com", "工资条"),
                                                ("github.com", "PRIVATE"), ("gist.github.com", "PR"),
                                                ("example.com", "PR"), (None, None))]
                native_host.serve(self.state, io.BytesIO(b"".join(frame(m) for m in messages)), io.BytesIO())
                self.assertEqual(path.stat().st_mode & 0o777, 0o644)
                self.assertEqual(path.read_bytes(), contents)
                expected = []
                for message in messages:
                    if not oracle.hides(message):
                        expected.append(message)
                    elif message["type"] == "heartbeat":
                        expected.append({**message, "url_host": "<hidden>", "title": None})
                self.assertEqual([json.loads(r.data) for r in self.requests if r.get_method() == "POST"], expected)


class NativeHostTest(unittest.TestCase):
    def setUp(self):
        enable_plugins(self, "screen_awareness")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
        # The messages below are stamped 1792300000; selections reach the mouth only while recent.
        self.server.attention = AttentionStore(self.state / "attention.sqlite",
                                               Blacklist(deny_blacklist(self.state / "blacklist.json")),
                                               clock=lambda: 1792300002.0)
        self.addCleanup(self.server.attention.close)
        serve_in_thread(self.server)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        (self.state / "hook.token").write_text(HOOK + "\n", encoding="utf-8")
        (self.state / "hook.token").chmod(0o600)
        (self.state / "ui-runtime.json").write_text(json.dumps(
            {"base_url": f"http://127.0.0.1:{self.server.server_port}", "ui_token": UI}), encoding="utf-8")

    def run_host(self, messages):
        stdin, stdout = io.BytesIO(b"".join(frame(m) for m in messages)), io.BytesIO()
        native_host.serve(self.state, stdin, stdout)
        return unframe(stdout.getvalue())

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_sends_blacklist_domains_first(self):
        [config] = self.run_host([])
        self.assertEqual(config["type"], "config")
        self.assertIn("icbc.com.cn", config["domains"])
        self.assertEqual((config["mode"], config["allow_domains"]), ("deny", []))
        self.server.attention.blacklist.set_mode("allow")
        self.server.attention.blacklist.allow_add("domains", "github.com")
        [config] = self.run_host([])
        self.assertEqual((config["mode"], config["allow_domains"]), ("allow", ["github.com"]))

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_reads_the_c10_example_blacklist(self):
        example = (ROOT.parent / "protocol/C10-shared-files/examples/blacklist.json").read_text(encoding="utf-8")
        (self.state / "blacklist.json").write_text(example, encoding="utf-8")
        [config] = self.run_host([])
        self.assertEqual((config["domains"], config["title_patterns"]),
                         (json.loads(example)["domains"], json.loads(example)["title_patterns"]))
        self.assertIsNone(native_host.scrub({"type": "page", "url_host": "m.icbc.com.cn", "title": "x", "text": "y"},
                                            native_host.Blacklist(self.state / "blacklist.json")))

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_forwards_heartbeat_page_and_selection(self):
        self.server.share_page_text = True
        self.run_host([
            {"type": "heartbeat", "ts": 1792300000.0, "url_host": "github.com", "title": "PR", "audible": False,
             "visible": True, "tab_id": 1, "window_focused": True},
            {"type": "selection", "ts": 1792300001.0, "url_host": "github.com", "title": "PR", "text": "一句"}])
        self.assertEqual(self.server.attention.events("browser")[0]["data"]["url_host"], "github.com")
        self.assertEqual(self.server.attention.latest_selection()["text"], "一句")

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_forwards_identity_fields_and_selection_cleared(self):
        self.server.share_page_text = True
        ids = {"browser_session": "S1", "tab_id": 1, "document_id": "D1", "revision": 1}
        self.run_host([
            {"type": "heartbeat", "ts": 1792300000.0, "url_host": "github.com", "title": "PR", "audible": False,
             "visible": True, "window_focused": True, **ids},
            {"type": "selection", "ts": 1792300001.0, "url_host": "github.com", "title": "PR", "text": "一句", **ids}])
        self.assertEqual({k: self.server.attention.events("browser")[0]["data"][k] for k in ids}, ids)
        self.assertEqual(self.server.attention.latest_selection()["text"], "一句")
        self.run_host([
            {"type": "selection_cleared", "ts": 1792300001.5, "url_host": "github.com", "title": "PR", **ids}])
        self.assertIsNone(self.server.attention.latest_selection())

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_blacklisted_host_text_never_leaves_the_host(self):
        self.run_host([
            {"type": "heartbeat", "ts": 1792300000.0, "url_host": "mybank.icbc.com.cn", "title": "账户",
             "audible": False, "visible": True, "tab_id": 1, "window_focused": True},
            {"type": "page", "ts": 1792300001.0, "url_host": "mybank.icbc.com.cn", "title": "账户", "text": "余额"}])
        self.assertEqual(self.server.attention.events("browser")[0]["data"]["url_host"], "<hidden>")
        self.assertEqual(self.server.attention.context(), [])

    def test_scrub_drops_text_and_hides_heartbeats_on_blacklisted_hosts(self):
        blacklist = native_host.Blacklist(self.state / "blacklist.json")
        page = {"type": "page", "ts": 1.0, "url_host": "mybank.icbc.com.cn", "title": "账户", "text": "余额"}
        beat = {"type": "heartbeat", "ts": 1.0, "url_host": "icbc.com.cn", "title": "账户", "audible": False}
        self.assertIsNone(native_host.scrub(page, blacklist))
        self.assertEqual(native_host.scrub(beat, blacklist),
                         {**beat, "url_host": "<hidden>", "title": None})
        ok = {**page, "url_host": "github.com"}
        self.assertEqual(native_host.scrub(ok, blacklist), ok)

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_allow_mode_forwards_only_tabs_on_the_allow_list(self):
        self.server.share_page_text = True
        self.server.attention.blacklist.set_mode("allow")
        self.server.attention.blacklist.allow_add("domains", "github.com")
        tab = {"audible": False, "visible": True, "tab_id": 1, "window_focused": True}
        self.run_host([
            {"type": "heartbeat", "ts": 1792300000.0, "url_host": "news.example.com", "title": "新闻", **tab},
            {"type": "page", "ts": 1792300000.5, "url_host": "news.example.com", "title": "新闻", "text": "正文"},
            {"type": "selection", "ts": 1792300001.0, "url_host": "gist.github.com", "title": "PR", "text": "一句"}])
        self.assertEqual(self.server.attention.events("browser")[0]["data"]["url_host"], "<hidden>")
        self.assertEqual([c["url_host"] for c in self.server.attention.context()], ["gist.github.com"])
        blacklist = native_host.Blacklist(self.state / "blacklist.json")
        self.assertIsNone(native_host.scrub({"type": "page", "url_host": "example.com", "title": "x", "text": "y"},
                                            blacklist))
        self.assertIsNone(native_host.scrub({"type": "metrics", "url_host": None, "title": None}, blacklist))

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_agentd_down_does_not_stop_the_host(self):
        (self.state / "ui-runtime.json").write_text(json.dumps({"base_url": "http://127.0.0.1:9", "ui_token": UI}), encoding="utf-8")
        out = self.run_host([{"type": "selection", "ts": 1.0, "url_host": "a.com", "title": None, "text": "x"}])
        self.assertEqual(out[0]["type"], "config")

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_requests_bypass_proxies(self):
        self.server.share_page_text = True
        with socket.socket() as dead:
            dead.bind(("127.0.0.1", 0))
            proxy = f"http://127.0.0.1:{dead.getsockname()[1]}"
        environ = {k: v for k, v in os.environ.items() if k.lower() not in ("no_proxy", "http_proxy", "https_proxy")}
        with mock.patch.dict(os.environ, {**environ, "HTTP_PROXY": proxy, "http_proxy": proxy}, clear=True), \
                mock.patch.object(urllib.request, "_opener", None):
            [config] = self.run_host([
                {"type": "heartbeat", "ts": 1792300000.0, "url_host": "github.com", "title": "PR", "audible": False,
                 "visible": True, "tab_id": 1, "window_focused": True},
                {"type": "selection", "ts": 1792300001.0, "url_host": "github.com", "title": "PR", "text": "一句"}])
        self.assertTrue(config["enabled"])
        self.assertEqual(self.server.attention.latest_selection()["text"], "一句")

    def test_redirects_are_not_followed(self):
        seen = []

        class Redirect(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.path, self.headers.get("Authorization")))
                if self.path == "/context/browser/policy":
                    self.send_response(302)
                    self.send_header("Location", "/elsewhere")
                    self.end_headers()
                    return
                body = b'{"enabled": true, "text_enabled": true}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        serve_in_thread(server)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        (self.state / "ui-runtime.json").write_text(json.dumps({"base_url": f"http://127.0.0.1:{server.server_port}"}),
                                                    encoding="utf-8")
        [config] = self.run_host([])
        self.assertFalse(config["enabled"])
        self.assertEqual(seen, [("/context/browser/policy", "Bearer " + HOOK)])

    def test_host_reads_no_ui_token(self):
        self.assertNotIn("ui_token", Path(native_host.__file__).read_text(encoding="utf-8"))

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_default_policy_does_not_collect_text(self):
        [config] = self.run_host([{"type": "page", "ts": 1792300000.0, "url_host": "github.com", "text": "secret"}])
        self.assertTrue(config["enabled"])
        self.assertFalse(config["text_enabled"])
        self.assertEqual(self.server.attention.context(), [])

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_policy_refresh_respects_pause_and_title_blacklist(self):
        self.server.paused_until = self.server.clock() + 60
        configs = self.run_host([{"type": "policy"}])
        self.assertEqual(len(configs), 2)
        self.assertTrue(all(not c["enabled"] for c in configs))
        blacklist = self.server.attention.blacklist
        blacklist.add("title_patterns", "private")
        self.assertIsNone(native_host.scrub({"type": "metrics", "url_host": "github.com", "title": "private"},
                                            native_host.Blacklist(self.state / "blacklist.json")))


if __name__ == "__main__":
    unittest.main()
