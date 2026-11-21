"""Reference-pose calibration and per-kind IK corrections for Kimodo SOMA-30 motion on a character's native rig.

The bone-direction calibration carries SOMA's neutral posture (forward spine and neck, flat feet) onto the rig. The
reference-pose calibration instead maps Kimodo's mean standing pose onto the character's own idle clip.

    python3 -m agentic_complex_build.style_retarget stand --skeleton skeleton.json --npz idle_s0.npz [...] --out stand.json
"""
import argparse
from importlib import resources
import json
from pathlib import Path

import numpy as np
from character_library import Package, read_json, write_json
from .common import sha256_file
from . import import_generated, secondary_fit
from .import_vmd import package_rig
from .mmd import rotation
from .mmd.native_rig import NativeRig, package_humanoid
from .mmd.rig_math import basis, bone, unit

STAND_SCHEMA = 'endfield-kimodo-stand-reference/v2'
STAND_FILE = 'kimodo_stand_reference.json'
# Metres; Kimodo services on different devices report neutral joints a few 1e-8 apart.
NEUTRAL_TOLERANCE = 1e-5
# A reference clip's median ankle spread over hip-joint distance; outside it the idle is a posed (feet together) stance.
REFERENCE_STANCE = (1.0, 2.0)
# Seated knee gap over hip width: the authored seated clips' medians are 0.51-0.62.
SIT_KNEE = 0.6
# Turning ankle spread over hip width: the authored turn clips' medians are 1.41-1.45.
TURN_STANCE = 1.45
SWIVEL_MAX_DEG = 40.0
# Thigh angle from straight down (degrees) over which knee_swivel's weight ramps from 0 to 1.
SEATED_THIGH_DEG = (20.0, 50.0)


def mean_rot(R):
    """Rotation nearest the mean of R (..., 3, 3) over axis 0."""
    u, _, vt = np.linalg.svd(R.mean(0)); m = u@vt
    if np.linalg.det(m) < 0: u[:, -1] *= -1; m = u@vt
    return m


def yaw_to(lat_now, lat_ref):
    """Rotations about +y taking each frame's horizontal lateral vector onto lat_ref's."""
    a = np.arctan2(lat_now[:, 2], lat_now[:, 0])-np.arctan2(lat_ref[2], lat_ref[0])
    c, s = np.cos(a), np.sin(a); H = np.zeros((len(a), 3, 3)); H[:, 1, 1] = 1
    H[:, 0, 0] = H[:, 2, 2] = c; H[:, 0, 2] = s; H[:, 2, 0] = -s
    return H


def smoothstep(x):
    x = np.clip(x, 0, 1)
    return x*x*(3-2*x)


def world_rotations(world):
    return world[..., :3, :3]/np.linalg.norm(world[..., :3, :3], axis=-2, keepdims=True)


def hip_frame(rig, world):
    """Per frame: the horizontal unit L->R Thigh axis, the hip centre and the hip-joint distance."""
    hl, hr = world[:, rig.humanoid['leftUpperLeg'], :3, 3], world[:, rig.humanoid['rightUpperLeg'], :3, 3]
    lat = hr-hl; lat[:, 1] = 0; lat /= np.linalg.norm(lat, axis=-1, keepdims=True)
    return lat, (hl+hr)/2, np.linalg.norm(hr-hl, axis=-1)


def stand_reference(skeleton_doc, npz_paths):
    """Kimodo's mean standing pose: every SOMA joint's heading-normalised global rotation and the body basis."""
    sk = import_generated.check_skeleton(skeleton_doc); si = {n: i for i, n in enumerate(sk['names'])}
    neutral = np.array(sk['neutral_joints'], float); lat = neutral[si['RightLeg']]-neutral[si['LeftLeg']]; lat[1] = 0
    xs, Rs = [], []
    for path in npz_paths:
        x, R, _ = import_generated.read_motion(path, 0, len(sk['names']))
        H = yaw_to(x[:, si['RightLeg']]-x[:, si['LeftLeg']], lat)
        xs.append(np.einsum('fij,fkj->fki', H, x)); Rs.append(H[:, None]@R)
    xs, Rs = np.concatenate(xs), np.concatenate(Rs)
    body = mean_rot(np.array([basis(x[si['RightLeg']]-x[si['LeftLeg']], x[si['Neck1']]-x[si['Hips']]) for x in xs]))
    return dict(schema=STAND_SCHEMA, model=import_generated.DEFAULT_MODEL,
                skeleton={k: sk[k] for k in ('names', 'parents', 'neutral_joints')},
                sources=[dict(file=Path(p).name, sha256=sha256_file(p)) for p in npz_paths],
                rotations={name: mean_rot(Rs[:, k]).tolist() for k, name in enumerate(sk['names'])},
                body_basis=body.tolist())


