"""GET /characters/<id>/mod-settings answers the settings of the installed pack's interaction/mod-settings.json."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from brain.characters import Repository
from character_library import Library
import support
from test_character_binding import BindingCase
from test_character_library_mod_settings import TABLE, modded
import test_server as helpers

SETTINGS = [{"id": "coat", "name": "外套", "category": "clothing", "default": 0, "values": [{"value": 0, "name": "穿"}, {"value": 1, "name": "脱"}]},
            {"id": "color", "name": "配色", "default": 0,
             "values": [{"value": 0, "name": "1"}, {"value": 1, "name": "2"}, {"value": 2, "name": "3"}]}]


class ModSettingsRouteTest(BindingCase):
    def install(self, table):
        source, self.library = self.state_dir / "source", self.state_dir / "library"
        modded(source, table)
        Library(self.library).install(source)
        self.server.characters = Repository(self.library / "current.json")
        return self.server.characters.package("fixture")

    def test_the_settings_of_each_appearance(self):
        sha = self.install(TABLE).sha256
        self.assertEqual(self.request("GET", "/characters/fixture/mod-settings"),
                         (200, {"character": "fixture", "package_sha256": sha, "schema": "endfield-mod-settings/v1",
                                "appearances": {"mod_a": {"settings": SETTINGS}}}))

    def test_a_pack_without_a_table(self):
        sha = self.install(None).sha256
        self.assertEqual(self.request("GET", "/characters/fixture/mod-settings"),
                         (200, {"character": "fixture", "package_sha256": sha, "schema": "endfield-mod-settings/v1",
                                "appearances": {}}))

    def test_unknown_character(self):
        self.install(TABLE)
        self.assertEqual(self.request("GET", "/characters/unknown/mod-settings"), (404, {"error": "unknown_character"}))

    def test_a_table_changed_after_install(self):
        package = self.install(TABLE)
        path = package.root / "runtime/interaction/mod-settings.json"
        data = bytearray(path.read_bytes()); data[-2] ^= 1; path.write_bytes(bytes(data))
        self.assertEqual(self.request("GET", "/characters/fixture/mod-settings"), (409, {"error": "component_sha_mismatch"}))

    def test_only_the_ui_token_reads_it(self):
        self.install(TABLE)
        for token in (None, helpers.HOOK, helpers.EVENTS):
            self.assertEqual(self.request("GET", "/characters/fixture/mod-settings", token=token),
                             (401, {"error": "unauthorized"}))
        self.assertEqual(self.request("GET", "/characters/fixture/mod-settings", token=support.UI)[0], 200)


if __name__ == "__main__":
    unittest.main()
