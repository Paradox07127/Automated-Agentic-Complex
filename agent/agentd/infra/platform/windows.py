r"""infra.platform on Windows, with ctypes only: LockFileEx, a protected current-user DACL and Job Objects.

Differences from POSIX:
- lock_file locks byte 0 with LockFileEx. The lock is mandatory: no other handle can read or write that byte.
- File modes mean nothing here. make_private_dir gives the directory a protected DACL with one ACE, the current user,
  inherited by what is created inside; owned_by_current_user, private_mode and set_private_mode therefore accept and
  do nothing.
- A symlink or junction is refused by checking for a reparse point before opening, not atomically with the open.
- A tracked child is put in its own Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE right after it starts, so a
  grandchild it starts before that escapes. Its tree has no polite stop: signal_group ends it with TerminateJobObject
  with or without force, and release_group (or agentd exiting) closes the job, which ends what is left.
- sync_directory does nothing: os.open cannot open a directory, and NTFS journals the rename itself.
- stop_own_group does nothing: a runner is in agentd's job, which agentd ends.
- on_stop_signals handles only Ctrl-Break; a runner started with CREATE_NO_WINDOW gets none, so it stops on stdin EOF.
- watch_parent waits on the parent's process handle, and takes stdin EOF as the parent's stop request, as runners do.
- serve_ipc is a byte-mode named pipe \\.\pipe\<prefix><random>, local clients only, made with an explicit DACL;
  it serves on the ProactorEventLoop the way loop.start_serving_pipe does, whose own pipes have the default DACL.
  connect_ipc opens it for overlapped I/O: on a synchronous handle a pending read would block every write.
"""
import _winapi
import asyncio
from asyncio import windows_events, windows_utils
import ctypes
from ctypes import wintypes
import errno
import functools
import msvcrt
import os
import secrets
import signal
import stat
import subprocess
import threading

_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

LOCKFILE_FAIL_IMMEDIATELY, LOCKFILE_EXCLUSIVE_LOCK, ERROR_LOCK_VIOLATION = 0x1, 0x2, 33
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 0x2000, 9
PROCESS_TERMINATE, PROCESS_SET_QUOTA, SYNCHRONIZE, WAIT_OBJECT_0 = 0x0001, 0x0100, 0x00100000, 0
PROCESS_QUERY_LIMITED_INFORMATION, INFINITE = 0x1000, 0xFFFFFFFF
TOKEN_QUERY, TOKEN_USER = 0x0008, 1
DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SDDL_REVISION_1 = 0x4, 0x80000000, 1
PIPE_ACCESS_DUPLEX, FILE_FLAG_OVERLAPPED, FILE_FLAG_FIRST_PIPE_INSTANCE = 0x3, 0x40000000, 0x00080000
PIPE_REJECT_REMOTE_CLIENTS, PIPE_UNLIMITED_INSTANCES, PIPE_BUFFER = 0x8, 255, 65536
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
KEEP = ("SystemRoot", "SYSTEMDRIVE", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT", "COMSPEC")


class _Overlapped(ctypes.Structure):
    _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t), ("Offset", wintypes.DWORD),
                ("OffsetHigh", wintypes.DWORD), ("hEvent", wintypes.HANDLE)]


class _BasicLimit(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]


