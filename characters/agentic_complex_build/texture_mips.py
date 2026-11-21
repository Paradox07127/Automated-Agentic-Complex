"""Fill in the mip levels a texture lacks, its level 0 kept byte for byte: each new level is the 2x2 box filter of the one
above it, in linear light for an sRGB format and with a BC5 normal map's vectors renormalized, encoded again in the texture's
format. The encoders aim at adequate levels, not the best: BC7 writes mode 6 only, BC3 and BC5 their endpoints' range.
Standard library only: this module ships in the app's content.
"""
from concurrent.futures import ProcessPoolExecutor
import math
from math import sumprod
import multiprocessing
import os

from .efmi_mod import mip_size
from .outfit_compose import TextureBlob

FORMATS = ('BC7_SRGB_BLOCK', 'BC7_UNORM_BLOCK', 'BC5_UNORM_BLOCK', 'BC3_SRGB_BLOCK', 'BC3_UNORM_BLOCK', 'R8G8B8A8_SRGB', 'R8G8B8A8_UNORM')
# Fewer level-0 blocks than this over all textures are filled in this process; more are split over worker processes.
POOL_BLOCKS = 4096
# The level-0 pixel rows of one worker task.
BAND_ROWS = 128

SRGB_TO_LINEAR = [((v/255+0.055)/1.055)**2.4 if v > 10 else v/255/12.92 for v in range(256)]
UNORM = [v/255 for v in range(256)]
LINEAR_STEPS = 16384
LINEAR_TO_SRGB = [255*(12.92*x if x <= 0.0031308 else 1.055*x**(1/2.4)-0.055) for x in (i/LINEAR_STEPS for i in range(LINEAR_STEPS+1))]
# The pixels of a 4x4 block that each texel of the level below averages.
QUADS = ((0, 1, 4, 5), (2, 3, 6, 7), (8, 9, 12, 13), (10, 11, 14, 15))

# BC7 mode -> (subsets, partition bits, rotation bits, index selection bits, color bits, alpha bits, endpoint p-bits,
# shared p-bits, index bits, secondary index bits).
BC7_MODES = ((3, 4, 0, 0, 4, 0, 1, 0, 3, 0), (2, 6, 0, 0, 6, 0, 0, 1, 3, 0), (3, 6, 0, 0, 5, 0, 0, 0, 2, 0), (2, 6, 0, 0, 7, 0, 1, 0, 2, 0),
             (1, 0, 2, 1, 5, 6, 0, 0, 2, 3), (1, 0, 2, 0, 7, 8, 0, 0, 2, 2), (1, 0, 0, 0, 7, 7, 1, 0, 4, 0), (2, 6, 0, 0, 5, 5, 1, 0, 2, 0))
BC7_WEIGHTS = {2: (0, 21, 43, 64), 3: (0, 9, 18, 27, 37, 46, 55, 64), 4: (0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64)}
# Bit i is the subset of pixel i of each two-subset partition.
BC7_PARTITIONS2 = (
    0xCCCC, 0x8888, 0xEEEE, 0xECC8, 0xC880, 0xFEEC, 0xFEC8, 0xEC80, 0xC800, 0xFFEC, 0xFE80, 0xE800, 0xFFE8, 0xFF00, 0xFFF0, 0xF000,
    0xF710, 0x008E, 0x7100, 0x08CE, 0x008C, 0x7310, 0x3100, 0x8CCE, 0x088C, 0x3110, 0x6666, 0x366C, 0x17E8, 0x0FF0, 0x718E, 0x399C,
    0xAAAA, 0xF0F0, 0x5A5A, 0x33CC, 0x3C3C, 0x55AA, 0x9696, 0xA55A, 0x73CE, 0x13C8, 0x324C, 0x3BDC, 0x6996, 0xC33C, 0x9966, 0x0660,
    0x0272, 0x04E4, 0x4E40, 0x2720, 0xC936, 0x936C, 0x39C6, 0x639C, 0x9336, 0x9CC6, 0x817E, 0xE718, 0xCCF0, 0x0FCC, 0x7744, 0xEE22)
