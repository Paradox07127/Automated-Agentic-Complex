import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE.parent))
from component_manifest import tree_sha256, write_component, write_lock

spec = importlib.util.spec_from_file_location("c11_validate", ROOT / "protocol/C11-components/validate.py")
validate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validate)


class TreeHashTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.root = self.directory / "payload"
        self.root.mkdir()

    def test_exact_record_format_utf8_order_and_no_final_newline(self):
        (self.root / "a").mkdir()
        (self.root / "a/data").write_bytes(b"x")
        (self.root / "a/data").chmod(0o644)
        (self.root / "a.txt").write_bytes(b"hi")
        (self.root / "a.txt").chmod(0o744)
        (self.root / "z").symlink_to("a/data")
        (self.root / "角色").write_bytes(b"")
        (self.root / "角色").chmod(0o644)
        records = [
            "F a.txt 1 2 " + hashlib.sha256(b"hi").hexdigest(),
            "F a/data 0 1 " + hashlib.sha256(b"x").hexdigest(),
            "L z a/data",
            "F 角色 0 0 " + hashlib.sha256(b"").hexdigest(),
        ]
        expected = hashlib.sha256("\n".join(records).encode("utf-8")).hexdigest()
        self.assertEqual(tree_sha256(self.root), expected)

    def test_creation_order_and_apfs_clone_have_the_same_hash(self):
        other = self.directory / "reordered"
        other.mkdir()
        entries = [("a.txt", b"one"), ("bin/run", b"two"), ("角色/name", b"three")]
        for root, items in ((self.root, entries), (other, reversed(entries))):
            for relative, content in items:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                path.chmod(0o755 if relative == "bin/run" else 0o644)
            (root / "current").symlink_to("bin/run")
            (root / "lib").symlink_to("角色", target_is_directory=True)
        cloned = self.directory / "cloned"
        subprocess.run(["cp", "-c", "-R", str(self.root), str(cloned)], check=True, capture_output=True)
        expected = tree_sha256(self.root)
        self.assertEqual(tree_sha256(other), expected)
        self.assertEqual(tree_sha256(cloned), expected)
        self.assertTrue((cloned / "lib").is_symlink())

    def test_one_byte_changes_the_hash(self):
        path = self.root / "data"
        path.write_bytes(b"hello")
        before = tree_sha256(self.root)
        path.write_bytes(b"jello")
        self.assertNotEqual(tree_sha256(self.root), before)

    def test_execute_bits_change_hash_but_other_mode_bits_and_mtime_do_not(self):
        path = self.root / "run"
        path.write_bytes(b"run")
        path.chmod(0o644)
        before = tree_sha256(self.root)
        path.chmod(0o600)
        os.utime(path, (1, 1))
        self.assertEqual(tree_sha256(self.root), before)
        for mode in (0o700, 0o610, 0o601):
            path.chmod(mode)
            with self.subTest(mode=mode):
                self.assertNotEqual(tree_sha256(self.root), before)

    def test_symlink_target_changes_hash_without_following_links(self):
        outside = self.directory / "outside"
        outside.mkdir()
        (outside / "data").write_bytes(b"one")
        link = self.root / "link"
        link.symlink_to("../outside", target_is_directory=True)
        before = tree_sha256(self.root)
        (outside / "data").write_bytes(b"two")
        self.assertEqual(tree_sha256(self.root), before)
        link.unlink()
        link.symlink_to("../missing", target_is_directory=True)
        self.assertNotEqual(tree_sha256(self.root), before)
        expected = hashlib.sha256(b"L link ../missing").hexdigest()
        self.assertEqual(tree_sha256(self.root), expected)

    def test_caches_ds_store_and_own_manifest_are_excluded(self):
        before = tree_sha256(self.root)
        (self.root / "__pycache__").mkdir()
        (self.root / "__pycache__/module.pyc").write_bytes(b"compiled")
        (self.root / ".DS_Store").write_bytes(b"finder")
        (self.root / "component.json").write_text("{}", encoding="utf-8")
        nested = self.root / "nested"
        nested.mkdir()
        (nested / "__pycache__").mkdir()
        (nested / "__pycache__/module.pyc").write_bytes(b"compiled again")
        (nested / ".DS_Store").write_bytes(b"finder again")
        self.assertEqual(tree_sha256(self.root), before)
        (nested / "component.json").write_text("{}", encoding="utf-8")
        self.assertNotEqual(tree_sha256(self.root), before)

    def test_empty_directories_do_not_change_the_hash(self):
        expected = hashlib.sha256(b"").hexdigest()
        self.assertEqual(tree_sha256(self.root), expected)
        (self.root / "empty/nested").mkdir(parents=True)
        self.assertEqual(tree_sha256(self.root), expected)

    def test_write_component_is_a_sidecar_with_matching_hash_and_totals(self):
        (self.root / "server.py").write_bytes(b"print('hello')\n")
        (self.root / "launcher").symlink_to("server.py")
        (self.root / "__pycache__").mkdir()
        (self.root / "__pycache__/server.pyc").write_bytes(b"ignored")
        before = tree_sha256(self.root)
        doc = write_component(self.root, "agentd", "1.0.0", {"launcher": "launcher"},
                              {"C6": "1"}, {"runtime.python": "3.13.9"})
        self.assertIsNone(validate.check_component(doc))
        self.assertEqual(json.loads((self.directory / "component.json").read_text(encoding="utf-8")), doc)
        self.assertFalse((self.root / "component.json").exists())
        self.assertEqual(doc["tree_sha256"], before)
        self.assertEqual(doc["files"], 2)
        self.assertEqual(doc["bytes"], len(b"print('hello')\n"))
        self.assertEqual(doc["entrypoints"], {"launcher": "launcher"})
        self.assertEqual(doc["provides"], {"C6": "1"})
        self.assertEqual(doc["requires"], {"runtime.python": "3.13.9"})
        self.assertNotIn("placed", doc)
        self.assertEqual(tree_sha256(self.root), before)

    def test_write_component_records_placed_without_changing_payload_hash(self):
        (self.root / "MacOS").mkdir()
        (self.root / "MacOS/AgenticComplex").write_bytes(b"host")
        before = tree_sha256(self.root)
        for placed in ({}, {"MacOS/AgenticComplex": "MacOS/AgenticComplex"}):
            with self.subTest(placed=placed):
                doc = write_component(self.root, "host", "1", {"executable": "MacOS/AgenticComplex"}, {}, {}, placed=placed)
                self.assertIsNone(validate.check_component(doc))
                self.assertEqual(doc["placed"], placed)
                self.assertEqual(json.loads((self.directory / "component.json").read_text())["placed"], placed)
                self.assertEqual(doc["tree_sha256"], before)

    def test_write_component_refuses_a_manifest_c11_rejects(self):
        (self.root / "data").write_bytes(b"x")
        with self.assertRaisesRegex(ValueError, "component.id"):
            write_component(self.root, "characters." + "a" * 60, "1.0.0", {}, {}, {})
        self.assertFalse((self.directory / "component.json").exists())

    def test_write_lock_pins_the_same_tree_in_both_editions(self):
        host = {"id": "host", "version": "1.0.0", "tree_sha256": "a" * 64}
        component = {"id": "agentd", "version": "1.0.0", "tree_sha256": "b" * 64}
        for edition, placement in (("portable", "bundle"), ("split", "support")):
            path = self.directory / f"{edition}.composition.lock.json"
            components = [dict(component, placement=placement)]
            write_lock(path, edition, host, components)
            doc = json.loads(path.read_text(encoding="utf-8"))
            with self.subTest(edition=edition):
                self.assertIsNone(validate.check_lock(doc))
                self.assertEqual(doc["edition"], edition)
                self.assertEqual(doc["host"], host)
                self.assertEqual(doc["components"], components)


if __name__ == "__main__":
    unittest.main()
