"""Content-identified CoW materialization; writable views never use hard links, an install on Windows links content it already holds.

APFS clonefile shares data extents while preserving write isolation. Other file
systems fall back to a normal copy. This is storage deduplication, not a claim
about allocated APFS blocks or GPU residency. Package manifests remain unchanged.
"""
import ctypes
import errno
import functools
import hashlib
import os
from pathlib import Path
import shutil
import stat
import sys


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while chunk := stream.read(4 * 1024 * 1024): h.update(chunk)
    return h.hexdigest()


@functools.cache
def _clonefile():
    clone = ctypes.CDLL(None, use_errno=True).clonefile
    clone.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
    clone.restype = ctypes.c_int
    return clone


def clone_or_copy(source, destination):
    """Destination must be new. No linking back into a mutable source tree."""
    source, destination = Path(source), Path(destination)
    if destination.exists() or destination.is_symlink(): raise ValueError('resource_destination_exists')
    if not source.is_file() or source.is_symlink(): raise ValueError('resource_source_not_regular')
    if sys.platform == 'darwin':
        if _clonefile()(os.fsencode(source), os.fsencode(destination), 0) == 0:
            # Build views can rewrite descriptors even when an archived input is
            # read-only. Changing the clone's mode never changes its source.
            destination.chmod(stat.S_IMODE(destination.stat().st_mode) | stat.S_IWUSR)
            return 'cloned'
        error = ctypes.get_errno()
        if error not in {errno.EXDEV, errno.ENOTSUP, errno.EOPNOTSUPP, errno.ENOSYS}:
            raise OSError(error, os.strerror(error), str(destination))
    shutil.copyfile(source, destination)
    return 'copied'


def link_or_copy(source, destination):
    """Only for an immutable destination (an installed package): on Windows a hard link sharing the source's storage, else clone_or_copy."""
    source, destination = Path(source), Path(destination)
    if destination.exists() or destination.is_symlink(): raise ValueError('resource_destination_exists')
    if not source.is_file() or source.is_symlink(): raise ValueError('resource_source_not_regular')
    if sys.platform != 'win32': return clone_or_copy(source, destination)
    try:
        os.link(source, destination)
        return 'linked'
    except OSError:
        # Another volume, or a file system without hard links (FAT32, exFAT, ReFS).
        shutil.copyfile(source, destination)
        return 'copied'


class ResourceRepository:
    """One content index per materialization transaction, with ordinary file views.

    The index is derived from validated manifests, not a second source of truth.
    Every reused canonical file is SHA checked. CoW views may be edited safely;
    changing an indexed canonical file invalidates that content identity.
    """
    def __init__(self):
        self.content = {}
        self.verified = {}
        self.stats = dict(cloned=0, copied=0, linked=0, content_reuses=0, logical_bytes=0, full_copy_bytes=0)

    def register(self, path, ref):
        key = (ref['sha256'], ref['byte_count'])
        previous = self.content.get(key)
        if previous is None or not previous.is_file(): self.content[key] = Path(path)

    def _verify(self, path, key):
        if not path.is_file() or path.is_symlink(): raise ValueError('resource_source_not_regular')
        st = path.stat()
        stamp = (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        if st.st_size != key[1]: raise ValueError('resource_size_mismatch')
        if self.verified.get((path, key)) != stamp:
            if digest(path) != key[0]: raise ValueError('resource_sha_mismatch')
            self.verified[path, key] = stamp

    def materialize(self, source, destination, ref, *, source_verified=False):
        source, destination = Path(source), Path(destination)
        key = (ref['sha256'], ref['byte_count'])
        if not source_verified: self._verify(source, key)
        canonical = self.content.get(key)
        if canonical is not None and canonical.is_file():
            self._verify(canonical, key)
            selected = canonical
            self.stats['content_reuses'] += 1
        else: selected = source
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Only an installed canonical file is linked: a link to the import source would let later edits there change the package.
        method = (link_or_copy if selected is canonical else clone_or_copy)(selected, destination)
        self.stats[method] += 1
        self.stats['logical_bytes'] += key[1]
        if method == 'copied': self.stats['full_copy_bytes'] += key[1]
        self.register(destination, ref)
        return method

    def relocate(self, old, new):
        old, new = Path(old), Path(new)
        for key, path in list(self.content.items()):
            if path.is_relative_to(old): self.content[key] = new / path.relative_to(old)
        # Signatures name old paths; no stale proof survives a namespace change.
        self.verified.clear()
