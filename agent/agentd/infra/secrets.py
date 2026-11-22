"""The operating system holds agentd's provider and service credentials."""
import base64
from contextlib import contextmanager, ExitStack
import ctypes as C
import hashlib
from pathlib import Path
import sys
import uuid

from infra.platform import make_private_dir
from infra.tokens import read_token, write_secret


class ModelError(RuntimeError):
    """Only stable, non-secret error codes cross the UI boundary."""


class MemorySecrets:
    def __init__(self):
        self._values = {}

    def put(self, name, value):
        self._values[name] = value

    def get(self, name):
        return self._values.get(name)

    def delete(self, name):
        self._values.pop(name, None)


@contextmanager
def setting_secret(store, previous, prefix, value):
    """Commit an endpoint and its credential reference together. None keeps the key, empty bytes clear it."""
    if value is None:
        yield previous
        return
    original = store.get(previous) if previous else None
    ref = prefix + uuid.uuid4().hex if value else None
    if ref:
        store.put(ref, value)
    try:
        if previous:
            store.delete(previous)
        try:
            yield ref
        except OSError:
            if original is not None:
                store.put(previous, original)
            raise
    except (ModelError, OSError):
        if ref:
            store.delete(ref)
        raise


def _declare(function, result, *args):
    function.restype, function.argtypes = result, args


class Keychain:
    def __init__(self, service="Agentic Complex"):
        self.service = service
        self.keychain = None
        cf = self.cf = C.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        sec = self.security = C.CDLL("/System/Library/Frameworks/Security.framework/Security")
        ptr, index = C.c_void_p, C.c_long
        _declare(cf.CFStringCreateWithCString, ptr, ptr, C.c_char_p, C.c_uint32)
        _declare(cf.CFDataCreate, ptr, ptr, C.c_char_p, index)
        _declare(cf.CFDictionaryCreate, ptr, ptr, C.POINTER(ptr), C.POINTER(ptr), index, ptr, ptr)
        self.key_callbacks = C.c_char.in_dll(cf, "kCFTypeDictionaryKeyCallBacks")
        self.value_callbacks = C.c_char.in_dll(cf, "kCFTypeDictionaryValueCallBacks")
        _declare(cf.CFArrayCreate, ptr, ptr, C.POINTER(ptr), index, ptr)
        _declare(cf.CFDataGetLength, index, ptr)
        _declare(cf.CFDataGetBytePtr, ptr, ptr)
        _declare(cf.CFRelease, None, ptr)
        _declare(sec.SecKeychainCopyDefault, C.c_int32, C.POINTER(ptr))
        _declare(sec.SecItemAdd, C.c_int32, ptr, ptr)
        _declare(sec.SecItemUpdate, C.c_int32, ptr, ptr)
        _declare(sec.SecItemCopyMatching, C.c_int32, ptr, C.POINTER(ptr))
        _declare(sec.SecItemDelete, C.c_int32, ptr)
        self.keys = {key: ptr.in_dll(sec, key).value for key in (
            "kSecClass", "kSecClassGenericPassword", "kSecAttrService", "kSecAttrAccount", "kSecValueData",
            "kSecReturnData", "kSecUseKeychain", "kSecMatchSearchList")}
        self.true = ptr.in_dll(cf, "kCFBooleanTrue").value
        # The daemon reports a locked keychain or an untrusted caller to settings without opening a dialog.
        _declare(sec.SecKeychainSetUserInteractionAllowed, C.c_int32, C.c_ubyte)
        self._check(sec.SecKeychainSetUserInteractionAllowed(False))

    @staticmethod
    def _check(status):
        if status:
            raise ModelError("secret_store_unavailable") from OSError(status, "Keychain")

    def _item(self, name, operation, value=None):
        cf, sec, keys = self.cf, self.security, self.keys
        with ExitStack() as stack:
            def owned(ref):
                stack.callback(cf.CFRelease, ref)
                return ref

            def dictionary(fields):
                pointers = C.c_void_p * len(fields)
                return owned(cf.CFDictionaryCreate(None, pointers(*(keys[k] for k in fields)),
                                                   pointers(*fields.values()), len(fields),
                                                   C.byref(self.key_callbacks), C.byref(self.value_callbacks)))

            keychain = self.keychain
            if keychain is None:
                keychain = C.c_void_p()
                self._check(sec.SecKeychainCopyDefault(C.byref(keychain)))
                owned(keychain)
            item = {"kSecClass": keys["kSecClassGenericPassword"]}
            for attr, text in (("kSecAttrService", self.service), ("kSecAttrAccount", name)):
                item[attr] = owned(cf.CFStringCreateWithCString(None, text.encode(), 0x08000100))
            search = owned(cf.CFArrayCreate(None, C.byref(keychain), 1, None))
            query = {**item, "kSecMatchSearchList": search}
            if operation == "get":
                query["kSecReturnData"] = self.true
                data = C.c_void_p()
                status = sec.SecItemCopyMatching(dictionary(query), C.byref(data))
                if status == -25300:  # errSecItemNotFound
                    return None
                self._check(status)
                owned(data)
                return C.string_at(cf.CFDataGetBytePtr(data), cf.CFDataGetLength(data))
            if operation == "delete":
                status = sec.SecItemDelete(dictionary(query))
                if status != -25300:
                    self._check(status)
                return
            data = owned(cf.CFDataCreate(None, value, len(value)))
            attrs = {"kSecValueData": data}
            status = sec.SecItemAdd(dictionary({**item, **attrs, "kSecUseKeychain": keychain}), None)
            if status == -25299:  # errSecDuplicateItem
                status = sec.SecItemUpdate(dictionary(query), dictionary(attrs))
            self._check(status)

    def put(self, name, value):
        self._item(name, "put", value)

    def get(self, name):
        return self._item(name, "get")

    def delete(self, name):
        self._item(name, "delete")