class _ExtendedLimit(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", _BasicLimit), ("IoInfo", ctypes.c_uint64 * 6),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]


class _SecurityAttributes(ctypes.Structure):
    _fields_ = [("nLength", wintypes.DWORD), ("lpSecurityDescriptor", ctypes.c_void_p),
                ("bInheritHandle", wintypes.BOOL)]


def _declare(function, restype, *argtypes):
    function.restype, function.argtypes = restype, argtypes


_declare(_kernel32.LockFileEx, wintypes.BOOL, wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
         wintypes.DWORD, ctypes.POINTER(_Overlapped))
_declare(_kernel32.UnlockFileEx, wintypes.BOOL, wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
         ctypes.POINTER(_Overlapped))
_declare(_kernel32.CreateJobObjectW, wintypes.HANDLE, ctypes.c_void_p, wintypes.LPCWSTR)
_declare(_kernel32.SetInformationJobObject, wintypes.BOOL, wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
_declare(_kernel32.OpenProcess, wintypes.HANDLE, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
_declare(_kernel32.AssignProcessToJobObject, wintypes.BOOL, wintypes.HANDLE, wintypes.HANDLE)
_declare(_kernel32.TerminateJobObject, wintypes.BOOL, wintypes.HANDLE, wintypes.UINT)
_declare(_kernel32.WaitForSingleObject, wintypes.DWORD, wintypes.HANDLE, wintypes.DWORD)
_declare(_kernel32.CloseHandle, wintypes.BOOL, wintypes.HANDLE)
_declare(_kernel32.GetCurrentProcess, wintypes.HANDLE)
_declare(_kernel32.GetProcessTimes, wintypes.BOOL, wintypes.HANDLE, *[ctypes.POINTER(wintypes.FILETIME)] * 4)
_declare(_kernel32.CreateNamedPipeW, wintypes.HANDLE, wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
         wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(_SecurityAttributes))
_declare(_kernel32.LocalFree, ctypes.c_void_p, ctypes.c_void_p)
_declare(_advapi32.OpenProcessToken, wintypes.BOOL, wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE))
_declare(_advapi32.GetTokenInformation, wintypes.BOOL, wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
         ctypes.POINTER(wintypes.DWORD))
_declare(_advapi32.ConvertSidToStringSidW, wintypes.BOOL, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))
_declare(_advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW, wintypes.BOOL, wintypes.LPCWSTR, wintypes.DWORD,
         ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p)
_declare(_advapi32.SetFileSecurityW, wintypes.BOOL, wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p)

_jobs = {}
_jobs_lock = threading.Lock()


def _check(ok):
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())


def _handle(file):
    return msvcrt.get_osfhandle(file if isinstance(file, int) else file.fileno())


def lock_file(file, blocking=True):
    flags = LOCKFILE_EXCLUSIVE_LOCK if blocking else LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY
    if not _kernel32.LockFileEx(_handle(file), flags, 0, 1, 0, ctypes.byref(_Overlapped())):
        code = ctypes.get_last_error()
        if code == ERROR_LOCK_VIOLATION:
            raise BlockingIOError(errno.EAGAIN, "the file is locked by another open file")
        raise ctypes.WinError(code)


def unlock_file(file):
    _check(_kernel32.UnlockFileEx(_handle(file), 0, 1, 0, ctypes.byref(_Overlapped())))


@functools.cache
def _user_sid():
    token = wintypes.HANDLE()
    _check(_advapi32.OpenProcessToken(_kernel32.GetCurrentProcess(), TOKEN_QUERY, ctypes.byref(token)))
    try:
        size = wintypes.DWORD()
        _advapi32.GetTokenInformation(token, TOKEN_USER, None, 0, ctypes.byref(size))
        buffer = ctypes.create_string_buffer(size.value)
        _check(_advapi32.GetTokenInformation(token, TOKEN_USER, buffer, size, ctypes.byref(size)))
        text = ctypes.c_void_p()
        # TOKEN_USER starts with the PSID.
        _check(_advapi32.ConvertSidToStringSidW(ctypes.c_void_p.from_buffer(buffer).value, ctypes.byref(text)))
        try:
            return ctypes.wstring_at(text.value)
        finally:
            _kernel32.LocalFree(text)
    finally:
        _kernel32.CloseHandle(token)


def _refuse_reparse_point(path):
    if os.lstat(path).st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise OSError(errno.ELOOP, "a symlink or junction", str(path))


