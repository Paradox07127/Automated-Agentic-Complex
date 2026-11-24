"""Save through the settings handlers, then inspect every file in a fresh state directory."""
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from voice.credential import TtsCredential
from infra.secrets import MemorySecrets
from api.speech import SpeechMixin
from models.model_backends import ModelSettings
from motion.settings import MotionSettings


class CredentialStorageTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name)
        self.store = MemorySecrets()

    def assert_private(self, *values):
        for path in self.state.rglob("*"):
            if path.is_file():
                for value in values:
                    with self.subTest(path=path.name, credential=value):
                        self.assertNotIn(value.encode(), path.read_bytes())

    def test_provider_keys(self):
        settings = ModelSettings(self.state, self.store)
        for provider, extra in (("openai", {}), ("pi_catalog", {"pi_provider": "groq"})):
            key = "dummy-private-" + provider
            settings.save({"provider": provider, "model": "m", **extra})
            settings.save({"provider": provider, "api_key": key, **extra})
            self.assertEqual(settings.connection()[2], key)
        self.assertEqual(ModelSettings(self.state, self.store).connection()[2], "dummy-private-pi_catalog")
        self.assert_private("dummy-private-openai", "dummy-private-pi_catalog")

    def test_oauth_tokens(self):
        auth = ModelSettings(self.state, self.store).auth
        auth.pending = {"id": "profile", "state": "state", "client_id": None, "verifier": "v", "nonce": "n",
                        "redirect": "http://localhost/", "expires": time.time() + 60}
        tokens = {key: "dummy-private-" + key for key in ("access_token", "refresh_token", "id_token")}
        with patch.object(auth, "_token", return_value={**tokens, "expires_in": 3600, "token_type": "Bearer",
                                                       "scope": "chatgpt.tokens.use.direct"}), patch.object(
                auth, "_identity", return_value={"sub": "account", "iss": "issuer", "email": "user@example.com"}):
            self.assertTrue(auth.finish({"state": ["state"], "code": ["code"], "client_id": ["client"]}))
        self.assertEqual(auth.access_token(), tokens["access_token"])
        profile = auth.data["active"]
        auth.data["profiles"][profile]["expires_at"] = 0
        auth._save()
        reopened = ModelSettings(self.state, self.store).auth
        with patch.object(reopened, "_token", return_value={"access_token": "new-dummy-access", "token_type": "bearer",
                                                           "expires_in": 3600}) as refresh:
            self.assertEqual(reopened.access_token(), "new-dummy-access")
        self.assertEqual(refresh.call_args.args[0]["refresh_token"], tokens["refresh_token"])
        self.assert_private(*tokens.values(), "new-dummy-access")
        with patch("httpx.get") as discover, patch("httpx.post") as revoke:
            discover.return_value.json.return_value = {"revocation_endpoint": "https://auth.openai.com/revoke"}
            revoke.return_value.status_code = 200
            self.assertEqual(reopened.logout(profile), {"revoked": True})
        self.assertFalse(self.store._values)
        self.assertFalse(reopened.state()["profiles"][0]["connected"])

    def test_motion_token(self):
        motion = MotionSettings(self.state, self.store)
        key = "dummy-private-motion"
        status, public = motion.update({"backend": "generated", "token": key})
        self.assertEqual((status, public["token_set"], motion.token()), (200, True, key))
        self.assert_private(key)

    def test_tts_token(self):
        handler = SpeechMixin()
        handler._json = Mock()
        handler.server = SimpleNamespace(tts_credential=TtsCredential(self.state / "tts-token", self.store), speech=SimpleNamespace())
        key = "dummy-private-tts"
        handler._voice_token({"token": key})
        handler._json.assert_called_once_with(200, {"ok": True})
        self.assertEqual(handler.server.speech.token, key)
        self.assert_private(key)

    def test_tts_address_change_discards_the_stored_token(self):
        path = self.state / "tts-token"
        handler = SpeechMixin()
        handler._json = Mock()
        handler.server = SimpleNamespace(tts_credential=TtsCredential(path, self.store), speech=SimpleNamespace())
        handler._voice_token({"token": "old-service"})
        handler.server.tts_credential.ref.rename(path.with_suffix(".revoked"))
        self.assertIsNone(handler.server.tts_credential.get())
        self.assertFalse(self.store._values)
        self.assertFalse(path.with_suffix(".revoked").exists())

    def test_provider_store_failure_reaches_settings(self):
        from api.settings import SettingsMixin
        from models.model_auth import ModelError
        handler = SettingsMixin()
        handler._json = Mock()
        models = ModelSettings(self.state, self.store)
        models.secrets = Mock()
        models.secrets.put.side_effect = ModelError("secret_store_unavailable")
        handler.server = SimpleNamespace(models=models, character_agent=None)
        handler._models_post("/model/settings", {"provider": "openai", "api_key": "dummy-private-failed"})
        handler._json.assert_called_once_with(400, {"error": "secret_store_unavailable"})
        self.assert_private("dummy-private-failed")

    def test_failed_delete_can_be_retried(self):
        from infra.secrets import ModelError
        settings = ModelSettings(self.state, self.store)
        settings.save({"provider": "openai", "api_key": "dummy-private-key"})
        motion = MotionSettings(self.state, self.store)
        service = {"backend": "generated"}
        motion.update({**service, "token": "dummy-private-motion"})
        with patch.object(self.store, "delete", side_effect=ModelError("secret_store_unavailable")):
            with self.assertRaisesRegex(ModelError, "secret_store_unavailable"):
                settings.save({"provider": "openai", "clear_key": True})
            with self.assertRaisesRegex(ModelError, "secret_store_unavailable"):
                motion.update({**service, "token": ""})
        ModelSettings(self.state, self.store).save({"provider": "openai", "clear_key": True})
        MotionSettings(self.state, self.store).update({**service, "token": ""})
        self.assertFalse(self.store._values)
