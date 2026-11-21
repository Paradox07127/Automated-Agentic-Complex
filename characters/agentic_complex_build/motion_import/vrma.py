"""VRMA motion (VRMC_vrm_animation 1.0): the humanoid bones the extension names, on the canonical joints, and its expressions.

The neutral pose is every node at its default TRS, which the extension requires to be the VRM T-pose.
"""
from pathlib import Path

import numpy as np

from character_library import digest
from . import gltf
from .humanoid_map import vrm_arrays, vrm_fingers
from .take import FPS, Expression, MotionTake

EXTENSION = 'VRMC_vrm_animation'


def _bad(reason):
    return ValueError('bad_source: ' + reason)


def _node(entry, count):
    node = entry.get('node') if isinstance(entry, dict) else None
    if not isinstance(node, int) or isinstance(node, bool) or not 0 <= node < count: raise _bad('vrm_animation')
    return node


def probe(path, take=0):
    motion = load(path, take)
    return dict(gltf.probe(path, take), has_face=bool(motion.expressions), warnings=motion.warnings)


def load(path, take=0, options=None):
    doc, s, takes = gltf.open_take(path, take); nodes = doc.get('nodes', []); trs = s['trs']; F = len(s['times'])
    extension = (doc.get('extensions') or {}).get(EXTENSION)
    if not isinstance(extension, dict): raise _bad('vrm_animation')
    bones = {name: _node(entry, len(nodes))
             for name, entry in ((extension.get('humanoid') or {}).get('humanBones') or {}).items()}
    warnings = []
    # The extension forbids scale on humanoid bones and translation on any but the hips; those channels keep the default.
    for target in (channel['target'] for channel in doc['animations'][take]['channels']):
        node, channel_path = target.get('node'), target.get('path')
        if node not in bones.values(): continue
        if channel_path == 'scale': warning = 'scale_ignored'
        elif channel_path == 'translation' and node != bones.get('hips'): warning = 'translation_ignored'
        else: continue
        trs[node][channel_path] = gltf._rest(nodes[node])[('translation', 'rotation', 'scale').index(channel_path)]
        if warning not in warnings: warnings.append(warning)
    used = sorted(set(bones.values())); column = {k: c for c, k in enumerate(used)}
    xyz, R = gltf.neutral_first(doc, trs, F, used)
    columns = {name: column[k] for name, k in bones.items()}; fingers = vrm_fingers(columns, xyz, R)
    xyz, R, synthesized = vrm_arrays(columns, xyz, R)
    expressions = []
    for kind in ('preset', 'custom'):
        for name, entry in ((extension.get('expressions') or {}).get(kind) or {}).items():
            x = np.asarray(trs[_node(entry, len(nodes))]['translation'], float)[:, 0]
            if np.any((x < 0) | (x > 1)) and 'expression_clamped' not in warnings: warnings.append('expression_clamped')
            expressions.append(Expression(kind + ':' + name, np.clip(x, 0, 1)))
    if expressions: warnings.append('expressions_not_applied')
    if extension.get('lookAt') is not None: warnings.append('look_at_ignored')
    return MotionTake(format='vrma', source_name=Path(path).name, source_sha256=digest(path), frame_rate=float(FPS),
                      neutral=xyz[0], xyz=xyz[1:], R=R[1:], take=take, takes=takes, source_frames=F, fingers=fingers,
                      expressions=tuple(expressions), warnings=synthesized + warnings + ['fingers_rest'])
