"""Character-owned topics and shared or private user facts at their product boundaries."""
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

import test_character_agent_semantic as semantic
from brain import characters
from infra.store import open_store
from personal.history import History
from test_plugin_routes import request


class OwnershipTest(unittest.TestCase):
    setUp = semantic.SemanticTests.setUp
    tearDown = semantic.SemanticTests.tearDown
    factory = semantic.SemanticTests.factory
    findings = semantic.SemanticTests.findings

    def topics(self, character):
        code, body = request(self.server, 'GET', '/conversations?character=' + character)
        self.assertEqual(code, 200)
        return body

    def test_each_character_keeps_her_own_active_topic(self):
        a = request(self.server, 'POST', '/conversations', {'title': 'A'})[1]
        before = self.c._ensure_runtime()
        self.server._live_lines.add(threading.Event())
        code, b = request(self.server, 'POST', '/conversations', {'character_id': 'birch', 'title': 'B'})
        self.assertEqual(code, 201)
        request(self.server, 'POST', '/conversations', {'character_id': 'birch', 'title': 'B2'})
        generation = self.server.history_generation
        self.assertEqual(request(self.server, 'POST', '/conversations/' + b['id'] + '/activate',
                                 {'expected_version': b['revision']})[0], 200)
        for character, topic, other in [('aster', a, b), ('birch', b, a)]:
            body = self.topics(character)
            self.assertEqual(body['character'], character)
            self.assertEqual({r['character_id'] for r in body['conversations']}, {character})
            self.assertNotIn(other['id'], [r['id'] for r in body['conversations']])
            self.assertEqual([r['id'] for r in body['conversations'] if r['active']], [topic['id']])
        self.assertEqual(request(self.server, 'GET', '/conversations?character=missing'),
                         (404, {'error': 'unknown_character'}))
        path = '/conversations/' + b['id']
        code, archived = request(self.server, 'PUT', path, {'expected_version': b['revision'] + 1, 'archived': True})
        self.assertEqual(code, 200)
        self.assertFalse(archived['active'])
        self.assertIn(archived, self.topics('birch')['conversations'])
        self.assertEqual(request(self.server, 'DELETE', path, {'expected_version': archived['revision']})[0], 200)
        self.assertEqual(self.server.history_generation, generation)
        self.assertIs(self.c._ensure_runtime(), before)

    def test_absent_characters_job_protects_its_topic(self):
        item = self.server.history.conversations.create(character_id='birch')
        job = self.c.jobs.store.submit('Birch job', {'character_id': 'birch'}, conversation_id=item['id'])
        self.assertEqual(request(self.server, 'DELETE', '/conversations/' + item['id'],
                                 {'expected_version': item['revision']}), (409, {'error': 'busy'}))
        self.assertEqual(self.c.jobs.store.get(job['job_id'])['state'], 'queued')
        self.assertTrue(self.topics('birch')['busy'])
        self.server.history.conversations.create(character_id='birch')
        self.assertFalse(self.topics('birch')['busy'])

    def test_integration_search_refuses_owner(self):
        from api.integration import _memory_search
        handler = Mock(server=self.server)
        _memory_search(handler, {'q': ['tea'], 'owner': ['aster']})
        handler.json.assert_called_once_with(400, {'error': 'invalid_query'})

    def test_jobs_and_history_keep_their_owners(self):
        semantic.SemanticTests.source(self)
        job = {'job_id': 'birch-job', 'payload': {'user_request': 'read', 'character_id': 'birch'},
               'updated_at': 2, 'result': {}, 'state': 'succeeded'}
        with patch.object(self.c.jobs.store, 'results_since', return_value=[job]):
            batch = self.pipeline.sources()
            self.assertEqual([r['kind'] for r in batch], ['conversation'])
            self.pipeline.run_once()
            self.assertEqual(self.pipeline.sources()[0]['character_id'], 'birch')

    def test_observation_episode_keeps_the_observers_owner(self):
        event = {'id': 'observed', 'character_id': 'birch', 'at': 2, 'dependencies': [], 'title': 'budget'}
        with patch.object(self.c.observations, 'events', return_value=[event]):
            self.reply = self.findings()
            self.assertEqual(self.pipeline.run_once()['state'], 'committed')
        self.assertEqual(self.db.execute('SELECT owner FROM episodes').fetchone()[0], 'birch')

    def test_missing_owner_releases_cursor(self):
        for cid in ('removed', 'aster'):
            self.server.history.record(turn_id=cid, source='text', character_id=cid, persona_revision='1',
                                      user_text='test', reply='ok', state='completed', started_at=1)
        self.assertEqual(self.pipeline.run_once()['state'], 'rejected')
        self.assertEqual(self.pipeline.sources()[0]['character_id'], 'aster')

    def test_episode_visibility_follows_batch(self):
        semantic.SemanticTests.source(self)
        self.reply = self.findings()
        self.assertEqual(self.pipeline.run_once()['state'], 'committed')
        episode = self.db.execute('SELECT id FROM episodes').fetchone()[0]
        for cid in ('aster', 'birch'):
            knowledge = self.c.knowledge(character_id=cid)
            knowledge.permitted = lambda *_: True
            with self.subTest(cid=cid):
                self.assertEqual(bool(list(knowledge._raw_rows('episodes', self.reply['title']))), cid == 'aster')
                self.assertEqual(bool(knowledge._raw_read('episodes', episode)), cid == 'aster')

    def test_failed_switch_leaves_old_topic_and_runtime(self):
        server = self.server
        runtime = self.c._ensure_runtime()
        old = (server.character, server.mouth, server.history.conversations.active)
        status, prepared = server.prepare_switch('birch')
        self.assertEqual(status, 200)
        with patch.object(server.history, 'window', side_effect=sqlite3.OperationalError('read failed')):
            self.assertEqual(server.commit_switch(prepared['switch_id'])[0], 500)
        self.assertEqual((server.character, server.mouth, server.history.conversations.active), old)
        self.assertIs(self.c.runtime, runtime)
        self.assertFalse(runtime._closed)

    def test_late_record_trace_and_receipt_stay_in_old_topic(self):
        from traces.trace_store import TraceStore
        s = self.server
        s.trace = TraceStore(self.db, 1, lock=s.history.lock)
        topic = s.history.conversations.active
        trace = s._open_trace('old', 0, 'text', 'earlier')
        trace['conversation_id'] = topic
        s._cut_lines['old'] = ({'role': 'user', 'content': 'earlier'}, [], [], topic)
        s.set_character('birch')
        s._record(trace, 'text', 'earlier', '', 'cancelled', 1)
        s._cancel_acked(trace)
        s._settle('old', 'heard')
        rows = s.history.conversations.turns(topic)['turns']
        self.assertEqual([(r['character_id'], r['reply']) for r in rows], [('aster', 'heard')])
        self.assertFalse(s.mouth.history)
        self.assertIsNotNone(self.db.execute("SELECT 1 FROM trace_events WHERE kind='cancel.acked' AND turn_id='old'").fetchone())

    def test_snapshot_without_character(self):
        self.server.character = None
        self.assertIsNone(request(self.server, 'GET', '/agent/snapshot')[1]['conversations'])

    def test_absent_character_cannot_receive_messages(self):
        a = request(self.server, 'POST', '/conversations', {'title': 'A'})[1]
        self.server.set_character('birch')
        self.assertEqual(request(self.server, 'POST', '/conversations/' + a['id'] + '/messages', {'text': 'hello'}),
                         (409, {'error': 'character_not_present', 'character_id': 'aster'}))

    def test_switch_selects_or_creates_the_runtime_topic(self):
        a = self.c._ensure_runtime().conversation_id
        self.server.set_character('birch')
        b = self.c._ensure_runtime().conversation_id
        self.assertNotEqual(a, b)
        self.assertEqual([(r['id'], r['title']) for r in self.topics('birch')['conversations']], [(b, '新对话')])
        self.server.set_character('aster')
        self.assertEqual(self.c._ensure_runtime().conversation_id, a)
        self.server.set_character('birch')
        self.assertEqual(self.c._ensure_runtime().conversation_id, b)

    def test_preview_uses_latest_reply_or_user_text(self):
        item = request(self.server, 'POST', '/conversations', {})[1]
        self.assertEqual(item.get('preview'), '')
        for reply, expected in [('[intent:greet]  hello\n  ' + '世' * 70, 'hello ' + '世' * 54), ('', 'user text')]:
            self.server.history.record(turn_id='turn', source='text', character_id='aster', persona_revision='v1',
                user_text=' user\ntext ', reply=reply, state='completed', started_at=1, conversation_id=item['id'])
            row = next(r for r in self.topics('aster')['conversations'] if r['id'] == item['id'])
            self.assertEqual(row['preview'], expected)

    def test_prompt_and_read_routes_respect_memory_ownership(self):
        for scope, text in [('character', 'tea is our nickname'), ('shared', 'tea is my preference')]:
            turn = self.c.memory_journal.turn(scope, 'remember ' + text, 'codex', 'fixture', 'aster', {})
            turn.open(lambda: True)
            args = {'operation': 'add', 'kind': 'preference', 'text': text, 'evidence_quote': text}
            if scope == 'character':
                args['scope'] = scope
            self.assertEqual(turn.call('memory_propose', args).get('outcome'), 'stored')
            turn.finish('completed')
        private, shared = self.server.memory.active()
        self.server.memory.correct(private['fact_id'], 'tea is our secret nickname')
        for cid, expected in [('aster', {private['fact_id'], shared['fact_id']}), ('birch', {shared['fact_id']})]:
            knowledge = self.c.knowledge(character_id=cid)
            profile = knowledge.call('personal_profile', {})['items']
            related = knowledge.related_facts('tea', set(), limit=5, max_chars=4000)
            for rows in (profile, related):
                self.assertEqual({row['id'] for row in rows}, expected)
            self.server.set_character(cid)
            turn = self.c.prepare('prompt-' + cid, 'tea', threading.Event(), self.server.turn_generation,
                                  'text', {'remember': True, 'reset': -1})
            self.assertIsNone(turn.error)
            prompt = self.sessions[-1].calls[-1]['prompt']
            self.assertIn(shared['text'], prompt)
            self.assertEqual('tea is our secret nickname' in prompt, cid == 'aster')
        for route in ('/memory', '/memory/export'):
            for owner, expected in [('shared', shared), ('aster', private)]:
                facts = request(self.server, 'GET', route + '?owner=' + owner)[1]['facts']
                self.assertEqual([(r['fact_id'], r['owner']) for r in facts],
                                 [(expected['fact_id'], None if owner == 'shared' else owner)])

    def test_extraction_groups_lines_and_stores_the_source_character(self):
        for i, (cid, words) in enumerate([('birch', 'our private joke'), ('aster', 'I take the train')]):
            self.server.history.record(turn_id=str(i), source='text', character_id=cid, persona_revision='v1',
                user_text=words, reply='ok', state='completed', started_at=i+1)
        for i, (scope, words) in enumerate([('character', 'our private joke'), ('shared', 'I take the train')]):
            self.reply = self.findings(words)
            self.reply['memories'][0]['scope'] = scope
            self.assertEqual(self.pipeline.run_once()['state'], 'committed')
            sources = json.loads(self.sessions[-1].calls[0]['prompt'])['evidence']['sources']
            self.assertEqual([s['source_id'] for s in sources], ['history:' + str(i)])
        self.assertEqual([(f['text'], f['owner']) for f in self.server.memory.active()],
                         [('our private joke', 'birch'), ('I take the train', None)])


