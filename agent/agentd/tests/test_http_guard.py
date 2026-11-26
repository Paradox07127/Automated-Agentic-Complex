import http.client
import io
import json
from pathlib import Path
import re
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from support import enable_plugins
from api.handler import ROUTES  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
import daemon.main as agentd_main  # noqa: E402
from support import serve_in_thread  # noqa: E402

TOKENS = {"hook_token": "hook-token", "ui_token": "ui-token", "events_token": "events-token"}


def route_path(path):
    if isinstance(path, str):
        return path

    def sample(parts):
        value = ""
        for kind, arg in parts:
            if kind is re._constants.LITERAL:
                value += chr(arg)
            elif kind is re._constants.NOT_LITERAL:
                value += "a" if arg != ord("a") else "b"
            elif kind is re._constants.IN:
                first, item = arg[0]
                value += chr(item[0] if first is re._constants.RANGE else item) \
                    if first in (re._constants.RANGE, re._constants.LITERAL) else "1"
            elif kind is re._constants.SUBPATTERN:
                value += sample(arg[3])
            elif kind is re._constants.BRANCH:
                value += sample(arg[1][0])
            elif kind is re._constants.MAX_REPEAT:
                value += sample(arg[2]) * arg[0]
            elif kind is not re._constants.AT:
                raise AssertionError(kind)
        return value

    value = sample(re._parser.parse(path.pattern, path.flags))
    assert path.fullmatch(value), value
    return value


