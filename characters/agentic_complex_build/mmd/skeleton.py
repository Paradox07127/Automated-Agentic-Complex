"""MMD skeleton evaluation in right-handed space: FK, CCD IK (PMD IK list, knee hinge), rotation-influence bones.

Conversion from MMD (left-handed, Y up, faces -Z): position z -> -z, quaternion (x, y, z, w) -> (-x, -y, z, w).
After it the model faces +Z with its left side on +X, like the VoiceA GLB. Units stay MMD units.
"""
from dataclasses import replace
import numpy as np
from .io import PmdBone, name_key, sample_vmd, ik_enabled, last_frame

FLIP = np.array([1.0, 1.0, -1.0])
QFLIP = np.array([-1.0, -1.0, 1.0, 1.0])
KNEE_RANGE = (np.radians(0.5), np.pi)  # saba MMDIkSolver knee limits about +X in right-handed space


def qmul(a, b):
    ax, ay, az, aw = np.moveaxis(a, -1, 0)
    bx, by, bz, bw = np.moveaxis(b, -1, 0)
    return np.stack([aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw,
                     aw * bw - ax * bx - ay * by - az * bz], -1)


def qconj(q):
    return q * np.array([-1.0, -1.0, -1.0, 1.0])


def qrot(q, v):
    u = q[..., :3]
    w = q[..., 3:]
    t = 2 * np.cross(u, v)
    return v + w * t + np.cross(u, t)


def qmat(q):
    x, y, z, w = np.moveaxis(q, -1, 0)
    return np.stack([np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], -1),
                     np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], -1),
                     np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1)], -2)


def qaxis(axis, angle):
    axis = np.asarray(axis, float)
    angle = np.asarray(angle, float)[..., None]
    return np.concatenate([axis * np.sin(angle / 2), np.cos(angle / 2)], -1)


def qpow(q, w):
    """Rotation scaled by weight w (slerp from identity)."""
    q = q * np.where(q[..., 3:] < 0, -1, 1)
    ang = 2 * np.arccos(np.clip(q[..., 3], -1, 1))
    s = np.sin(ang / 2)
    axis = np.where(s[..., None] > 1e-9, q[..., :3] / np.maximum(s, 1e-12)[..., None], [1.0, 0.0, 0.0])
    return qaxis(axis, ang * w)


def qangle(q):
    return 2 * np.arccos(np.clip(np.abs(q[..., 3]), 0, 1))


def to_rh_pos(p):
    return np.asarray(p, float) * FLIP


def to_rh_quat(q):
    return np.asarray(q, float) * QFLIP


