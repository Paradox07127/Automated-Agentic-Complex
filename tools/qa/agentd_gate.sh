#!/bin/bash
# Usage: agentd_gate.sh <checkout> <log dir> [jobs]
# The agentd profile of tools/qa/suites.json, run by the gate.py beside this script: agent/agentd/tests one module per
# process, <jobs> (default 6) at once; the tests bind no fixed port and keep their state in temp dirs. Prints the summed
# "Ran" count, `receipt: <path>`, then GATE PASS or GATE FAIL with the failing modules.
set -euo pipefail
(( $# == 2 || $# == 3 )) || { echo 'usage: agentd_gate.sh <checkout> <log dir> [jobs]' >&2; exit 2; }
repo=$(cd "$1" && pwd); mkdir -p "$2"; L=$(cd "$2" && pwd)
exec python3 -I "$(dirname "${BASH_SOURCE[0]}")/gate.py" --profile agentd --checkout "$repo" --logs "$L" --jobs "${3:-6}"
