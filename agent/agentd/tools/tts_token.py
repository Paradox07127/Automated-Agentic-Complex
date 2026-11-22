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
from infra.paths import app_state_dir
from infra.secrets import system_store
from voice.credential import TtsCredential  # noqa: E402


def ensure(credential):
    token = credential.get()
    if token is None:
        token = secrets.token_urlsafe(32)
        credential.put(token)
    return token


def push(token, host, remote, run=subprocess.run):
    """Write the token to remote on host over stdin."""
    target = shlex.quote(remote)
    script = (f"umask 077 && mkdir -p \"$(dirname {target})\" && cat > {target}.new && chmod 600 {target}.new"
              f" && mv {target}.new {target}")
    if run(["ssh", host, script], input=token + "\n", text=True).returncode != 0:
        raise SystemExit(f"could not write the token to {host}:{remote}")


def rotate(credential, host, remote, run=subprocess.run):
    token = secrets.token_urlsafe(32)
    with credential.stage(token):
        push(token, host, remote, run)


def main(secret_store=None):
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
    credential = TtsCredential(args.file, system_store(app_state_dir()) if secret_store is None else secret_store)
    if args.action == "ensure":
        ensure(credential)
        print(credential.ref)
    elif args.action == "push":
        push(ensure(credential), args.ssh, args.remote)
        print(f"copied to {args.ssh}:{args.remote}; restart the TTS service to load it")
    else:
        rotate(credential, args.ssh, args.remote)
        print(f"rotated the credential for {args.ssh}:{args.remote}; restart the TTS service and agentd")


if __name__ == "__main__":
    main()
