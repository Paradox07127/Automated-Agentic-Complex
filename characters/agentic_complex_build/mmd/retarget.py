"""Evaluated MMD skeleton -> the supplied native rig's body/finger tracks, its bones by NativeRig.humanoid.
The rig adapter preserves each character's node count, original units and rest scales.
Uses the local rig_math module; no runtime dependency on research directories.

Mapping (MMD -> SOMA name -> humanoid bone):
  センター/グルーブ/全ての親 (FK ancestors) + 下半身 -> Hips -> hips (translation from the 足 midpoint,
      rotation = world 下半身; replaces Retarget's leg-line/neck basis so upper-body lean does not tilt the pelvis)
  上半身 -> Spine1, Spine2, Chest -> spine/chest/upperChest. Without 上半身2 all three take the world 上半身
      rotation (rigid, exactly MMD's single waist pivot); with 上半身2 Spine2 takes the half-way slerp and Chest 上半身2.
  首 -> Neck1, 頭 -> Head, 肩/腕/ひじ/手首 -> Shoulder/UpperArm/LowerArm/Hand, 足/ひざ/足首/つま先 -> UpperLeg/LowerLeg/Foot/Toes.
  腕捩/手捩 sit between 腕-ひじ and ひじ-手首, so FK folds them into the forearm/hand world rotation. Twist nodes
      (TWISTS): upper arm takes the 腕捩 roll, forearm the Hand's roll relative to the Forearm (手捩 + 手首); segment and
      child bones keep theirs.
  Fingers: 親指０/１/２ -> Finger0/01/02 (PMD has no 親指０: Finger0 keeps its rest pose relative to the hand and the two
      PMD thumb joints drive Finger01/02); 人指/中指/薬指/小指 １/２/３ -> Finger1..4 joints 0/1/2.
Calibration: Retarget's swing calibration for the arm/leg chain; feet use no swing (both rest feet stand flat);
hand and finger joints use a full frame (segment direction + index-to-little axis), so palm roll is preserved.
"""
import numpy as np
from . import rotation
from .rig_math import bone
from .skeleton import qmul, qconj, qpow, qrot, qmat

FACE_BONES = [
    'eyeRtJoint', 'faceRtIrisJoint', 'faceRtPupilJoint', 'faceRtHighlightJoint', 'eyeRt01Joint', 'eyeRt01EyelashJoint',
    'eyeRt02Joint', 'eyeRt02EyelashJoint', 'eyeRt03Joint', 'eyeRt03EyelashJoint', 'eyeRt03IrissdJoint', 'eyeRt04Joint',
    'eyeRt04EyelashJoint', 'eyeRt05Joint', 'eyeRt05EyelashJoint', 'eyeRt06Joint', 'eyeRt07Joint', 'eyeRt08Joint',
    'eyeLfJoint', 'faceLfIrisJoint', 'faceLfPupilJoint', 'faceLfHighlightJoint', 'eyeLf01Joint', 'eyeLf01EyelashJoint',
    'eyeLf02Joint', 'eyeLf02EyelashJoint', 'eyeLf03Joint', 'eyeLf03EyelashJoint', 'eyeLf03IrissdJoint', 'eyeLf04Joint',
    'eyeLf04EyelashJoint', 'eyeLf05Joint', 'eyeLf05EyelashJoint', 'eyeLf06Joint', 'eyeLf07Joint', 'eyeLf08Joint',
    'browRt01Joint', 'browRt02Joint', 'browRt03Joint', 'browRt04Joint', 'browRt05Joint', 'browLf01Joint',
    'browLf02Joint', 'browLf03Joint', 'browLf04Joint', 'browLf05Joint', 'faceLfCheekOtJoint', 'faceLfCheekOtDnJoint',
    'faceMdJawDnJoint', 'faceMdToothDnJoint', 'faceMdToothUpJoint', 'faceRtCheekOtJoint', 'faceRtCheekOtDnJoint',
    'browLineRt01Joint', 'browLineRt02Joint', 'browLineRt03Joint', 'browLineLf01Joint', 'browLineLf02Joint',
    'browLineLf03Joint', 'NoseMd01Joint', 'lipRup1Joint', 'lipRup2Joint', 'lipRup3Joint', 'lipRup4Joint',
    'lipMupJoint', 'lipLup4Joint', 'lipLup3Joint', 'lipLup2Joint', 'lipLup1Joint', 'lipRdn1Joint', 'lipRdn2Joint',
    'lipRdn3Joint', 'lipRdn4Joint', 'lipMdnJoint', 'lipLdn4Joint', 'lipLdn3Joint', 'lipLdn2Joint', 'lipLdn1Joint',
    'jawJoint', 'TongueMd01Joint', 'TongueMd02Joint', 'line_jnt', 'head_mid_jnt', 'head_up_jnt', 'head_dn_jnt']

