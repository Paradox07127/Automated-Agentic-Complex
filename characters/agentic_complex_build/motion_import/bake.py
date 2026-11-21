"""A humanoid take on the canonical joints baked onto a package's native rig and installed as an imported action."""
from dataclasses import replace

import numpy as np

from character_library import Package, digest
from ..common import canonical_json, sha256_bytes
from ..import_generated import contact_intervals, despike, lock_schedule
from ..import_vmd import install_clips, package_rig
from ..mmd import rotation
from ..mmd.native_rig import NativeRig, package_humanoid
from ..mmd.retarget import TWISTS, SIDES, unit, _twist_angle
from ..mmd.rig_math import Retarget, bone, swing
from .take import CANONICAL, CANONICAL_PARENTS, FPS, audio_track, report_document, resample

KIND = 'humanoid-retargeted-linear-samples'
# Target rig space: metres, Y up.
CONTACT_HEIGHT_M = 0.03  # above the foot's lowest ankle height over the take
CONTACT_SPEED_M_S = 0.15  # horizontal ankle speed
TRIGGER_NAMES = {'bvh': 'BVH', 'gltf': 'glTF', 'vrma': 'VRMA', 'fbx': 'FBX'}
DIGITS = ('Thumb', 'Index', 'Middle', 'Ring', 'Little')  # the rig's Finger0..4


def derive_contacts(ankles, fps):
    """(F, 2) bool, columns L and R: the ankle is low and nearly still in the target rig's space."""
    columns = []
    for side in 'LR':
        p = np.asarray(ankles[side], float)
        velocity = np.gradient(p, axis=0)*fps
        columns.append((p[:, 1] < p[:, 1].min()+CONTACT_HEIGHT_M) & (np.hypot(velocity[:, 0], velocity[:, 2]) < CONTACT_SPEED_M_S))
    return np.stack(columns, 1)


class HumanoidToRig:
    def __init__(self, rig, take):
        self.rig = r = rig; self.take = take; self.ret = Retarget(rig, take.skeleton()); ids = r.humanoid
        # (roll axis in the segment's frame, segment child, [(twist node, roll axis in its parent's frame)], shares)
        self.twist = []
        for side, _, _ in SIDES:
            for _, _, seg, end, nodes, shares in TWISTS:
                S, E = ids[bone(side, seg)], ids[bone(side, end)]
                axis = unit(r.rest[E, :3, 3]-r.rest[S, :3, 3])
                js = [ids[bone(side, n)] for n in nodes if bone(side, n) in ids]
                self.twist.append((r.restR[S].T@axis, E, [(j, r.restR[r.parent[j]].T@axis) for j in js], shares))
        self.twist_nodes = sum(len(nodes) for _, _, nodes, _ in self.twist)
        self.leg = {side: tuple(ids[bone(side, x)] for x in ['UpperLeg', 'LowerLeg', 'Foot', 'Toes']) for side in 'LR'}
        self.hips = CANONICAL.index('Hips'); self.parents = CANONICAL_PARENTS
        # Per finger: (hand node, [(node, source finger or None, calibration)] from the hand out).
        self.fingers = []; fingers = take.fingers or {}; C = self.ret.C
        for side, _, word in SIDES:
            for n, digit in enumerate(DIGITS):
                nodes = r.finger(side, n); names = [word+digit+str(k+1) for k in range(3)]
                if not any(name in fingers for name in names) or None in nodes: continue
                chain = []; turn = np.eye(3)
                for k, name in enumerate(names):
                    if name not in fingers: chain.append((nodes[k], None, None)); continue
                    child = names[k+1] if k < 2 else None
                    # A distal joint has no source child: it keeps the turn of the joint before it.
                    if child in fingers:
                        turn = swing(r.rest[nodes[k+1], :3, 3]-r.rest[nodes[k], :3, 3], C@(fingers[child][0]-fingers[name][0]))
                    chain.append((nodes[k], name, turn@r.restR[nodes[k]]))
                self.fingers.append((ids[bone(side, 'Hand')], chain))
        self.finger_nodes = sum(name is not None for _, chain in self.fingers for _, name, _ in chain)

    def spread_twists(self, q):
        r = self.rig
        for u, E, nodes, shares in self.twist:
            tau = _twist_angle(rotation.compose(q[E], rotation.inv(r.q0[E])), u)
            prev = 0.0
            for (j, axis), share in zip(nodes, shares):
                q[j] = rotation.compose(rotation.from_rotvec(axis*(share-prev)*tau), q[j])
                prev = share

    def bake_fingers(self, Q, worlds):
        """Q's finger nodes from the source fingers' global rotations, under the hands' world rotations in worlds."""
        r, C, fingers = self.rig, self.ret.C, self.take.fingers
        for hand, chain in self.fingers:
            parent = r.rotations(worlds[:, hand])
            for j, name, cal in chain:
                if name is None: parent = parent@rotation.as_matrix(Q[:, j]); continue
                world = C@np.asarray(fingers[name][1], float)@C.T@cal
                Q[:, j] = rotation.from_matrix(np.swapaxes(parent, -1, -2)@world); parent = world

    def bake(self, foot_lock=True):
        """Returns Q (F,N,4), T (F,N,3) in the rig's RH frame and the bake's report fields."""
        r, ret, take = self.rig, self.ret, self.take
        xyz = np.asarray(take.xyz, float)
        rot, despiked = despike(np.asarray(take.R, float), self.parents)
        F = len(xyz); Q, T, worlds = ret.frames(xyz, rot, xyz[0, self.hips])
        self.bake_fingers(Q, worlds)
        free = {side: worlds[:, self.leg[side][2], :3, 3] for side in 'LR'}
        contacts = take.contacts
        if contacts is None: contacts = derive_contacts(free, FPS)
        intervals = {side: contact_intervals(contacts[:, k]) for k, side in enumerate('LR')}
        overshoot = 0.0
        for side in 'LR' if foot_lock else '':
            th, ca, fo, to = self.leg[side]
            for f, (weight, interval) in enumerate(lock_schedule(intervals[side], F)):
                if not weight: continue
                w = worlds[f]; fwd = w[to, :3, 3]-w[fo, :3, 3]; fwd[1] = 0
                goal = (1-weight)*free[side][f]+weight*free[side][interval[0]]
                hint = (w[ca, :3, 3]-w[th, :3, 3])+.05*unit(fwd)
                overshoot = max(overshoot, r.solve_limb(Q[f], T[f], (th, ca, fo), goal, endR=r.rotations(w)[fo], hint=hint))
        for f in range(F): self.spread_twists(Q[f])
        return Q, T, dict(frames=F, contact_intervals={side: len(intervals[side]) for side in 'LR'},
            solve_limb_overshoot_max_m=float(overshoot), twist_nodes=self.twist_nodes, finger_nodes=self.finger_nodes,
            despiked_frames=despiked,
            finite=bool(np.isfinite(Q).all() and np.isfinite(T).all()))


