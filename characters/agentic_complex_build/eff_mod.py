"""Read an EFF (Endfield Framework) format 3 mod folder as data: its mod.ini, its .effres files and the Unity Mesh inside a mesh
.effres. Nothing in the mod is executed.

A failure is ValueError('<reason code>:<detail>'). Standard library only: this module ships in the app's content.
"""
from array import array
import configparser
from dataclasses import dataclass, field
import hashlib
from pathlib import Path
import struct
import sys

from .efmi_geometry import MAX_INDICES, MAX_VERTICES
from .efmi_mod import MAX_FILE_BYTES, checked_path

MAGIC = b'EFF_AUTHOR_FILE3'
# Magic, u32 version, u32 kind, u64 meta length, u64 payload length, sha256 of the meta.
HEADER = struct.Struct('<16s2I2Q32s')
KIND_MESH = 1
# A mesh payload: 128 bytes this reader does not interpret, then a Unity SerializedFile, then EFF's own `EFFMESH\0` data.
MESH_PREFIX = 128
SERIALIZED_VERSION = 22
MESH_CLASS = 43
# The offsets into Unity's built-in common string table that a Mesh typetree uses.
COMMON_STRINGS = {0: 'AABB', 49: 'Array', 55: 'Base', 76: 'bool', 81: 'char', 106: 'data', 161: 'float', 222: 'int', 245: 'Matrix4x4f',
                  427: 'm_Name', 795: 'size', 840: 'string', 894: 'TypelessData', 921: 'UInt64', 928: 'UInt8', 934: 'unsigned int',
                  981: 'vector', 997: 'Vector3f'}
PRIMITIVES = {'bool': 'B', 'char': 'B', 'UInt8': 'B', 'SInt8': 'b', 'short': 'h', 'SInt16': 'h', 'unsigned short': 'H', 'UInt16': 'H',
              'int': 'i', 'SInt32': 'i', 'unsigned int': 'I', 'UInt32': 'I', 'long long': 'q', 'SInt64': 'q',
              'unsigned long long': 'Q', 'UInt64': 'Q', 'FileSize': 'Q', 'float': 'f', 'double': 'd'}
ALIGN_FLAG = 0x4000
# Unity 2021 VertexFormat -> bytes per component.
VERTEX_FORMATS = {0: 4, 1: 2, 2: 1, 3: 1, 4: 2, 5: 2, 6: 1, 7: 1, 8: 2, 9: 2, 10: 4, 11: 4}
STREAM_ALIGN = 16


@dataclass
class Texture:
    name: str
    effres: Path
    dds: Path
    linear: bool


@dataclass
class Material:
    name: str
    effres: Path
    source_path: str
    source_asset: str
    # Material slot name (`_BaseMap`) -> Texture.
    textures: dict


@dataclass
class Part:
    name: str
    mesh_section: str
    mesh: Path
    material: Material | None
    visible: bool
    material_slot: int


@dataclass
class Replace:
    name: str
    target_asset: str
    target_path: str
    target_bundle: str
    parts: list
    skip: bool


@dataclass
class EffMod:
    root: Path
    id: str
    textures: dict = field(default_factory=dict)
    materials: dict = field(default_factory=dict)
    parts: dict = field(default_factory=dict)
    replaces: list = field(default_factory=list)
    controls_path: Path | None = None


@dataclass
class Channel:
    format: int
    # As serialized; its low 4 bits are the component count.
    dimension: int
    # vertex_count * components * component bytes, one vertex after another.
    data: bytes


@dataclass
class EffMesh:
    name: str
    vertex_count: int
    # Unity vertex channel number -> Channel, for each channel with components.
    channels: dict
    # Per submesh, an array('I') of its triangle list indices with its baseVertex added.
    submeshes: list
    bone_hashes: list
    # 16 floats per bone in the serialized order e00 e01 .. e33, row-major (e03 e13 e23 is the translation).
    bindposes: list
    root_bone_hash: int
    shape_count: int


def truth(value):
    return value.strip().lower() in ('1', 'true', 'yes', 'on')