SIDES = [('L', '左', 'Left'), ('R', '右', 'Right')]
MMD_FINGERS = {0: ['親指０', '親指１', '親指２'], 1: ['人指１', '人指２', '人指３'], 2: ['中指１', '中指２', '中指３'],
               3: ['薬指１', '薬指２', '薬指３'], 4: ['小指１', '小指２', '小指３']}
ARM = [('Shoulder', '肩'), ('Arm', '腕'), ('ForeArm', 'ひじ'), ('Hand', '手首')]
LEG = [('Leg', '足'), ('Shin', 'ひざ'), ('Foot', '足首'), ('ToeBase', 'つま先')]
NATIVE_ARM = {'Shoulder': 'Clavicle', 'Arm': 'UpperArm', 'ForeArm': 'Forearm', 'Hand': 'Hand'}
NATIVE_LEG = {'Leg': 'Thigh', 'Shin': 'Calf', 'Foot': 'Foot', 'ToeBase': 'Toe0'}
PALM_FRACTION = .65  # same palm-centre fraction of wrist->middle-finger-base as Rig.palm
# Roll source (MMD twist bone, or None = the VoiceA segment child's roll relative to the segment, from bind), the MMD bone its
# roll axis points to, VoiceA segment, its child (humanoid bones), twist nodes (extras.twist names), cumulative share of
# the roll on each node (node at the segment start, then mid-segment, its child). Upper arm: the centre of the half segment each
# node skins, as miku_v2 spreads 腕捩 (腕捩1/2/3 at 25/50/75%). Forearm: VoiceA's own clips keep the twist on Hand and
# put 1/3 and 2/3 of it on these nodes; the skin weights are painted for that split.
TWISTS = [('腕捩', 'ひじ', 'UpperArm', 'LowerArm', ['UpperArmTwist', 'UpperArmTwist1'], (.25, .75)),
          (None, '手首', 'LowerArm', 'Hand', ['LowerArmTwist', 'LowerArmTwist1'], (1 / 3, 2 / 3))]


def unit(v):
    v = np.asarray(v, float)
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


def basis(a, b):
    x = unit(a)
    y = unit(b - x * np.dot(b, x))
    return np.stack([x, y, np.cross(x, y)], axis=1)


