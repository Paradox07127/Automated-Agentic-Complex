"""GPU admission and real residency-controller regressions; no model or GPU required."""
import fcntl
from pathlib import Path
import tempfile
import threading
import time
import unittest

from model_residency import GpuAdmission, GpuBudgetUnavailable, ModelResidency, PEAK_MIB, HEADROOM_MIB, MIB


class ResidencyTest(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.cache = ModelResidency(GpuAdmission(lambda: 32 * 1024 * MIB), lambda: self.events.append('collect'))

    def factory(self, name):
        events = self.events
        class Model:
            def close(self):
                events.append('close:' + name)
        events.append('load:' + name)
        return Model()

    def test_same_model_is_reused_and_switches_never_retain_the_old_one(self):
        first = self.cache.load('si', lambda: self.factory('si'))
        self.assertIs(first, self.cache.load('si', lambda: self.fail('reloaded')))
        for name in ['aster', 'si'] * 10:
            self.cache.load(name, lambda: self.factory(name))
            self.assertEqual(list(self.cache.models), [name])
        self.assertEqual(self.events[:4], ['load:si', 'close:si', 'collect', 'load:aster'])

    def test_load_failure_leaves_no_cached_or_stale_model(self):
        self.cache.load('si', lambda: self.factory('si'))
        def fail():
            raise RuntimeError('synthetic load failure')
        with self.assertRaisesRegex(RuntimeError, 'synthetic'):
            self.cache.load('aster', fail)
        self.assertEqual(self.cache.models, {})
        self.assertIn('close:si', self.events)

    def test_headroom_is_checked_again_for_every_new_model(self):
        free = [32 * 1024 * MIB]
        self.cache.admission.free_bytes = lambda: free[0]
        self.cache.load('si', lambda: self.factory('si'))
        free[0] = (HEADROOM_MIB + PEAK_MIB - 1) * MIB
        with self.assertRaises(GpuBudgetUnavailable):
            self.cache.load('aster', lambda: self.fail('allocation must not start'))
        self.assertEqual(self.cache.models, {})

    def test_post_load_violation_closes_the_new_model(self):
        free = [32 * 1024 * MIB]
        self.cache.admission.free_bytes = lambda: free[0]
        def allocate():
            free[0] = (HEADROOM_MIB - 1) * MIB
            return self.factory('si')
        with self.assertRaises(GpuBudgetUnavailable):
            self.cache.load('si', allocate)
        self.assertEqual(self.cache.models, {})
        self.assertIn('close:si', self.events)


class SharedAdmissionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.job = self.root / 'tts.txt'
        self.job.write_text(f'pid=101\npeakMiB={PEAK_MIB}\nowner=fixture\n')
        self.used = {101: 0, 202: 2048}
        self.admission = GpuAdmission(lambda: 24 * 1024 * MIB, self.job, lambda: self.used, pid=101)

    def test_other_jobs_unallocated_reservations_are_subtracted(self):
        other = self.root / 'other.txt'
        other.write_text('pid=202\npeakGiB=16\nowner=other\n')
        before = other.read_bytes()
        with self.assertRaises(GpuBudgetUnavailable), self.admission.load():
            self.fail('not admitted')
        self.assertEqual(other.read_bytes(), before)
        self.used[202] = 16 * 1024
        with self.admission.load():
            pass

    def test_cannot_borrow_another_process_reservation(self):
        self.job.write_text(f'pid=999\npeakMiB={PEAK_MIB}\n')
        with self.assertRaises(GpuBudgetUnavailable), self.admission.load():
            self.fail('not admitted')

    def hold_admission_lock(self, seconds):
        held = threading.Event()
        def hold():
            with (self.root / '.admit.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                held.set()
                time.sleep(seconds)
        holder = threading.Thread(target=hold)
        holder.start()
        self.addCleanup(holder.join)
        held.wait()

    def test_briefly_busy_admission_lock_is_waited_for(self):
        self.hold_admission_lock(0.5)
        with self.admission.load():
            pass

    def test_busy_admission_lock_fails_after_bounded_wait_without_allocating(self):
        self.hold_admission_lock(3)
        start = time.monotonic()
        with self.assertRaisesRegex(GpuBudgetUnavailable, 'busy'), self.admission.load():
            self.fail('not admitted')
        self.assertLess(time.monotonic() - start, 3)

    def test_peak_overshoot_is_rejected_and_lock_is_released(self):
        with self.assertRaises(GpuBudgetUnavailable), self.admission.load():
            self.used[101] = PEAK_MIB + 1
        self.used[101] = 0
        with self.admission.load():
            pass

    def test_missing_or_malformed_registration_fails_closed(self):
        for contents in ('pid=bad\npeakMiB=4923\n', 'pid=101\npeakMiB=1\n'):
            self.job.write_text(contents)
            with self.assertRaises(GpuBudgetUnavailable), self.admission.load():
                self.fail('not admitted')
        self.job.unlink()
        with self.assertRaises(GpuBudgetUnavailable), self.admission.load():
            self.fail('not admitted')


if __name__ == '__main__':
    unittest.main()
