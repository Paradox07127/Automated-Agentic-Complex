r"""Character library reads past MAX_PATH: the \\?\ form of infra.platform and a library deeper than 300 characters."""
import json
import ntpath
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

AGENTD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENTD))
from infra.platform import long_path, plain_path, windows_long_path, windows_plain_path

FIXTURE = AGENTD / "tests" / "fixtures" / "characters"


class ConversionTests(unittest.TestCase):
    def test_drive_path_gets_the_prefix_and_backslashes(self):
        self.assertEqual(windows_long_path("D:\\lib/packages\\a\\..\\b\\card.json"), "\\\\?\\D:\\lib\\packages\\b\\card.json")
        self.assertEqual(windows_plain_path("\\\\?\\D:\\lib\\card.json"), "D:\\lib\\card.json")

    def test_unc_path_gets_the_unc_prefix(self):
        self.assertEqual(windows_long_path("\\\\server\\share\\lib\\card.json"), "\\\\?\\UNC\\server\\share\\lib\\card.json")
        self.assertEqual(windows_plain_path("\\\\?\\UNC\\server\\share\\lib\\card.json"), "\\\\server\\share\\lib\\card.json")

    def test_prefixed_path_is_left_alone(self):
        for path in ("\\\\?\\D:\\lib\\card.json", "\\\\?\\UNC\\server\\share\\card.json"):
            self.assertEqual(windows_long_path(path), path)
            self.assertEqual(windows_long_path(windows_long_path(path)), path)
        self.assertEqual(windows_plain_path("D:\\lib\\card.json"), "D:\\lib\\card.json")

    def test_relative_path_is_made_absolute_first(self):
        result = windows_long_path("lib\\current.json")
        self.assertTrue(result.startswith("\\\\?\\") and result.endswith("\\lib\\current.json"), result)
        if sys.platform == "win32":
            self.assertEqual(result, "\\\\?\\" + os.path.join(os.getcwd(), "lib", "current.json"))

    def test_this_platform_takes_the_windows_form_only_on_windows(self):
        path = str(FIXTURE / "current.json")
        if sys.platform == "win32":
            self.assertEqual(long_path(path), windows_long_path(path))
        else:
            self.assertEqual(long_path(path), path)
        self.assertEqual(plain_path(long_path(path)), path)


@unittest.skipUnless(sys.platform == "win32", "MAX_PATH is a Windows limit")
class LongLibraryTests(unittest.TestCase):
    # The build host has the system long-path switch on, so a plain path would open too: this proves that the
    # prefixed paths agentd now uses read a library this deep, not that a plain one fails.
    def test_repository_reads_a_library_deeper_than_300_characters(self):
        from brain.characters import Repository
        from character_library import Library
        tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, long_path(tmp), True)
        root = os.path.join(tmp, "l" * 120, "m" * 120, "library")
        shutil.copytree(long_path(FIXTURE), long_path(root))
        longest = max(len(os.path.join(d, n)) - len(long_path(root)) for d, _, ns in os.walk(long_path(root)) for n in ns)
        self.assertGreater(len(root) + longest, 300)
        expected = sorted(c["id"] for c in json.loads((FIXTURE / "current.json").read_text(encoding="utf-8"))["characters"])
        repository = Repository(os.path.join(root, "current.json"))
        self.assertEqual(repository.ids(), expected)
        for cid in expected:
            self.assertTrue(repository.load_card(cid)["name"])
            self.assertTrue(str(repository.card_path(cid)).startswith("\\\\?\\"))
        for view in Library(repository.catalog.parent).entries():
            self.assertTrue(view["root"].startswith(root), view["root"])
            self.assertTrue(view["persona"].startswith(root), view["persona"])


if __name__ == "__main__":
    unittest.main()
