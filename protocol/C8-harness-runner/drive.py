"""Drive one C8 runner through init, one query and canned tool replies."""
import argparse
import json
import math
import os
from pathlib import Path
import shlex
import subprocess
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(1, str(Path(__file__).resolve().parents[2] / "agent/agentd"))
from infra.platform import new_group_options, release_group, signal_group, track_group
from validate import FROM_RUNNER, MAX_FRAME, check


def send(proc, frame):
    line = json.dumps(frame, ensure_ascii=False, allow_nan=False) + "\n"
    problem = check([line])
    if problem:
        raise ValueError(problem)
    proc.stdin.write(line.encode("utf-8"))
    proc.stdin.flush()


def close(proc, deadline):
    try:
        # Closing must not block on a runner that stopped reading stdin.
        os.set_blocking(proc.stdin.fileno(), False)
        try:
            proc.stdin.write(b'{"v":1,"type":"close"}\n')
        except BrokenPipeError:
            pass
        for stop, grace in ((False, 1), (True, 2)):
            if stop:
                try:
                    signal_group(proc)
                except ProcessLookupError:
                    pass
            try:
                proc.wait(timeout=min(grace, max(0, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                pass
    finally:
        try:
            signal_group(proc, force=True)
        except ProcessLookupError:
            pass
        proc.wait()
        release_group(proc)
        proc.stdin.close()
        proc.stdout.close()


def drive(scenario, argv, deadline, timeout):
    for kind in ("init", "query"):
        if scenario[kind].get("type") != kind:
            raise ValueError(f"scenario.{kind}.type must be {kind}")
        problem = check([json.dumps(scenario[kind], allow_nan=False) + "\n"])
        if problem:
            raise ValueError(problem)
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, bufsize=0, **new_group_options())
    track_group(proc)
    expired = threading.Event()

    def expire():
        # Ending the runner unblocks the read or write the driver waits in.
        expired.set()
        try:
            signal_group(proc, force=True)
        except ProcessLookupError:
            pass

    timer = threading.Timer(max(0, deadline - time.monotonic()), expire)
    timer.start()
    lines, queried = [], False
    try:
        send(proc, scenario["init"])
        while True:
            raw = proc.stdout.readline(MAX_FRAME + 1)
            if not raw:
                if expired.is_set():
                    raise TimeoutError(f"timeout after {timeout:g}s")
                raise ValueError("runner exited before result")
            if len(raw) > MAX_FRAME:
                raise ValueError("frame larger than MAX_FRAME")
            if not raw.endswith(b"\n"):
                raise ValueError("frame missing trailing newline")
            lines.append(raw.decode("utf-8"))
            problem = check(lines)
            try:
                frame = json.loads(lines[-1])
            except ValueError:
                raise ValueError(problem or "not JSON") from None
            if isinstance(frame, dict) and isinstance(frame.get("type"), str):
                print(frame["type"], flush=True)
            if problem:
                raise ValueError(problem)
            kind = frame["type"]
            if kind not in FROM_RUNNER:
                raise ValueError(f"unexpected runner frame: {kind}")
            if frame.get("run_id") not in (None, scenario["query"]["run_id"]):
                raise ValueError("runner frame run_id does not match query")
            if kind == "ready" and not queried:
                send(proc, scenario["query"])
                queried = True
            elif kind == "tool_request":
                name = frame["name"]
                if name not in scenario["tool_results"]:
                    raise ValueError(f"no canned tool_result for {name}")
                reply = scenario["tool_results"][name]
                send(proc, {"v": 1, "type": "tool_result", "run_id": frame["run_id"],
                            "tool_call_id": frame["tool_call_id"],
                            "result": reply["result"], "is_error": reply["is_error"]})
            elif kind == "error":
                raise ValueError(f"runner error: {frame['code']}")
            elif kind == "result":
                return
    finally:
        timer.cancel()
        close(proc, deadline)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--script", required=True, type=Path)
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("runner", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    argv = args.runner[1:] if args.runner[:1] == ["--"] else args.runner
    if not argv:
        parser.error("runner argv required after --")
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be positive and finite")

    deadline = time.monotonic() + args.timeout
    try:
        scenario = json.loads(args.script.read_text(encoding="utf-8"))
        drive(scenario, argv, deadline, args.timeout)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"C8-DRIVE fail {error}", flush=True)
        return 1
    print(f"C8-DRIVE ok {shlex.join(argv)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
