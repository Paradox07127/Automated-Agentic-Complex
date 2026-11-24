"""Carry an imported appearance into the Windows frame table (vulkan/frame.bin, package_format.py) without rebuilding it.

An outfit import (agentic_complex_build/import_outfit.py) adds `outfit:<appearance>/<mesh>` clones of palette meshes, each draw
a copy of one of its template's draws with other vertex, index and texture blobs, and the switches' texture variants. Every
program, state and sampler they draw with is already in the table, so this copies the template's records instead of reading
the game's SPIR-V again: a clone's draw takes the template draw's programs, layout, states and samplers, and its own vertex
buffers, indices, textures and dynamic address defaults; its palette mesh gets a mesh record and bone records, the new
appearance an appearance record, and every mesh's appearance gate follows the palette. Each variant texture gets a Texture
row, found by its blob's SHA-256. The table is then bound to the import's manifest and neutral scene.
"""
import hashlib
import struct

import package_format as fmt

E, NONE, OWN = fmt.ENUMS, fmt.NONE, 'vulkan/blobs/'
INDEX_FORMAT = {2: 57, 4: 42}
# DXGI values of the texture encodings an outfit can carry (windows_package.py FORMATS).
TEXTURE_FORMAT = {'BC1_RGB_UNORM_BLOCK': 71, 'BC1_RGBA_UNORM_BLOCK': 71, 'BC1_RGB_SRGB_BLOCK': 72, 'BC1_RGBA_SRGB_BLOCK': 72, 'BC3_UNORM_BLOCK': 77,
                  'BC3_SRGB_BLOCK': 78, 'BC4_UNORM_BLOCK': 80, 'BC5_UNORM_BLOCK': 83, 'BC6H_UFLOAT_BLOCK': 95, 'BC6H_SFLOAT_BLOCK': 96, 'BC7_UNORM_BLOCK': 98,
                  'BC7_SRGB_BLOCK': 99, 'R8G8B8A8_UNORM': 28, 'R8G8B8A8_SRGB': 29, 'B8G8R8A8_UNORM': 87, 'R8_UNORM': 61, 'R8G8_UNORM': 49}
BLOCK_BYTES = {71: 8, 72: 8, 80: 8, 77: 16, 78: 16, 83: 16, 95: 16, 96: 16, 98: 16, 99: 16}
PIXEL_BYTES = {28: 4, 29: 4, 87: 4, 61: 1, 49: 2}


class Failure(ValueError):pass


def need(ok, message):
    if not ok:raise Failure('vulkan_outfit: '+message)


def sha(data):return hashlib.sha256(data).hexdigest()


def rkey(r):return '%s:%s:%s' % (r.get('category'), r.get('set'), r.get('binding'))


def read_table(data):
    head = fmt.STRUCTS['Header']; need(data[:8] == fmt.MAGIC and len(data) >= head.size, 'not a Windows frame table')
    h = head.unpack(data); need(h['version'] == fmt.VERSION and h['file_bytes'] == len(data), 'frame table version or length mismatch')
    tables = {}
    for t in fmt.TABLES:
        o, n = h[t+'_offset'], h[t+'_count']
        if t == 'strings':tables[t] = bytearray(data[o:o+n]); continue
        s = fmt.table_struct(t); tables[t] = [s.unpack(data, o+i*s.size) for i in range(n)]
    return h, tables


def write_table(header, tables):
    """windows_package.Package.serialize: each table 16-byte aligned after the Header."""
    head = fmt.STRUCTS['Header']; layout = []; offset = head.size
    for t in fmt.TABLES:
        body = bytes(tables[t]) if t == 'strings' else b''.join(fmt.table_struct(t).pack(r) for r in tables[t])
        offset = (offset+15) & ~15; layout.append((t, offset, body)); offset += len(body)
    values = dict(header, magic=fmt.MAGIC, version=fmt.VERSION, header_bytes=head.size, file_bytes=offset)
    for t, o, body in layout:values[t+'_offset'] = o; values[t+'_count'] = len(body) if t == 'strings' else len(tables[t])
    out = bytearray(offset); out[:head.size] = head.pack(values)
    for _, o, body in layout:out[o:o+len(body)] = body
    return bytes(out)


