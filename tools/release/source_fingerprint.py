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
SCOPES = ['app/electron', 'app/helpers/mac', 'app/Resources', 'app/packaging', 'agent/agentd',
    'characters', f'{RENDERER}/host/Sources', f'{RENDERER}/runtime/Sources', f'{RENDERER}/preview/Sources',
    f'{RENDERER}/character-assets/Sources', 'web', 'protocol/ui-bridge']
# The Electron shell's own tests stay out.
ELECTRON_TESTS = ('app', 'electron', 'test')
EXCLUDED_PARTS = ('.build', '__pycache__', '.swiftpm', 'node_modules', 'dist', 'test-results', '.shots', 'playwright-report')
SUFFIXES = ('.swift', '.py', '.json', '.h', '.c', '.m', '.metal', '.txt', '.md', '.mjs', '.lock',
            '.ts', '.tsx', '.css', '.html', '.plist')
RELEASE_TOOLS = ('release.py', 'package_app.py', 'electron_runtime.py', 'notarize.py', 'flip_fuses.mjs')
PROFILE_KEY = '@release-profile'
# Files hashed when they exist (the renderer's package manifests are absent from a public checkout).
EXTRA_FILES = [f'{RENDERER}/host/Package.swift', f'{RENDERER}/runtime/Package.swift', f'{RENDERER}/preview/Package.swift',
               f'{RENDERER}/character-assets/Package.swift', 'app/build_app.sh', 'app/package_release.sh', 'tools/platform/sign_bundle.sh',
               'characters/packaging/native_bundle.py',
               'characters/agentic_complex_build/motion_import/native/build.sh']


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
    return {PROFILE_KEY: digest(profile)} if profile.is_file() else {}


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
    for name in RELEASE_TOOLS:
        path = root / 'tools/release' / name
        if path.is_file(): files[path.relative_to(root).as_posix()] = digest(path)
    for relative in EXTRA_FILES:
        if relative.startswith(RENDERER + '/') and not (root / relative).is_file(): continue
        files[relative] = digest(root / relative)
    return files


def fingerprint(files):
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()


def compute(root):
    files = source_files(root)
    return files, fingerprint(files)
