"""Hashing, identity JSON, file references and checks shared by the build tools."""
import hashlib
import json
from pathlib import Path


def need(value, reason):
    if not value:
        raise ValueError(reason)


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        while b := f.read(4*1024*1024):
            h.update(b)
    return h.hexdigest()


def canonical_json(value):
    """Key-sorted JSON bytes that identity hashes are taken over; json.dumps defaults otherwise, no newline."""
    return json.dumps(value, sort_keys=True).encode()


def reference(path, root):
    path, root = Path(path), Path(root)
    return dict(file=path.relative_to(root).as_posix(), sha256=sha256_file(path), byte_count=path.stat().st_size)
