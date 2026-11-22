"""Quick replies through /say and the UI's prewarm endpoint, without a listening socket."""
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from brain.parser import parse_command
from character_agent.services.settings import RuntimeSettings
from models.model_backends import ModelSettings
from traces.trace_store import TraceStore
from test_character_agent_pi import HAS_SDK
import test_character_agent_semantic as fixture
from test_character_agent_runtime import FakeSession, chat
from test_runtime_routes import route
from test_plugin_routes import request


class QuickTests(unittest.TestCase):
    def setUp(self):
        fixture.SemanticTests.setUp(self)
        self.server.trace = TraceStore(self.db, 1, lock=self.server.history.lock)
        self.server.server_port = 48810
        self.script = chat

    tearDown = fixture.SemanticTests.tearDown

    def factory(self, definitions):
        self.definitions.append(definitions)
        session = FakeSession(lambda *args: self.script(*args))
        session.prewarm = Mock()
        self.sessions.append(session)
        return session

    def say(self, text):
        status, body = self.server.say(text)
        self.assertEqual(status, 202, body)
        deadline = time.monotonic() + 3
        while self.server._live_lines and time.monotonic() < deadline:
            time.sleep(.005)
        self.assertFalse(self.server._live_lines)
        events = [e['data'] for e in self.server.feed.since(0) if e['event'] == 'line' and
                  e['data']['line_id'] == body['line_id']]
        self.assertTrue(events[-1]['final'])
        self.assertIsNone(events[-1]['error'])
        self.assertNotIn('route', body)
        self.assertTrue(all('route' not in e for e in events))
        row = self.db.execute("SELECT event FROM trace_events WHERE kind='turn.settled' AND turn_id=?",
                              (body['line_id'],)).fetchone()
        return events, json.loads(row[0])['attrs'].get('route')

    def test_routing_table(self):
        from daemon.turns import foreground_route
        for text, options, expected in [
            ('早上好', {}, 'quick'), ('今天好累', {}, 'quick'), ('你在干嘛', {}, 'quick'),
            ('I went for a run.', {}, 'quick'), ('download?', {}, 'quick'),
            ('https://example.org', {}, 'chat'), ('www.example.com', {}, 'chat'),
            ('它在~/Documents', {}, 'chat'), ('看 /tmp', {}, 'chat'),
            (r'X:\Documents', {}, 'chat'), ('我的草稿.md', {}, 'chat'),
            ('帮我查一下天气', {}, 'chat'), ('整理照片', {}, 'chat'), ('please install Firefox', {}, 'chat'),
            ('你好', {'scope_id': 'scope'}, 'chat'), ('你好', {'look': True}, 'chat'),
            ('你好', {'reply_to': {'kind': 'line', 'id': 'old'}}, 'chat'),
            ('stop', {}, 'chat')]:
            with self.subTest(text=text, options=options):
                self.assertEqual(foreground_route(text, command=parse_command(text), **options), expected)

    def test_pi_only_and_model_defaults(self):
        for backend, chat_route, model in [('codex', route('pi', 'fast'), 'fast'),
                                            ('pi', None, 'main'), ('pi', route('claude'), '')]:
            config = RuntimeSettings.validate({'backend': backend, 'runtime_source': 'local', 'model': 'main',
                                              'routes': {'chat': chat_route} if chat_route else {}})
            quick = RuntimeSettings.route(config, 'quick')
            self.assertEqual((quick['backend'], quick['model']), ('pi', model))
        config = RuntimeSettings.validate({'routes': {'quick': route('pi', 'mine', 'low')}})
        self.assertEqual(RuntimeSettings.route(config, 'quick')['_turn_effort'], 'low')
        self.assertEqual(RuntimeSettings.route(config, 'quick')['model'], 'mine')
        with self.assertRaisesRegex(ValueError, 'invalid_route_backend'):
            RuntimeSettings.validate({'routes': {'quick': route('codex')}})

    def test_bounded_queries_reuse_one_tool_free_session(self):
        with patch.object(self.c, '_session_factory', wraps=self.c._session_factory) as create:
            for i in range(20):
                self.say('早上好 ' + str(i))
        self.assertEqual(self.definitions, [[]])
        self.assertFalse(create.call_args.kwargs['native_tools'])
        calls = self.sessions[0].calls
        self.assertEqual(len(calls), 20)
        for i, query in enumerate(calls):
            self.assertEqual([pair[0]['content'] for pair in query['history']],
                             ['早上好 ' + str(j) for j in range(max(0, i - 8), i)])
        self.assertEqual(self.c.list_memory_runs(), [])

    @unittest.skipUnless(HAS_SDK, 'Pinned Pi SDK unavailable')
    def test_warm_pi_provider_requests(self):
        models = self.server.models = ModelSettings(self.root / 'models')
        models.save({'provider': 'compatible', 'base_url': 'https://fixture.invalid/v1',
                     'api_key': 'fixture', 'model': 'fixture'})
        self.c.settings.save({'backend': 'codex', 'runtime_source': 'local', 'model': 'chat-only'})
        self.c.session_factory_override = None
        runner = Path(__file__).parent / 'fakes' / 'quick_pi_fetch.mjs'
        with patch('character_agent.harness.pi_transport.RUNNER', runner):
            self.assertEqual(request(self.server, 'POST', '/chat/prewarm', {})[0], 200)
            session = self.c.quick_session()
            pid, session_id = session.pid, session.session_id
            self.assertEqual(request(self.server, 'POST', '/chat/prewarm', {})[0], 200)
            self.assertEqual(self.c.quick_session().pid, pid)
            self.assertFalse(list(self.root.rglob('requests.jsonl')))
            for i in range(20):
                events, _ = self.say(f'早上好 {i:02}')
                self.assertEqual(''.join(e['text_delta'] for e in events), '早上好')
                self.assertEqual(session.session_id, session_id)
            logs = list(self.root.rglob('requests.jsonl'))
            self.assertEqual(len(logs), 1)
            frames = [json.loads(line) for line in logs[0].read_text().splitlines()]
        self.assertEqual(len(frames), 20)
        self.assertEqual({f['pid'] for f in frames}, {pid})
        for i, frame in enumerate(frames):
            body = frame['request']
            self.assertEqual(body['model'], 'fixture')
            self.assertIn('[handoff]', body['messages'][0]['content'])
            self.assertFalse(body.get('tools'))
            self.assertLessEqual(body.get('max_tokens') or body['max_completion_tokens'], 1024)
            self.assertEqual(body['messages'][0], frames[0]['request']['messages'][0])
            words = json.dumps(body['messages'][1:], ensure_ascii=False)
            for j in range(i + 1):
                self.assertEqual(f'早上好 {j:02}' in words, j >= i - 8)
        self.assertEqual(len(frames[0]['request']['messages']), len(frames[-1]['request']['messages']))

    def test_stable_persona_with_changing_memory(self):
        self.say('早上好')
        self.server.memory.add('我喜欢薄荷茶', 'asserted_by_user', kind='preference')
        events, selected = self.say('早上好')
        first, second = self.sessions[0].calls
        self.assertIn('[handoff]', first['system_prompt'])
        self.assertEqual(first['system_prompt'].encode(), second['system_prompt'].encode())
        self.assertNotIn('薄荷茶', first['prompt'])
        self.assertIn('薄荷茶', second['prompt'])
        self.assertEqual(selected, 'quick')

    def test_default_scope_keeps_casual_line_quick(self):
        (self.root / 'in').mkdir()
        scope = self.c.workspace.create_scope([str(self.root / 'in')], str(self.root / 'out'), ttl=3600)
        self.c.settings.save({**self.c.settings.snapshot(), 'scope_id': scope['scope_id']})
        self.assertEqual(self.say('早上好')[1], 'quick')

    def test_split_handoff_leaves_only_chat_answer(self):
        def answer(session, prompt, options):
            parts = ['[hand', 'off] secret'] if not self.definitions[-1] else ['[intent:greet]', 'Hello']
            for part in parts:
                yield {'type': 'text_delta', 'item_id': 'answer', 'kind': 'assistant_text',
                       'status': 'delta', 'phase': 'final', 'text': part}
            yield {'type': 'result', 'success': True, 'final_text': ''.join(parts), 'model': 'fixture'}
        self.script = answer
        events, selected = self.say('你能帮帮我吗')
        self.assertEqual(len(self.sessions), 2)
        self.assertEqual(selected, 'chat')
        self.assertEqual(''.join(e['text_delta'] for e in events), 'Hello')
        self.assertNotIn('secret', str(self.server.feed.since(0)))
        rows = self.server.history.page()[0]
        self.assertEqual([(row['user_text'], row['reply']) for row in rows], [('你能帮帮我吗', 'Hello')])

    def test_prewarm_twice_then_query(self):
        expected = json.loads((Path(__file__).resolve().parents[3] / 'protocol/C6-agentd-api/fixtures/chat-prewarm.json').read_text())
        for _ in range(2):
            self.assertEqual(request(self.server, 'POST', '/chat/prewarm', {}), (200, expected))
        self.assertEqual(len(self.sessions), 1)
        self.assertTrue(self.sessions[0].prewarm.called)
        self.assertEqual(self.sessions[0].calls, [])
        self.say('早上好')
        self.assertEqual(len(self.sessions), 1)
        self.assertEqual(len(self.sessions[0].calls), 1)
