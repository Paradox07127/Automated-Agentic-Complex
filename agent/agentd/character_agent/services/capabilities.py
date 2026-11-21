"""Implementation facts, separate from discovery, login and real-task evidence."""
from character_agent.harness.registry import HARNESSES, harness


def describe(config, selected=None, *, computer_use_ready=False):
    backend = config["backend"]
    native = backend in HARNESSES
    web = native and harness(backend).web_access
    value = {
        "backend": backend,
        "discovered": selected is not None,
        "authenticated": bool(selected and selected.get("authenticated")),
        "entry_supported": bool(selected and selected.get("entry_supported")),
        "boundary_verified": bool(selected and selected.get("boundary_verified")),
        # These are only known after an actual run, not after login/status.
        "tool_inventory_verified": None,
        "task_verified": None,
        "features": {
            "web_access": {"implemented": web,
                "enabled": web and config.get("web_access", "off") != "off",
                "mode": config.get("web_access", "off"),
                "reason": None if web else "unsupported_by_runtime"},
            "domain_tools": {"implemented": native, "reason": None if native else "native_harness_required"},
            "automatic_memory_observation_proactive": {"implemented": native, "reason": None if native else "native_harness_required"},
            "observation_briefs": {"implemented": native, "reason": "evidence_bound_daily_weekly_backend" if native else "native_harness_required"},
            "goal_and_job_interaction": {"implemented": native, "reason": None if native else "native_harness_required"},
            "persistent_reminder_tools": {"implemented": native, "reason": "explicit_user_instruction_and_versioned_receipts"},
            "embodied_response": {"implemented": native, "reason": "request_and_actor_receipt_separate"},
            "memory_write_and_journal": {"implemented": native, "reason": None if native else "native_harness_required"},
            # Every kernel runs its own shell and file tools in conversations, with their own MCP servers and Skills.
            "native_shell": {"implemented": native, "enabled": native, "reason": "kernel_own_tools"},
            "clarification_and_approval": {"implemented": native, "enabled": config.get("interactive_tools", True), "reason": "product_request_inbox"},
            "native_resume": {"implemented": False, "reason": "product_checkpoints_only"},
            "parallel_background_tasks": {"implemented": native, "reason": None if native else "native_harness_required"},
            "native_computer_use": {"implemented": True, "via": "kernel_sub_run"} if computer_use_ready
                else {"implemented": False, "reason": "computer_route_unavailable"},
        },
    }
    if backend == "acp":
        # The agent runs its own shell and editing tools; their permission requests go on approval cards.
        value["features"]["native_shell"] = {"implemented": True, "enabled": True, "reason": "approval_cards"}
        value["features"]["builtin_tools"] = {"implemented": True, "verified": False, "reason": "acp_agent_tools_unverified"}
    if backend == "pi":
        # Pi's own shell and file tools in the Workspace; pi_tool_approval puts bash, powershell, write and edit on cards.
        value["features"]["native_shell"] = {"implemented": True, "enabled": True,
            "reason": "approval_cards" if config.get("pi_tool_approval", True) else "runs_without_approval"}
    return value
