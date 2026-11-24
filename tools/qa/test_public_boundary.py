"""Public tracked files do not reference private/, and the release lists ship nothing from it."""
import json
from pathlib import Path
import re
import subprocess
import sys
import unittest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools/release'))
import release
import source_fingerprint

# `/private/tmp`, `/private/var` and other absolute macOS paths do not match.
REFERENCE = re.compile(r'(?<![\w./-])private/')
# The extension points public code looks for when they exist.
ALLOWED_REFERENCES = (
    'private/suites.json',
    'private/release/release.json',
    'private/windows/host.json',
    'private/renderer',  # the renderer's sources; a public checkout builds without them
    'private/remote',  # the Windows build-host runner
)
ALLOWED_FILES = (
    'app/Tests/t_gate.sh',  # builds stub private suites for the gate's self-test
    'tools/qa/test_public_boundary.py',
)


def public_files():
    listed = subprocess.run(['git', '-C', str(REPO), 'ls-files', '-z'], check=True, capture_output=True, text=True).stdout
    return [rel for rel in listed.split('\0') if rel and not rel.startswith('private/')]


def text_of(path):
    try:
        data = path.read_bytes()
    except (FileNotFoundError, IsADirectoryError):
        return None
    if b'\0' in data[:8192]:
        return None
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        return None


class PublicBoundary(unittest.TestCase):
    def test_public_files_do_not_reference_private(self):
        hits = []
        for rel in public_files():
            if rel in ALLOWED_FILES:
                continue
            text = text_of(REPO / rel)
            if text is None:
                continue
            for number, line in enumerate(text.splitlines(), 1):
                for match in REFERENCE.finditer(line):
                    if not line.startswith(ALLOWED_REFERENCES, match.start()):
                        hits.append(f'{rel}:{number}: {line}')
                        break
        self.assertEqual(hits, [], '\n' + '\n'.join(hits))

    def test_no_tracked_file_is_ignored(self):
        # A tracked file an ignore rule matches drops out of the next `git add -A` that follows its removal.
        ignored = subprocess.run(['git', '-C', str(REPO), 'ls-files', '-ci', '--exclude-standard'], capture_output=True, text=True, check=True).stdout.split()
        self.assertEqual(ignored, [])

    def test_release_lists_ship_no_private_file(self):
        lists = dict(CONTENT_SOURCES=release.CONTENT_SOURCES, CONTENT_PACKAGES=release.CONTENT_PACKAGES,
                     SCOPES=source_fingerprint.SCOPES, EXTRA_FILES=source_fingerprint.EXTRA_FILES)
        # The fingerprint hashes the renderer's sources where a checkout has them; nothing else private.
        hits = [f'{name}: {path}' for name, paths in lists.items() for path in paths
                if path.startswith('private/') and not path.startswith(source_fingerprint.RENDERER + '/')]
        profile = json.loads((REPO / 'app/packaging/release.json').read_text(encoding='utf-8'))
        hits += [f'app/packaging/release.json {key}: {profile[key]}' for key in ('character_catalog', 'ui_art', 'output_root')
                 if profile[key] is not None and profile[key].startswith('private/')]
        self.assertEqual(hits, [])
        self.assertFalse(release.shipping_path('private/x'))
        self.assertTrue(release.shipping_path(source_fingerprint.RENDERER + '/host/Sources/MetalAvatarHost/App/Host.swift'))


if __name__ == '__main__':
    unittest.main()
