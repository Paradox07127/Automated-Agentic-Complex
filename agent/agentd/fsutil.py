"""Whole-file replacement: a reader sees the old file or the complete new one, never a partial write."""
import json
import os
from pathlib import Path
import tempfile

from infra.platform import set_private_mode


def atomic_write_text(path, text, mode=None):
    """Writes text (UTF-8) to a new file beside path and renames it over path; the file is 0600 unless mode is given.

    The temporary file is created O_EXCL|O_NOFOLLOW, so a symlink at path is replaced, never written through."""
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        # newline="": the bytes on disk are the text as given, on Windows too.
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            if mode is not None:
                set_private_mode(stream.fileno(), mode)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def atomic_write_json(path, obj, mode=None, newline=False, **dump_kwargs):
    """atomic_write_text of json.dumps(obj, **dump_kwargs), plus "\\n" when newline."""
    atomic_write_text(path, json.dumps(obj, **dump_kwargs) + ("\n" if newline else ""), mode)


def read_json(path, **load_kwargs):
    return json.loads(Path(path).read_bytes(), **load_kwargs)
