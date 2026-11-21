"""ActorArchive rig adapter using the verified Unity-to-glTF mirrorX boundary."""
from pathlib import Path
import numpy as np
from .rig_math import Rig, humanoid_ids, pack_humanoid


def package_humanoid(package):
    """The package's humanoid.json document, None without one."""
    return pack_humanoid(package.root/Path(package.native_ref['file']).parent/package.native_entry['c7']['file'])


class NativeRig(Rig):
    def __init__(self, document, humanoid=None):
        """humanoid: the rig's humanoid.json document; without one, humanoid_map_missing."""
        nodes = document['nodes']
        if document.get('schema') != 'metal-actor-rig-v1' or not nodes or len(nodes) > 10000:
            raise ValueError('invalid_native_rig')
        self.N = len(nodes)
        self.nodes = [dict(n, name=n['path'].rsplit('/', 1)[-1]) for n in nodes]
        self.parent = np.array([n['parent'] for n in nodes], int)
        self.order = list(range(self.N))
        if any(n['index'] != i or (n['parent'] != -1 if i == 0 else not 0 <= n['parent'] < i)
               for i, n in enumerate(nodes)):
            raise ValueError('invalid_native_rig_order')
        self.ids = {n['path'].rsplit('/', 1)[-1]: i for i, n in enumerate(nodes)}
        self.t0 = np.array([n['position'] for n in nodes], float) * [-1, 1, 1]
        self.q0 = np.array([n['rotation'] for n in nodes], float) * [1, -1, -1, 1]
        self.s = np.array([n['scale'] for n in nodes], float)
        if not all(np.isfinite(x).all() for x in [self.t0, self.q0, self.s]):
            raise ValueError('nonfinite_target_rig')
        self.rest = self.fk(self.q0, self.t0)
        self.restR = self.rotations(self.rest)
        self.humanoid = humanoid_ids(humanoid, [n['path'] for n in nodes])
        self.hips = self.humanoid['hips']
        # The retargeter writes explicit reviewed arm twist shares afterwards.
        self.twists = {}

    def unity_pose(self, rotations, positions):
        return rotations * [1, -1, -1, 1], positions * [-1, 1, 1]
