"""Import, probe, list, rename and remove motions and edit motion chains: import publishes one installed character rebuilt with a
new motion in place, probe reads a motion source without a library, list shows a character's imported motions, rename and remove
publish the character rebuilt with one imported motion retitled or taken out, chain checks a motion-chain proposal or publishes
the character rebuilt with it; Companion's motion import runs it by script path.

On success stdout ends with one JSON result line; import, mmd-media (which gives a shared MMD motion other music) and mmd-sync
(which aligns a character with the shared MMD library) first emit progress lines, mmd-list shows that library and mmd-scan sorts
an MMD project's files. On failure the last stderr line is {"ok": false, "reason", "detail"}.
"""
import argparse
import datetime
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import shutil
import signal
import struct
import sys

AGENTD = Path(__file__).resolve().parent
sys.path.insert(0, str(AGENTD))  # -I leaves the script's folder off the path
from character_library import Library, Package, PackageError, digest, read_json, validate_pack, write_json
from infra.platform import lock_file
from motion.zip_import import Failure, classify, extract, fail, placed, walk

# The host refuses a character with more action rows or motion media tracks than this.
HOST_ROWS = 128
MAX_SECONDS = 360
# The importer's ValueError messages start with one of these reasons; any other message is a bad source.
SOURCE_REASONS = ("unsupported_format", "bad_source", "bad_vmd", "no_animation", "unmapped_skeleton", "too_long")
# Hashed in this order.
FBX_SOURCES = ("build.sh", "fbx_motion.c", "ufbx.c", "ufbx.h")
# Each stage's share of the progress bar, in order: roughly its share of a timed dance import.
VMD_STAGES = (("read", .05), ("sample", .05), ("retarget", .35), ("write", .3), ("validate", .1), ("publish", .15))
TAKE_STAGES = (("read", .05), ("retarget", .45), ("write", .3), ("validate", .1), ("publish", .1))
# mmd-sync: the entries share this much of the bar; validate and publish the rest.
SYNC_ENTRIES = .85


class Progress:
    """Prints MOTION-IMPORT §9 progress lines, with counts (mmd-sync's total and done) on each; the printed fraction never
    decreases, and a step under 0.005 within one stage with unchanged counts is not printed."""
    def __init__(self, **counts): self.counts, self.printed = counts, None

    def span(self, stages, start=0.0, end=1.0):
        """progress(stage, fraction) mapping each stage's own 0–1 onto its share of start..end."""
        at, spans = start, {}
        for name, share in stages: spans[name] = (at, (end - start) * share); at += spans[name][1]
        return lambda stage, fraction: self.show(stage, spans[stage][0] + spans[stage][1] * fraction)

    def show(self, stage, fraction):
        line = dict(event="progress", stage=stage, fraction=round(min(fraction, 1.0), 3), **self.counts)
        if self.printed is not None:
            line["fraction"] = max(line["fraction"], self.printed["fraction"])
            if (stage == self.printed["stage"] and line["fraction"] - self.printed["fraction"] < .005 and line["fraction"] < 1
                    and self.counts.items() <= self.printed.items()): return
        self.printed = line
        print(json.dumps(line), flush=True)


def dev_fbx_tool(characters):
    """The dev checkout's fbx-motion: .build/fbx-motion/<first 16 hex of the sha256 over FBX_SOURCES' bytes>/fbx-motion."""
    sha = hashlib.sha256()
    for name in FBX_SOURCES: sha.update((characters / "agentic_complex_build/motion_import/native" / name).read_bytes())
    return characters / ".build/fbx-motion" / sha.hexdigest()[:16] / "fbx-motion"


def importer():
    """The importer package: the app's runtime/content when it is there, else the dev checkout's agentic_complex_build.
    Also names the fbx-motion tool the FBX importer runs, unless AAC_FBX_TOOL already does."""
    content = AGENTD.parent / "content"
    if (content / "import_vmd.py").is_file():
        os.environ.setdefault("AAC_FBX_TOOL", str(AGENTD.parent / ("tools/fbx-motion.exe" if sys.platform == "win32" else "tools/fbx-motion")))
        sys.path[:0] = [str(AGENTD.parent), str(content)]
        return "content"
    characters = AGENTD.parents[1] / "characters"
    os.environ.setdefault("AAC_FBX_TOOL", str(dev_fbx_tool(characters)))
    sys.path.insert(0, str(characters))
    return "agentic_complex_build"


def motion_import(suffix): return importlib.import_module(importer() + ".motion_import" + suffix)


