from pathlib import Path
import ast
import io
import json
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import route_registry  # noqa: E402
from route_registry import REGISTRY  # noqa: E402
from api.handler import ROUTES, Handler  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from character.gate import Gate  # noqa: E402
from infra.store import open_store  # noqa: E402
import support  # noqa: E402

AGENTD = Path(__file__).resolve().parents[1]
SNAPSHOT = Path(__file__).resolve().parent / "routes_snapshot.json"
ROUTE_CLASSES = Path(__file__).resolve().parents[3] / "protocol" / "ui-bridge" / "routes.json"
HEX32 = "0123456789abcdef0123456789abcdef"
SAMPLES = {  # one value per template parameter that every pattern using that name accepts
    "request_id": "0123456789ab",
    "session_id": "own:0123456789ab",
    "trace_id": "turn-1",
    "fact_id": "fact-1",
    "type": "view",
    "task_id": "task-1",
    "date": "2026-11-04",
    "commitment_id": "c-1",
    "schedule_id": "schedule-1",
    "episode_id": "42",
    "card_id": "01234567-89ab-cdef-0123-456789abcdef",
    "entry_id": HEX32,
    "conversation_id": HEX32,
    "run_id": "run-1",
    "goal_id": HEX32,
    "job_id": HEX32,
    "interaction_id": HEX32,
    "delivery_id": "delivery-" + HEX32,
    "source_id": "obs-" + HEX32,
    "brief_id": "brief-" + HEX32,
    "item_id": "hyp-1",
    "scope_id": "scope-1",
    "motion_id": "gm-0123456789abcdef",
    "character_id": "aster",
}


def pattern_of(path):
    return path if isinstance(path, str) else path.pattern


def concretise(template):
    return re.sub(r":([a-z_]+)", lambda m: SAMPLES[m.group(1)], template)


def matches(path, value):
    return path == value if isinstance(path, str) else path.fullmatch(value) is not None


