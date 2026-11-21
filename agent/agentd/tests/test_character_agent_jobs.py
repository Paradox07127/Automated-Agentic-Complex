import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.jobs import JobStore, JobCoordinator
from personal.memory import Memory
from infra.store import open_store


class JobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = open_store(Path(self.tmp.name) / 'domain.sqlite')
        self.memory = Memory(self.db)
        self.now = 1800000000.
        self.store = JobStore(self.memory, clock=lambda: self.now)
        self.coordinator = None

    def tearDown(self):
        if self.coordinator: self.coordinator.close()
        self.db.close(); self.tmp.cleanup()

    def job(self, title='整理资料', goal=None):
        return self.store.submit(title, {'user_request': 'synthetic-private-request'}, goal)

    def wait(self, predicate):
        until = time.monotonic() + 4
        while time.monotonic() < until:
            if predicate(): return
            time.sleep(.01)
        self.fail('condition not reached')

    def test_goal_revision_and_completion_require_verified_jobs(self):
        goal = self.store.create_goal('目标', '持续整理项目证据')
        with self.assertRaisesRegex(ValueError, 'goal_version_changed'):
            self.store.update_goal(goal['goal_id'], 2, 'paused')
        with self.assertRaisesRegex(ValueError, 'goal_results_not_verified'):
            self.store.update_goal(goal['goal_id'], 1, 'completed')
        job = self.job(goal=goal['goal_id']); self.store.claim()
        self.store.settle(job['job_id'], 'needs_review')
        with self.assertRaisesRegex(ValueError, 'goal_results_not_verified'):
            self.store.update_goal(goal['goal_id'], 1, 'completed')
        self.store.resume(job['job_id']); self.store.claim(); self.store.settle(job['job_id'], 'succeeded')
        self.assertEqual(self.store.update_goal(goal['goal_id'], 1, 'completed')['state'], 'completed')

    def test_paused_goal_does_not_launch_queued_work(self):
        goal = self.store.create_goal('项目', '资料核查')
        self.job(goal=goal['goal_id'])
        self.store.update_goal(goal['goal_id'], 1, 'paused')
        self.assertIsNone(self.store.claim())
        with self.assertRaisesRegex(ValueError, 'goal_not_active'): self.job(goal=goal['goal_id'])

    def test_payload_is_private_and_stable_status_events_have_no_request_text(self):
        job = self.job()
        self.assertNotIn('payload', self.store.get(job['job_id']))
        self.assertNotIn('synthetic-private', json.dumps(self.store.pending_events()))
        self.assertIn('synthetic-private', json.dumps(self.store.get(job['job_id'], private=True)))

    def test_invalid_goal_reference_is_rejected_before_sql_or_job_creation(self):
        for value in ([], {}, True, 42, '', 'x'*129):
            with self.subTest(value=value),self.assertRaisesRegex(ValueError,'invalid_job_goal'):
                self.store.submit('核查资料',{'user_request':'synthetic'},value)
        self.assertEqual(self.store.list(),[])

    def test_claim_lease_and_heartbeat(self):
        first = self.job('一'); second = self.job('二')
        claim = self.store.claim('owner')
        self.assertEqual(claim['job_id'], first['job_id'])
        self.assertTrue(self.store.leased(first['job_id']))
        self.now += 25; self.store.heartbeat('owner'); self.now += 10
        self.assertTrue(self.store.leased(first['job_id']))
        self.now += 31; self.assertFalse(self.store.leased(first['job_id']))
        self.assertEqual(self.store.claim('other')['job_id'], second['job_id'])

    def test_outbox_retry_keeps_same_event_identity(self):
        self.job(); attempts = []
        def unavailable(event): attempts.append(event); raise OSError()
        c = self.coordinator = JobCoordinator(self.store, lambda *_: {}, lambda _: None, unavailable)
        c.publish(); first = self.store.pending_events()[0]['event_id']
        c.emit = attempts.append; c.publish()
        self.assertEqual(attempts[-1]['event_id'], first)
        self.assertEqual(self.store.pending_events(), [])

    def test_worker_rolls_back_sqlite_error_and_runs_next_job(self):
        job = self.job(); failed = threading.Event(); ran = threading.Event()
        claim = self.store.claim
        def flaky_claim(owner):
            if not failed.is_set():
                with self.store.lock:
                    self.db.execute('BEGIN IMMEDIATE')
                    self.db.execute("UPDATE personal_jobs SET state='running' WHERE job_id=?", (job['job_id'],))
                failed.set()
                raise sqlite3.OperationalError('injected claim failure')
            return claim(owner)
        self.store.claim = flaky_claim
        c = self.coordinator = JobCoordinator(self.store, lambda *_: ran.set() or {'job_state': 'succeeded'}, lambda _: None, concurrency=1)
        with mock.patch('threading.excepthook'):
            c.start()
            self.assertTrue(failed.wait(1))
            self.assertTrue(ran.wait(2), 'worker did not recover after sqlite error')
        self.assertTrue(c.workers[0].is_alive())
        self.wait(lambda: self.store.get(job['job_id'])['state'] == 'succeeded')
        next_job = self.job('下一项')
        self.wait(lambda: self.store.get(next_job['job_id'])['state'] == 'succeeded')
        self.assertFalse(self.db.in_transaction)

    def test_an_idle_worker_opens_no_transaction_and_wakes_for_a_new_job(self):
        ran = threading.Event(); statements = []
        c = self.coordinator = JobCoordinator(self.store, lambda *_: ran.set() or {'job_state': 'succeeded'}, lambda _: None)
        c.start()
        time.sleep(.3)  # both workers find nothing queued and wait
        self.db.set_trace_callback(statements.append)
        time.sleep(.6)
        self.db.set_trace_callback(None)
        self.assertEqual([s for s in statements if s.startswith('BEGIN')], [])
        self.job()
        self.assertTrue(ran.wait(.5), 'a queued job did not wake an idle worker')

    def test_worker_survives_publish_error_after_execution(self):
        ran = threading.Event(); injected = threading.Event()
        job = self.job(); pending_events = self.store.pending_events
        def flaky_events():
            if ran.is_set() and not injected.is_set():
                injected.set()
                with self.store.lock:
                    self.db.execute('BEGIN IMMEDIATE')
                raise sqlite3.OperationalError('injected publish failure')
            return pending_events()
        self.store.pending_events = flaky_events
        c = self.coordinator = JobCoordinator(self.store, lambda *_: ran.set() or {'job_state': 'succeeded'}, lambda _: None, concurrency=1)
        with mock.patch('threading.excepthook'):
            c.start(); self.assertTrue(injected.wait(1))
            c.workers[0].join(.4)
            self.assertTrue(c.workers[0].is_alive(), 'publish error killed worker')
            next_job = self.job('下一项')
            self.wait(lambda: self.store.get(next_job['job_id'])['state'] == 'succeeded')
        self.assertEqual(self.store.get(job['job_id'])['state'], 'succeeded')
        self.assertFalse(self.db.in_transaction)

    def test_execute_sqlite_error_rolls_back_before_failing_job(self):
        first = self.job(); second = self.job('下一项'); ran = threading.Event()
        def execute(job, cancel):
            if job['job_id'] == first['job_id']:
                with self.store.lock:
                    self.db.execute("UPDATE personal_jobs SET state='cancelled' WHERE job_id=?", (second['job_id'],))
                raise sqlite3.OperationalError('injected execution failure')
            ran.set()
            return {'job_state': 'succeeded'}
        c = self.coordinator = JobCoordinator(self.store, execute, lambda _: None, concurrency=1)
        c.start()
        self.assertTrue(ran.wait(2), 'failed execution committed an open transaction')
        self.wait(lambda: self.store.get(second['job_id'])['state'] == 'succeeded')
        self.assertEqual(self.store.get(first['job_id'])['result'], {'error': 'OperationalError', 'reason': None})
        self.assertFalse(self.db.in_transaction)

    def test_heartbeat_rolls_back_error_and_keeps_running(self):
        c = self.coordinator = JobCoordinator(self.store, lambda *_: {}, lambda _: None)
        heartbeat = self.store.heartbeat; calls = []
        def flaky_heartbeat(owner, **kwargs):
            calls.append(owner)
            if len(calls) == 1:
                with self.store.lock:
                    self.db.execute('BEGIN IMMEDIATE')
                    self.db.execute("INSERT INTO personal_job_leases VALUES('partial',?,0)", (owner,))
                raise sqlite3.OperationalError('injected heartbeat failure')
            heartbeat(owner, **kwargs)
        self.store.heartbeat = flaky_heartbeat
        with mock.patch.object(c.stopped, 'wait', side_effect=[False, False, False, True]):
            try: c._heartbeat()
            except sqlite3.OperationalError: self.fail('sqlite error escaped heartbeat')
        self.assertGreaterEqual(len(calls), 2)
        self.assertIsNone(self.db.execute("SELECT * FROM personal_job_leases WHERE job_id='partial'").fetchone())
        self.assertFalse(self.db.in_transaction)

    def test_heartbeat_recovers_expired_inactive_jobs_periodically(self):
        job = self.job(); self.store.claim('crashed-owner')
        live = self.job('仍在运行'); self.store.claim('crashed-owner')
        c = self.coordinator = JobCoordinator(self.store, lambda *_: {}, lambda _: None)
        c.cancels[live['run_id']] = (live['job_id'], threading.Event())
        ticks = []
        def tick(_):
            ticks.append(self.store.get(job['job_id'])['state'])
            if len(ticks) == 2: self.now += 31
            return len(ticks) == 4
        with mock.patch.object(c.stopped, 'wait', side_effect=tick): c._heartbeat()
        self.assertEqual(ticks, ['running', 'running', 'interrupted', 'interrupted'])
        self.assertEqual(self.store.get(live['job_id'])['state'], 'running')
        self.assertEqual(self.store.pending_events(), [])

    def test_concurrent_publishers_deliver_event_once(self):
        self.job(); entered = threading.Event(); release = threading.Event(); done = threading.Event(); delivered = []
        def emit(event):
            delivered.append(event['event_id']); entered.set(); release.wait(2)
        c = self.coordinator = JobCoordinator(self.store, lambda *_: {}, lambda _: None, emit)
        first = threading.Thread(target=c.publish)
        second = threading.Thread(target=lambda: (c.publish(), done.set()))
        first.start(); self.assertTrue(entered.wait(1)); second.start()
        try: done.wait(.1)
        finally:
            release.set(); first.join(2); second.join(2)
        self.assertEqual(len(delivered), 1)
        self.assertEqual(self.store.pending_events(), [])

    def test_heartbeat_does_not_renew_inactive_attempt_after_settlement_error(self):
        c = self.coordinator = JobCoordinator(self.store, lambda *_: {}, lambda _: None)
        job = self.job(); self.store.claim(c.owner)
        active = self.job('仍在运行'); self.store.claim(c.owner)
        c.cancels[active['run_id']] = (active['job_id'], threading.Event())
        ticks = []
        def tick(_):
            ticks.append(self.store.get(job['job_id'])['state'])
            self.now += 10
            return len(ticks) == 5
        with mock.patch.object(c.stopped, 'wait', side_effect=tick): c._heartbeat()
        self.assertEqual(self.store.get(job['job_id'])['state'], 'interrupted')
        self.assertEqual(self.store.get(active['job_id'])['state'], 'running')
        self.assertTrue(self.store.leased(active['job_id']))

    def test_double_shutdown_interrupts_running_job_once(self):
        job = self.job(); self.store.claim(); interrupted = []
        c = self.coordinator = JobCoordinator(self.store, lambda *_: {}, interrupted.append)
        c.close(); c.close()
        with mock.patch.object(c.stopped, 'wait', side_effect=[False, True]): c._heartbeat()
        self.assertEqual(interrupted, [job['job_id']])
        with self.store.lock:
            count = self.db.execute("SELECT COUNT(*) FROM personal_job_events WHERE job_id=? AND state='interrupted'", (job['job_id'],)).fetchone()[0]
        self.assertEqual(count, 1)

    def test_two_background_jobs_run_independently_and_cancel_is_targeted(self):
        started, release = {}, threading.Event()
        def execute(job, cancel):
            started[job['job_id']] = True
            while not release.wait(.01) and not cancel.is_set(): pass
            return {'job_state': 'cancelled' if cancel.is_set() else 'needs_review', 'reply': 'synthetic result'}
        c = self.coordinator = JobCoordinator(self.store, execute, lambda _: None)
        one, two = self.job('一'), self.job('二'); c.start()
        self.wait(lambda: len(started) == 2)
        self.assertTrue(c.cancel(one['job_id']))
        self.assertEqual(self.store.get(one['job_id'])['state'], 'cancelled')
        self.assertEqual(self.store.get(two['job_id'])['state'], 'running')
        release.set()
        self.wait(lambda: self.store.get(two['job_id'])['state'] == 'needs_review')
        self.assertEqual(self.store.get(one['job_id'])['state'], 'cancelled')

    def test_resume_retains_job_and_goal_and_creates_new_attempt(self):
        goal = self.store.create_goal('项目', '持续整理')
        job = self.job(goal=goal['goal_id']); self.store.claim()
        self.store.settle(job['job_id'], 'interrupted')
        resumed = self.store.resume(job['job_id'])
        self.assertEqual(resumed['job_id'], job['job_id'])
        self.assertEqual(resumed['goal_id'], goal['goal_id'])
        self.assertEqual(resumed['previous_run_id'], job['run_id'])
        self.assertNotEqual(resumed['run_id'], job['run_id'])

    def test_resume_increases_generation(self):
        job = self.job()
        self.store.claim(); self.store.settle(job['job_id'], 'interrupted')
        resumed = self.store.resume(job['job_id'])
        self.assertGreater(resumed['generation'], job['generation'])

    def test_cancelled_job_cannot_be_overwritten_by_late_success(self):
        job = self.job(); self.store.claim()
        self.store.settle(job['job_id'], 'cancelled')
        self.assertFalse(self.store.settle(job['job_id'], 'succeeded'))
        self.assertEqual(self.store.get(job['job_id'])['state'], 'cancelled')

    def test_late_attempt_cannot_settle_a_resumed_running_job(self):
        first=self.job();self.store.claim()
        self.store.settle(first['job_id'],'interrupted')
        second=self.store.resume(first['job_id']);self.store.claim()
        changed=self.store.settle(first['job_id'],'succeeded',{'reply':'obsolete'},expected_run_id=first['run_id'])
        self.assertFalse(changed)
        current=self.store.get(first['job_id'])
        self.assertEqual(current['run_id'],second['run_id']);self.assertEqual(current['state'],'running')
        self.assertTrue(self.store.leased(first['job_id']))

    def test_old_worker_completion_does_not_drop_new_attempt_cancel_handle(self):
        first_started,second_started=threading.Event(),threading.Event()
        first_release,second_release=threading.Event(),threading.Event()
        attempts=[]
        def execute(job,cancel):
            attempts.append((job['run_id'],cancel))
            if len(attempts)==1:
                first_started.set();first_release.wait(3)
                return {'job_state':'succeeded','reply':'obsolete'}
            second_started.set();second_release.wait(3)
            return {'job_state':'needs_review','reply':'current'}
        c=self.coordinator=JobCoordinator(self.store,execute,lambda _:None)
        first=self.job();c.start();self.assertTrue(first_started.wait(2))
        c.cancel(first['job_id'],interrupted=True)
        current=self.store.resume(first['job_id']);c.start();self.assertTrue(second_started.wait(2))
        try:
            first_release.set()
            self.wait(lambda:not c.is_active(first['job_id'],first['run_id']))
            self.assertEqual(self.store.get(first['job_id'])['state'],'running')
            self.assertTrue(c.is_active(first['job_id'],current['run_id']))
            c.cancel(first['job_id'])
            self.assertTrue(attempts[1][1].is_set())
        finally:first_release.set();second_release.set()

    def test_control_scans_do_not_ignore_running_work_older_than_public_page(self):
        oldest=self.job();self.store.claim()
        for n in range(101):
            self.now += 1
            recent=self.job(str(n));self.store.claim();self.store.settle(recent['job_id'],'succeeded')
        self.assertNotIn(oldest['job_id'],[j['job_id'] for j in self.store.list()])
        c=self.coordinator=JobCoordinator(self.store,lambda *_:{},lambda _:None)
        c.cancel_all('scope_revoked')
        self.assertEqual(self.store.get(oldest['job_id'])['state'],'cancelled')

    def test_recent_results_are_ordered_by_completion_not_creation(self):
        oldest=self.job();self.store.claim()
        for n in range(101):
            self.now+=1;job=self.job(str(n));self.store.claim();self.store.settle(job['job_id'],'succeeded')
        self.now+=1
        self.store.settle(oldest['job_id'],'needs_review',{'reply':'just completed'})
        self.assertEqual(self.store.results_since(self.now-1)[0]['job_id'],oldest['job_id'])
        self.assertEqual(self.store.results_since(self.now-1)[0]['result']['reply'],'just completed')

    def test_explicit_revision_keeps_scope_and_verification_and_can_select_new_kernel(self):
        payload = {'user_request': '原目标', 'instruction': '原分工', 'scope_id': 'scope-one',
            'expected_outputs': {'artifacts': [{'path': 'report.md'}]}, 'config': {'backend': 'codex'}}
        job = self.store.submit('目标', payload); self.store.claim(); self.store.settle(job['job_id'], 'interrupted')
        self.store.resume(job['job_id'], text='补充来源说明', config={'backend': 'pi'}, consent_epoch=3)
        updated = self.store.get(job['job_id'], private=True)['payload']
        self.assertIn('补充来源说明', updated['user_request'])
        self.assertEqual(updated['scope_id'], payload['scope_id'])
        self.assertEqual(updated['expected_outputs'], payload['expected_outputs'])
        self.assertEqual(updated['config']['backend'], 'pi')

    def test_parallel_claims_never_claim_same_job(self):
        self.job('一'); self.job('二'); claimed = []
        workers = [threading.Thread(target=lambda: claimed.append(self.store.claim('worker')['job_id'])) for _ in range(2)]
        for worker in workers: worker.start()
        for worker in workers: worker.join()
        self.assertEqual(len(set(claimed)), 2)

    def test_queue_is_bounded_and_clear_removes_all_private_records(self):
        for n in range(20): self.job(str(n))
        with self.assertRaisesRegex(ValueError, 'background_queue_full'): self.job('overflow')
        self.store.clear()
        self.assertEqual(self.store.list(), [])
        self.assertEqual(self.store.pending_events(), [])


if __name__ == '__main__': unittest.main()
