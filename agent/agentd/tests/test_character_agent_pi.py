"""Real Pi SDK with a deterministic loopback model; no cloud/model-quality claim."""
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.harness.pi_config import PI_VERSION, PiConfig, pi_runner_environment, resolve_pi_runtime
from character_agent.harness.pi_transport import RUNNER, ManagedPiSession, list_models
from character_agent.harness.transport import HarnessError, join_reapers
from character_agent.services.workspace import WorkspaceService
from infra.platform import child_environment
from support import serve_in_thread

_spec = importlib.util.spec_from_file_location(
    "c8_validate", Path(__file__).resolve().parents[3] / "protocol/C8-harness-runner/validate.py")
c8 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(c8)


class _Recorded:
    """Runner process whose stdout lines are also kept for the C8 validator."""
    def __init__(self, proc, frames):
        self._proc, self._frames, self.stdout = proc, frames, self

    def readline(self, limit):
        raw = self._proc.stdout.readline(limit)
        if raw:
            self._frames.append(raw.decode())
        return raw

    def __getattr__(self, name):
        return getattr(self._proc, name)


def capture_frames(session):
    frames, read = [], session._read
    session._read = lambda proc, generation: read(_Recorded(proc, frames), generation)
    return frames


# validate() rejects the empty paths resolve_pi_runtime returns where no Pi runtime is installed.
ABSOLUTE_RUNTIME = {'node': str(Path(__file__).resolve()), 'runtime_dir': str(Path(__file__).resolve().parent)}


class PiConfigTests(unittest.TestCase):
    def config(self, **changes):
        return replace(PiConfig('/tmp/pi-test', 'openai', 'fixture', api_key='private-api-key', **ABSOLUTE_RUNTIME), **changes)

    def test_private_configuration_has_no_secret_in_repr_or_public(self):
        config = self.config()
        self.assertNotIn('private-api-key', repr(config))
        self.assertNotIn('private-api-key', json.dumps(config.public()))
        self.assertEqual(config.wire()['api_key'], 'private-api-key')

    def test_loopback_does_not_require_cloud_credentials(self):
        config = self.config(auth_source='none', api_key='', base_url='http://127.0.0.1:1234/v1')
        self.assertIs(config.validate(), config)
        with self.assertRaisesRegex(ValueError, 'requires_loopback'):
            replace(config, base_url='https://remote.example/v1').validate()

    def test_login_cannot_forward_native_credentials_to_custom_endpoint(self):
        with self.assertRaisesRegex(ValueError, 'native_login_requires_native_provider'):
            self.config(auth_source='existing_login', base_url='https://other.example/v1').validate()

    def test_config_rejects_bad_endpoints_budgets_and_relative_executables(self):
        for changes in ({'base_url': 'http://remote.example/v1'}, {'base_url': 'https://user:password@example.com'},
                        {'base_url': 'https://example.com?token=bad'}, {'node': 'node'}, {'max_turns': True},
                        {'max_budget_usd': float('nan')}, {'provider': '../openai'}, {'api': 'arbitrary-code'},
                        {'effort': 'turbo'}, {'max_output_tokens': 64}, {'max_output_tokens': True}):
            with self.subTest(changes=changes), self.assertRaises(ValueError): self.config(**changes).validate()

    def test_effort_and_output_budget_reach_the_runner(self):
        self.assertEqual((self.config().wire()['thinking_level'], self.config().wire()['max_output_tokens']), ('off', 4096))
        for effort in ('low', 'medium', 'high'):
            with self.subTest(effort=effort):
                self.assertEqual(self.config(effort=effort).wire()['thinking_level'], effort)
        self.assertEqual(self.config(max_output_tokens=16384).wire()['max_output_tokens'], 16384)

    def test_every_pi_thinking_level_and_custom_model_capabilities_reach_the_runner(self):
        for level in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'):
            with self.subTest(level=level):
                self.assertEqual(self.config(effort=level).wire()['thinking_level'], level)
        wire = self.config().wire()
        self.assertEqual((wire['context_window'], wire['reasoning']), (128000, False))
        wire = self.config(context_window=32000, reasoning=True).wire()
        self.assertEqual((wire['context_window'], wire['reasoning']), (32000, True))
        for changes in ({'context_window': 512}, {'context_window': True}, {'reasoning': 'yes'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError): self.config(**changes).validate()

    def test_tool_reminder_reaches_the_runner_and_rejects_bad_values(self):
        self.assertIsNone(self.config().wire()['tool_reminder'])
        self.assertEqual(self.config(tool_reminder='Stay in voice.').wire()['tool_reminder'], 'Stay in voice.')
        for value in ('', 'x' * 1001, 42, b'Stay in voice.'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'invalid_tool_reminder'):
                self.config(tool_reminder=value).validate()

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_app_resolution_never_uses_development_runtime(self):
        site = '/Applications/Agentic Complex.app/Contents/Resources/components/harness.pi'
        node, runtime = resolve_pi_runtime(site)
        self.assertEqual(node, site + '/node/bin/node')
        self.assertEqual(runtime, site + '/pi-runtime')

    def test_environment_excludes_foreign_auth_hooks_and_node_options(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
            'ANTHROPIC_API_KEY': 'no', 'OPENAI_API_KEY': 'no', 'NODE_OPTIONS': '--require malicious.js',
            'PI_CODING_AGENT_DIR': '/foreign', 'CODEX_HOME': '/foreign'}):
            env = pi_runner_environment(root)
            for key in ('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'CODEX_HOME'):
                self.assertNotIn(key, env)
            self.assertEqual(env['HOME'], str(Path(root).resolve() / 'home'))
            self.assertEqual(env['PI_OFFLINE'], '1')

    def test_environment_keeps_the_users_proxy_and_has_node_use_it(self):
        proxies = {'HTTP_PROXY': 'http://proxy.example:8080', 'https_proxy': 'http://proxy.example:8443',
                   'NO_PROXY': 'localhost,127.0.0.1', 'all_proxy': 'socks5://proxy.example:1080'}
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, proxies):
            env = pi_runner_environment(root)
            self.assertLessEqual(proxies.items(), env.items())
            self.assertEqual(env['NODE_USE_ENV_PROXY'], '1')

    def test_environment_without_a_proxy_leaves_node_proxy_support_off(self):
        names = [f(key) for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY') for f in (str.upper, str.lower)]
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'NODE_USE_ENV_PROXY': '1'}):
            for name in names:
                os.environ.pop(name, None)
            env = pi_runner_environment(root)
            for key in names + ['NODE_USE_ENV_PROXY']:
                self.assertNotIn(key, env)

    def test_environment_starts_from_the_platform_child_environment_with_the_users_path(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'PATH': os.pathsep.join(('/fixture/bin', '/usr/bin'))}):
            env = pi_runner_environment(root)
            base = {k: v for k, v in child_environment(Path(root).resolve() / 'tmp').items() if k != 'PATH'}
            self.assertLessEqual(base.items(), env.items())
            self.assertEqual(env['PATH'], os.pathsep.join(('/fixture/bin', '/usr/bin')))

    @unittest.skipUnless(sys.platform == "win32", "Windows install directories")
    def test_windows_environment_keeps_where_pi_finds_git_bash_and_powershell(self):
        with tempfile.TemporaryDirectory() as root:
            env = pi_runner_environment(root)
            for key in ('ProgramFiles', 'SystemRoot', 'COMSPEC', 'USERPROFILE', 'TEMP'):
                self.assertTrue(env.get(key), key)

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_posix_environment_is_the_users_path_and_nothing_else(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'SSL_CERT_FILE': '/certs.pem',
                                                                            'PATH': '/opt/homebrew/bin:/usr/bin:/bin'}):
            for key in ('SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'):
                os.environ.pop(key, None)
            state = Path(root).resolve()
            self.assertEqual(pi_runner_environment(root), {
                'PATH': '/opt/homebrew/bin:/usr/bin:/bin', 'HOME': str(state / 'home'), 'LANG': 'en_US.UTF-8',
                'TMPDIR': str(state / 'tmp'), 'PI_CODING_AGENT_DIR': str(state / 'agent'), 'PI_OFFLINE': '1',
                'DO_NOT_TRACK': '1', 'NO_COLOR': '1', 'SSL_CERT_FILE': '/certs.pem'})


