"""Fails on tracked paths that break a Windows checkout, on a missing .gitattributes eol rule, and on the Electron
shell's layer rules: app/electron/src/common/ imports neither electron nor node:*, and only src/main/platform/ reads
process.platform; and on agentd source files outside infra/platform/ that test the operating system more often than
AGENTD_PLATFORM_LIMITS allows. The layer and agentd rules read working-tree files, including non-ignored untracked
sources."""
import re
import subprocess
import sys
from pathlib import Path

MAX_PATH = 200
RESERVED = {'CON', 'PRN', 'AUX', 'NUL'} | {f'COM{i}' for i in range(1, 10)} | {f'LPT{i}' for i in range(1, 10)}
ILLEGAL = re.compile(r'[<>:"|?*\x00-\x1f]')
ELECTRON_SRC = 'app/electron/src/'
ELECTRON_COMMON = ELECTRON_SRC + 'common/'
ELECTRON_PLATFORM = ELECTRON_SRC + 'main/platform/'
# `from 'x'`, `import 'x'`, `import('x')` and `require('x')` of electron, electron/<sub> or node:<name>.
SHELL_IMPORT = re.compile(r'''(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*['"](electron(?:/[^'"]*)?|node:[^'"]+)['"]''')
PLATFORM_READ = re.compile(r'\bprocess\.platform\b')
AGENTD = 'agent/agentd/'
AGENTD_PLATFORM = AGENTD + 'infra/platform/'
OS_TEST = re.compile(r'\bsys\.platform\b|\bos\.name\b|\bplatform\.system\(\)')
# Operating-system tests per agentd source file outside infra/platform/; lower a limit when a test goes, never raise one.
AGENTD_PLATFORM_LIMITS = {
    'agent/agentd/character_agent/harness/pi_config.py': 2,
    'agent/agentd/character_agent/harness/profile_cleanup.py': 2,
    'agent/agentd/character_agent/services/kernel_login.py': 1,
    'agent/agentd/codex_hook_forward.py': 2,
    'agent/agentd/infra/paths.py': 2,
    'agent/agentd/infra/secrets.py': 2,
    'agent/agentd/motion_tool.py': 1,
    'agent/agentd/resource_store.py': 2,
    'agent/agentd/tool_gateway/computer_use.py': 3,
    'agent/agentd/tools/install_hooks.py': 1,
}


def ls_files(root, *args):
    out = subprocess.run(['git', 'ls-files', '-z', *args], cwd=root, capture_output=True, check=True).stdout
    return [p.decode('utf-8', 'surrogateescape') for p in out.split(b'\0') if p]


def layer_violations(root):
    found = []
    for path in sorted(set(ls_files(root, '-c', '-o', '--exclude-standard', '--', ELECTRON_SRC))):
        source = root / path
        if not source.is_file():
            continue
        text = source.read_text(encoding='utf-8', errors='replace')
        if path.startswith(ELECTRON_COMMON):
            found += [(path, f"src/common imports '{m.group(1)}'") for m in SHELL_IMPORT.finditer(text)]
        if not path.startswith(ELECTRON_PLATFORM) and PLATFORM_READ.search(text):
            found.append((path, 'reads process.platform outside src/main/platform/'))
    return found


def agentd_platform_violations(root):
    found = []
    for path in sorted(set(ls_files(root, '-c', '-o', '--exclude-standard', '--', AGENTD))):
        name = path.rsplit('/', 1)[-1]
        if (not path.endswith('.py') or path.startswith(AGENTD_PLATFORM) or '/tests/' in path
                or name.startswith('test_') or not (root / path).is_file()):
            continue
        count = len(OS_TEST.findall((root / path).read_text(encoding='utf-8', errors='replace')))
        limit = AGENTD_PLATFORM_LIMITS.get(path, 0)
        if count > limit:
            found.append((path, f'{count} operating-system tests (sys.platform, os.name, platform.system()), limit '
                                f'{limit}; use agent/agentd/infra/platform/ instead'))
    return found


def violations(root):
    root = Path(root)
    found = []
    seen = {}
    for path in ls_files(root):
        seen.setdefault(path.lower(), []).append(path)
        if len(path) > MAX_PATH:
            found.append((path, f'path longer than {MAX_PATH} characters ({len(path)})'))
        if ILLEGAL.search(path):
            found.append((path, 'character illegal on Windows'))
        for part in path.split('/'):
            if part.split('.')[0].upper() in RESERVED:
                found.append((path, f'Windows reserved name {part}'))
            if part.endswith('.') or part.endswith(' '):
                found.append((path, f'trailing dot or space in {part}'))
    for group in seen.values():
        if len(group) > 1:
            for path in group:
                found.append((path, 'differs only by case from ' + ', '.join(p for p in group if p != path)))
    found += layer_violations(root)
    found += agentd_platform_violations(root)
    attrs = root / '.gitattributes'
    if not attrs.is_file():
        found.append(('.gitattributes', 'missing'))
    elif not re.search(r'\beol=(lf|crlf)\b', attrs.read_text(encoding='utf-8')):
        found.append(('.gitattributes', 'no eol rule'))
    return found


def main(argv):
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parents[2]
    found = violations(root)
    for path, reason in found:
        print(f'{path}: {reason}')
    print(f'XPLAT-GUARD {"FAIL" if found else "PASS"}: {len(found)} violations')
    return 1 if found else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
