import glob
import os
import unittest

from validate import check

HERE = os.path.dirname(os.path.abspath(__file__))
EXPECTED = {
    "bad-no-capabilities.ndjson": "line 1: ready.capabilities missing or not object",
    "bad-capability-value.ndjson": "line 1: capabilities.cancel must be one of",
    "bad-capability-missing-key.ndjson": "line 1: capabilities.native_questions missing",
    "bad-v.ndjson": "line 1: v must be 1",
    "bad-seq-repeat.ndjson": "line 3: seq must increase",
}


def read(name):
    with open(os.path.join(HERE, "examples", name), encoding="utf-8") as f:
        return f.readlines()


class ExamplesTest(unittest.TestCase):
    def test_valid_examples_cover_every_runner(self):
        names = sorted(os.path.basename(p) for p in glob.glob(os.path.join(HERE, "examples", "ok-*.ndjson")))
        self.assertEqual(names, ["ok-acp-permission.ndjson", "ok-acp.ndjson", "ok-codex.ndjson", "ok-pi.ndjson"])
        for name in names:
            with self.subTest(name):
                self.assertIsNone(check(read(name)))

    def test_invalid_examples_report_their_error(self):
        names = sorted(os.path.basename(p) for p in glob.glob(os.path.join(HERE, "examples", "bad-*.ndjson")))
        self.assertEqual(names, sorted(EXPECTED))
        for name in names:
            with self.subTest(name):
                err = check(read(name))
                self.assertIsNotNone(err)
                self.assertTrue(err.startswith(EXPECTED[name]), err)

    def test_frame_size_counts_the_newline(self):
        frame = '{"v": 1, "seq": 1, "type": "error", "code": "x", "message": "%s"}'
        pad = 40 * 1024 * 1024 - len(frame % "") - 1
        self.assertIsNone(check([frame % ("a" * pad) + "\n"]))
        self.assertEqual(check([frame % ("a" * (pad + 1)) + "\n"]), "line 0: frame larger than MAX_FRAME")


if __name__ == "__main__":
    unittest.main()
