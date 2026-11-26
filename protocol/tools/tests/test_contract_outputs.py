from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "protocol" / "tools"))

import gen_routes  # noqa: E402

REGENERATE = "python3 -I protocol/tools/gen_all.py --write"


class ContractOutputsTest(unittest.TestCase):
    def test_routes_json_is_generated(self):
        committed = (ROOT / "protocol" / "ui-bridge" / "routes.json").read_text(encoding="utf-8")
        self.assertTrue(committed == gen_routes.render_routes_json(),
                        f"protocol/ui-bridge/routes.json is stale; run `{REGENERATE}` from the repo root")

    def test_ts_routes_is_generated(self):
        path = ROOT / "web" / "src" / "bridge" / "agentd-routes.generated.ts"
        committed = path.read_text(encoding="utf-8") if path.is_file() else None
        self.assertTrue(committed == gen_routes.render_ts_routes(),
                        f"web/src/bridge/agentd-routes.generated.ts is stale; run `{REGENERATE}` from the repo root")

    def test_a_nullable_path_under_two_lists_is_nullable(self):
        loose = {"nullable": ["tasks[].artifacts[].opened_at"], "free_keys": []}
        self.assertEqual(gen_routes._ts_type(1.0, "tasks[].artifacts[].opened_at", loose, ""), "number | null")


if __name__ == "__main__":
    unittest.main()
