"""VMD morph tracks baked onto a package's original face controls as an endfield-original-named-facial-animation/v1 clip."""
from importlib import resources
import json
import numpy as np

from .io import FPS, name_key

VOWELS = ('a', 'i', 'u', 'e', 'o')
TOLERANCES = (0.002, 0.005, 0.01, 0.02)


def load_slots():
    """{VMD-stored MMD morph name: slot} from morph-names.json."""
    doc = json.loads(resources.files(__package__).joinpath('morph-names.json').read_text(encoding='utf-8'))
    return {name_key(name): slot for name, slot in doc['slots'].items()}


def resolve(face_controls, emotion_map, override):
    """{MMD name: [(control, weight)]}: the override's morphs first, then the vowel slots through the default lipsync
    group's poses; only controls with bones."""
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
    for name, slot in load_slots().items():
        if name not in mapping and slot in VOWELS and slot in vowels:
            mapping[name] = [(w['control'], w['weight']) for w in poses[vowels[slot]]]
    mapping = {name: [(c, w) for c, w in pairs if c in usable] for name, pairs in mapping.items()}
    return {name: pairs for name, pairs in mapping.items() if pairs}


def bake(morph_keys, first, count, mapping):
    """(dense {control: (count,) values in [0, 1]}, mapped names, unmapped names) for source frames first..first+count-1."""
    by = {}
    for key in morph_keys:
        by.setdefault(name_key(key.name), {})[key.frame] = key.weight  # a repeated frame keeps the last key
    frames = np.arange(first, first + count, dtype=float)
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


def clip_document(name, duration, curves, pause_auto_blink):
    """The clip for {control: [(frame, value)]}; tangents are the adjacent secants, so the Hermite sampler is linear."""
    tracks = []
    for control in sorted(curves):
        points = curves[control]
        slopes = [(v1 - v0) * FPS / (f1 - f0) for (f0, v0), (f1, v1) in zip(points, points[1:])]
        rows = [dict(time=f / FPS, value=v, in_slope=slopes[k - 1] if k else 0.0,
                     out_slope=slopes[k] if k < len(slopes) else 0.0, weighted_mode=0) for k, (f, v) in enumerate(points)]
        tracks.append(dict(control=control, curve=dict(m_curve=rows)))
    return dict(schema='endfield-original-named-facial-animation/v1', name=name, duration=duration, additive=False,
                override=False, pause_auto_blink=pause_auto_blink, curves=tracks)


def budgeted(dense):
    """({control: [(frame, value)]}, tolerance) at the first tolerance within ActorFacialAnimation's limits, else None."""
    frames = len(next(iter(dense.values()))) if dense else 1
    for tol in TOLERANCES:
        curves = {c: simplify(v, tol) for c, v in dense.items()}
        counts = [len(x) for x in curves.values()]
        # Size of the file write_json writes (compact JSON and a newline); the title is not counted.
        size = len(json.dumps(clip_document('', (frames - 1) / FPS, curves, False), ensure_ascii=False,
                              separators=(',', ':'), allow_nan=False).encode()) + 1
        if len(curves) <= 256 and all(1 <= n <= 10000 for n in counts) and sum(counts) <= 50000 and size <= 2097152:
            return curves, tol
    return None
