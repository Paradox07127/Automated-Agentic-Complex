"""Humanoid source skeletons onto the canonical joints by joint name, and source arrays in canonical order."""
import re

import numpy as np

from .take import CANONICAL

_SIDED = {'Shoulder': ('{side}shoulder', '{side}collar', '{s}clavicle'),
          'Arm': ('{side}arm', '{side}uparm', '{s}shoulder'),
          'ForeArm': ('{side}forearm', '{side}lowarm', '{s}elbow'),
          'Hand': ('{side}hand', '{s}wrist'),
          'Leg': ('{side}upleg', '{side}hip', '{s}thigh'),
          'Shin': ('{side}leg', '{side}knee', '{s}shin'),
          'Foot': ('{side}foot', '{side}ankle'),
          'ToeBase': ('{side}toebase', '{side}toe')}
# Normalized source names per canonical joint, first match wins. The spine between Hips and Neck1 comes from the
# hierarchy, not from names; CMU's and Mixamo's `neck` is the neck base, so CMU's `neck1` is only a fallback.
ALIASES = {'Hips': ('hips',), 'Neck1': ('neck', 'neck1'), 'Head': ('head',),
           **{side + joint: tuple(a.format(side=side.lower(), s=side[0].lower()) for a in aliases)
              for side in ('Left', 'Right') for joint, aliases in _SIDED.items()}}
REQUIRED = ('Hips', 'Neck1', 'Head') + tuple(side + joint for side in ('Left', 'Right')
                                             for joint in ('Arm', 'ForeArm', 'Hand', 'Leg', 'Shin', 'Foot'))
# Finger joints, 1 at the hand: canonical finger -> (Mixamo/BVH finger names, VRM 1.0 segments).
_FINGERS = {'Thumb': (('thumb',), ('Metacarpal', 'Proximal', 'Distal')),
            'Index': (('index',), ('Proximal', 'Intermediate', 'Distal')),
            'Middle': (('middle',), ('Proximal', 'Intermediate', 'Distal')),
            'Ring': (('ring',), ('Proximal', 'Intermediate', 'Distal')),
            'Little': (('pinky', 'little'), ('Proximal', 'Intermediate', 'Distal'))}
FINGERS = tuple(side + finger + str(n) for side in ('Left', 'Right') for finger in _FINGERS for n in (1, 2, 3))
ALIASES.update({side + finger + str(n): tuple('%shand%s%d' % (side.lower(), word, n) for word in words)
                for side in ('Left', 'Right') for finger, (words, _) in _FINGERS.items() for n in (1, 2, 3)})
_VRM_SIDED = {'Shoulder': 'Shoulder', 'UpperArm': 'Arm', 'LowerArm': 'ForeArm', 'Hand': 'Hand', 'UpperLeg': 'Leg',
              'LowerLeg': 'Shin', 'Foot': 'Foot', 'Toes': 'ToeBase'}
# VRM 1.0 humanoid bone names onto the canonical joints.
VRM_TO_CANONICAL = {'hips': 'Hips', 'spine': 'Spine1', 'chest': 'Spine2', 'upperChest': 'Chest', 'neck': 'Neck1', 'head': 'Head',
                    **{side + bone: side.capitalize() + joint for side in ('left', 'right') for bone, joint in _VRM_SIDED.items()}}
VRM_REQUIRED = tuple(bone for bone in VRM_TO_CANONICAL
                     if bone not in ('chest', 'upperChest', 'neck') and not bone.endswith(('Shoulder', 'Toes')))
VRM_FINGERS = {side + finger + segment: side.capitalize() + finger + str(n + 1) for side in ('left', 'right')
               for finger, (_, segments) in _FINGERS.items() for n, segment in enumerate(segments)}
HAND_TIP = 0.4  # of ForeArm->Hand past the hand
TOE = 0.12  # of the Leg->Shin->Foot length ahead of the foot
# Where a missing spine or neck joint goes, as a share of Hips->Head: the release library's two rigs (birch, aster)
# averaged, each humanoid spine bone's rest position (NativeRig.rest) projected onto its Hips->Head line.
SPINE_HEIGHTS = {'Hips': 0.0, 'Spine1': 0.1636, 'Spine2': 0.3166, 'Chest': 0.4696, 'Neck1': 0.8226, 'Head': 1.0}


def normalize(name):
    return re.sub(r'[_\-. ]', '', name.rsplit(':', 1)[-1].lower())


