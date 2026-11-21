"""Body stance of a baked clip at its first and last frame, measured against the rig's bind pose.

Heights are rig-root-space y (Unity up) above the root plane y=0. The bind pose is the
standing reference. The pelvis is the humanoid hips, the ankles the feet, the head the head.
"""
import numpy as np

from .mmd.rig_math import humanoid_ids

# LIFTED stances are never measured: a config names them per clip.
LIFTED = ('air', 'boss')
STANCES = ('stand', 'sit', 'floor', 'lie') + LIFTED
# Pelvis above the lower ankle / bind at or above this is standing; a seat on a high table lifts
# the pelvis above its standing height, so the pelvis alone cannot tell standing from sitting.
STAND_LEG = .85
# Pelvis height / bind below this is on the ground.
FLOOR_PELVIS = .35
# Lying: the pelvis-to-head axis is at most this far from horizontal (degrees) ...
LIE_TORSO_DEGREES = 35
# ... and the head is below this fraction of its bind height (a deep forward bend keeps it higher).
LIE_HEAD = .40
BONES = ('hips', 'head', 'leftFoot', 'rightFoot')


def _need(ok, reason):
    if not ok:
        raise ValueError(reason)


def _matrices(rotations, positions, scales):
    """Local TRS matrices; rotations are xyzw quaternions."""
    x, y, z, w = np.moveaxis(rotations/np.linalg.norm(rotations, axis=-1, keepdims=True), -1, 0)
    m = np.empty(rotations.shape[:-1]+(4, 4))
    m[..., 0, :3] = np.stack([1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)], -1)
    m[..., 1, :3] = np.stack([2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)], -1)
    m[..., 2, :3] = np.stack([2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)], -1)
    m[..., :3, :3] *= scales[..., None, :]
    m[..., :3, 3] = positions
    m[..., 3, :] = [0, 0, 0, 1]
    return m


class Rig:
    def __init__(self, document, humanoid=None):
        """humanoid: the rig's humanoid.json document; without one, humanoid_map_missing."""
        _need(document.get('schema') == 'metal-actor-rig-v1', 'stance_unsupported_rig')
        nodes = document['nodes']
        self.parent = [n['parent'] for n in nodes]
        _need(all(n['index'] == i and -1 <= p < i for i, (n, p) in enumerate(zip(nodes, self.parent))), 'stance_rig_not_parent_first')
        found = humanoid_ids(humanoid, [n['path'] for n in nodes])
        self.bones = [found[bone] for bone in BONES]
        self.rotations, self.positions, self.scales = (np.array([n[k] for n in nodes], dtype=float) for k in ['rotation', 'position', 'scale'])
        self.reference = self.heights(self.rotations[None], self.positions[None])[0]
        pelvis, head, foot, elevation = self.reference
        _need(pelvis > 0 and pelvis-foot > 0 and head > pelvis and elevation >= 90-LIE_TORSO_DEGREES, 'stance_bind_pose_is_not_standing')

    def points(self, rotations, positions, scales=None):
        """World positions [frames, 4, 3] of BONES."""
        rotations, positions = np.asarray(rotations, dtype=float), np.asarray(positions, dtype=float)
        _need(rotations.ndim == 3 and rotations.shape[1:] == (len(self.parent), 4) and positions.shape == rotations.shape[:2]+(3,)
              and len(rotations) > 0, 'stance_pose_shape')
        scales = np.broadcast_to(self.scales, positions.shape) if scales is None else np.asarray(scales, dtype=float)
        _need(scales.shape == positions.shape, 'stance_pose_shape')
        _need(np.isfinite(rotations).all() and np.isfinite(positions).all() and np.isfinite(scales).all(), 'stance_pose_nonfinite')
        _need((np.linalg.norm(rotations, axis=-1) > 1e-8).all(), 'stance_pose_zero_rotation')
        local = _matrices(rotations, positions, scales)
        world = np.empty_like(local)
        for i, p in enumerate(self.parent):
            world[:, i] = local[:, i] if p < 0 else world[:, p] @ local[:, i]
        return world[:, self.bones][..., :3, 3]

    def heights(self, rotations, positions, scales=None):
        """[frames, 4]: pelvis, head and lower-ankle heights, and the torso's elevation from horizontal in degrees."""
        p = self.points(rotations, positions, scales)
        axis = p[:, 1]-p[:, 0]
        length = np.linalg.norm(axis, axis=-1)
        _need((length > 1e-6).all(), 'stance_pose_degenerate_torso')
        elevation = np.degrees(np.arcsin(np.clip(np.abs(axis[:, 1])/length, 0, 1)))
        return np.stack([p[:, 0, 1], p[:, 1, 1], np.minimum(p[:, 2, 1], p[:, 3, 1]), elevation], -1)

    def classify(self, measured):
        pelvis, head, foot, elevation = measured
        rest_pelvis, rest_head, rest_foot, _ = self.reference
        if elevation <= LIE_TORSO_DEGREES and head/rest_head < LIE_HEAD:
            return 'lie'
        if pelvis/rest_pelvis < FLOOR_PELVIS:
            return 'floor'
        return 'stand' if (pelvis-foot)/(rest_pelvis-rest_foot) >= STAND_LEG else 'sit'

    def stances(self, rotations, positions, scales=None):
        """(stance_start, stance_end) of local TRS samples [frames, nodes, 4|3] in rig node order."""
        rotations, positions = np.asarray(rotations, dtype=float), np.asarray(positions, dtype=float)
        _need(rotations.ndim == 3 and len(rotations) > 0, 'stance_pose_shape')
        ends = [0, -1]
        picked = None if scales is None else np.asarray(scales, dtype=float)[ends]
        start, end = self.heights(rotations[ends], positions[ends], picked)
        return self.classify(start), self.classify(end)


def stances(rig_document, rotations, positions, scales=None, humanoid=None):
    return Rig(rig_document, humanoid).stances(rotations, positions, scales)
