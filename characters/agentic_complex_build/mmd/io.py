"""MMD file I/O: VMD reader/writer, PMD (bones + IK) reader, minimal PMD writer for fixtures, bezier sampling.

All values stay in the file's own left-handed MMD space; mmd_skeleton converts to right-handed.
"""
import struct
from dataclasses import dataclass, field
from pathlib import Path
import numpy as np

ENC = 'cp932'  # MMD writes Shift-JIS (Windows code page 932)
VMD_MAGIC = b'Vocaloid Motion Data 0002'
FPS = 30


def decode_name(raw):
    raw = raw.split(b'\0', 1)[0]
    # A name cut at the field width can end in half of a double-byte character.
    for cut in (len(raw), len(raw) - 1):
        try:
            return raw[:cut].decode(ENC)
        except UnicodeDecodeError:
            pass
    return raw.decode(ENC, 'replace')


def encode_name(name, width, errors='strict'):
    b = name.encode(ENC, errors)[:width]
    return b + b'\0' * (width - len(b))


def name_key(name, width=15):
    """Name as VMD can store it (15 bytes), used to match PMD bone names against VMD keys."""
    return decode_name(encode_name(name, width, 'replace'))  # a name decoded with U+FFFD must still give a key


# ---------------------------------------------------------------- VMD
@dataclass
class BoneKey:
    name: str
    frame: int
    pos: tuple
    rot: tuple  # x, y, z, w
    interp: bytes = b''


@dataclass
class MorphKey:
    name: str
    frame: int
    weight: float


@dataclass
class Vmd:
    model: str = ''
    bones: list = field(default_factory=list)
    morphs: list = field(default_factory=list)
    cameras: list = field(default_factory=list)   # (frame, distance, pos3, rot3, interp24 bytes, fov, perspective)
    lights: list = field(default_factory=list)    # (frame, color3, direction3)
    shadows: list = field(default_factory=list)   # (frame, mode, distance)
    iks: list = field(default_factory=list)       # (frame, visible, [(ik bone name, enabled)])
    sections: int = 6  # sections present after the header; older files end early


def interp_bytes(x=(20, 20, 107, 107), y=None, z=None, r=None):
    """64-byte VMD interpolation block from (x1, y1, x2, y2) control points (0..127) per channel."""
    y = x if y is None else y
    z = x if z is None else z
    r = x if r is None else r
    row = []
    for i in range(4):
        row += [x[i], y[i], z[i], r[i]]
    block = list(row)
    for k in range(1, 4):  # MMD stores three shifted copies of the first row
        block += row[k:] + [1] + [0] * (k - 1)
    return bytes(block)


LINEAR = interp_bytes()


def interp_points(interp):
    """(4, 4) array: rows X, Y, Z, R; columns x1, y1, x2, y2 (bytes [c, c+4, c+8, c+12])."""
    b = np.frombuffer(bytes(interp[:16]), np.uint8).astype(float)
    return np.stack([b[[c, c + 4, c + 8, c + 12]] for c in range(4)])


def bezier(t, cp):
    """MMD bezier easing: solve x(s) = t on the curve (0,0),(x1,y1),(x2,y2),(1,1), return y(s).
    cp is (..., 4); its leading axes broadcast against t."""
    x1, y1, x2, y2 = np.moveaxis(np.asarray(cp, float) / 127.0, -1, 0)
    t = np.asarray(t, float)
    lo = np.zeros_like(t)
    hi = np.ones_like(t)
    for _ in range(50):  # x(s) is monotonic for control points inside [0, 1]
        s = (lo + hi) / 2
        xs = 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s * s * x2 + s ** 3
        lo = np.where(xs < t, s, lo)
        hi = np.where(xs < t, hi, s)
    s = (lo + hi) / 2
    return 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s * s * y2 + s ** 3


