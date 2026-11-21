#!/usr/bin/env python3
"""Claude Code PreToolUse hook for Bash: blocks commit/release/mac/host gate runs and packaging in sessions.

Those run only through tools/qa/gate_daemon.py (one runner for main, packs from the green commit). Reads the hook
JSON on stdin; exits 2 with one line on stderr for a blocked command, else 0 silently.
"""
import json
import re
import sys

# A script runs when its path starts a command (after ; & | ( or env assignments) or follows an interpreter.
INTERPRETER = r'(?:\S*/)?(?:bash|sh|zsh|python3?(?:\.\d+)?|exec)\s+(?:-\S+\s+)*'
RUNS = (r'(?:(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*(?:' + INTERPRETER + r')?|(?:^|\s)' + INTERPRETER + r')'
        r'["\']?(?:\S*/)?{script}(?=$|[\s"\';&|)])')
# A heredoc body is data (a file, a commit message, a Python script) unless the command it feeds is a shell.
HEREDOC = re.compile(r'^([^\n]*?)<<-?\s*([\'"]?)(\w+)\2([^\n]*\n).*?^\s*\3[ \t]*$', re.M | re.S)
SHELL = re.compile(r'(?:^|[\s;&|(/])(?:bash|sh|zsh)(?=\s|$)')
DAEMON = 'python3 -I tools/qa/gate_daemon.py'
RULES = [
    (re.compile(RUNS.format(script=r'gate\.py')), re.compile(r'--profile(?:=|\s+)["\']?(?:commit|release|mac|host)\b'),
     f'commit/release/mac/host 门禁只由执行器跑：合入 main 后用 `{DAEMON} ensure` 和 `{DAEMON} status` 看结果，发包或阶段收尾用 `{DAEMON} release`'),
    (re.compile(RUNS.format(script=r'Tests/gate\.sh')), None,
     f'app/Tests/gate.sh 只由执行器跑：用 `{DAEMON} ensure` 和 `{DAEMON} status`'),
    (re.compile(RUNS.format(script=r'mac_gate\.sh')), None,
     f'mac_gate.sh 只由执行器跑：用 `{DAEMON} ensure` 和 `{DAEMON} status`'),
    (re.compile(RUNS.format(script=r'(?:build_app|package_release)\.sh')), None,
     f'打包只取最近一次全绿的提交：用 `{DAEMON} pack`'),
    (re.compile(RUNS.format(script=r'release/release\.py')), None,
     f'打包只取最近一次全绿的提交：用 `{DAEMON} pack`'),
]


def main():
    command = (json.load(sys.stdin).get('tool_input') or {}).get('command') or ''
    command = HEREDOC.sub(lambda m: m[0] if SHELL.search(m[1]) else m[1] + m[4], command)
    for runs, also, message in RULES:
        if not runs.search(command) or (also and not also.search(command)):
            continue
        print(message, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