BC7_PARTITIONS3 = (
    '0011001102212222', '0001001122112221', '0000200122112211', '0222002200110111', '0000000011221122', '0011001100220022',
    '0022002211111111', '0011001122112211', '0000000011112222', '0000111111112222', '0000111122222222', '0012001200120012',
    '0112011201120112', '0122012201220122', '0011011211221222', '0011200122002220', '0001001101121122', '0111001120012200',
    '0000112211221122', '0022002200221111', '0111011102220222', '0001000122212221', '0000001101220122', '0000110022102210',
    '0122012200110000', '0012001211222222', '0110122112210110', '0000011012211221', '0022110211020022', '0110011020022222',
    '0011012201220011', '0000200022112221', '0000000211221222', '0222002200120011', '0011001200220222', '0120012001200120',
    '0000111122220000', '0120120120120120', '0120201212010120', '0011220011220011', '0011112222000011', '0101010122222222',
    '0000000021212121', '0022112200221122', '0022001100220011', '0220122102201221', '0101222222220101', '0000212121212121',
    '0101010101012222', '0222011102220111', '0002111200021112', '0000211221122112', '0222011101110222', '0002111211120002',
    '0110011001102222', '0000000021122112', '0110011022222222', '0022001100110022', '0022112211220022', '0000000000002112',
    '0002000100020001', '0222122202221222', '0101222222222222', '0111201122012220')
BC7_ANCHORS2 = (15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
                15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15)
BC7_ANCHORS3_1 = (3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
                  8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3)
BC7_ANCHORS3_2 = (15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
                  15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8)
# Subsets -> partition -> (subset of each pixel, the pixels whose index has one bit less).
BC7_SHAPES = {1: [((0,)*16, (0,))],
              2: [(tuple((m >> i) & 1 for i in range(16)), (0, a)) for m, a in zip(BC7_PARTITIONS2, BC7_ANCHORS2)],
              3: [(tuple(map(int, p)), (0, a, b)) for p, a, b in zip(BC7_PARTITIONS3, BC7_ANCHORS3_1, BC7_ANCHORS3_2)]}
# The index of BC7_WEIGHTS[4] nearest each weight 0..64 out of 64.
NEAREST4 = [min(range(16), key=lambda i: abs(BC7_WEIGHTS[4][i]-t)) for t in range(65)]


def expand(value, bits):return (value << (8-bits)) | (value >> (2*bits-8))


def bc7_decode(block):
    """The 64 RGBA bytes (pixel order) of a BC7 block; a block with no mode bit decodes to zeros."""
    v = int.from_bytes(block, 'little')
    low = v & 0xFF
    if not low:return [0]*64
    mode = (low & -low).bit_length()-1
    ns, pb, rb, isb, cb, ab, epb, spb, ib, ib2 = BC7_MODES[mode]
    v >>= mode+1
    part = v & ((1 << pb)-1); v >>= pb
    rot = v & ((1 << rb)-1); v >>= rb
    sel = v & ((1 << isb)-1); v >>= isb
    n = 2*ns
    ends = [[0, 0, 0, 255] for _ in range(n)]
    for c in range(3):
        for e in ends:e[c] = v & ((1 << cb)-1); v >>= cb
    if ab:
        for e in ends:e[3] = v & ((1 << ab)-1); v >>= ab
    pbits = None
    if epb:pbits = [(v >> e) & 1 for e in range(n)]; v >>= n
    elif spb:pbits = [(v >> (e >> 1)) & 1 for e in range(n)]; v >>= ns
    extra = 1 if pbits else 0
    for k, e in enumerate(ends):
        for c in range(3):e[c] = expand((e[c] << extra) | (pbits[k] if extra else 0), cb+extra)
        if ab:e[3] = expand((e[3] << extra) | (pbits[k] if extra else 0), ab+extra)
    subsets, anchors = BC7_SHAPES[ns][part]
    indices = []
    for i in range(16):
        w = ib-1 if i in anchors else ib
        indices.append(v & ((1 << w)-1)); v >>= w
    alphas = indices
    if ib2:
        alphas = []
        for i in range(16):
            w = ib2-1 if i == 0 else ib2
            alphas.append(v & ((1 << w)-1)); v >>= w
    cw, aw = BC7_WEIGHTS[ib], BC7_WEIGHTS[ib2 or ib]
    if sel:indices, alphas, cw, aw = alphas, indices, aw, cw
    out = []
    for i in range(16):
        s = subsets[i]; e0, e1 = ends[2*s], ends[2*s+1]
        w = cw[indices[i]]; u = 64-w; a = aw[alphas[i]]
        px = [(u*e0[0]+w*e1[0]+32) >> 6, (u*e0[1]+w*e1[1]+32) >> 6, (u*e0[2]+w*e1[2]+32) >> 6, ((64-a)*e0[3]+a*e1[3]+32) >> 6]
        if rot:px[rot-1], px[3] = px[3], px[rot-1]
        out += px
    return out


