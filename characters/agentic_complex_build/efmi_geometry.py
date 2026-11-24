"""Turn one EFMI mod component's vertex and index buffers into the channels and index groups of its cloned template mesh.

The component is read as `efmi_mod.components` evaluated it; none of the mod's shaders or scripts runs. A failure is
ValueError('<reason code>:<detail>'), a kept loss a warning. Standard library only: this module ships in the app's content.
"""
from array import array
import copy
from dataclasses import dataclass, field

from . import mesh_codec
from .outfit_compose import GeometryReplacement, SegmentGroup

MAX_VERTICES = 2_000_000
MAX_INDICES = 8_000_000
# Element format -> (array typecode, components).
FORMATS = {'R32G32B32_FLOAT': ('f', 3), 'R32G32_FLOAT': ('f', 2), 'R32G32B32A32_FLOAT': ('f', 4), 'R32_UINT': ('I', 1),
           'R32G32B32A32_UINT': ('I', 4), 'R16G16B16A16_UNORM': ('H', 4), 'R16G16B16A16_UINT': ('H', 4), 'R8G8B8A8_UINT': ('B', 4)}
# The formats each used semantic may come in.
SEMANTICS = {'POSITION0': ('R32G32B32_FLOAT',), 'ENCODEDDATA0': ('R32_UINT',), 'TEXCOORD0': ('R32G32_FLOAT',), 'TEXCOORD1': ('R32G32_FLOAT',),
             'BLENDWEIGHTS0': ('R16G16B16A16_UNORM', 'R32G32B32A32_FLOAT'),
             'BLENDINDICES0': ('R16G16B16A16_UINT', 'R8G8B8A8_UINT', 'R32G32B32A32_UINT')}
INDEX_FORMATS = {'R16_UINT': 2, 'R32_UINT': 4}
# Template channel -> (format, stride) a mod stream can be written as.
WRITTEN = {0: ('R32G32B32_SFLOAT', 12), 1: ('R32_SFLOAT', 4), 4: ('R32G32_SFLOAT', 8), 5: ('R32G32_SFLOAT', 8), 6: ('R32G32_SFLOAT', 8),
           12: ('R32G32B32A32_SFLOAT', 16), 13: ('R32G32B32A32_UINT', 16)}
FLOAT_TBN = ('R32G32B32_SFLOAT', 12)
# The octahedral normal fields of a packed ch1 word; exporters keep them and re-encode the tangent above.
NORMAL_BITS = (1 << 20)-1
# Exporters round UV0 of a kept vertex by up to 3e-8; a texel of an 8192 texture is 1.2e-4.
UV_TOLERANCE = 1e-6


def crc_table():
    table = []
    for i in range(256):
        c = i
        for _ in range(8):c = (c >> 1) ^ (0x82F63B78 if c & 1 else 0)
        table.append(c)
    return table


CRC32C_TABLE = crc_table()


def crc32c(data):
    """CRC-32C (Castagnoli) with seed 0, XXMI's region hash of a submesh's index bytes."""
    crc = 0xFFFFFFFF
    for b in data:crc = CRC32C_TABLE[(crc ^ b) & 0xFF] ^ (crc >> 8)
    return crc ^ 0xFFFFFFFF


@dataclass
class GeometryResult:
    replacement: GeometryReplacement
    # ps-tN slot -> mod texture file of each of replacement.groups, whose own textures stay empty.
    group_textures: list[dict[str, str]]
    warnings: list[str] = field(default_factory=list)


@dataclass
class Parts:
    """A component's decoded streams and index groups beside its template mesh, before any channel is written."""
    mesh: str
    submesh: str | None
    vertex_count: int
    # Each by semantic: (array of its interleaved components, format); an EFF mesh's OUTLINE0 is the template's ch6 f32×2.
    elements: dict
    color: bool
    # (u32 indices, ps-tN slot -> file) per group of segments.
    groups: list
    # source_channel -> the template attribute; then the template's positions and UV0 (None unless f32×2).
    template: dict
    template_positions: array
    template_uvs: array | None
    outline: bool
    unmodified: bool
    warnings: list


