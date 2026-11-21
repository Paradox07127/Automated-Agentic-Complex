"""Per-purpose kernel routes: the sessions each purpose builds, the readiness /character/runtime reports for them, and
a semantic run on a route that cannot run."""
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.handler import Handler
from brain.egress import EgressPolicy
from character_agent.integration import CharacterAgentController
from character_agent.services.settings import DEFAULTS, ROUTES, RuntimeSettings
from daemon.agentd_server import AgentdServer
import test_character_agent_semantic as semantic_fixture
from test_character_agent_runtime import FakeSession

from support import enable_plugins

PORT = 48810


def route(backend, model=None, effort=None, acp_agent=None):
    return {'backend': backend, 'acp_agent': acp_agent, 'model': model, 'effort': effort}


class RuntimeRouteTests(unittest.TestCase):
    def setUp(self):
        enable_plugins(self)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        with patch.object(AgentdServer, 'server_bind'), patch.object(AgentdServer, 'server_activate'):
            self.server = AgentdServer(('127.0.0.1', PORT), 'hook-token', 'ui-token')
        self.server.server_port = PORT
        self.server.egress = EgressPolicy()
        self.server.mouth = object()
        self.controller = self.server.character_agent = CharacterAgentController(self.server, self.root)
        self.addCleanup(self.controller.store.close)
        self.addCleanup(self.controller.workspace.close)
        self.addCleanup(self.server.server_close)
        self.rows = [self.found('codex', True)]
        self.controller.discovery = SimpleNamespace(scan=lambda refresh=False: {'runtimes': self.rows, 'scanned_at': 0})
        # Without a bundled pi, the unsaved default auto-selects the logged-in local Codex these tests drive.
        missing = str(self.root / 'no-pi')
        pi = patch('character_agent.harness.pi_config.resolve_pi_runtime', return_value=(missing, missing))
        pi.start(); self.addCleanup(pi.stop)

    def request(self, method, body=None):
        payload = b'' if body is None else json.dumps(body).encode()
        raw = (f'{method} /character/runtime HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n'
               f'Authorization: Bearer ui-token\r\nContent-Type: application/json\r\n'
               f'Content-Length: {len(payload)}\r\n\r\n').encode() + payload
        handler = Handler.__new__(Handler)
        handler.server = self.server
        handler.rfile, handler.wfile = io.BytesIO(raw), io.BytesIO()
        handler.handle_one_request()
        headers, response = handler.wfile.getvalue().split(b'\r\n\r\n', 1)
        return int(headers.split()[1]), json.loads(response)

    def put(self, change):
        code, reply = self.request('PUT', change)
        self.assertEqual(code, 200, reply)
        return reply

    @staticmethod
    def found(backend, authenticated):
        return {'backend': backend, 'runtime_source': 'local_cli', 'path': '/synthetic/local_cli/' + backend,
                'version': 'test', 'entry_supported': True, 'boundary_verified': True, 'authenticated': authenticated}

    def sessions(self):
        """(backend, model, effort) of the foreground, side and background sessions."""
        configs, payloads = [], []

        class Runtime:
            def __init__(self, *args, model, effort=None, **kwargs):
                self.model, self.effort = model, effort

            def run(self, **kwargs): raise RuntimeError('synthetic_stop')

            def close(self): pass

        jobs = SimpleNamespace(start=lambda: None, store=SimpleNamespace(
            submit=lambda title, payload, goal_id, **_: payloads.append(payload) or {'job_id': 'job-1'}))
        with patch.object(self.controller, '_session_factory_bound',
                          side_effect=lambda config, actor_id=None: configs.append(config)), \
             patch('character_agent.integration.PersonalAgentRuntime', Runtime), \
             patch.object(self.controller, '_prepare', side_effect=lambda *args, runtime, **options: None), \
             patch.object(self.controller, 'jobs', jobs):
            self.controller.submit_job('work', 'synthetic work', 'synthetic work')
            self.controller.runtime = None
            try:
                self.controller._ensure_runtime()
            finally:
                self.controller.runtime = None
            self.controller.prepare('side-1', 'hi', threading.Event(), 1, 'text', None, side=True)
            job = {'job_id': 'job-1', 'run_id': 'run-1', 'payload': payloads[0], 'generation': 0,
                   'conversation_id': None, 'previous_run_id': None}
            with self.assertRaisesRegex(RuntimeError, 'synthetic_stop'):
                self.controller._execute_job(job, threading.Event())
        self.assertNotIn('_turn_effort', payloads[0]['config'])
        return [(config['backend'], self.controller._model(config), config.get('_turn_effort')) for config in configs]

    def test_chat_and_background_routes_reach_their_own_sessions(self):
        self.assertEqual(self.sessions(), [('codex', 'default', 'low'), ('codex', 'default', 'low'), ('codex', 'default', None)])
        self.put({'model': 'base-model'})
        self.assertEqual(self.sessions(), [('codex', 'base-model', 'low')] * 2 + [('codex', 'base-model', None)])
        for chat, background, expected in (
                (route('codex', 'fast-model'), route('codex', 'deep-model', 'high'),
                 [('codex', 'fast-model', 'low')] * 2 + [('codex', 'deep-model', 'high')]),
                (route('codex', None, 'inherit'), route('codex', None, 'medium'),
                 [('codex', 'base-model', None)] * 2 + [('codex', 'base-model', 'medium')]),
                (route('codex', None, 'high'), route('codex', None, 'inherit'),
                 [('codex', 'base-model', 'high')] * 2 + [('codex', 'base-model', None)])):
            with self.subTest(chat=chat, background=background):
                self.put({'routes': {'chat': chat, 'background': background}})
                self.assertEqual(self.sessions(), expected)
        self.put({'routes': {}})
        self.assertEqual(self.sessions(), [('codex', 'base-model', 'low')] * 2 + [('codex', 'base-model', None)])

    def test_foreground_and_side_runs_use_the_chat_route_kernel(self):
        self.rows.append(self.found('claude', True))
        self.put({'backend': 'codex', 'runtime_source': 'local', 'model': 'base-model',
                  'routes': {'chat': route('claude', 'sonnet', 'high')}})
        self.assertEqual(self.sessions(), [('claude', 'sonnet', 'high')] * 2 + [('codex', 'base-model', None)])
        self.put({'routes': {'chat': route('claude')}})
        self.assertEqual(self.sessions(), [('claude', '', None)] * 2 + [('codex', 'base-model', None)])

    def test_runtime_reply_reports_every_route_and_whether_its_kernel_is_ready(self):
        code, reply = self.request('GET')
        self.assertEqual(code, 200)
        self.assertEqual(reply['routes'], {purpose: {**route('codex'), 'follows_main': True, 'ready': True, 'error': None}
                                           for purpose in ROUTES})
        chat, judge = route('codex', 'fast-model'), route('claude', 'sonnet', 'low')
        reply = self.put({'routes': {'chat': chat, 'judge': judge}})
        self.assertEqual(RuntimeSettings(self.root).snapshot()['routes'], {'chat': chat, 'judge': judge})
        self.assertEqual(reply['routes'], {
            **{purpose: {**route('codex'), 'follows_main': True, 'ready': True, 'error': None} for purpose in ROUTES},
            'chat': {**chat, 'follows_main': False, 'ready': True, 'error': None},
            'judge': {**judge, 'follows_main': False, 'ready': False, 'error': 'runtime_missing'}})
        self.assertEqual(set(reply) - {'routes'}, set(self.request('GET')[1]) - {'routes'})
        self.rows.append(self.found('claude', False))
        self.assertEqual(self.request('GET')[1]['routes']['judge'],
                         {**judge, 'follows_main': False, 'ready': False, 'error': 'native_login_required'})
        self.rows[-1] = self.found('claude', True)
        self.assertEqual(self.request('GET')[1]['routes']['judge'], {**judge, 'follows_main': False, 'ready': True, 'error': None})
        self.rows[:] = [self.found('claude', True)]
        reply = self.request('GET')[1]
        self.assertEqual((reply['ready'], reply['error']), (False, 'runtime_missing'))
        self.assertEqual((reply['routes']['memory']['ready'], reply['routes']['memory']['error']), (False, 'runtime_missing'))
        self.assertTrue(reply['routes']['judge']['ready'])
        for purpose in ROUTES:
            self.assertEqual(set(reply['routes'][purpose]),
                             {'backend', 'acp_agent', 'model', 'effort', 'follows_main', 'ready', 'error'})
        self.assertNotIn('front_model', reply)
        self.assertLessEqual(set(DEFAULTS), set(reply))

    def test_a_background_job_waits_for_the_background_route_not_the_main_kernel(self):
        self.rows.append(self.found('claude', True))
        self.put({'backend': 'codex', 'runtime_source': 'local', 'routes': {'background': route('claude')}})
        payloads = []
        jobs = SimpleNamespace(start=lambda: None, store=SimpleNamespace(
            submit=lambda title, payload, goal_id, **_: payloads.append(payload) or {'job_id': 'job-1'}))
        self.rows[:] = [self.found('claude', False)]
        with patch.object(self.controller, 'jobs', jobs), self.assertRaisesRegex(ValueError, 'native_login_required'):
            self.controller.submit_job('work', 'synthetic work', 'synthetic work')
        self.rows[:] = [self.found('claude', True)]
        with patch.object(self.controller, 'jobs', jobs):
            self.controller.submit_job('work', 'synthetic work', 'synthetic work')
        self.assertEqual(payloads[0]['config']['backend'], 'codex')


    def test_desktop_task_checks_and_runs_on_the_computer_route(self):
        self.rows.append(self.found('claude', True))
        self.put({'backend': 'codex', 'runtime_source': 'local', 'model': 'base-model',
                  'routes': {'computer': route('claude', 'sonnet')}})
        checked, ran = [], []
        self.server.computer_control = object()
        with patch.object(self.controller, '_can_run_desktop_task',
                          side_effect=lambda config, bridge: checked.append(config['backend']) or True), \
             patch.object(self.controller.tools, 'verdict'), \
             patch('tool_gateway.computer_toolset.run_desktop_task',
                   side_effect=lambda bridge, args, *, config, **_: ran.append((config['backend'], config['model'])) or {}):
            self.controller._native('desktop_task', {'goal': 'synthetic'}, run_id='run-1', is_current=lambda: True)
        self.assertEqual(checked, ['claude'])
        self.assertEqual(ran, [('claude', 'sonnet')])

    def test_computer_use_is_reported_from_the_computer_route_without_an_api_key(self):
        self.put({'routes': {'computer': route('codex')}})
        self.server.computer_control = object()
        for enabled, expected in ((True, {'implemented': True, 'via': 'kernel_sub_run'}),
                                  (False, {'implemented': False, 'reason': 'computer_route_unavailable'})):
            with self.subTest(enabled=enabled), patch('tool_gateway.desktop.status', return_value={'enabled': enabled}):
                reply = self.controller.public()
                self.assertEqual((reply['auth_source'], reply['routes']['computer']['backend']), ('existing_login', 'codex'))
                self.assertEqual(reply['capabilities']['features']['native_computer_use'], expected)

    def test_a_chat_line_waits_for_the_chat_route_not_the_main_kernel(self):
        self.rows.append(self.found('claude', True))
        self.put({'backend': 'codex', 'runtime_source': 'local', 'routes': {'chat': route('claude')}})
        lines = []
        with patch.object(self.server, '_run_character_line', side_effect=lambda *args, **kwargs: lines.append(args[0])):
            self.rows[:] = [self.found('claude', True)]
            self.assertFalse(self.controller.public()['ready'])
            status, body = self.server.say('你好')
            self.assertEqual((status, body.get('runtime')), (202, 'claude'), body)
            self.assertEqual(self.server._line_lane(), 'kernel')
            self.rows[:] = [self.found('codex', True), self.found('claude', False)]
            self.assertTrue(self.controller.public()['ready'])
            self.assertIsNone(self.server._line_lane())
            self.assertEqual(self.server.say('你好'), (503, {'error': 'native_login_required', 'runtime': 'claude'}))

