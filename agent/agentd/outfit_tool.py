"""Import and remove EFMI mod appearances: import publishes one installed character rebuilt with the mod's textures and geometry as a new
imported appearance, remove publishes it rebuilt without one; Companion's outfit import runs it by script path.

On success stdout ends with one JSON result line, after import's progress lines; on failure the last stderr line is {"ok": false, "reason", "detail"}.
The mod's files are never kept: the library records only its fingerprint, name and time.
"""
import argparse
import datetime
import importlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace

AGENTD = Path(__file__).resolve().parent
sys.path.insert(0, str(AGENTD))  # -I leaves the script's folder off the path
from character_library import Library, Package, PackageError, digest, read_json, validate_pack, write_json
from infra.platform import lock_file
from motion.zip_import import Failure, fail
from motion_tool import Progress

INDEX_SCHEMA = "endfield-outfit-imports/v1"
# Each stage's share of the import's progress bar, in order: roughly its share of a timed outfit import.
STAGES = (("read", .2), ("compose", .25), ("write", .25), ("validate", .1), ("publish", .2))
# The importer's ValueError messages start with one of these reasons; any other message is a mod it cannot import.
IMPORT_REASONS = ("unsupported_mod", "merged_skeleton", "unsafe_path", "unmapped_component", "bone_out_of_range",
                  "missing_channel", "texture_mismatch", "nothing_to_import", "not_this_character",
                  "unsupported_texture_format", "unsupported_geometry", "geometry_invalid", "channel_unresolved",
                  "geometry_too_large", "ambiguous_ini", "absent_template_mesh", "absent_template_submesh", "index_format",
                  "unknown_bone", "duplicate_bone", "duplicate_submesh", "graph_store_missing", "skin_matrices_layout",
                  "channel_size", "texture_size", "buffer_size", "mod_too_large", "duplicate_appearance",
                  "invalid_mapping", "invalid_slot_hints", "invalid_lod1_bones", "invalid_mod_settings")


def importer():
    """The importer package: the app's runtime/content when it is there, else the dev checkout's agentic_complex_build."""
    content = AGENTD.parent / "content"
    if (content / "import_outfit.py").is_file():
        sys.path[:0] = [str(AGENTD.parent), str(content)]
        return "content"
    sys.path.insert(0, str(AGENTD.parents[1] / "characters"))
    return "agentic_complex_build"


def outfit_module(name): return importlib.import_module(importer() + "." + name)


def checked_host(args):
    host = args.validate_with.resolve()
    if not (host.is_file() and os.access(host, os.X_OK)): fail("validate_failed", "host executable is missing or not executable: " + str(host))
    return host


def find(library, character):
    package = library.package(character)
    if package is None: fail("internal", "unknown_character: " + character)
    return package


def imported(package):
    """The ids of package's kind=imported appearances, in pack order."""
    if not package.render_enabled: return []
    pack = read_json(package.root / Path(package.native_ref["file"]).parent / package.native_entry["c7"]["file"])
    return [a["id"] for a in pack["appearances"] if a.get("kind") == "imported"]


def named_files(value):
    """Every "file" string anywhere in a JSON document."""
    if isinstance(value, list): return set().union(*map(named_files, value))
    if not isinstance(value, dict): return set()
    return set().union({value["file"]} if isinstance(value.get("file"), str) else set(), *map(named_files, value.values()))


def documents(root, package):
    """The documents package's appearances live in, read from root: package's directory or a clone of it."""
    d = SimpleNamespace(native_path=root / package.native_ref["file"]); d.runtime = d.native_path.parent
    d.native = read_json(d.native_path); d.entry = d.native["characters"][0]
    d.source_path, d.graph_path, d.pack_path = (d.runtime / d.entry[k]["file"] for k in ("source", "graph", "c7"))
    d.source, d.graph, d.pack = read_json(d.source_path), read_json(d.graph_path), read_json(d.pack_path)
    d.animation = d.pack_path.parent / "animation"
    d.palette_path = d.animation / d.pack["animation"]["palette_contract"]["file"]; d.palette = read_json(d.palette_path)
    d.settings_path = d.pack_path.parent / "interaction" / "mod-settings.json"
    listed = any(r["file"] == "mod-settings.json" for r in d.pack["interaction"]["data"])
    d.settings = read_json(d.settings_path) if listed else None
    # A blob name is relative to the folder of the document naming it: the source manifest or the graph.
    d.folders = {d.source_path.parent: [d.source]}
    d.folders.setdefault(d.graph_path.parent, []).append(d.graph)
    return d


