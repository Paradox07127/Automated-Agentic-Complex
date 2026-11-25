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

    def test_steer_and_its_result(self):
        ready = ('{"v": 1, "seq": 1, "type": "ready", "tool_names": [], "tool_inventory_verified": true, "model": "m", '
                 '"capabilities": {"cancel": "native", "tool_injection": "in_process", "builtin_tools": "unverified", '
                 '"system_prompt": "native", "usage": "none", "event_scope": "session", "native_questions": false, '
                 '"steer": "%s"}}\n')
        steer = '{"v": 1, "type": "steer", "run_id": "r", "steer_id": "s", "text": %s}\n'
        answer = '{"v": 1, "seq": 2, "type": "steer_result", "run_id": "r", "steer_id": "s", "accepted": %s, "code": %s}\n'
        self.assertIsNone(check([ready % "native", steer % '"change of plan"', answer % ("true", "null")]))
        self.assertIsNone(check([ready % "unsupported", steer % '"x"', answer % ("false", '"unsupported"')]))
        self.assertEqual(check([ready % "native", steer % '""']), "line 1: steer.text missing or not nonempty_str")
        self.assertEqual(check([ready % "native", answer % ('"yes"', "null")]),
                         "line 1: steer_result.accepted missing or not bool")
        self.assertTrue(check([ready % "sometimes"]).startswith("line 0: capabilities.steer must be one of"))

    def test_frame_size_counts_the_newline(self):
        frame = '{"v": 1, "seq": 1, "type": "error", "code": "x", "message": "%s"}'
        pad = 40 * 1024 * 1024 - len(frame % "") - 1
        self.assertIsNone(check([frame % ("a" * pad) + "\n"]))
        self.assertEqual(check([frame % ("a" * (pad + 1)) + "\n"]), "line 0: frame larger than MAX_FRAME")


if __name__ == "__main__":
    unittest.main()