def _restrict(path, inherit):
    descriptor = ctypes.c_void_p()
    _check(_advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        f"D:P(A;{'OICI' if inherit else ''};FA;;;{_user_sid()})", SDDL_REVISION_1, ctypes.byref(descriptor), None))
    try:
        _check(_advapi32.SetFileSecurityW(str(path), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                                          descriptor))
    finally:
        _kernel32.LocalFree(descriptor)


def make_private_dir(path):
    os.makedirs(path, exist_ok=True)
    _refuse_reparse_point(path)
    _restrict(path, True)


def make_private_tree(path):
    _refuse_reparse_point(path)
    _restrict(path, True)
    for root, directories, files in os.walk(path, followlinks=False):
        for name in directories + files:
            child = os.path.join(root, name)
            attributes = os.lstat(child).st_file_attributes
            if not attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                _restrict(child, bool(attributes & stat.FILE_ATTRIBUTE_DIRECTORY))


def open_private_file(path, flags):
    try:
        _refuse_reparse_point(path)
    except FileNotFoundError:
        pass
    return os.open(path, flags | os.O_NOINHERIT | os.O_BINARY, 0o600)


def owned_by_current_user(info):
    return True


def private_mode(info):
    return True


def set_private_mode(fd, mode):
    pass


def sync_directory(path):
    pass


def new_group_options():
    return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}


def track_group(proc):
    job = _kernel32.CreateJobObjectW(None, None)
    _check(job)
    try:
        info = _ExtendedLimit()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        _check(_kernel32.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ctypes.byref(info),
                                                 ctypes.sizeof(info)))
        process = _kernel32.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA | SYNCHRONIZE, False, proc.pid)
        _check(process)
        try:
            if not _kernel32.AssignProcessToJobObject(job, process):
                error = ctypes.WinError(ctypes.get_last_error())
                if _kernel32.WaitForSingleObject(process, 0) == WAIT_OBJECT_0:
                    # Already exited: there is no tree left to track.
                    _kernel32.CloseHandle(job)
                    return
                raise error
        finally:
            _kernel32.CloseHandle(process)
    except BaseException:
        _kernel32.CloseHandle(job)
        raise
    with _jobs_lock:
        _jobs[proc] = job


def signal_group(proc, force=False):
    with _jobs_lock:
        job = _jobs.get(proc)
    if job is None:
        raise ProcessLookupError(errno.ESRCH, "no tracked process tree")
    _check(_kernel32.TerminateJobObject(job, 1))


def release_group(proc):
    with _jobs_lock:
        job = _jobs.pop(proc, None)
    if job is not None:
        _kernel32.CloseHandle(job)


def stop_own_group():
    pass


def on_stop_signals(loop, callback, *args):
    signal.signal(signal.SIGBREAK, lambda signum, frame: loop.call_soon_threadsafe(callback, *args))


class _PipeServer(windows_events.PipeServer):
    def _server_pipe_handle(self, first):
        if self.closed():
            return None
        descriptor = ctypes.c_void_p()
        # NULL attributes would give the default DACL, which grants Everyone and Anonymous read (named pipes).
        _check(_advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            f"D:P(A;;GA;;;{_user_sid()})", SDDL_REVISION_1, ctypes.byref(descriptor), None))
        try:
            attributes = _SecurityAttributes(ctypes.sizeof(_SecurityAttributes), descriptor, False)
            flags = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (FILE_FLAG_FIRST_PIPE_INSTANCE if first else 0)
            handle = _kernel32.CreateNamedPipeW(self._address, flags, PIPE_REJECT_REMOTE_CLIENTS,
                                                PIPE_UNLIMITED_INSTANCES, PIPE_BUFFER, PIPE_BUFFER, 0,
                                                ctypes.byref(attributes))
        finally:
            _kernel32.LocalFree(descriptor)
        if handle in (None, INVALID_HANDLE_VALUE):
            raise ctypes.WinError(ctypes.get_last_error())
        pipe = windows_utils.PipeHandle(handle)
        self._free_instances.add(pipe)
        return pipe


