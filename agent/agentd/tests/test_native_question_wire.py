"""Opt-in native CLI checks against synthetic local state."""
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.harness.codex_runner import AppServer


@unittest.skipUnless(os.environ.get('AAC_NATIVE_QUESTION_WIRE') == '1', 'opt-in native CLI protocol checks')
class NativeQuestionWireTests(unittest.IsolatedAsyncioTestCase):
    async def test_codex_accepts_injected_original_call_and_structured_answer(self):
        cli = os.environ.get('AAC_CODEX_CLI') or shutil.which('codex')
        if not cli: self.skipTest('Codex CLI unavailable')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'codex').mkdir()
            env = {k: v for k, v in os.environ.items() if k in ('PATH', 'TMPDIR', 'LANG')}
            env.update(HOME=str(root), CODEX_HOME=str(root / 'codex'))
            app = AppServer([cli, '-c', 'check_for_update_on_startup=false', 'app-server', '--listen', 'stdio://'],
                env, str(root), lambda *args: None)
            try:
                await app.start()
                await app.request('initialize', {'clientInfo': {'name': 'endfield_probe', 'version': '1'},
                    'capabilities': {'experimentalApi': True}})
                thread = await app.request('thread/start', {'ephemeral': True, 'cwd': str(root), 'model': 'gpt-5',
                    'baseInstructions': 'Synthetic local protocol probe.', 'sandbox': 'read-only', 'approvalPolicy': 'never'})
                response = await app.request('thread/inject_items', {'threadId': thread['thread']['id'], 'items': [
                    {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'original-goal'}]},
                    {'type': 'function_call', 'call_id': 'original-call', 'name': 'ask_user', 'arguments': '{"questions":[]}'},
                    {'type': 'function_call_output', 'call_id': 'original-call', 'output': '{"answers":{"q":["real-answer"]}}'}]})
                self.assertEqual(response, {})
            finally:
                await app.disconnect()
