#!/usr/bin/env python3
"""The one definition of the Windows frame table (d3d11/frame.bin of a character directory, magic EFWPKG01).

d3d11/frame.bin is little-endian: a Header, then every table in TABLES order. Each
record is packed (no padding); the Header holds every table's byte offset and
record count. Strings live in the `strings` table (NUL-terminated UTF-8, for
logs only) and are referenced by byte offset. Index fields hold NONE where
there is no referent. The same struct list generates the Python layouts the
writer packs and private/renderer/windows/package_format.h for the C++ reader:
  --write-header <path>   write the C++ header
  --check-header <path>   exit 1 when <path> differs from the generated header
"""
import argparse
from pathlib import Path
import re
import struct
import sys

MAGIC = b'EFWPKG01'
VERSION = 4
NONE = 0xFFFFFFFF

# type -> (struct code, C++ type)
TYPES = {'u8': ('B', 'uint8_t'), 'u32': ('I', 'uint32_t'), 'i32': ('i', 'int32_t'), 'f32': ('f', 'float'), 'u64': ('Q', 'uint64_t')}


class Struct:
    """One packed record: fields are (name, type, count); count > 1 is an array."""
    def __init__(self, name, spec):
        self.name = name; self.fields = []
        for item in spec.split():
            field, kind = item.split(':')
            count = 1
            if '[' in kind:kind, n = kind[:-1].split('['); count = int(n)
            self.fields.append((field, kind, count))
        self.format = '<'+''.join((str(c) if c > 1 else '')+TYPES[k][0] for _, k, c in self.fields)
        self.size = struct.calcsize(self.format)

    def defaults(self):
        return {f: (bytes(c) if k == 'u8' else [0]*c) if c > 1 else 0 for f, k, c in self.fields}

    def pack(self, record):
        unknown = set(record)-{f for f, _, _ in self.fields}
        if unknown:raise KeyError('%s has no field %s' % (self.name, ', '.join(sorted(unknown))))
        values = []
        for f, k, c in self.fields:
            v = record.get(f, bytes(c) if k == 'u8' and c > 1 else [0]*c if c > 1 else 0)
            if c > 1:
                v = list(v)
                if len(v) != c:raise ValueError('%s.%s needs %d values' % (self.name, f, c))
                values += v
            else:values.append(v)
        return struct.pack(self.format, *values)

    def unpack(self, data, offset=0):
        flat = list(struct.unpack_from(self.format, data, offset)); out = {}
        for f, k, c in self.fields:
            if c > 1:out[f] = bytes(flat[:c]) if k == 'u8' else flat[:c]; del flat[:c]
            else:out[f] = flat.pop(0)
        return out


# Tables in file order. `strings` is raw bytes (count = byte length).
TABLES = ['strings', 'blobs', 'targets', 'textures', 'subresources', 'programs', 'program_bindings', 'input_layouts', 'input_elements',
          'samplers', 'blend_states', 'depth_stencil_states', 'rasterizer_states', 'passes', 'color_attachments', 'pass_reads',
          'draws', 'vertex_buffers', 'bindings', 'dynamic_addresses', 'producers', 'actors']

