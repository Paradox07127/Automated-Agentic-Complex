import ast
import unittest
from pathlib import Path

import support  # noqa: F401

ROOT = Path(__file__).resolve().parents[1]
DOMAIN = ("sessions", "observation", "personal", "character", "voice", "models", "traces", "tool_gateway", "brain",
          "character_agent")
# Packages above the domain layer, and the domain packages themselves: infra/ imports none of them.
UPPER = {"daemon", "api", *DOMAIN}


def imported_packages(package):
    """(file, top-level name) of every import statement under agent/agentd/<package>/, lazy ones included."""
    for path in sorted((ROOT / package).rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                yield from ((path, alias.name.split(".")[0]) for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                yield path, node.module.split(".")[0]


class LayerTest(unittest.TestCase):
    def test_domain_packages_do_not_import_daemon_or_api(self):
        bad = [f"{p.relative_to(ROOT)}: {name}" for package in DOMAIN for p, name in imported_packages(package)
               if name in ("daemon", "api")]
        self.assertEqual(bad, [])

    def test_infra_imports_no_upper_layer(self):
        bad = [f"{p.relative_to(ROOT)}: {name}" for p, name in imported_packages("infra") if name in UPPER]
        self.assertEqual(bad, [])


if __name__ == "__main__":
    unittest.main()
