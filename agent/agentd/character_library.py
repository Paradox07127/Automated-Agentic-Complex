"""Immutable character packages and one atomic catalog for UI, persona and Metal.

Only data is installed. Native resource/ABI/GPU checks remain the renderer's job;
an installed package is not a claim of visual or hardware acceptance.
"""
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import stat
import subprocess
import tempfile
import zipfile
import fsutil
from infra.platform import lock_file, plain_path, sync_directory
import pool_codec
from resource_store import ResourceRepository

ID = re.compile(r"^[a-z0-9_]+$")
VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
SHA = re.compile(r"^[0-9a-f]{64}$")
BASE = {"render.default", "motion.idle", "motion.preview", "persona.dialogue"}
# A package whose components have no render key is text-only and needs only these.
TEXT_ONLY_BASE = {"persona.dialogue"}
EXECUTABLES = {".py", ".pyc", ".sh", ".command", ".dylib", ".so", ".exe", ".dll"}
NATIVE_FIELDS = ("c7", "actor_archive", "source", "library", "graph", "lighting", "coverage", "library_ssaa1")
# The neutral package beside the frame graph: all three or none (packages built before it).
NEUTRAL_FIELDS = ("neutral_scene", "neutral_build_record", "metal_product")
# The Windows frame table, bound to the neutral scene: only with the neutral package.
VULKAN_FIELDS = ("vulkan_frame",)
MAX_FILES = 50000
MAX_BYTES = 32 * 1024 ** 3
# Seconds the host may take to load a package's native bundle; callers hold the library lock meanwhile.
VALIDATE_TIMEOUT = 300


class PackageError(ValueError):
    pass


def need(value, reason):
    if not value:
        raise PackageError(reason)


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(4 * 1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def read_json(path):
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, "duplicate_json_key")
            result[key] = value
        return result
    try:
        return fsutil.read_json(path, object_pairs_hook=pairs, parse_constant=lambda _: need(False, "nonfinite_json"))
    except (OSError, json.JSONDecodeError, TypeError) as error:
        raise PackageError("invalid_json: " + plain_path(path)) from error


def write_json(path, value):
    """Atomic replace in the same directory; readers see an entire snapshot."""
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    fsutil.atomic_write_text(path, json_bytes(value).decode())
    sync_directory(path.parent)


def relative(value):
    need(isinstance(value, str) and value and "\\" not in value and "\0" not in value, "invalid_path")
    path = PurePosixPath(value)
    need(not PureWindowsPath(value).drive and not path.is_absolute() and path.as_posix() == value and
         all(part not in ("", ".", "..") for part in value.split("/")), "escaping_path")
    need(path.suffix.lower() not in EXECUTABLES, "executable_payload")
    return value