def source_failure(error):
    reason = str(error).split(":")[0]
    fail(reason if reason in SOURCE_REASONS else "bad_source", error)


def find(library, character):
    package = library.package(character)
    if package is None: fail("internal", "unknown_character: " + character)
    if not package.render_enabled: fail("unsupported_character", character + " is text-only: it has no body to move")
    return package


def pack_folder(package):
    runtime = package.root / Path(package.native_ref["file"]).parent
    return runtime, (runtime / package.native_entry["c7"]["file"]).parent


def vmd_reports(package): return [read_json(p) for p in sorted((package.root / "provenance").glob("vmd-*.json"))]


def precheck(package, source, fmt, take):
    """Everything the importer would refuse late, checked against the installed package without writing; returns the format."""
    runtime, pack = pack_folder(package)
    rows = sum(len(read_json(pack / section / "actions.json")["actions"]) for section in ("animation", "interaction"))
    if rows >= HOST_ROWS: fail("too_many_actions", "%s already has %d action rows; the host loads at most %d" % (package.id, rows, HOST_ROWS))
    media = pack / "animation/motion-media.json"
    tracks = len(read_json(media)["tracks"]) if media.exists() else 0
    if tracks >= HOST_ROWS: fail("too_many_media", "%s already has %d motion media tracks; the host loads at most %d" % (package.id, tracks, HOST_ROWS))
    name = importer()
    module = lambda suffix: importlib.import_module(name + suffix)
    if fmt == "auto":
        try: fmt = motion_import(".formats").detect(source)
        except ValueError as error: fail("unsupported_format", error)
    if fmt == "vmd":
        try: motion = module(".import_vmd").checked_vmd(source)
        except ValueError as error: fail("bad_vmd", error)
        seconds = module(".mmd.io").last_frame(motion) / 30
        if seconds > MAX_SECONDS: fail("too_long", "the motion lasts %.1f s; at most %d s" % (seconds, MAX_SECONDS))
        if seconds <= 0: fail("bad_vmd", "the motion has a single frame")
    else:
        try: motion_import(".pipeline").probe_file(source, fmt, take)
        except ValueError as error: source_failure(error)
    archive = runtime / package.native_entry["actor_archive"]["file"]
    rig = read_json(archive.parent / read_json(archive)["rig"]["file"])
    skeleton = module(".mmd.skeleton")
    source = skeleton.MmdSkeleton(skeleton.add_semi_standard_bones(module(".mmd.reference").build_pmd()))
    try:
        humanoid = module(".mmd.native_rig").package_humanoid(package)
        module(".stance").Rig(rig, humanoid)
        module(".mmd.retarget").VmdToNative(module(".mmd.native_rig").NativeRig(rig, humanoid), module(".mmd.rig_math").Retarget, source)
    except (KeyError, ValueError) as error: fail("missing_bones", "%s's rig cannot take MMD motion: %r" % (package.id, error))
    return fmt


def keep(path, folder):
    """Content-addressed copy of an import source; returns its name in folder."""
    name = digest(path) + path.suffix.lower()
    if not (folder / name).exists():
        shutil.copyfile(path, folder / (name + ".partial")); os.replace(folder / (name + ".partial"), folder / name)
    return name


def finite(seconds):
    """--bgm-start: any finite number of seconds; a negative one starts the music after that much silence."""
    if seconds is not None and not math.isfinite(seconds): fail("bad_source", "--bgm-start must be a finite number of seconds")


def vmd_info(path):
    """zip_import.classify's reading of a VMD; ValueError when it does not parse."""
    io = importlib.import_module(importer() + ".mmd.io")
    try: motion = io.read_vmd(path)
    except struct.error as error: raise ValueError(error) from error
    frames = io.last_frame(motion) if motion.bones or motion.morphs else max((key[0] for key in motion.cameras), default=0)
    return dict(bones=len(motion.bones), cameras=len(motion.cameras), morphs=len({key.name for key in motion.morphs}),
                model=motion.model, frames=frames)


