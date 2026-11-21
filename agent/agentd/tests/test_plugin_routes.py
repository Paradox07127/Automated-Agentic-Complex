"""Plug-in checks at the HTTP boundary, including requests that stay available."""
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import support
from api.handler import Handler
from daemon.agentd_server import AgentdServer
from infra import plugins
from observation.blacklist import Blacklist
from observation.capture import CaptureManager


def request(server, method, path, body=None):
    payload = json.dumps(body).encode() if body is not None else b""
    raw = (f"{method} {path} HTTP/1.1\r\nHost: localhost:48810\r\nAuthorization: Bearer {server.ui_token}\r\n"
           f"Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n\r\n").encode() + payload
    handler = Handler.__new__(Handler)
    handler.server = server
    handler.rfile, handler.wfile = io.BytesIO(raw), io.BytesIO()
    handler.handle_one_request()
    headers, response = handler.wfile.getvalue().split(b"\r\n\r\n", 1)
    return int(headers.split()[1]), json.loads(response)


class PluginRoutesTest(unittest.TestCase):
    def setUp(self):
        with patch.object(AgentdServer, "server_bind"), patch.object(AgentdServer, "server_activate"):
            server = AgentdServer(("127.0.0.1", 48810), "hook", support.UI)
        server.server_port = 48810
        self.server = server
        self.addCleanup(server.server_close)

    def test_default_routes(self):
        server = self.server
        for method, path, plugin in (("GET", "/agent/jobs", "personal_agent"),
                                     ("GET", "/observation/briefs", "daily_brief"),
                                     ("POST", "/look", "screen_reading")):
            with self.subTest(path=path):
                self.assertEqual(request(server, method, path), (409, {"error": "plugin_off", "plugin": plugin}))
        self.assertEqual(request(server, "GET", "/health")[0], 200)
        self.assertEqual(request(server, "POST", "/say", {"text": "unmute"}), (200, {"command": "unmute"}))
        server.mouth = object()
        self.assertEqual(request(server, "POST", "/interaction/tap", {}), (200, {"kind": None}))

    def test_screen_selection_cannot_enter_chat_while_reading_is_off(self):
        self.assertEqual(request(self.server, "POST", "/say", {"text": "explain", "quote": {"text": "selection"}}),
                         (409, {"error": "plugin_off", "plugin": "screen_reading"}))

    def test_classic_tap_without_light_ai(self):
        server = self.server
        with patch.dict(plugins.resolved, light_ai=False):
            self.assertEqual(request(server, "POST", "/interaction/tap", {}), (200, {"kind": None}))
            self.assertEqual(request(server, "POST", "/say", {"text": "hi"}),
                             (409, {"error": "plugin_off", "plugin": "light_ai"}))

    def test_one_shot_reply_reaches_chat_without_background_capture(self):
        server = self.server
        with tempfile.TemporaryDirectory() as tmp, patch.dict(plugins.resolved, screen_reading=True):
            server.capture = CaptureManager(server.feed, Blacklist(support.deny_blacklist(Path(tmp) / "blacklist")),
                                            lambda: None, None, share_text=True)
            status, opened = server.look({"window_id": 7})
            self.assertEqual(status, 202)
            body = {"window_id": 7, "app": "Editor", "text": "selected window", "source": "ax"}
            self.assertFalse(request(server, "POST", "/context/text", body)[1]["accepted"])
            status, reply = request(server, "POST", "/context/text", {**body, "request_id": opened["request_id"]})
            self.assertEqual((status, reply), (202, {"accepted": True}))
            self.assertIn("selected window", server._attention_context(look=opened["request_id"]))

    def test_runtime_settings_remain_accessible_for_harness_only(self):
        server = self.server
        with patch.dict(plugins.resolved, light_ai=False, harness_bridge=True):
            self.assertEqual(request(server, "GET", "/character/runtime"),
                             (503, {"error": "character_runtime_unavailable"}))
