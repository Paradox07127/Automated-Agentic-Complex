"""VMD morph tracks baked onto a package's original face controls as an endfield-original-named-facial-animation/v1 clip."""
from importlib import resources
import json
import numpy as np

from .io import FPS, name_key

TOLERANCES = (0.002, 0.005, 0.01, 0.02)


def load_slots():
    """{VMD-stored MMD morph name: slot} from morph-names.json."""
    doc = json.loads(resources.files(__package__).joinpath('morph-names.json').read_text(encoding='utf-8'))
    return {name_key(name): slot for name, slot in doc['slots'].items()}


def load_rules():
    """{slot: rule} from face-slots.json."""
    return json.loads(resources.files(__package__).joinpath('face-slots.json').read_text(encoding='utf-8'))['slots']


def resolve(face_controls, emotion_map, override, blink):
    """{MMD name: [(control, weight)]}: the override's morphs first, then each slot's rule from face-slots.json: a vowel
    through the default lipsync group's pose, a blink through blink ({control: value with the eyes closed}, None leaves
    blinks unmapped) on its _L_/_R_ side, any other one through one class of the controls of a pose the package has;
    only controls with bones."""
    usable = {c['name'] for c in face_controls['controls'] if c['bones']}
    poses = {p['name']: p['weights'] for p in face_controls['poses']}
    mapping = {}
    for name, rows in ((override or {}).get('morphs') or {}).items():
        pairs = []
        for row in rows:
            weight = row.get('weight', 1)
            pairs += [(w['control'], w['weight'] * weight) for w in poses[row['pose']]] if 'pose' in row else [(row['control'], weight)]
        mapping[name_key(name)] = pairs
    vowels = {g['label']: g['vowels'] for g in face_controls['lipsync_groups']}[emotion_map['default']]
    rules = load_rules()
    sides = dict(both=('_L_', '_R_'), left=('_L_',), right=('_R_',))
    for name, slot in load_slots().items():
        rule = rules[slot]
        if name in mapping:
            continue
        if 'lipsync' in rule:
            if rule['lipsync'] in vowels:
                mapping[name] = [(w['control'], w['weight']) for w in poses[vowels[rule['lipsync']]]]
        elif 'blink' in rule:
            if blink is not None:
                mapping[name] = [(c, v) for c, v in blink.items() if any(s in c for s in sides[rule['blink']])]
        elif rule['pose'] in poses:
            mapping[name] = [(w['control'], w['weight'] * rule['weight']) for w in poses[rule['pose']]
                             if w['control'].startswith(rule['controls'] + '_')]
    mapping = {name: [(c, w) for c, w in pairs if c in usable] for name, pairs in mapping.items()}
    return {name: pairs for name, pairs in mapping.items() if pairs}


def pchip_slopes(times, values):
    """Fritsch-Carlson monotone piecewise cubic Hermite derivatives (C1 continuous, zero overshoot)."""
    n = len(values)
    if n <= 1:
        return [0.0] * n
    h = np.diff(np.asarray(times, float))
    m = np.diff(np.asarray(values, float)) / h
    if n == 2:
        return [float(m[0]), float(m[0])]
    d = np.zeros(n, float)
    for k in range(1, n - 1):
        s0, s1 = m[k - 1], m[k]
        if s0 * s1 > 0.0:
            w1, w2 = 2.0 * h[k] + h[k - 1], h[k] + 2.0 * h[k - 1]
            d[k] = (w1 + w2) / (w1 / s0 + w2 / s1)
    d0 = ((2.0 * h[0] + h[1]) * m[0] - h[0] * m[1]) / (h[0] + h[1])
    if d0 * m[0] <= 0.0:
        d0 = 0.0
    elif m[0] * m[1] < 0.0 and abs(d0) > abs(3.0 * m[0]):
        d0 = 3.0 * m[0]
    dn = ((2.0 * h[-1] + h[-2]) * m[-1] - h[-1] * m[-2]) / (h[-1] + h[-2])
    if dn * m[-1] <= 0.0:
        dn = 0.0
    elif m[-1] * m[-2] < 0.0 and abs(dn) > abs(3.0 * m[-1]):
        dn = 3.0 * m[-1]
    d[0], d[-1] = d0, dn
    return d.tolist()


