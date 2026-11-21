"""Vertex and index codecs for importing an EFMI mod's geometry: packed TBN (ch1), outline normals (ch6), weights, bones, indices.

ch1 follows the bit layout the game's character vertex shader decodes. Buffers go in and out as bytes (native-endian items) or
arrays, independent of the package format. Standard library only: this module ships in the app's content.
"""
from array import array
import math

PACKED = 1 << 30
SIGN = 1 << 31
WELD_TOLERANCE = 1e-4
INFLUENCES = 4
# A ch1 field is a 10-bit two's complement value over 511.
FIELD = [(v - 1024 if v >= 512 else v)/511.0 for v in range(1024)]


def _array(data, code):
    """`data` as an array of typecode `code`; bytes-like data is read as its items."""
    if isinstance(data, array) and data.typecode == code:return data
    if isinstance(data, (bytes, bytearray, memoryview)):
        out = array(code); out.frombytes(data)
        return out
    return array(code, data)


def _columns(data, code, width):
    """The `width` interleaved components of `data` as separate lists."""
    a = _array(data, code)
    return [a[k::width].tolist() for k in range(width)]


def _interleave(columns, code):
    out = array(code, bytes(array(code).itemsize*len(columns)*len(columns[0])))
    for k, column in enumerate(columns):out[k::len(columns)] = array(code, column)
    return out


def is_packed_tbn(ch1):
    """Whether every ch1 word carries the packed flag (bit 30), so the shader decodes it rather than reading ch1/ch2 as floats."""
    return all(w & PACKED for w in _array(ch1, 'I'))


def decode_tbn(ch1):
    """(normals xyz, tangents xyz, signs ±1) of packed ch1 words, decoded as the game's vertex shader does."""
    words = _array(ch1, 'I')
    if not is_packed_tbn(words):raise ValueError('unpacked_tbn')
    sqrt = math.sqrt; field = FIELD
    normals = []; tangents = []
    for w in words:
        x = field[w & 1023]; y = field[(w >> 10) & 1023]; z = field[(w >> 20) & 1023]
        nz = 1.0 - abs(x) - abs(y)
        if nz < 0.0:x, y = (1.0 - abs(y))*(1.0 if x >= 0.0 else -1.0), (1.0 - abs(x))*(1.0 if y >= 0.0 else -1.0)
        l = 1.0/sqrt(x*x + y*y + nz*nz); nx = x*l; ny = y*l; nz *= l
        # Basis r = (n.y-n.z, n.z-n.x, n.x-n.y) and b = n×r; z picks a direction in it on a diamond.
        rx = ny - nz; ry = nz - nx; rz = nx - ny
        l = 1.0/sqrt(rx*rx + ry*ry + rz*rz); rx *= l; ry *= l; rz *= l
        s = -1.0 if z < 0.0 else 1.0
        a = 1.0 - 2.0*z*s; c = s*(1.0 - abs(a))
        l = 1.0/sqrt(a*a + c*c); a *= l; c *= l
        normals += (nx, ny, nz)
        tangents += (rx*a + (ny*rz - nz*ry)*c, ry*a + (nz*rx - nx*rz)*c, rz*a + (nx*ry - ny*rx)*c)
    return array('d', normals), array('d', tangents), array('b', [(w >> 31)*2 - 1 for w in words])


def encode_tbn(normals, tangents, signs):
    """Packed ch1 words of (normals xyz, tangents xyz, signs ±1), with bit 30 set; the inverse of `decode_tbn`.

    The tangent is coded against the basis of the quantized normal, the one the shader rebuilds."""
    sqrt = math.sqrt; field = FIELD
    n = _array(normals, 'd'); t = _array(tangents, 'd')
    out = []
    for nx, ny, nz, tx, ty, tz, sign in zip(n[0::3], n[1::3], n[2::3], t[0::3], t[1::3], t[2::3], signs):
        l = abs(nx) + abs(ny) + abs(nz); x = nx/l; y = ny/l
        if nz < 0.0:x, y = (1.0 - abs(y))*(1.0 if x >= 0.0 else -1.0), (1.0 - abs(x))*(1.0 if y >= 0.0 else -1.0)
        qx = round(x*511.0); qy = round(y*511.0)
        x = field[qx & 1023]; y = field[qy & 1023]
        z = 1.0 - abs(x) - abs(y)
        if z < 0.0:x, y = (1.0 - abs(y))*(1.0 if x >= 0.0 else -1.0), (1.0 - abs(x))*(1.0 if y >= 0.0 else -1.0)
        l = 1.0/sqrt(x*x + y*y + z*z); x *= l; y *= l; z *= l
        rx = y - z; ry = z - x; rz = x - y
        l = 1.0/sqrt(rx*rx + ry*ry + rz*rz); rx *= l; ry *= l; rz *= l
        a = tx*rx + ty*ry + tz*rz
        c = tx*(y*rz - z*ry) + ty*(z*rx - x*rz) + tz*(x*ry - y*rx)
        l = abs(a) + abs(c)
        qz = 0
        if l > 0.0:
            qz = round((1.0 - a/l)*255.5)
            if c < 0.0:qz = -qz
        out.append((qx & 1023) | (qy & 1023) << 10 | (qz & 1023) << 20 | PACKED | (SIGN if sign > 0 else 0))
    return array('I', out)