STRUCTS = {
    'Header': Struct('Header', 'magic:u8[8] version:u32 header_bytes:u32 file_bytes:u32 width:u32 height:u32 output_target:u32 character:u32 '
                     'scene_sha256:u8[32] manifest_sha256:u8[32] d3d11_library_sha256:u8[32] library_revision:u8[32] '
                     + ' '.join('%s_offset:u32 %s_count:u32' % (t, t) for t in TABLES)),
    # `file` names the blob by its path in the character directory (blob_name_ok); C++ checks SHA-256 and size on load.
    'Blob': Struct('Blob', 'sha256:u8[32] size:u64 file:u32'),
    'Target': Struct('Target', 'name:u32 width:u32 height:u32 texture_format:u32 view_format:u32 srv_format:u32 bind_flags:u32 is_depth:u32 has_stencil:u32'),
    'Texture': Struct('Texture', 'name:u32 dimension:u32 width:u32 height:u32 depth:u32 mip_count:u32 array_size:u32 format:u32 misc_flags:u32 '
                      'blob:u32 first_subresource:u32 subresource_count:u32'),
    # D3D11 subresource order: mip + face * mip_count.
    'Subresource': Struct('Subresource', 'offset:u32 row_pitch:u32 slice_pitch:u32 byte_count:u32'),
    'Program': Struct('Program', 'stage:u32 dxbc_blob:u32 first_binding:u32 binding_count:u32 name:u32'),
    'ProgramBinding': Struct('ProgramBinding', 'register_class:u32 slot:u32 kind:u32 stride:u32 cb_bytes:u32 name:u32'),
    'InputLayout': Struct('InputLayout', 'program:u32 first_element:u32 element_count:u32'),
    'InputElement': Struct('InputElement', 'semantic_name:u32 semantic_index:u32 format:u32 input_slot:u32 aligned_byte_offset:u32'),
    'Sampler': Struct('Sampler', 'filter:u32 address_u:u32 address_v:u32 address_w:u32 mip_lod_bias:f32 max_anisotropy:u32 comparison_func:u32 '
                      'border_color:f32[4] min_lod:f32 max_lod:f32'),
    # D3D11_BLEND_DESC; arrays index RenderTarget[0..7].
    'BlendState': Struct('BlendState', 'alpha_to_coverage_enable:u32 independent_blend_enable:u32 blend_enable:u32[8] src_blend:u32[8] dest_blend:u32[8] '
                         'blend_op:u32[8] src_blend_alpha:u32[8] dest_blend_alpha:u32[8] blend_op_alpha:u32[8] render_target_write_mask:u32[8]'),
    'DepthStencilState': Struct('DepthStencilState', 'depth_enable:u32 depth_write_mask:u32 depth_func:u32 stencil_enable:u32 stencil_read_mask:u32 '
                                'stencil_write_mask:u32 front_fail_op:u32 front_depth_fail_op:u32 front_pass_op:u32 front_func:u32 '
                                'back_fail_op:u32 back_depth_fail_op:u32 back_pass_op:u32 back_func:u32 stencil_ref:u32'),
    'RasterizerState': Struct('RasterizerState', 'fill_mode:u32 cull_mode:u32 front_counter_clockwise:u32 depth_bias:i32 depth_bias_clamp:f32 '
                              'slope_scaled_depth_bias:f32 depth_clip_enable:u32 scissor_enable:u32 multisample_enable:u32 antialiased_line_enable:u32'),
    # The DSV is depth_target (or stencil_target where the pass has no depth); both name the same target when both exist.
    'Pass': Struct('Pass', 'name:u32 phase:u32 kind:u32 first_color:u32 color_count:u32 depth_target:u32 depth_load:u32 depth_store:u32 depth_clear:f32 '
                   'stencil_target:u32 stencil_load:u32 stencil_store:u32 stencil_clear:u32 first_read:u32 read_count:u32 has_viewport:u32 '
                   'viewport:f32[4] first_draw:u32 draw_count:u32'),
    'ColorAttachment': Struct('ColorAttachment', 'target:u32 load:u32 store:u32 clear:f32[4]'),
    'PassRead': Struct('PassRead', 'source:u32 index:u32'),
    # Input slot i of the draw's layout reads vertex buffer first_vertex_buffer + i, offset 0. `mesh` (here and in
    # DynamicAddress) is the string offset of the mesh name; source_draw is the source manifest draw, -1 for none.
    'Draw': Struct('Draw', 'kind:u32 vs_program:u32 ps_program:u32 input_layout:u32 first_vertex_buffer:u32 vertex_buffer_count:u32 index_blob:u32 '
                   'index_format:u32 index_count:u32 vertex_count:u32 blend_state:u32 depth_stencil_state:u32 rasterizer_state:u32 mesh:u32 '
                   'source_draw:i32 first_binding:u32 binding_count:u32'),
    'VertexBuffer': Struct('VertexBuffer', 'blob:u32 stride:u32 byte_count:u32'),
    'Binding': Struct('Binding', 'stage:u32 register_class:u32 slot:u32 source:u32 index:u32'),
    # A buffer the C++ uploads each frame (DYNAMIC, Map WRITE_DISCARD), starting from default_blob.
    'DynamicAddress': Struct('DynamicAddress', 'pass:u32 draw_kind:u32 draw_index:u32 category:u32 set:u32 binding:u32 byte_count:u32 byte_width:u32 '
                             'default_blob:u32 semantics:u32 mesh:u32 post_role:u32 bind_flags:u32 misc_flags:u32 structure_byte_stride:u32 '
                             'srv_format:u32 srv_num_elements:u32 srv_flags:u32 name:u32'),
    # One producer input per record, by ProducerKind (windows_reference_producers.py producer_records): the field use
    # and the `values` layout of each kind are listed there.
    'Producer': Struct('Producer', 'kind:u32 name:u32 index:u32 node:u32 blob:u32 count:u32 values:f32[16]'),
    # Actor data by ActorKind (windows_actor_export.py actor_records); flags are ActorFlag bits, blobs index `blobs`.
    # appearance: name the C3 id, index its ordinal (0 the default), first/parent/node the strings of its display name, kind
    # and desc (NONE when the pack gives none). A mesh's clip_visibility table (aux_blob, u32 clip ordinals) holds clips only;
    # with appearance_gate its oracle_blob lists the u32 appearance ordinals it is drawn in, without it every appearance.
    # face_control, face_delta and vowel are optional (a package without them keeps the mouth closed): a face_control (name,
    # index its ordinal, first/count its face_delta records), each face_delta (parent the control ordinal, node the rig node,
    # values the position, Maya Euler degree and scale deltas, then the bone's neutral Euler), then vowel records a, i, u, e, o
    # (index the ordinal, blob the u32 control ordinal and f32 weight of each row of its pose, NONE for none).
    # clip: blob the key file as the actor archive stores it, EFKEY002 (codec 0 or 1, aux_blob u8 pre/post wrap per curve) or,
    # with efkey001, EFKEY001 (aux_blob per curve u16 node, u8 attribute, u8 component, u8 pre wrap, u8 post wrap, 2 zero bytes,
    # u32 key count, u32 byte offset); values length, frame rate. A time window of another clip has parent the source clip
    # ordinal, blob and aux_blob NONE, values[2..3] the source time range. oracle_blob NONE and count 0 for a clip without oracle.
    'Actor':Struct('Actor', 'kind:u32 name:u32 index:u32 parent:u32 node:u32 blob:u32 aux_blob:u32 oracle_blob:u32 first:u32 count:u32 '
                    'flags:u32 values:f32[16]'),
    # frame.bin (fixture-f60/, producer-golden/<case>/): FrameHeader, FrameEntry per dynamic address, visible source draw
    # indices (u32), then the 16-aligned byte data the entries point into (offsets from the file start).
    'FrameHeader': Struct('FrameHeader', 'magic:u8[8] version:u32 frame_index:u32 address_count:u32 visible_draw_count:u32 package_sha256:u8[32]'),
    'FrameEntry': Struct('FrameEntry', 'offset:u32 byte_count:u32'),
}
FRAME_MAGIC = b'EFWFRM01'
TABLE_STRUCTS = {'blobs': 'Blob', 'targets': 'Target', 'textures': 'Texture', 'subresources': 'Subresource', 'programs': 'Program',
                 'program_bindings': 'ProgramBinding', 'input_layouts': 'InputLayout', 'input_elements': 'InputElement', 'samplers': 'Sampler',
                 'blend_states': 'BlendState', 'depth_stencil_states': 'DepthStencilState', 'rasterizer_states': 'RasterizerState',
                 'passes': 'Pass', 'color_attachments': 'ColorAttachment', 'pass_reads': 'PassRead', 'draws': 'Draw',
                 'vertex_buffers': 'VertexBuffer', 'bindings': 'Binding', 'dynamic_addresses': 'DynamicAddress', 'producers': 'Producer', 'actors': 'Actor'}

