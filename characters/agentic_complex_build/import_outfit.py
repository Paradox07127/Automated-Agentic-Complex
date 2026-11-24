#!/usr/bin/env python3
"""Import an EFMI mod as a new imported appearance of one character and emit a validated package.

Each mod component is matched to a template mesh by the CRC-32C of the mesh's index bytes, and drawn as efmi_mod evaluates
the mod's command lists at their defaults: a component that brings its own index and vertex buffers and differs from the
template replaces the draws of its submesh with its geometry (efmi_geometry), one draw per group of its segments, and every
other mesh that gets a mod texture is cloned with the template's own index and vertex bytes. The mod's switches become
interaction/mod-settings.json (mod_settings): the segments and texture variants the runtime switches. None of the mod's shaders or
scripts runs. The output is a NEW directory; the input package is never modified. Standard library only: this module ships in
the app's content.
"""
from pathlib import Path
import argparse
import dataclasses
from datetime import datetime, timezone
import json
import re
import shutil
import struct
import subprocess
import tempfile

import numpy as np

from character_library import Package, read_json, write_json, need
import native_bundle
import pool_codec
import vulkan_outfit
from .common import canonical_json, reference as ref, sha256_bytes, sha256_file
from . import efmi_geometry, efmi_mod, mod_settings, outfit_compose, texture_dhash

# skins-R1 LAYOUT.json (endfield-efmi-layout/v1) without its per-sample measurements and evidence pointers.
LAYOUT = {'schema': 'endfield-efmi-layout/v1',
          'date': '2026-11-15',
          'scope': 'skins-R1 samples A (si103) and B (maid) vs birch package persona-20261115; metadata only (no mesh/texture/ini '
                   'content).',
          'template_channels': {'0': [{'format': 'R32G32B32_SFLOAT', 'stride': 12}],
                                '1': [{'format': 'R32G32B32_SFLOAT', 'stride': 12}, {'format': 'R32_SFLOAT', 'stride': 4}],
                                '2': [{'format': 'R32G32B32A32_SFLOAT', 'stride': 16}],
                                '3': [{'format': 'R32G32B32A32_SFLOAT', 'stride': 16}],
                                '4': [{'format': 'R32G32_SFLOAT', 'stride': 8}],
                                '5': [{'format': 'R32G32B32A32_SFLOAT', 'stride': 16}, {'format': 'R32G32_SFLOAT', 'stride': 8}],
                                '6': [{'format': 'R32G32_SFLOAT', 'stride': 8}],
                                '8': [{'format': 'R32G32B32A32_SFLOAT', 'stride': 16}],
                                '9': [{'format': 'R32G32B32_SFLOAT', 'stride': 12}],
                                '10': [{'format': 'R32G32B32_SFLOAT', 'stride': 12}],
                                '11': [{'format': 'R32G32B32A32_SFLOAT', 'stride': 16}],
                                '12': [{'format': 'R32G32B32A32_SFLOAT', 'stride': 16}],
                                '13': [{'format': 'R32G32B32A32_UINT', 'stride': 16}]},
          'semantic_to_source_channel': [{'buffer': 'VB0',
                                          'semantic': 'POSITION0',
                                          'format': 'R32G32B32_FLOAT',
                                          'source_channel': 0,
                                          'convert': 'copy',
                                          'status': 'ok'},
                                         {'buffer': 'VB0',
                                          'semantic': 'ENCODEDDATA0',
                                          'format': 'R32_UINT',
                                          'source_channel': 1,
                                          'convert': 'copy_bits',
                                          'status': 'ok: normal+flag bits equal T9 ch1, tangent bits re-encoded (R1a Q4)'},
                                         {'buffer': 'VB0',
                                          'semantic': 'UNKNOWN0',
                                          'format': 'R8G8B8A8_UINT',
                                          'source_channel': None,
                                          'convert': 'use_original_channel_if_unmodified',
                                          'status': 'unresolved encoding (R1a Q4)'},
                                         {'buffer': 'VB0',
                                          'semantic': 'NORMAL0',
                                          'format': 'R32G32B32_FLOAT',
                                          'source_channel': 1,
                                          'convert': 'pack_octahedral_10_10_10_2',
                                          'status': 'not implemented'},
                                         {'buffer': 'VB1',
                                          'semantic': 'TEXCOORD0',
                                          'format': 'R32G32_FLOAT',
                                          'source_channel': 4,
                                          'convert': 'copy',
                                          'status': 'ok: no V flip'},
                                         {'buffer': 'VB1',
                                          'semantic': 'TEXCOORD1',
                                          'format': 'R32G32_FLOAT',
                                          'source_channel': 5,
                                          'convert': 'copy',
                                          'status': 'ok'},
                                         {'buffer': 'VB1',
                                          'semantic': 'UNKNOWN0',
                                          'format': 'R32G32_UINT',
                                          'source_channel': 5,
                                          'convert': 'use_original_channel_if_unmodified',
                                          'status': 'unresolved: all zero in B C0/C12'},
                                         {'buffer': 'VB1',
                                          'semantic': 'COLOR0',
                                          'format': 'R8G8B8A8_SNORM',
                                          'source_channel': 3,
                                          'convert': 'ignore',
                                          'status': 'unresolved: T9 has no ch3; template uses ch3 only in vfx materials'},
                                         {'buffer': 'VB1_LOD1',
                                          'semantic': 'TEXCOORD0',
                                          'format': 'R32G32_FLOAT',
                                          'source_channel': 4,
                                          'convert': 'lod1_only',
                                          'status': 'ignored for lod0'},
                                         {'buffer': 'VB1_LOD1',
                                          'semantic': 'TEXCOORD1',
                                          'format': 'R32G32_FLOAT',
                                          'source_channel': 5,
                                          'convert': 'lod1_only',
                                          'status': 'ignored for lod0'},
                                         {'buffer': 'VB1_LOD1',
                                          'semantic': 'TEXCOORD4',
                                          'format': 'R32G32_FLOAT',
                                          'source_channel': 8,
                                          'convert': 'lod1_only',
                                          'status': 'ignored for lod0'},
                                         {'buffer': 'VB2',
                                          'semantic': 'BLENDWEIGHTS0',
                                          'format': 'R16G16B16A16_UNORM',
                                          'source_channel': 12,
                                          'convert': 'unorm16_to_f32',
                                          'status': 'ok'},
                                         {'buffer': 'VB2',
                                          'semantic': 'BLENDWEIGHTS0',
                                          'format': 'R32G32B32A32_FLOAT',
                                          'source_channel': 12,
                                          'convert': 'copy',
                                          'status': 'cpu_posed component only'},
                                         {'buffer': 'VB2',
                                          'semantic': 'BLENDINDICES0',
                                          'format': 'R16G16B16A16_UINT',
                                          'source_channel': 13,
                                          'convert': 'merged_skeleton_remap_u16_to_u32',
                                          'status': 'ok (Q6)'},
                                         {'buffer': 'IB',
                                          'semantic': 'INDEX0',
                                          'format': 'R16_UINT',
                                          'source_channel': 'indices',
                                          'convert': 'copy_u16',
                                          'status': 'ok'},
                                         {'buffer': 'IB',
                                          'semantic': 'INDEX0',
                                          'format': 'R32_UINT',
                                          'source_channel': 'indices',
                                          'convert': 'copy_u32',
                                          'status': 'ok'}],
          'fill_rules': [{'channels': [2, 8, 9, 10, 11],
                          'rule': 'replicate the template constant from source/manifest.json missing_channels for the same (mesh, '
                                  'material, pass) to the mod vertex count',
                          'template_constants': [{'channel': 2, 'value': [0.0, 0.0, 0.0, 1], 'entries': 25},
                                                 {'channel': 6, 'value': [0.0, 0.0], 'entries': 1},
                                                 {'channel': 8, 'value': [0.0, 0.0, 0.0, 1], 'entries': 31},
                                                 {'channel': 9, 'value': [0.0, 0.0, 0.0], 'entries': 11},
                                                 {'channel': 10, 'value': [0.0, 0.0, 0.0], 'entries': 11},
                                                 {'channel': 11, 'value': [0.0, 0.0, 0.0, 1], 'entries': 3}]},
                         {'channels': [1],
                          'rule': 'VB0 ENCODEDDATA0 bits copied as-is; if the field is UNKNOWN0 (B C2/C8) or the component is unmodified, '
                                  'use the original channel01 buffer'},
                         {'channels': [12], 'rule': 'UNORM16/65535 -> float4; VB2 stride 8 (indices only) -> (1,0,0,0)'},
                         {'channels': [13], 'rule': 'merged-skeleton remap (mapping_rules.bone_index) then widen u16 -> u32'},
                         {'channels': [6], 'rule': 'unresolved: CharacterOutline uses generated channel6-f32.bin; generation not found'},
                         {'channels': [3], 'rule': 'unresolved: mod COLOR0 vs template constant (vfx materials only)'}],
          'mapping_rules': {'component_to_mesh': ['look up ib_hash in the region-hash table of all original Mesh submeshes',
                                                  'several hits: prefer most POSITION-equal vertices, then non-vfxpart (cloth_05/06/08/09 '
                                                  'share IB with vfxpart_03/01/04/02)',
                                                  'TextureOverride with empty draw list or Hide section -> hidden',
                                                  'cpu_posed components (B C15/C16, brow) are not drawn from mod buffers'],
                            'bone_index': ['g = BLENDINDICES value (merged skeleton id)',
                                           'find c with vg_offset[c] <= g < vg_offset[c]+vg_count[c] (ini '
                                           '$Pool_MergedSkeleton_Component_VertexGroupOffsets/Counts)',
                                           'bone = original mesh of c, bone l = g - vg_offset[c]; palette order == original m_BindPose '
                                           'order (verified 23/23 meshes)',
                                           'target index = position of that bone path in the target palette; append missing bones '
                                           '(bindpose from any palette mesh; cross-mesh max diff 2.5e-6)',
                                           'never use g - own vg_offset (naive): errors up to 1561 mm in a synthetic pose'],
                            'index_width': 'R16 or R32 per Components.buf / ini format; >65535 vertices (A cloth_01 86663, B C3 304571) '
                                           'need 32-bit indices'},
          'ib_hash': {'usable': True,
                      'algorithm': 'CRC-32C (Castagnoli, init 0) over m_IndexBuffer[firstByte : firstByte + 2*indexCount] of one submesh '
                                   '(raw u16 LE); no D3D11_BUFFER_DESC',
                      'hits': {'A': 20, 'B': 28},
                      'whole_buffer_plus_desc_hits': 0,
                      'caveats': ['identical IB in cloth_05/06/08/09 and vfxpart_03/01/04/02',
                                  'face/iris/eyeshadow/brow lod0 == lod1, cloth_09 lod1 == lod2',
                                  'A TextureOverrideSiFreePlayablePosition_* hashes are not IB hashes',
                                  'A LOD1 entries map to *_lod1 meshes that are not in our palette']},
          'textures': {'all_mips': 1,
                       'size_check': 'header-derived size == file size for 63/63',
                       'note': 'see R1b-mapping.md Q7 for per-file template resource names'}}
