"""Write or check every file generated from the protocol registries.

usage: python3 -I protocol/tools/gen_all.py --write | --check
"""
from pathlib import Path
import subprocess
import sys

TOOLS = Path(__file__).resolve().parent
GENERATORS = ("gen_plugins.py", "gen_routes.py", "gen_bridge.py", "gen_c12.py", "gen_render_table.py", "gen_event_pools.py")


def main(argv):
    if argv not in (["--write"], ["--check"]):
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    codes = [subprocess.run([sys.executable, "-I", str(TOOLS / name), argv[0]]).returncode for name in GENERATORS]
    return 1 if any(codes) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
