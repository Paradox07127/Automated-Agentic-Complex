"""Settings files that become readable again are picked up without a restart or a save."""
import copy
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from infra.secrets import MemorySecrets
from fsutil import atomic_write_json
from models.model_auth import ModelError
from models.model_backends import DEFAULTS, ModelSettings


class SettingsReloadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = self.tmp.name

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_model_settings_recover_after_permissions_are_fixed(self):
        path = Path(self.directory, "model-settings.json")
        backends = copy.deepcopy(DEFAULTS)
        backends["compatible"].update(model="local-model")
        atomic_write_json(path, {"provider": "compatible", "backends": backends})
        os.chmod(path, 0o644)
        settings = ModelSettings(self.directory, MemorySecrets())
        public = settings.public()
        self.assertEqual(public["error"], "credential_permissions")
        self.assertEqual(public["provider"], "chatgpt")  # unreadable settings run on the defaults
        os.chmod(path, 0o600)
        public = settings.public()
        self.assertIsNone(public["error"])
        self.assertEqual(public["provider"], "compatible")
        try:
            settings.connection()
        except ModelError as error:
            self.assertNotEqual(str(error), "credential_permissions")

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_still_unreadable_keeps_error_and_revision(self):
        model_path = Path(self.directory, "model-settings.json")
        atomic_write_json(model_path, {"provider": "anthropic", "backends": copy.deepcopy(DEFAULTS)})
        os.chmod(model_path, 0o644)
        models = ModelSettings(self.directory, MemorySecrets())
        self.assertEqual(models.public()["error"], "credential_permissions")
        self.assertEqual(models.public()["error"], "credential_permissions")


if __name__ == "__main__":
    unittest.main()