def bake(morph_keys, first, count, mapping, frame_times=None):
    """(dense {control: (count,) values in [0, 1]}, mapped names, unmapped names) for source frames first..first+count-1."""
    by = {}
    for key in morph_keys:
        by.setdefault(name_key(key.name), {})[key.frame] = key.weight  # a repeated frame keeps the last key
    frames = np.arange(first, first + count, dtype=float) if frame_times is None else np.asarray(frame_times, float)
    dense = {}
    mapped = sorted(by.keys() & mapping.keys())
    for name in mapped:
        kf = sorted(by[name])
        values = np.interp(frames, kf, [by[name][f] for f in kf])
        for control, weight in mapping[name]:
            dense[control] = dense.get(control, 0) + values * weight
    return {c: np.clip(v, 0, 1) for c, v in dense.items()}, mapped, sorted(by.keys() - mapping.keys())


def simplify(values, tol):
    """[(frame, value)] of a Ramer-Douglas-Peucker polyline keeping the first and last frame.

    Deviation is measured in value units at each frame, so tol is a weight error."""
    v = np.asarray(values, float); n = len(v)
    keep = np.zeros(n, bool); keep[[0, -1]] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2: continue
        error = np.abs(v[a + 1:b] - (v[a] + (v[b] - v[a]) * np.arange(1, b - a) / (b - a)))
        k = int(np.argmax(error))
        if error[k] > tol:
            m = a + 1 + k; keep[m] = True; stack += [(a, m), (m, b)]
    return [(int(i), float(v[i])) for i in np.flatnonzero(keep)]


def clip_document(name, duration, curves, pause_auto_blink, fps=FPS, tangent_mode='pchip', time_offset=0.0):
    """The clip for {control: [(frame, value)]} using C1 PCHIP monotone cubic tangents (or secants when linear)."""
    tracks = []
    for control in sorted(curves):
        points = curves[control]
        times = [time_offset + f / fps for f, _ in points]
        vals = [v for _, v in points]
        if tangent_mode == 'pchip':
            d = pchip_slopes(times, vals)
            rows = [dict(time=t, value=v, in_slope=d[k], out_slope=d[k], weighted_mode=0)
                    for k, (t, v) in enumerate(zip(times, vals))]
        else:
            slopes = [(v1 - v0) * fps / (f1 - f0) for (f0, v0), (f1, v1) in zip(points, points[1:])]
            rows = [dict(time=t, value=v, in_slope=slopes[k - 1] if k else 0.0,
                         out_slope=slopes[k] if k < len(slopes) else 0.0, weighted_mode=0)
                    for k, (t, v) in enumerate(zip(times, vals))]
        tracks.append(dict(control=control, curve=dict(m_curve=rows)))
    return dict(schema='endfield-original-named-facial-animation/v1', name=name, duration=duration, additive=False,
                override=False, pause_auto_blink=pause_auto_blink, curves=tracks)


def budgeted(dense, fps=FPS, tangent_mode='pchip', time_offset=0.0):
    """({control: [(frame, value)]}, tolerance) at the first tolerance within ActorFacialAnimation's limits, else None."""
    frames = len(next(iter(dense.values()))) if dense else 1
    for tol in TOLERANCES:
        curves = {c: simplify(v, tol) for c, v in dense.items()}
        counts = [len(x) for x in curves.values()]
        # Size of the file write_json writes (compact JSON and a newline); the title is not counted.
        size = len(json.dumps(clip_document('', time_offset + (frames - 1) / fps, curves, False, fps=fps, tangent_mode=tangent_mode, time_offset=time_offset),
                              ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()) + 1
        if len(curves) <= 256 and all(1 <= n <= 20000 for n in counts) and sum(counts) <= 100000 and size <= 4194304:
            return curves, tol
    return None
