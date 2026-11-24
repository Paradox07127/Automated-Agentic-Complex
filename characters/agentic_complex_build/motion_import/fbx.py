"""FBX motion through the fbx-motion tool (ufbx): per-frame world matrices, rotations and the humanoid take.

Node transforms are kept as the file has them: its units and axes; a left-handed file is refused.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile

import numpy as np

from character_library import digest
from .gltf import rotations
from .humanoid_map import canonical_arrays, finger_arrays, map_skeleton
from .take import FPS, MotionTake, frame_count

TIMEOUT_S = 120


def tool():
    """The fbx-motion executable named by AAC_FBX_TOOL."""
    path = os.environ.get('AAC_FBX_TOOL')
    if not path or not os.access(path, os.X_OK) or not Path(path).is_file():
        raise ValueError('unsupported_format: fbx_tool_missing')
    return path


def _run(args):
    """The tool's stdout; its exit 2 failure line on stderr becomes the importer's ValueError."""
    # The tool prints UTF-8 names; Windows would decode a text pipe in its ANSI code page.
    try: run = subprocess.run([tool(), *map(str, args)], capture_output=True, encoding='utf-8', errors='strict', timeout=TIMEOUT_S)
    except UnicodeDecodeError: raise ValueError('bad_source: fbx_tool') from None
    if run.returncode == 2:
        error = json.loads(run.stderr.strip().splitlines()[-1])
        reason = error['error']
        if reason in ('no_animation', 'too_long'): raise ValueError(reason)
        raise ValueError('bad_source: ' + (error['detail'] if reason == 'bad_source' else reason))
    if run.returncode: raise ValueError('bad_source: fbx_tool')
    return run.stdout


def probe(path, take=0):
    info = json.loads(_run(['probe', path]))
    if not info['right_handed']: raise ValueError('bad_source: left_handed_axes')
    takes = [{'index': t['index'], 'name': t['name'], 'duration_s': t['time_end'] - t['time_begin']} for t in info['takes']]
    if not takes: raise ValueError('no_animation')
    if not 0 <= take < len(takes): raise ValueError('bad_source: take')
    for entry in takes:
        entry.update(frames=frame_count(entry['duration_s']), frame_rate=float(FPS))
    return {'takes': takes, 'has_face': False, 'has_camera': False, 'warnings': []}


def _sample(path, take):
    """(node names, parents, world matrices (F + 1, N, 4, 4)); matrix set 0 is the unanimated scene."""
    with tempfile.TemporaryDirectory() as folder:
        out = Path(folder) / 'sample.bin'
        _run(['sample', path, '--take', take, '--fps', FPS, '--out', out])
        data = out.read_bytes()
    end = data.index(b'\n'); header = json.loads(data[:end])
    N = len(header['nodes']); F = header['frames']
    M = np.frombuffer(data, '<f8', offset=end + 1)
    if M.size != (F + 1) * N * 12: raise ValueError('bad_source: fbx_tool')
    G = np.zeros((F + 1, N, 4, 4)); G[..., :3, :] = M.reshape(F + 1, N, 3, 4); G[..., 3, 3] = 1
    return [node['name'] for node in header['nodes']], [node['parent'] for node in header['nodes']], G


def load(path, take=0, options=None):
    """The take on the canonical joints, its nodes mapped by name."""
    takes = len(probe(path, take)['takes'])
    names, parents, G = _sample(path, take)
    mapping, chain, unmapped = map_skeleton(names, parents, (options or {}).get('bone_map'))
    used = sorted(set(mapping.values()) | set(chain)); column = {k: c for c, k in enumerate(used)}
    G = G[:, used]; xyz = G[..., :3, 3]; R = rotations(G) @ np.swapaxes(rotations(G[:1]), -1, -2)
    columns = {name: column[k] for name, k in mapping.items()}; fingers = finger_arrays(columns, xyz, R)
    xyz, R, warnings = canonical_arrays(columns, [column[k] for k in chain], xyz, R)
    warnings += ['unmapped_bones'] if unmapped else []
    return MotionTake(format='fbx', source_name=Path(path).name, source_sha256=digest(path), frame_rate=float(FPS),
                      neutral=xyz[0], xyz=xyz[1:], R=R[1:], take=take, takes=takes, source_frames=len(G) - 1,
                      fingers=fingers, unmapped=unmapped, warnings=warnings + ['fingers_rest'])