# Enumerations written into the package; the C++ header carries the same values.
ENUMS = {
    'Stage': {'vertex': 0, 'pixel': 1},
    'RegisterClass': {'b': 0, 't': 1, 's': 2},
    'BindingKind': {'cb': 0, 'structured': 1, 'raw': 2, 'tex2d': 3, 'tex3d': 4, 'cube': 5, 'tex2darray': 6, 'sampler': 7},
    'TextureDimension': {'2D': 0, '3D': 1, 'Cube': 2, '2DArray': 3},
    'PassKind': {'render': 0, 'depth_copy': 1, 'premultiply': 2, 'coverage_split': 3, 'max_edges': 4, 'unpremultiply': 5,
                 'linearize_post': 6, 'downsample_l1': 7, 'clear_only': 8, 'downsample_add': 9},
    'Load': {'dontCare': 0, 'load': 1, 'clear': 2},
    'Store': {'dontCare': 0, 'store': 1},
    'ReadSource': {'target': 0, 'texture': 1},
    'DrawKind': {'source': 0, 'auxiliary': 1, 'fullscreen': 2, 'product': 3},
    'BindingSource': {'static_blob': 0, 'dynamic': 1, 'target': 2, 'texture': 3, 'sampler': 4},
    'Category': {'ubos': 0, 'ssbos': 1},
    'Semantic': {'Transform': 1, 'Global': 2, 'PerDraw': 4, 'Skin': 8, 'ShadowVB': 16, 'ShadowData': 32, 'LightData': 64, 'Bins': 128,
                 'PerMaterial': 256, 'PerPass': 512},
    'PostRole': {'none': 0, 'cameraGlobal': 1, 'apply': 2, 'grading': 3, 'apply_black': 4},
    'ProducerKind': {'convention': 0, 'camera_endpoint': 1, 'camera_settings': 2, 'key_light': 3, 'point_light': 4, 'face_light': 5,
                     'environment': 6, 'shadow': 7, 'shadow_sphere': 8, 'bins': 9, 'post_look': 10, 'time': 11, 'constant': 12},
    'MaterialResponse': {'authored': 0, 'irradiance_sh': 1, 'neutral_diagnostic': 2},
    'ToneMapping': {'aces_modified': 0},
    'ActorKind': {'rig_node': 0, 'mesh': 1, 'bone': 2, 'clip': 3, 'oracle_sample': 4, 'head': 5, 'appearance': 6, 'face_control': 7,
                  'face_delta': 8, 'vowel': 9},
    # scene: a mesh of a 3D stage (palette `scene`), drawn only where the renderer shows that stage. particle: a mesh the
    # palette contract drives per particle (`particle_palette`); without a particle runtime it is never drawn.
    'ActorFlag': {'has_source_id': 1, 'head_basis': 2, 'clip_visibility': 4, 'loop': 8, 'scene': 16, 'appearance_gate': 32, 'particle': 64,
                  'efkey001': 128},
}


