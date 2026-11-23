"""Synthetic fixtures only: no byte of a user mod or of game data."""
from pathlib import Path
import random
import sys
import time
import unittest

CHARACTERS = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(CHARACTERS)]
from agentic_complex_build import texture_mips
from agentic_complex_build.texture_dhash import dhash, distance, max_distance

ALL = (1 << 64)-1


def texture(fmt, width, height, f):
    """One level of `fmt` whose pixel (x, y) is f(x, y), channel values 0..255; a block past the edge repeats the last pixel."""
    bw, _, _, encode, _, _ = texture_mips.CODECS[fmt]
    out = bytearray()
    for j in range(0, height, bw):
        for i in range(0, width, bw):
            out += encode([f(min(i+p % bw, width-1), min(j+p//bw, height-1)) for p in range(bw*bw)])
    return bytes(out)


def columns(width, height, f):
    """An RGBA8 level whose pixel (x, y) is f(x)."""
    return b''.join(bytes(f(x)) for x in range(width))*height


def ramp(width, height, falling):
    """An RGBA8 level whose red rises or falls left to right."""
    def f(x):
        r = round(255*x/(width-1)) if width > 1 else 0
        return (255-r if falling else r, 0, 255, 255)
    return (width, height, columns(width, height, f))


def exact_hash(values):
    """The dHash of a 9x8 grid of sample values (rows of 9) that is not all zero bits."""
    return sum(1 << (y*8+x) for y in range(8) for x in range(8) if values[y][x] > values[y][x+1])


class DhashTest(unittest.TestCase):
    def test_falling_gradient_sets_every_bit(self):
        self.assertEqual(dhash('R8G8B8A8_UNORM', [(64, 64, columns(64, 64, lambda x: (255-4*x, 0, 255, 255)))]), ALL)

    def test_rising_gradient_gives_the_centre_thermometer_codes(self):
        # Centre u = 0.5 on 64 texels: texels 31 and 32, red (124+128)/2 = 126 -> floor(126/255*16+0.5) = 8 -> 0x00FF;
        # green 0 -> 0, blue and alpha 1 -> 16 -> 0xFFFF. High word R G, low word B A.
        h = dhash('R8G8B8A8_UNORM', [(64, 64, columns(64, 64, lambda x: (4*x, 0, 255, 255)))])
        self.assertEqual(h, 0x00FF0000_FFFFFFFF)

    def test_samples_hit_texel_centres_of_a_9x8_level(self):
        rng = random.Random(7)
        px = [[tuple(rng.randrange(256) for _ in range(4)) for _ in range(9)] for _ in range(8)]
        data = b''.join(bytes(p) for row in px for p in row)
        self.assertEqual(dhash('R8G8B8A8_UNORM', [(9, 8, data)]), exact_hash([[sum(p) for p in row] for row in px]))

    def test_samples_of_an_18x16_level_average_four_texels(self):
        rng = random.Random(11)
        px = [[tuple(rng.randrange(256) for _ in range(4)) for _ in range(18)] for _ in range(16)]
        data = b''.join(bytes(p) for row in px for p in row)
        means = [[sum(map(sum, (px[2*y][2*x], px[2*y][2*x+1], px[2*y+1][2*x], px[2*y+1][2*x+1]))) for x in range(9)] for y in range(8)]
        self.assertEqual(dhash('R8G8B8A8_UNORM', [(18, 16, data)]), exact_hash(means))

    def test_addressing_clamps_at_the_edges(self):
        # Two columns, bright then dark: samples 0, 1 clamp to the bright texel, 7, 8 to the dark one, 2..6 fall between.
        data = columns(2, 8, lambda x: (255, 255, 255, 255) if x == 0 else (0, 0, 0, 255))
        self.assertEqual(dhash('R8G8B8A8_UNORM', [(2, 8, data)]), 0x7E7E7E7E_7E7E7E7E)

    def test_512_chain_hashes_its_256_level(self):
        levels = [ramp(512 >> k, 512 >> k, k == 1) for k in range(10)]
        self.assertEqual(dhash('R8G8B8A8_UNORM', levels), ALL)

    def test_level_choice_uses_the_shorter_side(self):
        levels = [ramp(1024 >> k, 512 >> k, k == 1) for k in range(4)]
        self.assertEqual(dhash('R8G8B8A8_UNORM', levels), ALL)

    def test_200_px_texture_hashes_level_0(self):
        levels = [ramp(200 >> k, 200 >> k, k == 0) for k in range(8)]
        self.assertEqual(dhash('R8G8B8A8_UNORM', levels), ALL)

    def test_srgb_compares_linear_values(self):
        # Pure red is the lower of the two as bytes (510 < 511) but the higher in linear light (2 > 1.43).
        def f(x):return (255, 0, 0, 255) if x % 2 == 0 else (128, 128, 0, 255)
        data = columns(9, 8, f)
        self.assertEqual(dhash('R8G8B8A8_UNORM', [(9, 8, data)]), 0xAAAAAAAA_AAAAAAAA)
        self.assertEqual(dhash('R8G8B8A8_SRGB', [(9, 8, data)]), 0x55555555_55555555)
        bc7 = texture('BC7_SRGB_BLOCK', 9, 8, lambda x, y: f(x))
        self.assertEqual(dhash('BC7_SRGB_BLOCK', [(9, 8, bc7)]), 0x55555555_55555555)

    def test_bc5_samples_red_green_zero_one(self):
        # (128, 128) is below (200, 64) as (R, G, 0, 1) but above it as a unit normal (1.01 against 0.73).
        def f(x, y):return (128, 128, 0, 255) if x % 2 == 0 else (200, 64, 0, 255)
        self.assertEqual(dhash('BC5_UNORM_BLOCK', [(9, 8, texture('BC5_UNORM_BLOCK', 9, 8, f))]), 0xAAAAAAAA_AAAAAAAA)
        # Flat (255, 128): R 16 -> 0xFFFF, G floor(128/255*16+0.5) = 8 -> 0x00FF, B 0 -> 0, A 16 -> 0xFFFF.
        flat = texture('BC5_UNORM_BLOCK', 8, 8, lambda x, y: (255, 128, 0, 255))
        self.assertEqual(dhash('BC5_UNORM_BLOCK', [(8, 8, flat)]), 0xFFFF00FF_0000FFFF)

    def test_bc7_hashes_as_its_decoded_pixels(self):
        def f(x, y):return ((x*37+y*11) % 256, (x*13) % 256, (y*29) % 256, 255)
        for bc7_fmt, rgba_fmt in (('BC7_UNORM_BLOCK', 'R8G8B8A8_UNORM'), ('BC7_SRGB_BLOCK', 'R8G8B8A8_SRGB')):
            bc7 = texture(bc7_fmt, 36, 32, f)
            px = {}
            for j in range(8):
                for i in range(9):
                    values = texture_mips.bc7_decode(bc7[(j*9+i)*16:(j*9+i)*16+16])
                    for p in range(16):px[4*i+p % 4, 4*j+p//4] = values[4*p:4*p+4]
            rgba = b''.join(bytes(px[x, y]) for y in range(32) for x in range(36))
            h = dhash(rgba_fmt, [(36, 32, rgba)])
            self.assertNotIn(h, (0, ALL))
            self.assertEqual(dhash(bc7_fmt, [(36, 32, bc7)]), h)

    def test_unsupported_format(self):
        with self.assertRaisesRegex(ValueError, 'unsupported_texture_format'):dhash('BC1_UNORM_BLOCK', [(4, 4, bytes(8))])

    def test_2048_bc7_chain_hashes_under_a_second(self):
        block = texture_mips.bc7_encode([(16*p, 255-16*p, 128, 255) for p in range(16)])
        chain = [(max(1, 2048 >> k), max(1, 2048 >> k), block*(max(1, (2048 >> k)//4)**2)) for k in range(12)]
        for levels in (chain, chain[:1]):
            start = time.perf_counter()
            dhash('BC7_UNORM_BLOCK', levels)
            self.assertLess(time.perf_counter()-start, 1.0)


class DistanceTest(unittest.TestCase):
    def test_distance(self):
        self.assertEqual(distance(0, 0), 0)
        self.assertEqual(distance(0, 1), 64)
        self.assertEqual(distance(ALL, 0), 64)
        self.assertEqual(distance(0xFF, 0x0F), 4)
        self.assertEqual(distance(ALL, 1), 63)
        self.assertEqual(distance(0x1363895A_02495A04, 0x1363895A_02495A04), 0)

    def test_max_distance(self):
        self.assertEqual(max_distance(), 16)
        self.assertEqual([max_distance(c) for c in (0.75, 0.9, 1.0, 1.5, -1)], [16, 6, 0, 0, 64])


if __name__ == '__main__':
    unittest.main()
