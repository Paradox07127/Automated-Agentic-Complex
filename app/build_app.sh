#!/bin/bash
# The canonical self-contained release.
set -euo pipefail
pkg="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$pkg/package_release.sh" "$@"