def load_eff(root):
    """The sections of `root`/mod.ini with their references to each other resolved and their file paths checked."""
    root = Path(root).resolve()

    def file(name):
        path = checked_path(root, name.strip().replace('\\', '/'))
        if not path.is_file():raise ValueError('unsupported_mod:eff_file:'+name.strip())
        return path

    def key(s, name):
        if not (value := s.get(name, '').strip()):raise ValueError(f'unsupported_mod:eff_key:{s.name}.{name}')
        return value

    def section(table, name):
        if name.strip() not in table:raise ValueError('unsupported_mod:eff_reference:'+name.strip())
        return table[name.strip()]

    ini = configparser.ConfigParser(interpolation=None, strict=True, comment_prefixes=(';', '#'), inline_comment_prefixes=None)
    # Keys keep their case: a texture key names a material slot such as `_BaseMap`.
    ini.optionxform = str
    try:ini.read_string(file('mod.ini').read_text(encoding='utf-8-sig'))
    except configparser.Error as e:raise ValueError('unsupported_mod:eff_ini') from e
    mod = ini['Mod'] if ini.has_section('Mod') else {}
    if (version := mod.get('format', '').strip()) != '3':raise ValueError('unsupported_mod:eff_format:'+version)
    out = EffMod(root, mod.get('id', '').strip())
    names = ini.sections()
    meshes = {n: file(key(ini[n], 'path')) for n in names if n.startswith('Mesh_')}
    for n in names:
        s = ini[n]
        if n.startswith('Texture'):out.textures[n] = Texture(n, file(key(s, 'path')), file(key(s, 'dds')), truth(s.get('linear', '')))
    for n in names:
        s = ini[n]
        if n.startswith('Material'):
            textures = {k[len('texture.'):]: section(out.textures, v) for k, v in s.items() if k.startswith('texture.')}
            out.materials[n] = Material(n, file(key(s, 'path')), s.get('source.path', '').strip(), key(s, 'source.asset'), textures)
    for n in names:
        s = ini[n]
        if n.startswith('Part'):
            material = section(out.materials, s['material']) if s.get('material', '').strip() else None
            if not ((slot := s.get('material_slot', '0').strip()).isascii() and slot.isdigit()):raise ValueError(f'unsupported_mod:eff_key:{n}.material_slot')
            out.parts[n] = Part(n, key(s, 'mesh'), section(meshes, key(s, 'mesh')), material, truth(s.get('visible', 'true')), int(slot))
    for n in names:
        s = ini[n]
        if n.startswith('Replace'):
            parts = [section(out.parts, p) for p in s.get('parts', '').split(',') if p.strip()]
            out.replaces.append(Replace(n, key(s, 'target.asset'), s.get('target.path', '').strip(), s.get('target.bundle', '').strip(),
                                        parts, s.get('handling', '').strip().lower() == 'skip'))
    if ini.has_section('ResourceControls'):out.controls_path = file(key(ini['ResourceControls'], 'path'))
    return out


def read_effres(path):
    """(kind, meta, payload) of one .effres file."""
    path = Path(path)
    if path.stat().st_size > MAX_FILE_BYTES:raise ValueError('mod_too_large')
    raw = path.read_bytes()
    if len(raw) < HEADER.size:raise ValueError('unsupported_mod:eff_file:'+path.name)
    magic, version, kind, meta_len, payload_len, digest = HEADER.unpack_from(raw)
    if magic != MAGIC or version != 3 or HEADER.size+meta_len+payload_len != len(raw):raise ValueError('unsupported_mod:eff_file:'+path.name)
    meta = raw[HEADER.size:HEADER.size+meta_len]
    if hashlib.sha256(meta).digest() != digest:raise ValueError('unsupported_mod:eff_file:'+path.name)
    return kind, meta, raw[HEADER.size+meta_len:]


class Malformed(Exception):
    pass


class Reader:
    """Bounds-checked reads over buf[start:end]; `pos` is absolute, so alignment is to the start of `buf`."""

    def __init__(self, buf, start, end, endian):
        if not 0 <= start <= end <= len(buf):raise Malformed('range')
        self.buf, self.pos, self.end, self.endian = buf, start, end, endian

    def take(self, n):
        if n < 0 or self.pos+n > self.end:raise Malformed('truncated')
        self.pos += n
        return self.buf[self.pos-n:self.pos]

    def unpack(self, fmt):
        values = struct.unpack(self.endian+fmt, self.take(struct.calcsize(self.endian+fmt)))
        return values[0] if len(values) == 1 else values

    def cstring(self):
        stop = self.buf.find(b'\0', self.pos, self.end)
        if stop < 0:raise Malformed('truncated')
        text = self.take(stop-self.pos).decode('utf-8', 'replace'); self.take(1)
        return text

    def align(self):
        self.take(-self.pos % 4)