class MmdSkeleton:
    """Bones from a PMD; rest heads in right-handed MMD units; local frames are world-aligned at rest."""

    def __init__(self, pmd):
        self.pmd = pmd
        self.names = [b.name for b in pmd.bones]
        self.B = len(self.names)
        self.idx = {n: i for i, n in enumerate(self.names)}
        self.key_idx = {name_key(n): i for i, n in enumerate(self.names)}  # VMD names are cut at 15 bytes
        self.parent = np.array([b.parent for b in pmd.bones])
        self.rest = to_rh_pos([b.pos for b in pmd.bones])
        self.order = []
        seen = set()

        def visit(i):
            if i in seen:
                return
            if self.parent[i] >= 0:
                visit(self.parent[i])
            seen.add(i)
            self.order.append(i)
        for i in range(self.B):
            visit(i)
        self.children = {i: [] for i in range(self.B)}
        for i in range(self.B):
            if self.parent[i] >= 0:
                self.children[self.parent[i]].append(i)
        rank = {b: k for k, b in enumerate(self.order)}
        self.subtree = {}
        for i in range(self.B):
            sub, stack = [], [i]
            while stack:
                j = stack.pop()
                sub.append(j)
                stack.extend(self.children[j])
            self.subtree[i] = sorted(sub, key=rank.get)
        # PMD type 5 (回転影響下): copies the local rotation of bone `ik`; type 9 (回転運動): same with weight tail/100
        # (MMD Tools PMD import convention). Influences are applied to VMD local rotations before IK.
        self.influence = []
        for i, b in enumerate(pmd.bones):
            if b.type == 5 and 0 <= b.ik < self.B:
                self.influence.append((i, b.ik, 1.0))
            elif b.type == 9 and 0 <= b.ik < self.B:
                self.influence.append((i, b.ik, b.tail * 0.01))
        self.influence.sort(key=lambda x: rank[x[0]])
        self.iks = []
        for k in pmd.iks:
            self.iks.append({'bone': k.bone, 'target': k.target, 'iterations': k.iterations, 'limit': k.limit * 4.0,
                             'chain': list(k.chain), 'knee': [('ひざ' in self.names[c]) for c in k.chain],
                             'name': self.names[k.bone]})

    def locals_from_vmd(self, vmd, n_frames=None, frame_times=None):
        """Local (F,B,4) rotations and (F,B,3) translations in RH, the keyed bone names and unknown names."""
        if frame_times is not None:
            frame_times = np.asarray(frame_times, float)
            n_frames = len(frame_times)
        elif n_frames is None:
            n_frames = last_frame(vmd) + 1
        samples = sample_vmd(vmd, n_frames, frame_times=frame_times)
        lq = np.zeros((n_frames, self.B, 4))
        lq[..., 3] = 1
        lt = np.zeros((n_frames, self.B, 3))
        missing = []
        for name, (pos, rot) in samples.items():
            i = self.key_idx.get(name_key(name))
            if i is None:
                missing.append(name)
                continue
            lq[:, i] = to_rh_quat(rot)
            lt[:, i] = to_rh_pos(pos)
        return lq, lt, sorted(samples), sorted(missing)

    def apply_influence(self, lq):
        lq = lq.copy()
        for b, src, w in self.influence:
            lq[:, b] = qmul(qpow(lq[:, src], w), lq[:, b])
        return lq

    def fk(self, lq, lt, bones=None, wq=None, wp=None, mask=None):
        """World rotations (F,B,4) and positions (F,B,3). With `bones`, recompute only those (parents first)
        into existing wq/wp, for frames in `mask`."""
        F = lq.shape[0]
        if bones is None:
            wq = np.zeros((F, self.B, 4))
            wp = np.zeros((F, self.B, 3))
            bones = self.order
            mask = slice(None)
        for b in bones:
            p = self.parent[b]
            if p < 0:
                wq[mask, b] = lq[mask, b]
                wp[mask, b] = self.rest[b] + lt[mask, b]
            else:
                wq[mask, b] = qmul(wq[mask, p], lq[mask, b])
                wp[mask, b] = wp[mask, p] + qrot(wq[mask, p], self.rest[b] - self.rest[p] + lt[mask, b])
        return wq, wp

    def solve_ik(self, lq, lt, wq, wp, enabled=None):
        """PMD IK entries in list order, every frame from its own VMD pose as in three.js MMDAnimationHelper.
        Two-bone knee chains are solved in closed form (`_knee_from_reach`); the rest use CCD (three.js
        CCDIKSolver rules, knee links projected to a positive rotation about +X). Returns updated lq, wq, wp."""
        F = lq.shape[0]
        lq = lq.copy()
        on = {}
        for ik in self.iks:
            on[ik['name']] = np.ones(F, bool)
            if enabled is not None:
                for nm, arr in enabled.items():
                    if name_key(nm) == name_key(ik['name']):
                        on[ik['name']] = arr[:F].copy()
        self._ccd(lq, lt, wq, wp, on)
        return lq, wq, wp

    def _knee_from_reach(self, ik, lq, lt, wq, wp, on):
        """Set the knee hinge so that |hip -> ankle| equals |hip -> goal|, clamped to KNEE_RANGE. CCD from a
        near-straight knee gains under a degree per iteration and stops 2-3 cm short within 40 iterations; its
        knee step also undoes a correct bend while the hip is still off, so the hip gets no CCD loop after this."""
        knee, hip = ik['chain']
        eff = ik['target']
        a = self.rest[knee] - self.rest[hip] + lt[:, knee]  # thigh in the hip frame (the knee's parent)
        c = self.rest[eff] - self.rest[knee] + lt[:, eff]  # shin in the knee frame
        d2 = np.sum((wp[:, ik['bone']] - wp[:, hip]) ** 2, 1)
        # |a + Rx(t) c|^2 = |a|^2 + |c|^2 + 2 (a_x c_x + r cos(t + phi)), r and phi from the (y, z) parts
        r = np.hypot(a[:, 1], a[:, 2]) * np.hypot(c[:, 1], c[:, 2])
        phi = np.arctan2(a[:, 1] * c[:, 2] - a[:, 2] * c[:, 1], a[:, 1] * c[:, 1] + a[:, 2] * c[:, 2])
        cos_t = (d2 - np.sum(a * a, 1) - np.sum(c * c, 1) - 2 * a[:, 0] * c[:, 0]) / np.maximum(2 * r, 1e-12)
        base = np.arccos(np.clip(cos_t, -1, 1))
        lo, hi = KNEE_RANGE
        cand = np.stack([base - phi, -base - phi], 1)
        cand = (cand + np.pi) % (2 * np.pi) - np.pi
        inside = (cand >= lo) & (cand <= hi)
        t = np.where(inside[:, 0], cand[:, 0], np.where(inside[:, 1], cand[:, 1], np.clip(cand[:, 0], lo, hi)))
        t = np.where(inside.all(1), cand.min(1), t)
        lq[on, knee] = qaxis(np.array([1.0, 0.0, 0.0]), t[on])
        self.fk(lq, lt, self.subtree[knee], wq, wp, on)

    def _ccd(self, lq, lt, wq, wp, on_by_ik):
        F = lq.shape[0]
        for ik in self.iks:
            on = on_by_ik[ik['name']]
            if not on.any():
                continue
            goal = wp[:, ik['bone']].copy()
            eff = ik['target']
            chain, knees, iterations = ik['chain'], ik['knee'], ik['iterations']
            if len(chain) == 2 and knees[0]:
                # two-bone leg: knee from reach, then one shortest-arc turn of the hip lands the ankle on the goal
                self._knee_from_reach(ik, lq, lt, wq, wp, on)
                chain, knees, iterations = chain[1:], knees[1:], 1
            for _ in range(iterations):
                rotated = np.zeros(F, bool)
                for link, knee in zip(chain, knees):
                    inv = qconj(wq[:, link])
                    ev = qrot(inv, wp[:, eff] - wp[:, link])
                    tv = qrot(inv, goal - wp[:, link])
                    ne = np.linalg.norm(ev, axis=1)
                    nt = np.linalg.norm(tv, axis=1)
                    ok = on & (ne > 1e-9) & (nt > 1e-9)
                    ev = ev / np.maximum(ne, 1e-12)[:, None]
                    tv = tv / np.maximum(nt, 1e-12)[:, None]
                    ang = np.arccos(np.clip(np.sum(ev * tv, 1), -1, 1))
                    ok &= ang > 1e-5
                    ang = np.minimum(ang, ik['limit'])
                    axis = np.cross(ev, tv)
                    na = np.linalg.norm(axis, axis=1)
                    ok &= na > 1e-9
                    if not ok.any():
                        continue
                    axis = axis / np.maximum(na, 1e-12)[:, None]
                    new = qmul(lq[:, link], qaxis(axis, ang))
                    if knee:
                        new = new * np.where(new[:, 3:] < 0, -1, 1)
                        c = np.clip(new[:, 3], -1, 1)
                        new = np.stack([np.sqrt(1 - c * c), np.zeros(F), np.zeros(F), c], 1)
                    lq[ok, link] = new[ok]
                    self.fk(lq, lt, self.subtree[link], wq, wp, ok)
                    rotated |= ok
                if not rotated.any():
                    break

    def evaluate(self, lq, lt, enabled=None):
        """Full pose: influence bones, FK, CCD IK. Returns dict with lq, wq, wp, R (F,B,3,3)."""
        lq = self.apply_influence(lq)
        wq, wp = self.fk(lq, lt)
        lq, wq, wp = self.solve_ik(lq, lt, wq, wp, enabled)
        return {'lq': lq, 'wq': wq, 'wp': wp, 'R': qmat(wq)}

    def evaluate_vmd(self, vmd, n_frames=None, translation_scale=1.0, frame_times=None):
        lq, lt, keyed, missing = self.locals_from_vmd(vmd, n_frames, frame_times=frame_times)
        lt = lt * translation_scale  # every bone's position keys, like MMD's ボーンフレーム位置角度補正
        out = self.evaluate(lq, lt, ik_enabled(vmd, lq.shape[0], frame_times=frame_times))
        out.update(lt=lt, keyed=keyed, missing=missing)
        return out

