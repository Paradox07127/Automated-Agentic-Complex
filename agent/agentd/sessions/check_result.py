"""Structured results of test commands received through live session hooks."""
import re

from sessions.events import command_text, tool_category
from sessions.session_digest import COUNT, EXIT_TEXT, FAIL, TEST_CMD

XCTEST = re.compile(r"Test Case '-\[([^\s]+) ([^\]]+)\]' failed")
PYTEST = re.compile(r"^FAILED[ \t]+(?!\()(\S+)", re.M)
UNITTEST = re.compile(r"^(?:FAIL|ERROR): (\S+) \(([^)]+)\)", re.M)
VITEST = re.compile(r"^\s*FAIL\s+(\S+\.(?:test|spec)\.[^\s]+)\s*>\s*(.+)", re.M)


def parse(tool_name, tool_input, body):
    """The last result's label, exit, counts and at most eight failing test names; None for other tools."""
    command = command_text(tool_input)
    match = TEST_CMD.search(command or '')
    if tool_category(tool_name) != 'command' or match is None:
        return None
    response = body.get('tool_response')
    error = body.get('error')
    if isinstance(error, str):
        text = error
    elif isinstance(response, str):
        text = response
    elif isinstance(response, dict):
        text = '\n'.join(response[k] for k in ('stdout', 'stderr') if isinstance(response.get(k), str))
    else:
        text = ''
    exit_code = body.get('exit_code')
    if isinstance(response, dict):
        exit_code = response.get('exit_code', response.get('exit', exit_code))
    if not isinstance(exit_code, int) or isinstance(exit_code, bool):
        exits = EXIT_TEXT.findall(text)
        exit_code = int(exits[-1]) if exits else None
    if not text and exit_code is None:
        return None
    names, suites = [], []

    def add(name, suite):
        if name not in names:
            names.append(name)
        if suite not in suites:
            suites.append(suite)

    for owner, name in XCTEST.findall(text):
        add(f'{owner}.{name}', owner.rsplit('.', 1)[-1])
    for name in PYTEST.findall(text):
        parts = name.split('::')
        add(name, parts[-2] if len(parts) > 2 else parts[0].rsplit('/', 1)[-1])
    for name, owner in UNITTEST.findall(text):
        parts = owner.split('.')
        add(owner, parts[-2] if len(parts) > 1 else owner)
    for path, name in VITEST.findall(text):
        add(f'{path} > {name.strip()}', name.split(' > ')[0].strip())
    counts = [line for line in text.splitlines() if COUNT.search(line)]
    failed, total = None, None
    for line in counts:
        executed = re.search(r'(?:Executed|Ran) (\d+) tests?', line)
        if executed:
            total = int(executed[1])
        failures = re.search(r'with (\d+) failures?', line)
        if failures:
            failed = int(failures[1])
        unit = re.search(r'FAILED \(([^)]+)\)', line)
        if unit:
            failed = sum(int(n) for n in re.findall(r'(?:failures|errors)=(\d+)', unit[1]))
        results = re.findall(r'(\d+) (failed|passed|skipped|deselected|xfailed|xpassed|error[s]?)\b', line)
        if results:
            failed = sum(int(n) for n, kind in results if kind in ('failed', 'error', 'errors'))
            total = sum(int(n) for n, kind in results if kind != 'deselected')
    if failed is None and names:
        failed = len(names)
    if failed is None and exit_code == 0 and not FAIL.search(text):
        failed = 0
    return {'label': match[0], 'exit': exit_code, 'failed': failed, 'total': total,
            'names': names[:8], 'suites': suites}
