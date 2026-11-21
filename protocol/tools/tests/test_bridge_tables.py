from pathlib import Path
import subprocess
import sys
import unittest

GENERATOR = Path(__file__).resolve().parents[3] / "protocol" / "tools" / "gen_bridge.py"


class BridgeTablesTest(unittest.TestCase):
    def test_generated_tables_match_ops_json(self):
        self.assertTrue(GENERATOR.is_file(), GENERATOR)
        run = subprocess.run([sys.executable, "-I", "-B", str(GENERATOR), "--check"], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(run.returncode, 0, f"{run.stdout}{run.stderr}regenerate: python3 -I protocol/tools/gen_all.py --write")


if __name__ == "__main__":
    unittest.main()