def read_vmd(path):
    data = Path(path).read_bytes()
    if not data.startswith(VMD_MAGIC):
        raise ValueError('not a VMD 0002 file')
    v = Vmd(model=decode_name(data[30:50]))
    o = 50
    sections = 0

    def count():
        nonlocal o
        if o + 4 > len(data):
            return None
        n = struct.unpack_from('<I', data, o)[0]
        o += 4
        return n

    n = count()
    if n is not None:
        sections += 1
        for _ in range(n):
            name = decode_name(data[o:o + 15])
            frame, px, py, pz, qx, qy, qz, qw = struct.unpack_from('<I3f4f', data, o + 15)
            v.bones.append(BoneKey(name, frame, (px, py, pz), (qx, qy, qz, qw), data[o + 47:o + 111]))
            o += 111
    n = count()
    if n is not None:
        sections += 1
        for _ in range(n):
            frame, w = struct.unpack_from('<If', data, o + 15)
            v.morphs.append(MorphKey(decode_name(data[o:o + 15]), frame, w))
            o += 23
    n = count()
    if n is not None:
        sections += 1
        for _ in range(n):
            frame, dist, px, py, pz, rx, ry, rz = struct.unpack_from('<If3f3f', data, o)
            interp = data[o + 32:o + 56]
            fov, persp = struct.unpack_from('<IB', data, o + 56)
            v.cameras.append((frame, dist, (px, py, pz), (rx, ry, rz), interp, fov, persp))
            o += 61
    n = count()
    if n is not None:
        sections += 1
        for _ in range(n):
            frame, r, g, b, x, y, z = struct.unpack_from('<I3f3f', data, o)
            v.lights.append((frame, (r, g, b), (x, y, z)))
            o += 28
    n = count()
    if n is not None:
        sections += 1
        for _ in range(n):
            frame, mode, dist = struct.unpack_from('<IBf', data, o)
            v.shadows.append((frame, mode, dist))
            o += 9
    n = count()
    if n is not None:
        sections += 1
        for _ in range(n):
            frame, visible, nik = struct.unpack_from('<IBI', data, o)
            o += 9
            states = []
            for _ in range(nik):
                states.append((decode_name(data[o:o + 20]), bool(data[o + 20])))
                o += 21
            v.iks.append((frame, visible, states))
    v.sections = sections
    return v


def write_vmd(v, path=None):
    out = bytearray(VMD_MAGIC + b'\0' * (30 - len(VMD_MAGIC)) + encode_name(v.model, 20))
    sec = [len(v.bones), len(v.morphs), len(v.cameras), len(v.lights), len(v.shadows), len(v.iks)]
    if any(sec[v.sections:]):
        raise ValueError('data in a section beyond Vmd.sections')
    for s in range(v.sections):
        out += struct.pack('<I', sec[s])
        if s == 0:
            for k in v.bones:
                interp = k.interp if k.interp else LINEAR
                out += encode_name(k.name, 15) + struct.pack('<I3f4f', k.frame, *k.pos, *k.rot) + bytes(interp)
        elif s == 1:
            for k in v.morphs:
                out += encode_name(k.name, 15) + struct.pack('<If', k.frame, k.weight)
        elif s == 2:
            for frame, dist, pos, rot, interp, fov, persp in v.cameras:
                out += struct.pack('<If3f3f', frame, dist, *pos, *rot) + bytes(interp) + struct.pack('<IB', fov, persp)
        elif s == 3:
            for frame, color, direction in v.lights:
                out += struct.pack('<I3f3f', frame, *color, *direction)
        elif s == 4:
            for frame, mode, dist in v.shadows:
                out += struct.pack('<IBf', frame, mode, dist)
        elif s == 5:
            for frame, visible, states in v.iks:
                out += struct.pack('<IBI', frame, visible, len(states))
                for name, enabled in states:
                    out += encode_name(name, 20) + bytes([1 if enabled else 0])
    if path is not None:
        Path(path).write_bytes(bytes(out))
    return bytes(out)