def clone(package_root, output):
    """(the package's documents read from its copy in the NEW directory output, reference(path, root)): ref(path, root), and a
    file of the copy not rewritten since keeps its package file's verified digest, which Package(output) checks again."""
    ref = outfit_module("common").reference
    package = Package(package_root)
    subprocess.run(["/bin/cp", "-cR", str(package.root), str(output)], check=True)
    def stamp(path): s = path.stat(); return s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns
    cloned = {p: stamp(p) for p in output.rglob("*") if p.is_file()}
    def reference(path, root):
        old = package.inventory.get(path.relative_to(output).as_posix())
        if old is None or cloned.get(path) != stamp(path): return ref(path, root)
        return dict(file=path.relative_to(root).as_posix(), sha256=old["sha256"], byte_count=old["byte_count"])
    return documents(output, package), reference


def finish(output, d, definition, reference):
    """Write the changed documents d of the copy output and index it again: its native bundle, coverage and inventory."""
    ref = outfit_module("common").reference
    native_bundle = importlib.import_module("native_bundle")  # the importer package puts it on sys.path
    runtime, entry, native, animation, pack = d.runtime, d.entry, d.native, d.animation, d.pack
    write_json(d.source_path, d.source)
    d.graph["manifest_sha256"] = digest(d.source_path); native_bundle.write_neutral(runtime, entry, d.graph)
    write_json(d.palette_path, d.palette); pack["animation"]["palette_contract"] = ref(d.palette_path, animation)
    if (animation / "supplemental-clips.json").exists():
        clips = read_json(animation / "supplemental-clips.json"); clips["base_contract_sha256"] = digest(d.palette_path)
        write_json(animation / "supplemental-clips.json", clips)
    for section in ["animation", "interaction"]:
        folder = d.pack_path.parent / section
        pack[section]["data"] = [dict(x, **ref(folder / x["file"], folder)) for x in pack[section]["data"]]
    pack["render"]["manifest"] = ref(d.source_path, d.source_path.parent); write_json(d.pack_path, pack)
    for key, path in (("source", d.source_path), ("graph", d.graph_path), ("c7", d.pack_path)): entry[key] = ref(path, runtime)
    cp = runtime / entry["coverage"]["file"]; write_json(cp, native_bundle.character_coverage(runtime, entry)); entry["coverage"] = ref(cp, runtime)
    roles = {x["file"]: x.get("roles", ["runtime_imported_outfit"]) for x in native["files"]}
    native["files"] = [dict(**reference(p, runtime), roles=roles.get(p.relative_to(runtime).as_posix(), ["runtime_imported_outfit"]))
                       for p in sorted(runtime.rglob("*")) if p.is_file() and p != d.native_path]
    write_json(d.native_path, native); native_bundle.verify(runtime)
    definition["components"]["render"]["native_bundle"] = ref(d.native_path, output)
    definition["inventory"] = [reference(p, output) for p in sorted(output.rglob("*")) if p.is_file() and p != output / "character.json"]
    write_json(output / "character.json", definition)
    return Package(output)


def strip(package_root, output, appearances, bump):
    """Clone the package to the NEW directory output without the imported appearances, their draws, the blobs only they used
    and their import reports; bump raises the patch version so the result can replace the package in its library."""
    compose = outfit_module("outfit_compose")
    output = Path(output); d, reference = clone(package_root, output)
    before = {folder: named_files(docs) for folder, docs in d.folders.items()}
    settings = d.settings
    for appearance in appearances:
        state = compose.remove_appearance(d.source, d.graph, d.palette, d.pack, appearance, mod_settings=settings)["mod_settings"]
        (output / "provenance" / ("outfit-" + appearance + ".json")).unlink(missing_ok=True)
        if state == "removed": d.settings_path.unlink(); settings = None
    if settings is not None: write_json(d.settings_path, settings)
    for folder, docs in d.folders.items():
        for name in before[folder] - named_files(docs): (folder / name).unlink(missing_ok=True)
    definition = read_json(output / "character.json")
    if bump:
        major, minor, patch = map(int, definition["version"].split(".")); definition["version"] = f"{major}.{minor}.{patch+1}"
    return finish(output, d, definition, reference)


