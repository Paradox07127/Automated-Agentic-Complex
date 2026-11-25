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
from brain.events import cue  # noqa: E402
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
ORCHESTRATION = ['reminders_list', 'reminder_create', 'reminder_update', 'dispatch_session', 'dispatch_status', 'schedule_propose', 'schedules_list', 'schedule_update', 'goals_list', 'goal_create', 'goal_update',
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
        self.server.computer_control = object()
        self.server.sessions = Mock(sessions={}, store=None)

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
        self.line('查一下资料', no_memory=True); result['remember_off'] = names()
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

    def test_a_gift_runs_in_its_own_session_and_typing_keeps_its_session(self):
        self.line('整理资料')
        self.prepare('gift-1', 'gift')
        self.line('再整理一次')
        # The gift's session, without the harness tools, is its own and closes; typing keeps the one it opened.
        typed, gift = self.sessions[0], self.sessions[-1]
        self.assertEqual(len(self.sessions), 2)
        self.assertEqual(len(typed.calls), 2)
        self.assertFalse(typed.closed)
        self.assertEqual(len(gift.calls), 1)
        self.assertEqual(gift.closed, 1)

    def proactive(self, reply):
        """A proactive cue line whose kernel says reply; later runs say chat's reply again."""
        def said(session, prompt, options):
            yield {'type': 'text_delta', 'text': reply}
            yield {'type': 'result', 'success': True, 'final_text': reply, 'session_id': 'sdk-test'}
        self.script = said
        conn, response = self.open_feed()
        self.server.start_line('proactive-1', cue('greeting', '管理员 came back.', 'Greet them.'), source='proactive')
        events = self.lines_until_final(response); conn.close()
        self.assertFalse(events[-1].get('error'), events)
        self.script = integration.chat

    def test_typing_after_a_proactive_line_keeps_its_session_and_is_told_the_line(self):
        self.line('整理资料')
        self.proactive('欢迎回来，资料我还记着。')
        self.line('再整理一次')
        typed = self.sessions[0]
        self.assertFalse(typed.closed)
        self.assertEqual(len(typed.calls), 2)
        self.assertNotIn('Turns this session has not seen', typed.calls[0]['prompt'])
        unheard = typed.calls[1]['prompt'].split('Turns this session has not seen', 1)[1]
        self.assertIn('<event', unheard)
        self.assertIn('欢迎回来，资料我还记着。', unheard)

    def test_a_reopened_typing_session_gets_the_proactive_line_only_from_history(self):
        self.line('整理资料')
        self.proactive('欢迎回来，资料我还记着。')
        self.controller.runtime._session_key = None
        self.line('再整理一次')
        reopened = self.sessions[-1].calls[-1]
        self.assertTrue(self.sessions[0].closed)
        self.assertNotIn('Turns this session has not seen', reopened['prompt'])
        self.assertIn('欢迎回来，资料我还记着。', json.dumps(reopened['history'], ensure_ascii=False))

    def test_a_tap_runs_in_its_own_session_and_typing_keeps_its_session(self):
        self.desktop_on()
        self.line('整理资料')
        self.prepare('tap-1', 'tap')
        self.line('再整理一次')
        typed, tap = self.sessions[0], self.sessions[1]
        self.assertEqual(len(self.sessions), 2)
        self.assertEqual(len(typed.calls), 2)
        self.assertFalse(typed.closed)
        self.assertEqual(len(tap.calls), 1)
        self.assertEqual(tap.closed, 1)
        self.assertEqual([d['name'] for d in self.definitions[1]], HEAD['embodied_only'])

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
