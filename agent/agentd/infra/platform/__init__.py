"""Operating-system specific operations; posix.py and windows.py each implement every name below.

lock_file(file, blocking=True)     exclusive lock on an open file (descriptor or object with fileno()); without blocking,
                                   BlockingIOError when another open file holds it. Closing the file releases it.
unlock_file(file)
make_private_dir(path)             creates path (and parents) readable by the current user only; refuses a symlink or
                                   reparse point; PermissionError when it is not the current user's.
make_private_tree(path)            makes path and every directory and regular file under it private to the current user;
                                   symlinks are left alone.
open_private_file(path, flags)     os.open without following a symlink, mode 0600 when created; never inherited.
owned_by_current_user(info)        an os.fstat result belongs to the current user.
private_mode(info)                 an os.fstat result grants nobody else access.
set_private_mode(fd, mode)         applies POSIX mode bits to an open file.
sync_directory(path)               flushes a directory, so a rename inside it survives a crash.
new_group_options()                Popen / create_subprocess_exec keyword arguments for a child that heads its own tree.
track_group(proc)                  call right after starting such a child (proc has .pid).
signal_group(proc, force=False)    ends the child's tree: SIGTERM, or SIGKILL with force.
release_group(proc)                forgets a tracked tree once the child is done.
stop_own_group()                   from a runner that heads its own tree: ends that tree.
on_stop_signals(loop, callback, *args)  runs callback on the asyncio loop when the process is asked to stop.
await serve_ipc(handle_connection, prefix, limit=65536)
                                   listens where only the current user can connect: a unix socket in a new 0700
                                   directory under /tmp, or a named pipe whose DACL has one ACE, the current user.
                                   Returns (server, address); handle_connection(reader, writer) runs per connection as
                                   with asyncio.start_server, and server.close() stops listening and removes the
                                   endpoint. On Windows it needs the ProactorEventLoop.
connect_ipc(address)               a blocking connection to that address with write(data), readline(limit) and close();
                                   one thread may wait in readline while others write.
child_environment(tmp)             the platform part of a runner's allowlisted environment, its temporary dir set to tmp.
watch_parent(pid, stop)            for a process whose parent pid supervises it: os._exit(0) at once when pid has
                                   already exited. Later, from a daemon thread: on POSIX os._exit(0) once pid exits,
                                   without cleanup (the parent stops it with SIGTERM); on Windows, which has no
                                   SIGTERM, stop() once, when pid exits or stdin reaches EOF, the parent's stop request.
store_app_folders(prefix)          the install folders of the current user's Microsoft Store packages whose full name starts
                                   with prefix, from the registry; [] on POSIX.
THIS_MACHINE, USER_MACHINE         how prompts name the machine she runs on: 这台 Mac / the user's Mac on macOS,
                                   这台电脑 / the user's computer on Windows.
long_path(path)                    the str to open path's files by: on Windows windows_long_path(path), which opens
                                   past MAX_PATH without the system's long-path switch; elsewhere path unchanged.
plain_path(path)                   the str of path without that prefix, for what leaves agentd (another process's
                                   argument, a log line, a response).
command_line(cmd)                  what Popen starts for a stored command line: on Windows the line whole, which
                                   CreateProcess splits as Windows programs expect, backslashes included; elsewhere
                                   shlex.split(cmd), which raises ValueError when it cannot be split.
"""
import ntpath
import os
import shlex
import sys

THIS_MACHINE, USER_MACHINE = ("这台电脑", "the user's computer") if sys.platform == "win32" else ("这台 Mac", "the user's Mac")


def windows_long_path(path):
    r"""path absolute, normalized (no / or ..) and with the extended-length prefix \\?\ (\\?\UNC\ for a share);
    a path that already has a \\?\ or \\.\ prefix unchanged. String work only, so it runs on every platform."""
    text = os.fspath(path)
    if text.startswith(("\\\\?\\", "\\\\.\\")):
        return text
    text = ntpath.abspath(text)
    return "\\\\?\\UNC\\" + text[2:] if text.startswith("\\\\") else "\\\\?\\" + text


def windows_plain_path(path):
    r"""path without the \\?\ (or \\?\UNC\) prefix windows_long_path adds."""
    text = os.fspath(path)
    if text.startswith("\\\\?\\UNC\\"):
        return "\\\\" + text[8:]
    return text[4:] if text.startswith("\\\\?\\") else text


if sys.platform == "win32":
    long_path, plain_path = windows_long_path, windows_plain_path
    def command_line(cmd): return cmd
else:
    def long_path(path): return os.fspath(path)
    def plain_path(path): return os.fspath(path)
    def command_line(cmd): return shlex.split(cmd)

if sys.platform == "win32":
    from infra.platform.windows import (child_environment, connect_ipc, lock_file, make_private_dir,
                                        make_private_tree, new_group_options, on_stop_signals, open_private_file,
                                        owned_by_current_user, private_mode, release_group, serve_ipc,
                                        set_private_mode, signal_group, stop_own_group, store_app_folders, sync_directory,
                                        track_group, unlock_file, watch_parent)
else:
    from infra.platform.posix import (child_environment, connect_ipc, lock_file, make_private_dir, make_private_tree,
                                      new_group_options, on_stop_signals, open_private_file, owned_by_current_user,
                                      private_mode, release_group, serve_ipc, set_private_mode, signal_group,
                                      stop_own_group, store_app_folders, sync_directory, track_group, unlock_file,
                                      watch_parent)

__all__ = ["child_environment", "command_line", "connect_ipc", "lock_file", "long_path", "make_private_dir", "make_private_tree",
           "new_group_options", "on_stop_signals", "open_private_file", "owned_by_current_user", "plain_path", "private_mode",
           "release_group", "serve_ipc", "set_private_mode", "signal_group", "stop_own_group", "store_app_folders",
           "sync_directory", "track_group", "unlock_file", "watch_parent"]
