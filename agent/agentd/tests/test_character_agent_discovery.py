import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.harness.discovery import DiscoveryService, entry_supported, native_status, runtime_version
from character_agent.harness.transport import runner_environment


def codex_cli(tmp):
    cli = Path(tmp) / "codex"; cli.write_text("#!/bin/sh\n", encoding="utf-8"); cli.chmod(0o700)
    return cli


class DiscoveryTests(unittest.TestCase):
    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_login_status_never_exports_account_or_token(self):
        completed = type("Result", (), {"returncode": 0, "stdout": "Logged in using ChatGPT as private@example.com",
                                        "stderr": "token not-for-output"})()
        with patch("character_agent.harness.discovery.subprocess.run", return_value=completed):
            result = native_status("/fixture/codex", "codex")
        self.assertTrue(result["authenticated"])
        self.assertEqual(result["auth_mode"], "existing_login")
        self.assertEqual(result["auth_method"], "chatgpt")
        self.assertNotIn("private", json.dumps(result))
        self.assertNotIn("not-for-output", json.dumps(result))

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_claude_login_status_reads_only_logged_in_and_method(self):
        result = lambda code, value: type("Result", (), {"returncode": code, "stdout": json.dumps(value), "stderr": ""})()
        account = {"loggedIn": True, "authMethod": "claude.ai", "email": "private@example.com", "orgName": "Private Org"}
        with patch("character_agent.harness.discovery.subprocess.run", return_value=result(0, account)) as run:
            self.assertEqual(native_status("/fixture/claude", "claude"),
                             {"authenticated": True, "auth_mode": "existing_login", "auth_method": "claude.ai"})
        # Codex's -c state overrides are not Claude options.
        self.assertEqual(run.call_args.args[0], ["/fixture/claude", "auth", "status", "--json"])
        with patch("character_agent.harness.discovery.subprocess.run",
                   return_value=result(1, {"loggedIn": False, "authMethod": "none"})):
            self.assertEqual(native_status("/fixture/claude", "claude"),
                             {"authenticated": False, "auth_mode": "none", "auth_method": "none"})

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_claude_version_and_stream_json_entry_are_probed(self):
        def run(argv, **_):
            out = "2.1.327 (Claude Code)\n" if argv[-1] == "--version" else \
                "  --input-format <format>  Input format\n  --output-format <format>  Output format\n"
            return type("Result", (), {"returncode": 0, "stdout": out, "stderr": ""})()
        with patch("character_agent.harness.discovery.subprocess.run", side_effect=run) as probe:
            self.assertEqual(runtime_version("/fixture/claude", "claude"), "2.1.327")
            self.assertTrue(entry_supported("/fixture/claude", "claude"))
        self.assertEqual(probe.call_args.args[0][-2:], ["/fixture/claude", "--help"])

    def test_cache_returns_copy_and_refresh_reprobes(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = codex_cli(tmp)
            service = DiscoveryService(candidates=[("codex", "local_cli", cli)])
            with patch("character_agent.harness.discovery.runtime_version", return_value="0.163.0") as version, \
                 patch("character_agent.harness.discovery.entry_supported", return_value=True), \
                 patch("character_agent.harness.discovery.native_status", return_value={"authenticated": True, "auth_mode": "existing_login"}):
                first = service.scan()
                first["runtimes"].clear()
                self.assertEqual(len(service.scan()["runtimes"]), 1)
                self.assertEqual(version.call_count, 1)
                service.scan(refresh=True)
                self.assertEqual(version.call_count, 2)

    def test_concurrent_refreshes_share_one_inspection(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = codex_cli(tmp)
            service = DiscoveryService(candidates=[("codex", "local_cli", cli)])
            inspected, started = [], threading.Event()
            def slow(candidate):
                inspected.append(candidate); started.set(); time.sleep(0.3)
                return {"backend": "codex", "path": str(candidate[2])}
            results = []
            with patch.object(service, "_inspect", side_effect=slow):
                first = threading.Thread(target=lambda: results.append(service.scan(refresh=True)))
                first.start(); started.wait(5)
                second = threading.Thread(target=lambda: results.append(service.scan(refresh=True)))
                second.start(); first.join(5); second.join(5)
                self.assertEqual(len(inspected), 1)
                self.assertEqual(len(results), 2)
                self.assertEqual(results[0], results[1])
                service.scan(refresh=True)
                self.assertEqual(len(inspected), 2)

    def test_expired_cache_answers_at_once_and_rescans_in_the_background(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = codex_cli(tmp)
            now = [0.0]
            service = DiscoveryService(cache_seconds=30, candidates=[("codex", "local_cli", cli)], clock=lambda: now[0])
            inspected, release = [], threading.Event()
            def inspect(candidate):
                inspected.append(candidate)
                if len(inspected) > 1: release.wait(5)
                return {"backend": "codex", "path": str(candidate[2]), "n": len(inspected)}
            with patch.object(service, "_inspect", side_effect=inspect):
                service.scan()
                now[0] = 601.0
                started = time.monotonic()
                stale = service.scan()
                self.assertLess(time.monotonic() - started, 0.5)
                self.assertEqual(stale["runtimes"][0]["n"], 1)
                service.scan()
                release.set()
                for _ in range(100):
                    if service.scan()["runtimes"][0]["n"] == 2: break
                    time.sleep(0.02)
                self.assertEqual(len(inspected), 2)
                self.assertEqual(service.scan()["runtimes"][0]["n"], 2)

    def test_a_scan_outlives_thirty_seconds_and_only_the_login_is_probed_again(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = codex_cli(tmp)
            now = [0.0]
            service = DiscoveryService(candidates=[("codex", "local_cli", cli)], clock=lambda: now[0])
            logins = [{"authenticated": False, "auth_mode": "none", "auth_method": "unknown", "auth_error": "status_unavailable"},
                      {"authenticated": True, "auth_mode": "existing_login", "auth_method": "chatgpt"}]

            def settled():
                for _ in range(250):
                    if service._background is None: return
                    time.sleep(0.02)
                self.fail("background scan did not finish")
            with patch("character_agent.harness.discovery.runtime_version", return_value="0.163.0") as version, \
                 patch("character_agent.harness.discovery.entry_supported", return_value=True) as entry, \
                 patch("character_agent.harness.discovery.native_status", side_effect=lambda *_: logins[min(status.call_count, 2) - 1]) as status:
                self.assertFalse(service.scan()["runtimes"][0]["authenticated"])
                now[0] = 31.0
                service.scan(); settled()
                [row] = service.scan()["runtimes"]
                self.assertEqual((version.call_count, entry.call_count, status.call_count), (1, 1, 2))
                self.assertEqual((row["authenticated"], row["auth_method"], row["version"]), (True, "chatgpt", "0.163.0"))
                self.assertNotIn("auth_error", row)
                now[0] = 59.0
                service.scan(); settled()
                self.assertEqual(status.call_count, 2)  # the refreshed login is good for another 30 s
                now[0] = 599.0
                service.scan(); settled()
                self.assertEqual((version.call_count, status.call_count), (1, 3))
                cli.write_text("#!/bin/sh\n# updated\n", encoding="utf-8")
                service.scan(); settled()
                self.assertEqual((version.call_count, entry.call_count), (2, 2))
                now[0] = 599.0 + 600
                service.scan(); settled()
                self.assertEqual(version.call_count, 3)

    def test_saved_scan_answers_a_new_service_without_probing(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = codex_cli(tmp)
            saved = Path(tmp) / "runtime-discovery.json"
            make = lambda: DiscoveryService(candidates=[("codex", "local_cli", cli)], clock=lambda: 0.0, path=saved)
            inspected = []
            def inspect(candidate):
                inspected.append(candidate)
                return {"backend": "codex", "runtime_source": "local_cli", "path": str(candidate[2])}
            with patch.object(DiscoveryService, "_inspect", side_effect=inspect):
                first = make().scan()
                self.assertEqual(len(inspected), 1)
                service = make()
                self.assertEqual(service.scan(), first)
                self.assertEqual(len(inspected), 1)
                self.assertIsNone(service._background)

    def test_saved_scan_with_retired_runtimes_is_not_reused(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = codex_cli(tmp)
            saved = Path(tmp) / "runtime-discovery.json"
            for row in ({"backend": "claude_agent_sdk", "runtime_source": "local_cli", "path": str(cli)},
                        {"backend": "claude", "runtime_source": "bundled", "path": str(cli)},
                        {"backend": "codex", "runtime_source": "bundled", "path": str(cli)}):
                with self.subTest(row=row):
                    saved.write_text(json.dumps({"runtimes": [row], "identities": [None], "scanned_at": 0}), encoding="utf-8")
                    self.assertIsNone(DiscoveryService(path=saved)._cached)

    def test_changed_identity_answers_from_cache_and_probes_in_the_background(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = codex_cli(tmp)
            service = DiscoveryService(candidates=[("codex", "local_cli", cli)], clock=lambda: 0.0)
            threads, inspected, release = [], [], threading.Event()
            def inspect(candidate):
                inspected.append(candidate)
                if len(inspected) > 1: release.wait(5)
                return {"backend": "codex", "path": str(candidate[2]), "n": len(inspected)}
            # The scanning thread itself lists the candidates; the probes run in its worker pool.
            listed = lambda: threads.append(threading.current_thread()) or [("codex", "local_cli", cli)]
            with patch.object(service, "_local_candidates", side_effect=listed), patch.object(service, "_inspect", side_effect=inspect):
                service.scan()
                cli.write_text("#!/bin/sh\n# updated\n", encoding="utf-8")
                started = time.monotonic()
                self.assertEqual(service.scan()["runtimes"][0]["n"], 1)
                self.assertEqual(service.scan()["runtimes"][0]["n"], 1)
                self.assertLess(time.monotonic() - started, 0.5)
                release.set()
                for _ in range(100):
                    if service.scan()["runtimes"][0]["n"] == 2: break
                    time.sleep(0.02)
                self.assertEqual(len(inspected), 2)
                self.assertIsNot(threads[1], threading.current_thread())

    def test_concurrent_first_scans_probe_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = codex_cli(tmp)
            service = DiscoveryService(candidates=[("codex", "local_cli", cli)], clock=lambda: 0.0)
            inspected, started = [], threading.Event()
            def slow(candidate):
                inspected.append(candidate); started.set(); time.sleep(0.3)
                return {"backend": "codex", "path": str(candidate[2])}
            results = []
            with patch.object(service, "_inspect", side_effect=slow):
                first = threading.Thread(target=lambda: results.append(service.scan()))
                first.start(); started.wait(5)
                second = threading.Thread(target=lambda: results.append(service.scan()))
                second.start(); first.join(5); second.join(5)
                self.assertEqual(len(inspected), 1)
                self.assertEqual(len(results), 2)
                self.assertEqual(results[0], results[1])

    def test_a_scan_during_the_startup_scan_waits_for_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = codex_cli(tmp)
            service = DiscoveryService(candidates=[("codex", "local_cli", cli)], clock=lambda: 0.0)
            inspected = []
            def slow(candidate):
                inspected.append(candidate); time.sleep(0.3)
                return {"backend": "codex", "path": str(candidate[2])}
            with patch.object(service, "_inspect", side_effect=slow):
                service.warm()
                self.assertEqual(len(service.scan()["runtimes"]), 1)
                self.assertEqual(len(inspected), 1)

    def test_refresh_probes_on_the_callers_thread(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = codex_cli(tmp)
            service = DiscoveryService(candidates=[("codex", "local_cli", cli)], clock=lambda: 0.0,
                                       path=Path(tmp) / "runtime-discovery.json")
            threads, inspected = [], []
            def inspect(candidate):
                inspected.append(candidate)
                return {"backend": "codex", "path": str(candidate[2]), "n": len(inspected)}
            listed = lambda: threads.append(threading.current_thread()) or [("codex", "local_cli", cli)]
            with patch.object(service, "_local_candidates", side_effect=listed), patch.object(service, "_inspect", side_effect=inspect):
                service.scan()
                self.assertEqual(service.scan(refresh=True)["runtimes"][0]["n"], 2)
                self.assertEqual(threads, [threading.current_thread()] * 2)

    def test_missing_protocol_entry_is_discovered_but_not_enabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = codex_cli(tmp)
            service = DiscoveryService(candidates=[("codex", "app_cli", cli)])
            with patch("character_agent.harness.discovery.runtime_version", return_value="0.999.0-alpha.1"), \
                 patch("character_agent.harness.discovery.native_status", return_value={"authenticated": True, "auth_mode": "existing_login"}):
                entry = service.scan()["runtimes"][0]
            self.assertFalse(entry["entry_supported"])
            self.assertFalse(entry["boundary_verified"])

    def test_existing_login_preserves_native_profiles_and_the_users_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"CODEX_HOME": "/native-profile", "OPENAI_API_KEY": "wrong-account",
                                         "CLAUDE_CONFIG_DIR": "/claude-profile"}):
                env = runner_environment(tmp, auth_mode="existing_login")
                api_key_env = runner_environment(tmp)
            self.assertEqual((env["CODEX_HOME"], env["CLAUDE_CONFIG_DIR"]), ("/native-profile", "/claude-profile"))
            self.assertEqual(env["OPENAI_API_KEY"], "wrong-account")
            self.assertFalse({"CODEX_HOME", "CLAUDE_CONFIG_DIR"} & set(api_key_env))
            self.assertFalse(Path("/native-profile").exists())

    def test_native_keychain_login_names_survive_environment_isolation(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"USER": "fixture-user", "LOGNAME": "fixture-user"}):
            env = runner_environment(tmp, auth_mode="existing_login")
            self.assertEqual(env["USER"], "fixture-user")
            self.assertEqual(env["LOGNAME"], "fixture-user")

    def test_future_version_can_run_when_protocol_entry_is_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = codex_cli(tmp)
            service = DiscoveryService(candidates=[("codex", "app_cli", cli)])
            with patch("character_agent.harness.discovery.runtime_version", return_value="0.999.0-alpha.1"), \
                 patch("character_agent.harness.discovery.entry_supported", return_value=True), \
                 patch("character_agent.harness.discovery.native_status", return_value={"authenticated": True}):
                entry = service.scan()["runtimes"][0]
            self.assertTrue(entry["entry_supported"])
            self.assertFalse(entry["boundary_verified"])
            self.assertIsNone(entry['reason'])
            self.assertFalse(entry['compatibility']['version_required'])
            self.assertNotIn('sdk_available', entry)

    def test_explicit_runtime_probe_is_cached_and_binary_updates_invalidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = codex_cli(tmp)
            service=DiscoveryService()
            with patch('character_agent.harness.discovery.runtime_version',return_value='99.0.0') as version, \
                 patch('character_agent.harness.discovery.entry_supported',return_value=True), \
                 patch('character_agent.harness.discovery.native_status',return_value={'authenticated':True}):
                first=service.inspect_runtime(str(cli),'codex')
                first['path']='changed-copy'
                self.assertEqual(service.inspect_runtime(str(cli),'codex')['path'],str(cli))
                self.assertEqual(version.call_count,1)
                cli.write_text('#!/bin/sh\n# updated\n', encoding="utf-8")
                service.inspect_runtime(str(cli),'codex')
                self.assertEqual(version.call_count,2)

    def test_explicit_probe_accepts_only_codex_and_claude(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = codex_cli(tmp)
            service=DiscoveryService()
            with patch('character_agent.harness.discovery.runtime_version',return_value='99.0.0') as version, \
                 patch('character_agent.harness.discovery.entry_supported',return_value=True), \
                 patch('character_agent.harness.discovery.native_status',return_value={'authenticated':True}) as status:
                self.assertIsNone(service.inspect_runtime(str(cli),'pi'))
                self.assertEqual(service.inspect_runtime(str(cli),'codex')['backend'],'codex')
                version.assert_called_once_with(cli,'codex')
                status.assert_called_once_with(cli,'codex')
                self.assertEqual(service.inspect_runtime(str(cli),'claude')['backend'],'claude')
                status.assert_called_with(cli,'claude')


if __name__ == "__main__":
    unittest.main()
