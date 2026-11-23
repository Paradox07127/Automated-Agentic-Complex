"""Clone one original mesh into a new appearance as a mesh of its own, with replaced index, vertex and texture bytes.

The clone keeps the template's programs, render state and bones, after which it may append bones; its draws are appended to
the source and each one is scheduled in its template's pass where the runtime's full-frame draw order puts it, so the default
appearance keeps its draws and their order. Each self-shadow atlas entry of the template gets the clone's own entries.
Standard library only: this module ships in the app's content.
"""
import array
import copy
import hashlib
from dataclasses import dataclass, field

TEXTURE_FORMATS = {'BC7_SRGB_BLOCK', 'BC7_UNORM_BLOCK', 'BC5_UNORM_BLOCK', 'BC6H_UFLOAT_BLOCK', 'BC3_SRGB_BLOCK', 'BC3_UNORM_BLOCK',
                   'R8G8B8A8_SRGB', 'R8G8B8A8_UNORM'}
MIP_FIELDS = ('level', 'width', 'height', 'offset', 'size')


@dataclass
class TextureBlob:
    data: bytes
    width: int
    height: int
    rd_format_name: str
    mips: list[dict]


@dataclass
class MeshReplacement:
    mesh: str
    vertex_count: int
    indices: bytes
    index_bytes: int
    # Keyed by Unity source_channel; each in the template draw's format for that channel.
    channels: dict[int, bytes]
    textures: dict[str, TextureBlob]


@dataclass
class SegmentGroup:
    """The segments of a mod component drawn with one set of textures: each replaced template draw becomes one draw of it."""
    indices: bytes
    # 2 (u16) or 4 (u32).
    index_bytes: int
    # Keyed by resource name, or by (template material, resource name) for the draws of one material.
    textures: dict
    # An endfield-mod-settings/v1 condition under which the group is drawn; None draws it always.
    condition: dict[str, list[int]] | None = None
    # (first, count, condition) of each run of the group's indices drawn only under its condition.
    runs: list = field(default_factory=list)


@dataclass
class GeometryReplacement:
    """Mod geometry for the draws of `mesh` whose indices blob has sha256 `submesh`, the clone's other submeshes keeping theirs."""
    mesh: str
    # None replaces every draw of the mesh, as a MeshReplacement does.
    submesh: str | None
    vertex_count: int
    # Keyed by Unity source_channel; each in the template draw's format for that channel.
    channels: dict[int, bytes]
    groups: list[SegmentGroup]
    # {source_transform_id, bindpose_row_major} each; bone i of them is palette index len(template bones)+i in channel 13.
    extra_bones: list[dict] = field(default_factory=list)


def srgb(texture):
    """Whether a draw's texture record samples as sRGB, by the renderer's TextureSpec rule."""
    name = texture.get('rd_format_name')
    if name:return '_SRGB' in name
    return texture['storage_color_space_raw'] == 1


