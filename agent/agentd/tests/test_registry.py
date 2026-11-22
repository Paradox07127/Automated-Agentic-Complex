from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sessions.events import normalize_claude, normalize_codex  # noqa: E402
from sessions.registry import INTENTS, Registry, STATES, own_app_wait  # noqa: E402
from observation.spatial import Consumed  # noqa: E402

A = ("claude", "A")
B = ("codex", "B")


def claude(name, ts, session="A", **extra):
    return normalize_claude({"hook_event_name": name, "session_id": session, "cwd": "/a", **extra}, now=ts)


def codex(name, ts, session="B", **extra):
    return normalize_codex({"hook_event_name": name, "session_id": session, "cwd": "/b", **extra}, now=ts)


class MultiSessionTest(unittest.TestCase):
    def test_interleaved_sessions_keep_separate_identity(self):
        reg = Registry(epoch=1)
        reg.ingest(claude("SessionStart", 0.0))
        reg.ingest(claude("UserPromptSubmit", 0.1))
        self.assertEqual(reg.focus(0.1)["display_session"], "claude:A")

        # A second session starting must not cancel the first.
        reg.ingest(codex("SessionStart", 1.0))
        reg.ingest(codex("UserPromptSubmit", 1.1))
        self.assertEqual(reg.sessions[A].state, "thinking")
        self.assertEqual(reg.sessions[B].state, "thinking")
        self.assertEqual(reg.focus(1.1)["display_session"], "claude:A")

        reg.ingest(codex("PreToolUse", 2.0, tool_name="Bash"))
        focus = reg.focus(2.0)
        self.assertEqual((focus["display_session"], focus["state"], focus["tool_category"]),
                         ("codex:B", "running_tool", "command"))
        self.assertEqual(reg.sessions[A].state, "thinking")

        approval = claude("PermissionRequest", 3.0, tool_name="Write")
        approval.request_id = "r1"
        reg.ingest(approval)
        self.assertEqual(reg.focus(3.0)["state"], "awaiting_approval")
        self.assertEqual(reg.focus(3.0)["display_session"], "claude:A")
        reg.approval_resolved(A, "r1", "allow", now=3.5)
        self.assertEqual(reg.sessions[A].state, "running_tool")

        reg.ingest(claude("Stop", 4.0))
        self.assertEqual(reg.sessions[A].state, "done")
        self.assertEqual(reg.sessions[B].state, "running_tool")
        self.assertEqual([o["kind"] for o in reg.sessions[A].outcomes], ["done"])
        self.assertEqual(reg.outcomes[-1]["display_session"], "claude:A")
        self.assertEqual(reg.focus(4.0)["display_session"], "codex:B")

        trail = [(i["display_session"], i["state"]) for i in reg.intents]
        self.assertEqual(trail, [("claude:A", "idle"), ("claude:A", "thinking"),
                                 ("codex:B", "running_tool"), ("claude:A", "awaiting_approval"),
                                 ("claude:A", "running_tool"), ("codex:B", "running_tool")])
        self.assertEqual(reg.intents[-1]["intent"], "explain")
        self.assertEqual(reg.intents[-1]["epoch"], 1)

        # B fails on its own; A's earlier completion stays recorded.
        reg.ingest(claude("StopFailure", 5.0, session="C", error="api"))
        reg.ingest(codex("Stop", 5.1))
        kinds = [(o["display_session"], o["kind"]) for o in reg.outcomes]
        self.assertEqual(kinds, [("claude:A", "done"), ("claude:C", "error"), ("codex:B", "done")])
        self.assertEqual(reg.focus(5.1)["state"], "error")

    def test_external_sessions_can_only_be_observed_and_navigated(self):
        # Hooks give no way to resume, fork or drive an external session.
        registry = Registry()
        registry.ingest(claude("SessionStart", 1.0, session="A"))
        registry.ingest(claude("SessionStart", 1.0, session="T", agentd_origin={"kind": "terminal",
                                                                                   "tty": "/dev/ttys003"}))
        registry.ingest(claude("SessionStart", 1.0, session="U", agentd_origin={"kind": "unknown"}))
        caps = {s["session_id"]: s["capabilities"] for s in registry.snapshot(now=2.0)["sessions"]}
        self.assertEqual(caps, {"A": ["observe"], "T": ["observe", "navigate"], "U": ["observe"]})

    def test_priority_order(self):
        reg = Registry()
        reg.ingest(codex("PreCompact", 0.0, session="c1"))
        reg.ingest(codex("UserPromptSubmit", 0.0, session="t1"))
        self.assertEqual(reg.focus(0.0)["display_session"], "codex:t1")
        for i in range(3):
            reg.ingest(claude("PostToolUseFailure", 0.1 + i, session="e1", tool_name="Bash"))
        self.assertEqual(reg.focus(2.1)["state"], "error")
        reg.ingest(claude("Notification", 2.2, session="i1", notification_type="idle_prompt"))
        self.assertEqual(reg.focus(2.2)["state"], "awaiting_input")
        reg.ingest(claude("PermissionRequest", 2.3, session="a1", tool_name="Bash"))
        self.assertEqual(reg.focus(2.3)["state"], "awaiting_approval")

    def test_a_background_role_run_yields_to_a_wait_and_a_done(self):
        reg = Registry(clock=lambda: 0.0)
        reg.set_role_focus({"display_session": "role:bg", "state": "background", "priority": STATES.index("background"),
                            "tool_name": None, "tool_category": None, "expires_at": None}, generation=1)
        self.assertEqual((reg.focus(0.0)["state"], reg.intents[-1]["intent"]), ("background", "think"))
        reg.ingest(claude("PermissionRequest", 0.0, tool_name="Bash"))
        self.assertEqual(reg.focus(0.0)["state"], "awaiting_approval")
        reg.ingest(claude("Stop", 0.1))
        self.assertEqual(reg.focus(0.1)["state"], "done")
        reg.tick(5.0)
        self.assertEqual(reg.focus(5.0)["display_session"], "role:bg")
        reg.ingest(claude("UserPromptSubmit", 6.0))
        reg.tick(1000.0)
        self.assertEqual(reg.sessions[A].state, "stale")
        self.assertEqual(reg.focus(1000.0)["display_session"], "role:bg")

    def test_subagent_marker_does_not_take_main_state(self):
        reg = Registry()
        reg.ingest(claude("UserPromptSubmit", 0.0))
        reg.ingest(claude("PreToolUse", 0.2, agent_id="x", tool_name="Grep"))
        session = reg.sessions[A]
        self.assertEqual(session.state, "thinking")
        self.assertEqual(session.subagents["x"]["state"], "running_tool")
        reg.ingest(claude("Stop", 1.0))
        self.assertEqual(reg.focus(1.0)["state"], "subagent")
        reg.ingest(claude("SubagentStop", 2.0, agent_id="x"))
        self.assertEqual(session.subagents, {})
        self.assertEqual(session.outcomes[-1]["kind"], "subagent_done")