def mode6_endpoint(e):
    """(7-bit channels, p-bit) of the mode 6 endpoint nearest RGBA `e` (floats 0..255)."""
    best = None
    for bit in (0, 1):
        qs = [min(127, max(0, int((x-bit)/2+0.5))) for x in e]
        err = sum((2*k+bit-x)**2 for k, x in zip(qs, e))
        if best is None or err < best[0]:best = (err, qs, bit)
    return best[1], best[2]


def mode6_fit(channels, ends):
    """(squared error, endpoints, p-bits, indices) of the mode 6 endpoints nearest `ends` for the pixels' `channels`."""
    (q0, p0), (q1, p1) = mode6_endpoint(ends[0]), mode6_endpoint(ends[1])
    v0, v1 = [2*k+p0 for k in q0], [2*k+p1 for k in q1]
    dv = [b-a for a, b in zip(v0, v1)]; dd = sumprod(dv, dv)
    if dd:
        scale, base = 64/dd, sumprod(v0, dv)
        idx = [NEAREST4[min(64, max(0, int((r*dv[0]+g*dv[1]+b*dv[2]+a*dv[3]-base)*scale+0.5)))] for r, g, b, a in zip(*channels)]
    else:idx = [0]*16
    weights = [BC7_WEIGHTS[4][i] for i in idx]
    err = 0
    for c, values in enumerate(channels):
        e0, e1 = v0[c], v1[c]
        err += sum(((((64-w)*e0+w*e1+32) >> 6)-x)**2 for w, x in zip(weights, values))
    return err, (q0, q1), (p0, p1), idx


def bc7_encode(px):
    """A BC7 mode 6 block of 16 RGBA pixels, each channel a float 0..255: endpoints along the pixels' principal axis, then
    refitted by least squares to the indices they give, whichever fits better."""
    channels = list(zip(*px))
    mean = [sum(ch)/16 for ch in channels]
    d = [[x-m for x in ch] for ch, m in zip(channels, mean)]
    cov = [[sumprod(d[i], d[j]) for j in range(4)] for i in range(4)]
    axis = [max(ch)-min(ch) for ch in channels]
    for _ in range(3):
        new = [sumprod(row, axis) for row in cov]
        m = max(abs(a) for a in new)
        if m < 1e-9:break
        axis = [a/m for a in new]
    ts = [r*axis[0]+g*axis[1]+b*axis[2]+a*axis[3] for r, g, b, a in zip(*d)]
    ends = [[min(255.0, max(0.0, m+t*a)) for m, a in zip(mean, axis)] for t in (min(ts), max(ts))]
    best = mode6_fit(channels, ends)
    w = [BC7_WEIGHTS[4][i]/64 for i in best[3]]; u = [1-x for x in w]
    uu, uw, ww = sumprod(u, u), sumprod(u, w), sumprod(w, w)
    det = uu*ww-uw*uw
    if best[0] and det > 1e-9:
        su, sw = [sumprod(u, ch) for ch in channels], [sumprod(w, ch) for ch in channels]
        refit = [[min(255.0, max(0.0, (ww*a-uw*b)/det)) for a, b in zip(su, sw)], [min(255.0, max(0.0, (uu*b-uw*a)/det)) for a, b in zip(su, sw)]]
        best = min(best, mode6_fit(channels, refit), key=lambda f: f[0])
    _, q, p, idx = best
    q, p = list(q), list(p)
    if idx[0] >= 8:
        q.reverse(); p.reverse(); idx = [15-i for i in idx]
    bits, at = 1 << 6, 7
    for c in range(4):
        bits |= q[0][c] << at; bits |= q[1][c] << (at+7); at += 14
    bits |= p[0] << at; bits |= p[1] << (at+1); at += 2
    bits |= idx[0] << at; at += 3
    for i in idx[1:]:bits |= i << at; at += 4
    return bits.to_bytes(16, 'little')


