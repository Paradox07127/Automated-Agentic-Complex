#!/bin/bash
# Usage: [AAC_LOCK=<name>] tools/platform/gpu-lock.sh <label> <command...>
# Runs <command> while holding the named Mac lock; waits while another holder runs.
# AAC_LOCK: gpu (default) for runs that start an app, player or probe window; any other name is its own lock.
set -u
name=${AAC_LOCK:-gpu}
# One directory for the main checkout and all its worktrees, so they all wait on the same lock.
common=$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
# Without git (an exported tree) the repo root is the one holding this script.
if [ -n "$common" ]; then root=$(dirname "$common"); else root=$(cd "$(dirname "$0")/../.." && pwd); fi
LOCK=${AAC_LOCK_DIR:-$root/.local/cache}/$name.lock
label=$1; shift
# A caller that already holds this lock (an outer gpu-lock.sh) runs the command directly; waiting would deadlock.
held=AAC_LOCK_HELD_${name//[^A-Za-z0-9_]/_}
[ -n "${!held:-}" ] && exec "$@"
mkdir -p "$(dirname "$LOCK")"
# AAC_LOCK_WAIT: seconds to wait for another holder before exiting 75 (default 900).
deadline=$(( SECONDS + ${AAC_LOCK_WAIT:-900} )); told=
until mkdir "$LOCK" 2>/dev/null; do
  # A holder that died without cleanup leaves its pid behind; reclaim the lock.
  if [ -f "$LOCK/pid" ] && ! kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
  owner=$(cat "$LOCK/owner" 2>/dev/null)
  [ -z "$told" ] && { echo "gpu-lock: $label waits for $name held by: $owner" >&2; told=1; }
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "gpu-lock: $label gave up after ${AAC_LOCK_WAIT:-900} s; $name held by: $owner" >&2
    exit 75
  fi
  sleep 2
done
echo $$ > "$LOCK/pid"
printf '%s %s\n' "$label" "$(date -u +%FT%TZ)" > "$LOCK/owner"
trap 'rm -rf "$LOCK"' EXIT
export "$held=1"
"$@"