class ToolTargetTest(unittest.TestCase):
    def test_current_target_clears_between_tools_and_the_last_one_stays(self):
        reg = Registry(coalesce=0)
        reg.ingest(claude("UserPromptSubmit", 0.0))
        self.assertEqual({k: reg.snapshot(0.0)["sessions"][0][k] for k in ("tool_target", "last_tool_name",
                                                                          "last_tool_target")},
                         {"tool_target": None, "last_tool_name": None, "last_tool_target": None})
        reg.ingest(claude("PreToolUse", 1.0, tool_name="Edit", tool_input={"file_path": "/w/HostLink.swift"}))
        row = reg.snapshot(1.0)["sessions"][0]
        self.assertEqual((row["tool_name"], row["tool_target"], row["last_tool_name"], row["last_tool_target"]),
                         ("Edit", "HostLink.swift", "Edit", "HostLink.swift"))
        reg.ingest(claude("PostToolUse", 2.0, tool_name="Edit", tool_input={"file_path": "/w/HostLink.swift"}))
        row = reg.snapshot(2.0)["sessions"][0]
        self.assertEqual((row["state"], row["tool_name"], row["tool_target"], row["last_tool_name"],
                          row["last_tool_target"]), ("thinking", None, None, "Edit", "HostLink.swift"))

    def test_an_allowed_approval_keeps_its_target(self):
        reg = Registry()
        event = claude("PermissionRequest", 1.0, tool_name="Bash", tool_input={"command": "swift test"})
        event.request_id = "r1"
        reg.ingest(event)
        reg.approval_resolved(A, "r1", "allow", now=2.0)
        row = reg.snapshot(2.0)["sessions"][0]
        self.assertEqual((row["state"], row["tool_name"], row["tool_target"]), ("running_tool", "Bash", "swift"))


