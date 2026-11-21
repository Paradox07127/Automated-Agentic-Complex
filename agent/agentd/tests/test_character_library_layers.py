"""Optional outfit layers and appearance fields in c7/pack.json are checked at install."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from character_library import Library, Package, PackageError, write_json
from test_character_library import fixture

MESHES = [{"mesh": "body"}, {"mesh": "weapon", "appearances": ["armed"]}, {"mesh": "coat"}, {"mesh": "charm"}]
LAYERS = [{"id": "coat", "name": "外套", "meshes": ["coat"]}, {"id": "charm", "name": "饰品", "meshes": ["charm"], "appearances": ["default"]}]


def layered(root, layers=None, appearances=None):
    """The weapon fixture with its palette, appearances and layers rewritten and every hash chained up again."""
    doc = fixture(root, weapon=True)
    def rewrite(path, value):
        data = (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode()
        (root / path).write_bytes(data)
        ref = dict(file=path, sha256=hashlib.sha256(data).hexdigest(), byte_count=len(data))
        doc["inventory"] = [ref if r["file"] == path else r for r in doc["inventory"]]
        return ref
    def runtime(ref): return dict(ref, file=ref["file"][len("runtime/"):])
    bundle = json.loads((root / "runtime/bundle.json").read_text(encoding="utf-8"))
    pack = json.loads((root / "runtime/pack.json").read_text(encoding="utf-8"))
    palette = runtime(rewrite("runtime/animation/palette.json", {"meshes": MESHES}))
    pack["animation"]["palette_contract"] = dict(palette, file="palette.json")
    if appearances is not None: pack["appearances"] = appearances
    if layers is not None: pack["layers"] = layers
    c7 = runtime(rewrite("runtime/pack.json", pack))
    bundle["files"] = [{"animation/palette.json": palette, "pack.json": c7}.get(r["file"], r) for r in bundle["files"]]
    bundle["characters"][0]["c7"] = c7
    doc["components"]["render"]["native_bundle"] = rewrite("runtime/bundle.json", bundle)
    write_json(root / "character.json", doc)


class CharacterLibraryLayerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_valid_layers_and_appearance_fields_install(self):
        src = self.root / "source"
        layered(src, LAYERS, [{"id": "default", "name": "默认", "desc": "原装", "kind": "original"},
            {"id": "armed", "name": "持械", "kind": "imported", "source": {"format": "efmi", "fingerprint": "b" * 64,
             "mod_name": "x", "imported_at": "2026-11-15T00:00:00Z"}}])
        library = Library(self.root / "library"); library.install(src)
        self.assertEqual(library.entries()[0]["id"], "fixture")

    def test_pack_without_layers_still_installs(self):
        src = self.root / "source"; layered(src)
        Package(src)

    def test_bad_layers_are_rejected(self):
        for name, layers in [("overlap", [LAYERS[0], dict(LAYERS[1], meshes=["charm", "coat"])]),
                             ("unknown", [dict(LAYERS[0], meshes=["missing"])]),
                             ("weapon", [dict(LAYERS[0], id="weapon")])]:
            with self.subTest(name):
                src = self.root / name; layered(src, layers)
                with self.assertRaisesRegex(PackageError, "^invalid_layers$"): Package(src)

    def test_bad_appearance_kind_is_rejected(self):
        src = self.root / "kind"; layered(src, appearances=[{"id": "default", "kind": "modded"}, {"id": "armed"}])
        with self.assertRaisesRegex(PackageError, "^invalid_appearances$"): Package(src)


if __name__ == "__main__":
    unittest.main()
