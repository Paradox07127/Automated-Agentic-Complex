#!/usr/bin/env python3
"""Retarget Kimodo SOMA-30 generated motions onto an existing character's native rig and emit a validated package.

Like import_vmd, the output is a NEW offline package (or library generation); the input package and library are
never mutated. Body joints follow the SOMA global rotations, arm twist nodes take shares of the segment roll,
contact intervals lock the ankles, and fingers and face keep their rest pose. With a secondary_fit model, its corrective
and twist bones and default hand pose replace those.
"""
from pathlib import Path
import argparse
import json
import shutil

import numpy as np
from character_library import Package, Library, digest, read_json, write_json, need
from resource_store import clone_or_copy
from .common import canonical_json, sha256_bytes
from .import_vmd import install_clips, package_rig
from . import secondary_fit, style_retarget
from .mmd import rotation
from .mmd.native_rig import NativeRig, package_humanoid
from .mmd.retarget import TWISTS, SIDES, unit, _twist_angle
from .mmd.rig_math import Retarget, bone, swing

KIND = 'kimodo-soma-retargeted-linear-samples'
DEFAULT_MODEL = 'Kimodo-SOMA-RP-v1.2'
LOCK_FRAMES = 3   # shortest contact run that locks an ankle
BLEND_FRAMES = 3  # frames before and after a lock blended with the free trajectory
FPS = 30
SPIKE_DEG, SPIKE_RATIO = 30.0, 3.0  # a flip step: over 30 deg/frame and 3x the median of the steps within 5 frames
SPIKE_GAP = 6  # flip steps this many frames apart or closer are one cluster


def read_skeleton(path):
    return check_skeleton(read_json(path))


def check_skeleton(sk):
    count = len(sk['names'])
    need(count == len(set(sk['names'])) == len(sk['parents']) == len(sk['neutral_joints']), 'invalid_soma_skeleton')
    need(len(sk['foot_indices']) == 4 and all(0 <= i < count for i in sk['foot_indices']), 'invalid_soma_foot_indices')
    return sk


def read_motion(path, slot, joints):
    """(xyz F×J×3, global rotations F×J×3×3, contacts F×4 bool) of one batch slot."""
    with np.load(path, allow_pickle=False) as data:
        need(int(data['fps']) == FPS, 'unsupported_motion_fps')
        xyz, rot, contacts = (data[k] for k in ['posed_joints', 'global_rot_mats', 'foot_contacts'])
    need(xyz.ndim == 4 and xyz.shape[2:] == (joints, 3) and rot.shape == xyz.shape[:3]+(3, 3)
         and contacts.shape == xyz.shape[:2]+(4,), 'invalid_motion_shape')
    need(0 <= slot < xyz.shape[0], 'motion_slot_out_of_range')
    need(2 <= xyz.shape[1] <= 180*FPS+1, 'motion_range_limit_180_seconds')
    xyz, rot = xyz[slot].astype(float), rot[slot].astype(float)
    need(np.isfinite(xyz).all() and np.isfinite(rot).all(), 'nonfinite_motion')
    return xyz, rot, contacts[slot] > .5


def contact_intervals(column):
    """Inclusive (first, last) frames of each contact run at least LOCK_FRAMES long."""
    runs, start = [], None
    for f, down in enumerate(list(column)+[False]):
        if down and start is None: start = f
        if not down and start is not None:
            if f-start >= LOCK_FRAMES: runs.append((start, f-1))
            start = None
    return runs


def lock_schedule(intervals, frames):
    """Per frame (weight, interval): 1 inside an interval, ramping to 0 over BLEND_FRAMES on either side."""
    schedule = [(0.0, None)]*frames
    for interval in intervals:
        first, last = interval
        for f in range(max(0, first-BLEND_FRAMES), min(frames, last+BLEND_FRAMES+1)):
            outside = max(first-f, f-last, 0)
            weight = 1-outside/(BLEND_FRAMES+1)
            if weight > schedule[f][0]: schedule[f] = (weight, interval)
    return schedule


def ankle_speeds(positions, intervals):
    """Horizontal ankle speeds (cm/s) between consecutive frames inside the intervals."""
    steps = [positions[f]-positions[f-1] for first, last in intervals for f in range(first+1, last+1)]
    return np.array([np.hypot(d[0], d[2])*FPS*100 for d in steps])


