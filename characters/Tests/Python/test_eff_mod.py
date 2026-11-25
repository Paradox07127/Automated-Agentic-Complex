"""Synthetic fixtures only: no byte of a user mod or of game data."""
import hashlib
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zlib

CHARACTERS = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(CHARACTERS)]
from agentic_complex_build import eff_mod

# Offsets of Unity's built-in common string table the fixture typetree uses; every other string is in its own buffer.
COMMON = {'AABB': 0, 'Array': 49, 'Base': 55, 'bool': 76, 'char': 81, 'data': 106, 'float': 161, 'int': 222, 'Matrix4x4f': 245,
          'm_Name': 427, 'size': 795, 'string': 840, 'TypelessData': 894, 'UInt64': 921, 'UInt8': 928, 'unsigned int': 934,
          'vector': 981, 'Vector3f': 997}
ALIGN = 0x4000
POSITIONS = [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.5)]
TBN = [0x11223344, 0x55667788, 0x99aabbcc]
UVS = [(0.0, 0.0), (1.0, 0.0), (0.25, 0.75)]
WEIGHTS = [(65535, 0, 0, 0), (32768, 32767, 0, 0), (0, 65535, 0, 0)]
BONE_INDICES = [(0, 0, 0, 0), (0, 1, 0, 0), (1, 0, 0, 0)]
BONES = [zlib.crc32(b'Root/a'), zlib.crc32(b'Root/a/b')]
# Row-major e00..e33; the second carries a translation in e03 e13 e23.
BINDPOSES = [[1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0],
             [1.0, 0.0, 0.0, 0.5, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0, 1.0, 2.0, 0.0, 0.0, 0.0, 1.0]]
ROOT_HASH = zlib.crc32(b'Root')


def array_of(item, meta=ALIGN):
    return ('Array', 'Array', -1, meta, True, [('int', 'size', 4, 0, False, []), item])


def leaf(type_, name, size, meta=0):
    return (type_, name, size, meta, False, [])


def struct_of(type_, name, *children, meta=0):
    return (type_, name, -1, meta, False, list(children))


def string(name):
    return struct_of('string', name, array_of(leaf('char', 'data', 1)))


def vector(name, item):
    return struct_of('vector', name, array_of(item))


U32 = lambda name: leaf('unsigned int', name, 4)
MESH_TREE = struct_of('Mesh', 'Base',
    string('m_Name'),
    vector('m_SubMeshes', struct_of('SubMesh', 'data', *map(U32, ('firstByte', 'indexCount')), leaf('int', 'topology', 4),
                                    *map(U32, ('baseVertex', 'firstVertex', 'vertexCount')))),
    struct_of('BlendShapeData', 'm_Shapes', vector('shapes', struct_of('MeshBlendShape', 'data', U32('firstVertex'), U32('vertexCount')))),
    vector('m_BindPose', struct_of('Matrix4x4f', 'data', *(leaf('float', f'e{r}{c}', 4) for r in range(4) for c in range(4)))),
    vector('m_BoneNameHashes', U32('data')),
    U32('m_RootBoneNameHash'),
    leaf('bool', 'm_IsReadable', 1, ALIGN),
    leaf('int', 'm_IndexFormat', 4),
    vector('m_IndexBuffer', leaf('UInt8', 'data', 1)),
    struct_of('VertexData', 'm_VertexData', U32('m_VertexCount'),
              vector('m_Channels', struct_of('ChannelInfo', 'data', *(leaf('UInt8', n, 1) for n in ('stream', 'offset', 'format', 'dimension')))),
              ('TypelessData', 'm_DataSize', -1, ALIGN, True, [leaf('int', 'size', 4), leaf('UInt8', 'data', 1)])),
    struct_of('StreamingInfo', 'm_StreamData', leaf('UInt64', 'offset', 8), U32('size'), string('path')))
BUNDLE_TREE = struct_of('AssetBundle', 'Base', string('m_Name'))


