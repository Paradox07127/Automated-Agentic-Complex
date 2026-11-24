"""The kernel session and desktop bridge are scripted fakes; no model or desktop input is used."""
import ast
import base64
import importlib
import json
from pathlib import Path
import sys
import struct
import zlib
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tool_gateway.registry import BUILTIN, REGISTRY
from tool_gateway.gateway import SessionKey

TARGET = {'pid': 123, 'window_id': 7}
CONFIG = {'backend': 'codex', 'auth_source': 'existing_login', 'timeout_seconds': 900, 'max_turns': 24}
ELEMENTS = [{'element_id': 'e0', 'role': 'AXButton', 'enabled': True,
             'bounds': {'x': 10, 'y': 20, 'width': 100, 'height': 30}, 'actions': ['AXPress']},
            {'element_id': 'e1', 'role': 'AXTextField', 'enabled': True,
             'bounds': {'x': 50, 'y': 60, 'width': 200, 'height': 20}, 'actions': []}]


class Bridge:
    def __init__(self):
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        data = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 800, 600, 8, 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress((b'\0' + b'\xff\0\0' * 800) * 600)) + chunk(b'IEND', b''))
        self.image = base64.b64encode(data).decode()
        self.calls, self.error = [], None

    def __call__(self, name, args, **kwargs):
        self.calls.append((name, args, kwargs))
        if self.error:
            return {'error': {'code': self.error, 'message': self.image}}
        if name == 'desktop_observe':
            return {'snapshot_id': 's' + str(len(self.calls)), 'elements': ELEMENTS,
                    'target': {**TARGET, 'bundle_id': 'test.app',
                               'bounds': {'x': 20, 'y': 30, 'width': 400, 'height': 300}},
                    'image': {'mime_type': 'image/png', 'data': self.image}}
        return {'effect': 'unverifiable', 'requires_fresh_observation': True}


class Session:
    """A scripted kernel: calls its tools in order, then ends with text; loop repeats the last call forever."""
    def __init__(self, script, text='', loop=False, after=None):
        self.script, self.text, self.loop, self.after = list(script), text, loop, after
        self.results, self.closed, self.cancelled_seen = [], False, False

    def stream(self, prompt, *, system_prompt, history, cancelled, tool_handler, run_id=None):
        self.prompt, self.system, self.history = prompt, system_prompt, history
        yield {'type': 'ready'}
        index = 0
        while True:
            if cancelled():
                self.cancelled_seen = True
                yield {'type': 'result', 'success': False, 'subtype': 'cancelled'}
                return
            if index >= len(self.script) and not self.loop:
                if self.text:
                    yield {'type': 'text_delta', 'text': self.text}
                yield {'type': 'result', 'success': True}
                return
            name, args = self.script[min(index, len(self.script) - 1)]
            index += 1
            result = tool_handler(name, args)
            self.results.append((name, result))
            if self.after:
                self.after(name)
            yield {'type': 'tool_finished', 'name': name, 'result': result}

    def close(self):
        self.closed = True