class MmdSource:
    """SOMA-style joints that Retarget expects, each a point attached rigidly to one MMD bone."""

    def __init__(self, sk, rig):
        self.sk = sk
        need = ['下半身', '上半身', '首', '頭'] + [s + m for _, s, _ in SIDES for _, m in ARM + LEG] + [s + '中指１' for _, s, _ in SIDES]
        miss = [n for n in need if n not in sk.idx]
        if miss:
            raise ValueError('PMD lacks bones: %s' % miss)
        b = sk.idx
        self.upper2 = b.get('上半身2')
        ids = rig.humanoid
        sp, s1, s2, nk = (rig.rest[ids[n], :3, 3] for n in ['spine', 'chest', 'upperChest', 'neck'])
        L = np.linalg.norm(nk - sp)
        self.fractions = (float(np.linalg.norm(s1 - sp) / L), float(np.linalg.norm(s2 - sp) / L))
        u0, n0 = sk.rest[b['上半身']], sk.rest[b['首']]
        names, parents, attach = [], [], []

        def add(name, parent, bone, point, rot):
            names.append(name)
            parents.append(names.index(parent) if parent else -1)
            attach.append((bone, np.asarray(point, float), rot))
        add('Hips', None, None, None, ('bone', b['下半身']))
        add('Spine1', 'Hips', b['上半身'], u0, ('bone', b['上半身']))
        for name, parent, f in [('Spine2', 'Spine1', self.fractions[0]), ('Chest', 'Spine2', self.fractions[1])]:
            p = u0 + f * (n0 - u0)
            on_upper2 = self.upper2 is not None and sk.rest[self.upper2][1] <= p[1]
            if self.upper2 is None:
                rot = ('bone', b['上半身'])
            elif name == 'Spine2':
                rot = ('half', b['上半身'], self.upper2)
            else:
                rot = ('bone', self.upper2)
            add(name, parent, self.upper2 if on_upper2 else b['上半身'], p, rot)
        add('Neck1', 'Chest', b['首'], n0, ('bone', b['首']))
        add('Head', 'Neck1', b['頭'], sk.rest[b['頭']], ('bone', b['頭']))
        for _, s, w in SIDES:
            parent = 'Chest'
            for soma, m in ARM:
                add(w + soma, parent, b[s + m], sk.rest[b[s + m]], ('bone', b[s + m]))
                parent = w + soma
            add(w + 'HandTip', w + 'Hand', b[s + '手首'], sk.rest[b[s + '中指１']], ('bone', b[s + '手首']))
        for _, s, w in SIDES:
            parent = 'Hips'
            for soma, m in LEG:
                add(w + soma, parent, b[s + m], sk.rest[b[s + m]], ('bone', b[s + m]))
                parent = w + soma
        self.names, self.parents, self.attach = names, parents, attach
        self.legs = (b['左足'], b['右足'])
        self.neutral = self.positions(sk.rest[None], np.tile([0, 0, 0, 1.0], (1, sk.B, 1)))[0]

    def positions(self, wp, wq):
        out = np.zeros((wp.shape[0], len(self.names), 3))
        for j, (bone, point, _) in enumerate(self.attach):
            if bone is None:
                out[:, j] = (wp[:, self.legs[0]] + wp[:, self.legs[1]]) / 2
            else:
                out[:, j] = wp[:, bone] + qrot(wq[:, bone], point - self.sk.rest[bone])
        return out

    def rotations(self, wq):
        out = np.zeros((wq.shape[0], len(self.names), 4))
        for j, (_, _, rot) in enumerate(self.attach):
            if rot[0] == 'bone':
                out[:, j] = wq[:, rot[1]]
            else:
                a, c = wq[:, rot[1]], wq[:, rot[2]]
                out[:, j] = qmul(a, qpow(qmul(qconj(a), c), .5))
        return qmat(out)

    def skeleton(self):
        return {'names': self.names, 'neutral_joints': self.neutral.tolist(), 'parents': self.parents}


def mmd_child_dir(sk, m):
    kids = sk.children[m]
    if kids:
        return sk.rest[kids[0]] - sk.rest[m]
    b = sk.pmd.bones[m]
    if b.type != 9 and 0 < b.tail < sk.B and b.tail != m:
        return sk.rest[b.tail] - sk.rest[m]
    return sk.rest[m] - sk.rest[sk.parent[m]]


