import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import source_fingerprint


class SourceFingerprintTests(unittest.TestCase):
    def test_selected_profile_content_changes_the_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'checkout'
            for relative in source_fingerprint.EXTRA_FILES:
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                (root / relative).touch()
            private = root / 'private/release/release.json'
            private.parent.mkdir(parents=True)
            external = Path(tmp) / 'electron.json'
            for profile in (private, external):
                with self.subTest(profile=profile.name), patch.dict(os.environ, AAC_RELEASE_PROFILE='' if profile == private else str(external)):
                    profile.write_text(json.dumps(dict(notary_keychain_profile='first')))
                    first = source_fingerprint.compute(root)[1]
                    profile.write_text(json.dumps(dict(notary_keychain_profile='second')))
                    self.assertNotEqual(first, source_fingerprint.compute(root)[1])

    def test_entitlements_and_release_tools_each_invalidate_the_fingerprint(self):
        inputs = ['app/packaging/entitlements/main.plist'] + ['tools/release/' + name for name in
            ('release.py', 'package_app.py', 'electron_runtime.py', 'notarize.py', 'flip_fuses.mjs')]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for relative in inputs + source_fingerprint.EXTRA_FILES:
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                (root / relative).touch()
            for relative in inputs:
                with self.subTest(source=relative):
                    before = source_fingerprint.compute(root)[1]
                    (root / relative).write_text('changed')
                    self.assertNotEqual(before, source_fingerprint.compute(root)[1])

    def test_compute_hashes_scoped_sources_and_extra_files_only(self):
        inside = ['agent/agentd/server.py', 'web/src/main.tsx', 'protocol/ui-bridge/routes.json']
        outside = ['agent/agentd/notes.bin', 'agent/agentd/__pycache__/server.py',
                   'web/node_modules/pkg/index.ts', 'characters/dist/out.json',
                   'app/Tests/Probe.swift', 'app/Sources/Core.swift', 'app/Package.swift', 'elsewhere/linked.py']
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for relative in inside + outside + source_fingerprint.EXTRA_FILES:
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                (root / relative).write_text('content of ' + relative)
            os.symlink(root / 'elsewhere', root / 'agent/agentd/linked')
            os.symlink(root / 'missing.py', root / 'agent/agentd/broken.py')
            files, fingerprint = source_fingerprint.compute(root)
        expected = {relative: hashlib.sha256(('content of ' + relative).encode()).hexdigest()
                    for relative in inside + source_fingerprint.EXTRA_FILES}
        self.assertEqual(files, expected)
        self.assertEqual(fingerprint, hashlib.sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest())
        self.assertEqual(source_fingerprint.fingerprint(expected), fingerprint)

    def test_every_profile_covers_the_electron_shell_and_helper_sources(self):
        electron = ['app/electron/src/main/index.ts', 'app/electron/package.json', 'app/electron/build.mjs',
                    'app/electron/native/mac/preview.m', 'app/helpers/mac/Sources/HelperCore/Permissions.swift',
                    'app/helpers/mac/Package.swift']
        outside = ['app/electron/node_modules/electron/index.ts', 'app/electron/dist/main.mjs',
                   'app/electron/test/config.test.ts', 'app/helpers/mac/.build/release/main.swift']
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for relative in electron + outside + source_fingerprint.EXTRA_FILES:
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                (root / relative).write_text('content of ' + relative)
            (root / 'app/packaging').mkdir()
            (root / 'app/packaging/release.json').write_text(json.dumps({'schema': 'endfield-release-config/v1'}))
            files = source_fingerprint.compute(root)[0]
            self.assertEqual(set(files), {'app/packaging/release.json', '@release-profile', *electron,
                                          *source_fingerprint.EXTRA_FILES})


if __name__ == '__main__':
    unittest.main()
