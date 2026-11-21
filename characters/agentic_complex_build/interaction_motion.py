"""Offline shared biped motion adaptation; target bind pose and model scale stay intact.

Derived clips are explicit products, never labelled as original animations of the
target character. Animation evaluation uses the existing native curve/key ABI.
"""
from pathlib import Path
import json
import struct

import numpy as np
from scipy.spatial.transform import Rotation

from .common import need as require, reference, sha256_bytes, sha256_file as sha
from .keys_v2 import decode as decode_efkey002
from .mmd.rig_math import bone, humanoid_ids


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


class BipedRig:
    def __init__(self, document, humanoid=None):
        """humanoid: the rig's humanoid.json document; without one, humanoid_map_missing. names: the Bip001 nodes by name,
        which retarget() pairs between two game rigs."""
        require(document['schema'] == 'metal-actor-rig-v1', 'unsupported_rig')
        self.document, self.nodes = document, document['nodes']
        self.parent = [n['parent'] for n in self.nodes]
        require(all(n['index'] == i and (p == -1 if i == 0 else 0 <= p < i)
                    for i, (n, p) in enumerate(zip(self.nodes, self.parent))), 'invalid_rig_order')
        self.names = {}
        for n in self.nodes:
            name = n['path'].rsplit('/', 1)[-1]
            if name.startswith('Bip001'):
                require(name not in self.names, 'ambiguous_biped_bone:' + name)
                self.names[name] = n['index']
        self.humanoid = humanoid_ids(humanoid, [n['path'] for n in self.nodes])
        self.positions = np.array([n['position'] for n in self.nodes], dtype=float)
        self.rotations = np.array([n['rotation'] for n in self.nodes], dtype=float)
        self.scales = np.array([n['scale'] for n in self.nodes], dtype=float)
        require(all(np.isfinite(v).all() for v in [self.positions, self.rotations, self.scales]), 'nonfinite_rig')
        require(np.all(np.linalg.norm(self.rotations, axis=-1) > 1e-8), 'zero_bind_rotation')
        self.rest = self.fk(self.rotations[None], self.positions[None])[0]
        self.rest_rotation = self.rotation_matrices(self.rest)
        self.hips = self.humanoid['hips']
        self.root = self.parent[self.hips]
        lengths = []
        for side in ['L', 'R']:
            p = self.rest[[self.humanoid[bone(side, part)] for part in ['UpperLeg', 'LowerLeg', 'Foot']], :3, 3]
            lengths.append(np.linalg.norm(p[1] - p[0]) + np.linalg.norm(p[2] - p[1]))
        self.leg_length = float(np.mean(lengths))
        require(self.leg_length > 1e-4, 'degenerate_biped_legs')

    @staticmethod
    def rotation_matrices(world):
        linear = world[..., :3, :3]
        return linear / np.linalg.norm(linear, axis=-2, keepdims=True)

    def fk(self, rotations, positions, scales=None):
        frames = len(rotations)
        local = np.broadcast_to(np.eye(4), (frames, len(self.nodes), 4, 4)).copy()
        scale=self.scales[None] if scales is None else scales
        local[..., :3, :3] = Rotation.from_quat(rotations.reshape(-1, 4)).as_matrix().reshape(frames, -1, 3, 3) * scale[...,None,:]
        local[..., :3, 3] = positions
        world = np.empty_like(local)
        for i, parent in enumerate(self.parent):
            world[:, i] = local[:, i] if parent < 0 else world[:, parent] @ local[:, i]
        return world


def baked_times(meta):
    """Seconds of a clip's baked frames."""
    # Preserve both endpoints. Runtime loop/clamp policy remains explicit in C7.
    times = np.arange(int(round(meta['length'] * meta['frame_rate'])) + 1) / meta['frame_rate']
    times = times[times < meta['length'] - 1e-6]
    return np.append(times, meta['length'])