def _between(low, high, name, a, b):
    """name's position on the line from a (joint low) to b (joint high) by SPINE_HEIGHTS."""
    H = SPINE_HEIGHTS
    return a + (H[name] - H[low]) / (H[high] - H[low]) * (b - a)


def _synthesized(names):
    return ['synthesized_bones: ' + ','.join(name for name in CANONICAL if name in names)] if names else []


def map_skeleton(names, parents, override=None):
    """(canonical or finger name -> source index, source spine between Hips and Neck1, unused source names).

    Without Neck1 the spine runs from Hips to Head's parent."""
    mapping = {canonical: names.index(source) for canonical, source in (override or {}).items()
               if (canonical in CANONICAL or canonical in FINGERS) and source in names}
    normalized = [normalize(name) for name in names]
    for canonical, aliases in ALIASES.items():
        if canonical in mapping: continue
        used = set(mapping.values())
        found = next((i for alias in aliases for i, name in enumerate(normalized) if name == alias and i not in used), None)
        if found is not None: mapping[canonical] = found
    chain, linked = [], True; top = mapping.get('Neck1', mapping.get('Head'))
    if 'Hips' in mapping and top is not None:
        joint = parents[top]
        while joint not in (-1, mapping['Hips']):
            chain.append(joint); joint = parents[joint]
        linked = joint == mapping['Hips']; chain = chain[::-1] if linked else []
    missing = [name for name in CANONICAL if name in REQUIRED and name not in mapping
               and not (name == 'Neck1' and 'Head' in mapping)] + ([] if linked else ['Spine1'])
    if missing: raise ValueError('unmapped_skeleton: ' + ','.join(missing))
    used = set(mapping.values()) | set(chain)
    return mapping, chain, [name for i, name in enumerate(names) if i not in used]


def vrm_arrays(bones, xyz, R):
    """canonical_arrays for VRM humanoid bones (name -> source index); the spine comes by name, not from a chain."""
    missing = [VRM_TO_CANONICAL[bone] for bone in VRM_REQUIRED if bone not in bones]
    if missing: raise ValueError('unmapped_skeleton: ' + ','.join(missing))
    xyz = np.asarray(xyz, float); R = np.asarray(R, float)
    mapping = {VRM_TO_CANONICAL[bone]: i for bone, i in bones.items() if bone in VRM_TO_CANONICAL}
    extra = []  # (canonical name, position, rotation) as source columns past S
    # A synthesized joint turns with the real bone below it.
    if 'neck' in bones: neck = xyz[:, bones['neck']]
    else:
        below = next(bone for bone in ('upperChest', 'chest', 'spine') if bone in bones)
        neck = _between(VRM_TO_CANONICAL[below], 'Head', 'Neck1', xyz[:, bones[below]], xyz[:, bones['head']])
        extra.append(('Neck1', neck, R[:, bones[below]]))
    if 'chest' in bones: chest, chest_R = xyz[:, bones['chest']], R[:, bones['chest']]
    else:
        high = 'neck' if 'neck' in bones else 'head'
        chest = _between('Spine1', VRM_TO_CANONICAL[high], 'Spine2', xyz[:, bones['spine']], xyz[:, bones[high]])
        chest_R = R[:, bones['spine']]; extra.append(('Spine2', chest, chest_R))
    synthesized = _synthesized([name for name, _, _ in extra])
    if 'upperChest' not in bones:
        extra.append(('Chest', (chest + neck) / 2, chest_R))
    for side in ('left', 'right'):
        if side + 'MiddleProximal' in bones:
            extra.append((side.capitalize() + 'HandTip', xyz[:, bones[side + 'MiddleProximal']], R[:, bones[side + 'Hand']]))
    for k, (name, _, _) in enumerate(extra): mapping[name] = xyz.shape[1] + k
    if extra:
        xyz = np.concatenate([xyz, np.stack([p for _, p, _ in extra], 1)], 1)
        R = np.concatenate([R, np.stack([r for _, _, r in extra], 1)], 1)
    out, rot, warnings = canonical_arrays(mapping, [], xyz, R)
    return out, rot, synthesized + warnings


def vrm_fingers(bones, xyz, R):
    """finger_arrays for VRM humanoid bones (name -> source index)."""
    return finger_arrays({VRM_FINGERS[bone]: i for bone, i in bones.items() if bone in VRM_FINGERS}, xyz, R)


