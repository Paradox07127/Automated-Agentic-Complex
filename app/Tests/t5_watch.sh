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

[ "$fail" = 0 ] && echo "T5-WATCH PASS" || { echo "T5-WATCH FAIL"; exit 1; }