class CoalesceTest(unittest.TestCase):
    def test_tool_storm_within_300ms_is_merged(self):
        reg = Registry()
        reg.ingest(claude("UserPromptSubmit", 0.0))
        reg.ingest(claude("PreToolUse", 1.0, tool_name="Read"))
        reg.ingest(claude("PostToolUse", 1.05, tool_name="Read"))
        reg.ingest(claude("PreToolUse", 1.1, tool_name="Grep"))
        reg.ingest(claude("PostToolUse", 1.2, tool_name="Grep"))
        reg.ingest(claude("PreToolUse", 1.25, tool_name="Edit"))
        session = reg.sessions[A]
        self.assertEqual((session.state, session.tool_name), ("running_tool", "Read"))
        self.assertEqual(session.coalesced, 4)
        reg.tick(1.29)
        self.assertEqual(session.tool_name, "Read")
        reg.tick(1.31)
        self.assertEqual((session.state, session.tool_name, session.tool_category),
                         ("running_tool", "Edit", "write"))
        reg.ingest(claude("PostToolUse", 2.0, tool_name="Edit"))
        self.assertEqual(session.state, "thinking")
        tools = [i["tool_category"] for i in reg.intents if i["state"] == "running_tool"]
        self.assertEqual(tools, ["read", "write"])

    def test_sessions_coalesce_independently(self):
        reg = Registry()
        reg.ingest(claude("PreToolUse", 1.0, tool_name="Read"))
        reg.ingest(codex("PreToolUse", 1.1, tool_name="Bash"))
        self.assertEqual(reg.sessions[B].tool_name, "Bash")

    def test_non_tool_event_drops_pending_tool(self):
        reg = Registry()
        reg.ingest(claude("PreToolUse", 1.0, tool_name="Read"))
        reg.ingest(claude("PostToolUse", 1.1, tool_name="Read"))
        reg.ingest(claude("Stop", 1.2))
        reg.tick(2.0)
        self.assertEqual(reg.sessions[A].state, "done")


