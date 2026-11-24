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

    def test_renderer_core_and_common_sources_and_the_profiles_art_and_looks_change_the_fingerprint(self):
        # Each ships: the core and common libraries link into the renderer, the art and looks are copied into the app.
        inputs = ['private/renderer/core/src/deform.cpp', 'private/renderer/core/src/deform.h', 'private/renderer/core/include/core.hpp',
                  'private/renderer/core/third_party/lzfse/lzfse_decode.c', 'private/renderer/core/build.sh',
                  'private/renderer/common/src/host.cpp', 'private/renderer/common/include/host.h', 'private/renderer/common/build.sh',
                  'app/packaging/ui-art/common/tab.png', 'app/packaging/ui-art/brand/AppIcon.icns',
                  '.local/output/looks/lut/sp_filter_1.rgba8']
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for relative in inputs + source_fingerprint.EXTRA_FILES:
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                (root / relative).touch()
            profile = root / 'private/release/release.json'; profile.parent.mkdir(parents=True)
            profile.write_text(json.dumps(dict(schema='endfield-release-config/v1', ui_art='app/packaging/ui-art',
                                               photo_looks='.local/output/looks')))
            with patch.dict(os.environ, AAC_RELEASE_PROFILE=''):
                for relative in inputs:
                    with self.subTest(source=relative):
                        before = source_fingerprint.compute(root)[1]
                        (root / relative).write_text('changed')
                        self.assertNotEqual(before, source_fingerprint.compute(root)[1])
        import release
        for relative in inputs[:8]: self.assertTrue(release.shipping_path(relative), relative)
        for relative in ('private/renderer/core/tests/deform_tests.cpp', 'private/renderer/core/compare/face/golden.json',
                         'private/renderer/core/build/libplayer_core.a'):
            self.assertFalse(release.shipping_path(relative), relative)

    def test_profile_dirs_false_leaves_out_the_profile_directories_and_nothing_else(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for relative in source_fingerprint.EXTRA_FILES + ['app/packaging/ui-art/common/tab.png']:
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                (root / relative).touch()
            profile = root / 'private/release/release.json'; profile.parent.mkdir(parents=True)
            profile.write_text(json.dumps(dict(ui_art='app/packaging/ui-art', photo_looks='.local/output/looks')))
            with patch.dict(os.environ, AAC_RELEASE_PROFILE=''):
                files = source_fingerprint.compute(root, profile_dirs=False)[0]
                self.assertIn(source_fingerprint.PROFILE_KEY, files)
                self.assertFalse([name for name in files if name.startswith(('@ui-art/', '@photo-looks/'))])
                (root / '.local/output/looks').mkdir(parents=True)
                (root / '.local/output/looks/looks.json').touch()
                self.assertEqual(source_fingerprint.compute(root, profile_dirs=False)[0], files)
                self.assertEqual(set(source_fingerprint.compute(root)[0]) - set(files),
                                 {'@ui-art/common/tab.png', '@photo-looks/looks.json'})

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