def safe_extract_zip(source: Path, stage: Path, *, max_files: int, max_bytes: int, decode_cp932: bool = False, skip=None) -> list[Path]:
    """Every entry checked before any is written; returns the files written under stage, skipping names skip(name) accepts."""
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        need(0 < len(infos) <= max_files, "archive_file_limit")
        members = []; total = 0; folded = set()
        for item in infos:
            name = item.filename
            # zipfile reads a name without the UTF-8 flag as cp437; Japanese archivers write cp932.
            if decode_cp932 and not item.flag_bits & 0x800:
                try: name = name.encode("cp437").decode("cp932")
                except UnicodeError: pass
            if item.is_dir(): name = name.rstrip("/")
            target = stage / relative(name)
            need(stage in target.parents, "escaping_path")
            need(name.casefold() not in folded, "duplicate_archive_path"); folded.add(name.casefold())
            mode = item.external_attr >> 16
            need(not (stat.S_ISLNK(mode) or (not item.is_dir() and mode & 0o111) or item.flag_bits & 1), "archive_executable_or_link")
            need(item.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "unsupported_archive_compression")
            total += item.file_size; need(total <= max_bytes, "archive_byte_limit")
            members.append((item, name, target))
        written = []
        for item, name, target in members:
            if skip is not None and skip(name): continue
            if item.is_dir(): target.mkdir(parents=True, exist_ok=True); continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(item) as src, target.open("xb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
            need(target.stat().st_size == item.file_size, "archive_length_mismatch")
            written.append(target)
        return written


def contained(root, value):
    # relative() refuses "..", so with no link below root the file cannot resolve outside it.
    relative(value)
    path = str(root)
    for part in value.split("/"):
        path += os.sep + part
        try: mode = os.lstat(path).st_mode
        except (FileNotFoundError, NotADirectoryError): raise PackageError("missing_or_escaping_file") from None
        need(not stat.S_ISLNK(mode), "runtime_symlink")
    need(stat.S_ISREG(mode), "missing_or_escaping_file")
    return root / value


def validate_ref(ref):
    need(isinstance(ref, dict), "invalid_reference")
    relative(ref.get("file"))
    need(isinstance(ref.get("sha256"), str) and SHA.fullmatch(ref["sha256"]), "invalid_sha256")
    need(type(ref.get("byte_count")) is int and ref["byte_count"] >= 0, "invalid_byte_count")


SETTING_ID = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
SETTING_CATEGORIES = ("clothing", "accessory", "hair", "color", "other")
TEXTURE_FORMAT = ("dimension", "rd_format_name", "storage_color_space_raw")
TEXTURE_SIZE = ("width", "height", "depth", "mip_count", "face_count", "array_length")


def check_mod_settings(table, appearances, source, indexed):
    """endfield-mod-settings/v1 against the source manifest's draws and texture_variants; indexed(variant) is true for a packaged file."""
    def ok(value, reason): need(value, "invalid_mod_settings:" + reason)
    def label(x): return isinstance(x, str) and 0 < len(x.encode()) <= 64
    ok(isinstance(table, dict) and table.get("schema") == "endfield-mod-settings/v1", "schema")
    ok(isinstance(table.get("appearances"), dict), "shape")
    draws = [d for d in source.get("draws", []) if isinstance(d, dict)]
    variants = source.get("texture_variants", [])
    ok(isinstance(variants, list) and all(isinstance(v, dict) for v in variants), "shape")
    by_id = {v.get("id"): v for v in variants}
    ok(len(by_id) == len(variants), "shape")
    def slots(mesh, names, block=None):
        return [r["texture"] for d in draws if d.get("mesh") == mesh and block in (None, (d.get("indices") or {}).get("sha256"))
                for r in d.get("resources", [])
                if isinstance(r, dict) and r.get("category") == "separate_images" and isinstance(r.get("texture"), dict) and
                isinstance(r.get("names"), list) and set(names).intersection(x for x in r["names"] if isinstance(x, str))]
    for appearance, entry in table["appearances"].items():
        ok(appearance in appearances, "unknown_appearance")
        ok(isinstance(entry, dict) and all(isinstance(entry.get(k), list) for k in ("settings", "segments", "textures")), "shape")
        ok(len(entry["settings"]) <= 64, "limit")
        settings = {}
        for s in entry["settings"]:
            ok(isinstance(s, dict) and isinstance(s.get("id"), str) and SETTING_ID.fullmatch(s["id"]) and s["id"] not in settings and
               label(s.get("name")) and isinstance(s.get("values"), list) and s["values"] and
               ("origin" not in s or isinstance(s["origin"], dict)) and s.get("category", "other") in SETTING_CATEGORIES, "shape")
            ok(len(s["values"]) <= 16, "limit")
            values = [v.get("value") if isinstance(v, dict) and label(v.get("name")) else None for v in s["values"]]
            ok(all(type(v) is int and 0 <= v <= 255 for v in values) and len(set(values)) == len(values), "shape")
            ok(type(s.get("default")) is int and s["default"] in values, "default_not_in_values")
            settings[s["id"]] = set(values)
        def condition(when):
            ok(isinstance(when, dict), "shape")
            for key, allowed in when.items():
                ok(key in settings, "unknown_setting")
                ok(isinstance(allowed, list) and allowed and all(type(v) is int for v in allowed) and len(set(allowed)) == len(allowed), "shape")
                ok(settings[key].issuperset(allowed), "unknown_value")
        ok(len(entry["segments"]) <= 1024, "limit")
        runs = {}
        for g in entry["segments"]:
            ok(isinstance(g, dict) and isinstance(g.get("mesh"), str) and isinstance(g.get("indices_sha256"), str) and
               type(g.get("first")) is int and type(g.get("count")) is int and ("origin" not in g or isinstance(g["origin"], dict)), "shape")
            meshes = [d for d in draws if d.get("mesh") == g["mesh"]]
            ok(meshes, "unknown_mesh")
            counts = {d.get("index_count") for d in meshes if isinstance(d.get("indices"), dict) and d["indices"].get("sha256") == g["indices_sha256"]}
            ok(counts, "unknown_indices")
            # Every pass sharing the index block draws the same runs, so they must agree on its length.
            ok(len(counts) == 1, "index_count_mismatch")
            total = counts.pop()
            ok(type(total) is int and g["first"] >= 0 and g["count"] > 0 and g["first"] % 3 == 0 and g["count"] % 3 == 0 and
               g["first"] + g["count"] <= total, "segment_out_of_range")
            condition(g.get("visible_when"))
            runs.setdefault((g["mesh"], g["indices_sha256"]), []).append((g["first"], g["count"]))
        for spans in runs.values():
            spans.sort()
            ok(all(a[0] + a[1] <= b[0] for a, b in zip(spans, spans[1:])), "segment_overlap")
        targets, count = set(), 0
        for t in entry["textures"]:
            ok(isinstance(t, dict) and isinstance(t.get("mesh"), str) and isinstance(t.get("resource"), str) and
               isinstance(t.get("indices_sha256", ""), str) and (t["mesh"], t.get("indices_sha256"), t["resource"]) not in targets and
               isinstance(t.get("variants"), list) and t["variants"], "shape")
            targets.add((t["mesh"], t.get("indices_sha256"), t["resource"])); count += len(t["variants"])
            ok(count <= 64, "limit")
            ok(any(d.get("mesh") == t["mesh"] for d in draws), "unknown_mesh")
            ok("indices_sha256" not in t or any(d.get("mesh") == t["mesh"] and isinstance(d.get("indices"), dict) and
                                                d["indices"].get("sha256") == t["indices_sha256"] for d in draws), "unknown_indices")
            ok(slots(t["mesh"], [t["resource"]], t.get("indices_sha256")), "unknown_resource")
            picked = set()
            for v in t["variants"]:
                ok(isinstance(v, dict) and isinstance(v.get("variant"), str) and v["variant"] not in picked, "shape")
                picked.add(v["variant"])
                condition(v.get("when"))
                variant = by_id.get(v["variant"])
                ok(variant is not None, "unknown_variant")
                names = variant.get("resource_names")
                ok(isinstance(names, list) and names and all(isinstance(x, str) for x in names) and isinstance(variant.get("texture"), dict) and
                   isinstance(variant.get("file"), str) and isinstance(variant.get("sha256"), str) and indexed(variant), "shape")
                ok(variant.get("mesh") == t["mesh"] and variant.get("indices_sha256") == t.get("indices_sha256") and t["resource"] in names,
                   "variant_mesh_mismatch")
                for slot in slots(t["mesh"], names, t.get("indices_sha256")):
                    ok(all(slot.get(k) == variant["texture"].get(k) for k in TEXTURE_FORMAT), "variant_format_mismatch")
                    ok(all(slot.get(k) == variant["texture"].get(k) for k in TEXTURE_SIZE), "variant_size_mismatch")


class Package:
    def __init__(self, root, deep=True):
        need(not Path(root).is_symlink(), "runtime_symlink")
        self.root = Path(root).resolve()
        self.document = d = read_json(contained(self.root, "character.json"))
        need(isinstance(d, dict) and d.get("schema") == "endfield-character-definition" and
             type(d.get("schema_version")) is int and d["schema_version"] == 1, "unsupported_character_schema")
        self.render_enabled = isinstance(d.get("components"), dict) and "render" in d["components"]
        need((isinstance(d.get("game"), str) or not self.render_enabled) and
             isinstance(d.get("id"), str) and ID.fullmatch(d["id"]), "invalid_character_id")
        need(isinstance(d.get("version"), str) and VERSION.fullmatch(d["version"]), "invalid_character_version")
        self.id, self.version = d["id"], d["version"]
        self.sha256 = digest(self.root / "character.json")
        source = d.get("source_identity", {})
        need(isinstance(source.get("character_id"), str) and source["character_id"] and
             isinstance(source.get("snapshot"), str) and source["snapshot"], "missing_source_identity")
        names = d.get("display", {}).get("name", {})
        need(isinstance(names, dict) and all(isinstance(v, str) and v.strip() for v in names.values()) and names, "missing_display_name")
        self.name = names.get("zh-Hans") or names[sorted(names)[0]]
        self.aliases = d.get("aliases", [])
        need(isinstance(self.aliases, list) and all(isinstance(x, str) and ID.fullmatch(x) and x != self.id for x in self.aliases)
             and len(set(self.aliases)) == len(self.aliases), "invalid_alias")
        self.inventory = {}
        folded = set()
        need(isinstance(d.get("inventory"), list) and d["inventory"], "empty_inventory")
        for ref in d["inventory"]:
            validate_ref(ref); key = ref["file"]
            need(key not in self.inventory and key.casefold() not in folded, "duplicate_inventory")
            self.inventory[key] = ref; folded.add(key.casefold())
            path = contained(self.root, key)
            need(path.stat().st_size == ref["byte_count"], "file_length_mismatch")
            if deep: need(digest(path) == ref["sha256"], "file_sha_mismatch")
        need(isinstance(d.get("capabilities"), list) and all(isinstance(x, str) for x in d["capabilities"]) and
             len(set(d["capabilities"])) == len(d["capabilities"]) and
             (BASE if self.render_enabled else TEXT_ONLY_BASE).issubset(d["capabilities"]), "missing_base_capability")
        self.components = c = d.get("components", {})
        need(isinstance(c, dict), "missing_components")
        # Every package may omit game_data and ui; whatever it includes is checked.
        try:
            self.native_ref = c["render"]["native_bundle"] if self.render_enabled else None
            self.card_ref, self.lore_ref = c["persona"]["card"], c["persona"]["lore"]
            ui = c["ui"] if "ui" in c else {}
            need(isinstance(ui, dict), "missing_base_component")
            self.game_ref = c["game_data"] if "game_data" in c else None
            self.head_ref = ui["head"] if "head" in ui else None
        except (KeyError, TypeError) as error:
            raise PackageError("missing_base_component") from error
        for ref in (self.native_ref, self.card_ref, self.lore_ref):
            if self.render_enabled or ref is not None: self.resolve(ref)
        for ref in (self.game_ref, self.head_ref):
            if ref is not None: self.resolve(ref)
        for kind in ('portrait', 'background'):
            art = ui.get(kind)
            need((art is not None) == ('ui.' + kind in d['capabilities']), kind + '_capability_mismatch')
            if art is not None: self.resolve(art)
        card, game = self.card(), self.game_data() if self.game_ref is not None else None
        need(card.get("name") == self.name and (game is None or game.get("id") == self.id and
             game.get("source_character_id") == source["character_id"] and game.get("name") == self.name), "component_identity_mismatch")
        from brain.persona import render_persona
        try:
            render_persona(card)
            from brain.lorebook import Lorebook
            Lorebook(self.resolve(self.lore_ref))
        except (KeyError, TypeError, ValueError) as error:
            raise PackageError("invalid_persona_or_lore") from error
        if game is not None:
            need(isinstance(game.get("fields"), list) and all(isinstance(x, dict) and
                 isinstance(x.get("key"), str) and x["key"] and isinstance(x.get("label"), str) and x["label"] and
                 (x.get("value") is None or isinstance(x["value"], str)) and
                 isinstance(x.get("source"), str) and x["source"] for x in game["fields"]), "invalid_game_data_provenance")
            need(len({x['key'] for x in game['fields']}) == len(game['fields']), "duplicate_game_data_key")
        self.voice_enabled = c.get("voice") is not None
        if self.voice_enabled:
            need(isinstance(c["voice"], dict) and all(isinstance(c["voice"].get(k), str) and c["voice"][k]
                 for k in ("character", "language")), "invalid_voice_profile")
        self.native = self.native_entry = None
        if not self.render_enabled: return
        self.native = n = read_json(self.resolve(self.native_ref))
        need(n.get("schema") == "metal-native-character-bundle/v1" and
             len(n.get("characters", [])) == 1 and n["characters"][0].get("id") == self.id, "native_character_identity_mismatch")
        self.native_entry = n["characters"][0]
        native_prefix = PurePosixPath(self.native_ref["file"]).parent
        need(isinstance(n.get("files"), list) and n["files"], "empty_native_inventory")
        native_paths=set()
        for ref in n["files"]:
            need(ref['file'].casefold() not in native_paths, "duplicate_native_inventory")
            native_paths.add(ref['file'].casefold())
            self.resolve(dict(ref, file=str(native_prefix / relative(ref["file"]))), verify=False)
        native_index = {ref["file"]: ref for ref in n["files"]}
        for field in NATIVE_FIELDS:
            if field == "library_ssaa1" and field not in self.native_entry: continue
            ref = self.native_entry.get(field)
            validate_ref(ref)
            need(native_index.get(ref["file"]) == ref or all(native_index.get(ref["file"], {}).get(k) == ref[k]
                 for k in ("file", "sha256", "byte_count")), "native_reference_not_indexed")
        neutral = [field for field in NEUTRAL_FIELDS if field in self.native_entry]
        need(len(neutral) in (0, len(NEUTRAL_FIELDS)), "incomplete_neutral_package")
        vulkan = [field for field in VULKAN_FIELDS if field in self.native_entry]
        need(not vulkan or neutral, "vulkan_frame_without_neutral_package")
        for field in neutral + vulkan:
            ref = self.native_entry[field]; validate_ref(ref)
            need(all(native_index.get(ref["file"], {}).get(k) == ref[k] for k in ("file", "sha256", "byte_count")), "native_reference_not_indexed")
            self.resolve(dict(ref, file=str(native_prefix / ref["file"])))
        # The scene is shared by every character; publish copies its path into the library bundle.
        if "scene" in n:
            need(isinstance(n["scene"], dict) and isinstance(n["scene"].get("objects"), dict), "invalid_native_scene")
            ref = n["scene"]["objects"]; validate_ref(ref)
            need(all(native_index.get(ref["file"], {}).get(k) == ref[k] for k in ("file", "sha256", "byte_count")), "native_reference_not_indexed")
            self.resolve(dict(ref, file=str(native_prefix / ref["file"])))
        archive = read_json(self.resolve(dict(self.native_entry["actor_archive"], file=str(native_prefix / self.native_entry["actor_archive"]["file"]))))
        need(self.native_entry.get("default_clip") in [x.get("name") for x in archive.get("clips", [])], "missing_default_clip")
        pack = read_json(self.resolve(dict(self.native_entry["c7"], file=str(native_prefix / self.native_entry["c7"]["file"]))))
        need(pack.get("id") == self.id, "c7_identity_mismatch")
        need(pack.get('render',{}).get('manifest',{}).get('sha256') == self.native_entry['source']['sha256'], "c7_source_identity_mismatch")
        graph=read_json(self.resolve(dict(self.native_entry['graph'],file=str(native_prefix / self.native_entry['graph']['file']))))
        need(graph.get('manifest_sha256') == self.native_entry['source']['sha256'], "graph_source_identity_mismatch")
        appearance=self.native_entry.get('default_appearance')
        need(appearance in [a.get('id') for a in pack.get('appearances',[])], "missing_default_appearance")
        coverage=read_json(self.resolve(dict(self.native_entry['coverage'],file=str(native_prefix / self.native_entry['coverage']['file']))))
        need(appearance in coverage.get('appearances',[]) and not coverage.get('blocked',{}).get(appearance+':'+self.native_entry['default_clip']), "blocked_default_appearance")
        weapon=c['render'].get('weapon_visibility')
        need((weapon is not None)==('render.weapon_toggle' in d['capabilities']), 'weapon_capability_mismatch')
        if weapon is not None:
            need(isinstance(weapon,dict) and isinstance(weapon.get('meshes'),list) and weapon['meshes'] and
                 all(isinstance(x,str) and x for x in weapon['meshes']) and len(set(weapon['meshes']))==len(weapon['meshes']), 'invalid_weapon_visibility')
            shown,hidden=weapon.get('shown_appearance'),weapon.get('hidden_appearance')
            ids={a['id'] for a in pack['appearances']}
            need(shown in ids and hidden in ids and shown!=hidden,'weapon_appearance_missing')
            for value in [shown,hidden]:
                need(value in coverage.get('appearances',[]) and not coverage.get('blocked',{}).get(value+':'+self.native_entry['default_clip']), 'weapon_appearance_unprepared')
            palette_ref=pack.get('animation',{}).get('palette_contract');validate_ref(palette_ref)
            palette_path=native_prefix/PurePosixPath(self.native_entry['c7']['file']).parent/'animation'/palette_ref['file']
            meshes=read_json(self.resolve(dict(palette_ref,file=str(palette_path))))['meshes']
            need(set(weapon['meshes']).issubset({m['mesh'] for m in meshes}), 'weapon_mesh_missing')
            for mesh in meshes:
                show=mesh.get('appearances') is None or shown in mesh['appearances']
                hide=mesh.get('appearances') is None or hidden in mesh['appearances']
                need((show and not hide) if mesh['mesh'] in weapon['meshes'] else show==hide,'weapon_visibility_changes_body')
        # Same rules as the local build tool appearance_layers.py; agentd cannot import the pipeline.
        appearance_ids=[a.get('id') for a in pack.get('appearances',[])]
        layers=pack.get('layers')
        if layers is not None:
            palette_ref=pack.get('animation',{}).get('palette_contract');validate_ref(palette_ref)
            palette_path=native_prefix/PurePosixPath(self.native_entry['c7']['file']).parent/'animation'/palette_ref['file']
            palette={m['mesh']:m for m in read_json(self.resolve(dict(palette_ref,file=str(palette_path))))['meshes']}
            need(isinstance(layers,list) and len(layers)<=16,'invalid_layers')
            layer_ids,used=set(),set()
            for layer in layers:
                need(isinstance(layer,dict) and isinstance(layer.get('id'),str) and re.fullmatch(r'[a-z][a-z0-9_]{0,31}',layer['id']) and
                     layer['id']!='weapon' and layer['id'] not in layer_ids and isinstance(layer.get('name'),str) and
                     0<len(layer['name'].encode())<=64 and isinstance(layer.get('meshes'),list) and layer['meshes'],'invalid_layers')
                layer_ids.add(layer['id'])
                for mesh in layer['meshes']:
                    need(isinstance(mesh,str) and mesh in palette and mesh not in used and
                         'visible_with_clips' not in palette[mesh] and 'particle_palette' not in palette[mesh],'invalid_layers')
                    used.add(mesh)
                need('appearances' not in layer or isinstance(layer['appearances'],list) and
                     all(isinstance(x,str) and x in appearance_ids for x in layer['appearances']),'invalid_layers')
        for a in pack.get('appearances',[]):
            source=a.get('source')
            need(('kind' not in a or a['kind'] in ('original','imported')) and
                 ('desc' not in a or isinstance(a['desc'],str) and len(a['desc'].encode())<=200) and
                 (a.get('kind')!='imported' or 'source' in a) and
                 ('source' not in a or isinstance(source,dict) and source.get('format') in ('efmi','clone') and
                  isinstance(source.get('fingerprint'),str) and SHA.fullmatch(source['fingerprint']) and
                  isinstance(source.get('imported_at'),str)),'invalid_appearances')
        c7_dir=native_prefix/PurePosixPath(self.native_entry['c7']['file']).parent
        palette_ref=pack.get('animation',{}).get('palette_contract')
        if palette_ref is not None:
            validate_ref(palette_ref)
            for mesh in read_json(self.resolve(dict(palette_ref,file=str(c7_dir/'animation'/palette_ref['file']))))['meshes']:
                need('scene' not in mesh or isinstance(mesh['scene'],str) and mesh['scene'],'invalid_palette_scene')
        stage_ref=next((r for r in pack.get('interaction',{}).get('data',[]) if r.get('file')=='stage.json'),None)
        if stage_ref is not None:
            stage=read_json(self.resolve(dict(stage_ref,file=str(c7_dir/'interaction'/'stage.json'))))
            number=lambda x:type(x) in (int,float)
            need(isinstance(stage,dict) and stage.get('schema')=='endfield-character-stage/v1' and isinstance(stage.get('id'),str) and stage['id'] and
                 isinstance(stage.get('display'),dict) and isinstance(stage['display'].get('name'),str) and stage['display']['name'] and
                 isinstance(stage.get('box'),dict) and all(number(stage['box'].get(k)) for k in ('aspect','height_fraction','floor_v')) and
                 isinstance(stage.get('meshes'),list) and stage['meshes'] and all(isinstance(x,str) and x for x in stage['meshes']) and
                 isinstance(stage.get('camera_hint'),dict) and all(isinstance(stage['camera_hint'].get(k),list) and len(stage['camera_hint'][k])==3 and
                     all(number(v) for v in stage['camera_hint'][k]) for k in ('position','look_at')) and
                 isinstance(stage.get('limits'),dict) and all(number(stage['limits'].get(k)) for k in ('min_camera_height_m','max_camera_distance_m')) and
                 isinstance(stage.get('excluded'),list) and all(isinstance(x,dict) and isinstance(x.get('node'),str) and
                     isinstance(x.get('reason'),str) for x in stage['excluded']) and
                 isinstance(stage.get('source_identity'),dict),'invalid_stage')
        settings_ref=next((r for r in pack.get('interaction',{}).get('data',[]) if r.get('file')=='mod-settings.json'),None)
        if settings_ref is not None:
            table=read_json(self.resolve(dict(settings_ref,file=str(c7_dir/'interaction'/'mod-settings.json'))))
            source_ref=self.native_entry['source']
            source=read_json(self.resolve(dict(source_ref,file=str(native_prefix/source_ref['file']))))
            # Variant files are relative to the manifest, like its draws' resources.
            source_dir=PurePosixPath(source_ref['file']).parent
            def indexed(ref):
                item=native_index.get(str(source_dir/ref['file']))
                if item is None: return False
                if item['byte_count']==ref.get('byte_count'): return item['sha256']==ref['sha256']
                try: raw=pool_codec.raw_identity(contained(self.root,str(native_prefix/source_dir/ref['file'])),item['byte_count'])
                except ValueError: return False
                return raw==(ref['sha256'],ref.get('byte_count'))
            check_mod_settings(table,appearance_ids,source,indexed)

    def resolve(self, ref, verify=True):
        validate_ref(ref)
        expected = self.inventory.get(ref["file"], {})
        need(all(expected.get(k) == ref[k] for k in ("file", "sha256", "byte_count")), "unindexed_component")
        path = contained(self.root, ref["file"])
        # Component documents are verified even for metadata-only catalog reads.
        need(path.stat().st_size == ref["byte_count"], "component_length_mismatch")
        if verify: need(digest(path) == ref["sha256"], "component_sha_mismatch")
        return path

    def card(self): return read_json(self.resolve(self.card_ref))
    def game_data(self): return read_json(self.resolve(self.game_ref))

    def view(self):
        return dict(id=self.id, name=self.name, version=self.version, root=plain_path(self.root), definition_sha256=self.sha256,
                    aliases=self.aliases, capabilities=self.document["capabilities"], voice_enabled=self.voice_enabled,
                    persona=plain_path(self.resolve(self.card_ref)), lore=plain_path(self.resolve(self.lore_ref)),
                    head=plain_path(self.resolve(self.head_ref)) if self.head_ref is not None else None,
                    game_data=self.game_data() if self.game_ref is not None else None)


class Library:
    def __init__(self, root, catalog_name="current.json"):
        self.root = Path(root).resolve()
        relative(catalog_name)
        need("/" not in catalog_name, "invalid_catalog_name")
        self.catalog_name = catalog_name
        self.resources = ResourceRepository()

    def snapshot(self):
        path = self.root / self.catalog_name
        if not path.exists():
            need(self.catalog_name == "current.json", "missing_catalog")
            return dict(schema="endfield-character-library/v1", revision="", characters=[])
        doc = read_json(path)
        need(doc.get("schema") == "endfield-character-library/v1", "unsupported_catalog_schema")
        payload = {k: v for k, v in doc.items() if k != "revision"}
        need(hashlib.sha256(json_bytes(payload)).hexdigest() == doc.get("revision"), "catalog_revision_mismatch")
        ref = doc["native_bundle"]; validate_ref(ref)
        need(digest(contained(self.root, ref["file"])) == ref["sha256"], "native_catalog_sha_mismatch")
        return doc

    def packages(self): return [self.load_entry(entry) for entry in self.snapshot()["characters"]]

    def package(self, character):
        """The installed package of character, or None; no other character's package is loaded."""
        entry = next((e for e in self.snapshot()["characters"] if e["id"] == character), None)
        return None if entry is None else self.load_entry(entry)

    def load_entry(self, entry):
        """Load and verify one definition referenced by a catalog snapshot."""
        ref = entry["definition"]; validate_ref(ref); path = contained(self.root, ref["file"])
        need(digest(path) == ref["sha256"] and path.stat().st_size == ref["byte_count"], "definition_sha_mismatch")
        package = Package(path.parent, deep=False)
        need(package.id == entry["id"], "catalog_character_identity_mismatch")
        return package

    def entries(self): return [package.view() for package in self.packages()]

    def import_path(self, source, validate_with=None):
        # validate_with: the host executable that must load the staged native bundle; None skips that check.
        host = None if validate_with is None else Path(validate_with).resolve()
        need(host is None or (host.is_file() and os.access(host, os.X_OK)), "load_failed: host executable is missing or not executable: " + str(host))
        source = Path(source)
        directory = source.is_dir()
        if directory and host is None: return self.install(source)
        need(directory or (source.is_file() and source.suffix == ".endfield-character"), "unsupported_package_file")
        # Extract under a private staging directory; no entry may supply executable code,
        # links, absolute paths, duplicate names or unbounded decompressed output.
        with tempfile.TemporaryDirectory(prefix="endfield-character-") as temporary:
            stage = Path(temporary)
            if directory:
                need(not source.is_symlink() and not os.path.isjunction(source), "runtime_symlink")
                # A Windows junction is no symlink to is_symlink, and copytree would copy what it points at.
                for walked, names, _ in os.walk(source, followlinks=False):
                    for name in names: need(not os.path.isjunction(os.path.join(walked, name)), "runtime_symlink")
                # Finder and Explorer drop these into any folder the user browses; they are not package files.
                shutil.copytree(source, stage, dirs_exist_ok=True, symlinks=True,
                                ignore=shutil.ignore_patterns(".DS_Store", "Thumbs.db", "desktop.ini"))
                for walked, names, files in os.walk(stage, followlinks=False):
                    for name in names + files: need(not (Path(walked) / name).is_symlink(), "runtime_symlink")
            else:
                safe_extract_zip(source, stage, max_files=MAX_FILES, max_bytes=MAX_BYTES)
            package = Package(stage)
            expected = set(package.inventory) | {"character.json"}
            actual = {p.relative_to(stage).as_posix() for p in stage.rglob("*") if p.is_file()}
            need(actual == expected, "archive_unindexed_payload")
            if host is not None: validate_pack(host, package)
            return self.install(stage)

    def install(self, source):
        package = Package(source)
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / ".lock").open("a", encoding="utf-8") as lock:
            lock_file(lock)
            old = self.packages()
            for existing in old:
                if existing.id == package.id and existing.version == package.version:
                    need(existing.sha256 == package.sha256, "same_version_different_content")
                    return self.snapshot()
                # Live character switching currently goes by ID. Until package-generation pinning
                # spans all processes, an import can append IDs but never replace one
                # underneath a prepared persona/native transaction.
                need(existing.id != package.id, "character_update_requires_offline_migration")
            for existing in old:
                for ref in existing.inventory.values():
                    self.resources.register(contained(existing.root, ref['file']), ref)
            return self.publish(self.materialize(old, package))

    def upgrade(self, source, base_sha256):
        """Publish a higher version of an installed character built from its current package, under the same catalog path.

        The base package directory stays on disk until the shell removes it at the next app launch.
        The tools build source as a clone of the base package, so its files are copied without indexing the installed ones.
        """
        # materialize checks the SHA-256 of every copied file before it is published.
        package = Package(source, deep=False)
        with (self.root / ".lock").open("a", encoding="utf-8") as lock:
            lock_file(lock)
            old = self.packages()
            current = next((x for x in old if x.id == package.id), None)
            need(current is not None, "unknown_character")
            need(current.sha256 == base_sha256, "upgrade_base_changed")
            need(tuple(map(int, package.version.split("."))) > tuple(map(int, current.version.split("."))), "upgrade_requires_higher_version")
            return self.publish(self.materialize(old, package))

    def materialize(self, old, package):
        """Copy package to packages/<id>/<sha> under the held lock; returns the catalog's packages with it in place of its ID."""
        aliases = set()
        for entry in [x for x in old if x.id != package.id] + [package]:
            names = {entry.id, *entry.aliases}
            need(not aliases.intersection(names), "alias_collision"); aliases.update(names)
        destination = self.root / "packages" / package.id / package.sha256
        if destination.exists(): installed = Package(destination, deep=False)
        else:
            stage = Path(tempfile.mkdtemp(prefix=".install-", dir=self.root))
            try:
                for ref in package.inventory.values():
                    target = stage / ref["file"]; target.parent.mkdir(parents=True, exist_ok=True)
                    self.resources.materialize(contained(package.root, ref["file"]), target, ref, source_verified=True)
                self.resources.materialize(package.root / "character.json", stage / "character.json",
                    dict(sha256=package.sha256,byte_count=(package.root/'character.json').stat().st_size), source_verified=True)
                installed = Package(stage)
                destination.parent.mkdir(parents=True, exist_ok=True); stage.rename(destination)
                installed.root = destination
                self.resources.relocate(stage, destination)
            except ValueError as error:
                raise PackageError(str(error)) from error
            finally:
                if stage.exists(): shutil.rmtree(stage)
        return [x for x in old if x.id != package.id] + [installed]

    def publish(self, packages, default=None):
        if default is not None: need(default in {p.id for p in packages}, "unknown_default_character")
        entries, native_entries, native_files, scene = [], [], {}, None
        for package in sorted(packages, key=lambda x: x.id):
            prefix = package.root.relative_to(self.root).as_posix()
            definition = package.root / "character.json"
            entries.append(dict(id=package.id, definition=dict(file=prefix + "/character.json", sha256=package.sha256,
                                                               byte_count=definition.stat().st_size)))
            if not package.render_enabled: continue
            native_prefix = str(PurePosixPath(prefix) / PurePosixPath(package.native_ref["file"]).parent)
            entry = copy.deepcopy(package.native_entry)
            for field in NATIVE_FIELDS + NEUTRAL_FIELDS + VULKAN_FIELDS:
                if field in entry: entry[field]["file"] = native_prefix + "/" + entry[field]["file"]
            native_entries.append(entry)
            for ref in package.native["files"]:
                ref = dict(ref, file=native_prefix + "/" + ref["file"]); native_files[ref["file"]] = ref
            if package.native.get("scene"):
                original = package.native["scene"]["objects"]
                if scene: need(scene["objects"]["sha256"] == original["sha256"], "shared_scene_identity_mismatch")
                else: scene = dict(objects=dict(original, file=native_prefix + "/" + original["file"]))
        native = dict(schema="metal-native-character-bundle/v1", characters=native_entries,
                      files=[native_files[k] for k in sorted(native_files)], **(dict(scene=scene) if scene else {}))
        native_bytes = json_bytes(native); sha = hashlib.sha256(native_bytes).hexdigest()
        native_file = "native-" + sha + ".json"; write_json(self.root / native_file, native)
        if default is None and packages:
            previous_default=self.snapshot().get('default_character')
            default=previous_default if previous_default in {p.id for p in packages} else packages[0].id
        # An empty library has no default_character.
        payload = dict(schema="endfield-character-library/v1", characters=entries,
                       native_bundle=dict(file=native_file, sha256=sha, byte_count=len(native_bytes)),
                       **(dict(default_character=default) if default is not None else {}))
        snapshot = dict(payload, revision=hashlib.sha256(json_bytes(payload)).hexdigest())
        write_json(self.root / ("catalog-" + snapshot["revision"] + ".json"), snapshot)
        write_json(self.root / "current.json", snapshot)
        return snapshot


