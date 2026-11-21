#!/usr/bin/env python3
"""Manual-grant acceptance against ControlFixture.app only; no permission automation or user data."""
import argparse
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agent" / "agentd"))
from tool_gateway.computer_use import ComputerControlClient, ComputerControlConfig, ComputerUseError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--support-dir", required=True, type=Path)
    parser.add_argument("--session", default="own:control-acceptance")
    parser.add_argument("--exercise-fixture", action="store_true", help="Write synthetic text and press the fixture button, after manual task grants")
    args = parser.parse_args()
    run = args.support_dir / "run"
    client = ComputerControlClient(ComputerControlConfig(str(run / "computer-control.sock"), str(run / "computer-control.token")), args.session, allow_control=args.exercise_fixture)
    target = {"bundle_id": "local.agenticcomplex.controlfixture"}
    checks = []

    def emit(name, **fields):
        checks.append({"check": name, **fields})
        print(json.dumps(checks[-1], ensure_ascii=False), flush=True)

    def observe():
        return client.call("desktop_observe", {"target": target, "include_text": True})

    def unique(snapshot, predicate):
        candidates = [e for e in snapshot["elements"] if predicate(e)]
        if len(candidates) != 1:
            raise RuntimeError("Fixture element was missing or ambiguous; no action taken")
        return candidates[0]["element_id"]

    status = client.call("desktop_status", {"target": target})
    emit("status", enabled=status["enabled"], ax_trusted=status["ax_trusted"], windows=len(status.get("windows", [])))
    snapshot = observe()  # First run intentionally stops here if task grants have not been clicked.
    emit("observation", elements=len(snapshot["elements"]), includes_image="image" in snapshot)
    if not args.exercise_fixture:
        return 0

    field = unique(snapshot, lambda e: e["role"] == "AXTextField")
    text = "Agentic Complex synthetic acceptance 2026-10-21"
    result = client.call("desktop_act", {"snapshot_id": snapshot["snapshot_id"], "action": "set_value", "element_id": field, "text": text})
    emit("write", effect=result["effect"])
    try:
        client.call("desktop_act", {"snapshot_id": snapshot["snapshot_id"], "action": "press", "element_id": field})
        raise RuntimeError("Consumed snapshot unexpectedly remained actionable")
    except ComputerUseError as error:
        if error.code != "unknown_snapshot":
            raise
        emit("client_replay_blocked", code=error.code)
    snapshot = observe()
    field = unique(snapshot, lambda e: e["role"] == "AXTextField")
    result = client.call("desktop_verify", {"snapshot_id": snapshot["snapshot_id"], "element_id": field, "expected_value": text})
    if result.get("verified") is not True:
        raise RuntimeError("Synthetic text did not read back exactly")
    emit("text_verified", verified=True)

    time.sleep(0.3)  # Product deliberately limits effects to at most one per 250ms.
    snapshot = observe()
    button = unique(snapshot, lambda e: e["role"] == "AXButton" and e.get("title") == "执行测试")
    client.call("desktop_act", {"snapshot_id": snapshot["snapshot_id"], "action": "press", "element_id": button})
    snapshot = observe()
    label = unique(snapshot, lambda e: e["role"] == "AXStaticText" and e.get("value") == "桥已打通 · Verified")
    result = client.call("desktop_verify", {"snapshot_id": snapshot["snapshot_id"], "element_id": label, "expected_value": "桥已打通 · Verified"})
    if result.get("verified") is not True:
        raise RuntimeError("Fixture button effect did not read back")
    emit("button_verified", verified=True)
    client.call("desktop_cancel", {})
    emit("cancelled", granted=client.call("desktop_status", {}).get("session_granted"))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ComputerUseError as error:
        print(json.dumps({"blocked": error.code, "message": error.message}, ensure_ascii=False))
        raise SystemExit(2)
