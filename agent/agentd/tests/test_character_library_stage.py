"""The optional stage (interaction/stage.json and scene-gated palette rows) is checked at install."""
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

MESHES = [{"mesh": "body"}, {"mesh": "weapon", "appearances": ["armed"]},
          {"mesh": "stage:charinfo/floor", "contributes_to_visual_bounds": False, "scene": "charinfo"}]
STAGE = {"schema": "endfield-character-stage/v1", "id": "charinfo", "display": {"name": "角色信息展示台"},
         "box": {"aspect": 16 / 9, "height_fraction": 0.6, "floor_v": 0.1}, "meshes": ["stage:charinfo/floor"],
         "camera_hint": {"position": [0, 1.38, 4.966], "look_at": [0, 0.82, 0]},
         "limits": {"min_camera_height_m": 0.2, "max_camera_distance_m": 15},
         "excluded": [{"node": "CharInfo_Scene/Mesh/SphereOutside", "reason": "hgbuffer_needs_deferred_lighting"}],
         "source_identity": {"prefab": "assets/charinfochar.prefab", "cab": "cab-x", "path_id": "1",
                             "source_manifest_sha256": ["a" * 64]}}


def staged(root, meshes=MESHES, stage=STAGE):
    """The weapon fixture with its palette rewritten and, unless stage is None, stage.json listed in interaction.data."""
    doc = fixture(root, weapon=True)
    def rewrite(path, value):
        data = (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode()
        (root / path).parent.mkdir(parents=True, exist_ok=True); (root / path).write_bytes(data)
        ref = dict(file=path, sha256=hashlib.sha256(data).hexdigest(), byte_count=len(data))
        doc["inventory"] = [r for r in doc["inventory"] if r["file"] != path] + [ref]
        return ref
    def runtime(ref): return dict(ref, file=ref["file"][len("runtime/"):])
    bundle = json.loads((root / "runtime/bundle.json").read_text(encoding="utf-8"))
    pack = json.loads((root / "runtime/pack.json").read_text(encoding="utf-8"))
    palette = runtime(rewrite("runtime/animation/palette.json", {"meshes": meshes}))
    pack["animation"]["palette_contract"] = dict(palette, file="palette.json")
    files = {"animation/palette.json": palette}
    if stage is not None:
        ref = files["interaction/stage.json"] = runtime(rewrite("runtime/interaction/stage.json", stage))
        pack["interaction"] = {"data": [dict(ref, file="stage.json")]}
    c7 = files["pack.json"] = runtime(rewrite("runtime/pack.json", pack))
    bundle["files"] = [r for r in bundle["files"] if r["file"] not in files] + list(files.values())
    bundle["characters"][0]["c7"] = c7
    doc["components"]["render"]["native_bundle"] = rewrite("runtime/bundle.json", bundle)
    write_json(root / "character.json", doc)


class CharacterLibraryStageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_valid_stage_installs(self):
        src = self.root / "source"; staged(src)
        library = Library(self.root / "library"); library.install(src)
        self.assertEqual(library.entries()[0]["id"], "fixture")

    def test_package_without_stage_still_installs(self):
        for name, meshes in [("plain", MESHES[:2]), ("scene_rows", MESHES)]:
            with self.subTest(name):
                src = self.root / name; staged(src, meshes, None)
                Package(src)
        src = self.root / "old"; fixture(src)
        Package(src)

    def test_stage_missing_a_required_field_is_rejected(self):
        for field in STAGE:
            with self.subTest(field):
                src = self.root / field; staged(src, stage={k: v for k, v in STAGE.items() if k != field})
                with self.assertRaisesRegex(PackageError, "^invalid_stage$"): Package(src)

    def test_stage_with_a_bad_field_is_rejected(self):
        for name, change in [("schema", dict(schema="endfield-character-stage/v2")), ("display", dict(display={"name": ""})),
                             ("meshes", dict(meshes=[])), ("box", dict(box=dict(STAGE["box"], aspect="16:9"))),
                             ("camera_hint", dict(camera_hint={"position": [0, 1], "look_at": [0, 0.82, 0]})),
                             ("limits", dict(limits={"min_camera_height_m": True, "max_camera_distance_m": 15})),
                             ("excluded", dict(excluded=[{"node": "x"}]))]:
            with self.subTest(name):
                src = self.root / name; staged(src, stage=dict(STAGE, **change))
                with self.assertRaisesRegex(PackageError, "^invalid_stage$"): Package(src)

    def test_palette_scene_must_be_a_string(self):
        for name, scene in [("number", 1), ("empty", ""), ("null", None)]:
            with self.subTest(name):
                src = self.root / name; staged(src, MESHES[:2] + [dict(MESHES[2], scene=scene)], None)
                with self.assertRaisesRegex(PackageError, "^invalid_palette_scene$"): Package(src)


if __name__ == "__main__":
    unittest.main()
