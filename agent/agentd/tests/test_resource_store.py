import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from resource_store import ResourceRepository, clone_or_copy, link_or_copy
from character_library import Library, materialize_library, write_json
from test_character_library import fixture


def ref(data):return dict(sha256=hashlib.sha256(data).hexdigest(),byte_count=len(data))


class ResourceStoreTests(unittest.TestCase):
    def test_clone_or_fallback_preserves_write_isolation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'original';source.write_bytes(b'original')
            result=clone_or_copy(source,root/'view')
            self.assertIn(result,['cloned','copied'])
            if sys.platform=='darwin':self.assertEqual(result,'cloned')
            self.assertNotEqual(source.stat().st_ino,(root/'view').stat().st_ino)
            (root/'view').write_bytes(b'edited')
            self.assertEqual(source.read_bytes(),b'original')

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_content_identity_ignores_name_but_checks_hash_and_canonical_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);repo=ResourceRepository();data=b'same';r=ref(data)
            source=root/'source';source.write_bytes(data)
            repo.materialize(source,root/'one',r);repo.materialize(source,root/'two',r)
            self.assertEqual(repo.stats['content_reuses'],1)
            (root/'one').write_bytes(b'evil')
            with self.assertRaisesRegex(ValueError,'sha_mismatch'):repo.materialize(source,root/'three',r)
            self.assertFalse((root/'three').exists())
            self.assertEqual((root/'two').read_bytes(),data)

    def test_non_apfs_fallback_and_symlink_refusal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'one';source.write_bytes(b'data')
            with patch('resource_store.sys.platform','linux'):
                self.assertEqual(clone_or_copy(source,root/'two'),'copied')
            (root/'link').symlink_to(source)
            with self.assertRaisesRegex(ValueError,'not_regular'):clone_or_copy(root/'link',root/'three')
            with self.assertRaisesRegex(ValueError,'destination_exists'):clone_or_copy(source,root/'two')

    def test_link_or_copy_off_windows_is_clone_or_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'one';source.write_bytes(b'data')
            self.assertIn(link_or_copy(source,root/'two'),['cloned','copied'])
            self.assertEqual((root/'two').read_bytes(),b'data')
            self.assertNotEqual(source.stat().st_ino,(root/'two').stat().st_ino)
            (root/'link').symlink_to(source)
            with self.assertRaisesRegex(ValueError,'not_regular'):link_or_copy(root/'link',root/'three')
            with self.assertRaisesRegex(ValueError,'destination_exists'):link_or_copy(source,root/'two')

    def test_link_or_copy_on_windows_links_and_falls_back_to_a_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'one';source.write_bytes(b'data')
            with patch('resource_store.sys.platform','win32'):
                self.assertEqual(link_or_copy(source,root/'linked'),'linked')
                with patch('resource_store.os.link',side_effect=OSError(18,'cross-device')):
                    self.assertEqual(link_or_copy(source,root/'copied'),'copied')
            self.assertEqual(source.stat().st_ino,(root/'linked').stat().st_ino)
            self.assertNotEqual(source.stat().st_ino,(root/'copied').stat().st_ino)
            self.assertEqual((root/'copied').read_bytes(),b'data')

    def test_readonly_archived_input_produces_independently_writable_build_view(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'original';source.write_bytes(b'json');source.chmod(0o444)
            clone_or_copy(source,root/'view');(root/'view').write_bytes(b'rebased')
            self.assertEqual(source.read_bytes(),b'json')
            self.assertEqual(source.stat().st_mode & 0o777,0o444)

    def test_selected_snapshot_excludes_history_and_retains_exact_manifests(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'role';fixture(source,'one')
            library=Library(root/'library');library.install(source)
            write_json(library.root/'unrelated-history.json',{'not':'a seed input'})
            result=materialize_library(library.root/'current.json',root/'output')
            self.assertEqual((root/'output/current.json').read_bytes(),(library.root/'current.json').read_bytes())
            self.assertFalse((root/'output/unrelated-history.json').exists())
            self.assertEqual(Library(root/'output').packages()[0].sha256,library.packages()[0].sha256)
            self.assertGreater(result['cloned']+result['copied'],0)


if __name__=='__main__':unittest.main()
