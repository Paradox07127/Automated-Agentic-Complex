"""A VMD camera track sampled per 30 fps frame in its source values, for the package's camera/<clip>.json."""
import numpy as np

from .io import bezier

SCHEMA = 'endfield-motion-camera/v1'
# Interpolation groups of the 24-byte camera block (three.js 0.114.0 MMDLoader): one per center axis, then the
# rotation, the distance and the FOV.
CHANNELS = dict(center=(0, 1, 2), euler=(3, 3, 3), distance=(4,), fov_deg=(5,))


def channel_points(interp24, channel):
    """(x1, y1, x2, y2) for io.bezier; a camera group stores its bytes as x1, x2, y1, y2."""
    x1, x2, y1, y2 = interp24[channel * 4:channel * 4 + 4]
    return x1, y1, x2, y2


def sample(keys, first, count, frame_times=None):
    """Frames first..first+count-1 (or continuous frame_times) of Vmd.cameras keys."""
    byframe = {}
    for k in keys:
        byframe[k[0]] = k
    ks = [byframe[f] for f in sorted(byframe)]
    kf = np.array([k[0] for k in ks], float)
    values = dict(center=np.array([k[2] for k in ks], float), euler=np.array([k[3] for k in ks], float),
                  distance=np.array([[k[1]] for k in ks], float), fov_deg=np.array([[k[5]] for k in ks], float))
    f = np.arange(first, first + count, dtype=float) if frame_times is None else np.asarray(frame_times, float)
    out_frames = len(f)
    out = {}
    if len(ks) == 1:
        for name, v in values.items():
            out[name] = np.repeat(v, out_frames, 0)
    else:
        i1 = np.clip(np.searchsorted(kf, f, side='right'), 1, len(ks) - 1)
        i0 = i1 - 1
        t = np.clip((f - kf[i0]) / (kf[i1] - kf[i0]), 0, 1)
        for name, v in values.items():
            res = np.empty((out_frames, v.shape[1]))
            for axis, channel in enumerate(CHANNELS[name]):
                u = np.empty(out_frames)
                for seg in np.unique(i1):
                    m = i1 == seg
                    u[m] = bezier(t[m], channel_points(ks[seg][4], channel))
                res[:, axis] = v[i0, axis] + (v[i1, axis] - v[i0, axis]) * u
            out[name] = res
    out['distance'] = out['distance'][:, 0]
    out['fov_deg'] = out['fov_deg'][:, 0]
    # The perspective switch does not interpolate: the key that starts the segment holds it. VMD stores 0 for
    # perspective on and 1 for orthographic.
    start = np.clip(np.searchsorted(kf, f, side='right') - 1, 0, None)
    out['perspective'] = [ks[i][6] == 0 for i in start]
    base_f = float(f[0]) if out_frames else float(first)
    out['cuts'] = [int(b - base_f) for a, b in zip(kf, kf[1:]) if b - a == 1 and base_f <= b <= (float(f[-1]) if out_frames else base_f)]
    return out


def document(clip, sampled, to_rig, frame_rate=30):
    """The endfield-motion-camera/v1 document: VMD values (euler in radians) plus the retarget's to_rig."""
    return dict(schema=SCHEMA, clip=clip, frame_rate=frame_rate, frames=len(sampled['distance']), space='mmd-source',
                center=np.asarray(sampled['center']).tolist(), euler=np.asarray(sampled['euler']).tolist(),
                distance=np.asarray(sampled['distance']).tolist(), fov_deg=np.asarray(sampled['fov_deg']).tolist(),
                perspective=list(sampled['perspective']), cuts=list(sampled['cuts']), to_rig=to_rig)
