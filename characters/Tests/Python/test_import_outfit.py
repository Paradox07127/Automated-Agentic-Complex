"""Synthetic fixtures only: no byte of a user mod or of game data."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

CHARACTERS = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(CHARACTERS), str(CHARACTERS.parent/'agent/agentd/tests')]
from agentic_complex_build import import_outfit, texture_dhash
from character_library import Package, read_json, write_json
import native_bundle
import package_format
import vulkan_outfit
from test_character_library import fixture

CLOTH = 'S_actor_test_cloth_01_lod0'
BODY = 'S_actor_test_body_01_lod0'
TWIN = 'S_actor_test_vfxpart_01_lod0'
O1_POSITIONS = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 0)]
BONES = [dict(path=p) for p in ('Root/a', 'Root/a/b', 'Root/c')]
# CRC-32C of the u16 index bytes: O1 [0,1,2,2,1,3], O2 submesh 0 [0,1,2], O2 submesh 1 [2,1,3].
O1_HASH, O2_SUB0, O2_SUB1 = '40609654', 'ad2ae6dc', '6504de68'


def dds(width, height, dxgi=None, fourcc=b'DX10', fill=None):
    """One-mip DDS with fake block data: magic, 124-byte header, a DX10 header when `fourcc` is DX10.

    `fill` is the byte of every block; a template texture of `package_fixture` is filled with its binding."""
    header = bytearray(124)
    struct.pack_into('<7I', header, 0, 124, 0x2100F, height, width, 0, 0, 1)
    struct.pack_into('<2I4s', header, 72, 32, 0x4, fourcc)
    dx10 = struct.pack('<5I', dxgi, 3, 0, 1, 0) if fourcc == b'DX10' else b''
    return b'DDS '+bytes(header)+dx10+bytes([fill if fill is not None else dxgi or 7])*16*((width+3)//4)*((height+3)//4)


def package_fixture(root, cloth_extra=(), atlas=False, second_material=False, skinned=False, tables={}, neutral=True, vulkan=False):
    """test_character_library's package with a runtime of three meshes: O1, its same-IB vfxpart twin O3, and two-submesh O2.

    `cloth_extra` adds (name, format, srgb, binding, size) textures to O1; `second_material` a draw of O1's submesh in material
    M_cloth_b, whose _BaseMap is 8x8; `atlas` a self-shadow atlas pass casting O1, its blobs beside the frame graph; `skinned`
    rig ids 11-13 for the three bones and O1's weights and bone indices (channels 12 and 13); `tables` ({file: document}) files
    of interaction/ that the pack lists; without `neutral` the bundle has no neutral package, as one built before it; `vulkan` a
    Windows frame table (vulkan_frame_fixture)."""
    doc = fixture(root, 'fixture')
    runtime = root/'runtime'
    for p in sorted(runtime.rglob('*'), reverse=True):p.unlink() if p.is_file() else p.rmdir()
    def put(path, value, base=''):
        data = value if isinstance(value, bytes) else (json.dumps(value, ensure_ascii=False)+'\n').encode()
        target = runtime/path; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
        return dict(file=path[len(base):], sha256=hashlib.sha256(data).hexdigest(), byte_count=len(data))
    stored = {}
    def blob(raw, base='source/'):
        stored[hashlib.sha256(raw).hexdigest()] = raw
        return put(base+'Files/'+hashlib.sha256(raw).hexdigest()+'.bytes', raw, base)
    def texture(name, fmt, srgb, binding, size=4):
        raw = bytes([binding])*16
        tex = dict(name='T_'+name, width=size, height=size, mip_count=2, storage_color_space_raw=int(srgb), rd_format_name=fmt, size=32,
                   mips=[dict(level=0, width=size, height=size, offset=0, size=16), dict(level=1, width=size//2, height=size//2, offset=16, size=16)])
        return dict(set=1, binding=binding, category='separate_images', names=[name], reflected_type='texture2D', texture=tex, **blob(raw+raw))
    def draw(mesh, material, indices, positions):
        resources = [texture('_BaseMap', 'BC7_SRGB_BLOCK', True, 7), texture('_BumpMap', 'BC5_UNORM_BLOCK', False, 6)]
        if mesh == CLOTH:resources += [texture('_MetallicGlossMap', 'BC7_UNORM_BLOCK', False, 2), texture('_ClearCoatMask', 'BC7_UNORM_BLOCK', False, 5),
                                       *(texture(*extra) for extra in cloth_extra)]
        attributes = [dict(location=0, source_channel=0, format='R32G32B32_SFLOAT', stride=12, **blob(b''.join(struct.pack('<3f', *p) for p in positions))),
                      dict(location=1, source_channel=4, format='R32G32_SFLOAT', stride=8, **blob(bytes(8*len(positions))))]
        if skinned and mesh == CLOTH:
            attributes += [dict(location=2, source_channel=12, format='R32G32B32A32_SFLOAT', stride=16, **blob(struct.pack('<4f', 1, 0, 0, 0)*len(positions))),
                           dict(location=3, source_channel=13, format='R32G32B32A32_UINT', stride=16, **blob(bytes(16*len(positions))))]
        return dict(mesh=mesh, material=material, pass_name='PreGBuffer', queue=2000, vertex_count=len(positions), index_count=len(indices),
                    index_component_bytes=2, indices=blob(struct.pack(f'<{len(indices)}H', *indices)), attributes=attributes, resources=resources)
    twin_positions = O1_POSITIONS[:3]+[(5, 5, 5)]
    draws = [draw(CLOTH, 'M_cloth', [0, 1, 2, 2, 1, 3], O1_POSITIONS), draw(BODY, 'M_body', [0, 1, 2], O1_POSITIONS),
             draw(BODY, 'M_face', [2, 1, 3], O1_POSITIONS), draw(TWIN, 'M_fx', [0, 1, 2, 2, 1, 3], twin_positions)]
    if second_material:
        draws.append(draw(CLOTH, 'M_cloth_b', [0, 1, 2, 2, 1, 3], O1_POSITIONS))
        draws[-1]['resources'][0] = texture('_BaseMap', 'BC7_SRGB_BLOCK', True, 7, 8)
    source = put('source/source.json',{'schema': 'endfield-native-character-manifest-v1', 'draws': draws})
    clip = put('clips/idle.json', {'schema': 'metal-actor-clip-v1', 'name': 'idle',
        'keys': put('clips/idle.keys', b'EFKEY001'), 'oracle': put('clips/idle.oracle', b'EFPOSE01')})
    archive = put('actor.json', {'schema': 'metal-actor-source-export-v1', 'source_bundle_sha256': '0'*64,
        'rig': put('rig.json', {'schema': 'metal-actor-rig-v1', 'nodes': [dict(index=i, parent=-1, path=b['path'], source_id=str(11+i)) for i, b in enumerate(BONES)] if skinned else []}), 'clips': [dict(clip, name='idle', length=1.0, loop=True)]})
    bones = [dict(b, source_transform_id=str(11+i), bindpose_row_major=[float(k % 5 == 0) for k in range(16)]) if skinned else b for i, b in enumerate(BONES)]
    palette = {'clips': [{'name': 'idle', 'loop': True, 'length': 1.0}],
               'meshes': [dict(mesh=CLOTH, bones=bones), dict(mesh=BODY, bones=bones), dict(mesh=TWIN, bones=bones, appearances=['top'])]}
    pack = put('pack.json', {'schema': 'endfield-character-pack/v1', 'id': 'fixture', 'render': {'manifest': dict(source, file='source.json')},
        'appearances': [{'id': 'default', 'name': '默认'}, {'id': 'top', 'name': '满潜'}],
        'animation': {'palette_contract': put('animation/palette.json', palette, 'animation/'), 'data': []},
        'interaction': {'data': [put('interaction/'+name, document, 'interaction/') for name, document in tables.items()]}})
    graph = {'schema': 'metal-frame-graph-v1', 'manifest_sha256': source['sha256'], 'sampler_overrides': {}, 'targets': [], 'textures': [],
             'passes': [dict(id='pre-gbuffer', phase='pre-gbuffer', kind='render', colors=[], reads=[], draws=list(range(len(draws))), texture_bindings={})],
             'frame_inputs': dict(visible_draws=list(range(len(draws))), state_overrides=[], overrides=[]),
             'output': 'l1', 'source_coordinate_policy': 'unity-reversed-z-msl-boundary'}
    if atlas:
        def moved(ref):return dict(ref, **blob(stored[ref['sha256']], ''))
        cloth = draws[0]
        caster = dict(mesh=CLOTH, material=cloth['material'], pass_name='ShadowCaster', queue=2000, vertex_count=cloth['vertex_count'],
                      index_count=cloth['index_count'], index_component_bytes=2, indices=moved(cloth['indices']),
                      attributes=[moved(a) for a in cloth['attributes']], resources=[moved(r) for r in cloth['resources'][:1]])
        graph['passes'].append(dict(id='character-atlas', phase='character-atlas', kind='render', colors=[], reads=[], draws=[], geometry=[caster]))
    entry = dict(id='fixture', default_clip='idle', default_appearance='default', c7=pack, actor_archive=archive, source=source,
        library=put('programs.json', {'schema': 'metal-program-library-v1', 'programs': []}), graph=put('graph.json', graph),
        lighting=put('lighting.json', {'schema': 'metal-product-lighting/v1', 'sphere_source': put('sphere.json', {})}))
    if neutral:native_bundle.write_neutral(runtime, entry, graph); entry['graph'] = put('graph.json', (runtime/'graph.json').read_bytes())
    if vulkan:entry['vulkan_frame'] = put('vulkan/frame.bin', vulkan_frame_fixture(runtime, draws, palette, read_json(runtime/'pack.json'), entry))
    entry['coverage'] = put('coverage.json', native_bundle.character_coverage(runtime, entry))
    files = [put(p.relative_to(runtime).as_posix(), p.read_bytes()) for p in sorted(runtime.rglob('*')) if p.is_file()]
    native = put('bundle.json', {'schema': 'metal-native-character-bundle/v1', 'characters': [entry], 'files': files})
    doc['components']['render']['native_bundle'] = dict(native, file='runtime/bundle.json')
    doc['inventory'] = [x for x in doc['inventory'] if not x['file'].startswith('runtime/')]+[dict(x, file='runtime/'+x['file']) for x in files+[native]]
    (root/'character.json').write_text(json.dumps(doc, ensure_ascii=False))
    return Package(root)


def vulkan_frame_fixture(runtime, draws, palette, pack, entry):
    """A frame table of one render pass `pre-gbuffer` drawing every source draw: vertex buffers by attribute location, its
    indices, a texture binding per image resource; the appearance records and a mesh record per palette mesh with its bones."""
    E, NONE = package_format.ENUMS, package_format.NONE
    tables = {t: [] for t in package_format.TABLES}; tables['strings'] = bytearray(b'\0')
    pkg = vulkan_outfit.Table.__new__(vulkan_outfit.Table)
    pkg.header, pkg.t, pkg.dir, pkg.written, pkg.blob_index, pkg.string_index = {}, tables, runtime, {}, {}, {'': 0}
    pkg.read = lambda r, where: (runtime/'source'/r['file']).read_bytes()
    for i, d in enumerate(draws):
        first_element, first_vb = len(tables['input_elements']), len(tables['vertex_buffers'])
        for slot, a in enumerate(sorted(d['attributes'], key=lambda a: a['location'])):
            pkg.add('input_elements', dict(location=a['location'], input_slot=slot))
            pkg.add('vertex_buffers', dict(blob=pkg.blob(pkg.read(a, 'source')), stride=a['stride'], byte_count=a['byte_count']))
        layout = pkg.add('input_layouts', dict(first_element=first_element, element_count=len(d['attributes'])))
        first_binding = len(tables['bindings'])
        for r in d['resources']:
            pkg.add('bindings', dict(stage=1, set=r['set'], binding=r['binding'], source=E['BindingSource']['texture'], index=pkg.texture(r, 'source')))
        pkg.add('draws', dict(kind=E['DrawKind']['source'], input_layout=layout, first_vertex_buffer=first_vb, vertex_buffer_count=len(d['attributes']),
                              index_blob=pkg.blob(pkg.read(d['indices'], 'source')), index_format=57, index_count=d['index_count'], vertex_count=d['vertex_count'],
                              mesh=pkg.string(d['mesh']), source_draw=i, first_binding=first_binding, binding_count=len(d['resources'])))
    pkg.add('passes', dict(name=pkg.string('pre-gbuffer'), first_draw=0, draw_count=len(draws)))
    for ai, a in enumerate(pack['appearances']):
        pkg.add('actors', dict(kind=E['ActorKind']['appearance'], name=pkg.string(a['id']), index=ai, first=pkg.string(a['name']), parent=NONE, node=NONE))
    looks = [a['id'] for a in pack['appearances']]
    for mi, m in enumerate(palette['meshes']):
        worn = m.get('appearances')
        gate = NONE if worn is None else pkg.blob(b''.join(struct.pack('<I', looks.index(a)) for a in worn))
        pkg.add('actors', dict(kind=E['ActorKind']['mesh'], name=pkg.string(m['mesh']), index=mi, first=len(tables['actors'])+1, count=len(m['bones']),
                               blob=NONE, aux_blob=NONE, oracle_blob=gate, flags=0 if worn is None else E['ActorFlag']['appearance_gate']))
        for bi, _ in enumerate(m['bones']):pkg.add('actors', dict(kind=E['ActorKind']['bone'], index=bi, parent=mi, node=bi))
    (runtime/vulkan_outfit.OWN).mkdir(parents=True, exist_ok=True)
    for digest, raw in pkg.written.items():(runtime/vulkan_outfit.OWN/digest).write_bytes(raw)
    header = dict(width=4, height=4, output_target=NONE, character=pkg.string('fixture'), scene_sha256=bytes.fromhex(entry['neutral_scene']['sha256']),
                  manifest_sha256=bytes.fromhex(entry['source']['sha256']))
    return vulkan_outfit.write_table(header, tables)


# The SI free-migration shape: non-ASCII ini name, LF, mixed separators, merged-skeleton pools, slot textures,
# a Hide section for O2 submesh 1, a PlayablePosition-like section, and a LOD1 entry the template has no mesh for.
SI_INI = '''[Constants]
global $component_count = 2
global $bones_count = 6

[Pool_MergedSkeleton_Component_VertexGroupOffsets]
pool_size = $component_count

[CommandListInitializeMergedSkeleton]
$component_id = 0
$Pool_MergedSkeleton_Component_VertexGroupOffsets[$component_id] = 0
$Pool_MergedSkeleton_Component_VertexGroupCounts[$component_id] = 3

[TextureOverride_EntryPoint_LOD0.40609654_6_0]
hash = 40609654
match_first_index = 0
match_index_count = 6
if vb0 == 7181007
    handling = skip
    $\\EFMIv1\\component_id = 0
    CommandList\\EFMIv1\\Callback_Component_DrawCustom = ref CommandList_Draw_LOD0.40609654_6_0
    run = CommandList\\EFMIv1\\Component_DrawInstances
endif

[CommandList_Draw_LOD0.40609654_6_0]
ib = Resource_LOD0.40609654_6_0_Index
vb0 = Resource_LOD0.40609654_6_0_Position
ps-t17 = ResourceTexture_Diffuse
ps-t18 = ResourceTexture_Light
; [mesh:LOD0.40609654-6-0.cloth] [vertex_count:4]
  drawindexedinstanced = 6,INSTANCE_COUNT,0,0,FIRST_INSTANCE

[TextureOverride_EntryPoint_LOD1.0badc0de_9_0]
hash = 0badc0de
match_first_index = 0
match_index_count = 9
$\\EFMIv1\\component_id = 1
run = CommandList_Draw_LOD1

[CommandList_Draw_LOD1]
drawindexedinstanced = 9,INSTANCE_COUNT,0,0,FIRST_INSTANCE

[Resource_LOD0.40609654_6_0_Index]
type = Buffer
format = DXGI_FORMAT_R32_UINT
stride = 4
filename = Meshes\\LOD0.40609654-6-0-Index.buf

[Resource_LOD0.40609654_6_0_Position]
type = Buffer
stride = 16
filename = Meshes/LOD0.40609654-6-0-Position.buf

[ResourceTexture_Diffuse]
filename = Textures\\D.dds

[ResourceTexture_Light]
filename = Textures/L.Dds

[TextureOverrideHideFaceLOD0]
hash = 6504de68
match_first_index = 0
match_index_count = 3
if vb0 == 7181016
    handling = skip
endif

[TextureOverridePlayablePosition_40609654]
hash = 00c0ffee
match_first_index = 0
match_index_count = 6
filter_index = 7181003
'''


def si_mod(root, ini=SI_INI, positions=O1_POSITIONS):
    (root/'Meshes').mkdir(parents=True); (root/'Textures').mkdir()
    (root/'示例乙.ini').write_text(ini)
    (root/'Meshes/LOD0.40609654-6-0-Index.buf').write_bytes(struct.pack('<6I', 0, 1, 2, 2, 1, 3))
    (root/'Meshes/LOD0.40609654-6-0-Position.buf').write_bytes(b''.join(struct.pack('<3fI', *p, 0) for p in positions))
    (root/'Textures/D.dds').write_bytes(dds(8, 8, 99))
    (root/'Textures/l.dds').write_bytes(dds(8, 8, 98))
    (root/'Textures/unused.dds').write_bytes(dds(4, 4, 98))
    return root


# The EFMI-Tools template shape: CRLF, an entry for O2 submesh 0, an empty draw list that hides O1, `this` textures named
# after their components, one of them a BC5 without a DX10 header and one whose file name claims another format than its header.
TOOLS_INI = '''[ResourceModName]
type = Buffer
data = "Tools Mod"

[TextureOverride_EntryPoint_Component0]
hash = ad2ae6dc
match_index_count = 3
if $mod_enabled && DRAW_TYPE == 4
    $\\EFMIv1\\component_id = 0
    CommandList\\EFMIv1\\Callback_Component_DrawCustom = ref CommandList_Draw_Component0
    run = CommandList\\EFMIv1\\Component_DrawInstances
endif

[TextureOverride_EntryPoint_Component1]
hash = 40609654
match_index_count = 6
CommandList\\EFMIv1\\Callback_Component_DrawCustom = ref CommandList_Draw_Component1
run = CommandList\\EFMIv1\\Component_DrawInstances

[CommandList_Draw_Component0]
ib = ref Resource_Component0_IB
run = CommandList\\EFMIv1\\OverrideTextures
drawindexed = 3, 0, 0

[CommandList_Draw_Component1]

[Resource_Component0_IB]
type = Buffer
format = DXGI_FORMAT_R16_UINT
stride = 2
filename = Meshes/Component0_IB.buf

[Resource_Texture_1234abcd]
filename = Textures/Components-0 t=1234abcd BC7-Linear.dds

[TextureOverride_Texture0]
hash = 1234abcd
if $object_detected
    this = Resource_Texture_1234abcd
endif

[Resource_Texture_5678ef01]
filename = Textures/Components-0-1 t=5678ef01 BC5-Linear.dds

[TextureOverride_Texture1]
hash = 5678ef01
this = Resource_Texture_5678ef01
'''


def tools_mod(root):
    (root/'Meshes').mkdir(parents=True); (root/'Textures').mkdir()
    (root/'mod.ini').write_bytes(TOOLS_INI.replace('\n', '\r\n').encode())
    (root/'Meshes/Component0_IB.buf').write_bytes(struct.pack('<3H', 0, 1, 2))
    (root/'Textures/Components-0 t=1234abcd BC7-Linear.dds').write_bytes(dds(4, 4, 99))
    (root/'Textures/Components-0-1 t=5678ef01 BC5-Linear.dds').write_bytes(dds(4, 4, fourcc=b'ATI2'))
    return root


def write_map(path, **fields):
    path.write_text(json.dumps(dict(schema='endfield-outfit-map/v1', **fields)))
    return path


# One component drawn on O1 (CLOTH) with its original positions; {draw} is the body of its draw command list.
CLOTH_INI = '''[TextureOverride_EntryPoint_LOD0.40609654_6_0]
hash = 40609654
match_first_index = 0
match_index_count = 6
$\\EFMIv1\\component_id = 0
run = CommandList_Draw

[CommandList_Draw]
vb0 = Resource_Position
{draw}

[Resource_Position]
type = Buffer
stride = 16
filename = Meshes/Position.buf
'''


def cloth_mod(root, draw, textures, sections=''):
    """A mod of CLOTH_INI with the draw list `draw`, the ini `sections` after it, and `textures` (path -> DDS bytes)."""
    (root/'Meshes').mkdir(parents=True); (root/'Textures').mkdir()
    (root/'mod.ini').write_text(CLOTH_INI.format(draw=draw)+sections)
    (root/'Meshes/Position.buf').write_bytes(b''.join(struct.pack('<3fI', *p, 0) for p in O1_POSITIONS))
    for name, raw in textures.items():(root/name).write_bytes(raw)
    return root


MOVED_POSITIONS = O1_POSITIONS[:3]+[(1, 1, 0.5)]


def geometry_mod(root):
    """CLOTH_INI drawn from the component's own index buffer with O1's fourth vertex moved, and a new _BaseMap: mod geometry."""
    sections = '\n[Resource_IB]\ntype = Buffer\nformat = DXGI_FORMAT_R16_UINT\nfilename = Meshes/IB.buf\n\n[ResourceNew]\nfilename = Textures/new.dds\n'
    mod = cloth_mod(root, 'ib = Resource_IB\nps-t17 = ResourceNew\ndrawindexed = 6, 0, 0', {'Textures/new.dds': dds(8, 8, 99)}, sections)
    (mod/'Meshes/IB.buf').write_bytes(struct.pack('<6H', 0, 1, 2, 2, 1, 3))
    (mod/'Meshes/Position.buf').write_bytes(b''.join(struct.pack('<3fI', *p, 0) for p in MOVED_POSITIONS))
    return mod


# Two sub-draws of CLOTH bind one slot: first the template's own _MetallicGlossMap (filled with its binding 2), then a new texture.
SLOT_DRAW = '''ps-t18 = ResourceOld
drawindexedinstanced = 3,INSTANCE_COUNT,0,0,FIRST_INSTANCE
ps-t18 = ResourceNew
drawindexedinstanced = 3,INSTANCE_COUNT,3,0,FIRST_INSTANCE'''
SLOT_SECTIONS = '''
[ResourceOld]
filename = Textures/old.dds

[ResourceNew]
filename = Textures/new.dds
'''


# A draw after EFMI's texture check, which fires the `this` overrides.
CHECKED_DRAW = 'run = CommandList\\EFMIv1\\OverrideTextures\ndrawindexedinstanced = 6,INSTANCE_COUNT,0,0,FIRST_INSTANCE'


def this_sections(*hashes):
    """EFMI-Tools `this` overrides of CLOTH's component 0, one per original texture hash."""
    return ''.join(f'\n[Resource_Texture_{h}]\nfilename = Textures/Components-0 t={h} BC7-Linear.dds\n\n'
                   f'[TextureOverride_Texture{i}]\nhash = {h}\nthis = Resource_Texture_{h}\n' for i, h in enumerate(hashes))


