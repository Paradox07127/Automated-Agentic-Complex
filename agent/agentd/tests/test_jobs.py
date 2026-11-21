"""Question waits release workers without consuming the next execution window."""
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.jobs import JobCoordinator, JobStore
from personal.memory import Memory
from infra.store import open_store


class WaitingJobTests(unittest.TestCase):
    def test_k10_waiting_time_does_not_expire_execution_window(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as directory:
            db = open_store(Path(directory) / 'domain.sqlite')
            self.addCleanup(db.close)
            now = [100.]
            store = JobStore(Memory(db), clock=lambda: now[0])
            job = store.submit('question', {'user_request': 'original', 'config': {'timeout_seconds': 30}})
            store.claim()
            db.execute("UPDATE personal_jobs SET state='waiting_user' WHERE job_id=?", (job['job_id'],))
            db.commit()
            now[0] += 2 * 3600
            resumed = store.resume(job['job_id'])
            self.assertEqual(resumed['state'], 'queued')
            claimed = store.claim()
            self.assertEqual(claimed['updated_at'], now[0])
            self.assertEqual(claimed['payload']['config']['timeout_seconds'], 30)

    def test_k10_waiting_job_releases_slot_and_resumes_after_two_hour_wait(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as directory:
            db = open_store(Path(directory) / 'domain.sqlite')
            self.addCleanup(db.close)
            now = [100.]
            store = JobStore(Memory(db), clock=lambda: now[0])
            first = store.submit('question', {'user_request': 'original', 'config': {'timeout_seconds': 30}})
            second = store.submit('other', {'user_request': 'second'})
            ran = threading.Event()
            def execute(job, cancel):
                if job['job_id'] == first['job_id']: return {'job_state': 'waiting_user'}
                return {'job_state': 'succeeded'}
            coordinator = JobCoordinator(store, execute, lambda ident: None,
                emit=lambda event: ran.set() if event['job_id'] == second['job_id'] and event['state'] == 'succeeded' else None, concurrency=1)
            self.addCleanup(coordinator.close)
            coordinator.start()
            self.assertTrue(ran.wait(2))
            self.assertEqual(store.get(first['job_id'])['state'], 'waiting_user')
            self.assertFalse(store.leased(first['job_id']))
            now[0] += 2 * 3600
            coordinator.close()
            resumed = store.resume(first['job_id'])
            self.assertEqual(resumed['job_id'], first['job_id'])
            self.assertEqual(resumed['previous_run_id'], first['run_id'])
            self.assertEqual(resumed['state'], 'queued')
            self.assertEqual(store.claim()['job_id'], first['job_id'])
            self.assertEqual(store.get(first['job_id'], private=True)['payload']['config']['timeout_seconds'], 30)
            self.assertEqual(store.get(second['job_id'])['state'], 'succeeded')
