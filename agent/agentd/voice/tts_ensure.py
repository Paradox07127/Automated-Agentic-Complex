"""Start the ws TTS on demand: ssh runs the ws ensure script, which answers `ready <s>` or `fail <why>`.

The ws side stops the TTS itself after it has been idle."""
import subprocess
import sys
import threading
import time

TIMEOUT = 200.0  # seconds; covers a cold start
FRESH = 30.0  # seconds after a success in which request() runs nothing
NEGATIVE = 90.0  # seconds after a failure in which request() runs nothing, so wait_ready() answers False at once


class TtsEnsurer:
    def __init__(self, host, script, run=subprocess.run, clock=time.monotonic):
        self.host, self.script = host, script
        self.run, self.clock = run, clock
        self._lock = threading.Lock()
        self._done = threading.Event()  # set once the latest ensure has ended
        self._done.set()
        self._ready = False  # the latest ensure's outcome
        self._ready_at = None  # clock time of the latest success
        self._failed_at = None  # clock time of the latest failure
        # callable(event, why, retry_after): ensure_started, then ensure_ready or ensure_failed, whose
        # retry_after is the clock time the negative cache ends
        self.on_change = lambda event, why, retry_after: None

    def request(self):
        """Run one ensure in the background; joins the one running, and skips while a success or failure is fresh."""
        with self._lock:
            if not self._done.is_set():
                return
            if self._ready_at is not None and self.clock() - self._ready_at < FRESH:
                return
            if self._failed_at is not None and self.clock() - self._failed_at < NEGATIVE:
                return
            self._done = done = threading.Event()
        self.on_change("ensure_started", None, None)
        threading.Thread(target=self._ensure, args=(done,), daemon=True).start()

    def clear_negative(self):
        """Forget the latest failure, so the next request() runs an ensure."""
        with self._lock:
            self._failed_at = None

    def wait_ready(self, timeout):
        """Block until the current ensure ends or timeout passes; True only when it answered ready."""
        with self._lock:
            done = self._done
        return done.wait(max(0.0, timeout)) and self._ready

    def _ensure(self, done):
        start = self.clock()
        command = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", self.host, self.script, "ensure"]
        try:
            result = self.run(command, capture_output=True, text=True, timeout=TIMEOUT)
            lines = (result.stdout or "").splitlines()
            first = lines[0].strip() if lines else ""
            ready = result.returncode == 0 and first.split(" ")[0] == "ready"
            why = first or f"exit {result.returncode}"
        except subprocess.TimeoutExpired:
            ready, why = False, "timeout"
        except OSError as e:
            ready, why = False, type(e).__name__
        with self._lock:
            self._ready = ready
            if ready:
                self._ready_at, self._failed_at = self.clock(), None
            else:
                self._failed_at = self.clock()
            retry_after = None if ready else self._failed_at + NEGATIVE
        print(f"agentd: tts ensure {'ready' if ready else 'fail'} ({why}) in {self.clock() - start:.1f}s",
              file=sys.stderr)
        self.on_change("ensure_ready" if ready else "ensure_failed", why, retry_after)  # before waiters wake
        done.set()
