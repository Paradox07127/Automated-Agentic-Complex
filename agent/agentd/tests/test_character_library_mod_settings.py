"""The optional mod settings table (interaction/mod-settings.json) and the manifest's texture_variants are checked at install."""
import copy
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
import pool_codec

MESH = "outfit:mod_a/S_actor_x_cloth_01_lod0"
IB = "1" * 64
SPEC = {"name": "T_cloth_01_D", "width": 512, "height": 512, "mip_count": 10, "rd_format_name": "BC7_SRGB_BLOCK",
        "storage_color_space_raw": 1}


def draw(pass_name, mesh=MESH, indices=IB, index_count=6000):
    return {"mesh": mesh, "pass_name": pass_name, "index_count": index_count, "index_component_bytes": 2,
            "indices": {"file": "Files/" + indices + ".bytes", "sha256": indices, "byte_count": index_count * 2},
            "resources": [{"set": 1, "binding": 1, "category": "separate_images", "names": ["_BaseMap"],
                           "reflected_type": "texture2D", "texture": SPEC, "file": "Files/" + "2" * 64 + ".bytes",
                           "sha256": "2" * 64, "byte_count": 64},
                          {"set": 0, "binding": 47, "category": "separate_images", "names": ["_CameraDepthTexture"],
                           "reflected_type": "texture2D"}]}


DRAWS = [draw("PreGBuffer"), draw("ForwardLit"), draw("PreGBuffer", "body", "3" * 64, 300)]
VARIANTS = [{"id": "mod_a/cloth_01/_BaseMap/1", "mesh": MESH, "resource_names": ["_BaseMap"], "texture": SPEC},
            {"id": "mod_a/cloth_01/_BaseMap/2", "mesh": MESH, "resource_names": ["_BaseMap"], "texture": SPEC}]
TABLE = {"schema": "endfield-mod-settings/v1", "appearances": {"mod_a": {
    "settings": [
        {"id": "coat", "name": "外套", "category": "clothing", "default": 0, "values": [{"value": 0, "name": "穿"}, {"value": 1, "name": "脱"}],
         "origin": {"section": "KeySwap_0", "variable": "$swapkey0", "key": "VK_F1", "type": "cycle"}},
        {"id": "color", "name": "配色", "default": 0,
         "values": [{"value": 0, "name": "1"}, {"value": 1, "name": "2"}, {"value": 2, "name": "3"}]}],
    "segments": [
        {"mesh": MESH, "indices_sha256": IB, "first": 0, "count": 3000, "visible_when": {"coat": [0]},
         "origin": {"section": "TextureOverride_Component1", "condition": "if $swapkey0 == 0"}},
        {"mesh": MESH, "indices_sha256": IB, "first": 3000, "count": 1200, "visible_when": {"coat": [1]}},
        {"mesh": MESH, "indices_sha256": IB, "first": 4200, "count": 1800, "visible_when": {}}],
    "textures": [
        {"mesh": MESH, "resource": "_BaseMap",
         "variants": [{"variant": "mod_a/cloth_01/_BaseMap/1", "when": {"color": [1]}},
                      {"variant": "mod_a/cloth_01/_BaseMap/2", "when": {"color": [2], "coat": [0, 1]}}]}]}}}


