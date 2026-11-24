"""Rename or remove an imported motion by rebuilding its package, undoing what import_vmd.install_clips wrote."""
import json
from pathlib import Path
import shutil
import tempfile

from character_library import Package, digest, need, read_json, write_json
import native_bundle
from resource_store import clone_or_copy
from ..common import canonical_json, reference as ref, sha256_bytes
from ..motion_graph import FILE as GRAPH, pack_graph, text

EDIT_SCHEMA = 'endfield-motion-edit/v1'
MAP = 'intent-motion-map.json'


def write_document(path, value):
    """write_json, except the intent-motion-map keeps its key order: ActorMotionPolicy prefers an intent's clips in that order."""
    if Path(path).name != MAP: return write_json(path, value)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n', encoding='utf-8')


def cloned_ref(package, stage, p, root):
    """ref(p, root) for p in stage, a clone_or_copy copy of package; a file still as cloned (an APFS clone keeps size and mtime) keeps the hash of
    the package's inventory, which the library checks in the copy it publishes; a file the edit rewrote was read from a package
    file that must match it."""
    # String slices: p lies under root and root under stage, and relative_to is slow over every file of a package.
    key = str(p)[len(str(stage))+1:]; known = package.inventory.get(key)
    if known is None: return ref(p, root)
    a, b = p.stat(), (package.root/key).stat()
    if (a.st_size, a.st_mtime_ns) != (b.st_size, b.st_mtime_ns):
        need(digest(package.root/key) == known['sha256'], 'file_sha_mismatch')
        return ref(p, root)
    return dict(file=str(p)[len(str(root))+1:], sha256=known['sha256'], byte_count=known['byte_count'])


def imported_report(package_root, action):
    """The provenance report path and clip name of the import that added action, or (None, None)."""
    for path in sorted((Path(package_root)/'provenance').glob('*.json')):
        doc = read_json(path)
        if doc.get('schema') == 'endfield-vmd-import/v1' and doc.get('action') == action: return path, doc['clip']
        if doc.get('schema') == 'endfield-motion-import/v1' and doc['action']['id'] == action: return path, doc['action']['clip']
    return None, None


