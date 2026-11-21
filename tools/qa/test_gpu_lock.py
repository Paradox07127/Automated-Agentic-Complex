import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'tools/platform/gpu-lock.sh'


class GpuLock(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = dict(os.environ, AAC_LOCK_DIR=self.tmp.name, AAC_LOCK='gpu')

    def hold(self, owner):
        lock = Path(self.tmp.name, 'gpu.lock')
        lock.mkdir()
        holder = subprocess.Popen(['sleep', '60'])
        self.addCleanup(holder.kill)
        (lock / 'pid').write_text(str(holder.pid))
        (lock / 'owner').write_text(owner + '\n')

    def run_lock(self, wait):
        start = time.time()
        done = subprocess.run(['bash', str(SCRIPT), 'probe', 'true'], env=dict(self.env, AAC_LOCK_WAIT=str(wait)),
                              capture_output=True, text=True, timeout=30)
        return done, time.time() - start

    def test_free_lock_runs_the_command(self):
        done, _ = self.run_lock(1)
        self.assertEqual(done.returncode, 0)

    def test_a_live_holder_makes_it_give_up_with_the_owner_named(self):
        self.hold('gate:other-checkout 2026-11-17T07:00:00Z')
        done, seconds = self.run_lock(1)
        self.assertEqual(done.returncode, 75)
        self.assertIn('gate:other-checkout', done.stderr)
        self.assertLess(seconds, 10)

    def test_a_dead_holder_is_reclaimed(self):
        lock = Path(self.tmp.name, 'gpu.lock')
        lock.mkdir()
        (lock / 'pid').write_text('999999')
        done, _ = self.run_lock(1)
        self.assertEqual(done.returncode, 0)


if __name__ == '__main__':
    unittest.main()
