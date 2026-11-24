"""Offline startup seed merge. The Companion instance lock must be held.

Build a new immutable generation: every seed character's package is the seed's, rebuilt with the user's outfit and motion imports
of the old one; custom roles, the old catalog and the import records are retained.
Live import still cannot replace an ID underneath an active character-switch/C3 transaction.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from character_library import Library, Package, digest, need, read_json, validate_pack, write_json
from motion.zip_import import Failure
from resource_store import clone_or_copy

# The library's import records and kept sources, carried to the new generation.
RECORDS = ("outfit-imports", "mmd-library", "motion-imports")


def reapply(target, base, previous, host, work):
    """Publish base, the seed package installed in target, rebuilt with the live imports of previous, the old library's package of
    its character; returns their failures as (record, reason). An import that cannot be rebuilt is left out and its record marked;
    a validation failure keeps base and marks every record. Only a ValueError or Failure verdict marks a record: any other error
    (OSError, a host that cannot run) aborts the merge. MMD motions are left to mmd-sync, which bakes them again later."""
    outfits = target.root / "outfit-imports" / base.id / "imports.json"
    motions = target.root / "motion-imports" / base.id / "imports.json"
    if not outfits.exists() and not motions.exists(): return []
    # Imported only here: a library without imports needs none of the importers.
    import motion_tool
    import outfit_tool
    outfit_index = read_json(outfits) if outfits.exists() else None
    motion_index = read_json(motions) if motions.exists() else None
    take = motion_tool.motion_import(".take") if motion_index is not None else None
    appearances = outfit_tool.imported(previous)
    takes = [e for e in (motion_index or {}).get("imports", [])
             if e["format"] != "vmd" and e["removed_at"] is None and e["action"] is not None]
    if not appearances and not takes: return []
    version = lambda p: tuple(int(x) for x in p.version.split("."))
    major, minor, patch = max(version(base), version(previous))
    current, applied, failures = base, [], []
    for n, appearance in enumerate(appearances):
        output = work / ("outfit-%d" % n)
        try: current = outfit_tool.graft(current.root, previous.root, output, [appearance], current.version)
        except (Failure, ValueError) as error:
            shutil.rmtree(output, ignore_errors=True); failures.append((("outfit", appearance), "%s: %s" % (type(error).__name__, error)))
        else: applied.append(("outfit", appearance))
    for n, entry in enumerate(takes):
        output = work / ("motion-%d" % n)
        report = previous.root / "provenance" / (entry["format"] + "-" + entry["action"][len(entry["format"]) + 1:] + ".json")
        options = read_json(report) if report.exists() else None
        sources = motions.parent
        try:
            parts = motion_tool.motion_import(".pipeline").import_file(
                current.root, sources / entry["source"]["file"], entry["format"], output,
                take=options["source"]["take"] if options else 0, title=entry["title"],
                bgm=sources / entry["bgm"]["file"] if entry["bgm"] else None,
                bgm_start=entry["bgm"]["offset_s"] if entry["bgm"] else None,
                foot_lock=options["tracks"]["body"]["foot_lock"] if options else True)
        except (Failure, ValueError) as error:
            shutil.rmtree(output, ignore_errors=True); failures.append((("motion", entry), "%s: %s" % (type(error).__name__, error)))
        else:
            current = Package(output, deep=False); applied.append(("motion", entry))
            entry["action"], entry["clip"] = parts["action"]["id"], parts["action"]["clip"]
    if current is not base:
        definition = read_json(current.root / "character.json")
        definition["version"] = f"{major}.{minor}.{patch + 1}"; definition["base_package_version"] = base.version
        write_json(current.root / "character.json", definition)
        try:
            # Library.upgrade checks every file's SHA-256 in the copy it publishes.
            staged = Package(current.root, deep=False)
            if host is not None: validate_pack(host, staged)
            target.upgrade(staged.root, base.sha256)
        except ValueError as error:
            failures += [(record, "validate_failed: %s" % error) for record in applied]
    when = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    for (kind, record), reason in failures:
        print("%s: %s import %s not carried over: %s" % (base.id, kind, record if kind == "outfit" else record["title"], reason), file=sys.stderr)
        if kind == "outfit":
            for entry in (outfit_index or {}).get("imports", []):
                if entry["appearance"] == record and entry["removed_at"] is None: entry.update(removed_at=when, migration_failure=reason)
        else: record["removed_at"] = when
    if outfit_index is not None: write_json(outfits, outfit_index)
    if motion_index is not None: take.check_index(motion_index); write_json(motions, motion_index)
    return failures


def merge_seed(seed_catalog, seed_sha256, existing_catalog, existing_sha256, output, validate_with=None):
    """validate_with: the host executable that must load each rebuilt package; None skips that check."""
    seed_catalog, existing_catalog, output = map(lambda p: Path(p).resolve(), (seed_catalog, existing_catalog, output))
    host = None if validate_with is None else Path(validate_with).resolve()
    need(host is None or (host.is_file() and os.access(host, os.X_OK)), "load_failed: host executable is missing or not executable: " + str(host))
    need(digest(seed_catalog) == seed_sha256, 'seed_catalog_sha_mismatch')
    need(digest(existing_catalog) == existing_sha256, 'existing_catalog_changed')
    if output.exists():
        marker = read_json(output / 'distribution-seed.json')
        need(marker.get('seed_sha256') == seed_sha256 and marker.get('previous_catalog_sha256') == existing_sha256,
             'seed_generation_collision')
        result = Library(output).snapshot(); Library(output).packages()
        return result
    seed = Library(seed_catalog.parent, seed_catalog.name)
    existing = Library(existing_catalog.parent, existing_catalog.name)
    previous = {p.id: p for p in existing.packages()}
    selected = dict(previous, **{p.id: p for p in seed.packages()})
    old_default = existing.snapshot().get('default_character')
    default = old_default if old_default in selected else seed.snapshot()['default_character']
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.seed-', dir=output.parent))
    try:
        # Install the default first: Library's atomic publisher preserves it.
        target = Library(stage)
        for cid in [default] + sorted(set(selected) - {default}): target.install(selected[cid].root)
        for name in RECORDS:
            if (existing.root / name).is_dir(): shutil.copytree(existing.root / name, stage / name, symlinks=True, copy_function=clone_or_copy)
        work = stage / '.reapply'; failed = {}
        for package in target.packages():
            old = previous.get(package.id)
            if old is None or old.sha256 == package.sha256: continue
            work.mkdir(exist_ok=True)
            failures = reapply(target, package, old, host, work)
            if failures: failed[package.id] = [reason for _, reason in failures]
            shutil.rmtree(work)
        need(digest(seed_catalog) == seed_sha256, 'seed_catalog_changed')
        need(digest(existing_catalog) == existing_sha256, 'existing_catalog_changed')
        write_json(stage / 'distribution-seed.json', dict(schema='endfield-distribution-seed/v1',
            seed_sha256=seed_sha256, previous_catalog_sha256=existing_sha256, imports_not_carried_over=failed,
            resource_materialization=dict(target.resources.stats,unique_contents=len(target.resources.content))))
        stage.rename(output)
        return Library(output).snapshot()
    finally:
        if stage.exists(): shutil.rmtree(stage)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ['seed-catalog', 'existing-catalog', 'output']: parser.add_argument('--' + key, type=Path, required=True)
    for key in ['seed-sha256', 'existing-sha256']: parser.add_argument('--' + key, required=True)
    parser.add_argument('--validate-with', type=Path)
    args = parser.parse_args()
    try:
        result = merge_seed(args.seed_catalog, args.seed_sha256, args.existing_catalog, args.existing_sha256, args.output,
                            args.validate_with)
        print(json.dumps(dict(revision=result['revision'], ids=[x['id'] for x in result['characters']])))
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr); raise SystemExit(2)
