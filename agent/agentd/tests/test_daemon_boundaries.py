"""Consent, deletion and event ordering at the daemon's handler boundaries."""
import io
import json
import time
import unittest
from unittest.mock import Mock, patch

import support
import test_character_agent_semantic as fixture
from api.handler import Handler
from api.integration import _propose_reminder
from observation.attention import AttentionStore
from observation.blacklist import Blacklist
from observation.capture import CaptureManager
from observation.timeline import Timeline
from personal.commitments import Commitments
from test_registry import claude


class DaemonBoundariesTest(unittest.TestCase):
    setUp = fixture.SemanticTests.setUp
    tearDown = fixture.SemanticTests.tearDown
    factory = fixture.SemanticTests.factory

    def handler(self, path):
        handler = object.__new__(Handler)
        handler.server, handler.path, handler.headers = self.server, path, {}
        handler._json = Mock()
        return handler

    def attention(self):
        blacklist = Blacklist(support.deny_blacklist(self.root / 'blacklist.json'))
        self.server.attention = AttentionStore(':memory:', blacklist)
        self.addCleanup(self.server.attention.close)
        return blacklist

    def test_session_sharing_gates_prompt_storage_and_chat(self):
        self.attention()
        s = self.server
        s.share_typed_text = True
        for sharing, plugin in ((False, True), (True, False)):
            with self.subTest(sharing=sharing, plugin=plugin), patch.dict('infra.plugins.resolved', coding_sessions=plugin):
                s.share_agent_sessions = sharing
                marker = f'coding prompt marker {sharing}'
                self.handler('/hook/claude')._hook('/hook/claude', claude('UserPromptSubmit', time.time()),
                                                  {'prompt': marker})
                before = sum(len(session.calls) for session in self.sessions)
                status, reply = s.say('How are things going?')
                self.assertEqual(status, 202, reply)
                s._wait_for_closing_turns(time.monotonic() + 5)
                self.assertGreater(sum(len(session.calls) for session in self.sessions), before)
                request = self.sessions[-1].calls[-1]
                values = s.attention.db.execute('SELECT value FROM events_raw').fetchall()
                self.assertEqual((marker in str(request), (marker,) in values), (False, False))

    def test_window_revocation_before_insert(self):
        s = self.server
        blacklist = self.attention()
        s.timeline = Timeline(':memory:', blacklist)
        self.addCleanup(s.timeline.close)
        s.capture = CaptureManager(s.feed, blacklist, lambda: None, None, share_text=True)
        s.privacy_config = self.root / 'privacy.json'
        policy = {'share_window_text': True, 'screen_context_level': 'window', 'share_actions': True}
        s.privacy_config.write_text(json.dumps(policy), encoding='utf-8')
        insert = s.timeline.ingest

        def revoke(rows, **generations):
            self.assertEqual(rows[0]['tree']['text'], 'window marker')
            s.privacy_config.write_text(json.dumps({**policy, 'share_window_text': False}), encoding='utf-8')
            s.sync_privacy()
            return insert(rows, **generations)

        with patch.object(s.timeline, 'ingest', revoke):
            self.handler('/context/timeline')._timeline_post({'records': [{'ts': time.time(), 'kind': 'click',
                'app': 'Editor', 'tree': {'mode': 'full', 'text': 'window marker'}}]})
        self.assertEqual(s.timeline.db.execute('SELECT tree_text FROM timeline').fetchall(), [(None,)])

    def test_history_only_preserves_personal_work(self):
        jobs = self.c.jobs.store
        goal = jobs.create_goal('Report', 'Write the report')
        job = jobs.submit('Draft', {}, goal['goal_id'])
        scope = self.c.workspace.create_scope([str(self.root)])['scope_id']
        with self.db:
            self.db.execute("INSERT INTO personal_deliveries(delivery_id,canonical_task_id,run_id,character_id,"
                            "generation,state,outcome,verification_source,title,payload,produced_at)"
                            " VALUES('result','task','done','aster',1,'produced','succeeded','automatic_checks',"
                            "'Report','{}',1)")
        delivery = self.c.deliveries.get('result')
        status, result = self.server.say('How is the report coming along?')
        self.assertEqual(status, 202, result)
        self.server._wait_for_closing_turns(time.monotonic() + 5)
        self.assertTrue(self.c.list_memory_runs())
        h = self.handler('/memory?scope=history')
        h._memory_delete(None)
        h._json.assert_called_once_with(200, {'history_deleted': 1, 'facts_deleted': 0})
        self.assertEqual(self.server.history.export(), [])
        self.assertEqual(self.c.list_memory_runs(), [])
        self.assertEqual(jobs.goal(goal['goal_id']), goal)
        self.assertEqual(jobs.get(job['job_id']), job)
        self.assertIsNotNone(self.c.workspace.get_scope(scope))
        self.assertEqual(self.c.deliveries.get('result'), delivery)

    def test_range_delete_keeps_older_frame_and_shared_content(self):
        self.attention()
        s, obs = self.server, self.c.observations
        s.share_typed_text = True
        old = obs.ingest('input_event', 'shared', source_key='old', at=time.time() - 3600)
        recent = obs.ingest('input_event', 'shared', source_key='recent', at=time.time())
        self.assertEqual(obs.get(old)['text'], obs.get(recent)['text'])
        self.handler('/observation?range=15m')._observation_delete()
        self.assertEqual((bool(obs.get(old)), bool(obs.get(recent))), (True, False))

    def test_approved_reminder_cannot_settle_after_reset(self):
        s = self.server
        s.commitments = Commitments(self.db)
        with patch('api.integration.threading.Thread') as worker:
            _propose_reminder(self.handler('/integration/reminders'), {'text': 'reminder', 'due_at': time.time() + 100})
        settle = worker.call_args.kwargs['target']
        request, = s.broker.pending()
        s.broker.decide(request['request_id'], request['generation'], 'allow')
        wait = s.broker.wait

        def reset_after_approval(ident):
            decision = wait(ident)
            self.assertEqual(decision, 'allow')
            status, result = s.reset()
            self.assertEqual(status, 200, result)
            self.assertFalse(any(result['rows'].values()))
            return decision

        with patch.object(s.broker, 'wait', reset_after_approval):
            settle()
        self.assertEqual(s.commitments.list(), [])
        self.assertNotIn('commitment', [item['event'] for item in s.feed.since(0)])

    def test_reminder_receipts_survive_startup(self):
        store = Commitments(self.db)
        item = store.add('reminder', 1000, request_key='create')
        self.server.load_receipts(self.db)
        self.assertEqual(store.add('reminder', 1000, request_key='create')['id'], item['id'])
        store.delete(item['id'])
        self.server.load_receipts(self.db)
        with self.assertRaisesRegex(ValueError, 'reminder_deleted'):
            store.add('reminder', 1000, request_key='create')

    def test_old_stop_and_end_leave_newer_card_and_session(self):
        s = self.server
        now = time.time()
        s.registry.ingest(claude('UserPromptSubmit', now))
        request = s.broker.open('claude', 'A', 'Read')
        for kind in ('Stop', 'SessionEnd'):
            self.handler('/hook/claude')._hook('/hook/claude', claude(kind, now - 1), {})
        s.registry.ingest(claude('SessionEnd', now - 2))
        self.assertEqual((request.status, ('claude', 'A') in s.registry.sessions), ('pending', True))

    def events(self):
        h = self.handler('/events')
        h.send_header = h.send_response = h.end_headers = Mock()
        h.wfile = io.BytesIO()
        with patch.object(self.server.registry, 'wait_for_intent', side_effect=BrokenPipeError):
            h._events()
        return h.wfile.getvalue().decode()

    def test_snapshot_survives_non_intent_traffic(self):
        registry = self.server.registry
        registry.ingest(claude('UserPromptSubmit', time.time()))
        for _ in range(registry.intents.maxlen):
            registry.publish_event('behavior_cancel', {})
        stream = self.events()
        self.assertIn('event: snapshot', stream)
        self.assertIn('"state": "thinking"', stream)

    def test_snapshot_cursor_does_not_skip_a_transition(self):
        registry = self.server.registry
        registry.tick()
        def transition():
            registry.ingest(claude('UserPromptSubmit', time.time()))
            return []
        with patch.object(self.server.spatial, 'running', transition):
            stream = self.events()
        self.assertIn('"state": "thinking"', stream)
