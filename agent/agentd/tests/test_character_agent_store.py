"""Durable run lifecycle tests using isolated SQLite files."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.store import RunStore
from tool_gateway.ledger import EffectLedger


class RunStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.path = Path(self.tmp.name) / 'runs.sqlite'
        self.store = RunStore(self.path)

    def tearDown(self):
        self.store.close(); self.tmp.cleanup()

    def begin(self, ident='run'):
        self.store.begin(ident, 'conversation', 'character', 7, 'scope')

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_roundtrip_preserves_product_identity_without_prompt_text(self):
        self.begin(); self.store.finish('run', 'completed', task_id='task', sdk_session_id='sdk',
                                       dependencies=[{'source': 'memory', 'id': 'fact', 'version': 2}], result={'ok': True})
        row = self.store.get('run')
        self.assertEqual(row['conversation_id'], 'conversation'); self.assertEqual(row['character_id'], 'character')
        self.assertEqual(row['generation'], 7); self.assertEqual(row['result'], {'ok': True})
        self.assertEqual(row['dependencies'][0]['version'], 2)
        self.assertNotIn('prompt', row); self.assertIsNotNone(row['ended_at'])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_state_since_is_when_the_run_entered_its_state(self):
        self.begin('live'); self.begin('waiting')
        self.store.finish('waiting', 'waiting_user')
        live, waiting = self.store.get('live'), self.store.get('waiting')
        self.assertEqual(live['state_since'], live['started_at'])
        self.assertEqual(waiting['state_since'], waiting['ended_at'])
        self.assertEqual({row['run_id']: row['state_since'] for row in self.store.list()},
                         {'waiting': waiting['ended_at'], 'live': live['started_at']})

    def test_restart_marks_only_live_runs_interrupted(self):
        self.begin('active'); self.begin('done'); self.store.finish('done', 'completed')
        self.store.close(); self.store = RunStore(self.path)
        self.assertEqual(self.store.get('active')['state'], 'interrupted')
        self.assertEqual(self.store.get('done')['state'], 'completed')

    def test_event_sequence_is_unique_under_concurrent_producers(self):
        self.begin(); values = []
        def record(n): values.append(self.store.event('run', 'tool_started', {'tool': 'knowledge_search', 'tool_call_id': f'call-{n}'}))
        threads = [threading.Thread(target=record, args=(n,)) for n in range(20)]
        for t in threads: t.start()
        for t in threads: t.join(2)
        self.assertEqual(sorted(values), list(range(1, 21)))
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM character_run_events').fetchone()[0], 20)

    def test_forget_removes_runs_and_event_payloads(self):
        self.begin(); self.store.event('run', 'running', {'backend': 'test', 'model': 'test'})
        self.store.forget()
        self.assertEqual(self.store.list(), []); self.assertIsNone(self.store.get('run'))
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM character_run_events').fetchone()[0], 0)

    def test_forget_conversation_removes_background_runs_and_questions_only_for_it(self):
        from character_agent.services.interactions import InteractionService
        service = InteractionService(self.store, wait_seconds=0)
        self.begin('foreground'); self.begin('background')
        self.store.begin('other', 'other-conversation', 'character', 0)
        for ident in ('background', 'other'):
            self.store.event(ident, 'running', {'backend': 'test'})
            self.store.checkpoint(ident, ident, {'task_id': ident, 'goal': 'private-text'})
            EffectLedger(self.store).prepare(ident, ident, 'tool', 'hash')
            with self.assertRaisesRegex(ValueError, 'interaction_pending'):
                service.ask(ident, [{'id': 'q', 'question': 'private-text'}], valid=lambda: True, character_id='character')
        self.store.forget_runs((), conversation_id='conversation')
        self.assertIsNone(self.store.get('foreground')); self.assertIsNone(self.store.get('background'))
        self.assertIsNone(self.store.load_checkpoint(run_id='background'))
        self.assertEqual(EffectLedger(self.store).effects('background'), [])
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM character_run_events WHERE run_id='background'").fetchone()[0], 0)
        self.assertEqual([row['run_id'] for row in service.list()], ['other'])
        self.assertIsNotNone(self.store.get('other'))
        from character_agent.services.jobs import JobStore
        from personal.history import History
        from personal.memory import Memory
        from infra.store import open_store
        db = open_store(Path(self.tmp.name) / 'domain.sqlite')
        try:
            history = History(db)
            conversations = history.conversations
            conversations.run_store = self.store
            conversation = conversations.get(conversations.active)
            jobs = JobStore(Memory(db))
            job = jobs.submit('private-job', {'user_request': 'private-request'}, conversation_id=conversation['id'])
            jobs.claim()
            self.store.begin(job['run_id'], conversation['id'], 'character', 0)
            with self.assertRaisesRegex(ValueError, 'interaction_pending'):
                service.ask(job['run_id'], [{'id': 'q', 'question': 'private-question'}], valid=lambda: True, character_id='character')
            # Match the controller's question callback: this worker is suspended, not still executing.
            self.store.finish(job['run_id'], 'waiting_user')
            jobs.settle(job['job_id'], 'waiting_user')
            conversations.update(conversation['id'], {'expected_version': conversation['revision']}, delete=True)
            self.assertIsNone(jobs.get(job['job_id']))
            self.assertIsNone(self.store.get(job['run_id']))
            self.assertEqual([row['run_id'] for row in service.list()], ['other'])
            for table in ('personal_job_events', 'personal_job_leases'):
                self.assertEqual(db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0], 0)
        finally:
            db.close()

    def test_late_finish_does_not_resurrect_forgotten_run(self):
        self.begin(); self.store.forget()
        self.store.finish('run', 'completed', result={'ok': True})
        self.assertIsNone(self.store.get('run'))

    def test_terminal_state_cannot_be_overwritten_by_late_completion(self):
        self.begin(); self.store.finish('run', 'cancelled', result={'reason': 'user_cancelled'})
        try: self.store.finish('run', 'completed', result={'ok': True})
        except ValueError: pass
        self.assertEqual(self.store.get('run')['state'], 'cancelled')
        self.assertEqual(self.store.get('run')['result'], {'reason': 'user_cancelled'})

    def test_invalid_state_is_rejected_without_changing_live_record(self):
        self.begin()
        with self.assertRaises(ValueError): self.store.finish('run', 'invented-state')
        self.assertEqual(self.store.get('run')['state'], 'running')

    def test_raw_text_metadata_is_rejected_at_persistence_boundary(self):
        self.begin()
        with self.assertRaises(ValueError): self.store.event('run', 'running', {'text': 'synthetic-secret'})
        rows = self.store.db.execute('SELECT metadata FROM character_run_events').fetchall()
        self.assertNotIn('synthetic-secret', json.dumps([r[0] for r in rows]))

    def test_checkpoint_binds_task_before_terminal_result_and_rejects_rebinding(self):
        self.begin()
        self.assertTrue(self.store.checkpoint('run', 'task-a', {'task_id': 'task-a', 'goal': 'Original'}))
        self.assertEqual(self.store.get('run')['task_id'], 'task-a')
        with self.assertRaisesRegex(ValueError, 'checkpoint_task_conflict'):
            self.store.checkpoint('run', 'task-b', {'task_id': 'task-b', 'goal': 'Changed'})
        self.assertEqual(self.store.load_checkpoint(run_id='run')['goal'], 'Original')
        with self.assertRaisesRegex(ValueError, 'invalid_checkpoint'):
            self.store.checkpoint('run', 'task-a', {'task_id': 'task-b'})
        self.store.forget()
        self.assertFalse(self.store.checkpoint('run', 'task-a', {'task_id': 'task-a', 'goal': 'late'}))
        self.assertIsNone(self.store.load_checkpoint(task_id='task-a'))

    def plan(self, steps=None, status='in_progress'):
        value = {'run_id': 'run', 'item_id': 'run:plan', 'seq': 1, 'kind': 'plan', 'status': status,
                 'summary': 'Read', 'text': ''}
        if steps is not None:
            value['steps'] = steps
        self.store.item(value)

    def test_plan_steps_roundtrip_and_survive_upsert_without_steps(self):
        self.begin()
        steps = [{'text': 'Read', 'status': 'completed'}, {'text': 'Write', 'status': 'in_progress'}]
        self.plan(steps)
        self.assertEqual(self.store.items('run')[0]['steps'], steps)
        self.plan(status='completed')
        row = self.store.items('run')[0]
        self.assertEqual((row['steps'], row['status']), (steps, 'completed'))

    def test_item_without_steps_reads_none_and_redaction_clears_steps(self):
        self.begin()
        self.store.item({'run_id': 'run', 'item_id': 'answer', 'seq': 2, 'kind': 'assistant_text',
                         'status': 'completed', 'text': 'Hi'})
        self.plan([{'text': 'Read', 'status': 'pending'}])
        self.assertIsNone(next(r for r in self.store.items('run') if r['item_id'] == 'answer')['steps'])
        self.store.redact_items(['run'])
        self.assertEqual([r['steps'] for r in self.store.items('run')], [None, None])


if __name__ == '__main__': unittest.main()
