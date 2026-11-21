import ast
import importlib
import inspect
import textwrap
import unittest

import support

from api.handler import Handler  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from route_registry import REGISTRY, SERVER  # noqa: E402

HOOK, UI = "hook-token", "ui-token"
# Handler methods the old do_* if-chains called; each must still be reached from a route's action.
CHAIN_METHODS = {
    "_episode_evidence", "_episodes_day", "_summary_runs",
    "_character_state_history", "_speech", "_attention_summary", "_sessions_list", "_history", "_memory_read",
    "_trace_read", "_diag_stream", "_session_lines", "_sse", "_reset", "_voice_reset", "_models_post",
    "_decision", "_speech_cancel", "_speech_playback", "_turn_cancel", "_feedback",
    "_character", "_switch", "_blacklist_add", "_blacklist_defaults", "_behavior_receipt", "_attention_beat",
    "_attention_events", "_browser", "_context_text", "_context_image", "_sessions_post", "_trace_events",
    "_memory_post", "_task_review", "_commitment_action", "_idempotent", "_say", "_hook", "_observation_put",
    "_activity_put", "_capabilities_put", "_switches_put", "_avatar_put", "_state_switch_put", "_memory_body",
    "_episode_edit", "_episode_delete",
    "_context_item_delete", "_memory_delete", "_observation_delete", "_blacklist_remove",
}


def self_calls(name):
    """Names of the self.<name>(...) calls in one Handler method's body."""
    tree = ast.parse(textwrap.dedent(inspect.getsource(getattr(Handler, name))))
    return {n.func.attr for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
            and isinstance(n.func.value, ast.Name) and n.func.value.id == "self"}


class RouteDispatchTest(unittest.TestCase):
    def test_every_route_owner_resolves(self):
        for route in REGISTRY:
            with self.subTest(method=route.method, path=str(route.path), owner=route.owner):
                if route.owner == SERVER:
                    self.assertTrue(callable(getattr(Handler, route.action, None)), route.action)
                else:
                    self.assertIsNone(route.action)
                    self.assertTrue(callable(getattr(importlib.import_module(route.owner), "route", None)))

    def test_no_chain_method_is_left_unreachable(self):
        actions = {route.action for route in REGISTRY if route.owner == SERVER}
        reached = set(actions)
        for name in actions | {"_dispatch", "_post"}:
            reached |= self_calls(name)
        self.assertEqual(sorted(CHAIN_METHODS - reached), [])


class OwnerDeclinesTest(unittest.TestCase):
    """The registry's /task-understanding/<id>/correct accepts 129-132 character ids the owner's route() does not."""
    request = support.request
    path = "/task-understanding/" + "a" * 129 + "/correct"

    def setUp(self):
        support.enable_plugins(self, "screen_awareness")
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
        self.thread = support.serve_in_thread(self.server)
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def test_declined_path_answers_not_found(self):
        self.assertEqual(self.request("POST", self.path, {"revision": 1}), (404, {"error": "not_found"}))

    def test_declined_path_answers_resetting_while_resetting(self):
        self.server.resetting = True
        self.assertEqual(self.request("POST", self.path, {"revision": 1}), (503, {"error": "resetting"}))


if __name__ == "__main__":
    unittest.main()
