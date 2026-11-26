"""Offline admission, replay, scheduling and private generation regressions."""
import hashlib
import itertools
import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_character_agent_semantic as fixtures
from character_agent.services.memory_service import MemoryJournal, DETAIL_KEEP, RUN_KEEP
from infra.data_lifecycle import DataLifecycle
from infra.store import open_store
from models.usage import UsageMeter, HOUR_CAP


class SemanticAdmissionTests(unittest.TestCase):
    setUp = fixtures.SemanticTests.setUp
    tearDown = fixtures.SemanticTests.tearDown
    factory = fixtures.SemanticTests.factory
    source = fixtures.SemanticTests.source

    def meter(self):
        self.now = time.mktime((2026, 10, 28, 9, 0, 0, 0, 0, -1))
        self.server.usage = UsageMeter(self.db, lock=self.server.memory.lock, clock=lambda:self.now)
        return self.server.usage

    def counts(self):
        return (self.db.execute('SELECT COUNT(*) FROM memory_agent_runs').fetchone()[0],
                self.db.execute('SELECT COUNT(*) FROM memory_agent_events').fetchone()[0],
                self.c.store.db.execute('SELECT COUNT(*) FROM character_runs').fetchone()[0],
                self.db.execute('SELECT COALESCE(SUM(calls),0) FROM model_usage').fetchone()[0])

    def test_exhausted_quota_writes_only_one_content_free_count(self):
        meter = self.meter()
        for _ in range(HOUR_CAP): meter.record('fixture','proactive_decide',None)
        before = self.counts()
        with self.assertRaisesRegex(ValueError,'usage_cap'):
            self.c.semantic.run('proactive_decide','private-instructions',{'private':'private-evidence'})
        self.assertEqual(self.counts(),before)
        rows = self.db.execute("SELECT purpose,outcome FROM semantic_attempts WHERE outcome='usage_cap'").fetchall()
        self.assertEqual(rows,[('proactive_decide','usage_cap')])
        self.assertNotIn('private-',str(self.db.execute('SELECT * FROM semantic_attempts').fetchall()))
        self.assertFalse(self.sessions)

    def test_cancel_before_first_token_refunds_every_quota(self):
        meter = self.meter()
        def factory(definitions):
            def script(session,prompt,options):
                self.c.semantic.cancel()
                yield {'type':'error','code':'semantic_cancelled'}
            session = fixtures.FakeSession(script); self.sessions.append(session); return session
        self.c.session_factory_override = factory
        before = self.counts()[-1]
        with self.assertRaisesRegex(ValueError,'semantic_cancelled'):
            self.c.semantic.run('memory_extract','private',{'sources':[{'kind':'conversation'}]})
        self.assertEqual(self.counts()[-1],before)
        self.assertTrue(meter.admit('memory_extract'))
        self.assertEqual(self.db.execute('SELECT outcome,counted FROM semantic_attempts').fetchall(),[('cancelled',0)])
        self.assertIsNone(self.c.memory_journal.get(self.c.memory_journal.list()[0]['run_id'])['detail'])

    def test_failed_run_contains_fingerprints_without_request_or_output_text(self):
        self.meter()
        self.reply = {'description':'private-output'}
        def reject(value): raise ValueError('invalid_observation')
        with self.assertRaisesRegex(ValueError,'invalid_observation'):
            self.c.semantic.run('observation_vision','private-instructions',{'source':'private-evidence'},validate_output=reject)
        row = self.c.memory_journal.get(self.c.memory_journal.list()[0]['run_id'])
        self.assertFalse('private-' in json.dumps(row),'failed journal retains private text')
        prompt = self.sessions[0].calls[0]['prompt']
        self.assertEqual(row['detail']['prompt'],{'sha256':hashlib.sha256(prompt.encode()).hexdigest(),'length':len(prompt)})
        self.assertEqual(set(row['detail']['evidence']),{'sha256','length'})
        self.assertEqual(self.db.execute('SELECT outcome,counted FROM semantic_attempts').fetchall(),[('failed',1)])

    def test_startup_purges_expired_rows_without_a_read(self):
        journal = self.c.memory_journal
        turn = journal.turn('old','','codex','fixture','aster',{'prompt':'private-old'})
        turn.open(lambda:True); turn.record('tool',{'result':'private-old'}); turn.finish('completed')
        future = time.time()+RUN_KEEP+1
        MemoryJournal(self.server.memory,clock=lambda:future, interactions=None)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM memory_agent_runs').fetchone()[0],0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM memory_agent_events').fetchone()[0],0)

    def test_pipeline_request_has_conversation_and_job_but_no_window_source(self):
        self.source()
        self.server.capture = SimpleNamespace(window_text=lambda:{'text':'private-window'},share_text=True,vision=None)
        self.server.observation_paused = lambda:False
        self.c.jobs.store.results_since = lambda cutoff:[{'job_id':'one','payload':{'user_request':'verify','character_id':self.server.character},'result':{'reply':'checked'},
                'updated_at':time.time(),'state':'succeeded'}]
        self.pipeline.run_once()
        evidence = json.loads(self.sessions[0].calls[0]['prompt'])['evidence']
        ids = [item['source_id'] for item in evidence['sources']]
        self.assertTrue(any(i.startswith('history:') for i in ids))
        self.assertIn('job:one',ids)
        self.assertFalse(any(i.startswith('window:') for i in ids))

    def test_reset_classifies_and_retains_content_free_budget_rows(self):
        # The schema is present independently of the registration being tested.
        self.db.execute('CREATE TABLE IF NOT EXISTS semantic_attempts (id INTEGER PRIMARY KEY,purpose TEXT,outcome TEXT,at REAL,day TEXT,counted INTEGER,conversation INTEGER)')
        self.db.execute("INSERT INTO semantic_attempts(purpose,outcome,at,day,counted,conversation) VALUES('memory_extract','succeeded',1,'2026-10-28',1,1)")
        self.db.commit()
        DataLifecycle([self.db]).clear()
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM semantic_attempts').fetchone()[0],1)

    @unittest.skipIf(sys.platform == "win32", "the test keeps an SQLite file open while deleting or replacing it, which Windows refuses (WinError 32)")
    def test_replay_preserves_windows_and_conversation_reserve_across_restart(self):
        meter = self.meter()
        start = self.now
        attempts = []
        for origin,total in (('capture',245),('user_state',91),('activity',13),('memory',62)):
            for i in range(total): attempts.append((start+i*4*3600/total,origin,i))
        admitted, restarted = [], False
        for at,origin,i in sorted(attempts):
            self.now = at
            purpose = 'memory_extract' if origin=='memory' else 'observation_interpret'
            conversation = origin=='memory' and i%2==1
            if not restarted and at>=start+2*3600:
                before = [meter.admit(p) for p in ('memory_extract','observation_interpret','facing_decide')]
                db = open_store(self.root/'domain.sqlite'); self.addCleanup(db.close)
                meter = self.server.usage = UsageMeter(db,clock=lambda:self.now)
                self.assertEqual([meter.admit(p) for p in ('memory_extract','observation_interpret','facing_decide')],before)
                restarted = True
            sources = [{'kind':'conversation' if conversation else 'role_task'}] if origin=='memory' else []
            try: self.c.semantic.run(purpose,'return JSON',{'sources':sources})
            except ValueError as exc: self.assertEqual(str(exc),'usage_cap')
            else: admitted.append((at,purpose,conversation))
        self.assertTrue(restarted)
        self.assertEqual(sum(p=='observation_interpret' for _,p,_ in admitted),120)  # 30 an hour over the four replayed hours
        self.assertEqual(sum(p=='memory_extract' for _,p,_ in admitted),40)
        self.assertGreaterEqual(sum(p=='memory_extract' and conv for _,p,conv in admitted),6)
        for at,_,_ in admitted:
            self.assertLessEqual(sum(at-3600<t<=at and p!='observation_interpret' for t,p,_ in admitted),HOUR_CAP)
        rows = self.db.execute('SELECT outcome,COUNT(*) FROM semantic_attempts GROUP BY outcome').fetchall()
        self.assertEqual(dict(rows),{'succeeded':160,'usage_cap':251})

    def test_failed_request_never_reaches_journal_as_plaintext(self):
        self.meter()
        stored = []
        def fail():
            stored.extend(self.db.execute('SELECT detail FROM memory_agent_runs').fetchall())
            raise ValueError('fixture_failed')
        self.during = fail
        with self.assertRaisesRegex(ValueError,'fixture_failed'):
            self.c.semantic.run('review','private-instructions',{'source':'private-evidence'})
        self.assertFalse('private-' in str(stored),'pending request is persisted as plaintext')

    def test_startup_scrubs_existing_failed_generation_text(self):
        turn = self.c.memory_journal.turn('failed-old','','codex','fixture','aster',{'prompt':'private-old','evidence':{'source':'private-evidence'}},purpose='review')
        turn.open(lambda:True)
        detail = {'request':json.dumps(turn.request),'output':'private-output','trace':['private-tool']}
        self.db.execute("UPDATE memory_agent_runs SET state='failed',detail=? WHERE run_id='failed-old'",(json.dumps(detail),))
        self.db.commit()
        journal = MemoryJournal(self.server.memory, interactions=None)
        rows = self.db.execute("SELECT detail FROM memory_agent_runs WHERE run_id='failed-old'").fetchall()
        self.assertFalse('private-' in str(rows),'startup retains old failure text')
        self.assertEqual(json.loads(rows[0][0])['prompt']['length'],len('private-old'))
        self.assertIsNotNone(journal)

    def test_retention_timer_purges_details_without_reads(self):
        turn = self.c.memory_journal.turn('old','','codex','fixture','aster',{'prompt':'private-old'})
        turn.open(lambda:True); turn.finish('completed')
        now = [time.time()]
        with patch('threading.Timer') as timer:
            journal = MemoryJournal(self.server.memory,clock=lambda:now[0], interactions=None)
            self.assertTrue(timer.called)
            self.assertEqual(timer.call_args.args[0],3600)
            now[0] += DETAIL_KEEP+1
            timer.call_args.args[1]()
            self.assertIsNone(self.db.execute("SELECT detail FROM memory_agent_runs WHERE run_id='old'").fetchone()[0])
            self.assertEqual(timer.call_count,2)
            self.assertIsNotNone(journal)

    def test_daily_purpose_caps_and_facing_hourly_count(self):
        meter = self.meter()
        for purpose,cap in (('proactive_decide',10),('observation_vision',20),('memory_extract',40)):
            with self.subTest(purpose=purpose):
                self.db.execute('DELETE FROM model_usage'); self.db.commit()
                for i in range(cap):
                    self.assertTrue(meter.admit(purpose))
                    meter.record('fixture',purpose,None)
                    self.now += 301
                self.assertFalse(meter.admit(purpose))
                self.now += 86400
        for _ in range(HOUR_CAP): meter.record('fixture','facing_decide',None)
        self.assertFalse(meter.admit('facing_decide'))
        self.assertTrue(meter.admit('observation_interpret'))
        self.assertTrue(meter.admit('character_agent'))

    @unittest.skipIf(sys.platform == "win32", "the test keeps an SQLite file open while deleting or replacing it, which Windows refuses (WinError 32)")
    def test_saturated_hour_survives_restart_and_resets_at_boundary(self):
        meter = self.meter()
        for _ in range(HOUR_CAP): meter.record('fixture','review',None)
        self.assertFalse(meter.admit('review'))
        db = open_store(self.root/'domain.sqlite'); self.addCleanup(db.close)
        restarted = UsageMeter(db,clock=lambda:self.now)
        self.assertFalse(restarted.admit('review'))
        self.now += 3600
        self.assertTrue(restarted.admit('review'))

    def test_scheduler_prioritizes_and_replaces_pending_requests(self):
        from character_agent.services.semantic import SemanticScheduler
        scheduler = SemanticScheduler()
        scheduler.acquire('review',lambda:True)
        order, errors, workers = [], [], []
        def submit(purpose,label):
            def work():
                try: scheduler.acquire(purpose,lambda:True)
                except ValueError as exc: errors.append((label,str(exc)))
                else:
                    order.append(label)
                    scheduler.release()
            worker = threading.Thread(target=work); worker.start(); workers.append(worker)
        for purpose,label in (('facing_decide','old'),('facing_decide','new'),('observation_brief','brief'),
                              ('memory_extract','memory'),('proactive_decide','proactive'),('character_agent','visible')):
            submit(purpose,label)
            deadline = time.monotonic()+2
            while time.monotonic()<deadline:
                with scheduler.condition:
                    if purpose in scheduler.pending and (label!='new' or errors): break
                time.sleep(.001)
            else: self.fail('request did not queue')
        scheduler.release()
        for worker in workers: worker.join(2); self.assertFalse(worker.is_alive())
        self.assertEqual(order,['visible','proactive','memory','new','brief'])
        self.assertEqual(errors,[('old','semantic_cancelled')])

    def test_thought_queues_with_proactive_decisions_behind_visible_work(self):
        from character_agent.services.semantic import SemanticScheduler
        self.assertEqual(SemanticScheduler.priority('thought'),SemanticScheduler.priority('proactive_decide'))
        self.assertGreater(SemanticScheduler.priority('thought'),SemanticScheduler.priority('character_agent'))

    def test_a_users_look_queues_first_and_an_automatic_one_last(self):
        from character_agent.services.semantic import SemanticScheduler
        self.assertEqual(SemanticScheduler.priority('user_vision'),0)
        self.assertEqual(SemanticScheduler.priority('observation_vision'),4)

    def test_only_a_users_look_passes_the_spent_background_caps(self):
        from character_agent.services.semantic import SemanticVision
        meter = self.meter()
        for _ in range(HOUR_CAP): meter.record('fixture','observation_vision',None)
        self.reply = {'description':'一个终端窗口'}
        with self.assertRaisesRegex(ValueError,'usage_cap'):
            SemanticVision(self.c.semantic).describe(b'png')
        self.assertEqual(SemanticVision(self.c.semantic).describe(b'png',user=True),'一个终端窗口')
        self.assertEqual(self.db.execute("SELECT purpose,outcome,counted FROM semantic_attempts"
                                         " WHERE outcome='usage_cap' OR purpose='user_vision'").fetchall(),
                         [('observation_vision','usage_cap',0),('user_vision','succeeded',0)])

    def test_queue_timeout_records_busy_without_private_writes(self):
        self.meter()
        self.c.semantic.slot.acquire()
        before = self.counts()
        try:
            with patch('character_agent.services.semantic.time.monotonic',side_effect=itertools.chain([0,0],itertools.repeat(31))):
                with self.assertRaisesRegex(ValueError,'semantic_busy'):
                    self.c.semantic.run('facing_decide','private',{'private':'private-evidence'})
        finally: self.c.semantic.slot.release()
        self.assertEqual(self.counts(),before)
        self.assertEqual(self.db.execute('SELECT outcome,counted FROM semantic_attempts').fetchall(),[('busy',0)])


if __name__=='__main__': unittest.main()
