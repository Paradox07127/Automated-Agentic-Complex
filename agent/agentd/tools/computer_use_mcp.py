#!/usr/bin/env python3
"""Session-scoped MCP stdio facade for Companion native desktop control. Stdout is JSON-RPC only."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tool_gateway.computer_use import ComputerControlConfig, ComputerUseError, MAX_REQUEST, mcp_result
from tool_gateway import desktop
from tool_gateway.ledger import EffectLedger
from tool_gateway.registry import REGISTRY


def open_ledger(path):
    """The receipts ledger, or None after a stderr diagnostic: desktop_act still runs without one."""
    try:
        return EffectLedger.open(path)
    except sqlite3.Error as e:
        print(f"desktop_act receipts are not recorded: {e}", file=sys.stderr)
        return None


def settle(ledger, effect_id, state, receipt):
    try:
        ledger.settle(effect_id, state, receipt)
    except sqlite3.Error as e:
        print(f"desktop_act receipt {effect_id} is not recorded: {e}", file=sys.stderr)


def act(client, ledger, args):
    """desktop_act between prepare and settle, under the same receipt rule as character runs."""
    run_id = "own:" + client.session_id
    effect_id = f"{run_id}:{uuid.uuid4()}"
    if ledger is not None:
        digest = hashlib.sha256(json.dumps(args, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()
        try:
            ledger.prepare(effect_id, run_id, "desktop_act", digest)
        except sqlite3.Error as e:
            print(f"desktop_act receipts are not recorded: {e}", file=sys.stderr)
            ledger = None
    if ledger is None:
        return client.call("desktop_act", args)
    try:
        value = client.call("desktop_act", args)
    except Exception:
        settle(ledger, effect_id, "unknown", {"effect": "unknown"})
        raise
    receipt = {"effect": value.get("effect", "unknown"), "tool": "desktop_act"}
    settle(ledger, effect_id, "committed" if receipt["effect"] == "confirmed" else "unknown", receipt)
    return value


def serve(client, source=sys.stdin.buffer, output=sys.stdout, ledger=None):
    while True:
        line = source.readline(MAX_REQUEST + 1)
        if not line:
            return
        request_id = None
        try:
            if len(line) > MAX_REQUEST or not line.endswith(b"\n"):
                return  # refuse an oversized frame rather than accepting its tail as another request
            message = json.loads(line)
            if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
                raise ValueError("invalid request")
            request_id = message.get("id")
            method = message.get("method")
            if method in ("notifications/initialized", "notifications/cancelled") or request_id is None:
                continue
            if method == "initialize":
                result = {"protocolVersion": (message.get("params") or {}).get("protocolVersion", "2024-11-05"),
                          "capabilities": {"tools": {}}, "serverInfo": {"name": "agentic-complex-desktop", "version": "1"}}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": REGISTRY.mcp_tools("own_session")}
            elif method == "tools/call":
                params = message.get("params") or {}
                name, arguments = params.get("name"), params.get("arguments", {})
                try:
                    result = mcp_result(act(client, ledger, arguments) if name == "desktop_act"
                                        else client.call(name, arguments))
                except ComputerUseError as e:
                    result = {"isError": True, "content": [{"type": "text", "text": json.dumps(
                        {"error": {"code": e.code, "message": e.message}, "retryable": False}, ensure_ascii=False)}]}
            else:
                output.write(json.dumps({"jsonrpc": "2.0", "id": request_id,
                                         "error": {"code": -32601, "message": "Method not found"}}) + "\n")
                output.flush()
                continue
            response = {"jsonrpc": "2.0", "id": request_id, "result": result}
        except (ValueError, TypeError, AttributeError):
            response = {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32600, "message": "Invalid request"}}
        output.write(json.dumps(response, ensure_ascii=False) + "\n")
        output.flush()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--mode", choices=("read_only", "workspace_write"), default="read_only")
    parser.add_argument("--ledger")
    args = parser.parse_args()
    client = desktop.session_client(ComputerControlConfig(args.socket, args.token_file), args.session_id, args.mode)
    serve(client, ledger=open_ledger(args.ledger) if args.ledger else None)


if __name__ == "__main__":
    main()
