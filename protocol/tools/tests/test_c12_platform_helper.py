"""C12 platform-helper examples, ops.json and the CONTRACT.md tables (protocol/C12-platform-helper)."""
from pathlib import Path
import json
import re
import sys
import unittest

C12 = Path(__file__).resolve().parents[2] / "C12-platform-helper"
sys.path.insert(0, str(C12))

from validate import check, check_spec, load_spec  # noqa: E402

EXPECTED = {
    "bad-after-shutdown.ndjson": "line 4: message after shutdown",
    "bad-before-hello.ndjson": "line 0: screens.list before the hello response",
    "bad-duplicate-response.ndjson": "line 4: response to no outstanding request",
    "bad-error-code.ndjson": "line 3: capture.window: error code 'window_closed' not listed",
    "bad-event-before-register.ndjson": "line 2: ptt.down before a successful ptt.register",
    "bad-missing-param.ndjson": "line 2: capture.window.params.window_id missing",
    "bad-one-of.ndjson": "line 2: ocr.recognize.params needs exactly one of",
    "bad-result-type.ndjson": "line 3: windows.list.result.windows[0].bounds.width missing",
    "bad-seq.ndjson": "line 5: seq must increase",
    "bad-unanswered.ndjson": "requests without a response",
    "bad-unknown-op.ndjson": "line 2: unknown op 'screen.list'",
    "bad-unsupported-missing-param.ndjson": "line 2: browser.front_tab.params.app_id missing",
    "bad-unsupported-ok.ndjson": "line 3: browser.front_tab succeeded on windows",
    "bad-v.ndjson": "line 0: v must be 1",
}
PLATFORMS = {"两者": ["macos", "windows"], "仅 Mac": ["macos"], "仅 Windows": ["windows"]}


def read(path):
    return path.read_text(encoding="utf-8").splitlines(keepends=True)


class C12Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec = load_spec()

    def test_spec_is_consistent(self):
        self.assertIsNone(check_spec(self.spec))

    def test_valid_examples_pass(self):
        paths = sorted(C12.glob("examples/ok-*.ndjson"))
        self.assertGreaterEqual(len(paths), 2)
        for path in paths:
            with self.subTest(path.name):
                self.assertIsNone(check(read(path), self.spec))

    def test_invalid_examples_report_their_error(self):
        names = sorted(p.name for p in C12.glob("examples/bad-*.ndjson"))
        self.assertEqual(names, sorted(EXPECTED))
        for name in names:
            with self.subTest(name):
                err = check(read(C12 / "examples" / name), self.spec)
                self.assertIsNotNone(err)
                self.assertTrue(err.startswith(EXPECTED[name]), err)

    def test_every_op_and_event_has_a_valid_example(self):
        succeeded, events, platforms = set(), set(), set()
        for path in C12.glob("examples/ok-*.ndjson"):
            pending = {}
            for line in read(path):
                msg = json.loads(line)
                if "op" in msg:
                    pending[msg["id"]] = msg["op"]
                elif msg.get("ok") is True:
                    succeeded.add(pending[msg["id"]])
                    if pending[msg["id"]] == "hello":
                        platforms.add(msg["result"]["platform"])
                elif "event" in msg:
                    events.add(msg["event"])
        self.assertEqual(sorted(set(self.spec["ops"]) - succeeded), [])
        self.assertEqual(sorted(set(self.spec["events"]) - events), [])
        self.assertEqual(platforms, set(self.spec["platforms"]))

    def test_contract_tables_match_ops_json(self):
        text = (C12 / "CONTRACT.md").read_text(encoding="utf-8")
        op_text = text.split("\n## 7. ", 1)[1].split("\n## 8. ", 1)[0]
        event_text = text.split("\n## 8. ", 1)[1].split("\n## 9. ", 1)[0]
        op_row = re.compile(r"^\| `([^`]+)` \| (两者|仅 Mac|仅 Windows) \|", re.M)
        ops = {m.group(1): PLATFORMS[m.group(2)] for m in op_row.finditer(op_text)}
        events = set(re.findall(r"^\| `([^`]+)` \|", event_text, re.M))
        self.assertEqual(sorted(ops), sorted(self.spec["ops"]))
        for name, op in self.spec["ops"].items():
            with self.subTest(name):
                self.assertEqual(ops[name], op["platforms"])
        self.assertEqual(events, set(self.spec["events"]))


if __name__ == "__main__":
    unittest.main()