def texture_rows(spec, data):
    """(dimension, faces, subresources) of a 2D texture as windows_package.texture_layout lays it out."""
    name = spec.get('rd_format_name'); need(name in TEXTURE_FORMAT, 'texture encoding %s is not one an outfit carries' % name)
    need(spec.get('dimension') in (None, '2D') and (spec.get('depth') or 1) == 1 and spec.get('face_count') in (None, 1), 'outfit texture is not 2D')
    dxgi = TEXTURE_FORMAT[name]; w, h, mips = spec['width'], spec['height'], spec['mip_count']
    need(0 < w <= 16384 and 0 < h <= 16384 and 0 < mips <= max(w, h).bit_length(), 'invalid texture dimensions/mips')
    bw, bb = (4, BLOCK_BYTES[dxgi]) if dxgi in BLOCK_BYTES else (1, PIXEL_BYTES[dxgi])
    out, offset = [], 0
    for level in range(mips):
        mw, mh = max(1, w >> level), max(1, h >> level)
        row = (mw+bw-1)//bw*bb; count = row*((mh+bw-1)//bw)
        out.append(dict(offset=offset, row_pitch=row, slice_pitch=count, byte_count=count)); offset += count
    need(offset == len(data), 'texture payload is not its mip chain')
    return dxgi, out


class Table:
    def __init__(self, data, character_dir, read):
        self.header, self.t = read_table(data); self.dir = character_dir; self.read = read
        self.blob_index = {b['sha256'].hex(): i for i, b in enumerate(self.t['blobs'])}
        self.string_index = {}; at = 0; s = self.t['strings']
        while at < len(s):
            end = s.index(b'\0', at); self.string_index.setdefault(s[at:end].decode(), at); at = end+1
        self.written = {}

    def text(self, offset):
        s = self.t['strings']; return None if offset == NONE else s[offset:s.index(b'\0', offset)].decode()

    def string(self, value):
        if value is None:return NONE
        if value not in self.string_index:self.string_index[value] = len(self.t['strings']); self.t['strings'] += value.encode()+b'\0'
        return self.string_index[value]

    def add(self, table, record):fmt.table_struct(table).pack(record); self.t[table].append(record); return len(self.t[table])-1

    def blob(self, data):
        """The blob record of `data`: a file of the character directory with its bytes, else vulkan/blobs/<sha256>."""
        digest = sha(data)
        if digest not in self.blob_index:
            name = next((n for n in ('source/Files/%s.bytes' % digest, 'graph/Files/%s.bytes' % digest)
                         if (self.dir/n).is_file() and (self.dir/n).stat().st_size == len(data)), None)
            if name is None:name = OWN+digest; self.written[digest] = data
            self.blob_index[digest] = self.add('blobs', dict(sha256=bytes.fromhex(digest), size=len(data), file=self.string(name)))
        return self.blob_index[digest]

    def blob_sha(self, index):return self.t['blobs'][index]['sha256'].hex()

    def texture(self, resource, store):
        """A Texture row for a source image resource, shared with a row of the same blob and format."""
        spec, data = resource['texture'], self.read(resource, store)
        dxgi, subresources = texture_rows(spec, data); blob = self.blob(data)
        for i, x in enumerate(self.t['textures']):
            if x['blob'] == blob and x['format'] == dxgi and (x['width'], x['height'], x['mip_count']) == (spec['width'], spec['height'], spec['mip_count']):return i
        first = len(self.t['subresources'])
        for s in subresources:self.add('subresources', s)
        return self.add('textures', dict(name=self.string(spec.get('name')), dimension=E['TextureDimension']['2D'], width=spec['width'], height=spec['height'],
                                         depth=1, mip_count=spec['mip_count'], array_size=1, format=dxgi, misc_flags=0, blob=blob,
                                         first_subresource=first, subresource_count=len(subresources)))


def draw_addresses(t, draw):
    return [b['index'] for b in t.t['bindings'][draw['first_binding']:draw['first_binding']+draw['binding_count']]
            if b['source'] == E['BindingSource']['dynamic']]


