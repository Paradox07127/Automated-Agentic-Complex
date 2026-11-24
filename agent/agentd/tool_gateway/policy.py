"""ApprovalPolicy: which method gates a tool call, whether it is dangerous, how long the user has to answer and what
revokes the grant. The only module that judges danger (danger.classify)."""
from dataclasses import dataclass

from sessions.danger import classify
from tool_gateway.registry import BUILTIN

METHODS = ("none", "run_actions", "scope", "card", "native_panel", "exact_call", "observe_only")
WINDOWS = {"dispatch": 600.0, "exact_call": 180.0}  # seconds; no hook is blocked on either
# Enforced by the shell (computer-control.ts `CONSENT`); mirrored here so the policy can name them.
# native_control_actions: acts per control grant; native_control_window: seconds.
MIRRORS = {"native_grant_ttl": 600.0, "native_snapshot_ttl": 15.0, "native_wait": 180.0,
           "native_control_actions": 5, "native_control_window": 120.0}
REVOKE_ON = {"native_panel": frozenset({"run_end", "turn_cancelled", "user_cancelled_task", "context_changed",
                                        "scope_revoked", "memory_changed", "history_cleared", "runtime_changed",
                                        "shutdown", "own_delete", "own_interrupt", "own_idle",
                                        "own_stop", "own_turn_end",
                                        "conversation_idle", "conversation_switch"}),
             "exact_call": frozenset({"call_returned", "expired", "run_invalidated", "shutdown"}),
             "card": frozenset({"expired", "tool_event", "agent_stopped", "session_ended", "shutdown", "reset"})}
# verify command a read_only task may store -> the git arguments run for it (sessions.git_state.run)
READ_ONLY_PRESETS = {"git diff --stat": ("diff", "--no-ext-diff", "--stat"), "git status --short": ("status", "--short"),
                     "git log -1 --stat": ("log", "--no-ext-diff", "-1", "--stat")}


@dataclass(frozen=True)
class Verdict:
    method: str  # one of METHODS
    dangerous: bool = False
    rule: str | None = None  # the danger.classify rule that matched
    single_only: bool = False  # True refuses allow_session
    window_s: float | None = None  # how long the request waits for the user
    reason: str = ""  # stable code for the trace


class ApprovalPolicy:
    def hook(self, source, kind, *, observe=False):
        """Codex asks natively; observe-only hooks never hold the source tool for an approval card."""
        if kind != 'permission_request' or source == 'codex' or observe:
            return Verdict('observe_only', reason='external_observation')
        return Verdict('card', reason='permission_request')

    def danger(self, tool, targets):
        """(dangerous, rule) for the first target that is dangerous; (False, None) when none is."""
        for target in targets:
            judged = classify(tool, target)
            if judged["dangerous"]:
                return True, judged["rule"]
        return False, None

    def card(self, kind, tool, targets, *, window):
        """A broker card. A dispatch prompt is text for a model, not a command to run, so it is never judged."""
        dangerous, rule = self.danger(tool, targets) if kind == "tool" else (False, None)
        return Verdict("card", dangerous, rule, window_s=window,
                       reason="dispatch" if kind != "tool" else "dangerous" if dangerous else "ordinary")

    def desktop_elicitation(self, mode, tool_params, native_status):
        """Codex's desktop_act approval form in an own session: the native panel when that session already holds a
        window grant, else a card. tool_params has passed computer_use.validate; native_status is the session's
        desktop_status, None when it was not read."""
        status = native_status or {}
        permissions = status.get("permissions")
        if mode == "workspace_write" and isinstance(tool_params, dict) and status.get("session_granted") is True \
                and isinstance(status.get("paused"), bool) and isinstance(permissions, list) \
                and "observation" in permissions:
            return Verdict("native_panel", reason="window_granted")
        return Verdict("card", reason="no_window_grant")

    def desktop(self, caller, name):
        """A desktop_* call; the Companion panel grants the window, the policy only names the method."""
        if BUILTIN[name].grant == "none":
            return Verdict("none", reason="no_window_access")
        return Verdict("native_panel", reason="companion_grant")

    def verify_command(self, mode, cmd):
        if mode == "read_only":
            return cmd in READ_ONLY_PRESETS
        return bool(cmd) and not self.danger("Bash", (cmd,))[0]

    def window(self, name):
        return WINDOWS[name]


POLICY = ApprovalPolicy()
