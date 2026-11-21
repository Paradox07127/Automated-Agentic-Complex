import glob
import os
import unittest

from validate import check

HERE = os.path.dirname(os.path.abspath(__file__))


class ExamplesTest(unittest.TestCase):
    def test_examples(self):
        paths = sorted(glob.glob(os.path.join(HERE, "examples", "*.ndjson")))
        self.assertGreaterEqual(len(paths), 7)
        for p in paths:
            with open(p, encoding="utf-8") as f:
                err = check(f.readlines())
            with self.subTest(os.path.basename(p)):
                if os.path.basename(p).startswith("ok-"):
                    self.assertIsNone(err)
                else:
                    self.assertIsNotNone(err)


if __name__ == "__main__":
    unittest.main()