async def serve_ipc(handle_connection, prefix, limit=2 ** 16):
    loop = asyncio.get_running_loop()
    address = rf"\\.\pipe\{prefix}{secrets.token_hex(16)}"
    server = _PipeServer(address)

    def accept(future=None):
        pipe = None
        try:
            if future is not None:
                pipe = future.result()
                server._free_instances.discard(pipe)
                if server.closed():
                    pipe.close()
                    return
                reader = asyncio.StreamReader(limit=limit, loop=loop)
                protocol = asyncio.StreamReaderProtocol(reader, handle_connection, loop=loop)
                loop._make_duplex_pipe_transport(pipe, protocol, extra={"addr": address})
            pipe = server._get_unconnected_pipe()
            if pipe is None:
                return
            future = loop._proactor.accept_pipe(pipe)
        except BrokenPipeError:
            # The client left before the connection was accepted.
            if pipe is not None:
                pipe.close()
            loop.call_soon(accept)
        except asyncio.CancelledError:
            pass
        else:
            server._accept_pipe_future = future
            future.add_done_callback(accept)

    accept()
    return server, address


class _PipeConnection:
    def __init__(self, handle):
        self.handle, self.buffer = handle, bytearray()

    def write(self, data):
        overlapped, _ = _winapi.WriteFile(self.handle, data, overlapped=True)
        overlapped.GetOverlappedResult(True)

    def readline(self, limit):
        while b"\n" not in self.buffer and len(self.buffer) < limit:
            try:
                overlapped, _ = _winapi.ReadFile(self.handle, PIPE_BUFFER, overlapped=True)
                overlapped.GetOverlappedResult(True)
            except BrokenPipeError:
                break
            chunk = overlapped.getbuffer()
            if not chunk:
                break
            self.buffer += chunk
        end = min(self.buffer.find(b"\n") + 1 or len(self.buffer), limit)
        line, self.buffer = bytes(self.buffer[:end]), self.buffer[end:]
        return line

    def close(self):
        _winapi.CloseHandle(self.handle)


def connect_ipc(address):
    while True:
        try:
            return _PipeConnection(_winapi.CreateFile(address, _winapi.GENERIC_READ | _winapi.GENERIC_WRITE, 0,
                                                      _winapi.NULL, _winapi.OPEN_EXISTING, _winapi.FILE_FLAG_OVERLAPPED,
                                                      _winapi.NULL))
        except OSError as error:
            if error.winerror != _winapi.ERROR_PIPE_BUSY:
                raise
        # Every instance is taken until the server makes the next one.
        _winapi.WaitNamedPipe(address, 1000)


def child_environment(tmp):
    env = {key: os.environ[key] for key in KEEP if key in os.environ}
    root = os.environ.get("SystemRoot", r"C:\Windows")
    env.update(PATH=";".join((root + r"\System32", root, root + r"\System32\Wbem")), TEMP=str(tmp), TMP=str(tmp))
    return env


def _created(process):
    times = [wintypes.FILETIME() for _ in range(4)]
    _check(_kernel32.GetProcessTimes(process, *map(ctypes.byref, times)))
    return times[0].dwHighDateTime << 32 | times[0].dwLowDateTime


def watch_parent(pid, stop):
    process = _kernel32.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    # An exited parent's pid can be reused: a process created after this one is not the parent.
    if not process or _kernel32.WaitForSingleObject(process, 0) == WAIT_OBJECT_0 or \
            _created(process) > _created(_kernel32.GetCurrentProcess()):
        os._exit(0)
    once = threading.Lock()

    def end():
        if once.acquire(blocking=False):
            stop()

    def parent_exit():
        _kernel32.WaitForSingleObject(process, INFINITE)
        end()

    def stdin_eof():
        while os.read(0, 4096):
            pass
        end()

    threading.Thread(target=parent_exit, daemon=True).start()
    threading.Thread(target=stdin_eof, daemon=True).start()
