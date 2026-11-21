"""Retarget one Kimodo SOMA-30 npz at runtime into an in-place metal-actor-clip-v1 document and its EFKEY001 keys.

The installed package is only read; the secondary_fit model and the reference idle pose are cached per package SHA-256
in cache_dir.
"""
import io
from pathlib import Path

import numpy as np
from character_library import Package, digest, read_json, write_json
from .common import canonical_json, need, sha256_bytes
from .import_generated import KIND, DEFAULT_MODEL, FPS, SomaToRig, check_skeleton, contact_intervals, read_motion
from .import_vmd import encode_clip, package_rig
from . import secondary_fit, style_retarget
from .mmd import rotation
from .mmd.retarget import _twist_angle
from .mmd.native_rig import NativeRig, package_humanoid
from .mmd.rig_math import bone

TRACKS = 'endfield-generated-tracks/v1'
SEATED = ('window_loop', 'sit_enter', 'sit_loop', 'sit_exit')
KINDS = ('perform', 'walk', 'turn', 'lean')+SEATED
STANCES = dict(window_loop=('sit', 'sit'), sit_loop=('sit', 'sit'), sit_enter=('stand', 'sit'), sit_exit=('sit', 'stand'))
MIRROR = np.array([-1., 1, 1])
LEAN_REACH_M = 0.02  # the most a lean's grip may lie beyond the rig arm's reach


def seat_offset(package):
    """Unity rig root offset from the pelvis to the seat centre, averaged over the authored seat loop; None without seat anchors
    or an affordance seat use."""
    pack_path = package.root/Path(package.native_ref['file']).parent/package.native_entry['c7']['file']
    files = {ref['file'] for ref in read_json(pack_path)['interaction']['data']}
    if 'seat-anchors.json' not in files or 'affordance-uses.json' not in files: return None
    interaction = pack_path.parent/'interaction'; anchors = read_json(interaction/'seat-anchors.json')
    # The host's choice of the loop: the affordance seat use's.
    loop = next((u['loop'] for u in read_json(interaction/'affordance-uses.json')['uses'] if u['surface'] == 'seat'), None)
    if loop is None: return None
    samples = next(c['samples'] for c in anchors['clips'] if c['name'] == loop)
    offset = np.mean([np.subtract(s['seat_centre'], s['pelvis']) for s in samples], 0)
    frame = read_json(interaction/'rig-profile.json')['frame']
    # The anchors' axes are the profile's left/up/forward rows in Unity rig coordinates.
    return np.array([frame['left'], frame['up'], frame['forward']], float).T@offset


def _heading(xyz, si):
    """Kimodo's heading of the hip vector (feature_utils) per frame, radians from frame 0, unwrapped, positive to her
    left, about Kimodo +Y."""
    d = xyz[:, si['RightLeg']]-xyz[:, si['LeftLeg']]
    theta = np.unwrap(np.arctan2(d[:, 2], -d[:, 0])); return theta-theta[0]


