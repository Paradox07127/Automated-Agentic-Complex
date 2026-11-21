"""Pi without a runtime provider uses the 「pi 账号与凭据」 connection; fake credentials only."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.harness.pi_config import PiConfig
from character_agent.harness.registry import HARNESSES, pi_catalog
from character_agent.integration import CharacterAgentController
from character_agent.services.settings import DEFAULTS, RuntimeSettings
from models.model_auth import ModelError
from models.model_backends import ModelSettings

# Fake runner: records every frame and its environment, answers ready and result.
FAKE_RUNNER = r'''
import json, os, sys
# The runner environment names its temporary directory TMPDIR on POSIX, TEMP on Windows.
log = os.path.join(os.environ.get("TMPDIR") or os.environ["TEMP"], "..", "frames.jsonl")
seq = 0
def emit(**frame):
    global seq; seq += 1
    sys.stdout.write(json.dumps({"v": 1, "seq": seq, **frame}) + "\n"); sys.stdout.flush()
for line in sys.stdin:
    message = json.loads(line)
    with open(log, "a") as out: out.write(json.dumps({"frame": message, "env": dict(os.environ)}) + "\n")
    if message["type"] == "init":
        native = message["config"]["native_tools"]
        emit(type="ready", backend="pi", session_id="s", tool_names=[], tool_inventory_verified=True,
             model=message["config"]["model"], provider=message["config"]["provider"], sdk_version="9.9.9-fake",
             builtin_tools=["read", "write"] if native else [], builtin_tools_unavailable={"grep": "rg_not_found"} if native else {},
             shell={"bash": "/bin/bash" if native else None, "powershell": None},
             tool_approval=native and message["config"]["tool_approval"],
             workspace_dir=message["config"]["workspace_dir"] if native else None,
             capabilities={"cancel": "native", "tool_injection": "in_process", "builtin_tools": "disabled_verified",
                           "system_prompt": "native", "usage": "tokens", "event_scope": "session", "native_questions": False})
    elif message["type"] == "query":
        emit(type="result", run_id=message["run_id"], success=True, subtype="success", final_text="ok")
    elif message["type"] == "close":
        break
'''


class FakeAuth:
    """ChatGPT sign-in whose token changes on every read, like a refresh."""
    def __init__(self, connected=True):
        self.connected, self.issued = connected, []

    def access_token(self):
        if not self.connected:
            raise ModelError("sign_in_required")
        self.issued.append(f"chatgpt-token-{len(self.issued) + 1}")
        return self.issued[-1]

    def state(self):
        return {"profiles": [{"connected": self.connected}]}


class PiConnectionCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.models = ModelSettings(self.root / "models")
        self.auth = self.models.auth = FakeAuth()
        site = self.root / "harness.pi"
        node = site / ("node/node.exe" if sys.platform == "win32" else "node/bin/node")
        node.parent.mkdir(parents=True); node.write_text("", encoding="utf-8")
        package = site / "pi-runtime/node_modules/@earendil-works/pi-coding-agent"
        package.mkdir(parents=True); (package / "package.json").write_text("{}", encoding="utf-8")
        self.rows = []
        c = self.controller = CharacterAgentController.__new__(CharacterAgentController)
        c.server = SimpleNamespace(models=self.models)
        c.state_dir = self.root / "personal"
        c.settings = RuntimeSettings(c.state_dir)
        c.settings.data["workspace_dir"] = str(self.root / "workspace")
        c.harness_sites = {"harness.pi": str(site)}
        c.session_factory_override = c.credential_override = None
        c._auto_chosen = False
        c._pi_facts, c._pi_prices = None, {}
        c.discovery = SimpleNamespace(scan=lambda refresh=False: {"runtimes": self.rows, "scanned_at": 0})

    def tearDown(self):
        self.tmp.cleanup()

    def use(self, provider, **backend):
        self.models.data["provider"] = provider
        self.models.data["backends"].setdefault(provider, {}).update(backend)

    def config(self, **changes):
        return {**DEFAULTS, **changes}


class MappingTests(PiConnectionCase):
    def test_chatgpt_subscription_maps_to_responses_with_its_access_token(self):
        self.use("chatgpt", model="gpt-5.5")
        config = self.config()
        self.assertEqual(self.controller._pi_connection(config),
                         {"provider": "chatgpt", "auth_source": "api_key", "base_url": "https://api.openai.com/v1",
                          "api": "openai-responses", "max_output_tokens": 4096})
        self.assertEqual(self.controller._credential(config), self.auth.issued[-1])
        self.assertEqual(self.controller._model(config), "gpt-5.5")

    def test_anthropic_default_endpoint_uses_the_builtin_provider(self):
        self.use("anthropic", api_key="fake-anthropic-key")
        config = self.config()
        self.assertEqual(self.controller._pi_connection(config),
                         {"provider": "anthropic", "auth_source": "api_key", "base_url": "https://api.anthropic.com"})
        self.assertEqual(self.controller._credential(config), "fake-anthropic-key")
        self.assertEqual(self.controller._model(config), "claude-haiku-5-5")

    def test_anthropic_other_endpoint_only_reroutes_the_catalog_provider(self):
        self.use("anthropic", api_key="fake-anthropic-key", base_url="https://gateway.example/anthropic")
        self.assertEqual(self.controller._pi_connection(self.config()),
                         {"provider": "anthropic", "auth_source": "api_key", "base_url": "https://gateway.example/anthropic"})

    def test_deepseek_uses_the_catalog_provider(self):
        self.use("deepseek", api_key="fake-deepseek-key")
        config = self.config()
        self.assertEqual(self.controller._pi_connection(config),
                         {"provider": "deepseek", "auth_source": "api_key", "base_url": "https://api.deepseek.com"})
        self.assertEqual(self.controller._credential(config), "fake-deepseek-key")
        self.assertEqual(self.controller._model(config), "deepseek-flash")

    def test_pi_catalog_runs_the_chosen_provider_with_its_own_key(self):
        self.use("pi_catalog", pi_provider="openrouter", model="openrouter/auto", keys={"openrouter": "fake-or-key", "groq": "fake-groq-key"})
        config = self.config()
        self.assertEqual(self.controller._pi_connection(config),
                         {"provider": "openrouter", "auth_source": "api_key", "base_url": ""})
        self.assertEqual(self.controller._credential(config), "fake-or-key")
        self.assertEqual(self.controller._model(config), "openrouter/auto")

    def test_pi_catalog_without_a_chosen_provider_is_missing(self):
        self.use("pi_catalog", pi_provider="", keys={})
        with self.assertRaisesRegex(ValueError, "pi_connection_missing"):
            self.controller._pi_connection(self.config())

    def test_xai_has_its_own_backend_and_key(self):
        self.use("xai", api_key="fake-xai-key", model="grok-4.3")
        config = self.config()
        self.assertEqual(self.controller._pi_connection(config),
                         {"provider": "xai", "auth_source": "api_key", "base_url": "https://api.x.ai/v1"})
        self.assertEqual(self.controller._credential(config), "fake-xai-key")
        self.assertEqual(self.controller._model(config), "grok-4.3")

    def test_runtime_provider_reads_its_own_backend_key_never_the_compatible_one(self):
        self.models.data["backends"]["compatible"].update(base_url="https://api.deepseek.com", api_key="fake-compatible-key")
        for provider, url in (("deepseek", "https://api.deepseek.com"), ("xai", "https://api.x.ai/v1")):
            with self.subTest(provider=provider):
                config = self.config(provider=provider, model="m", auth_source="api_key")
                with self.assertRaisesRegex(ValueError, "missing_provider_api_key"):
                    self.controller._credential(config)
                self.models.data["backends"][provider]["api_key"] = "fake-" + provider + "-key"
                self.assertEqual(self.controller._credential(config), "fake-" + provider + "-key")
                self.assertEqual(self.controller._pi_connection(config),
                                 {"provider": provider, "auth_source": "api_key", "base_url": url})

    def test_compatible_keeps_the_compatible_rules(self):
        self.use("compatible", api_key="fake-compatible-key", model="local-model")
        config = self.config()
        self.assertEqual(self.controller._pi_connection(config),
                         {"provider": "compatible", "auth_source": "api_key", "base_url": "http://127.0.0.1:11434/v1",
                          "api": "openai-completions", "supports_images": False, "max_output_tokens": 4096})
        self.assertEqual(self.controller._credential(config), "fake-compatible-key")
        self.models.data["backends"]["compatible"]["api_key"] = ""
        self.assertEqual(self.controller._pi_connection(self.config(auth_source="local_no_auth"))["auth_source"], "none")
        with self.assertRaisesRegex(ValueError, "pi_connection_missing"):
            self.controller._pi_connection(config)
        self.models.data["backends"]["compatible"]["base_url"] = "https://remote.example/v1"
        with self.assertRaisesRegex(ValueError, "requires_loopback"):
            self.controller._pi_connection(self.config(auth_source="local_no_auth"))

    def test_missing_credentials_are_pi_connection_missing(self):
        self.use("anthropic")
        with self.assertRaisesRegex(ValueError, "pi_connection_missing"):
            self.controller._credential(self.config())
        self.auth.connected = False
        self.use("chatgpt", model="gpt-5.5")
        with self.assertRaisesRegex(ValueError, "pi_connection_missing"):
            self.controller._pi_connection(self.config())

    def test_openai_other_endpoint_is_refused(self):
        self.use("openai", api_key="fake-openai-key", base_url="https://proxy.example/v1", model="gpt-5.5")
        with self.assertRaisesRegex(ValueError, "unsupported_openai_endpoint"):
            self.controller._pi_connection(self.config())

    def test_runtime_model_wins_and_no_model_anywhere_is_select_model(self):
        self.use("chatgpt", model="gpt-5.5")
        self.assertEqual(self.controller._model(self.config(model="gpt-5.5-mini")), "gpt-5.5-mini")
        chat = {"backend": "pi", "acp_agent": None, "model": "front", "effort": None}
        self.assertEqual(self.controller._model(RuntimeSettings.route(self.config(routes={"chat": chat}), "chat")), "front")
        self.models.data["backends"]["chatgpt"]["model"] = ""
        with self.assertRaisesRegex(ValueError, "select_model"):
            self.controller._pi_connection(self.config())
        self.assertEqual(self.controller._pi_connection(self.config(model="gpt-5.5"))["provider"], "chatgpt")

    def test_explicit_runtime_provider_keeps_its_own_connection(self):
        self.use("chatgpt", model="gpt-5.5")
        self.models.data["backends"]["compatible"]["base_url"] = "http://127.0.0.1:1234/v1"
        connection = self.controller._pi_connection(self.config(provider="compatible", auth_source="local_no_auth"))
        self.assertEqual((connection["provider"], connection["base_url"]), ("compatible", "http://127.0.0.1:1234/v1"))


class CatalogPriceTests(PiConnectionCase):
    def test_only_pi_stops_a_run_at_the_cost_limit(self):
        self.assertEqual({key: h.cost_limit_supported for key, h in HARNESSES.items()},
                         {"codex": False, "pi": True, "acp": False, "claude": False})

    def test_the_main_model_is_priced_when_pis_offline_catalog_prices_it(self):
        catalogs = {"anthropic": [{"id": "claude-haiku-5-5", "priced": True}, {"id": "free-model", "priced": False}],
                    "compatible": []}
        with patch("character_agent.harness.pi_transport.list_models",
                   side_effect=lambda node, runtime, state, provider: {"providers": [], "models": catalogs[provider]}) as listing:
            self.use("anthropic", api_key="fake-anthropic-key")
            self.assertTrue(self.controller._catalog_priced(self.config()))
            self.assertFalse(self.controller._catalog_priced(self.config(model="free-model")))
            self.assertFalse(self.controller._catalog_priced(self.config(model="unlisted")))
            self.use("compatible", api_key="fake-compatible-key", model="local-model")
            self.assertFalse(self.controller._catalog_priced(self.config()))
        # One offline catalog read per provider.
        self.assertEqual([call.args[3] for call in listing.call_args_list], ["anthropic", "compatible"])

    def test_a_runtime_that_cannot_list_its_catalog_prices_nothing_and_is_read_again(self):
        self.use("anthropic", api_key="fake-anthropic-key")
        with patch("character_agent.harness.pi_transport.list_models", side_effect=ValueError("pi_runtime_unavailable")) as listing:
            self.assertFalse(self.controller._catalog_priced(self.config()))
            self.assertFalse(self.controller._catalog_priced(self.config()))
        self.assertEqual(listing.call_count, 2)


class SavedProviderTests(PiConnectionCase):
    def test_pi_route_never_walks_to_another_keyed_provider(self):
        self.models.save({"provider": "openai", "model": "gpt-5.5", "api_key": "fake-openai-key"})
        self.models.save({"provider": "deepseek"})
        with self.assertRaisesRegex(ValueError, "pi_connection_missing"):
            self.controller._pi_route(self.config())


class SessionTests(PiConnectionCase):
    def test_every_query_carries_the_current_token_and_nothing_reads_pi_login(self):
        self.use("chatgpt", model="gpt-5.5")
        runner = self.root / "fake_runner.py"; runner.write_text(FAKE_RUNNER, encoding="utf-8")
        config = self.config(runtime_source="local", executable=sys.executable)
        session = self.controller._session_factory([], config)
        session.runner_path = runner
        try:
            for run in ("run-1", "run-2"):
                events = list(session.stream("hi", system_prompt="You are Mira.", run_id=run))
                self.assertTrue(events[-1]["success"], events)
        finally:
            session.close()
        records = [json.loads(line) for line in (self.controller.state_dir / "character-agent/runner/pi/frames.jsonl")
                   .read_text(encoding="utf-8").splitlines()]
        frames = [r["frame"] for r in records]
        init = next(f for f in frames if f["type"] == "init")
        queries = [f for f in frames if f["type"] == "query"]
        self.assertEqual((init["config"]["provider"], init["config"]["api"], init["config"]["base_url"]),
                         ("chatgpt", "openai-responses", "https://api.openai.com/v1"))
        self.assertNotIn("auth_file", init["config"])
        self.assertEqual([q["api_key"] for q in queries], self.auth.issued[-2:])
        self.assertNotEqual(queries[0]["api_key"], queries[1]["api_key"])
        pi_home = str(Path.home() / ".pi")
        for record in records:
            # Only the user's own mcp.json and Skills directories may name ~/.pi; Pi's login there is never passed.
            config = {k: v for k, v in record["frame"].get("config", {}).items() if k not in ("user_agent_dir", "skill_dirs")}
            self.assertNotIn(pi_home, json.dumps({**record, "frame": {**record["frame"], "config": config}}))
            self.assertNotEqual(record["env"]["HOME"], str(Path.home()))

    def test_only_a_session_with_pis_own_tools_records_what_pi_found(self):
        self.use("deepseek", api_key="fake-deepseek-key")
        runner = self.root / "fake_runner.py"; runner.write_text(FAKE_RUNNER, encoding="utf-8")
        config = self.config(runtime_source="local", executable=sys.executable)
        facts = []
        for native in (False, True, False):
            session = self.controller._session_factory([], config, native_tools=native)
            session.runner_path = runner
            try:
                session.probe()
            finally:
                session.close()
            facts.append(self.controller._pi_facts)
        found = {"sdk_version": "9.9.9-fake", "builtin_tools": ["read", "write"],
                 "builtin_tools_unavailable": {"grep": "rg_not_found"}, "shell": {"bash": "/bin/bash", "powershell": None},
                 "tool_approval": True, "workspace_dir": str(self.root / "workspace")}
        self.assertEqual(facts, [None, found, found])

    def test_catalog_provider_reaches_the_runner_without_an_endpoint_api(self):
        self.use("deepseek", api_key="fake-deepseek-key")
        runner = self.root / "fake_runner.py"; runner.write_text(FAKE_RUNNER, encoding="utf-8")
        session = self.controller._session_factory([], self.config(runtime_source="local", executable=sys.executable))
        session.runner_path = runner
        try:
            self.assertTrue(list(session.stream("hi", system_prompt="You are Mira.", run_id="run-1"))[-1]["success"])
        finally:
            session.close()
        frames = [json.loads(line)["frame"] for line in (self.controller.state_dir / "character-agent/runner/pi/frames.jsonl")
                  .read_text(encoding="utf-8").splitlines()]
        init = next(f for f in frames if f["type"] == "init")["config"]
        self.assertEqual((init["provider"], init["model"], init["base_url"], init["api"], init["api_key"]),
                         ("deepseek", "deepseek-flash", "https://api.deepseek.com", None, "fake-deepseek-key"))

    def init_config(self, config):
        runner = self.root / "fake_runner.py"; runner.write_text(FAKE_RUNNER, encoding="utf-8")
        session = self.controller._session_factory([], {"_turn_effort": None, **config, "runtime_source": "local",
                                                        "executable": sys.executable})
        session.runner_path = runner
        try:
            self.assertTrue(session.probe())
        finally:
            session.close()
        frames = [json.loads(line)["frame"] for line in (self.controller.state_dir / "character-agent/runner/pi/frames.jsonl")
                  .read_text(encoding="utf-8").splitlines()]
        return [f for f in frames if f["type"] == "init"][-1]["config"]

    def test_compatible_model_capabilities_and_thinking_default_reach_the_runner(self):
        self.use("compatible", api_key="fake-compatible-key", model="local-model", context_window=64000,
                 reasoning=True, supports_images=True, max_output_tokens=8192, reasoning_effort="medium")
        init = self.init_config(self.config())
        self.assertEqual((init["context_window"], init["reasoning"], init["supports_images"], init["max_output_tokens"],
                          init["thinking_level"]), (64000, True, True, 8192, "medium"))

    def test_the_route_effort_wins_over_the_thinking_default(self):
        self.use("deepseek", api_key="fake-deepseek-key", reasoning_effort="max")
        self.assertEqual(self.init_config(self.config())["thinking_level"], "max")
        self.assertEqual(self.init_config(self.config(_turn_effort="low"))["thinking_level"], "low")
        self.models.data["backends"]["deepseek"]["reasoning_effort"] = ""
        self.assertEqual(self.init_config(self.config())["thinking_level"], "off")

    def test_catalog_runner_uses_the_node_and_sdk_of_pi_sessions(self):
        site = Path(self.controller.harness_sites["harness.pi"]).resolve()
        with patch("character_agent.harness.pi_transport.list_models", return_value={"providers": [], "models": []}) as listing:
            self.assertEqual(pi_catalog(self.controller, "groq"), {"providers": [], "models": []})
            self.controller.settings.save({"runtime_source": "local", "executable": sys.executable})
            pi_catalog(self.controller, None)
        catalog = self.controller.state_dir / "character-agent/runner/pi/catalog"
        self.assertEqual([call.args for call in listing.call_args_list],
                         [(str(site / ("node/node.exe" if sys.platform == "win32" else "node/bin/node")), str(site / "pi-runtime"), catalog, "groq"),
                          (sys.executable, str(site / "pi-runtime"), catalog, None)])

    def test_pi_config_has_no_login_file(self):
        with self.assertRaises(TypeError):
            PiConfig("/tmp/pi", "anthropic", "m", auth_file="/tmp/auth.json")
        self.assertNotIn("auth_file", PiConfig("/tmp/pi", "anthropic", "m", api_key="k").wire())
        with self.assertRaisesRegex(ValueError, "credentials_missing"):
            PiConfig("/tmp/pi", "anthropic", "m", auth_source="existing_login").validate()


class AutoSelectTests(PiConnectionCase):
    codex = {"backend": "codex", "path": "/synthetic/codex", "entry_supported": True, "authenticated": True}

    def test_pi_without_a_connection_falls_back_to_logged_in_codex(self):
        self.rows = [self.codex]
        self.use("anthropic")
        self.assertTrue(self.controller._auto_select())
        self.assertEqual(self.controller.settings.snapshot()["backend"], "codex")

    def test_pi_with_a_connection_stays(self):
        self.rows = [self.codex]
        self.use("chatgpt", model="gpt-5.5")
        self.assertTrue(self.controller._auto_select())
        self.assertEqual(self.controller.settings.snapshot()["backend"], "pi")

    def test_without_codex_pi_stays_even_without_a_connection(self):
        self.use("anthropic")
        self.assertTrue(self.controller._auto_select())
        self.assertEqual(self.controller.settings.snapshot()["backend"], "pi")


if __name__ == "__main__":
    unittest.main()