class _Blob(C.Structure):
    _fields_ = [("size", C.c_uint32), ("data", C.c_void_p)]


class DPAPI:
    def __init__(self, directory):
        self.directory = Path(directory) / "credentials"
        crypt = C.WinDLL("crypt32", use_last_error=True)
        self.protect, self.unprotect = crypt.CryptProtectData, crypt.CryptUnprotectData
        for function in (self.protect, self.unprotect):
            _declare(function, C.c_int, C.POINTER(_Blob), C.c_void_p, C.c_void_p, C.c_void_p, C.c_void_p,
                     C.c_uint32, C.POINTER(_Blob))
        self.free = C.WinDLL("kernel32").LocalFree
        _declare(self.free, C.c_void_p, C.c_void_p)

    def _crypt(self, function, value):
        buffer = C.create_string_buffer(value)
        source = _Blob(len(value), C.cast(buffer, C.c_void_p))
        result = _Blob()
        # CRYPTPROTECT_UI_FORBIDDEN, current user (no CRYPTPROTECT_LOCAL_MACHINE).
        if not function(C.byref(source), None, None, None, None, 1, C.byref(result)):
            raise ModelError("secret_store_unavailable") from C.WinError(C.get_last_error())
        try:
            return C.string_at(result.data, result.size)
        finally:
            self.free(result.data)

    def _path(self, name):
        return self.directory / hashlib.sha256(name.encode()).hexdigest()

    def put(self, name, value):
        protected = self._crypt(self.protect, value)
        try:
            make_private_dir(self.directory)
            write_secret(self._path(name), base64.b64encode(protected).decode("ascii"))
        except (OSError, SystemExit) as error:
            raise ModelError("secret_store_unavailable") from error

    def get(self, name):
        try:
            protected = base64.b64decode(read_token(self._path(name)), validate=True)
        except FileNotFoundError:
            return None
        except (OSError, ValueError, SystemExit) as error:
            raise ModelError("secret_store_unavailable") from error
        return self._crypt(self.unprotect, protected)

    def delete(self, name):
        try:
            self._path(name).unlink(missing_ok=True)
        except OSError as error:
            raise ModelError("secret_store_unavailable") from error


def system_store(directory):
    if sys.platform == "darwin":
        return Keychain()
    if sys.platform == "win32":
        return DPAPI(directory)
    raise ModelError("secret_store_unavailable")
