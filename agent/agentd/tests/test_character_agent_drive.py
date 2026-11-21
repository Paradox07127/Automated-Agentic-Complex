"""Standalone C8 driver against real runners and local model fixtures."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
HARNESS = ROOT / 'agent/agentd/character_agent/harness'

sys.path.insert(0, str(HERE.parent))
from character_agent.harness.codex_transport import CodexConfig
from character_agent.harness.pi_config import PiConfig, pi_runner_environment
from character_agent.harness.transport import runner_environment
from test_character_agent_codex import ResponsesFixture, binaries
from test_character_agent_pi import HAS_SDK as HAS_PI_SDK, NODE, RUNTIME, FixtureModel

# Every bridged harness config names the directory its own tools work in.
WORK = {"workspace_dir": tempfile.gettempdir(), "native_tools": True}


class DriveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def drive(self, scenario, argv, env, cwd=None):
        script = self.root / 'scenario.json'
        script.write_text(json.dumps(scenario), encoding='utf-8')
        result = subprocess.run([sys.executable, '-I', str(ROOT / 'protocol/C8-harness-runner/drive.py'),
                                 '--script', str(script), '--', *argv],
                                env=env, cwd=cwd, capture_output=True, text=True, timeout=65, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('C8-DRIVE ok', result.stdout)
        self.assertEqual(result.stdout.splitlines().count('tool_request'), 1, result.stdout)

    @unittest.skipUnless(binaries(), 'No verified Codex executable available')
    def test_codex_runner_tool_result_reaches_model(self):
        for binary in binaries():
            with self.subTest(binary=binary), tempfile.TemporaryDirectory() as tmp, ResponsesFixture({
                    'type': 'function_call', 'name': 'fixture_read', 'arguments': '{}'}) as fixture:
                config = CodexConfig(Path(tmp) / 'state', 'gpt-6.1-sol', 'synthetic-fixture-key', cli_path=binary,
                    runtime_source='local', base_url=fixture.url, effort='medium', **WORK)
                receipt = 'C8 Codex canned receipt confirmed.'
                scenario = {
                    'init': {'v': 1, 'type': 'init', 'config': config.wire(),
                        'system_prompt': 'Synthetic personal assistant.',
                        'tools': [{'name': 'fixture_read', 'description': 'Read synthetic fixture',
                            'input_schema': {'type': 'object', 'properties': {}, 'additionalProperties': False}}]},
                    'query': {'v': 1, 'type': 'query', 'run_id': 'fixture-run',
                        'prompt': 'Use the fixture tool, then report its result.', 'history': None},
                    'tool_results': {'fixture_read': {'result': {'content': [{'type': 'text', 'text': receipt}]},
                                                      'is_error': False}},
                }
                self.drive(scenario, [config.python, '-I', '-B', str(HARNESS / 'codex_runner.py')],
                    runner_environment(config.state_dir, auth_mode=config.auth_mode))
                self.assertEqual(len(fixture.requests), 2)
                self.assertIn(receipt, json.dumps(fixture.requests[1]['input']))

    @unittest.skipUnless(HAS_PI_SDK, 'Pinned Pi SDK unavailable; run python3 -I agent/agentd/character_agent/harness/pi_install_runtime.py --destination .local/pi-runtime --npm "$(which npm)" first')
    def test_pi_runner_tool_result_reaches_model(self):
        fixture = FixtureModel([{'name': 'receipt_check', 'args': {'id': 'e1'}}, 'Checked.'])
        self.addCleanup(fixture.close)
        config = PiConfig(self.root / 'private', 'endfield-fixture', 'fixture', node=NODE, runtime_dir=RUNTIME,
                          auth_source='none', base_url=fixture.url)
        receipt = 'C8 Pi canned receipt confirmed.'
        scenario = {
            'init': {'v': 1, 'type': 'init', 'config': config.wire(),
                'system_prompt': 'You are Mira, a concise personal companion.',
                'tools': [{'name': 'receipt_check', 'description': 'Check receipt.', 'input_schema': {
                    'type': 'object', 'properties': {'id': {'type': 'string'}}, 'required': ['id']}}]},
            'query': {'v': 1, 'type': 'query', 'run_id': 'run-1', 'prompt': 'Make a useful report.', 'history': None},
            'tool_results': {'receipt_check': {'result': {'content': [{'type': 'text', 'text': receipt}]},
                                               'is_error': False}},
        }
        self.drive(scenario, [config.node, str(HARNESS / 'pi_runner.mjs')],
            pi_runner_environment(config.state_dir), cwd=str(Path(config.state_dir).resolve() / 'workspace'))
        self.assertEqual(len(fixture.requests), 2)
        self.assertIn(receipt, json.dumps(fixture.requests[1]['messages']))


if __name__ == '__main__': unittest.main()
