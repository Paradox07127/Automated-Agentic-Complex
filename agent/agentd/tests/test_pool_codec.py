"""Pool containers: the LZFSE form of a character pool file and the raw identity its header carries."""
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pool_codec

RAW = b''.join(b'texel %d ' % (i % 97) for i in range(20000))


class PoolCodecTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def write(self, data):
        path = self.root / 'pool.bytes'; path.write_bytes(data); return path

    def test_a_container_decodes_to_its_raw_bytes_and_names_their_identity(self):
        stored = pool_codec.encode(RAW)
        self.assertLess(len(stored), len(RAW))
        self.assertEqual(stored[:8], pool_codec.MAGIC)
        self.assertEqual(pool_codec.decode(stored), RAW)
        self.assertEqual(pool_codec.raw_identity(self.write(stored), len(stored)),
                         (hashlib.sha256(RAW).hexdigest(), len(RAW)))

    def test_incompressible_bytes_have_no_container(self):
        self.assertIsNone(pool_codec.encode(os.urandom(4096)))
        self.assertIsNone(pool_codec.encode(b'x' * pool_codec.HEADER.size))
        self.assertIsNone(pool_codec.encode(b''))

    def test_raw_identity_refuses_what_is_not_a_container_header(self):
        stored = pool_codec.encode(RAW)
        for data in (b'BADMAGIC' + stored[8:], stored[:8] + (2).to_bytes(4, 'little') + stored[12:], stored[:pool_codec.HEADER.size - 1]):
            with self.subTest(data=data[:12]), self.assertRaisesRegex(ValueError, 'invalid_pool_container'):
                pool_codec.raw_identity(self.write(data), len(data))
        # A header naming no more raw bytes than are stored does not describe a container.
        small = pool_codec.HEADER.pack(pool_codec.MAGIC, pool_codec.LZFSE, 60, bytes(32)) + bytes(20)
        with self.assertRaisesRegex(ValueError, 'invalid_pool_container'):
            pool_codec.raw_identity(self.write(small), len(small))

    def test_decode_refuses_a_truncated_stream_or_a_header_of_other_bytes(self):
        stored = pool_codec.encode(RAW)
        with self.assertRaises(ValueError):
            pool_codec.decode(stored[:len(stored) // 2])
        other = stored[:20] + hashlib.sha256(b'other').digest() + stored[pool_codec.HEADER.size:]
        with self.assertRaisesRegex(ValueError, 'pool_container_mismatch'):
            pool_codec.decode(other)
        with self.assertRaisesRegex(ValueError, 'invalid_pool_container'):
            pool_codec.decode(b'BADMAGIC' + stored[8:])


if __name__ == '__main__':
    unittest.main()
