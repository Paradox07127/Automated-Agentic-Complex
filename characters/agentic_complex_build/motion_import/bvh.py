"""BVH motion: the hierarchy and channel data, forward kinematics, and the take on the canonical joints.

Units and axes are kept as the file has them.
"""
import math
from pathlib import Path

import numpy as np

from character_library import digest
from .humanoid_map import canonical_arrays, finger_arrays, map_skeleton
from .take import MotionTake

MAX_JOINTS = 512
MAX_BYTES = 64 * 1024**2
MAX_SAMPLES = 4_000_000  # frames x joints
POSITIONS = ('Xposition', 'Yposition', 'Zposition')
ROTATIONS = ('Xrotation', 'Yrotation', 'Zrotation')


def _bad(reason):
    return ValueError('bad_source: ' + reason)


def parse(text):
    """(joints without End Sites, frame time in seconds, motion (F, C) in CHANNELS order)."""
    tokens = text.split(); cursor = [0]; joints = []

    def word():
        if cursor[0] >= len(tokens): raise _bad('truncated')
        cursor[0] += 1
        return tokens[cursor[0] - 1]

    def expect(*words):
        if any(word() != w for w in words): raise _bad('hierarchy')

    def number(token):
        try: value = float(token)
        except ValueError: raise _bad('number') from None
        if not math.isfinite(value): raise _bad('number')
        return value

    def offset():
        expect('OFFSET')
        return [number(word()) for _ in range(3)]

    def joint(parent):
        if len(joints) >= MAX_JOINTS: raise _bad('too_many_joints')
        index = len(joints); name = word(); expect('{')
        entry = {'name': name, 'parent': parent, 'offset': offset()}
        expect('CHANNELS'); count = word()
        if not count.isdigit() or int(count) > 6: raise _bad('channels')
        channels = [word() for _ in range(int(count))]
        if any(c not in POSITIONS + ROTATIONS for c in channels) or len(set(channels)) != len(channels): raise _bad('channels')
        entry['channels'] = channels; joints.append(entry)
        while (token := word()) != '}':
            if token == 'JOINT': joint(index)
            elif token == 'End':
                expect('Site', '{'); offset(); expect('}')
            else: raise _bad('hierarchy')
    expect('HIERARCHY', 'ROOT'); joint(-1); expect('MOTION', 'Frames:')
    frames = word()
    if not frames.isdigit(): raise _bad('frames')
    frames = int(frames)
    expect('Frame', 'Time:'); frame_time = number(word())
    if frame_time <= 0: raise _bad('frame_time')
    if frames * len(joints) > MAX_SAMPLES: raise _bad('too_many_samples')
    columns = sum(len(j['channels']) for j in joints); values = tokens[cursor[0]:]
    if len(values) != frames * columns: raise _bad('truncated')
    try: motion = np.array(values, float).reshape(frames, columns)
    except ValueError: raise _bad('number') from None
    if not np.isfinite(motion).all(): raise _bad('number')
    return joints, frame_time, motion


def _axis_rotation(axis, degrees):
    a = np.radians(degrees); c, s = np.cos(a), np.sin(a)
    i, j = ((1, 2), (2, 0), (0, 1))[axis]  # the plane the axis turns
    m = np.zeros(np.shape(a) + (3, 3)); m[..., axis, axis] = 1
    m[..., i, i] = c; m[..., j, j] = c; m[..., i, j] = -s; m[..., j, i] = s
    return m


def fk(joints, motion):
    """World positions (F, S, 3) and global rotations (F, S, 3, 3); rotation channels multiply on the right in file order."""
    F = len(motion); S = len(joints); column = 0
    xyz = np.zeros((F, S, 3)); R = np.zeros((F, S, 3, 3))
    for k, joint in enumerate(joints):
        t = np.tile(np.asarray(joint['offset'], float), (F, 1)); local = np.tile(np.eye(3), (F, 1, 1))
        for channel in joint['channels']:
            axis = 'XYZ'.index(channel[0]); values = motion[:, column]; column += 1
            if channel in POSITIONS: t[:, axis] = values
            else: local = local @ _axis_rotation(axis, values)
        p = joint['parent']
        if p < 0: xyz[:, k] = t; R[:, k] = local
        else: xyz[:, k] = xyz[:, p] + np.einsum('fij,fj->fi', R[:, p], t); R[:, k] = R[:, p] @ local
    return xyz, R


def _neutral(joints):
    """The OFFSET hierarchy with every channel at 0; its global rotations are identity."""
    xyz = np.zeros((len(joints), 3))
    for k, joint in enumerate(joints):
        xyz[k] = (xyz[joint['parent']] if joint['parent'] >= 0 else 0) + np.asarray(joint['offset'], float)
    return xyz


def _read(path, take):
    if take != 0: raise _bad('take')
    if Path(path).stat().st_size > MAX_BYTES: raise _bad('file_size')
    return parse(Path(path).read_text(encoding='utf-8', errors='replace'))


def _canonical(joints, xyz, R, override):
    """map_skeleton, canonical_arrays with the neutral pose as frame 0, the take's fingers and its warnings."""
    mapping, chain, unmapped = map_skeleton([j['name'] for j in joints], [j['parent'] for j in joints], override)
    xyz = np.concatenate([_neutral(joints)[None], xyz]); R = np.concatenate([np.tile(np.eye(3), (1, len(joints), 1, 1)), R])
    xyz_c, R_c, warnings = canonical_arrays(mapping, chain, xyz, R)
    return xyz_c, R_c, finger_arrays(mapping, xyz, R), unmapped, warnings + (['unmapped_bones'] if unmapped else [])


def probe(path, take=0):
    joints, frame_time, motion = _read(path, take)
    S = len(joints); _, _, _, _, warnings = _canonical(joints, np.zeros((0, S, 3)), np.zeros((0, S, 3, 3)), None)
    return {'takes': [{'index': 0, 'name': Path(path).name, 'duration_s': (len(motion) - 1) * frame_time,
                       'frames': len(motion), 'frame_rate': 1 / frame_time}],
            'has_face': False, 'has_camera': False, 'warnings': warnings}


def load(path, take=0, options=None):
    joints, frame_time, motion = _read(path, take)
    xyz, R = fk(joints, motion)
    xyz_c, R_c, fingers, unmapped, warnings = _canonical(joints, xyz, R, (options or {}).get('bone_map'))
    return MotionTake(format='bvh', source_name=Path(path).name, source_sha256=digest(path), frame_rate=1 / frame_time,
                      neutral=xyz_c[0], xyz=xyz_c[1:], R=R_c[1:], take=0, takes=1, source_frames=len(motion),
                      fingers=fingers, contacts=None, unmapped=unmapped, warnings=warnings + ['fingers_rest'])
