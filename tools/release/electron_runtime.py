"""Download, verify and unpack the locked official Electron release for the app host.

Only the archive named by `app/packaging/electron-runtime.lock.json` is fetched,
from Electron's GitHub releases, and it must match the locked SHA256 before use.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness_runtime import HOST, inventory_tree, locked, sha

ROOT = Path(__file__).resolve().parents[2]
LOCK = 'app/packaging/electron-runtime.lock.json'
SCHEMA = 'endfield-electron-runtime/v1'
RELEASES = 'https://github.com/electron/electron/releases/download/'


def prepare(cache_dir, root=ROOT, platform=HOST):
    """Return the unpacked `Electron.app` (on Windows the root holding `electron.exe`) and its manifest;
    reuse a cached archive whose hash matches."""
    lock = locked(json.loads((Path(root) / LOCK).read_text()), platform)
    if lock.get('schema') != SCHEMA or not lock['url'].startswith(RELEASES):
        raise ValueError('invalid_electron_lock')
    cache_dir = Path(cache_dir).resolve(); cache_dir.mkdir(parents=True, exist_ok=True)
    archive = cache_dir / lock['archive']
    destination = cache_dir / ('electron-v' + lock['version'] + '-' + lock['platform'])
    with tempfile.TemporaryDirectory(prefix='.electron-runtime-', dir=cache_dir) as temporary:
        temporary = Path(temporary)
        if not archive.is_file() or sha(archive) != lock['sha256']:
            download = temporary / lock['archive']
            with urllib.request.urlopen(lock['url'], timeout=60) as response, download.open('wb') as output:
                shutil.copyfileobj(response, output)
            if sha(download) != lock['sha256']: raise ValueError('electron_archive_hash_mismatch')
            os.replace(download, archive)
        staging = temporary / 'extract'
        if platform.startswith('win32'):
            with zipfile.ZipFile(archive) as packed: packed.extractall(staging)
            app = '.'
        else:
            # zipfile drops symlinks; ditto keeps the framework links and mode bits.
            subprocess.run(['/usr/bin/ditto', '-x', '-k', str(archive), str(staging)], check=True, timeout=300)
            app = 'Electron.app'
        manifest = {'schema': SCHEMA, 'version': lock['version'], 'platform': lock['platform'],
                    'sha256': lock['sha256'], 'files': inventory_tree(staging / app)}
        if destination.exists(): shutil.rmtree(destination)
        os.replace(staging, destination)
    return destination / app, manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=ROOT / '.local/cache/electron-runtime')
    args = parser.parse_args()
    app, manifest = prepare(args.cache)
    print(json.dumps({'app': str(app)} | {key: value for key, value in manifest.items() if key != 'files'}))
