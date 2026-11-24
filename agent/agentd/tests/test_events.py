from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from brain.events import cue, recorded  # noqa: E402


class CueTest(unittest.TestCase):
    def test_cue_puts_facts_in_the_tag_and_the_aim_after_it(self):
        text = cue("tap", "管理员 touched your head.", "React in a line.", region="head", count=1, unused=None)
        self.assertEqual(text, '<event kind="tap" region="head" count="1">\n管理员 touched your head.\n</event>\nReact in a line.')

    def test_history_keeps_only_the_event(self):
        text = cue("tap", "管理员 touched you.", "React in a line.")
        self.assertEqual(recorded(text), '<event kind="tap">\n管理员 touched you.\n</event>')
        for plain in ("你好", "<event> is a tag", "（送了你一份礼物）"):
            self.assertEqual(recorded(plain), plain)


if __name__ == "__main__":
    unittest.main()
