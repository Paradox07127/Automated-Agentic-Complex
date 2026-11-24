"""infra.platform on macOS and Linux."""
import asyncio
import errno
import fcntl
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import stat
import tempfile
import threading


def lock_file(file, blocking=True):
    fcntl.flock(file, fcntl.LOCK_EX if blocking else fcntl.LOCK_EX | fcntl.LOCK_NB)


def unlock_file(file):
    fcntl.flock(file, fcntl.LOCK_UN)


def make_private_dir(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if os.fstat(fd).st_uid != os.getuid():
            raise PermissionError(errno.EPERM, "not owned by the current user", str(path))
        os.fchmod(fd, 0o700)
    finally:
        os.close(fd)


def make_private_tree(path):
    os.chmod(path, 0o700, follow_symlinks=False)
    for root, directories, files in os.walk(path, followlinks=False):
        for name in directories + files:
            child = Path(root) / name
            mode = child.lstat().st_mode
            if stat.S_ISDIR(mode):
                os.chmod(child, 0o700, follow_symlinks=False)
            elif stat.S_ISREG(mode):
                os.chmod(child, 0o600, follow_symlinks=False)


def open_private_file(path, flags):
    # NONBLOCK keeps a FIFO from hanging the open.
    return os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600)


def owned_by_current_user(info):
    return info.st_uid == os.getuid()


def private_mode(info):
    return not info.st_mode & 0o077


def set_private_mode(fd, mode):
    os.fchmod(fd, mode)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def new_group_options():
    return {"start_new_session": True}


def track_group(proc):
    pass


def signal_group(proc, force=False):
    os.killpg(proc.pid, signal.SIGKILL if force else signal.SIGTERM)


def release_group(proc):
    pass


def stop_own_group():
    if os.getpgrp() == os.getpid():
        os.killpg(os.getpgrp(), signal.SIGTERM)


def on_stop_signals(loop, callback, *args):
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, callback, *args)


class _UnixServer:
    def __init__(self, server, directory):
        self.server, self.directory = server, directory

    def close(self):
        self.server.close()
        shutil.rmtree(self.directory, ignore_errors=True)


async def serve_ipc(handle_connection, prefix, limit=2 ** 16):
    # A short base keeps the path under the unix socket limit; gettempdir() follows TMPDIR, which for a runner is deep
    # inside its state directory. mkdtemp makes the directory 0700.
    directory = tempfile.mkdtemp(prefix=prefix, dir="/tmp")
    path = os.path.join(directory, "mcp.sock")
    try:
        server = await asyncio.start_unix_server(handle_connection, path, limit=limit)
    except BaseException:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    return _UnixServer(server, directory), path


class _SocketConnection:
    def __init__(self, sock):
        self.sock, self.reader = sock, sock.makefile("rb")

    def write(self, data):
        self.sock.sendall(data)

    def readline(self, limit):
        return self.reader.readline(limit)

    def close(self):
        self.reader.close()
        self.sock.close()


def connect_ipc(address):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(address)
    return _SocketConnection(sock)


def child_environment(tmp):
    return {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": str(tmp)}


def store_app_folders(prefix):
    return []


def watch_parent(pid, stop):
    kq = select.kqueue()
    event = select.kevent(pid, filter=select.KQ_FILTER_PROC,
                          flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT)
    try:
        kq.control([event], 0, 0)
    except ProcessLookupError:
        os._exit(0)
    # The parent may have exited between the caller's getppid check and registration.
    if os.getppid() != pid:
        os._exit(0)
    threading.Thread(target=lambda: (kq.control(None, 1, None), os._exit(0)), daemon=True).start()
