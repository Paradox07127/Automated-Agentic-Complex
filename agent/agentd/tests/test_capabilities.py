import json
from pathlib import Path
import socket
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from models.capabilities import collect
from models.model_backends import ModelSettings


def no_network(*_, **__):
    raise AssertionError("network call during collect")


def models(provider="anthropic", has_key=True, error=None, chatgpt=None):
    backends = {p: {"has_key": has_key if p == provider else False} for p in ("anthropic", "openai", "compatible", "chatgpt")}
    public = {"provider": provider, "backends": backends, "error": error,
              "chatgpt": chatgpt or {"active": None, "pending": False, "error": None, "profiles": []}}
    return NS(public=lambda: public)


def server(**overrides):
    fields = dict(models=models(), mouth=object(),
                  speech=object(), muted=False, _speech_failed=None, _tts_last=None,
                  consent=consent({"window_text": True, "page_text": False, "screenshots": False}))
    fields.update(overrides)
    return NS(**fields)


def consent(saved, started=None):
    started = saved if started is None else started
    return NS(capabilities=lambda: dict(started), snapshot=lambda: (dict(saved), 1))


def item(snapshot, name):
    entry = snapshot["items"][name]
    return entry["state"], entry["reason"]


def profile(connected, sharing):
    return {"active": "p", "pending": False, "error": None,
            "profiles": [{"id": "p", "label": "", "email": "", "connected": connected, "sharing": sharing}]}


class CollectTest(unittest.TestCase):
    def setUp(self):
        guards = [patch.object(httpx.Client, "send", no_network), patch.object(httpx.AsyncClient, "send", no_network),
                  patch.object(socket.socket, "connect", no_network)]
        for guard in guards:
            guard.start()
            self.addCleanup(guard.stop)

    def test_shape(self):
        snapshot = collect(server())
        self.assertIsInstance(snapshot["at"], str)
        for entry in snapshot["items"].values():
            self.assertIn(entry["state"], ("configured", "ready", "degraded", "unavailable", "unknown"))
        self.assertNotIn("images", snapshot["items"])

    def test_generation(self):
        for name, fake, expected in (
                ("error", models(error="settings_unreadable"), ("degraded", "settings_unreadable")),
                ("no key", models(has_key=False), ("unavailable", "missing_api_key")),
                ("key", models(), ("configured", None)),
                ("compatible", models("compatible", has_key=False), ("configured", None)),
                ("chatgpt signed out", models("chatgpt"), ("unavailable", "sign_in_required")),
                ("chatgpt no plan", models("chatgpt", chatgpt=profile(True, False)), ("unavailable", "plan_usage_not_enabled")),
                ("chatgpt", models("chatgpt", chatgpt=profile(True, True)), ("configured", None))):
            with self.subTest(name):
                self.assertEqual(item(collect(server(models=fake)), "generation"), expected)

    def test_mouth(self):
        self.assertEqual(item(collect(server(mouth=None)), "mouth"), ("unavailable", "no_llm"))
        self.assertEqual(item(collect(server()), "mouth"), ("ready", None))

    def test_voice(self):
        failed = {"speech_id": "s", "reason": "tts_failed", "at": "t1"}
        for name, fields, expected in (
                ("no relay", dict(speech=None), ("unavailable", "no_tts")),
                ("muted", dict(muted=True, _speech_failed=failed, _tts_last={"result": "tts_failed", "at": "t1"}), ("configured", "muted")),
                ("failed", dict(_speech_failed=failed, _tts_last={"result": "tts_failed", "at": "t1"}), ("degraded", "tts_failed")),
                ("failed then spoke", dict(_speech_failed=failed, _tts_last={"result": "complete", "at": "t2"}), ("ready", None)),
                ("ready", {}, ("ready", None))):
            with self.subTest(name):
                self.assertEqual(item(collect(server(**fields)), "voice"), expected)

    def test_shares(self):
        snapshot = collect(server())
        self.assertEqual(item(snapshot, "share_window_text"), ("configured", None))
        self.assertEqual(item(snapshot, "share_page_text"), ("unavailable", "off"))
        self.assertEqual(item(snapshot, "share_screenshots"), ("unavailable", "off"))

    def test_shares_follow_saved_consent(self):
        started = {"window_text": True, "page_text": True, "screenshots": True, "typed_text": True}
        snapshot = collect(server(consent=consent({**started, "window_text": False}, started)))
        self.assertEqual(item(snapshot, "share_window_text"), ("unavailable", "off"))
        self.assertEqual(item(snapshot, "share_page_text"), ("configured", None))

    def test_missing_attributes_are_unknown(self):
        snapshot = collect(NS())
        for name in ("generation", "mouth", "voice"):
            self.assertEqual(item(snapshot, name), ("unknown", "not_running"), name)
        unset = collect(server(models=None))
        self.assertEqual(item(unset, "generation"), ("unknown", "not_running"))

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_real_settings_credential_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model-settings.json"
            path.write_text(json.dumps(
                {"provider": "anthropic", "backends": {"anthropic": {"model": "m", "base_url": "https://api.anthropic.com", "api_key": "k"}}}), encoding="utf-8")
            path.chmod(0o644)
            real_models = ModelSettings(directory)
            fake = server(models=real_models)
            snapshot = collect(fake)
            self.assertEqual(item(snapshot, "generation"), ("degraded", "credential_permissions"))
            path.chmod(0o600)
            real_models.save({"provider": "anthropic", "api_key": "k"})
            snapshot = collect(fake)
            self.assertEqual(item(snapshot, "generation"), ("configured", None))


if __name__ == "__main__":
    unittest.main()
