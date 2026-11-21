import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

GUARD = Path(__file__).resolve().parent / 'worktree_guard.py'


def git(cwd, *args):
    subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True)


class WorktreeGuard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.main = Path(self.tmp.name, 'repo')
        self.main.mkdir()
        git(self.main, 'init', '-q', '-b', 'main')
        (self.main / '.gitignore').write_text('notes/\n')
        (self.main / 'a.txt').write_text('a\n')
        git(self.main, 'add', '.')
        git(self.main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
        self.wt = self.main / '.claude/worktrees/w'
        git(self.main, 'worktree', 'add', '-q', '--detach', str(self.wt))

    def guard(self, path, key='file_path'):
        done = subprocess.run([sys.executable, '-I', str(GUARD)], input=json.dumps({'tool_input': {key: str(path)}}),
                              capture_output=True, text=True, timeout=30)
        return done.returncode, done.stderr

    def test_a_tracked_or_new_file_in_the_main_checkout_is_blocked(self):
        for path in (self.main / 'a.txt', self.main / 'src/new.py'):
            with self.subTest(str(path)):
                code, err = self.guard(path)
                self.assertEqual(code, 2)
                self.assertIn('EnterWorktree', err)
        self.assertEqual(self.guard(self.main / 'x.ipynb', 'notebook_path')[0], 2)

    def test_a_worktree_an_ignored_path_and_a_path_outside_pass(self):
        for path in (self.wt / 'a.txt', self.wt / 'src/new.py', self.main / 'notes/plan.md',
                     Path(self.tmp.name, 'elsewhere.txt')):
            with self.subTest(str(path)):
                self.assertEqual(self.guard(path), (0, ''))


if __name__ == '__main__':
    unittest.main()
