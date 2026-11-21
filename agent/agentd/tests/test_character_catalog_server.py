"""New silent role and old voiced roles share the real character switch server paths."""
from pathlib import Path
import tempfile
import unittest

from test_character_library import fixture
from character_library import Library
from brain.characters import Repository
import test_server as helpers


class CatalogSwitchTest(helpers.FeedServerCase):
    request = helpers.SayTest.request
    prepare = helpers.CharacterSwitchTest.prepare
    commit = helpers.CharacterSwitchTest.commit
    abort = helpers.CharacterSwitchTest.abort
    def setUp(self):
        super().setUp()
        self.server.mouth = helpers.FakeMouth(["[intent:greet]嗯。"])
        self.server.mouth.history = [["u", "live", "a"]]
        self.server.speech = helpers.FakeRelay()
        self.server.speech.character, self.server.speech.language = "voice_a", "zh"
        self.server.mouth_factory = lambda cid: helpers.FakeMouth(["[intent:greet]哼。"])
        self.packages = tempfile.TemporaryDirectory(); self.addCleanup(self.packages.cleanup)
        root = Path(self.packages.name); library = Library(root / "library")
        for cid in ("aster", "birch", "third"):
            source = root / cid; fixture(source, cid, voice=cid != "third"); library.install(source)
        self.server.characters = Repository(library.root / "current.json")

    def test_catalog_silent_switch_keeps_text_and_never_uses_previous_voice(self):
        status, prepared = self.prepare({"id": "third"})
        self.assertEqual(status, 200)
        self.assertEqual(self.commit(prepared["switch_id"])[0], 200)
        self.assertEqual(self.server.character, "third")
        self.assertTrue(self.server._text_only("text"))
        self.assertFalse(self.server.character_voice_enabled)
        self.assertEqual(self.server.mouth.history, [["u", "live", "a"]])
        self.server.set_character("aster")
        self.assertTrue(self.server.character_voice_enabled)
        self.assertFalse(self.server._text_only("text"))
        self.assertEqual((self.server.speech.character, self.server.speech.language), ("aster", "zh"))
        self.server.set_character("birch")
        self.assertEqual(self.server.speech.character, "birch")

    def test_catalog_abort_keeps_old_persona_and_voice(self):
        _, prepared = self.prepare({"id": "third"})
        self.assertEqual(self.abort(prepared["switch_id"])[0], 200)
        self.assertEqual(self.server.character, "aster")
        self.assertTrue(self.server.character_voice_enabled)
        self.assertEqual(self.server.speech.character, "voice_a")


if __name__ == "__main__": unittest.main()
