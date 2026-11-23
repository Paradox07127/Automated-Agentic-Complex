from collections import Counter
from pathlib import Path
import json
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from infra.plugins import DEFAULTS
from api.handler import ROUTES  # noqa: E402

ROUTE_CLASSES = Path(__file__).resolve().parents[3] / "protocol" / "ui-bridge" / "routes.json"
CLASSES = {"read", "write", "confirm_native", "native_only", "host_only", "hook_only", "integration_only", "stream"}
SURFACES = {"main", "stack", "onboarding"}
CLOSED = {"native_only", "host_only", "hook_only", "integration_only", "stream"}
STACK = {  # The panel's base routes plus quiet, meeting, the task rail stopping runs and jobs, the reminder card's cancel/snooze/complete, the console reading the runtime, the focus session, and the desktop drop card's file scopes and job, the chat window muting a proactive kind, a done session card marked seen, a reminder card marked seen once the bubble shows it, and the tune panel reading and setting the motion source: the only routes the stack panel may send
    ("GET", "/character/runtime"),
    ("GET", "/proactive/mutes"),
    ("POST", "/desktop/sessions/seen"),
    ("PUT", "/proactive/mutes"),
    ("POST", "^/approvals/([0-9a-f]{1,64})/decision$"),
    ("POST", "^/agent/interactions/([a-f0-9]{32})/(answer|dismiss|continue)$"),
    ("POST", "^/commitments/([^/]{1,64})/seen$"),
    ("POST", "^/tasks/([^/]{1,64})/(accept|reject)$"),
    ("POST", "^/agent/tasks/[^/]{1,196}/(accept|reject)$"),
    ("POST", "/feedback"),
    ("POST", "/turn/cancel"),
    ("PUT", "/observation/quiet"),
    ("PUT", "/observation/meeting"),
    ("POST", "^/agent/runs/([A-Za-z0-9_-]{1,128})/cancel$"),
    ("POST", "/agent/jobs"),
    ("POST", "^/agent/jobs/([a-f0-9]{32})/(cancel|resume)$"),
    ("POST", "^/commitments/([^/]{1,64})/(cancel|snooze|complete)$"),
    ("GET", "/focus"),
    ("POST", "/focus"),
    ("DELETE", "/focus"),
    ("GET", "/agent/scopes"),
    ("POST", "/agent/scopes"),
    ("POST", "^/agent/scopes/([^/]{1,128})/revoke$"),
}


def route_key(method, path):
    return method, path if isinstance(path, str) else path.pattern


class UIRouteClassesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.entries = json.loads(ROUTE_CLASSES.read_text(encoding="utf-8"))

    def test_every_route_has_exactly_one_entry(self):
        listed = Counter((entry["method"], entry["path"]) for entry in self.entries)
        self.assertEqual([key for key, n in listed.items() if n > 1], [])
        routes = {route_key(method, path) for method, path, _ in ROUTES}
        self.assertEqual(sorted(routes - listed.keys()), [], "missing from routes.json")
        self.assertEqual(sorted(listed.keys() - routes), [], "not in server.ROUTES")

    def test_fields_and_values(self):
        for entry in self.entries:
            with self.subTest(entry=entry):
                if "plugin" in entry:
                    self.assertIn(entry["plugin"], DEFAULTS)
                self.assertEqual(set(entry) - {"plugin"}, {"method", "path", "class", "surfaces"})
                self.assertIn(entry["class"], CLASSES)
                self.assertIsInstance(entry["surfaces"], list)
                self.assertLessEqual(set(entry["surfaces"]), SURFACES)
                self.assertEqual(len(entry["surfaces"]), len(set(entry["surfaces"])))
                if entry["class"] in CLOSED:
                    self.assertEqual(entry["surfaces"], [])

    def test_stack_reset_and_hook_routes(self):
        by_key = {(entry["method"], entry["path"]): entry for entry in self.entries}
        self.assertEqual(sorted(key for key, entry in by_key.items() if "stack" in entry["surfaces"]), sorted(STACK))
        self.assertEqual(by_key[("POST", "/reset")]["class"], "confirm_native")
        for method, path, tokens in ROUTES:
            if tokens in (("hook_token",), ("integration_token",)):
                with self.subTest(method=method, path=path):
                    self.assertEqual(by_key[route_key(method, path)]["class"], tokens[0].replace("_token", "_only"))


if __name__ == "__main__":
    unittest.main()
