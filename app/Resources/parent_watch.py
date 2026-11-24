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
import time

# Seconds from TERM to KILL of the command's group; under the 4 s the supervisor gives this watcher before its SIGKILL.
GRACE = 2.0


def watch_windows(parent, command):
    """Windows ends this process outright, running no handler: the command is in a Job Object that kills it when this
    process's handle to the job closes."""
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    synchronize, query_limited, terminate, set_quota, infinite = 0x00100000, 0x1000, 0x0001, 0x0100, 0xFFFFFFFF
    kill_on_job_close, extended_limit_information = 0x2000, 9
    create_suspended, snap_thread, suspend_resume = 0x00000004, 0x00000004, 0x0002

    class BasicLimit(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class ExtendedLimit(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimit), ("IoInfo", ctypes.c_uint64 * 6),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    class ThreadEntry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ThreadID", wintypes.DWORD),
                    ("th32OwnerProcessID", wintypes.DWORD), ("tpBasePri", wintypes.LONG), ("tpDeltaPri", wintypes.LONG),
                    ("dwFlags", wintypes.DWORD)]

    for name, restype, *argtypes in [
            ("OpenProcess", wintypes.HANDLE, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD),
            ("WaitForSingleObject", wintypes.DWORD, wintypes.HANDLE, wintypes.DWORD),
            ("GetCurrentProcess", wintypes.HANDLE),
            ("GetProcessTimes", wintypes.BOOL, wintypes.HANDLE, *[ctypes.POINTER(wintypes.FILETIME)] * 4),
            ("CreateJobObjectW", wintypes.HANDLE, ctypes.c_void_p, wintypes.LPCWSTR),
            ("SetInformationJobObject", wintypes.BOOL, wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD),
            ("AssignProcessToJobObject", wintypes.BOOL, wintypes.HANDLE, wintypes.HANDLE),
            ("CreateToolhelp32Snapshot", wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD),
            ("Thread32First", wintypes.BOOL, wintypes.HANDLE, ctypes.POINTER(ThreadEntry)),
            ("Thread32Next", wintypes.BOOL, wintypes.HANDLE, ctypes.POINTER(ThreadEntry)),
            ("OpenThread", wintypes.HANDLE, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD),
            ("ResumeThread", wintypes.DWORD, wintypes.HANDLE),
            ("CloseHandle", wintypes.BOOL, wintypes.HANDLE)]:
        function = getattr(kernel32, name)
        function.restype, function.argtypes = restype, argtypes

    def created(process):
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel32.GetProcessTimes(process, *map(ctypes.byref, times)):
            raise ctypes.WinError(ctypes.get_last_error())
        return times[0].dwHighDateTime << 32 | times[0].dwLowDateTime

    def resume(pid):
        """Resumes the suspended process's threads (Popen closes its thread handle); False when none resumed."""
        snapshot = kernel32.CreateToolhelp32Snapshot(snap_thread, 0)
        if snapshot in (None, ctypes.c_void_p(-1).value):
            return False
        resumed, entry = False, ThreadEntry()
        entry.dwSize = ctypes.sizeof(entry)
        more = kernel32.Thread32First(snapshot, ctypes.byref(entry))
        while more:
            if entry.th32OwnerProcessID == pid:
                thread = kernel32.OpenThread(suspend_resume, False, entry.th32ThreadID)
                resumed = bool(thread) and kernel32.ResumeThread(thread) != 0xFFFFFFFF
                if thread:
                    kernel32.CloseHandle(thread)
                if not resumed:
                    break
            more = kernel32.Thread32Next(snapshot, ctypes.byref(entry))
        kernel32.CloseHandle(snapshot)
        return resumed

    # Held from here on, so a parent that exits later still signals it; a reused pid belongs to a process created after this one.
    process = kernel32.OpenProcess(synchronize | query_limited, False, parent)
    if not process or kernel32.WaitForSingleObject(process, 0) == 0 or created(process) > created(kernel32.GetCurrentProcess()):
        os._exit(0)
    job = kernel32.CreateJobObjectW(None, None)
    info = ExtendedLimit()
    info.BasicLimitInformation.LimitFlags = kill_on_job_close
    if not job or not kernel32.SetInformationJobObject(job, extended_limit_information, ctypes.byref(info), ctypes.sizeof(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    # Suspended until it is in the job, so nothing it starts can fall outside it.
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, creationflags=create_suspended)
    handle = kernel32.OpenProcess(terminate | set_quota, False, child.pid)
    if not handle or not kernel32.AssignProcessToJobObject(job, handle) or not resume(child.pid):
        error = ctypes.WinError(ctypes.get_last_error())
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
    child, ending, launch = None, False, threading.Lock()

    def end():
        """TERM to the command's process group, KILL to what is left after GRACE; then exits."""
        nonlocal ending
        ending = True
        if child is not None:
            deadline = time.monotonic() + GRACE
            try:
                os.killpg(child.pid, signal.SIGTERM)
                while time.monotonic() < deadline:
                    # The leader's zombie would keep its group alive.
                    try:
                        os.waitpid(child.pid, os.WNOHANG)
                    except ChildProcessError:
                        pass
                    os.killpg(child.pid, 0)
                    time.sleep(0.05)
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        os._exit(0)

    def on_term(*_):
        # Takes no lock: it runs on the main thread, which may hold `launch`. Before the command exists it only latches.
        nonlocal ending
        ending = True
        if child is not None:
            end()

    signal.signal(signal.SIGTERM, on_term)
    kq = select.kqueue()
    event = select.kevent(parent, filter=select.KQ_FILTER_PROC,
                          flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT)
    try:
        kq.control([event], 0, 0)
    except ProcessLookupError:
        os._exit(0)

    def on_parent_exit():
        nonlocal ending
        kq.control(None, 1, None)
        with launch:
            ending = True
        end()

    watcher = threading.Thread(target=on_parent_exit, daemon=True)
    watcher.start()
    # The parent may have exited between the getppid check and registration.
    if os.getppid() != parent:
        os._exit(0)
    with launch:
        if ending:
            os._exit(0)
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, start_new_session=True)
    if ending:
        end()
    status = child.wait()
    if ending:
        # on_parent_exit is still ending the rest of the group, and exits this process when done.
        watcher.join()
    sys.exit(status)


if __name__ == "__main__":
    main()