def bc4_decode(block):
    """The 16 values (floats 0..255) of an 8-byte BC4 block."""
    e0, e1 = block[0], block[1]
    if e0 > e1:palette = [e0, e1]+[((7-i)*e0+i*e1)/7 for i in range(1, 7)]
    else:palette = [e0, e1]+[((5-i)*e0+i*e1)/5 for i in range(1, 5)]+[0, 255]
    v = int.from_bytes(block[2:8], 'little')
    return [palette[(v >> (3*i)) & 7] for i in range(16)]


def bc4_encode(values):
    """An 8-byte BC4 block of 16 floats 0..255 in its eight-value mode, the endpoints their range."""
    e0, e1 = min(255, int(max(values)+0.5)), max(0, int(min(values)+0.5))
    if e0 <= e1:return bytes([e0, e0])+bytes(6)
    scale = 7/(e0-e1); v = 0
    for i, x in enumerate(values):
        k = min(7, max(0, int((x-e1)*scale+0.5)))
        v |= (0 if k == 7 else 1 if k == 0 else 8-k) << (3*i)
    return bytes([e0, e1])+v.to_bytes(6, 'little')


def rgb565(c):return ((c >> 11) << 3 | (c >> 13), ((c >> 5) & 63) << 2 | ((c >> 9) & 3), (c & 31) << 3 | ((c >> 2) & 7))


def bc3_decode(block):
    """The 64 RGBA values (pixel order) of a BC3 block; its color block always has four colors."""
    alpha = bc4_decode(block[:8])
    c0, c1 = rgb565(block[8] | block[9] << 8), rgb565(block[10] | block[11] << 8)
    palette = [c0, c1, [(2*a+b)/3 for a, b in zip(c0, c1)], [(a+2*b)/3 for a, b in zip(c0, c1)]]
    v = int.from_bytes(block[12:16], 'little'); out = []
    for i in range(16):out += [*palette[(v >> (2*i)) & 3], alpha[i]]
    return out


BC3_WEIGHTS = (0, 1, 1/3, 2/3)


def bc3_fit(channels, ends):
    """(squared error, color 0, color 1, indices) of the RGB565 endpoints nearest `ends` for the pixels' `channels`, color 0
    the greater."""
    c0, c1 = (int(min(255.0, max(0.0, r))*31/255+0.5) << 11 | int(min(255.0, max(0.0, g))*63/255+0.5) << 5 |
              int(min(255.0, max(0.0, b))*31/255+0.5) for r, g, b in ends)
    if c0 < c1:c0, c1 = c1, c0
    e0, e1 = rgb565(c0), rgb565(c1)
    dv = [b-a for a, b in zip(e0, e1)]; dd = sumprod(dv, dv)
    if dd:
        base = sumprod(e0, dv)
        idx = [0 if t < 1/6 else 2 if t < 1/2 else 3 if t < 5/6 else 1 for t in ((r*dv[0]+g*dv[1]+b*dv[2]-base)/dd for r, g, b in zip(*channels))]
    else:idx = [0]*16
    err = sum((a+BC3_WEIGHTS[i]*d-x)**2 for a, d, values in zip(e0, dv, channels) for i, x in zip(idx, values))
    return err, c0, c1, idx