class PiTransportFailureTests(unittest.TestCase):
    def queued(self, **fields):
        session = ManagedPiSession(PiConfig('/tmp/pi-test', 'openai', 'fixture', api_key='private-api-key'))
        session._queue({'type': 'result', 'run_id': 'run-1', 'success': False, 'subtype': 'model_error', **fields},
                       session._generation, None)
        return session._events.get_nowait()

    def test_length_stop_is_an_unretryable_truncation(self):
        event = self.queued(stop_reason='length', error_message='')
        self.assertEqual((event['error'], event['failure']['code'], event['failure']['retryable']),
                         ('output_truncated', 'output_truncated', False))

    def test_other_stop_reasons_keep_their_classification(self):
        event = self.queued(stop_reason='error', error_message='429: slow down')
        self.assertEqual((event['error'], event['failure']['code'], event['failure']['retryable']),
                         ('model_error', 'rate_limited', True))


class FixtureModel:
    def __init__(self, steps=None, status=200, error_message='fixture failure'):
        self.steps = list(steps or ['finished'])
        self.status, self.error_message = status, error_message
        self.requests, self.authorization = [], []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.requests.append(request)
                owner.authorization.append(self.headers.get('Authorization'))
                index = len(owner.requests) - 1
                step = owner.steps[min(index, len(owner.steps)-1)]
                if callable(step): step = step(request)
                # A {'status': ...} step answers that one request with an HTTP error.
                status = step['status'] if isinstance(step, dict) and 'status' in step else owner.status
                self.send_response(status)
                self.send_header('Content-Type', 'text/event-stream' if status == 200 else 'application/json')
                self.end_headers()
                if status != 200:
                    self.wfile.write(json.dumps({'error': {'message': owner.error_message, 'type': 'invalid_request_error'}}).encode())
                    return
                base = {'id': f'fixture-{index}', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'fixture'}
                if isinstance(step, dict):
                    delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': f'call-{index}', 'type': 'function',
                             'function': {'name': step['name'], 'arguments': json.dumps(step.get('args', {}))}}]}
                    finish = 'tool_calls'
                elif isinstance(step, tuple):
                    delta, finish = {'role': 'assistant', 'content': step[0]}, step[1]
                else:
                    delta, finish = {'role': 'assistant', 'content': step}, 'stop'
                frames = [{**base, 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]},
                          {**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}],
                           'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}}]
                try:
                    for frame in frames:
                        self.wfile.write(('data: '+json.dumps(frame)+'\n\n').encode())
                    self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError): pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = serve_in_thread(self.server)

    @property
    def url(self): return f'http://127.0.0.1:{self.server.server_port}/v1'

    def close(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)


# A stdio MCP server with one tool, echo, written to the MCP JSON-RPC framing (one message per line).
ECHO_MCP = r"""
import json, sys
TOOL = {"name": "echo", "description": "Echo text back.",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}
for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue
    method = message["method"]
    if method == "initialize":
        result = {"protocolVersion": message["params"]["protocolVersion"], "capabilities": {"tools": {}},
                  "serverInfo": {"name": "echo", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [TOOL]}
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": "echo: " + message["params"]["arguments"]["text"]}]}
    elif method == "ping":
        result = {}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": method}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
"""


# pi_runner.mjs whose setRuntimeApiKey takes 500 ms, the window an interrupt can land in before the prompt starts.
SLOW_KEY_RUNNER = """
const sdk = await import(SDK_URL);
const setKey = sdk.ModelRuntime.prototype.setRuntimeApiKey;
sdk.ModelRuntime.prototype.setRuntimeApiKey = async function (...args) {
  await new Promise(resolve => setTimeout(resolve, 500));
  return setKey.apply(this, args);
};
await import(RUNNER_URL);
"""

NODE, RUNTIME = resolve_pi_runtime()
HAS_SDK = Path(NODE).is_file() and (Path(RUNTIME) / 'node_modules/@earendil-works/pi-coding-agent/package.json').is_file()