def element(raw, stride, offset, fmt, resource):
    """The interleaved components of one element of every `stride`-byte vertex of `raw`."""
    if fmt not in FORMATS:raise ValueError('unsupported_geometry:buffer_layout:'+resource)
    code, width = FORMATS[fmt]
    items = array(code); size = items.itemsize
    if stride % size or offset % size or offset+size*width > stride:raise ValueError('unsupported_geometry:buffer_layout:'+resource)
    items.frombytes(raw)
    step, start = stride//size, offset//size
    out = array(code, bytes(size*width*(len(raw)//stride)))
    for k in range(width):out[k::width] = items[start+k::step]
    return out


def stream_file(mod, component, stream, warnings):
    """The file `stream` draws at the evaluated state: its own, or for a shader's RW output the base file of a known zero morph."""
    if not stream.rw:
        if stream.file is None:raise ValueError('unsupported_geometry:buffer_layout:'+stream.resource)
        return stream.file
    output = 'unsupported_geometry:custom_shader_output:'+stream.resource
    base = stream.base_file
    if base is None:raise ValueError(output)
    writers = (component.deform or {}).get('writers', [])
    if component.shape_keys:
        if any(v != 0 for v in component.shape_keys.values()):raise ValueError(f'unsupported_geometry:shapekey_default:{component.id}')
        warnings.append('shapekey_ignored')
    if writers:
        strides = {b.stride for b in mod.buffers.values() if b.filename == base}
        if strides != {stream.stride} or any(mod.custom_shaders.get(w) != 'geometry' for w in writers):raise ValueError(output)
        warnings.append('morph_ignored')
    elif not component.shape_keys:raise ValueError(output)
    return base


def read_streams(mod, component, warnings):
    """(semantic -> (components, format), vertex count of each stream, whether COLOR0 came) of the component's vb0, vb1 and vb2."""
    streams = {s.slot: s for s in component.streams}
    found, counts, color = {}, [], False
    for slot in ('vb0', 'vb1', 'vb2'):
        s = streams.get(slot)
        if s is None:continue
        name = stream_file(mod, component, s, warnings)
        if not s.layout or s.stride <= 0 or name not in mod.files:raise ValueError('unsupported_geometry:buffer_layout:'+s.resource)
        size = mod.files[name].stat().st_size
        if size % s.stride:raise ValueError('geometry_invalid:buffer_size:'+s.resource)
        if size//s.stride > MAX_VERTICES:raise ValueError(f'geometry_too_large:{component.id}')
        raw = mod.files[name].read_bytes()
        counts.append(len(raw)//s.stride)
        for semantic, fmt, offset in s.layout:
            color |= semantic == 'COLOR0'
            if semantic not in SEMANTICS or semantic in found:continue
            if fmt not in SEMANTICS[semantic]:raise ValueError('unsupported_geometry:buffer_layout:'+s.resource)
            found[semantic] = (element(raw, s.stride, offset, fmt, s.resource), fmt)
    if 'POSITION0' not in found:raise ValueError('unsupported_geometry:buffer_layout:'+component.section)
    return found, counts, color


def covered(ranges, first, count):
    """Whether the index range [first, first+count) lies in the union of `ranges`."""
    end = first
    for a, n in sorted(ranges):
        if a > end:break
        end = max(end, a+n)
        if end >= first+count:return True
    return count == 0


def slot_files(textures):
    """ps-tN slot -> the one mod file its candidate bindings name; an unbound or undecided slot is left out."""
    out = {}
    for slot, candidates in textures.items():
        files = {f for f, _ in candidates if f is not None}
        if len(files) == 1:out[slot] = files.pop()
    return out


def kept_segments(mod, component):
    """The component's segments that draw geometry: an effect shader's draw is drawn with the template's shader unless plain
    draws already cover its range (a redraw); panels and compute shaders draw no geometry."""
    real = [s for s in component.segments if s.first is not None and s.count is not None]
    plain = [(s.first, s.count) for s in real if s.custom_shader is None]
    return [s for s in real if s.custom_shader is None or
            (mod.custom_shaders.get(s.custom_shader) == 'pixel_effect' and not covered(plain, s.first, s.count))]


def index_groups(mod, component, vertex_count):
    """(u32 indices, slot -> file) of each group of the component's kept segments, keyed by textures, toggle condition and split."""
    ib = component.ib
    if not ib or not ib.get('file') or ib.get('format') not in INDEX_FORMATS or ib['file'] not in mod.files:
        raise ValueError('unsupported_geometry:buffer_layout:'+component.section)
    raw = mod.files[ib['file']].read_bytes(); width = INDEX_FORMATS[ib['format']]
    if len(raw) % width:raise ValueError('geometry_invalid:buffer_size:'+component.section)
    if len(raw)//width > MAX_INDICES:raise ValueError(f'geometry_too_large:{component.id}')
    indices = mesh_codec.widen_indices(raw, width)
    keep = kept_segments(mod, component)
    if not keep:raise ValueError('unsupported_geometry:no_draw:'+component.section)
    # Each group joins a part of these draws, so their sum bounds every list below; a negative count cannot offset it.
    if sum(abs(s.count) for s in keep) > MAX_INDICES:raise ValueError(f'geometry_too_large:{component.id}')
    try:drawn = mesh_codec.concat_ranges(indices, [(s.first, s.count, 0) for s in keep], vertex_count)
    except ValueError:raise ValueError('geometry_invalid:index_range:'+component.section) from None
    groups = {}
    for s in keep:groups.setdefault((tuple(sorted(s.textures.items())), s.condition, s.split), []).append(s)
    return [(mesh_codec.concat_ranges(indices, [(s.first, s.count, 0) for s in segments], vertex_count), slot_files(segments[0].textures))
            for segments in groups.values()], drawn


def template_submesh(component, draws, read_blob):
    """(indices sha256 or None for a one-submesh mesh, its draw): the submesh of the component's match_index_count, told apart
    by its region hash when several have that count."""
    shas = {d['indices']['sha256']: d for d in draws}
    if len(shas) == 1:return None, next(iter(shas.values()))
    hits = {sha: d for sha, d in shas.items() if d['index_count'] == component.index_count}
    if len(hits) > 1:
        hits = {sha: d for sha, d in hits.items() if d['index_component_bytes'] == 2 and '%08x' % crc32c(read_blob(d['indices'])) == component.hash}
    if len(hits) != 1:raise ValueError('unsupported_geometry:submesh:'+component.section)
    return next(iter(hits.items()))


def floats_of(raw):
    out = array('f'); out.frombytes(raw)
    return out


def read_component(mod, component, mesh, source, read_blob):
    """The Parts of `component` drawn over template `mesh`, with whether it is the template's own geometry (numerically equal
    positions, so ±0.0 match, and the same indices)."""
    warnings = []
    draws = [d for d in source['draws'] if d['mesh'] == mesh]
    if not draws:raise ValueError('absent_template_mesh')
    submesh, hit = template_submesh(component, draws, read_blob)
    template = {}
    for d in draws:
        for a in d['attributes']:template.setdefault(a['source_channel'], a)
    if (template.get(0, {}).get('format'), template.get(0, {}).get('stride')) != WRITTEN[0]:raise ValueError(f'channel_unresolved:{mesh}:0')
    found, counts, color = read_streams(mod, component, warnings)
    # Streams may differ in length when the draws index only the vertices the shortest one holds; the rest is never fetched.
    n = min(counts)
    try:groups, drawn = index_groups(mod, component, n)
    except ValueError as e:
        if len(set(counts)) > 1 and str(e).startswith('geometry_invalid:index_range:'):
            raise ValueError('geometry_invalid:stream_count:'+component.section) from None
        raise
    if len(set(counts)) > 1:found = {k: (a[:n*FORMATS[fmt][1]], fmt) for k, (a, fmt) in found.items()}
    writers = set((component.deform or {}).get('writers', ()))
    if component.deform and not component.deform['active'] and any(mod.custom_shaders.get(w) == 'geometry' for w in writers):
        warnings.append('morph_ignored')
    for name, kind, ran in component.custom_shaders:
        if ran and kind != 'state' and name not in writers:warnings.append('custom_shader_ignored:'+name)
    t_positions = floats_of(read_blob(template[0]))
    t_uvs = floats_of(read_blob(template[4])) if (template.get(4, {}).get('format'), template.get(4, {}).get('stride')) == WRITTEN[4] else None
    unmodified = found['POSITION0'][0] == t_positions and drawn == mesh_codec.widen_indices(read_blob(hit['indices']), hit['index_component_bytes'])
    return Parts(mesh, submesh, n, found, color, groups, template, t_positions, t_uvs,
                 any(d['pass_name'] == 'CharacterOutline' for d in draws), unmodified, warnings)


def match(parts, template_words=None):
    """The template vertex with the same POSITION and UV0 (within UV_TOLERANCE) of each mod vertex, or -1.

    Of several, such as the two sides of a double-sided shell, the one whose packed normal bits equal the mod's is taken."""
    uvs = parts.elements.get('TEXCOORD0', (None,))[0]
    if uvs is None or parts.template_uvs is None:return [-1]*parts.vertex_count
    p, tu = parts.template_positions, parts.template_uvs
    table = {}
    for i, key in enumerate(zip(p[0::3], p[1::3], p[2::3])):table.setdefault(key, []).append(i)
    words = parts.elements.get('ENCODEDDATA0', (None,))[0]
    p = parts.elements['POSITION0'][0]
    out = []
    for k, key in enumerate(zip(p[0::3], p[1::3], p[2::3])):
        u, v = uvs[2*k], uvs[2*k+1]
        hits = [i for i in table.get(key, ()) if abs(tu[2*i]-u) <= UV_TOLERANCE and abs(tu[2*i+1]-v) <= UV_TOLERANCE]
        if not hits:out.append(-1)
        elif len(hits) == 1 or words is None or template_words is None:out.append(hits[0])
        else:out.append(next((i for i in hits if (template_words[i] ^ words[k]) & NORMAL_BITS == 0), hits[0]))
    return out


def component_bones(parts, mod, component, palette, mesh_of_component):
    """skin's `bone` of an EFMI component: merged-skeleton ids go through the offset table to (component c, local l), bone l of
    c's template mesh; local ids are bones of this mesh."""
    id_format = parts.elements.get('BLENDINDICES0', (None, None))[1]
    entries = {m['mesh']: m for m in palette['meshes']}
    merged = mod.merged_skeleton and id_format != 'R8G8B8A8_UINT'
    table = sorted((o, c, k) for k, (o, c) in mod.skeleton.items() if o is not None and c is not None)
    def bone(g):
        unresolved = f'unsupported_geometry:bone_unresolved:{component.id}:{g}'
        if merged:
            if mod.bones_count is not None and g >= mod.bones_count:raise ValueError(unresolved)
            hits = [(k, g-o) for o, c, k in table if o <= g < o+c]
            if len(hits) != 1:raise ValueError(unresolved)
            [(k, l)] = hits
            mesh, order = mesh_of_component[k] if isinstance(mesh_of_component.get(k), tuple) else (mesh_of_component.get(k), None)
            bones = entries[mesh]['bones'] if mesh in entries else []
            if order is not None:
                if l >= len(order):raise ValueError(unresolved)
                l = order[l]
        else:
            l, bones = g, entries[parts.mesh]['bones']
        if l >= len(bones):raise ValueError(unresolved)
        return bones[l]
    return bone


def skin(parts, palette, rig_ids, bone, warnings):
    """(ch12 weights, ch13 clone palette indices, extra bones), or None without BLENDINDICES.

    `bone(g)` is the palette bone record ({source_transform_id, bindpose_row_major, ...}) of BLENDINDICES id g. A bone the
    mesh lacks is appended in order of first use."""
    if 'BLENDINDICES0' not in parts.elements:return None
    ids, _ = parts.elements['BLENDINDICES0']
    n = parts.vertex_count
    if 'BLENDWEIGHTS0' in parts.elements:
        raw, fmt = parts.elements['BLENDWEIGHTS0']
        unit = 65535.0 if fmt == 'R16G16B16A16_UNORM' else 1.0
        sums = [a+b+c+d for a, b, c, d in zip(raw[0::4], raw[1::4], raw[2::4], raw[3::4])]
        if any(s and abs(s/unit-1.0) >= 0.001 for s in sums):warnings.append('weights_renormalized')
        weights, zero = mesh_codec.normalize_weights(array('f', raw))
        if zero:warnings.append('zero_weights_fixed')
    else:
        weights = array('f', [1.0, 0.0, 0.0, 0.0]*n)
    own = {m['mesh']: m for m in palette['meshes']}[parts.mesh]['bones']
    index = {}
    for i, b in enumerate(own):index.setdefault(b['source_transform_id'], i)
    extra = []
    def resolve(g):
        record = bone(g); sid = record['source_transform_id']
        if sid not in rig_ids:raise ValueError('unsupported_geometry:unknown_bone:'+str(sid))
        if sid not in index:
            index[sid] = len(own)+len(extra); extra.append(copy.deepcopy(record))
        return index[sid]
    cache = {}
    out = array('I', bytes(4*len(ids)))
    for k, (g, w) in enumerate(zip(ids, weights)):
        if w == 0.0:continue
        found = cache.get(g)
        if found is None:found = cache[g] = resolve(g)
        out[k] = found
    if extra:warnings.append(f'bones_appended:{parts.mesh}:{len(extra)}')
    return weights, out, extra


def build(parts, palette, read_blob, rig_ids, bone):
    """The GeometryResult of `parts`, each channel the template draws written in the template's format at the mod's vertex count;
    `bone` is skin's."""
    n, t, warnings = parts.vertex_count, parts.template, list(parts.warnings)
    blobs = {}
    def blob(c):
        if c not in blobs:blobs[c] = read_blob(t[c])
        return blobs[c]
    def constant(c):
        raw, stride = blob(c), t[c]['stride']
        return raw == raw[:stride]*(len(raw)//stride) and len(raw) >= stride
    def written(c):return (t[c]['format'], t[c]['stride'])
    template_words = array('I', blob(1)) if 1 in t and written(1) == WRITTEN[1] else None
    matched = match(parts, template_words)
    every = -1 not in matched
    positions = parts.elements['POSITION0'][0]
    uvs = parts.elements.get('TEXCOORD0', (None,))[0]
    channels = {}
    words = None
    if 1 in t or parts.outline:
        encoded = parts.elements.get('ENCODEDDATA0', (None,))[0]
        if encoded is not None and mesh_codec.is_packed_tbn(encoded):words = encoded
        else:
            indices = array('I')
            for g, _ in parts.groups:indices += g
            # One group a vertex: welding would merge the two sides of a double-sided shell.
            normals = mesh_codec.recompute_normals(positions, indices, array('I', range(n)))
            tangents, signs = mesh_codec.recompute_tangents(positions, uvs if uvs is not None else array('f', bytes(8*n)), indices, normals)
            words = mesh_codec.encode_tbn(normals, tangents, signs); warnings.append('normals_recomputed')
        if parts.outline and template_words is not None:
            words = array('I', [w if m < 0 else template_words[m] for w, m in zip(words, matched)])
    if 6 in t and written(6) == WRITTEN[6] and 'OUTLINE0' in parts.elements:channels[6] = parts.elements['OUTLINE0'][0].tobytes()
    elif parts.outline and 6 in t and written(6) == WRITTEN[6]:
        groups, _ = mesh_codec.weld(positions)
        xy = mesh_codec.outline_normals(positions, words, groups)
        old = floats_of(blob(6))
        for i, m in enumerate(matched):
            if m >= 0:xy[2*i:2*i+2] = old[2*m:2*m+2]
        if not every:warnings.append('outline_normals_recomputed')
        channels[6] = xy.tobytes()
    if 1 in t:
        if written(1) == WRITTEN[1]:channels[1] = words.tobytes()
        elif written(1) == FLOAT_TBN:channels[1] = array('f', mesh_codec.decode_tbn(words)[0]).tobytes()
    if 2 in t and not constant(2) and written(2) == ('R32G32B32A32_SFLOAT', 16) and words is not None:
        _, tangents, signs = mesh_codec.decode_tbn(words)
        rows = array('f', bytes(16*n))
        for k in range(3):rows[k::4] = array('f', tangents[k::3])
        rows[3::4] = array('f', signs)
        channels[2] = rows.tobytes()
    channels[0] = positions.tobytes()
    if 4 in t and uvs is not None and written(4) == WRITTEN[4]:channels[4] = uvs.tobytes()
    if 5 in t and 'TEXCOORD1' in parts.elements and written(5) == WRITTEN[5]:channels[5] = parts.elements['TEXCOORD1'][0].tobytes()
    extra = []
    if (12 in t or 13 in t) and (skinned := skin(parts, palette, rig_ids, bone, warnings)):
        weights, bones, extra = skinned
        if 12 in t and written(12) == WRITTEN[12]:channels[12] = weights.tobytes()
        if 13 in t and written(13) == WRITTEN[13]:channels[13] = bones.tobytes()
    if 3 in t and parts.color:warnings.append('color0_ignored')
    for c in sorted(t):
        if c in channels:continue
        stride = t[c]['stride']
        if constant(c):channels[c] = blob(c)[:stride]*n
        elif every:channels[c] = b''.join(blob(c)[m*stride:(m+1)*stride] for m in matched)
        else:raise ValueError(f'channel_unresolved:{parts.mesh}:{c}')
    channels = {c: channels[c] for c in sorted(t)}
    width = 2 if n <= 0xFFFF else 4
    groups = [SegmentGroup(array('H' if width == 2 else 'I', g).tobytes(), width, {}) for g, _ in parts.groups]
    return GeometryResult(GeometryReplacement(parts.mesh, parts.submesh, n, channels, groups, extra), [s for _, s in parts.groups], warnings)


def component_geometry(mod, component, mesh, source, palette, read_blob, rig_ids, mesh_of_component):
    """The GeometryResult replacing template `mesh` (or its submesh of the component's match_index_count) with `component`, or
    None when the component is that mesh's own geometry, which the texture-only path keeps.

    `mesh_of_component` maps the mod's component ids to template meshes, for merged-skeleton bone ids, or to (mesh, order) for a
    component of another LOD whose bone l is the mesh's bone order[l]; `rig_ids` holds the rig's
    source transform ids; `read_blob(ref)` reads a source blob."""
    parts = read_component(mod, component, mesh, source, read_blob)
    if parts.unmodified:return None
    return build(parts, palette, read_blob, rig_ids, component_bones(parts, mod, component, palette, mesh_of_component))
