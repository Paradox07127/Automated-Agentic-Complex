"""Fails when the test code of a host that should consume a shared protocol example directory never refers to it.

Usage: fixture_consumers.py [<repo>]
A test file refers to protocol/<contract>/<dir> when <dir> follows <contract> after at most 8 separator characters
("C1-agent-events/fixtures", "C1-agent-events" / "fixtures"), or when it names <contract> and holds the string
literal "<dir>" (C12 / 'examples'). A pair in KNOWN_GAPS passes; without the renderer sources (a public checkout) the
pairs of a host whose test code is all in them are skipped. Prints each missing pair, then FIXTURE-CONSUMERS PASS or FAIL;
exits 1 on a missing pair.
"""
import re
import sys
from pathlib import Path

# Host: the globs of its test code, relative to the repo; a directory stands for every file under it.
HOSTS = {
    'mac-renderer': ['private/renderer/host/Tests', 'private/renderer/runtime/Tests', 'private/renderer-tests'],
    'efw': ['private/renderer/windows/tests', 'private/renderer/windows/tools', 'private/renderer/windows/src/selftest_*.cpp'],
    'core': ['private/renderer/core/tests'],
    'agentd': ['agent/agentd/tests'],
    'electron': ['app/electron/test'],
    'helper-mac': ['app/helpers/mac/Tests'],
    'helper-win': ['app/helpers/windows/tests'],
}
# Shared example directory: the hosts that should consume it (both ends of its contract).
CONSUMERS = {
    'protocol/C1-agent-events/fixtures': ['agentd', 'mac-renderer', 'efw', 'core'],
    'protocol/C2-speech-stream/examples': ['agentd', 'mac-renderer', 'efw'],
    'protocol/C3-host-ipc/examples': ['electron', 'mac-renderer', 'efw'],
    'protocol/C6-agentd-api/fixtures': ['agentd', 'electron'],
    'protocol/C8-harness-runner/examples': ['agentd'],
    'protocol/C9-agentd-process/examples': ['agentd', 'electron'],
    'protocol/C10-shared-files/examples': ['agentd', 'electron'],
    'protocol/C11-components/examples': ['electron'],
    'protocol/C12-platform-helper/examples': ['electron', 'helper-mac', 'helper-win'],
    'protocol/character-library/fixtures': ['agentd', 'electron', 'mac-renderer', 'efw'],
}
# Pairs not consumed today; remove one as soon as its host consumes the directory.
KNOWN_GAPS = {
    ('protocol/C2-speech-stream/examples', 'agentd'): 'its tests check the C2 lines agentd writes with validate.py, not against the examples',
    ('protocol/C12-platform-helper/examples', 'electron'): 'the helper tests drive a fake helper in Node with their own lines',
    ('protocol/C12-platform-helper/examples', 'helper-mac'):
        'Tests/replay.py replays them through the C12 path it imports from app/helpers/windows/tests/replay.py',
    ('protocol/character-library/fixtures', 'efw'): 'its tests load built character packages, not the library fixtures',
}
CODE = {'.py', '.swift', '.ts', '.mts', '.mjs', '.js', '.cpp', '.cc', '.c', '.h', '.hpp', '.m', '.mm', '.sh', '.bat', '.ps1'}
SKIP_DIRS = {'.build', 'build', 'node_modules', '__pycache__', 'third_party'}


def test_files(root, host):
    for pattern in HOSTS[host]:
        for match in sorted(root.glob(pattern)):
            for path in sorted(match.rglob('*')) if match.is_dir() else [match]:
                if path.suffix in CODE and path.is_file() and not SKIP_DIRS & set(path.relative_to(root).parts):
                    yield path


def refers(text, directory):
    contract, sub = directory.split('/')[1:]
    return (re.search(rf'{re.escape(contract)}\W{{1,8}}{re.escape(sub)}\b', text) is not None
            or (contract in text and re.search(rf'''(['"]){re.escape(sub)}\1''', text) is not None))


def check(root):
    """(missing pairs, known gaps a host now consumes, number of skipped pairs)."""
    root = Path(root)
    public = not (root / 'private').is_dir()
    missing, stale, skipped = [], [], 0
    for directory, hosts in CONSUMERS.items():
        for host in hosts:
            if public and all(p.startswith('private/renderer') for p in HOSTS[host]):
                skipped += 1
                continue
            found = any(refers(p.read_text(encoding='utf-8', errors='replace'), directory) for p in test_files(root, host))
            if not found and (directory, host) not in KNOWN_GAPS:
                missing.append((directory, host))
            if found and (directory, host) in KNOWN_GAPS:
                stale.append((directory, host))
    return missing, stale, skipped


def main(argv):
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parents[2]
    missing, stale, skipped = check(root)
    for directory, host in missing:
        print(f'{directory}: no test of {host} ({", ".join(HOSTS[host])}) refers to it')
    for directory, host in stale:
        print(f'{directory}: {host} consumes it now; remove the pair from KNOWN_GAPS')
    pairs = sum(len(hosts) for hosts in CONSUMERS.values())
    print(f'FIXTURE-CONSUMERS {"FAIL" if missing else "PASS"}: {pairs} pairs, {len(missing)} missing, '
          f'{len(KNOWN_GAPS)} known gaps, {skipped} skipped without the renderer sources')
    return 1 if missing else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
