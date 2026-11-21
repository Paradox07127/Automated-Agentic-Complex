import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import compress_library

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent/agentd/tests'))
from test_character_library import fixture as character_fixture, text_fixture
from character_library import Library
import pool_codec


class CompressLibraryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_the_output_library_holds_each_package_with_its_pool_compressed(self):
        compressible, incompressible = b''.join(b'texel %d ' % (i % 89) for i in range(5000)), os.urandom(4096)
        library = Library(self.root / 'library')
        character_fixture(self.root / 'role', pool=[compressible, incompressible]); library.install(self.root / 'role')
        text_fixture(self.root / 'aide'); library.install(self.root / 'aide')
        before = library.snapshot()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            compress_library.main([str(library.root / 'current.json'), str(self.root / 'out')])
        report = {row['id']: row for row in json.loads(out.getvalue())['characters']}
        self.assertEqual(report['fixture']['files_compressed'], 1)
        self.assertLess(report['fixture']['bytes_after'], report['fixture']['bytes_before'])
        self.assertEqual(report['aide']['files_compressed'], 0)
        result = Library(self.root / 'out')
        packages = {package.id: package for package in result.packages()}
        self.assertEqual(result.snapshot().get('default_character'), before.get('default_character'))
        pool = packages['fixture'].root / 'runtime/Files'
        stored = (pool / (hashlib.sha256(compressible).hexdigest() + '.bytes')).read_bytes()
        self.assertEqual(pool_codec.decode(stored), compressible)
        self.assertEqual((pool / (hashlib.sha256(incompressible).hexdigest() + '.bytes')).read_bytes(), incompressible)
        # The source library is left as it was.
        self.assertEqual(library.snapshot(), before)
        with self.assertRaisesRegex(ValueError, 'output_already_exists'):
            compress_library.compress_library(library.root / 'current.json', self.root / 'out')


if __name__ == '__main__':
    unittest.main()
