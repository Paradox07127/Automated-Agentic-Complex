"""Pose family of a baked clip at its first and last frame: the nearest base loop of the same stance.

The gap between two poses is the largest key-bone distance in centimetres after moving the hips to the
origin and turning the facing (the horizontal right-to-left thigh axis) onto +x about Unity up (y). Stances are
stance.py's, from the same frames. Writes the endfield-pose-families/v1 document a C7 pack carries.
"""
import numpy as np

from .mmd.rig_math import humanoid_ids
from .stance import Rig, _matrices

SCHEMA = 'endfield-pose-families/v1'
# The key bones by their humanoid.json bones, the first one present wins.
KEY_HUMANOID = (('hips',), ('spine',), ('upperChest', 'chest'), ('neck',), ('head',)) + tuple(
    (side+part,) for side in ('left', 'right') for part in ('UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot'))
# An end farther than this from every base of its stance is 'other'.
MATCH_CM = 8.0
OTHER = 'other'


def _need(ok, reason):
    if not ok:
        raise ValueError(reason)


def gap_cm(a, b):
    """Largest key-bone distance between two aligned poses, in centimetres."""
    return float(np.linalg.norm(np.asarray(a)-np.asarray(b), axis=-1).max()*100)


class Poses:
    def __init__(self, rig_document, humanoid=None):
        """humanoid: the pack's humanoid.json document; without one, humanoid_map_missing."""
        self.rig = Rig(rig_document, humanoid)
        found = humanoid_ids(humanoid, [n['path'] for n in rig_document['nodes']])
        self.keys = []
        for bones in KEY_HUMANOID:
            bone = next((b for b in bones if b in found), None)
            _need(bone is not None, 'pose_bone_missing:'+bones[-1])
            self.keys.append(found[bone])
        self.thighs = [KEY_HUMANOID.index(('leftUpperLeg',)), KEY_HUMANOID.index(('rightUpperLeg',))]

    def endpoints(self, rotations, positions, scales=None):
        """[(stance, aligned key-bone points [bones, 3] in metres)] of the first and last of local TRS samples
        [frames, nodes, 4|3] in rig node order."""
        rotations, positions = np.asarray(rotations, dtype=float), np.asarray(positions, dtype=float)
        _need(rotations.ndim == 3 and len(rotations) > 0, 'pose_shape')
        ends = [0, -1]
        rotations, positions = rotations[ends], positions[ends]
        scales = np.broadcast_to(self.rig.scales, positions.shape) if scales is None else np.asarray(scales, dtype=float)[ends]
        stances = [self.rig.classify(h) for h in self.rig.heights(rotations, positions, scales)]
        local = _matrices(rotations, positions, scales)
        world = np.empty_like(local)
        for i, p in enumerate(self.rig.parent):
            world[:, i] = local[:, i] if p < 0 else world[:, p] @ local[:, i]
        points = world[:, self.keys][..., :3, 3]
        points = points-points[:, :1]
        lateral = points[:, self.thighs[0]]-points[:, self.thighs[1]]
        angle = np.arctan2(lateral[:, 2], lateral[:, 0])[:, None]
        c, s = np.cos(angle), np.sin(angle)
        x, y, z = np.moveaxis(points, -1, 0)
        aligned = np.stack([c*x+s*z, y, c*z-s*x], -1)
        return list(zip(stances, aligned))


def nearest(end, bases):
    """(family, cm) of one (stance, pose) end against {family: (stance, pose)}; with no base of its stance, the
    nearest base of any stance gives the distance and the family is 'other'."""
    stance, pose = end
    same = {f: round(gap_cm(pose, b), 1) for f, (s, b) in bases.items() if s == stance}
    gaps = same or {f: round(gap_cm(pose, b), 1) for f, (_, b) in bases.items()}
    family = min(gaps, key=gaps.get)
    return (family if same and gaps[family] <= MATCH_CM else OTHER), gaps[family]


def families(rig_document, clips, bases, hub, bridges, references, humanoid=None):
    """The pose-families document; humanoid as Poses takes it.

    clips: {clip id: (rotations, positions, scales|None)} local TRS samples, at least its first and last frame;
    bases: {family: clip id} of the standing bases that family_gaps_cm compares, hub one of them;
    bridges: {'A>B': clip id}, each starting in A and ending in B; references: {family: clip id} of further bases
    (e.g. a seat or floor loop) that classify clips without entering the gaps."""
    _need(hub in bases, 'pose_hub_not_a_base')
    poses = Poses(rig_document, humanoid)
    named = dict(bases, **references)
    _need(set(named.values()) <= set(clips), 'pose_base_unmeasured')
    ends = {name: poses.endpoints(*clips[name]) for name in clips}
    first = {family: ends[name][0] for family, name in named.items()}
    rows = {}
    for name in sorted(ends):
        (start, start_cm), (end, end_cm) = (nearest(e, first) for e in ends[name])
        rows[name] = dict(start=start, end=end, start_cm=start_cm, end_cm=end_cm)
    for key, name in bridges.items():
        a, _, b = key.partition('>')
        _need(name in rows and (rows[name]['start'], rows[name]['end']) == (a, b), 'pose_bridge_breaks:'+key)
    gaps = {a: {b: round(gap_cm(first[a][1], first[b][1]), 1) for b in bases if b != a} for a in bases}
    return dict(schema=SCHEMA, bases=dict(bases), references=dict(references), hub=hub, bridges=dict(bridges),
                family_gaps_cm=gaps, clips=rows)