def bc3_encode(px):
    """A BC3 block of 16 RGBA pixels (floats 0..255): its colors along their principal axis, then refitted by least squares to
    the indices they give, whichever fits better; its alpha its range."""
    channels = list(zip(*px))[:3]
    mean = [sum(ch)/16 for ch in channels]
    d = [[x-m for x in ch] for ch, m in zip(channels, mean)]
    cov = [[sumprod(d[i], d[j]) for j in range(3)] for i in range(3)]
    axis = [max(ch)-min(ch) for ch in channels]
    for _ in range(3):
        new = [sumprod(row, axis) for row in cov]
        m = max(abs(a) for a in new)
        if m < 1e-9:break
        axis = [a/m for a in new]
    ts = [r*axis[0]+g*axis[1]+b*axis[2] for r, g, b in zip(*d)]
    best = bc3_fit(channels, [[m+t*a for m, a in zip(mean, axis)] for t in (max(ts), min(ts))])
    w = [BC3_WEIGHTS[i] for i in best[3]]; u = [1-x for x in w]
    uu, uw, ww = sumprod(u, u), sumprod(u, w), sumprod(w, w)
    det = uu*ww-uw*uw
    if best[0] and det > 1e-9:
        su, sw = [sumprod(u, ch) for ch in channels], [sumprod(w, ch) for ch in channels]
        refit = [[(ww*a-uw*b)/det for a, b in zip(su, sw)], [(uu*b-uw*a)/det for a, b in zip(su, sw)]]
        best = min(best, bc3_fit(channels, refit), key=lambda f: f[0])
    _, c0, c1, idx = best
    v = 0
    if c0 != c1:
        for k, i in enumerate(idx):v |= i << (2*k)
    return bc4_encode([p[3] for p in px])+bytes([c0 & 255, c0 >> 8, c1 & 255, c1 >> 8])+v.to_bytes(4, 'little')


def bc5_decode(block):
    """The 64 bytes-range values (R, G, 0, 255 a pixel) of a BC5 block."""
    out = []
    for r, g in zip(bc4_decode(block[:8]), bc4_decode(block[8:])):out += [r, g, 0, 255]
    return out


def bc5_encode(px):return bc4_encode([p[0] for p in px])+bc4_encode([p[1] for p in px])


def rgba8_decode(block):return list(block)


def rgba8_encode(px):return bytes(min(255, max(0, int(x+0.5))) for x in px[0])


# Format -> (block width, block bytes, decode, encode, the filter space of a byte value of each channel, normal map).
CODECS = {'BC7_SRGB_BLOCK': (4, 16, bc7_decode, bc7_encode, True, False), 'BC7_UNORM_BLOCK': (4, 16, bc7_decode, bc7_encode, False, False),
          'BC5_UNORM_BLOCK': (4, 16, bc5_decode, bc5_encode, False, True), 'BC3_SRGB_BLOCK': (4, 16, bc3_decode, bc3_encode, True, False),
          'BC3_UNORM_BLOCK': (4, 16, bc3_decode, bc3_encode, False, False), 'R8G8B8A8_SRGB': (1, 4, rgba8_decode, rgba8_encode, True, False),
          'R8G8B8A8_UNORM': (1, 4, rgba8_decode, rgba8_encode, False, False)}


def to_filter(fmt, values):
    """The filter-space texels of a format's decoded values (4 a pixel): linear RGBA in 0..1, or a normal map's unit (x, y, z, 0)."""
    _, _, _, _, srgb, normal = CODECS[fmt]
    out = []
    if normal:
        for i in range(0, len(values), 4):
            x, y = values[i]/127.5-1, values[i+1]/127.5-1
            out.append((x, y, math.sqrt(max(0.0, 1-x*x-y*y)), 0.0))
        return out
    color = SRGB_TO_LINEAR if srgb else UNORM
    for i in range(0, len(values), 4):
        r, g, b, a = values[i:i+4]
        if isinstance(r, int):out.append((color[r], color[g], color[b], a/255))
        else:out.append((to_linear(r) if srgb else r/255, to_linear(g) if srgb else g/255, to_linear(b) if srgb else b/255, a/255))
    return out


