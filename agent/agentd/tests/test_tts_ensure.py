from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voice.tts_ensure import TtsEnsurer  # noqa: E402

SCRIPT = "/srv/tts/ondemand/tts_ondemand.sh"


class FakeRun:
    """Stands in for subprocess.run: answers `stdout` with `code`, after `gate` opens when one is given."""
    def __init__(self, stdout="ready 3\n", code=0, gate=None, error=None):
        self.stdout, self.code, self.gate, self.error = stdout, code, gate, error
        self.calls = []

    def __call__(self, command, **kwargs):
        self.calls.append((command, kwargs))
        if self.gate is not None:
            self.gate.wait(5)
        if self.error is not None:
            raise self.error
        return subprocess.CompletedProcess(command, self.code, self.stdout, "")


class TtsEnsurerTest(unittest.TestCase):
    def test_ready_runs_the_ws_script_over_ssh(self):
        run = FakeRun()
        ensurer = TtsEnsurer("ws", SCRIPT, run=run)
        ensurer.request()
        self.assertTrue(ensurer.wait_ready(5))
        command, kwargs = run.calls[0]
        self.assertEqual(command, ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", "ws", SCRIPT, "ensure"])
        self.assertEqual(kwargs["timeout"], 200)

    def test_a_host_that_looks_like_an_option_stays_the_host(self):
        run = FakeRun()
        ensurer = TtsEnsurer("-oProxyCommand=touch x", SCRIPT, run=run)
        ensurer.request()
        ensurer.wait_ready(5)
        command, _ = run.calls[0]
        self.assertEqual(command[command.index("--") + 1], "-oProxyCommand=touch x")

    def test_concurrent_requests_run_once(self):
        gate = threading.Event()
        run = FakeRun(gate=gate)
        ensurer = TtsEnsurer("ws", SCRIPT, run=run)
        ensurer.request()
        ensurer.request()
        self.assertFalse(ensurer.wait_ready(0.1))  # still running
        gate.set()
        self.assertTrue(ensurer.wait_ready(5))
        self.assertEqual(len(run.calls), 1)

    def test_fail_is_not_ready(self):
        for run in (FakeRun("fail gpu busy\n", code=1), FakeRun("", code=255),
                    FakeRun(error=subprocess.TimeoutExpired("ssh", 200))):
            with self.subTest(stdout=run.stdout, error=run.error):
                ensurer = TtsEnsurer("ws", SCRIPT, run=run)
                ensurer.request()
                self.assertFalse(ensurer.wait_ready(5))

    def test_a_fresh_success_skips_the_next_run(self):
        now = [100.0]
        run = FakeRun()
        ensurer = TtsEnsurer("ws", SCRIPT, run=run, clock=lambda: now[0])
        ensurer.request()
        self.assertTrue(ensurer.wait_ready(5))
        now[0] += 29
        ensurer.request()
        self.assertTrue(ensurer.wait_ready(5))
        self.assertEqual(len(run.calls), 1)
        now[0] += 2
        ensurer.request()
        self.assertTrue(ensurer.wait_ready(5))
        self.assertEqual(len(run.calls), 2)

    def test_a_failure_skips_requests_for_90_seconds(self):
        now = [100.0]
        run = FakeRun("fail down\n", code=1)
        ensurer = TtsEnsurer("ws", SCRIPT, run=run, clock=lambda: now[0])
        ensurer.request()
        self.assertFalse(ensurer.wait_ready(5))
        now[0] += 89
        ensurer.request()
        started = time.monotonic()
        self.assertFalse(ensurer.wait_ready(5))
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertEqual(len(run.calls), 1)

    def test_a_failure_is_retried_once_90_seconds_have_passed(self):
        now = [100.0]
        run = FakeRun("fail down\n", code=1)
        ensurer = TtsEnsurer("ws", SCRIPT, run=run, clock=lambda: now[0])
        ensurer.request()
        self.assertFalse(ensurer.wait_ready(5))
        now[0] += 91
        ensurer.request()
        ensurer.wait_ready(5)
        self.assertEqual(len(run.calls), 2)

    def test_on_change_reports_start_and_ready(self):
        ensurer, events = TtsEnsurer("ws", SCRIPT, run=FakeRun()), []
        ensurer.on_change = lambda *event: events.append(event)
        ensurer.request()
        self.assertTrue(ensurer.wait_ready(5))
        self.assertEqual(events, [("ensure_started", None, None), ("ensure_ready", "ready 3", None)])

    def test_on_change_reports_failure_with_the_negative_cache_end(self):
        now = [100.0]
        ensurer, events = TtsEnsurer("ws", SCRIPT, run=FakeRun("fail down\n", code=1), clock=lambda: now[0]), []
        ensurer.on_change = lambda *event: events.append(event)
        ensurer.request()
        self.assertFalse(ensurer.wait_ready(5))
        self.assertEqual(events[-1], ("ensure_failed", "fail down", 190.0))

    def test_skipped_requests_report_nothing(self):
        now = [100.0]
        ensurer, events = TtsEnsurer("ws", SCRIPT, run=FakeRun("fail down\n", code=1), clock=lambda: now[0]), []
        ensurer.request()
        self.assertFalse(ensurer.wait_ready(5))
        ensurer.on_change = lambda *event: events.append(event)
        ensurer.request()
        self.assertEqual(events, [])

    def test_clear_negative_lets_the_next_request_run(self):
        now = [100.0]
        run = FakeRun("fail down\n", code=1)
        ensurer = TtsEnsurer("ws", SCRIPT, run=run, clock=lambda: now[0])
        ensurer.request()
        self.assertFalse(ensurer.wait_ready(5))
        ensurer.clear_negative()
        ensurer.request()
        ensurer.wait_ready(5)
        self.assertEqual(len(run.calls), 2)


if __name__ == "__main__":
    unittest.main()