class MotionArchive:
    def __init__(self, manifest, humanoid=None):
        """humanoid: the humanoid.json document of the archive's rig, as BipedRig takes it."""
        self.path = Path(manifest)
        self.root, self.document = self.path.parent, read_json(self.path)
        require(self.document['schema'] == 'metal-actor-source-export-v1', 'unsupported_archive')
        self.rig = BipedRig(read_json(self.resolve(self.document['rig'])), humanoid)
        self.clips = {c['name']: c for c in self.document['clips']}

    def resolve(self, ref):
        path = (self.root / ref['file']).resolve()
        require(path.is_relative_to(self.root.resolve()), 'motion_reference_escapes_archive')
        require(sha(path) == ref['sha256'] and path.stat().st_size == ref['byte_count'], 'motion_reference_identity_mismatch')
        return path

    def sample(self, name, frames=None):
        """(clip document, times, {positions, rotations, scales}) at every baked frame, or only at the baked frame indices `frames`."""
        meta = read_json(self.resolve(self.clips[name]))
        if meta.get('source_clip_name'):
            source=meta['source_clip_name'];row=self.clips[source]
            require(meta['source_clip_sha256']==row['sha256'],'motion_window_source_identity')
            original=read_json(self.resolve(row))
            require(not original.get('source_clip_name'),'nested_motion_window')
            times=baked_times(original);start,end=meta['source_time_range']
            take=np.where((times>=start-1e-5)&(times<=end+1e-5))[0]
            require(len(take)>=2 and abs(times[take[0]]-start)<1e-4 and abs(times[take[-1]]-end)<1e-4,'analysis_window_not_on_source_sample_grid')
            if frames is not None:take=take[frames]
            _,_,values=self.sample(source,take)
            return meta,times[take]-start,values
        data = self.resolve(meta['keys']).read_bytes()
        if data[:8] == b'EFKEY002':
            data = decode_efkey002(data)
        require(data[:8] == b'EFKEY001', 'invalid_motion_keys')
        times = baked_times(meta)
        if frames is not None:
            times = times[frames]
        values = {key: np.broadcast_to(getattr(self.rig, key), (len(times),) + getattr(self.rig, key).shape).copy()
                  for key in ['positions', 'rotations', 'scales']}
        attributes = dict(position='positions', rotation='rotations', scale='scales')
        for curve in meta['curves']:
            require(curve['stride'] == 28 and 0 <= curve['node'] < len(self.rig.nodes), 'invalid_curve')
            keys = np.frombuffer(data, dtype=np.dtype([('f', '<f4', 6), ('mode', '<u4')]), count=curve['count'], offset=curve['offset'])
            v = keys['f'].astype(float)
            if len(v) == 1:
                sampled = np.full(len(times), v[0, 1])
            else:
                i = np.clip(np.searchsorted(v[:, 0], times, side='right') - 1, 0, len(v)-2)
                a, b = v[i], v[i+1]
                span = b[:, 0] - a[:, 0]
                t = np.clip((times - a[:, 0]) / span, 0, 1)
                out_w = np.where((keys['mode'][i] & 2) != 0, a[:, 5], 1/3)
                in_w = np.where((keys['mode'][i+1] & 1) != 0, b[:, 4], 1/3)
                lo, hi = np.zeros_like(t), np.ones_like(t)
                for _ in range(25):
                    u = (lo+hi)/2
                    x = 3*(1-u)**2*u*out_w + 3*(1-u)*u*u*(1-in_w) + u**3
                    lo, hi = np.where(x < t, u, lo), np.where(x < t, hi, u)
                u = (lo+hi)/2
                stepped = ~np.isfinite(a[:, 3]) | ~np.isfinite(b[:, 2])
                sampled = ((1-u)**3*a[:, 1] + 3*(1-u)**2*u*(a[:, 1]+np.where(stepped, 0, a[:, 3])*span*out_w)
                           + 3*(1-u)*u*u*(b[:, 1]-np.where(stepped, 0, b[:, 2])*span*in_w) + u**3*b[:, 1])
                sampled = np.where(stepped, a[:, 1], sampled)
                sampled = np.where(times <= v[0, 0], v[0, 1], np.where(times >= v[-1, 0], v[-1, 1], sampled))
            values[attributes[curve['attribute']]][:, curve['node'], curve['component']] = sampled
        values['rotations'] /= np.linalg.norm(values['rotations'], axis=-1, keepdims=True)
        require(all(np.isfinite(v).all() for v in values.values()), 'nonfinite_source_pose')
        return meta, times, values