def resample_fingers(take, fps=FPS):
    """take.fingers at fps, the rotations resampled as resample() does the body's."""
    if not take.fingers: return take.fingers
    names = list(take.fingers); R = np.stack([np.asarray(take.fingers[name][1], float) for name in names], 1)
    moved = resample(replace(take, xyz=np.zeros(R.shape[:2]+(3,)), R=R, contacts=None, expressions=()), fps)
    return {name: (take.fingers[name][0], moved.R[:, k]) for k, name in enumerate(names)}


def import_take(package_root, take, output, *, title, bgm=None, bgm_start=None, foot_lock=True, bone_map=None, progress=None):
    """Bake the take onto the package's rig into the NEW package output; the import result's parts.
    progress(stage, fraction) is told the stages retarget and write, each from 0 to 1."""
    progress = progress or (lambda stage, fraction: None)
    take.validate()
    progress('retarget', 0)
    source_rate = take.frame_rate; take = replace(resample(take, FPS), fingers=resample_fingers(take, FPS))
    identity = sha256_bytes(canonical_json(dict(format=take.format, source=take.source_sha256, take=take.take,
        foot_lock=foot_lock, bone_map=bone_map, bgm=digest(bgm) if bgm else None, bgm_start=bgm_start)))[:16]
    name = 'imported_'+take.format+'_'+identity; action = take.format+'_'+identity
    # install_clips checks the inventory's SHA-256 of each file it rewrites; the library checks the others when it publishes.
    package = Package(package_root, deep=False); rig_doc, rig_sha = package_rig(package); rig = NativeRig(rig_doc, package_humanoid(package))
    Q, T, info = HumanoidToRig(rig, take).bake(foot_lock); fingers = info['finger_nodes'] > 0
    q, t = rig.unity_pose(Q, T)
    progress('retarget', 1)
    provenance =dict(kind=KIND, format=take.format, source_sha256=take.source_sha256, take=take.take, foot_lock=foot_lock,
                      unmapped=list(take.unmapped), target_rig_sha256=rig_sha,
                      coordinate_boundary=take.format+' RH -> calibrated RH -> Unity mirrorX')
    clip = dict(name=name, action=action, title=title, trigger='导入 '+TRIGGER_NAMES[take.format]+' · 手动播放', q=q, t=t,
                provenance=provenance,
                bgm=dict(source=bgm, start=0 if bgm_start is None else bgm_start, file=identity+'.wav') if bgm else None)
    source = {'name': take.source_name, 'sha256': take.source_sha256, 'take': take.take, 'takes': take.takes,
              'frame_rate': source_rate, 'frames': take.source_frames, 'zip': None,
              'expressions': [e.name for e in take.expressions]}
    def report(installed, rig_unchanged):
        [(metadata, music_info)] = installed
        return report_document(character=package.id, format=take.format,
            action={'id': action, 'clip': name, 'title': title, 'duration_s': metadata['length'], 'frames': len(take.xyz),
                    'has_bgm': music_info is not None},
            source=source,
            tracks={'body': {'retarget': 'humanoid-bone-direction', 'unmapped': list(take.unmapped),
                             'fingers': 'retargeted' if fingers else 'rest', 'foot_lock': foot_lock},
                    'face': None, 'camera': None, 'audio': audio_track(music_info, identity)},
            warnings=[w for w in dict.fromkeys(take.warnings) if not (fingers and w == 'fingers_rest')])
    progress('write', 0)
    document = install_clips(package, output, [clip], take.format+'-'+identity, report)
    progress('write', 1)
    return {key: document[key] for key in ('format', 'action', 'source', 'tracks', 'warnings')}
