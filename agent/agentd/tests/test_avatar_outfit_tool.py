"""avatar_outfits_list and avatar_outfit: she changes her own worn appearance, layers or mod switches through Companion,
which answers each `/feed` `looks` event with POST /avatar/looks/receipts."""
import hashlib
import json
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from brain.characters import Repository  # noqa: E402
from character_library import Library, write_json  # noqa: E402
from route_registry import REGISTRY, UI  # noqa: E402
from tool_gateway.registry import BUILTIN, REGISTRY as TOOLS  # noqa: E402
import test_character_agent_integration as integration  # noqa: E402
from test_character_library_mod_settings import TABLE, modded  # noqa: E402

ROUTE_CLASSES = Path(__file__).resolve().parents[3] / "protocol" / "ui-bridge" / "routes.json"
LAYERS = [{"id": "cape", "name": "披风", "meshes": ["body"], "appearances": ["default", "mod_a"]}]
SETTINGS = [{"id": "coat", "name": "外套", "category": "clothing", "default": 0, "values": [{"value": 0, "name": "穿"}, {"value": 1, "name": "脱"}]},
            {"id": "color", "name": "配色", "default": 0,
             "values": [{"value": 0, "name": "1"}, {"value": 1, "name": "2"}, {"value": 2, "name": "3"}]}]