MAP_SCHEMA = 'endfield-outfit-map/v1'
VERTEX_STREAMS = ('ib', 'vb0', 'vb1', 'vb2', 'vb3')
# EFMI-Tools texture file names: `Components-<ids> t=<original texture hash> <format tag>.dds`.
TEXTURE_HASH = re.compile(r'\bt=([0-9a-f]{8})\b', re.IGNORECASE)
FORMAT_TAGS = {'bc7-srgb': 'BC7_SRGB_BLOCK', 'bc7-linear': 'BC7_UNORM_BLOCK', 'bc5-linear': 'BC5_UNORM_BLOCK'}
# A texture handed to another mod's namespace (RabbitFx): `<IB hash>-<index count>-<first index>-<semantic>Map.dds`.
EXTERNAL_NAME = re.compile(r'([0-9a-f]{8})-\d+-\d+-(diffuse|light|normal)map\.dds', re.IGNORECASE)
# The semantic a `this` texture's resource or file is named by (`Resource_Component4_LightMap`, `Components-4-8 Light.dds`).
SEMANTIC_NAME = re.compile(r'(?<![a-z])(diffuse|light|normal)(?:map)?(?![a-z])', re.IGNORECASE)
# The slots RabbitFX's rewritten character shaders read the material's maps from (its SetTextures: Diffuse, Lightmap, Normalmap).
RABBITFX_SLOTS = {'ps-t70': 'diffusemap', 'ps-t71': 'lightmap', 'ps-t72': 'normalmap'}
HINTS_FILE = 'efmi-slot-hints.json'
HINTS_SCHEMA = 'endfield-efmi-slot-hints/v1'
# The variables the mod's command lists are evaluated with: the game draws level 0.
LOD0 = {'$lod_level': 0}
DXGI_CODES = {name: code for code, name in efmi_mod.DXGI_FORMATS.items()}
# A filter's match_format (a DXGI name without DXGI_FORMAT_) -> rd_format_name.
DXGI_NAMES = {'BC7_UNORM': 'BC7_UNORM_BLOCK', 'BC7_UNORM_SRGB': 'BC7_SRGB_BLOCK', 'BC5_UNORM': 'BC5_UNORM_BLOCK', 'BC6H_UF16': 'BC6H_UFLOAT_BLOCK',
              'BC3_UNORM': 'BC3_UNORM_BLOCK', 'BC3_UNORM_SRGB': 'BC3_SRGB_BLOCK', 'R8G8B8A8_UNORM': 'R8G8B8A8_UNORM',
              'R8G8B8A8_UNORM_SRGB': 'R8G8B8A8_SRGB'}
LOD1_FILE = 'efmi-lod1-bones.json'
LOD1_SCHEMA = 'endfield-efmi-lod1-bones/v1'


def crc_table():
    table = []
    for i in range(256):
        c = i
        for _ in range(8):c = (c >> 1) ^ (0x82F63B78 if c & 1 else 0)
        table.append(c)
    return table


CRC32C_TABLE = crc_table()
# Slicing-by-4 folded into two 16-bit tables: one step takes a little-endian word into the register.
_T = [np.array(CRC32C_TABLE, np.uint32)]
for _ in range(3):_T.append((_T[-1] >> 8) ^ _T[0][_T[-1] & 0xFF])
_X = np.arange(1 << 16, dtype=np.uint32)
CRC32C_LO, CRC32C_HI = _T[3][_X & 0xFF] ^ _T[2][_X >> 8], _T[1][_X & 0xFF] ^ _T[0][_X >> 8]
del _T, _X
# Inputs of at least LANES*LANE_MIN bytes run as LANES equal segments at once.
CRC32C_LANES, CRC32C_LANE_MIN = 1024, 64


def gf2_apply(cols, x):
    """The 32-bit linear map whose image of bit i is cols[i], applied to x."""
    out, i = 0, 0
    while x:
        if x & 1:out ^= cols[i]
        x >>= 1; i += 1
    return out


def zero_bytes(n):
    """The map of the CRC register over n zero bytes (without the pre/post inversion), as images of its 32 bits."""
    step, out = [CRC32C_TABLE[(1 << i) & 0xFF] ^ ((1 << i) >> 8) for i in range(32)], [1 << i for i in range(32)]
    while n:
        if n & 1:out = [gf2_apply(step, c) for c in out]
        n >>= 1
        if n:step = [gf2_apply(step, c) for c in step]
    return out


def crc32c_lanes(data, crc):
    """(register after the longest prefix of `data` that splits into CRC32C_LANES segments of whole words, the rest of `data`)
    from register `crc`. Without the inversion the register is linear in its start and the bytes: over A then B it is
    zero_bytes(len B)(register over A) ^ (register over B from 0). Segment 0 starts from `crc`, the others from 0; segments are
    then joined in pairs, each pair a segment twice as long, until one is left."""
    m = len(data)//CRC32C_LANES//4
    s = np.zeros(CRC32C_LANES, np.uint32); s[0] = crc
    words = np.frombuffer(data, '<u4', CRC32C_LANES*m).reshape(CRC32C_LANES, m)
    for j in range(m):
        s ^= words[:, j]; s = CRC32C_LO[s & 0xFFFF] ^ CRC32C_HI[s >> 16]
    bits = (np.arange(256)[:, None] >> np.arange(8) & 1).astype(bool)
    shift = zero_bytes(4*m)
    while len(s) > 1:
        t = np.bitwise_xor.reduce(np.where(bits, np.array(shift, np.uint32).reshape(4, 1, 8), np.uint32(0)), axis=2)
        a = s[0::2]
        s = t[0][a & 0xFF] ^ t[1][a >> 8 & 0xFF] ^ t[2][a >> 16 & 0xFF] ^ t[3][a >> 24] ^ s[1::2]
        shift = [gf2_apply(shift, c) for c in shift]
    return int(s[0]), data[CRC32C_LANES*m*4:]


def crc32c(data, crc=0):
    """Standard CRC-32C (Castagnoli) continued from `crc`, which XXMI calls with seed 0 as the hash of one submesh's index range."""
    crc ^= 0xFFFFFFFF
    if len(data) >= CRC32C_LANES*CRC32C_LANE_MIN:crc, data = crc32c_lanes(data, crc)
    for b in data:crc = CRC32C_TABLE[(crc ^ b) & 0xFF] ^ (crc >> 8)
    return crc ^ 0xFFFFFFFF


def positions(raw, stride):
    """The float3 at offset 0 of each `stride`-byte vertex."""
    return [struct.unpack_from('<3f', raw, i) for i in range(0, len(raw)-stride+1, stride)]


def choose(candidates, equal):
    """The candidate with the most POSITION-equal vertices, then the one that is not a vfxpart; None while still tied."""
    best = max(equal.get(m, 0) for m in candidates)
    top = [m for m in candidates if equal.get(m, 0) == best]
    plain = [m for m in top if 'vfxpart' not in m]
    if len(top) == 1:return top[0]
    return plain[0] if len(plain) == 1 else None


def geometry(points, template):
    if points is None:return 'unknown'
    if len(points) == len(template) and points == template:return 'unmodified'
    return 'subset_of_original' if set(points) <= set(template) else 'modified'


def visible_in(appearances, base, appearance_id):
    """A kept mesh's appearance list once `appearance_id` shows it wherever `base` does; None (every appearance) stays None."""
    if appearances is None or base not in appearances:return appearances
    return appearances+[appearance_id]


