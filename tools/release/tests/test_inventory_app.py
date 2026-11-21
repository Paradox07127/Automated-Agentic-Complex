from pathlib import Path
import re
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import inventory_app
from test_package_app import ELECTRON_HELPERS, synthetic_electron_app

HELPERS = sorted('Contents/Frameworks/' + name + '.app' for name in ELECTRON_HELPERS)


class InventoryNestedAppTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        # The synthetic bundle has no real code to sign; the nested-app rule is under test.
        self.codesign = self.enterContext(mock.patch.object(inventory_app.subprocess, 'run'))

    def app(self, name):
        """The synthetic Electron.app staged as Agentic Complex.app."""
        out = self.root / name / 'out'; out.mkdir(parents=True)
        app = out / 'Agentic Complex.app'
        shutil.copytree(synthetic_electron_app(self.root / name), app, symlinks=True)
        return app

    def test_an_electron_app_keeps_exactly_its_four_helper_apps(self):
        app = self.app('app')
        manifest = inventory_app.inventory(app)
        self.codesign.assert_called_once_with(['/usr/bin/codesign', '--verify', '--strict', '--deep', str(app.resolve())], check=True)
        self.assertEqual(len(HELPERS), 4)
        for helper in HELPERS:
            name = helper[len('Contents/Frameworks/'):-len('.app')]
            self.assertIn(helper + '/Contents/MacOS/' + name, manifest['files'])
        self.assertEqual((manifest['single_app'], manifest['bundle_id']), (True, 'com.github.Electron'))

    def test_an_electron_app_refuses_another_nested_app_or_a_missing_helper(self):
        for name, damage, error in [
                ('extra', lambda app: (app / 'Contents/Resources/Other.app/Contents').mkdir(parents=True),
                 'nested application remains: Contents/Resources/Other.app'),
                ('fifth helper', lambda app: (app / 'Contents/Frameworks/Electron Helper (Extra).app').mkdir(),
                 r'nested application remains: Contents/Frameworks/Electron Helper \(Extra\).app'),
                ('inside a helper', lambda app: (app / 'Contents/Frameworks/Electron Helper.app/Contents/Inner.app').mkdir(),
                 'nested application remains: Contents/Frameworks/Electron Helper.app/Contents/Inner.app'),
                ('missing', lambda app: shutil.rmtree(app / 'Contents/Frameworks/Electron Helper (GPU).app'),
                 r'Electron helper app missing: Contents/Frameworks/Electron Helper \(GPU\).app')]:
            with self.subTest(case=name):
                app = self.app(name); damage(app)
                with self.assertRaisesRegex(ValueError, '^' + error + '$'):
                    inventory_app.inventory(app)

    def test_an_app_without_the_electron_helpers_is_refused(self):
        app = self.root / 'plain/Agentic Complex.app'; (app / 'Contents/MacOS').mkdir(parents=True)
        (app / 'Contents/Info.plist').write_bytes(inventory_app.plistlib.dumps(dict(CFBundleIdentifier='local.agenticcomplex.companion')))
        (app / 'Contents/MacOS/AgenticComplex').write_bytes(b'synthetic shell')
        with self.assertRaisesRegex(ValueError, '^Electron helper app missing: ' + re.escape(', '.join(HELPERS)) + '$'):
            inventory_app.inventory(app)


if __name__ == '__main__':
    unittest.main()