def with_layers(root, layers):
    """modded()'s source with a top-level layers[] in its pack.json, every digest of it rewritten."""
    def write(path, value):
        data = (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode()
        (root / path).write_bytes(data)
        return {"sha256": hashlib.sha256(data).hexdigest(), "byte_count": len(data)}
    read = lambda path: json.loads((root / path).read_text(encoding="utf-8"))  # noqa: E731
    doc, bundle, pack = read("character.json"), read("runtime/bundle.json"), read("runtime/pack.json")
    digest = write("runtime/pack.json", {**pack, "layers": layers})
    for ref in [bundle["characters"][0]["c7"], *[r for r in bundle["files"] if r["file"] == "pack.json"],
                *[r for r in doc["inventory"] if r["file"] == "runtime/pack.json"]]:
        ref.update(digest)
    digest = write("runtime/bundle.json", bundle)
    for ref in [doc["components"]["render"]["native_bundle"], *[r for r in doc["inventory"] if r["file"] == "runtime/bundle.json"]]:
        ref.update(digest)
    write_json(root / "character.json", doc)


class AvatarOutfitToolTest(integration.IntegrationFixture):
    def setUp(self):
        super().setUp()
        source, library = self.root / "source", self.root / "library"
        modded(source, TABLE)
        with_layers(source, LAYERS)
        Library(library).install(source)
        self.addCleanup(setattr, self.server, "characters", self.server.characters)
        self.addCleanup(setattr, self.server, "character", self.server.character)
        self.server.characters, self.server.character = Repository(library / "current.json"), "fixture"

    def native(self, name, args):
        return self.controller._native(name, args, run_id="turn-outfit", is_current=lambda: True)

    def looks(self):
        return [item["data"] for item in self.server.feed.since(0) if item["event"] == "looks"]

    def change(self, args):
        """Runs avatar_outfit on a thread; returns (the looks event it published, a function that joins it)."""
        result = {}
        thread = threading.Thread(target=lambda: result.update(value=self.native("avatar_outfit", args)), daemon=True)
        thread.start()
        deadline = time.monotonic() + 5
        while not self.looks():
            if time.monotonic() > deadline: self.fail("no looks event")
            time.sleep(.01)
        def joined():
            thread.join(5)
            self.assertFalse(thread.is_alive())
            return result["value"]
        return self.looks()[-1], joined

    def test_the_list_holds_the_packs_looks_and_no_current_before_a_receipt(self):
        self.assertEqual(self.native("avatar_outfits_list", {}), {
            "character": "fixture",
            "appearances": [{"id": "default"}, {"id": "armed"}, {"id": "mod_a", "name": "mod"}],
            "layers": [{"id": "cape", "name": "披风", "appearances": ["default", "mod_a"]}],
            "mod_settings": {"mod_a": {"settings": SETTINGS}},
            "current": None})

    def test_an_unknown_id_or_value_publishes_nothing(self):
        cases = [({"appearance": "gone"}, "unknown_appearance"),
                 ({"layers": {"hide": ["hat"], "show": []}}, "unknown_layer"),
                 ({"appearance": "mod_a", "layers": {"hide": [], "show": ["hat"]}}, "unknown_layer"),
                 ({"mods": {"appearance": "gone", "values": {"coat": 1}}}, "unknown_appearance"),
                 ({"mods": {"appearance": "default", "values": {"coat": 1}}}, "unknown_mod_setting"),
                 ({"mods": {"appearance": "mod_a", "values": {"hat": 1}}}, "unknown_mod_setting"),
                 ({"mods": {"appearance": "mod_a", "values": {"coat": 2}}}, "invalid_mod_value"),
                 ({"appearance": "mod_a", "mods": {"appearance": "mod_a", "values": {"coat": 1, "color": 7}}}, "invalid_mod_value")]
        for args, reason in cases:
            with self.subTest(args=args):
                self.assertEqual(self.native("avatar_outfit", {**args, "reason": "试试"}), {"ok": False, "reason": reason})
        self.assertEqual(self.looks(), [])

    def test_bad_arguments_are_refused(self):
        for args in ({}, {"reason": "换衣服"}, {"appearance": "mod_a"}, {"appearance": "mod_a", "reason": ""},
                     {"appearance": "mod_a", "reason": "x" * 201}, {"appearance": "mod_a", "reason": "x", "seconds": 3},
                     {"appearance": 1, "reason": "x"}, {"appearance": "", "reason": "x"},
                     {"layers": ["cape"], "reason": "x"}, {"layers": {"hide": "cape"}, "reason": "x"},
                     {"layers": {"hide": [], "show": []}, "reason": "x"}, {"layers": {"hide": ["cape"], "show": ["cape"]}, "reason": "x"},
                     {"layers": {"hide": ["cape"], "drop": []}, "reason": "x"},
                     {"mods": {"appearance": "mod_a"}, "reason": "x"}, {"mods": {"appearance": "mod_a", "values": {}}, "reason": "x"},
                     {"mods": {"appearance": "mod_a", "values": {"coat": True}}, "reason": "x"},
                     {"mods": {"appearance": "mod_a", "values": {"coat": 1.0}}, "reason": "x"}):
            with self.subTest(args=args):
                self.assertEqual(self.native("avatar_outfit", args), {"error": {"code": "invalid_arguments"}})
        self.assertEqual(self.native("avatar_outfits_list", {"character": "fixture"}), {"error": {"code": "invalid_arguments"}})
        self.assertEqual(self.looks(), [])

    def test_a_valid_call_publishes_one_looks_event_and_returns_its_receipt(self):
        event, joined = self.change({"appearance": "mod_a", "layers": {"hide": ["cape"]},
                                     "mods": {"appearance": "mod_a", "values": {"coat": 1}}, "reason": "下雨了"})
        self.assertRegex(event["request_id"], r"^[0-9a-f]{16}$")
        self.assertEqual(event, {"seq": event["seq"], "request_id": event["request_id"], "appearance": "mod_a",
                                 "layers": {"hide": ["cape"], "show": []},
                                 "mod_settings": {"appearance": "mod_a", "values": {"coat": 1}}})
        receipt = {"request_id": event["request_id"], "ok": True, "appearance": "mod_a", "values": {"coat": 1, "color": 0}}
        self.assertEqual(self.request("POST", "/avatar/looks/receipts", receipt), (200, {"applied": True}))
        self.assertEqual(joined(), {"ok": True, "appearance": "mod_a", "values": {"coat": 1, "color": 0}})
        self.assertEqual(len(self.looks()), 1)
        self.assertEqual(self.native("avatar_outfits_list", {})["current"], {"appearance": "mod_a", "values": {"coat": 1, "color": 0}})
        self.assertEqual(self.request("POST", "/avatar/looks/receipts", receipt), (200, {"applied": False}))

    def test_a_refusal_comes_back_with_its_reason(self):
        event, joined = self.change({"appearance": "armed", "reason": "要出门"})
        self.assertEqual(event, {"seq": event["seq"], "request_id": event["request_id"], "appearance": "armed"})
        self.assertEqual(self.request("POST", "/avatar/looks/receipts", {"request_id": event["request_id"], "ok": False,
            "reason": "switching", "appearance": "default", "values": {}}), (200, {"applied": True}))
        self.assertEqual(joined(), {"ok": False, "reason": "switching", "appearance": "default", "values": {}})

    def test_no_receipt_is_a_timeout_within_the_bound(self):
        with patch("character.looks.WAIT_S", 0.2):
            started = time.monotonic()
            self.assertEqual(self.native("avatar_outfit", {"appearance": "armed", "reason": "要出门"}),
                             {"ok": False, "reason": "timeout"})
        self.assertLess(time.monotonic() - started, 2)
        [event] = self.looks()
        # A late receipt still tells her what she wears.
        self.assertEqual(self.request("POST", "/avatar/looks/receipts", {"request_id": event["request_id"], "ok": True,
            "appearance": "armed", "values": {}}), (200, {"applied": True}))
        self.assertEqual(self.native("avatar_outfits_list", {})["current"], {"appearance": "armed", "values": {}})

    def test_a_bad_or_unknown_receipt(self):
        good = {"request_id": "0123456789abcdef", "ok": True, "appearance": "mod_a", "values": {"coat": 1}}
        for body in ([], {**good, "extra": 1}, {k: v for k, v in good.items() if k != "values"}, {**good, "request_id": ""},
                     {**good, "ok": "yes"}, {**good, "reason": 3}, {**good, "appearance": 3}, {**good, "values": {"coat": True}},
                     {**good, "values": []}):
            with self.subTest(body=body):
                self.assertEqual(self.request("POST", "/avatar/looks/receipts", body), (400, {"error": "invalid_receipt"}))
        self.assertEqual(self.request("POST", "/avatar/looks/receipts", {**good, "appearance": None}), (200, {"applied": False}))
        self.assertEqual(self.native("avatar_outfits_list", {})["current"], None)

    def test_the_receipt_route_is_host_only(self):
        [route] = [r for r in REGISTRY if r.path == "/avatar/looks/receipts"]
        self.assertEqual((route.method, route.tokens, route.ui_class, route.surfaces), ("POST", UI, "host_only", ()))
        listed = [e for e in json.loads(ROUTE_CLASSES.read_text(encoding="utf-8")) if e["path"] == "/avatar/looks/receipts"]
        self.assertEqual(listed, [{"method": "POST", "path": "/avatar/looks/receipts", "class": "host_only", "surfaces": []}])
        self.assertEqual(self.request("POST", "/avatar/looks/receipts", {}, token="wrong")[0], 401)


class RegistryTest(unittest.TestCase):
    def test_both_tools_are_offered_like_avatar_motion(self):
        motion = BUILTIN["avatar_motion"]
        for name, effect in (("avatar_outfit", "embodied"), ("avatar_outfits_list", "read")):
            with self.subTest(name=name):
                spec = BUILTIN[name]
                self.assertEqual((spec.family, spec.effect, spec.grant, spec.callers, spec.modes, spec.receipt),
                                 (motion.family, effect, "none", motion.callers, motion.modes, False))
        names = [d["name"] for d in TOOLS.native_definitions(desktop=False)]
        self.assertEqual(names[-2:], ["avatar_outfits_list", "avatar_outfit"])
        tool = next(d for d in TOOLS.native_definitions(desktop=False) if d["name"] == "avatar_outfit")
        self.assertEqual(tool["input_schema"]["required"], ["reason"])
        self.assertIn("avatar_outfits_list", tool["description"])


if __name__ == "__main__":
    unittest.main()