def fingerprint(mod):
    """sha256 over the (path, sha256) list of the inis and every file they name, sorted by path."""
    rows = sorted([p.relative_to(mod.root).as_posix(), sha256_file(p)] for p in {*mod.inis, *mod.files.values()})
    return sha256_bytes(canonical_json(rows))


def bound_buffer(mod, override, values, stream):
    """The mod buffer `override` binds to `stream` (ib, vb0, ...), or None when it binds none of the mod's buffers there."""
    for e in override.lines:
        if e.key != stream or not efmi_mod.active(e, values):continue
        name = efmi_mod.target(e.value)
        key = next((k for k in mod.buffers if name in (('resource_'+k).lower(), ('resource'+k).lower())), None)
        return key if key is not None and mod.buffers[key].filename in mod.files else None
    return None


def mod_positions(mod, override, values, component=None):
    """The POSITION of each vertex in the vb0 buffer `override` (or its evaluated `component`) binds, or None when it binds none
    of the mod's buffers."""
    if component is not None:
        s = next((s for s in component.streams if s.slot == 'vb0'), None)
        name = s and (s.base_file if s.rw else s.file)
        if name not in mod.files or s.stride < 12:return None
        raw = mod.files[name].read_bytes()
        return positions(raw, s.stride) if len(raw) % s.stride == 0 else None
    key = bound_buffer(mod, override, values, 'vb0')
    if key is None:return None
    raw, stride, _, _ = efmi_mod.read_buffer(mod, key)
    return positions(raw, stride) if stride >= 12 else None


def mod_regions(mod, override, values, draws, component=None):
    """The CRC-32C a template region would hash to of each index range `draws` take from the mod's own index buffer, the one
    `override` (or its evaluated `component`) binds."""
    if component is not None:
        ib = component.ib or {}
        if ib.get('file') not in mod.files:return []
        width, raw = efmi_geometry.INDEX_FORMATS.get(ib.get('format')), mod.files[ib['file']].read_bytes()
    else:
        key = bound_buffer(mod, override, values, 'ib')
        if key is None:return []
        # An index buffer's format sets its width; exporters often write no stride for it.
        width = {'DXGI_FORMAT_R16_UINT': 2, 'DXGI_FORMAT_R32_UINT': 4}.get(mod.buffers[key].format.upper(), mod.buffers[key].stride)
        raw = mod.files[mod.buffers[key].filename].read_bytes()
    if width not in (2, 4) or len(raw) % width:return []
    indices = struct.unpack(f'<{len(raw)//width}{"H" if width == 2 else "I"}', raw)
    crcs = []
    for d in draws:
        part = indices[d.first:d.first+d.count]
        # Template regions hash their u16 index bytes.
        if part and max(part) < 65536:crcs.append('%08x' % crc32c(struct.pack(f'<{len(part)}H', *part)))
    return crcs


def material_variants(source, mesh):
    """Resource name -> material -> texture record of every encoded texture `mesh`'s draws sample, in draw order."""
    out = {}
    for d in source['draws']:
        if d['mesh'] != mesh:continue
        for r in d['resources']:
            if r['category'] == 'separate_images' and r.get('file') and r.get('texture', {}).get('rd_format_name'):
                out.setdefault(r['names'][0], {}).setdefault(d['material'], r['texture'])
    return out


def material_textures(source, mesh):
    """Resource name -> texture record of every encoded texture `mesh`'s draws sample, its first material's of a shared name."""
    return {n: next(iter(m.values())) for n, m in material_variants(source, mesh).items()}


def sized(blob, texture):return (texture['width'], texture['height']) == (blob.width, blob.height)


def shaped(blob, texture):return texture['width']*blob.height == texture['height']*blob.width


def fitting(materials, blob):
    """The materials (material -> texture of one resource name) whose texture `blob` replaces: those of its size, else of its
    aspect, else all."""
    return [m for m, t in materials.items() if sized(blob, t)] or [m for m, t in materials.items() if shaped(blob, t)] or list(materials)


def match_components(mod, source, palette, read_blob, mapping, values, components=None):
    """(receipt rows, mesh -> its drawn override, hidden meshes, component id -> mesh) of the mod's level-0 overrides.

    The hash of a level-0 override is a template region's CRC; a stale one, which the game no longer draws, is level 0 when its
    match_index_count is a template region's index count, and is placed by the CRC of the mod's own index buffer, then by the
    template mesh holding most of its positions. What a component draws and binds is its evaluated Component of `components`
    (efmi_mod.components; the mod's own by default); an override without a component id is read by `values` alone."""
    components = mod.components if components is None else components
    meshes = [m['mesh'] for m in palette['meshes'] if not m['mesh'].startswith('outfit:')]
    regions, crcs, counts = {}, {}, {}
    for d in source['draws']:
        if d['mesh'] not in meshes or d['index_component_bytes'] != 2:continue
        key = d['indices']['sha256']
        if key not in crcs:crcs[key] = '%08x' % crc32c(read_blob(d['indices']))
        if d['mesh'] not in regions.setdefault(crcs[key], []):regions[crcs[key]].append(d['mesh'])
        counts.setdefault(d['index_count'], set()).add(d['mesh'])
    drawable = sorted({m for found in regions.values() for m in found})
    template, sets = {}, {}
    def points(mesh):
        if mesh not in template:
            ch0 = next((a for d in source['draws'] if d['mesh'] == mesh for a in d['attributes'] if a['source_channel'] == 0), None)
            template[mesh] = positions(read_blob(ch0), ch0['stride']) if ch0 else []
        return template[mesh]
    def point_set(mesh):
        if mesh not in sets:sets[mesh] = set(points(mesh))
        return sets[mesh]
    def evaluated(o):return components.get(o.component) if o.component is not None else None
    def calls_of(o):
        c = evaluated(o)
        return c.segments if c is not None else [d for d in o.draws if efmi_mod.active(d.entry, values)]
    def ranges(o):return [d for d in calls_of(o) if d.count is not None and d.first is not None]
    if mod.overrides and not any(o.hash in regions or set(mod_regions(mod, o, values, ranges(o), evaluated(o))) & set(regions) for o in mod.overrides):
        everywhere = set().union(*map(point_set, drawable))
        if not any(p in everywhere for o in mod.overrides for p in mod_positions(mod, o, values, evaluated(o)) or ()):
            raise ValueError('not_this_character:没有一个组件的哈希或顶点位置属于这个角色')
    files = {s.name.lower() for s in mod.sections if s.get('filename')}
    top = {}
    for o in mod.overrides:
        if o.component is not None and o.index_count is not None:top[o.component] = max(top.get(o.component, 0), o.index_count)
    rows, drawn, hidden, by_component = [], {}, set(), {}
    for o in mod.overrides:
        row = dict(section=o.section, component=o.component, hash=o.hash); rows.append(row)
        # A stale hash is level 0 only with a template region's index count, the largest of its component's sections.
        if o.hash not in regions and o.index_count is not None and (o.index_count not in counts or o.index_count < top.get(o.component, 0)):
            row['action'] = 'skipped_lod'; continue
        component = evaluated(o)
        calls = calls_of(o)
        real = ranges(o)
        chosen = mapping.get('components', {}).get(str(o.component)) if o.component is not None else None
        if chosen is not None and chosen not in meshes:raise ValueError('unmapped_component:'+o.section)
        candidates = [chosen] if chosen else regions.get(o.hash, [])
        if not candidates and real:
            pool = sorted(counts[o.index_count]) if o.index_count is not None else drawable
            if found := sorted({m for crc in mod_regions(mod, o, values, real, component) for m in regions.get(crc, []) if m in pool}):
                candidates = found; row['matched_by'] = 'index_buffer'
            elif found := set(mod_positions(mod, o, values, component) or ()):
                overlap = {m: len(found & point_set(m)) for m in pool}
                if (mesh := choose(pool, overlap)) and overlap[mesh]:candidates = [mesh]; row['matched_by'] = 'positions'
        # Without a draw call of its own, a component that binds mod buffers replaces only some vertex streams.
        streams_only = not real and (any(s.file or s.base_file for s in component.streams) or (component.ib or {}).get('file') if component is not None
                                     else any(e.key in VERTEX_STREAMS and efmi_mod.target(e.value) in files for e in o.lines))
        if not candidates:
            if real:raise ValueError('unmapped_component:'+o.section)
            # A stale hash without a draw is one the game no longer matches, so in the game its streams replace nothing.
            row['action'] = 'ignored'
            if streams_only:row['reason'] = 'stream_only'
            continue
        if streams_only:raise ValueError('unsupported_geometry:stream_only:'+o.section)
        if calls and not real:row['action'] = 'skipped_cpu_posed'; continue
        reaches = any(e.key == 'run' or e.value.lower().startswith('ref commandlist') for e in o.lines)
        if not real and (o.keys.get('handling') or '').lower() != 'skip' and not reaches:row['action'] = 'ignored'; continue
        found = mod_positions(mod, o, values, component) if real else None
        equal = {m: sum(a == b for a, b in zip(found, points(m))) for m in candidates} if found and len(candidates) > 1 else {}
        mesh = choose(candidates, equal)
        if mesh is None:raise ValueError('unmapped_component:'+o.section)
        row['mesh'] = mesh
        if o.component is not None:by_component.setdefault(o.component, mesh)
        if real:
            row.update(action='kept', geometry=geometry(found, points(mesh))); drawn.setdefault(mesh, o)
        else:
            row['action'] = 'hidden'; hidden.add(mesh)
    return rows, drawn, hidden-set(drawn), by_component


