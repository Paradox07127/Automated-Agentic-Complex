"""Runtime partial updates and human session titles through in-process HTTP requests."""
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.handler import Handler
from brain.egress import EgressPolicy
from character_agent.integration import CharacterAgentController
from character_agent.services.settings import DEFAULTS, RuntimeSettings
from daemon.agentd_server import AgentdServer


class CharacterRuntimeAndTitleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        with patch.object(AgentdServer, 'server_bind'), patch.object(AgentdServer, 'server_activate'):
            self.server = AgentdServer(('127.0.0.1', 48800), 'hook-token', 'ui-token')
        self.server.server_port = 48800
        self.server.egress = EgressPolicy()
        self.server.mouth = object()
        self.controller = self.server.character_agent = CharacterAgentController(self.server, self.root)
        self.addCleanup(self.controller.store.close)
        self.addCleanup(self.controller.workspace.close)
        self.addCleanup(self.server.server_close)
        self.rows = []
        self.controller.discovery = SimpleNamespace(scan=lambda refresh=False: {'runtimes': self.rows, 'scanned_at': 0})
        # Without a bundled pi, the unsaved default auto-selects the logged-in local Codex these tests drive.
        missing = str(self.root / 'no-pi')
        pi = patch('character_agent.harness.pi_config.resolve_pi_runtime', return_value=(missing, missing))
        pi.start(); self.addCleanup(pi.stop)

    def request(self, method, path, body=None, token='ui-token'):
        payload = b'' if body is None else json.dumps(body).encode()
        raw = (f'{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:48800\r\n'
               f'Authorization: Bearer {token}\r\nContent-Type: application/json\r\n'
               f'Content-Length: {len(payload)}\r\n\r\n').encode() + payload
        handler = Handler.__new__(Handler)
        handler.server = self.server
        handler.rfile, handler.wfile = io.BytesIO(raw), io.BytesIO()
        handler.handle_one_request()
        headers, response = handler.wfile.getvalue().split(b'\r\n\r\n', 1)
        return int(headers.split()[1]), json.loads(response)

    def hook(self, source, name, session='A', **extra):
        return self.request('POST', f'/hook/{source}',
                            {'hook_event_name': name, 'session_id': session, 'cwd': '/w', **extra}, token='hook-token')

    @staticmethod
    def found(backend, source, authenticated):
        return {'backend': backend, 'runtime_source': source, 'path': '/synthetic/' + source + '/' + backend,
                'version': 'test', 'entry_supported': True, 'boundary_verified': True,
                'authenticated': authenticated}

    def test_partial_runtime_put_preserves_every_omitted_effective_setting(self):
        self.rows = [self.found('codex', 'local_cli', True)]
        request = lambda method, body=None: self.request(method, '/character/runtime', body)
        for setup in (None, {'model': 'chosen-model', 'executable': '/synthetic/local_cli/codex',
                             'interactive_tools': False, 'history_retention': '7d', 'max_budget_usd': 2.5,
                             'workspace_dir': '/synthetic/workspace', 'reply_language': 'ja'}):
            with self.subTest(saved=setup is not None):
                if setup is not None:
                    self.assertEqual(request('PUT', setup)[0], 200)
                code, before = request('GET')
                self.assertEqual(code, 200)
                if setup is None:
                    self.assertEqual(before['runtime_source'], 'local')
                changes = {'max_budget_usd': 3.0}
                code, updated = request('PUT', changes)
                self.assertEqual(code, 200)
                code, after = request('GET')
                self.assertEqual(code, 200)
                # The reply's routes add readiness to the saved ones (test_runtime_routes).
                expected = {**{key: before[key] for key in DEFAULTS if key != 'routes'}, **changes}
                self.assertEqual({key: updated[key] for key in expected}, expected)
                self.assertEqual({key: after[key] for key in expected}, expected)
                self.assertEqual(RuntimeSettings(self.root).snapshot(), {**expected, 'routes': {}})

    def test_hook_session_title_waits_for_a_human_prompt_after_task_notification(self):
        self.server.share_typed_text = True
        notification = ('<task-notification>\n<task-id>b123</task-id>\n'
                        '<tool-use-id>toolu_123</tool-use-id>\n<status>completed</status>\n'
                        '<summary>Background command completed</summary>\n</task-notification>')
        payload = {'transcript_path': '/unavailable/session.jsonl', 'prompt_id': 'notification-1'}
        self.assertEqual(self.hook('claude', 'UserPromptSubmit', prompt=notification, **payload), (200, {}))
        self.assertEqual(self.hook('claude', 'UserPromptSubmit', prompt='Please fix the failing build',
                                   prompt_id='human-1', transcript_path=payload['transcript_path']), (200, {}))
        self.assertEqual(self.server.registry.titles(), {'claude:A': 'Please fix the failing build'})

    def test_hook_session_with_only_machine_prompts_has_no_title(self):
        self.server.share_typed_text = True
        for prompt in ('  <system-reminder>Tool output is ready.</system-reminder>\n',
                       '<local-command-caveat>Local command output follows.</local-command-caveat>\n'
                       '<command-name>/clear</command-name><command-message>clear</command-message>'
                       '<command-args></command-args>\n<local-command-stdout></local-command-stdout>',
                       '<task-notification><task-id>b123</task-id><status>completed</status></task-notification>'):
            self.assertEqual(self.hook('claude', 'UserPromptSubmit', prompt=prompt), (200, {}))
        self.assertEqual(self.server.registry.titles(), {})

    def test_hook_session_title_uses_human_text_beside_machine_blocks(self):
        self.server.share_typed_text = True
        self.hook('claude', 'UserPromptSubmit', prompt='<system-reminder>Editor context</system-reminder>\n'
                  'Explain <widget> markup\n<system-reminder>More context</system-reminder>')
        self.assertEqual(self.server.registry.titles(), {'claude:A': 'Explain <widget> markup'})