def weld(positions, tolerance=WELD_TOLERANCE):
    """(group of each vertex, group count): vertices whose xyz round to the same cell of a `tolerance` grid share a group."""
    xs, ys, zs = _columns(positions, 'f', 3); k = 1.0/tolerance
    table = {}
    keys = zip([round(v*k) for v in xs], [round(v*k) for v in ys], [round(v*k) for v in zs])
    groups = array('I', [table.setdefault(key, len(table)) for key in keys])
    return groups, len(table)


def _groups(positions, groups):
    if groups is None:return weld(positions)
    return groups, max(groups) + 1 if len(groups) else 0


def recompute_normals(positions, indices, groups=None):
    """Unit vertex normals xyz: the area-weighted sum of cross(p1-p0, p2-p0) over the triangles at each weld group.

    `groups` defaults to `weld(positions)`; a group no triangle reaches gets +Z."""
    xs, ys, zs = _columns(positions, 'f', 3)
    groups, count = _groups(positions, groups)
    g = groups.tolist() if isinstance(groups, array) else list(groups)
    i = _array(indices, 'I')
    ax = [0.0]*count; ay = [0.0]*count; az = [0.0]*count
    for a, b, c in zip(i[0::3], i[1::3], i[2::3]):
        x0 = xs[a]; y0 = ys[a]; z0 = zs[a]
        ux = xs[b] - x0; uy = ys[b] - y0; uz = zs[b] - z0
        vx = xs[c] - x0; vy = ys[c] - y0; vz = zs[c] - z0
        fx = uy*vz - uz*vy; fy = uz*vx - ux*vz; fz = ux*vy - uy*vx
        a = g[a]; ax[a] += fx; ay[a] += fy; az[a] += fz
        b = g[b]; ax[b] += fx; ay[b] += fy; az[b] += fz
        c = g[c]; ax[c] += fx; ay[c] += fy; az[c] += fz
    sqrt = math.sqrt
    for k in range(count):
        x = ax[k]; y = ay[k]; z = az[k]; l = sqrt(x*x + y*y + z*z)
        if l > 0.0:ax[k] = x/l; ay[k] = y/l; az[k] = z/l
        else:az[k] = 1.0
    return _interleave([[ax[k] for k in g], [ay[k] for k in g], [az[k] for k in g]], 'd')


def recompute_tangents(positions, uvs, indices, normals):
    """(unit tangents xyz, signs ±1): per vertex, the triangles' dP/dU summed and made orthogonal to the normal (Gram-Schmidt).

    sign is that of (N×T)·dP/dV, so cross(N, T)·sign is the bitangent the shader rebuilds. A vertex with no usable UV area gets
    the shader's zero-code tangent of its normal."""
    xs, ys, zs = _columns(positions, 'f', 3)
    us, vs = _columns(uvs, 'f', 2)
    nx, ny, nz = _columns(normals, 'd', 3)
    n = len(xs); i = _array(indices, 'I')
    sx = [0.0]*n; sy = [0.0]*n; sz = [0.0]*n; tx = [0.0]*n; ty = [0.0]*n; tz = [0.0]*n
    for a, b, c in zip(i[0::3], i[1::3], i[2::3]):
        x0 = xs[a]; y0 = ys[a]; z0 = zs[a]; u0 = us[a]; v0 = vs[a]
        e1x = xs[b] - x0; e1y = ys[b] - y0; e1z = zs[b] - z0
        e2x = xs[c] - x0; e2y = ys[c] - y0; e2z = zs[c] - z0
        du1 = us[b] - u0; dv1 = vs[b] - v0; du2 = us[c] - u0; dv2 = vs[c] - v0
        det = du1*dv2 - du2*dv1
        if det == 0.0:continue
        r = 1.0/det
        px = (e1x*dv2 - e2x*dv1)*r; py = (e1y*dv2 - e2y*dv1)*r; pz = (e1z*dv2 - e2z*dv1)*r
        qx = (e2x*du1 - e1x*du2)*r; qy = (e2y*du1 - e1y*du2)*r; qz = (e2z*du1 - e1z*du2)*r
        sx[a] += px; sy[a] += py; sz[a] += pz; tx[a] += qx; ty[a] += qy; tz[a] += qz
        sx[b] += px; sy[b] += py; sz[b] += pz; tx[b] += qx; ty[b] += qy; tz[b] += qz
        sx[c] += px; sy[c] += py; sz[c] += pz; tx[c] += qx; ty[c] += qy; tz[c] += qz
    sqrt = math.sqrt; signs = []
    for k in range(n):
        x = nx[k]; y = ny[k]; z = nz[k]; px = sx[k]; py = sy[k]; pz = sz[k]
        d = x*px + y*py + z*pz; px -= x*d; py -= y*d; pz -= z*d
        l = sqrt(px*px + py*py + pz*pz)
        if l > 0.0:px /= l; py /= l; pz /= l
        else:
            px = y - z; py = z - x; pz = x - y; l = sqrt(px*px + py*py + pz*pz); px /= l; py /= l; pz /= l
        sx[k] = px; sy[k] = py; sz[k] = pz
        signs.append(-1 if (y*pz - z*py)*tx[k] + (z*px - x*pz)*ty[k] + (x*py - y*px)*tz[k] < 0.0 else 1)
    return _interleave([sx, sy, sz], 'd'), array('b', signs)