def type_tree(tree):
    """(nodes, string buffer) of a typetree as Unity 2021 stores it: 32-byte rows by depth, names in a buffer or the common table."""
    rows, strings = [], bytearray()
    def offset(text):
        if text in COMMON:return 0x80000000 | COMMON[text]
        at = strings.find(text.encode()+b'\0')
        if at < 0:at = len(strings); strings.extend(text.encode()+b'\0')
        return at
    def walk(node, level):
        type_, name, size, meta, is_array, children = node
        rows.append(struct.pack('<HBBIIiiiQ', 1, level, int(is_array), offset(type_), offset(name), size, len(rows), meta, 0))
        for c in children:walk(c, level+1)
    walk(tree, 0)
    return b''.join(rows), bytes(strings)


def aligned(data):
    return data+bytes(-len(data) % 4)


def sized(data):
    return aligned(struct.pack('<i', len(data))+data)


def vertex_data():
    """Channels 0 and 1 in stream 0, 4 in stream 1, 12 and 13 in stream 2; each stream padded to 16 bytes."""
    streams = [b''.join(struct.pack('<3fI', *p, t) for p, t in zip(POSITIONS, TBN)), b''.join(struct.pack('<2f', *uv) for uv in UVS),
               b''.join(struct.pack('<4H4B', *w, *i) for w, i in zip(WEIGHTS, BONE_INDICES))]
    data = b''.join(s+bytes(-len(s) % 16) for s in streams)
    channels = [(0, 0, 0, 0)]*14
    channels[0], channels[1], channels[4], channels[12], channels[13] = (0, 0, 0, 3), (0, 12, 0, 0x31), (1, 0, 0, 2), (2, 0, 4, 4), (2, 8, 6, 4)
    return channels, data


def mesh_object(index_format=0, indices=(7, 7, 0, 1, 2), first_byte=4, index_count=3):
    channels, data = vertex_data()
    code = 'HI'[index_format]
    out = sized(b'Cloth')
    out += struct.pack('<i6I', 1, first_byte, index_count, 0, 0, 0, len(POSITIONS))
    out += struct.pack('<i', 0)
    out += struct.pack('<i', len(BINDPOSES))+b''.join(struct.pack('<16f', *m) for m in BINDPOSES)
    out += struct.pack(f'<i{len(BONES)}I', len(BONES), *BONES)
    out += struct.pack('<I', ROOT_HASH)
    out += aligned(b'\1')
    out += struct.pack('<i', index_format)
    out += sized(struct.pack(f'<{len(indices)}{code}', *indices))
    out += struct.pack('<Ii', len(POSITIONS), len(channels))+b''.join(bytes(c) for c in channels)
    out += sized(data)
    out += struct.pack('<QI', 0, 0)+sized(b'')
    return out