class SemanticRouteTests(unittest.TestCase):
    setUp = semantic_fixture.SemanticTests.setUp
    tearDown = semantic_fixture.SemanticTests.tearDown
    factory = semantic_fixture.SemanticTests.factory

    def recorded(self):
        configs = []

        def factory(tools, config, **kwargs):
            configs.append(config)
            return FakeSession(lambda *args: iter([{'type': 'result', 'success': True, 'final_text': '{"ok": true}',
                                                    'model': 'fixture-model'}]))
        return configs, patch.object(self.c, '_session_factory', side_effect=factory)

    def test_semantic_run_builds_its_session_on_its_route(self):
        self.c.settings.save({'backend': 'codex', 'runtime_source': 'local', 'model': 'base-model', 'routes': {
            'judge': route('claude', 'sonnet'), 'understand': route('pi', 'gpt-5.5', 'high')}})
        self.c.discovery = SimpleNamespace(scan=lambda refresh=False: {'runtimes': [], 'scanned_at': 0})
        configs, factory = self.recorded()
        with factory:
            results = [self.c.semantic.run(purpose, '返回JSON', {}) for purpose in ('review', 'observation_interpret', 'memory_extract')]
        self.assertEqual([(r['backend'], r['value']) for r in results], [('claude', {'ok': True}), ('pi', {'ok': True}),
                                                                        ('codex', {'ok': True})])
        self.assertEqual([(c['backend'], c['runtime_source'], c['model'], c['_semantic_effort']) for c in configs],
                         [('claude', 'local', 'sonnet', 'medium'), ('pi', 'bundled', 'gpt-5.5', 'high'),
                          ('codex', 'local', 'base-model', 'medium')])

    def test_semantic_run_on_a_route_that_cannot_run_fails_with_its_error_and_never_runs_the_main_kernel(self):
        self.c.settings.save({'backend': 'codex', 'runtime_source': 'local', 'routes': {'judge': route('claude')}})
        self.c.session_factory_override = None
        rows = [RuntimeRouteTests.found('codex', True)]
        self.c.discovery = SimpleNamespace(scan=lambda refresh=False: {'runtimes': rows, 'scanned_at': 0})
        configs, factory = self.recorded()
        with factory:
            with self.assertRaisesRegex(ValueError, '^runtime_missing$'):
                self.c.semantic.run('proactive_decide', '返回JSON', {})
            rows.append(RuntimeRouteTests.found('claude', False))
            with self.assertRaisesRegex(ValueError, '^native_login_required$'):
                self.c.semantic.run('facing_decide', '返回JSON', {})
            self.assertEqual(self.c.public()['routes']['judge']['error'], 'native_login_required')
            self.assertEqual(configs, [])
            self.assertEqual(self.c.semantic.run('memory_extract', '返回JSON', {})['backend'], 'codex')
        self.assertEqual([c['backend'] for c in configs], ['codex'])
        self.assertEqual(self.db.execute('SELECT purpose,outcome FROM semantic_attempts ORDER BY rowid').fetchall(),
                         [('proactive_decide', 'failed'), ('facing_decide', 'failed'), ('memory_extract', 'succeeded')])


if __name__ == '__main__':
    unittest.main()