def program(source, mesh, family=False):
    """The programs `mesh` is drawn with, or with `family` the shader folders they come from; its materials when no draw names one."""
    draws = [d for d in source['draws'] if d['mesh'] == mesh]
    stages = {s['source_spirv'] for d in draws for s in d.get('stages', []) if s.get('source_spirv')}
    if not stages:return tuple(sorted({d['material'] for d in draws}))
    return tuple(sorted({Path(s).parent.name for s in stages} if family else stages))


def slot_key(source, mesh, slot):
    # A ps-t register belongs to one compiled program; a semantic holds across the variants of a shader.
    return program(source, mesh, family=not slot.startswith('ps-t')), slot


def hint_name(programs):
    """The slot hint table's name of a slot_key program tuple."""
    return '|'.join(programs)


def config_table(name, schema, reason, folder=None, listed=()):
    """The config table that `listed` (a pack's interaction data, in `folder`) names, of the sha256 it records; without one no
    hints."""
    row = next((r for r in listed if r['file'] == name), None)
    if row is None:return dict(characters={})
    raw = (folder/row['file']).read_bytes()
    need(sha256_bytes(raw) == row['sha256'], 'file_sha_mismatch')
    table = json.loads(raw)
    if table.get('schema') != schema:raise ValueError(reason)
    return table


def slot_hints(character, folder=None, listed=()):
    """Program (or shader family) name -> slot -> resource that sample mods showed for `character` (efmi_slot_hints.py)."""
    return config_table(HINTS_FILE, HINTS_SCHEMA, 'invalid_slot_hints', folder, listed)['characters'].get(character, {})


def lod1_bones(character, folder=None, listed=()):
    """LOD1 submesh region hash -> {lod1_mesh, lod0_mesh, index_count, bones} of `character`, bone i of the lod1 mesh being
    bone bones[i] of the lod0 mesh's palette."""
    return config_table(LOD1_FILE, LOD1_SCHEMA, 'invalid_lod1_bones', folder, listed)['characters'].get(character, {})


def bone_sources(components, by_component, lod1):
    """Component id -> its template mesh, or (lod0 mesh, bone order) for a LOD1 component that `lod1` (lod1_bones) knows, for
    merged-skeleton bone ids; a LOD1 component is never drawn."""
    out = dict(by_component)
    for cid, c in components.items():
        if cid not in out and c.hash in lod1:out[cid] = (lod1[c.hash]['lod0_mesh'], lod1[c.hash]['bones'])
    return out


def program_hints(source, mesh, hints):
    """Slot -> resource that `hints` names for `mesh`'s shader family and, over it, for its programs."""
    return {**hints.get(hint_name(program(source, mesh, family=True)), {}), **hints.get(hint_name(program(source, mesh)), {})}


def slot_formats(source, mesh, hints):
    """ps-tN -> DXGI code of the template texture that `hints` puts in each ps-t slot of `mesh`'s programs, other slots
    unbound; None when the table names no ps-t slot of them, which leaves every slot's format unknown."""
    own = material_textures(source, mesh)
    found = {s: DXGI_CODES[own[r]['rd_format_name']] for s, r in program_hints(source, mesh, hints).items()
             if s.startswith('ps-t') and r in own and own[r]['rd_format_name'] in DXGI_CODES}
    return found or None


def dds_format(path):
    """The rd_format_name a DDS header names, by read_dds's rules, or None for a file it refuses by its header."""
    with Path(path).open('rb') as f:head = f.read(148)
    if len(head) < 128 or head[:4] != b'DDS ':return None
    fourcc = head[84:88]
    if fourcc == b'DX10':return efmi_mod.DXGI_FORMATS.get(struct.unpack_from('<I', head, 128)[0]) if len(head) == 148 else None
    if fourcc in efmi_mod.FOURCC_FORMATS:return efmi_mod.FOURCC_FORMATS[fourcc]
    if fourcc == b'\0\0\0\0' and struct.unpack_from('<I', head, 80)[0] & 0x40 and struct.unpack_from('<5I', head, 88) == efmi_mod.RGBA_MASKS:
        return 'R8G8B8A8_UNORM'
    return None


def evaluate(mod, source, by_component, hints, base, values=LOD0):
    """Component id -> Component at the defaults with `values` over them, each component of a mesh in `by_component` with the
    slot formats of its mesh, the others as in `base` (evaluated with no slot format known)."""
    out = dict(base)
    formats = {cid: slot_formats(source, mesh, hints) for cid, mesh in by_component.items()}
    for key in {tuple(sorted(f.items())) for f in formats.values() if f}:
        found = efmi_mod.components(mod, values, dict(key))
        out.update({cid: found[cid] for cid, f in formats.items() if f and tuple(sorted(f.items())) == key})
    return out


def texture_targets(mod, drawn, hidden, by_component, values, components=None, groups=None):
    """(file -> places it is bound to, (file, mesh) -> slots, file -> original texture hash, warnings) of the mod's textures.

    A place is (mesh, None) for every draw of the mesh, or (mesh, (component, group)) for one group of a component whose geometry
    is imported, which `groups` (component id -> slot -> file of each of its groups) lists; a slot binding is the one file that
    holds the slot at a draw of the evaluated `components` (the mod's own by default)."""
    components = mod.components if components is None else components
    groups = groups or {}
    shown = {c: m for c, m in by_component.items() if m not in hidden}
    targets, slots, hashes, warnings = {}, {}, {}, []
    def bind(filename, place, slot):
        targets.setdefault(filename, set()).add(place); slots.setdefault((filename, place[0]), set()).add(slot)
        if slot in RABBITFX_SLOTS:slots[filename, place[0]].add(RABBITFX_SLOTS[slot])
    for c, mesh in shown.items():
        if c in groups:
            for g, bound in enumerate(groups[c]):
                for slot, filename in bound.items():bind(filename, (mesh, (c, g)), slot)
        elif c in components:
            for s in efmi_geometry.kept_segments(mod, components[c]):
                for slot, filename in efmi_geometry.slot_files(s.textures).items():bind(filename, (mesh, None), slot)
    resources = {}
    for s in mod.sections:
        if s.get('filename'):resources.setdefault(s.get('filename').replace('\\', '/'), s.name)
    # A `this` file is placed where a texture check binds it, by the segments' `hash:` slots.
    for h, filename in mod.textures:
        hashes.setdefault(filename, h)
        # The semantic stands in for a slot, as an external namespace texture's does.
        if semantic := SEMANTIC_NAME.search(resources.get(filename, '')) or SEMANTIC_NAME.search(Path(filename).stem):
            for mesh, _ in targets.get(filename, ()):slots.setdefault((filename, mesh), set()).add(semantic.group(1).lower()+'map')
    by_hash = {}
    for o in mod.overrides:
        if o.component in shown:by_hash.setdefault(o.hash, shown[o.component])
    for _, filename in mod.external_textures:
        name = EXTERNAL_NAME.fullmatch(Path(filename).name)
        if filename in targets or not name or name.group(1).lower() not in by_hash:continue
        mesh = by_hash[name.group(1).lower()]
        # The semantic stands in for the slot that the other mod binds it to.
        targets[filename] = {(mesh, None)}; slots[filename, mesh] = {name.group(2).lower()+'map'}
    warnings += ['external_namespace:'+f for _, f in mod.external_textures if f not in targets]
    warnings += ['texture_unbound:'+f for f in dict.fromkeys(f for _, f in mod.textures) if f not in targets]
    for filename in targets:
        if filename not in hashes and (match := TEXTURE_HASH.search(Path(filename).name)):hashes[filename] = match.group(1).lower()
    return targets, slots, hashes, warnings


def hashed_textures(source, mesh):
    """The resource of each template texture file of `mesh` that the runtime hashes, its first in draw order."""
    seen = set()
    for d in source['draws']:
        if d['mesh'] != mesh:continue
        for r in d['resources']:
            t = r.get('texture', {})
            if r['category'] != 'separate_images' or not r.get('file') or not t.get('mips') or t['rd_format_name'] not in DXGI_CODES or \
                    r['file'] in seen:continue
            seen.add(r['file'])
            yield r


def texture_hashes(source, mesh, read_blob):
    """3DMigoto hash -> resource names of `mesh`'s template textures: the CRC-32C of level 0 continued over the
    D3D11_TEXTURE2D_DESC the game creates the texture with (one slice, no multisampling, default usage, shader resource)."""
    out = {}
    for r in hashed_textures(source, mesh):
        t = r['texture']; m = t['mips'][0]
        # EFMI's texture_hash = 0 keeps 3DMigoto 1.2's length, width*height bytes, when level 0 is not shorter.
        size = t['width']*t['height'] if t['width']*t['height'] <= m['size'] else m['size']
        desc = struct.pack('<11I', t['width'], t['height'], t['mip_count'], 1, DXGI_CODES[t['rd_format_name']], 1, 0, 0, 8, 0, 0)
        out.setdefault('%08x' % crc32c(desc, crc32c(read_blob(r)[m['offset']:m['offset']+size])), set()).add(r['names'][0])
    return out


