"""Tool registry: metadata for every tool a model can be offered. Schemas stay in their family modules; offer() drops a
definition that is unregistered and keeps the rest whatever the mode, so a mode switch leaves the tool list unchanged."""
from dataclasses import dataclass

from tool_gateway.computer_use import DESKTOP_TASK_TOOL, TOOLS as DESKTOP_TOOLS

MODES = ("actions", "embodied_only", "read_only", "background")
# Backends that run with their own file tools and shell in the Workspace: no workspace readers.
BRIDGED = frozenset(("claude", "codex", "acp", "pi"))


@dataclass(frozen=True)
class ToolSpec:
    name: str
    family: str        # knowledge|workspace|task|memory|orchestration|interaction|desktop|embodied
    effect: str        # read|write|external_write|desktop_input|embodied
    grant: str         # one of policy.METHODS
    callers: frozenset  # character|character_side|character_background|own_session
    modes: frozenset   # subset of MODES
    receipt: bool = False  # True: the handler runs inside EffectLedger.effect()


def _family(family, modes, callers, tools):
    return {name: ToolSpec(name, family, effect, grant, frozenset(callers), frozenset(modes), receipt)
            for name, effect, grant, receipt in tools}


_FOREGROUND = ("character",)
_WORK = ("character", "character_background")
BUILTIN = {
    **_family("knowledge", MODES, ("character", "character_side", "character_background"), [
        (name, "read", "none", False) for name in (
            "personal_profile", "knowledge_search", "knowledge_read", "task_context", "behavior_context",
            "observation_status", "observation_search", "observation_read", "observation_changes",
            "observation_image", "observation_refresh")]),
    **_family("desktop", ("actions",), ("character", "own_session"), [
        ("desktop_status", "read", "none", False), ("desktop_observe", "read", "native_panel", False),
        ("desktop_act", "desktop_input", "native_panel", True), ("desktop_verify", "read", "native_panel", False),
        ("desktop_cancel", "write", "none", False)]),
    **_family("desktop", ("actions",), _FOREGROUND, [
        ("desktop_task", "desktop_input", "native_panel", True)]),
    **_family("embodied", ("actions", "embodied_only"), _FOREGROUND, [
        ("avatar_face", "embodied", "none", False), ("avatar_facing_status", "read", "none", False)]),
    **_family("workspace", ("actions", "background"), _WORK, [
        ("workspace_list", "read", "scope", False), ("workspace_read", "read", "scope", False),
        ("workspace_image", "read", "scope", False), ("workspace_search", "read", "scope", False), ("artifact_write", "write", "scope", False),
        ("artifact_read", "read", "scope", False), ("artifact_verify", "read", "scope", False)]),
    **_family("task", ("actions", "background"), _WORK, [
        ("task_plan", "write", "run_actions", False), ("artifact_read_previous", "read", "scope", False)]),
    **_family("memory", ("actions",), _FOREGROUND, [("memory_propose", "write", "run_actions", False)]),
    **_family("orchestration", ("actions",), _FOREGROUND, [
        ("schedule_propose", "write", "run_actions", False), ("schedules_list", "read", "none", False),
        ("schedule_update", "write", "card", False), ("dispatch_session", "external_write", "card", False), ("dispatch_status", "read", "none", False),
        ("reminders_list", "read", "none", False), ("reminder_create", "write", "run_actions", False),
        ("reminder_update", "write", "run_actions", False), ("goals_list", "read", "none", False),
        ("goal_create", "write", "run_actions", False), ("goal_update", "write", "run_actions", False),
        ("background_start", "write", "run_actions", False), ("background_status", "read", "none", False),
        ("background_cancel", "write", "run_actions", False), ("task_continue", "write", "run_actions", False)]),
    **_family("interaction", ("actions", "background"), _WORK, [("ask_user", "read", "none", False)]),
}


@dataclass(frozen=True)
class Offer:
    definitions: list
    families: dict
    mode: str
    refused: frozenset  # offered names this mode does not allow

    def family(self, name):
        """None: the name was not offered to this run."""
        return self.families.get(name)

    def refusal(self, name):
        """The tool error for an offered name outside this run's mode; None when the mode allows it."""
        if name not in self.refused: return None
        return {"error": {"code": "tool_not_allowed_in_mode", "mode": self.mode,
                          "message": f"{name} is not available in this run's {self.mode} mode."}}


class ToolRegistry:
    def offer(self, mode, definitions):
        """Keeps the order of definitions, which feeds the session key."""
        kept = [d for d in definitions if d["name"] in BUILTIN]
        return Offer(kept, {d["name"]: BUILTIN[d["name"]].family for d in kept}, mode,
                     frozenset(d["name"] for d in kept if mode not in BUILTIN[d["name"]].modes))

    def native_definitions(self, *, desktop, desktop_task=False):
        """The desktop and embodied families in model format; desktop only while a Companion bridge exists."""
        from observation.facing_decisions import FACING_TOOL, FACING_STATUS_TOOL
        tools = [{"name": t["name"], "description": t["description"], "input_schema": t["inputSchema"]}
                 for t in DESKTOP_TOOLS] if desktop else []
        return [*tools, *([DESKTOP_TASK_TOOL] if desktop and desktop_task else []), FACING_TOOL, FACING_STATUS_TOOL]

    def mcp_tools(self, caller):
        return [t for t in DESKTOP_TOOLS if caller in BUILTIN[t["name"]].callers]


REGISTRY = ToolRegistry()