class VmdToNative:
    def __init__(self, rig, Retarget, sk):
        self.rig, self.sk = rig, sk
        self.src = MmdSource(sk, rig)
        self.ret = Retarget(rig, self.src.skeleton())
        r, C, b = rig, self.ret.C, sk.idx
        self.C = C
        self.face = [r.ids[n] for n in FACE_BONES if n in r.ids]
        self.fingers = []  # (voice_a node, mmd bone or None, cal)
        self.hand_frame = {}
        ids = r.humanoid
        for side, s, _ in SIDES:
            foot = ids[bone(side, 'Foot')]
            self.ret.cal[foot] = r.restR[foot]
            h = ids[bone(side, 'Hand')]
            p_across = r.rest[ids[bone(side, 'IndexProximal')], :3, 3] - r.rest[ids[bone(side, 'LittleProximal')], :3, 3]
            s_across = sk.rest[b[s + '人指１']] - sk.rest[b[s + '小指１']] if s + '人指１' in b and s + '小指１' in b else None
            if s_across is None:
                raise ValueError('PMD lacks 人指１/小指１ for the hand frame')
            p_fwd = r.rest[ids[bone(side, 'MiddleProximal')], :3, 3] - r.rest[h, :3, 3]
            s_fwd = sk.rest[b[s + '中指１']] - sk.rest[b[s + '手首']]
            self.ret.cal[h] = basis(C @ s_fwd, C @ s_across) @ basis(p_fwd, p_across).T @ r.restR[h]
            self.hand_frame[side] = (p_across, s_across)
            for n, mnames in MMD_FINGERS.items():
                chain = r.finger(side, n)
                if None in chain:
                    raise ValueError('rig lacks finger %d joints on side %s' % (n, side))
                for k, mname in enumerate(mnames):
                    p = chain[k]
                    m = b.get(s + mname)
                    if m is None:
                        self.fingers.append((p, None, None, s + mname))
                        continue
                    pd = r.rest[chain[k + 1], :3, 3] - r.rest[p, :3, 3]
                    G = basis(C @ mmd_child_dir(sk, m), C @ s_across) @ basis(pd, p_across).T
                    self.fingers.append((p, m, G @ r.restR[p], s + mname))
        self.leg = {side: tuple(ids[bone(side, x)] for x in ['UpperLeg', 'LowerLeg', 'Foot', 'Toes']) for side in 'LR'}
        self.src_ankle = {'L': b['左足首'], 'R': b['右足首']}
        assert np.linalg.det(C) > 0  # a roll angle keeps its sense from MMD to VoiceA
        # (MMD twist bone or None, roll axis (MMD rest frame, or the VoiceA segment's frame for None), VoiceA segment
        # child, [(VoiceA node, roll axis in its parent's frame)], shares)
        self.twist = []
        for side, s, _ in SIDES:
            for mmd, nxt, seg, end, nodes, shares in TWISTS:
                if mmd is not None and s + mmd not in b:
                    continue
                S, E = ids[bone(side, seg)], ids[bone(side, end)]
                axis = unit(r.rest[E, :3, 3] - r.rest[S, :3, 3])
                u = r.restR[S].T @ axis if mmd is None else unit(sk.rest[b[s + nxt]] - sk.rest[b[s + mmd]])
                js = [ids[bone(side, n)] for n in nodes if bone(side, n) in ids]
                self.twist.append((None if mmd is None else b[s + mmd], u, E,
                                   [(j, r.restR[r.parent[j]].T @ axis) for j in js], shares))

    def mapping_table(self):
        """MMD bone -> VoiceA nodes it drives directly."""
        r, sk = self.rig, self.sk
        inv = {v: k for k, v in self.ret.si.items()}
        table = {}
        for j, k in self.ret.mapping.items():
            soma = inv[k]
            src_j = self.src.names.index(soma)
            bone, _, rot = self.src.attach[src_j]
            bones = [rot[1]] if rot[0] == 'bone' else [rot[1], rot[2]]
            if soma == 'Hips':
                bones = [sk.idx['下半身']]
            for m in bones:
                table.setdefault(sk.names[m], []).append(r.nodes[j]['name'])
        for p, m, _, _ in self.fingers:
            if m is not None:
                table.setdefault(sk.names[m], []).append(r.nodes[p]['name'])
        return table

    def apply_world(self, q, t, targets):
        """World matrices (F,N,4,4) of q (F,N,4), t (F,N,3), each node of targets first turned in q to its world
        rotation targets[j] (F,3,3)."""
        r = self.rig
        local = np.zeros(q.shape[:-1] + (4, 4))
        local[..., :3, :3] = rotation.as_matrix(q) * r.s[:, None, :]
        local[..., :3, 3] = t
        local[..., 3, 3] = 1
        world = np.zeros_like(local)
        eye = np.broadcast_to(np.eye(4), (len(q), 4, 4))
        for j in r.order:
            par = r.parent[j]
            pw = eye if par < 0 else world[:, par]
            if j in targets:
                q[:, j] = rotation.from_matrix(np.linalg.inv(pw[:, :3, :3]) @ targets[j])
                local[:, j, :3, :3] = rotation.as_matrix(q[:, j]) * r.s[j][None, :]
            world[:, j] = pw @ local[:, j]
        return world

    def spread_twists(self, q, lq):
        """Roll each VoiceA twist node (still at its rest local rotation) by its share of the roll; the shares are
        cumulative because the second node is the first one's child. q (F,N,4), lq (F,B,4)."""
        r = self.rig
        for m, u, E, nodes, shares in self.twist:
            d = lq[:, m] if m is not None else rotation.compose(q[:, E], rotation.inv(r.q0[E]))
            tau = _twist_angle(d, u)
            prev = 0.0
            for (j, axis), share in zip(nodes, shares):
                q[:, j] = rotation.compose(rotation.from_rotvec(axis * (share - prev) * tau[:, None]), q[:, j])
                prev = share

    def bake(self, ev, foot_ik=False, frames=None, init=None, progress=None):
        """ev: MmdSkeleton.evaluate output. init: source hips position the root offset is measured from (None = frame 0;
        a single-frame pose needs the source rest hips, or a crouch keeps the rest hip height and lifts the feet).
        progress: called with the fraction of frames baked, at least every 2% of them, the last time with 1.
        Returns Q (F,N,4), T (F,N,3), P world positions (F,N,3), info."""
        r, ret, C = self.rig, self.ret, self.C
        wq, wp = ev['wq'], ev['wp']
        F = wq.shape[0] if frames is None else frames
        xyz = self.src.positions(wp[:F], wq[:F])
        srcR = self.src.rotations(wq[:F])
        Rm = ev['R'][:F]
        lower = self.sk.idx['下半身']
        init = xyz[0, ret.si['Hips']] if init is None else init
        Q = np.zeros((F, r.N, 4))
        T = np.zeros((F, r.N, 3))
        P = np.zeros((F, r.N, 3))
        overshoot = np.zeros((F, 2))
        # Frames are baked in blocks; they depend on each other only through foot IK's frame-0 ankles.
        step = max(1, F // 50)
        for first in range(0, F, step):
            s = slice(first, first + step)
            q, t, world = ret.frames(xyz[s], srcR[s], init)
            R = r.rotations(world)
            targets = {j: R[:, j] for j in ret.mapping}
            targets[r.hips] = C @ Rm[s, lower] @ C.T @ r.restR[r.hips]
            for p, m, cal, _ in self.fingers:
                if m is not None:
                    targets[p] = C @ Rm[s, m] @ C.T @ cal
            w = self.apply_world(q, t, targets)
            if first == 0:
                ankle0 = {side: w[0, self.leg[side][2], :3, 3].copy() for side in 'LR'}
            if foot_ik:
                Rw = r.rotations(w)
                for k, side in enumerate('LR'):
                    th, ca, fo, to = self.leg[side]
                    a = self.src_ankle[side]
                    goal = ankle0[side] + (wp[s, a] - wp[0, a]) @ (ret.scale * C).T
                    fwd = w[:, to, :3, 3] - w[:, fo, :3, 3]
                    fwd[:, 1] = 0
                    hint = (w[:, ca, :3, 3] - w[:, th, :3, 3]) + .05 * unit(fwd)
                    # Rig.solve_limb over the block's frames.
                    lw = r.fk(q, t, [th, ca, fo])
                    wa, wb = r.rotations(lw[:, [th, ca]]).swapaxes(0, 1)
                    p, e, h = lw[:, th, :3, 3], lw[:, ca, :3, 3], lw[:, fo, :3, 3]
                    l1, l2 = np.linalg.norm(e - p, axis=-1), np.linalg.norm(h - e, axis=-1)
                    d = goal - p
                    rawdist = np.linalg.norm(d, axis=-1)
                    d = unit(d)
                    dist = np.clip(rawdist, abs(l1 - l2) + 1e-6, l1 + l2 - 1e-6)
                    along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist)
                    height = np.sqrt(np.maximum(0, l1 * l1 - along * along))
                    pole = hint - d * np.sum(hint * d, -1, keepdims=True)
                    pole = np.where(np.linalg.norm(pole, axis=-1, keepdims=True) < 1e-6,
                                    np.where(abs(d[:, 2:]) < .8, np.cross(d, [0, 0, 1]), np.cross(d, [1, 0, 0])), pole)
                    desired_elbow = p + d * along[:, None] + unit(pole) * height[:, None]
                    clamped = p + d * dist[:, None]
                    for j, R in ((th, _swing(e - p, desired_elbow - p) @ wa), (ca, _swing(h - e, clamped - desired_elbow) @ wb),
                                 (fo, Rw[:, fo])):
                        par = r.parent[j]
                        q[:, j] = rotation.from_matrix(np.linalg.inv(r.fk(q, t, [par])[:, par, :3, :3]) @ R)
                    overshoot[s, k] = np.maximum(0, rawdist - l1 - l2)
            self.spread_twists(q, ev['lq'][s])
            Q[s], T[s] = q, t
            P[s] = r.fk(q, t)[..., :3, 3]
            if progress is not None:
                progress(min(first + step, F) / F)
        return {'Q': Q, 'T': T, 'P': P, 'xyz': xyz, 'overshoot_max_m': float(overshoot.max()), 'scale': float(ret.scale)}


