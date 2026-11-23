"""xplat_guard.py against throwaway git repos, one per violation class, plus the real repo."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools/qa'))
import xplat_guard


class Guard(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        subprocess.run(['git', 'init', '-q'], cwd=self.root, check=True)
        (self.root / '.gitattributes').write_text('* text=auto eol=lf\n')

    def add(self, rel, text='x\n'):
        # Index-only, so names that collide or are illegal on this filesystem still work.
        blob = subprocess.run(['git', 'hash-object', '-w', '--stdin'], cwd=self.root, input=text,
                              capture_output=True, text=True, check=True).stdout.strip()
        subprocess.run(['git', 'update-index', '--add', '--cacheinfo', f'100644,{blob},{rel}'],
                       cwd=self.root, check=True)

    def reasons(self):
        return [f'{p}: {r}' for p, r in xplat_guard.violations(self.root)]

    def source(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def test_clean(self):
        self.add('a/b.txt')
        self.assertEqual(self.reasons(), [])

    def test_case_pair(self):
        self.add('a/Readme.md')
        self.add('a/README.md')
        self.assertEqual(len(self.reasons()), 2)
        self.assertIn('differs only by case', self.reasons()[0])

    def test_reserved(self):
        self.add('a/con.txt')
        self.add('NUL')
        self.add('x/Com3/y.py')
        self.assertEqual(len(self.reasons()), 3)
        self.assertTrue(all('reserved' in r for r in self.reasons()))

    def test_illegal_char(self):
        self.add('a/b?c.txt')
        self.add('a/d:e')
        self.assertEqual(len(self.reasons()), 2)

    def test_trailing_dot_or_space(self):
        self.add('a/b.')
        self.add('c /d.txt')
        self.assertEqual(len(self.reasons()), 2)

    def test_long_path(self):
        self.add('a/' + 'x' * 200 + '.txt')
        self.assertIn('longer than', self.reasons()[0])

    def test_missing_attributes(self):
        (self.root / '.gitattributes').unlink()
        self.assertEqual(self.reasons(), ['.gitattributes: missing'])

    def test_attributes_without_eol(self):
        (self.root / '.gitattributes').write_text('*.png binary\n')
        self.assertEqual(self.reasons(), ['.gitattributes: no eol rule'])

    def test_electron_common_imports(self):
        self.source('app/electron/src/common/a.ts', "import { app } from 'electron';\n")
        self.source('app/electron/src/common/b.ts', 'export { join } from "node:path";\n')
        self.source('app/electron/src/common/c.ts', "const m = await import('electron/main');\n")
        self.source('app/electron/src/common/d.ts', "import ops from './ops.ts';\nimport x from 'electron-like';\n")
        self.source('app/electron/src/main/e.ts', "import { app } from 'electron';\nimport fs from 'node:fs';\n")
        self.assertEqual(self.reasons(), [
            "app/electron/src/common/a.ts: src/common imports 'electron'",
            "app/electron/src/common/b.ts: src/common imports 'node:path'",
            "app/electron/src/common/c.ts: src/common imports 'electron/main'",
        ])

    def test_layer_rules_read_unstaged_and_untracked_sources(self):
        directory = self.root / 'app/electron/src/common'
        directory.mkdir(parents=True)
        self.add('app/electron/src/common/a.ts', 'export const value = 1;')
        self.add('app/electron/src/common/deleted.ts', "import 'electron';")
        (directory / 'a.ts').write_text("import 'node:path';")
        (directory / 'new.ts').write_text("import 'electron';")
        (directory / '.gitignore').write_text('ignored.ts\n')
        (directory / 'ignored.ts').write_text("import 'electron';")
        self.assertEqual(self.reasons(), [
            "app/electron/src/common/a.ts: src/common imports 'node:path'",
            "app/electron/src/common/new.ts: src/common imports 'electron'",
        ])

    def test_electron_process_platform(self):
        self.source('app/electron/src/main/platform/index.ts', "export const mac = process.platform === 'darwin';\n")
        self.source('app/electron/src/main/index.ts', "if (process.platform === 'win32') {}\n")
        self.source('app/electron/src/preload/index.ts', 'const p = process.platform;\n')
        self.source('web/src/x.ts', 'const p = process.platform;\n')
        self.assertEqual(self.reasons(), [
            'app/electron/src/main/index.ts: reads process.platform outside src/main/platform/',
            'app/electron/src/preload/index.ts: reads process.platform outside src/main/platform/',
        ])

    def test_agentd_platform_tests_only_go_down(self):
        limited = 'agent/agentd/resource_store.py'
        self.assertEqual(xplat_guard.AGENTD_PLATFORM_LIMITS[limited], 2)
        self.source(limited, "if sys.platform == 'darwin': pass\n")
        self.source('agent/agentd/infra/platform/__init__.py', 'W = sys.platform == "win32"\n' * 5)
        self.source('agent/agentd/tests/test_x.py', 'if os.name == "nt": pass\n')
        self.source('agent/agentd/x_test_helper.txt', 'os.name\n')
        self.assertEqual(self.reasons(), [])
        self.source(limited, "if sys.platform == 'darwin': pass\nif os.name == 'nt': pass\nplatform.system()\n")
        self.source('agent/agentd/new_module.py', 'WINDOWS = os.name == "nt"\n')
        self.assertEqual([r.split(' (')[0] for r in self.reasons()], [
            'agent/agentd/new_module.py: 1 operating-system tests',
            'agent/agentd/resource_store.py: 3 operating-system tests',
        ])
        self.assertIn('limit 0; use agent/agentd/infra/platform/', self.reasons()[0])

    def test_cli_exit_code(self):
        self.add('aux.txt')
        run = subprocess.run([sys.executable, '-I', str(REPO / 'tools/qa/xplat_guard.py'), str(self.root)],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 1)
        self.assertIn('aux.txt: Windows reserved name', run.stdout)


class RealRepo(unittest.TestCase):
    def test_zero_violations(self):
        self.assertEqual(xplat_guard.violations(REPO), [])


if __name__ == '__main__':
    unittest.main()
