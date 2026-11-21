import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from electron_runtime import ROOT, prepare
from harness_runtime import locked

ARCHIVE = 'electron-v45.4.1-darwin-arm64.zip'
URL = 'https://github.com/electron/electron/releases/download/v45.4.1/' + ARCHIVE
WINDOWS_ARCHIVE = 'electron-v45.4.1-win32-x64.zip'
DITTO = unittest.skipIf(sys.platform == 'win32', 'unpacking the macOS release needs /usr/bin/ditto')


def entry(archive, name, mode, data):
    info = zipfile.ZipInfo(name); info.create_system = 3; info.external_attr = mode << 16
    archive.writestr(info, data)


def synthetic_zip():
    """Official layout in miniature: framework links, an executable and the license."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        entry(archive, 'LICENSE', stat.S_IFREG | 0o644, 'synthetic license')
        entry(archive, 'Electron.app/Contents/MacOS/Electron', stat.S_IFREG | 0o755, 'synthetic executable')
        framework = 'Electron.app/Contents/Frameworks/Electron Framework.framework/'
        entry(archive, framework + 'Versions/A/Electron Framework', stat.S_IFREG | 0o755, 'synthetic library')
        entry(archive, framework + 'Versions/Current', stat.S_IFLNK | 0o755, 'A')
        entry(archive, framework + 'Electron Framework', stat.S_IFLNK | 0o755, 'Versions/Current/Electron Framework')
    return buffer.getvalue()


def synthetic_windows_zip():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('LICENSE', 'synthetic license')
        archive.writestr('electron.exe', 'synthetic executable')
        archive.writestr('locales/en-US.pak', 'synthetic locale')
    return buffer.getvalue()


def fixture_root(directory, url=URL, sha256=None, data=None, windows=None):
    lock = {'schema': 'endfield-electron-runtime/v1', 'version': '45.4.1', 'platform': 'darwin-arm64',
            'archive': ARCHIVE, 'url': url, 'sha256': sha256 or hashlib.sha256(data).hexdigest(),
            'checksum_source': 'https://github.com/electron/electron/releases/download/v45.4.1/SHASUMS256.txt',
            'license_file': 'LICENSE'}
    if windows is not None:
        lock['platforms'] = {'win32-x64': {'archive': WINDOWS_ARCHIVE, 'sha256': hashlib.sha256(windows).hexdigest(),
                                           'url': 'https://github.com/electron/electron/releases/download/v45.4.1/' + WINDOWS_ARCHIVE}}
    path = directory / 'app/packaging/electron-runtime.lock.json'; path.parent.mkdir(parents=True)
    path.write_text(json.dumps(lock))
    return directory


def serve(data):
    return patch('electron_runtime.urllib.request.urlopen', side_effect=lambda *args, **kwargs: io.BytesIO(data))


class ElectronRuntimeTests(unittest.TestCase):
    def test_lock_pins_the_electron_version_of_the_shell(self):
        lock = json.loads((ROOT / 'app/packaging/electron-runtime.lock.json').read_text())
        package = json.loads((ROOT / 'app/electron/package.json').read_text())
        self.assertEqual(lock['version'], package['devDependencies']['electron'])
        self.assertEqual(lock['platform'], 'darwin-arm64')
        self.assertEqual(lock['url'], 'https://github.com/electron/electron/releases/download/v'
                         + lock['version'] + '/' + lock['archive'])
        self.assertRegex(lock['sha256'], '^[0-9a-f]{64}$')

    def test_lock_pins_the_windows_archive_of_the_same_release(self):
        lock = json.loads((ROOT / 'app/packaging/electron-runtime.lock.json').read_text())
        windows = locked(lock, 'win32-x64')
        self.assertEqual((windows['version'], windows['platform'], windows['archive']),
                         (lock['version'], 'win32-x64', 'electron-v' + lock['version'] + '-win32-x64.zip'))
        self.assertEqual(windows['url'], 'https://github.com/electron/electron/releases/download/v'
                         + lock['version'] + '/' + windows['archive'])
        self.assertRegex(windows['sha256'], '^[0-9a-f]{64}$')
        self.assertNotEqual(windows['sha256'], lock['sha256'])

    def test_hash_mismatch_fails_and_keeps_no_archive(self):
        data = synthetic_zip()
        with tempfile.TemporaryDirectory() as temporary:
            root = fixture_root(Path(temporary) / 'root', sha256='0' * 64); cache = Path(temporary) / 'cache'
            with serve(data), self.assertRaisesRegex(ValueError, 'electron_archive_hash_mismatch'):
                prepare(cache, root, platform='darwin-arm64')
            self.assertEqual(list(cache.iterdir()), [])

    def test_url_outside_official_releases_fails_before_download(self):
        data = synthetic_zip()
        with tempfile.TemporaryDirectory() as temporary:
            root = fixture_root(Path(temporary) / 'root', url='https://example.com/electron/electron/releases/download/' + ARCHIVE, data=data)
            with serve(data) as download, self.assertRaisesRegex(ValueError, 'invalid_electron_lock'):
                prepare(Path(temporary) / 'cache', root, platform='darwin-arm64')
            download.assert_not_called()

    @DITTO
    def test_prepare_keeps_framework_links_and_executable_bits(self):
        data = synthetic_zip()
        with tempfile.TemporaryDirectory() as temporary:
            root = fixture_root(Path(temporary) / 'root', data=data)
            with serve(data) as download: app, manifest = prepare(Path(temporary) / 'cache', root, platform='darwin-arm64')
            download.assert_called_once()
            self.assertEqual(app.name, 'Electron.app')
            framework = app / 'Contents/Frameworks/Electron Framework.framework'
            self.assertTrue((framework / 'Versions/Current').is_symlink())
            self.assertEqual(os.readlink(framework / 'Versions/Current'), 'A')
            self.assertEqual(os.readlink(framework / 'Electron Framework'), 'Versions/Current/Electron Framework')
            self.assertEqual((framework / 'Electron Framework').read_text(), 'synthetic library')
            self.assertTrue(os.access(app / 'Contents/MacOS/Electron', os.X_OK))
            self.assertTrue((app.parent / 'LICENSE').is_file())
            self.assertEqual(manifest['sha256'], hashlib.sha256(data).hexdigest())
            self.assertEqual(manifest['files']['Contents/Frameworks/Electron Framework.framework/Versions/Current'], {'symlink': 'A'})
            self.assertTrue(manifest['files']['Contents/MacOS/Electron']['executable'])

    @DITTO
    def test_cached_archive_is_not_downloaded_again(self):
        data = synthetic_zip()
        with tempfile.TemporaryDirectory() as temporary:
            root = fixture_root(Path(temporary) / 'root', data=data); cache = Path(temporary) / 'cache'
            with serve(data): prepare(cache, root, platform='darwin-arm64')
            with serve(data) as download: app, _ = prepare(cache, root, platform='darwin-arm64')
            download.assert_not_called()
            self.assertTrue(os.access(app / 'Contents/MacOS/Electron', os.X_OK))

    def test_windows_release_unpacks_to_a_root_with_electron_exe(self):
        data, windows = synthetic_zip(), synthetic_windows_zip()
        with tempfile.TemporaryDirectory() as temporary:
            root = fixture_root(Path(temporary) / 'root', data=data, windows=windows); cache = Path(temporary) / 'cache'
            with serve(windows) as download: app, manifest = prepare(cache, root, platform='win32-x64')
            download.assert_called_once_with(
                'https://github.com/electron/electron/releases/download/v45.4.1/' + WINDOWS_ARCHIVE, timeout=60)
            self.assertEqual(app, (cache / 'electron-v45.4.1-win32-x64').resolve())
            self.assertEqual((app / 'electron.exe').read_text(), 'synthetic executable')
            self.assertTrue((app / 'LICENSE').is_file())
            self.assertEqual(sorted(manifest['files']), ['LICENSE', 'electron.exe', 'locales/en-US.pak'])
            self.assertEqual((manifest['platform'], manifest['sha256']), ('win32-x64', hashlib.sha256(windows).hexdigest()))
            with serve(windows) as download: prepare(cache, root, platform='win32-x64')
            download.assert_not_called()


if __name__ == '__main__': unittest.main()
