"""Git state of a work segment's checkout and whether its HEAD landed in the main tree, on real small repositories."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sessions.git_state import landed, snapshot
import test_worklog_l1 as l1

GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]


class Repo:
    def __init__(self, test):
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name).resolve()
        self.root = self.base / "repo"
        subprocess.run(["git", "init", "-q", "-b", "main", str(self.root)], check=True)
        self.commit(self.root, "a.txt", "a\n")

    def git(self, cwd, *args):
        return subprocess.run([*GIT, "-C", str(cwd), *args], check=True, capture_output=True, text=True, encoding="utf-8").stdout.strip()

    def time(self, sha):
        return int(self.git(self.root, "log", "-1", "--format=%ct", sha))

    def commit(self, cwd, name, text):
        (Path(cwd) / name).write_text(text, encoding="utf-8")
        self.git(cwd, "add", name)
        self.git(cwd, "commit", "-q", "-m", name)
        return self.git(cwd, "rev-parse", "HEAD")

    def worktree(self, branch):
        path = self.base / "trees" / "checkout"
        self.git(self.root, "worktree", "add", "-q", "-b", branch, str(path))
        return path


class SnapshotTest(unittest.TestCase):
    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_a_worktree_names_its_main_tree_branch_head_and_dirty_count(self):
        repo = Repo(self)
        tree = repo.worktree("w1")
        head = repo.commit(tree, "b.txt", "b\n")
        (tree / "b.txt").write_text("changed\n", encoding="utf-8")
        (tree / "new.txt").write_text("new\n", encoding="utf-8")
        self.assertEqual(snapshot(str(tree)), {"root": str(repo.root), "branch": "w1", "head": head, "dirty": 2,
                                               "linked": True, "committed_at": repo.time(head)})
        self.assertEqual(snapshot(str(repo.root))["dirty"], 0)

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_a_detached_head_has_no_branch(self):
        repo = Repo(self)
        head = repo.git(repo.root, "rev-parse", "HEAD")
        repo.git(repo.root, "checkout", "-q", "--detach")
        self.assertEqual(snapshot(str(repo.root)), {"root": str(repo.root), "branch": None, "head": head, "dirty": 0,
                                                    "linked": False, "committed_at": repo.time(head)})

    def test_a_checkout_whose_path_has_a_space_has_a_snapshot(self):
        repo = Repo(self)
        spaced = repo.base / "my repo"
        subprocess.run(["git", "init", "-q", "-b", "main", str(spaced)], check=True)
        repo.commit(spaced, "a.txt", "a\n")
        self.assertIsNotNone(snapshot(str(spaced)))

    def test_no_directory_no_repository_or_no_commit_is_none(self):
        repo = Repo(self)
        plain = repo.base / "plain"
        plain.mkdir()
        empty = repo.base / "empty"
        subprocess.run(["git", "init", "-q", str(empty)], check=True)
        for cwd in (str(repo.base / "gone"), str(plain), str(empty), None, ""):
            with self.subTest(cwd=cwd):
                self.assertIsNone(snapshot(cwd))


class LandedTest(unittest.TestCase):
    def test_a_merged_branch_landed_and_an_open_one_did_not(self):
        repo = Repo(self)
        tree = repo.worktree("w1")
        head = repo.commit(tree, "b.txt", "b\n")
        self.assertFalse(landed(str(repo.root), head))
        repo.commit(repo.root, "c.txt", "c\n")
        repo.git(repo.root, "merge", "-q", "--no-ff", "-m", "merge", "w1")
        repo.git(repo.root, "worktree", "remove", str(tree))
        self.assertTrue(landed(str(repo.root), head))

    def test_a_rebased_branch_landed_by_its_patches(self):
        repo = Repo(self)
        tree = repo.worktree("w1")
        repo.commit(tree, "b.txt", "b\n")
        head = repo.commit(tree, "d.txt", "d\n")
        repo.commit(repo.root, "c.txt", "c\n")
        repo.git(tree, "rebase", "-q", "main")
        repo.git(repo.root, "merge", "-q", "--ff-only", "w1")
        self.assertNotEqual(repo.git(repo.root, "rev-parse", "HEAD"), head)
        self.assertTrue(landed(str(repo.root), head))

    def test_a_squashed_branch_a_missing_object_or_no_repository_is_false(self):
        repo = Repo(self)
        tree = repo.worktree("w1")
        repo.commit(tree, "b.txt", "b\n")
        head = repo.commit(tree, "d.txt", "d\n")
        repo.git(repo.root, "merge", "-q", "--squash", "w1")
        repo.git(repo.root, "commit", "-q", "-m", "squash")
        self.assertFalse(landed(str(repo.root), head))
        self.assertFalse(landed(str(repo.root), "0" * 40))
        self.assertFalse(landed(str(repo.base / "gone"), head))


class StoredSnapshotTest(unittest.TestCase):
    """The L1 row of a segment keeps its checkout's git state; the model never sees it."""
    setUp, session, rows = l1.WorkLogL1Test.setUp, l1.WorkLogL1Test.session, l1.WorkLogL1Test.rows

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_a_summary_stores_the_git_state_of_its_cwd(self):
        repo = Repo(self)
        tree = repo.worktree("w-secret-branch")
        head = repo.commit(tree, "b.txt", "b\n")
        self.obs.add(l1.T0, "prompt_submit", {"prompt": "请修好 HostLink 断线重连"}, cwd=str(tree))
        self.obs.add(l1.T0 + 3 * l1.MIN, "prompt_submit", {"prompt": "再跑一遍"}, cwd=str(tree))
        self.obs.add(l1.T0 + 5 * l1.MIN, "stop", {"last_assistant_message": "修好了"}, cwd=str(tree))
        self.service.client = l1.Client([l1.summary()])
        self.now = l1.T0 + 30 * l1.MIN
        self.service.tick(self.now)
        [row] = self.rows()
        self.assertEqual(row["body"]["git"], {"root": str(repo.root), "branch": "w-secret-branch", "head": head,
                                              "dirty": 0, "linked": True, "committed_at": repo.time(head)})
        prompt = json.dumps(self.service.client.calls, ensure_ascii=False, default=str)
        self.assertNotIn(head, prompt)
        self.assertNotIn("w-secret-branch", prompt)

    def test_a_cwd_outside_git_stores_no_git_state(self):
        self.session()
        self.service.client = l1.Client([l1.summary()])
        self.now = l1.T0 + 30 * l1.MIN
        self.service.tick(self.now)
        [row] = self.rows()
        self.assertNotIn("git", row["body"])

if __name__ == "__main__":
    unittest.main()