class TtlTest(unittest.TestCase):
    def test_states_expire_and_idle_sessions_are_removed(self):
        reg = Registry(ttl={"running_tool": 10.0}, session_ttl=60.0)
        reg.ingest(claude("Stop", 0.0))
        reg.tick(3.9)
        self.assertEqual(reg.sessions[A].state, "done")
        reg.tick(4.0)
        self.assertEqual(reg.sessions[A].state, "idle")

        reg.ingest(codex("PreToolUse", 0.0, tool_name="Bash"))
        reg.tick(9.9)
        self.assertEqual(reg.sessions[B].state, "running_tool")
        reg.tick(10.0)
        self.assertEqual(reg.sessions[B].state, "stale")

        reg.tick(60.0)
        self.assertEqual(reg.sessions, {})
        self.assertEqual([o["kind"] for o in reg.outcomes], ["done", "expired", "expired"])
        self.assertIsNone(reg.focus(60.0)["display_session"])

    def test_lost_observation_is_stale_with_the_last_event_time(self):
        # No hook for 180 s while a tool runs means agentd lost sight of it, not that it went idle.
        reg = Registry()
        reg.ingest(claude("UserPromptSubmit", 0.0))
        reg.ingest(claude("PreToolUse", 5.0, tool_name="Bash"))
        reg.tick(184.9)
        self.assertEqual(reg.sessions[A].state, "running_tool")
        reg.tick(185.0)
        [session] = reg.snapshot(185.0)["sessions"]
        self.assertEqual((session["state"], session["observed_at"], session["expires_at"]), ("stale", 5.0, None))
        self.assertEqual(reg.intents[-1]["intent"], "idle")
        reg.ingest(claude("PostToolUse", 190.0, tool_name="Bash"))
        self.assertEqual(reg.sessions[A].state, "thinking")

    def test_stale_parent_with_a_live_subagent_shows_the_subagent(self):
        reg = Registry()
        reg.ingest(claude("UserPromptSubmit", 0.0))
        reg.ingest(claude("PreToolUse", 590.0, tool_name="Bash", agent_id="sub1"))
        reg.tick(600.0)
        self.assertEqual((reg.sessions[A].state, reg.sessions[A].effective_state), ("stale", "subagent"))

    def test_waits_and_endings_still_expire_to_idle(self):
        reg = Registry()
        reg.ingest(claude("Notification", 0.0, notification_type="idle_prompt"))
        reg.ingest(codex("Stop", 0.0))
        reg.tick(600.0)
        self.assertEqual((reg.sessions[A].state, reg.sessions[B].state), ("idle", "idle"))

    def test_a_notification_keeps_an_approval_wait_without_changing_it(self):
        # Claude Code repeats its Notification hook while its own permission dialog stays open.
        reg = Registry()
        reg.ingest(claude("PermissionRequest", 0.0, tool_name="Bash", tool_input={"command": "make"}))
        reg.ingest(claude("Notification", 100.0, notification_type="permission_prompt"))
        reg.tick(200.0)
        [session] = reg.snapshot(200.0)["sessions"]
        self.assertEqual((session["state"], session["since"], session["tool_name"], session["expires_at"]),
                         ("awaiting_approval", 0.0, "Bash", 220.0))
        reg.tick(220.0)
        self.assertEqual(reg.sessions[A].state, "stale")

    def test_a_notification_does_not_extend_other_states(self):
        reg = Registry()
        reg.ingest(claude("UserPromptSubmit", 0.0))
        reg.ingest(claude("Notification", 500.0, notification_type="permission_prompt"))
        reg.tick(600.0)
        self.assertEqual(reg.sessions[A].state, "stale")

    def test_session_end_cleans_up(self):
        reg = Registry()
        reg.ingest(claude("UserPromptSubmit", 0.0))
        reg.ingest(codex("UserPromptSubmit", 0.0))
        reg.ingest(claude("SessionEnd", 1.0, reason="exit"))
        self.assertNotIn(A, reg.sessions)
        self.assertIn(B, reg.sessions)
        self.assertEqual(reg.focus(1.0)["display_session"], "codex:B")
        self.assertEqual(reg.outcomes[-1]["kind"], "ended")

    def test_compact_restores_previous_state(self):
        reg = Registry()
        reg.ingest(claude("UserPromptSubmit", 0.0))
        reg.ingest(claude("PreCompact", 1.0, trigger="auto"))
        self.assertEqual(reg.sessions[A].state, "compacting")
        reg.ingest(claude("PostCompact", 2.0))
        self.assertEqual(reg.sessions[A].state, "thinking")


