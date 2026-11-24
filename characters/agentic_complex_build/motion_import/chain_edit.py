"""Rebuild a character package with a motion-chain proposal (endfield-motion-chain-proposal/v1), as edit.py rebuilds one.

An edit rewrites a clip's intent-motion-map next, exit or hold_seconds, or its blend-times blend_in_s. A chain is a
motion-graph chains key and motion_graph.policy_chain from it; replace and insert at index i (>= 1) rewrite the next of its
clip i-1 and lead the placed clip on to what followed. Each chain the edits change, from a clip nothing leads to, a pooled clip
or an action row's clip, is checked as the builder checks its own: no clip repeats along next, else exit; it comes to rest in
the stance it starts in; a new link keeps the stance; a pooled standing chain passes check_families; an action row's clip stays
a chains key. Any problem refuses the whole proposal. An action row whose clip's chain changes takes the new chain's required_clips
and duration, as build_original_agent_motion writes them.
"""
import copy
import math
from pathlib import Path
import shutil
import tempfile

from character_library import Package, PackageError, need, read_json, write_json
import native_bundle
from resource_store import clone_or_copy
from ..common import canonical_json, reference as ref, sha256_bytes
from ..motion_families import chain_timing, check_families, pooled
from ..motion_graph import FILE as GRAPH, pack_graph, policy_chain, text
from ..pose_family import SCHEMA as POSE_FAMILIES
from .edit import EDIT_SCHEMA, cloned_ref, write_document

SCHEMA = 'endfield-motion-chain-proposal/v1'
MAX_BLEND_S = 2.0
# The fields of each op besides 'op'; a set edit names at least one of SET_FIELDS, each the intent-motion-map field it writes.
FIELDS = dict(set={'clip'}, replace={'chain', 'index', 'clip'}, insert={'chain', 'index', 'clip'}, blend={'clip', 'seconds'})
SET_FIELDS = dict(next='next', exit='exit', hold='hold_seconds')
NO_CHANGES = dict(chains_added=[], chains_removed=[], chains_changed=[])


class Refused(PackageError):
    """problems: [{edit: index into the proposal's edits or None, reason}]."""
    def __init__(self, problems):
        super().__init__('chain_refused')
        self.problems = problems


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def walk(start, entries, returns):
    """(clips from start along each source return, else next, else exit; whether a clip repeats)."""
    out, clip = [], start
    while clip and clip not in out:
        out.append(clip); entry = entries.get(clip) or {}
        clip = returns.get(clip) or entry.get('next') or entry.get('exit')
    return out, bool(clip)


def apply(edit, entries, blends, clips, returns, keys):
    """Applies one edit to the intent-motion-map clips and blend-times clips; raises PackageError with its reason."""
    op = edit.get('op') if isinstance(edit, dict) else None
    need(op in FIELDS and FIELDS[op] <= set(edit) <= FIELDS[op] | {'op'} | (set(SET_FIELDS) if op == 'set' else set()), 'bad_edit')
    need(op != 'set' or set(edit) & set(SET_FIELDS), 'bad_edit')
    clip = edit['clip']; need(isinstance(clip, str), 'bad_edit'); need(clip in clips, 'unknown_clip:' + clip)
    if op == 'set':
        for key in ('next', 'exit'):
            if edit.get(key) is not None:
                need(isinstance(edit[key], str), 'bad_edit'); need(edit[key] in clips, 'unknown_clip:' + edit[key])
        need(edit.get('next') is None or clip not in returns, 'source_return:' + clip)
        hold = edit.get('hold')
        need(hold is None or number(hold) and hold >= 0 and clips[clip]['loop'], 'bad_hold')
        entry = entries.setdefault(clip, {})
        for key, field in SET_FIELDS.items():
            if key in edit:
                if edit[key] is None: entry.pop(field, None)
                else: entry[field] = edit[key]
    elif op == 'blend':
        need(number(edit['seconds']) and 0 <= edit['seconds'] <= MAX_BLEND_S, 'bad_blend')
        blends.setdefault(clip, {}).update(blend_in_s=edit['seconds'], source='motion chain edit')
    else:
        chain, index = edit['chain'], edit['index']
        need(isinstance(chain, str) and isinstance(index, int) and not isinstance(index, bool), 'bad_edit')
        need(chain in keys, 'unknown_chain:' + chain)
        segments = policy_chain(chain, lambda c: returns.get(c) or (entries.get(c) or {}).get('next'))
        after = index + (op == 'replace')
        need(1 <= index < len(segments) + (op == 'insert'), 'bad_index')
        before, following = segments[index - 1], segments[after] if after < len(segments) else None
        need(before not in returns, 'source_return:' + before)
        need(returns.get(clip, following) == following, 'source_return:' + clip)
        entries.setdefault(before, {})['next'] = clip
        entry = entries.setdefault(clip, {})
        if following: entry['next'] = following
        else: entry.pop('next', None)