def same_skeleton(stand, sk):
    """Whether sk has the stand reference's joints, parents and neutral joints within NEUTRAL_TOLERANCE."""
    ref = stand['skeleton']
    if ref['names'] != sk['names'] or ref['parents'] != sk['parents']: return False
    a, b = np.array(ref['neutral_joints'], float), np.array(sk['neutral_joints'], float)
    return a.shape == b.shape and np.abs(a-b).max() <= NEUTRAL_TOLERANCE


def load_stand():
    return json.loads(resources.files(__package__).joinpath(STAND_FILE).read_text(encoding='utf-8'))


def rig_reference(package_root):
    """The character's mean idle pose in the rig's RH frame, heading-normalised to the rest L->R Thigh axis:
    dict(clip, rotations: node name -> 3x3), or None without an idle clip of an ordinary stance."""
    package = Package(package_root, deep=False); rig_doc = package_rig(package)[0]
    humanoid = package_humanoid(package); rig = NativeRig(rig_doc, humanoid)
    # The actor archive as package_rig finds it; secondary_fit.actor_dir assumes the character packages' layout.
    entry = read_json(package.root/package.native_ref['file'])['characters'][0]
    archive = package.root/Path(package.native_ref['file']).parent/entry['actor_archive']['file']; actor = archive.parent
    rest = np.array([n['position']+n['rotation']+n['scale'] for n in rig_doc['nodes']], float)
    pack = package.root/Path(package.native_ref['file']).parent/package.native_entry['c7']['file']
    # The package's declared idle bases; a package without motion-bindings.json (the importer's fixtures) has none.
    bindings = read_json(pack.parent/'animation/motion-bindings.json') if (pack.parent/'animation/motion-bindings.json').exists() else {}
    wanted = bindings.get('idle_bases') or [bindings[k] for k in ('overview',) if k in bindings]
    found = {c['name']: read_json(actor/c['file']) for c in read_json(archive)['clips'] if c['name'] in wanted}
    # secondary_fit's body bones are Retarget's mapped bones with the pelvis in place of the hips.
    pelvis = secondary_fit.pack_pelvis(pack)
    nodes = [rig.hips]+[rig.ids[n] for n in secondary_fit.roles(rig_doc, humanoid, pelvis)[0]]
    lat_rest = rig.rest[rig.humanoid['rightUpperLeg'], :3, 3]-rig.rest[rig.humanoid['leftUpperLeg'], :3, 3]
    feet = [rig.humanoid[bone(side, 'Foot')] for side in 'LR']
    for name in (n for n in wanted if n in found):
        clip = found[name]
        times = np.linspace(0, clip['length'], max(2, int(round(clip['length']*import_generated.FPS))+1))
        pose = secondary_fit.sample_clip(actor, clip, rest, times, list(range(rig.N)))
        # Unity -> RH is NativeRig's mirrorX boundary.
        world = rig.fk(pose[..., 3:7]*[1, -1, -1, 1], pose[..., :3]*[-1, 1, 1])
        lat, _, hipw = hip_frame(rig, world)
        stance = np.abs(np.sum((world[:, feet[1], :3, 3]-world[:, feet[0], :3, 3])*lat, -1))/hipw
        if not REFERENCE_STANCE[0] <= np.median(stance) <= REFERENCE_STANCE[1]: continue
        H = yaw_to(lat, lat_rest); R = world_rotations(world)
        return dict(clip=name, rotations={rig.nodes[j]['name']: mean_rot(H@R[:, j]).tolist() for j in nodes})
    return None


def calibrate(convert, stand, reference):
    """Point a SomaToRig's calibration at the reference poses: the stand pose retargets to the rig's idle pose."""
    ret, rig = convert.ret, convert.rig; C = ret.C
    Rs = {ret.si[n]: np.array(m, float) for n, m in stand['rotations'].items()}
    Rr = {rig.ids[n]: np.array(m, float) for n, m in reference['rotations'].items() if n in rig.ids}
    for j, k in ret.mapping.items(): ret.cal[j] = (C@Rs[k]@C.T).T@Rr[j]
    ret.root_cal = (C@np.array(stand['body_basis'], float)@ret.sb.T@C.T).T@Rr[rig.hips]


