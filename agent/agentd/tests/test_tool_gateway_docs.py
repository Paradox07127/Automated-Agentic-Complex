from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tool_gateway import desktop  # noqa: E402
from tool_gateway.policy import METHODS, MIRRORS, POLICY, REVOKE_ON, WINDOWS  # noqa: E402
from tool_gateway.registry import BUILTIN  # noqa: E402

DOC = Path(__file__).resolve().parents[3] / "docs" / "architecture" / "tool-gateway.md"
# Durations the doc may name besides POLICY.window(...) and MIRRORS.
DESKTOP = {"IDLE_RELEASE": desktop.IDLE_RELEASE, "ACQUIRE_WAIT": desktop.ACQUIRE_WAIT}


def table(heading):
    """Body rows of the first Markdown table under the heading, cells stripped of backticks."""
    lines = DOC.read_text(encoding="utf-8").splitlines()
    start = lines.index(heading)
    rows = []
    for line in lines[start + 1:]:
        if line.startswith("|"):
            rows.append([cell.strip().replace("`", "") for cell in line.strip().strip("|").split("|")])
        elif rows:
            break
    return rows[2:]  # header and separator


def names(cell):
    return {name.strip() for name in cell.split(",") if name.strip()}


class ToolGatewayDocsTest(unittest.TestCase):
    def test_every_method_has_a_row(self):
        documented = [row[0] for row in table("## 方法")]
        self.assertEqual(sorted(documented), sorted(METHODS))

    def test_every_documented_window_equals_the_code(self):
        rows = {row[0]: float(row[1]) for row in table("## 时长")}
        self.assertTrue(set(WINDOWS) | set(MIRRORS) | set(DESKTOP) <= set(rows))
        for name, value in rows.items():
            if name in WINDOWS:
                self.assertEqual(value, POLICY.window(name), name)
            elif name in MIRRORS:
                self.assertEqual(value, MIRRORS[name], name)
            else:
                self.assertEqual(value, DESKTOP[name], name)

    def test_revocation_matches_revoke_on(self):
        rows = {row[0]: names(row[1]) for row in table("## 撤销")}
        self.assertEqual(rows, {method: set(reasons) for method, reasons in REVOKE_ON.items()})
        released = {row[0] for row in table("### 释放与取消") if row[1] == "desktop_release"}
        self.assertEqual(released, set(desktop.RELEASE_REASONS))

    def test_every_registry_family_has_its_tools(self):
        rows = {row[0]: row for row in table("## 注册表")}
        families = {spec.family for spec in BUILTIN.values()}
        self.assertEqual(set(rows), families)
        for family, row in rows.items():
            specs = [spec for spec in BUILTIN.values() if spec.family == family]
            self.assertEqual(names(row[1]), {spec.name for spec in specs}, family)
            self.assertEqual(names(row[2]), {spec.grant for spec in specs}, family)
            self.assertEqual(names(row[3]), set().union(*(spec.callers for spec in specs)), family)

    def test_every_path_names_a_method(self):
        for row in table("## 路径"):
            self.assertTrue(names(row[3]) <= set(METHODS), row[0])


if __name__ == "__main__":
    unittest.main()