def inputs(args, paths):
    """The body, face and camera VMDs, audio, music offset and left-out-file warnings of the import; a lone non-ZIP --source is the
    body, else the files are sorted as mmd-scan sorts them and its suggestions fill what no flag names. No music, no offset."""
    if paths == [args.source]: body, morph, camera, bgm, start, warnings = args.source, args.morph, args.camera, args.bgm, args.bgm_start, []
    else:
        found = classify(paths, vmd_info); chosen = found["suggested"]
        pick = lambda kind, key: Path(found[kind][chosen[key]]["path"]) if chosen[key] is not None else None
        body = pick("bodies", "body")
        morph, camera, bgm = args.morph or pick("faces", "face"), args.camera or pick("cameras", "camera"), args.bgm or pick("audio", "audio")
        start = chosen["bgm_start_s"] if args.bgm_start is None else args.bgm_start
        left = [item["name"] for kind in ("bodies", "faces", "cameras", "audio") for item in found[kind]
                if Path(item["path"]) not in (body, morph, camera, bgm)]
        warnings = ["ignored_file: " + name for name in sorted(left + [item["name"] for item in found["ignored"]])]
    return body, morph, camera, bgm, start if bgm else None, warnings


def mmd_rows(package):
    reports = {report["action"] for report in vmd_reports(package)}
    return {row["id"]: row for row in read_json(pack_folder(package)[1] / "animation/actions.json")["actions"]
            if row["id"] in reports}


def load_mmd(library):
    """The shared MMD library; a v1 file or none reads as an empty v2 library."""
    path = library.root / "mmd-library/index.json"
    take = motion_import(".take")
    doc = read_json(path) if path.exists() else None
    if doc is None or doc.get("schema") == "endfield-mmd-library/v1": doc = dict(schema=take.MMD_SCHEMA, entries=[])
    take.check_mmd_index(doc)
    return doc


def save_mmd(library, doc):
    folder = library.root / "mmd-library"; folder.mkdir(exist_ok=True)
    sources = folder / "sources"; sources.mkdir(exist_ok=True)
    write_json(folder / "index.json", doc)
    live = {entry[key]["file"] for entry in doc["entries"] if entry["removed_at"] is None
            for key in ("source", "morph", "camera", "bgm") if entry[key] is not None}
    for path in sources.iterdir():
        if path.name not in live: path.unlink()


def entry_paths(library, entry):
    """The kept body, face, camera and music files of a library entry, None where it has none."""
    sources = library.root / "mmd-library/sources"
    return {key: sources / entry[key]["file"] if entry[key] else None for key in ("source", "morph", "camera", "bgm")}


def bumped(package, current):
    """current, chained from package, as package's next patch version, ready to validate and publish."""
    definition = read_json(current.root / "character.json")
    # The host finds the window envelope of an imported package by the version it derives from.
    definition.setdefault("base_package_version", package.version)
    major, minor, patch = map(int, package.version.split("."))
    definition["version"] = f"{major}.{minor}.{patch + 1}"
    write_json(current.root / "character.json", definition)
    # library.upgrade checks every file's SHA-256 in the copy it publishes.
    return Package(current.root, deep=False)


def mmd_list(args):
    library = Library(args.library)
    stages = library.root / ".vmd-stage"; stages.mkdir(exist_ok=True)
    with (stages / ".lock").open("a", encoding="utf-8") as lock:
        try: lock_file(lock, blocking=False)
        except BlockingIOError: fail("busy", "another motion import is running in " + str(library.root))
        doc = load_mmd(library)
        packages = [(package, mmd_rows(package)) for package in library.packages() if package.render_enabled]
        entries = []
        for entry in sorted(doc["entries"], key=lambda e: e["created_at"]):
            if entry["removed_at"] is not None: continue
            characters = []
            for package, rows in packages:
                failure = entry["failures"].get(package.id)
                failed = failure is not None and failure["package_sha256"] == package.sha256
                state = "baked" if entry["id"] in rows else "failed" if failed else "pending"
                characters.append(dict(id=package.id, state=state, reason=failure["reason"] if state == "failed" else None))
            project = entry["project"] or dict(title=None, role=None)
            entries.append(dict(id=entry["id"], title=entry["title"], duration_s=entry["duration_s"],
                                has_bgm=entry["bgm"] is not None, has_camera=entry["camera"] is not None, has_face=entry["has_face"],
                                project=project["title"], role=project["role"], created_at=entry["created_at"], characters=characters))
    return dict(ok=True, entries=entries)


