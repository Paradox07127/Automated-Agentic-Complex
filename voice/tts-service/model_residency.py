"""Conservative single-model residency and shared GPU admission, without importing torch."""
import contextlib
import fcntl
import os
from pathlib import Path
import subprocess
import time

MAX_MODELS = 1
PEAK_MIB = 4923  # measured single-model peak plus 20%; matches ondemand's reservation
HEADROOM_MIB = 8192
MIB = 1 << 20
LOCK_WAIT_SECONDS = 2


class GpuBudgetUnavailable(RuntimeError):
    pass


def process_usage():
    result = subprocess.run(
        ['nvidia-smi', '--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'],
        capture_output=True, text=True, check=True, timeout=5)
    usage = {}
    for line in result.stdout.splitlines():
        pid, memory = line.split(',')
        usage[int(pid)] = usage.get(int(pid), 0) + int(memory)
    return usage


def fields(path):
    return dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line)


class GpuAdmission:
    def __init__(self, free_bytes, job=None, usage=process_usage, pid=None):
        self.free_bytes, self.job, self.usage = free_bytes, Path(job) if job else None, usage
        self.pid = os.getpid() if pid is None else pid

    def _check(self, loading):
        reserved = 0
        if self.job:
            own = fields(self.job)
            if int(own.get('pid', 0)) != self.pid or int(own.get('peakMiB', 0)) < PEAK_MIB:
                raise GpuBudgetUnavailable('TTS requires its own registered single-model GPU reservation')
            used = self.usage()
            if not loading and used.get(self.pid, 0) > int(own['peakMiB']):
                raise GpuBudgetUnavailable('TTS exceeded its registered GPU reservation')
            for path in self.job.parent.glob('*.txt'):
                if path == self.job:
                    continue
                entry = fields(path)
                peak = float(entry.get('peakMiB', float(entry.get('peakGiB', 0)) * 1024))
                reserved += max(0, peak - used.get(int(entry.get('pid', 0)), 0))
        needed = HEADROOM_MIB + (PEAK_MIB if loading else 0)
        if self.free_bytes() / MIB - reserved < needed:
            raise GpuBudgetUnavailable('Insufficient shared GPU headroom for TTS')

    @contextlib.contextmanager
    def load(self):
        # Serialize the admission check and allocation with other shared GPU jobs.
        # Wait briefly for the lock, then fail closed; a request must not wait indefinitely.
        try:
            with contextlib.ExitStack() as stack:
                if self.job:
                    lock = stack.enter_context((self.job.parent / '.admit.lock').open('a'))
                    deadline = time.monotonic() + LOCK_WAIT_SECONDS
                    while True:
                        try:
                            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            break
                        except BlockingIOError as error:
                            if time.monotonic() >= deadline:
                                raise GpuBudgetUnavailable('GPU admission is busy; retry later') from error
                            time.sleep(0.05)
                self._check(loading=True)
                yield
                self._check(loading=False)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise GpuBudgetUnavailable('GPU admission state is unavailable') from error


class ModelResidency:
    """Only publish a fully admitted model. A failed load leaves no resident model."""
    def __init__(self, admission, cleanup):
        self.admission, self.cleanup = admission, cleanup
        self.models = {}

    def load(self, name, factory):
        if name in self.models:
            return self.models[name]
        while self.models:
            _, old = self.models.popitem()
            try:
                old.close()
            finally:
                del old
                self.cleanup()
        model = None
        try:
            with self.admission.load():
                model = factory()
        except BaseException:
            try:
                if model is not None:
                    model.close()
            finally:
                model = None
                self.cleanup()
            raise
        self.models[name] = model
        return model
