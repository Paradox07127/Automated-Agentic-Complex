import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness_runtime import (HOST, LAYOUT, ROOT, inventory_tree, lock_hashes, locked, copy_python_site, python_pins,
                             validate_runtime, verify_node)


def distribution(site, name, version, payload=None):
    info = site / (name.replace('-', '_') + '-' + version + '.dist-info')
    info.mkdir(parents=True)
    (info / 'METADATA').write_text(f'Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n')
    records = [str((info / 'METADATA').relative_to(site)), str((info / 'RECORD').relative_to(site))]
    for path, content in (payload or {}).items():
        target = site / path; target.parent.mkdir(parents=True, exist_ok=True); target.write_text(content); records.append(path)
    (info / 'RECORD').write_text('\n'.join(record + ',,' for record in records) + '\n')


def write_manifest(directory):
    manifest = {'schema': 'endfield-personal-agent-runtime/v1', 'locks': lock_hashes(),
                'node_version': '24.22.1', 'pi_version': '1.4.0', 'files': inventory_tree(directory)}
    (directory / 'manifest.json').write_text(json.dumps(manifest))


def prepared_fixture(directory, platform=HOST):
    """Synthetic packaging fixture; never presented as an executable runtime."""
    directory.mkdir(parents=True)
    for name, version in python_pins().items(): distribution(directory / 'python-site', name, version)
    notice = directory / 'python-site' / ('numpy-' + python_pins()['numpy'] + '.dist-info/licenses/LICENSE.txt')
    notice.parent.mkdir(); notice.write_text('synthetic numpy notice')
    node = directory / LAYOUT[platform]['node']; node.parent.mkdir(parents=True)
    node.write_bytes(b'synthetic executable'); node.chmod(0o755)
    (directory / 'node/LICENSE').write_text('synthetic node notice')
    pi = directory / 'pi-runtime/node_modules/@earendil-works/pi-coding-agent'; pi.mkdir(parents=True)
    (pi / 'package.json').write_text(json.dumps({'name': '@earendil-works/pi-coding-agent', 'version': '1.4.0'}))
    (directory / 'pi-runtime/runtime-manifest.json').write_text('{}')
    write_manifest(directory)
    return directory


class HarnessPackagingTests(unittest.TestCase):
    def test_python_lock_sets_are_hash_pinned_and_compatible(self):
        pins = python_pins()
        self.assertNotIn('claude-agent-sdk', pins)
        self.assertNotIn('openai-codex-cli-bin', pins)
        self.assertEqual(pins['numpy'], '2.5.4')

    def test_package_rejects_missing_dependencies_before_staging(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = prepared_fixture(Path(temporary) / 'runtime')
            self.assertEqual(validate_runtime(directory)['pi_version'], '1.4.0')
            (directory / LAYOUT[HOST]['node']).unlink()
            with self.assertRaisesRegex(ValueError, 'integrity_mismatch'): validate_runtime(directory)

    def test_prepared_site_rejects_unlocked_distributions(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = prepared_fixture(Path(temporary) / 'runtime')
            distribution(directory / 'python-site', 'unrelated-package', '1.0')
            write_manifest(directory)
            with self.assertRaisesRegex(ValueError, 'unrelated-package'):
                validate_runtime(directory)

    def test_agentd_http_client_and_transport_are_in_the_release_lock(self):
        self.assertLessEqual({'httpx', 'httpcore', 'certifi'}, python_pins().keys())

    def test_source_lock_change_invalidates_cached_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = prepared_fixture(Path(temporary) / 'runtime')
            with patch('harness_runtime.lock_hashes', return_value={'new-lock': 'changed'}):
                with self.assertRaisesRegex(ValueError, 'locks_stale'): validate_runtime(directory)

    def test_runtime_always_carries_node_and_pi(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = prepared_fixture(Path(temporary) / 'runtime')
            self.assertEqual(len(validate_runtime(directory)['locks']), 4)
            (directory / 'node/LICENSE').unlink(); write_manifest(directory)
            with self.assertRaisesRegex(ValueError, 'harness_runtime_incomplete'): validate_runtime(directory)

    def test_external_symlink_is_not_a_bundled_dependency(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); directory = root / 'runtime'; directory.mkdir()
            (root / 'outside').write_text('external')
            (directory / 'escape').symlink_to(root / 'outside')
            with self.assertRaisesRegex(ValueError, 'external_symlink'): inventory_tree(directory)

    def test_homebrew_linkage_is_rejected_even_for_matching_node_version(self):
        with patch('harness_runtime.subprocess.check_output', side_effect=[
            'v24.22.1\n', 'node:\n\t/opt/homebrew/lib/libnode.dylib (compatibility version 0)\n']):
            with self.assertRaisesRegex(ValueError, 'node_external_library'):
                verify_node('/fixture/node', '24.22.1', platform='darwin-arm64')

    def test_windows_node_is_checked_by_version_alone(self):
        with patch.dict(os.environ, {'SYSTEMROOT': 'C:\\Windows'}), \
             patch('harness_runtime.subprocess.check_output', return_value='v24.22.1\n') as run:
            verify_node('C:\\fixture\\node.exe', '24.22.1', platform='win32-x64')
        run.assert_called_once()
        self.assertEqual(run.call_args.kwargs['env'], {'SYSTEMROOT': 'C:\\Windows'})

    def test_windows_runtime_has_node_exe_at_the_node_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = prepared_fixture(Path(temporary) / 'runtime', 'win32-x64')
            self.assertTrue((directory / 'node/node.exe').is_file())
            self.assertEqual(validate_runtime(directory, platform='win32-x64')['pi_version'], '1.4.0')
            with self.assertRaisesRegex(ValueError, 'harness_runtime_incomplete'):
                validate_runtime(directory, platform='darwin-arm64')

    def test_overlay_console_script_launchers_stay_out(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); overlay = root / 'overlay'; target = root / 'out'
            distribution(overlay, 'pydantic', '2.14.1', {'pydantic/__init__.py': 'new'})
            (overlay / 'bin').mkdir(); (overlay / 'bin/uvicorn.exe').write_text('#!D:\\build\\host\\python.exe')
            copy_python_site(overlay, target)
            self.assertFalse((target / 'bin').exists())
            self.assertEqual((target / 'pydantic/__init__.py').read_text(), 'new')

    def test_node_lock_is_official_archive_with_exact_integrity(self):
        lock = json.loads((ROOT / 'app/packaging/node-runtime.lock.json').read_text())
        self.assertEqual(lock['version'], '24.22.1')
        self.assertEqual(lock['platform'], 'darwin-arm64')
        self.assertTrue(lock['url'].startswith('https://nodejs.org/dist/'))
        self.assertRegex(lock['sha256'], '^[0-9a-f]{64}$')

    def test_node_lock_has_the_official_windows_zip(self):
        lock = json.loads((ROOT / 'app/packaging/node-runtime.lock.json').read_text())
        self.assertIs(locked(lock, 'darwin-arm64'), lock)
        windows = locked(lock, 'win32-x64')
        self.assertEqual((windows['version'], windows['platform'], windows['archive']),
                         ('24.22.1', 'win32-x64', 'node-v24.22.1-win-x64.zip'))
        self.assertEqual(windows['url'], 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip')
        self.assertRegex(windows['sha256'], '^[0-9a-f]{64}$')
        self.assertNotEqual(windows['sha256'], lock['sha256'])


if __name__ == '__main__': unittest.main()
