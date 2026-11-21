"""ToolGateway: one per CharacterAgentController; holds the policy, the effect ledger, the desktop leases and the
decision reporter."""
from dataclasses import dataclass

from tool_gateway.desktop import DesktopLeases
from tool_gateway.ledger import EffectLedger
from tool_gateway.policy import POLICY
from tool_gateway.registry import REGISTRY


@dataclass(frozen=True)
class SessionKey:
    caller: str
    run_id: str  # a character run id, or "own:<session_id>"
    conversation_id: str | None

    @property
    def native_session(self):
        if self.caller != "character":
            return self.run_id.removeprefix("own:")
        return "character:" + (self.conversation_id or self.run_id)


class ToolSession:
    """One run's hold on the gateway; leaving it ends the run's hold on its desktop lease."""

    def __init__(self, gateway, key):
        self.gateway, self.key = gateway, key

    def __enter__(self):
        self.gateway.desktop.enter(self.key)
        return self

    def __exit__(self, *exc):
        self.gateway.close(self.key.run_id, "run_end")


class ToolGateway:
    def __init__(self, run_store, *, computer_control=lambda: None, egress=lambda: None,
                 report=lambda kind, attrs, key: None):
        """computer_control() and egress() are read at call time; report is ApprovalBroker.report."""
        self.policy, self.ledger, self.report = POLICY, EffectLedger(run_store), report
        self.registry = REGISTRY
        self.computer_control, self.egress = computer_control, egress
        self.desktop = DesktopLeases(computer_control, egress, report)

    def session(self, key):
        return ToolSession(self, key)

    def close(self, run_id, reason):
        return self.desktop.release(run_id, reason)

    def close_all(self, reason):
        self.desktop.release_all(reason)

    def verdict(self, run_id, tool, verdict):
        self.report("tool.verdict", {"tool": tool, "method": verdict.method, "dangerous": verdict.dangerous,
                                     "rule": verdict.rule, "reason": verdict.reason}, run_id)