@unittest.skipUnless(HAS_SDK, 'Pinned Pi SDK unavailable; run python3 -I agent/agentd/character_agent/harness/pi_install_runtime.py --destination .local/pi-runtime --npm "$(which npm)" first')
class PiSDKTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.resources = []

    def tearDown(self):
        for resource in reversed(self.resources): resource.close()
        # A runner still open holds files in the directory, and Windows refuses to delete them.
        join_reapers()
        self.tmp.cleanup()

    def model(self, *args, **kwargs):
        model = FixtureModel(*args, **kwargs); self.resources.append(model); return model

    def session(self, model_server=None, definitions=None, handler=None, **changes):
        config = PiConfig(self.root / 'private', 'endfield-fixture', 'fixture', node=NODE, runtime_dir=RUNTIME,
                          auth_source='none', base_url=(model_server.url if model_server else 'http://127.0.0.1:1/v1'))
        session = ManagedPiSession(replace(config, **changes), definitions, handler)
        self.resources.append(session); return session

    def run_session(self, session, prompt='Make a useful report.', **kwargs):
        return list(session.stream(prompt, system_prompt='You are Mira, a concise personal companion.', run_id='run-1', **kwargs))

    def test_real_sdk_probe_no_model_request_and_exact_tool_inventory(self):
        model = self.model()
        definitions = [{'name': 'receipt_check', 'description': 'Check an effect receipt.',
                        'input_schema': {'type': 'object', 'properties': {}}}]
        session = self.session(model, definitions)
        ready = session.probe()
        self.assertEqual(ready['sdk_version'], PI_VERSION)
        self.assertEqual(ready['tool_names'], ['receipt_check'])
        self.assertTrue(ready['tool_inventory_verified'])
        self.assertEqual(model.requests, [])

    def test_sdk_admission_uses_capabilities_instead_of_package_version(self):
        original = Path(RUNTIME) / 'node_modules/@earendil-works/pi-coding-agent'
        root = self.root / 'future-sdk'
        package = root / 'node_modules/@earendil-works/pi-coding-agent'
        package.mkdir(parents=True)
        for entry in original.iterdir():
            if entry.name != 'package.json':
                (package / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
        metadata = json.loads((original / 'package.json').read_text(encoding='utf-8'))
        metadata['version'] = '999.0.0-test'
        (package / 'package.json').write_text(json.dumps(metadata), encoding='utf-8')
        session = self.session(runtime_dir=str(root))
        ready = session.probe()
        self.assertEqual(ready['sdk_version'], '999.0.0-test')
        self.assertTrue(ready['tool_inventory_verified'])

    def test_multimodal_tool_pixels_reach_the_model_when_explicitly_supported(self):
        model = self.model([{'name': 'observation_image', 'args': {}}, 'Image inspected.'])
        definitions = [{'name': 'observation_image', 'description': 'Read authorized pixels.',
                        'input_schema': {'type': 'object', 'properties': {}}}]
        def handler(*_):
            return {'content': [{'type': 'image', 'data': 'aW1hZ2UtZml4dHVyZQ==', 'mimeType': 'image/png'}]}
        session = self.session(model, definitions, handler, supports_images=True)
        self.assertIn('image', session.probe()['modalities'])
        result = self.run_session(session)
        self.assertTrue(result[-1]['success'], result)
        self.assertIn('data:image/png;base64,aW1hZ2UtZml4dHVyZQ==', json.dumps(model.requests[1]))

    def test_text_only_model_does_not_claim_an_observation_image_read(self):
        model = self.model([{'name': 'observation_image', 'args': {}}, 'Image unavailable.'])
        definitions = [{'name': 'observation_image', 'description': 'Read authorized pixels.',
                        'input_schema': {'type': 'object', 'properties': {}}}]
        calls = []
        session = self.session(model, definitions, lambda *args: calls.append(args) or {})
        events = self.run_session(session)
        self.assertTrue(events[-1]['success'], events)
        self.assertEqual(calls, [])
        self.assertIn('model_images_unavailable', json.dumps(model.requests[1]))
        self.assertFalse(any(e['type'] == 'tool_started' for e in events))

    def test_large_multimodal_tool_payload_is_forwarded_without_the_old_two_mib_limit(self):
        import base64
        # Transport bytes only, not a visual-recognition/model-quality fixture.
        encoded = base64.b64encode(b'large-image-transport-fixture' * 100000).decode()
        self.assertGreater(len(encoded), 2 * 1024 * 1024)
        model = self.model([{'name': 'observation_image', 'args': {}}, 'Image received.'])
        definitions = [{'name': 'observation_image', 'description': 'Read authorized pixels.',
                        'input_schema': {'type': 'object', 'properties': {}}}]
        session = self.session(model, definitions,
            lambda *_: {'content': [{'type': 'image', 'data': encoded, 'mimeType': 'image/png'}]}, supports_images=True)
        events = self.run_session(session)
        self.assertTrue(events[-1]['success'], events[-1])
        self.assertIn(encoded, json.dumps(model.requests[1]))

    def test_personal_prompt_history_and_no_ambient_resources_or_persistent_transcript(self):
        model = self.model()
        session = self.session(model)
        ambient = self.root / 'private' / 'workspace'
        ambient.mkdir(parents=True)
        (ambient / 'AGENTS.md').write_text('FOREIGN_PROMPT_SENTINEL', encoding='utf-8')
        marker = self.root / 'extension-executed'
        extensions = self.root / 'private' / 'agent' / 'extensions'; extensions.mkdir(parents=True)
        (extensions / 'trap.mjs').write_text('import fs from "node:fs"; fs.writeFileSync('+json.dumps(str(marker))+',"ran"); export default () => {};', encoding='utf-8')
        events = self.run_session(session, history=[[{'role': 'user', 'content': 'What did we settle on?'},
                                                    {'role': 'assistant', 'content': 'Earlier confirmed plan.'}]])
        self.assertTrue(events[-1]['success'], events)
        payload = json.dumps(model.requests[0])
        self.assertIn('Mira', payload); self.assertIn('Earlier confirmed plan.', payload)
        self.assertNotIn('FOREIGN_PROMPT_SENTINEL', payload)
        self.assertFalse(marker.exists())
        self.assertFalse(model.requests[0].get('tools'))
        self.assertFalse(list((self.root / 'private').rglob('*.jsonl')))
        self.assertFalse(list((self.root / 'private').rglob('auth.json')))

    HISTORY = [[{'role': 'user', 'content': 'What did we settle on?'}, {'role': 'assistant', 'content': 'Earlier confirmed plan.'}],
               [{'role': 'user', 'content': 'And the time?'}, {'role': 'assistant', 'content': 'Seven sharp.'}]]
    HISTORY_TURNS = [('user', 'What did we settle on?'), ('assistant', 'Earlier confirmed plan.'),
                     ('user', 'And the time?'), ('assistant', 'Seven sharp.')]

    @staticmethod
    def conversation(request):
        text = lambda content: content if isinstance(content, str) else ''.join(part.get('text', '') for part in content or [])
        return [(m['role'], text(m.get('content'))) for m in request['messages']]

    def turns(self, request, system):
        """The request's messages after its one leading system prompt, as (role, text)."""
        [(role, head), *messages] = self.conversation(request)
        self.assertEqual(role, 'system'); self.assertTrue(head.startswith(system), head)
        return messages

    def assert_own_system(self, request, system):
        """The request's one system message: the session's prompt and the workspace Pi names after it."""
        heads = [text for role, text in self.conversation(request) if role == 'system']
        self.assertEqual(len(heads), 1, heads)
        self.assertRegex(heads[0], '^' + re.escape(system) + r'\n\n<cwd>\n[^\n]+\n</cwd>$')

    def test_history_reaches_the_model_as_its_own_turns(self):
        model = self.model()
        events = self.run_session(self.session(model), 'Remind me.', history=self.HISTORY)
        self.assertTrue(events[-1]['success'], events)
        self.assert_own_system(model.requests[0], 'You are Mira, a concise personal companion.')
        self.assertEqual(self.turns(model.requests[0], 'You are Mira, a concise personal companion.'),
                         [*self.HISTORY_TURNS, ('user', 'Remind me.')])
        self.assertNotIn('product_history', json.dumps(model.requests[0]))

    def test_history_stays_after_the_system_prompt_on_a_model_that_takes_later_system_messages(self):
        model = self.model(['Seven sharp, as planned.', 'Done.'])
        session = self.session(model, provider='deepseek', model='deepseek-v4-pro', auth_source='api_key', api_key='fixture-key')
        self.assertTrue(self.run_session(session, 'Remind me.', history=self.HISTORY)[-1]['success'])
        self.assertTrue(list(session.stream('Thanks.', system_prompt='You are Mira, a concise personal companion.', run_id='run-2'))[-1]['success'])
        system = 'You are Mira, a concise personal companion.'
        self.assertEqual(self.turns(model.requests[0], system), [*self.HISTORY_TURNS, ('user', 'Remind me.')])
        self.assertEqual(self.turns(model.requests[1], system), [*self.HISTORY_TURNS, ('user', 'Remind me.'),
                         ('assistant', 'Seven sharp, as planned.'), ('user', 'Thanks.')])

    def test_quick_reply_history_reaches_the_model_as_its_own_turns(self):
        model = self.model(['First answer.', 'Quick answer.'])
        session = self.session(model)
        self.assertTrue(self.run_session(session, 'First.')[-1]['success'])
        events = list(session.stream('Quick one.', system_prompt='You are Mira, answering quickly.', run_id='run-2',
                                     history=self.HISTORY, replace_history=True))
        self.assertTrue(events[-1]['success'], events)
        self.assertEqual(self.turns(model.requests[1], 'You are Mira, answering quickly.'),
                         [*self.HISTORY_TURNS, ('user', 'Quick one.')])
        self.assertEqual([turn for turn in self.conversation(model.requests[1]) if turn[0] == 'system'],
                         [('system', 'You are Mira, answering quickly.')])
        self.assertNotIn('expert coding assistant', json.dumps(model.requests[1]))
        self.assertNotIn('product_history', json.dumps(model.requests[1]))

    def test_question_resume_history_reaches_the_model_as_its_own_turns(self):
        model = self.model()
        definition = {'name': 'ask_user', 'description': 'Ask a question.', 'input_schema': {'type': 'object'}}
        events = self.run_session(self.session(model, [definition]), prompt='original-goal', history=self.HISTORY, ask_user_result={
            'name': 'ask_user', 'tool_call_id': 'original-call', 'args': {'questions': [{'id': 'q', 'question': 'private-question'}]},
            'result': {'answers': {'q': ['real-answer']}}})
        self.assertTrue(events[-1]['success'], events)
        self.assert_own_system(model.requests[0], 'You are Mira, a concise personal companion.')
        turns = self.turns(model.requests[0], 'You are Mira, a concise personal companion.')
        self.assertEqual(turns[:5], [*self.HISTORY_TURNS, ('user', 'original-goal')])
        self.assertEqual([role for role, _ in turns[5:]], ['assistant', 'tool'])
        self.assertNotIn('product_history', json.dumps(model.requests[0]))

    def test_tool_callback_context_and_receipt_return_to_model(self):
        model = self.model([{'name': 'receipt_check', 'args': {'id': 'e1'}}, 'Checked.'])
        calls = []
        class Handler:
            def call_with_context(self, name, args, context):
                calls.append((name, args, context))
                return {'content': [{'type': 'text', 'text': 'Readback confirmed.'}],
                        'effect_receipt': {'id': 'e1', 'status': 'committed'}}
        definitions = [{'name': 'receipt_check', 'description': 'Check receipt.', 'input_schema': {
            'type': 'object', 'properties': {'id': {'type': 'string'}}, 'required': ['id']}}]
        events = self.run_session(self.session(model, definitions, Handler()))
        self.assertTrue(events[-1]['success'], events)
        self.assertEqual(calls, [('receipt_check', {'id': 'e1'}, {'tool_call_id': 'call-0', 'run_id': 'run-1'})])
        self.assertIn('effect_receipt', json.dumps(model.requests[1]['messages']))
        self.assertEqual(events[-1]['final_text'], 'Checked.')
        self.assertEqual(events[-1]['num_turns'], 2)
        self.assertEqual(events[-1]['usage']['input_tokens'], 20)
        self.assertEqual(events[-1]['usage']['output_tokens'], 10)
        self.assertEqual(events[-1]['context_tokens'], 10)
        self.assertIsNone(events[-1]['cost_usd'])

    def reminder_run(self, reminder):
        model = self.model([{'name': 'receipt_check', 'args': {'id': 'e1'}}, 'Checked.', 'Again.'])
        definitions = [{'name': 'receipt_check', 'description': 'Check receipt.', 'input_schema': {
            'type': 'object', 'properties': {'id': {'type': 'string'}}, 'required': ['id']}}]
        session = self.session(model, definitions, lambda *_: {'content': [{'type': 'text', 'text': 'Readback confirmed.'}]},
                               tool_reminder=reminder)
        self.assertTrue(self.run_session(session)[-1]['success'])
        # A later run sends the session's transcript again.
        self.assertTrue(list(session.stream('Next.', system_prompt='You are Mira, a concise personal companion.', run_id='run-2'))[-1]['success'])
        return model.requests

    def test_tool_reminder_rides_only_the_call_after_a_tool_result_and_stays_out_of_the_transcript(self):
        reminder = 'Speak as Mira in your own voice.'
        first, after_tool, next_run = self.reminder_run(reminder)
        self.assertNotIn(reminder, json.dumps(first))
        self.assertEqual(after_tool['messages'][-1], {'role': 'tool', 'tool_call_id': 'call-0',
                                                      'content': 'Readback confirmed.\n' + reminder})
        self.assertNotIn(reminder, json.dumps(next_run))
        self.assertIn('Readback confirmed.', json.dumps(next_run))

    def test_without_tool_reminder_the_requests_are_unchanged(self):
        reminder = 'Speak as Mira in your own voice.'
        on, off = self.reminder_run(reminder), self.reminder_run(None)
        self.assertEqual(off[1]['messages'][-1], {'role': 'tool', 'tool_call_id': 'call-0', 'content': 'Readback confirmed.'})
        on[1]['messages'][-1]['content'] = on[1]['messages'][-1]['content'].removesuffix('\n' + reminder)
        self.assertEqual(off, on)

    def test_runner_frames_follow_c8(self):
        model = self.model([{'name': 'receipt_check', 'args': {'id': 'e1'}}, 'Checked.'])
        definitions = [{'name': 'receipt_check', 'description': 'Check receipt.', 'input_schema': {
            'type': 'object', 'properties': {'id': {'type': 'string'}}, 'required': ['id']}}]
        session = self.session(model, definitions, lambda *_: {'ok': True})
        frames = capture_frames(session)
        events = self.run_session(session)
        self.assertTrue(events[-1]['success'], events)
        kinds = [json.loads(frame)['type'] for frame in frames]
        self.assertEqual((kinds[0], kinds[-1]), ('ready', 'result'))
        self.assertIn('tool_request', kinds)
        self.assertIsNone(c8.check(frames))
        self.assertEqual((session.capabilities['usage'], session.capabilities['native_questions']), ('tokens', False))

    def test_question_resume_delivers_original_structured_tool_result(self):
        model = self.model()
        definition = {'name': 'ask_user', 'description': 'Ask a question.', 'input_schema': {'type': 'object'}}
        events = self.run_session(self.session(model, [definition]), prompt='original-goal', ask_user_result={
            'name': 'ask_user', 'tool_call_id': 'original-call',
            'args': {'questions': [{'id': 'q', 'question': 'private-question'}]},
            'result': {'answers': {'q': ['real-answer']}}})
        self.assertTrue(events[-1]['success'], events)
        messages = model.requests[0]['messages']
        [result] = [m for m in messages if m['role'] == 'tool']
        self.assertEqual(result['tool_call_id'], 'original-call')
        self.assertEqual(json.loads(result['content']), {'answers': {'q': ['real-answer']}})
        self.assertNotIn('private-question', json.dumps([m for m in messages if m['role'] == 'user']))

    def test_real_artifact_write_and_verify_with_sdk_tools(self):
        inputs = self.root / 'inputs'; inputs.mkdir(); (inputs / 'notes.md').write_text('Two guests.\n', encoding='utf-8')
        service = WorkspaceService(self.root / 'workspace-state'); self.resources.append(service)
        scope = service.create_scope([str(inputs)], str(self.root / 'outputs'))['scope_id']
        model = self.model([{'name': 'artifact_write', 'args': {'path': 'plan.md', 'content': '# Plan\nInvite two guests.', 'source_refs': []}},
                            {'name': 'artifact_verify', 'args': {'path': 'plan.md', 'checks': {'required_sections': ['Plan']}}},
                            'The report exists and passed its checks.'])
        class Handler:
            def call_with_context(self, name, args, context):
                return service.call(name, args, scope_id=scope, run_id=context['run_id'], effect_id=context['tool_call_id'])
        events = self.run_session(self.session(model, service.tool_definitions(sources=False), Handler()))
        self.assertTrue(events[-1]['success'], events)
        result = service.verify_run('run-1', scope)
        self.assertTrue(result['ok'], result); self.assertTrue(result['self_checked'], result)
        self.assertEqual(len(service.run_artifacts('run-1')), 1)
        sent_tools = [x['function']['name'] for x in model.requests[0]['tools']]
        self.assertEqual(set(sent_tools), {x['name'] for x in service.tool_definitions(sources=False)})
        self.assertNotIn('bash', sent_tools); self.assertNotIn('read', sent_tools)

    def test_builtin_call_without_native_tools_never_reaches_host(self):
        marker = self.root / 'forbidden-write'
        model = self.model([{'name': 'write', 'args': {'path': str(marker), 'content': 'forbidden'}}, 'Cannot do that.'])
        calls = []
        events = self.run_session(self.session(model, handler=lambda *args: calls.append(args)))
        self.assertEqual(calls, [])
        self.assertEqual([e for e in events if e['type'] == 'tool_started'], [])
        self.assertFalse(marker.exists())

    def test_host_tools_cannot_collide_with_builtin_names(self):
        definitions = [{'name': 'bash', 'description': 'Pretend custom.', 'input_schema': {'type': 'object'}}]
        with self.assertRaisesRegex(HarnessError, 'invalid_tool_inventory'):
            self.session(definitions=definitions).probe()

    def workspace_session(self, model_server, definitions=None, handler=None, permission=None, **changes):
        """Pi's own tools on, in a Workspace of its own; permission answers its approval cards.
        The user's Pi configuration is self.root / 'user-pi' (its mcp.json, skills/)."""
        workspace = self.root / 'Workspace'; workspace.mkdir(exist_ok=True)
        user = self.root / 'user-pi'
        session = self.session(model_server, definitions, handler, native_tools=True, workspace_dir=str(workspace),
                               user_agent_dir=str(user), skill_dirs=(str(user / 'skills'),), **changes)
        session.permission_handler = permission
        return session, workspace

    def test_builtin_write_lands_in_the_workspace_without_a_card_when_approval_is_off(self):
        model = self.model([{'name': 'write', 'args': {'path': 'plan.md', 'content': '# Plan\n'}}, 'Written.'])
        definitions = [{'name': 'receipt_check', 'description': 'Check an effect receipt.',
                        'input_schema': {'type': 'object', 'properties': {}}}]
        asked = []
        session, workspace = self.workspace_session(model, definitions, permission=asked.append, tool_approval=False)
        ready = session.probe()
        self.assertLessEqual({'read', 'bash', 'edit', 'write', 'ls'}, set(ready['builtin_tools']))
        self.assertEqual(ready['tool_names'], sorted(ready['builtin_tools'] + ['receipt_check']))
        self.assertEqual((ready['tool_approval'], ready['workspace_dir'], ready['capabilities']['builtin_tools']),
                         (False, str(workspace), 'unverified'))
        self.assertTrue(ready['shell']['bash'])
        events = self.run_session(session)
        self.assertTrue(events[-1]['success'], events)
        self.assertEqual((workspace / 'plan.md').read_text(encoding='utf-8'), '# Plan\n')
        self.assertEqual(asked, [])
        self.assertFalse([e for e in events if e['type'] == 'permission_requested'])
        self.assertIn('write', [t['function']['name'] for t in model.requests[0]['tools']])

    def test_refused_card_blocks_the_builtin_and_the_model_sees_the_refusal(self):
        model = self.model([{'name': 'write', 'args': {'path': 'plan.md', 'content': 'draft'}}, 'Not allowed.'])
        asked = []
        session, workspace = self.workspace_session(model, permission=lambda request: asked.append(request))
        self.assertIs(session.probe()['tool_approval'], True)
        events = self.run_session(session)
        self.assertTrue(events[-1]['success'], events)
        self.assertFalse((workspace / 'plan.md').exists())
        [request] = asked
        self.assertEqual((request['title'], request['kind'], request['locations'], request['raw_input']),
                         ('write: plan.md', 'edit', [str(workspace / 'plan.md')], {'path': 'plan.md', 'content': 'draft'}))
        self.assertIn('The user did not allow this call.', json.dumps(model.requests[1]['messages']))

    def test_allowed_card_runs_the_builtin_and_reads_need_no_card(self):
        model = self.model([{'name': 'read', 'args': {'path': 'notes.md'}},
                            {'name': 'write', 'args': {'path': 'plan.md', 'content': 'draft'}}, 'Written.'])
        asked = []
        session, workspace = self.workspace_session(model, permission=lambda request: asked.append(request) or 'allow_once')
        (workspace / 'notes.md').write_text('Two guests.', encoding='utf-8')
        events = self.run_session(session)
        self.assertTrue(events[-1]['success'], events)
        self.assertEqual((workspace / 'plan.md').read_text(encoding='utf-8'), 'draft')
        self.assertEqual([request['title'] for request in asked], ['write: plan.md'])
        self.assertIn('Two guests.', json.dumps(model.requests[1]['messages']))

    def test_the_users_mcp_server_waits_for_a_card_and_their_skills_are_listed(self):
        user = self.root / 'user-pi'
        skill = user / 'skills' / 'trip-notes'; skill.mkdir(parents=True)
        (skill / 'SKILL.md').write_text('---\nname: trip-notes\ndescription: Write trip notes. Use when the user plans a trip.\n---\n\n'
                                        'List the stops first.\n', encoding='utf-8')
        server = self.root / 'echo_mcp.py'; server.write_text(ECHO_MCP, encoding='utf-8')
        (user / 'mcp.json').write_text(json.dumps({'mcpServers': {'echo': {
            'command': sys.executable, 'args': ['-I', str(server)], 'exposure': 'direct'}}}), encoding='utf-8')
        model = self.model([{'name': 'mcp__echo__echo', 'args': {'text': 'hi'}}, 'Echoed.'])
        asked = []
        session, _ = self.workspace_session(model, permission=lambda request: asked.append(request) or 'allow_once')
        events = self.run_session(session)
        self.assertTrue(events[-1]['success'], events)
        [request] = asked
        self.assertEqual((request['title'], request['kind'], request['locations'], request['raw_input']),
                         ('mcp__echo__echo', 'other', None, {'text': 'hi'}))
        self.assertIn('mcp__echo__echo', [t['function']['name'] for t in model.requests[0]['tools']])
        # As JSON escapes it: a Windows path's backslashes are doubled.
        self.assertIn(json.dumps(str(skill / 'SKILL.md'))[1:-1], json.dumps(model.requests[0]['messages']))
        self.assertIn('echo: hi', json.dumps(model.requests[1]['messages']))

    def test_a_refused_card_keeps_a_codemode_mcp_call_from_reaching_the_server(self):
        user = self.root / 'user-pi'; user.mkdir()
        server = self.root / 'echo_mcp.py'; server.write_text(ECHO_MCP, encoding='utf-8')
        (user / 'mcp.json').write_text(json.dumps({'mcpServers': {'echo': {
            'command': sys.executable, 'args': ['-I', str(server)]}}}), encoding='utf-8')
        model = self.model([{'name': 'codemode', 'args': {'code': 'return await tools.mcp__echo__echo({text: "hi"})'}},
                            'Not allowed.'])
        asked = []
        session, _ = self.workspace_session(model, permission=lambda request: asked.append(request['title']))
        events = self.run_session(session)
        self.assertTrue(events[-1]['success'], events)
        self.assertEqual(asked, ['mcp__echo__echo'])
        self.assertIn('The user did not allow this call.', json.dumps(model.requests[1]['messages']))
        self.assertNotIn('echo: hi', json.dumps(model.requests[1]['messages']))

    def test_a_large_write_still_gets_a_card_the_approval_store_accepts(self):
        from character_agent.services.interactions import encoded
        content = '长文本\n' * 12500
        model = self.model([{'name': 'write', 'args': {'path': 'big.txt', 'content': content}}, 'Written.'])
        asked = []
        session, workspace = self.workspace_session(model, permission=lambda request: asked.append(request) or 'allow_once')
        events = self.run_session(session)
        self.assertTrue(events[-1]['success'], events)
        [request] = asked
        preview = {key: request[key] for key in ('title', 'kind', 'locations', 'raw_input')}
        self.assertLess(len(encoded(preview)), 32000)
        self.assertEqual((request['raw_input']['path'], request['raw_input']['truncated']), ('big.txt', True))
        self.assertTrue(content.startswith(request['raw_input']['content']))
        self.assertEqual((workspace / 'big.txt').read_text(encoding='utf-8'), content)

    def test_unanswered_card_refuses_when_it_times_out(self):
        model = self.model([{'name': 'bash', 'args': {'command': 'echo ran > ran.txt'}}, 'Timed out.'])
        session, workspace = self.workspace_session(model, permission=lambda request: time.sleep(1.5) or 'allow_once',
                                                    permission_timeout=0.3)
        events = self.run_session(session)
        self.assertTrue(events[-1]['success'], events)
        self.assertFalse((workspace / 'ran.txt').exists())
        self.assertIn('The user did not allow this call.', json.dumps(model.requests[1]['messages']))

    @unittest.skipUnless(sys.platform == 'win32', 'Windows shells')
    def test_windows_enables_powershell_and_bash_only_where_pi_finds_one(self):
        ready = self.workspace_session(self.model())[0].probe()
        self.assertIn('powershell', ready['builtin_tools'])
        self.assertRegex(ready['shell']['powershell'], r'(?i)(pwsh|powershell)\.exe$')
        self.assertEqual('bash' in ready['builtin_tools'], ready['shell']['bash'] is not None, ready['shell'])

    def test_shell_and_slash_syntax_are_only_model_input(self):
        marker = self.root / 'shell-executed'
        model = self.model()
        events = self.run_session(self.session(model), '!touch ' + str(marker))
        self.assertTrue(events[-1]['success']); self.assertFalse(marker.exists())
        self.assertIn('!touch', json.dumps(model.requests[0]))

    def test_an_interrupt_while_the_query_sets_its_key_never_reaches_the_model(self):
        model = self.model()
        runner = self.root / 'slow_key_runner.mjs'
        sdk = Path(RUNTIME) / 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'
        runner.write_text(SLOW_KEY_RUNNER.replace('SDK_URL', json.dumps(sdk.as_uri()))
                          .replace('RUNNER_URL', json.dumps(RUNNER.as_uri())), encoding='utf-8')
        config = PiConfig(self.root / 'private', 'endfield-fixture', 'fixture', node=NODE, runtime_dir=RUNTIME,
                          auth_source='none', base_url=model.url)
        session = ManagedPiSession(config, runner_path=runner, credential=lambda: 'fixture-key')
        self.resources.append(session)
        cancel = threading.Event()
        stream = session.stream('Make a useful report.', system_prompt='You are Mira.', run_id='run-1', cancelled=cancel)
        self.assertEqual(next(stream)['type'], 'ready')
        threading.Timer(.2, cancel.set).start()
        self.assertEqual(list(stream)[-1]['subtype'], 'cancelled')
        self.assertEqual(model.requests, [])

    def test_model_error_cannot_be_reported_as_success(self):
        events = self.run_session(self.session(self.model(status=401)))
        self.assertFalse(events[-1]['success']); self.assertEqual(events[-1]['subtype'], 'model_error')

    def test_model_error_text_becomes_a_failure_code_and_stays_out_of_the_frame(self):
        cases = ((429, 'The ChatGPT user has reached their Subscription Sharing usage limit.', 'quota_exhausted'),
                 (401, 'Incorrect API key provided.', 'auth_expired'))
        for status, message, code in cases:
            with self.subTest(status=status):
                result = self.run_session(self.session(self.model(status=status, error_message=message)))[-1]
                self.assertEqual((result['success'], result['error'], result['failure']['code']), (False, 'model_error', code))
                self.assertNotIn(message, json.dumps(result))

    def test_long_context_keeps_the_full_output_limit(self):
        model = self.model()
        events = self.run_session(self.session(model), 'x' * 120000)
        self.assertTrue(events[-1]['success'], events[-1])
        request = model.requests[0]
        self.assertEqual(request.get('max_completion_tokens', request.get('max_tokens')), 4096)

    def test_custom_endpoint_uses_the_configured_output_budget(self):
        model = self.model()
        events = self.run_session(self.session(model, max_output_tokens=16384))
        self.assertTrue(events[-1]['success'], events[-1])
        request = model.requests[0]
        self.assertEqual(request.get('max_completion_tokens', request.get('max_tokens')), 16384)

    def catalog_session(self, model_server=None, **changes):
        return self.session(model_server, provider='deepseek', model='deepseek-flash', auth_source='api_key',
                            api_key='fixture-key', **changes)

    def test_catalog_address_keeps_the_catalog_model(self):
        ready = self.catalog_session(base_url='https://api.deepseek.com').probe()
        self.assertEqual((ready['modalities'], ready['cost_tracking'], ready['capabilities']['usage']),
                         (['text', 'image'], 'provider_catalog_estimate', 'usd'))

    def test_catalog_provider_behind_another_address_keeps_reasoning_limits_and_prices(self):
        model = self.model()
        events = self.run_session(self.catalog_session(model, effort='high'))
        result = events[-1]
        self.assertTrue(result['success'], result)
        request = model.requests[0]
        self.assertNotEqual(request.get('max_completion_tokens', request.get('max_tokens')), 4096)
        self.assertEqual(request.get('reasoning_effort'), 'high')
        self.assertEqual((result['cost_tracking'], result['cost_source']), ('provider_catalog_estimate', 'sdk_estimate'))
        self.assertGreater(result['cost_usd'], 0)

    def test_unlisted_model_of_a_catalog_provider_runs_behind_its_address(self):
        model = self.model()
        result = self.run_session(self.session(model, provider='deepseek', model='gateway-model', auth_source='api_key',
                                               api_key='fixture-key'))[-1]
        self.assertTrue(result['success'], result)
        self.assertEqual((result['cost_tracking'], result['cost_usd']), ('unpriced_custom_endpoint', None))

    def test_custom_endpoint_thinks_only_when_its_model_is_marked_reasoning(self):
        for reasoning, sent in ((False, None), (True, 'high')):
            with self.subTest(reasoning=reasoning):
                model = self.model()
                result = self.run_session(self.session(model, effort='high', reasoning=reasoning))[-1]
                self.assertTrue(result['success'], result)
                self.assertEqual(model.requests[0].get('reasoning_effort'), sent)

    def test_offline_catalog_lists_a_providers_models_with_their_sdk_capabilities(self):
        catalog = list_models(NODE, RUNTIME, self.root / 'catalog', 'deepseek')
        flash = next(m for m in catalog['models'] if m['id'] == 'deepseek-flash')
        self.assertEqual(flash, {'id': 'deepseek-flash', 'name': 'DeepSeek V4.1 Flash', 'context_window': 1000000,
                                 'max_tokens': 384000, 'input': ['text', 'image'], 'reasoning': True,
                                 'thinking_levels': ['off', 'low', 'high', 'max'], 'priced': True})
        self.assertEqual(list_models(NODE, RUNTIME, self.root / 'catalog', None)['models'], [])

    def test_offline_catalog_providers_take_a_key_and_run_without_the_pruned_sdks(self):
        ids = [p['id'] for p in list_models(NODE, RUNTIME, self.root / 'catalog', None)['providers']]
        self.assertTrue({'anthropic', 'deepseek', 'openrouter', 'groq', 'mistral', 'zai'} <= set(ids), ids)
        for dropped in ('google', 'google-vertex', 'amazon-bedrock', 'openai-codex', 'typesafe'):
            self.assertNotIn(dropped, ids)
        apis = {m['id'] for m in list_models(NODE, RUNTIME, self.root / 'catalog', 'opencode')['models']}
        self.assertTrue(apis)
        self.assertFalse(any(m.startswith('gemini') for m in apis), apis)

    def test_offline_catalog_without_an_sdk_is_a_runner_error(self):
        with self.assertRaisesRegex(ValueError, 'pi_runner_error'):
            list_models(NODE, str(self.root / 'no-runtime'), self.root / 'catalog', 'deepseek')

    def test_catalog_prices_reach_the_budget_limit(self):
        result = self.run_session(self.catalog_session(self.model(), max_budget_usd=1e-9))[-1]
        self.assertEqual((result['success'], result['subtype']), (False, 'max_budget'))

    def test_model_error_is_retried_with_the_sdk_defaults(self):
        model = self.model([{'status': 503}, 'Recovered.'])
        events = self.run_session(self.session(model))
        self.assertTrue(events[-1]['success'], events[-1])
        self.assertEqual(len(model.requests), 2)

    def test_truncated_reply_has_its_own_failure_code_and_keeps_streamed_text(self):
        events = self.run_session(self.session(self.model([('Half a sent', 'length')])))
        result = events[-1]
        self.assertEqual((result['success'], result['error'], result['failure']['code'], result['failure']['retryable']),
                         (False, 'output_truncated', 'output_truncated', False))
        self.assertEqual(result['final_text'], 'Half a sent')

    def test_max_turns_prevents_host_side_effect_after_limit(self):
        model = self.model([{'name': 'effect', 'args': {}}])
        calls = []
        definitions = [{'name': 'effect', 'description': 'A host effect.', 'input_schema': {'type': 'object', 'properties': {}}}]
        events = self.run_session(self.session(model, definitions, lambda *args: calls.append(args), max_turns=1))
        self.assertEqual(calls, []); self.assertFalse(events[-1]['success'])
        self.assertEqual(events[-1]['subtype'], 'max_turns')

    def test_cancel_while_tool_waits_and_concurrent_input_rejected(self):
        model = self.model([{'name': 'wait_for_consent', 'args': {}}, 'Should not continue.'])
        entered = threading.Event(); release = threading.Event(); result = []
        def handler(*_): entered.set(); release.wait(5); return {'ok': True}
        definitions = [{'name': 'wait_for_consent', 'description': 'Wait.', 'input_schema': {'type': 'object', 'properties': {}}}]
        session = self.session(model, definitions, handler)
        worker = threading.Thread(target=lambda: result.extend(self.run_session(session)), daemon=True); worker.start()
        self.assertTrue(entered.wait(5))
        with self.assertRaisesRegex(HarnessError, 'run_busy'):
            self.run_session(session, 'Second input')
        session.interrupt(); worker.join(5); release.set()
        self.assertFalse(worker.is_alive()); self.assertFalse(result[-1]['success'])
        self.assertEqual(result[-1]['subtype'], 'cancelled')
        self.assertEqual(len(model.requests), 1)

    def test_a_steer_while_a_tool_waits_reaches_the_next_model_request_after_the_tool_result(self):
        model = self.model([{'name': 'wait_for_consent', 'args': {}}, 'Changed course.'])
        entered = threading.Event(); release = threading.Event(); result = []
        def handler(*_): entered.set(); release.wait(5); return {'ok': True}
        definitions = [{'name': 'wait_for_consent', 'description': 'Wait.', 'input_schema': {'type': 'object', 'properties': {}}}]
        session = self.session(model, definitions, handler)
        self.assertEqual(session.steer('change of plan'), (False, 'no_active_run'))
        worker = threading.Thread(target=lambda: result.extend(self.run_session(session)), daemon=True); worker.start()
        self.assertTrue(entered.wait(5))
        try:
            self.assertEqual(session.steer('change of plan', run_id='run-1'), (True, None))
        finally:
            release.set()
        worker.join(10)
        self.assertTrue(result[-1]['success'], result)
        self.assertNotIn('steer_result', [event['type'] for event in result])
        self.assertEqual(len(model.requests), 2)
        self.assertEqual([m['role'] for m in model.requests[1]['messages']][-2:], ['tool', 'user'])
        self.assertIn(model.requests[1]['messages'][-1]['content'], ('change of plan', [{'type': 'text', 'text': 'change of plan'}]))
        self.assertEqual(session.steer('too late', run_id='run-1'), (False, 'no_active_run'))

    def test_invalidate_recreates_native_session_with_product_history(self):
        model = self.model(['first', 'resumed'])
        session = self.session(model)
        first = self.run_session(session)[-1]['session_id']
        session.invalidate()
        second = self.run_session(session, history=[[{'role': 'user', 'content': 'Confirmed durable checkpoint.'},
                                                     {'role': 'assistant', 'content': 'Noted.'}]])[-1]
        self.assertNotEqual(first, second['session_id'])
        self.assertIn('Confirmed durable checkpoint.', json.dumps(model.requests[-1]))

    def test_login_without_a_key_never_falls_back_to_a_pi_login_file(self):
        for directory in (self.root / 'private' / 'home' / '.pi' / 'agent', self.root / 'private' / 'agent'):
            directory.mkdir(parents=True)
            (directory / 'auth.json').write_text(json.dumps({'anthropic': {'type': 'api_key', 'key': 'foreign-key'}}), encoding='utf-8')
        session = self.session(auth_source='existing_login', base_url=None, provider='anthropic', model='claude-sonnet-4-5')
        self.assertFalse(session.probe()['authenticated'])
        with self.assertRaisesRegex(ValueError, 'credentials_missing'): self.run_session(session)

    def test_each_query_uses_the_key_it_carries(self):
        model = self.model(['first', 'second'])
        keys = iter(['query-key-1', 'query-key-2'])
        session = self.session(model, auth_source='api_key', api_key='init-key')
        session.credential = lambda: next(keys)
        first = self.run_session(session)[-1]
        second = list(session.stream('Again.', system_prompt='You are Mira, a concise personal companion.', run_id='run-2'))[-1]
        self.assertTrue(first['success'], first); self.assertTrue(second['success'], second)
        self.assertEqual(first['session_id'], second['session_id'])
        self.assertEqual(model.authorization, ['Bearer query-key-1', 'Bearer query-key-2'])

if __name__ == '__main__': unittest.main()