def problems_of(mapping, before, metadata, families, actions, returns, clips, graphs):
    """The reasons the changed chains of mapping (its clips against before) break."""
    entries, found = mapping['clips'], []
    def add(reason):
        if reason not in found: found.append(reason)
    stance = lambda clip, key: (metadata.get(clip) or {}).get(key, 'stand')
    names = set(clips) | set(entries)
    old = {c: walk(c, before, returns) for c in names}; new = {c: walk(c, entries, returns) for c in names}
    reached = {x for c in names for x in [returns.get(c), (entries.get(c) or {}).get('next'), (entries.get(c) or {}).get('exit')] if x and x != c}
    drawn, rows = pooled(mapping), {c for row in actions for c in row.get('clips') or []}
    links = {pair for path, _ in old.values() for pair in zip(path, path[1:])}
    for start in sorted(c for c in names if new[c] != old[c] and (c not in reached or c in drawn or c in rows)):
        path, repeats = new[start]
        if repeats:
            add('cycle:' + start); continue
        for a, b in zip(path, path[1:]):
            if (a, b) not in links and stance(a, 'stance_end') != stance(b, 'stance_start'): add('stance_breaks:%s>%s' % (a, b))
        if stance(path[-1], 'stance_end') != stance(start, 'stance_start'):
            add('no_return:' + start)
        elif families and start in drawn and start in metadata:
            try: check_families(families, mapping, metadata, {start})
            except ValueError as error: add(str(error))
    for clip in sorted(rows & set(graphs[0]['chains']) - set(graphs[1]['chains'])): add('chain_key_lost:' + clip)
    return found


def plan(package, proposal):
    """{problems, graph_changes, documents: {section/file: rewritten document}, graph: the rewritten motion graph or None}."""
    refused = lambda reason: dict(problems=[dict(edit=None, reason=reason)], graph_changes=NO_CHANGES, documents={}, graph=None)
    if not (isinstance(proposal, dict) and set(proposal) == {'schema', 'character', 'package_sha256', 'edits'} and proposal['schema'] == SCHEMA
            and proposal['character'] == package.id and isinstance(proposal['edits'], list) and proposal['edits']):
        return refused('bad_proposal')
    if proposal['package_sha256'] != package.sha256: return refused('stale')
    runtime = package.root/Path(package.native_ref['file']).parent
    pack_path, archive_path = runtime/package.native_entry['c7']['file'], runtime/package.native_entry['actor_archive']['file']
    pack = read_json(pack_path); animation, interaction = pack_path.parent/'animation', pack_path.parent/'interaction'
    mapping, blending = read_json(animation/'intent-motion-map.json'), read_json(interaction/'blend-times.json')
    metadata = read_json(interaction/'motion-metadata.json')['clips']
    acted = {name: read_json(pack_path.parent/name) for name in ['animation/actions.json', 'interaction/actions.json']}
    actions = [row for document in acted.values() for row in document['actions']]
    families = next((d for d in (read_json(animation/r['file']) for r in pack['animation']['data']) if d.get('schema') == POSE_FAMILIES), None)
    rules = {r['name']: r for r in read_json(animation/pack['animation']['palette_contract']['file'])['clips']}
    if (animation/'supplemental-clips.json').exists():
        rules.update({r['name']: r for r in read_json(animation/'supplemental-clips.json')['clips']})
    returns = {n: r['auto_return_clip'] for n, r in rules.items() if r.get('auto_return_clip')}
    clips = {r['name']: r for r in read_json(archive_path)['clips']}
    previous = read_json(animation/GRAPH) if (animation/GRAPH).exists() else None
    graph_of = lambda m, b: pack_graph(package.id, pack_path, archive_path, {'intent-motion-map.json': m}, {'blend-times.json': b}, previous=previous)
    old = graph_of(mapping, blending)
    edited, blends = copy.deepcopy(mapping), copy.deepcopy(blending)
    problems = []
    for i, edit in enumerate(proposal['edits']):
        try: apply(edit, edited['clips'], blends['clips'], clips, returns, old['chains'])
        except PackageError as error: problems.append(dict(edit=i, reason=str(error)))
    if problems: return dict(problems=problems, graph_changes=NO_CHANGES, documents={}, graph=None)
    new = graph_of(edited, blends)
    problems = [dict(edit=None, reason=r) for r in problems_of(edited, mapping['clips'], metadata, families, actions, returns, clips, (old, new))]
    before, after = old['chains'], new['chains']
    changes = dict(chains_added=sorted(set(after) - set(before)), chains_removed=sorted(set(before) - set(after)),
                   chains_changed=sorted(k for k in set(before) & set(after) if before[k] != after[k]))
    chain_of = lambda entries, clip: policy_chain(clip, lambda c: returns.get(c) or (entries.get(c) or {}).get('next'))
    retimed = copy.deepcopy(acted)
    for row in [row for document in retimed.values() for row in document['actions'] if len(row.get('clips') or []) == 1]:
        chain = chain_of(edited['clips'], row['clips'][0])
        if chain != chain_of(mapping['clips'], row['clips'][0]): row.update(chain_timing(chain, {c: clips[c]['length'] for c in chain}))
    documents = {k: v for k, v, o in [('animation/intent-motion-map.json', edited, mapping), ('interaction/blend-times.json', blends, blending)]
                 + [(k, retimed[k], acted[k]) for k in acted] if v != o}
    return dict(problems=problems, graph_changes=changes, documents=documents, graph=new if previous is not None else None)