def texture_dhashes(source, mesh, read_blob, cache):
    """(resource name, rd_format_name, dHash) of each of `mesh`'s template textures that texture_hashes reads and
    texture_dhash decodes; `cache` keeps a file's dHash across meshes."""
    out = []
    for r in hashed_textures(source, mesh):
        t = r['texture']
        if t['rd_format_name'] not in texture_dhash.CODECS:continue
        if r['file'] not in cache:
            raw = read_blob(r)
            cache[r['file']] = texture_dhash.dhash(t['rd_format_name'], [(m['width'], m['height'], raw[m['offset']:m['offset']+m['size']]) for m in t['mips']])
        out.append((r['names'][0], t['rd_format_name'], cache[r['file']]))
    return out


def filtered(dhashes, key):
    """The resources a `filter:<dHash>:<match_format>:<max distance>` slot binds of `dhashes` (texture_dhashes): those of the
    format with the least distance to the filter's dHash, all ties, none when that is above the max distance."""
    _, dhash, fmt, most = key.split(':')
    found = [(texture_dhash.distance(int(dhash, 16), h), n) for n, f, h in dhashes if not fmt or f == DXGI_NAMES.get(fmt)]
    best = min((d for d, _ in found), default=None)
    return set() if best is None or best > int(most) else {n for d, n in found if d == best}


def learn_textures(mod, source, read_blob, targets, slots, hashes):
    """(file -> TextureBlob of each file not unchanged on all its meshes, unchanged: file -> {mesh: resource},
    known: original hash or slot_key -> resources, claimed: mesh -> {(material, resource): hash}) from the files equal to a
    template texture; `targets` maps a file to its (mesh, group) places."""
    refs = {(d['mesh'], d['material'], r['names'][0]): r for d in source['draws'] for r in d['resources']
            if r['category'] == 'separate_images' and r.get('file') and r.get('texture', {}).get('rd_format_name')}
    level0 = {}
    def template_level0(r):
        if r['file'] not in level0:
            m = r['texture']['mips'][0]; level0[r['file']] = read_blob(r)[m['offset']:m['offset']+m['size']]
        return level0[r['file']]
    blobs, unchanged, known, claimed = {}, {}, {}, {}
    for filename in sorted(targets):
        if not targets[filename]:continue
        blob = efmi_mod.read_dds(mod.files[filename], mod.color_spaces.get(filename)); m0 = blob.mips[0]; data = blob.data[m0['offset']:m0['offset']+m0['size']]
        meshes = sorted({mesh for mesh, _ in targets[filename]})
        for mesh in meshes:
            same = [(m, n) for n, materials in material_variants(source, mesh).items() for m, t in materials.items()
                    if (t['rd_format_name'], t['width'], t['height']) == (blob.rd_format_name, blob.width, blob.height) and template_level0(refs[mesh, m, n]) == data]
            if not same:continue
            unchanged.setdefault(filename, {})[mesh] = same[0][1]
            for key in same:claimed.setdefault(mesh, {})[key] = hashes.get(filename)
            for k in [hashes.get(filename), *(slot_key(source, mesh, s) for s in slots.get((filename, mesh), ()))]:
                if k is not None:known.setdefault(k, set()).update(n for _, n in same)
        if set(unchanged.get(filename, {})) != set(meshes):blobs[filename] = blob
    return blobs, unchanged, known, claimed


def match_textures(mod, source, read_blob, drawn, hidden, by_component, mapping, values, hints, components=None, groups=None):
    """(receipt rows, place -> {(material, resource name): TextureBlob}, warnings) for every texture file the mod binds.

    A file whose level 0 equals a template texture of a mesh is that texture unchanged there and is not applied; it teaches this
    mod's tables of original texture hash and of (program, slot) -> resource, which place the other files before the shape rule.
    `hints` (slot_hints) places by its slot a file that this mod's tables do not. Places are texture_targets'; of a resource
    name that several materials of a mesh sample, a file replaces the materials it fits (fitting)."""
    targets, slots, hashes, warnings = texture_targets(mod, drawn, hidden, by_component, values, components, groups)
    # A slot of a mod shader's own may hold a format no template texture has.
    unsupported = {f: targets.pop(f) for f in sorted(targets) if dds_format(mod.files[f]) is None}
    blobs, unchanged, known, claimed = learn_textures(mod, source, read_blob, targets, slots, hashes)
    variants = {}
    def kinds(mesh):
        if mesh not in variants:variants[mesh] = material_variants(source, mesh)
        return variants[mesh]
    def own_of(mesh, blob):
        """Resource name -> the texture of the first material whose texture `blob` would replace."""
        return {n: materials[fitting(materials, blob)[0]] for n, materials in kinds(mesh).items()}
    def other_hash(mesh, key, h):
        found = claimed.get(mesh, {}).get(key)
        return bool(h and found and found != h)
    template_hashes, template_dhashes, dhash_cache = {}, {}, {}
    def hashed(filename, mesh):
        """The resources whose template texture of `mesh` has the hash of one of the file's `hash:` slots there, and those its
        `filter:` slots there name by dHash (filtered) or, where a filter names none, by the original hash in the file name."""
        bound = slots.get((filename, mesh), ())
        found, named = {s[5:] for s in bound if s.startswith('hash:')}, set()
        for s in bound:
            if not s.startswith('filter:'):continue
            if mesh not in template_dhashes:template_dhashes[mesh] = texture_dhashes(source, mesh, read_blob, dhash_cache)
            if near := filtered(template_dhashes[mesh], s):named |= near
            elif match := TEXTURE_HASH.search(Path(filename).name):found.add(match.group(1).lower())
        if found and mesh not in template_hashes:template_hashes[mesh] = texture_hashes(source, mesh, read_blob)
        return named | {n for h in found for n in template_hashes[mesh].get(h, ())}
    def candidates(filename, mesh, own, blob):
        """(resources, whether this mod's tables or the hints name them rather than the shape rule)."""
        if named := hashed(filename, mesh) & set(own):return named, True
        h = hashes.get(filename); keys = [slot_key(source, mesh, s) for s in slots.get((filename, mesh), ())]
        seen = set().union(*(known.get(k, set()) for k in [h, *keys] if k is not None)) & set(own)
        if seen:return seen, True
        family = hint_name(program(source, mesh, family=True))
        if hinted := {hints.get(hint_name(p), {}).get(s) or hints.get(family, {}).get(s) for p, s in keys} & set(own):return hinted, True
        fits = {n for n, t in own.items() if t['rd_format_name'] == blob.rd_format_name and shaped(blob, t)}
        # A resource kept unchanged under another original hash in each of its materials is not the one this hash replaces.
        fits -= {n for n in fits if all(other_hash(mesh, (m, n), h) for m in kinds(mesh)[n])}
        return {n for n in fits if sized(blob, own[n])} or fits, False
    def free(place, name, blob):
        """The (material, name) keys `blob` would replace at `place` that no other file took."""
        return [(m, name) for m in fitting(kinds(place[0])[name], blob) if (m, name) not in assigned.get(place, {})]
    def place_key(place):return place[0], place[1] is not None, place[1] or ()
    def unread(filename, mesh):
        """Whether the file is bound at `mesh` only to ps-t registers that the hint table, which knows the slots of the mesh's
        programs, leaves out and this mod teaches nothing about: a patched shader's own, which the template programs never read;
        to RabbitFX semantics the mesh's shader has no resource for; and to hashes of textures that `mesh` does not have.
        A file bound only by filters is unread where they name no template texture, whatever the table."""
        named = program_hints(source, mesh, hints)
        table = {s for s in named if s.startswith('ps-t')}
        bound = slots.get((filename, mesh), set())
        if bound and all(s.startswith('filter:') for s in bound):return not hashed(filename, mesh)
        def dead(s):
            if s.startswith(('hash:', 'filter:')):return True
            if s.startswith('ps-t'):return s not in table and slot_key(source, mesh, s) not in known
            return s in RABBITFX_SLOTS.values() and s not in named and slot_key(source, mesh, s) not in known
        return bool(table and bound) and not hashes.get(filename) and not hashed(filename, mesh) and all(dead(s) for s in bound)
    # Of a format nothing here reads, a file only a mod shader samples is unused whatever its format.
    warnings += [('texture_unbound:' if all(unread(f, m) for m, _ in places) else 'texture_unsupported:')+f for f, places in unsupported.items()]
    rows, assigned, placing = [], {}, []
    for i, filename in enumerate(sorted(targets)):
        places = sorted((p for p in targets[filename] if p[0] not in unchanged.get(filename, {})), key=place_key)
        # A hash override or a filter replaces a texture only on the meshes whose template has it.
        if any(hashed(filename, m) for m, _ in places):
            places = [p for p in places if hashed(filename, p[0]) or
                      any(not s.startswith(('hash:', 'filter:')) for s in slots.get((filename, p[0]), ()))]
        meshes = sorted({m for m, _ in places})
        row = dict(index=i, file=filename, meshes=meshes, resource=None); rows.append(row)
        if filename in unchanged:row['unchanged'] = dict(sorted(unchanged[filename].items()))
        if not places:continue
        blob = blobs[filename]
        own = {p: own_of(p[0], blob) for p in places}
        name = mapping.get('textures', {}).get(str(i))
        if name is None and all(unread(filename, m) for m in meshes):warnings.append('texture_unbound:'+filename); continue
        if name is not None:
            if not all(name in own[p] for p in places):raise ValueError(f'texture_mismatch:{i}:{filename}')
            placing.append((0, 0, i, row, places, blob, own, name)); continue
        found = [candidates(filename, p[0], own[p], blob) for p in places]
        fits = [c for c, _ in found]
        # Two files cannot replace one resource; a table's word, then the template's size, decides which file is placed first.
        rank = 1 if all(named for _, named in found) else 2 if all(any(sized(blob, own[p][n]) for n in c) for p, c in zip(places, fits)) else 3
        # A draw's program reads one of two slots the tables name for one resource; the lower register is placed first.
        first = min((int(s[4:]) for m in meshes for s in slots.get((filename, m), ()) if s.startswith('ps-t')), default=0) if rank == 1 else 0
        placing.append((rank, first, i, row, places, blob, own, fits))
    for rank, _, i, row, places, blob, own, choice in sorted(placing, key=lambda p: p[:3]):
        filename = row['file']
        if rank == 0:chosen = [choice]
        else:
            fits = choice
            left = [{n for n in c if free(p, n, blob)} for p, c in zip(places, fits)]
            # Only a unique match is accepted, the same resource in every place the texture is bound to.
            names = set.intersection(*left)
            lost = any(c and not rest for c, rest in zip(fits, left))
            if not names and rank == 1 and all(c and not rest for c, rest in zip(fits, left)):
                warnings.append('texture_unbound:'+filename); continue
            if not names and (lost or len({m for m, _ in targets[filename]}) > 1 and hashes.get(filename)) and not all(
                    any(sized(blob, own[p][n]) for n in c) for p, c in zip(places, fits)):
                # An original texture with none of its size in one of its meshes, which several components share or whose
                # candidates other files took, is one that no slot of this character holds (a global one of the game).
                warnings.append('texture_unbound:'+filename); continue
            # Several resources only when hashes name them all: one file the mod puts in place of several original textures.
            by_hash = [hashed(filename, p[0]) for p in places]
            if len(names) != 1 and not (names and all(names <= h for h in by_hash)):
                raise ValueError(f'texture_mismatch:{i}:{filename}: candidates '+'; '.join(
                    f'{p[0]}: {", ".join(n+(" (taken)" if n not in rest else "") for n in sorted(c)) or "none"}' for p, c, rest in zip(places, fits, left)))
            chosen = sorted(names)
        row['resource'] = chosen[0]
        if len(chosen) > 1:row['resources'] = chosen
        for name in chosen:
            for p in places:
                keys = free(p, name, blob)
                if not keys:raise ValueError(f'texture_mismatch:{i}:{filename}: {name} of {p[0]} is taken')
                assigned.setdefault(p, {}).update(dict.fromkeys(keys, blob))
        # The template samplers may need the whole chain, which a block-compressed texture cannot be given here.
        if len(blob.mips) == 1 and any(own[p][n]['mip_count'] > 1 for p in places for n in chosen):warnings.append('needs_mips:'+filename)
        tag = re.search(r'bc7-srgb|bc7-linear|bc5-linear', Path(filename).name, re.IGNORECASE)
        if tag and FORMAT_TAGS[tag.group(0).lower()] != blob.rd_format_name:warnings.append('format_tag:'+filename)
    return rows, assigned, warnings


