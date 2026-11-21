import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.harness import pi_install_runtime


class InstallEnvironmentTest(unittest.TestCase):
    def test_npm_gets_the_variables_node_needs_on_windows(self):
        seen = {}

        def run(command, env, **_):
            seen.update(env)
            raise RuntimeError("stop after npm is started")

        windows = {"SystemRoot": r"C:\Windows", "APPDATA": r"C:\A", "LOCALAPPDATA": r"C:\L",
                   "TEMP": r"C:\T", "TMP": r"C:\T", "USERPROFILE": r"C:\U", "SECRET_TOKEN": "x"}
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, windows), \
                mock.patch.object(pi_install_runtime.subprocess, "run", run):
            with self.assertRaises(RuntimeError):
                pi_install_runtime.install_runtime(Path(tmp) / "out", Path(__file__).resolve())
        # Windows reports os.environ keys in upper case.
        seen = {key.upper(): value for key, value in seen.items()}
        for key in ("SystemRoot", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "USERPROFILE"):
            self.assertEqual(seen.get(key.upper()), windows[key], key)
        self.assertNotIn("SECRET_TOKEN", seen)


if __name__ == "__main__":
    unittest.main()
