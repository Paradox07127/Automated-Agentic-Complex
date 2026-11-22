#!/usr/bin/env python3
"""Command hook handler for Codex and Claude: forward the hook JSON on stdin to agentd.

It adds `agentd_origin` (where the session runs, for the jump to it) from this process's env and tty, and
`agentd_started_at`, the time it started: hooks run in the background, so they can arrive out of order.
It prints nothing and exits 0, so the agent goes on as without the hook.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request


def _tty():
    """The terminal device the agent runs in, e.g. /dev/ttys004, or None."""
    if os.name == "nt":  # no tty devices, os.ttyname or ps
        return None
    # Hooks get the JSON on a pipe, so the std fds are usually not the terminal; the agent's
    # controlling tty comes from ps. ttyname of /dev/tty itself only returns "/dev/tty".
    for fd in (0, 1, 2):
        try:
            if os.isatty(fd):
                return _device(os.ttyname(fd))
        except OSError:
            pass
    try:
        name = subprocess.run(["ps", "-o", "tty=", "-p", str(os.getppid())], capture_output=True, text=True,
                              timeout=0.2, encoding="utf-8").stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return _device("/dev/" + name) if name and name.strip("?") else None


def _device(path):
    return None if path == "/dev/tty" else path


# origin field <- environment variable; bundle_id tells apart apps that all report TERM_PROGRAM=vscode.
ENV_FIELDS = (("entrypoint", "CLAUDE_CODE_ENTRYPOINT"), ("bundle_id", "__CFBundleIdentifier"),
              ("wezterm_pane", "WEZTERM_PANE"), ("kitty_window_id", "KITTY_WINDOW_ID"),
              ("kitty_listen_on", "KITTY_LISTEN_ON"))


# What the agent runs a hook command through on Windows; they exit with the hook, before any jump.
WINDOWS_SHELLS = frozenset(("cmd.exe", "conhost.exe", "powershell.exe", "pwsh.exe"))


def _windows_processes():
    """{pid: (parent pid, lower-case exe name)} of every process, from a Toolhelp32 snapshot."""
    import ctypes
    from ctypes import wintypes

    class Entry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD),
                    ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                    ("pcPriClassBase", wintypes.LONG), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", wintypes.WCHAR * 260)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.CreateToolhelp32Snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
    for name in ("Process32FirstW", "Process32NextW"):
        getattr(kernel32, name).argtypes = (wintypes.HANDLE, ctypes.POINTER(Entry))
        getattr(kernel32, name).restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    snapshot = kernel32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if snapshot in (None, ctypes.c_void_p(-1).value):
        raise OSError(ctypes.get_last_error(), "CreateToolhelp32Snapshot failed")
    processes, entry = {}, Entry()
    entry.dwSize = ctypes.sizeof(Entry)
    try:
        more = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while more:
            processes[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile.lower())
            more = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    return processes


def _agent_pid(processes=None):
    """The pid the jump starts from: the parent, on Windows its first ancestor that is none of WINDOWS_SHELLS (the agent
    CLI); the parent when the walk finds none."""
    parent = os.getppid()
    if os.name != "nt":
        return parent
    try:
        processes = _windows_processes() if processes is None else processes
    except OSError:
        return parent
    pid = parent
    for _ in range(64):  # a reused pid can make the parent links a loop
        if pid not in processes:
            break
        up, exe = processes[pid]
        if exe not in WINDOWS_SHELLS:
            return pid
        pid = up
    return parent


def origin(env=None):
    env = os.environ if env is None else env
    tty, tmux = _tty(), env.get("TMUX") or None
    if tmux:
        kind = "tmux"
    elif env.get("CLAUDE_CODE_ENTRYPOINT") == "claude-desktop":
        kind = "desktop"
    else:
        kind = "terminal" if tty else "unknown"
    # Inside tmux TERM_PROGRAM is "tmux"; finding the outer terminal is left to the shell.
    return {"kind": kind, "term_program": env.get("TERM_PROGRAM") or None, "tty": tty,
            "tmux_pane": env.get("TMUX_PANE") or None, "tmux_socket": tmux.split(",")[0] if tmux else None,
            "pid": _agent_pid(), **{field: env.get(var) or None for field, var in ENV_FIELDS}}


def with_origin(raw, started):
    try:
        payload = json.loads(raw)
    except ValueError:
        return raw
    if not isinstance(payload, dict):
        return raw
    return json.dumps({**payload, "agentd_origin": origin(), "agentd_started_at": started}).encode()


def forward(raw, url, token, timeout, endpoint="/hook/codex", observe=False):
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
    if observe:
        headers["X-Agentd-Observe"] = "1"
    request = urllib.request.Request(url.rstrip("/") + endpoint, data=raw, method="POST", headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        response.read()


def main(argv=None, stdin=None):
    started = time.time()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:48800")
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--endpoint", default="/hook/codex", choices=("/hook/codex", "/hook/claude"))
    parser.add_argument("--timeout", type=float, default=3.0,
                        help="HTTP wait; keep below the hooks.json timeout")
    parser.add_argument("--observe", action="store_true",
                        help="agentd only records a Claude PermissionRequest and answers at once")
    args = parser.parse_args(argv)
    stdin = stdin or sys.stdin.buffer
    try:
        raw = stdin.read()
        with open(args.token_file, encoding="utf-8") as stream:
            token = stream.read().strip()
        forward(with_origin(raw, started), args.url, token, args.timeout, args.endpoint, args.observe)
    except urllib.error.HTTPError as error:
        error.close()
    except Exception:  # any failure leaves the agent as without the hook
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