def clone_draw(template, name, vertex_count, channels, indices, index_bytes, textures, put):
    """(the template draw with these bytes under mesh `name`, the set:binding slots of its replaced textures)."""
    if index_bytes not in (2, 4):raise ValueError('index_format')
    new = copy.deepcopy(template); new['mesh'] = name
    new.update(vertex_count=vertex_count, index_count=len(indices)//index_bytes, index_component_bytes=index_bytes, indices=put(indices))
    for attribute in new['attributes']:
        c = attribute['source_channel']
        if c not in channels:raise ValueError(f'missing_channel:{c}')
        raw = channels[c]
        if len(raw) != attribute['stride']*vertex_count:raise ValueError(f'channel_size:{c}')
        attribute.update(put(raw))
    replaced = []
    for resource in new['resources']:
        hits = [k for n in resource['names'] for k in ((template.get('material'), n), n) if k in textures]
        if resource['category'] != 'separate_images' or not hits:continue
        blob = textures[hits[0]]
        if blob.rd_format_name not in TEXTURE_FORMATS:raise ValueError('unsupported_texture_format')
        resource.update(put(blob.data))
        resource['texture'].update(width=blob.width, height=blob.height, mip_count=len(blob.mips), rd_format_name=blob.rd_format_name, mips=copy.deepcopy(blob.mips))
        replaced.append(f"separate_images:{resource['set']}:{resource['binding']}")
    return new, replaced


def copy_draw_keys(table, t, n, skip=()):
    """Copy every `draw:<t>:<rest>` key of `table` to `draw:<n>:<rest>`, except a <rest> in `skip`."""
    own = f'draw:{t}:'
    for key, value in list(table.items()):
        if key.startswith(own) and key[len(own):] not in skip:table[f'draw:{n}:'+key[len(own):]] = copy.deepcopy(value)


def frame_order(source, i):
    """Sort key of draw `i` in the order FrameGraph.validate requires of a full frame: PreGBuffer by index, then queue, outlines last, index."""
    d = source['draws'][i]
    if d['pass_name'] == 'PreGBuffer':return (0, 0, False, i)
    return (1, d['queue'], d['pass_name'] == 'CharacterOutline', i)


def shift_indices(raw, width, offset, vertex_count):
    """(`raw`'s `width`-byte indices each plus `offset`, their width), u32 once `vertex_count` leaves the u16 range."""
    out = array.array('H' if width == 2 and vertex_count <= 0xFFFF else 'I', [i+offset for i in memoryview(raw).cast('H' if width == 2 else 'I')])
    return out.tobytes(), out.itemsize


def grow_skin(resources, bones, extra, put):
    """Give each `_VertexSkinMatrices` record of `bones` (a 48-byte header row, then one or two rows a bone) `extra` more bones."""
    for r in resources:
        if not extra or '_VertexSkinMatrices' not in r['names'] or not r.get('file'):continue
        per, left = divmod(r['byte_count']//48-1, bones)
        if r['byte_count'] % 48 or left or per not in (1, 2):raise ValueError('skin_matrices_layout')
        # The host writes every row each frame, so only the size counts.
        r.update(put(bytes(48*(1+per*(bones+extra)))))


def remap_bones(raw, remap):
    """R32G32B32A32_UINT channel 13 `raw` with each palette index in `remap` replaced by its value."""
    ids = array.array('I'); ids.frombytes(raw)
    return array.array('I', [remap.get(i, i) for i in ids]).tobytes()


def clone_mesh(source, graph, palette, pack, put, replacement, appearance, read_blob=None, put_graph=None, rig_ids=(), textures=None, mesh=None):
    """Add `mesh`'s clone `outfit:<appearance id>/<mesh>`, shown only in the new `appearance`.

    `replacement` is a list of GeometryReplacements of the mesh, each for its own submesh (or one for every draw); the clone holds
    their vertices one after another, then the template's when a draw is left that none of them replaces, which keeps its template
    indices and takes `textures`. A single GeometryReplacement, or a MeshReplacement for one group on every draw, stands for a list
    of it; `mesh` names the mesh of an empty list. `put(raw)` stores a blob beside the source manifest and `put_graph(raw)` one
    beside the frame graph; without `put_graph` the atlas entries only reuse blobs the graph holds and keep their template's
    textures. `read_blob(ref)` reads a source blob. Each extra bone must be in `rig_ids`; one that several replacements append
    gets one palette index. The result's `blocks` holds, per replacement, the indices sha256 of each group's draws."""
    if isinstance(replacement, MeshReplacement):
        replacement = GeometryReplacement(replacement.mesh, None, replacement.vertex_count, replacement.channels,
                                          [SegmentGroup(replacement.indices, replacement.index_bytes, replacement.textures)])
    replacements = list(replacement) if isinstance(replacement, (list, tuple)) else [replacement]
    if appearance['id'] in {a['id'] for a in pack['appearances']}:raise ValueError('duplicate_appearance')
    mesh, draws = replacements[0].mesh if replacements else mesh, source['draws']
    templates = [i for i, d in enumerate(draws) if d['mesh'] == mesh]
    if not templates or any(r.mesh != mesh for r in replacements):raise ValueError('absent_template_mesh')
    submeshes = [r.submesh for r in replacements]
    if len(set(submeshes)) < len(submeshes) or (None in submeshes and len(submeshes) > 1):raise ValueError('duplicate_submesh')
    def owner(d):return next((k for k, r in enumerate(replacements) if r.submesh is None or d['indices']['sha256'] == r.submesh), None)
    if any(not any(owner(draws[t]) == k for t in templates) for k in range(len(replacements))):raise ValueError('absent_template_submesh')
    [entry] = [m for m in palette['meshes'] if m['mesh'] == mesh]
    bones = len(entry['bones'])
    template_ids = {b['source_transform_id'] for b in entry['bones']} if any(r.extra_bones for r in replacements) else set()
    extra, index, remaps = [], {}, []
    for r in replacements:
        own, remap = set(template_ids), {}
        for j, b in enumerate(r.extra_bones):
            sid = b['source_transform_id']
            if sid not in rig_ids:raise ValueError(f'unknown_bone:{sid}')
            if sid in own:raise ValueError(f'duplicate_bone:{sid}')
            own.add(sid)
            if sid not in index:index[sid] = len(extra); extra.append(b)
            if index[sid] != j:remap[bones+j] = bones+index[sid]
        remaps.append(remap)
    name = 'outfit:'+appearance['id']+'/'+mesh
    offsets, mod_vertices = [], 0
    for r in replacements:offsets.append(mod_vertices); mod_vertices += r.vertex_count
    left = next((draws[t] for t in templates if owner(draws[t]) is None), None)
    total = mod_vertices+(left['vertex_count'] if left else 0)
    own_channels = {a['source_channel']: a for t in templates for a in draws[t]['attributes']}
    # A mesh's draws share one blob a channel: the replacements' vertices, then the template's for the draws left as they are.
    channels = {}
    for c in replacements[0].channels if replacements else own_channels:
        if any(c not in r.channels for r in replacements) or (left and c not in own_channels):continue
        raws = [remap_bones(r.channels[c], m) if c == 13 and m else r.channels[c] for r, m in zip(replacements, remaps)]
        channels[c] = b''.join(raws+([read_blob(own_channels[c])] if left else []))
    shifted = {}
    def shift(key, raw, width, offset):
        if offset == 0:return raw, width
        if key not in shifted:shifted[key] = shift_indices(raw, width, offset, total)
        return shifted[key]
    def parts(d):
        k = owner(d)
        if k is not None:
            return [(*shift((k, i), g.indices, g.index_bytes, offsets[k]), g.textures, g.condition, g.runs, (k, i)) for i, g in enumerate(replacements[k].groups)]
        key = d['indices']['sha256']
        if key not in shifted:
            raw = read_blob(d['indices'])
            shifted[key] = shift_indices(raw, d['index_component_bytes'], mod_vertices, total) if mod_vertices else (raw, d['index_component_bytes'])
        return [(*shifted[key], textures or {}, None, (), None)]
    clones = [(t, *clone_draw(draws[t], name, total, channels, *part[:3], put), *part[3:]) for t in templates for part in parts(draws[t])]
    known = {r['sha256']: r for p in graph['passes'] for e in p.get('geometry', [])
             for r in [e['indices'], *e['attributes'], *e['resources']] if r.get('file')}
    def graph_put(raw):
        h = hashlib.sha256(raw).hexdigest()
        if h in known:return {k: known[h][k] for k in ('file', 'sha256', 'byte_count')}
        if put_graph is None:raise ValueError('graph_store_missing')
        return put_graph(raw)
    casters = []
    for p in graph['passes']:
        for e in [e for e in p.get('geometry', []) if e['mesh'] == mesh]:
            for indices, width, bound, *_ in parts(e):
                new, _ = clone_draw(e, name, total, channels, indices, width, bound if put_graph else {}, graph_put)
                grow_skin(new['resources'], bones, len(extra), graph_put); casters.append((p, new))
    added, segments, blocks = [], [], {}
    for t, new, replaced, condition, runs, group in clones:
        grow_skin(new['resources'], bones, len(extra), put)
        n = len(draws); draws.append(new); added.append(n)
        block = new['indices']['sha256']
        if group is not None:blocks[group] = block
        if block not in {s['indices_sha256'] for s in segments}:
            if condition is not None:
                segments.append(dict(mesh=name, indices_sha256=block, first=0, count=new['index_count'], visible_when=copy.deepcopy(condition)))
            segments += [dict(mesh=name, indices_sha256=block, first=f, count=c, visible_when=copy.deepcopy(w)) for f, c, w in runs]
        for schedule in graph['passes']:
            if t not in schedule.get('draws', []):continue
            # A valid pass is already in frame order, so the clone goes after every draw that sorts before it.
            schedule['draws'].insert(sum(frame_order(source, i) < frame_order(source, n) for i in schedule['draws']), n)
            # A replaced slot gets no binding, so the draw samples its own new blob.
            copy_draw_keys(schedule.get('texture_bindings', {}), t, n, replaced)
            copy_draw_keys(schedule.get('sampler_overrides', {}), t, n)
        copy_draw_keys(graph['sampler_overrides'], t, n)
        inputs = graph['frame_inputs']
        if t in inputs['visible_draws']:inputs['visible_draws'].append(n)
        for key in ('state_overrides', 'overrides'):
            copies = [dict(copy.deepcopy(o), draw_index=n) for o in inputs[key] if o['draw_index'] == t]
            if key == 'overrides':grow_skin([o['resource'] for o in copies], bones, len(extra), graph_put)
            inputs[key] += copies
    atlas = {}
    for p, new in casters:
        atlas.setdefault(p['id'], []).append(len(p['geometry'])); p['geometry'].append(new)
    palette['meshes'].append(dict(copy.deepcopy(entry), mesh=name, appearances=[appearance['id']],
                                  bones=copy.deepcopy(entry['bones'])+copy.deepcopy(extra)))
    if entry.get('appearances') is None:entry['appearances'] = [a['id'] for a in pack['appearances']]
    pack['appearances'].append({k: copy.deepcopy(appearance[k]) for k in ('id', 'name', 'kind', 'source')})
    return dict(mesh=mesh, new_mesh=name, draws=added, atlas=atlas, bones={b['source_transform_id']: bones+i for i, b in enumerate(extra)},
                segments=segments, blocks=[[blocks[k, i] for i in range(len(r.groups))] for k, r in enumerate(replacements)])


def rekey_draws(table, index):
    """`table` with each `draw:<i>:<rest>` key moved to `draw:<index[i]>:<rest>`, or dropped when `i` is not in `index`."""
    out = {}
    for key, value in table.items():
        if not key.startswith('draw:'):out[key] = value; continue
        i, rest = key[len('draw:'):].split(':', 1)
        if int(i) in index:out[f'draw:{index[int(i)]}:'+rest] = value
    return out


def remove_appearance(source, graph, palette, pack, appearance_id, mod_settings=None):
    """Delete imported `appearance_id` with its `outfit:<id>/` meshes, their draws, atlas entries and texture variants, and its
    entry of `mod_settings` (the pack's interaction/mod-settings.json table), renumbering every draw index left.

    The result's `mod_settings` is 'removed' when the table lost its last appearance and the pack its listing: the caller then
    deletes the file."""
    kinds = {a['id']: a.get('kind') for a in pack['appearances']}
    # Character.m requires the current appearance id to be listed, and `default` is the fallback.
    if appearance_id == 'default' or kinds.get(appearance_id) != 'imported':raise ValueError('not_imported')
    data = pack.get('interaction', {}).get('data', [])
    if mod_settings is None and any(r['file'] == 'mod-settings.json' for r in data):raise ValueError('mod_settings_required')
    prefix = 'outfit:'+appearance_id+'/'
    removed = [i for i, d in enumerate(source['draws']) if d['mesh'].startswith(prefix)]
    kept = [i for i in range(len(source['draws'])) if not source['draws'][i]['mesh'].startswith(prefix)]
    index = {i: n for n, i in enumerate(kept)}
    source['draws'] = [d for i, d in enumerate(source['draws']) if i in index]
    for schedule in graph['passes']:
        if 'draws' in schedule:schedule['draws'] = [index[i] for i in schedule['draws'] if i in index]
        for field in ('texture_bindings', 'sampler_overrides'):
            if field in schedule:schedule[field] = rekey_draws(schedule[field], index)
    graph['sampler_overrides'] = rekey_draws(graph['sampler_overrides'], index)
    inputs = graph['frame_inputs']
    inputs['visible_draws'] = [index[i] for i in inputs['visible_draws'] if i in index]
    for field in ('state_overrides', 'overrides'):
        inputs[field] = [dict(o, draw_index=index[o['draw_index']]) for o in inputs[field] if o['draw_index'] in index]
    meshes = [m['mesh'] for m in palette['meshes'] if m['mesh'].startswith(prefix)]
    palette['meshes'] = [m for m in palette['meshes'] if not m['mesh'].startswith(prefix)]
    pack['appearances'] = [a for a in pack['appearances'] if a['id'] != appearance_id]
    everyone = [a['id'] for a in pack['appearances']]
    for entry in palette['meshes']:
        if entry.get('appearances') is None:continue
        left_out = appearance_id not in entry['appearances']
        entry['appearances'] = [a for a in entry['appearances'] if a != appearance_id]
        # A template of the appearance's clones or a mesh it hid, now listing every appearance, is shown in all of them, which is
        # what an absent list means.
        if left_out and entry['appearances'] == everyone:del entry['appearances']
    atlas = 0
    for schedule in graph['passes']:
        if 'geometry' not in schedule:continue
        kept_entries = [e for e in schedule['geometry'] if not e['mesh'].startswith(prefix)]
        atlas += len(schedule['geometry'])-len(kept_entries); schedule['geometry'] = kept_entries
    variants = [v['id'] for v in source.get('texture_variants', []) if v['mesh'].startswith(prefix)]
    if 'texture_variants' in source:
        source['texture_variants'] = [v for v in source['texture_variants'] if not v['mesh'].startswith(prefix)]
        # The import that added the first variant added the key.
        if not source['texture_variants']:del source['texture_variants']
    state = None
    if mod_settings is not None:
        mod_settings['appearances'].pop(appearance_id, None); state = 'kept'
        if not mod_settings['appearances']:
            pack['interaction']['data'] = [r for r in data if r['file'] != 'mod-settings.json']; state = 'removed'
    return dict(appearance=appearance_id, meshes=meshes, draws=removed, atlas=atlas, texture_variants=variants, mod_settings=state)


def graft_appearance(source, graph, palette, pack, old, appearance_id, mod_settings=None, old_settings=None):
    """Add imported `appearance_id` of the documents `old` (source, graph, palette, pack) to these, the inverse of remove_appearance:
    its `outfit:<id>/` meshes, their draws numbered after the draws here, their schedule, frame inputs and atlas entries, its texture
    variants, the meshes it hides and its entry of `old_settings` (that pack's mod-settings table) added to `mod_settings` (this one's).

    A mesh the appearance clones or hides must have the same draws and palette entry here as in `old`. The result's `mod_settings`
    is the table the caller writes, None when there is none; the caller copies the blobs the added entries name."""
    old_source, old_graph, old_palette, old_pack = old
    kinds = {a['id']: a.get('kind') for a in old_pack['appearances']}
    if appearance_id == 'default' or kinds.get(appearance_id) != 'imported':raise ValueError('not_imported')
    if appearance_id in {a['id'] for a in pack['appearances']}:raise ValueError('duplicate_appearance')
    for doc, table in ((pack, mod_settings), (old_pack, old_settings)):
        if table is None and any(r['file'] == 'mod-settings.json' for r in doc.get('interaction', {}).get('data', [])):
            raise ValueError('mod_settings_required')
    prefix = 'outfit:'+appearance_id+'/'
    old_meshes, meshes = {m['mesh']: m for m in old_palette['meshes']}, {m['mesh']: m for m in palette['meshes']}
    clones = [m for m in old_palette['meshes'] if m['mesh'].startswith(prefix)]
    hidden = [m['mesh'] for m in old_palette['meshes'] if not m['mesh'].startswith('outfit:') and m.get('appearances') is not None
              and appearance_id not in m['appearances'] and 'default' in m['appearances']]
    def bare(entry):return {k: v for k, v in entry.items() if k != 'appearances'}
    def own(doc, mesh):return [d for d in doc['draws'] if d['mesh'] == mesh]
    for mesh in [m['mesh'][len(prefix):] for m in clones]+hidden:
        if mesh not in meshes or mesh not in old_meshes:raise ValueError('template_missing:'+mesh)
        if bare(meshes[mesh]) != bare(old_meshes[mesh]) or own(source, mesh) != own(old_source, mesh):raise ValueError('template_changed:'+mesh)
    moved = [i for i, d in enumerate(old_source['draws']) if d['mesh'].startswith(prefix)]
    index = {i: len(source['draws'])+k for k, i in enumerate(moved)}
    passes = {p['id']: p for p in graph['passes']}
    def draw_keys(table):return rekey_draws({k: v for k, v in table.items() if k.startswith('draw:')}, index)
    for p in old_graph['passes']:
        entries = [e for e in p.get('geometry', []) if e['mesh'].startswith(prefix)]
        if any(i in index for i in p.get('draws', [])) or entries or any(draw_keys(p.get(f, {})) for f in ('texture_bindings', 'sampler_overrides')):
            if p['id'] not in passes:raise ValueError('pass_missing:'+p['id'])
    source['draws'] += [copy.deepcopy(old_source['draws'][i]) for i in moved]
    atlas = 0
    for p in old_graph['passes']:
        if p['id'] not in passes:continue
        schedule = passes[p['id']]
        for n in [index[i] for i in p.get('draws', []) if i in index]:
            # A valid pass is already in frame order, so the draw goes after every draw that sorts before it.
            schedule['draws'].insert(sum(frame_order(source, i) < frame_order(source, n) for i in schedule['draws']), n)
        for field in ('texture_bindings', 'sampler_overrides'):
            if keys := draw_keys(p.get(field, {})):schedule.setdefault(field, {}).update(copy.deepcopy(keys))
        entries = [copy.deepcopy(e) for e in p.get('geometry', []) if e['mesh'].startswith(prefix)]
        if entries:schedule['geometry'] += entries; atlas += len(entries)
    graph['sampler_overrides'].update(copy.deepcopy(draw_keys(old_graph['sampler_overrides'])))
    inputs, old_inputs = graph['frame_inputs'], old_graph['frame_inputs']
    inputs['visible_draws'] += [index[i] for i in old_inputs['visible_draws'] if i in index]
    for field in ('state_overrides', 'overrides'):
        inputs[field] += [dict(copy.deepcopy(o), draw_index=index[o['draw_index']]) for o in old_inputs[field] if o['draw_index'] in index]
    everyone = [a['id'] for a in pack['appearances']]
    for entry in palette['meshes']:
        if entry['mesh'].startswith('outfit:'):continue
        before = old_meshes.get(entry['mesh'])
        # A mesh `old` lacks is shown in the appearance where the default appearance shows it, as an import does.
        if before is None:shown = entry.get('appearances') is None or 'default' in entry['appearances']
        else:shown = before.get('appearances') is None or appearance_id in before['appearances']
        if shown and entry.get('appearances') is not None and appearance_id not in entry['appearances']:entry['appearances'].append(appearance_id)
        if not shown and entry.get('appearances') is None:entry['appearances'] = list(everyone)
    palette['meshes'] += copy.deepcopy(clones)
    pack['appearances'].append(copy.deepcopy(next(a for a in old_pack['appearances'] if a['id'] == appearance_id)))
    variants = [copy.deepcopy(v) for v in old_source.get('texture_variants', []) if v['mesh'].startswith(prefix)]
    if variants:source['texture_variants'] = source.get('texture_variants', [])+variants
    entry = (old_settings or {}).get('appearances', {}).get(appearance_id)
    if entry is not None:
        if mod_settings is None:
            mod_settings = dict(schema=old_settings['schema'], appearances={})
            pack['interaction']['data'].append(dict(file='mod-settings.json'))
        mod_settings['appearances'][appearance_id] = copy.deepcopy(entry)
    return dict(appearance=appearance_id, meshes=[m['mesh'] for m in clones], draws=list(index.values()), atlas=atlas,
                texture_variants=[v['id'] for v in variants], mod_settings=mod_settings)


def identity_replacement(source, read_blob, mesh):
    """`mesh`'s own index, vertex and explicitly encoded texture bytes as a replacement; `read_blob(ref)` reads a source blob."""
    draws = [d for d in source['draws'] if d['mesh'] == mesh]
    if not draws:raise ValueError('absent_template_mesh')
    channels, textures = {}, {}
    for d in draws:
        for attribute in d['attributes']:
            if attribute['source_channel'] not in channels:channels[attribute['source_channel']] = read_blob(attribute)
        for r in d['resources']:
            texture = r.get('texture', {})
            if r['category'] != 'separate_images' or not r.get('file') or not texture.get('rd_format_name') or r['names'][0] in textures:continue
            textures[r['names'][0]] = TextureBlob(read_blob(r), texture['width'], texture['height'], texture['rd_format_name'],
                                                  [{k: m[k] for k in MIP_FIELDS} for m in texture['mips']])
    first = draws[0]
    return MeshReplacement(mesh=mesh, vertex_count=first['vertex_count'], indices=read_blob(first['indices']), index_bytes=first['index_component_bytes'],
                           channels=channels, textures=textures)