def mmd_sync(args):
    host = args.validate_with.resolve()
    if not (host.is_file() and os.access(host, os.X_OK)): fail("validate_failed", "host executable is missing or not executable: " + str(host))
    library = Library(args.library)
    stages = library.root / ".vmd-stage"; stages.mkdir(exist_ok=True)
    with (stages / ".lock").open("a", encoding="utf-8") as lock:
        try: lock_file(lock, blocking=False)
        except BlockingIOError: fail("busy", "another motion import is running in " + str(library.root))
        package = find(library, args.character)
        stage = stages / package.id
        def terminated(signum, frame): raise SystemExit(143)
        previous = signal.signal(signal.SIGTERM, terminated)
        try:
            shutil.rmtree(stage, ignore_errors=True)
            stage.mkdir()
            doc = load_mmd(library)
            original = json.dumps(doc, sort_keys=True)
            current = package
            rows = mmd_rows(package)
            result = dict(ok=True, character=package.id, version=package.version, baked=[], renamed=[], removed=[], failed=[])
            failed = []
            live = {entry["id"] for entry in doc["entries"] if entry["removed_at"] is None}
            # Imported MMD rows no library entry names come last, to be removed.
            named = {entry["id"] for entry in doc["entries"]}
            work = [(entry["id"], entry) for entry in doc["entries"]] + [(action, None) for action in rows if action not in named]
            total = len(work)
            bar = Progress(total=total, done=0); bar.show("read", 0)
            for n, (action, entry) in enumerate(work, 1):
                row = rows.get(action)
                operation = None
                if entry is None: operation = "removed"
                elif entry["removed_at"] is not None:
                    if row is not None and action not in live: operation = "removed"
                elif row is not None:
                    if row["name"] != entry["title"]: operation = "renamed"
                else:
                    failure = entry["failures"].get(package.id)
                    if failure is None or failure["package_sha256"] != package.sha256: operation = "baked"
                if operation:
                    output = stage / str(n)
                    try:
                        if operation == "baked":
                            paths = entry_paths(library, entry)
                            precheck(current, paths["source"], "vmd", 0)
                            try:
                                parts = motion_import(".pipeline").import_file(current.root, paths["source"], "vmd", output,
                                    title=entry["title"], bgm=paths["bgm"], bgm_start=entry["bgm"]["offset_s"] if entry["bgm"] else None,
                                    foot_lock=entry["foot_lock"], camera=paths["camera"], morph=paths["morph"],
                                    progress=bar.span(VMD_STAGES[1:4], SYNC_ENTRIES * (n - 1) / total, SYNC_ENTRIES * n / total))
                            except ValueError as error: source_failure(error)
                            if parts["action"]["id"] != action: fail("internal", "the stored options bake %s, not %s" % (parts["action"]["id"], action))
                        else:
                            motion_import(".edit").edit_package(current.root, output, action=action, title=entry and entry["title"],
                                                                remove=operation == "removed")
                    except (Failure, PackageError) as error:
                        reason = error.reason if isinstance(error, Failure) else str(error)
                        if entry is not None:
                            entry["failures"][package.id] = dict(reason=reason, detail=str(error), package_sha256=package.sha256)
                            failed.append(entry)
                        result["failed"].append(dict(id=action, reason=reason, detail=str(error)))
                        shutil.rmtree(output, ignore_errors=True)
                    else:
                        current = Package(output, deep=False)
                        if entry is not None: entry["failures"].pop(package.id, None)
                        result[operation].append(action)
                bar.counts["done"] = n; bar.show(bar.printed["stage"] if operation == "baked" else "write", SYNC_ENTRIES * n / total)
            if current is not package:
                current = bumped(package, current)
                for entry in failed: entry["failures"][package.id]["package_sha256"] = current.sha256
                bar.show("validate", SYNC_ENTRIES)
                try: validate_pack(host, current)
                except (PackageError, TimeoutError) as error: fail("validate_failed", error)
                bar.show("publish", SYNC_ENTRIES + .05)
                library.upgrade(current.root, package.sha256)
                result["version"] = current.version
            if json.dumps(doc, sort_keys=True) != original: save_mmd(library, doc)
            bar.show("publish", 1)
            return result
        finally:
            shutil.rmtree(stage, ignore_errors=True)
            signal.signal(signal.SIGTERM, previous)


