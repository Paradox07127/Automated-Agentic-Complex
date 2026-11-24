"""glTF 2.0 motion: GLB/JSON reading, accessors, animation sampling, forward kinematics, rotations and the humanoid take.

Node TRS are kept as the file has them: metres, Y up, quaternions (x, y, z, w).
"""
import base64
import json
from pathlib import Path
import struct
from urllib.parse import unquote, urlsplit

import numpy as np

from character_library import digest
from .humanoid_map import canonical_arrays, finger_arrays, map_skeleton
from .take import FPS, Expression, MotionTake

MAX_BYTES = 256 * 1024**2
MAX_SAMPLES = 4_000_000  # frames x nodes
COMPONENTS = {5120: ('i1', 127), 5121: ('u1', 255), 5122: ('<i2', 32767), 5123: ('<u2', 65535), 5126: ('<f4', None)}
WIDTHS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
PATHS = ('translation', 'rotation', 'scale', 'weights')


def _bad(reason):
    return ValueError('bad_source: ' + reason)


def _glb(data):
    """(JSON document, BIN chunk or None) of a GLB 2 file."""
    if len(data) < 20: raise _bad('glb')
    _, version, length = struct.unpack_from('<4sII', data)
    if version != 2 or length > len(data): raise _bad('glb')
    offset = 12; document = bin = None
    while offset + 8 <= length:
        size, kind = struct.unpack_from('<I4s', data, offset); chunk = data[offset + 8:offset + 8 + size]
        if document is None:
            if kind != b'JSON': raise _bad('glb')
            document = chunk
        elif kind == b'BIN\0' and bin is None: bin = chunk
        offset += 8 + size
    if document is None: raise _bad('glb')
    return document, bin


def _buffer(base, buffer, index, bin):
    uri = buffer.get('uri')
    if uri is None:
        if index != 0 or bin is None: raise _bad('buffer')
        return bin
    if uri.startswith('data:'):
        header, _, payload = uri.partition(',')
        if not header.endswith(';base64'): raise _bad('data_uri')
        try: return base64.b64decode(payload, validate=True)
        except ValueError: raise _bad('data_uri') from None
    name = unquote(uri)
    if urlsplit(uri).scheme or Path(name).is_absolute(): raise _bad('external_uri')
    path = (base / name).resolve()
    if not path.is_relative_to(base.resolve()): raise _bad('external_uri')
    if path.stat().st_size > MAX_BYTES: raise _bad('file_size')
    return path.read_bytes()


def read(path):
    path = Path(path)
    if path.stat().st_size > MAX_BYTES: raise _bad('file_size')
    data = path.read_bytes()
    text, bin = _glb(data) if data[:4] == b'glTF' else (data, None)
    try: doc = json.loads(text)
    except ValueError: raise _bad('json') from None
    if not isinstance(doc, dict): raise _bad('json')
    buffers = []
    for index, buffer in enumerate(doc.get('buffers', [])):
        content = _buffer(path.parent, buffer, index, bin)
        # A GLB BIN chunk may carry up to 3 bytes of padding past byteLength.
        if len(content) < buffer['byteLength']: raise _bad('buffer')
        buffers.append(bytes(content[:buffer['byteLength']]))
    return {'json': doc, 'buffers': buffers, 'base': path.parent}


def packed(path, folder):
    """path when its buffers are all inside it, else a GLB of it in folder with every buffer in the BIN chunk: the library keeps
    one file of an import, which must bake again alone."""
    source = read(path); doc = source['json']
    if all(b.get('uri') is None or b['uri'].startswith('data:') for b in doc.get('buffers', [])): return Path(path)
    blob, offsets = bytearray(), []
    for content in source['buffers']: offsets.append(len(blob)); blob += content + bytes(-len(content) % 4)
    doc = dict(doc, buffers=[{'byteLength': len(blob)}],
               bufferViews=[dict(v, buffer=0, byteOffset=v.get('byteOffset', 0) + offsets[v['buffer']]) for v in doc.get('bufferViews', [])])
    text = json.dumps(doc, separators=(',', ':')).encode(); text += b' ' * (-len(text) % 4)
    out = Path(folder) / (Path(path).stem + '.glb')
    out.write_bytes(struct.pack('<4sII', b'glTF', 2, 28 + len(text) + len(blob)) + struct.pack('<I4s', len(text), b'JSON') + text
                    + struct.pack('<I4s', len(blob), b'BIN\0') + bytes(blob))
    return out


