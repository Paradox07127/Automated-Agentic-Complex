#!/bin/bash
# Usage: [AGENTD_PYTHON=<path>] tools/platform/agentd-python.sh  — prints the Python that runs agentd.
# Order: a non-empty AGENTD_PYTHON, this checkout's agent/.venv, then the main checkout's (a worktree has none).
set -u
[ -n "${AGENTD_PYTHON:-}" ] && { echo "$AGENTD_PYTHON"; exit 0; }
checkout="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -x "$checkout/agent/.venv/bin/python" ] && { echo "$checkout/agent/.venv/bin/python"; exit 0; }
main="$(dirname "$(git -C "$checkout" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")"
[ -x "$main/agent/.venv/bin/python" ] && { echo "$main/agent/.venv/bin/python"; exit 0; }
echo "agentd-python: no agent/.venv in $checkout or $main; set AGENTD_PYTHON" >&2
exit 1