def to_linear(v):
    """An sRGB value 0..255 that need not be whole (a BC3 palette color) in linear light."""
    v /= 255
    return ((v+0.055)/1.055)**2.4 if v > 0.04045 else v/12.92


def from_filter(fmt, texel):
    """A filter-space texel as the encoder's channel values, floats 0..255."""
    _, _, _, _, srgb, normal = CODECS[fmt]
    if normal:return ((texel[0]+1)*127.5, (texel[1]+1)*127.5, 0.0, 255.0)
    a = texel[3]*255
    if srgb:
        return tuple(LINEAR_TO_SRGB[int(min(1.0, max(0.0, c))*LINEAR_STEPS+0.5)] for c in texel[:3])+(a,)
    return (texel[0]*255, texel[1]*255, texel[2]*255, a)


def normalize(texel):
    x, y, z, _ = texel
    n = math.sqrt(x*x+y*y+z*z)
    return (x/n, y/n, z/n, 0.0) if n > 1e-12 else (0.0, 0.0, 1.0, 0.0)


def decode_level(fmt, data, width, height):
    """The filter-space texels of one level, row by row."""
    bw, nb, decode, *_ = CODECS[fmt]
    bx, by = (width+bw-1)//bw, (height+bw-1)//bw
    out = [None]*(width*height)
    for j in range(by):
        for i in range(bx):
            k = (j*bx+i)*nb
            texels = to_filter(fmt, decode(data[k:k+nb]))
            for p, t in enumerate(texels):
                x, y = i*bw+p % bw, j*bw+p//bw
                if x < width and y < height:out[y*width+x] = t
    return out


def downsample(fmt, texels, width, height):
    """(the 2x2 box filter of a level, its width, its height); an edge of one texel is repeated."""
    w, h = max(1, width >> 1), max(1, height >> 1)
    normal = CODECS[fmt][5]
    out = []
    for y in range(h):
        r0, r1 = min(2*y, height-1)*width, min(2*y+1, height-1)*width
        for x in range(w):
            x0, x1 = min(2*x, width-1), min(2*x+1, width-1)
            a, b, c, d = texels[r0+x0], texels[r0+x1], texels[r1+x0], texels[r1+x1]
            t = ((a[0]+b[0]+c[0]+d[0])*0.25, (a[1]+b[1]+c[1]+d[1])*0.25, (a[2]+b[2]+c[2]+d[2])*0.25, (a[3]+b[3]+c[3]+d[3])*0.25)
            out.append(normalize(t) if normal else t)
    return out, w, h