def outline_normals(positions, ch1, groups=None):
    """ch6 xy of each vertex: its weld group's summed unit ch1 normals, normalized, in the vertex's ch1 TBN, rounded to 1/127.

    Only xy is kept even when the smoothed normal lies behind the vertex; the shader takes z ≥ 0. `groups` defaults to
    `weld(positions)`."""
    normals, tangents, signs = decode_tbn(ch1)
    groups, count = _groups(positions, groups)
    g = groups.tolist() if isinstance(groups, array) else list(groups)
    nx, ny, nz = _columns(normals, 'd', 3)
    ax = [0.0]*count; ay = [0.0]*count; az = [0.0]*count
    for k, x, y, z in zip(g, nx, ny, nz):ax[k] += x; ay[k] += y; az[k] += z
    sqrt = math.sqrt
    for k in range(count):
        x = ax[k]; y = ay[k]; z = az[k]; l = sqrt(x*x + y*y + z*z)
        if l > 0.0:ax[k] = x/l; ay[k] = y/l; az[k] = z/l
    out = []
    for k, x, y, z, tx, ty, tz, w in zip(g, nx, ny, nz, tangents[0::3], tangents[1::3], tangents[2::3], signs):
        px = ax[k]; py = ay[k]; pz = az[k]
        out += (round((px*tx + py*ty + pz*tz)*127.0)/127.0,
                round((px*(y*tz - z*ty) + py*(z*tx - x*tz) + pz*(x*ty - y*tx))*w*127.0)/127.0)
    return array('f', out)


def normalize_weights(weights):
    """(weights scaled to sum 1 per vertex, number of all-zero vertices); an all-zero vertex becomes (1, 0, 0, 0)."""
    columns = _columns(weights, 'f', INFLUENCES)
    sums = [sum(row) for row in zip(*columns)]
    inverse = [1.0/s if s else 0.0 for s in sums]
    columns = [[v*r for v, r in zip(column, inverse)] for column in columns]
    columns[0] = [1.0 if r == 0.0 else v for v, r in zip(columns[0], inverse)]
    return _interleave(columns, 'f'), inverse.count(0.0)


def remap_bones(bones, table):
    """Each bone index looked up in `table` (a sequence or a mapping); an index the table lacks raises ValueError."""
    bones = _array(bones, 'I')
    out = array('I')
    for b in bones:
        try:out.append(table[b])
        except (IndexError, KeyError):raise ValueError(f'bone {b} is not in the table') from None
    return out


def widen_indices(data, component_bytes):
    """u16 or u32 index bytes as u32."""
    if component_bytes == 4:return _array(data, 'I')
    if component_bytes == 2:return array('I', _array(data, 'H'))
    raise ValueError(f'index_component_bytes:{component_bytes}')


def concat_ranges(indices, ranges, vertex_count):
    """The (first, count, base_vertex) ranges of `indices` joined, each index plus its base vertex and checked < `vertex_count`."""
    indices = _array(indices, 'I'); out = array('I')
    for first, count, base in ranges:
        if first < 0 or count < 0 or first + count > len(indices):raise ValueError(f'range {first}+{count} exceeds {len(indices)} indices')
        part = indices[first:first + count]
        if base:part = array('I', [v + base for v in part])
        if part and max(part) >= vertex_count:raise ValueError(f'index {max(part)} is not below the vertex count {vertex_count}')
        out += part
    return out