def _slerp(q0, q1, t):
    q0 = np.asarray(q0, float)
    q1 = np.asarray(q1, float).copy()
    d = np.sum(q0 * q1, -1)
    q1[d < 0] *= -1
    d = np.abs(d)
    t = np.asarray(t, float)[..., None]
    theta = np.arccos(np.clip(d, -1, 1))[..., None]
    small = theta < 1e-6
    s = np.sin(np.where(small, 1, theta))
    a = np.where(small, 1 - t, np.sin((1 - t) * theta) / s)
    b = np.where(small, t, np.sin(t * theta) / s)
    q = a * q0 + b * q1
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def sample_bone_keys(keys, n_frames, frame_times=None):
    """Per-frame (pos (F,3), quat xyzw (F,4)) for one bone's keys.

    The interpolation stored on a key shapes the segment that ends at that key; outside the keyed range the
    nearest key is held. Duplicate frames keep the last key, as MMD does on load."""
    byframe = {}
    for k in keys:
        byframe[k.frame] = k
    ks = [byframe[f] for f in sorted(byframe)]
    kf = np.array([k.frame for k in ks], float)
    kp = np.array([k.pos for k in ks], float)
    kq = np.array([k.rot for k in ks], float)
    kq /= np.linalg.norm(kq, axis=1, keepdims=True)
    f = np.arange(n_frames, dtype=float) if frame_times is None else np.asarray(frame_times, float)
    out_frames = len(f)
    pos = np.zeros((out_frames, 3))
    rot = np.zeros((out_frames, 4))
    if len(ks) == 1:
        pos[:] = kp[0]
        rot[:] = kq[0]
        return pos, rot
    i1 = np.clip(np.searchsorted(kf, f, side='right'), 1, len(ks) - 1)
    i0 = i1 - 1
    span = kf[i1] - kf[i0]
    t = np.clip((f - kf[i0]) / span, 0, 1)
    cps = np.stack([interp_points(k.interp if k.interp else LINEAR) for k in ks])  # (K, 4, 4)
    u = bezier(t[:, None], cps[i1])  # (F, 4): X, Y, Z, R easing of each frame's segment
    pos[:] = kp[i0] + (kp[i1] - kp[i0]) * u[:, :3]
    rot[:] = _slerp(kq[i0], kq[i1], u[:, 3])
    return pos, rot


def sample_vmd(v, n_frames=None, frame_times=None):
    """{bone name: (pos, quat)} sampled at frames 0..n_frames-1 (or continuous frame_times), file coordinates."""
    if frame_times is not None:
        n_frames = len(frame_times)
    elif n_frames is None:
        n_frames = last_frame(v) + 1
    by = {}
    for k in v.bones:
        by.setdefault(k.name, []).append(k)
    return {name: sample_bone_keys(keys, n_frames, frame_times=frame_times) for name, keys in by.items()}


def last_frame(v):
    frames = [k.frame for k in v.bones] + [k.frame for k in v.morphs] + [k[0] for k in v.iks]
    return max(frames) if frames else 0


def detect_source_fps(v, morph_vmd=None):
    """Infer source VMD authoring frame rate (30.0 or 60.0) from keyframe cadence and optional paired 30fps morph VMD."""
    body_max = max((k.frame for k in v.bones), default=0)
    if morph_vmd is not None and getattr(morph_vmd, 'morphs', None):
        morph_max = max(k.frame for k in morph_vmd.morphs)
        if body_max >= 120 and morph_max >= 30 and 1.75 <= (body_max / morph_max) <= 2.25:
            return 60.0
    by = {}
    for k in v.bones:
        by.setdefault(k.name, []).append(k.frame)
    unit_steps, total_steps = 0, 0
    for frames in by.values():
        fs = sorted(set(frames))
        if len(fs) < 120:
            continue
        diffs = np.diff(fs)
        unit_steps += int(np.sum(diffs == 1))
        total_steps += len(diffs)
    if total_steps >= 500 and (unit_steps / total_steps) >= 0.85 and body_max >= 3600:
        return 60.0
    return float(FPS)


def ik_enabled(v, n_frames, frame_times=None):
    """{ik bone name: bool (F,)}; a property key holds until the next one, IK defaults to on."""
    out = {}
    ft = None if frame_times is None else np.asarray(frame_times, float)
    count = len(ft) if ft is not None else n_frames
    for frame, _, states in sorted(v.iks, key=lambda x: x[0]):
        for name, enabled in states:
            arr = out.setdefault(name, np.ones(count, bool))
            if ft is None:
                arr[frame:] = enabled
            else:
                arr[ft >= frame] = enabled
    return out