def accessor(doc, buffers, i):
    """(count,) for SCALAR, else (count, width), as float64; normalized integers per the glTF 2.0 formulas."""
    a = doc['accessors'][i]
    if 'sparse' in a: raise _bad('sparse_accessor')
    if a['componentType'] not in COMPONENTS or a['type'] not in WIDTHS: raise _bad('accessor')
    dtype, scale = COMPONENTS[a['componentType']]; width = WIDTHS[a['type']]; count = a['count']
    if (scale is not None) != bool(a.get('normalized', False)): raise _bad('accessor')
    if 'bufferView' not in a: values = np.zeros((count, width))
    else:
        view = doc['bufferViews'][a['bufferView']]; data = buffers[view['buffer']]
        start = view.get('byteOffset', 0); length = view['byteLength']; offset = a.get('byteOffset', 0)
        item = np.dtype(dtype).itemsize; stride = view.get('byteStride', item * width)
        if start + length > len(data) or (count and offset + stride * (count - 1) + item * width > length):
            raise _bad('accessor')
        values = np.ndarray((count, width), dtype, memoryview(data)[start:start + length], offset,
                            (stride, item)).astype(float)
        if scale is not None: values = np.maximum(values / scale, -1.0)
    return values[:, 0] if width == 1 else values


def _span(doc, animation):
    """(start, end) seconds over the animation's sampler inputs, from the min/max glTF requires on them."""
    inputs = [doc['accessors'][s['input']] for s in animation['samplers']]
    return min((a['min'][0] for a in inputs), default=0.0), max((a['max'][0] for a in inputs), default=0.0)


def _frames(start, end, fps):
    return int(np.floor((end - start) * fps + 1e-6)) + 1


def animations(doc):
    out = []
    for index, animation in enumerate(doc.get('animations', [])):
        start, end = _span(doc, animation)
        out.append({'index': index, 'name': animation.get('name') or 'animation %d' % index, 'duration_s': end - start})
    return out


def _quat_matrix(q):
    """(..., 4) quaternions (x, y, z, w), not necessarily unit, to (..., 3, 3)."""
    q = q / np.linalg.norm(q, axis=-1, keepdims=True); x, y, z, w = np.moveaxis(q, -1, 0)
    return np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
                     2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
                     2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1).reshape(q.shape[:-1] + (3, 3))


def _matrix_quat(R):
    trace = np.trace(R)
    if trace > 0:
        s = 2 * np.sqrt(trace + 1)
        return np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1], s * s / 4]) / s
    i = int(np.argmax(np.diag(R))); j, k = (i + 1) % 3, (i + 2) % 3
    s = 2 * np.sqrt(1 + R[i, i] - R[j, j] - R[k, k]); q = np.zeros(4)
    q[i] = s / 4; q[j] = (R[j, i] + R[i, j]) / s; q[k] = (R[k, i] + R[i, k]) / s; q[3] = (R[k, j] - R[j, k]) / s
    return q


def _rest(node):
    """The node's default (translation, rotation, scale); a matrix is split with a mirror put on the X scale."""
    if 'matrix' in node:
        M = np.asarray(node['matrix'], float).reshape(4, 4).T  # column-major in the file
        scale = np.linalg.norm(M[:3, :3], axis=0); R = M[:3, :3] / scale
        if np.linalg.det(R) < 0: scale[0] = -scale[0]; R[:, 0] = -R[:, 0]
        return M[:3, 3], _matrix_quat(R), scale
    return (np.asarray(node.get('translation', (0, 0, 0)), float), np.asarray(node.get('rotation', (0, 0, 0, 1)), float),
            np.asarray(node.get('scale', (1, 1, 1)), float))


