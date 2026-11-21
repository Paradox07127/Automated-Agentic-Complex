#!/usr/bin/env python3
"""Install a registry ACP agent's npm or uv package globally, the same command settings run.

Usage: python3 -I tools/acp/install_agent.py <agent-id> [--print]
--print  prints the command without running it. Stdlib only.
"""
import argparse
from pathlib import Path
import shlex
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent" / "agentd"))
from character_agent.harness import acp_agents  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("agent_id")
    parser.add_argument("--print", action="store_true", dest="print_only")
    args = parser.parse_args(argv)
    try:
        command = acp_agents.install_command(args.agent_id)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1
    if args.print_only:
        print(shlex.join(command))
        return 0
    result = acp_agents.install(args.agent_id)
    sys.stdout.write(result["output_tail"])
    print(f"{shlex.join(command)}: exit {result['exit']}", file=sys.stderr)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
