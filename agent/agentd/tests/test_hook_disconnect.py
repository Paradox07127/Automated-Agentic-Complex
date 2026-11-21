"""The settings-page disconnect edits only its selected, service-owned hooks."""
import http.client
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from brain.language import ReplyLanguage
from daemon.agentd_server import AgentdServer
from tools import install_hooks
from support import enable_plugins, serve_in_thread


class HookDisconnectTest(unittest.TestCase):
    def setUp(self):
        enable_plugins(self, 'coding_sessions')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.server = AgentdServer(('127.0.0.1', 0), 'hook-only', 'ui-secret')
        self.worker = serve_in_thread(self.server)
        self.addCleanup(self.close)
        self.root = Path(self.tmp.name)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.user = {'hooks': [{'type': 'command', 'command': 'my-unrelated-hook'}]}
        self.ours = {'hooks': [{'type': 'command', 'command':
            f'python3 /opt/Endfield/codex_hook_forward.py --observe --url {self.url}'}]}
        self.original = {'model': 'keep-me', 'hooks': {'Stop': [self.user, self.ours]}}
        self.server.hook_files = {'claude': self.root / 'settings.json', 'codex': self.root / 'hooks.json'}
        for path in self.server.hook_files.values():
            path.write_text(json.dumps(self.original), encoding='utf-8')
        # Windows' localtime refuses times this close to the epoch.
        self.server.hook_seen = {'claude': 1_700_000_001, 'codex': 1_700_000_002}

    def close(self):
        self.server.shutdown(); self.server.server_close(); self.worker.join(2)

    def request(self, body, token='ui-secret'):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        conn.request('POST', '/integrations/hooks/disconnect', json.dumps(body),
                     {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        reply = conn.getresponse(); data = json.load(reply); status = reply.status; conn.close()
        return status, data

    def test_selected_tool_only_preserves_other_hooks_and_leaves_no_copy(self):
        other = self.server.hook_files['claude'].read_bytes()
        path = self.server.hook_files['codex']
        status, reply = self.request({'target': 'codex'})
        self.assertEqual((status, reply), (200, {'target': 'codex', 'removed': 1}))
        self.assertEqual(json.loads(path.read_text(encoding='utf-8')), {'model': 'keep-me', 'hooks': {'Stop': [self.user]}})
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['hooks.json', 'settings.json'])
        self.assertEqual(self.server.hook_files['claude'].read_bytes(), other)
        self.assertFalse(self.server._diag_hooks()['codex']['installed'])
        self.assertEqual(self.server.hook_seen['codex'], 1_700_000_002)  # historical events remain historical
        self.assertEqual(self.request({'target': 'codex'})[1], {'target': 'codex', 'removed': 0})

    def test_hook_and_events_tokens_cannot_edit_settings_or_choose_paths(self):
        for token in ('hook-only', 'bad'):
            self.assertEqual(self.request({'target': 'codex'}, token)[0], 401)
        for body in ({'target': 'both'}, {'target': '../settings'}, {'target': 'codex', 'path': '/tmp/anything'}, []):
            self.assertEqual(self.request(body)[0], 400)
        self.assertEqual(list(self.root.glob('*.bak')), [])
        for path in self.server.hook_files.values():
            self.assertEqual(json.loads(path.read_text(encoding='utf-8')), self.original)

    def test_invalid_json_settings_are_not_overwritten(self):
        path = self.server.hook_files['claude']; path.write_text('{bad json', encoding='utf-8')
        self.assertEqual(self.request({'target': 'claude'})[0], 409)
        self.assertEqual(path.read_text(encoding='utf-8'), '{bad json')
        self.assertEqual(list(self.root.glob('*.bak')), [])

    def test_missing_and_unconfigured_tool_do_not_touch_the_other_tool(self):
        self.server.hook_files['codex'].unlink()
        self.assertEqual(self.request({'target': 'codex'})[1]['removed'], 0)
        del self.server.hook_files['claude']
        self.assertEqual(self.request({'target': 'claude'})[0], 503)
        self.assertEqual(json.loads((self.root/'settings.json').read_text(encoding='utf-8')), self.original)

    def test_error_detail_follows_the_reply_language(self):
        del self.server.hook_files['claude']
        self.addCleanup(setattr, self.server, 'character_agent', None)
        for setting, detail in (('en', "The background service has not found this tool's settings file yet; "
                                       "restart it and try again"),
                                ('zh-Hans', '后台尚未定位此工具的配置文件，请重启后台后重试')):
            with self.subTest(setting=setting):
                self.server.character_agent = SimpleNamespace(
                    reply_language=ReplyLanguage(), settings=SimpleNamespace(snapshot=lambda: {'reply_language': setting}))
                self.assertEqual(self.request({'target': 'claude'}),
                                 (503, {'error': 'hook_file_unavailable', 'detail': detail}))