def owner_source(owner):
    """The owner module's string literals and bare names."""
    tree = ast.parse((AGENTD / (owner.replace(".", "/") + ".py")).read_text(encoding="utf-8"))
    strings = {n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    return strings, names


class RouteRegistryTest(unittest.TestCase):
    def test_routes_match_snapshot(self):
        snapshot = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
        self.assertEqual([[m, pattern_of(p), list(t)] for m, p, t in ROUTES], snapshot)
        self.assertEqual(ROUTES, tuple((r.method, r.path, r.tokens) for r in REGISTRY))

    def test_template_samples_match_exactly_one_route(self):
        for route in REGISTRY:
            with self.subTest(method=route.method, path=pattern_of(route.path)):
                if isinstance(route.path, str):
                    self.assertEqual(route.templates, ())
                    continue
                self.assertTrue(route.templates)
                for template in route.templates:
                    sample = concretise(template)
                    hits = [r for r in REGISTRY if r.method == route.method and matches(r.path, sample)]
                    self.assertEqual(hits, [route], sample)

    def test_ui_fields_match_routes_json(self):
        entries = json.loads(ROUTE_CLASSES.read_text(encoding="utf-8"))
        listed = {(e["method"], e["path"]): (e["class"], e["surfaces"]) for e in entries}
        ours = {(r.method, pattern_of(r.path)): (r.ui_class, list(r.surfaces)) for r in REGISTRY}
        self.assertEqual(ours, listed)
        self.assertEqual(len(REGISTRY), len(entries))

    def test_owner_source_mentions_route(self):
        constants = {v.pattern: k for k, v in vars(route_registry).items() if isinstance(v, re.Pattern)}
        for route in REGISTRY:
            with self.subTest(method=route.method, path=pattern_of(route.path), owner=route.owner):
                self.assertIsNotNone(route.owner)
                if route.action is not None:
                    self.assertEqual(route.owner, "api.handler")
                    self.assertTrue(hasattr(Handler, route.action), route.action)
                    continue
                strings, names = owner_source(route.owner)
                if isinstance(route.path, str):
                    self.assertTrue(route.path in strings, route.path)
                elif route.path.pattern in constants:
                    self.assertTrue(constants[route.path.pattern] in names, constants[route.path.pattern])
                else:  # an inline pattern: the owner has its own regex literal for every template
                    patterns = [re.compile(v) for v in strings if v.startswith(("/", "^/"))]
                    for template in route.templates:
                        sample = concretise(template)
                        self.assertTrue(any(p.fullmatch(sample) for p in patterns), sample)


class ProactiveRoutesTest(unittest.TestCase):
    def request(self, method, path, body=None, token=support.UI):
        payload = b"" if body is None else json.dumps(body).encode()
        auth = "" if token is None else f"Authorization: Bearer {token}\r\n"
        raw = (f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:48810\r\n{auth}"
               f"Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n\r\n").encode() + payload
        handler = Handler.__new__(Handler)
        handler.server = self.server
        handler.rfile, handler.wfile = io.BytesIO(raw), io.BytesIO()
        handler.handle_one_request()
        headers, response = handler.wfile.getvalue().split(b"\r\n\r\n", 1)
        return int(headers.split()[1]), json.loads(response)

    def test_settings_and_stats_routes(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as tmp:
            db = open_store(Path(tmp) / "agentd.sqlite")
            self.addCleanup(db.close)
            with patch.object(AgentdServer, "server_bind"), patch.object(AgentdServer, "server_activate"):
                self.server = AgentdServer(("127.0.0.1", 48810), "hook-token", support.UI,
                                           events_token="events-token", gate=Gate(enabled=True, db=db))
            self.server.server_port = 48810
            try:
                settings = {"companion_mode": True, "quiet_start": 22, "quiet_end": 8}
                self.assertEqual(self.request("GET", "/proactive/settings"), (200, settings))
                self.assertEqual(self.request("PUT", "/proactive/settings", {"companion_mode": False}),
                                 (200, {**settings, "companion_mode": False}))
                self.assertFalse(self.server.gate.companion)
                self.assertEqual(self.request("PUT", "/proactive/settings", {"companion_mode": True}),
                                 (200, settings))
                self.assertTrue(self.server.gate.companion)
                self.assertEqual(self.request("GET", "/proactive/settings"), (200, settings))
                self.assertEqual(self.request("PUT", "/proactive/settings", {"quiet_start": 23, "quiet_end": 7}),
                                 (200, {**settings, "quiet_start": 23, "quiet_end": 7}))
                self.assertEqual(self.request("PUT", "/proactive/settings", {"quiet_end": 0}),
                                 (200, {**settings, "quiet_start": 23, "quiet_end": 0}))
                self.assertEqual(self.server.gate.quiet, (23, 0))
                for body in ({}, {"companion_mode": "true"}, {"companion_mode": 1},
                             {"companion_mode": False, "extra": True}, [], {"quiet_start": 24},
                             {"quiet_start": -1}, {"quiet_end": True}, {"quiet_end": "7"}, {"quiet_start": 7.0}):
                    self.assertEqual(self.request("PUT", "/proactive/settings", body)[0], 400)
                self.assertEqual(self.request("GET", "/proactive/settings"),
                                 (200, {**settings, "quiet_start": 23, "quiet_end": 0}))
                from character.proactive_log import ProactiveLog
                self.server.proactive_log = ProactiveLog(db)
                now = self.server.clock()
                self.server.proactive_log.shown("old", "line", "comment", None, "old", None, None,
                                                now - 8 * 86400)
                self.server.proactive_log.shown("new", "line", "comment", None, "new", None, None, now)
                counts = {"shown": 1, "replied": 0, "accepted": 0, "feedback": 0}
                self.assertEqual(self.request("GET", "/proactive/stats"), (200, {"comment": counts}))
                self.assertEqual(self.request("GET", "/proactive/stats?days=30"),
                                 (200, {"comment": {**counts, "shown": 2}}))
                self.assertEqual(self.request("GET", "/proactive/stats?days=31"),
                                 self.request("GET", "/proactive/stats?days=30"))
                for days in ("0", "-1", "abc", ""):
                    self.assertEqual(self.request("GET", f"/proactive/stats?days={days}")[0], 400)
                for token in (None, "hook-token", "events-token"):
                    self.assertEqual(self.request("GET", "/proactive/settings", token=token)[0], 401)
                    self.assertEqual(self.request("PUT", "/proactive/settings", {"companion_mode": False},
                                                  token=token)[0], 401)
                    self.assertEqual(self.request("GET", "/proactive/stats", token=token)[0], 401)
            finally:
                self.server.server_close()


if __name__ == "__main__":
    unittest.main()
