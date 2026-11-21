#!/usr/bin/env python3
"""agentd_launcher.py with faults, for the headless e2e gate; same argv as agentd_launcher.py.

Faults: $E2E_AGENTD_FAULTS names a JSON file mapping a launch number ("1", "2", ...) or "*" to
{"recovery_wait_file", "bind_late_s", "exit_status", "after_s"}. Each launch appends a line to
<state-dir>/e2e-agentd-launches.jsonl. agentd always gets --ledger-root <state-dir>/ledger.
"""
import json
import os
from pathlib import Path
import runpy
import sys
import time

LAUNCHER = Path(__file__).resolve().parents[3] / "Resources/agentd_launcher.py"


def option(argv, name):
    return argv[argv.index(name) + 1]


def launch_faults(state):
    with open(state / "e2e-agentd-launches.jsonl", "a+") as f:
        f.seek(0)
        number = len(f.readlines()) + 1
        f.write(json.dumps({"launch": number, "pid": os.getpid()}) + "\n")
    path = os.environ.get("E2E_AGENTD_FAULTS")
    if not path or not os.path.exists(path):
        return {}
    faults = json.loads(Path(path).read_text())
    return faults.get(str(number), faults.get("*", {}))


def main():
    split = sys.argv.index("--")
    agentd_dir, agentd_args = option(sys.argv[:split], "--agentd-dir"), sys.argv[split + 1:]
    state = Path(option(agentd_args, "--state-dir"))
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    (state / "ledger").mkdir(mode=0o700, exist_ok=True)
    faults = launch_faults(state)
    if "exit_status" in faults:
        time.sleep(faults.get("after_s", 0))
        os._exit(faults["exit_status"])
    time.sleep(faults.get("bind_late_s", 0))
    sys.path.insert(0, agentd_dir)
    import server
    release = faults.get("recovery_wait_file")
    if release:
        recover = server.AgentdServer.recover_tasks

        def held(self):
            while not os.path.exists(release):
                time.sleep(0.05)
            return recover(self)
        server.AgentdServer.recover_tasks = held
    sys.argv = [str(LAUNCHER)] + sys.argv[1:] + ["--ledger-root", str(state / "ledger")]
    runpy.run_path(str(LAUNCHER), run_name="__main__")


if __name__ == "__main__":
    main()