def table_struct(name):return STRUCTS[TABLE_STRUCTS[name]]


SEGMENT = re.compile(r'[A-Za-z0-9._-]+')


def blob_name_ok(name):
    """A relative path that stays in the character directory: '/'-separated segments of [A-Za-z0-9._-], none '.' or '..'."""
    return all(SEGMENT.fullmatch(s) and s not in ('.', '..') for s in name.split('/'))


def enumerator(name):return 'k'+''.join(p[:1].upper()+p[1:] for p in name.split('_'))


def header_text():
    out = ['// Generated by characters/packaging/package_format.py --write-header; do not edit.',
           '// Windows frame table (d3d11/frame.bin): little-endian, packed records, tables in Header order.',
           '#ifndef EFW_PACKAGE_FORMAT_H', '#define EFW_PACKAGE_FORMAT_H', '', '#include <cstdint>', '', 'namespace efw {', '',
           'constexpr char kMagic[9] = "%s";' % MAGIC.decode(), 'constexpr char kFrameMagic[9] = "%s";' % FRAME_MAGIC.decode(),
           'constexpr uint32_t kVersion = %d;' % VERSION,
           'constexpr uint32_t kNone = 0x%08Xu;' % NONE, '']
    for enum, values in ENUMS.items():
        out.append('enum class %s : uint32_t {' % enum)
        out += ['    %s = %d,' % (enumerator(k), v) for k, v in values.items()]
        out += ['};', '']
    out += ['#pragma pack(push, 1)', '']
    for s in STRUCTS.values():
        out.append('struct %s {' % s.name)
        out += ['    %s %s%s;' % (TYPES[k][1], f, '[%d]' % c if c > 1 else '') for f, k, c in s.fields]
        out += ['};', 'static_assert(sizeof(%s) == %d, "%s layout");' % (s.name, s.size, s.name), '']
    out += ['#pragma pack(pop)', '', '}  // namespace efw', '', '#endif  // EFW_PACKAGE_FORMAT_H', '']
    return '\n'.join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument('--write-header', metavar='PATH')
    group.add_argument('--check-header', metavar='PATH')
    a = ap.parse_args(argv)
    if a.write_header:
        Path(a.write_header).parent.mkdir(parents=True, exist_ok=True); Path(a.write_header).write_text(header_text()); return 0
    path = Path(a.check_header)
    if not path.is_file() or path.read_text() != header_text():
        print('%s differs from the generated package format header' % path, file=sys.stderr); return 1
    print('%s matches the package format' % path); return 0


if __name__ == '__main__':sys.exit(main())