def check(package_root, proposal):
    """The proposal checked against the package at package_root without writing: {ok, problems, graph_changes}."""
    result = plan(Package(package_root), proposal)
    return dict(ok=not result['problems'], problems=result['problems'], graph_changes=result['graph_changes'])


def chain_package(package_root, output, proposal):
    """Clone the package to the NEW directory output with the proposal applied; returns the provenance/edit-<16hex>.json document.

    Raises Refused with the proposal's problems, writing nothing."""
    # cloned_ref checks the inventory's SHA-256 of each file this rewrites; the library checks the others when it publishes.
    package = Package(package_root, deep=False); output = Path(output).resolve()
    need(not output.exists(), 'output_already_exists')
    need(not output.is_relative_to(package.root), 'output_inside_input_package')
    result = plan(package, proposal)
    if result['problems']: raise Refused(result['problems'])
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.edit-', dir=output.parent)); shutil.rmtree(stage)
    try:
        shutil.copytree(package.root, stage, symlinks=True, copy_function=clone_or_copy)
        definition = read_json(stage/'character.json'); runtime = stage/Path(package.native_ref['file']).parent
        native_path = stage/package.native_ref['file']; native = read_json(native_path); entry = native['characters'][0]
        pack_path = runtime/entry['c7']['file']; pack = read_json(pack_path)
        for name, document in result['documents'].items(): write_document(pack_path.parent/name, document)
        if result['graph'] is not None: (pack_path.parent/'animation'/GRAPH).write_text(text(result['graph']))
        for section in ['animation', 'interaction']:
            folder = pack_path.parent/section
            pack[section]['data'] = [dict(x, **ref(folder/x['file'], folder)) for x in pack[section]['data']]
        write_json(pack_path, pack); entry['c7'] = ref(pack_path, runtime)
        previous = {x['file']: x for x in native['files']}
        native['files'] = [dict(previous[p.relative_to(runtime).as_posix()], **cloned_ref(package, stage, p, runtime)) for p in sorted(runtime.rglob('*')) if p.is_file() and p != native_path]
        write_json(native_path, native); native_bundle.verify(runtime)
        definition['components']['render']['native_bundle'] = ref(native_path, stage)
        major, minor, patch = map(int, definition['version'].split('.')); definition['version'] = f'{major}.{minor}.{patch+1}'
        report = dict(schema=EDIT_SCHEMA, character=package.id, op='chain', edits=proposal['edits'], previous_version=package.version)
        write_json(stage/'provenance'/('edit-'+sha256_bytes(canonical_json(report))[:16]+'.json'), report)
        definition['inventory'] = [cloned_ref(package, stage, p, stage) for p in sorted(stage.rglob('*')) if p.is_file() and p != stage/'character.json']
        write_json(stage/'character.json', definition); Package(stage, deep=False); stage.rename(output)
        return report
    finally:
        if stage.exists(): shutil.rmtree(stage)
