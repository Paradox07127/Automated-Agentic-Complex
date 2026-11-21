"""app/Resources/parent_watch.py on Windows: its command dies with the watcher's TerminateProcess and with its parent's
exit, and its exit status is the watcher's."""
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

WATCH = Path(__file__).resolve().parents[3] / "app" / "Resources" / "parent_watch.py"
# Starts the watcher around argv[1:], prints its pid, then on `wait` prints its status; on stdin EOF it exits. The watcher
# gets no stdin, as from the shell: Python's startup on a pipe this parent is blocked reading would wait for that read.
PARENT = """import os, subprocess, sys
watcher = subprocess.Popen([sys.executable, "-I", "-B", sys.argv[1], "--parent-pid", str(os.getpid()), "--", *sys.argv[2:]],
                           stdin=subprocess.DEVNULL)
print(watcher.pid, flush=True)
if sys.stdin.readline() == "wait\\n":
    print(watcher.wait(), flush=True)
"""
# Publishes its pid in argv[1], then stays a minute or exits with argv[2].
CHILD = """import os, sys, time
open(sys.argv[1] + ".tmp", "w", encoding="utf-8").write(str(os.getpid()))
os.replace(sys.argv[1] + ".tmp", sys.argv[1])
if len(sys.argv) > 2:
    sys.exit(int(sys.argv[2]))
time.sleep(60)
"""
SYNCHRONIZE, PROCESS_TERMINATE, WAIT_OBJECT_0 = 0x00100000, 0x0001, 0


@unittest.skipUnless(os.name == "nt", "the Windows branch of parent_watch.py")
class ParentWatchWindowsTests(unittest.TestCase):
    def setUp(self):
        import ctypes
        from ctypes import wintypes
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel32.OpenProcess.restype, self.kernel32.OpenProcess.argtypes = wintypes.HANDLE, (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        self.kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        self.kernel32.TerminateProcess.argtypes = (wintypes.HANDLE, wintypes.UINT)
        self.kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)

    def start(self, *child_args):
        """The parent, the watcher's pid and a handle to the command; no handle for one that exits at once."""
        pid_file, errors = self.dir / "child.pid", self.dir / "stderr.txt"
        # The watcher and the command write their tracebacks to the parent's stderr.
        with open(errors, "wb") as stderr:
            parent = subprocess.Popen([sys.executable, "-I", "-B", "-c", PARENT, str(WATCH), sys.executable, "-I", "-B", "-c", CHILD,
                                       str(pid_file), *child_args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
                                      encoding="utf-8")
        self.addCleanup(parent.wait, 10)
        self.addCleanup(parent.stdin.close)
        self.addCleanup(parent.stdout.close)
        watcher = int(parent.stdout.readline())
        deadline = time.monotonic() + 20
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue(pid_file.exists(), f"no command pid; parent {parent.poll()}, stderr: "
                        f"{errors.read_text(encoding='utf-8', errors='replace')}")
        if child_args:
            return parent, watcher, None
        # Opened while the watcher still holds the command, so its pid cannot be reused yet.
        child = self.kernel32.OpenProcess(SYNCHRONIZE | PROCESS_TERMINATE, False, int(pid_file.read_text(encoding="utf-8")))
        self.assertTrue(child)
        self.addCleanup(self.kernel32.CloseHandle, child)
        self.addCleanup(self.kernel32.TerminateProcess, child, 1)
        return parent, watcher, child

    def gone(self, process):
        return self.kernel32.WaitForSingleObject(process, 5000) == WAIT_OBJECT_0

    def test_terminating_the_watcher_ends_its_command(self):
        parent, watcher, child = self.start()
        self.assertFalse(self.kernel32.WaitForSingleObject(child, 200) == WAIT_OBJECT_0)
        os.kill(watcher, signal.SIGTERM)
        self.assertTrue(self.gone(child))

    def test_the_parent_exiting_ends_the_command(self):
        parent, watcher, child = self.start()
        parent.stdin.close()
        self.assertEqual(parent.wait(10), 0)
        self.assertTrue(self.gone(child))

    def test_the_watcher_exits_with_the_command_status(self):
        parent, watcher, child = self.start("7")
        parent.stdin.write("wait\n")
        parent.stdin.flush()
        self.assertEqual(parent.stdout.readline().strip(), "7")


if __name__ == "__main__":
    unittest.main()