def validate_pack(host, package):
    """The Metal host must load the package's native bundle; its stderr is the failure reason."""
    if not package.render_enabled: return
    try:
        result = subprocess.run([str(host), "--validate-pack", str(package.resolve(package.native_ref))],
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                                timeout=VALIDATE_TIMEOUT)
    except subprocess.TimeoutExpired:
        # Not a PackageError: a host that cannot answer says nothing about the package.
        raise TimeoutError("load_failed: host validation timed out") from None
    need(result.returncode == 0, result.stderr.strip() or "load_failed: host validation exited " + str(result.returncode))


def materialize_library(catalog_path, destination):
    """Copy only the selected, validated generation, reusing exact content via CoW.

    No old generations, research files or mutable lock files enter the app seed.
    All v1 manifest bytes and relative paths remain compatible with every reader.
    """
    catalog_path, destination = Path(catalog_path).resolve(), Path(destination)
    need(not destination.exists(), 'resource_destination_exists')
    library = Library(catalog_path.parent, catalog_path.name)
    snapshot = library.snapshot()
    before = digest(catalog_path)
    resources = ResourceRepository()
    destination.mkdir(parents=True)
    try:
        for entry in snapshot['characters']:
            definition = contained(library.root, entry['definition']['file'])
            need(digest(definition) == entry['definition']['sha256'], 'definition_sha_mismatch')
            package = Package(definition.parent)
            prefix = package.root.relative_to(library.root)
            for ref in package.inventory.values():
                resources.materialize(contained(package.root,ref['file']),destination/prefix/ref['file'],ref,source_verified=True)
            resources.materialize(definition,destination/entry['definition']['file'],entry['definition'],source_verified=True)
        native = snapshot['native_bundle']
        resources.materialize(contained(library.root,native['file']),destination/native['file'],native)
        resources.materialize(catalog_path,destination/'current.json',dict(sha256=before,byte_count=catalog_path.stat().st_size))
        need(digest(catalog_path)==before,'catalog_changed_during_materialization')
        result = Library(destination)
        for package in result.packages(): Package(package.root)
        return dict(schema='endfield-resource-materialization/v1',catalog_sha256=before,
                    unique_contents=len(resources.content),**resources.stats)
    except BaseException:
        shutil.rmtree(destination)
        raise


def export_package(source, output):
    package = Package(source); output = Path(output)
    need(output.suffix == ".endfield-character", "unsupported_package_file")
    need(not output.exists(), "output_already_exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".export-", dir=output.parent); os.close(fd)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
            for name in ["character.json", *sorted(package.inventory)]:
                info = zipfile.ZipInfo(name); info.external_attr = 0o100644 << 16
                with contained(package.root, name).open("rb") as src, archive.open(info, "w", force_zip64=True) as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
        os.rename(temporary, output)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
