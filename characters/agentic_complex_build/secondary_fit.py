"""Learn from a character's own clips how corrective, twist and finger bones follow the 22 body bones.

Generated motion drives only the body bones. Corrective and twist bones get a ridge regression on quadratic features of
the local rotation vectors (relative to rest) of their driver body bones; fingers get the mean relaxed hand pose, plus
k-means hand poses as an upper bound in the report. Training poses are the Unity local TRS of the clips' curves,
sampled densely (RATE) with ActorCurves.swift's evaluation; the clips' oracle samples check that evaluation.

    python3 -m agentic_complex_build.secondary_fit --package <package> --out model.json --report report.json
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

import numpy as np

from . import keys_v2
from .mmd.rig_math import DIGITS, bone, humanoid_ids, pack_humanoid

SCHEMA = 'endfield-secondary-fit-v1'
# The body bones: the anatomical pelvis, rig-profile.json's PELVIS slot (no humanoid bone is it; the hips carry the
# motion), then these humanoid bones.
PELVIS = 'Pelvis'
BODY =('spine', 'chest', 'upperChest', 'neck', 'head') + tuple(
    bone(side, part) for side in 'LR'
    for part in ('Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes'))
CORRECTIVE = re.compile(r'^corrective_|_t[yz]_(plus|minus)$|_bend_jnt$')
FINGERS = {side: tuple(bone(side, digit+segment) for digit, segments in DIGITS for segment in segments) for side in 'LR'}
# Clips whose secondary bones are not the character's own animation: retargets from another rig, and time windows
# that repeat a source clip already in the set.
FOREIGN = ('shared-biped-retarget', 'immutable-source-time-window')
RATE = 15.0
FOLDS = 5
ALPHAS = 10.0**np.arange(-6, 5)
STILL_FEATURE = 1e-5  # training std under which a feature is held at its mean in apply
MIN_VARIANCE = 1e-8
CLUSTERS = 4
# Share rule baseline (segment, its child, roll source, twist nodes (extras.twist names), cumulative roll share per node).
# 'self': the segment's own roll, which its twist children inherit in full; 'child': the child's roll relative to the
# segment. UpperArm and LowerArm are mmd/retarget.py's TWISTS; UpperLeg and LowerLeg copy them.
TWIST_RULES = (('UpperArm', 'LowerArm', 'self', ('UpperArmTwist', 'UpperArmTwist1'), (.25, .75)),
               ('LowerArm', 'Hand', 'child', ('LowerArmTwist', 'LowerArmTwist1'), (1/3, 2/3)),
               ('UpperLeg', 'LowerLeg', 'self', ('UpperLegTwist', 'UpperLegTwist1'), (.25, .75)),
               ('LowerLeg', 'Foot', 'child', ('LowerLegTwist', 'LowerLegTwist1'), (1/3, 2/3)))


def _need(ok, reason):
    if not ok:
        raise ValueError(reason)


def node_names(rig_doc):
    return [n['path'].split('/')[-1] for n in rig_doc['nodes']]


def rig_humanoid(rig_doc, humanoid=None):
    """humanoid_ids of the rig by its humanoid.json document; without one, humanoid_map_missing."""
    return humanoid_ids(humanoid, [n['path'] for n in rig_doc['nodes']])


def pack_pelvis(pack_path):
    """The path the rig-profile.json that the C7 pack at pack_path lists in interaction.data gives its PELVIS slot, None
    without either."""
    pack_path = Path(pack_path)
    ref = next((r for r in json.loads(pack_path.read_text())['interaction']['data'] if r['file'] == 'rig-profile.json'), None)
    if ref is None:
        return None
    blob = (pack_path.parent/'interaction'/ref['file']).read_bytes()
    _need(hashlib.sha256(blob).hexdigest() == ref['sha256'], 'rig_profile_sha256_mismatch')
    return next((b['path'] for b in json.loads(blob)['bones'] if b['slot'] == PELVIS), None)


def roles(rig_doc, humanoid=None, pelvis=None):
    """(body bone names, {node name: 'corrective', 'twist' or 'finger'}, {side: its finger joint names}). Corrective
    and twist bones named so go by name; BODY, FINGERS and extras.twist nodes by rig_humanoid; pelvis: pack_pelvis's
    path, the one rig node at it or ending in '/' and it, None for no pelvis body bone."""
    names = node_names(rig_doc); ids = rig_humanoid(rig_doc, humanoid)
    at = [] if pelvis is None else [i for i, n in enumerate(rig_doc['nodes']) if n['path'] == pelvis or n['path'].endswith('/'+pelvis)]
    _need(pelvis is None or len(at) == 1, 'pelvis_node_missing_or_ambiguous')
    body = [names[i] for i in at] + [names[ids[b]] for b in BODY if b in ids]
    twists = {names[j] for b, j in ids.items() if 'Twist' in b}
    joints = {side: {names[ids[f]] for f in FINGERS[side] if f in ids} for side in 'LR'}
    kinds = {}
    for n in names:
        if CORRECTIVE.search(n):
            kinds[n] = 'corrective'
        elif 'Twist' in n or n in twists:
            kinds[n] = 'twist'
        elif n in joints['L'] or n in joints['R']:
            kinds[n] = 'finger'
    return body, kinds, {side: {n for n in joints[side] if kinds[n] == 'finger'} for side in 'LR'}


# Quaternions are Unity xyzw.
def qmul(a, b):
    ax, ay, az, aw = np.moveaxis(a, -1, 0)
    bx, by, bz, bw = np.moveaxis(b, -1, 0)
    return np.stack([aw*bx+ax*bw+ay*bz-az*by, aw*by-ax*bz+ay*bw+az*bx,
                     aw*bz+ax*by-ay*bx+az*bw, aw*bw-ax*bx-ay*by-az*bz], -1)


def qconj(q):
    return q*np.array([-1, -1, -1, 1.])


def qlog(q):
    """Rotation vector, angle in [0, pi]."""
    q = np.where(q[..., 3:] < 0, -q, q)
    s = np.linalg.norm(q[..., :3], axis=-1, keepdims=True)
    angle = 2*np.arctan2(s, q[..., 3:])
    return q[..., :3]*np.where(s > 1e-12, angle/np.maximum(s, 1e-12), 2.)


def qexp(v):
    angle = np.linalg.norm(v, axis=-1, keepdims=True)
    k = np.where(angle > 1e-12, np.sin(angle/2)/np.maximum(angle, 1e-12), .5)
    return np.concatenate([v*k, np.cos(angle/2)], -1)


def qangle(a, b):
    """Angle between rotations, degrees."""
    d = np.abs(np.sum(a*b, -1))/(np.linalg.norm(a, axis=-1)*np.linalg.norm(b, axis=-1))
    return np.degrees(2*np.arccos(np.clip(d, 0, 1)))


def qmatrix(q):
    x, y, z, w = q
    return np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)], [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                     [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])


def qmean(q):
    """Sign-aligned, normalised mean over axis 0."""
    m = q[0]
    for _ in range(3):
        aligned = np.where(np.sum(q*m, -1, keepdims=True) < 0, -q, q)
        m = aligned.mean(0)
        m = m/np.linalg.norm(m, axis=-1, keepdims=True)
    return m


def roll(d, axis):
    """Signed angle of d's twist about the unit axis (swing-twist decomposition)."""
    p = np.sum(d[..., :3]*axis, -1)
    a = 2*np.arctan2(p, d[..., 3])
    return (a+np.pi) % (2*np.pi)-np.pi


