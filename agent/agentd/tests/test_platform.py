"""infra.platform on the platform the tests run on: POSIX on the Mac, Windows on the Windows host."""
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock
import warnings

AGENTD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENTD))
from character_agent.harness.transport import runner_environment
from infra.platform import (child_environment, lock_file, make_private_dir, new_group_options, release_group,
                            signal_group, track_group, unlock_file)

# Holds an exclusive lock on argv[1] until killed; writes argv[2] once it holds it.
HOLDER = ("import sys,time;sys.path.insert(0,{agentd!r});from infra.platform import lock_file;"
          "f=open(sys.argv[1],'a',encoding='utf-8');lock_file(f);open(sys.argv[2],'w',encoding='utf-8').close();time.sleep(600)")
# Starts HOLDER as its own child, so killing the group must reach a grandchild.
PARENT = ("import subprocess,sys,time;subprocess.Popen([sys.executable,'-I','-c',sys.argv[1],*sys.argv[2:]],"
          "creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0));time.sleep(600)")


def wait_for(predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def free(path):
    with open(path, "a", encoding="utf-8") as stream:
        try:
            lock_file(stream, blocking=False)
        except BlockingIOError:
            return False
        unlock_file(stream)
        return True


class LockTests(unittest.TestCase):
    def test_a_held_lock_refuses_a_second_open_until_unlocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".lock"
            with open(path, "a", encoding="utf-8") as first:
                lock_file(first)
                self.assertFalse(free(path))
                unlock_file(first)
                self.assertTrue(free(path))

    def test_closing_the_holder_releases_the_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".lock"
            fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
            lock_file(fd, blocking=False)
            self.assertFalse(free(path))
            os.close(fd)
            self.assertTrue(free(path))


class GroupTests(unittest.TestCase):
    def test_killing_the_group_ends_a_grandchild(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock, ready = Path(tmp) / ".lock", Path(tmp) / "ready"
            proc = subprocess.Popen([sys.executable, "-I", "-c", PARENT, HOLDER.format(agentd=str(AGENTD)), str(lock), str(ready)],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    **new_group_options())
            track_group(proc)
            try:
                self.assertTrue(wait_for(ready.exists), "grandchild never took the lock")
                self.assertFalse(free(lock))
                signal_group(proc, force=True)
                proc.wait(timeout=5)
                self.assertTrue(wait_for(lambda: free(lock)), "grandchild outlived its group")
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
                release_group(proc)


class EnvironmentTests(unittest.TestCase):
    def test_runner_environment_starts_python_with_asyncio(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = runner_environment(tmp)
            result = subprocess.run([sys.executable, "-I", "-c", "import asyncio, socket, ssl, tempfile; print(tempfile.gettempdir())"],
                                    env=env, capture_output=True, text=True, encoding="utf-8", timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(Path(result.stdout.strip()).resolve(), (Path(tmp) / "tmp").resolve())

    @unittest.skipIf(sys.platform == "win32", "POSIX allowlist")
    def test_posix_allowlist_is_path_and_tmpdir(self):
        self.assertEqual(child_environment("/x/tmp"), {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": "/x/tmp"})

    @unittest.skipUnless(sys.platform == "win32", "Windows allowlist")
    def test_windows_allowlist_keeps_what_child_processes_need(self):
        env = child_environment(r"C:\x\tmp")
        for key in ("SystemRoot", "SYSTEMDRIVE", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT", "COMSPEC"):
            self.assertEqual(env[key], os.environ[key], key)
        self.assertEqual((env["TEMP"], env["TMP"]), (r"C:\x\tmp", r"C:\x\tmp"))
        self.assertTrue(env["PATH"].lower().startswith(os.environ["SystemRoot"].lower() + "\\system32"))

    @unittest.skipUnless(sys.platform == "win32", "the Store package registry")
    def test_store_app_folders_match_the_package_name_prefix(self):
        import infra.platform.windows as windows
        packages = {"OpenAI.CodexPrimaryRuntime.v26_26.1119.907.0_x64__3k8sg7r9htsxt": r"C:\Apps\Runtime",
                    "OpenAI.Codex_26.1117.4957.0_x64__2p2nqsd0c76g0": r"C:\Apps\Codex"}
        class Key:
            def __init__(self, name=None): self.name = name
            def __enter__(self): return self
            def __exit__(self, *_): return False
        registry = type(sys)("winreg")
        registry.HKEY_CURRENT_USER = Key()
        registry.OpenKey = lambda parent, name: Key(name)
        registry.QueryInfoKey = lambda key: (len(packages), 0, 0)
        registry.EnumKey = lambda key, i: list(packages)[i]
        registry.QueryValueEx = lambda key, value: (packages[key.name], 1)
        with unittest.mock.patch.object(windows, "winreg", registry):
            self.assertEqual(windows.store_app_folders("OpenAI.Codex_"), [r"C:\Apps\Codex"])

    @unittest.skipIf(sys.platform == "win32", "POSIX has no Store packages")
    def test_posix_has_no_store_app_folders(self):
        from infra.platform import store_app_folders
        self.assertEqual(store_app_folders("OpenAI.Codex_"), [])


class PathTests(unittest.TestCase):
    def test_private_dir_is_created_again_without_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a" / "state"
            make_private_dir(path)
            make_private_dir(path)
            (path / "f").write_text("x", encoding="utf-8")
            self.assertEqual((path / "f").read_text(encoding="utf-8"), "x")
            if sys.platform != "win32":
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)

    @unittest.skipIf(sys.platform == "win32", "creating a symlink needs a privilege on Windows")
    def test_private_dir_refuses_a_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "real").mkdir()
            (Path(tmp) / "link").symlink_to(Path(tmp) / "real")
            with self.assertRaises(OSError):
                make_private_dir(Path(tmp) / "link")


class SourceTests(unittest.TestCase):
    def test_both_platform_modules_compile_without_warnings(self):
        # Each is compiled only on its own platform, so a warning in windows.py never shows on the Mac.
        for path in sorted((AGENTD / "infra/platform").glob("*.py")):
            with self.subTest(path.name), warnings.catch_warnings():
                warnings.simplefilter("error")
                compile(path.read_text(encoding="utf-8"), str(path), "exec")



class MachineWordTests(unittest.TestCase):
    """The prompts name the machine she runs on: a Mac on macOS, a computer on Windows."""

    def test_prompts_name_this_platforms_machine(self):
        import infra.platform as platform
        from brain import persona
        from character_agent import integration
        from tool_gateway import computer_toolset
        expected = ("这台电脑", "the user's computer") if sys.platform == "win32" else ("这台 Mac", "the user's Mac")
        self.assertEqual((platform.THIS_MACHINE, platform.USER_MACHINE), expected)
        self.assertIn(platform.USER_MACHINE, integration.LORE_LABELS["fanon"])
        self.assertIn(platform.USER_MACHINE, computer_toolset.SYSTEM.splitlines()[0])
        source = Path(persona.__file__).read_text(encoding="utf-8")
        self.assertNotIn("这台 Mac", source)
        self.assertIn("USER_MACHINE", source)

if __name__ == "__main__":
    unittest.main()
