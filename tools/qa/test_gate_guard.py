"""gate_guard.py exit codes for the commands it blocks and the ones it lets through."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

GUARD = Path(__file__).resolve().parent / 'gate_guard.py'

BLOCKED = [
    'python3 -I tools/qa/gate.py --profile commit --checkout .',
    'python3 -I tools/qa/gate.py --profile=release',
    'cd /x && python3 -I /x/tools/qa/gate.py --checkout /x --profile mac',
    'timeout 900 python3 -I tools/qa/gate.py --profile host --only a',
    'bash app/Tests/gate.sh',
    'tools/platform/gpu-lock.sh gate bash app/Tests/gate.sh',
    './tools/qa/mac_gate.sh --fast',
    'bash app/build_app.sh --layout split',
    'app/build_app.sh',
    'bash app/build_app.sh --development',
    'bash app/package_release.sh --layout split',
    'agent/.venv/bin/python -I tools/release/release.py --check',
    'echo start; python3 "$CLAUDE_PROJECT_DIR/tools/qa/gate.py" --profile commit',
    "bash <<'EOF'\nbash app/build_app.sh\nEOF",
    "cat > notes.txt <<EOF\nhi\nEOF\nbash app/build_app.sh",
    '(cd app && bash build_app.sh)',
]

ALLOWED = [
    'python3 -I tools/qa/gate.py --profile dev --checkout . --changed main',
    'python3 -I tools/qa/gate.py --profile agentd',
    'python3 -I tools/qa/gate.py --profile=web',
    'python3 -I tools/qa/gate.py --profile public',
    'python3 -I tools/qa/gate.py --list',
    'python3 -I tools/qa/gate_daemon.py release',
    'python3 -I tools/qa/gate_daemon.py pack',
    'cat app/build_app.sh',
    'grep -n profile tools/qa/gate.py',
    'git status',
    "cat > t.py <<'EOF'\nself.write('app/build_app.sh', 'echo')\n(bash app/build_app.sh)\nEOF\npython3 t.py",
    "git commit -q -F - <<'EOF'\nRun bash app/build_app.sh only through the runner\nEOF",
    "python3 - <<'EOF'\nBLOCKED = [\n    'echo start; python3 \"tools/qa/gate.py\" --profile commit',\n]\nEOF",
    '',
]


def guard(command):
    return subprocess.run([sys.executable, '-I', str(GUARD)], input=json.dumps(dict(tool_input=dict(command=command))),
                          capture_output=True, text=True)


class GateGuardTest(unittest.TestCase):
    def test_blocked_commands_exit_2_with_one_line_naming_the_daemon(self):
        for command in BLOCKED:
            with self.subTest(command=command):
                result = guard(command)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(len(result.stderr.strip().splitlines()), 1)
                self.assertIn('tools/qa/gate_daemon.py', result.stderr)

    def test_allowed_commands_exit_0_silently(self):
        for command in ALLOWED:
            with self.subTest(command=command):
                result = guard(command)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))


if __name__ == '__main__':
    unittest.main()
