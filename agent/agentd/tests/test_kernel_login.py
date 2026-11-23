"""In-app kernel sign-in against fake codex and claude executables and the scripted fake ACP agent."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services import kernel_login
from character_agent.services.kernel_login import KernelLogin

FAKE_ACP = Path(__file__).resolve().parent / "fixtures/fake_acp_agent.py"

# One script plays both CLIs. `mode` beside it: ok, deny or hang. "signed" in the profile directory is the login.
FAKE_CLI = r'''
import json, os, sys, time
here = os.path.dirname(os.path.abspath(__file__))
mode = open(os.path.join(here, "mode")).read().strip()
args = sys.argv[1:]
while args[:1] == ["-c"]:
    args = args[2:]
home = os.environ.get("CODEX_HOME") or os.environ["CLAUDE_CONFIG_DIR"]
signed = os.path.join(home, "signed")
with open(os.path.join(here, "calls"), "a") as f:
    f.write(json.dumps({"args": args, "home": home}) + "\n")
if args in (["login", "status"], ["auth", "status", "--json"]):
    if args[0] == "auth":
        print(json.dumps({"loggedIn": os.path.exists(signed), "email": "c@example.com", "subscriptionType": "max"}))
    sys.exit(0 if os.path.exists(signed) else 1)
if args in (["logout"], ["auth", "logout"]):
    os.path.exists(signed) and os.remove(signed)
    sys.exit(0)
if args == ["auth", "login", "--claudeai"]:
    print("If the browser didn't open, visit: https://claude.ai/oauth/authorize?x", flush=True)
    if mode == "hang":
        time.sleep(60)
    if mode == "ok":
        open(signed, "w").close()
    sys.exit(0 if mode == "ok" else 1)
if args[:1] == ["app-server"]:
    def send(m):
        print(json.dumps(m), flush=True)
    for line in sys.stdin:
        m = json.loads(line)
        if m.get("method") == "initialize":
            send({"id": m["id"], "result": {}})
        elif m.get("method") == "account/login/start":
            send({"id": m["id"], "result": {"type": "chatgpt", "loginId": "L1", "authUrl": "https://auth.example/authorize"}})
            if mode != "hang":
                if mode == "ok":
                    open(signed, "w").close()
                send({"method": "account/login/completed", "params": {"loginId": "L1", "success": mode == "ok"}})
        elif m.get("method") == "account/read":
            send({"id": m["id"], "result": {"account": {"type": "chatgpt", "email": "x@example.com", "planType": "plus"}}})
'''


@unittest.skipIf(os.name == "nt", "the fake CLIs are shebang scripts")
class KernelLoginTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.bin = root / "bin"
        self.bin.mkdir()
        self.cli = self.bin / "cli"
        self.cli.write_text("#!" + sys.executable + " -I\n" + FAKE_CLI, encoding="utf-8")
        self.cli.chmod(0o755)
        self.mode("ok")
        self.opened = []
        self.acp_logins = []
        self.login = KernelLogin(root / "state", open_url=lambda url: self.opened.append(url) or True,
                                 on_acp_login=lambda agent, ok: self.acp_logins.append((agent, ok)))

    def mode(self, value):
        (self.bin / "mode").write_text(value, encoding="utf-8")

    def calls(self):
        return [json.loads(line) for line in (self.bin / "calls").read_text(encoding="utf-8").splitlines()]

    def finished(self):
        deadline = time.monotonic() + 15
        while self.login.public()["pending"] is not None:
            self.assertLess(time.monotonic(), deadline, "sign-in did not finish")
            time.sleep(0.05)
        return self.login.public()

    def test_codex_signs_in_to_the_apps_own_keyring_profile_and_shows_the_account(self):
        home = self.login.home("codex")
        self.assertFalse(self.login.signed_in("codex", str(self.cli), True))
        self.assertEqual(self.login.start("codex", str(self.cli))["pending"], {"backend": "codex", "acp_agent": None})
        self.assertIsNone(self.finished()["error"])
        self.assertEqual(self.opened, ["https://auth.example/authorize"])
        self.assertTrue(self.login.signed_in("codex", str(self.cli), True))
        self.assertEqual(self.login.public()["accounts"]["codex"],
                         {"signed_in": True, "email": "x@example.com", "plan": "plus"})
        self.assertEqual((home / "config.toml").read_text(encoding="utf-8"), 'cli_auth_credentials_store = "keyring"\n')
        self.assertEqual({call["home"] for call in self.calls()}, {str(home)})

    def test_claude_signs_in_with_its_own_cli_and_reads_the_account_from_its_status(self):
        self.login.start("claude", str(self.cli))
        self.assertIsNone(self.finished()["error"])
        # The CLI opens the browser itself.
        self.assertEqual(self.opened, [])
        self.assertTrue(self.login.signed_in("claude", str(self.cli), True))
        self.assertEqual(self.login.public()["accounts"]["claude"],
                         {"signed_in": True, "email": "c@example.com", "plan": "max"})
        self.assertEqual(self.login.logout("claude", str(self.cli))["accounts"], {})
        self.assertFalse(self.login.signed_in("claude", str(self.cli), True))

    def test_a_denied_sign_in_reports_why_and_stays_signed_out(self):
        self.mode("deny")
        for backend in ("codex", "claude"):
            with self.subTest(backend=backend):
                self.login.start(backend, str(self.cli))
                self.assertEqual(self.finished()["error"], "login_denied")
                self.assertFalse(self.login.signed_in(backend, str(self.cli), True))

    def test_cancel_ends_the_waiting_cli_without_an_error_and_a_second_start_waits_for_the_first(self):
        self.mode("hang")
        self.login.start("claude", str(self.cli))
        with self.assertRaisesRegex(ValueError, "login_pending"):
            self.login.start("codex", str(self.cli))
        started = time.monotonic()
        self.login.cancel()
        self.assertIsNone(self.finished()["error"])
        self.assertLess(time.monotonic() - started, 10)

    def test_a_sign_in_the_browser_never_finishes_times_out(self):
        self.mode("hang")
        with patch.object(kernel_login, "TIMEOUT", 1):
            self.login.start("codex", str(self.cli))
            self.assertEqual(self.finished()["error"], "login_timeout")

    def test_no_browser_is_an_error_the_user_can_act_on(self):
        self.login.open_url = lambda url: False
        self.login.start("codex", str(self.cli))
        self.assertEqual(self.finished()["error"], "browser_unavailable")

    def test_codex_logout_forgets_the_account(self):
        self.login.start("codex", str(self.cli))
        self.finished()
        self.login.logout("codex", str(self.cli))
        self.assertFalse((self.login.home("codex") / "account.json").exists())
        self.assertFalse(self.login.signed_in("codex", str(self.cli), True))
        self.assertIn({"args": ["logout"], "home": str(self.login.home("codex"))}, self.calls())

    def test_acp_terminal_method_runs_the_agents_own_command_with_its_args(self):
        agent = {"id": "fake", "command": [str(self.cli)]}
        self.login.start("acp", agent=agent, method={"id": "login", "type": "terminal", "args": ["auth", "login", "--claudeai"],
                                                    "env": {"CLAUDE_CONFIG_DIR": str(self.bin)}})
        self.assertIsNone(self.finished()["error"])
        self.assertEqual(self.acp_logins, [("fake", True)])
        self.assertEqual(self.calls()[-1], {"args": ["auth", "login", "--claudeai"], "home": str(self.bin)})

    def test_acp_agent_method_authenticates_over_acp(self):
        log = Path(self.tmp.name) / "acp.jsonl"
        # A refusal carries the agent's own words, which say what to do.
        for auth, error, detail in (("ok", None, None), ("deny", "login_denied", "Authentication required")):
            with self.subTest(auth=auth):
                agent = {"id": "fake", "command": [sys.executable, "-I", "-B", str(FAKE_ACP)],
                         "env": {"FAKE_ACP_AUTH": auth, "FAKE_ACP_LOG": str(log)}}
                self.login.start("acp", agent=agent, method={"id": "fake-login", "name": "Fake login"})
                done = self.finished()
                self.assertEqual((done["error"], done["detail"]), (error, detail))
        events = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([e["params"] for e in events if e["event"] == "authenticate"], [{"methodId": "fake-login"}] * 2)
        self.assertEqual(self.acp_logins, [("fake", True)])

    def test_acp_logout_only_where_the_agent_offers_it(self):
        command = [sys.executable, "-I", "-B", str(FAKE_ACP)]
        with self.assertRaisesRegex(ValueError, "logout_unsupported"):
            self.login.logout("acp", agent={"id": "fake", "command": command})
        self.login.logout("acp", agent={"id": "fake", "command": command, "env": {"FAKE_ACP_LOGOUT": "1"}})
        self.assertEqual(self.acp_logins, [("fake", False)])

    def deepseek(self, session):
        """The fake agent as dsh, its DeepSeek account route `session` (dsh_signed_out or dsh_signed_in) from now on."""
        os.environ["FAKE_ACP_SESSION"] = session
        return [sys.executable, "-I", "-B", str(FAKE_ACP)]

    def test_deepseek_sign_in_opens_the_desktop_client_and_waits_until_dsh_sees_the_account(self):
        self.addCleanup(os.environ.pop, "FAKE_ACP_SESSION", None)
        command = self.deepseek("dsh_signed_out")
        self.assertFalse(self.login.signed_in("deepseek", command, True))
        opened = []
        with patch.object(kernel_login, "DEEPSEEK_POLL", 0.05), \
                patch.object(kernel_login.subprocess, "run", side_effect=lambda argv, **_: opened.append(argv) or
                             SimpleNamespace(returncode=0)):
            self.login.start("deepseek", command)
            time.sleep(0.5)
            self.assertEqual(self.login.public()["pending"], {"backend": "deepseek", "acp_agent": None})
            self.deepseek("dsh_signed_in")
            self.assertIsNone(self.finished()["error"])
        self.assertEqual(opened, [["open", "-b", "com.deepseek.dsh"]])
        self.assertEqual(self.login.public()["accounts"], {})
        self.assertTrue(self.login.signed_in("deepseek", command, True))
        # The desktop client owns the account's sign-out.
        with self.assertRaisesRegex(ValueError, "logout_unsupported"):
            self.login.logout("deepseek")

    def test_deepseek_sign_in_without_the_desktop_client_says_so(self):
        self.addCleanup(os.environ.pop, "FAKE_ACP_SESSION", None)
        with patch.object(kernel_login.subprocess, "run", return_value=SimpleNamespace(returncode=1)):
            self.login.start("deepseek", self.deepseek("dsh_signed_out"))
            self.assertEqual(self.finished()["error"], "deepseek_desktop_missing")

    def test_deepseek_key_route_keeps_dsh_credentials_in_the_apps_own_file(self):
        patch_file = self.login.deepseek_patch()
        self.assertEqual(json.loads(patch_file.read_text(encoding="utf-8")),
                         [{"id": "credentials", "config": {"path": str(self.login.home("deepseek") / ".credentials.yaml")}}])


if __name__ == "__main__":
    unittest.main()