def _slerp(a, b, s):
    """The glTF 2.0 spherical linear interpolation, taking the shorter arc."""
    d = np.sum(a * b, -1, keepdims=True); b = np.where(d < 0, -b, b); d = np.abs(d)
    angle = np.arccos(np.clip(d, -1, 1)); sin = np.sin(angle); near = sin < 1e-9
    safe = np.where(near, 1, sin)
    wa = np.where(near, 1 - s, np.sin((1 - s) * angle) / safe); wb = np.where(near, s, np.sin(s * angle) / safe)
    out = wa * a + wb * b
    return out / np.linalg.norm(out, axis=-1, keepdims=True)


def _interpolate(keys, values, times, mode, rotation):
    """values: (K, width), or (K, 3, width) for CUBICSPLINE as (in-tangent, value, out-tangent); clamped outside the keys."""
    count = len(keys)
    if mode == 'STEP' or count == 1:
        index = np.clip(np.searchsorted(keys, times, side='right') - 1, 0, count - 1)
        return (values[:, 1] if mode == 'CUBICSPLINE' else values)[index]
    k = np.clip(np.searchsorted(keys, times, side='right') - 1, 0, count - 2)
    step = keys[k + 1] - keys[k]; s = np.clip((times - keys[k]) / step, 0, 1)[:, None]
    if mode == 'LINEAR':
        a, b = values[k], values[k + 1]
        return _slerp(a, b, s) if rotation else a + s * (b - a)
    s2, s3 = s * s, s * s * s; step = step[:, None]
    out = ((2 * s3 - 3 * s2 + 1) * values[k, 1] + step * (s3 - 2 * s2 + s) * values[k, 2]
           + (3 * s2 - 2 * s3) * values[k + 1, 1] + step * (s3 - s2) * values[k + 1, 0])
    return out / np.linalg.norm(out, axis=-1, keepdims=True) if rotation else out


def sample(doc, buffers, anim_index, fps=FPS):
    """Every node's TRS at fps from the animation's first key to its last; unanimated channels hold the node default."""
    animation = doc['animations'][anim_index]; nodes = doc.get('nodes', [])
    start, end = _span(doc, animation); F = _frames(start, end, fps)
    if F * max(len(nodes), 1) > MAX_SAMPLES: raise _bad('too_many_samples')
    times = start + np.arange(F) / fps
    trs = {k: dict(zip(('translation', 'rotation', 'scale'), (np.tile(v, (F, 1)) for v in _rest(node))))
           for k, node in enumerate(nodes)}
    weights = {}
    for channel in animation['channels']:
        target = channel['target']; node = target.get('node'); path = target.get('path')
        if node is None or path not in PATHS: continue
        sampler = animation['samplers'][channel['sampler']]; mode = sampler.get('interpolation', 'LINEAR')
        if mode not in ('STEP', 'LINEAR', 'CUBICSPLINE'): raise _bad('sampler')
        keys = accessor(doc, buffers, sampler['input']); values = accessor(doc, buffers, sampler['output'])
        parts = 3 if mode == 'CUBICSPLINE' else 1
        if keys.ndim != 1 or not len(keys) or np.any(np.diff(keys) <= 0) or values.size % (len(keys) * parts):
            raise _bad('sampler')
        width = values.size // (len(keys) * parts)
        if path != 'weights' and width != (4 if path == 'rotation' else 3): raise _bad('sampler')
        values = values.reshape((len(keys), 3, width) if parts == 3 else (len(keys), width))
        value = _interpolate(keys, values, times, mode, path == 'rotation')
        if path == 'weights': weights[node] = value
        else: trs[node][path] = value
    return {'times': times, 'trs': trs, 'weights': weights}


def parents(doc):
    nodes = doc.get('nodes', []); parent = [-1] * len(nodes)
    for p, node in enumerate(nodes):
        for child in node.get('children', []):
            if child == p or parent[child] != -1: raise _bad('hierarchy')
            parent[child] = p
    return parent