class LiveRetarget:
    def __init__(self, package_root, cache_dir):
        package = Package(package_root)
        self.rig_doc, self.rig_sha256 = package_rig(package); self.rig = NativeRig(self.rig_doc, package_humanoid(package))
        self.secondary_path = Path(cache_dir)/(package.sha256+'.secondary.json')
        if not self.secondary_path.exists(): write_json(self.secondary_path, secondary_fit.fit(package.root))
        self.secondary = read_json(self.secondary_path); self.secondary_sha256 = digest(self.secondary_path)
        # null when the package has no usable idle clip.
        reference_path = Path(cache_dir)/(package.sha256+'.reference.json')
        if not reference_path.exists(): write_json(reference_path, style_retarget.rig_reference(package.root))
        self.reference = read_json(reference_path); self.stand = style_retarget.load_stand()
        self.seat_offset = seat_offset(package)
        self.sk = self.convert = None

    def skeleton(self, doc):
        self.sk = check_skeleton(doc); self.convert = SomaToRig(self.rig, doc, self.stand, self.reference)
        self.skeleton_sha256 = sha256_bytes(canonical_json(doc))

    def to_kimodo(self, value):
        """A rig root point (Unity, metres) as a Kimodo point list (metres), or a yaw (degrees, positive toward +x) as
        Kimodo degrees (positive toward her left)."""
        if np.ndim(value) == 0: return -float(value)
        ret = self.convert.ret
        return (ret.C.T@(np.asarray(value, float)*MIRROR)/ret.scale).tolist()

    def from_kimodo(self, value):
        """The inverse of to_kimodo."""
        if np.ndim(value) == 0: return -float(value)
        ret = self.convert.ret
        return (ret.scale*ret.C@np.asarray(value, float)*MIRROR).tolist()

    def heading(self, npz_bytes):
        """Slot 0's heading per frame in degrees from frame 0, unwrapped, positive to her left: a turn's yaw track negated."""
        xyz, _, _ = read_motion(io.BytesIO(npz_bytes), 0, len(self.sk['names']))
        return np.degrees(_heading(xyz, self.convert.ret.si)).tolist()

    def lean_grip(self, Q, T, geometry):
        """(Q with geometry's hand side arm solved toward its grip, the largest overshoot of the arm's reach in metres).
        Q, T: (F, N, 4/3) RH local. The pull is 0 up to 0.5 s and full from 1 s, when the request's hand constraints
        begin; the hand keeps its world rotation and the elbow its bend direction."""
        rig = self.rig; side = 'L' if geometry['hand'] == 'left' else 'R'
        chain = [rig.humanoid[bone(side, n)] for n in ('UpperArm', 'LowerArm', 'Hand')]
        twists = [entry for entry in self.convert.twist if entry[1] in chain[1:]]
        goal = np.asarray(geometry['grip'], float)*MIRROR; weight = np.clip((np.arange(len(Q))/FPS-.5)/.5, 0, 1)
        Q = Q.copy(); world = rig.fk(Q, T, chain); overshoot = 0.0
        roll = lambda f: [_twist_angle(rotation.compose(Q[f, E], rotation.inv(rig.q0[E])), u) for u, E, _, _ in twists]
        for f in np.flatnonzero(weight):
            s, e, h = world[f, chain, :3, 3]; before = roll(f)
            overshoot = max(overshoot, rig.solve_limb(Q[f], T[f], chain, h+weight[f]*(goal-h),
                                                      endR=rig.rotations(world[f, chain[2:]])[0], hint=e-(s+h)/2))
            # spread_twists again on this arm: its twist nodes take the change of their segment's roll.
            for (_, _, nodes, shares), old, new in zip(twists, before, roll(f)):
                prev = 0.0
                for (j, axis), share in zip(nodes, shares):
                    Q[f, j] = rotation.compose(rotation.from_rotvec(axis*(share-prev)*(new-old)), Q[f, j]); prev = share
        return Q, float(overshoot)

    def clip(self, npz_bytes, motion_id, kind='perform', geometry=None):
        """(meta, keys, tracks) of slot 0 of the npz, named motion_id; tracks is the endfield-generated-tracks/v1
        document, None for perform. geometry is the host's request geometry in rig root coordinates; a sit_loop or
        sit_exit with a seat, asked with the seat as origin, has its frame-0 hips moved onto the seat."""
        need(kind in KINDS, 'unknown_motion_kind')
        need(kind not in SEATED or self.seat_offset is not None, 'no_seat_anchors')
        xyz, rot, contacts = read_motion(io.BytesIO(npz_bytes), 0, len(self.sk['names']))
        Q, T, _ = self.convert.bake(xyz, rot, contacts, foot_lock=True)
        style_ik = None
        if kind in SEATED: Q = style_retarget.knee_swivel(self.rig, Q, T, style_retarget.SIT_KNEE); style_ik = 'seated-knees'
        if kind == 'turn':
            Q = style_retarget.narrow_stance(self.rig, Q, T, contacts, self.convert.ankle_column, style_retarget.TURN_STANCE)
            style_ik = 'turn-stance'
        lean_overshoot = None
        if kind == 'lean' and geometry is not None and {'hand', 'grip'} <= set(geometry):
            Q, lean_overshoot = self.lean_grip(Q, T, geometry); style_ik = 'lean-grip'
            need(lean_overshoot <= LEAN_REACH_M, 'lean_grip_out_of_reach')
        hips = self.rig.hips; ret = self.convert.ret; F = len(xyz); stance = STANCES.get(kind, ('stand', 'stand'))
        tracks = None if kind == 'perform' else dict(
            schema=TRACKS, id=motion_id, kind=kind, rate_hz=FPS, loop=kind in ('window_loop', 'sit_loop'),
            stance_start=stance[0], stance_end=stance[1],
            contacts={side: [[first/FPS, last/FPS] for first, last in contact_intervals(contacts[:, self.convert.ankle_column[side]])]
                      for side in 'LR'})
        if kind == 'turn':
            theta = _heading(xyz, ret.si)
            c, s = np.cos(-theta), np.sin(-theta); undo = np.zeros((F, 3, 3)); undo[:, 1, 1] = 1
            undo[:, 0, 0] = undo[:, 2, 2] = c; undo[:, 0, 2] = s; undo[:, 2, 0] = -s
            undo = ret.C@undo@ret.C.T
            # The hips' parents are rest-identity, so turning its local transform turns the whole pose about the root's vertical.
            Q[:, hips] = rotation.compose(rotation.from_matrix(undo), Q[:, hips]); T[:, hips] = np.einsum('fij,fj->fi', undo, T[:, hips])
            tracks['yaw'] = (-np.degrees(theta)).tolist()
        q, t = self.rig.unity_pose(Q, T)
        q, t = secondary_fit.apply(self.secondary, self.rig_doc, q, t)
        seat = None
        if kind in ('sit_loop', 'sit_exit') and geometry is not None and 'seat' in geometry:
            # The hips' parents are rest-identity, so moving its local position moves the whole pose in the rig root.
            seat = np.asarray(geometry['seat'], float); t[:, hips] += seat-t[0, hips]
        excursion = float(np.hypot(*(t[:, hips, [0, 2]]-t[0, hips, [0, 2]]).T).max())
        # Kimodo's ground is y=0.
        toes = [i for i in self.sk['foot_indices'] if self.sk['names'][i].endswith('ToeBase')]
        toe_min = float(xyz[:, toes, 1].min()*100)
        removed = 0.0
        if kind == 'perform':
            # Bake puts the travel on the hips node; its parents are rest-identity, so its local x/z is horizontal.
            # Only the straight line from frame 0 to the last frame is removed, so the hips keep their sway.
            net = t[-1, hips, [0, 2]]-t[0, hips, [0, 2]]
            t[:, hips, [0, 2]] -= np.linspace(0, 1, len(t))[:, None]*net; removed = float(np.hypot(*net))
        elif kind == 'walk':
            with np.load(io.BytesIO(npz_bytes), allow_pickle=False) as data: smooth = data['smooth_root_pos'][0].astype(float)
            need(smooth.shape == (F, 3) and np.isfinite(smooth).all(), 'invalid_smooth_root')
            step = smooth-smooth[0]; step[:, 1] = 0
            path = (ret.scale*step@ret.C.T*MIRROR)[:, [0, 2]]; length = np.hypot(*path[-1])
            need(length > 1e-3, 'walk_without_travel')
            direction = path[-1]/length
            # The host's one-shot travel never decreases and ends at its maximum; the hips keep the real root's difference
            # from travel x direction (back-steps, overshoot, drift across), 0 at the last frame, so the host's sum is the real route.
            travel = np.minimum(np.maximum.accumulate(path@direction), length)
            t[:, hips, [0, 2]] -= travel[:, None]*direction; removed = float(travel[-1])
            tracks.update(travel=travel.tolist(), direction=direction.tolist())
        elif kind in SEATED:
            # Approximation: the seat centre keeps the authored seat loop's offset from the pelvis instead of a skinned measure.
            pelvis = t[:, hips]
            tracks.update(seat_centre=(pelvis+self.seat_offset).tolist(), pelvis=pelvis[:, 1].tolist())
        provenance = dict(kind=KIND, npz_sha256=sha256_bytes(npz_bytes), slot=0, model=DEFAULT_MODEL, foot_lock=True,
                          skeleton_sha256=self.skeleton_sha256, rig_sha256=self.rig_sha256,
                          coordinate_boundary='Kimodo SOMA Y-up RH -> calibrated RH -> Unity mirrorX',
                          secondary_sha256=self.secondary_sha256, removed_travel_m=removed,
                          quality=dict(removed_travel_m=removed, toe_min_cm=toe_min, hips_excursion_m=excursion),
                          calibration=self.convert.calibration, reference_clip=self.convert.reference_clip,
                          hips='rotation' if ret.hips_from_rotation else 'basis', style_ik=style_ik,
                          seat_anchor=None if seat is None else seat.tolist(), lean_ik_overshoot_m=lean_overshoot)
        meta, keys = encode_clip(self.rig_doc, motion_id, q, t, FPS, provenance)
        sha = sha256_bytes(keys)
        return dict(meta, keys=dict(file=sha+'.keys', sha256=sha, byte_count=len(keys))), keys, tracks
