"""Read-only git state of a work segment's checkout, and whether a commit of it reached the main tree's branch.
Never fetches and never reads file contents."""
import functools
import os
import shutil
import subprocess


@functools.cache
def _available():
    """/usr/bin/git without the Command Line Tools asks the user to install them on every call."""
    if shutil.which("git") != "/usr/bin/git":
        return shutil.which("git") is not None
    try:
        return subprocess.run(["xcode-select", "-p"], capture_output=True, timeout=5).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _git(cwd, *args):
    """(returncode, stdout) of git run in cwd, or None when it could not run."""
    if not _available():
        return None
    try:
        done = subprocess.run(["git", "--no-optional-locks", "-C", cwd, *args], capture_output=True, text=True,
                              timeout=5, encoding="utf-8")
    except (OSError, subprocess.SubprocessError):
        return None
    return done.returncode, done.stdout


def snapshot(cwd):
    """{root: the main tree root, branch: None when detached, head: full sha, dirty: lines of status --porcelain,
    linked: cwd is a linked worktree, committed_at: HEAD's commit time}, or None when cwd is no directory, not in a
    repository with a commit, or git fails."""
    if not cwd or not os.path.isdir(cwd):
        return None
    dirs = _git(cwd, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir")
    status = _git(cwd, "status", "--porcelain=v2", "--branch")
    if dirs is None or status is None or dirs[0] != 0 or status[0] != 0 or len(dirs[1].splitlines()) != 2:
        return None
    git_dir, common = dirs[1].splitlines()
    if os.path.basename(common) != ".git":
        return None
    lines = status[1].splitlines()
    heads = dict(line[2:].split(" ", 1) for line in lines if line.startswith("# branch."))
    if heads["branch.oid"] == "(initial)":  # no commit yet
        return None
    committed = _git(cwd, "log", "-1", "--format=%ct", heads["branch.oid"])
    if committed is None or committed[0] != 0:
        return None
    return {"root": os.path.dirname(common),
            "branch": None if heads["branch.head"] == "(detached)" else heads["branch.head"],
            "head": heads["branch.oid"], "dirty": sum(not line.startswith("#") for line in lines),
            "linked": git_dir != common, "committed_at": int(committed[1].strip())}


def landed(root, sha):
    """Whether sha is in the current branch of the main tree at root, as an ancestor or as patches applied by a
    rebase. False when git fails or sha is unknown; a squash merge is not recognized."""
    ancestor = _git(root, "merge-base", "--is-ancestor", sha, "HEAD")
    if ancestor is None or ancestor[0] not in (0, 1):
        return False
    if ancestor[0] == 0:
        return True
    cherry = _git(root, "cherry", "HEAD", sha)
    lines = cherry[1].splitlines() if cherry is not None and cherry[0] == 0 else []
    return bool(lines) and all(line.startswith("-") for line in lines)