def has_geometry(mod, component):
    """Whether a component draws an index buffer and a vb0 of its own, the geometry efmi_geometry reads; one drawing the game's
    buffers keeps the template's geometry."""
    vb0 = next((s for s in component.streams if s.slot == 'vb0'), None)
    return (component.ib or {}).get('file') in mod.files and vb0 is not None and (vb0.rw or vb0.file in mod.files)


def geometries(mod, rows, components, source, palette, read_blob, rig_ids, bones):
    """(component id -> GeometryResult, or None for the template's own geometry, report rows) of each drawn component;
    `bones` is bone_sources'."""
    results, report = {}, []
    for row in rows:
        cid = row.get('component')
        if row['action'] != 'kept' or cid is None or cid in results or cid not in components:continue
        component, mesh, own = components[cid], row['mesh'], has_geometry(mod, components[cid])
        result = efmi_geometry.component_geometry(mod, component, mesh, source, palette, read_blob, rig_ids, bones) if own else None
        results[cid] = result
        if result is None:
            change = 'unmodified' if own or row.get('geometry') in ('unmodified', 'unknown') else row['geometry']
            report.append(dict(component=cid, section=row['section'], mesh=mesh, submesh=None, change=change, applied=own,
                               vertices=next(d['vertex_count'] for d in source['draws'] if d['mesh'] == mesh), groups=0, bones_appended=0, warnings=[]))
            continue
        r = result.replacement
        report.append(dict(component=cid, section=row['section'], mesh=mesh, submesh=r.submesh,
                           change=row['geometry'] if row.get('geometry') in ('subset_of_original', 'modified') else 'modified', applied=True,
                           vertices=r.vertex_count, groups=len(r.groups), bones_appended=len(r.extra_bones), warnings=result.warnings))
    return results, report


def switch_geometry(mod, component, extra, result, mesh, source, palette, read_blob, rig_ids, bones):
    """`result` with groups of the `extra` segments, which only other switch values draw, after its own, or None when they would
    change one of its groups; a vertex its own groups index keeps its channel bytes."""
    union = efmi_geometry.component_geometry(mod, dataclasses.replace(component, segments=component.segments+extra), mesh, source,
                                             palette, read_blob, rig_ids, bones)
    old = result.replacement; new = union.replacement if union else None
    if new is None or (new.submesh, new.vertex_count, len(new.extra_bones)) != (old.submesh, old.vertex_count, len(old.extra_bones)) or \
            [(g.indices, g.index_bytes) for g in new.groups[:len(old.groups)]] != [(g.indices, g.index_bytes) for g in old.groups]:
        return None
    used = set()
    for g in old.groups:used.update(memoryview(g.indices).cast('H' if g.index_bytes == 2 else 'I'))
    channels = {}
    for c, raw in new.channels.items():
        mine = old.channels.get(c, raw)
        if mine == raw or len(mine) != len(raw):channels[c] = mine; continue
        # Normals recomputed over every group differ where an added group shares a vertex.
        stride, out = len(raw)//new.vertex_count, bytearray(raw)
        for i in used:out[i*stride:(i+1)*stride] = mine[i*stride:(i+1)*stride]
        channels[c] = bytes(out)
    return efmi_geometry.GeometryResult(dataclasses.replace(new, channels=channels, extra_bones=old.extra_bones), union.group_textures,
                                        list(dict.fromkeys(result.warnings+union.warnings)))


def resource_of(texture_rows, filename, mesh):
    """The resource the texture match placed `filename` in at `mesh`, also one it left unchanged, or None."""
    row = next((r for r in texture_rows if r['file'] == filename), None)
    if row is None:return None
    return row['resource'] if mesh in row['meshes'] else row.get('unchanged', {}).get(mesh)


