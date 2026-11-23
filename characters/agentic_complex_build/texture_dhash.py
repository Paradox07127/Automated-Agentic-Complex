"""The 64-bit difference hash (dHash) XXMI computes on the GPU for a texture (DHash64Gpu.cpp), so that a mod's texture
filter (`match_dhash`, `match_confidence`) can be matched to the original texture it names: 9x8 bilinear samples of one
level, each bit whether a sample is greater than its right-hand neighbour. Only the blocks the samples touch are decoded.
Standard library only: this module ships in the app's content.
"""
import math
import struct

from .texture_mips import CODECS, SRGB_TO_LINEAR, to_linear

# XXMI's [Rendering] dhash_mip_size: the shorter side of the smallest level it prefers to hash.
MIP_SIZE = 256


def level_index(levels):
    """The level XXMI hashes: the smallest whose shorter side is at least MIP_SIZE, else level 0."""
    for i in range(len(levels)-1, 0, -1):
        if min(levels[i][0], levels[i][1]) >= MIP_SIZE:return i
    return 0


def view_texel(srgb, px):
    """A decoded texel (4 channel values 0..255) as a D3D11 view of its format returns it: RGBA 0..1, the color linear for
    an sRGB format; BC5's decoder already gives (R, G, 0, 255)."""
    r, g, b, a = px
    if srgb:r, g, b = (SRGB_TO_LINEAR[c] if isinstance(c, int) else to_linear(c) for c in (r, g, b))
    else:r, g, b = r/255, g/255, b/255
    return (r, g, b, a/255)


def sampler(fmt, width, height, data):
    """A function of (u, v) giving the bilinear, clamp-addressed RGBA sample of a level, decoding each block once."""
    bw, nb, decode, _, srgb, _ = CODECS[fmt]
    bx = (width+bw-1)//bw
    blocks = {}

    def texel(x, y):
        i, j = x//bw, y//bw
        texels = blocks.get((i, j))
        if texels is None:
            k = (j*bx+i)*nb
            values = decode(data[k:k+nb])
            texels = blocks[i, j] = [view_texel(srgb, values[p:p+4]) for p in range(0, len(values), 4)]
        return texels[(y-j*bw)*bw+x-i*bw]

    def sample(u, v):
        tx, ty = u*width-0.5, v*height-0.5
        x0, y0 = math.floor(tx), math.floor(ty)
        fx, fy = tx-x0, ty-y0
        xa, xb = min(max(x0, 0), width-1), min(max(x0+1, 0), width-1)
        ya, yb = min(max(y0, 0), height-1), min(max(y0+1, 0), height-1)
        c00, c10, c01, c11 = texel(xa, ya), texel(xb, ya), texel(xa, yb), texel(xb, yb)
        # a+f*(b-a) keeps a flat region exactly flat, so equal neighbours never set a bit.
        out = []
        for a, b, c, d in zip(c00, c10, c01, c11):
            top, bottom = a+fx*(b-a), c+fx*(d-c)
            out.append(top+fy*(bottom-top))
        return out

    return sample


def dhash(rd_format_name, levels):
    """The dHash of a texture whose levels are [(width, height, data)] from level 0 down, `rd_format_name` a CODECS key."""
    if rd_format_name not in CODECS:raise ValueError('unsupported_texture_format')
    width, height, data = levels[level_index(levels)]
    sample = sampler(rd_format_name, width, height, data)
    rows = [[0.25*sum(sample((x+0.5)/9, (y+0.5)/8)) for x in range(9)] for y in range(8)]
    h = 0
    for y, row in enumerate(rows):
        for x in range(8):
            if row[x] > row[x+1]:h |= 1 << (y*8+x)
    if not h:
        # Flat image: the centre RGBA as 16-bit thermometer codes, R G in the high word, B A in the low.
        r, g, b, a = ((1 << math.floor(min(max(c, 0.0), 1.0)*16+0.5))-1 for c in sample(0.5, 0.5))
        h = (r << 16 | g) << 32 | b << 16 | a
    return h


def distance(a, b):
    """The Hamming distance of two dHashes; a zero hash is 64 from every other."""
    if (a == 0) != (b == 0):return 64
    return (a ^ b).bit_count()


def f32(x):return struct.unpack('f', struct.pack('f', x))[0]


def max_distance(confidence=0.75):
    """The greatest distance a filter of this `match_confidence` accepts, in float32 as XXMI computes it."""
    c = f32(min(max(0.0, confidence), 1.0))
    return int(f32(1.0-c)*64)
