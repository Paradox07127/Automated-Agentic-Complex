"""Pool containers: a character pool file (source/Files/<raw sha256>.bytes) stored LZFSE-compressed.

Layout (little endian): magic 'EFPOOL01', codec u32 (1 LZFSE), raw byte count u64, raw SHA-256 (32 bytes), then one LZFSE
stream that decodes to exactly the raw bytes. References keep the raw identity; a stored file whose size equals the
referenced byte_count holds the raw bytes, any other must be a container whose header carries the referenced identity.
encode and decode need macOS's libcompression; raw_identity reads the header only and runs everywhere.
"""
import ctypes
import functools
import hashlib
import struct

HEADER = struct.Struct('<8sIQ32s')
MAGIC = b'EFPOOL01'
LZFSE = 1
COMPRESSION_LZFSE = 0x801


@functools.cache
def _lib():
    lib = ctypes.CDLL('/usr/lib/libcompression.dylib')
    for function in (lib.compression_encode_buffer, lib.compression_decode_buffer):
        function.restype = ctypes.c_size_t
        function.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_int]
    return lib


def _code(function, data, capacity):
    target = ctypes.create_string_buffer(capacity)
    size = function(target, capacity, bytes(data), len(data), None, COMPRESSION_LZFSE)
    return ctypes.string_at(target, size)


def raw_identity(path, stored_byte_count):
    """(raw sha256 hex, raw byte count) of the container at path, whose recorded size is stored_byte_count."""
    with open(path, 'rb') as file:
        head = file.read(HEADER.size)
    if len(head) < HEADER.size or stored_byte_count <= HEADER.size:
        raise ValueError('invalid_pool_container')
    magic, codec, raw_bytes, raw_sha256 = HEADER.unpack(head)
    if magic != MAGIC or codec != LZFSE or raw_bytes <= stored_byte_count:
        raise ValueError('invalid_pool_container')
    return raw_sha256.hex(), raw_bytes


def encode(raw):
    """The container of raw, or None when it would not be strictly smaller than raw."""
    capacity = len(raw) - HEADER.size - 1
    if capacity <= 0:
        return None
    stream = _code(_lib().compression_encode_buffer, raw, capacity)
    if not stream:
        return None
    return HEADER.pack(MAGIC, LZFSE, len(raw), hashlib.sha256(raw).digest()) + stream


def decode(stored):
    """The raw bytes of the container stored, checked against its header."""
    if len(stored) <= HEADER.size:
        raise ValueError('invalid_pool_container')
    magic, codec, raw_bytes, raw_sha256 = HEADER.unpack_from(stored)
    if magic != MAGIC or codec != LZFSE:
        raise ValueError('invalid_pool_container')
    raw = _code(_lib().compression_decode_buffer, stored[HEADER.size:], raw_bytes + 1)
    if len(raw) != raw_bytes or hashlib.sha256(raw).digest() != raw_sha256:
        raise ValueError('pool_container_mismatch')
    return raw