# Package reading.
def actor_dir(package_dir):
    characters = sorted((Path(package_dir)/'runtime'/'characters').iterdir())
    _need(len(characters) == 1, 'package_has_one_character')
    return characters[0]/'actor'


def _clips(actor):
    manifest = json.loads((actor/'manifest.json').read_text())
    for entry in manifest['clips']:
        yield entry['name'], json.loads((actor/entry['file']).read_text())


def _oracle(actor, clip):
    data = (actor/clip['oracle']['file']).read_bytes()
    _need(data[:8] == b'EFPOSE01', 'not_an_efpose01_oracle')
    for s in clip['samples']:
        _need(s['stride'] == 40 and s['offset']+40*s['node_count'] <= len(data), 'oracle_sample_out_of_range')
        yield s['time'], np.frombuffer(data, '<f4', s['node_count']*10, s['offset']).reshape(-1, 10).astype(float)


def _segment(t0, v0, out, t1, v1, inn, time):
    """ActorCurveMath.segment for unweighted keys."""
    dt = t1-t0
    x = (time-t0)/np.where(dt > 0, dt, 1)
    m0, m1 = np.where(np.isfinite(out), out, 0)*dt, np.where(np.isfinite(inn), inn, 0)*dt
    a, b = 2*v0-2*v1+m0+m1, -3*v0+3*v1-2*m0-m1
    v = ((a*x+b)*x+m0)*x+v0
    v = np.where((out == np.inf) | (inn == np.inf), v0, v)
    return np.where((out == -np.inf) | (inn == -np.inf), v1, v)


