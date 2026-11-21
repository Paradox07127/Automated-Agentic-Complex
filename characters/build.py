#!/usr/bin/env python3
"""Run one character build tool: python3 -I characters/build.py <tool> [args...]."""
from pathlib import Path
import runpy
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
if len(sys.argv) < 2:
    sys.exit('usage: build.py <tool> [args...]')
tool = sys.argv.pop(1)
runpy.run_module('agentic_complex_build.' + tool, run_name='__main__', alter_sys=True)