def serialized_file(mesh=None):
    """A version-22 SerializedFile with an AssetBundle object and one Mesh object, little-endian metadata, typetrees on."""
    mesh = mesh_object() if mesh is None else mesh
    bundle = sized(b'bundle')
    meta = b'2021.3.34f5\0'+struct.pack('<iBi', 19, 1, 2)
    for class_id, tree in ((142, BUNDLE_TREE), (43, MESH_TREE)):
        nodes, strings = type_tree(tree)
        meta += struct.pack('<iBh', class_id, 0, -1)+bytes(16)+struct.pack('<ii', len(nodes)//32, len(strings))+nodes+strings
        meta += struct.pack('<i', 0)
    meta += struct.pack('<i', 2)
    for path_id, start, size, type_index in ((1, 0, len(bundle), 0), (2, len(bundle), len(mesh), 1)):
        meta += bytes(-(48+len(meta)) % 4)
        meta +=struct.pack('<qqIi', path_id, start, size, type_index)
    meta += struct.pack('<iii', 0, 0, 0)+b'\0'
    data_offset = 48+len(meta)+(-(48+len(meta)) % 16)
    file_size = data_offset+len(bundle)+len(mesh)
    header = struct.pack('>4IB3sIQQQ', 0, 0, 22, 0, 0, b'\0\0\0', len(meta), file_size, data_offset, 0)
    return (header+meta).ljust(data_offset, b'\0')+bundle+mesh


def effres(kind, meta=b'', payload=b''):
    return struct.pack('<16s2I2Q', b'EFF_AUTHOR_FILE3', 3, kind, len(meta), len(payload))+hashlib.sha256(meta).digest()+meta+payload


def mesh_effres(sf=None):
    return effres(1, b'\x1e\0\0\0\0\0\0\0EFF_AUTHOR_RESOURCE_METADATA/3', bytes(128)+(serialized_file() if sf is None else sf)+b'EFFMESH\0tail')


MOD_INI = """[Mod]
format=3
id=fixture_mod
key_switch_enabled=1

[Constants]

[TextureSkin]
path=textures/skin.effres
dds=textures/skin.dds

[TextureSkinNormal]
path=textures/skin_n.effres
dds=textures/skin_n.dds
linear=true

[MaterialBody]
path=materials/body.effres
source.path=assets/m_body.mat
source.asset=M_actor_test_body_01
texture._BaseMap=TextureSkin
texture._BumpMap=TextureSkinNormal

[Mesh_PartBody]
path=meshes/body.effres

[PartBody]
mesh=Mesh_PartBody
visible=true
material_slot=0
material=MaterialBody

[Mesh_PartExtra]
path=meshes/extra.effres

[PartExtra]
mesh=Mesh_PartExtra
visible=false
material_slot=1

[ReplaceBody]
target.path=assets/s_body_lod0.asset
target.asset=S_actor_test_body_01_lod0
target.bundle=bundles/windows/main/0.ab
parts=PartBody,PartExtra
lod.1.asset=S_actor_test_body_01_lod1

[ReplaceCloth]
target.asset=S_actor_test_cloth_01_lod0
handling=skip

[ResourceControls]
type=controls
path=controls.effres
"""


def mod_fixture(root, ini=MOD_INI):
    files = {'textures/skin.effres': effres(3), 'textures/skin.dds': b'DDS ', 'textures/skin_n.effres': effres(3),
             'textures/skin_n.dds': b'DDS ', 'materials/body.effres': effres(2, b'm', b'format=EFFMAT'),
             'meshes/body.effres': mesh_effres(), 'meshes/extra.effres': mesh_effres(), 'controls.effres': effres(6, b'c'),
             'mod.ini': ini.encode()}
    for name, data in files.items():
        (root/name).parent.mkdir(parents=True, exist_ok=True); (root/name).write_bytes(data)
    return root


class EffModTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name).resolve()
        self.root = mod_fixture(self.dir/'mod')

    def tearDown(self):
        self.tmp.cleanup()

    def test_load_eff_resolves_sections(self):
        mod = eff_mod.load_eff(self.root)
        self.assertEqual(mod.id, 'fixture_mod')
        self.assertEqual(sorted(mod.textures), ['TextureSkin', 'TextureSkinNormal'])
        self.assertEqual(mod.textures['TextureSkin'].dds, self.root/'textures/skin.dds')
        self.assertEqual([t.linear for t in mod.textures.values()], [False, True])
        body = mod.materials['MaterialBody']
        self.assertEqual(body.source_asset, 'M_actor_test_body_01')
        self.assertEqual({slot: t.name for slot, t in body.textures.items()}, {'_BaseMap': 'TextureSkin', '_BumpMap': 'TextureSkinNormal'})
        self.assertIs(mod.parts['PartBody'].material, body)
        self.assertEqual(mod.parts['PartBody'].mesh, self.root/'meshes/body.effres')
        self.assertIsNone(mod.parts['PartExtra'].material)
        self.assertEqual([(p.visible, p.material_slot) for p in mod.parts.values()], [(True, 0), (False, 1)])
        self.assertEqual([(r.name, r.target_asset, [p.name for p in r.parts], r.skip) for r in mod.replaces],
                         [('ReplaceBody', 'S_actor_test_body_01_lod0', ['PartBody', 'PartExtra'], False),
                          ('ReplaceCloth', 'S_actor_test_cloth_01_lod0', [], True)])
        self.assertEqual(mod.controls_path, self.root/'controls.effres')

    def test_read_effres(self):
        kind, meta, payload = eff_mod.read_effres(self.root/'materials/body.effres')
        self.assertEqual((kind, meta, payload), (2, b'm', b'format=EFFMAT'))

    def test_read_mesh(self):
        mesh = eff_mod.read_mesh(self.root/'meshes/body.effres')
        self.assertEqual((mesh.name, mesh.vertex_count, mesh.shape_count, mesh.root_bone_hash), ('Cloth', 3, 0, ROOT_HASH))
        self.assertEqual(sorted(mesh.channels), [0, 1, 4, 12, 13])
        self.assertEqual(mesh.channels[0].data, b''.join(struct.pack('<3f', *p) for p in POSITIONS))
        self.assertEqual((mesh.channels[1].dimension, mesh.channels[1].data), (0x31, struct.pack('<3I', *TBN)))
        self.assertEqual(mesh.channels[4].data, b''.join(struct.pack('<2f', *uv) for uv in UVS))
        self.assertEqual((mesh.channels[12].format, mesh.channels[12].data), (4, b''.join(struct.pack('<4H', *w) for w in WEIGHTS)))
        self.assertEqual((mesh.channels[13].format, mesh.channels[13].data), (6, b''.join(bytes(i) for i in BONE_INDICES)))
        self.assertEqual([list(s) for s in mesh.submeshes], [[0, 1, 2]])
        self.assertEqual(mesh.bone_hashes, BONES)
        self.assertEqual(mesh.bindposes, BINDPOSES)

    def test_read_mesh_u32_indices(self):
        (self.root/'meshes/body.effres').write_bytes(mesh_effres(serialized_file(mesh_object(1, (2, 1, 0), 0))))
        self.assertEqual([list(s) for s in eff_mod.read_mesh(self.root/'meshes/body.effres').submeshes], [[2, 1, 0]])

    def test_rejects_bad_magic(self):
        path = self.root/'meshes/body.effres'
        path.write_bytes(b'EFF_AUTHOR_FILE2'+path.read_bytes()[16:])
        with self.assertRaisesRegex(ValueError, r'^unsupported_mod:eff_file:body\.effres$'):eff_mod.read_effres(path)

    def test_rejects_other_version(self):
        path = self.root/'meshes/body.effres'
        raw = bytearray(path.read_bytes()); struct.pack_into('<I', raw, 16, 4); path.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, r'^unsupported_mod:eff_file:body\.effres$'):eff_mod.read_effres(path)

    def test_rejects_payload_past_end(self):
        path = self.root/'meshes/body.effres'
        raw = bytearray(path.read_bytes()); struct.pack_into('<Q', raw, 32, struct.unpack_from('<Q', raw, 32)[0]+1); path.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, r'^unsupported_mod:eff_file:body\.effres$'):eff_mod.read_effres(path)

    def test_rejects_meta_digest_mismatch(self):
        path = self.root/'meshes/body.effres'
        raw = bytearray(path.read_bytes()); raw[72] ^= 1; path.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, r'^unsupported_mod:eff_file:body\.effres$'):eff_mod.read_effres(path)

    def test_rejects_path_escaping_the_mod(self):
        (self.dir/'x.effres').write_bytes(mesh_effres())
        mod_fixture(self.root, MOD_INI.replace('path=meshes/extra.effres', 'path=../x.effres'))
        with self.assertRaisesRegex(ValueError, r'^unsafe_path$'):eff_mod.load_eff(self.root)

    def test_rejects_part_naming_a_missing_mesh(self):
        mod_fixture(self.root, MOD_INI.replace('mesh=Mesh_PartExtra', 'mesh=Mesh_PartGone'))
        with self.assertRaisesRegex(ValueError, r'^unsupported_mod:eff_reference:Mesh_PartGone$'):eff_mod.load_eff(self.root)

    def test_rejects_format_2(self):
        mod_fixture(self.root, MOD_INI.replace('format=3', 'format=2'))
        with self.assertRaisesRegex(ValueError, r'^unsupported_mod:eff_format:2$'):eff_mod.load_eff(self.root)


if __name__ == '__main__':
    unittest.main()
