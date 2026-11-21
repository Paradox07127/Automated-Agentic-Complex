from pathlib import Path
import hashlib
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sessions.approvals import ApprovalBroker  # noqa: E402
from sessions.events import normalize_claude  # noqa: E402
from api.hooks import session_scope  # noqa: E402
from sessions.own import OwnSession, SessionManager  # noqa: E402


def broker(window=0.1):
    return ApprovalBroker(hook_timeout=window + 0.2, margin=0.2)


class ApprovalBrokerTest(unittest.TestCase):
    def test_pending_survives_history_eviction(self):
        b = ApprovalBroker(history=2)
        pending = b.open("claude", "first")
        finished = b.open("claude", "second")
        b.decide(finished.request_id, finished.generation, "allow")
        b.wait(finished.request_id)
        b.open("claude", "third")
        self.assertEqual(b.decide(pending.request_id, pending.generation, "deny"), (True, None))

    def test_deadline_must_be_shorter_than_hook_timeout(self):
        with self.assertRaises(ValueError):
            ApprovalBroker(hook_timeout=5.0, margin=0.0)
        with self.assertRaises(ValueError):
            ApprovalBroker(hook_timeout=5.0, margin=5.0)

    def test_timeout_returns_no_decision(self):
        b = broker()
        request = b.open("claude", "A", "Bash")
        start = time.monotonic()
        self.assertIsNone(b.wait(request.request_id))
        self.assertGreaterEqual(time.monotonic() - start, 0.09)
        self.assertEqual(b.pending(), [])

    def test_open_with_a_window_sets_its_own_deadline(self):
        clock = [100.0]
        b = ApprovalBroker(hook_timeout=10.0, margin=1.0, clock=lambda: clock[0])
        long = b.open("agentd", "d1", "codex", kind="dispatch", window=600.0)
        plain = b.open("claude", "A", "Bash")
        self.assertEqual((long.deadline, plain.deadline), (700.0, 109.0))
        clock[0] = 200.0
        self.assertEqual([r["request_id"] for r in b.pending()], [long.request_id])

    def test_card_reports_its_whole_window(self):
        clock = [100.0]
        b = ApprovalBroker(hook_timeout=10.0, margin=1.0, clock=lambda: clock[0])
        long = b.open("agentd", "d1", "codex", kind="dispatch", window=600.0)
        plain = b.open("claude", "A", "Bash")
        clock[0] = 105.0
        self.assertEqual((long.to_dict(clock[0])["window_s"], plain.to_dict(clock[0])["window_s"]), (600.0, 9.0))

    def test_card_carries_its_wall_clock_creation_time(self):
        b = ApprovalBroker(hook_timeout=10.0, margin=1.0, clock=lambda: 5.0)
        before = time.time()
        b.open("claude", "A", "Bash")
        after = time.time()
        [card] = b.pending()
        self.assertIsInstance(card["created_at"], float)
        self.assertTrue(before <= card["created_at"] <= after)

    def test_stale_decision_cannot_approve_next_request(self):
        b = broker()
        a = b.open("claude", "A", "Bash")
        self.assertIsNone(b.wait(a.request_id))
        c = b.open("claude", "A", "Bash")
        self.assertNotEqual(a.request_id, c.request_id)
        self.assertNotEqual(a.generation, c.generation)

        self.assertEqual(b.decide(a.request_id, a.generation, "allow"), (False, "expired"))
        self.assertEqual(b.decide(a.request_id, c.generation, "allow"), (False, "generation_mismatch"))
        self.assertEqual(b.decide(c.request_id, a.generation, "allow"), (False, "generation_mismatch"))
        self.assertEqual([p["request_id"] for p in b.pending()], [c.request_id])

        self.assertEqual(b.decide(c.request_id, c.generation, "deny"), (True, None))
        self.assertEqual(b.wait(c.request_id), "deny")

    def test_decision_is_one_shot(self):
        b = broker(window=2.0)
        request = b.open("codex", "B", "apply_patch")
        results = []
        waiter = threading.Thread(target=lambda: results.append(b.wait(request.request_id)))
        waiter.start()
        self.assertEqual(b.decide(request.request_id, request.generation, "allow"), (True, None))
        self.assertEqual(b.decide(request.request_id, request.generation, "deny"), (False, "already_decided"))
        waiter.join(2)
        self.assertEqual(results, ["allow"])
        self.assertEqual(b.decide(request.request_id, request.generation, "allow"), (False, "already_decided"))

    def test_only_a_deny_keeps_its_message(self):
        b = broker(window=2.0)
        denied, allowed = b.open("claude", "A", "Bash"), b.open("claude", "A", "Bash")
        self.assertIsNone(denied.message)
        self.assertEqual(b.decide(denied.request_id, denied.generation, "deny", message="wrong dir"), (True, None))
        self.assertEqual(b.decide(allowed.request_id, allowed.generation, "allow", message="ok"), (True, None))
        self.assertEqual((denied.message, allowed.message), ("wrong dir", None))

    def test_mismatched_or_malformed_decisions_rejected(self):
        b = broker(window=2.0)
        request = b.open("claude", "A")
        self.assertEqual(b.decide(request.request_id, request.generation + 1, "allow"),
                         (False, "generation_mismatch"))
        self.assertEqual(b.decide(request.request_id, str(request.generation), "allow"),
                         (False, "generation_mismatch"))
        self.assertEqual(b.decide(request.request_id, True, "allow"), (False, "generation_mismatch"))
        self.assertEqual(b.decide(request.request_id, request.generation, "yes"), (False, "invalid_decision"))
        self.assertEqual(b.decide("ffff", request.generation, "allow"), (False, "unknown_request"))
        self.assertEqual(len(b.pending()), 1)

    def test_pending_card_carries_tool_summary(self):
        b = broker(window=2.0)
        b.open("claude", "A", "Bash", tool_summary="rm -rf build")
        b.open("claude", "B", "Bash")
        self.assertEqual([p["tool_summary"] for p in b.pending()], ["rm -rf build", None])

    def test_card_carries_summary_and_content_metadata(self):
        b = broker(window=2.0)
        for tool, tool_input in (("Bash", {"command": "c" * 5000}),
                                 ("Write", {"file_path": "/w/a", "content": "新" * 500})):
            with self.subTest(tool=tool):
                event = normalize_claude({"session_id": "A", "tool_name": tool, "tool_input": tool_input})
                fields = {key: event.to_dict()[key] for key in (
                    "summary_truncated", "summary_length", "summary_sha256", "content_preview",
                    "content_preview_truncated", "content_preview_length", "content_preview_sha256")}
                request = b.open("claude", "A", tool, tool_summary=event.tool_summary, **fields)
                card = request.to_dict(b.clock())
                self.assertEqual({key: card[key] for key in fields}, fields)
                if tool == "Bash":
                    self.assertTrue(card["summary_truncated"])
                    self.assertEqual(card["summary_length"], 5000)
                    self.assertEqual(card["summary_sha256"], hashlib.sha256(("c" * 5000).encode()).hexdigest())
                    self.assertTrue(card["tool_summary"].endswith("…"))
                else:
                    self.assertEqual(card["content_preview"], "新" * 400)

    def test_card_carries_the_directory_the_tool_runs_in(self):
        b = broker(window=2.0)
        tool = b.open("claude", "A", "Bash", tool_summary="rm -rf build/", cwd="/tmp/x")
        dispatch = b.open("agentd", "d1", "codex", kind="dispatch", dispatch={"cwd": "/repo"})
        now = b.clock()
        self.assertEqual((tool.to_dict(now)["cwd"], dispatch.to_dict(now)["cwd"]), ("/tmp/x", None))

    def test_own_session_card_carries_the_session_cwd(self):
        b = broker(window=2.0)
        with tempfile.TemporaryDirectory() as folder:
            manager = SessionManager(b, lambda _: None, Path(folder), "http://127.0.0.1:1", "hook-token", 10)
            session = OwnSession("claude", "/tmp/proj", "看看")
            asker = threading.Thread(target=manager.ask, args=(session, "Bash", "ls"))
            asker.start()
            deadline = time.monotonic() + 2
            while not b.pending() and time.monotonic() < deadline:
                time.sleep(0.01)
            [card] = b.pending()
            b.decide(card["request_id"], card["generation"], "deny")
            asker.join(2)
        self.assertEqual(card["cwd"], "/tmp/proj")

    def scope(self, command):
        return {"kind": "rule", "detail": f"Bash({command})", "updates": [
            {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": command}], "behavior": "allow",
             "destination": "session"}]}

    def test_dangerous_card_is_marked_and_may_allow_for_the_session(self):
        b = broker(window=2.0)
        risky = b.open("claude", "A", "Bash", tool_summary="git push --force", session_scope=self.scope("git push"))
        [card] = b.pending()
        self.assertEqual((card["dangerous"], card["options"], card["session_scope"]),
                         (True, ["allow", "allow_session", "deny"], {"kind": "rule", "detail": "Bash(git push)"}))
        self.assertEqual(b.decide(risky.request_id, risky.generation, "allow_session"), (True, None))
        self.assertEqual(b.wait(risky.request_id), "allow_session")

    def test_plain_card_with_a_scope_allows_for_the_session(self):
        b = broker(window=2.0)
        plain = b.open("claude", "A", "Bash", tool_summary="git status", session_scope=self.scope("git status"))
        [card] = b.pending()
        self.assertEqual(card["options"], ["allow", "allow_session", "deny"])
        self.assertEqual(card["session_scope"], {"kind": "rule", "detail": "Bash(git status)"})
        self.assertEqual(b.decide(plain.request_id, plain.generation, "allow_session"), (True, None))
        self.assertEqual(b.wait(plain.request_id), "allow_session")

    def test_truncated_cards_allow_only_once(self):
        for field in ("summary_truncated", "content_preview_truncated"):
            with self.subTest(field=field):
                b = broker(window=2.0)
                request = b.open("claude", "A", "Bash", tool_summary="echo safe…",
                                 session_scope=self.scope("echo:*"), **{field: True})
                [card] = b.pending()
                self.assertEqual((card["options"], card["session_scope"]), (["allow", "deny"], None))
                self.assertEqual(b.decide(request.request_id, request.generation, "allow_session"),
                                 (False, "scope_unavailable"))
                self.assertEqual(b.decide(request.request_id, request.generation, "allow"), (True, None))

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_broad_suggestions_offer_no_session_scope(self):
        safe = self.scope("git status")["updates"][0]
        broad = [{"type": "addRules", "rules": [{"toolName": "Read"}], "behavior": "allow"}]
        broad += [{"type": "addRules", "rules": [{"toolName": "Read", "ruleContent": content}],
                   "behavior": "allow"} for content in ("/", "/*", "/**", "~", "~/**", "$HOME", "$HOME/**", "")]
        contents = ("*", "**", ":*", ".", "./**", "//", "//**", "//*", "~/*", "$HOME/*",
                    "${HOME}", "${HOME}/**", "${HOME}/*", f"/{Path.home()}", f"/{Path.home()}/**")
        broad += [{"type": "addRules", "rules": [{"toolName": tool, "ruleContent": content}], "behavior": "allow"}
                  for tool, value in [("Read", content) for content in contents]
                  + [("Bash", "*"), ("Bash", "**"), ("Bash", ":*"), ("Edit", "./**")]
                  for content in (value, f"  {value}  ")]
        broad += [{"type": "addRules", "rules": [{"toolName": "", "ruleContent": "/w/a"}], "behavior": "allow"}]
        broad += [{"type": "addDirectories", "directories": [directory]}
                  for directory in ("/", "/tmp/..", str(Path.home()), str(Path.home()) + "/", "$HOME", "~")]
        for suggestion in broad:
            with self.subTest(suggestion=suggestion):
                event = normalize_claude({"session_id": "A", "permission_suggestions": [safe, suggestion]})
                scope = session_scope(event.suggestions)
                self.assertIsNone(scope)
                b = broker(window=2.0)
                b.open("claude", "A", "Bash", tool_summary="git status", session_scope=scope)
                self.assertEqual(b.pending()[0]["options"], ["allow", "deny"])

    def test_narrow_rules_offer_a_session_scope(self):
        for tool, value in (("Bash", "npm run test:*"), ("Bash", "git status"),
                            ("Read", "~/code/app/**"), ("Read", f"/{Path.home()}/code/**"),
                            ("Edit", "/src/**"), ("Read", "src/*.py")):
            for content in (value, f"  {value}  "):
                with self.subTest(tool=tool, content=content):
                    rule = {"type": "addRules", "rules": [{"toolName": tool, "ruleContent": content}],
                            "behavior": "allow"}
                    event = normalize_claude({"session_id": "A", "permission_suggestions": [rule]})
                    scope = session_scope(event.suggestions)
                    self.assertEqual(scope, {"kind": "rule", "detail": f"{tool}({content})",
                                             "updates": event.suggestions})
                    b = broker(window=2.0)
                    request = b.open("claude", "A", tool, tool_summary="safe", session_scope=scope)
                    self.assertEqual(b.pending()[0]["options"], ["allow", "allow_session", "deny"])
                    self.assertEqual(b.decide(request.request_id, request.generation, "allow_session"), (True, None))

    def test_card_without_a_scope_cannot_allow_for_the_session(self):
        b = broker(window=2.0)
        request = b.open("claude", "A", "Bash", tool_summary="git status")
        [card] = b.pending()
        self.assertEqual((card["options"], card["session_scope"]), (["allow", "deny"], None))
        self.assertEqual(b.decide(request.request_id, request.generation, "allow_session"),
                         (False, "scope_unavailable"))
        self.assertEqual(request.status, "pending")

    def test_session_end_cancels_waiters(self):
        b = broker(window=5.0)
        request = b.open("claude", "A")
        other = b.open("claude", "Z")
        threading.Timer(0.05, b.cancel_session, ("claude", "A")).start()
        start = time.monotonic()
        self.assertIsNone(b.wait(request.request_id))
        self.assertLess(time.monotonic() - start, 2.0)
        self.assertEqual(b.decide(request.request_id, request.generation, "allow"), (False, "cancelled"))
        self.assertEqual([p["request_id"] for p in b.pending()], [other.request_id])

    def test_retire_cancels_the_single_matching_request(self):
        b = broker(window=5.0)
        request = b.open("claude", "A", "Bash", tool_fp="f1")
        other = b.open("claude", "A", "Bash", tool_fp="f2")
        self.assertEqual(b.retire("claude", "A", None, "Bash", "f3"), [])
        self.assertEqual(b.retire("claude", "A", None, "Bash", None), [])
        self.assertEqual(len(b.pending()), 2)
        results = []
        threading.Timer(0.05, lambda: results.append(
            b.retire("claude", "A", None, "Bash", "f1"))).start()
        start = time.monotonic()
        self.assertIsNone(b.wait(request.request_id))
        self.assertLess(time.monotonic() - start, 2.0)
        self.assertEqual(results, [[request.request_id]])
        self.assertEqual(request.status, "cancelled")
        self.assertEqual([p["request_id"] for p in b.pending()], [other.request_id])

    def test_retire_leaves_ambiguous_matches_alone(self):
        b = broker(window=5.0)
        first = b.open("claude", "A", "Bash", tool_fp="f1")
        second = b.open("claude", "A", "Bash", tool_fp="f1")
        self.assertEqual(b.retire("claude", "A", None, "Bash", "f1"), [])
        self.assertEqual((first.status, second.status), ("pending", "pending"))
        self.assertEqual(len(b.pending()), 2)

    def test_cancel_agent_only_cancels_that_agent(self):
        b = broker(window=5.0)
        main = b.open("claude", "A", "Bash")
        x = b.open("claude", "A", "Bash", agent_id="x")
        y = b.open("claude", "A", "Bash", agent_id="y")
        other = b.open("claude", "Z", "Bash")
        self.assertEqual(b.cancel_agent("claude", "A", "x"), [x.request_id])
        self.assertEqual(b.cancel_agent("claude", "A", None), [main.request_id])
        self.assertEqual([p["request_id"] for p in b.pending()], [y.request_id, other.request_id])
        self.assertEqual(b.cancel_session("claude", "Z"), [other.request_id])

    def test_cancel_all_retires_every_pending_card(self):
        b = broker(window=5.0)
        seen = self.recorded(b)
        tool = b.open("claude", "A", "Bash")
        dispatch = b.open("agentd", "d1", "claude", kind="dispatch")
        decided = b.open("claude", "Z", "Bash")
        b.decide(decided.request_id, decided.generation, "allow")
        threading.Timer(0.05, b.cancel_all, kwargs={"reason": "shutdown"}).start()
        self.assertIsNone(b.wait(tool.request_id))
        self.assertEqual((tool.status, dispatch.status, decided.status), ("cancelled", "cancelled", "decided"))
        self.assertEqual(b.pending(), [])
        self.assertEqual([attrs.get("reason") for kind, attrs, _ in seen if kind == "approval.retired"],
                         ["shutdown", "shutdown"])

    def test_abandoned_waiter_returns_without_decision(self):
        b = broker(window=5.0)
        request = b.open("claude", "A", "Bash")
        gone = threading.Event()
        threading.Timer(0.05, gone.set).start()
        start = time.monotonic()
        self.assertIsNone(b.wait(request.request_id, abandoned=gone.is_set))
        self.assertLess(time.monotonic() - start, 0.5)
        self.assertEqual(request.status, "abandoned")
        self.assertEqual(b.pending(), [])

    def recorded(self, b):
        seen = []
        b.on_decision = lambda kind, attrs, key: seen.append((kind, attrs, key))
        return seen

    def test_card_answers_and_retirements_are_reported(self):
        b = broker(window=5.0)
        seen = self.recorded(b)
        card = b.open("claude", "A", "Bash", tool_fp="f1")
        b.decide(card.request_id, card.generation, "deny")
        b.decide(card.request_id, card.generation, "allow")  # refused: no second record
        retired = b.open("claude", "A", "Write", tool_fp="f2")
        b.retire("claude", "A", None, "Write", "f2")
        ended = b.open("claude", "Z", None)
        b.cancel_session("claude", "Z")
        stopped = b.open("claude", "Y", "Bash")
        b.cancel_agent("claude", "Y", None)
        self.assertEqual(seen, [
            ("approval.opened", {"request_id": card.request_id, "tool": "Bash"}, card.request_id),
            ("approval.decided", {"request_id": card.request_id, "tool": "Bash", "decision": "deny", "by": "card"},
             card.request_id),
            ("approval.opened", {"request_id": retired.request_id, "tool": "Write"}, retired.request_id),
            ("approval.retired", {"request_id": retired.request_id, "tool": "Write", "reason": "tool_event"},
             retired.request_id),
            ("approval.opened", {"request_id": ended.request_id, "tool": None}, ended.request_id),
            ("approval.retired", {"request_id": ended.request_id, "tool": None, "reason": "session_ended"},
             ended.request_id),
            ("approval.opened", {"request_id": stopped.request_id, "tool": "Bash"}, stopped.request_id),
            ("approval.retired", {"request_id": stopped.request_id, "tool": "Bash", "reason": "agent_stopped"},
             stopped.request_id)])

    def test_native_answer_and_expiry_are_reported(self):
        b = broker(window=5.0)
        seen = self.recorded(b)
        native = b.open("claude", "A", "Bash")
        self.assertIsNone(b.wait(native.request_id, abandoned=lambda: True))
        b.window = 0.05
        late = b.open("claude", "A", "Bash")
        self.assertIsNone(b.wait(late.request_id))
        self.assertEqual([(kind, attrs.get("by"), attrs.get("decision"), attrs.get("reason"))
                          for kind, attrs, _ in seen],
                         [("approval.opened", None, None, None), ("approval.decided", "native", "deny", None),
                          ("approval.opened", None, None, None), ("approval.retired", None, None, "expired")])

    def test_a_failing_decision_callback_changes_nothing(self):
        b = broker(window=2.0)
        b.on_decision = lambda *_: 1 / 0
        request = b.open("claude", "A", "Bash")
        self.assertEqual(b.decide(request.request_id, request.generation, "allow"), (True, None))
        self.assertEqual(b.wait(request.request_id), "allow")
        self.assertEqual(b.cancel_session("claude", "A"), [])


if __name__ == "__main__":
    unittest.main()