def world(doc, trs, frames):
    """(frames, N, 4, 4) world matrices with scale; trs values broadcast to frames, missing nodes take their default."""
    nodes = doc.get('nodes', []); parent = parents(doc)
    order = [k for k in range(len(nodes)) if parent[k] < 0]
    for k in order: order.extend(nodes[k].get('children', []))
    if len(order) != len(nodes): raise _bad('hierarchy')
    G = np.zeros((frames, len(nodes), 4, 4))
    for k in order:
        t, q, s = (trs[k][p] for p in ('translation', 'rotation', 'scale')) if k in trs else _rest(nodes[k])
        local = np.zeros((frames, 4, 4))
        local[:, :3, :3] = _quat_matrix(np.broadcast_to(q, (frames, 4))) * np.broadcast_to(s, (frames, 3))[:, None, :]
        local[:, :3, 3] = np.broadcast_to(t, (frames, 3)); local[:, 3, 3] = 1
        G[:, k] = G[:, parent[k]] @ local if parent[k] >= 0 else local
    return G


def rotations(G):
    """The rotation of each G[..., :3, :3] with scale and shear taken out (polar decomposition)."""
    M = G[..., :3, :3]
    if np.any(np.linalg.det(M) < 0): raise _bad('mirrored_node')
    U, _, Vt = np.linalg.svd(M)
    return U @ Vt


def open_take(path, take):
    """(document, the take sampled at FPS, number of takes)."""
    source = read(path); doc = source['json']; takes = len(doc.get('animations', []))
    if not takes: raise ValueError('no_animation')
    if not 0 <= take < takes: raise _bad('take')
    return doc, sample(doc, source['buffers'], take), takes


def neutral_first(doc, trs, frames, nodes):
    """World positions with scale (frames + 1, n, 3) and global rotations relative to the neutral pose (frames + 1, n, 3, 3)
    of the given nodes; frame 0 is the neutral pose, every node at its default TRS."""
    rest = world(doc, {}, 1)[:, nodes]; G = np.concatenate([rest, world(doc, trs, frames)[:, nodes]])
    return G[..., :3, 3], rotations(G) @ np.swapaxes(rotations(rest), -1, -2)


def load(path, take=0, options=None):
    """The take on the canonical joints, its nodes mapped by name; morph weights become expressions."""
    doc, s, takes = open_take(path, take); nodes = doc.get('nodes', [])
    names = [node.get('name') or 'node %d' % k for k, node in enumerate(nodes)]
    mapping, chain, unmapped = map_skeleton(names, parents(doc), (options or {}).get('bone_map'))
    used = sorted(set(mapping.values()) | set(chain)); column = {k: c for c, k in enumerate(used)}
    xyz, R = neutral_first(doc, s['trs'], len(s['times']), used)
    columns = {name: column[k] for name, k in mapping.items()}; fingers = finger_arrays(columns, xyz, R)
    xyz, R, warnings = canonical_arrays(columns, [column[k] for k in chain], xyz, R)
    expressions = []
    for node, values in s['weights'].items():
        mesh = nodes[node].get('mesh')
        targets = doc['meshes'][mesh].get('extras', {}).get('targetNames', []) if mesh is not None else []
        for i in range(values.shape[1]):
            expressions.append(Expression('%s#%s' % (names[node], targets[i] if i < len(targets) else i), values[:, i]))
    warnings += (['unmapped_bones'] if unmapped else []) + (['expressions_not_applied'] if expressions else [])
    return MotionTake(format='gltf', source_name=Path(path).name, source_sha256=digest(path), frame_rate=float(FPS),
                      neutral=xyz[0], xyz=xyz[1:], R=R[1:], take=take, takes=takes, source_frames=len(s['times']),
                      fingers=fingers, expressions=tuple(expressions), unmapped=unmapped, warnings=warnings + ['fingers_rest'])


def probe(path, take=0):
    doc = read(path)['json']; takes = animations(doc)
    if not takes: raise ValueError('no_animation')
    if not 0 <= take < len(takes): raise _bad('take')
    for entry in takes:
        entry.update(frames=_frames(0, entry['duration_s'], FPS), frame_rate=float(FPS))
    has_face = any(c['target'].get('path') == 'weights' for c in doc['animations'][take]['channels'])
    return {'takes': takes, 'has_face': has_face, 'has_camera': False, 'warnings': []}