def run(args):
    host = args.validate_with.resolve()
    if not (host.is_file() and os.access(host, os.X_OK)): fail("validate_failed", "host executable is missing or not executable: " + str(host))
    finite(args.bgm_start)
    bar = Progress(); bar.show("read", 0)
    library = Library(args.library)
    package = find(library, args.character)
    zipped = args.source.suffix.lower() == ".zip"
    if not zipped:
        body, morph, camera, bgm, bgm_start, ignored = inputs(args, [args.source, *args.extra])
        fmt = precheck(package, body, args.format, args.take)
    title = args.title or args.source.stem
    take = motion_import(".take")
    stages = library.root / ".vmd-stage"; stages.mkdir(exist_ok=True)
    with (stages / ".lock").open("a", encoding="utf-8") as lock:
        try: lock_file(lock, blocking=False)
        except BlockingIOError: fail("busy", "another motion import is running in " + str(library.root))
        stage = stages / package.id
        unpacked = stages / (package.id + "-inputs")
        glb = stages / (package.id + "-glb")
        shutil.rmtree(stage, ignore_errors=True)  # left by a killed import
        shutil.rmtree(unpacked, ignore_errors=True); shutil.rmtree(glb, ignore_errors=True)
        try:
            if zipped:
                body, morph, camera, bgm, bgm_start, ignored = inputs(args, [*extract(args.source, unpacked), *args.extra])
                fmt = precheck(package, body, args.format, args.take)
            if fmt in ("gltf", "vrma"):
                # The kept source is one file: buffers beside a .gltf (a VRMA too) go into a GLB, which is baked and kept.
                glb.mkdir()
                try: body = motion_import(".gltf").packed(body, glb)
                except ValueError as error: source_failure(error)
            progress = bar.span(VMD_STAGES if fmt == "vmd" else TAKE_STAGES)
            progress("read", 1)
            try:
                parts = motion_import(".pipeline").import_file(
                    package.root, body, fmt, stage, take=args.take, title=title, bgm=bgm, bgm_start=bgm_start,
                    foot_lock=not args.no_foot_lock, bone_map=read_json(args.bone_map) if args.bone_map else None, camera=camera,
                    morph=morph, progress=progress)
            except ValueError as error:
                if "motion_already_imported" in str(error): fail("already_imported", error)
                source_failure(error)
            progress("validate", 0)
            # library.upgrade checks every file's SHA-256 in the copy it publishes.
            staged = Package(stage, deep=False)
            try: validate_pack(host, staged)
            except (PackageError, TimeoutError) as error: fail("validate_failed", error)
            progress("publish", 0)
            shared = load_mmd(library) if fmt == "vmd" else None
            sources = library.root / "mmd-library/sources" if fmt == "vmd" else library.root / "motion-imports" / package.id
            sources.mkdir(parents=True, exist_ok=True)
            kept = lambda path: dict(file=keep(path, sources), sha256=digest(path), name=path.name) if path else None
            created = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
            if fmt == "vmd":
                record = dict(id=parts["action"]["id"], title=title, duration_s=parts["action"]["duration_s"], created_at=created,
                              removed_at=None, source=kept(body), morph=kept(morph), camera=kept(camera),
                              bgm=dict(kept(bgm), offset_s=bgm_start) if bgm else None, foot_lock=not args.no_foot_lock,
                              has_face=parts["tracks"]["face"] is not None,
                              project=dict(title=args.project, role=args.role, place_frame=placed(body)[1]) if args.project is not None else None,
                              failures={})
            else:
                music = keep(bgm, sources) if bgm else None
                record = dict(action=parts["action"]["id"], clip=parts["action"]["clip"], format=parts["format"], title=title,
                              source=kept(body),
                              bgm=dict(file=music, sha256=Path(music).stem, offset_s=bgm_start) if music else None,
                              camera=kept(camera), zip=kept(args.source) if zipped else None, morphs_mapped=[], morphs_unmapped=[],
                              created_at=created, removed_at=None)
            library.upgrade(stage, package.sha256)
        finally:
            shutil.rmtree(stage, ignore_errors=True)
            shutil.rmtree(unpacked, ignore_errors=True); shutil.rmtree(glb, ignore_errors=True)
        if fmt == "vmd":
            entry = next((e for e in shared["entries"] if e["id"] == record["id"] and e["removed_at"] is None), None)
            if entry is None: shared["entries"].append(record)
            else: entry["failures"].pop(package.id, None)
            save_mmd(library, shared)
        else:
            index = sources / "imports.json"
            imports = read_json(index) if index.exists() else dict(schema=take.INDEX_SCHEMA, imports=[])
            imports["imports"].append(record); take.check_index(imports); write_json(index, imports)
    progress("publish", 1)
    return take.build_result(character=package.id, version=staged.version, created_at=created,
                             **dict(parts, warnings=parts["warnings"] + ignored))


def mmd_scan(args):
    """mmd-scan: the files of a folder, a ZIP (extracted under --unpack-to) or single files, sorted for an MMD import."""
    source, unpack = args.source.resolve(), args.unpack_to.resolve()
    if unpack.exists(): fail("bad_source", "--unpack-to already exists: " + str(unpack))
    files, zips = [], 0
    for path in (source, *(extra.resolve() for extra in args.extra)):
        if path.is_dir(): files += walk(path)
        elif path.suffix.lower() == ".zip": files += extract(path, unpack / str(zips)); zips += 1
        elif path.is_file(): files.append(path)
        else: fail("bad_source", "no such file or folder: " + str(path))
    root = source if source.is_dir() else unpack if source.suffix.lower() == ".zip" else source.parent
    return dict(ok=True, title=source.name if source.is_dir() else source.stem, root=str(root), **classify(files, vmd_info))


