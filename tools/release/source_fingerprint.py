#!/usr/bin/env python3
"""Source fingerprint of a checkout: the value package_app writes to source-manifest.json.

Stdlib only, so gate runners can import it without the agentd tree.
"""
import hashlib
import json
import os
from pathlib import Path

# The renderer's sources: a local checkout has them, a public one does not and builds an app without the renderer.
RENDERER = 'private/renderer'
# The player core's and host-common's static libraries, which core/build.sh and common/build.sh build and the host links.
RENDERER_LIBRARIES = [f'{RENDERER}/core/src', f'{RENDERER}/core/include', f'{RENDERER}/core/third_party',
    f'{RENDERER}/common/src', f'{RENDERER}/common/include']
SCOPES = ['app/electron', 'app/helpers/mac', 'app/Resources', 'app/packaging', 'agent/agentd',
    'characters', f'{RENDERER}/host/Sources', f'{RENDERER}/runtime/Sources', f'{RENDERER}/preview/Sources',
    f'{RENDERER}/character-assets/Sources', *RENDERER_LIBRARIES, 'web', 'protocol/ui-bridge']
# The Electron shell's own tests stay out.
ELECTRON_TESTS = ('app', 'electron', 'test')
EXCLUDED_PARTS = ('.build', '__pycache__', '.swiftpm', 'node_modules', 'dist', 'test-results', '.shots', 'playwright-report')
SUFFIXES = ('.swift', '.py', '.json', '.h', '.hpp', '.c', '.cpp', '.m', '.metal', '.sh', '.txt', '.md', '.mjs', '.lock',
            '.ts', '.tsx', '.css', '.html', '.plist')
RELEASE_TOOLS = ['tools/release/' + name for name in (
    'release.py', 'package_app.py', 'package_windows.py', 'windows_exe.py', 'build_components.py',
    'component_manifest.py', 'electron_runtime.py', 'harness_runtime.py', 'local_paths.py', 'inventory_app.py',
    'notarize.py', 'flip_fuses.mjs', 'gate_receipt.py', 'source_fingerprint.py')] + [
    'tools/qa/gate.py', 'tools/qa/artifact_smoke.py', 'protocol/C11-components/validate.py',
    'tools/platform/agentd-python.sh', 'tools/platform/gpu-lock.sh', 'tools/platform/sign_bundle.sh',
    'app/electron/build.mjs', 'app/electron/native/mac/build.mjs', 'web/vite.config.ts',
    'app/build_app.sh', 'app/package_release.sh', 'characters/agentic_complex_build/motion_import/native/build.sh']
PROFILE_KEY = '@release-profile'
EXTRA_FILES = [f'{RENDERER}/host/Package.swift', f'{RENDERER}/runtime/Package.swift', f'{RENDERER}/preview/Package.swift',
               f'{RENDERER}/character-assets/Package.swift', f'{RENDERER}/core/build.sh', f'{RENDERER}/common/build.sh',
               'characters/packaging/native_bundle.py', *RELEASE_TOOLS]
# The profile's directories whose every file the app ships.
PROFILE_DIRECTORIES = {'ui_art': '@ui-art/', 'photo_looks': '@photo-looks/'}


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while chunk := stream.read(4 * 1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def profile_inputs(root):
    # Imported here: release imports this module.
    from release import default_profile
    profile = default_profile(Path(root))
    if not profile.is_file():
        return {}
    data = profile.read_bytes()
    document = json.loads(data)
    inputs = {PROFILE_KEY: hashlib.sha256(data).hexdigest()}
    for target, source in document.get('content_overrides', {}).items():
        inputs['@content-override/' + target] = digest(Path(root) / source)
    for key, prefix in PROFILE_DIRECTORIES.items():
        if document.get(key) is None: continue
        directory = Path(root) / document[key]
        for path in sorted(directory.rglob('*')):
            if path.is_file(): inputs[prefix + path.relative_to(directory).as_posix()] = digest(path)
    return inputs


def source_files(root):
    """SHA-256 by checkout-relative path, with a stable key for the selected profile in any checkout."""
    root = Path(root)
    files = profile_inputs(root)
    for scope in SCOPES:
        # followlinks=False matches rglob('*'): symlinked directories are not entered, symlinked files are hashed.
        for directory, dirnames, filenames in os.walk(root / scope):
            dirnames[:] = sorted(name for name in dirnames if name not in EXCLUDED_PARTS)
            for name in sorted(filenames):
                path = Path(directory, name)
                relative = path.relative_to(root)
                if any(p in EXCLUDED_PARTS for p in relative.parts) or relative.parts[:3] == ELECTRON_TESTS or not path.is_file(): continue
                if path.suffix in SUFFIXES:
                    files[relative.as_posix()] = digest(path)
    for relative in EXTRA_FILES:
        if relative.startswith(RENDERER + '/') and not (root / relative).is_file(): continue
        files[relative] = digest(root / relative)
    return files


def fingerprint(files):
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()


def compute(root):
    files = source_files(root)
    return files, fingerprint(files)