@dataclass
class Node:
    type: str
    name: str
    byte_size: int
    is_array: bool
    meta_flag: int
    children: list = field(default_factory=list)


def node_string(offset, strings):
    if offset & 0x80000000:
        if (offset & 0x7fffffff) not in COMMON_STRINGS:raise Malformed(f'common_string:{offset & 0x7fffffff}')
        return COMMON_STRINGS[offset & 0x7fffffff]
    return Reader(strings, offset, len(strings), '<').cstring()


def type_tree(rows, strings):
    """The root Node of a typetree's flat (level, flags, type offset, name offset, byte size, meta flag) rows."""
    if not rows or rows[0][0] != 0:raise Malformed('typetree')
    stack = []
    for level, flags, type_offset, name_offset, byte_size, meta_flag in rows:
        if level > len(stack) or (level == 0 and stack):raise Malformed('typetree')
        node = Node(node_string(type_offset, strings), node_string(name_offset, strings), byte_size, bool(flags & 1), meta_flag)
        del stack[level:]
        if stack:stack[-1].children.append(node)
        stack.append(node)
    return stack[0]


def mesh_object(sf):
    """The Mesh typetree root and a Reader over the one Mesh object of SerializedFile bytes `sf`."""
    head = Reader(sf, 0, len(sf), '>')
    _, _, version, _, endian, _, metadata_size, file_size, data_offset, _ = head.unpack('4IB3sIQQQ')
    if version != SERIALIZED_VERSION:raise Malformed(f'serialized_version:{version}')
    if endian not in (0, 1) or file_size > len(sf) or not head.pos+metadata_size <= data_offset <= file_size:raise Malformed('header')
    r = Reader(sf, head.pos, head.pos+metadata_size, '<>'[endian])
    r.cstring()
    _, enable_type_tree, type_count = r.unpack('iBi')
    if not enable_type_tree:raise Malformed('no_typetree')
    types = []
    for _ in range(max(0, type_count)):
        class_id, _, _ = r.unpack('iBh')
        r.take(32 if class_id == 114 else 16)
        node_count, strings_size = r.unpack('ii')
        if node_count < 0:raise Malformed('typetree')
        rows = [(level, flags, t, n, size, meta) for _, level, flags, t, n, size, _, meta, _ in
                struct.iter_unpack(r.endian+'HBBIIiiiQ', r.take(node_count*32))]
        strings = r.take(strings_size)
        r.take(4*max(0, r.unpack('i')))
        types.append((class_id, rows, strings))
    meshes = []
    for _ in range(max(0, r.unpack('i'))):
        r.align()
        _, byte_start, byte_size, type_index = r.unpack('qqIi')
        if not 0 <= type_index < len(types):raise Malformed('object_type')
        if types[type_index][0] == MESH_CLASS:meshes.append((byte_start, byte_size, type_index))
    if len(meshes) != 1:raise Malformed(f'mesh_count:{len(meshes)}')
    byte_start, byte_size, type_index = meshes[0]
    if byte_start < 0 or data_offset+byte_start+byte_size > file_size:raise Malformed('object_range')
    return type_tree(*types[type_index][1:]), Reader(sf, data_offset+byte_start, data_offset+byte_start+byte_size, r.endian)


def read_value(r, node):
    """One typetree node's value: a primitive, a dict of fields, a list, or bytes / an array for an array of primitives."""
    if node.is_array:value = read_array(r, node)
    elif len(node.children) == 1 and node.children[0].is_array:
        value = read_value(r, node.children[0])
        if node.type == 'string':value = value.decode('utf-8', 'replace')
    elif node.children:value = {c.name: read_value(r, c) for c in node.children}
    elif node.type in PRIMITIVES:
        if node.byte_size != struct.calcsize('<'+PRIMITIVES[node.type]):raise Malformed('primitive_size:'+node.type)
        value = r.unpack(PRIMITIVES[node.type])
    else:raise Malformed('type:'+node.type)
    if node.meta_flag & ALIGN_FLAG:r.align()
    return value