def _wrap(time, first, last, pre, post):
    span = last-first
    if span <= 0:
        return time
    out = time.copy()
    for side, mode in [(time < first, pre), (time > last, post)]:
        if mode == 2:
            out = np.where(side, first+np.mod(time-first, span), out)
        elif mode == 4:
            v = np.mod(time-first, 2*span)
            out = np.where(side, first+np.where(v <= span, v, 2*span-v), out)
    return out


def evaluate_curve(keys, pre, post, time):
    """ActorClip.evaluate of one curve's keys at the times."""
    t, v = keys['t'].astype(float), keys['v'].astype(float)
    if len(keys) == 1:
        return np.full(len(time), v[0])
    _need(np.all(keys['m'] == 0), 'weighted_tangents')
    time = _wrap(time, t[0], t[-1], pre, post)
    i = np.clip(np.searchsorted(t, time, 'right')-1, 0, len(t)-2)
    value = _segment(t[i], v[i], keys['o'][i].astype(float), t[i+1], v[i+1], keys['i'][i+1].astype(float), time)
    return np.where(time < t[0], v[0], np.where(time >= t[-1], v[-1], value))


def sample_clip(actor, clip, rest, times, nodes):
    """Local TRS (F, len(nodes), 10) of the clip at times in [0, length]; unanimated channels keep rest."""
    raw = (actor/clip['keys']['file']).read_bytes()
    if raw[:8] == keys_v2.MAGIC2:
        raw = keys_v2.decode(raw)
    _need(raw[:8] == keys_v2.MAGIC1, 'unknown_key_payload')
    keys = np.frombuffer(raw, keys_v2.KEY, offset=8)
    column = {n: k for k, n in enumerate(nodes)}
    pose = np.repeat(rest[None, nodes], len(times), 0)
    base = {'position': 0, 'rotation': 3, 'scale': 7}
    for c in clip['curves']:
        if c['node'] in column:
            k = keys[(c['offset']-8)//28:(c['offset']-8)//28+c['count']]
            pose[:, column[c['node']], base[c['attribute']]+c['component']] = evaluate_curve(
                k, c['pre_wrap'], c['post_wrap'], times)
    pose[..., 3:7] /= np.linalg.norm(pose[..., 3:7], axis=-1, keepdims=True)
    return pose


def dataset(package_dir, rate=RATE):
    """Dense samples of the character's own clips at the body, corrective, twist and finger nodes."""
    actor = actor_dir(package_dir)
    rig_doc = json.loads((actor/'rig.json').read_text())
    humanoid = pack_humanoid(actor.parent/'c7'/'pack.json')
    body, kinds, fingers = roles(rig_doc, humanoid, pack_pelvis(actor.parent/'c7'/'pack.json'))
    names = node_names(rig_doc)
    rest = np.array([n['position']+n['rotation']+n['scale'] for n in rig_doc['nodes']], float)
    nodes = [i for i, n in enumerate(names) if n in body or n in kinds]
    poses, groups, clip_names = [], [], []
    skipped, check = {}, dict(position=0., rotation_deg=0., samples=0)
    for name, clip in _clips(actor):
        source = clip.get('curve_provenance', {}).get('kind')
        if source in FOREIGN:
            skipped.setdefault(source, []).append(name)
            continue
        times = np.linspace(0, clip['length'], max(2, int(round(clip['length']*rate))+1))
        oracle = list(_oracle(actor, clip))
        try:
            pose = sample_clip(actor, clip, rest, np.concatenate([times, [t for t, _ in oracle]]), nodes)
        except ValueError as error:
            skipped.setdefault(str(error), []).append(name)
            continue
        for (_, truth), got in zip(oracle, pose[len(times):]):
            check['position'] = max(check['position'], float(np.abs(truth[nodes, :3]-got[:, :3]).max()))
            check['rotation_deg'] = max(check['rotation_deg'], float(qangle(truth[nodes, 3:7], got[:, 3:7]).max()))
            check['samples'] += 1
        poses.append(pose[:len(times)])
        groups += [len(clip_names)]*len(times)
        clip_names.append(name)
    _need(len(clip_names) >= FOLDS, 'too_few_clips')
    sub = dict(nodes=[dict(rig_doc['nodes'][i], index=k) for k, i in enumerate(nodes)])
    return dict(rig=rig_doc, humanoid=humanoid, body=body, kinds=kinds, fingers=fingers, sub_rig=sub,
                names=[names[i] for i in nodes], pose=np.concatenate(poses),
                groups=np.array(groups), clip_names=clip_names, skipped=skipped, oracle_check=check, rate=rate)


# Model.
def drivers(rig_doc, name, body, children=True):
    """The first two body-bone (names in body) ancestors (parent, then the parent's parent), skipping non-body bones;
    with children, also the first one's body-bone children, whose roll the forearm and calf twist bones follow."""
    names = node_names(rig_doc)
    out, i = [], rig_doc['nodes'][names.index(name)]['parent']
    while i >= 0 and len(out) < 2:
        if names[i] in body:
            out.append(names[i])
        i = rig_doc['nodes'][i]['parent']
    if children and out:
        first = names.index(out[0])
        out += [names[k] for k, n in enumerate(rig_doc['nodes']) if n['parent'] == first and names[k] in body]
    return out


def features(rv):
    """Linear rotation-vector features plus all their degree-2 products."""
    i, j = np.triu_indices(rv.shape[1])
    return np.concatenate([rv, rv[:, i]*rv[:, j]], 1)


def fold_of(groups, folds=FOLDS):
    """Fold of each sample; whole clips go to one fold."""
    unique = np.unique(groups)
    order = np.random.default_rng(0).permutation(len(unique))
    return (order % folds)[np.searchsorted(unique, groups)]


def _ridge(z, y, alpha):
    """Coefficients (features, outputs, alphas) for standardised z and centred y."""
    e, v = np.linalg.eigh(z.T @ z)
    b = v.T @ (z.T @ y)
    return np.einsum('fk,ko,ka->foa', v, b, 1/(e[:, None]+alpha[None]))


def fit_bone(x, y, groups):
    mean, scale = x.mean(0), x.std(0)
    scale = np.where(scale > 1e-12, scale, 1.)
    z = (x-mean)/scale
    fitted = y.var(0) > MIN_VARIANCE
    coef, intercept = np.zeros((x.shape[1], 6)), y.mean(0)
    alpha, cv = np.full(6, np.nan), np.zeros(6)
    if fitted.any():
        fold = fold_of(groups)
        error = np.zeros((fitted.sum(), len(ALPHAS)))
        for f in range(FOLDS):
            train, test = fold != f, fold == f
            w = _ridge(z[train], y[train][:, fitted]-y[train][:, fitted].mean(0), ALPHAS)
            pred = np.einsum('sf,foa->soa', z[test], w)+y[train][:, fitted].mean(0)[None, :, None]
            error += ((pred-y[test][:, fitted, None])**2).sum(0)
        best = error.argmin(1)
        alpha[fitted], cv[fitted] = ALPHAS[best], np.sqrt(error[np.arange(len(best)), best]/len(y))
        w = _ridge(z, y[:, fitted]-intercept[fitted], ALPHAS)
        coef[:, fitted] = w[:, np.arange(len(best)), best]
    return dict(feature_mean=mean.tolist(), feature_scale=scale.tolist(), feature_low=z.min(0).tolist(),
                feature_high=z.max(0).tolist(), coef=coef.tolist(),
                intercept=intercept.tolist(), fitted=fitted.tolist(),
                alpha=[None if np.isnan(a) else float(a) for a in alpha], cv_rmse=cv.tolist())


def _delta(pose, rest):
    """Rotation vector of the local rotation relative to rest, in the bone's own frame."""
    return qlog(qmul(qconj(rest[3:7]), pose[..., 3:7]))


def _kmeans(x, k, rng, restarts=8, iterations=100):
    best = None
    for _ in range(restarts):
        centre = x[[rng.integers(len(x))]]
        while len(centre) < k:
            d = ((x[:, None]-centre[None])**2).sum(-1).min(1)
            centre = np.concatenate([centre, x[[rng.choice(len(x), p=d/d.sum())]]])
        for _ in range(iterations):
            label = ((x[:, None]-centre[None])**2).sum(-1).argmin(1)
            new = np.array([x[label == c].mean(0) if np.any(label == c) else centre[c] for c in range(k)])
            if np.allclose(new, centre):
                break
            centre = new
        inertia = ((x-centre[label])**2).sum()
        if best is None or inertia < best[0]:
            best = (inertia, label)
    return best[1]


def fit_fingers(names, pose, fingers):
    """fingers: roles' finger joint names per side."""
    out = dict(default={}, clusters={})
    rng = np.random.default_rng(0)
    for side in 'LR':
        cols = [k for k, n in enumerate(names) if n in fingers[side]]
        if not cols:
            continue
        q = pose[:, cols, 3:7]
        mean = qmean(q)
        q = np.where(np.sum(q*mean, -1, keepdims=True) < 0, -q, q)
        label = _kmeans(q.reshape(len(q), -1), min(CLUSTERS, len(q)), rng)
        out['default'].update({names[k]: m.tolist() for k, m in zip(cols, mean)})
        out['clusters'][side] = [dict(share=float(np.mean(label == c)),
                                      pose={names[k]: m.tolist() for k, m in zip(cols, qmean(q[label == c]))})
                                 for c in range(label.max()+1)]
    return out


def fit_data(data, mask=None, children=None):
    """children None picks, per bone, the driver set with or without children by the cross-validated error
    relative to each output's variance."""
    mask = np.ones(len(data['pose']), bool) if mask is None else mask
    pose, groups, names = data['pose'][mask], data['groups'][mask], data['names']
    rest = np.array([n['position']+n['rotation']+n['scale'] for n in data['sub_rig']['nodes']], float)
    column = {n: k for k, n in enumerate(names)}
    bones = {}
    for k, name in enumerate(names):
        if data['kinds'].get(name) not in ('corrective', 'twist'):
            continue
        y = np.concatenate([pose[:, k, :3], _delta(pose[:, k], rest[k])], 1)
        best = None
        for choice in ([True, False] if children is None else [children]):
            driver = drivers(data['rig'], name, data['body'], choice)
            x = features(np.concatenate([_delta(pose[:, column[d]], rest[column[d]]) for d in driver], 1))
            bone = dict(kind=data['kinds'][name], drivers=driver, **fit_bone(x, y, groups))
            fitted = np.array(bone['fitted'])
            score = float(np.sum(np.array(bone['cv_rmse'])[fitted]**2/y.var(0)[fitted]))
            if best is None or score < best[0]:
                best = (score, bone)
        bones[name] = best[1]
    return dict(schema=SCHEMA, rate=data['rate'], clips=len(np.unique(groups)), samples=int(mask.sum()),
                bones=bones, fingers=fit_fingers(names, pose, data['fingers']))


def fit(package_dir):
    return fit_data(dataset(package_dir))


def apply(model, rig_doc, q, t):
    """Unity local q (F, N, 4), t (F, N, 3) with body bones set: returns new q, t with corrective and twist bones
    regressed from the body and fingers in the default hand pose."""
    q, t = np.array(q, float), np.array(t, float)
    names = node_names(rig_doc)
    index = {n: i for i, n in enumerate(names)}
    q0 = np.array([n['rotation'] for n in rig_doc['nodes']], float)
    for name, bone in model['bones'].items():
        if name not in index:
            continue
        rv = np.concatenate([qlog(qmul(qconj(q0[index[d]]), q[:, index[d]])) for d in bone['drivers']], 1)
        # A hinge's off-axis components barely vary in training (std 1e-12 to 1e-7): a generated pose lands far out,
        # unclipped it moves the bone kilometres, clipped it leaps between the bounds as it crosses the mean. Held at 0.
        scale = np.array(bone['feature_scale'])
        z = np.where(scale < STILL_FEATURE, 0.0,
                     np.clip((features(rv)-bone['feature_mean'])/scale, bone['feature_low'], bone['feature_high']))
        y = z @ np.array(bone['coef'])+bone['intercept']
        j = index[name]
        t[:, j] = y[:, :3]
        q[:, j] = qmul(np.broadcast_to(q0[j], (len(y), 4)), qexp(y[:, 3:]))
    for name, value in model['fingers']['default'].items():
        if name in index:
            q[:, index[name]] = value
    return q, t


# Evaluation.
def twist_rules(rig_doc, humanoid=None):
    """{twist node: (roll source node, roll axis in the source's parent frame, axis in the node's parent frame,
    the node's share of the roll)} for the share rule baseline."""
    names = node_names(rig_doc)
    index = rig_humanoid(rig_doc, humanoid)
    nodes = rig_doc['nodes']
    world_r, world_p = [None]*len(nodes), [None]*len(nodes)
    for i, n in enumerate(nodes):
        r, p = qmatrix(np.array(n['rotation'], float))*np.array(n['scale'], float), np.array(n['position'], float)
        par = n['parent']
        world_r[i], world_p[i] = (r, p) if par < 0 else (world_r[par] @ r, world_r[par] @ p+world_p[par])
    frame = [r/np.linalg.norm(r, axis=0) for r in world_r]
    out = {}
    for side in 'LR':
        for seg, end, source, twists, shares in TWIST_RULES:
            s, e = index.get(bone(side, seg)), index.get(bone(side, end))
            if s is None or e is None:
                continue
            axis = world_p[e]-world_p[s]
            axis /= np.linalg.norm(axis)
            src = s if source == 'self' else e
            u = frame[nodes[src]['parent']].T @ axis
            previous = 1. if source == 'self' else 0.
            for twist, share in zip(twists, shares):
                j = index.get(bone(side, twist))
                if j is None:
                    continue
                out[names[j]] = (names[src], u, frame[nodes[j]['parent']].T @ axis, share-previous)
                previous = share
    return out


def _stats(values):
    values = np.concatenate([np.ravel(v) for v in values]) if values else np.zeros(0)
    if not len(values):
        return None
    return dict(median=float(np.median(values)), p95=float(np.percentile(values, 95)))


def evaluate(data):
    """Clip-grouped 5-fold held-out errors of the model and its baselines, per bone class."""
    names, pose, groups = data['names'], data['pose'], data['groups']
    sub = data['sub_rig']
    rest = np.array([n['position']+n['rotation']+n['scale'] for n in sub['nodes']], float)
    column = {n: k for k, n in enumerate(names)}
    body = [column[n] for n in names if n in data['body']]
    rules = twist_rules(data['rig'], data['humanoid'])
    # Bones that never leave rest score zero for every method; leave them out of the pooled numbers.
    moving = [k for k, n in enumerate(names) if data['kinds'].get(n) in ('corrective', 'twist') and (
        np.concatenate([pose[:, k, :3], _delta(pose[:, k], rest[k])], 1).var(0) > MIN_VARIANCE).any()]
    errors = {}

    def add(cls, method, name, position, rotation):
        entry = errors.setdefault(cls, {}).setdefault(method, {}).setdefault(name, ([], []))
        entry[0].append(position)
        entry[1].append(rotation)

    fold = fold_of(groups)
    for f in range(FOLDS):
        test = fold == f
        truth = pose[test]
        q_in = np.repeat(rest[None, :, 3:7], test.sum(), 0)
        t_in = np.repeat(rest[None, :, :3], test.sum(), 0)
        q_in[:, body], t_in[:, body] = truth[:, body, 3:7], truth[:, body, :3]
        predicted = {}
        for method, children in [('model', None), ('model_with_children', True), ('model_ancestors_only', False)]:
            model = fit_data(data, ~test, children)
            predicted[method] = apply(model, sub, q_in, t_in)
        for k in moving:
            name = names[k]
            cls = data['kinds'][name]
            pos = lambda p: 1000*np.linalg.norm(p-truth[:, k, :3], axis=-1)
            for method, (q, t) in predicted.items():
                add(cls, method, name, pos(t[:, k]), qangle(q[:, k], truth[:, k, 3:7]))
            add(cls, 'rest', name, pos(rest[k, :3]), qangle(rest[k, 3:7], truth[:, k, 3:7]))
            if name in rules:
                src, u, axis, share = rules[name]
                s = column[src]
                tau = roll(qmul(truth[:, s, 3:7], qconj(rest[s, 3:7])), u)
                rule = qmul(qexp(axis*(share*tau)[:, None]), np.broadcast_to(rest[k, 3:7], (len(tau), 4)))
                add(cls, 'share_rule', name, pos(rest[k, :3]), qangle(rule, truth[:, k, 3:7]))
        for side, clusters in model['fingers']['clusters'].items():
            fingers = list(clusters[0]['pose'])
            cols = [column[n] for n in fingers]
            real = truth[:, cols, 3:7]
            default = np.array([model['fingers']['default'][n] for n in fingers])
            centre = np.array([[c['pose'][n] for n in fingers] for c in clusters])
            near = np.stack([qangle(c[None], real) for c in centre])
            best = near.mean(2).argmin(0)
            for name, err in [('default', qangle(default[None], real)), ('rest', qangle(rest[cols, 3:7][None], real)),
                              ('nearest_cluster', near[best, np.arange(len(best))])]:
                add('finger', name, side, None, err)
    report = dict(folds=FOLDS, classes={}, per_bone={})
    for cls, methods in errors.items():
        report['classes'][cls] = {m: dict(position_mm=_stats([p for v in b.values() for p in v[0] if p is not None]),
                                          rotation_deg=_stats([r for v in b.values() for r in v[1]]))
                                  for m, b in methods.items()}
        for m, b in methods.items():
            for name, (p, r) in b.items():
                report['per_bone'].setdefault(name, {})[m] = dict(
                    position_mm=_stats([x for x in p if x is not None]), rotation_deg=_stats(r))
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--package', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--report', required=True)
    args = parser.parse_args(argv)
    data = dataset(args.package)
    model = fit_data(data)
    model['character'] = actor_dir(args.package).parent.name
    report = dict(evaluate(data), character=model['character'], rate=data['rate'], clips=len(data['clip_names']),
                  samples=len(data['pose']), skipped={k: dict(count=len(v), clips=v) for k, v in data['skipped'].items()},
                  dense_vs_oracle_max_abs=data['oracle_check'])
    for path, doc in [(args.out, model), (args.report, report)]:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps(doc, indent=1, allow_nan=False)+'\n')


if __name__ == '__main__':
    main()