def mmd_media(args):
    """mmd-media: a library entry imported again with its own body, face and camera and other music, replacing the entry and the
    current character's row in one publish."""
    host = args.validate_with.resolve()
    if not (host.is_file() and os.access(host, os.X_OK)): fail("validate_failed", "host executable is missing or not executable: " + str(host))
    finite(args.bgm_start)
    bar = Progress(); bar.show("read", 0)
    library = Library(args.library)
    package = find(library, args.character)
    take = motion_import(".take")
    stages = library.root / ".vmd-stage"; stages.mkdir(exist_ok=True)
    with (stages / ".lock").open("a", encoding="utf-8") as lock:
        try: lock_file(lock, blocking=False)
        except BlockingIOError: fail("busy", "another motion import is running in " + str(library.root))
        shared = load_mmd(library)
        old = next((e for e in shared["entries"] if e["id"] == args.action and e["removed_at"] is None), None)
        if old is None: fail("unknown_action", args.action + " is not in the MMD library")
        paths, bgm = entry_paths(library, old), args.bgm
        bgm_start = args.bgm_start if bgm else None
        precheck(package, paths["source"], "vmd", 0)
        stage = stages / package.id
        shutil.rmtree(stage, ignore_errors=True)  # left by a killed import
        stage.mkdir()
        try:
            current = package
            if args.action in mmd_rows(package):
                try: motion_import(".edit").edit_package(package.root, stage / "removed", action=args.action, title=None, remove=True)
                except PackageError as error:
                    if str(error) in ("unknown_action", "not_imported", "linked_motion", "outside_package"): fail(str(error), error)
                    raise
                current = Package(stage / "removed", deep=False)
            progress = bar.span(VMD_STAGES)
            progress("read", 1)
            try:
                parts = motion_import(".pipeline").import_file(current.root, paths["source"], "vmd", stage / "imported",
                    title=old["title"], bgm=bgm, bgm_start=bgm_start, foot_lock=old["foot_lock"], camera=paths["camera"],
                    morph=paths["morph"], progress=progress)
            except ValueError as error:
                if "motion_already_imported" in str(error): fail("already_imported", error)
                source_failure(error)
            progress("validate", 0)
            staged = bumped(package, Package(stage / "imported", deep=False))
            try: validate_pack(host, staged)
            except (PackageError, TimeoutError) as error: fail("validate_failed", error)
            progress("publish", 0)
            sources = library.root / "mmd-library/sources"
            created = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
            entry = dict(old, id=parts["action"]["id"], duration_s=parts["action"]["duration_s"], created_at=created,
                         bgm=dict(file=keep(bgm, sources), sha256=digest(bgm), name=bgm.name, offset_s=bgm_start) if bgm else None,
                         has_face=parts["tracks"]["face"] is not None, failures={})
            library.upgrade(staged.root, package.sha256)
        finally:
            shutil.rmtree(stage, ignore_errors=True)
        old["removed_at"] = created
        shared["entries"].append(entry); save_mmd(library, shared)
    progress("publish", 1)
    return dict(take.build_result(character=package.id, version=staged.version, created_at=created, **parts), replaced=args.action)


def reclaim(sources, imports):
    """Deletes the kept sources no live index entry names (an entry whose action is unknown is never removed, so it keeps its files)."""
    live = {entry[key]["file"] for entry in imports["imports"] if entry["removed_at"] is None
            for key in ("source", "bgm", "camera", "zip") if entry[key] is not None}
    for path in sources.iterdir():
        if path.is_file() and path.name != "imports.json" and path.name not in live: path.unlink()