def add_semi_standard_bones(pmd):
    """Copy of a PMD with the semi-standard body bones it lacks appended (全ての親, グルーブ, 上半身2, 足IK親, 親指０), so
    VMDs made for semi-standard models keep those keys. Each new bone is inserted between an existing bone and its
    children, at rest identity, so a VMD that does not key it gives the same pose. Placement: 全ての親 at the origin;
    グルーブ on センター; 上半身2 halfway 上半身-首; 足IK親 under 足ＩＫ on the floor; 親指０ halfway 手首-親指１."""
    bones = [replace(b) for b in pmd.bones]
    idx = {b.name: i for i, b in enumerate(bones)}

    def add(name, parent, pos, typ, children):
        i = len(bones)
        bones.append(PmdBone(name, parent, children[0] if children else 0, typ, 0, tuple(float(x) for x in pos)))
        for c in children:
            bones[c].parent = i
        idx[name] = i

    def kids(p):
        return [i for i, b in enumerate(bones) if b.parent == p]

    def mid(a, c):
        return (np.asarray(bones[idx[a]].pos) + np.asarray(bones[idx[c]].pos)) / 2
    if '全ての親' not in idx:
        add('全ての親', -1, (0, 0, 0), 1, kids(-1))
    if 'グルーブ' not in idx:
        add('グルーブ', idx['センター'], bones[idx['センター']].pos, 1, kids(idx['センター']))
    if '上半身2' not in idx:
        add('上半身2', idx['上半身'], mid('上半身', '首'), 0, kids(idx['上半身']))
    for s in '左右':
        ik = idx.get(s + '足ＩＫ')
        if s + '足IK親' not in idx and ik is not None:
            x, _, z = bones[ik].pos
            add(s + '足IK親', bones[ik].parent, (x, 0, z), 1, [ik])
        if s + '親指０' not in idx and s + '親指１' in idx:
            t1 = idx[s + '親指１']
            add(s + '親指０', bones[t1].parent, mid(s + '手首', s + '親指１'), 0, [t1])
        if s + '足先EX' not in idx and s + '足首' in idx:
            ankle = idx[s + '足首']
            toes = [idx[s + 'つま先']] if s + 'つま先' in idx else []
            pos = mid(s + '足首', s + 'つま先') if toes else bones[ankle].pos
            add(s + '足先EX', ankle, pos, 0, toes)
    return replace(pmd, bones=bones)
