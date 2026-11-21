"""Prepare and verify locked personal-agent dependencies outside a release app.

Network installation belongs to this explicit preparation command. Staging only
accepts a complete, current, hash-verified result and never finds a global CLI.
"""
import argparse
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
LOCKS = ('agent/agentd/requirements-character-agent.lock', 'app/packaging/requirements-content.lock',
         'agent/agentd/character_agent/pi-runtime/package-lock.json', 'app/packaging/node-runtime.lock.json')
PYTHON_LOCKS = LOCKS[:2]
EXPECTED = {'numpy': '2.5.4'}
PI_UNUSED = ('.map', '.d.ts', '.d.mts')
HOST = 'win32-x64' if sys.platform == 'win32' else 'darwin-arm64'
# Paths in the prepared runtime (node/ is the official archive's root) and in a venv.
LAYOUT = {'darwin-arm64': {'node': 'node/bin/node', 'npm': 'node/lib/node_modules/npm/bin/npm-cli.js', 'venv_python': 'bin/python'},
          'win32-x64': {'node': 'node/node.exe', 'npm': 'node/node_modules/npm/bin/npm-cli.js', 'venv_python': 'Scripts/python.exe'}}


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def normalized(name): return re.sub(r'[-_.]+', '-', name).lower()


def locked(lock, platform=HOST):
    """The lock's entry for platform: the top level is one platform, `platforms` overrides archive, url and sha256."""
    if platform == lock['platform']: return lock
    return lock | {'platform': platform} | lock['platforms'][platform]


def lock_hashes(root=ROOT):
    return {name: sha(root / name) for name in LOCKS}


def python_pins(root=ROOT):
    pins = {}
    for name in PYTHON_LOCKS:
        for line in (root / name).read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#'): continue
            match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([^ ]+)( ; sys_platform == "win32")? (--hash=sha256:[0-9a-f]{64})(?: --hash=sha256:[0-9a-f]{64})*', line.strip())
            if not match: raise ValueError('unhashed_python_dependency')
            if match.group(3) and sys.platform != 'win32': continue
            key = normalized(match.group(1)); value = match.group(2)
            if key in pins and pins[key] != value: raise ValueError('conflicting_python_dependency')
            pins[key] = value
    return pins


def verify_python_site(site, pins):
    actual = {}
    for distribution in metadata.distributions(path=[str(site)]):
        name = normalized(distribution.metadata['Name'])
        if name in actual: raise ValueError('duplicate_python_distribution: ' + name)
        actual[name] = distribution.version
    for name, version in pins.items():
        if actual.get(name) != version: raise ValueError('python_dependency_mismatch: ' + name)
    extra = actual.keys() - pins.keys()
    if extra: raise ValueError('unlocked_python_distributions: ' + ', '.join(sorted(extra)))
    return actual


def inventory_tree(directory):
    root = Path(directory).resolve(); files = {}
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        if relative == 'manifest.json' or '__pycache__' in path.parts or path.suffix == '.pyc': continue
        if path.is_symlink():
            if not path.resolve().is_relative_to(root): raise ValueError('runtime_external_symlink: ' + relative)
            files[relative] = {'symlink': os.readlink(path)}
        elif path.is_file():
            files[relative] = {'sha256': sha(path), 'executable': bool(path.stat().st_mode & 0o111)}
    return files


def verify_node(node, version, platform=HOST):
    windows = platform.startswith('win32')
    # node.exe aborts at start without SYSTEMROOT.
    env = {'SYSTEMROOT': os.environ['SYSTEMROOT']} if windows else {'PATH': '/usr/bin:/bin', 'HOME': '/var/empty'}
    actual = subprocess.check_output([str(node), '--version'], text=True, timeout=10, env=env).strip()
    if actual != 'v' + version: raise ValueError('node_version_mismatch')
    if windows: return
    dependencies = subprocess.check_output(['/usr/bin/otool', '-L', str(node)], text=True, timeout=10)
    for line in dependencies.splitlines()[1:]:
        dependency = line.strip().split(' (', 1)[0]
        if not dependency.startswith(('/usr/lib/', '/System/Library/')):
            raise ValueError('node_external_library: ' + dependency)


