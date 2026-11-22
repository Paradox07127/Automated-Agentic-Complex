"""Native integration uses a disposable keychain or the current Windows user's DPAPI."""
import ctypes
from pathlib import Path
import os
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class NativeSecretsTest(unittest.TestCase):
    def round_trip(self, store):
        self.assertIsNone(store.get("fixture"))
        store.put("fixture", b"dummy\0credential")
        self.addCleanup(store.delete, "fixture")
        self.assertEqual(store.get("fixture"), b"dummy\0credential")
        store.put("fixture", b"replacement")
        self.assertEqual(store.get("fixture"), b"replacement")
        store.delete("fixture")
        self.assertIsNone(store.get("fixture"))

    @unittest.skipUnless(sys.platform == "darwin", "requires Security.framework")
    def test_keychain(self):
        from infra.secrets import Keychain
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        store = Keychain("Agentic Complex test " + uuid.uuid4().hex)
        sec = store.security
        sec.SecKeychainCreate.argtypes = [ctypes.c_char_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_ubyte,
                                          ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
        sec.SecKeychainDelete.argtypes = [ctypes.c_void_p]
        password = uuid.uuid4().hex.encode()
        keychain = ctypes.c_void_p()
        status = sec.SecKeychainCreate(os.fsencode(Path(tmp.name) / "fixture.keychain"), len(password), password,
                                       False, None, ctypes.byref(keychain))
        self.assertEqual(status, 0, f"SecKeychainCreate OSStatus {status}")
        self.addCleanup(store.cf.CFRelease, keychain)
        self.addCleanup(sec.SecKeychainDelete, keychain)
        store.keychain = keychain
        self.round_trip(store)

    @unittest.skipUnless(sys.platform == "win32", "requires current-user DPAPI")
    def test_dpapi(self):
        from infra.secrets import DPAPI
        with tempfile.TemporaryDirectory() as tmp:
            store = DPAPI(Path(tmp))
            store.put("disk", b"dummy-private-dpapi")
            self.assertEqual(DPAPI(Path(tmp)).get("disk"), b"dummy-private-dpapi")
            files = [p for p in Path(tmp).rglob("*") if p.is_file()]
            self.assertTrue(files)
            for p in files:
                self.assertNotIn(b"dummy-private-dpapi", p.read_bytes())
            self.round_trip(store)
