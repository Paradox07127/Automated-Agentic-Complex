import contextlib
import datetime
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dev_deploy
import package_app
from test_harness_runtime import prepared_fixture
from test_package_app import electron_fields


def at(second):
    return datetime.datetime(2026, 10, 31, 12, 0, second, tzinfo=datetime.timezone.utc)


def files(root):
    return {p.relative_to(root).as_posix(): package_app.digest(p) for p in sorted(root.rglob('*')) if p.is_file()}


@unittest.skipUnless((package_app.ROOT / '.git').exists(), 'deploy names each deployment after the git HEAD')
class DevDeployTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.web = self.root / 'web-dist'; (self.web / 'assets').mkdir(parents=True)
        for name in ['main.html', 'stack.html', 'assets/main.js']:
            (self.web / name).write_text('synthetic ' + name)
        self.art = self.root / 'art'
        (self.art / 'common').mkdir(parents=True); (self.art / 'common/contour.png').write_bytes(b'contour')
        (self.art / 'art-manifest.json').write_text(json.dumps(dict(schema='endfield-ui-art/v1', files=[
            dict(key='common/contour', file='common/contour.png', sha256=package_app.digest(self.art / 'common/contour.png'))])))
        self.base = self.root / 'dev-runtime'

    def deploy(self, part, second):
        return dev_deploy.deploy(part, base=self.base, web_dist=self.web, ui_art=self.art, now=at(second))

    def test_deployment_equals_the_staged_app_file_for_file(self):
        binaries = self.root / 'binaries'; binaries.mkdir()
        (binaries / 'metal-avatar-host').write_bytes(b'synthetic executable')
        python = self.root / 'python'; (python / 'bin').mkdir(parents=True)
        (python / 'bin/python3').write_text('#!/bin/sh\nprintf "3.12.99\\n"\n'); (python / 'bin/python3').chmod(0o755)
        fbx_tool = self.root / 'fbx-motion'; fbx_tool.write_text('#!/bin/sh\n'); fbx_tool.chmod(0o755)
        args = SimpleNamespace(output=self.root / 'out', library=Path(__file__).resolve().parents[3] / 'protocol/character-library/fixtures/library',
            id=None, port=None, python=python, **electron_fields(self, binaries),
            harness_runtime=prepared_fixture(self.root / 'harness'),
            host=binaries / 'metal-avatar-host', build_version='1', web_dist=self.web, ui_art=self.art, fbx_tool=fbx_tool,
            content_override=[relative + '=' + str(package_app.ROOT / source) for relative, source in
                              json.loads(dev_deploy.default_profile().read_text()).get('content_overrides', {}).items()])
        with contextlib.redirect_stdout(io.StringIO()), patch.object(package_app, 'sign_payload', create=True):
            package_app.stage(args)
        resources = args.output / 'Agentic Complex.app/Contents/Resources'
        staged = json.loads((args.output / 'staging-manifest.json').read_text())
        for part, second in [('all', 0), ('web', 1), ('agentd', 2)]:
            with self.subTest(part=part):
                receipt = self.deploy(part, second)
                current = self.base / 'current'
                self.assertTrue(os.readlink(current).startswith(at(second).strftime('%Y%m%dT%H%M%SZ') + '-'))
                for directory, bundled in [('ui', 'components/web-ui/payload/ui'),
                                           ('ui-bridge', 'components/web-ui/payload/ui-bridge'),
                                           ('runtime/agentd', 'components/agentd/payload/agentd')]:
                    self.assertEqual(files(current / directory), files(resources / bundled), directory)
                self.assertEqual(sorted(p.name for p in current.iterdir()), ['dev-receipt.json', 'runtime', 'ui', 'ui-bridge'])
                self.assertEqual(receipt['ui_sha256'], staged['ui_sha256'])
                self.assertEqual(receipt['agentd_sha256'], package_app.tree_sha256(resources / 'components/agentd/payload/agentd'))
                self.assertEqual(json.loads((current / 'dev-receipt.json').read_text()), receipt)
                self.assertRegex(receipt['commit'], r'^[0-9a-f]{40}$')
                self.assertIsInstance(receipt['dirty'], bool)
                self.assertEqual(Path(os.readlink(current)).name.endswith('-dirty'), receipt['dirty'])

    def test_one_half_needs_a_previous_deployment(self):
        for part in ['web', 'agentd']:
            with self.subTest(part=part), self.assertRaisesRegex(ValueError, 'deploy all first'):
                self.deploy(part, 0)
        self.assertEqual(dev_deploy.deployments(self.base), [])

    def test_current_switches_in_one_rename(self):
        self.deploy('all', 0)
        old = os.readlink(self.base / 'current')
        seen = []
        replace = os.replace
        def watched(source, target):
            if Path(target) == self.base / 'current': seen.append((os.readlink(source), os.readlink(target)))
            replace(source, target)
        with patch.object(dev_deploy.os, 'replace', side_effect=watched):
            self.deploy('agentd', 1)
        new = os.readlink(self.base / 'current')
        self.assertNotEqual(new, old)
        self.assertEqual(seen, [(new, old)], 'current points at the old deployment until the rename')
        self.assertEqual([p.name for p in self.base.iterdir() if p.name.startswith('.')], [])

    def test_only_the_last_five_deployments_stay(self):
        self.base.mkdir()
        (self.base / 'notes').mkdir()
        (self.base / '20260101T000000Z-abc').mkdir()
        made = []
        for second in range(7):
            self.deploy('all' if second == 0 else 'agentd', second)
            made.append(os.readlink(self.base / 'current'))
        self.assertEqual([p.name for p in dev_deploy.deployments(self.base)], made[-5:])
        self.assertTrue((self.base / 'notes').is_dir())
        self.assertTrue((self.base / '20260101T000000Z-abc').is_dir())
        self.assertEqual(os.readlink(self.base / 'current'), made[-1])


if __name__ == '__main__':
    unittest.main()