def edit_package(package_root, output, *, action, title=None, remove=False):
    """Clone the package to the NEW directory output with action removed (remove=True) or renamed to title.

    Returns the provenance/edit-<16hex>.json document. Raises PackageError unknown_action, not_imported or bad_title."""
    # cloned_ref checks the inventory's SHA-256 of each file this rewrites; the library checks the others when it publishes.
    package = Package(package_root, deep=False); output = Path(output).resolve()
    need(not output.exists(), 'output_already_exists')
    need(not output.is_relative_to(package.root), 'output_inside_input_package')
    pack_ref = Path(package.native_ref['file']).parent/package.native_entry['c7']['file']
    rows = read_json(package.root/pack_ref.parent/'animation/actions.json')['actions']
    need(any(x['id'] == action for x in rows), 'unknown_action')
    report_path, clip = imported_report(package.root, action)
    need(report_path is not None, 'not_imported')
    if not remove:
        title = (title or '').strip(); need(1 <= len(title) <= 64, 'bad_title')
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.edit-', dir=output.parent)); shutil.rmtree(stage)
    try:
        shutil.copytree(package.root, stage, symlinks=True, copy_function=clone_or_copy)
        definition = read_json(stage/'character.json'); runtime = stage/Path(package.native_ref['file']).parent
        native_path = stage/package.native_ref['file']; native = read_json(native_path); entry = native['characters'][0]
        archive_path = runtime/entry['actor_archive']['file']
        pack_path = runtime/entry['c7']['file']; pack = read_json(pack_path); animation = pack_path.parent/'animation'; interaction = pack_path.parent/'interaction'
        palette_path = animation/pack['animation']['palette_contract']['file']; palette = read_json(palette_path)
        def change(folder, file, fn):
            p = folder/file; d = read_json(p); fn(d); write_document(p, d)
        if remove:
            archive = read_json(archive_path); base = archive_path.parent
            [item] = [x for x in archive['clips'] if x['name'] == clip]
            metadata = read_json(base/item['file'])
            for file in (metadata['keys']['file'], item['file']): (base/file).unlink()
            # A release package ships without oracle files.
            (base/metadata['oracle']['file']).unlink(missing_ok=True)
            archive['clips'].remove(item); write_json(archive_path, archive)
            palette['clips'] = [x for x in palette['clips'] if x['name'] != clip]
            change(animation, 'intent-motion-map.json', lambda d: d['clips'].pop(clip))
            change(animation, 'actions.json', lambda d: d.update(actions=[x for x in d['actions'] if x['id'] != action]))
            change(interaction, 'motion-metadata.json', lambda d: d['clips'].pop(clip))
            change(interaction, 'blend-times.json', lambda d: d['clips'].pop(clip))
            media_path = animation/'motion-media.json'
            if media_path.exists():
                media = read_json(media_path)
                removed = [x for x in media['tracks'] if x['action'] == action]
                media['tracks'] = [x for x in media['tracks'] if x['action'] != action]
                library_path = animation/'facial-animations.json'
                for track in removed:
                    for key in ('audio', 'camera'):
                        if key in track: (animation/track[key]['file']).unlink()
                    if 'face' in track:
                        name = track['face']['facial_animation']; library = read_json(library_path)
                        if not any(x.get('face', {}).get('facial_animation') == name for x in media['tracks']):
                            for row in [x for x in library['clips'] if x['id'] == name and x.get('motion_only')]:
                                (animation/row['animation']['file']).unlink(); library['clips'].remove(row); write_json(library_path, library)
                if media['tracks']: write_json(media_path, media)
                else:
                    media_path.unlink()
                    pack['animation']['data'] = [x for x in pack['animation']['data'] if x['file'] != 'motion-media.json']
            (stage/report_path.relative_to(package.root)).unlink()
            # A removed file is published nowhere, so only here can it fail the edit.
            need(all(digest(package.root/key) == known['sha256'] for key, known in package.inventory.items() if not (stage/key).exists()),
                 'file_sha_mismatch')
        else:
            change(animation, 'actions.json', lambda d: [x.update(name=title) for x in d['actions'] if x['id'] == action])
        write_json(palette_path, palette); pack['animation']['palette_contract'] = ref(palette_path, animation)
        if (animation/'supplemental-clips.json').exists():
            change(animation, 'supplemental-clips.json', lambda d: d.update(base_contract_sha256=digest(palette_path)))
        if (animation/GRAPH).exists():
            # From the old graph's poses: the app's content runtime lacks the scipy that sampling the archive needs.
            (animation/GRAPH).write_text(text(pack_graph(package.id, pack_path, archive_path, previous=read_json(animation/GRAPH))))
        for section in ['animation', 'interaction']:
            folder = pack_path.parent/section
            pack[section]['data'] = [dict(x, **ref(folder/x['file'], folder)) for x in pack[section]['data']]
        write_json(pack_path, pack); entry['c7'] = ref(pack_path, runtime); entry['actor_archive'] = ref(archive_path, runtime)
        cp = runtime/entry['coverage']['file']; write_json(cp, native_bundle.character_coverage(runtime, entry)); entry['coverage'] = ref(cp, runtime)
        roles = {x['file']: x.get('roles', ['runtime_imported_motion']) for x in native['files']}
        native['files'] = [dict(**cloned_ref(package, stage, p, runtime), roles=roles.get(p.relative_to(runtime).as_posix(), ['runtime_imported_motion'])) for p in sorted(runtime.rglob('*')) if p.is_file() and p != native_path]
        write_json(native_path, native); native_bundle.verify(runtime)
        definition['components']['render']['native_bundle'] = ref(native_path, stage)
        major, minor, patch = map(int, definition['version'].split('.')); definition['version'] = f'{major}.{minor}.{patch+1}'
        report = dict(schema=EDIT_SCHEMA, character=package.id, op='remove' if remove else 'rename', action=action,
                      title=None if remove else title, previous_version=package.version)
        write_json(stage/'provenance'/('edit-'+sha256_bytes(canonical_json(report))[:16]+'.json'), report)
        definition['inventory'] = [cloned_ref(package, stage, p, stage) for p in sorted(stage.rglob('*')) if p.is_file() and p != stage/'character.json']
        write_json(stage/'character.json', definition); Package(stage, deep=False); stage.rename(output)
        return report
    finally:
        if stage.exists(): shutil.rmtree(stage)
