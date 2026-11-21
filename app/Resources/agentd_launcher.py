#!/usr/bin/env python3
"""Run agentd in this process and end it with the parent Companion.

usage: agentd_launcher.py --agentd-dir D [--parent-pid P] -- <agentd arguments>
Without --parent-pid nothing is watched (C9: `-- --describe`, or agentd run by hand). With it, agentd's
infra.platform.watch_parent ends agentd with the parent; on Windows closing agentd's stdin also stops it.
"""
import argparse
import os
import signal
import sys


def main():
    argv = sys.argv[1:]
    if "--" not in argv:
        sys.exit(__doc__)
    split = argv.index("--")
    parser = argparse.ArgumentParser()
    parser.add_argument("--agentd-dir", required=True)
    parser.add_argument("--parent-pid", type=int)
    args = parser.parse_args(argv[:split])
    if args.parent_pid is not None and os.getppid() != args.parent_pid:
        os._exit(0)
    sys.path.insert(0, args.agentd_dir)
    if args.parent_pid is not None:
        from infra.platform import watch_parent
        # agentd shuts down cleanly on SIGTERM, which on Windows only a raise inside the process delivers.
        watch_parent(args.parent_pid, lambda: signal.raise_signal(signal.SIGTERM))
    sys.argv = [args.agentd_dir + "/server.py"] + argv[split + 1:]
    import server
    server.main()


if __name__ == "__main__":
    main()