class LateAndReplayTest(unittest.TestCase):
    def test_tool_end_after_stop_of_same_turn_keeps_done(self):
        reg = Registry()
        reg.ingest(claude("UserPromptSubmit", 0.0, prompt_id="T"))
        reg.ingest(claude("PreToolUse", 0.5, tool_name="Bash", prompt_id="T"))
        reg.ingest(claude("Stop", 1.0, prompt_id="T"))
        reg.ingest(claude("PostToolUse", 2.0, tool_name="Bash", prompt_id="T"))
        session = reg.sessions[A]
        self.assertEqual(session.state, "done")
        self.assertEqual(session.last_event, 2.0)
        reg.tick(5.0)
        self.assertEqual(session.state, "idle")

    def test_a_tool_end_that_arrives_before_its_start_ends_in_thinking(self):
        """Async hooks: each event carries its forwarder's start time and arrives in any order."""
        reg = Registry()
        reg.ingest(claude("UserPromptSubmit", 1.0, agentd_started_at=0.9))
        reg.ingest(claude("PostToolUse", 3.0, tool_name="Bash", agentd_started_at=2.0))
        reg.ingest(claude("PreToolUse", 3.1, tool_name="Bash", agentd_started_at=1.5))
        reg.tick(4.0)
        session = reg.sessions[A]
        self.assertEqual((session.state, session.since, session.last_event), ("thinking", 2.0, 2.0))

    def test_retired_approval_returns_to_thinking(self):
        reg = Registry()
        for request_id in ("r1", "r2"):
            approval = claude("PermissionRequest", 1.0, tool_name="Bash")
            approval.request_id = request_id
            reg.ingest(approval)
        reg.approval_resolved(A, "r1", "retired", now=1.5)
        self.assertEqual(reg.sessions[A].state, "awaiting_approval")
        reg.approval_resolved(A, "r2", "retired", now=1.6)
        self.assertEqual(reg.sessions[A].state, "thinking")

    def test_replayed_stop_is_dropped(self):
        reg = Registry()
        stop = codex("Stop", 1.0, turn_id="T")
        self.assertFalse(reg.is_replay(stop))
        reg.ingest(stop)
        self.assertTrue(reg.is_replay(codex("Stop", 2.0, turn_id="T")))
        self.assertEqual(reg.outcomes[-1], {"display_session": "codex:B", "source": "codex",
                                            "session_id": "B", "kind": "replay_dropped", "ts": 2.0})
        self.assertFalse(reg.is_replay(codex("PostToolUse", 3.0, tool_name="Bash", turn_id="T")))
        self.assertFalse(reg.is_replay(codex("PostToolUse", 3.0, tool_name="Bash", turn_id="T")))

    def test_identical_permission_requests_are_replays_only_after_turn_ends(self):
        reg = Registry()
        ask = dict(tool_name="Bash", tool_input={"command": "ls"}, turn_id="T")
        self.assertFalse(reg.is_replay(codex("PermissionRequest", 1.0, **ask)))
        self.assertFalse(reg.is_replay(codex("PermissionRequest", 1.1, **ask)))
        reg.ingest(codex("Stop", 2.0, turn_id="T"))
        self.assertTrue(reg.is_replay(codex("PermissionRequest", 3.0, **ask)))
        self.assertEqual(reg.outcomes[-1]["kind"], "replay_dropped")


class ToolFailureTest(unittest.TestCase):
    def test_one_failure_records_a_tool_failure_outcome(self):
        reg = Registry()
        reg.ingest(claude("UserPromptSubmit", 0.0))
        reg.ingest(claude("PostToolUseFailure", 1.0, tool_name="Bash", tool_input={"command": "make"}))
        self.assertEqual(list(reg.outcomes), [{"display_session": "claude:A", "source": "claude", "session_id": "A",
                                               "kind": "tool_failure", "ts": 1.0, "tool_name": "Bash",
                                               "tool_category": "command"}])

    def test_three_failures_record_three_tool_failures_and_one_error(self):
        reg = Registry()
        reg.ingest(claude("UserPromptSubmit", 0.0))
        for ts in (1.0, 2.0, 3.0):
            reg.ingest(claude("PostToolUseFailure", ts, tool_name="Bash"))
        self.assertEqual([o["kind"] for o in reg.outcomes], ["tool_failure"] * 3 + ["error"])
        self.assertNotIn("tool_name", reg.outcomes[-1])


class FailedAtTest(unittest.TestCase):
    def test_failure_is_kept_past_the_error_ttl_until_new_work(self):
        reg = Registry()
        reg.ingest(claude("UserPromptSubmit", 0.0))
        self.assertIsNone(reg.snapshot(0.0)["sessions"][0]["failed_at"])
        reg.ingest(claude("StopFailure", 1.0))
        reg.tick(31.0)
        [session] = reg.snapshot(31.0)["sessions"]
        self.assertEqual((session["state"], session["failed_at"]), ("idle", 1.0))
        reg.ingest(claude("UserPromptSubmit", 40.0))
        self.assertIsNone(reg.sessions[A].failed_at)