class HttpGuardTest(unittest.TestCase):
    def setUp(self):
        enable_plugins(self)
        self.server = AgentdServer(("127.0.0.1", 0), **TOKENS)
        self.addCleanup(self.server.server_close)
        self.port = self.server.server_port
        self.thread = serve_in_thread(self.server)
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.server.shutdown)

    def request(self, method, path, token=None, headers=None, body=None, send_body=True):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        self.addCleanup(conn.close)
        headers = dict(headers or {})
        headers.setdefault("Host", f"127.0.0.1:{self.port}")
        conn.putrequest(method, path, skip_host=True)
        if token is not None:
            conn.putheader("Authorization", f"Bearer {token}")
        for key, value in headers.items():
            if value is not None:
                conn.putheader(key, value)
        if body is not None:
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders(body if send_body else None)
        response = conn.getresponse()
        data = json.loads(response.read())
        if not send_body:
            self.assertTrue(response.will_close)
        conn.close()
        return response.status, data

    def test_every_table_entry_requires_its_listed_tokens(self):
        for method, path, allowed in ROUTES:
            path = route_path(path)
            if path == "/health":
                self.assertEqual((method, allowed), ("GET", ()))
                continue
            self.assertTrue(allowed, (method, path))
            for token in (None, *(value for name, value in TOKENS.items() if name not in allowed)):
                with self.subTest(method=method, path=path, token=token):
                    self.assertEqual(self.request(method, path, token), (401, {"error": "unauthorized"}))

    def test_quiet_route_requires_the_ui_token(self):
        self.assertIn(("PUT", "/observation/quiet", ("ui_token",)), ROUTES)
        for token in (None, TOKENS["hook_token"], TOKENS["events_token"]):
            with self.subTest(token=token):
                self.assertEqual(self.request("PUT", "/observation/quiet", token),
                                 (401, {"error": "unauthorized"}))

    def test_gift_route_requires_the_ui_token(self):
        self.assertIn(("POST", "/interaction/gift", ("ui_token",)), ROUTES)
        for token in (None, TOKENS["hook_token"], TOKENS["events_token"]):
            with self.subTest(token=token):
                self.assertEqual(self.request("POST", "/interaction/gift", token),
                                 (401, {"error": "unauthorized"}))

    def test_agent_snapshot_requires_the_ui_token(self):
        self.assertIn(("GET", "/agent/snapshot", ("ui_token",)), ROUTES)
        for token in (None, TOKENS["hook_token"], TOKENS["events_token"]):
            with self.subTest(token=token):
                self.assertEqual(self.request("GET", "/agent/snapshot", token),
                                 (401, {"error": "unauthorized"}))

    def test_history_and_run_files_routes_require_the_ui_token(self):
        self.assertIn(("GET", "/character/state/history", ("ui_token",)), ROUTES)
        for path in ("/agent/tasks/job:a/files",):
            self.assertTrue(any(method == "GET" and not isinstance(pattern, str)
                                and pattern.fullmatch(path) and allowed == ("ui_token",)
                                for method, pattern, allowed in ROUTES))
        for path in ("/character/state/history", "/agent/tasks/job:a/files"):
            for token in (None, TOKENS["hook_token"], TOKENS["events_token"]):
                with self.subTest(path=path, token=token):
                    self.assertEqual(self.request("GET", path, token), (401, {"error": "unauthorized"}))

    def test_reminder_actions_require_the_ui_token(self):
        for action in ("snooze", "complete"):
            path = f"/commitments/reminder/{action}"
            self.assertTrue(any(method == "POST" and not isinstance(pattern, str) and pattern.fullmatch(path)
                                and allowed == ("ui_token",) for method, pattern, allowed in ROUTES))
            for token in (None, TOKENS["hook_token"], TOKENS["events_token"]):
                with self.subTest(action=action, token=token):
                    self.assertEqual(self.request("POST", path, token), (401, {"error": "unauthorized"}))

    def test_unknown_paths_and_methods_are_not_found(self):
        for method, path in (("GET", "/missing"), ("POST", "/missing"), ("PUT", "/missing"),
                             ("PATCH", "/missing"), ("DELETE", "/missing"),
                             ("GET", "/agent/jobs/" + "a" * 32 + "/cancel")):
            for token in (None, TOKENS["ui_token"]):
                with self.subTest(method=method, path=path, token=token):
                    self.assertEqual(self.request(method, path, token), (404, {"error": "not_found"}))

    def test_host_must_be_loopback_and_use_the_server_port(self):
        for host in (f"evil.example:{self.port}", f"127.0.0.1:{self.port + 1}", None):
            with self.subTest(host=host):
                self.assertEqual(self.request("GET", "/health", headers={"Host": host}),
                                 (400, {"error": "invalid_host"}))
        for host in ("127.0.0.1", "localhost", "[::1]"):
            for value in (host, f"{host}:{self.port}"):
                with self.subTest(host=value):
                    self.assertEqual(self.request("GET", "/health", headers={"Host": value})[0], 200)

    def test_cross_site_headers_are_refused_even_with_a_token(self):
        for headers in ({"Origin": "https://evil.example"}, {"Origin": "null"},
                        {"Origin": ""}, {"Sec-Fetch-Site": "cross-site"},
                        {"Sec-Fetch-Site": "same-origin"}, {"Sec-Fetch-Site": ""}):
            for token in (None, TOKENS["ui_token"]):
                with self.subTest(headers=headers, token=token):
                    self.assertEqual(self.request("GET", "/state", token, headers),
                                     (403, {"error": "cross_site"}))
        self.assertEqual(self.request("GET", "/state", TOKENS["ui_token"], {"Sec-Fetch-Site": "none"})[0], 200)

    def test_options_is_method_not_allowed(self):
        self.assertEqual(self.request("OPTIONS", "/state"), (405, {"error": "method_not_allowed"}))

    def test_only_json_media_types_reach_write_routes(self):
        for method, path in (("POST", "/say"), ("PUT", "/memory/paused"), ("PATCH", "/memory/facts/a")):
            with self.subTest(method=method):
                self.assertEqual(self.request(method, path, TOKENS["ui_token"],
                                              {"Content-Type": "text/plain"}, b"{}"),
                                 (415, {"error": "unsupported_media_type"}))
        for headers in ({"Content-Type": "application/json; charset=utf-8"}, {}):
            self.assertEqual(self.request("POST", "/say", TOKENS["ui_token"], headers, b"{}"),
                             (400, {"error": "invalid_text"}))

    def test_guards_run_in_order_and_close_without_reading_the_body(self):
        for method, headers, expected in (
                ("OPTIONS", {"Host": "evil.example", "Origin": "null"}, (400, "invalid_host")),
                ("OPTIONS", {"Origin": "null"}, (403, "cross_site")),
                ("OPTIONS", {"Content-Type": "text/plain"}, (405, "method_not_allowed")),
                ("POST", {"Content-Type": "text/plain"}, (415, "unsupported_media_type"))):
            with self.subTest(method=method, headers=headers):
                self.assertEqual(self.request(method, "/state", headers=headers, body=b"{}", send_body=False),
                                 (expected[0], {"error": expected[1]}))

    def test_bodyless_posts_with_a_body_keep_the_next_request_on_the_connection_intact(self):
        for path in ("/sessions/s1/interrupt", "/tasks/t1/accept", "/tasks/t1/reject",
                     "/commitments/c1/cancel", "/commitments/c1/complete"):
            with self.subTest(path=path):
                conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
                self.addCleanup(conn.close)
                conn.request("POST", path, b"{}", {"Authorization": f"Bearer {TOKENS['ui_token']}",
                                                    "Content-Type": "application/json"})
                conn.getresponse().read()
                conn.request("GET", "/health")
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())["status"], "ok")

    def test_early_replies_to_a_request_with_an_unread_body_keep_the_connection_in_step(self):
        self.server.closing = True  # /sessions answers 503 shutting_down before reading its body
        for path in ("/agent/runs/r1/cancel", "/sessions"):
            with self.subTest(path=path):
                conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
                self.addCleanup(conn.close)
                conn.request("POST", path, b'{"padding": "x"}', {"Authorization": f"Bearer {TOKENS['ui_token']}",
                                                                 "Content-Type": "application/json"})
                response = conn.getresponse()
                response.read()
                self.assertEqual(response.status, 503)
                if response.getheader("Connection", "").lower() == "close":
                    continue
                conn.request("GET", "/health")
                self.assertEqual(conn.getresponse().status, 200)

    def test_a_read_body_or_no_body_keeps_the_connection_open(self):
        for path, body in (("/say", b"{}"), ("/tasks/t1/accept", None)):
            with self.subTest(path=path):
                conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
                self.addCleanup(conn.close)
                conn.request("POST", path, body, {"Authorization": f"Bearer {TOKENS['ui_token']}",
                                                  "Content-Type": "application/json"})
                response = conn.getresponse()
                response.read()
                self.assertFalse(response.will_close)
                sock = conn.sock
                conn.request("GET", "/health")
                self.assertEqual(conn.getresponse().status, 200)
                self.assertIs(conn.sock, sock)

    def test_content_length_with_transfer_encoding_closes_the_connection(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        self.addCleanup(conn.close)
        conn.putrequest("POST", "/say")
        conn.putheader("Authorization", f"Bearer {TOKENS['ui_token']}")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", "2")
        conn.putheader("Transfer-Encoding", "chunked")
        conn.endheaders(b"{}")
        response = conn.getresponse()
        response.read()
        self.assertEqual(response.getheader("Connection"), "close")

    def test_bodyless_routes_answer_oversized_or_chunked_requests_at_once_and_close(self):
        for path in ("/tasks/t1/accept", "/agent/runs/r1/cancel"):
            for header in (("Content-Length", str(10 ** 9)), ("Transfer-Encoding", "chunked")):
                with self.subTest(path=path, header=header[0]):
                    conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
                    self.addCleanup(conn.close)
                    conn.putrequest("POST", path)
                    conn.putheader("Authorization", f"Bearer {TOKENS['ui_token']}")
                    conn.putheader(*header)
                    conn.endheaders()
                    response = conn.getresponse()
                    response.read()
                    self.assertEqual(response.getheader("Connection"), "close")

    def test_non_ascii_bearer_is_unauthorized_and_server_keeps_serving(self):
        self.assertEqual(self.request("GET", "/state", "é"), (401, {"error": "unauthorized"}))
        self.assertEqual(self.request("GET", "/state", TOKENS["ui_token"])[0], 200)


class StartupModesTest(unittest.TestCase):
    def test_main_sets_private_umask_before_startup(self):
        with mock.patch.object(agentd_main.os, "umask") as umask, \
                mock.patch.object(agentd_main.sys, "stderr", io.StringIO()), \
                mock.patch.object(agentd_main, "parse_args", side_effect=InterruptedError):
            with self.assertRaises(InterruptedError):
                agentd_main.main()
            umask.assert_called_once_with(0o077)

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_startup_tightens_existing_modes_without_following_symlinks(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[3]) as root:
            root = Path(root)
            state = root / "state"
            state.mkdir(mode=0o755)
            subdir = state / "nested"
            subdir.mkdir(mode=0o755)
            state.chmod(0o755)
            subdir.chmod(0o755)
            inside, outside = subdir / "data.jsonl", root / "outside"
            inside.write_text("fixture", encoding="utf-8")
            outside.write_text("fixture", encoding="utf-8")
            inside.chmod(0o644)
            outside.chmod(0o644)
            link = state / "link"
            link.symlink_to(outside)
            dir_link = state / "directory-link"
            dir_link.symlink_to(root, target_is_directory=True)
            links = [path.lstat().st_mode for path in (link, dir_link)]
            args = SimpleNamespace(state_dir=str(state), interaction_preset="balanced", plugin_on=[], plugin_off=[])
            with mock.patch.object(agentd_main.os, "umask"), \
                    mock.patch.object(agentd_main.sys, "stderr", io.StringIO()), \
                    mock.patch.object(agentd_main, "parse_args", return_value=args), \
                    mock.patch.object(agentd_main, "write_secret"), \
                    mock.patch.object(agentd_main, "read_token", side_effect=InterruptedError):
                with self.assertRaises(InterruptedError):
                    agentd_main.main()
            self.assertEqual(stat.S_IMODE(inside.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(subdir.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o644)
            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o700)
            self.assertEqual([path.lstat().st_mode for path in (link, dir_link)], links)


if __name__ == "__main__":
    unittest.main()
