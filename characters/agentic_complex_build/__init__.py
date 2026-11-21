"""Offline character build tools. Run one as `python3 -I characters/build.py <tool> [args...]`.

Importing the package puts the source roots of the tools' dependencies on sys.path; no module edits it again.
"""
from pathlib import Path
import sys
from typing import NamedTuple


class Roots(NamedTuple):
    agentd: str = 'agent/agentd'
    native_bundle: str = 'characters/packaging'


REPO = Path(__file__).resolve().parents[2]
ROOTS = Roots()
sys.path[:0] = [str(REPO/root) for root in ROOTS if str(REPO/root) not in sys.path]
