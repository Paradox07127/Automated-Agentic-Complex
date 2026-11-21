#!/usr/bin/env python3
"""Chrome Native Messaging host for the Agentic Complex extension: frames on stdio -> POST /context/browser.

On connect it sends the read mode and the domains so the extension extracts no text where it may not; it drops matches
again before forwarding. It reads only hook.token and the agentd base_url, never the ui token."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import urllib.error
import urllib.request

HIDDEN = {"app": "<hidden>"}
MAX_MESSAGE = 1024 * 1024  # Chrome's limit for messages from the extension


class Blacklist:
    """Read only the C10 mode and the domain and title rules; None means nothing may be forwarded."""
    def __init__(self, path):
        self.path = path
        self.data = None

    def _load(self):
        self.mode, self.allow_domains = "allow", []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            self.titles = [re.compile(p) for p in data.get("title_patterns", [])]
            allow_domains = list(data.get("allow", {}).get("domains", []))
        except (OSError, ValueError, AttributeError, TypeError, re.error):
            self.data = None
            return
        self.data = data
        self.mode = "deny" if data.get("mode") == "deny" else "allow"
        self.allow_domains = allow_domains

    def hides(self, window):
        host = (window.get("url_host") or "").casefold()
        if self.mode == "allow":  # only allowed hosts; a message without a host is hidden
            return not (host and any(host == d.casefold() or host.endswith("." + d.casefold())
                                     for d in self.allow_domains))
        if host and any(host == d.casefold() or host.endswith("." + d.casefold())
                        for d in self.data.get("domains", [])):
            return True
        title = window.get("title") or ""
        return any(p.search(title) for p in self.titles)


def read_token(path):
    # NONBLOCK lets the regular-file check reject a FIFO without waiting for a writer.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError(f"{path} must be a regular file with one link")
        if info.st_uid != os.getuid():
            raise ValueError(f"{path} must be owned by the current user")
        if info.st_mode & 0o077:
            raise ValueError(f"{path} must be mode 0600")
    except BaseException:
        os.close(fd)
        raise
    with os.fdopen(fd, "r", encoding="utf-8") as stream:
        return stream.read().strip()


def read_message(stream):
    header = stream.read(4)
    if len(header) < 4:
        return None
    (size,) = struct.unpack("=I", header)
    if size > MAX_MESSAGE:
        return None
    return json.loads(stream.read(size))


def write_message(stream, obj):
    raw = json.dumps(obj, ensure_ascii=False).encode()
    stream.write(struct.pack("=I", len(raw)) + raw)
    stream.flush()


def scrub(message, blacklist):
    """The message to forward, or None to drop it."""
    blacklist._load()
    if blacklist.data is None:
        return None
    host = message.get("url_host")
    if not blacklist.hides({"url_host": host, "title": message.get("title")}):
        return message
    if message.get("type") != "heartbeat":
        return None
    return {**message, "url_host": HIDDEN["app"], "title": None}


def serve(state_dir, stdin, stdout, timeout=3.0):
    blacklist = Blacklist(state_dir / "blacklist.json")
    base = token = None
    def config():
        nonlocal base, token
        policy = {"enabled": False, "text_enabled": False}
        try:
            token = read_token(state_dir / "hook.token")
            base = json.loads((state_dir / "ui-runtime.json").read_text(encoding="utf-8"))["base_url"]
        except (OSError, ValueError, KeyError, TypeError):
            print("agentd is not running", file=sys.stderr)
        else:
            try:
                request = urllib.request.Request(base.rstrip("/") + "/context/browser/policy",
                                                 headers={"Authorization": f"Bearer {token}"})
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    policy = json.load(response)
            except (urllib.error.URLError, OSError, ValueError):
                pass
        blacklist._load()
        data = blacklist.data or {}
        write_message(stdout, {"type": "config", **policy, "domains": data.get("domains", []),
                               "title_patterns": data.get("title_patterns", []), "mode": blacklist.mode,
                               "allow_domains": blacklist.allow_domains})
        return policy
    policy = config()
    while True:
        message = read_message(stdin)
        if message is None:
            return
        if isinstance(message, dict) and message.get("type") == "policy":
            policy = config()
            continue
        if not policy.get("enabled") or (isinstance(message, dict) and message.get("type") in ("page", "selection")
                                          and not policy.get("text_enabled")):
            continue
        message = scrub(message, blacklist) if isinstance(message, dict) else None
        if message is None:
            continue
        request = urllib.request.Request(
            base.rstrip("/") + "/context/browser", data=json.dumps(message).encode(), method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                response.read()
        except (urllib.error.URLError, OSError):
            pass  # agentd down or busy: drop this one; the next heartbeat comes within a minute


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True)
    args, _chrome_args = parser.parse_known_args()  # Chrome appends the caller origin
    serve(Path(args.state_dir), sys.stdin.buffer, sys.stdout.buffer)


if __name__ == "__main__":
    main()