def retarget(source, target, rotations, positions):
    """Transfer bind-relative world rotations; retain every target bone's length.

    Only the hips translation carries the scaled source displacement. Unmapped
    facial, garment and prop nodes retain the target's local bind transforms.
    """
    ratio = target.leg_length / source.leg_length
    require(.5 <= ratio <= 2, 'unsupported_biped_proportion_ratio')
    world = source.fk(rotations, positions)
    source_r = source.rotation_matrices(world)
    count = len(rotations)
    q = np.broadcast_to(target.rotations, (count,) + target.rotations.shape).copy()
    t = np.broadcast_to(target.positions, (count,) + target.positions.shape).copy()
    mapped = {index: source.names[name] for name, index in target.names.items() if name in source.names}
    target_world = np.empty((count, len(target.nodes), 4, 4))
    for index, parent in enumerate(target.parent):
        parent_world = np.broadcast_to(np.eye(4), (count, 4, 4)) if parent < 0 else target_world[:, parent]
        if index in mapped:
            src = mapped[index]
            desired = source_r[:, src] @ source.rest_rotation[src].T @ target.rest_rotation[index]
            local = np.linalg.inv(target.rotation_matrices(parent_world)) @ desired
            q[:, index] = Rotation.from_matrix(local).as_quat()
            if index == target.hips:
                delta = world[:, src, :3, 3] - source.rest[src, :3, 3]
                point = target.rest[index, :3, 3] + ratio*delta
                t[:, index] = (np.linalg.inv(parent_world) @ np.concatenate([point, np.ones((count, 1))], axis=-1)[..., None])[:, :3, 0]
        local = np.broadcast_to(np.eye(4), (count, 4, 4)).copy()
        local[:, :3, :3] = Rotation.from_quat(q[:, index]).as_matrix() * target.scales[index][None, None, :]
        local[:, :3, 3] = t[:, index]
        target_world[:, index] = parent_world @ local
    # Quaternions q and -q encode the same orientation; keep interpolation continuous.
    for frame in range(1, count):
        q[frame] *= np.where(np.sum(q[frame]*q[frame-1], axis=-1) < 0, -1, 1)[:, None]
    require(np.isfinite(q).all() and np.isfinite(t).all(), 'nonfinite_retargeted_pose')
    return q, t, ratio, mapped


def write_clip(root, name, rig, times, rotations, positions, loop, provenance):
    root = Path(root)
    data, curves = bytearray(b'EFKEY001'), []
    for attribute, samples, rest in [('rotation', rotations, rig.rotations), ('position', positions, rig.positions)]:
        for node in range(len(rig.nodes)):
            for component in range(samples.shape[-1]):
                values = samples[:, node, component]
                if np.max(np.abs(values-rest[node, component])) < 1e-7:
                    continue
                constant = np.max(np.abs(values-values[0])) < 1e-7
                ts, vs = (times[:1], values[:1]) if constant else (times, values)
                offset = len(data)
                for i, (time, value) in enumerate(zip(ts, vs)):
                    incoming = 0 if i == 0 else (vs[i]-vs[i-1])/(ts[i]-ts[i-1])
                    outgoing = 0 if i+1 == len(ts) else (vs[i+1]-vs[i])/(ts[i+1]-ts[i])
                    data.extend(struct.pack('<6fI', time, value, incoming, outgoing, 1/3, 1/3, 0))
                curves.append(dict(node=node, attribute=attribute, component=component, offset=offset,
                                   count=len(ts), stride=28, pre_wrap=1, post_wrap=1))
    stem = sha256_bytes(name.encode())
    directory = root/'clips'; directory.mkdir(exist_ok=True)
    key_path = directory/(stem+'.keys'); key_path.write_bytes(data)
    oracle = bytearray(b'EFPOSE01'); checkpoints = []
    for frame in sorted({0, len(times)//4, len(times)//2, len(times)-1}):
        offset = len(oracle)
        for i in range(len(rig.nodes)):
            oracle.extend(struct.pack('<10f', *positions[frame, i], *rotations[frame, i], *rig.scales[i]))
        checkpoints.append(dict(time=float(times[frame]), offset=offset, node_count=len(rig.nodes), stride=40))
    oracle_path = directory/(stem+'.oracle'); oracle_path.write_bytes(oracle)
    meta = dict(schema='metal-actor-clip-v1', name=name, length=float(times[-1]), frame_rate=60,
                loop=loop, keys=reference(key_path, root), curves=curves, oracle=reference(oracle_path, root), samples=checkpoints,
                curve_provenance=provenance, independent_game_oracle=False,
                oracle_time_policy='derived retarget checkpoints; not an independent game observation')
    path = directory/(stem+'.json'); write_json(path, meta)
    return dict(reference(path, root), name=name, length=meta['length'], loop=loop, curve_count=len(curves))
