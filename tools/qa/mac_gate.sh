#!/bin/bash
# Usage: mac_gate.sh <checkout> <log dir> [--perf]
# The mac profile of tools/qa/suites.json, run by the gate.py beside this script on <checkout>: the window and GPU part
# of the release profile, the release build of the Metal host then the gpu-locked suites.
# Prints one line per suite, `receipt: <path>`, then GATE PASS or GATE FAIL.
set -uo pipefail
repo=$(cd "$1" && pwd); mkdir -p "$2"; L=$(cd "$2" && pwd); shift 2; perf=()
for a in "$@"; do case $a in --perf) perf=(--perf) ;; esac; done
exec python3 -I "$(dirname "${BASH_SOURCE[0]}")/gate.py" --profile mac --checkout "$repo" --logs "$L" ${perf[@]+"${perf[@]}"}
