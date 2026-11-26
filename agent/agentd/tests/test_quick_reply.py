"""Unified chat route, /chat/prewarm, topic quotes, and cancellation through /say."""
import json
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.settings import RuntimeSettings
from infra.secrets import MemorySecrets
from models.model_backends import ModelSettings
from traces.trace_store import TraceStore
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

    def test_quick_route_aliases_chat_route(self):
        config = RuntimeSettings.validate({'backend': 'codex', 'runtime_source': 'local', 'model': 'main',
                                           'routes': {'chat': route('claude', 'sonnet', 'high')}})
        self.assertEqual(RuntimeSettings.route(config, 'quick'), RuntimeSettings.route(config, 'chat'))
        self.assertEqual(self.c.public()['routes']['quick'], self.c.public()['routes']['chat'])

    def test_chat_reuses_session_and_feeds_memory(self):
        for i in range(5):
            events, selected = self.say('早上好 ' + str(i))
            self.assertEqual(selected, 'chat')
            self.assertEqual(''.join(e['text_delta'] for e in events), 'Hello')
        self.script = lambda *_: iter([{'type': 'result', 'success': True, 'final_text': json.dumps(self.reply)}])
        extracted = self.pipeline.run_once()
        self.assertEqual(extracted['state'], 'no_new_knowledge')
        request_text = self.c.memory_run_details(extracted['run_id'])['detail']['request']
        self.assertIn('早上好 0', request_text)
        self.assertIn('Hello', request_text)

    def test_prewarm_twice_succeeds(self):
        expected = json.loads((Path(__file__).resolve().parents[3] / 'protocol/C6-agentd-api/fixtures/chat-prewarm.json').read_text(encoding='utf-8'))
        for _ in range(2):
            self.assertEqual(request(self.server, 'POST', '/chat/prewarm', {}), (200, expected))
        self.assertEqual(len(self.sessions), 1)
        self.assertTrue(self.sessions[0].prewarm.called)
        self.assertEqual(self.sessions[0].calls, [])
        self.say('早上好')
        self.assertTrue(self.sessions[-1].calls)

    def test_stale_prepare_never_replaces_runtime(self):
        runtime = self.c._ensure_runtime()
        self.c.prepare('old', 'hi', threading.Event(), self.server.turn_generation - 1, 'text', {'route': 'chat'})
        self.assertIs(self.c.runtime, runtime)
        self.assertFalse(runtime._closed)

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

    def test_cancel_interrupts_chat_stream(self):
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

    def test_cancel_waiting_for_prewarm_lock(self):
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

    def wait_settled(self):
        deadline = time.monotonic() + 3
        while self.server._live_lines and time.monotonic() < deadline:
            time.sleep(.005)
        self.assertFalse(self.server._live_lines)


if __name__ == '__main__':
    unittest.main()