def clone_draw(t, draw, index, old, new, store, overrides, mesh):
    """A copy of frame table draw `draw` (drawing geometry `old`) that draws geometry `new`, as kind index `index` of its pass."""
    resources = {rkey(r): r for r in new['resources']}; template = {rkey(r): r for r in old['resources']}
    layout = t.t['input_layouts'][draw['input_layout']]
    elements = t.t['input_elements'][layout['first_element']:layout['first_element']+layout['element_count']]
    attributes = {a['location']: a for a in new['attributes']}; first_vb = len(t.t['vertex_buffers'])
    for slot in range(draw['vertex_buffer_count']):
        element = next(e for e in elements if e['input_slot'] == slot); a = attributes.get(element['location'])
        need(a is not None, '%s draws no attribute at location %d' % (mesh, element['location']))
        vb = t.t['vertex_buffers'][draw['first_vertex_buffer']+slot]; data = t.read(a, store)
        need(a['stride'] == vb['stride'] and len(data) == a['stride']*new['vertex_count'], '%s location %d: vertex layout differs from its template' % (mesh, element['location']))
        t.add('vertex_buffers', dict(blob=t.blob(data), stride=a['stride'], byte_count=len(data)))
    width, count = new['index_component_bytes'], new['index_count']; indices = t.read(new['indices'], store)
    need(width in INDEX_FORMAT and count > 0 and count % 3 == 0 and len(indices) == width*count, '%s: invalid index stream' % mesh)
    moved, first_binding = {}, len(t.t['bindings'])
    for b in t.t['bindings'][draw['first_binding']:draw['first_binding']+draw['binding_count']]:
        key = '%s:%d:%d' % ({0: 'ubos', 1: 'ssbos'}.get(t.t['dynamic_addresses'][b['index']]['category']) if b['source'] == E['BindingSource']['dynamic'] else
                            'separate_images', b['set'], b['binding'])
        record = dict(b)
        if b['source'] == E['BindingSource']['texture'] and key in template and key in resources:
            if t.blob_sha(t.t['textures'][b['index']]['blob']) == template[key].get('sha256') and resources[key].get('sha256') != template[key].get('sha256'):
                record['index'] = t.texture(resources[key], store)
        elif b['source'] == E['BindingSource']['dynamic']:
            if b['index'] not in moved:
                a = dict(t.t['dynamic_addresses'][b['index']], draw_index=index, mesh=t.string(mesh))
                source = overrides.get(key) or resources.get(key)
                if source is not None:
                    data = t.read(source, overrides.get(key) and 'graph' or store)
                    if a['category'] == E['Category']['ubos']:need(len(data) >= a['byte_count'], '%s %s: short uniform block' % (mesh, key)); data = data[:a['byte_count']]
                    else:a.update(byte_count=len(data), byte_width=len(data))
                    a['default_blob'] = t.blob(data)
                moved[b['index']] = t.add('dynamic_addresses', a)
            record['index'] = moved[b['index']]
        t.add('bindings', record)
    return dict(draw, first_vertex_buffer=first_vb, index_blob=t.blob(indices), index_format=INDEX_FORMAT[width], index_count=count,
                vertex_count=new['vertex_count'], mesh=t.string(mesh), first_binding=first_binding)


def template_of(candidates, new, label):
    """The template draw of clone geometry `new`: a draw of the same mesh, material and programs, the same indices when one has them."""
    same = [(i, g) for i, g in candidates if g.get('material') == new.get('material') and
            [s['source_spirv_sha256'] for s in g.get('stages') or []] == [s['source_spirv_sha256'] for s in new.get('stages') or []]]
    need(same, '%s has no template draw in the frame table' % label)
    return next(((i, g) for i, g in same if g['indices']['sha256'] == new['indices']['sha256']), same[0])


def extend(character_dir, data, manifest, manifest_sha256, scene_sha256, graph, palette, pack, rig, read):
    """The bytes of frame table `data` with the clones, appearances, texture variants and cutout masks the import added, bound to the manifest
    and scene, and {sha256: bytes} of the blobs to write under vulkan/blobs/. read(ref, 'source' | 'graph') returns a blob's bytes."""
    t = Table(data, character_dir, read); draws, passes = t.t['draws'], t.t['passes']; K = E['DrawKind']
    mesh_of = {i: d['mesh'] for i, d in enumerate(manifest['draws'])}
    by_pass = []
    for pi, p in enumerate(passes):
        rows = draws[p['first_draw']:p['first_draw']+p['draw_count']]
        source = {d['source_draw']: d for d in rows if d['kind'] == K['source']}
        aux = {t.t['dynamic_addresses'][draw_addresses(t, d)[0]]['draw_index']: d for d in rows if d['kind'] == K['auxiliary']}
        by_pass.append((source, aux, [d for d in rows if d['kind'] not in (K['source'], K['auxiliary'])]))
    known = {t.text(d['mesh']) for d in draws if d['kind'] == K['source']}
    added = [i for i, d in enumerate(manifest['draws']) if d['mesh'].startswith('outfit:') and d['mesh'] not in known]
    overrides = {}
    for o in (graph.get('frame_inputs') or {}).get('overrides', []):overrides.setdefault(o['draw_index'], {})[rkey(o['resource'])] = o['resource']
    rebuilt, graph_passes = [], {p['id']: p for p in graph['passes']}
    for record, (source, aux, other) in zip(passes, by_pass):
        p, order = graph_passes.get(t.text(record['name'])), []
        if p is None:
            rows = draws[record['first_draw']:record['first_draw']+record['draw_count']]
            need(not any(d['kind'] in (K['source'], K['auxiliary']) for d in rows), 'pass %s draws geometry the frame graph lacks' % t.text(record['name']))
            rebuilt.append(rows); continue
        for d in p.get('draws') or []:
            if d in source:order.append(source[d]); continue
            if d not in added:continue
            new = manifest['draws'][d]; template_mesh = new['mesh'].split('/', 1)[1]
            candidates = [(s, manifest['draws'][s]) for s in source if mesh_of.get(s) == template_mesh]
            s, old = template_of(candidates, new, new['mesh'])
            order.append(dict(clone_draw(t, source[s], d, old, new, 'source', overrides.get(d, {}), new['mesh']), source_draw=d))
        geometry = p.get('geometry') or []
        for j, g in enumerate(geometry):
            if j in aux:order.append(aux[j]); continue
            if not g['mesh'].startswith('outfit:') or g['mesh'] in known:continue
            template_mesh = g['mesh'].split('/', 1)[1]
            i, old = template_of([(i, geometry[i]) for i in aux if geometry[i]['mesh'] == template_mesh], g, g['mesh'])
            order.append(clone_draw(t, aux[i], j, old, g, 'graph', {}, g['mesh']))
        need(sum(d['mesh'] in known for d in [manifest['draws'][x] for x in p.get('draws') or [] if x in source]) == len(source)
             and all(j < len(geometry) for j in aux), 'pass %s: the frame graph no longer lists every draw of the frame table' % p['id'])
        rebuilt.append(order+other)
    t.t['draws'] = []
    for p, order in zip(passes, rebuilt):p.update(first_draw=len(t.t['draws']), draw_count=len(order)); t.t['draws'] += order
    actors(t, palette, pack, rig)
    for v in manifest.get('texture_variants') or []:t.texture(v, 'source')
    for d in manifest['draws']:
        if 'cutout' in d:t.texture(d['cutout'], 'source')
    t.header.update(manifest_sha256=bytes.fromhex(manifest_sha256), scene_sha256=bytes.fromhex(scene_sha256))
    return write_table(t.header, t.t), t.written