# ---------------------------------------------------------------- PMD
@dataclass
class PmdBone:
    name: str
    parent: int  # -1 = none (0xFFFF in file)
    tail: int
    type: int
    ik: int
    pos: tuple


@dataclass
class PmdIK:
    bone: int      # IK bone (e.g. 左足ＩＫ), its position is the goal
    target: int    # effector moved onto the goal (e.g. 左足首)
    iterations: int
    limit: float   # raw control weight; three.js MMDLoader uses limit * 4 as the per-step angle cap in radians
    chain: list    # link bones, effector side first


@dataclass
class Pmd:
    name: str = ''
    comment: str = ''
    version: float = 1.0
    bones: list = field(default_factory=list)
    iks: list = field(default_factory=list)
    n_vertices: int = 0
    n_face_indices: int = 0
    n_materials: int = 0


def read_pmd(path):
    data = Path(path).read_bytes()
    if data[:3] != b'Pmd':
        raise ValueError('not a PMD file')
    version = struct.unpack_from('<f', data, 3)[0]
    p = Pmd(name=decode_name(data[7:27]), comment=decode_name(data[27:283]), version=version)
    o = 283
    p.n_vertices = struct.unpack_from('<I', data, o)[0]
    o += 4 + 38 * p.n_vertices          # pos3 normal3 uv2 (f32), bone 2xu16, weight u8, edge u8
    p.n_face_indices = struct.unpack_from('<I', data, o)[0]
    o += 4 + 2 * p.n_face_indices
    p.n_materials = struct.unpack_from('<I', data, o)[0]
    o += 4 + 70 * p.n_materials         # rgba, power, specular3, ambient3, toon u8, edge u8, count u32, file 20
    nb = struct.unpack_from('<H', data, o)[0]
    o += 2
    for _ in range(nb):
        name = decode_name(data[o:o + 20])
        parent, tail, typ, ik, x, y, z = struct.unpack_from('<HHBH3f', data, o + 20)
        p.bones.append(PmdBone(name, -1 if parent == 0xFFFF else parent, tail, typ, ik, (x, y, z)))
        o += 39
    nik = struct.unpack_from('<H', data, o)[0]
    o += 2
    for _ in range(nik):
        bone, target, length, iters, limit = struct.unpack_from('<HHBHf', data, o)
        o += 11
        chain = list(struct.unpack_from('<%dH' % length, data, o))
        o += 2 * length
        p.iks.append(PmdIK(bone, target, iters, limit, chain))
    return p


def write_pmd(p, path=None, dummy_geometry=True):
    """Minimal PMD v1: optional dummy triangle/material (so readers must skip them), bones, IK, empty tail sections."""
    out = bytearray(b'Pmd' + struct.pack('<f', p.version) + encode_name(p.name, 20) + encode_name(p.comment, 256))
    nv = 3 if dummy_geometry else 0
    out += struct.pack('<I', nv)
    for i in range(nv):
        out += struct.pack('<3f3f2f2HBB', float(i), 1.0, 0.0, 0, 0, 1, 0.0, 0.0, 0, 0, 100, 0)
    out += struct.pack('<I', nv)
    out += struct.pack('<%dH' % nv, *range(nv))
    nm = 1 if dummy_geometry else 0
    out += struct.pack('<I', nm)
    for _ in range(nm):
        out += struct.pack('<4ff3f3fBBI', 1, 1, 1, 1, 5.0, 0, 0, 0, .5, .5, .5, 0, 1, nv) + encode_name('', 20)
    out += struct.pack('<H', len(p.bones))
    for b in p.bones:
        out += encode_name(b.name, 20) + struct.pack('<HHBH3f', 0xFFFF if b.parent < 0 else b.parent, b.tail, b.type, b.ik, *b.pos)
    out += struct.pack('<H', len(p.iks))
    for k in p.iks:
        out += struct.pack('<HHBHf', k.bone, k.target, len(k.chain), k.iterations, k.limit) + struct.pack('<%dH' % len(k.chain), *k.chain)
    out += struct.pack('<HBBI', 0, 0, 0, 0)  # morphs, morph display, bone display names, bone display
    if path is not None:
        Path(path).write_bytes(bytes(out))
    return bytes(out)
