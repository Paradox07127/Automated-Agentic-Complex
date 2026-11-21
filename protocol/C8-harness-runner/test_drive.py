"""Exercise the standalone C8 driver through its command line."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class DriveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def drive(self, scenario, argv):
        script = self.root / "scenario.json"
        script.write_text(json.dumps(scenario), encoding="utf-8")
        return subprocess.run([sys.executable, "-I", str(HERE / "drive.py"),
                               "--script", str(script), "--", *map(str, argv)],
                              capture_output=True, text=True, timeout=65, encoding="utf-8")

    def test_ready_without_capabilities(self):
        runner = self.root / "bad_runner.py"
        runner.write_text('''import json, sys
json.loads(sys.stdin.readline())
print(json.dumps({"v": 1, "seq": 1, "type": "ready", "tool_names": [],
                  "tool_inventory_verified": False, "model": "fixture"}), flush=True)
for line in sys.stdin:
    if json.loads(line)["type"] == "close":
        break
''', encoding="utf-8")
        result = self.drive({
            "init": {"v": 1, "type": "init", "config": {}, "system_prompt": "Fixture", "tools": []},
            "query": {"v": 1, "type": "query", "run_id": "run-1", "prompt": "Hi", "history": None},
            "tool_results": {},
        }, [sys.executable, "-I", "-B", runner])
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("C8-DRIVE fail", result.stdout)
        self.assertIn("ready.capabilities missing", result.stdout)


if __name__ == "__main__":
    unittest.main()