def _swing(a, b):
    """rig_math.swing over a leading frame axis: a, b (F,3) -> (F,3,3)."""
    a, b = unit(a), unit(b)
    v = np.cross(a, b)
    c = np.sum(a * b, -1)
    k = np.zeros(a.shape + (3,))
    k[:, 0, 1], k[:, 0, 2], k[:, 1, 2] = -v[:, 2], v[:, 1], -v[:, 0]
    k[:, 1, 0], k[:, 2, 0], k[:, 2, 1] = v[:, 2], -v[:, 1], v[:, 0]
    axis = unit(np.where(abs(a[:, :1]) < .8, np.cross(a, [1, 0, 0]), np.cross(a, [0, 1, 0])))
    return np.where((c < -.999999)[:, None, None], rotation.as_matrix(rotation.from_rotvec(axis * np.pi)),
                    np.eye(3) + k + k @ k / np.maximum(1 + c, 1e-12)[:, None, None])


def _twist_angle(q, u):
    q = q * np.where(q[..., 3:] >= 0, 1, -1)
    return 2 * np.arctan2(q[..., :3] @ u, q[..., 3])


def source_palms(sk, ev, scale=1.0):
    """Palm centre (F,3) and palmar normal (F,3) per side for the MMD source (hand rest is palm-down with the index
    finger forward, so palmar = forward x across on the left and across x forward on the right)."""
    out = {}
    for side, s, _ in SIDES:
        h, mid, ix, lt = (sk.idx[s + n] for n in ['手首', '中指１', '人指１', '小指１'])
        wq, wp = ev['wq'], ev['wp']
        fwd = qrot(wq[:, h], np.broadcast_to(sk.rest[mid] - sk.rest[h], wp[:, h].shape))
        across = qrot(wq[:, h], np.broadcast_to(sk.rest[ix] - sk.rest[lt], wp[:, h].shape))
        n = np.cross(fwd, across) if side == 'L' else np.cross(across, fwd)
        out[side] = ((wp[:, h] + PALM_FRACTION * fwd) * scale, unit(n))
    return out


