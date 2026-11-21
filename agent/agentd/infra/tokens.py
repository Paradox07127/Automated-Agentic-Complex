"""Owned state directories and no-follow, regular 0600 secret files."""
import os
import stat

from fsutil import atomic_write_text
from infra.platform import make_private_dir, open_private_file, owned_by_current_user, private_mode


def ensure_state_dir(path):
    try:
        make_private_dir(path)
    except PermissionError:
        raise SystemExit(f"{path} must be owned by the current user") from None


def secret_fd(path, flags):
    # Do not truncate until the opened inode has passed the checks.
    fd = open_private_file(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise SystemExit(f"{path} must be a regular file with one link")
        if not owned_by_current_user(info):
            raise SystemExit(f"{path} must be owned by the current user")
        return fd
    except BaseException:
        os.close(fd)
        raise


def write_secret(path, text):
    # An existing file must pass secret_fd's checks; it is then replaced whole, so no reader sees it empty.
    try:
        os.close(secret_fd(path, os.O_WRONLY))
    except FileNotFoundError:
        pass
    atomic_write_text(path, text, 0o600)


def read_token(path):
    fd = secret_fd(path, os.O_RDONLY)
    with os.fdopen(fd, "r", encoding="utf-8") as stream:
        if not private_mode(os.fstat(stream.fileno())):
            raise SystemExit(f"{path} must be mode 0600")
        return stream.read().strip()