def modded(root, table=TABLE, variants=VARIANTS, draws=DRAWS, store=None):
    """The weapon fixture with a real source manifest, a mod_a appearance and, unless table is None, mod-settings.json.
    store, when given, turns each variant's raw bytes into the bytes its file stores."""
    doc = fixture(root, weapon=True)
    def rewrite(path, value):
        data = value if isinstance(value, bytes) else (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode()
        (root / path).parent.mkdir(parents=True, exist_ok=True); (root / path).write_bytes(data)
        ref = dict(file=path, sha256=hashlib.sha256(data).hexdigest(), byte_count=len(data))
        doc["inventory"] = [r for r in doc["inventory"] if r["file"] != path] + [ref]
        return ref
    def runtime(ref): return dict(ref, file=ref["file"][len("runtime/"):])
    bundle = json.loads((root / "runtime/bundle.json").read_text(encoding="utf-8"))
    pack = json.loads((root / "runtime/pack.json").read_text(encoding="utf-8"))
    files = {}
    rows = []
    for i, variant in enumerate(variants or []):
        raw = b"variant %d" % i if store is None else b"variant %d " % i * 2000
        blob = runtime(rewrite("runtime/Files/variant%d.bytes" % i, raw if store is None else store(raw)))
        files[blob["file"]] = blob
        rows.append(dict(blob, sha256=hashlib.sha256(raw).hexdigest(), byte_count=len(raw), **variant))
    manifest = {"schema": "endfield-native-character-manifest-v1", "draws": draws}
    if variants is not None: manifest["texture_variants"] = rows
    source = files["source.json"] = runtime(rewrite("runtime/source.json", manifest))
    graph = json.loads((root / "runtime/graph.json").read_text(encoding="utf-8")); graph["manifest_sha256"] = source["sha256"]
    graph = files["graph.json"] = runtime(rewrite("runtime/graph.json", graph))
    pack["render"]["manifest"] = source
    pack["appearances"] = pack["appearances"] + [{"id": "mod_a", "name": "mod"}]
    if table is not None:
        ref = files["interaction/mod-settings.json"] = runtime(rewrite("runtime/interaction/mod-settings.json", table))
        pack["interaction"] = {"data": [dict(ref, file="mod-settings.json")]}
    c7 = files["pack.json"] = runtime(rewrite("runtime/pack.json", pack))
    bundle["files"] = [r for r in bundle["files"] if r["file"] not in files] + list(files.values())
    entry = bundle["characters"][0]
    entry.update(c7=c7, source=source, graph=graph)
    doc["components"]["render"]["native_bundle"] = rewrite("runtime/bundle.json", bundle)
    write_json(root / "character.json", doc)


def changed(edit):
    table = copy.deepcopy(TABLE); edit(table["appearances"]["mod_a"]); return table


class CharacterLibraryModSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def rejected(self, name, reason, table=TABLE, variants=VARIANTS, draws=DRAWS, store=None):
        with self.subTest(name):
            src = self.root / name; modded(src, table, variants, draws, store)
            with self.assertRaisesRegex(PackageError, "^invalid_mod_settings:" + reason + "$"): Package(src)

    def test_valid_table_installs(self):
        src = self.root / "source"; modded(src)
        library = Library(self.root / "library"); library.install(src)
        self.assertEqual(library.entries()[0]["id"], "fixture")

    def test_package_without_table_still_installs(self):
        for name, variants in [("no_variants", None), ("unused_variants", VARIANTS)]:
            with self.subTest(name):
                src = self.root / name; modded(src, None, variants)
                Package(src)

    def test_a_variant_stored_as_a_pool_container_installs(self):
        src = self.root / "container"; modded(src, store=pool_codec.encode)
        Package(src)
        other = lambda raw: (lambda c: c[:20] + hashlib.sha256(b"other").digest() + c[pool_codec.HEADER.size:])(pool_codec.encode(raw))
        self.rejected("container_of_other_bytes", "shape", store=other)

    def test_shape(self):
        self.rejected("schema", "schema", dict(TABLE, schema="endfield-mod-settings/v2"))
        self.rejected("appearance", "unknown_appearance", {"schema": TABLE["schema"], "appearances": {"ghost": TABLE["appearances"]["mod_a"]}})
        self.rejected("bad_id", "shape", changed(lambda a: a["settings"][0].update(id="Coat")))
        self.rejected("duplicate_id", "shape", changed(lambda a: a["settings"][1].update(id="coat")))
        self.rejected("duplicate_value", "shape", changed(lambda a: a["settings"][0]["values"].append({"value": 1, "name": "x"})))
        self.rejected("value_range", "shape", changed(lambda a: a["settings"][0]["values"].append({"value": 256, "name": "x"})))
        self.rejected("category", "shape", changed(lambda a: a["settings"][1].update(category="hat")))

    def test_unknown_mesh(self):
        self.rejected("mesh", "unknown_mesh", changed(lambda a: a["segments"][0].update(mesh="outfit:mod_a/ghost")))
        self.rejected("texture_mesh", "unknown_mesh", changed(lambda a: a["textures"][0].update(mesh="outfit:mod_a/ghost")))

    def test_unknown_indices(self):
        self.rejected("sha", "unknown_indices", changed(lambda a: a["segments"][0].update(indices_sha256="3" * 64)))
        self.rejected("texture_sha", "unknown_indices", changed(lambda a: a["textures"][0].update(indices_sha256="3" * 64)))

    def test_a_variant_of_one_index_block_fits_that_block_only(self):
        # The mesh's other block samples a 256-pixel _BaseMap, which the 512-pixel variant of block IB does not fit.
        other = draw("PreGBuffer", MESH, "4" * 64, 300)
        other["resources"][0] = dict(other["resources"][0], texture=dict(SPEC, width=256, height=256))
        variants = VARIANTS + [dict(VARIANTS[0], id="mod_a/cloth_01/111/_BaseMap/1", indices_sha256=IB)]
        texture = {"mesh": MESH, "indices_sha256": IB, "resource": "_BaseMap",
                   "variants": [{"variant": "mod_a/cloth_01/111/_BaseMap/1", "when": {"color": [1]}}]}
        src = self.root / "block"; modded(src, changed(lambda a: a.update(textures=[texture])), variants, DRAWS + [other])
        Package(src)
        self.rejected("whole_mesh", "variant_size_mismatch", TABLE, variants, DRAWS + [other])
        self.rejected("block_variant_on_mesh", "variant_mesh_mismatch", changed(lambda a: a["textures"][0]["variants"].append(texture["variants"][0])), variants)
        self.rejected("same_block_twice", "shape", changed(lambda a: a.update(textures=[texture, texture])), variants, DRAWS + [other])

    def test_segment_out_of_range(self):
        self.rejected("past_end", "segment_out_of_range", changed(lambda a: a["segments"][2].update(count=1803)))
        self.rejected("unaligned", "segment_out_of_range", changed(lambda a: a["segments"][2].update(first=4201, count=1797)))
        self.rejected("empty", "segment_out_of_range", changed(lambda a: a["segments"][2].update(count=0)))
        mismatched = [DRAWS[0], dict(DRAWS[1], index_count=3000), DRAWS[2]]
        self.rejected("index_counts_differ", "index_count_mismatch", draws=mismatched)

    def test_segment_overlap(self):
        self.rejected("overlap", "segment_overlap", changed(lambda a: a["segments"][1].update(first=2997)))

    def test_unknown_value(self):
        self.rejected("visible_when", "unknown_value", changed(lambda a: a["segments"][0].update(visible_when={"coat": [2]})))
        self.rejected("when", "unknown_value", changed(lambda a: a["textures"][0]["variants"][0].update(when={"color": [3]})))
        self.rejected("default", "default_not_in_values", changed(lambda a: a["settings"][0].update(default=5)))
        self.rejected("setting", "unknown_setting", changed(lambda a: a["segments"][0].update(visible_when={"hat": [0]})))

    def test_variant_must_fit_its_slot(self):
        def variants(**texture): return [dict(VARIANTS[0], texture=dict(SPEC, **texture)), VARIANTS[1]]
        self.rejected("format", "variant_format_mismatch", variants=variants(rd_format_name="BC7_UNORM_BLOCK"))
        self.rejected("color_space", "variant_format_mismatch", variants=variants(storage_color_space_raw=0))
        self.rejected("width", "variant_size_mismatch", variants=variants(width=1024))
        self.rejected("mips", "variant_size_mismatch", variants=variants(mip_count=9))
        self.rejected("other_mesh", "variant_mesh_mismatch", variants=[dict(VARIANTS[0], mesh="body"), VARIANTS[1]])
        self.rejected("unknown_variant", "unknown_variant", variants=VARIANTS[:1])
        self.rejected("no_variants", "unknown_variant", variants=None)
        self.rejected("runtime_slot", "unknown_resource", changed(lambda a: a["textures"][0].update(resource="_CameraDepthTexture")))
        self.rejected("absent_slot", "unknown_resource", changed(lambda a: a["textures"][0].update(resource="_NormalMap")))

    def test_limits(self):
        values = [{"value": i, "name": str(i)} for i in range(17)]
        settings = [{"id": "s%d" % i, "name": "s", "default": 0, "values": [{"value": 0, "name": "0"}]} for i in range(63)]
        self.rejected("settings", "limit", changed(lambda a: a["settings"].extend(settings)))
        self.rejected("values", "limit", changed(lambda a: a["settings"][1].update(values=values)))
        self.rejected("segments", "limit", changed(lambda a: a["segments"].extend([a["segments"][2]] * 1022)))
        self.rejected("variants", "limit", changed(lambda a: a["textures"][0]["variants"].extend([a["textures"][0]["variants"][0]] * 63)))


if __name__ == "__main__":
    unittest.main()
