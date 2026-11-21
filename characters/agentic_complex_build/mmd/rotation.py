"""NumPy rotation helpers with scipy.spatial.transform.Rotation's conventions (scalar-last quaternions,
Markley's matrix-to-quaternion branch and sign), so the importer runs on numpy alone."""
import numpy as np


def normalize(quat):
    quat = np.asarray(quat, float)
    norm = np.linalg.norm(quat, axis=-1, keepdims=True)
    if np.any(norm == 0): raise ValueError('Found zero norm quaternions in `quat`.')
    return quat / norm


def as_matrix(quat):
    """Rotation.from_quat(quat).as_matrix()."""
    x, y, z, w = np.moveaxis(normalize(quat), -1, 0)
    x2, y2, z2, w2 = x * x, y * y, z * z, w * w
    xy, zw, xz, yw, yz, xw = x * y, z * w, x * z, y * w, y * z, x * w
    m = np.empty(x.shape + (3, 3))
    m[..., 0, 0], m[..., 0, 1], m[..., 0, 2] = x2 - y2 - z2 + w2, 2 * (xy - zw), 2 * (xz + yw)
    m[..., 1, 0], m[..., 1, 1], m[..., 1, 2] = 2 * (xy + zw), -x2 + y2 - z2 + w2, 2 * (yz - xw)
    m[..., 2, 0], m[..., 2, 1], m[..., 2, 2] = 2 * (xz - yw), 2 * (yz + xw), -x2 - y2 + z2 + w2
    return m


def from_matrix(matrix):
    """Rotation.from_matrix(matrix).as_quat(); a matrix off orthogonal by more than 1e-12 is first projected with SVD."""
    m = np.array(matrix, float)
    if np.any(np.linalg.det(m) <= 0): raise ValueError('Non-positive determinant in rotation matrix.')
    skew = ~np.all(np.isclose(m @ np.swapaxes(m, -1, -2), np.eye(3), atol=1e-12), axis=(-2, -1))
    if np.any(skew):
        u, _, vt = np.linalg.svd(m[skew], full_matrices=False)
        m[skew] = u @ vt
    trace = m[..., 0, 0] + m[..., 1, 1] + m[..., 2, 2]
    diagonal = np.empty(trace.shape + (4,))
    diagonal[..., :3] = np.diagonal(m, 0, -2, -1); diagonal[..., 3] = trace
    choice = np.argmax(diagonal, -1)
    c = np.empty(trace.shape + (4, 4))  # the four candidate quaternions, one per row
    c[..., 0, 0], c[..., 0, 1], c[..., 0, 2], c[..., 0, 3] = 1 - trace + 2 * m[..., 0, 0], m[..., 1, 0] + m[..., 0, 1], m[..., 2, 0] + m[..., 0, 2], m[..., 2, 1] - m[..., 1, 2]
    c[..., 1, 0], c[..., 1, 1], c[..., 1, 2], c[..., 1, 3] = m[..., 1, 0] + m[..., 0, 1], 1 - trace + 2 * m[..., 1, 1], m[..., 2, 1] + m[..., 1, 2], m[..., 0, 2] - m[..., 2, 0]
    c[..., 2, 0], c[..., 2, 1], c[..., 2, 2], c[..., 2, 3] = m[..., 2, 0] + m[..., 0, 2], m[..., 2, 1] + m[..., 1, 2], 1 - trace + 2 * m[..., 2, 2], m[..., 1, 0] - m[..., 0, 1]
    c[..., 3, 0], c[..., 3, 1], c[..., 3, 2], c[..., 3, 3] = m[..., 2, 1] - m[..., 1, 2], m[..., 0, 2] - m[..., 2, 0], m[..., 1, 0] - m[..., 0, 1], 1 + trace
    return normalize(np.take_along_axis(c, choice[..., None, None], -2)[..., 0, :])


def from_rotvec(rotvec):
    """Rotation.from_rotvec(rotvec).as_quat()."""
    rotvec = np.asarray(rotvec, float)
    angle = np.linalg.norm(rotvec, axis=-1, keepdims=True)
    small = angle <= 1e-3
    angle2 = angle ** 2
    scale = np.where(small, 0.5 - angle2 / 48 + angle2 ** 2 / 3840, np.sin(angle / 2) / (angle + small))
    return np.concatenate([rotvec * scale, np.cos(angle / 2)], -1)


def as_rotvec(quat):
    """Rotation.from_quat(quat).as_rotvec()."""
    quat = normalize(quat)
    # Canonical sign: the first nonzero of w, x, y, z is positive.
    x, y, z, w = np.moveaxis(quat, -1, 0)
    flip = (w < 0) | (w == 0) & ((x < 0) | (x == 0) & ((y < 0) | (y == 0) & (z < 0)))
    quat = np.where(flip[..., None], -quat, quat)
    angle = 2 * np.arctan2(np.linalg.norm(quat[..., :3], axis=-1, keepdims=True), quat[..., 3:])
    small = angle <= 1e-3
    angle2 = angle ** 2
    scale = np.where(small, 2 + angle2 / 12 + 7 * angle2 ** 2 / 2880, angle / (np.sin(angle / 2) + small))
    return scale * quat[..., :3]


def inv(quat):
    """Rotation.from_quat(quat).inv().as_quat()."""
    return normalize(quat) * np.array([-1.0, -1.0, -1.0, 1.0])


def compose(p, q):
    """(Rotation.from_quat(p) * Rotation.from_quat(q)).as_quat()."""
    p, q = normalize(p), normalize(q)
    cross = np.cross(p[..., :3], q[..., :3])
    return np.concatenate([p[..., 3:] * q[..., :3] + q[..., 3:] * p[..., :3] + cross,
                           p[..., 3:] * q[..., 3:] - np.sum(p[..., :3] * q[..., :3], -1, keepdims=True)], -1)


def slerp(a, b, w):
    """Slerp([0, 1], Rotation.from_matrix([a, b]))(w).as_matrix() for rotation matrices a, b."""
    qa, qb = from_matrix(np.stack([a, b]))
    return as_matrix(compose(qa, from_rotvec(as_rotvec(compose(inv(qa), qb)) * w)))
