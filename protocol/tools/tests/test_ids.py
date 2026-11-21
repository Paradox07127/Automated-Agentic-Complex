"""Each file that keeps its own copy of an Endfield identifier still holds the value in protocol/ids.json."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
IDS = ROOT / "protocol" / "ids.json"
PATHS = ROOT / "agent" / "agentd" / "infra" / "paths.py"



def value(ids, key):
    for part in key.split("."):
        ids = ids[part]
    return ids


class IdsTest(unittest.TestCase):
    def setUp(self):
        self.ids = json.loads(IDS.read_text(encoding="utf-8"))

    def test_copies_hold_value(self):
        self.assertEqual(self.ids["schema"], "endfield-ids/v1")
        for key, files in self.ids["copies"].items():
            v = value(self.ids, key)
            for rel in files:
                with self.subTest(key=key, file=rel):
                    path = ROOT / rel
                    self.assertTrue(path.is_file(), rel)
                    text = path.read_text(encoding="utf-8")
                    self.assertIn(str(v), text, f"{rel} lacks {key} = {v!r}")

    def test_agentd_paths_equal_ids(self):
        spec = importlib.util.spec_from_file_location("endfield_ids_infra_paths", PATHS)
        paths = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(paths)
        ids = self.ids
        self.assertEqual(paths.COMPANION_BUNDLE, ids["bundle"]["companion"])
        self.assertEqual(paths.AGENTD_PORT, ids["ports"]["agentd"])
        self.assertEqual(paths.APP_STATE_DIR, "~/" + ids["dirs"]["agentd_state"])
        self.assertEqual(paths.COMPANION_SUPPORT_DIR, Path.home() / ids["dirs"]["companion_support"])


if __name__ == "__main__":
    unittest.main()
