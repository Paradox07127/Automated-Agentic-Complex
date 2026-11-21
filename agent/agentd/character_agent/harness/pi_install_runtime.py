"""Build-only helper: install the locked Pi npm tree without lifecycle scripts.

This never installs global packages, locates credentials, or downloads Node.
The caller supplies an absolute npm executable. A release builder must separately
provide a self-contained Node distribution (not a Homebrew launcher) and its
license, then copy this destination to the harness.pi component's pi-runtime.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

PRUNED_SCOPES = ('@aws-sdk', '@smithy', '@google')


def install_runtime(destination, npm, *, source=None, node=None):
    source = Path(source or Path(__file__).parent.parent / 'pi-runtime').resolve()
    destination = Path(destination).resolve()
    npm = Path(npm)
    if not npm.is_absolute() or not npm.is_file():
        raise ValueError('npm_executable_required')
    if source == destination or source in destination.parents:
        raise ValueError('runtime_destination_must_be_separate')
    destination.mkdir(mode=0o755, parents=True, exist_ok=True)
    for name in ('package.json', 'package-lock.json', 'dependencies.json', 'RUNTIME.md'):
        shutil.copy2(source / name, destination / name)
    # Windows lists os.environ keys in upper case; node aborts at start without SYSTEMROOT.
    keep = {'PATH', 'HOME', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
            'SYSTEMROOT', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERPROFILE'}
    env = {key: value for key, value in os.environ.items() if key.upper() in keep}
    env['npm_config_ignore_scripts'] = 'true'
    # --ignore-scripts also prevents a dependency from running postinstall code.
    with tempfile.TemporaryDirectory(prefix='endfield-npm-config-') as temporary:
        for kind in ('user', 'global'):
            config = Path(temporary) / (kind + '.npmrc'); config.write_text('', encoding='utf-8')
            env['npm_config_' + kind + 'config'] = str(config)
        command = [str(node), str(npm)] if node else [str(npm)]
        subprocess.run([*command, 'ci', '--prefix', str(destination), '--ignore-scripts', '--no-audit', '--no-fund',
                        '--registry', 'https://registry.npmjs.org/'],
                       env=env, check=True, timeout=180)
    modules = destination / 'node_modules'
    for package in modules.glob('@earendil-works/*'):
        for name in ('docs', 'examples'):
            if (package / name).is_dir(): shutil.rmtree(package / name)
        (package / 'CHANGELOG.md').unlink(missing_ok=True)
    # Bedrock and Gemini/Vertex SDKs; pi_config only accepts OpenAI and Anthropic APIs.
    for scope in PRUNED_SCOPES:
        if (modules / scope).is_dir(): shutil.rmtree(modules / scope)
    lock = json.loads((source / 'package-lock.json').read_text(encoding='utf-8'))
    packages = []
    for relative, info in lock['packages'].items():
        if not relative: continue
        if relative.startswith(tuple('node_modules/' + scope + '/' for scope in PRUNED_SCOPES)): continue
        directory = destination / relative
        if not directory.exists() and info.get('optional'): continue
        actual = json.loads((directory / 'package.json').read_text(encoding='utf-8'))
        if actual['version'] != info['version']:
            raise ValueError('installed_dependency_version_mismatch')
        # Keep original notice files in node_modules; inventory provides their
        # hashes and package license declaration, not a substituted legal notice.
        licenses = []
        for candidate in sorted(directory.iterdir()):
            if candidate.is_file() and candidate.name.lower().startswith(('license', 'licence', 'copying', 'notice')):
                licenses.append({'path': str(candidate.relative_to(destination)),
                                 'sha256': hashlib.sha256(candidate.read_bytes()).hexdigest()})
        packages.append({'name': actual.get('name'), 'version': actual['version'], 'path': relative,
                         'license': actual.get('license'), 'license_files': licenses})
    manifest = {'pi_version': '1.4.0', 'entry_kind': 'node_sdk', 'node_minimum': '22.19.0',
                'lock_sha256': hashlib.sha256((source / 'package-lock.json').read_bytes()).hexdigest(),
                'packages': packages}
    (destination / 'runtime-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', required=True)
    parser.add_argument('--npm', required=True)
    parser.add_argument('--node')
    args = parser.parse_args()
    result = install_runtime(args.destination, args.npm, node=args.node)
    print(json.dumps({'pi_version': result['pi_version'], 'package_count': len(result['packages']), 'lock_sha256': result['lock_sha256']}))
