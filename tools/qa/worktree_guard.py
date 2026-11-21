#!/usr/bin/env python3
"""Claude Code PreToolUse hook for Edit, Write and NotebookEdit: sessions edit tracked files only in their own worktree.

Blocks (exit 2, one line on stderr) a file in the main checkout that git does not ignore; a linked worktree, an ignored
path (notes/, .local/) and a path outside the repository pass. Reads the hook JSON on stdin.
"""
import json
from pathlib import Path
import subprocess
import sys


def git(cwd, *args):
    return subprocess.run(['git', '-C', str(cwd), *args], capture_output=True, text=True)


def main():
    tool_input = json.load(sys.stdin).get('tool_input') or {}
    path = tool_input.get('file_path') or tool_input.get('notebook_path')
    if not path:
        return 0
    target = Path(path).resolve()
    folder = next((p for p in [target, *target.parents] if p.is_dir()), None)
    if folder is None:
        return 0
    top = git(folder, 'rev-parse', '--show-toplevel').stdout.strip()
    common = git(folder, 'rev-parse', '--path-format=absolute', '--git-common-dir').stdout.strip()
    # Only the main checkout's own top level is guarded; in a linked worktree the top level is the worktree.
    if not top or not common or Path(top).resolve() != Path(common).parent.resolve():
        return 0
    if git(top, 'check-ignore', '-q', '--no-index', str(target)).returncode == 0:
        return 0
    print(f'{target} 在共用的主检出里。先用 EnterWorktree 进自己的工作树再改；合入 main 用快进合并（见 /ship）。', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main())
