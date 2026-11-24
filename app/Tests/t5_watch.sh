#!/bin/bash
# parent_watch.py (the TTS tunnel's wrapper) must kill its command within 2 s of its parent's kill -9, and on SIGTERM.
set -euo pipefail
tests="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
watch="$(dirname "$tests")/Resources/parent_watch.py"
tick() { perl -e 'select(undef, undef, undef, 1)'; }
tag="t5watch$$"
fail=0
trap 'pkill -9 -f "sleep 300 $tag" 2>/dev/null || true' EXIT

# Parent killed: the parent is a bash that only waits; perl's sleep carries a tag pgrep can match.
bash -c 'python3 -I "$1" --parent-pid $$ -- perl -e "sleep 300" "sleep 300 $2" & wait' _ "$watch" "$tag-a" &
parent=$!
for i in 1 2 3; do pgrep -f "sleep 300 $tag-a" >/dev/null && break; tick; done
pgrep -f "sleep 300 $tag-a" >/dev/null || { echo "command did not start"; fail=1; }
kill -9 "$parent"
tick; tick
if pgrep -f "sleep 300 $tag-a" >/dev/null; then echo "command survived the parent's kill -9"; fail=1; fi

# SIGTERM to the watcher, as Supervisor.stopAll sends it.
python3 -I "$watch" --parent-pid $$ -- perl -e "sleep 300" "sleep 300 $tag-b" &
wpid=$!
for i in 1 2 3; do pgrep -f "sleep 300 $tag-b" >/dev/null && break; tick; done
tick
kill -TERM "$wpid"
tick
if kill -0 "$wpid" 2>/dev/null; then echo "watcher still running 1 s after SIGTERM"; fail=1; kill -9 "$wpid"; fi
if pgrep -f "sleep 300 $tag-b" >/dev/null; then echo "command survived SIGTERM to the watcher"; fail=1; fi

# A command that ignores TERM and forks a worker that inherits that: writes "<sh pid> <sleep pid>" to its argument.
scratch="$(mktemp -d)" || exit 1
trap 'pkill -9 -f "sleep 300 $tag" 2>/dev/null || true; for f in "$scratch"/*.pids; do [ -s "$f" ] && kill -9 $(cat "$f") 2>/dev/null; done; rm -rf "$scratch"' EXIT
stubborn=(sh -c 'trap "" TERM; sleep 300 & echo $$ $! > "$1.tmp"; mv "$1.tmp" "$1"; wait' _)
started() { for i in 1 2 3; do [ -s "$1" ] && return 0; tick; done; echo "$2: command did not start"; fail=1; return 1; }
# Within 3 s (under the supervisor's 4 s before its SIGKILL), neither the sh nor its sleep is alive.
gone() { tick; tick; tick; for p in $(cat "$1"); do if kill -0 "$p" 2>/dev/null; then echo "$2: pid $p survived"; fail=1; fi; done; }

python3 -I "$watch" --parent-pid $$ -- "${stubborn[@]}" "$scratch/c.pids" &
wpid=$!
if started "$scratch/c.pids" "SIGTERM, process group"; then
  kill -TERM "$wpid"
  gone "$scratch/c.pids" "SIGTERM, process group"
  if kill -0 "$wpid" 2>/dev/null; then echo "watcher still running 3 s after SIGTERM"; fail=1; kill -9 "$wpid"; fi
fi

bash -c 'python3 -I "$1" --parent-pid $$ -- "${@:2}" & wait' _ "$watch" "${stubborn[@]}" "$scratch/d.pids" &
parent=$!
if started "$scratch/d.pids" "parent kill -9, process group"; then
  kill -9 "$parent"
  gone "$scratch/d.pids" "parent kill -9, process group"
fi

[ "$fail" = 0 ] && echo "T5-WATCH PASS" || { echo "T5-WATCH FAIL"; exit 1; }