def finger_arrays(mapping, xyz, R):
    """MotionTake.fingers from the mapping's finger names: {name: (neutral position (3,), global rotations (F, 3, 3))};
    frame 0 of xyz and R must be the neutral pose and is left out of the rotations."""
    xyz = np.asarray(xyz, float); R = np.asarray(R, float)
    return {name: (xyz[0, i], R[1:, i]) for name, i in mapping.items() if name in FINGERS}


def canonical_arrays(mapping, chain, xyz, R):
    """Source positions (F, S, 3) and global rotations (F, S, 3, 3) on CANONICAL; frame 0 must be the neutral pose.

    With an empty chain mapping has Spine1, Spine2 and Chest or they go between Hips and Neck1 by SPINE_HEIGHTS; a missing
    Neck1 goes between Head and the chain's end (Hips without a chain). Finger names in mapping are left out."""
    xyz = np.asarray(xyz, float); R = np.asarray(R, float)
    F = len(xyz); at = {name: j for j, name in enumerate(CANONICAL)}
    out = np.zeros((F, len(CANONICAL), 3)); rot = np.tile(np.eye(3), (F, len(CANONICAL), 1, 1)); warnings = []

    def put(name, position, rotation):
        out[:, at[name]] = position; rot[:, at[name]] = rotation

    def warn(warning):
        if warning not in warnings: warnings.append(warning)
    for name, i in mapping.items():
        if name in at: put(name, xyz[:, i], R[:, i])
    c = [xyz[:, i] for i in chain]; r = [R[:, i] for i in chain]; n = len(chain); synthesized = []
    # A synthesized joint turns with the real bone below it.
    if 'Neck1' not in mapping:
        below = chain[-1] if chain else mapping['Hips']  # the chain's end becomes Spine1 (one link) or Chest
        put('Neck1', _between(('Hips', 'Spine1', 'Chest')[min(n, 2)], 'Head', 'Neck1', xyz[:, below], xyz[:, mapping['Head']]),
            R[:, below])
        synthesized.append('Neck1')
    neck = out[:, at['Neck1']]
    if n == 0 and all(name in mapping for name in ('Spine1', 'Spine2', 'Chest')): spine = []
    elif n == 0:
        hips = mapping['Hips']; synthesized += ['Spine1', 'Spine2', 'Chest']
        spine = [(_between('Hips', 'Neck1', name, xyz[:, hips], neck), R[:, hips]) for name in ('Spine1', 'Spine2', 'Chest')]
    elif n == 1: spine = [(c[0], r[0]), (c[0] + (neck - c[0]) / 3, r[0]), (c[0] + 2 * (neck - c[0]) / 3, r[0])]
    elif n == 2: spine = [(c[0], r[0]), ((c[0] + c[1]) / 2, r[0]), (c[1], r[1])]
    else: spine = [(c[0], r[0]), (c[n // 2], r[n // 2]), (c[n - 1], r[n - 1])]
    for name, (position, rotation) in zip(('Spine1', 'Spine2', 'Chest'), spine): put(name, position, rotation)
    warnings += _synthesized(synthesized)
    for side in ('Left', 'Right'):
        if side + 'Shoulder' not in mapping:
            put(side + 'Shoulder', (out[:, at['Chest']] + out[:, at[side + 'Arm']]) / 2, rot[:, at['Chest']])
            warn('shoulder_synthesized')
        if side + 'HandTip' not in mapping:
            hand, fore = out[:, at[side + 'Hand']], out[:, at[side + 'ForeArm']]
            put(side + 'HandTip', hand + HAND_TIP * (hand - fore), rot[:, at[side + 'Hand']])
            warn('hand_tip_synthesized')
    for side in ('Left', 'Right'):
        if side + 'ToeBase' in mapping: continue
        # Right-handed: cross(up, right) is the facing direction.
        up = out[0, at['Neck1']] - out[0, at['Hips']]; right = out[0, at['RightLeg']] - out[0, at['LeftLeg']]
        forward = np.cross(up, right); forward = forward / np.linalg.norm(forward)
        leg, shin, foot = (out[0, at[side + joint]] for joint in ('Leg', 'Shin', 'Foot'))
        offset = TOE * (np.linalg.norm(shin - leg) + np.linalg.norm(foot - shin)) * forward
        foot_rot = rot[:, at[side + 'Foot']]
        put(side + 'ToeBase', out[:, at[side + 'Foot']] + np.einsum('fij,j->fi', foot_rot, offset), foot_rot)
        warn('toe_synthesized')
    return out, rot, warnings
