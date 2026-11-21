#!/usr/bin/env python3
"""Run a command and kill it as soon as the parent Companion exits; exit with the command's status.

usage: parent_watch.py --parent-pid P -- <command...>
"""
import os
import select
import signal
import subprocess
import sys
import threading


def watch_windows(parent, command):
    """Windows ends this process outright, running no handler: the command is in a Job Object that kills it when this
    process's handle to the job closes."""
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    synchronize, query_limited, terminate, set_quota, infinite = 0x00100000, 0x1000, 0x0001, 0x0100, 0xFFFFFFFF
    kill_on_job_close, extended_limit_information = 0x2000, 9

    class BasicLimit(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class ExtendedLimit(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimit), ("IoInfo", ctypes.c_uint64 * 6),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    for name, restype, *argtypes in [
            ("OpenProcess", wintypes.HANDLE, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD),
            ("WaitForSingleObject", wintypes.DWORD, wintypes.HANDLE, wintypes.DWORD),
            ("GetCurrentProcess", wintypes.HANDLE),
            ("GetProcessTimes", wintypes.BOOL, wintypes.HANDLE, *[ctypes.POINTER(wintypes.FILETIME)] * 4),
            ("CreateJobObjectW", wintypes.HANDLE, ctypes.c_void_p, wintypes.LPCWSTR),
            ("SetInformationJobObject", wintypes.BOOL, wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD),
            ("AssignProcessToJobObject", wintypes.BOOL, wintypes.HANDLE, wintypes.HANDLE)]:
        function = getattr(kernel32, name)
        function.restype, function.argtypes = restype, argtypes

    def created(process):
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel32.GetProcessTimes(process, *map(ctypes.byref, times)):
            raise ctypes.WinError(ctypes.get_last_error())
        return times[0].dwHighDateTime << 32 | times[0].dwLowDateTime

    # Held from here on, so a parent that exits later still signals it; a reused pid belongs to a process created after this one.
    process = kernel32.OpenProcess(synchronize | query_limited, False, parent)
    if not process or kernel32.WaitForSingleObject(process, 0) == 0 or created(process) > created(kernel32.GetCurrentProcess()):
        os._exit(0)
    job = kernel32.CreateJobObjectW(None, None)
    info = ExtendedLimit()
    info.BasicLimitInformation.LimitFlags = kill_on_job_close
    if not job or not kernel32.SetInformationJobObject(job, extended_limit_information, ctypes.byref(info), ctypes.sizeof(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL)
    handle = kernel32.OpenProcess(terminate | set_quota, False, child.pid)
    if not handle or not kernel32.AssignProcessToJobObject(job, handle):
        error = ctypes.WinError(ctypes.get_last_error())
        if child.poll() is None:
            child.kill()
            raise error

    def on_parent_exit():
        kernel32.WaitForSingleObject(process, infinite)
        child.kill()
        os._exit(0)

    threading.Thread(target=on_parent_exit, daemon=True).start()
    return child.wait()


def main():
    argv = sys.argv[1:]
    if "--" not in argv or argv.index("--") != 2 or argv[0] != "--parent-pid":
        sys.exit(__doc__)
    parent, command = int(argv[1]), argv[3:]
    if os.getppid() != parent:
        os._exit(0)
    if os.name == "nt":
        sys.exit(watch_windows(parent, command))
    child = None
    # Only signals the child: wait() below returns once it exits. Calling wait() here would deadlock on
    # Popen's wait lock, which the main thread holds.
    signal.signal(signal.SIGTERM, lambda *_: child and child.terminate())
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL)
    kq = select.kqueue()
    event = select.kevent(parent, filter=select.KQ_FILTER_PROC,
                          flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT)
    try:
        kq.control([event], 0, 0)
    except ProcessLookupError:
        child.kill()
        os._exit(0)

    def on_parent_exit():
        kq.control(None, 1, None)
        child.kill()
        os._exit(0)

    threading.Thread(target=on_parent_exit, daemon=True).start()
    # The parent may have exited between the getppid check and registration.
    if os.getppid() != parent:
        child.kill()
        os._exit(0)
    sys.exit(child.wait())


if __name__ == "__main__":
    main()
