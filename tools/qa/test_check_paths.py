"""check_paths.py --components against a fixture git tree with two components, and protocol/cross-paths.json against the build."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools/release'))
import release

README = '# 协议\n\n## 现行协议\n\n| ID | 接口 |\n|---|---|\n| C9 | agentd 进程 |\n\n## 已退役\n\n| C4 | 帧输出 |\n'


class Components(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / 'tools/qa').mkdir(parents=True)
        shutil.copy(REPO / 'tools/qa/check_paths.py', self.root / 'tools/qa/check_paths.py')
        self.write('protocol/README.md', README)
        self.write('a/writer.py', "open(state / 'a-state.json', 'w')\n")
        self.write('b/reader.swift', 'let url = dir.appendingPathComponent("a-state.json")\n')
        self.spec = {'schema': 'endfield-cross-paths/v1', 'roots': {'a': ['a/'], 'b': ['b/']},
                     'owned': {'a': ['a-state.json']}, 'ignore': {},
                     'allow': [{'row': 'C9', 'token': 'a-state.json', 'files': ['b/reader.swift']}]}

    def write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def run_check(self, flag='--components'):
        self.write('protocol/cross-paths.json', json.dumps(self.spec))
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        subprocess.run(['git', '-C', str(self.root), 'add', '-A'], check=True)
        p = subprocess.run([sys.executable, '-I', str(self.root / 'tools/qa/check_paths.py'), flag],
                           capture_output=True, text=True)
        return p.returncode, p.stdout

    def test_broken_markdown_link_fails(self):
        self.write('guide.md', '[setup](setup.md)')
        code, out = self.run_check('--links')
        self.assertIn('guide.md: setup.md', out)
        self.assertEqual((code, out.splitlines()[-1]), (1, 'CHECK-PATHS FAIL'))

    def test_registered_reference_passes(self):
        code, out = self.run_check()
        self.assertEqual(code, 0, out)
        self.assertEqual(out.splitlines()[-1], 'CHECK-PATHS PASS')

    def test_unregistered_reference_fails_naming_file_and_token(self):
        self.spec['allow'] = []
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn('b/reader.swift:1: a-state.json', out)

    def test_row_not_in_current_table_fails(self):
        self.spec['allow'][0]['row'] = 'C4'
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn('row C4', out)

    def test_allow_for_a_file_without_the_token_fails(self):
        self.spec['allow'][0]['files'].append('b/other.swift')
        self.write('b/other.swift', 'let x = 1\n')
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn('b/other.swift no longer has a-state.json', out)

    def test_path_in_a_comment_is_not_a_reference(self):
        self.write('b/reader.swift', '// reads "a-state.json"\n/* and\n "a-state.json" */\nlet u = "https://x"  // "a-state.json"\n')
        self.write('b/tool.py', '"""Reads "a-state.json"."""\nx = 1  # "a-state.json"\n')
        self.spec['allow'] = []
        code, out = self.run_check()
        self.assertEqual(code, 0, out)

    def test_unquoted_shell_word_is_a_reference(self):
        self.write('b/run.sh', 'cat a-state.json\nf=a-state.json\n')
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn('b/run.sh:1: a-state.json', out)
        self.assertIn('b/run.sh:2: a-state.json', out)

    def test_file_name_in_swift_prose_is_not_a_reference(self):
        self.write('b/message.swift', 'let m = "cannot read a-state.json"\n')
        code, out = self.run_check()
        self.assertEqual(code, 0, out)

    def test_tests_are_not_scanned(self):
        self.write('b/tests/test_reader.py', "path = 'a-state.json'\n")
        code, out = self.run_check()
        self.assertEqual(code, 0, out)

    def test_name_hard_coded_in_two_components_fails_until_owned_or_ignored(self):
        self.write('a/shared.py', "p = root / 'shared.json'\n")
        self.write('b/shared.swift', 'let p = "shared.json"\n')
        code, out = self.run_check()
        self.assertEqual(code, 1, out)
        self.assertIn('a/shared.py:1: shared.json', out)
        self.assertIn('b/shared.swift:1: shared.json', out)
        self.spec['ignore'] = {'shared.json': 'two unrelated files'}
        code, out = self.run_check()
        self.assertEqual(code, 0, out)

    def test_file_in_two_components_shares_names_with_both(self):
        self.spec['roots'] = {'a': ['a/', 'lib/'], 'b': ['b/', 'lib/']}
        self.write('lib/x.swift', 'let p = "shared.json"\n')
        self.write('a/shared.py', "p = root / 'shared.json'\n")
        code, out = self.run_check()
        self.assertEqual(code, 0, out)


class Roots(unittest.TestCase):
    def test_agentd_content_roots_match_the_release_build(self):
        spec = json.loads((REPO / 'protocol/cross-paths.json').read_text())
        content = {p for p in spec['roots']['agentd'] if p.startswith('characters/')}
        self.assertEqual(content, {*release.CONTENT_SOURCES, *release.CONTENT_PACKAGES})


if __name__ == '__main__':
    unittest.main()