def validate_runtime(directory, root=ROOT, *, execute=False, platform=HOST):
    directory = Path(directory).resolve()
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest.get('schema') != 'endfield-personal-agent-runtime/v1' or manifest.get('locks') != lock_hashes(root):
        raise ValueError('harness_runtime_locks_stale')
    if inventory_tree(directory) != manifest.get('files'): raise ValueError('harness_runtime_integrity_mismatch')
    verify_python_site(directory / 'python-site', python_pins(root))
    lock = json.loads((root / LOCKS[3]).read_text())
    if manifest.get('node_version') != lock['version']: raise ValueError('node_version_mismatch')
    package = json.loads((directory / 'pi-runtime/node_modules/@earendil-works/pi-coding-agent/package.json').read_text())
    if package.get('version') != '1.4.0': raise ValueError('pi_sdk_version_mismatch')
    for relative in (LAYOUT[platform]['node'], 'node/LICENSE', 'pi-runtime/runtime-manifest.json'):
        if not (directory / relative).is_file(): raise ValueError('harness_runtime_incomplete')
    if execute: verify_node(directory / LAYOUT[platform]['node'], lock['version'], platform)
    return manifest


def copy_python_site(overlay, destination):
    """Copy the site prepared from the hash-locked wheels to the fresh runtime prefix."""
    # pip --target puts console-script launchers in <overlay>/bin; they name the build host's python by absolute path
    # and nothing in the runtime runs them.
    shutil.copytree(overlay, destination, symlinks=True,
                    ignore=lambda directory, names: [name for name in names if name == '__pycache__' or name.endswith('.pyc')
                                                     or Path(directory) == overlay and name == 'bin'])


def prepare(destination, python, root=ROOT):
    destination = Path(destination).resolve(); python = Path(python).absolute()
    if destination.exists():
        return validate_runtime(destination, root, execute=True)
    lock = locked(json.loads((root / LOCKS[3]).read_text()))
    layout = LAYOUT[HOST]
    if lock['schema'] != 'endfield-node-runtime/v1' or not lock['url'].startswith('https://nodejs.org/dist/'):
        raise ValueError('invalid_node_lock')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.harness-runtime-', dir=destination.parent) as temporary:
        temporary = Path(temporary); staging = temporary / 'payload'; staging.mkdir()
        archive = temporary / lock['archive']
        with urllib.request.urlopen(lock['url'], timeout=60) as response, archive.open('wb') as output:
            shutil.copyfileobj(response, output)
        if sha(archive) != lock['sha256']: raise ValueError('node_archive_hash_mismatch')
        if lock['archive'].endswith('.zip'):
            with zipfile.ZipFile(archive) as packed: packed.extractall(temporary / 'extract')
        else:
            with tarfile.open(archive, 'r:gz') as tar:
                tar.extractall(temporary / 'extract', filter='data')
        source = temporary / 'extract' / lock['archive'].removesuffix('.zip').removesuffix('.tar.gz')
        shutil.move(source, staging / 'node')
        verify_node(staging / layout['node'], lock['version'])
        site = staging / 'python-site'
        # The development uv venv need not contain pip. Bootstrap only a
        # disposable installer venv, never mutate the developer interpreter.
        installer = temporary / 'installer'
        subprocess.run([str(python), '-I', '-m', 'venv', str(installer)], check=True, timeout=60)
        command = [str(installer / layout['venv_python']), '-I', '-m', 'pip', '--isolated', 'install', '--require-hashes', '--only-binary=:all:',
                   '--no-compile', '--disable-pip-version-check', '--index-url', 'https://pypi.org/simple', '--target', str(site)]
        for name in PYTHON_LOCKS: command += ['-r', str(root / name)]
        subprocess.run(command, check=True, timeout=300)
        verify_python_site(site, python_pins(root))
        sys.path.insert(0, str(root / 'agent/agentd'))
        from character_agent.harness.pi_install_runtime import install_runtime
        install_runtime(staging / 'pi-runtime', staging / layout['npm'],
                        source=root / 'agent/agentd/character_agent/pi-runtime', node=staging / layout['node'])
        # Source maps and type declarations: Pi's node loads neither (nothing turns source maps on).
        for path in (staging / 'pi-runtime/node_modules').rglob('*'):
            if path.name.endswith(PI_UNUSED) and path.is_file(): path.unlink()
        manifest = {'schema': 'endfield-personal-agent-runtime/v1', 'locks': lock_hashes(root),
                    'node_version': lock['version'], 'pi_version': '1.4.0', 'python_packages': EXPECTED,
                    'files': inventory_tree(staging)}
        (staging / 'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
        validate_runtime(staging, root, execute=True)
        shutil.move(staging, destination)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--python', type=Path, default=ROOT / 'agent/.venv/bin/python')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    result = validate_runtime(args.output, execute=True) if args.check else prepare(args.output, args.python)
    print(json.dumps({key: value for key, value in result.items() if key != 'files'}))
