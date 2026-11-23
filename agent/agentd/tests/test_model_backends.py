"""Protocol tests use fake HTTP/SSE and RSA keys; never use a real account or paid inference."""
import base64
import contextlib
import http.client
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from infra.secrets import MemorySecrets
from fsutil import atomic_write_json
from models.model_auth import ChatGPTAuth, ModelError, ISSUER, read_json
from models.model_backends import ModelSettings
from daemon.agentd_server import AgentdServer
from support import serve_in_thread


class CredentialFileTests(unittest.TestCase):
    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_json_credentials_refuse_symlinks_and_foreign_owners(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "target.json"
            atomic_write_json(target, {"access_token": "private"})
            link = Path(directory) / "linked.json"
            link.symlink_to(target)
            with self.assertRaisesRegex(ModelError, "credential_permissions"):
                read_json(link, {})
            with patch("infra.tokens.os.getuid", return_value=os.getuid() + 1):
                with self.assertRaisesRegex(ModelError, "credential_permissions"):
                    read_json(target, {})
            self.assertEqual(read_json(Path(directory) / "missing.json", {}), {})

    def test_refresh_lock_refuses_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "other"
            target.write_text("keep me", encoding="utf-8")
            lock = Path(directory) / "chatgpt-auth.json.lock"
            lock.symlink_to(target)
            auth = ChatGPTAuth(directory, MemorySecrets())
            self.assertEqual(auth.state()["error"], "credential_permissions")
            with self.assertRaisesRegex(ModelError, "credential_permissions"):
                auth.select("missing")
            self.assertEqual(target.read_text(encoding="utf-8"), "keep me")

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_unreadable_chatgpt_auth_file_leaves_model_settings_usable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "chatgpt-auth.json"
            atomic_write_json(path, {"host_id": "urn:uuid:x", "active": None, "profiles": {}})
            path.chmod(0o644)
            settings = ModelSettings(directory, MemorySecrets())
            self.assertEqual(settings.public()["chatgpt"]["error"], "credential_permissions")
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)


class ModelsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.settings = ModelSettings(self.tmp.name, MemorySecrets())
        self.addCleanup(self.settings.auth.cancel)

    def config(self, provider="openai", **values):
        return self.settings.save({"provider": provider, "model": "test-model", "api_key": "secret-key", **values})

    def test_a_moved_llm_endpoint_clears_only_the_compatible_key(self):
        from daemon.main import clear_moved_credentials
        tunnel = {"url": "http://127.0.0.1:11434/v1", "ssh_host": "gpu"}
        other_host = {**tunnel, "ssh_host": "gpu2"}
        direct = {"url": "https://llm.example/v1", "ssh_host": ""}
        off = {"url": "", "ssh_host": ""}
        endpoints = Path(self.tmp.name) / "service-endpoints.json"
        clear = lambda: self.settings.clear_key("compatible")  # noqa: E731
        # (endpoint at the last start or None for a first start, endpoint now, whether the key stays)
        for last, now, kept in ((None, tunnel, True), (tunnel, tunnel, True), (tunnel, other_host, False),
                                (tunnel, direct, False), (tunnel, off, False)):
            with self.subTest(last=last, now=now):
                endpoints.unlink(missing_ok=True)
                self.config("compatible", api_key="compatible-key")
                self.config("openai")
                ref = self.settings.data["backends"]["compatible"]["key_refs"]["compatible"]
                if last is not None:
                    clear_moved_credentials(self.tmp.name, {"llm": (last, clear)})
                with contextlib.redirect_stderr(io.StringIO()) as stderr:
                    clear_moved_credentials(self.tmp.name, {"llm": (now, clear)})
                loaded = ModelSettings(self.tmp.name, self.settings.secrets)
                self.assertEqual(loaded.public()["backends"]["compatible"]["has_key"], kept)
                self.assertEqual(self.settings.secrets.get(ref) is not None, kept)
                provider, _, key = loaded.connection()
                self.assertEqual((provider, key), ("openai", "secret-key"))
                self.assertEqual(stderr.getvalue(), "" if kept else "agentd: llm endpoint changed; credential cleared\n")
                self.assertEqual(json.loads(endpoints.read_text(encoding="utf-8"))["llm"], now)

    def test_deepseek_fixed_endpoint(self):
        self.settings.save({"provider": "deepseek", "api_key": "secret-key", "base_url": "https://evil.example"})
        self.assertEqual(self.settings.snapshot()["backends"]["deepseek"]["base_url"], "https://api.deepseek.com")
        self.assertEqual(self.settings.connection()[1]["model"], "deepseek-flash")
        self.settings.save({"provider": "deepseek", "clear_key": True})
        with self.assertRaisesRegex(ModelError, "missing_api_key"):
            self.settings.connection()

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_credentials_private_atomic_and_not_returned(self):
        self.config()
        self.assertEqual(self.settings.path.stat().st_mode & 0o777, 0o600)
        public = json.dumps(self.settings.public())
        self.assertNotIn("secret-key", public)
        self.assertNotIn("access_token", public)
        self.assertTrue(self.settings.public()["backends"]["openai"]["has_key"])
        loaded = ModelSettings(self.tmp.name, self.settings.secrets)
        self.assertEqual(loaded.connection()[2], "secret-key")
        self.config(api_key="replacement")
        self.settings.save({"provider": "openai", "model": "other"})
        self.assertEqual(self.settings.connection()[2], "replacement")
        self.settings.save({"provider": "openai", "clear_key": True})
        with self.assertRaisesRegex(ModelError, "missing_api_key"):
            self.settings.connection()

    def test_reject_remote_http_and_credentials_in_url(self):
        for url in ["http://remote.example/v1", "https://user:pass@api.example/v1", "file:///tmp/a", "https://api.example/v1?key=x"]:
            with self.subTest(url=url), self.assertRaisesRegex(ModelError, "invalid_base_url"):
                self.config(base_url=url)
        self.config("compatible", api_key="")
        self.assertEqual(self.settings.connection()[2], "")

    def test_the_compatible_address_is_the_llm_url_argument_never_a_setting(self):
        with self.assertRaisesRegex(ModelError, "invalid_base_url"):
            self.config("compatible", base_url="http://127.0.0.1:11434/v1")
        atomic_write_json(self.settings.path, {"provider": "compatible", "backends": {
            "compatible": {"model": "m", "base_url": "http://127.0.0.1:1/v1"}}})
        settings = ModelSettings(self.tmp.name, self.settings.secrets)
        self.assertNotIn("base_url", settings.public()["backends"]["compatible"])
        self.assertNotIn("base_url", settings.connection()[1])
        settings.save({"provider": "compatible", "model": "other"})
        self.assertNotIn("base_url", json.loads(settings.path.read_text(encoding="utf-8"))["backends"]["compatible"])

    def test_oauth_endpoint_pinned(self):
        self.config("chatgpt", base_url="https://evil.example", api_key="forbidden")
        config = self.settings.snapshot()["backends"]["chatgpt"]
        self.assertEqual(config["base_url"], "https://api.openai.com/v1")
        self.assertNotIn("api_key", config)

    def test_output_budget_and_reasoning_effort_are_validated(self):
        self.config(max_output_tokens=4096, reasoning_effort="low")
        config = self.settings.connection()[1]
        self.assertEqual((config["max_output_tokens"], config["reasoning_effort"]), (4096, "low"))
        for values in [{"max_output_tokens": 1}, {"max_output_tokens": True}, {"reasoning_effort": "unsupported"}]:
            with self.subTest(values=values), self.assertRaises(ModelError):
                self.config(**values)

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_unreadable_settings_file_degrades_until_saved(self):
        for name, damage, code in (("0644", lambda p: p.chmod(0o644), "credential_permissions"),
                                   ("malformed", lambda p: p.write_text("{broken", encoding="utf-8"), "settings_unreadable")):
            with self.subTest(name), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "model-settings.json"
                atomic_write_json(path, {"provider": "openai", "backends": {}})
                damage(path)
                settings = ModelSettings(directory, MemorySecrets())
                self.addCleanup(settings.auth.cancel)
                with self.assertRaisesRegex(ModelError, code):
                    settings.connection()
                self.assertEqual(settings.public()["error"], code)
                settings.save({"provider": "openai", "model": "m", "api_key": "secret-key"})
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertIsNone(settings.public()["error"])
                self.assertEqual(settings.connection()[2], "secret-key")

    def test_base_url_host_change_drops_stored_key(self):
        self.config()
        self.settings.save({"provider": "openai", "base_url": "https://api.openai.com/v1/"})
        self.assertTrue(self.settings.public()["backends"]["openai"]["has_key"])
        self.settings.save({"provider": "openai", "base_url": "https://other.example/v1"})
        self.assertFalse(self.settings.public()["backends"]["openai"]["has_key"])
        with self.assertRaisesRegex(ModelError, "missing_api_key"):
            self.settings.connection()
        self.settings.save({"provider": "openai", "base_url": "https://third.example/v1", "api_key": "new-key"})
        self.assertEqual(self.settings.connection()[2], "new-key")

    def test_supports_images_is_a_compatible_boolean(self):
        self.config("compatible", supports_images=True)
        self.assertIs(self.settings.snapshot()["backends"]["compatible"]["supports_images"], True)
        with self.assertRaisesRegex(ModelError, "invalid_supports_images"):
            self.config("compatible", supports_images="yes")

    def test_compatible_model_capabilities_have_defaults_and_are_validated(self):
        config = self.settings.public()["backends"]["compatible"]
        self.assertEqual((config["supports_images"], config["context_window"], config["reasoning"]), (False, 128000, False))
        self.config("compatible", context_window=32000, reasoning=True)
        config = self.settings.snapshot()["backends"]["compatible"]
        self.assertEqual((config["context_window"], config["reasoning"]), (32000, True))
        for values, code in (({"context_window": 512}, "invalid_context_window"), ({"context_window": True}, "invalid_context_window"),
                             ({"reasoning": "yes"}, "invalid_reasoning")):
            with self.subTest(values=values), self.assertRaisesRegex(ModelError, code):
                self.config("compatible", **values)
        self.config("openai", context_window=32000, reasoning=True)
        self.assertNotIn("context_window", self.settings.snapshot()["backends"]["openai"])

    def test_reasoning_effort_takes_every_pi_thinking_level(self):
        for level in ("", "off", "minimal", "low", "medium", "high", "xhigh", "max"):
            with self.subTest(level=level):
                self.config(reasoning_effort=level)
                self.assertEqual(self.settings.snapshot()["backends"]["openai"]["reasoning_effort"], level)

    def test_each_pi_catalog_provider_keeps_its_own_key(self):
        self.assertEqual(self.settings.public()["backends"]["pi_catalog"],
                         {"model": "", "base_url": "", "pi_provider": "", "max_output_tokens": 4096,
                          "reasoning_effort": "", "has_key": False})
        with self.assertRaisesRegex(ModelError, "invalid_pi_provider"):
            self.settings.save({"provider": "pi_catalog", "api_key": "groq-key"})
        for value in ("../groq", "", 3):
            with self.subTest(value=value), self.assertRaisesRegex(ModelError, "invalid_pi_provider"):
                self.settings.save({"provider": "pi_catalog", "pi_provider": value})
        self.settings.save({"provider": "pi_catalog", "pi_provider": "groq", "api_key": "groq-key", "model": "llama"})
        self.settings.save({"provider": "pi_catalog", "pi_provider": "openrouter", "base_url": "https://evil.example"})
        public = self.settings.public()["backends"]["pi_catalog"]
        self.assertEqual((public["pi_provider"], public["model"], public["base_url"], public["has_key"]),
                         ("openrouter", "", "", False))
        self.assertNotIn("groq-key", json.dumps(self.settings.public()))
        with self.assertRaisesRegex(ModelError, "missing_api_key"):
            self.settings.connection()
        self.settings.save({"provider": "pi_catalog", "api_key": "openrouter-key"})
        self.assertEqual(self.settings.connection()[2], "openrouter-key")
        self.settings.save({"provider": "pi_catalog", "pi_provider": "groq"})
        self.assertEqual(self.settings.connection()[2], "groq-key")
        self.settings.save({"provider": "pi_catalog", "clear_key": True})
        with self.assertRaisesRegex(ModelError, "missing_api_key"):
            self.settings.connection()
        self.settings.save({"provider": "pi_catalog", "pi_provider": "openrouter"})
        self.assertEqual(self.settings.connection()[2], "openrouter-key")

    def test_public_is_only_the_credential_store(self):
        self.config()
        public = self.settings.public()
        self.assertEqual(set(public), {"provider", "backends", "chatgpt", "error"})
        self.assertEqual(set(public["backends"]), {"anthropic", "deepseek", "xai", "openai", "compatible", "pi_catalog", "chatgpt"})
        for provider in ("auto", "claude_login", "codex_login"):
            with self.subTest(provider=provider), self.assertRaisesRegex(ModelError, "invalid_provider"):
                self.settings.save({"provider": provider})

    def test_catalog_of_a_compatible_api_lists_its_own_models(self):
        self.settings.llm_url = "http://127.0.0.1:11434/v1"
        self.config("compatible", api_key="local-key")
        with patch("httpx.get", return_value=httpx.Response(200, json={"data": [{"id": "qwen3"}]})) as get:
            self.assertEqual(self.settings.catalog(self.no_pi), {"providers": [], "models": [{
                "id": "qwen3", "name": "qwen3", "context_window": None, "max_tokens": None, "input": None,
                "reasoning": None, "thinking_levels": None, "priced": None}]})
        self.assertEqual(get.call_args.args[0], "http://127.0.0.1:11434/v1/models")
        self.assertEqual(get.call_args.kwargs["headers"]["Authorization"], "Bearer local-key")

    def test_catalog_of_a_compatible_api_without_the_llm_url_is_off(self):
        self.config("compatible", api_key="local-key")
        with patch("httpx.get", side_effect=AssertionError("no request")), \
                self.assertRaisesRegex(ModelError, "llm_service_off"):
            self.settings.catalog(self.no_pi)

    def test_catalog_of_a_compatible_api_starts_it_through_the_ensurer(self):
        self.settings.llm_url = "http://127.0.0.1:11434/v1"
        self.config("compatible", api_key="local-key")
        calls = []
        for ready in (True, False):
            with self.subTest(ready=ready):
                self.settings.llm_ensurer = NS(request=lambda: calls.append("request"),
                                               wait_ready=lambda timeout, ready=ready: calls.append(timeout) or ready)
                with patch("httpx.get", side_effect=lambda *a, **k: calls.append("get") or httpx.Response(200, json={"data": []})):
                    if ready:
                        self.assertEqual(self.settings.catalog(self.no_pi)["models"], [])
                        self.assertEqual(calls, ["request", 0.1, "get"])
                    else:
                        calls.clear()
                        with self.assertRaisesRegex(ModelError, "llm_ensure_failed"):
                            self.settings.catalog(self.no_pi)
                        self.assertEqual(calls, ["request", 0.1])

    def test_chatgpt_models_are_account_catalog_and_oauth_required(self):
        self.config("chatgpt")
        with self.assertRaisesRegex(ModelError, "sign_in_required"):
            self.settings.catalog(self.no_pi)
        with patch.object(self.settings.auth, "access_token", return_value="oauth"), patch("httpx.get", return_value=httpx.Response(
                200, json={"models": [{"slug": "available", "display_name": "Available", "visibility": "list"},
                                      {"slug": "hidden", "visibility": "hidden"}]})) as get:
            self.assertEqual([m["id"] for m in self.settings.catalog(self.no_pi)["models"]], ["available"])
            self.assertEqual(get.call_args.kwargs["headers"]["Authorization"], "Bearer oauth")

    def no_pi(self, provider):
        self.fail("a compatible API or ChatGPT lists its own models")

    def test_pi_services_list_pis_offline_catalog_without_a_key_or_request(self):
        asked = []
        listing = {"providers": [{"id": "groq", "name": "Groq"}], "models": []}
        with patch("httpx.get", side_effect=AssertionError("no provider request")):
            for provider in ("anthropic", "deepseek", "xai", "openai"):
                with self.subTest(provider=provider):
                    self.settings.save({"provider": provider})
                    self.assertEqual(self.settings.catalog(lambda name: asked.append(name) or listing), listing)
            self.settings.save({"provider": "pi_catalog"})
            self.settings.catalog(asked.append)
            self.settings.save({"provider": "pi_catalog", "pi_provider": "groq"})
            self.settings.catalog(asked.append)
        self.assertEqual(asked, ["anthropic", "deepseek", "xai", "openai", None, "groq"])


class AuthTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.auth = ChatGPTAuth(self.tmp.name, MemorySecrets()); self.addCleanup(self.auth.cancel)
        self.browser = patch("models.model_auth.webbrowser.open", return_value=True).start(); self.addCleanup(patch.stopall)

    def tokens(self, **overrides):
        return {"access_token": "access", "refresh_token": "refresh", "id_token": "id", "scope": "chatgpt.tokens.use.direct",
                "expires_in": 3600, "token_type": "Bearer", **overrides}

    def identity(self, **overrides):
        return {"sub": "account", "iss": ISSUER, "email": "a@example.com", **overrides}

    def finish(self, profile=None, identity=None, **tokens):
        self.auth.start(profile)
        attempt = dict(self.auth.pending)
        with patch.object(self.auth, "_token", return_value=self.tokens(**tokens)), patch.object(
                self.auth, "_identity", return_value=identity or self.identity()):
            return self.auth.finish({"state": [attempt["state"]], "code": ["code"],
                                     "client_id": [attempt["client_id"] or "issued-client"]})

    def test_pkce_nonce_state_host_and_no_ui_token_exposure(self):
        self.auth.start()
        params = parse_qs(urlparse(self.browser.call_args.args[0]).query)
        self.assertEqual(params["client_id"], ["dynamic_agent_client"])
        self.assertEqual(params["agent_name_hint"], ["Agentic Complex"])
        self.assertEqual(params["ext_agent_host_id"], [self.auth.data["host_id"]])
        self.assertEqual(params["code_challenge_method"], ["S256"])
        self.assertTrue(params["redirect_uri"][0].startswith("http://127.0.0.1:"))
        self.assertFalse(self.auth.finish({"state": ["wrong"], "code": ["secret"]}))
        self.assertIsNotNone(self.auth.pending)
        self.assertNotIn("verifier", json.dumps(self.auth.state()))
        host = self.auth.data["host_id"]
        self.assertEqual(ChatGPTAuth(self.tmp.name, MemorySecrets()).data["host_id"], host)

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_registration_saved_before_exchange_then_valid_identity(self):
        self.auth.start(); state = self.auth.pending["state"]
        def exchange(form):
            self.assertEqual(self.auth.data["profiles"][self.auth.pending["id"]]["client_id"], "issued-client")
            self.assertEqual(form["client_id"], "issued-client")
            self.assertIn("code_verifier", form)
            return self.tokens()
        with patch.object(self.auth, "_token", side_effect=exchange), patch.object(self.auth, "_identity", return_value=self.identity()):
            self.assertTrue(self.auth.finish({"state": [state], "code": ["code"], "client_id": ["issued-client"]}))
        self.assertEqual(self.auth.access_token(), "access")
        self.assertEqual(self.auth.path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('"access_token"', json.dumps(self.auth.state()))

    def test_denied_missing_client_and_wrong_returning_client(self):
        for query in [{"error": ["access_denied"]}, {"code": ["code"]}]:
            self.auth.start()
            with patch.object(self.auth, "_token") as token:
                self.assertFalse(self.auth.finish({"state": [self.auth.pending["state"]], **query}))
                token.assert_not_called()
        self.assertTrue(self.finish())
        selected = self.auth.data["active"]
        self.auth.start(selected)
        with patch.object(self.auth, "_token") as token:
            self.assertFalse(self.auth.finish({"state": [self.auth.pending["state"]], "client_id": ["wrong"], "code": ["code"]}))
            token.assert_not_called()
        self.assertEqual(self.auth.access_token(), "access")

    def test_identity_only_cannot_infer_and_account_mismatch_keeps_tokens(self):
        self.assertTrue(self.finish(scope="openid email"))
        selected = self.auth.data["active"]
        with self.assertRaisesRegex(ModelError, "plan_usage_not_enabled"):
            self.auth.access_token()
        self.assertFalse(self.finish(selected, identity=self.identity(sub="different"), access_token="replacement"))
        self.assertEqual(self.auth._credentials(selected)["access_token"], "access")

    def test_multiple_profiles_refresh_rotation_and_logout_retains_registration(self):
        self.assertTrue(self.finish()); first = self.auth.data["active"]
        self.assertTrue(self.finish()); second = self.auth.data["active"]
        self.assertNotEqual(first, second)
        self.assertEqual(len(self.auth.state()["profiles"]), 2)
        self.auth.select(first)
        self.auth.data["profiles"][first]["expires_at"] = time.time() - 10
        self.auth._save()
        with patch.object(self.auth, "_token", return_value=self.tokens(access_token="renewed", refresh_token="rotated")) as token:
            self.assertEqual(self.auth.access_token(), "renewed")
            self.assertEqual(token.call_args.args[0]["client_id"], "issued-client")
        self.assertEqual(self.auth._credentials(first)["refresh_token"], "rotated")
        self.assertEqual(self.auth._credentials(second)["access_token"], "access")
        with patch("httpx.get", return_value=httpx.Response(200, json={"revocation_endpoint": ISSUER + "/revoke"})), patch(
                "httpx.post", return_value=httpx.Response(200)):
            self.assertEqual(self.auth.logout(first), {"revoked": True})
        profile = self.auth.data["profiles"][first]
        self.assertEqual(profile["client_id"], "issued-client")
        self.assertNotIn("refresh_token", profile)
        with self.assertRaisesRegex(ModelError, "sign_in_required"):
            self.auth.access_token()

    def test_refresh_serializes_across_runtimes_and_uses_rotated_token(self):
        self.assertTrue(self.finish())
        profile = self.auth.data["profiles"][self.auth.data["active"]]
        profile["expires_at"] = time.time() - 10
        self.auth._save()
        second = ChatGPTAuth(self.tmp.name, self.auth.secrets)
        results = []
        def refresh(_):
            time.sleep(.02)
            return self.tokens(access_token="renewed", refresh_token="rotated")
        with patch.object(ChatGPTAuth, "_token", side_effect=refresh) as token:
            threads = [threading.Thread(target=lambda auth=auth: results.append(auth.access_token())) for auth in [self.auth, second]]
            for thread in threads: thread.start()
            for thread in threads: thread.join(2)
            self.assertEqual(results, ["renewed", "renewed"])
            self.assertEqual(token.call_count, 1)
        self.assertEqual(second._credentials(second.data["active"])["refresh_token"], "rotated")

    def test_returning_signin_reuses_client_and_host_with_fresh_state(self):
        self.assertTrue(self.finish()); selected = self.auth.data["active"]
        self.auth.start(selected)
        params = parse_qs(urlparse(self.browser.call_args.args[0]).query)
        self.assertEqual(params["client_id"], ["issued-client"])
        self.assertNotIn("agent_name_hint", params)
        self.assertEqual(params["id_token_hint"], ["id"])
        with patch.object(self.auth, "_token", return_value=self.tokens()), patch.object(self.auth, "_identity", return_value=self.identity()):
            self.assertTrue(self.auth.finish({"state": [self.auth.pending["state"]], "code": ["code"]}))

    def test_jwt_signature_issuer_audience_expiry_nonce(self):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        claims = {"iss": ISSUER, "sub": "account", "aud": "issued", "nonce": "nonce", "exp": time.time() + 60}
        with patch("httpx.get", return_value=httpx.Response(200, json={"issuer": ISSUER, "jwks_uri": ISSUER + "/jwks"})), patch(
                "jwt.PyJWKClient") as jwks:
            jwks.return_value.get_signing_key_from_jwt.return_value = NS(key=key.public_key())
            encoded = jwt.encode(claims, key, algorithm="RS256")
            self.assertEqual(self.auth._identity(encoded, "issued", "nonce")["sub"], "account")
            for change in [{"iss": "https://evil.example"}, {"aud": "wrong"}, {"exp": 1}, {"nonce": "wrong"}]:
                with self.subTest(change=change), self.assertRaises(Exception):
                    self.auth._identity(jwt.encode({**claims, **change}, key, algorithm="RS256"), "issued", "nonce")
            other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            with self.assertRaises(jwt.InvalidSignatureError):
                self.auth._identity(jwt.encode(claims, other, algorithm="RS256"), "issued", "nonce")


class ModelEndpointsTest(unittest.TestCase):
    def test_ui_only_settings_and_auth_and_safe_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            server = AgentdServer(("127.0.0.1", 0), "hook", "ui", events_token="events")
            server.models = ModelSettings(directory, MemorySecrets())
            pings = []
            server.character_agent = NS(semantic=NS(run=lambda purpose, prompt, context: pings.append(purpose) or {
                "backend": "codex", "model": "kernel-model"}), settings=NS(snapshot=lambda: {"backend": "codex"}),
                cancel=lambda reason: None, close=lambda: None)
            thread = serve_in_thread(server)
            try:
                def call(method, path, token, body=None):
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
                    connection.request(method, path, body=json.dumps(body) if body is not None else None,
                                       headers={"Authorization": "Bearer " + token})
                    response = connection.getresponse(); status, data = response.status, json.loads(response.read())
                    connection.close(); return status, data
                for token in ("hook", "events", "wrong"):
                    self.assertEqual(call("GET", "/model/settings", token)[0], 401)
                    self.assertEqual(call("POST", "/model/settings", token, {"provider": "openai"})[0], 401)
                    self.assertEqual(call("POST", "/model/chatgpt/start", token, {})[0], 401)
                status, data = call("POST", "/model/settings", "ui", {"provider": "openai", "api_key": "private", "model": "test"})
                self.assertEqual(status, 200)
                self.assertNotIn("private", json.dumps(data))
                status, data = call("POST", "/model/test", "ui", {})
                self.assertEqual((status, {k: v for k, v in data.items() if k != "elapsed_ms"}),
                                 (200, {"ok": True, "kernel": "codex", "provider": None, "model": "kernel-model",
                                        "tokens": None, "cost_usd": None}))
                self.assertIsInstance(data["elapsed_ms"], int)
                self.assertEqual(pings, ["review"])
                with patch.object(server.character_agent.semantic, "run", side_effect=ValueError("unsupported_harness")):
                    self.assertEqual(call("POST", "/model/test", "ui", {}), (400, {"error": "unsupported_harness"}))
                with patch.object(server.character_agent.semantic, "run", side_effect=RuntimeError("private request body")):
                    self.assertEqual(call("POST", "/model/test", "ui", {}), (502, {"error": "provider_request_failed"}))
            finally:
                server.shutdown(); server.server_close(); server.models.auth.cancel()

    def test_catalog_of_a_pi_service_comes_from_the_pi_runner(self):
        listing = {"providers": [{"id": "deepseek", "name": "DeepSeek"}], "models": [{
            "id": "deepseek-flash", "name": "DeepSeek V4.1 Flash", "context_window": 1000000, "max_tokens": 384000,
            "input": ["text", "image"], "reasoning": True, "thinking_levels": ["off", "low", "high", "max"], "priced": True}]}
        with tempfile.TemporaryDirectory() as directory:
            server = AgentdServer(("127.0.0.1", 0), "hook", "ui", events_token="events")
            server.models = ModelSettings(directory, MemorySecrets())
            server.models.save({"provider": "deepseek"})
            server.character_agent = NS(cancel=lambda reason: None, close=lambda: None)
            serve_in_thread(server)
            try:
                with patch("character_agent.harness.registry.pi_catalog", return_value=listing) as catalog:
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
                    connection.request("POST", "/model/catalog", body="{}", headers={"Authorization": "Bearer ui"})
                    response = connection.getresponse(); status, data = response.status, json.loads(response.read())
                    connection.close()
                    with patch("character_agent.harness.registry.pi_catalog", side_effect=ValueError("pi_runtime_unavailable")):
                        connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
                        connection.request("POST", "/model/catalog", body="{}", headers={"Authorization": "Bearer ui"})
                        failed = connection.getresponse(); failure = (failed.status, json.loads(failed.read()))
                        connection.close()
            finally:
                server.shutdown(); server.server_close(); server.models.auth.cancel()
        self.assertEqual((status, data), (200, listing))
        self.assertEqual(catalog.call_args.args, (server.character_agent, "deepseek"))
        self.assertEqual(failure, (400, {"error": "pi_runtime_unavailable"}))

    def test_pi_test_runs_the_main_connection_and_reports_what_it_used(self):
        main = {"backend": "pi", "provider": "", "model": "", "auth_source": "existing_login",
                "routes": {"judge": {"backend": "codex", "acp_agent": None, "model": None, "effort": None}}}
        used, recorded = [], []

        class Session:
            def stream(self, prompt, **options):
                yield {"type": "ready", "model": "deepseek-flash"}
                yield {"type": "result", "success": True, "final_text": '{"ok":true}', "model": "deepseek-flash",
                       "usage": {"input_tokens": 12, "output_tokens": 3, "cache_read_input_tokens": 0,
                                 "cache_creation_input_tokens": 0}, "cost_usd": 0.0000072}
            def close(self): pass
        with tempfile.TemporaryDirectory() as directory:
            server = AgentdServer(("127.0.0.1", 0), "hook", "ui", events_token="events")
            server.models = ModelSettings(directory, MemorySecrets())
            server.usage = NS(record=lambda *args, **kwargs: recorded.append(kwargs))
            server.character_agent = NS(
                semantic=NS(run=lambda *args: self.fail("the Pi test must not take a semantic route"), usage=None),
                settings=NS(snapshot=lambda: main), route_error=lambda config: None,
                _pi_connection=lambda config: {"provider": "deepseek", "auth_source": "api_key"},
                _session_factory=lambda definitions, config, native_tools: used.append((definitions, config, native_tools)) or Session(),
                _model=lambda config: "", cancel=lambda reason: None, close=lambda: None)
            serve_in_thread(server)
            try:
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
                connection.request("POST", "/model/test", body="{}", headers={"Authorization": "Bearer ui"})
                response = connection.getresponse(); status, data = response.status, json.loads(response.read())
                connection.close()
            finally:
                server.shutdown(); server.server_close(); server.models.auth.cancel()
        self.assertEqual(status, 200, data)
        self.assertEqual(used, [([], main, False)])
        self.assertEqual({k: v for k, v in data.items() if k != "elapsed_ms"},
                         {"ok": True, "kernel": "pi", "provider": "deepseek", "model": "deepseek-flash",
                          "tokens": {"input_tokens": 12, "output_tokens": 3, "cache_read_input_tokens": 0,
                                     "cache_creation_input_tokens": 0}, "cost_usd": 0.0000072})
        self.assertIsInstance(data["elapsed_ms"], int)
        self.assertEqual([(r["provider"], r["cost_usd"], r["cost_source"]) for r in recorded],
                         [("deepseek", 0.0000072, "sdk_estimate")])


if __name__ == "__main__":
    unittest.main()