def knee_swivel(rig, Q, T, target):
    """Rotate each seated leg about its hip->ankle axis so the knees' lateral gap narrows toward target hip widths.
    The weight follows the thigh's angle from straight down, so standing frames stay unchanged. Ankle positions and
    foot world rotations are kept. Q, T: (F, N, 4/3) RH local; returns the edited copy of Q."""
    Q = Q.copy(); ids = rig.humanoid; limit = np.radians(SWIVEL_MAX_DEG)
    world = rig.fk(Q, T); lat, centre, hipw = hip_frame(rig, world)
    for side, sign in (('L', -1), ('R', 1)):
        th, ca, fo = (ids[bone(side, n)] for n in ('UpperLeg', 'LowerLeg', 'Foot')); prev = 0.0
        for f in range(len(Q)):
            h, k, a = (world[f, j, :3, 3] for j in (th, ca, fo))
            down = np.degrees(np.arccos(np.clip(-unit(k-h)[1], -1, 1)))
            weight = smoothstep((down-SEATED_THIGH_DEG[0])/(SEATED_THIGH_DEG[1]-SEATED_THIGH_DEG[0]))
            u = unit(a-h); o = (k-h)-((k-h)@u)*u; v = np.cross(u, o)
            # The knee's outward lateral offset after a turn by theta about u: c0 + A cos(theta) + B sin(theta).
            c0 = sign*((h+((k-h)@u)*u-centre[f])@lat[f]); A, B = sign*(o@lat[f]), sign*(v@lat[f])
            now, radius = c0+A, np.hypot(A, B)
            if weight == 0 or now <= target/2*hipw[f] or radius < 1e-9: prev = 0.0; continue
            goal = now-weight*(now-target/2*hipw[f])
            base = np.arctan2(B, A); d = np.arccos(np.clip((goal-c0)/radius, -1, 1))
            theta = min((base+d, base-d), key=lambda x: abs(np.angle(np.exp(1j*(x-prev)))))
            theta = float(np.clip(np.angle(np.exp(1j*theta)), -limit, limit)); prev = theta
            turn = rotation.as_matrix(rotation.from_rotvec(u*theta))
            P = world_rotations(world[f, rig.parent[th]]); thigh = P.T@turn@P@rotation.as_matrix(Q[f, th])
            Q[f, th] = rotation.from_matrix(thigh)
            Q[f, fo] = rotation.from_matrix((P@thigh@rotation.as_matrix(Q[f, ca])).T@world_rotations(world[f, fo]))
    return Q


def narrow_stance(rig, Q, T, contacts, ankle_column, target, max_shift=0.10):
    """Move each planted foot toward the midline so its ankle sits at most target/2 hip widths from the hip centre.
    One horizontal shift per contact interval, measured at its middle frame and capped at max_shift metres;
    smoothstep between intervals, held before the first and after the last. Q, T: (F, N, 4/3) RH local; returns the
    edited copy of Q."""
    Q = Q.copy(); ids = rig.humanoid; F = len(Q)
    world = rig.fk(Q, T); lat, centre, hipw = hip_frame(rig, world)
    for side in 'LR':
        th, ca, fo, to = (ids[bone(side, n)] for n in ('UpperLeg', 'LowerLeg', 'Foot', 'Toes'))
        keys = []
        for first, last in import_generated.contact_intervals(contacts[:, ankle_column[side]]):
            m = (first+last)//2; d = (world[m, fo, :3, 3]-centre[m])@lat[m]
            keys.append((first, last, -np.sign(d)*min(max(abs(d)-target/2*hipw[m], 0), max_shift)*lat[m]))
        if not keys: continue
        shift = np.repeat(keys[0][2][None], F, 0)
        for (_, last, a), (first, _, b) in zip(keys, keys[1:]):
            shift += smoothstep((np.arange(F)-last)/(first-last))[:, None]*(b-a)
        for f in range(F):
            if not shift[f].any(): continue
            w = world[f]; fwd = w[to, :3, 3]-w[fo, :3, 3]; fwd[1] = 0
            rig.solve_limb(Q[f], T[f], (th, ca, fo), w[fo, :3, 3]+shift[f], endR=rig.rotations(w)[fo],
                           hint=(w[ca, :3, 3]-w[th, :3, 3])+.05*unit(fwd))
    return Q


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    stand = sub.add_parser('stand', help="write Kimodo's mean standing pose")
    stand.add_argument('--skeleton', type=Path, required=True)
    stand.add_argument('--npz', type=Path, nargs='+', required=True, help='standing samples, slot 0 of each')
    stand.add_argument('--out', type=Path, required=True)
    a = p.parse_args()
    write_json(a.out, stand_reference(read_json(a.skeleton), a.npz))


if __name__ == '__main__': main()