class StartedAtTest(unittest.TestCase):
    def test_a_turn_start_sets_started_at(self):
        reg = Registry()
        reg.ingest(claude("SessionStart", 0.0))
        self.assertIsNone(reg.snapshot(0.0)["sessions"][0]["started_at"])
        reg.ingest(claude("UserPromptSubmit", 1.0))
        reg.ingest(claude("PreToolUse", 2.0, tool_name="Bash"))
        self.assertEqual(reg.sessions[A].to_dict()["started_at"], 1.0)
        reg.ingest(claude("Stop", 3.0))
        reg.ingest(claude("UserPromptSubmit", 5.0))
        self.assertEqual(reg.sessions[A].to_dict()["started_at"], 5.0)

    def test_three_tool_failures_set_failed_at_and_done_clears_it(self):
        reg = Registry()
        reg.ingest(claude("UserPromptSubmit", 0.0))
        for ts in (1.0, 2.0, 3.0):
            reg.ingest(claude("PostToolUseFailure", ts, tool_name="Bash"))
        self.assertEqual(reg.sessions[A].failed_at, 3.0)
        reg.ingest(claude("Stop", 4.0))
        self.assertEqual((reg.sessions[A].failed_at, reg.sessions[A].completed_at), (None, 4.0))

    def test_a_failed_session_that_ends_is_retired_as_error(self):
        reg = Registry()
        reg.ingest(claude("StopFailure", 1.0))
        reg.ingest(claude("SessionEnd", 2.0, reason="exit"))
        row = reg.desktop_retired[A]
        self.assertEqual((row["effective_state"], row["since"], row["failed_at"]), ("error", 1.0, 1.0))
        reg.tick(1000.0)
        self.assertIn(A, reg.desktop_retired)
        reg.ingest(claude("UserPromptSubmit", 1001.0))
        self.assertNotIn(A, reg.desktop_retired)


class UnityIntentFieldsTest(unittest.TestCase):
    # The renderer picks the body action by an intent's state and falls back to its intent.
    def test_every_intent_carries_a_known_state(self):
        reg = Registry()
        reg.set_role_focus({"display_session": "role:bg", "state": "background", "priority": STATES.index("background"),
                            "tool_name": None, "tool_category": None, "expires_at": None}, generation=0)
        reg.set_role_focus(None, generation=0)
        reg.ingest(claude("UserPromptSubmit", 0.0))
        reg.ingest(claude("PreCompact", 0.5))
        reg.ingest(claude("PostCompact", 0.6))
        reg.ingest(claude("PreToolUse", 1.0, tool_name="Bash"))
        reg.tick(1.5)
        approval = claude("PermissionRequest", 2.0, tool_name="Write")
        approval.request_id = "r1"
        reg.ingest(approval)
        reg.approval_resolved(A, "r1", "allow", now=2.5)
        reg.ingest(claude("Stop", 3.0))
        reg.tick(7.0)
        reg.ingest(claude("Notification", 8.0, notification_type="idle_prompt"))
        reg.ingest(claude("UserPromptSubmit", 9.0))
        reg.ingest(claude("PreToolUse", 9.1, agent_id="x", tool_name="Grep"))
        reg.ingest(claude("Stop", 9.5))
        reg.ingest(claude("SubagentStop", 9.8, agent_id="x"))
        reg.ingest(claude("PreToolUse", 10.0, tool_name="Bash", session="B"))
        reg.tick(200.0)
        for ts in (201.0, 202.0, 203.0):
            reg.ingest(claude("PostToolUseFailure", ts, tool_name="Bash", session="E"))
        intents = reg.intents_since(0)
        for intent in intents:
            self.assertIn(intent.get("state"), STATES, intent)
            self.assertEqual(intent["intent"], INTENTS[intent["state"]], intent)
        self.assertEqual({i["state"] for i in intents}, set(STATES))

    def test_a_tool_switch_resends_the_same_state_and_intent(self):
        reg = Registry()
        reg.ingest(claude("PreToolUse", 1.0, tool_name="Read"))
        reg.tick(1.5)
        reg.ingest(claude("PostToolUse", 2.0, tool_name="Read"))
        reg.ingest(claude("PreToolUse", 2.0, tool_name="Bash"))
        reg.tick(2.5)
        tools = [(i.get("state"), i["intent"], i["tool_category"]) for i in reg.intents if i["tool_category"]]
        self.assertEqual(tools, [("running_tool", "explain", "read"), ("running_tool", "explain", "command")])


