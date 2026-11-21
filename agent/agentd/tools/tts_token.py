"""TTS bearer token (C2 v2 §4):made on the Mac, copied to the TTS host over ssh, rotated on both sides.

usage: tts_token.py ensure | push | rotate [--file F] [--ssh HOST] [--remote PATH]
push and rotate need --ssh (or $AAC_TTS_SSH_HOST) and --remote (or $AAC_TTS_TOKEN_REMOTE).
Both TTS backends read the token only at start: after push or rotate, restart them and agentd."""
import argparse
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from infra.paths import TTS_TOKEN_FILE as DEFAULT_FILE  # noqa: E402
from infra.tokens import write_secret  # noqa: E402


def ensure(path):
    """Create the token file (0600) when it is missing; an existing one is kept."""
    path = Path(path)
    if not path.exists():
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        write_secret(path, secrets.token_urlsafe(32) + "\n")
    return path


def push(path, host, remote, run=subprocess.run):
    """Write the local token to remote on host; the token goes over stdin, never on a command line."""
    token = Path(path).read_text(encoding="utf-8").strip()
    target = shlex.quote(remote)
    script = (f"umask 077 && mkdir -p \"$(dirname {target})\" && cat > {target}.new && chmod 600 {target}.new"
              f" && mv {target}.new {target}")
    if run(["ssh", host, script], input=token + "\n", text=True).returncode != 0:
        raise SystemExit(f"could not write the token to {host}:{remote}")


def rotate(path, host, remote, run=subprocess.run):
    """New token: the TTS host first, then the local file, so a failed copy leaves both sides on the old one."""
    path = Path(path)
    fresh = path.with_name(path.name + ".new")
    write_secret(fresh, secrets.token_urlsafe(32) + "\n")
    try:
        push(fresh, host, remote, run)
    except SystemExit:
        fresh.unlink()
        raise
    os.replace(fresh, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("ensure", "push", "rotate"))
    parser.add_argument("--file", default=os.environ.get("AAC_TTS_TOKEN_FILE", str(DEFAULT_FILE)))
    parser.add_argument("--ssh", default=os.environ.get("AAC_TTS_SSH_HOST"), help="ssh host of the TTS service")
    parser.add_argument("--remote", default=os.environ.get("AAC_TTS_TOKEN_REMOTE"),
                        help="token file path on that host")
    args = parser.parse_args()
    if args.action != "ensure":
        if not args.ssh:
            parser.error(f"{args.action} needs the TTS host: pass --ssh HOST or set AAC_TTS_SSH_HOST")
        if not args.remote:
            parser.error(f"{args.action} needs the token path on the TTS host: pass --remote PATH or set AAC_TTS_TOKEN_REMOTE")
    if args.action == "ensure":
        print(ensure(args.file))
    elif args.action == "push":
        push(ensure(args.file), args.ssh, args.remote)
        print(f"copied to {args.ssh}:{args.remote}; restart the TTS service to load it")
    else:
        rotate(ensure(args.file), args.ssh, args.remote)
        print(f"rotated {args.file} and {args.ssh}:{args.remote}; restart both TTS backends and agentd")


if __name__ == "__main__":
    main()