def first_level(fmt, data, width, height):
    """The 2x2 box filter of a level whose width and height are multiples of its block width 4, from each block at once; a block
    of bytes seen before is not decoded again."""
    _, nb, decode, _, _, normal = CODECS[fmt]
    bx, by = width//4, height//4
    w = width//2
    out = [None]*(w*(height//2))
    seen = {}
    for j in range(by):
        for i in range(bx):
            k = (j*bx+i)*nb
            block = data[k:k+nb]
            quads = seen.get(block)
            if quads is None:
                t = to_filter(fmt, decode(block)); quads = []
                for q in QUADS:
                    a, b, c, d = (t[p] for p in q)
                    s = ((a[0]+b[0]+c[0]+d[0])*0.25, (a[1]+b[1]+c[1]+d[1])*0.25, (a[2]+b[2]+c[2]+d[2])*0.25, (a[3]+b[3]+c[3]+d[3])*0.25)
                    quads.append(normalize(s) if normal else s)
                seen[block] = quads
            row = (2*j)*w+2*i
            out[row], out[row+1], out[row+w], out[row+w+1] = quads
    return out, w, height//2


def encode_level(fmt, texels, width, height):
    """One level's bytes, its blocks row by row; a block past the level's edge repeats its last texel."""
    bw, _, _, encode, _, _ = CODECS[fmt]
    out = bytearray()
    for j in range(0, height, bw):
        for i in range(0, width, bw):
            px = [from_filter(fmt, texels[min(j+p//bw, height-1)*width+min(i+p % bw, width-1)]) for p in range(bw*bw)]
            out += encode(px)
    return bytes(out)


def chain(fmt, width, height, count):
    """The mip records (level, width, height, offset, size) of `count` levels."""
    mips, offset = [], 0
    for level in range(count):
        w, h = max(1, width >> level), max(1, height >> level)
        mips.append(dict(level=level, width=w, height=h, offset=offset, size=mip_size(fmt, w, h))); offset += mips[-1]['size']
    return mips


def levels(fmt, data, width, height, count):
    """(the bytes of levels 1..count-1 below level 0 `data`, the texels of the last of them); the first comes from the blocks
    themselves when the level's size allows."""
    bw = CODECS[fmt][0]
    if bw == 4 and width % 4 == 0 and height % 4 == 0:texels, w, h = first_level(fmt, data, width, height)
    else:texels, w, h = downsample(fmt, decode_level(fmt, data, width, height), width, height)
    out = [encode_level(fmt, texels, w, h)]
    for _ in range(2, count):
        texels, w, h = downsample(fmt, texels, w, h); out.append(encode_level(fmt, texels, w, h))
    return out, texels


def band(task):
    """levels() of a band of level-0 rows: a worker task."""
    return levels(*task)


def fill_all(jobs):
    """Each (TextureBlob, level count) of `jobs` as a TextureBlob of that many levels, made from its level 0; one with as many
    levels is returned as it is. A texture whose height is a multiple of BAND_ROWS is filled in bands of that many rows, the
    levels a band holds whole blocks of computed apart, over worker processes once the jobs are large."""
    tasks, plans = [], []
    for blob, count in jobs:
        if len(blob.mips) >= count:plans.append(None); continue
        if blob.rd_format_name not in CODECS:raise ValueError('unsupported_texture_format')
        fmt, w, h = blob.rd_format_name, blob.width, blob.height
        m0 = blob.mips[0]; data = blob.data[m0['offset']:m0['offset']+m0['size']]
        bw, nb = CODECS[fmt][:2]
        rows = BAND_ROWS if bw == 4 and w % 4 == 0 and h % BAND_ROWS == 0 and h > BAND_ROWS else h
        # Level k of a band holds whole blocks while rows >> k is a multiple of the block width.
        inside = 1
        while inside+1 < count and (rows >> (inside+1)) >= bw and (rows >> (inside+1)) % bw == 0:inside += 1
        if rows == h:inside = count-1
        stride = (w+bw-1)//bw*nb*(rows//bw) if rows != h else len(data)
        first = len(tasks)
        for start in range(0, len(data), stride):tasks.append((fmt, data[start:start+stride], w, rows, inside+1))
        plans.append((blob, count, first, len(tasks), inside))
    blocks = sum(len(t[1])//CODECS[t[0]][1] for t in tasks)
    if blocks >= POOL_BLOCKS and len(tasks) > 1:
        with ProcessPoolExecutor(max_workers=min(len(tasks), os.cpu_count() or 1), mp_context=multiprocessing.get_context('spawn')) as pool:
            results = list(pool.map(band, tasks))
    else:results = [band(t) for t in tasks]
    out = []
    for (blob, count), plan in zip(jobs, plans):
        if plan is None:out.append(blob); continue
        _, _, first, last, inside = plan
        fmt, w = blob.rd_format_name, blob.width
        parts = results[first:last]
        made = [b''.join(p[0][k] for p in parts) for k in range(inside)]
        if inside < count-1:
            texels = [t for p in parts for t in p[1]]
            lw, lh = max(1, w >> inside), max(1, blob.height >> inside)
            for _ in range(inside+1, count):
                texels, lw, lh = downsample(fmt, texels, lw, lh); made.append(encode_level(fmt, texels, lw, lh))
        m0 = blob.mips[0]
        data = blob.data[m0['offset']:m0['offset']+m0['size']]+b''.join(made)
        mips = chain(fmt, w, blob.height, count)
        if len(data) != mips[-1]['offset']+mips[-1]['size']:raise ValueError('texture_size')
        out.append(TextureBlob(data, w, blob.height, fmt, mips))
    return out
