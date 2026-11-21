from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sessions.check_result import parse  # noqa: E402

SWIFT = {"error": "Exit code 1\nTest Case '-[CompanionCoreTests.HostSeatTests testA]' failed\n"
                  "Executed 12 tests, with 3 failures (0 unexpected)"}


class CheckResultTest(unittest.TestCase):
    def test_claude_failure_body(self):
        result = parse("Bash", {"command": "swift test"}, SWIFT)
        self.assertEqual(result, {"label": "swift test", "exit": 1, "failed": 3, "total": 12,
                                  "names": ["CompanionCoreTests.HostSeatTests.testA"], "suites": ["HostSeatTests"]})

    def test_codex_pytest_stdout_stderr(self):
        result = parse("shell", {"command": ["python", "-m", "pytest"]},
                       {"tool_response": {"stdout": "FAILED a.py::C::test_a - boom\nFAILED b.py::D::test_b\n"
                                                    "2 failed, 5 passed", "stderr": "", "exit_code": 1}})
        self.assertEqual(result["names"], ["a.py::C::test_a", "b.py::D::test_b"])
        self.assertEqual((result["failed"], result["total"], result["suites"]), (2, 7, ["C", "D"]))

    def test_unittest_and_vitest_names(self):
        for command, text, suite in (("python -m unittest", "FAIL: test_a (m.C.test_a)\nRan 4 tests\n"
                                     "FAILED (failures=1, errors=2)", "C"),
                                    ("npm test", "FAIL  x.test.tsx > suite > name\nTests  1 failed | 2 passed", "suite")):
            with self.subTest(command=command):
                result = parse("Bash", {"command": command}, {"tool_response": text})
                self.assertTrue(result["names"])
                self.assertEqual(result["suites"], [suite])
                self.assertEqual(result["failed"], 3 if "unittest" in command else 1)

    def test_exit_only_and_success(self):
        result = parse("Bash", {"command": "bash scripts/gate.sh"}, {"error": "GATE FAIL\nExit code 2"})
        self.assertEqual((result["label"], result["exit"], result["failed"]), ("gate.sh", 2, None))
        result = parse("Bash", {"command": "swift test"},
                       {"tool_response": "Executed 12 tests, with 0 failures", "exit_code": 0})
        self.assertEqual((result["failed"], result["exit"]), (0, 0))

    def test_only_test_commands_with_results_and_bounded_names(self):
        self.assertIsNone(parse("Read", {"command": "pytest"}, SWIFT))
        self.assertIsNone(parse("Bash", {"command": "ls"}, SWIFT))
        self.assertIsNone(parse("Bash", {"command": "pytest"}, {}))
        result = parse("Bash", {"command": "pytest"},
                       {"tool_response": "\n".join(f"FAILED a.py::C::t{i}" for i in range(12))})
        self.assertEqual(len(result["names"]), 8)
        self.assertEqual(result["failed"], 12)
