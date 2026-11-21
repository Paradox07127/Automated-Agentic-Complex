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
            "pid": os.getppid(), **{field: env.get(var) or None for field, var in ENV_FIELDS}}


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
