#!/bin/bash
# Canonical single-app release; all defaults come from the release profile release.py picks.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Ignores AGENTD_PYTHON: release.py builds from this venv's python and site-packages.
exec "$(AGENTD_PYTHON= bash "$repo/tools/platform/agentd-python.sh")" -I "$repo/tools/release/release.py" "$@"
