"""Text I/O in agent/ and protocol/ names its encoding: on Windows the default is the ANSI code page, not UTF-8.

The suites run with -X warn_default_encoding -W error::EncodingWarning, which only sees the test process; this
static pass also covers code that only runs in child processes (runners, MCP bridges, drive.py)."""
import ast
import os
from pathlib import Path
import re
import unittest

REPO = Path(__file__).resolve().parents[3]
SUBPROCESS_TEXT = {"run", "Popen", "check_output", "check_call", "call"}
# x.open(mode) is taken as Path.open unless x is self or one of these modules, whose open is not a text open.
NOT_TEXT_OPEN = {"self", "os", "webbrowser", "tarfile", "zipfile", "gzip", "sqlite3"}
MODE = re.compile(r"[rwxa+t]{1,3}")


def argument(call, index, name):
    return next((k.value for k in call.keywords if k.arg == name), call.args[index] if len(call.args) > index else None)


def text_mode(node, default):
    if node is None:
        return default
    return isinstance(node, ast.Constant) and isinstance(node.value, str) and bool(MODE.fullmatch(node.value))


def default_encoding(call):
    """True when call opens text without naming an encoding."""
    if any(k.arg in ("encoding", None) for k in call.keywords):
        return False
    func = call.func
    if isinstance(func, ast.Name):
        return func.id == "open" and len(call.args) < 4 and text_mode(argument(call, 1, "mode"), True)
    if not isinstance(func, ast.Attribute):
        return False
    owner = func.value.id if isinstance(func.value, ast.Name) else None
    if func.attr == "open" and owner not in NOT_TEXT_OPEN:
        return len(call.args) < 3 and text_mode(argument(call, 0, "mode"), True)
    if func.attr == "read_text":
        return not call.args
    if func.attr == "write_text":
        return len(call.args) < 2
    if func.attr == "fdopen" and owner == "os":
        return len(call.args) < 4 and text_mode(argument(call, 1, "mode"), True)
    if func.attr == "TextIOWrapper":
        return len(call.args) < 2
    if func.attr in ("NamedTemporaryFile", "TemporaryFile") and owner == "tempfile":
        return text_mode(argument(call, 0, "mode"), False)
    if func.attr in SUBPROCESS_TEXT and owner == "subprocess":
        return any(k.arg in ("text", "universal_newlines") and isinstance(k.value, ast.Constant) and k.value.value
                   for k in call.keywords)
    return False


def sources():
    for top in ("agent", "protocol"):
        for directory, subdirs, files in os.walk(REPO / top):
            subdirs[:] = [d for d in subdirs if not d.startswith(".") and d not in ("node_modules", "__pycache__")]
            yield from (Path(directory, name) for name in files if name.endswith(".py"))


class EncodingGuardTest(unittest.TestCase):
    def test_text_io_names_its_encoding(self):
        found = []
        for path in sources():
            tree = ast.parse(path.read_text(encoding="utf-8"), str(path))
            found += [f"{path.relative_to(REPO).as_posix()}:{node.lineno}" for node in ast.walk(tree)
                      if isinstance(node, ast.Call) and default_encoding(node)]
        self.assertFalse(found, "pass encoding='utf-8' (or open in binary mode):\n" + "\n".join(sorted(found)))

    def test_the_check_sees_each_form(self):
        missing = ["open(p)", "open(p, 'a')", "p.read_text()", "p.write_text(s)", "os.fdopen(fd, 'w')",
                   "io.TextIOWrapper(b)", "tempfile.NamedTemporaryFile('w')", "subprocess.run(a, text=True)",
                   "subprocess.check_output(a, universal_newlines=True)"]
        named = ["open(p, 'rb')", "open(p, encoding='utf-8')", "p.read_text('utf-8')", "p.write_text(s, encoding='utf-8')",
                 "os.fdopen(fd, 'wb')", "tempfile.NamedTemporaryFile()", "subprocess.run(a, capture_output=True)",
                 "subprocess.run(a, text=True, encoding='utf-8')", "open(p, **options)"]
        self.assertEqual([s for s in missing if not default_encoding(ast.parse(s).body[0].value)], [])
        self.assertEqual([s for s in named if default_encoding(ast.parse(s).body[0].value)], [])


if __name__ == "__main__":
    unittest.main()
