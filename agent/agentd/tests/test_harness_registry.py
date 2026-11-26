import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.integration import CharacterAgentController
from character_agent.services.capabilities import describe
from character_agent.services.settings import RuntimeSettings
from support import enable_plugins


SELECTED = {"authenticated": True, "entry_supported": True, "boundary_verified": False}

NATIVE_FEATURES = {
    "domain_tools": {"implemented": True, "reason": None},
    "automatic_memory_observation_proactive": {"implemented": True, "reason": None},
    "observation_briefs": {"implemented": True, "reason": "evidence_bound_daily_weekly_backend"},
    "goal_and_job_interaction": {"implemented": True, "reason": None},
    "persistent_reminder_tools": {"implemented": True, "reason": "explicit_user_instruction_and_versioned_receipts"},
    "embodied_response": {"implemented": True, "reason": "request_and_actor_receipt_separate"},
    "memory_write_and_journal": {"implemented": True, "reason": None},
    "native_shell": {"implemented": True, "enabled": True, "reason": "kernel_own_tools"},
    "clarification_and_approval": {"implemented": True, "enabled": False, "reason": "product_request_inbox"},
    "native_resume": {"implemented": False, "reason": "product_checkpoints_only"},
    "parallel_background_tasks": {"implemented": True, "reason": None},
}

UNKNOWN_FEATURES = {
    "domain_tools": {"implemented": False, "reason": "native_harness_required"},
    "automatic_memory_observation_proactive": {"implemented": False, "reason": "native_harness_required"},
    "observation_briefs": {"implemented": False, "reason": "native_harness_required"},
    "goal_and_job_interaction": {"implemented": False, "reason": "native_harness_required"},
    "persistent_reminder_tools": {"implemented": False, "reason": "explicit_user_instruction_and_versioned_receipts"},
    "embodied_response": {"implemented": False, "reason": "request_and_actor_receipt_separate"},
    "memory_write_and_journal": {"implemented": False, "reason": "native_harness_required"},
    "native_shell": {"implemented": False, "enabled": False, "reason": "kernel_own_tools"},
    "clarification_and_approval": {"implemented": False, "enabled": False, "reason": "product_request_inbox"},
    "native_resume": {"implemented": False, "reason": "product_checkpoints_only"},
    "parallel_background_tasks": {"implemented": False, "reason": "native_harness_required"},
}

# (backend, web_access) -> web_access feature
WEB = {
    ("codex", "off"): {"implemented": False, "enabled": False, "mode": "off", "reason": "unsupported_by_runtime"},
    ("codex", "search"): {"implemented": False, "enabled": False, "mode": "search", "reason": "unsupported_by_runtime"},
    ("pi", "off"): {"implemented": False, "enabled": False, "mode": "off", "reason": "unsupported_by_runtime"},
    ("pi", "search"): {"implemented": False, "enabled": False, "mode": "search", "reason": "unsupported_by_runtime"},
    ("acp_unknown", "off"): {"implemented": False, "enabled": False, "mode": "off", "reason": "unsupported_by_runtime"},
    ("acp_unknown", "search"): {"implemented": False, "enabled": False, "mode": "search", "reason": "unsupported_by_runtime"},
}

COMPUTER_USE_READY = {"implemented": True, "via": "kernel_sub_run"}
COMPUTER_USE_BLOCKED = {"implemented": False, "reason": "computer_route_unavailable"}


def config(backend, web, auth):
    return {"backend": backend, "web_access": web, "auth_source": auth, "interactive_tools": False}


def expected(backend, web, auth, ready, selected):
    base = UNKNOWN_FEATURES if backend == "acp_unknown" else NATIVE_FEATURES
    if backend == "pi":
        base = {**base, "native_shell": {"implemented": True, "enabled": True, "reason": "approval_cards"}}
    features = {"web_access": WEB[(backend, web)], **base,
                "native_computer_use": COMPUTER_USE_READY if ready else COMPUTER_USE_BLOCKED}
    return {"backend": backend, "discovered": selected is not None,
            "authenticated": selected is not None, "entry_supported": selected is not None,
            "boundary_verified": False, "tool_inventory_verified": None, "task_verified": None,
            "features": features}


