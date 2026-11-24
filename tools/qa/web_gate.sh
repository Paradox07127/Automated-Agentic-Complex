#!/bin/bash
# Usage: web_gate.sh <checkout> <log dir>
# The web profile of tools/qa/suites.json, run by the gate.py beside this script on <checkout>'s web: npm ci
# (replaces node_modules, so nothing else may build the web UI meanwhile), types, vitest, size and copy lints, the route
# contract, the app build (no data: fonts; the app's CSP blocks them), Playwright e2e on a port derived from the checkout path.
# Prints one line per step, `receipt: <path>`, then GATE PASS or GATE FAIL.
set -euo pipefail
(( $# == 2 )) || { echo 'usage: web_gate.sh <checkout> <log dir>' >&2; exit 2; }
repo=$(cd "$1" && pwd); mkdir -p "$2"; L=$(cd "$2" && pwd)
exec python3 -I "$(dirname "${BASH_SOURCE[0]}")/gate.py" --profile web --checkout "$repo" --logs "$L"
