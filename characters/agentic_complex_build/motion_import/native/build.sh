#!/bin/bash
# Builds the fbx-motion tool to $1; writes nothing else.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: build.sh <output>" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
clang -std=c99 -O2 -arch arm64 -mmacosx-version-min=15.0 \
	-DUFBX_NO_SUBDIVISION -DUFBX_NO_TESSELLATION -DUFBX_NO_GEOMETRY_CACHE -DUFBX_NO_SKINNING_EVALUATION \
	-DUFBX_NO_TRIANGULATION -DUFBX_NO_INDEX_GENERATION -DUFBX_NO_FORMAT_OBJ \
	"$here/ufbx.c" "$here/fbx_motion.c" -lm -o "$1"