def actors(t, palette, pack, rig):
    """Appearance records for the pack's new appearances; a mesh record and bone records for each new palette mesh, its instance
    record, clip visibility and flags its template's; every mesh's appearance gate from the palette."""
    K, F = E['ActorKind'], E['ActorFlag']; records = t.t['actors']
    looks = [a['id'] for a in pack['appearances']]
    have = [t.text(r['name']) for r in records if r['kind'] == K['appearance']]
    need(have == looks[:len(have)], 'the frame table appearances %s are not the first of the pack\'s %s' % (have, looks))
    def record(**r):
        v = list(r.pop('values', [])); records.append(dict(dict(name=NONE, index=0, parent=NONE, node=NONE, blob=NONE, aux_blob=NONE, oracle_blob=NONE,
                                                                 first=0, count=0, flags=0), values=v+[0.0]*(16-len(v)), **r))
    for ai, a in enumerate(pack['appearances'][len(have):], len(have)):
        record(kind=K['appearance'], name=t.string(a['id']), index=ai, first=t.string(a['name']), parent=t.string(a.get('kind')), node=t.string(a.get('desc')))
    meshes = {t.text(r['name']): r for r in records if r['kind'] == K['mesh']}
    sources = {n['source_id']: n['index'] for n in rig['nodes'] if n.get('source_id')}
    def gate(r, m):
        worn = None if m.get('appearances') is None else b''.join(struct.pack('<I', ai) for ai, a in enumerate(looks) if a in m['appearances'])
        r['oracle_blob'] = NONE if worn is None else t.blob(worn)
        r['flags'] = r['flags'] & ~F['appearance_gate'] | (0 if worn is None else F['appearance_gate'])
    for m in palette['meshes']:
        if m['mesh'] in meshes:gate(meshes[m['mesh']], m); continue
        need(m['mesh'].startswith('outfit:'), 'palette mesh %s has no mesh record' % m['mesh'])
        template = meshes.get(m['mesh'].split('/', 1)[1]); need(template is not None, '%s has no template mesh record' % m['mesh'])
        index = sum(r['kind'] == K['mesh'] for r in records)
        record(kind=K['mesh'], name=t.string(m['mesh']), index=index, first=len(records)+1, count=len(m['bones']), blob=template['blob'],
               aux_blob=template['aux_blob'], flags=template['flags'] & (F['head_basis'] | F['clip_visibility'] | F['particle']))
        gate(records[-1], m); meshes[m['mesh']] = records[-1]
        for bi, b in enumerate(m['bones']):
            need(b['source_transform_id'] in sources, '%s bone %s is not in the rig' % (m['mesh'], b['source_transform_id']))
            row = b['bindpose_row_major']
            record(kind=K['bone'], index=bi, parent=index, node=sources[b['source_transform_id']], values=[float(row[r*4+c]) for c in range(4) for r in range(4)])
