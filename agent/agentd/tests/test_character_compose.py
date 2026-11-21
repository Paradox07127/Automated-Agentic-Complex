"""Installed payload roots compose into the same catalog as the build-side library."""
import contextlib
import io
import json
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import character_tool
import resource_store
from character_library import Library, write_json
from test_character_library import fixture, tool_command

FIXTURE = Path(__file__).resolve().parents[3] / "protocol/character-library/fixtures/library"


class CharacterComposeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.snapshot = json.loads((FIXTURE / "current.json").read_text(encoding="utf-8"))
        self.payloads = []
        for entry in self.snapshot["characters"]:
            payload = self.root / entry["id"]
            shutil.copytree((FIXTURE / entry["definition"]["file"]).parent, payload)
            self.payloads.append(payload)
        self.output = self.root / "library"

    def arguments(self, payloads=None, default=None):
        args = ["compose", "--default", default or self.snapshot["default_character"], "--output", str(self.output)]
        for payload in self.payloads if payloads is None else payloads:
            args += ["--package", str(payload)]
        return args

    def compose(self, **options):
        return tool_command("character_tool.py", *self.arguments(**options))

    def compose_in_process(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(sys, "argv", ["character_tool.py", *self.arguments()]), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try: code = character_tool.main()
            except SystemExit as error: code = error.code
        return code, stderr.getvalue()

    def assert_no_output(self):
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob(".compose-*")), [])

    def test_fixture_index_and_native_bytes_match_for_new_and_empty_output(self):
        for empty in (False, True):
            with self.subTest(empty=empty):
                if empty: self.output.mkdir()
                result = self.compose()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((self.output / "current.json").read_bytes(), (FIXTURE / "current.json").read_bytes())
                native = self.snapshot["native_bundle"]["file"]
                self.assertEqual((self.output / native).read_bytes(), (FIXTURE / native).read_bytes())
                for entry, payload in zip(self.snapshot["characters"], self.payloads):
                    target = (self.output / entry["definition"]["file"]).parent
                    for source in payload.rglob("*"):
                        if source.is_file():
                            copied = target / source.relative_to(payload)
                            self.assertFalse(copied.is_symlink())
                            self.assertEqual(copied.read_bytes(), source.read_bytes())
                shutil.rmtree(self.output)

    def test_no_packages_compose_an_empty_library(self):
        character_tool.compose([], None, self.output)
        library = Library(self.output)
        snapshot = library.snapshot()
        self.assertEqual(snapshot["characters"], [])
        self.assertNotIn("default_character", snapshot)
        self.assertEqual(library.packages(), [])
        native = json.loads((self.output / snapshot["native_bundle"]["file"]).read_text(encoding="utf-8"))
        self.assertEqual((native["characters"], native["files"]), ([], []))

    def test_default_selects_a_character_other_than_the_first_package(self):
        first = self.root / "aaa"; fixture(first, "aaa")
        result = self.compose(payloads=[first, *self.payloads], default="fixture")
        self.assertEqual(result.returncode, 0, result.stderr)
        library = Library(self.output)
        self.assertEqual(library.snapshot()["default_character"], "fixture")
        self.assertEqual([p.id for p in library.packages()], ["aaa", "fixture"])

    def test_symlinked_files_and_directories_fail_without_partial_library(self):
        first = self.root / "aaa"; fixture(first, "aaa")
        payload = self.payloads[0]
        original = payload / "ui/head.png"
        outside = self.root / "head.png"; shutil.copy2(original, outside)
        for name in ("ui/head.png", "extra", "extra-directory"):
            with self.subTest(name=name):
                link = payload / name
                if link.exists(): link.unlink()
                link.symlink_to(first if name == "extra-directory" else outside)
                result = self.compose(payloads=[first, *self.payloads])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("runtime_symlink", result.stderr)
                self.assert_no_output()
                link.unlink()
                if name == "ui/head.png": shutil.copy2(outside, original)

    def test_missing_character_json_fails_without_output(self):
        (self.payloads[0] / "character.json").unlink()
        for empty in (False, True):
            with self.subTest(empty=empty):
                if empty: self.output.mkdir()
                result = self.compose()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("missing_or_escaping_file", result.stderr)
                self.assert_no_output()

    def test_nonempty_output_is_rejected(self):
        self.output.mkdir()
        (self.output / "existing").write_text("existing data", encoding="utf-8")
        result = self.compose()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("output_already_exists", result.stderr)
        self.assertEqual(list(self.root.glob(".compose-*")), [])

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_clone_and_copy_fallback_preserve_executable_bits(self):
        source = self.payloads[0] / "ui/head.png"; source.chmod(0o751)
        clone_or_copy = resource_store.clone_or_copy
        observed = {}
        for mode, platform in (("native", sys.platform), ("fallback", "linux")):
            with self.subTest(mode=mode):
                methods = set()
                def copy(source, destination):
                    method = clone_or_copy(source, destination)
                    methods.add(method)
                    return method
                with patch.object(resource_store.sys, "platform", platform), \
                        patch.object(resource_store, "clone_or_copy", side_effect=copy):
                    code, stderr = self.compose_in_process()
                self.assertEqual(code, 0, stderr)
                target = Library(self.output).packages()[0].root / "ui/head.png"
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o751)
                self.assertNotEqual(target.stat().st_ino, source.stat().st_ino)
                self.assertTrue(methods)
                if mode == "fallback": self.assertEqual(methods, {"copied"})
                observed[mode] = ",".join(sorted(methods))
                shutil.rmtree(self.output)
        print("compose materialization: " + "; ".join(f"{mode}={method}" for mode, method in observed.items()))

    def test_publish_failure_removes_staged_library(self):
        def fail_current(path, value):
            if Path(path).name == "current.json": raise OSError("injected_publish_failure")
            write_json(path, value)
        with patch("character_library.write_json", side_effect=fail_current):
            code, stderr = self.compose_in_process()
        self.assertNotEqual(code, 0)
        self.assertIn("injected_publish_failure", stderr)
        self.assert_no_output()


if __name__ == "__main__": unittest.main()