def edit(args, remove):
    """rename and remove: the package rebuilt without the motion or with its new title, published as import publishes."""
    host = args.validate_with.resolve()
    if not (host.is_file() and os.access(host, os.X_OK)): fail("validate_failed", "host executable is missing or not executable: " + str(host))
    library = Library(args.library)
    package = find(library, args.character)
    stages = library.root / ".vmd-stage"; stages.mkdir(exist_ok=True)
    with (stages / ".lock").open("a", encoding="utf-8") as lock:
        try: lock_file(lock, blocking=False)
        except BlockingIOError: fail("busy", "another motion import is running in " + str(library.root))
        shared, entry = None, None
        if args.action.startswith("mmd_"):
            shared = load_mmd(library)
            entry = next((e for e in shared["entries"] if e["id"] == args.action and e["removed_at"] is None), None)
            if not remove:
                args.title = args.title.strip()
                if not 1 <= len(args.title) <= 64: fail("bad_title", "bad_title")
            rows = read_json(pack_folder(package)[1] / "animation/actions.json")["actions"]
            if entry is not None and not any(row["id"] == args.action for row in rows):
                if remove: entry["removed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
                else: entry["title"] = args.title
                save_mmd(library, shared)
                return dict(ok=True, character=package.id, version=package.version, id=args.action,
                            **({} if remove else dict(title=args.title)))
        stage = stages / package.id
        shutil.rmtree(stage, ignore_errors=True)  # left by a killed import
        try:
            try: report = motion_import(".edit").edit_package(package.root, stage, action=args.action, title=getattr(args, "title", None), remove=remove)
            except PackageError as error:
                if str(error) in ("unknown_action", "not_imported", "bad_title", "linked_motion", "outside_package"): fail(str(error), error)
                raise
            # library.upgrade checks every file's SHA-256 in the copy it publishes.
            staged = Package(stage, deep=False)
            try: validate_pack(host, staged)
            except (PackageError, TimeoutError) as error: fail("validate_failed", error)
            library.upgrade(stage, package.sha256)
        finally:
            shutil.rmtree(stage, ignore_errors=True)
        if entry is not None:
            if remove: entry["removed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
            else: entry["title"] = report["title"]
            save_mmd(library, shared)
        sources = library.root / "motion-imports" / package.id; index = sources / "imports.json"
        if index.exists():
            take = motion_import(".take")
            imports = read_json(index)
            now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
            for entry in imports["imports"]:
                if entry["action"] == args.action and entry["removed_at"] is None:
                    if remove: entry["removed_at"] = now
                    else: entry["title"] = report["title"]
            take.check_index(imports); write_json(index, imports)
            if remove: reclaim(sources, imports)
    return dict(ok=True, character=package.id, version=staged.version, id=args.action, **({} if remove else dict(title=report["title"])))


def chain(args):
    """chain: with --check the proposal's problems and graph changes, else the package rebuilt with it, published as rename publishes."""
    library = Library(args.library)
    package = find(library, args.character)
    try: proposal = read_json(args.proposal)
    except PackageError as error: fail("bad_proposal", error)
    chain_edit = motion_import(".chain_edit")
    if args.check: return chain_edit.check(package.root, proposal)
    host = args.validate_with.resolve()
    if not (host.is_file() and os.access(host, os.X_OK)): fail("validate_failed", "host executable is missing or not executable: " + str(host))
    stages = library.root / ".vmd-stage"; stages.mkdir(exist_ok=True)
    with (stages / ".lock").open("a", encoding="utf-8") as lock:
        try: lock_file(lock, blocking=False)
        except BlockingIOError: fail("busy", "another motion import is running in " + str(library.root))
        stage = stages / package.id
        shutil.rmtree(stage, ignore_errors=True)  # left by a killed import
        try:
            try: chain_edit.chain_package(package.root, stage, proposal)
            except chain_edit.Refused as error:
                reason = error.problems[0]["reason"]
                fail(reason if reason in ("stale", "bad_proposal") else "chain_refused", json.dumps(error.problems, ensure_ascii=False))
            # library.upgrade checks every file's SHA-256 in the copy it publishes.
            staged = Package(stage, deep=False)
            try: validate_pack(host, staged)
            except (PackageError, TimeoutError) as error: fail("validate_failed", error)
            library.upgrade(stage, package.sha256)
        finally:
            shutil.rmtree(stage, ignore_errors=True)
    return dict(ok=True, character=package.id, version=staged.version)


def probe(args):
    try: return dict(ok=True, **motion_import(".pipeline").probe_file(args.source, args.format, args.take))
    except ValueError as error: source_failure(error)


def list_motions(args):
    """The current package's imported motions still in its action menu, in menu order; the index only supplies created_at."""
    library = Library(args.library)
    package = find(library, args.character)
    reports = {}
    for path in sorted((package.root / "provenance").glob("*.json")):
        report = read_json(path)
        if report.get("schema") == "endfield-vmd-import/v1":
            reports[report["action"]] = dict(clip=report["clip"], format="vmd", has_bgm=report["bgm"] is not None, warnings=[])
        elif report.get("schema") == "endfield-motion-import/v1":
            reports[report["action"]["id"]] = dict(clip=report["action"]["clip"], format=report["format"],
                                                   has_bgm=report["tracks"]["audio"] is not None, warnings=report["warnings"])
    index = library.root / "motion-imports" / package.id / "imports.json"
    imports = read_json(index) if index.exists() else dict(imports=[])
    created = {}
    for entry in imports["imports"]:
        if entry["removed_at"] is None: created.setdefault(entry["action"], entry["created_at"])
    shared = library.root / "mmd-library/index.json"
    for entry in read_json(shared)["entries"] if shared.exists() else []:
        if entry["removed_at"] is None: created.setdefault(entry["id"], entry["created_at"])
    rows = read_json(pack_folder(package)[1] / "animation/actions.json")["actions"]
    motions = [dict(id=row["id"], clip=reports[row["id"]]["clip"], title=row["name"], format=reports[row["id"]]["format"],
                    duration_s=row["duration"], has_bgm=reports[row["id"]]["has_bgm"], created_at=created.get(row["id"]),
                    warnings=reports[row["id"]]["warnings"]) for row in rows if row["id"] in reports]
    return dict(ok=True, character=package.id, version=package.version, motions=motions)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    sub = commands.add_parser("import")
    for name in ("library", "source", "validate-with"): sub.add_argument("--" + name, type=Path, required=True)
    sub.add_argument("--character", required=True)
    sub.add_argument("--bgm", type=Path); sub.add_argument("--title")
    # The importer, not argparse, refuses a format it does not know, so that reports unsupported_format.
    sub.add_argument("--format", default="auto"); sub.add_argument("--take", type=int, default=0)
    sub.add_argument("--bgm-start", type=float); sub.add_argument("--no-foot-lock", action="store_true")
    sub.add_argument("--bone-map", type=Path); sub.add_argument("--extra", type=Path, action="append", default=[])
    sub.add_argument("--morph", type=Path); sub.add_argument("--camera", type=Path)
    sub.add_argument("--project"); sub.add_argument("--role")
    sub = commands.add_parser("mmd-scan")
    for name in ("source", "unpack-to"): sub.add_argument("--" + name, type=Path, required=True)
    sub.add_argument("--extra", type=Path, action="append", default=[])
    sub = commands.add_parser("mmd-media")
    for name in ("library", "validate-with"): sub.add_argument("--" + name, type=Path, required=True)
    sub.add_argument("--character", required=True); sub.add_argument("--action", required=True)
    music = sub.add_mutually_exclusive_group(required=True)
    music.add_argument("--bgm", type=Path); music.add_argument("--no-bgm", action="store_true")
    sub.add_argument("--bgm-start", type=float)
    sub = commands.add_parser("probe")
    sub.add_argument("--source", type=Path, required=True)
    sub.add_argument("--format", default="auto"); sub.add_argument("--take", type=int, default=0)
    sub = commands.add_parser("list")
    sub.add_argument("--library", type=Path, required=True); sub.add_argument("--character", required=True)
    sub = commands.add_parser("mmd-list")
    sub.add_argument("--library", type=Path, required=True)
    sub = commands.add_parser("mmd-sync")
    for name in ("library", "validate-with"): sub.add_argument("--" + name, type=Path, required=True)
    sub.add_argument("--character", required=True)
    for command in ("rename", "remove"):
        sub = commands.add_parser(command)
        for name in ("library", "validate-with"): sub.add_argument("--" + name, type=Path, required=True)
        sub.add_argument("--character", required=True); sub.add_argument("--action", required=True)
        if command == "rename": sub.add_argument("--title", required=True)
    sub = commands.add_parser("chain")
    for name in ("library", "proposal", "validate-with"): sub.add_argument("--" + name, type=Path, required=True)
    sub.add_argument("--character", required=True); sub.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps({"import": run, "probe": probe, "list": list_motions, "rename": lambda a: edit(a, False),
                          "remove": lambda a: edit(a, True), "chain": chain, "mmd-sync": mmd_sync, "mmd-list": mmd_list,
                          "mmd-scan": mmd_scan, "mmd-media": mmd_media}[args.command](args), ensure_ascii=False))
        return 0
    except Failure as error: reason, detail = error.reason, str(error)
    except Exception as error: reason, detail = "internal", "%s: %s" % (type(error).__name__, error)
    print(json.dumps(dict(ok=False, reason=reason, detail=detail), ensure_ascii=False), file=sys.stderr)
    return 2


if __name__ == "__main__": sys.exit(main())