def despike(rot, parents):
    """Global rotations (F, J, 3, 3) with each cluster of flip steps in a joint's local rotation replaced by a slerp
    between the frame before its first step and the second frame after its last, and the number of frames changed."""
    F = len(rot); local = rot.copy()
    for j, p in enumerate(parents):
        if p >= 0: local[:, j] = np.swapaxes(rot[:, p], -1, -2)@rot[:, j]
    rel = np.swapaxes(local[:-1], -1, -2)@local[1:]
    step = np.degrees(np.arccos(np.clip((np.trace(rel, axis1=-2, axis2=-1)-1)/2, -1, 1)))
    median = np.array([np.median(step[max(0, i-5):i+6], 0) for i in range(len(step))])
    flip = (step > SPIKE_DEG) & (step > SPIKE_RATIO*np.maximum(median, 1))
    changed = np.zeros(F, bool)
    for j in np.flatnonzero(flip.any(0)):
        clusters = []
        for s in np.flatnonzero(flip[:, j]):
            if clusters and s-clusters[-1][-1] <= SPIKE_GAP: clusters[-1].append(s)
            else: clusters.append([s])
        for c in clusters:
            a0, a1 = max(0, c[0]-1), min(F-1, c[-1]+2)
            for f in range(a0+1, a1):
                local[f, j] = rotation.slerp(local[a0, j], local[a1, j], (f-a0)/(a1-a0)); changed[f] = True
    if not changed.any(): return rot, 0
    rot = rot.copy()
    # Parents precede their children in SOMA, so one pass rebuilds the changed frames.
    for j, p in enumerate(parents):
        rot[changed, j] = local[changed, j] if p < 0 else rot[changed, p]@local[changed, j]
    return rot, int(changed.sum())


def summary(speeds):
    if not len(speeds): return None
    return dict(median=round(float(np.median(speeds)), 3), p95=round(float(np.percentile(speeds, 95)), 3))


class SomaToRig:
    def __init__(self, rig, sk, stand=None, reference=None):
        self.rig = r = rig; self.ret = ret = Retarget(rig, sk); si = ret.si; ids = r.humanoid
        for side, _, word in SIDES:
            # SOMA's first hand child is the thumb tip; aim the hand at the middle fingertip, as the rig's hand aims at its middle finger.
            h = ids[bone(side, 'Hand')]
            ret.cal[h] = swing(r.rest[ids[bone(side, 'MiddleProximal')], :3, 3]-r.rest[h, :3, 3],
                               ret.C@(ret.neutral[si[word+'HandMiddleEnd']]-ret.neutral[si[word+'Hand']]))@r.restR[h]
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
        self.ankle_column = {side: sk['foot_indices'].index(si[word+'Foot']) for side, _, word in SIDES}
        self.hips = si['Hips']; self.parents = sk['parents']
        self.calibration, self.reference_clip = 'bone-direction', None
        if stand and reference and style_retarget.same_skeleton(stand, sk):
            style_retarget.calibrate(self, stand, reference)
            self.calibration, self.reference_clip = 'reference-pose', reference['clip']
            ret.hips_from_rotation = True

    def spread_twists(self, q):
        r = self.rig
        for u, E, nodes, shares in self.twist:
            tau = _twist_angle(rotation.compose(q[E], rotation.inv(r.q0[E])), u)
            prev = 0.0
            for (j, axis), share in zip(nodes, shares):
                q[j] = rotation.compose(rotation.from_rotvec(axis*(share-prev)*tau), q[j])
                prev = share

    def bake(self, xyz, rot, contacts, foot_lock=True):
        """Returns Q (F,N,4), T (F,N,3) in the rig's RH frame and the per-clip report fields."""
        r, ret = self.rig, self.ret
        rot, despiked = despike(rot, self.parents)
        F = len(xyz); Q, T, worlds = ret.frames(xyz, rot, xyz[0, self.hips])
        intervals = {side: contact_intervals(contacts[:, self.ankle_column[side]]) for side in 'LR'}
        free = {side: worlds[:, self.leg[side][2], :3, 3] for side in 'LR'}
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
        ankles = r.fk(Q, T)[:, [self.leg[side][2] for side in 'LR']][..., :3, 3]
        locked = dict(L=ankles[:, 0], R=ankles[:, 1])
        before = np.concatenate([ankle_speeds(free[side], intervals[side]) for side in 'LR'])
        after = np.concatenate([ankle_speeds(locked[side], intervals[side]) for side in 'LR'])
        return Q, T, dict(frames=F, contact_intervals={side: len(intervals[side]) for side in 'LR'},
            contact_ankle_speed_cm_s=dict(before_lock=summary(before), after_lock=summary(after)),
            solve_limb_overshoot_max_m=float(overshoot), twist_nodes=self.twist_nodes, despiked_frames=despiked,
            finite=bool(np.isfinite(Q).all() and np.isfinite(T).all()))