class PublishedEventTest(unittest.TestCase):
    def test_an_event_takes_the_next_intent_seq(self):
        reg = Registry(epoch=1)
        reg.set_activity("coding", "calm")
        reg.publish_event("speech_cancelled", {"speech_id": None, "reason": "client_cancel"})
        reg.set_activity("idle", "calm")
        self.assertEqual([i["seq"] for i in reg.intents_since(0)], [1, 2, 3])
        self.assertEqual(reg.intents_since(1)[0], {"seq": 2, "event": "speech_cancelled", "speech_id": None,
                                                   "reason": "client_cancel"})
        self.assertNotIn("event", reg.intents_since(2)[0])


def role_done(run_id, ended, outcome="succeeded", state="done"):
    """A role run's terminal focus as the embodiment projection makes it: its row holds 8 s past the end."""
    return {"display_session": f"role:{run_id}", "state": state, "priority": STATES.index(state), "tool_name": None,
            "tool_category": None, "expires_at": ended + 8, "run_id": run_id, "conversation_id": "c",
            "run_generation": 1, "phase": "completed", "outcome": outcome, "intent_override": "celebrate"}


class OccurrenceTest(unittest.TestCase):
    """Each terminal has one occurrence id across its resends; the next terminal of the session has a new one."""

    def focus_intents(self, reg, state):
        return [i for i in reg.intents_since(0) if "event" not in i and i["state"] == state]

    def test_a_resent_done_keeps_its_id_and_the_next_done_gets_a_new_one(self):
        reg = Registry(epoch=1)
        reg.ingest(claude("UserPromptSubmit", 0.0))
        reg.ingest(claude("Stop", 1.0))
        reg.set_activity("coding", "calm")  # a resend of the same done
        first, again = self.focus_intents(reg, "done")
        self.assertEqual(first["occurrence_id"], again["occurrence_id"])
        self.assertLessEqual(len(first["occurrence_id"].encode()), 64)
        reg.ingest(claude("UserPromptSubmit", 2.0))
        self.assertNotIn("occurrence_id", reg.intents[-1])  # only terminals carry one
        reg.ingest(claude("Stop", 3.0))
        self.assertNotEqual(self.focus_intents(reg, "done")[-1]["occurrence_id"], first["occurrence_id"])

    def test_an_error_has_its_own_id(self):
        reg = Registry(epoch=1)
        reg.ingest(claude("UserPromptSubmit", 0.0))
        reg.ingest(claude("StopFailure", 1.0, error="api"))
        reg.set_activity("coding", "calm")
        first, again = self.focus_intents(reg, "error")
        self.assertEqual(first["occurrence_id"], again["occurrence_id"])

    def test_a_role_run_terminal_keeps_its_id_and_the_next_run_gets_a_new_one(self):
        now = [100.0]
        reg = Registry(epoch=1, clock=lambda: now[0])
        reg.set_role_focus(role_done("r1", 99.0), generation=2)
        reg.set_activity("coding", "calm")
        first, again = self.focus_intents(reg, "done")
        self.assertEqual(first["occurrence_id"], again["occurrence_id"])
        self.assertLessEqual(len(first["occurrence_id"].encode()), 64)
        reg.set_role_focus(role_done("r2", 100.0), generation=2)
        self.assertNotEqual(self.focus_intents(reg, "done")[-1]["occurrence_id"], first["occurrence_id"])
        reg.set_role_focus(role_done("r3", 100.0, outcome="failed", state="error"), generation=2)
        self.assertIn("occurrence_id", self.focus_intents(reg, "error")[-1])


