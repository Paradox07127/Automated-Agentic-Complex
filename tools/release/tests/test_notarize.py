import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import notarize

APP = Path("/nonexistent/Agentic Complex.app")
SUBMISSION = "2efe2717-52ef-43a5-96dc-0797e4ca1041"


class FakeRun:
    def __init__(self, submit):
        self.submit = submit
        self.calls = []
        self.archive = None

    def __call__(self, command, **kwargs):
        self.calls.append(command)
        if command[0] == "ditto":
            self.archive = Path(command[-1])
            self.archive.write_bytes(b"zip")
            return subprocess.CompletedProcess(command, 0)
        if command[1:3] == ["notarytool", "submit"]:
            self.assertion_archive_exists = self.archive.is_file()
            return self.submit(command)
        if command[1:3] == ["notarytool", "log"]:
            return subprocess.CompletedProcess(command, 0, '{"issues": [{"message": "not signed"}]}', "")
        return subprocess.CompletedProcess(command, 0, "", "")


def outcome(status, code=0):
    return lambda command: subprocess.CompletedProcess(command, code, json.dumps(
        {"id": SUBMISSION, "status": status, "message": "Processing complete"}), "")


class NotarizeTests(unittest.TestCase):
    def test_split_submission_covers_the_external_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp) / "Agentic Complex.app"; app.mkdir()
            runtime = app.parent / "components/runtime.python/payload/bin/python"
            runtime.parent.mkdir(parents=True); runtime.touch()
            run = FakeRun(outcome("Accepted"))
            result = notarize.notarize(app, "release-profile", run=run)
            archived = [Path(source) for command in run.calls if command[0] == "ditto" for source in command[4:-1]]
            self.assertTrue(any(runtime.is_relative_to(source) for source in archived), "external runtime missing from submission")
            self.assertEqual([command[0] for command in run.calls].count("ditto"), 1)
            self.assertEqual(result, {"id": SUBMISSION, "status": "Accepted", "covers": ["Agentic Complex.app", "components"]})
            self.assertIn(["xcrun", "stapler", "staple", str(app)], run.calls)

    def assert_profile_only(self, run):
        for command in run.calls:
            if command[1:2] == ["notarytool"]:
                self.assertEqual(command[command.index("--keychain-profile") + 1], "release-profile")
                self.assertFalse({"--password", "-p", "--apple-id", "--team-id", "--key", "--key-id", "--issuer"} & set(command),
                                 command)

    def test_accepted_submission_is_stapled_and_validated(self):
        run = FakeRun(outcome("Accepted"))

        result = notarize.notarize(APP, "release-profile", run=run)

        self.assertEqual(result, {"id": SUBMISSION, "status": "Accepted", "covers": ["Agentic Complex.app"]})
        archive = str(run.archive)
        self.assertEqual(run.archive.name, "Agentic Complex.zip")
        self.assertEqual(run.calls, [
            ["ditto", "-c", "-k", "--keepParent", str(APP), archive],
            ["xcrun", "notarytool", "submit", archive, "--keychain-profile", "release-profile", "--wait",
             "--output-format", "json"],
            ["xcrun", "stapler", "staple", str(APP)],
            ["xcrun", "stapler", "validate", str(APP)],
        ])
        self.assertTrue(run.assertion_archive_exists)
        self.assertFalse(run.archive.exists())
        self.assertFalse(run.archive.parent.exists())
        self.assert_profile_only(run)

    def test_invalid_submission_fetches_the_log_and_fails_without_stapling(self):
        run = FakeRun(outcome("Invalid", code=1))

        with self.assertRaises(notarize.NotarizationError) as raised:
            notarize.notarize(APP, "release-profile", run=run)

        self.assertIn(SUBMISSION, str(raised.exception))
        self.assertIn("Invalid", str(raised.exception))
        self.assertIn("not signed", str(raised.exception))
        self.assertIn(["xcrun", "notarytool", "log", SUBMISSION, "--keychain-profile", "release-profile"], run.calls)
        self.assertFalse(any(command[1:2] == ["stapler"] for command in run.calls))
        self.assertFalse(run.archive.exists())
        self.assert_profile_only(run)

    def test_notarytool_error_fails_with_its_output_and_removes_the_zip(self):
        run = FakeRun(lambda command: subprocess.CompletedProcess(
            command, 69, "", "Error: No Keychain password item found for profile: release-profile"))

        with self.assertRaises(notarize.NotarizationError) as raised:
            notarize.notarize(APP, "release-profile", run=run)

        self.assertIn("No Keychain password item found", str(raised.exception))
        self.assertEqual([command[1:3] for command in run.calls[1:]], [["notarytool", "submit"]])
        self.assertFalse(run.archive.exists())
        self.assert_profile_only(run)


if __name__ == "__main__":
    unittest.main()