class MigrationTest(unittest.TestCase):
    def test_old_conversations_and_facts_acquire_owners_on_open(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'old.sqlite'
            db = sqlite3.connect(path)
            db.executescript("""
                CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,pinned INTEGER DEFAULT 0,
                    archived INTEGER DEFAULT 0,revision INTEGER DEFAULT 1,created_at REAL NOT NULL);
                CREATE TABLE conversation_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE conversation_turns(event_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL);
                CREATE TABLE history_turns(id INTEGER PRIMARY KEY,event_id TEXT UNIQUE,turn_id TEXT,source TEXT,
                    character_id TEXT,persona_revision TEXT,user_text TEXT,reply TEXT,state TEXT,started_at REAL,
                    ended_at REAL,raw_reply TEXT,resume_run_id TEXT);
                CREATE TABLE facts(id INTEGER PRIMARY KEY,fact_id TEXT,version INTEGER,kind TEXT,text TEXT,source TEXT,
                    evidence TEXT,occurred_at REAL,recorded_at REAL,state TEXT,last_used_at REAL,reinforcement REAL,
                    reinforced_at REAL,UNIQUE(fact_id,version));
                INSERT INTO conversations(id,title,created_at) VALUES ('mixed','mixed',1),('empty','empty',1);
                INSERT INTO conversation_settings VALUES ('active','mixed');
                INSERT INTO history_turns(event_id,character_id) VALUES ('1','aster'),('2','aster'),('3','birch');
                INSERT INTO conversation_turns VALUES ('1','mixed'),('2','mixed'),('3','mixed');
                INSERT INTO facts(fact_id,text) VALUES ('original','shared words');
            """)
            db.close()
            db = open_store(path)
            try:
                history = History(db, character_id="aster")
                self.assertEqual(history.conversations.active, "mixed")
                self.assertIn('character_id', [r[1] for r in db.execute('PRAGMA table_info(conversations)')])
                self.assertEqual(dict(db.execute("SELECT id,character_id FROM conversations WHERE id IN ('mixed','empty')")),
                                 {'mixed': 'aster', 'empty': characters.default()})
                self.assertIsNone(db.execute("SELECT value FROM conversation_settings WHERE key='active'").fetchone())
                self.assertEqual(db.execute('SELECT text,owner FROM facts').fetchall(), [('shared words', None)])
            finally:
                db.close()
