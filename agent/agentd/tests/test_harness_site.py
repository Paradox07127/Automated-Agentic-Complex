"""The harness.pi site reaches the Pi session and availability; Codex is local only."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

AGENTD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENTD))

from character_agent.harness.discovery import DiscoveryService
from character_agent.harness.pi_config import resolve_pi_runtime
from character_agent.harness.registry import HARNESSES
from character_agent.integration import CharacterAgentController
from character_agent.services.settings import RuntimeSettings
from daemon.main import parse_args
from support import enable_plugins

PI_PACKAGE = "pi-runtime/node_modules/@earendil-works/pi-coding-agent/package.json"
# The official Node zip keeps node.exe at its root; the macOS tarball keeps bin/node.
NODE = "node/node.exe" if sys.platform == "win32" else "node/bin/node"


def pi_site(root):
    site = root / "pi site"
    node = site / NODE
    node.parent.mkdir(parents=True); node.write_text("#!/bin/sh\n", encoding="utf-8"); node.chmod(0o700)
    package = site / PI_PACKAGE
    package.parent.mkdir(parents=True); package.write_text("{}", encoding="utf-8")
    return site


class HarnessSiteArgumentsTests(unittest.TestCase):
    def test_valid_pair_is_kept_and_default_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            site = Path(tmp) / "pi=site"; site.mkdir()
            args = parse_args(["--character", "aster", "--harness-site", f"harness.pi={site}"])
            self.assertEqual(args.harness_sites, {"harness.pi": str(site)})
            self.assertEqual(parse_args(["--character", "aster"]).harness_sites, {})

    def test_invalid_pairs_are_argument_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "file"; file.touch()
            cases = [([f"unknown={tmp}"], "unknown harness component"),
                     ([f"harness.claude={tmp}"], "unknown harness component"),
                     ([f"harness.codex={tmp}"], "unknown harness component"),
                     (["harness.pi=relative"], "absolute directory"),
                     ([f"harness.pi={tmp}", f"harness.pi={tmp}"], "duplicate harness component"),
                     ([f"harness.pi={tmp}/missing"], "directory does not exist"),
                     ([f"harness.pi={file}"], "directory does not exist"),
                     (["harness.pi"], "expected ID=DIR"),
                     (["harness.pi="], "absolute directory")]
            for pairs, reason in cases:
                with self.subTest(pairs=pairs):
                    stderr = io.StringIO()
                    argv = [arg for pair in pairs for arg in ("--harness-site", pair)]
                    with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
                        parse_args(["--character", "aster", *argv])
                    self.assertEqual(raised.exception.code, 2)
                    self.assertIn(reason, stderr.getvalue())


class CodexRunnerLocalOnlyTests(unittest.TestCase):
    def test_codex_runner_without_local_cli_fails_instead_of_a_bundled_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            message = {"v": 1, "type": "init", "system_prompt": "Fixture", "tools": [],
                       "config": {"state_dir": tmp, "model": "fixture"}}
            done = subprocess.run([sys.executable, "-I", "-S", "-B", str(AGENTD / "character_agent/harness/codex_runner.py")],
                                  input=json.dumps(message) + "\n", capture_output=True, text=True, timeout=10, encoding="utf-8")
            self.assertEqual(done.returncode, 0, done.stderr)
            frames = [json.loads(line) for line in done.stdout.splitlines()]
            self.assertEqual([(f["type"], f["code"]) for f in frames], [("error", "local_cli_path_required")])


class HarnessSiteConfigTests(unittest.TestCase):
    def test_site_resolves_to_its_node_and_pi_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            site = Path(tmp).resolve()
            self.assertEqual(resolve_pi_runtime(str(site)), (str(site / NODE), str(site / "pi-runtime")))

    def test_pi_session_uses_only_the_pi_site(self):
        with tempfile.TemporaryDirectory() as tmp:
            site = pi_site(Path(tmp)).resolve()
            integration = SimpleNamespace(harness_sites={"harness.pi": str(site)},
                                          _pi_connection=lambda config: {"provider": "fixture", "auth_source": "api_key"},
                                          _credential=lambda config: "fixture-key", server=SimpleNamespace(models=None))
            config = {"backend": "pi", "provider": "", "runtime_source": "bundled", "executable": None, "max_budget_usd": 1.0,
                      "pi_tool_approval": True}
            common = {"state_dir": tmp, "model": "fixture", "runtime_source": "bundled", "native_tools": False}
            session = HARNESSES["pi"].session(integration, config, common, [])
            self.assertEqual((session.config.node, session.config.runtime_dir),
                             (str(site / NODE), str(site / "pi-runtime")))

    def controller(self, root, sites, rows):
        controller = CharacterAgentController.__new__(CharacterAgentController)
        controller.session_factory_override = None
        controller.harness_sites = sites
        controller.settings = RuntimeSettings(root)
        controller._auto_chosen = False
        controller.discovery = SimpleNamespace(scan=lambda refresh=False: {"runtimes": rows, "scanned_at": 0})
        # 「pi 账号与凭据」 gives pi a connection, so only a missing site takes pi away.
        controller._pi_route = lambda config: ({"provider": "fixture", "auth_source": "api_key"}, "fixture-key", "fixture")
        return controller

    def test_availability_follows_the_site_and_auto_selection_keeps_pi(self):
        enable_plugins(self, "harness_bridge")  # codex is a harness
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            codex = [{"backend": "codex", "runtime_source": "local_cli", "path": "/fixture/codex",
                      "entry_supported": True, "authenticated": True}]
            controller = self.controller(root, {"harness.pi": str(pi_site(root))}, codex)
            available = {row["id"]: row["available"] for row in controller.available_backends()}
            # acp follows the ACP agents on this machine, not the site.
            self.assertEqual({k: available[k] for k in ("pi", "codex")}, {"pi": True, "codex": True})
            self.assertTrue(controller._auto_select())
            self.assertEqual((controller.settings.snapshot()["backend"], controller.settings.snapshot()["runtime_source"]),
                             ("pi", "bundled"))
            empty = root / "empty"; empty.mkdir()
            self.assertFalse({row["id"]: row["available"] for row in
                              self.controller(root, {"harness.pi": str(empty)}, codex).available_backends()}["pi"])

    def test_without_pi_only_a_logged_in_local_codex_is_auto_selected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); empty = root / "empty"; empty.mkdir()
            row = {"backend": "codex", "runtime_source": "local_cli", "path": "/fixture/codex", "entry_supported": True}
            for authenticated, backend, source in ((True, "codex", "local"), (False, "pi", "bundled")):
                with self.subTest(authenticated=authenticated):
                    controller = self.controller(root, {"harness.pi": str(empty)}, [{**row, "authenticated": authenticated}])
                    controller._auto_select()
                    snapshot = controller.settings.snapshot()
                    self.assertEqual((snapshot["backend"], snapshot["runtime_source"]), (backend, source))

    def test_discovery_lists_local_codex_and_claude_but_no_bundled_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = Path(tmp) / "codex"; cli.write_text("#!/bin/sh\n", encoding="utf-8"); cli.chmod(0o700)
            with patch("pathlib.Path.home", return_value=Path(tmp)), \
                 patch("character_agent.harness.discovery.shutil.which", side_effect=lambda name: str(cli) if name == "codex" else None):
                candidates = DiscoveryService()._local_candidates()
            self.assertEqual({backend for backend, _, _ in candidates}, {"codex", "claude"})
            self.assertEqual({source for _, source, _ in candidates}, {"local_cli", "app_cli"})
            self.assertEqual(candidates[0], ("codex", "local_cli", cli))
            self.assertEqual([path for backend, _, path in candidates if backend == "claude"][0], Path(tmp) / ".local/bin/claude")


if __name__ == "__main__":
    unittest.main()
