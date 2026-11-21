from pathlib import Path
import sys
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation.attention import AttentionStore  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from support import deny_blacklist  # noqa: E402
from sessions.events import normalize_claude  # noqa: E402
import test_server  # noqa: E402  (its classes by name here would run their tests in this file too)


class IngestRacesTest(test_server.FeedServerCase):
    """Events and prompts that arrive after a delete, a pause or a revocation they predate."""
    request = test_server.SayTest.request
    hook = test_server.ServerTest.hook

    def setUp(self):
        super().setUp()
        state = Path(self.tmp.name)
        self.now = time.time()
        clock = lambda: self.now  # noqa: E731
        self.server.clock = clock
        self.server.attention = AttentionStore(state / "attention.sqlite", Blacklist(deny_blacklist(state / "blacklist.json")),
                                               clock=clock)
        self.addCleanup(self.server.attention.close)

    def event(self, ago=0.0, **extra):
        return {"ts": self.now - ago, "kind": "value", "app": "Code", "bundle_id": "x.Code", "pid": 1,
                "window": "server.py", "url_host": None, "doc": "/w/server.py", "role": "AXTextArea", "subrole": None,
                "label": "编辑器", "value": "写一半", "value_len": 3, "shrink": 0, "edits": 1, **extra}

    def post(self, *events):
        return self.request("POST", "/context/events", {"events": list(events)}, test_server.UI)

    def stamps(self):
        return [row[0] for row in self.server.attention.db.execute("SELECT ts FROM events_raw ORDER BY ts, id")]

    def test_events_from_before_delete_attention_are_not_stored(self):
        deleted = self.now
        self.assertEqual(self.request("DELETE", "/attention")[0], 200)
        self.now += 3
        self.assertEqual(self.post(self.event(4), self.event(1)), (200, {"stored": 1, "dropped": 1}))
        self.assertEqual(self.stamps(), [deleted + 2])

    def test_events_from_a_cancelled_pause_are_not_stored(self):
        start = self.now
        self.assertEqual(self.request("PUT", "/observation/paused", {"minutes": 1})[0], 200)
        self.now += 20
        self.assertEqual(self.request("PUT", "/observation/paused", {"minutes": 0})[0], 200)
        self.now += 5
        self.assertEqual(self.post(self.event(30), self.event(15), self.event(10), self.event(1)),
                         (200, {"stored": 2, "dropped": 2}))
        self.assertEqual(self.stamps(), [start - 5, start + 24])

    def test_a_forget_during_activity_is_not_undone(self):
        recent, forgot = self.server.attention.recent_events, []

        def racing(*args, **kwargs):
            events = recent(*args, **kwargs)
            if not forgot:
                forgot.append(threading.Thread(target=self.server.forget_user_state))
                forgot[0].start()
                forgot[0].join(0.1)
            return events

        self.server.attention.recent_events = racing
        self.assertIsNotNone(self.server.activity())
        forgot[0].join(2)
        self.assertIsNone(self.server.user_state._current)

    def test_a_prompt_checked_before_a_revocation_keeps_no_text(self):
        self.server.share_typed_text = True
        snapshot = self.server.consent.snapshot

        def revoked_after(*args, **kwargs):
            answer = snapshot(*args, **kwargs)
            self.server.attention.clear_typed_text()
            return answer

        self.server.consent.snapshot = revoked_after
        self.assertEqual(self.hook("claude", "UserPromptSubmit", prompt="帮我看看"), (200, {}))
        self.assertEqual(self.server.attention.db.execute("SELECT kind, value, value_len FROM events_raw").fetchall(),
                         [("prompt", None, 4)])


class SessionReactionTest(test_server.FeedServerCase):
    """A session that ends done or error without becoming the focus intent gets a one-shot session_reaction."""

    def setUp(self):
        super().setUp()
        self.t0 = time.time()
        self.seq = self.server.registry.intent_seq

    def hook(self, name, after, session, **extra):
        self.server.ingest(normalize_claude({"hook_event_name": name, "session_id": session, "cwd": "/w", **extra},
                                            now=self.t0 + after))

    def published(self):
        return self.server.registry.intents_since(self.seq)

    def reactions(self):
        return [i for i in self.published() if i.get("event") == "session_reaction"]

    def test_an_error_behind_an_approval_reacts_and_the_focus_stays(self):
        self.hook("PermissionRequest", 0.0, "A", tool_name="Bash")
        self.hook("UserPromptSubmit", 0.1, "B")
        self.hook("StopFailure", 0.2, "B", error="api")
        self.assertEqual(self.reactions(), [{"seq": self.server.registry.intent_seq, "event": "session_reaction",
                                             "display_session": "claude:B", "state": "error",
                                             "turn_generation": self.server.registry.turn_generation}])
        focus = [i for i in self.published() if "event" not in i][-1]
        self.assertEqual((focus["display_session"], focus["state"]), ("claude:A", "awaiting_approval"))

    def test_quiet_mode_sends_no_reaction(self):
        registry = self.server.registry
        registry.set_role_focus(None, generation=registry.turn_generation, quiet=True)
        self.hook("PermissionRequest", 0.0, "A", tool_name="Bash")
        self.hook("UserPromptSubmit", 0.1, "B")
        self.hook("StopFailure", 0.2, "B", error="api")
        self.assertEqual(self.reactions(), [])

    def test_a_focus_session_finishing_while_another_works_reacts(self):
        self.hook("UserPromptSubmit", 0.0, "A")
        self.hook("UserPromptSubmit", 0.1, "B")
        self.hook("PreToolUse", 0.2, "A", tool_name="Bash")
        self.hook("Stop", 0.3, "A")
        self.assertEqual([(r["display_session"], r["state"]) for r in self.reactions()], [("claude:A", "done")])
        focus = [i for i in self.published() if "event" not in i][-1]
        self.assertEqual((focus["display_session"], focus["state"]), ("claude:B", "thinking"))

    def test_a_focus_intent_of_the_ending_is_no_second_reaction(self):
        self.hook("UserPromptSubmit", 0.0, "A")
        self.hook("Stop", 0.1, "A")
        self.assertEqual([(i["display_session"], i["state"]) for i in self.published() if "event" not in i][-1],
                         ("claude:A", "done"))
        self.assertEqual(self.reactions(), [])


if __name__ == "__main__":
    unittest.main()