def read_array(r, node):
    if len(node.children) != 2:raise Malformed('array')
    count = read_value(r, node.children[0])
    item = node.children[1]
    if not isinstance(count, int) or not 0 <= count <= r.end-r.pos:raise Malformed('array_size')
    if not item.children and item.type in PRIMITIVES and not item.meta_flag & ALIGN_FLAG:
        code = PRIMITIVES[item.type]
        if code == 'B':return bytes(r.take(count))
        if item.byte_size != struct.calcsize('<'+code) or array(code).itemsize != item.byte_size:raise Malformed('primitive_size:'+item.type)
        values = array(code, r.take(count*item.byte_size))
        if r.endian == '>':values.byteswap()
        return values
    return [read_value(r, item) for _ in range(count)]


def vertex_channels(vertex_data):
    """Unity channel number -> Channel, de-interleaved from m_DataSize: streams in order, each `vertex_count * stride` bytes and
    padded to 16 bytes, a stream's stride the bytes of its channels."""
    count, data = vertex_data['m_VertexCount'], vertex_data['m_DataSize']
    used = {i: c for i, c in enumerate(vertex_data['m_Channels']) if c['dimension'] & 0xF}
    for c in used.values():
        if c['format'] not in VERTEX_FORMATS:raise Malformed(f'vertex_format:{c["format"]}')
    width = {i: VERTEX_FORMATS[c['format']]*(c['dimension'] & 0xF) for i, c in used.items()}
    strides = [0]*(1+max((c['stream'] for c in used.values()), default=-1))
    for i, c in used.items():strides[c['stream']] += width[i]
    starts, offset = [], 0
    for stride in strides:
        starts.append(offset); offset += count*stride
        if offset > len(data):raise Malformed('vertex_data')
        offset += -offset % STREAM_ALIGN
    out = {}
    for i, c in used.items():
        stride = strides[c['stream']]
        if c['offset']+width[i] > stride:raise Malformed('vertex_channel')
        first, packed = starts[c['stream']]+c['offset'], bytearray(count*width[i])
        # One strided slice per byte of the channel's vertex.
        for k in range(width[i]):packed[k::width[i]] = data[first+k:first+k+count*stride:stride]
        out[i] = Channel(c['format'], c['dimension'], bytes(packed))
    return out


def submesh_indices(mesh, vertex_count):
    if mesh['m_IndexFormat'] not in (0, 1):raise Malformed(f'index_format:{mesh["m_IndexFormat"]}')
    code, buffer = 'HI'[mesh['m_IndexFormat']], mesh['m_IndexBuffer']
    width = struct.calcsize('<'+code)
    out = []
    for s in mesh['m_SubMeshes']:
        if s['topology'] != 0:raise Malformed(f'topology:{s["topology"]}')
        if s['firstByte']+s['indexCount']*width > len(buffer):raise Malformed('index_range')
        indices = array(code, buffer[s['firstByte']:s['firstByte']+s['indexCount']*width])
        if sys.byteorder == 'big':indices.byteswap()
        if indices and not 0 <= min(indices)+s['baseVertex'] <= max(indices)+s['baseVertex'] < vertex_count:raise Malformed('index_range')
        out.append(array('I', indices) if not s['baseVertex'] else array('I', (i+s['baseVertex'] for i in indices)))
    return out


def read_mesh(path):
    path = Path(path)
    kind, _, payload = read_effres(path)
    if kind != KIND_MESH:raise ValueError('unsupported_mod:eff_file:'+path.name)
    try:
        root, r = mesh_object(payload[MESH_PREFIX:])
        mesh = read_value(r, root)
        if r.pos != r.end:raise Malformed('object_size')
        vertex_data = mesh['m_VertexData']
        if mesh['m_StreamData']['size']:raise Malformed('stream_data')
        if vertex_data['m_VertexCount'] > MAX_VERTICES or sum(s['indexCount'] for s in mesh['m_SubMeshes']) > MAX_INDICES:
            raise ValueError('geometry_too_large:'+path.name)
        channels = vertex_channels(vertex_data)
        submeshes = submesh_indices(mesh, vertex_data['m_VertexCount'])
        return EffMesh(mesh['m_Name'], vertex_data['m_VertexCount'], channels, submeshes, list(mesh['m_BoneNameHashes']),
                       [list(m.values()) for m in mesh['m_BindPose']], mesh['m_RootBoneNameHash'], len(mesh['m_Shapes']['shapes']))
    except Malformed as e:raise ValueError(f'unsupported_mod:eff_mesh:{path.name}:{e}') from None
    except (KeyError, TypeError) as e:raise ValueError(f'unsupported_mod:eff_mesh:{path.name}:field:{e}') from None