FILTER_DRAW = 'ps-t[FilterTexture0] = ref ResourceTexture0\ndrawindexedinstanced = 6,INSTANCE_COUNT,0,0,FIRST_INSTANCE'


def filter_sections(dhash, file='Textures/new.dds', match_format=None):
    """The EFMI-Tools filter FILTER_DRAW binds `file` by: the template texture whose dHash is nearest `dhash` gets it."""
    own = f'match_format = {match_format}\n' if match_format else ''
    return f'\n[ResourceTexture0]\nfilename = {file}\n\n[FilterTexture0]\n{own}match_dhash = {dhash:016x}\n'


def template_dhash(fmt, binding):
    """The dHash of a template texture of `package_fixture`, its two levels filled with its binding."""
    raw = bytes([binding])*16
    return texture_dhash.dhash(fmt, [(4, 4, raw), (2, 2, raw)])


def fingerprint(root, names):
    rows = sorted((n, hashlib.sha256((root/n).read_bytes()).hexdigest()) for n in names)
    return hashlib.sha256(json.dumps([list(r) for r in rows], sort_keys=True).encode()).hexdigest()


class ImportOutfitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.package = package_fixture(self.root/'package')

    def staged(self, output):
        package = Package(output); runtime = output/'runtime'; native_bundle.verify(runtime)
        entry = package.native_entry
        pack = read_json(runtime/entry['c7']['file'])
        source = read_json(runtime/entry['source']['file'])
        palette = read_json(runtime/'animation'/pack['animation']['palette_contract']['file'])
        graph = read_json(runtime/entry['graph']['file'])
        return package, runtime, pack, source, palette, graph

    def si_import(self, **mapping):
        mod = si_mod(self.root/'si')
        path = write_map(self.root/'outfit-map.json', **mapping) if mapping else None
        return import_outfit.import_outfit(self.package.root, mod, self.root/'out', mapping=path), mod

    def test_maps_by_region_hash_and_replaces_only_textures(self):
        report, mod = self.si_import(textures={'1': '_MetallicGlossMap'})
        package, runtime, pack, source, palette, graph = self.staged(self.root/'out')
        aid = report['appearance']['id']
        self.assertEqual(report['appearance'], dict(id=aid, name='si'))
        self.assertEqual((report['character'], report['version'], package.version), ('fixture', '1.0.1', '1.0.1'))
        rows = {r['section']: (r['action'], r.get('mesh')) for r in report['components']}
        self.assertEqual(rows, {'TextureOverride_EntryPoint_LOD0.40609654_6_0': ('textures', CLOTH), 'TextureOverride_EntryPoint_LOD1.0badc0de_9_0': ('skipped_lod', None),
                                'TextureOverrideHideFaceLOD0': ('hidden', BODY), 'TextureOverridePlayablePosition_40609654': ('ignored', None)})
        self.assertEqual(report['components'][0]['geometry'], 'unmodified')
        self.assertEqual(report['textures'], [dict(index=0, file='Textures/D.dds', meshes=[CLOTH], resource='_BaseMap'),
                                              dict(index=1, file='Textures/L.Dds', meshes=[CLOTH], resource='_MetallicGlossMap')])
        self.assertEqual(report['unused_textures'], ['Textures/unused.dds'])
        self.assertIn('needs_mips:Textures/D.dds', report['warnings'])
        new = 'outfit:'+aid+'/'+CLOTH
        [template] = [d for d in source['draws'] if d['mesh'] == CLOTH]
        [clone] = [d for d in source['draws'] if d['mesh'] == new]
        # Textures only: the clone keeps the template's index and vertex bytes.
        self.assertEqual(clone['indices'], template['indices'])
        self.assertEqual(clone['attributes'], template['attributes'])
        replaced = {r['names'][0]: r for r in clone['resources']}
        self.assertEqual(replaced['_BaseMap']['sha256'], hashlib.sha256(dds(8, 8, 99)[148:]).hexdigest())
        self.assertEqual(replaced['_BaseMap']['texture']['width'], 8)
        self.assertEqual(replaced['_MetallicGlossMap']['sha256'], hashlib.sha256(dds(8, 8, 98)[148:]).hexdigest())
        self.assertEqual(replaced['_BumpMap'], {r['names'][0]: r for r in template['resources']}['_BumpMap'])
        self.assertEqual(graph['passes'][0]['draws'], [0, 1, 2, 3, 4])
        meshes = {m['mesh']: m.get('appearances') for m in palette['meshes']}
        self.assertEqual(meshes, {CLOTH: ['default', 'top'], BODY: ['default', 'top'], TWIN: ['top'], new: [aid]})
        self.assertEqual(pack['appearances'][-1]['kind'], 'imported')
        coverage = read_json(runtime/package.native_entry['coverage']['file'])
        self.assertEqual((coverage['appearances'], coverage['blocked']), (['default', 'top', aid], {}))
        self.assertTrue((self.root/'out/provenance'/('outfit-'+aid+'.json')).is_file())

    def neutral(self, runtime, entry):
        """The neutral scene of entry and whether its neutral package emits its frame graph byte for byte."""
        scene, record, metal = (read_json(runtime/entry[field]['file']) for field, _ in native_bundle.NEUTRAL)
        return scene, native_bundle.emitted(scene, record, metal) == (runtime/entry['graph']['file']).read_bytes()

    def test_the_import_writes_the_neutral_package_of_the_new_graph(self):
        self.package = package_fixture(self.root/'old', neutral=False)
        self.assertFalse(any(field in self.package.native_entry for field, _ in native_bundle.NEUTRAL))
        self.si_import(textures={'1': '_MetallicGlossMap'})
        package, runtime, _, _, _, graph = self.staged(self.root/'out')
        scene, same = self.neutral(runtime, package.native_entry)
        self.assertTrue(same)
        self.assertEqual(scene['passes'][0]['draws'], graph['passes'][0]['draws'])
        self.assertEqual(scene['frame_inputs']['visible_draws'], graph['frame_inputs']['visible_draws'])
        files = {f['file'] for f in read_json(runtime/'bundle.json')['files']}
        self.assertTrue({package.native_entry[field]['file'] for field, _ in native_bundle.NEUTRAL} <= files)
        import_outfit.import_outfit(self.root/'out', tools_mod(self.root/'tools'), self.root/'again')
        again, runtime, _, _, _, graph = self.staged(self.root/'again')
        scene, same = self.neutral(runtime, again.native_entry)
        self.assertTrue(same)
        self.assertNotEqual(again.native_entry['neutral_scene'], package.native_entry['neutral_scene'])
        self.assertEqual(scene['passes'][0]['draws'], graph['passes'][0]['draws'])

    def test_the_import_carries_the_clone_into_the_windows_frame_table(self):
        self.package = package_fixture(self.root/'windows', skinned=True, vulkan=True)
        report, _ = self.si_import(textures={'1': '_MetallicGlossMap'})
        package, runtime, pack, source, palette, _ = self.staged(self.root/'out')
        entry, aid = package.native_entry, report['appearance']['id']
        self.assertIn('vulkan_frame', entry)
        header, t = vulkan_outfit.read_table((runtime/entry['vulkan_frame']['file']).read_bytes())
        self.assertEqual((header['manifest_sha256'].hex(), header['scene_sha256'].hex()), (entry['source']['sha256'], entry['neutral_scene']['sha256']))
        def text(o):return t['strings'][o:t['strings'].index(b'\0', o)].decode()
        new = 'outfit:'+aid+'/'+CLOTH
        self.assertEqual([(text(d['mesh']), d['source_draw']) for d in t['draws']], [(CLOTH, 0), (BODY, 1), (BODY, 2), (TWIN, 3), (new, 4)])
        self.assertEqual((t['passes'][0]['first_draw'], t['passes'][0]['draw_count']), (0, 5))
        template, clone = t['draws'][0], t['draws'][4]
        def bound(d):
            return {(b['set'], b['binding']): t['blobs'][t['textures'][b['index']]['blob']]['sha256'].hex()
                    for b in t['bindings'][d['first_binding']:d['first_binding']+d['binding_count']]}
        resources = {(r['set'], r['binding']): r['sha256'] for r in source['draws'][4]['resources']}
        self.assertEqual(bound(clone), resources)
        self.assertNotEqual(bound(clone)[(1, 7)], bound(template)[(1, 7)])
        self.assertEqual(bound(clone)[(1, 6)], bound(template)[(1, 6)])
        self.assertEqual(t['blobs'][clone['index_blob']]['sha256'].hex(), source['draws'][4]['indices']['sha256'])
        K = package_format.ENUMS['ActorKind']
        self.assertEqual([text(r['name']) for r in t['actors'] if r['kind'] == K['appearance']], ['default', 'top', aid])
        def gate(name):
            [r] = [r for r in t['actors'] if r['kind'] == K['mesh'] and text(r['name']) == name]
            data = (runtime/text(t['blobs'][r['oracle_blob']]['file'])).read_bytes()
            return list(struct.unpack('<%dI' % (len(data)//4), data))
        self.assertEqual((gate(CLOTH), gate(new), gate(TWIN)), ([0, 1], [2], [1]))
        [mesh] = [r for r in t['actors'] if r['kind'] == K['mesh'] and text(r['name']) == new]
        bones = t['actors'][mesh['first']:mesh['first']+mesh['count']]
        self.assertEqual([(b['kind'], b['parent'], b['node']) for b in bones], [(K['bone'], mesh['index'], n) for n in range(3)])

    def test_the_import_names_the_version_it_derives_from(self):
        self.si_import(textures={'1': '_MetallicGlossMap'})
        self.assertEqual(read_json(self.root/'out/character.json')['base_package_version'], '1.0.0')
        definition = read_json(self.package.root/'character.json'); definition['base_package_version'] = '0.9.0'
        write_json(self.package.root/'character.json', definition)
        import_outfit.import_outfit(self.package.root, si_mod(self.root/'si2'), self.root/'out2', mapping=write_map(self.root/'map2.json', textures={'1': '_MetallicGlossMap'}))
        self.assertEqual(read_json(self.root/'out2/character.json')['base_package_version'], '0.9.0')

    def test_the_appearance_is_named_by_the_mod_fingerprint(self):
        report, mod = self.si_import(textures={'1': '_ClearCoatMask'})
        names = ['示例乙.ini', 'Meshes/LOD0.40609654-6-0-Index.buf', 'Meshes/LOD0.40609654-6-0-Position.buf', 'Textures/D.dds', 'Textures/l.dds']
        expected = fingerprint(mod, names)
        _, _, pack, *_ = self.staged(self.root/'out')
        record = pack['appearances'][-1]
        self.assertEqual(record['id'], 'mod_'+expected[:8])
        self.assertEqual({k: v for k, v in record['source'].items() if k != 'imported_at'}, dict(format='efmi', fingerprint=expected))
        self.assertRegex(record['source']['imported_at'], r'^\d{4}-\d\d-\d\dT')

    def test_the_twin_with_more_equal_positions_wins_then_the_non_vfxpart(self):
        mod = si_mod(self.root/'si', ini=SI_INI.replace('ps-t18 = ResourceTexture_Light\n', ''), positions=O1_POSITIONS[:3]+[(5, 5, 5)])
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        self.assertEqual((report['components'][0]['mesh'], report['components'][0]['geometry']), (TWIN, 'unmodified'))
        self.assertEqual(import_outfit.choose([CLOTH, TWIN], {CLOTH: 0, TWIN: 0}), CLOTH)
        self.assertIsNone(import_outfit.choose([CLOTH, 'S_actor_test_cloth_02_lod0'], {}))

    def test_mapping_components_override_the_hash(self):
        mod = si_mod(self.root/'si', ini=SI_INI.replace('ps-t18 = ResourceTexture_Light\n', ''))
        mapping = write_map(self.root/'map.json', components={'0': TWIN})
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out', mapping=mapping)
        self.assertEqual((report['components'][0]['mesh'], report['textures'][0]['resource']), (TWIN, '_BaseMap'))

    def test_tools_shape_pairs_this_textures_by_component_and_hides_an_empty_draw_list(self):
        report = import_outfit.import_outfit(self.package.root, tools_mod(self.root/'tools'), self.root/'out', name='女仆')
        package, runtime, pack, source, palette, graph = self.staged(self.root/'out')
        aid = report['appearance']['id']
        self.assertEqual(report['appearance']['name'], '女仆')
        self.assertEqual(pack['appearances'][-1]['source']['mod_name'], 'Tools Mod')
        self.assertEqual([(r['action'], r.get('mesh')) for r in report['components'] if r['action'] != 'ignored'],
                         [('textures', BODY), ('hidden', CLOTH)])
        self.assertEqual([(t['file'], t['meshes'], t['resource']) for t in report['textures']],
                         [('Textures/Components-0 t=1234abcd BC7-Linear.dds', [BODY], '_BaseMap'),
                          ('Textures/Components-0-1 t=5678ef01 BC5-Linear.dds', [BODY], '_BumpMap')])
        self.assertIn('format_tag:Textures/Components-0 t=1234abcd BC7-Linear.dds', report['warnings'])
        new = 'outfit:'+aid+'/'+BODY
        self.assertEqual(len([d for d in source['draws'] if d['mesh'] == new]), 2)
        meshes = {m['mesh']: m.get('appearances') for m in palette['meshes']}
        self.assertEqual(meshes, {CLOTH: ['default', 'top'], BODY: ['default', 'top'], TWIN: ['top'], new: [aid]})

    def test_each_submesh_of_a_texture_only_clone_keeps_its_own_indices(self):
        # BODY's two submeshes, as birch's brow: the M_face draw must not take the M_body draw's indices.
        report = import_outfit.import_outfit(self.package.root, tools_mod(self.root/'tools'), self.root/'out')
        *_, source, _, _ = self.staged(self.root/'out')
        new = 'outfit:'+report['appearance']['id']+'/'+BODY
        templates = {d['material']: d['indices'] for d in source['draws'] if d['mesh'] == BODY}
        self.assertEqual({d['material']: d['indices'] for d in source['draws'] if d['mesh'] == new}, templates)

    def test_a_component_with_geometry_of_its_own_replaces_its_mesh(self):
        package = package_fixture(self.root/'atlas', atlas=True)
        report = import_outfit.import_outfit(package.root, geometry_mod(self.root/'mod'), self.root/'out')
        _, runtime, pack, source, palette, graph = self.staged(self.root/'out')
        self.assertEqual(report['components'][0]['action'], 'geometry')
        self.assertEqual(report['geometry'], [dict(component=0, section='TextureOverride_EntryPoint_LOD0.40609654_6_0', mesh=CLOTH, submesh=None,
                                                   change='modified', applied=True, vertices=4, groups=1, bones_appended=0, warnings=[])])
        self.assertFalse([w for w in report['warnings'] if w.startswith('geometry_not_applied')])
        new = 'outfit:'+report['appearance']['id']+'/'+CLOTH
        [clone] = [d for d in source['draws'] if d['mesh'] == new]
        position = next(a for a in clone['attributes'] if a['source_channel'] == 0)
        self.assertEqual((runtime/'source'/position['file']).read_bytes(), struct.pack('<12f', *[v for p in MOVED_POSITIONS for v in p]))
        base = next(r for r in clone['resources'] if r['names'] == ['_BaseMap'])
        self.assertEqual(base['sha256'], hashlib.sha256(dds(8, 8, 99)[148:]).hexdigest())
        # The atlas entry casts the mod geometry from blobs beside the frame graph.
        [caster] = [e for p in graph['passes'] for e in p.get('geometry', []) if e['mesh'] == new]
        cast = next(a for a in caster['attributes'] if a['source_channel'] == 0)
        self.assertEqual((runtime/cast['file']).read_bytes(), (runtime/'source'/position['file']).read_bytes())

    def test_a_texture_replaces_the_material_of_its_size_where_materials_share_a_resource_name(self):
        # maid's cloth_05: two materials of one submesh sample `_MainTex` at two sizes, and the mod brings one file for each.
        package = package_fixture(self.root/'two', second_material=True)
        small, large = 'Textures/Components-0 t=0000aaaa BC7-sRGB.dds', 'Textures/Components-0 t=1111bbbb BC7-sRGB.dds'
        mod = cloth_mod(self.root/'mod', CHECKED_DRAW, {small: dds(4, 4, 99, fill=8), large: dds(8, 8, 99, fill=9)},
                        this_sections('0000aaaa', '1111bbbb').replace('BC7-Linear', 'BC7-sRGB'))
        report = import_outfit.import_outfit(package.root, mod, self.root/'out')
        self.assertEqual([(t['file'], t['resource']) for t in report['textures']], [(small, '_BaseMap'), (large, '_BaseMap')])
        *_, source, _, _ = self.staged(self.root/'out')
        new = 'outfit:'+report['appearance']['id']+'/'+CLOTH
        bases = {d['material']: next(r['sha256'] for r in d['resources'] if r['names'] == ['_BaseMap']) for d in source['draws'] if d['mesh'] == new}
        self.assertEqual(bases, {'M_cloth': hashlib.sha256(dds(4, 4, 99, fill=8)[148:]).hexdigest(),
                                 'M_cloth_b': hashlib.sha256(dds(8, 8, 99, fill=9)[148:]).hexdigest()})

    def test_merged_ids_of_a_lod1_component_take_its_lod0_mesh_bones_in_the_lod1_order(self):
        # si-df68a's shape: component 0's vertices weigh vertex groups of LOD1 component 1, whose bone l is BODY's bone [2, 0, 1][l].
        ini = '''[Constants]
global $bones_count = 6

[Pool_MergedSkeleton_Component_VertexGroupOffsets]
pool_size = 2

[CommandListInitializeMergedSkeleton]
$component_id = 0
$Pool_MergedSkeleton_Component_VertexGroupOffsets[$component_id] = 0
$Pool_MergedSkeleton_Component_VertexGroupCounts[$component_id] = 3
$component_id = 1
$Pool_MergedSkeleton_Component_VertexGroupOffsets[$component_id] = 3
$Pool_MergedSkeleton_Component_VertexGroupCounts[$component_id] = 3

[TextureOverride_EntryPoint_LOD0.40609654_6_0]
hash = 40609654
match_index_count = 6
$\\EFMIv1\\component_id = 0
run = CommandList_Draw

[TextureOverride_EntryPoint_LOD1.0badc0de_9_0]
hash = 0badc0de
match_index_count = 9
$\\EFMIv1\\component_id = 1
drawindexed = 9, 0, 0

[CommandList_Draw]
ib = Resource_IB
vb0 = Resource_Position
vb2 = Resource_Blend
drawindexed = 6, 0, 0

[Resource_IB]
type = Buffer
format = DXGI_FORMAT_R16_UINT
filename = Meshes/IB.buf

[Resource_Position]
type = Buffer
stride = 16
filename = Meshes/Position.buf

[Resource_Blend]
type = Buffer
stride = 16
filename = Meshes/Blend.buf
'''
        package = package_fixture(self.root/'skinned', skinned=True)
        mod = cloth_mod(self.root/'mod', '', {})
        (mod/'mod.ini').write_text(ini)
        (mod/'Meshes/IB.buf').write_bytes(struct.pack('<6H', 0, 1, 2, 2, 1, 3))
        (mod/'Meshes/Position.buf').write_bytes(b''.join(struct.pack('<3fI', *p, 0) for p in MOVED_POSITIONS))
        (mod/'Meshes/Blend.buf').write_bytes(b''.join(struct.pack('<8H', 65535, 0, 0, 0, 3+k % 3, 0, 0, 0) for k in range(4)))
        table = {'0badc0de': dict(lod1_mesh='S_actor_test_body_01_lod1', lod0_mesh=BODY, index_count=9, bones=[2, 0, 1])}
        carrying = package_fixture(self.root/'carrying', skinned=True, tables={
            import_outfit.LOD1_FILE: dict(schema=import_outfit.LOD1_SCHEMA, characters=dict(fixture=table))})
        report = import_outfit.import_outfit(carrying.root, mod, self.root/'out')
        self.assertEqual([(r['section'], r['action']) for r in report['components']],
                         [('TextureOverride_EntryPoint_LOD0.40609654_6_0', 'geometry'), ('TextureOverride_EntryPoint_LOD1.0badc0de_9_0', 'skipped_lod')])
        _, runtime, _, source, _, _ = self.staged(self.root/'out')
        [clone] = [d for d in source['draws'] if d['mesh'] == 'outfit:'+report['appearance']['id']+'/'+CLOTH]
        bones = next(a for a in clone['attributes'] if a['source_channel'] == 13)
        self.assertEqual(struct.unpack('<16I', (runtime/'source'/bones['file']).read_bytes())[0::4], (2, 0, 1, 2))
        # Without the table the vertex groups of the LOD1 component are no bones the importer knows.
        with self.assertRaises(ValueError) as caught:import_outfit.import_outfit(package.root, mod, self.root/'out-bare')
        self.assertEqual(str(caught.exception), 'unsupported_geometry:bone_unresolved:0:3')

    def test_draws_under_a_variable_the_override_sets_first_are_drawn(self):
        # Ink-mist's shape: the override sets $v940, and its post-run list draws only while $v940 holds that value.
        ini = '''[Constants]
global $v940 = 0

[TextureOverride372]
hash = 40609654
match_index_count = 6
if DRAW_TYPE == 4
    $v940 = 372
    handling = skip
endif
post run = CommandListD372

[CommandListD372]
if $v940 == 372
    $v940 = 0
    $\\EFMIv1\\component_id = 0
    run = CommandListDraw
endif

[CommandListDraw]
vb0 = Resource_Position
ps-t17 = ResourceNew
drawindexed = 6, 0, 0

[Resource_Position]
type = Buffer
stride = 16
filename = Meshes/Position.buf

[ResourceNew]
filename = Textures/new.dds
'''
        mod = cloth_mod(self.root/'mod', '', {'Textures/new.dds': dds(8, 8, 99)})
        (mod/'mod.ini').write_text(ini)
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        self.assertEqual([(r['section'], r['action'], r.get('mesh')) for r in report['components']], [('TextureOverride372', 'textures', CLOTH)])
        self.assertEqual(report['textures'], [dict(index=0, file='Textures/new.dds', meshes=[CLOTH], resource='_BaseMap')])

    def test_a_mesh_the_mod_keeps_is_shown_wherever_the_default_appearance_shows_it(self):
        self.assertEqual(import_outfit.visible_in(['default'], 'default', 'mod_1'), ['default', 'mod_1'])
        self.assertEqual(import_outfit.visible_in(['top'], 'default', 'mod_1'), ['top'])
        self.assertIsNone(import_outfit.visible_in(None, 'default', 'mod_1'))

    def code(self, mod, mapping=None):
        with self.assertRaises(ValueError) as caught:import_outfit.import_outfit(self.package.root, mod, self.root/'out', mapping=mapping)
        self.assertFalse((self.root/'out').exists())
        return str(caught.exception).split(':')[0]

    def test_error_codes(self):
        # The Hide section's hash is the character's, so the drawn one is a component it lacks.
        drawn_unknown = SI_INI.replace('hash = 40609654', 'hash = 12345678').replace('ib = Resource_LOD0.40609654_6_0_Index\n', '')
        self.assertEqual(self.code(si_mod(self.root/'a', ini=drawn_unknown, positions=[(7, 7, i) for i in range(4)])), 'unmapped_component')
        self.assertEqual(self.code(si_mod(self.root/'b')), 'texture_mismatch')
        mapping = write_map(self.root/'map.json', textures={'1': '_EmissionMap'})
        self.assertEqual(self.code(si_mod(self.root/'c'), mapping), 'texture_mismatch')
        bem = self.root/'bem'; bem.mkdir(); (bem/'pack.bem').write_bytes(b'BEM\0PKG\0')
        self.assertEqual(self.code(bem), 'unsupported_mod')
        stream = self.root/'stream'; stream.mkdir()
        (stream/'mod.ini').write_text('[TextureOverride_Component0]\nhash = 40609654\nvb1 = ref Resource_VB1\n\n[Resource_VB1]\ntype = Buffer\nstride = 8\nfilename = vb1.buf\n')
        (stream/'vb1.buf').write_bytes(bytes(32))
        self.assertEqual(self.code(stream), 'unsupported_geometry')
        empty = self.root/'empty'; empty.mkdir(); (empty/'mod.ini').write_text('[Constants]\nglobal $x = 0\n')
        self.assertEqual(self.code(empty), 'unsupported_mod')

    def test_a_merged_skeleton_does_not_refuse_a_textures_only_import(self):
        mod = si_mod(self.root/'si')
        mapping = write_map(self.root/'map.json', textures={'1': '_ClearCoatMask'})
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out', mapping=mapping)
        self.assertEqual(report['components'][0]['action'], 'textures')
        self.assertNotIn('format_changed:Textures/L.Dds', report['warnings'])

    def test_a_mapping_may_put_a_bc7_normal_map_in_a_bc5_slot_with_a_warning(self):
        mapping = write_map(self.root/'map.json', textures={'1': '_BumpMap'})
        report = import_outfit.import_outfit(self.package.root, si_mod(self.root/'si'), self.root/'out', mapping=mapping)
        self.assertEqual(report['textures'][1]['resource'], '_BumpMap')
        self.assertIn('format_changed:Textures/L.Dds', report['warnings'])

    def test_a_texture_equal_to_its_template_is_unchanged_and_its_hash_rules_out_its_resource(self):
        old, new = 'Textures/Components-0 t=11111111 BC7-Linear.dds', 'Textures/Components-0 t=22222222 BC7-Linear.dds'
        mod = cloth_mod(self.root/'mod', CHECKED_DRAW,
                        {old: dds(4, 4, 98, fill=2), new: dds(8, 8, 98)}, this_sections('11111111', '22222222'))
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        self.assertEqual(report['textures'], [dict(index=0, file=old, meshes=[], resource=None, unchanged={CLOTH: '_MetallicGlossMap'}),
                                              dict(index=1, file=new, meshes=[CLOTH], resource='_ClearCoatMask')])
        *_, source, _, _ = self.staged(self.root/'out')
        [template] = [d for d in source['draws'] if d['mesh'] == CLOTH]
        [clone] = [d for d in source['draws'] if d['mesh'] == 'outfit:'+report['appearance']['id']+'/'+CLOTH]
        mine, theirs = ({r['names'][0]: r['sha256'] for r in d['resources']} for d in (clone, template))
        self.assertEqual(mine['_MetallicGlossMap'], theirs['_MetallicGlossMap'])
        self.assertEqual(mine['_ClearCoatMask'], hashlib.sha256(dds(8, 8, 98)[148:]).hexdigest())

    def test_a_slot_that_bound_an_unchanged_texture_places_the_next_one(self):
        mod = cloth_mod(self.root/'mod', SLOT_DRAW, {'Textures/old.dds': dds(4, 4, 98, fill=2), 'Textures/new.dds': dds(8, 8, 98)}, SLOT_SECTIONS)
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        self.assertEqual(report['textures'], [dict(index=0, file='Textures/new.dds', meshes=[CLOTH], resource='_MetallicGlossMap'),
                                              dict(index=1, file='Textures/old.dds', meshes=[], resource=None, unchanged={CLOTH: '_MetallicGlossMap'})])

    def test_an_ambiguous_texture_names_its_candidates(self):
        mod = cloth_mod(self.root/'mod', SLOT_DRAW, {'Textures/old.dds': dds(4, 4, 98, fill=3), 'Textures/new.dds': dds(8, 8, 98)}, SLOT_SECTIONS)
        with self.assertRaises(ValueError) as caught:import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        # old.dds, of the template's size, is placed before new.dds.
        self.assertEqual(str(caught.exception), f'texture_mismatch:1:Textures/old.dds: candidates {CLOTH}: _ClearCoatMask, _MetallicGlossMap')

    def test_a_slot_learned_from_a_bc5_normal_map_takes_a_file_of_another_format_with_a_warning(self):
        # The runtime samples the file in its own format; the programs unpack _BumpMap as the game's do (x *= w, xy*2-1, z rebuilt).
        draw = SLOT_DRAW.replace('ps-t18', 'ps-t19')
        mod = cloth_mod(self.root/'srgb', draw, {'Textures/old.dds': dds(4, 4, fourcc=b'ATI2', fill=6), 'Textures/new.dds': dds(4, 4, 99)}, SLOT_SECTIONS)
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out-srgb')
        self.assertEqual(report['textures'][0]['resource'], '_BumpMap')
        self.assertIn('format_changed:Textures/new.dds', report['warnings'])
        mod = cloth_mod(self.root/'mod', draw, {'Textures/old.dds': dds(4, 4, fourcc=b'ATI2', fill=6), 'Textures/new.dds': dds(4, 4, 98)}, SLOT_SECTIONS)
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        self.assertEqual(report['textures'][0]['resource'], '_BumpMap')
        self.assertIn('format_changed:Textures/new.dds', report['warnings'])

    def test_the_slot_hint_table_places_a_texture_the_mod_teaches_nothing_about(self):
        draw = 'ps-t18 = ResourceNew\ndrawindexedinstanced = 6,INSTANCE_COUNT,0,0,FIRST_INSTANCE'
        sections = '\n[ResourceNew]\nfilename = Textures/new.dds\n'
        self.assertEqual(self.code(cloth_mod(self.root/'bare', draw, {'Textures/new.dds': dds(8, 8, 98)}, sections)), 'texture_mismatch')
        hints = {'fixture': {'M_cloth': {'ps-t18': '_ClearCoatMask'}}}
        carrying = package_fixture(self.root/'carrying', tables={import_outfit.HINTS_FILE: dict(schema=import_outfit.HINTS_SCHEMA, characters=hints)})
        report = import_outfit.import_outfit(carrying.root, cloth_mod(self.root/'mod', draw, {'Textures/new.dds': dds(8, 8, 98)}, sections), self.root/'out')
        self.assertEqual(report['textures'], [dict(index=0, file='Textures/new.dds', meshes=[CLOTH], resource='_ClearCoatMask')])
        self.assertEqual([import_outfit.slot_hints(c) for c in ('birch', 'aster', 'fixture')], [{}]*3)

    def shipped_tables(self, tables, packed=None):
        """Stages CONTENT_SOURCES flat into content/ as the app does, adds `tables` ({file: document}) beside them and returns
        the shipped importer's [slot_hints('fixture'), lod1_bones('fixture')] as a CompletedProcess; with `packed` ({file: bytes})
        those files also lie in a pack's interaction/ folder that lists them."""
        sys.path.insert(0, str(CHARACTERS.parent/'tools/release'))
        from release import CONTENT_SOURCES
        content = self.root/'shipped/content'; shutil.rmtree(content.parent, ignore_errors=True)
        content.mkdir(parents=True); (content/'__init__.py').write_text('')
        for relative in CONTENT_SOURCES:shutil.copy2(CHARACTERS.parent/relative, content/Path(relative).name)
        for name, document in tables.items():(content/name).write_text(json.dumps(document))
        folder = self.root/'shipped/interaction'; folder.mkdir()
        listed = []
        for name, raw in (packed or {}).items():
            (folder/name).write_bytes(raw); listed.append(dict(file=name, sha256=hashlib.sha256(raw).hexdigest(), byte_count=len(raw)))
        code = ('import sys,json;from pathlib import Path;sys.path[:0]=sys.argv[1:4];import content.import_outfit as m;'
                'pack=(Path(sys.argv[4]),json.loads(sys.argv[5]));print(json.dumps([m.slot_hints("fixture",*pack), m.lod1_bones("fixture",*pack)]))')
        return subprocess.run([sys.executable, '-I', '-c', code, str(content.parent), str(content), str(CHARACTERS.parent/'agent/agentd'),
                               str(folder), json.dumps(listed)], capture_output=True, text=True)

    def test_the_app_content_reads_no_hint_tables_beside_the_module(self):
        hints = {'M_cloth': {'ps-t18': '_ClearCoatMask'}}
        lod1 = {'0badc0de': dict(lod1_mesh='S_actor_test_body_01_lod1', lod0_mesh=BODY, index_count=9, bones=[2, 0, 1])}
        run = self.shipped_tables({import_outfit.HINTS_FILE: dict(schema=import_outfit.HINTS_SCHEMA, characters=dict(fixture=hints)),
                                   import_outfit.LOD1_FILE: dict(schema=import_outfit.LOD1_SCHEMA, characters=dict(fixture=lod1))})
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), [{}, {}])

    def test_only_the_tables_a_pack_lists_are_read(self):
        def table(schema, mesh):return dict(schema=schema, characters=dict(fixture={mesh: {}}))
        beside = {import_outfit.HINTS_FILE: table(import_outfit.HINTS_SCHEMA, 'beside'), import_outfit.LOD1_FILE: table(import_outfit.LOD1_SCHEMA, 'beside')}
        packed = {import_outfit.HINTS_FILE: json.dumps(table(import_outfit.HINTS_SCHEMA, 'packed')).encode()}
        run = self.shipped_tables(beside, packed)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), [{'packed': {}}, {}])
        packed[import_outfit.LOD1_FILE] = json.dumps(table(import_outfit.LOD1_SCHEMA, 'packed')).encode()
        run = self.shipped_tables({}, packed)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), [{'packed': {}}, {'packed': {}}])
        run = self.shipped_tables({}, {import_outfit.HINTS_FILE: json.dumps(table('other', 'packed')).encode()})
        self.assertIn('invalid_slot_hints', run.stderr)

    def test_a_packed_table_other_than_the_pack_records_is_refused(self):
        raw = json.dumps(dict(schema=import_outfit.HINTS_SCHEMA, characters={})).encode()
        folder = self.root/'interaction'; folder.mkdir(); (folder/import_outfit.HINTS_FILE).write_bytes(raw+b' ')
        listed = [dict(file=import_outfit.HINTS_FILE, sha256=hashlib.sha256(raw).hexdigest(), byte_count=len(raw))]
        with self.assertRaises(ValueError) as caught:import_outfit.slot_hints('fixture', folder, listed)
        self.assertEqual(str(caught.exception), 'file_sha_mismatch')

    def test_without_a_packed_hint_table_there_are_no_hints(self):
        run = self.shipped_tables({})
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), [{}, {}])

    def test_a_texture_shared_by_components_with_no_slot_of_its_size_anywhere_is_left_unbound(self):
        ini = '''[TextureOverride_EntryPoint_Component0]
hash = ad2ae6dc
match_index_count = 3
$\\EFMIv1\\component_id = 0
run = CommandList\\EFMIv1\\OverrideTextures
drawindexed = 3, 0, 0

[TextureOverride_EntryPoint_Component1]
hash = 40609654
match_index_count = 6
$\\EFMIv1\\component_id = 1
run = CommandList\\EFMIv1\\OverrideTextures
drawindexed = 6, 0, 0
''' + this_sections('1234abcd', '0000aaaa').replace('Components-0 t=0000aaaa', 'Components-0-1 t=0000aaaa')
        mod = self.root/'mod'; (mod/'Textures').mkdir(parents=True); (mod/'mod.ini').write_text(ini)
        (mod/'Textures/Components-0 t=1234abcd BC7-Linear.dds').write_bytes(dds(8, 8, 99))
        (mod/'Textures/Components-0-1 t=0000aaaa BC7-Linear.dds').write_bytes(dds(16, 8, 98))
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        self.assertEqual([(t['file'], t['resource']) for t in report['textures']],
                         [('Textures/Components-0 t=1234abcd BC7-Linear.dds', '_BaseMap'), ('Textures/Components-0-1 t=0000aaaa BC7-Linear.dds', None)])
        self.assertIn('texture_unbound:Textures/Components-0-1 t=0000aaaa BC7-Linear.dds', report['warnings'])

    def test_a_this_texture_is_placed_by_the_semantic_its_resource_or_file_is_named_by(self):
        draw = CHECKED_DRAW
        hints = {'fixture': {'M_cloth': {'lightmap': '_ClearCoatMask'}}}
        for i, (resource, file) in enumerate([('Resource_Component0_LightMap', 'Textures/Components-0 t=1234abcd.dds'),
                                               ('Resource_Texture0', 'Textures/Components-0 Light.dds')]):
            sections = f'\n[{resource}]\nfilename = {file}\n\n[TextureOverride_Texture0]\nhash = 1234abcd\nthis = {resource}\n'
            self.assertEqual(self.code(cloth_mod(self.root/f'bare{i}', draw, {file: dds(8, 8, 98)}, sections)), 'texture_mismatch')
            with mock.patch.object(import_outfit, 'slot_hints', lambda character, *pack: hints.get(character, {})):
                report = import_outfit.import_outfit(self.package.root, cloth_mod(self.root/f'mod{i}', draw, {file: dds(8, 8, 98)}, sections), self.root/f'out{i}')
            self.assertEqual(report['textures'], [dict(index=0, file=file, meshes=[CLOTH], resource='_ClearCoatMask')])

    def test_a_hash_override_of_a_resource_chosen_at_the_draw_replaces_the_template_texture_of_that_hash(self):
        # 67d578ae and 09226fad are 3DMigoto's hashes of the fixture's _ClearCoatMask and _MetallicGlossMap (mip 0 data, then the
        # desc); by format and shape alone coat.dds could be either.
        draw = '''ResourceSelectedCoat = ref ResourceNewCoat
ResourceSelectedParameters = ref ResourceNewParameters
$active = 1
ps-t70 = ref ResourceNewCoat
run = CommandList\\EFMIv1\\OverrideTextures
drawindexedinstanced = 6,INSTANCE_COUNT,0,0,FIRST_INSTANCE'''
        sections = '''
[ResourceSelectedCoat]
[ResourceSelectedParameters]

[ResourceNewCoat]
filename = Textures/coat.dds

[ResourceNewParameters]
filename = Textures/parameters.dds

[TextureOverride_Coat]
hash = 67d578ae
if $active
    this = ref ResourceSelectedCoat
endif

[TextureOverride_Parameters]
hash = 09226fad
if $active
    this = ref ResourceSelectedParameters
endif
'''
        mod = cloth_mod(self.root/'mod', draw, {'Textures/coat.dds': dds(8, 8, 98), 'Textures/parameters.dds': dds(2, 2, 28)}, sections)
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        self.assertEqual(report['textures'], [dict(index=0, file='Textures/coat.dds', meshes=[CLOTH], resource='_ClearCoatMask'),
                                              dict(index=1, file='Textures/parameters.dds', meshes=[CLOTH], resource='_MetallicGlossMap')])
        self.assertIn('format_changed:Textures/parameters.dds', report['warnings'])
        self.assertNotIn('format_changed:Textures/coat.dds', report['warnings'])

    def test_one_file_replaces_every_template_texture_whose_hash_it_overrides_in_the_file_s_own_format(self):
        # 85063a9b and 67d578ae are 3DMigoto's hashes of CLOTH's _EmissionMap (sRGB) and _ClearCoatMask; BODY has neither.
        package = package_fixture(self.root/'emissive', cloth_extra=[('_EmissionMap', 'BC7_SRGB_BLOCK', True, 9)])
        ini = '''[TextureOverride_EntryPoint_Component0]
hash = ad2ae6dc
match_index_count = 3
$\\EFMIv1\\component_id = 0
run = CommandList\\EFMIv1\\OverrideTextures
drawindexed = 3, 0, 0

[TextureOverride_EntryPoint_Component1]
hash = 40609654
match_index_count = 6
$\\EFMIv1\\component_id = 1
run = CommandList\\EFMIv1\\OverrideTextures
drawindexed = 6, 0, 0

[ResourceZero]
filename = Textures/zero.dds

[TextureOverrideEmission]
hash = 85063a9b
this = ref ResourceZero

[TextureOverrideCoating]
hash = 67d578ae
this = ref ResourceZero
'''
        mod = self.root/'mod'; (mod/'Textures').mkdir(parents=True); (mod/'mod.ini').write_text(ini)
        (mod/'Textures/zero.dds').write_bytes(dds(2, 2, 28, fill=0))
        report = import_outfit.import_outfit(package.root, mod, self.root/'out')
        self.assertEqual(report['textures'], [dict(index=0, file='Textures/zero.dds', meshes=[CLOTH], resource='_ClearCoatMask',
                                                   resources=['_ClearCoatMask', '_EmissionMap'])])
        self.assertIn('format_changed:Textures/zero.dds', report['warnings'])
        *_, source, _, _ = self.staged(self.root/'out')
        [clone] = [d for d in source['draws'] if d['mesh'] == 'outfit:'+report['appearance']['id']+'/'+CLOTH]
        replaced = {r['names'][0]: r for r in clone['resources']}
        for name in ('_ClearCoatMask', '_EmissionMap'):
            self.assertEqual((replaced[name]['sha256'], replaced[name]['texture']['rd_format_name']),
                             (hashlib.sha256(bytes(16)).hexdigest(), 'R8G8B8A8_UNORM'))

    def test_a_filter_slot_replaces_the_template_texture_of_the_nearest_dhash(self):
        # By format and shape alone new.dds could be _ClearCoatMask or _MetallicGlossMap.
        mod = cloth_mod(self.root/'mod', FILTER_DRAW, {'Textures/new.dds': dds(8, 8, 98)}, filter_sections(template_dhash('BC7_UNORM_BLOCK', 5)))
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        self.assertEqual(report['textures'], [dict(index=0, file='Textures/new.dds', meshes=[CLOTH], resource='_ClearCoatMask')])

    def test_a_filter_replaces_every_template_texture_at_the_least_distance(self):
        package = package_fixture(self.root/'two', cloth_extra=[('_DetailMask', 'BC7_UNORM_BLOCK', False, 34), ('_OcclusionMap', 'BC7_UNORM_BLOCK', False, 107)])
        a, b = template_dhash('BC7_UNORM_BLOCK', 34), template_dhash('BC7_UNORM_BLOCK', 107)
        between = a ^ ((a ^ b) & -(a ^ b))
        self.assertEqual((texture_dhash.distance(between, a), texture_dhash.distance(between, b)), (1, 1))
        mod = cloth_mod(self.root/'mod', FILTER_DRAW, {'Textures/new.dds': dds(4, 4, 98)}, filter_sections(between))
        report = import_outfit.import_outfit(package.root, mod, self.root/'out')
        self.assertEqual(report['textures'], [dict(index=0, file='Textures/new.dds', meshes=[CLOTH], resource='_DetailMask',
                                                   resources=['_DetailMask', '_OcclusionMap'])])
        *_, source, _, _ = self.staged(self.root/'out')
        [clone] = [d for d in source['draws'] if d['mesh'] == 'outfit:'+report['appearance']['id']+'/'+CLOTH]
        replaced = {r['names'][0]: r['sha256'] for r in clone['resources']}
        self.assertEqual({replaced['_DetailMask'], replaced['_OcclusionMap']}, {hashlib.sha256(dds(4, 4, 98)[148:]).hexdigest()})

    def test_a_filter_s_match_format_leaves_out_a_nearer_texture_of_another_format(self):
        # The filter's dHash is _BaseMap's; of the BC7_UNORM textures _ClearCoatMask is the nearest.
        sections = filter_sections(template_dhash('BC7_SRGB_BLOCK', 7), match_format='DXGI_FORMAT_BC7_UNORM')
        report = import_outfit.import_outfit(self.package.root, cloth_mod(self.root/'mod', FILTER_DRAW, {'Textures/new.dds': dds(8, 8, 99)}, sections),
                                             self.root/'out')
        self.assertEqual(report['textures'], [dict(index=0, file='Textures/new.dds', meshes=[CLOTH], resource='_ClearCoatMask')])
        self.assertIn('format_changed:Textures/new.dds', report['warnings'])

    def test_a_filter_that_matches_no_texture_falls_back_to_the_hash_in_the_file_name(self):
        # 67d578ae is 3DMigoto's hash of _ClearCoatMask, the template texture farthest from the filter's dHash.
        far = ~template_dhash('BC7_UNORM_BLOCK', 5) & (2**64-1)
        file = 'Textures/Components-0 t=67d578ae BC7-Linear.dds'
        mod = cloth_mod(self.root/'mod', FILTER_DRAW, {file: dds(8, 8, 98)}, filter_sections(far, file))
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        self.assertEqual(report['textures'], [dict(index=0, file=file, meshes=[CLOTH], resource='_ClearCoatMask')])

    def test_a_filter_whose_dhash_and_file_name_hash_name_no_texture_leaves_its_file_unbound(self):
        far = ~template_dhash('BC7_UNORM_BLOCK', 5) & (2**64-1)
        file = 'Textures/Components-0 t=11111111 BC7-Linear.dds'
        draw = 'ps-t17 = ResourceBase\n'+FILTER_DRAW
        sections = filter_sections(far, file)+'\n[ResourceBase]\nfilename = Textures/base.dds\n'
        mod = cloth_mod(self.root/'none', draw, {file: dds(8, 8, 98), 'Textures/base.dds': dds(8, 8, 99)}, sections)
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out-none')
        self.assertEqual({t['file']: t['resource'] for t in report['textures']}, {file: None, 'Textures/base.dds': '_BaseMap'})
        self.assertIn('texture_unbound:'+file, report['warnings'])

    def test_a_this_texture_no_texture_check_binds_is_placed_nowhere(self):
        file = 'Textures/Components-0 t=1234abcd BC5-Linear.dds'
        draw = 'ps-t17 = ResourceBase\ndrawindexedinstanced = 6,INSTANCE_COUNT,0,0,FIRST_INSTANCE'
        sections = this_sections('1234abcd').replace('BC7-Linear', 'BC5-Linear')+'\n[ResourceBase]\nfilename = Textures/base.dds\n'
        mod = cloth_mod(self.root/'mod', draw, {file: dds(8, 8, fourcc=b'ATI2'), 'Textures/base.dds': dds(8, 8, 99)}, sections)
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        self.assertEqual(report['textures'], [dict(index=0, file='Textures/base.dds', meshes=[CLOTH], resource='_BaseMap')])
        self.assertIn('texture_unbound:'+file, report['warnings'])

    def test_a_table_named_slot_takes_a_file_of_another_format_with_a_warning(self):
        draw = 'ps-t18 = ResourceNew\ndrawindexedinstanced = 6,INSTANCE_COUNT,0,0,FIRST_INSTANCE'
        hints = {'fixture': {'M_cloth': {'ps-t18': '_MetallicGlossMap'}}}
        carrying = package_fixture(self.root/'carrying', tables={import_outfit.HINTS_FILE: dict(schema=import_outfit.HINTS_SCHEMA, characters=hints)})
        mod = cloth_mod(self.root/'mod', draw, {'Textures/new.dds': dds(4, 4, 99)}, '\n[ResourceNew]\nfilename = Textures/new.dds\n')
        report = import_outfit.import_outfit(carrying.root, mod, self.root/'out-hinted')
        self.assertEqual(report['textures'], [dict(index=0, file='Textures/new.dds', meshes=[CLOTH], resource='_MetallicGlossMap')])
        self.assertIn('format_changed:Textures/new.dds', report['warnings'])
        # A mapping, too, may put a file of another color space in place.
        report, _ = self.si_import(textures={'1': '_BaseMap'})
        self.assertEqual(report['textures'][1]['resource'], '_BaseMap')
        self.assertIn('format_changed:Textures/L.Dds', report['warnings'])

    def test_a_resource_s_color_space_sets_the_format_its_file_is_read_in(self):
        draw = 'ps-t17 = ResourceNew\ndrawindexedinstanced = 6,INSTANCE_COUNT,0,0,FIRST_INSTANCE'
        sections = '\n[ResourceNew]\nfilename = Textures/new.dds\ncolor_space = sRGB\n'
        report = import_outfit.import_outfit(self.package.root, cloth_mod(self.root/'mod', draw, {'Textures/new.dds': dds(8, 8, 98)}, sections), self.root/'out')
        self.assertEqual(report['textures'], [dict(index=0, file='Textures/new.dds', meshes=[CLOTH], resource='_BaseMap')])
        self.assertNotIn('format_changed:Textures/new.dds', report['warnings'])
        *_, source, _, _ = self.staged(self.root/'out')
        [clone] = [d for d in source['draws'] if d['mesh'] == 'outfit:'+report['appearance']['id']+'/'+CLOTH]
        base = next(r for r in clone['resources'] if r['names'] == ['_BaseMap'])
        self.assertEqual((base['sha256'], base['texture']['rd_format_name']), (hashlib.sha256(dds(8, 8, 98)[148:]).hexdigest(), 'BC7_SRGB_BLOCK'))

    def test_rabbitfx_slots_place_by_the_semantics_its_shaders_read_them_as(self):
        draw = 'ps-t70 = ResourceD\nps-t71 = ResourceL\nps-t72 = ResourceN\ndrawindexedinstanced = 6,INSTANCE_COUNT,0,0,FIRST_INSTANCE'
        sections = '\n[ResourceD]\nfilename = Textures/d.dds\n\n[ResourceL]\nfilename = Textures/l.dds\n\n[ResourceN]\nfilename = Textures/n.dds\n'
        files = {'Textures/d.dds': dds(8, 8, 99), 'Textures/l.dds': dds(8, 8, 98), 'Textures/n.dds': dds(8, 8, fourcc=b'ATI2')}
        hints = {'fixture': {'M_cloth': {'diffusemap': '_BaseMap', 'lightmap': '_MetallicGlossMap', 'normalmap': '_BumpMap'}}}
        with mock.patch.object(import_outfit, 'slot_hints', lambda character, *pack: hints.get(character, {})):
            report = import_outfit.import_outfit(self.package.root, cloth_mod(self.root/'mod', draw, files, sections), self.root/'out')
        self.assertEqual([(t['file'], t['resource']) for t in report['textures']],
                         [('Textures/d.dds', '_BaseMap'), ('Textures/l.dds', '_MetallicGlossMap'), ('Textures/n.dds', '_BumpMap')])

    def test_the_file_of_the_template_size_takes_a_contested_resource_and_the_other_is_left_unbound(self):
        other, sized = 'Textures/Components-0 t=0000aaaa BC7-Linear.dds', 'Textures/Components-0 t=1111bbbb BC7-Linear.dds'
        draw = CHECKED_DRAW
        mod = cloth_mod(self.root/'mod', draw, {other: dds(8, 8, 99), sized: dds(4, 4, 99, fill=9)}, this_sections('0000aaaa', '1111bbbb'))
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        self.assertEqual(report['textures'], [dict(index=0, file=other, meshes=[CLOTH], resource=None),
                                              dict(index=1, file=sized, meshes=[CLOTH], resource='_BaseMap')])
        self.assertIn('texture_unbound:'+other, report['warnings'])
        # Both of the template's size: the mod gives no way to tell which one the resource is.
        mod = cloth_mod(self.root/'both', draw, {other: dds(4, 4, 99, fill=8), sized: dds(4, 4, 99, fill=9)}, this_sections('0000aaaa', '1111bbbb'))
        with self.assertRaises(ValueError) as caught:import_outfit.import_outfit(self.package.root, mod, self.root/'out-both')
        self.assertEqual(str(caught.exception), f'texture_mismatch:1:{sized}: candidates {CLOTH}: _BaseMap (taken)')

    def test_of_the_shape_rule_candidates_the_one_of_the_file_size_is_taken(self):
        package = package_fixture(self.root/'outline', cloth_extra=[('_OutlineMask', 'BC7_UNORM_BLOCK', False, 9, 8)])
        draw = CHECKED_DRAW
        file = 'Textures/Components-0 t=1234abcd BC7-Linear.dds'
        report = import_outfit.import_outfit(package.root, cloth_mod(self.root/'mod', draw, {file: dds(8, 8, 98)}, this_sections('1234abcd')), self.root/'out')
        self.assertEqual(report['textures'], [dict(index=0, file=file, meshes=[CLOTH], resource='_OutlineMask')])
        # _MetallicGlossMap and _ClearCoatMask are both of a 4x4 file's size.
        mod = cloth_mod(self.root/'small', draw, {file: dds(4, 4, 98, fill=3)}, this_sections('1234abcd'))
        with self.assertRaises(ValueError) as caught:import_outfit.import_outfit(package.root, mod, self.root/'out-small')
        self.assertEqual(str(caught.exception), f'texture_mismatch:0:{file}: candidates {CLOTH}: _ClearCoatMask, _MetallicGlossMap')

    def test_a_component_with_a_stale_hash_is_placed_by_its_own_index_buffer_then_by_its_positions(self):
        sections = '\n[Resource_IB]\ntype = Buffer\nformat = DXGI_FORMAT_R32_UINT\nstride = 4\nfilename = Meshes/IB.buf\n\n[ResourceNew]\nfilename = Textures/new.dds\n'
        mod = cloth_mod(self.root/'ib', 'ib = Resource_IB\nps-t17 = ResourceNew\ndrawindexed = 3, 0, 0', {'Textures/new.dds': dds(8, 8, 99)}, sections)
        (mod/'mod.ini').write_text((mod/'mod.ini').read_text().replace('hash = 40609654', 'hash = 0badc0de').replace(
            'match_index_count = 6', 'match_index_count = 3').replace('vb0 = Resource_Position\n', ''))
        (mod/'Meshes/IB.buf').write_bytes(struct.pack('<3I', 0, 1, 2))
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out-ib')
        self.assertEqual((report['components'][0]['mesh'], report['components'][0]['matched_by']), (BODY, 'index_buffer'))
        self.assertIn('stale_hash:TextureOverride_EntryPoint_LOD0.40609654_6_0', report['warnings'])
        # O1 and its twin share three positions; O1 holds all four.
        draw = 'ps-t17 = ResourceNew\ndrawindexedinstanced = 6,INSTANCE_COUNT,0,0,FIRST_INSTANCE'
        mod = cloth_mod(self.root/'vb0', draw, {'Textures/new.dds': dds(8, 8, 99)}, '\n[ResourceNew]\nfilename = Textures/new.dds\n')
        (mod/'mod.ini').write_text((mod/'mod.ini').read_text().replace('hash = 40609654', 'hash = 0badc0de'))
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        row = report['components'][0]
        self.assertEqual((row['mesh'], row['matched_by'], row['geometry'], row['action']), (CLOTH, 'positions', 'unmodified', 'textures'))
        self.assertEqual(report['textures'][0]['resource'], '_BaseMap')
        self.assertIn('stale_hash:TextureOverride_EntryPoint_LOD0.40609654_6_0', report['warnings'])

    def test_the_level_of_a_section_is_its_index_count_not_its_name(self):
        sections = '''
[TextureOverride_Component0_LOD0]
hash = 0badc0de
match_index_count = 9
$\\EFMIv1\\component_id = 0
run = CommandList_Draw

[TextureOverride_Component0]
hash = 0badf00d
match_index_count = 3
$\\EFMIv1\\component_id = 0
run = CommandList_Draw

[ResourceNew]
filename = Textures/new.dds
'''
        mod = cloth_mod(self.root/'mod', 'ps-t17 = ResourceNew\ndrawindexedinstanced = 6,INSTANCE_COUNT,0,0,FIRST_INSTANCE', {'Textures/new.dds': dds(8, 8, 99)}, sections)
        (mod/'mod.ini').write_text((mod/'mod.ini').read_text().replace('[TextureOverride_EntryPoint_LOD0.40609654_6_0]', '[TextureOverride_EntryPoint_LOD1_Component0]'))
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        self.assertEqual([(r['section'], r['action']) for r in report['components']],
                         [('TextureOverride_EntryPoint_LOD1_Component0', 'textures'), ('TextureOverride_Component0_LOD0', 'skipped_lod'),
                          ('TextureOverride_Component0', 'skipped_lod')])

    def test_a_mod_with_no_hash_and_no_position_of_the_character_is_not_this_character(self):
        mod = cloth_mod(self.root/'mod', 'drawindexedinstanced = 6,INSTANCE_COUNT,0,0,FIRST_INSTANCE', {})
        (mod/'mod.ini').write_text((mod/'mod.ini').read_text().replace('hash = 40609654', 'hash = 12345678'))
        (mod/'Meshes/Position.buf').write_bytes(b''.join(struct.pack('<3fI', 7, 7, i, 0) for i in range(4)))
        self.assertEqual(self.code(mod), 'not_this_character')

    def test_an_external_namespace_texture_is_placed_by_the_ib_hash_in_its_file_name(self):
        draw = 'Resource\\RabbitFx\\Diffuse = ref ResourceDiffuse\nResource\\RabbitFx\\NormalMap = ref ResourceStray\n' \
               'drawindexedinstanced = 6,INSTANCE_COUNT,0,0,FIRST_INSTANCE'
        sections = '\n[ResourceDiffuse]\nfilename = Textures/40609654-6-0-DiffuseMap.dds\n\n[ResourceStray]\nfilename = Textures/0badc0de-3-0-NormalMap.dds\n'
        mod = cloth_mod(self.root/'mod', draw, {'Textures/40609654-6-0-DiffuseMap.dds': dds(8, 8, 99),
                                                'Textures/0badc0de-3-0-NormalMap.dds': dds(4, 4, fourcc=b'ATI2')}, sections)
        report = import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        self.assertEqual(report['textures'], [dict(index=0, file='Textures/40609654-6-0-DiffuseMap.dds', meshes=[CLOTH], resource='_BaseMap')])
        self.assertIn('external_namespace:Textures/0badc0de-3-0-NormalMap.dds', report['warnings'])

    def test_a_mod_that_only_hides_is_nothing_to_import(self):
        draw = 'Resource\\RabbitFx\\Diffuse = ref ResourceOther\ndrawindexedinstanced = 6,INSTANCE_COUNT,0,0,FIRST_INSTANCE'
        sections = '\n[ResourceOther]\nfilename = Textures/other.dds\n\n[TextureOverrideHideFace]\nhash = 6504de68\nhandling = skip\n'
        mod = cloth_mod(self.root/'mod', draw, {'Textures/other.dds': dds(8, 8, 99)}, sections)
        with self.assertRaises(ValueError) as caught:import_outfit.import_outfit(self.package.root, mod, self.root/'out')
        self.assertEqual(str(caught.exception), f'nothing_to_import:只隐藏了组件 {BODY}，贴图都没套上')
        self.assertFalse((self.root/'out').exists())

    def test_the_slot_table_keys_by_program_and_semantics_by_shader_family(self):
        source = {'draws': [dict(mesh='a', material='Ma', stages=[dict(source_spirv='p/CharacterNPR/e1-slot1.spv')]),
                            dict(mesh='b', material='Mb', stages=[dict(source_spirv='p/CharacterNPR/e2-slot1.spv')]), dict(mesh='c', material='Mc')]}
        self.assertNotEqual(import_outfit.program(source, 'a'), import_outfit.program(source, 'b'))
        self.assertEqual([import_outfit.program(source, m, family=True) for m in 'abc'], [('CharacterNPR',), ('CharacterNPR',), ('Mc',)])

    def test_output_rules(self):
        mapping = write_map(self.root/'map.json', textures={'1': '_ClearCoatMask'})
        mod = si_mod(self.root/'si')
        import_outfit.import_outfit(self.package.root, mod, self.root/'out', mapping=mapping)
        with self.assertRaisesRegex(ValueError, 'output_already_exists'):import_outfit.import_outfit(self.package.root, mod, self.root/'out', mapping=mapping)
        with self.assertRaisesRegex(ValueError, 'output_inside_input_package'):
            import_outfit.import_outfit(self.package.root, mod, self.package.root/'new', mapping=mapping)
        self.assertEqual(Package(self.package.root).version, '1.0.0')

    def test_progress_reports_read_compose_and_write(self):
        calls = []
        import_outfit.import_outfit(self.package.root, si_mod(self.root/'si'), self.root/'out', mapping=write_map(self.root/'map.json', textures={'1': '_MetallicGlossMap'}),
                                    progress=lambda stage, fraction: calls.append((stage, fraction)))
        self.assertEqual(calls, [('read', 0), ('read', 1), ('compose', 0), ('compose', 1), ('write', 0), ('write', 1)])

    def test_the_inventories_equal_a_full_rehash(self):
        self.si_import(textures={'1': '_MetallicGlossMap'})
        out = self.root/'out'; runtime = out/'runtime'; definition = read_json(out/'character.json')
        files = [p for p in sorted(out.rglob('*')) if p.is_file() and p != out/'character.json']
        self.assertEqual(definition['inventory'], [import_outfit.ref(p, out) for p in files])
        native_path = out/definition['components']['render']['native_bundle']['file']
        self.assertEqual([{k: x[k] for k in ('file', 'sha256', 'byte_count')} for x in read_json(native_path)['files']],
                         [import_outfit.ref(p, runtime) for p in files if p.is_relative_to(runtime) and p != native_path])
        # Both kinds of file are there: ones still as cloned and ones the import wrote.
        source = [self.package.root/p.relative_to(out) for p in files]
        cloned = [s.is_file() and s.stat().st_mtime_ns == p.stat().st_mtime_ns for s, p in zip(source, files)]
        self.assertTrue(any(cloned) and not all(cloned))

    def test_main_prints_the_receipt(self):
        mapping = write_map(self.root/'map.json', textures={'1': '_ClearCoatMask'})
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            import_outfit.main(['--package', str(self.package.root), '--source', str(si_mod(self.root/'si')), '--output', str(self.root/'out'),
                                '--name', '水墨', '--map', str(mapping)])
        receipt = json.loads(out.getvalue())
        self.assertEqual((receipt['schema'], receipt['appearance']['name']), ('endfield-outfit-import/v1', '水墨'))

    def test_region_hash_is_crc32c_of_the_template_index_bytes(self):
        self.assertEqual('%08x' % import_outfit.crc32c(b'123456789'), 'e3069283')
        for indices, expected in (([0, 1, 2], O2_SUB0), ([2, 1, 3], O2_SUB1), ([0, 1, 2, 2, 1, 3], O1_HASH)):
            self.assertEqual('%08x' % import_outfit.crc32c(struct.pack(f'<{len(indices)}H', *indices)), expected)
        self.assertEqual('%08x' % import_outfit.crc32c(struct.pack('<3I', 0, 1, 2)), 'dd3bebfb')

    def test_module_stays_content_safe(self):
        text = (CHARACTERS/'agentic_complex_build/import_outfit.py').read_text()
        for word in ('sys.path', '__file__', 'presentation_candidate'):self.assertNotIn(word, text)
        self.assertEqual(import_outfit.LAYOUT['schema'], 'endfield-efmi-layout/v1')


if __name__ == '__main__':
    unittest.main()