class ConsumedTest(unittest.TestCase):
    """A terminal that arrives while the stage is offstage or quiet is consumed: it never carries its body cue."""

    def setUp(self):
        self.now, self.stage = 100.0, "quiet"
        self.reg = Registry(epoch=1, clock=lambda: self.now)
        self.consumed = Consumed(lambda: self.stage)
        self.reg.consumed = self.consumed
        self.reg.set_quiet(True)

    def leave_quiet(self):
        self.stage = "normal"
        self.reg.set_quiet(False)

    def test_a_done_on_the_quiet_stage_is_consumed_and_not_shown_when_quiet_ends(self):
        self.reg.ingest(claude("UserPromptSubmit", 100.0))
        self.reg.ingest(claude("Stop", 101.0))
        done = self.reg.intents[-1]
        self.assertEqual(done["state"], "done")
        self.assertEqual(self.consumed.ids(), [done["occurrence_id"]])
        self.now = 102.0
        self.leave_quiet()  # within the 4 s it is valid
        again = self.reg.intents[-1]
        self.assertEqual((again["state"], again["quiet"], again["occurrence_id"]),
                         ("done", False, done["occurrence_id"]))
        self.reg.tick(105.0)  # done held 4 s
        self.assertEqual(self.reg.intents[-1]["state"], "idle")
        self.assertEqual(self.consumed.ids(), [done["occurrence_id"]])

    def test_a_role_terminal_on_the_quiet_stage_loses_its_outcome_for_its_whole_row(self):
        self.reg.set_role_focus(role_done("r1", 100.0), generation=2)
        done = self.reg.intents[-1]
        self.assertEqual((done["state"], done["intent"]), ("done", "celebrate"))  # the face and bubble stay
        self.assertNotIn("outcome", done)
        self.assertEqual(self.consumed.ids(), [done["occurrence_id"]])
        self.now = 103.0
        self.leave_quiet()  # the row still holds: 8 s
        again = self.reg.intents[-1]
        self.assertEqual((again["state"], again["occurrence_id"]), ("done", done["occurrence_id"]))
        self.assertNotIn("outcome", again)
        self.now = 108.5
        self.reg.tick()
        self.assertEqual(self.reg.intents[-1]["state"], "idle")
        self.assertFalse([i for i in self.reg.intents if i.get("outcome")])  # shown 0 times

    def test_a_terminal_on_the_normal_stage_keeps_its_outcome(self):
        self.leave_quiet()
        self.reg.set_role_focus(role_done("r1", 100.0), generation=2)
        self.assertEqual(self.reg.intents[-1]["outcome"], "succeeded")
        self.assertEqual(self.consumed.ids(), [])

    def test_the_consumed_list_keeps_the_newest_64(self):
        for n in range(70):
            self.assertTrue(self.consumed.take(f"o-{n}"))
        self.assertEqual(self.consumed.ids(), [f"o-{n}" for n in range(6, 70)])
        self.stage = "normal"
        self.assertTrue(self.consumed.take("o-69"))  # once consumed, never shown
        self.assertFalse(self.consumed.take("o-2"))


class OwnAppWaitTest(unittest.TestCase):
    def test_an_observed_permission_request_waits_in_its_own_app(self):
        reg = Registry(epoch=1)
        reg.ingest(claude("PermissionRequest", 1.0, tool_name="Bash"))
        reg.ingest(codex("PermissionRequest", 1.0, tool_name="Bash"))
        held = claude("PermissionRequest", 1.0, session="C", tool_name="Bash")
        held.request_id = "r1"  # a card Endfield holds the hook for
        reg.ingest(held)
        words = {row["display_session"]: own_app_wait(row) for row in reg.snapshot(1.0)["sessions"]}
        self.assertEqual(words, {"claude:A": "waiting for confirmation in Claude Code",
                                 "codex:B": "waiting for confirmation in Codex", "claude:C": None})

    def test_other_states_are_not_own_app_waits(self):
        reg = Registry(epoch=1)
        reg.ingest(claude("UserPromptSubmit", 1.0))
        self.assertIsNone(own_app_wait(reg.snapshot(1.0)["sessions"][0]))


if __name__ == "__main__":
    unittest.main()
