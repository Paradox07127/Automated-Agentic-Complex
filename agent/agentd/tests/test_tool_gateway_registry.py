import ast
import io
import json
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.interactions import QuestionTurn  # noqa: E402
from tool_gateway.computer_use import TOOLS  # noqa: E402
import test_character_agent_integration as integration  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
KNOWLEDGE = ['personal_profile', 'knowledge_search', 'knowledge_read', 'task_context', 'behavior_context',
             'observation_status', 'observation_search', 'observation_read', 'observation_changes',
             'observation_image', 'observation_refresh']
# Every kernel reads the selected material with its own tools: no workspace readers.
WORKSPACE = ['artifact_write', 'artifact_read', 'artifact_verify', 'task_plan', 'artifact_read_previous']
DESKTOP = ['desktop_status', 'desktop_observe', 'desktop_act', 'desktop_verify', 'desktop_cancel']
EMBODIED = ['avatar_face', 'avatar_facing_status']
ORCHESTRATION = ['reminders_list', 'reminder_create', 'reminder_update', 'dispatch_session', 'dispatch_status', 'schedule_propose', 'schedules_list', 'goals_list', 'goal_create', 'goal_update',
                 'background_start', 'background_status', 'background_cancel', 'task_continue']
# Names reaching session_factory, in order; the order feeds the runtime session key. The mode does not filter them:
# typing and a gift offer the same tools and the call refuses a name outside the mode.
FOREGROUND = [*KNOWLEDGE, *DESKTOP, *EMBODIED, *WORKSPACE, 'memory_propose', *ORCHESTRATION, 'ask_user']
HEAD = {
    'actions': FOREGROUND,
    'embodied_only': FOREGROUND,
    'read_only': [*KNOWLEDGE, *WORKSPACE],
    'remember_off': [*KNOWLEDGE, *DESKTOP, *EMBODIED, *WORKSPACE, 'memory_propose'],
    'background': [*KNOWLEDGE, *WORKSPACE, 'ask_user'],
}


class RegistryOfferTests(integration.IntegrationFixture):
    def desktop_on(self):
        """A desktop bridge, so the desktop family is offered."""
        self.server.sessions = Mock(computer_control=object(), sessions={}, store=None)

    def prepare(self, line_id, source, *, side=False):
        trace = {'remember': True, 'reset': None, 'history': None}
        return self.controller.prepare(line_id, 'hello', threading.Event(), self.server.turn_generation, source, trace,
                                       side=side)

    def offered(self):
        """Tool names each kind of turn offers, keyed like HEAD."""
        self.desktop_on()
        scope = self.scope_id()
        names = lambda: [d['name'] for d in self.definitions[-1]]
        result = {}
        self.line('整理资料', scope_id=scope); result['actions'] = names()
        self.prepare('gift-1', 'gift'); result['embodied_only'] = names()
        self.prepare('side-1', 'text', side=True); result['read_only'] = names()
        self.line('临时问候', no_memory=True); result['remember_off'] = names()
        job = self.controller.submit_job('核对', '核对资料', '只核对资料', scope)
        deadline = time.monotonic() + 3
        while self.controller.jobs.store.get(job['job_id'])['state'] in ('queued', 'running'):
            if time.monotonic() > deadline: self.fail('background job did not finish')
            time.sleep(.01)
        result['background'] = names()
        self.controller.jobs.close()
        return result

    def test_per_mode_names_match_head(self):
        self.assertEqual(self.offered(), HEAD)

    def test_typing_after_a_gift_keeps_the_kernel_session(self):
        self.line('整理资料')
        self.prepare('gift-1', 'gift')
        self.line('再整理一次')
        self.assertEqual(len(self.definitions), 1)

    def test_every_offered_tool_is_registered(self):
        from tool_gateway.registry import BUILTIN
        for mode, names in self.offered().items():
            with self.subTest(mode):
                self.assertEqual([n for n in names if n not in BUILTIN], [])

    def test_unregistered_definition_never_reaches_model(self):
        original = QuestionTurn.tool_definitions
        def with_rogue(turn):
            return [*original(turn), {'name': 'rogue_tool', 'description': 'unregistered', 'input_schema': {'type': 'object'}}]
        with patch.object(QuestionTurn, 'tool_definitions', with_rogue):
            self.line('整理资料', scope_id=self.scope_id())
        self.assertNotIn('rogue_tool', [d['name'] for definitions in self.definitions for d in definitions])
        self.assertIn('ask_user', [d['name'] for d in self.definitions[-1]])


class RegistryModeTests(unittest.TestCase):
    def test_offer_keeps_every_mode_and_refuses_names_outside_it(self):
        from tool_gateway.registry import BUILTIN, MODES, REGISTRY
        definitions = [{'name': name} for name in BUILTIN]
        for mode in MODES:
            with self.subTest(mode):
                offer = REGISTRY.offer(mode, definitions)
                self.assertEqual(offer.definitions, definitions)
                self.assertEqual({name for name in BUILTIN if offer.refusal(name)},
                                 {name for name, spec in BUILTIN.items() if mode not in spec.modes})


class FacadeTests(unittest.TestCase):
    def test_facade_lists_registry_tools(self):
        from tool_gateway.registry import REGISTRY
        from tools.computer_use_mcp import serve
        self.assertEqual(REGISTRY.mcp_tools('own_session'), TOOLS)
        output = io.StringIO()
        serve(None, io.BytesIO(b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'), output)
        self.assertEqual(json.loads(output.getvalue())['result']['tools'], TOOLS)
        imported = {alias.name for node in ast.walk(ast.parse((ROOT / 'tools' / 'computer_use_mcp.py').read_text(encoding='utf-8')))
                    if isinstance(node, ast.ImportFrom) and node.module == 'computer_use' for alias in node.names}
        self.assertNotIn('TOOLS', imported)


if __name__ == '__main__':
    unittest.main()
