#!/bin/bash
# Host gate: the host profile of tools/qa/suites.json, run by tools/qa/gate.py on this checkout. Shell syntax of the build
# scripts, Metal host/native Swift tests, C3 examples, the release build of the Metal host, the Metal host's C3 plugin link,
# then the web suites.
# Prints one result line per suite, `receipt: <path>`, then GATE PASS or GATE FAIL; exits 1 if any suite fails.
# Only the Metal tests that create a device and host_link take the gpu lock.
# Callers do not wrap gate.sh. tools/platform/agentd-python.sh picks the agentd Python (AGENTD_PYTHON, else a venv).
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec python3 -I "$repo/tools/qa/gate.py" --profile host --checkout "$repo"