def graft(package_root, donor_root, output, appearances, version):
    """Clone the package to the NEW directory output with the imported appearances of the package at donor_root (the same character
    built from another base), their draws, blobs and import reports, at `version`, derived from the package's own version."""
    compose = outfit_module("outfit_compose")
    output = Path(output); d, reference = clone(package_root, output)
    donor = Package(donor_root, deep=False); old = documents(donor.root, donor)
    origins = {d.source_path.parent: old.source_path.parent, d.graph_path.parent: old.graph_path.parent}
    before = {folder: named_files(docs) for folder, docs in d.folders.items()}
    settings = d.settings
    (output / "provenance").mkdir(exist_ok=True)
    for appearance in appearances:
        settings = compose.graft_appearance(d.source, d.graph, d.palette, d.pack, (old.source, old.graph, old.palette, old.pack), appearance,
                                            mod_settings=settings, old_settings=old.settings)["mod_settings"]
        report = "outfit-" + appearance + ".json"
        shutil.copyfile(donor.root / "provenance" / report, output / "provenance" / report)
    if settings is not None: write_json(d.settings_path, settings)
    for folder, docs in d.folders.items():
        for name in named_files(docs) - before[folder]:
            origin, target = origins[folder] / name, folder / name
            # A graph blob absent beside the donor's graph is one the runtime reads from its source Files by SHA.
            if not origin.exists(): origin, target = (f / "Files" / Path(name).name for f in (old.source_path.parent, d.source_path.parent))
            if not target.exists(): target.parent.mkdir(exist_ok=True); shutil.copyfile(origin, target)
    definition = read_json(output / "character.json")
    definition["base_package_version"] = definition["version"]; definition["version"] = version
    return finish(output, d, definition, reference)


def locked(library, package, host, build, progress=lambda stage, fraction: None):
    """Under the library's outfit lock: build(stage) writes the package's new version to stage, which is validated and
    published in place of package; the stage is always removed. Returns the published package."""
    stages = library.root / ".outfit-stage"; stages.mkdir(exist_ok=True)
    with (stages / ".lock").open("a", encoding="utf-8") as lock:
        try: lock_file(lock, blocking=False)
        except BlockingIOError: fail("busy", "another outfit import is running in " + str(library.root))
        stage = stages / package.id
        shutil.rmtree(stage, ignore_errors=True)  # left by a killed import
        try:
            build(stage)
            progress("validate", 0)
            # library.upgrade checks every file's SHA-256 in the copy it publishes.
            staged = Package(stage, deep=False)
            try: validate_pack(host, staged)
            except PackageError as error: fail("validate_failed", error)
            progress("publish", 0)
            library.upgrade(stage, package.sha256)
        finally:
            shutil.rmtree(stage, ignore_errors=True)
        return staged


def run_import(args):
    host = checked_host(args)
    progress = Progress().span(STAGES); progress("read", 0)
    library = Library(args.library)
    package = find(library, args.character)
    report = {}
    def build(stage):
        try: report.update(outfit_module("import_outfit").import_outfit(package.root, args.source, stage, name=args.name, mapping=args.map,
                                                                        progress=progress))
        except ValueError as error:
            reason = str(error).split(":")[0]
            fail(reason if reason in IMPORT_REASONS else "unsupported_mod", error)
    staged = locked(library, package, host, build, progress)
    index = library.root / "outfit-imports" / package.id / "imports.json"
    imports = read_json(index) if index.exists() else dict(schema=INDEX_SCHEMA, imports=[])
    imports["imports"].append(dict(appearance=report["appearance"]["id"], name=report["appearance"]["name"],
                                   fingerprint=report["source"]["fingerprint"], created_at=report["source"]["imported_at"], removed_at=None))
    write_json(index, imports)
    progress("publish", 1)
    return dict(ok=True, character=package.id, version=staged.version, appearance=report["appearance"],
                warnings=report.get("warnings", []))


def run_remove(args):
    host = checked_host(args)
    library = Library(args.library)
    package = find(library, args.character)
    if args.appearance not in imported(package): fail("not_imported", "%s has no imported appearance %s" % (package.id, args.appearance))
    def build(stage): strip(package.root, stage, [args.appearance], bump=True)
    staged = locked(library, package, host, build)
    index = library.root / "outfit-imports" / package.id / "imports.json"
    if index.exists():
        imports = read_json(index)
        now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
        for entry in imports["imports"]:
            if entry["appearance"] == args.appearance and entry["removed_at"] is None: entry["removed_at"] = now
        write_json(index, imports)
    return dict(ok=True, character=package.id, version=staged.version, appearance=dict(id=args.appearance))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    sub = commands.add_parser("import")
    for name in ("library", "source", "validate-with"): sub.add_argument("--" + name, type=Path, required=True)
    sub.add_argument("--character", required=True)
    sub.add_argument("--name"); sub.add_argument("--map", type=Path)
    sub = commands.add_parser("remove")
    for name in ("library", "validate-with"): sub.add_argument("--" + name, type=Path, required=True)
    sub.add_argument("--character", required=True); sub.add_argument("--appearance", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps({"import": run_import, "remove": run_remove}[args.command](args), ensure_ascii=False))
        return 0
    except Failure as error: reason, detail = error.reason, str(error)
    except Exception as error: reason, detail = "internal", "%s: %s" % (type(error).__name__, error)
    print(json.dumps(dict(ok=False, reason=reason, detail=detail), ensure_ascii=False), file=sys.stderr)
    return 2


if __name__ == "__main__": sys.exit(main())
