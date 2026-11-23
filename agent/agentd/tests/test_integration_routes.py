import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character.gate import Gate  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from infra.store import open_store  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from observation.timeline import Timeline  # noqa: E402
from personal.commitments import Commitments  # noqa: E402
from personal.memory import Memory  # noqa: E402
from route_registry import REGISTRY  # noqa: E402
import support  # noqa: E402
from test_route_registry import concretise, pattern_of  # noqa: E402

HOOK, UI, INTEGRATION = "hook-token", support.UI, "integration-token"
OURS = ("integration_token",)


def integration(route):
    return pattern_of(route.path).lstrip("^").startswith("/integration/")


def sample_paths(route):
    return [concretise(t) for t in route.templates] if route.templates else [route.path]


class IntegrationRoutesTest(unittest.TestCase):
    request = support.request

    def setUp(self):
        support.enable_plugins(self, "external_access")
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        db = open_store(self.dir / "agentd.sqlite")
        self.addCleanup(db.close)
        gate = Gate(enabled=True, db=db)
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI, events_token="events-token", gate=gate,
                                   integration_token=INTEGRATION)
        self.server.memory = Memory(db)
        self.server.commitments = Commitments(db)
        self.server.timeline = Timeline(self.dir / "timeline.sqlite",
                                        Blacklist(support.deny_blacklist(self.dir / "blacklist.json")))
        self.addCleanup(self.server.timeline.close)
        thread = support.serve_in_thread(self.server)

        def stop():
            self.server.shutdown()
            self.server.server_close()
            thread.join(2)
        self.addCleanup(stop)

    def call(self, method, path, body=None):
        return self.request(method, path, body, token=INTEGRATION)

    def announced(self):
        return [i["data"] for i in self.server.feed.since(0) if i["event"] == "announce"]

    # token boundaries

    def test_only_the_integration_token_reaches_the_integration_routes(self):
        ours = [r for r in REGISTRY if integration(r)]
        self.assertEqual(len(ours), 6)
        for route in ours:
            self.assertEqual(route.tokens, OURS)
            for path in sample_paths(route):
                for token in (UI, HOOK, "events-token", None):
                    with self.subTest(method=route.method, path=path, token=token):
                        self.assertEqual(self.request(route.method, path, {}, token=token)[0], 401)

    def test_the_integration_token_reaches_no_other_route(self):
        others = [r for r in REGISTRY if r.tokens and not integration(r)]
        self.assertGreater(len(others), 150)
        for route in others:
            for path in sample_paths(route):
                with self.subTest(method=route.method, path=pattern_of(route.path)):
                    self.assertEqual(self.call(route.method, path, {})[0], 401)

    def test_the_integration_token_cannot_decide_its_own_reminder_card(self):
        status, proposed = self.call("POST", "/integration/reminders", {"text": "交周报", "due_at": time.time() + 3600})
        self.assertEqual(status, 202)
        [card] = self.request("GET", "/approvals")[1]["approvals"]
        decision = {"decision": "allow", "generation": card["generation"]}
        self.assertEqual(self.call("POST", f"/approvals/{proposed['request_id']}/decision", decision)[0], 401)
        self.assertEqual(self.call("GET", f"/integration/reminders/{proposed['request_id']}"),
                         (200, {"request_id": proposed["request_id"], "state": "pending", "commitment_id": None}))

    # notify

    def test_notify_hands_the_text_to_her_as_material(self):
        with mock.patch.object(self.server, "claim_line", return_value=True) as claim:
            status, body = self.call("POST", "/integration/notify", {"text": "构建完成，3 个测试失败", "source": "claude-code"})
        self.assertEqual((status, body), (200, {"delivered": "voice"}))
        [(line_id, instruction, recheck), kwargs] = claim.call_args
        self.assertTrue(line_id.startswith("integration-"))
        self.assertIn("not instructions", instruction)
        self.assertNotIn("构建完成", instruction)
        self.assertIn("构建完成，3 个测试失败", kwargs["material"])
        self.assertIn("claude-code", kwargs["material"])
        self.assertTrue(recheck())
        self.assertEqual(self.announced(), [])

    def test_notify_shows_a_card_when_she_cannot_speak(self):
        with mock.patch.object(self.server, "claim_line", return_value=False):
            self.assertEqual(self.call("POST", "/integration/notify", {"text": "构建完成"}),
                             (200, {"delivered": "card", "reason": "busy"}))
        self.server.gate.meeting = True
        with mock.patch.object(self.server, "claim_line") as claim:
            self.assertEqual(self.call("POST", "/integration/notify", {"text": "部署好了", "source": "codex"}),
                             (200, {"delivered": "card", "reason": "meeting"}))
        claim.assert_not_called()
        cards = self.announced()
        self.assertEqual([(c["kind"], c["level"], c["speak"]) for c in cards],
                         [("integration_notice", "P2", False)] * 2)
        self.assertEqual([c["headline"] for c in cards], ["[external] 构建完成", "[codex] 部署好了"])

    def test_notify_checks_its_body(self):
        for body in ({}, {"text": ""}, {"text": "  "}, {"text": 1}, {"text": "x" * 2001}, {"text": "ok", "source": "a b"},
                     {"text": "ok", "source": "x" * 41}, {"text": "ok", "extra": 1}, []):
            with self.subTest(body=body):
                self.assertEqual(self.call("POST", "/integration/notify", body)[0], 400)

    # reminders

    def wait_state(self, request_id, state):
        for _ in range(200):
            status, body = self.call("GET", f"/integration/reminders/{request_id}")
            if body["state"] == state:
                return body
            time.sleep(0.01)
        self.fail(f"{request_id} is {body}")

    def test_a_reminder_is_kept_only_after_the_user_allows_its_card(self):
        due = time.time() + 3600
        status, proposed = self.call("POST", "/integration/reminders", {"text": "交周报", "due_at": due, "source": "codex"})
        self.assertEqual(status, 202)
        self.assertEqual(set(proposed), {"request_id", "state", "expires_in_s"})
        self.assertEqual(proposed["state"], "pending")
        self.assertEqual(self.server.commitments.list(), [])
        [card] = self.request("GET", "/approvals")[1]["approvals"]
        self.assertEqual((card["request_id"], card["source"], card["tool_name"]), (proposed["request_id"], "codex", "reminder"))
        self.assertIn("交周报", card["tool_summary"])
        decision = {"decision": "allow", "generation": card["generation"]}
        self.assertEqual(self.request("POST", f"/approvals/{proposed['request_id']}/decision", decision)[0], 200)
        accepted = self.wait_state(proposed["request_id"], "accepted")
        [kept] = self.server.commitments.list()
        self.assertEqual((kept["id"], kept["text"], kept["due_at"]), (accepted["commitment_id"], "交周报", due))

    def test_a_denied_reminder_is_not_kept(self):
        status, proposed = self.call("POST", "/integration/reminders", {"text": "交周报", "due_at": time.time() + 60})
        [card] = self.request("GET", "/approvals")[1]["approvals"]
        decision = {"decision": "deny", "generation": card["generation"]}
        self.assertEqual(self.request("POST", f"/approvals/{proposed['request_id']}/decision", decision)[0], 200)
        self.assertEqual(self.wait_state(proposed["request_id"], "declined")["commitment_id"], None)
        self.assertEqual(self.server.commitments.list(), [])

    def test_reminder_bodies_and_unknown_ids(self):
        now = time.time()
        for body in ({"text": "x"}, {"text": "x", "due_at": now - 10}, {"text": "x", "due_at": now + 400 * 86400},
                     {"text": "x", "due_at": True}, {"text": "x", "due_at": "tomorrow"}, {"text": "", "due_at": now + 60},
                     {"text": "x" * 201, "due_at": now + 60}, {"due_at": now + 60}):
            with self.subTest(body=body):
                self.assertEqual(self.call("POST", "/integration/reminders", body)[0], 400)
        self.assertEqual(self.request("GET", "/approvals")[1]["approvals"], [])
        self.assertEqual(self.call("GET", "/integration/reminders/0123456789abcdef")[0], 404)

    # memory

    def test_memory_search_reads_active_facts_only(self):
        memory = self.server.memory
        memory.add("用户喜欢喝乌龙茶", "asserted_by_user", kind="preference")
        memory.add("用户在写周报", "observed_context")
        memory.add("用户喜欢乌龙茶的香气", "inferred_hypothesis", state="candidate")
        status, body = self.call("GET", "/integration/memory?q=" + quote("乌龙茶"))
        self.assertEqual(status, 200)
        self.assertEqual([(f["text"], f["kind"], f["source"]) for f in body["facts"]],
                         [("用户喜欢喝乌龙茶", "preference", "asserted_by_user")])
        self.assertEqual(set(body["facts"][0]), {"text", "kind", "source", "owner", "recorded_at"})
        for query in ("", "?q=", "?q=%20", "?q=x&limit=0", "?q=x&limit=11", "?q=x&limit=a"):
            with self.subTest(query=query):
                self.assertEqual(self.call("GET", "/integration/memory" + query)[0], 400)

    def test_a_proposed_fact_is_a_candidate_from_the_tool(self):
        status, body = self.call("POST", "/integration/memory", {"text": "用户用 zsh", "source": "claude-code"})
        self.assertEqual(status, 201)
        self.assertEqual(body["state"], "candidate")
        [fact] = self.server.memory.candidates()
        self.assertEqual((fact["fact_id"], fact["text"], fact["source"], fact["kind"], fact["evidence"]),
                         (body["fact_id"], "用户用 zsh", "inferred_hypothesis", "fact", ["integration:claude-code"]))
        self.assertEqual(self.server.memory.active(), [])
        self.assertIn(("added", body["fact_id"]),
                      [(i["data"]["action"], i["data"]["fact_id"]) for i in self.server.feed.since(0) if i["event"] == "memory"])

    def test_memory_proposals_respect_pause_rejection_and_kinds(self):
        memory = self.server.memory
        fact_id = memory.add("用户讨厌香菜", "inferred_hypothesis", state="candidate")
        memory.reject(fact_id, expected_version=1)
        self.assertEqual(self.call("POST", "/integration/memory", {"text": "用户讨厌香菜"}),
                         (409, {"error": "rejected_before"}))
        for body in ({"text": "x", "kind": "name"}, {"text": "x", "kind": "agreement"}, {"text": ""}, {"text": "x" * 501}):
            with self.subTest(body=body):
                self.assertEqual(self.call("POST", "/integration/memory", body)[0], 400)
        memory.set_paused(True)
        self.assertEqual(self.call("POST", "/integration/memory", {"text": "用户用 fish"}), (200, {"paused": True}))
        self.assertEqual([f["text"] for f in memory.candidates()], [])

    # timeline

    def record(self, ts, kind="window", app="Code", title="main.py — Endfield", host=None, text=None):
        return {"ts": ts, "kind": kind, "app": app, "bundle_id": None, "pid": 1, "window_id": 1, "window_title": title,
                "url_host": host, "target": {"value": "secret"} if text else None, "keys": "cmd+s" if text else None,
                "text": text, "tree": {"mode": "full", "text": "tree secret"} if text else None}

    def test_timeline_sums_focus_by_app_without_text(self):
        base = (int(time.time()) // 600 - 2) * 600
        self.server.timeline.ingest([
            self.record(base - 300, app="Finder", title="Downloads"),
            self.record(base + 10), self.record(base + 70, kind="text_input", text="password123"),
            self.record(base + 130, app="Safari", title="Docs", host="example.com"),
            self.record(base + 190, title="README.md — Endfield"), self.record(base + 250, kind="click"),
            self.record(base + 700, app="Terminal", title="zsh"),
        ])
        status, body = self.call("GET", f"/integration/timeline?since={base}&until={base + 900}")
        self.assertEqual(status, 200)
        self.assertNotIn("secret", json.dumps(body))
        self.assertNotIn("password123", json.dumps(body))
        self.assertEqual(body["paused"], False)
        # Focus runs from each window record to the next or until, across segments, from the last one before since.
        self.assertEqual(body["segments"], [
            {"start": base, "end": base + 600, "apps": [
                {"app": "Code", "seconds": 530, "titles": ["main.py — Endfield", "README.md — Endfield"], "hosts": []},
                {"app": "Safari", "seconds": 60, "titles": ["Docs"], "hosts": ["example.com"]},
                {"app": "Finder", "seconds": 10, "titles": ["Downloads"], "hosts": []}]},
            {"start": base + 600, "end": base + 1200, "apps": [
                {"app": "Terminal", "seconds": 200, "titles": ["zsh"], "hosts": []},
                {"app": "Code", "seconds": 100, "titles": ["README.md — Endfield"], "hosts": []}]}])

    def test_timeline_query_bounds_and_pause(self):
        now = time.time()
        for query in ("?since=a", f"?since={now}&until={now - 1}", f"?since={now - 25 * 3600}&until={now}",
                      "?since=nan", "?until=inf"):
            with self.subTest(query=query):
                self.assertEqual(self.call("GET", "/integration/timeline" + query)[0], 400)
        self.server.timeline.ingest([self.record(now - 60)])
        self.server.paused_until = self.server.clock() + 60
        status, body = self.call("GET", "/integration/timeline")
        self.assertEqual((status, body["paused"], body["segments"]), (200, True, []))


if __name__ == "__main__":
    unittest.main()
