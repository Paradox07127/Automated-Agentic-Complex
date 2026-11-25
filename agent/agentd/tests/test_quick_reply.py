"""Quick replies through /say and the UI's prewarm endpoint, without a listening socket."""
import json
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from brain.parser import parse_command
from character_agent.services.settings import RuntimeSettings
from infra.secrets import MemorySecrets
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

    def say(self, text, **options):
        status, body = self.server.say(text, **options)
        self.assertEqual(status, 202, body)
        self.wait_settled()
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
            ('They remind me of spring', {}, 'quick'), ('谢谢你提醒我', {}, 'quick'),
            ('昨天我记住了他的名字', {}, 'quick'), ('I went for a run yesterday', {}, 'quick'), ('我昨天安装了软件', {}, 'quick'),
            ('看看这个窗口', {}, 'chat'), ('帮我看看这个窗口', {}, 'chat'), ('看一下屏幕', {}, 'chat'),
            ('look at this window', {}, 'chat'), ('接着刚才那个继续', {}, 'chat'), ('继续刚才那个', {}, 'chat'),
            ('continue the task', {}, 'chat'), ('Remember my nickname', {}, 'chat'),
            ('明日リマインドして', {}, 'chat'), ('Could you run this', {}, 'chat'),
            ('I went for a run.', {}, 'quick'), ('download?', {}, 'quick'),
            ('https://example.org', {}, 'chat'), ('www.example.com', {}, 'chat'),
            ('它在~/Documents', {}, 'chat'), ('看 /tmp', {}, 'chat'),
            (r'X:\Documents', {}, 'chat'), ('我的草稿.md', {}, 'chat'),
            ('帮我查一下天气', {}, 'chat'), ('帮我在后台整理一下资料', {}, 'chat'), ('请在桌面上打开备忘录', {}, 'chat'), ('在后台查一下资料', {}, 'chat'),
            ('我昨天在家整理了照片', {}, 'quick'), ('整理照片', {}, 'chat'), ('please install Firefox', {}, 'chat'),
            ('十分钟后提醒我喝水', {}, 'chat'), ('明早叫我起床', {}, 'chat'), ('别让我忘了交报告', {}, 'chat'),
            ('取消 9:00 的喝水提醒', {}, 'chat'), ('把开会提醒推迟到五点', {}, 'chat'), ('设置一个午休提醒', {}, 'chat'),
            ('Remind me to call tomorrow', {}, 'chat'), ('Move my reminder to noon', {}, 'chat'),
            ('Cancel the lunch reminder', {}, 'chat'), ('请记住：我喜欢薄荷茶', {}, 'chat'),
            ('记一下我的偏好', {}, 'chat'), ('别忘了我喜欢薄荷茶', {}, 'chat'),
            ('Please remember that I prefer tea', {}, 'chat'), ('谢谢提醒', {}, 'quick'),
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
        self.assertEqual(RuntimeSettings.route(config, 'quick')['_turn_effort'], 'off')
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
        self.script = lambda *_: iter([{'type': 'result', 'success': True, 'final_text': json.dumps(self.reply)}])
        extracted = self.pipeline.run_once()
        self.assertEqual(extracted['state'], 'no_new_knowledge')
        request = self.c.memory_run_details(extracted['run_id'])['detail']['request']
        self.assertIn('早上好 0', request)
        self.assertIn('Hello', request)

    @unittest.skipUnless(HAS_SDK, 'Pinned Pi SDK unavailable')
    def test_warm_pi_provider_requests(self):
        models = self.server.models = ModelSettings(self.root / 'models', MemorySecrets(), llm_url='https://fixture.invalid/v1')
        models.save({'provider': 'compatible', 'api_key': 'fixture', 'model': 'fixture', 'reasoning': True, 'reasoning_effort': 'high'})
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
            frames = [json.loads(line) for line in logs[0].read_text(encoding='utf-8').splitlines()]
        self.assertEqual(len(frames), 20)
        self.assertEqual({f['pid'] for f in frames}, {pid})
        for i, frame in enumerate(frames):
            body = frame['request']
            self.assertEqual(body['model'], 'fixture')
            self.assertIn(body.get('reasoning_effort'), (None, 'none', 'off'))
            self.assertIn('[handoff]', body['messages'][0]['content'])
            self.assertFalse(body.get('tools'))
            self.assertLessEqual(body.get('max_tokens') or body['max_completion_tokens'], 1024)
            self.assertEqual(body['messages'][0], frames[0]['request']['messages'][0])
            words = json.dumps(body['messages'][1:], ensure_ascii=False)
            for j in range(i + 1):
                self.assertEqual(f'早上好 {j:02}' in words, j >= i - 8)
        self.assertEqual([len(f['request']['messages']) for f in frames], [2 + 2 * min(i, 8) for i in range(20)])

    def test_stable_persona_with_changing_memory(self):
        self.say('早上好')
        self.server.memory.add('我喜欢薄荷茶', 'asserted_by_user', kind='preference')
        with patch.object(self.server.spatial, 'facing_status', return_value={'behavior_id': 'face-one', 'phase': 'failed'}):
            events, selected = self.say('早上好')
        first, second = self.sessions[0].calls
        self.assertIn('[handoff]', first['system_prompt'])
        self.assertEqual(first['system_prompt'].encode(), second['system_prompt'].encode())
        self.assertNotIn('薄荷茶', first['prompt'])
        self.assertIn('薄荷茶', second['prompt'])
        self.assertNotIn('face-one', first['prompt'])
        self.assertIn('face-one', second['prompt'])
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
        with patch.object(self.server.mouth, 'pick_lore', wraps=self.server.mouth.pick_lore) as lore, \
                patch.object(self.c.reply_language, 'observe', wraps=self.c.reply_language.observe) as observe, \
                patch.object(self.server, '_context_assembled', wraps=self.server._context_assembled) as assembled:
            events, selected = self.say('你能帮帮我吗')
        self.assertEqual((lore.call_count, observe.call_count, assembled.call_count), (1, 1, 1))
        self.assertEqual(len(self.sessions), 2)
        self.assertEqual(selected, 'chat')
        self.assertEqual(''.join(e['text_delta'] for e in events), 'Hello')
        self.assertNotIn('secret', str(self.server.feed.since(0)))
        rows = self.server.history.page()[0]
        self.assertEqual([(row['user_text'], row['reply']) for row in rows], [('你能帮帮我吗', 'Hello')])

    def test_prewarm_twice_then_query(self):
        expected = json.loads((Path(__file__).resolve().parents[3] / 'protocol/C6-agentd-api/fixtures/chat-prewarm.json').read_text(encoding='utf-8'))
        for _ in range(2):
            self.assertEqual(request(self.server, 'POST', '/chat/prewarm', {}), (200, expected))
        self.assertEqual(len(self.sessions), 1)
        self.assertTrue(self.sessions[0].prewarm.called)
        self.assertEqual(self.sessions[0].calls, [])
        self.say('早上好')
        self.assertEqual(len(self.sessions), 1)
        self.assertEqual(len(self.sessions[0].calls), 1)

    def test_unavailable_quick_uses_chat(self):
        with patch.object(self.c, 'quick_status', return_value={'ready': False, 'error': 'plugin_off', 'backend': 'pi'}):
            self.assertEqual(self.say('hello')[1], 'chat')
        from infra import plugins
        with patch.dict(plugins.resolved, light_ai=False, harness_bridge=True):
            for path in ('/say', '/conversations/' + self.server.history.conversations.active + '/messages'):
                status, body = request(self.server, 'POST', path, {'text': 'hello'})
                self.assertEqual(status, 202, body)
                self.wait_settled()
                self.assertEqual(body['runtime'], 'codex')

    def test_readiness_outside_topic_lock(self):
        owned = []
        path = '/conversations/' + self.server.history.conversations.active + '/messages'
        def status():
            owned.append(self.server._switch_lock._is_owned())
            return {'ready': True, 'backend': 'pi'}
        with patch.object(self.c, 'quick_status', side_effect=status):
            self.assertEqual(request(self.server, 'POST', path, {'text': 'hi'})[0], 202)
        self.wait_settled()
        self.assertEqual(owned, [False])

    def wait_settled(self):
        deadline = time.monotonic() + 3
        while self.server._live_lines and time.monotonic() < deadline:
            time.sleep(.005)
        self.assertFalse(self.server._live_lines)

    def test_quick_preserves_chat_kernel_and_session(self):
        self.say('查一下 document')
        runtime, session = self.c.runtime, self.sessions[-1]
        self.say('hello')
        self.say('查一下 document again')
        self.assertIs(self.c.runtime, runtime)
        self.assertEqual(session.closed, 0)
        self.assertEqual(len(session.calls), 2)

    def test_stale_prepare_never_replaces_runtime(self):
        runtime = self.c._ensure_runtime()
        self.c.prepare('old', 'hi', threading.Event(), self.server.turn_generation - 1, 'text', {'route': 'quick'})
        self.assertIs(self.c.runtime, runtime)
        self.assertFalse(runtime._closed)

    def test_quick_temporary_turns_read_the_window_but_stay_out_of_it(self):
        with patch.object(self.server, 'history', None):
            self.say('first')
        self.say('second', remember=False)
        self.say('third', remember=False)
        self.assertEqual([turn[0]['content'] for turn in self.sessions[0].calls[-1]['history']], ['first'])
        with patch.object(self.server, 'history', None):
            self.say('fourth')
        self.assertEqual([turn[0]['content'] for turn in self.sessions[0].calls[-1]['history']], ['first'])

    def test_quick_validates_scope_before_dispatch(self):
        (self.root / 'in').mkdir()
        scope = self.c.workspace.create_scope([str(self.root / 'in')], str(self.root / 'out'), ttl=3600)
        self.c.settings.save({**self.c.settings.snapshot(), 'scope_id': scope['scope_id']})
        with patch.object(self.c.workspace, 'validate_scope', side_effect=[scope, ValueError('scope_expired')]):
            status, body = self.server.say('hi')
            self.assertEqual(status, 202)
            self.wait_settled()
        self.assertFalse(any(s.calls for s in self.sessions))

    def test_failed_quick_dispatch_has_run_and_fact_receipt(self):
        fact = self.server.memory.add('I drink tea', 'asserted_by_user', kind='preference')
        at_dispatch = []
        def fail(session, prompt, options):
            ident = options['run_id']
            at_dispatch.append((self.c.store.get(ident), self.db.execute(
                'SELECT 1 FROM fact_uses WHERE fact_id=? AND line_id=?', (fact, ident)).fetchone()))
            raise ValueError('transport_failed')
        self.script = fail
        status, body = self.server.say('hi')
        self.assertEqual(status, 202)
        self.wait_settled()
        self.assertTrue(all(at_dispatch[0]))
        self.assertEqual(self.c.store.get(body['run_id'])['state'], 'failed')

    def test_ready_event_precedes_opening_text(self):
        phases = []
        def answer(session, prompt, options):
            yield {'type': 'ready'}
            phases.extend(e['data'].get('phase') for e in self.server.feed.since(0) if e['event'] == 'agent_run')
            yield from chat(session, prompt, options)
        self.script = answer
        self.say('hi')
        self.assertIn('capabilities_checked', phases)

    def test_prewarm_retired_during_start(self):
        s = self.c.quick_session()
        def start():
            self.c.cancel('runtime_changed')
            s.closed = 0  # the child starts after retirement
        s.prewarm.side_effect = start
        self.assertEqual(request(self.server, 'POST', '/chat/prewarm', {})[0], 503)
        self.assertGreater(s.closed, 0)
        self.assertIsNot(self.c.quick_session(), s)

    def test_session_key_tracks_config(self):
        s = self.c.quick_session()
        self.c.settings.save({'routes': {'quick': route('pi', 'different')}})
        self.assertIsNot(self.c.quick_session(), s)
        self.assertGreater(s.closed, 0)

    def test_quick_model_uses_resolved_provider(self):
        self.server.models = ModelSettings(self.root / 'models', MemorySecrets(), llm_url='https://fixture.invalid/v1')
        self.server.models.save({'provider': 'compatible', 'api_key': 'fixture', 'model': 'account'})
        for provider, expected in [('deepseek', 'account'), ('compatible', 'chat-model')]:
            self.c.settings.save({'backend': 'pi', 'provider': provider, 'auth_source': 'api_key', 'model': 'chat-model'})
            with patch.object(self.c, '_session_factory', wraps=self.c._session_factory) as create:
                self.c.quick_session()
                self.assertEqual(self.c._model(create.call_args.args[1]), expected)
            self.c.cancel('runtime_changed')

    def test_cancel_interrupts_quick_stream(self):
        started, release = threading.Event(), threading.Event()
        def answer(session, prompt, options):
            session.interrupt_hook = release.set
            started.set()
            release.wait(2)
            yield from chat(session, prompt, options)
        self.script = answer
        status, body = self.server.say('hi')
        self.assertTrue(started.wait(2))
        try:
            self.c.cancel_conversation(self.server.history.conversations.active, body['run_id'], body['generation'])
            self.assertTrue(release.wait(.2))
        finally:
            release.set()
            self.wait_settled()

    def test_quote_uses_only_the_named_topics_displayed_words(self):
        s = self.server
        self.say('first question')
        path = '/conversations/' + s.history.conversations.active + '/messages'
        ident = s.history.page()[0][0]['turn_id']
        for part, words in [('user', 'first question'), ('reply', 'Hello')]:
            status, body = request(s, 'POST', path, {'text': 'why?', 'quote_turn': {'turn_id': ident, 'part': part}})
            self.assertEqual(status, 202, body)
            self.wait_settled()
            prompt = self.sessions[-1].calls[-1]['prompt']
            self.assertIn(words, prompt.split('</observed_context>')[0])
            self.assertIn('"speaker": "' + ('user' if part == 'user' else 'aster') + '"', prompt)
            self.assertTrue(prompt.endswith('why?'))
            self.assertTrue(self.definitions[-1])
        topic = s.history.conversations.create()
        self.assertEqual(request(s, 'POST', '/conversations/' + topic['id'] + '/messages',
                                {'text': 'why?', 'quote_turn': {'turn_id': ident, 'part': 'reply'}}),
                         (400, {'error': 'invalid_quote_turn'}))

    def test_cancel_quick_waiting_for_prewarm_lock(self):
        from character_agent.harness.transport import HarnessError, ManagedClaudeSession
        session = ManagedClaudeSession(Mock(), runner_path='unused')
        queued, cancelled, stopped = threading.Event(), threading.Event(), threading.Event()
        outcome = []

        def stream():
            queued.set()
            try:
                list(session.stream('hi', system_prompt='', replace_history=True, cancelled=cancelled))
            except HarnessError as error:
                outcome.append(error.code)
            finally:
                stopped.set()

        with session._stream_lock:
            worker = threading.Thread(target=stream)
            worker.start()
            self.assertTrue(queued.wait(1))
            cancelled.set()
            ended_while_locked = stopped.wait(.5)
        worker.join(2)
        self.assertTrue(ended_while_locked)
        self.assertEqual(outcome, ['cancelled'])

    def test_scope_expiring_at_adapter_ready_sends_no_prompt(self):
        (self.root / 'in').mkdir()
        scope = self.c.workspace.create_scope([str(self.root / 'in')], str(self.root / 'out'), ttl=3600)
        self.c.settings.save({**self.c.settings.snapshot(), 'scope_id': scope['scope_id']})
        sent = []
        def start(session, prompt, options):
            self.c.workspace.revoke_scope(scope['scope_id'])
            yield {'type': 'ready'}
            sent.append(prompt)
            yield from chat(session, prompt, options)
        self.script = start
        status, body = self.server.say('hi')
        self.assertEqual(status, 202)
        self.wait_settled()
        self.assertFalse(sent)
        self.assertEqual(self.c.store.get(body['run_id'])['state'], 'failed')

    def test_cancel_during_preparation_settles_accepted_quick_run(self):
        entered, release = threading.Event(), threading.Event()
        def lore(*args):
            entered.set()
            release.wait(2)
            return []
        with patch.object(self.server.mouth, 'pick_lore', side_effect=lore):
            status, body = self.server.say('hi')
            self.assertEqual(status, 202)
            self.assertTrue(entered.wait(1))
            self.assertEqual(self.c.cancel_conversation(self.server.history.conversations.active,
                                                        body['run_id'], body['generation'])[0], 202)
            release.set()
            self.wait_settled()
        run = self.c.store.get(body['run_id'])
        self.assertIsNotNone(run)
        self.assertEqual(run['state'], 'cancelled')

    @unittest.skipUnless(HAS_SDK, 'Pinned Pi SDK unavailable')
    def test_quick_query_overrides_session_thinking_budget(self):
        from character_agent.harness.pi_config import PiConfig, resolve_pi_runtime
        from character_agent.harness.pi_transport import ManagedPiSession
        node, runtime = resolve_pi_runtime()
        config = PiConfig(self.root / 'pi', 'compatible', 'fixture', api_key='fixture',
                          base_url='https://fixture.invalid/v1', reasoning=True, effort='high',
                          native_tools=False, node=node, runtime_dir=runtime)
        session = ManagedPiSession(config, runner_path=Path(__file__).parent / 'fakes' / 'quick_pi_fetch.mjs')
        try:
            events = list(session.stream('hi', system_prompt='answer', history=[], replace_history=True))
            self.assertTrue(events[-1]['success'], events[-1])
            log, = self.root.rglob('requests.jsonl')
            body = json.loads(log.read_text(encoding='utf-8'))['request']
            self.assertIn(body.get('reasoning_effort'), (None, 'none', 'off'))
            self.assertEqual(body.get('max_completion_tokens', body.get('max_tokens')), 1024)
        finally:
            session.close()

    def test_question_reply_reads_chat_readiness_outside_switch_lock(self):
        topic = self.server.history.conversations.active
        run = 'asked'
        questions = [{'id': 'q', 'question': 'Which one?'}]
        self.c.store.begin(run, topic, self.server.character, 0)
        self.c.store.checkpoint(run, None, {'task_id': None, 'goal': 'original goal', 'scope_id': None,
            'dependencies': [], 'pending_tool': {'name': 'ask_user', 'tool_call_id': 'call', 'args': {'questions': questions}}})
        with self.assertRaisesRegex(ValueError, 'interaction_pending'):
            self.c.interactions.ask(run, questions, valid=lambda: True, character_id=self.server.character)
        card, = self.c.interactions.list()
        owned = []
        public = self.c.public
        def readiness(*args, **kwargs):
            owned.append(self.server._switch_lock._is_owned())
            return public(*args, **kwargs)
        with patch.object(self.c, 'public', side_effect=readiness):
            status, body = request(self.server, 'POST', '/conversations/' + topic + '/messages',
                {'reply_to': {'request_id': card['request_id'], 'revision': card['revision']}, 'answers': {'q': ['first']}})
            self.wait_settled()
        self.assertEqual(status, 200, body)
        self.assertEqual(body['state'], 'resumed')
        self.assertTrue(owned)
        self.assertFalse(any(owned))