def coverage(conv, vmd):
    """Every keyed VMD bone -> mapped / ignored with a reason; morph keys are dropped (faces out of scope)."""
    from .io import name_key
    sk = conv.sk
    table = conv.mapping_table()
    direct = {sk.idx[n] for n in table}
    anc = set()
    for m in direct:
        p = sk.parent[m]
        while p >= 0:
            anc.add(int(p))
            p = sk.parent[p]
    ik_bones = {}
    for ik in sk.iks:
        if set(ik['chain']) & (direct | anc):
            p = ik['bone']
            ik_bones[p] = ik
            p = sk.parent[p]
            while p >= 0:
                ik_bones.setdefault(int(p), ik)
                p = sk.parent[p]
    rows = []
    for name in sorted({k.name for k in vmd.bones}):
        i = sk.key_idx.get(name_key(name))
        n_keys = sum(1 for k in vmd.bones if k.name == name)
        if i is None:
            st, why = 'ignored', 'bone not in the PMD (MMD ignores such keys too)'
        elif sk.names[i] in table:
            st, why = 'mapped', 'drives ' + ', '.join(table[sk.names[i]])
        elif i in ik_bones:
            st, why = 'mapped', 'CCD IK goal for %s chain (%s)' % (ik_bones[i]['name'], ', '.join(sk.names[c] for c in ik_bones[i]['chain']))
        elif i in anc:
            st, why = 'mapped', 'FK ancestor of mapped bones; folded into their world transforms'
        elif '目' in name:
            st, why = 'ignored', 'eye bone: face is out of scope, the 85 VoiceA face bones are never written'
        else:
            st, why = 'ignored', 'no VoiceA counterpart'
        rows.append({'bone': name, 'keys': n_keys, 'status': st, 'reason': why})
    morphs = sorted({m.name for m in vmd.morphs})
    return {'bones': rows, 'mapped': sum(r['status'] == 'mapped' for r in rows), 'ignored': sum(r['status'] == 'ignored' for r in rows),
            'morph_keys': len(vmd.morphs), 'morph_names': morphs, 'morph_status': 'dropped: faces are out of scope'}