def import_generated(package_path, output, skeleton, clips, model=DEFAULT_MODEL, foot_lock=True, secondary=None):
    """clips: dicts of npz, slot, name (action name) and title."""
    # install_clips checks the inventory's SHA-256 of each file it rewrites; the library checks the others when it publishes.
    package = Package(package_path, deep=False); output = Path(output).resolve()
    need(not output.exists(), 'output_already_exists')
    need(not output.is_relative_to(package.root), 'output_inside_input_package')
    sk = read_skeleton(skeleton); rig_doc, rig_sha = package_rig(package); rig = NativeRig(rig_doc, package_humanoid(package))
    convert = SomaToRig(rig, sk, style_retarget.load_stand(), style_retarget.rig_reference(package.root)); prepared = []; rows = []
    fitted = read_json(secondary) if secondary else None
    for clip in clips:
        xyz, rot, contacts = read_motion(clip['npz'], clip['slot'], len(sk['names']))
        Q, T, row = convert.bake(xyz, rot, contacts, foot_lock)
        q, t = rig.unity_pose(Q, T)
        if fitted: q, t = secondary_fit.apply(fitted, rig_doc, q, t)
        provenance = dict(kind=KIND, npz_sha256=digest(clip['npz']), slot=clip['slot'], model=model, foot_lock=foot_lock,
                          skeleton_sha256=digest(skeleton), target_rig_sha256=rig_sha,
                          coordinate_boundary='Kimodo SOMA Y-up RH -> calibrated RH -> Unity mirrorX',
                          secondary_sha256=digest(secondary) if secondary else None,
                          calibration=convert.calibration, reference_clip=convert.reference_clip)
        name = action = 'kimodo_'+clip['name']
        prepared.append(dict(name=name, action=action, title=clip['title'], trigger='Kimodo 生成 · 手动播放',
                             q=q, t=t, provenance=provenance, bgm=None))
        rows.append(dict(action=action, clip=name, title=clip['title'], provenance=provenance, **row))
    identity = sha256_bytes(canonical_json([[p['provenance'], p['name']] for p in prepared]))[:16]
    def report(installed, rig_unchanged):
        return dict(schema='endfield-kimodo-import/v1', character=package.id, target_nodes=rig.N,
            clips=[dict(row, duration=metadata['length']) for row, (metadata, _) in zip(rows, installed)],
            original_rig_unchanged=rig_unchanged,
            scope='retargeted body and ankle contact locks; '+('secondary_fit corrective, twist and default hand pose; face rest'
                  if secondary else 'arm twist shares; fingers/face rest; no corrective bones'))
    return install_clips(package, output, prepared, 'kimodo-'+identity, report)


def parse_clip(value):
    """npz:slot:name:title; the npz path may contain ':'."""
    npz, slot, name, title = value.rsplit(':', 3)
    return dict(npz=Path(npz), slot=int(slot), name=name, title=title)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    source = p.add_mutually_exclusive_group(required=True)
    source.add_argument('--package', type=Path, help='write one new package to --output')
    source.add_argument('--library', type=Path, help='publish a new library generation to --output with --character replaced')
    p.add_argument('--character'); p.add_argument('--output', type=Path, required=True)
    p.add_argument('--skeleton', type=Path, required=True)
    p.add_argument('--clip', type=parse_clip, action='append', required=True, help='npz:slot:action-name:title, repeatable')
    p.add_argument('--model', default=DEFAULT_MODEL); p.add_argument('--no-foot-lock', action='store_true')
    p.add_argument('--secondary', type=Path, help='secondary_fit model.json of the same character')
    a = p.parse_args(); need(not a.output.exists(), 'output_already_exists')
    need((a.library is None) == (a.character is None), 'character_requires_library')
    if a.package:
        report = import_generated(a.package, a.output, a.skeleton, a.clip, a.model, not a.no_foot_lock, a.secondary)
        print(json.dumps(report, ensure_ascii=False)); return
    need(not a.output.resolve().is_relative_to(a.library.resolve()), 'output_inside_input_library')
    packages = Library(a.library).packages(); by = {x.id: x for x in packages}; need(a.character in by, 'unknown_character')
    a.output.mkdir(parents=True)
    try:
        target = a.output/'packages-built'/a.character
        report = import_generated(by[a.character].root, target, a.skeleton, a.clip, a.model, not a.no_foot_lock, a.secondary)
        library = Library(a.output/'library'); library.root.mkdir(); built = []
        for original in packages:
            package = Package(target if original.id == a.character else original.root)
            destination = library.root/'packages'/package.id/package.sha256; destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(package.root, destination, symlinks=True, copy_function=clone_or_copy)
            built.append(Package(destination, deep=False))
        default = Library(a.library).snapshot()['default_character']
        library.publish(sorted(built, key=lambda x: (x.id != default, x.id)))
        result = dict(passed=True, catalog=str(a.output/'library/current.json'), report=report)
        write_json(a.output/'import-result.json', result); print(json.dumps(result, ensure_ascii=False))
    except BaseException:
        shutil.rmtree(a.output); raise


if __name__ == '__main__': main()