def import_outfit(package_root, mod_dir, stage, name=None, mapping=None, progress=None):
    """progress(stage, fraction) is told the stages read, compose and write, each from 0 to 1."""
    progress = progress or (lambda stage, fraction: None)
    progress('read', 0)
    # reference checks the inventory's SHA-256 of each file this rewrites; the library checks the others when it publishes.
    package = Package(package_root, deep=False); output = Path(stage).resolve()
    need(not output.exists(), 'output_already_exists')
    need(not output.is_relative_to(package.root), 'output_inside_input_package')
    mod = efmi_mod.load_mod(mod_dir)
    mapping = read_json(mapping) if mapping else dict(schema=MAP_SCHEMA)
    need(mapping.get('schema') == MAP_SCHEMA, 'invalid_mapping')
    progress('read', 1); progress('compose', 0)
    values = dict(mod.constants, **{'$lod_level': '0'})
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix='.outfit-', dir=output.parent)); shutil.rmtree(tmp)
    try:
        subprocess.run(['/bin/cp', '-cR', str(package.root), str(tmp)], check=True)
        definition = read_json(tmp/'character.json')
        native_path = tmp/package.native_ref['file']; runtime = native_path.parent
        native = read_json(native_path); entry = native['characters'][0]
        source_path, graph_path, pack_path = (runtime/entry[k]['file'] for k in ('source', 'graph', 'c7'))
        source, graph, pack = read_json(source_path), read_json(graph_path), read_json(pack_path)
        animation = pack_path.parent/'animation'
        palette_path = animation/pack['animation']['palette_contract']['file']; palette = read_json(palette_path)
        def read_blob(r):
            stored = (source_path.parent/r['file']).read_bytes()
            return stored if len(stored) == r['byte_count'] else pool_codec.decode(stored)
        archive_path = runtime/entry['actor_archive']['file']
        rig = read_json(archive_path.parent/read_json(archive_path)['rig']['file'])
        rig_ids = {n['source_id'] for n in rig['nodes'] if n.get('source_id') is not None}
        switches = mod_settings.Switches(mod)
        # An underwear switch is held where it draws most, for the defaults and every switch's values alike.
        lod0, pinned = switches.pin(LOD0)
        values.update(lod0)
        tables = pack_path.parent/'interaction', pack['interaction']['data']
        hints, base = slot_hints(package.id, *tables), efmi_mod.components(mod, lod0)
        # The slot formats a component is evaluated with are its mesh's, so the mesh is found first.
        components = evaluate(mod, source, match_components(mod, source, palette, read_blob, mapping, values, base)[3], hints, base, lod0)
        rows, drawn, hidden, by_component = match_components(mod, source, palette, read_blob, mapping, values, components)
        bones = bone_sources(components, by_component, lod1_bones(package.id, *tables))
        shown = {r['component']: r['mesh'] for r in rows if r['action'] == 'kept' and r.get('component') is not None}
        plan = switches.plan(lod0, components, shown, lambda v: evaluate(mod, source, by_component, hints, efmi_mod.components(mod, v), v))
        # A segment a value textures apart from the others of its group is drawn in a group of its own.
        for cid in {c for c, _ in plan.split}:
            components[cid] = dataclasses.replace(components[cid], segments=[dataclasses.replace(s, split=plan.split.get((cid, (s.first, s.count)), ()))
                                                                             for s in components[cid].segments])
        results, geometry = geometries(mod, rows, components, source, palette, read_blob, rig_ids, bones)
        plan.fixed[:0] = pinned
        for sid in pinned:plan.warn('setting_fixed:'+sid)
        own = {c: len(r.replacement.groups) for c, r in results.items() if r is not None}
        added = {}
        for (cid, _), (sid, vals, segment) in plan.extras.items():
            added.setdefault(cid, []).append(dataclasses.replace(segment, condition=(mod_settings.MARK, sid, tuple(vals)), custom_shader=None))
        drawn_with = dict(components)
        for cid, extra in sorted(added.items()):
            union = results.get(cid) and switch_geometry(mod, components[cid], extra, results[cid], shown[cid], source, palette, read_blob, rig_ids, bones)
            if union is None:
                plan.warn('segment_unmappable:'+components[cid].section)
                plan.extras = {k: e for k, e in plan.extras.items() if k[0] != cid}; continue
            results[cid] = union; drawn_with[cid] = dataclasses.replace(components[cid], segments=components[cid].segments+extra)
            next(g for g in geometry if g['component'] == cid)['groups'] = len(union.replacement.groups)
        geometric = {c: r for c, r in results.items() if r is not None}
        texture_rows, assigned, warnings = match_textures(mod, source, read_blob, drawn, hidden, by_component, mapping, values, hints,
                                                          components, {c: r.group_textures[:own[c]] for c, r in geometric.items()})
        warnings = mod.warnings+warnings
        if not assigned and not hidden and not geometric:raise ValueError('unsupported_mod:nothing_to_import')
        if not assigned and not geometric and not any(r.get('geometry') in ('subset_of_original', 'modified') for r in rows):
            raise ValueError('nothing_to_import:只隐藏了组件 '+', '.join(sorted(hidden))+'，贴图都没套上')
        cloned = {mesh for mesh, _ in assigned} | {r.replacement.mesh for r in geometric.values()}
        for row in rows:
            if row['action'] == 'kept' and row.get('component') in geometric:row['action'] = 'geometry'
            elif row['action'] == 'kept' and row.get('mesh') in cloned:row['action'] = 'textures'
            if row.get('geometry') in ('subset_of_original', 'modified') and row.get('component') not in geometric:
                warnings.append('geometry_not_applied:'+row['section'])
            # The game no longer draws this hash, so in the game the mod leaves this component as it is.
            if row.get('matched_by'):warnings.append('stale_hash:'+row['section'])
            if row.get('reason') == 'stream_only':warnings.append('stream_only_ignored:'+row['section'])
        for g in geometry:warnings += [w for w in g['warnings'] if w not in warnings]
        # A texture that only a skipped shader patch reads is that patch's loss, named in its warning.
        folded = {}
        for w in warnings:
            if not w.startswith('texture_unbound:'):continue
            f = w.split(':', 1)[1]
            read = [re.fullmatch(r'ps-t(\d+)', t.slot) for t in mod.slot_textures if t.filename == f]
            patch = next((n for n, ts in mod.shader_patches.items() if read and all(r and int(r.group(1)) in ts for r in read)), None)
            if patch:folded.setdefault(patch, []).append(f)
        warnings = [':'.join(['shader_patch_ignored', w[21:], *folded[w[21:]]]) if w.startswith('shader_patch_ignored:') and w[21:] in folded else w
                    for w in warnings if not (w.startswith('texture_unbound:') and any(w[16:] in fs for fs in folded.values()))]
        referenced = set(mod.files.values())
        unused = sorted(p.relative_to(mod.root).as_posix() for p in mod.root.rglob('*') if p.suffix.lower() == '.dds' and p.resolve() not in referenced)
        fp = fingerprint(mod)
        appearance = dict(id='mod_'+fp[:8], name=name or mod.name or mod.root.name, kind='imported',
                          source=dict(format='efmi', fingerprint=fp, **(dict(mod_name=mod.name) if mod.name else {}),
                                      imported_at=datetime.now(timezone.utc).isoformat(timespec='seconds')))
        if appearance['id'] in {a['id'] for a in pack['appearances']}:raise ValueError('duplicate_appearance')
        def store(*folders):
            def put(raw):
                sha = sha256_bytes(raw)
                for folder in set(folders):
                    p = folder/'Files'/(sha+'.bytes'); p.parent.mkdir(exist_ok=True)
                    if not p.exists():p.write_bytes(raw)
                return dict(file='Files/'+sha+'.bytes', sha256=sha, byte_count=len(raw))
            return put
        put, put_graph = store(source_path.parent), store(graph_path.parent)
        controlled = {}
        for (cid, span), when in plan.controlled.items():controlled.setdefault(cid, {})[span] = when
        layouts = {c: mod_settings.groups(mod, drawn_with[c], controlled.get(c, {}), plan.warn) for c in geometric}
        blobs = {}
        def texture(filename):
            if filename not in blobs:blobs[filename] = efmi_mod.read_dds(mod.files[filename], mod.color_spaces.get(filename))
            return blobs[filename]
        def added_textures(c, mesh, k):
            """Resource name -> TextureBlob of a group only other switch values draw: a file the match placed at the mesh, else one
            bound where the defaults bind a placed file of its format."""
            out = {}
            def placed(filename):
                row = next((r for r in texture_rows if r['file'] == filename), None)
                return row is not None and mesh in row['meshes']
            for slot, filename in results[c].group_textures[k].items():
                if resource := resource_of(texture_rows, filename, mesh):
                    if placed(filename):out[resource] = texture(filename)
                    continue
                before = {g[slot] for g in results[c].group_textures[:own[c]] if slot in g}
                resource = resource_of(texture_rows, next(iter(before)), mesh) if len(before) == 1 else None
                if resource is None:plan.warn('variant_unplaced:'+filename); continue
                [default_file] = before
                fmt = texture(default_file).rd_format_name if placed(default_file) else material_textures(source, mesh)[resource]['rd_format_name']
                try:blob = texture(filename)
                except ValueError:blob = None
                if blob is not None and fmt == blob.rd_format_name:out[resource] = blob
                else:plan.warn('variant_unplaced:'+filename)
            return out
        # The last item is None for every draw of the mesh, else (component, spans) of the segments it textures.
        wanted = [(sid, value, shown[cid], default_file, filename, None) for (cid, _), (default_file, changes) in plan.slots.items()
                  for sid, value, filename in changes]
        for default_file, changes in plan.this.items():
            row = next((r for r in texture_rows if r['file'] == default_file), None)
            meshes = sorted({*row['meshes'], *row.get('unchanged', {})}) if row else []
            for sid, value, filename in changes:
                if not meshes:plan.warn('variant_unplaced:'+filename)
                wanted += [(sid, value, mesh, default_file, filename, None) for mesh in meshes]
        for (cid, _), changes in plan.partial.items():
            for sid, value, default_file, filename, spans in changes:
                # Only mod geometry draws a segment in a block of its own.
                if cid in geometric:wanted.append((sid, value, shown[cid], default_file, filename, (cid, set(spans))))
                else:plan.warn('variant_unplaced:'+filename)
        # A mesh the defaults leave as the template gets a clone of the template's bytes, for its variants to replace a texture of
        # and its switches' segments to hide.
        cloned |= {mesh for _, _, mesh, default_file, _, _ in wanted if resource_of(texture_rows, default_file, mesh) is not None}
        template_runs = {}
        for cid, spans in sorted(controlled.items()):
            if cid in geometric:continue
            mesh, section = shown[cid], components[cid].section
            first_index = next((o.keys.get('match_first_index') for o in mod.overrides if o.section == section), None) or '0'
            found = mod_settings.block_runs(mod, components[cid], int(first_index) if first_index.isdigit() else 0,
                                            [d for d in source['draws'] if d['mesh'] == mesh], read_blob, spans, plan.warn)
            if found is not None:template_runs[cid] = found; cloned.add(mesh)
        clones, group_blocks = [], {}
        for mesh in [m['mesh'] for m in palette['meshes'] if m['mesh'] in cloned]:
            textures = assigned.get((mesh, None), {})
            # A group of mod geometry draws with the mesh's textures, then the ones bound at its own segments.
            replacements, owners = [], []
            for c, r in sorted(geometric.items()):
                if r.replacement.mesh != mesh:continue
                owners.append(c)
                groups = []
                for k, g in enumerate(r.replacement.groups):
                    bound = assigned.get((mesh, (c, k)), {}) if k < own[c] else added_textures(c, mesh, k)
                    shared = {key: b for key, b in textures.items() if (key[1] if isinstance(key, tuple) else key) not in bound} if k >= own[c] else textures
                    groups.append(dataclasses.replace(g, textures={**shared, **bound}, condition=layouts[c][k][0], runs=layouts[c][k][1]))
                replacements.append(dataclasses.replace(r.replacement, groups=groups))
            # clone_mesh appends the appearance and refuses one already listed, so each later mesh starts without it.
            if clones:pack['appearances'].pop()
            clones.append(outfit_compose.clone_mesh(source, graph, palette, pack, put, replacements, appearance, read_blob=read_blob,
                                                    put_graph=put_graph, rig_ids=rig_ids, textures=textures, mesh=mesh))
            group_blocks.update({(c, k): sha for c, shas in zip(owners, clones[-1]['blocks']) for k, sha in enumerate(shas)})
        if not clones:pack['appearances'].append({k: appearance[k] for k in ('id', 'name', 'kind', 'source')})
        segments = [s for c in clones for s in c['segments']]
        blocks = {(d['mesh'], d['indices']['sha256']) for d in source['draws']}
        for cid, (sha, runs) in sorted(template_runs.items()):
            new = 'outfit:'+appearance['id']+'/'+shown[cid]
            # Another component's geometry on the mesh moves the template's indices.
            if (new, sha) not in blocks:plan.warn('segment_unmappable:'+components[cid].section)
            else:segments += [dict(mesh=new, indices_sha256=sha, first=f, count=n, visible_when=w) for f, n, w in runs]
        items = []
        for sid, value, mesh, default_file, filename, part in wanted:
            resource = resource_of(texture_rows, default_file, mesh)
            if resource is None:plan.warn('variant_unplaced:'+filename); continue
            new = 'outfit:'+appearance['id']+'/'+mesh
            if part is None:items.append((sid, value, new, resource, filename, None)); continue
            c, spans = part
            items += [(sid, value, new, resource, filename, group_blocks[c, k]) for k, layout in enumerate(layouts[c]) if spans & set(layout[2])]
        order = {s.id: i for i, s in enumerate(plan.settings)}
        variants, variant_textures, variant_bytes = mod_settings.place_variants(appearance['id'], source, sorted(items, key=lambda i: order[i[0]]),
                                                                                 texture, put, plan.warn)
        settings = mod_settings.entry(plan, segments, variant_textures)
        if settings['settings']:
            folder = pack_path.parent/'interaction'
            listed = any(r['file'] == mod_settings.FILE for r in pack['interaction']['data'])
            table = read_json(folder/mod_settings.FILE) if listed else dict(schema=mod_settings.SCHEMA, appearances={})
            table['appearances'][appearance['id']] = settings; write_json(folder/mod_settings.FILE, table)
            if not listed:pack['interaction']['data'].append(dict(file=mod_settings.FILE))
            if variants:source['texture_variants'] = source.get('texture_variants', [])+variants
        named = {s['id'] for s in settings['settings']}
        others = [a['id'] for a in pack['appearances'] if a['id'] != appearance['id']]
        for m in palette['meshes']:
            if m['mesh'].startswith('outfit:') or m['mesh'] in cloned:continue
            if m['mesh'] in hidden:
                if m.get('appearances') is None:m['appearances'] = others
            elif m.get('appearances') is not None:m['appearances'] = visible_in(m['appearances'], entry['default_appearance'], appearance['id'])
        progress('compose', 1); progress('write', 0)
        write_json(source_path, source)
        frame_ref = entry.get(native_bundle.VULKAN[0])
        graph['manifest_sha256'] = sha256_file(source_path); native_bundle.write_neutral(runtime, entry, graph)
        write_json(palette_path, palette); pack['animation']['palette_contract'] = ref(palette_path, animation)
        if (animation/'supplemental-clips.json').exists():
            clips = read_json(animation/'supplemental-clips.json'); clips['base_contract_sha256'] = sha256_file(palette_path)
            write_json(animation/'supplemental-clips.json', clips)
        for section in ['animation', 'interaction']:
            folder = pack_path.parent/section
            pack[section]['data'] = [dict(x, **ref(folder/x['file'], folder)) for x in pack[section]['data']]
        pack['render']['manifest'] = ref(source_path, source_path.parent); write_json(pack_path, pack)
        for key, path in (('source', source_path), ('graph', graph_path), ('c7', pack_path)):entry[key] = ref(path, runtime)
        if frame_ref:
            # The Windows frame table gets the clones from its own records; without one the character has no Windows section.
            frame_path = runtime/frame_ref['file']; character_dir = frame_path.parent.parent
            def read_any(r, where):
                path = (source_path.parent if where == 'source' else graph_path.parent)/r['file']
                if not path.is_file():path = source_path.parent/'Files'/(r['sha256']+'.bytes')
                stored = path.read_bytes(); raw = stored if len(stored) == r['byte_count'] else pool_codec.decode(stored)
                need(sha256_bytes(raw) == r['sha256'], 'file_sha_mismatch'); return raw
            table, written = vulkan_outfit.extend(character_dir, frame_path.read_bytes(), source, entry['source']['sha256'], entry['neutral_scene']['sha256'],
                                                  graph, palette, pack, rig, read_any)
            (character_dir/vulkan_outfit.OWN).mkdir(parents=True, exist_ok=True)
            for digest, raw in written.items():(character_dir/vulkan_outfit.OWN/digest).write_bytes(raw)
            frame_path.write_bytes(table); entry[native_bundle.VULKAN[0]] = ref(frame_path, runtime)
        cp = runtime/entry['coverage']['file']; write_json(cp, native_bundle.character_coverage(runtime, entry)); entry['coverage'] = ref(cp, runtime)
        kept = {}
        def reference(p, root):
            """ref(p, root); a file still as cloned (cp -c keeps size and mtime) keeps the hash of the installed package's inventory,
            which no later step hashes again; a file the import rewrote was read from a package file that must match it."""
            # String slices: p lies under root and root under tmp, and relative_to is slow over every file of a package.
            key = str(p)[len(str(tmp))+1:]; known = package.inventory.get(key)
            if known is None:return ref(p, root)
            a, b = p.stat(), (package.root/key).stat()
            if (a.st_size, a.st_mtime_ns) != (b.st_size, b.st_mtime_ns):
                need(sha256_file(package.root/key) == known['sha256'], 'file_sha_mismatch')
                return ref(p, root)
            rel = str(p)[len(str(root))+1:]; kept[rel] = known['sha256']
            return dict(file=rel, sha256=known['sha256'], byte_count=known['byte_count'])
        roles = {x['file']: x.get('roles', ['runtime_imported_outfit']) for x in native['files']}
        native['files'] = [dict(**reference(p, runtime), roles=roles.get(p.relative_to(runtime).as_posix(), ['runtime_imported_outfit']))
                           for p in sorted(runtime.rglob('*')) if p.is_file() and p != native_path]
        # verify hashes only what reference did not take from the installed package's inventory.
        write_json(native_path, native); native_bundle.verify(runtime, kept)
        definition['components']['render']['native_bundle'] = ref(native_path, tmp)
        # The host finds the window envelope of an imported package by the version it derives from.
        definition.setdefault('base_package_version', definition['version'])
        major, minor, patch = map(int, definition['version'].split('.')); definition['version'] = f'{major}.{minor}.{patch+1}'
        warnings += [w for w in plan.warnings if w.split(':', 1)[0] in mod_settings.REPORTED and w not in warnings]
        report = dict(schema='endfield-outfit-import/v1', character=package.id, version=definition['version'],
                      appearance=dict(id=appearance['id'], name=appearance['name']), source=appearance['source'],
                      scope='default state, the mod\'s switches as a table of segments and texture variants: a component with geometry '
                            'of its own replaces its submesh, other clones keep their template index and vertex bytes; shape keys, '
                            'morphs and the mod\'s shaders are not applied',
                      components=rows, geometry=geometry, textures=texture_rows, unused_textures=unused, warnings=warnings, clones=clones,
                      settings=dict(settings=len(named), fixed=plan.fixed, unused=[s.id for s in plan.settings if s.id not in named and s.id not in plan.fixed],
                                    segments=len(settings['segments']), variants=len(variants) if named else 0,
                                    variant_bytes=variant_bytes if named else 0, warnings=plan.warnings))
        write_json(tmp/'provenance'/('outfit-'+appearance['id']+'.json'), report)
        definition['inventory'] = [reference(p, tmp) for p in sorted(tmp.rglob('*')) if p.is_file() and p != tmp/'character.json']
        write_json(tmp/'character.json', definition); Package(tmp, deep=False); tmp.rename(output)
        progress('write', 1)
        return report
    finally:
        if tmp.exists():shutil.rmtree(tmp)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--package', type=Path, required=True, help='character package directory (holds character.json)')
    p.add_argument('--source', type=Path, required=True, help='EFMI mod directory (holds its .ini files)')
    p.add_argument('--output', type=Path, required=True, help='NEW directory for the package with the imported appearance')
    p.add_argument('--name', help='display name of the appearance; default the mod name')
    p.add_argument('--map', type=Path, help=MAP_SCHEMA+' file whose components and textures override the automatic match')
    a = p.parse_args(argv)
    print(json.dumps(import_outfit(a.package, a.source, a.output, a.name, a.map), ensure_ascii=False))


if __name__ == '__main__':
    main()
