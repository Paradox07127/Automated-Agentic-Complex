#!/bin/bash
set -euo pipefail

usage() { printf 'Usage: %s --root <dir> --port <p> [--bind <addr>]\n' "$0" >&2; exit 2; }
root=
port=
bind=127.0.0.1
while [ "$#" -gt 0 ]; do
    case "$1" in
        --root) [ "$#" -ge 2 ] || usage; root=$2; shift 2 ;;
        --port) [ "$#" -ge 2 ] || usage; port=$2; shift 2 ;;
        --bind) [ "$#" -ge 2 ] || usage; bind=$2; shift 2 ;;
        *) usage ;;
    esac
done
[[ -n "$root" && "$port" =~ ^[0-9]{1,5}$ ]] || usage
octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
[[ "$bind" =~ ^$octet\.$octet\.$octet\.$octet$ ]] || usage
port=$((10#$port))
((port >= 1 && port <= 65535)) || usage

uid=$(id -u)
if [ "$uid" -eq 0 ]; then
    echo 'Run deploy.sh as the non-root service account.' >&2
    exit 1
fi
mkdir -p -- "$root/weights/state" "$root/weights/output" "$root/state" "$root/output"
root=$(cd -- "$root" && pwd -P)
python3 - "$root/state/tts-token" <<'PY'
import os,secrets,sys
path=sys.argv[1]
try:fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
except FileExistsError:pass
else:
    with os.fdopen(fd,'w') as token:
        os.fchmod(token.fileno(),0o600)
        token.write(secrets.token_urlsafe(32)+'\n')
print(f'Token file: {path}')
PY

export AAC_TTS_ROOT="$root" AAC_TTS_PORT="$port"
export AAC_TTS_UID="$uid" AAC_TTS_GID="$(id -g)"
export AAC_TTS_BIND="$bind" AAC_TTS_REMOTE="$([ "$bind" = 127.0.0.1 ] && echo 0 || echo 1)"
deploy_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
docker compose --file "$deploy_dir/compose.yaml" up --build -d