class DesktopTaskTests(unittest.TestCase):
    def module(self):
        return importlib.import_module('tool_gateway.computer_toolset')

    def run_task(self, *script, args=None, bridge=None, current=lambda: True, text='', loop=False, after=None):
        self.bridge = bridge or Bridge()
        self.session = Session(script, text, loop, after)
        self.trace, self.factory_calls = [], []
        def factory(definitions, config):
            self.factory_calls.append((definitions, config))
            return self.session
        return self.module().run_desktop_task(self.bridge, args or {'target': TARGET, 'goal': 'Open the tab'},
            config=CONFIG, session_factory=factory, is_current=current, report=self.trace.append)

    def test_product_tool_registered_for_character_actions_only(self):
        self.assertIn('desktop_task', BUILTIN, 'desktop_task is missing today')
        spec = BUILTIN['desktop_task']
        self.assertEqual((spec.family, spec.effect, spec.grant, spec.receipt),
                         ('desktop', 'desktop_input', 'native_panel', True))
        self.assertEqual(spec.callers, frozenset({'character'}))
        from tool_gateway.computer_use import DESKTOP_TASK_TOOL
        self.assertEqual(DESKTOP_TASK_TOOL['input_schema']['required'], ['target', 'goal'])
        self.assertNotIn('cost', DESKTOP_TASK_TOOL['description'])
        self.assertIsNone(REGISTRY.offer('actions', [DESKTOP_TASK_TOOL]).refusal('desktop_task'))
        for mode in ('read_only', 'background', 'embodied_only'):
            self.assertEqual(REGISTRY.offer(mode, [DESKTOP_TASK_TOOL]).refusal('desktop_task')['error']['code'], 'tool_not_allowed_in_mode')
        self.assertNotIn('desktop_task', [t['name'] for t in REGISTRY.mcp_tools('own_session')])

    def test_no_anthropic_client_in_the_toolset(self):
        source = Path(self.module().__file__).read_text(encoding='utf-8')
        imported = {alias.name.split('.')[0] for node in ast.walk(ast.parse(source))
                    if isinstance(node, (ast.Import, ast.ImportFrom))
                    for alias in (node.names if isinstance(node, ast.Import) else [SimpleNamespace(name=node.module or '')])}
        self.assertNotIn('anthropic', imported)

    def test_sub_run_screenshots_clicks_and_returns_done(self):
        result = self.run_task(('screenshot', {}), ('click', {'x': 400, 'y': 150}), ('screenshot', {}),
                               ('done', {'result': 'The tab is open.'}))
        self.assertEqual(result, {'code': 'completed', 'actions': 3, 'effect': 'unverifiable', 'result': 'The tab is open.'})
        definitions, config = self.factory_calls[0]
        self.assertEqual([d['name'] for d in definitions], ['screenshot', 'click', 'type', 'scroll', 'done'])
        self.assertTrue(all(set(d) == {'name', 'description', 'input_schema'} for d in definitions))
        self.assertEqual((config['backend'], config['timeout_seconds']), ('codex', self.module().MAX_SECONDS))
        self.assertEqual((self.session.prompt, self.session.system, self.session.history),
                         ('Open the tab', self.module().SYSTEM, []))
        calls = self.bridge.calls
        self.assertEqual([c[0] for c in calls], ['desktop_observe', 'desktop_act', 'desktop_observe'])
        self.assertEqual(calls[0][1], {'target': TARGET, 'include_image': True, 'include_text': False})
        self.assertEqual(calls[1][1], {'snapshot_id': 's1', 'action': 'click', 'x': 200, 'y': 75})
        self.assertEqual(calls[2][1]['target'], TARGET)
        self.assertTrue(all(0 < c[2]['timeout'] <= self.module().MAX_SECONDS for c in calls))
        shot = self.session.results[0][1]['content']
        self.assertEqual(shot[1], {'type': 'image', 'mimeType': 'image/png', 'data': self.bridge.image})
        described = json.loads(shot[0]['text'])
        self.assertEqual(described['image_size'], [800, 600])
        self.assertEqual(described['controls'][1], {'element_id': 'e1', 'role': 'AXTextField', 'enabled': True,
                                                    'bounds': {'x': 100, 'y': 120, 'width': 400, 'height': 40}})
        self.assertTrue(self.session.closed)
        self.assertTrue(self.session.cancelled_seen, 'done must end the kernel turn')
        self.assertEqual(self.trace, [{'member': 'screenshot', 'count': 1, 'code': 'ok'},
                                      {'member': 'click', 'count': 2, 'code': 'ok'},
                                      {'member': 'screenshot', 'count': 3, 'code': 'ok'}])
        self.assertNotIn(self.bridge.image, json.dumps([result, self.trace]))

    def test_type_and_scroll_map_to_bridge_actions(self):
        result = self.run_task(('screenshot', {}), ('type', {'element_id': 'e1', 'text': 'hello'}), ('screenshot', {}),
                               ('scroll', {'x': 200, 'y': 300, 'direction': 'down', 'amount': 2}), text='Scrolled.')
        self.assertEqual((result['code'], result['result']), ('completed', 'Scrolled.'))
        acts = [c[1] for c in self.bridge.calls if c[0] == 'desktop_act']
        self.assertEqual(acts, [{'snapshot_id': 's1', 'action': 'type', 'element_id': 'e1', 'text': 'hello'},
                                {'snapshot_id': 's3', 'action': 'scroll', 'x': 100, 'y': 150, 'delta_y': -80}])

    def test_each_action_needs_a_screenshot_after_the_last_one(self):
        result = self.run_task(('click', {'x': 1, 'y': 1}), ('screenshot', {}), ('click', {'x': 1, 'y': 1}),
                               ('click', {'x': 1, 'y': 1}), ('done', {'result': 'x'}))
        self.assertEqual(result['code'], 'completed')
        self.assertEqual([r[1].get('error', {}).get('code') for r in self.session.results],
                         ['screenshot_required', None, None, 'screenshot_required', None])
        self.assertEqual([c[0] for c in self.bridge.calls], ['desktop_observe', 'desktop_act'])

    def test_step_limit_stops_a_looping_kernel(self):
        result = self.run_task(('screenshot', {}), loop=True)
        self.assertEqual((result['code'], result['actions']), ('action_limit', self.module().MAX_STEPS))
        self.assertEqual(len(self.bridge.calls), self.module().MAX_STEPS)
        self.assertTrue(self.session.cancelled_seen)
        result = self.run_task(('screenshot', {}), loop=True, args={'target': TARGET, 'goal': 'look', 'max_actions': 2})
        self.assertEqual((result['code'], result['actions'], len(self.bridge.calls)), ('action_limit', 2, 2))

    def test_run_going_stale_cancels_before_the_next_action(self):
        state = {'current': True}
        def after(name):
            state['current'] = False
        result = self.run_task(('screenshot', {}), ('click', {'x': 1, 'y': 1}), current=lambda: state['current'], after=after)
        self.assertEqual(result['code'], 'run_cancelled')
        self.assertEqual([c[0] for c in self.bridge.calls], ['desktop_observe'])
        self.assertTrue(self.session.cancelled_seen)
        result = self.run_task(('screenshot', {}), current=lambda: False)
        self.assertEqual((result['code'], self.factory_calls, self.bridge.calls), ('run_cancelled', [], []))

    def test_wall_time_limit(self):
        with patch.object(self.module(), 'MAX_SECONDS', 0):
            result = self.run_task(('screenshot', {}))
        self.assertEqual((result['code'], self.bridge.calls), ('timeout', []))

    def test_grant_required_stops_without_retry(self):
        bridge = Bridge(); bridge.error = 'approval_required'
        result = self.run_task(('screenshot', {}), ('screenshot', {}), bridge=bridge)
        self.assertEqual(result['code'], 'grant_required')
        self.assertEqual(len(bridge.calls), 1)
        self.assertNotIn(bridge.image, json.dumps(result))

    def test_invalid_or_unsupported_input_never_acts(self):
        for name, args in (('click', {'x': 800, 'y': 0}), ('click', {'x': True, 'y': 1}),
                           ('scroll', {'x': 1, 'y': 1, 'direction': 'left', 'amount': 2}),
                           ('type', {'element_id': 'e9', 'text': 'x'}), ('key', {'key': 'return'})):
            with self.subTest(name=name, args=args):
                result = self.run_task(('screenshot', {}), (name, args), ('click', {'x': 1, 'y': 1}))
                self.assertEqual(result['code'], 'invalid_action')
                self.assertFalse(any(c[0] == 'desktop_act' for c in self.bridge.calls))
        for args in ({'target': TARGET, 'goal': ''}, {'target': TARGET, 'goal': 'x', 'max_actions': True},
                     {'target': {}, 'goal': 'x'}, {'target': TARGET, 'goal': 'x', 'extra': 1}):
            self.assertEqual(self.run_task(args=args)['code'], 'invalid_arguments')

    def test_effect_is_not_executed_until_an_action_reaches_the_bridge(self):
        for script in ((), (('screenshot', {}), ('done', {'result': 'It asks to sign in.'})),
                       (('screenshot', {}), ('click', {'x': 1, 'y': 1}), ('done', {'result': 'x'}))):
            with self.subTest(script=script):
                result = self.run_task(*script)
                self.assertEqual(result['effect'], 'unverifiable' if len(script) == 3 else 'not_executed')
        self.assertEqual(self.run_task(args={'target': TARGET, 'goal': ''})['effect'], 'not_executed')

    def test_sub_run_session_has_no_harness_tools_and_an_empty_workspace_of_its_own(self):
        import tempfile
        from character_agent.harness.claude_transport import ClaudeConfig
        from character_agent.harness.codex_transport import CodexConfig
        from character_agent.integration import CharacterAgentController
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        enable = patch('character_agent.integration.plugins.on', return_value=True)
        for backend, check in (('pi', None), ('codex', CodexConfig), ('claude', ClaudeConfig)):
            with self.subTest(backend=backend):
                harness = Mock()
                controller = Mock(session_factory_override=None, state_dir=Path(tmp.name))
                controller._model.return_value = 'model'
                controller.settings.workspace.return_value = '/shared'
                config = {'backend': backend, 'auth_source': 'existing_login', 'runtime_source': 'local'}
                with enable, patch.dict('character_agent.integration.HARNESSES', {backend: harness}):
                    CharacterAgentController._session_factory(controller, ['tool'], config, 'desktop-task-x',
                                                              native_tools=False, private_workspace=True, max_turns=9)
                common = harness.session.call_args.args[2]
                self.assertFalse(common['native_tools'])
                self.assertEqual(common.get('max_turns'), 9 if backend == 'pi' else None)
                if check is not None:
                    check(**common, cli_path='/usr/local/bin/' + backend, auth_mode='existing_login').validate()
                workspace = Path(common['workspace_dir'])
                self.assertEqual(workspace.parent, Path(tmp.name, 'character-agent', 'runner', backend, 'jobs', 'desktop-task-x'))
                self.assertEqual((list(workspace.iterdir()), workspace.stat().st_mode & 0o777), ([], 0o700))

    def test_kernel_ending_without_done_or_success(self):
        session = Session([])
        session.stream = Mock(side_effect=RuntimeError('runner_disconnected'))
        result = self.module().run_desktop_task(Bridge(), {'target': TARGET, 'goal': 'x'}, config=CONFIG,
            session_factory=lambda d, c: session, is_current=lambda: True)
        self.assertEqual(result['code'], 'kernel_failed')
        self.assertTrue(session.closed)

    def test_offered_for_image_kernels_with_an_enabled_bridge(self):
        module = self.module()
        from tool_gateway.computer_use import ComputerControlConfig
        bridge = ComputerControlConfig('/unused', '/unused')
        cases = [({'backend': 'codex', 'auth_source': 'existing_login'}, None, True, True, True),
                 ({'backend': 'claude', 'auth_source': 'existing_login'}, None, True, True, True),
                 ({'backend': 'pi', 'auth_source': 'api_key'}, None, True, True, True),
                 ({'backend': 'acp', 'auth_source': 'existing_login'}, {'promptCapabilities': {'image': True}}, True, True, True),
                 ({'backend': 'acp', 'auth_source': 'existing_login'}, {'promptCapabilities': {'image': False}}, True, True, False),
                 ({'backend': 'acp', 'auth_source': 'existing_login'}, None, True, True, False),
                 ({'backend': 'codex', 'auth_source': 'existing_login'}, None, False, True, False),
                 ({'backend': 'codex', 'auth_source': 'existing_login'}, None, True, False, False)]
        for config, capabilities, enabled, present, expected in cases:
            with self.subTest(config=config, capabilities=capabilities, enabled=enabled, present=present), \
                 patch('tool_gateway.desktop.status', return_value={'enabled': enabled}):
                ready = module.available(config, bridge if present else None, capabilities)
                names = [t['name'] for t in REGISTRY.native_definitions(desktop=present, desktop_task=ready)]
                self.assertEqual('desktop_task' in names, expected)

    def test_internal_images_use_same_lease_with_bounded_nonwaiting_call(self):
        from tool_gateway.desktop import DesktopLeases
        lease = DesktopLeases(lambda: object(), lambda: None, lambda *args: None)
        fake = Bridge()
        with patch('tool_gateway.desktop.ComputerControlClient') as client:
            def call(name, args):
                self.assertLessEqual(client.return_value.timeout, 3)
                self.assertFalse(client.return_value.wait_for_permission)
                return fake(name, args)
            client.return_value.call.side_effect = call
            client.return_value.session_id = 'character:run'
            key = SessionKey('character', 'run', None)
            self.assertTrue(hasattr(lease, 'computer_call'), 'no leased image path today')
            result = lease.computer_call(key, 'desktop_observe', {'target': TARGET, 'include_image': True}, timeout=3)
        self.assertEqual(result['image']['data'], fake.image)
        self.assertEqual(lease.held(), {'run': 'character:run'})

    def test_capability_follows_computer_route_readiness_for_any_auth(self):
        from character_agent.services.capabilities import describe
        for auth, ready in [('existing_login', True), ('api_key', False), ('api_key', True)]:
            cap = describe({'backend': 'pi', 'auth_source': auth}, computer_use_ready=ready)
            self.assertEqual(cap['features']['native_computer_use'], {'implemented': True, 'via': 'kernel_sub_run'}
                             if ready else {'implemented': False, 'reason': 'computer_route_unavailable'})

    def test_runtime_report_asks_the_bridge_on_the_computer_route(self):
        from character_agent.integration import CharacterAgentController
        from character_agent.services.settings import RuntimeSettings
        bridge = object()
        config = {'backend': 'codex', 'auth_source': 'existing_login', 'routes': {}}
        controller = SimpleNamespace(server=SimpleNamespace(computer_control=bridge), _acp_probes={})
        controller._can_run_desktop_task = lambda c, b: CharacterAgentController._can_run_desktop_task(controller, c, b)
        with patch('tool_gateway.computer_toolset.available', return_value=True) as available:
            self.assertTrue(CharacterAgentController._computer_use_ready(controller, config))
        available.assert_called_once_with(RuntimeSettings.route(config, 'computer'), bridge, None)
        controller.server.computer_control = None
        self.assertFalse(CharacterAgentController._computer_use_ready(controller, config))

    def test_controller_runs_task_on_the_computer_route_config(self):
        from character_agent.integration import CharacterAgentController
        from character_agent.services.settings import RuntimeSettings
        config = {'backend': 'codex', 'auth_source': 'existing_login', 'routes': {}}
        routed = RuntimeSettings.route(config, 'computer')
        tools, bridge = Mock(), object()
        controller = SimpleNamespace(settings=SimpleNamespace(snapshot=lambda: config), tools=tools,
            server=SimpleNamespace(computer_control=bridge),
            _acp_probes={}, _session_factory=Mock(return_value='session'))
        controller._can_run_desktop_task = lambda c, b: CharacterAgentController._can_run_desktop_task(controller, c, b)
        args = {'target': TARGET, 'goal': 'look'}
        with patch('tool_gateway.computer_toolset.available', return_value=True) as available, \
             patch('tool_gateway.computer_toolset.run_desktop_task', return_value={'code': 'completed'}) as run:
            value = CharacterAgentController._native(controller, 'desktop_task', args, run_id='run', is_current=lambda: True)
            self.assertEqual(value, {'code': 'completed'})
            available.assert_called_once_with(routed, bridge, None)
            self.assertEqual(run.call_args.kwargs['config'], routed)
            self.assertNotIn('api_key', run.call_args.kwargs)
            self.assertEqual(run.call_args.kwargs['session_factory'](['tool'], {'backend': 'codex', 'max_turns': 9}), 'session')
            definitions, sub, actor = controller._session_factory.call_args.args
            self.assertEqual((definitions, sub), (['tool'], {'backend': 'codex', 'max_turns': 9}))
            self.assertTrue(actor.startswith('desktop-task-'))
            self.assertEqual(controller._session_factory.call_args.kwargs,
                             {'native_tools': False, 'private_workspace': True, 'max_turns': 9})
            run.call_args.args[0]('desktop_observe', {'target': TARGET}, timeout=2)
            self.assertEqual(tools.desktop.computer_call.call_args.args[:2], (SessionKey('character', 'run', None), 'desktop_observe'))
            available.return_value = False
            self.assertEqual(CharacterAgentController._native(controller, 'desktop_task', args,
                run_id='run', is_current=lambda: True), {'error': {'code': 'desktop_task_unavailable'}})
            self.assertEqual(run.call_count, 1)

    def test_acp_readiness_reads_the_probed_prompt_capabilities(self):
        from character_agent.integration import CharacterAgentController
        capabilities = {'promptCapabilities': {'image': True}}
        controller = SimpleNamespace(_acp_probes={'gemini': {'ok': True, 'capabilities': capabilities}},
                                     _acp_error=lambda *args: None)
        with patch('tool_gateway.computer_toolset.available', return_value=True) as available:
            CharacterAgentController._can_run_desktop_task(controller, {'backend': 'acp', 'acp_agent': 'gemini'}, 'bridge')
            CharacterAgentController._can_run_desktop_task(controller, {'backend': 'acp', 'acp_agent': 'other'}, 'bridge')
        self.assertEqual([c.args[2] for c in available.call_args_list], [capabilities, None])

    def test_not_offered_on_a_computer_route_whose_acp_agent_cannot_be_locked(self):
        from character_agent.integration import CharacterAgentController
        capabilities = {'promptCapabilities': {'image': True}}
        agents = [{'id': agent, 'name': agent, 'source': 'local', 'command': ['/synthetic/' + agent, 'acp']}
                  for agent in ('goose', 'opencode')]
        controller = SimpleNamespace(_acp_probes={agent['id']: {'ok': True, 'capabilities': capabilities}
                                                  for agent in agents}, _acp_logins={})
        controller._acp_error = lambda *args: CharacterAgentController._acp_error(controller, *args)
        config = {'backend': 'acp', 'acp_launcher': 'local', 'acp_agent': 'goose'}
        with patch('character_agent.harness.acp_agents.find_local', return_value=agents), \
             patch('tool_gateway.desktop.status', return_value={'enabled': True}):
            self.assertFalse(CharacterAgentController._can_run_desktop_task(controller, config, 'bridge'))
            self.assertTrue(CharacterAgentController._can_run_desktop_task(controller, {**config, 'acp_agent': 'opencode'},
                                                                           'bridge'))

    def test_task_run_end_releases_even_a_conversation_lease(self):
        from tool_gateway.desktop import DesktopLeases
        lease = DesktopLeases(lambda: object(), lambda: None, lambda *args: None)
        key = SessionKey('character', 'run', 'conversation')
        lease.enter(key)
        with patch('tool_gateway.desktop.ComputerControlClient') as client, patch.object(lease, '_revoke') as revoke:
            client.return_value.call.return_value = {'enabled': True}
            lease.computer_call(key, 'desktop_status', {}, timeout=2)
            lease.release('run', 'run_end')
            self.assertEqual(revoke.call_count, 1, 'desktop_task must not retain the lease past run_end')
            self.assertEqual(lease.held(), {})
        lease.release_all('shutdown')