class DescribeGuardTest(unittest.TestCase):
    def test_describe_output_is_fixed_per_backend(self):
        for backend in ("codex", "pi", "acp_unknown"):
            for web in ("off", "search"):
                for auth, ready in (("api_key", True), ("api_key", False), ("existing_login", True)):
                    for selected in (SELECTED, None):
                        with self.subTest(backend=backend, web=web, auth=auth, ready=ready, selected=selected):
                            actual = describe(config(backend, web, auth), selected, computer_use_ready=ready)
                            self.assertEqual(json.dumps(actual), json.dumps(expected(backend, web, auth, ready, selected)))

    def test_pi_shell_row_says_whether_its_tools_wait_for_a_card(self):
        for setting, reason in ((True, "approval_cards"), (False, "runs_without_approval")):
            with self.subTest(setting=setting):
                actual = describe({"backend": "pi", "auth_source": "api_key", "pi_tool_approval": setting})
                self.assertEqual(actual["features"]["native_shell"], {"implemented": True, "enabled": True, "reason": reason})

    def test_web_access_defaults_off_when_unset(self):
        actual = describe({"backend": "pi", "auth_source": "existing_login"})
        self.assertEqual(actual["features"]["web_access"],
                         {"implemented": False, "enabled": False, "mode": "off", "reason": "unsupported_by_runtime"})
        self.assertEqual(actual["features"]["native_computer_use"], COMPUTER_USE_BLOCKED)


class SessionConfigTests(unittest.TestCase):
    """What _session_factory hands a harness: the Workspace, whether its own tools are on, the approval card."""

    def setUp(self):
        enable_plugins(self, "harness_bridge")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        patcher = mock.patch.object(Path, "home", return_value=self.home)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.approvals = []
        self.controller = SimpleNamespace(session_factory_override=None, state_dir=self.root, python=sys.executable,
            harness_sites={"harness.pi": str(self.root / "pi-site")}, settings=RuntimeSettings(self.root), _model=lambda config: "fixture", server=SimpleNamespace(models=None),
            _selected_runtime=lambda config: {"entry_supported": True, "path": str(self.root / "fixture" / "cli")},
            _pi_connection=lambda config: {"provider": "fixture", "auth_source": "none", "base_url": "http://127.0.0.1:1/v1"},
            _harness_permission=lambda request, source, name: self.approvals.append((request, source, name)) or "allow-once",
            _pi_ready=lambda event: None)

    def session(self, backend, **options):
        values = {"backend": backend} if backend == "pi" else {"backend": backend, "runtime_source": "local"}
        config = {**RuntimeSettings.validate({**self.controller.settings.snapshot(), **values}), "_turn_effort": None}
        return CharacterAgentController._session_factory(self.controller, [], config, **options)

    def test_bridged_sessions_work_in_agentic_complex_when_no_workspace_is_set(self):
        for backend in ("claude", "codex", "pi"):
            with self.subTest(backend=backend):
                wire = self.session(backend).config.wire()
                self.assertEqual(wire["workspace_dir"], str(self.home / "AgenticComplex"))
                self.assertTrue((self.home / "AgenticComplex").is_dir())
                self.assertIs(wire["native_tools"], True)
                for key in ("max_turns", "timeout_seconds", "max_budget_usd"):
                    # Pi keeps its turn and cost caps.
                    (self.assertIn if backend == "pi" and key != "timeout_seconds" else self.assertNotIn)(key, wire)

    def test_sessions_do_not_carry_tool_reminder(self):
        for backend in ("claude", "codex", "pi"):
            with self.subTest(backend=backend):
                self.assertNotIn("tool_reminder", self.session(backend, spoken=True).config.wire())
                self.assertNotIn("tool_reminder", self.session(backend).config.wire())

    def test_bridged_sessions_work_in_the_chosen_workspace(self):
        chosen = self.root / "projects" / "work"
        self.controller.settings.save({"workspace_dir": str(chosen)})
        for backend in ("claude", "codex", "pi"):
            with self.subTest(backend=backend):
                self.assertEqual(self.session(backend).config.wire()["workspace_dir"], str(chosen))
        self.assertTrue(chosen.is_dir())

    def test_sessions_without_native_tools_say_so(self):
        for backend in ("claude", "codex", "pi"):
            with self.subTest(backend=backend):
                self.assertIs(self.session(backend, native_tools=False).config.wire()["native_tools"], False)

    def test_claude_codex_and_pi_permission_requests_go_to_the_approval_card(self):
        request = {"run_id": "run-1", "request_id": "r", "title": "Bash", "options": []}
        for backend, name in (("claude", "Claude Code"), ("codex", "Codex"), ("pi", "Pi")):
            with self.subTest(backend=backend):
                self.assertEqual(self.session(backend).permission_handler(request), "allow-once")
                self.assertEqual(self.approvals[-1], (request, backend, name))

    def test_only_pi_gets_the_cost_cap(self):
        self.controller.settings.save({"max_budget_usd": 2.5})
        wire = self.session("pi").config.wire()
        self.assertEqual(wire["max_budget_usd"], 2.5)
        for backend in ("claude", "codex"):
            with self.subTest(backend=backend):
                self.assertNotIn("max_budget_usd", self.session(backend).config.wire())

    def test_pi_tool_approval_follows_the_setting(self):
        self.assertIs(self.session("pi").config.wire()["tool_approval"], True)
        self.controller.settings.save({"pi_tool_approval": False})
        self.assertIs(self.session("pi").config.wire()["tool_approval"], False)


if __name__ == "__main__":
    unittest.main()
