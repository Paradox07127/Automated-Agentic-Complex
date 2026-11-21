#!/usr/bin/env python3
"""Scripted stand-in for `claude -p --input-format stream-json --output-format stream-json`; stdout is stream-json only.

It starts the --mcp-config server, sends system/init (model claude-fake-1, the MCP tools, plus FAKE_CLAUDE_EXTRA_TOOLS
comma-separated) and answers control requests. FAKE_CLAUDE_SCRIPT picks the turn:
normal  streams "Hello ", calls the first MCP tool as toolu_1, streams "world", then a result with usage and cost;
auth    the CLI's authentication_failed notice and an is_error result;
rate    the CLI's rate_limit notice and an is_error result with api_error_status 429;
permission  asks the --permission-prompt-tool about a Bash call and answers with the behavior it returned.
FAKE_CLAUDE_LOG names a JSON-lines file that records argv and cwd, the MCP tool replies and each stdin message.
"""
import json
import os
import subprocess
import sys
import threading

SCRIPT = os.environ.get("FAKE_CLAUDE_SCRIPT", "normal")
LOG = os.environ.get("FAKE_CLAUDE_LOG")
EXTRA_TOOLS = [name for name in os.environ.get("FAKE_CLAUDE_EXTRA_TOOLS", "").split(",") if name]
SESSION = "11111111-2222-3333-4444-555555555555"
write_lock = threading.Lock()
state = {"mcp": None, "tools": [], "costs": 0.0}


def log(event, **fields):
    if LOG:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"event": event, **fields}) + "\n")


def send(message):
    with write_lock:
        sys.stdout.write(json.dumps({**message, "session_id": SESSION}) + "\n")
        sys.stdout.flush()


def stream(event):
    send({"type": "stream_event", "event": event, "parent_tool_use_id": None, "uuid": os.urandom(8).hex()})


def assistant(message_id, content, **extra):
    send({"type": "assistant", "message": {"id": message_id, "type": "message", "role": "assistant",
          "model": extra.pop("model", "claude-fake-1"), "content": content}, "parent_tool_use_id": None, **extra})


def text_message(message_id, text, stop=True):
    stream({"type": "message_start", "message": {"id": message_id, "model": "claude-fake-1", "content": []}})
    stream({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
    stream({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}})
    stream({"type": "content_block_stop", "index": 0})
    assistant(message_id, [{"type": "text", "text": text}])
    if stop:
        stream({"type": "message_delta", "delta": {"stop_reason": "end_turn"}})
        stream({"type": "message_stop"})


class Mcp:
    def __init__(self, server):
        self.proc = subprocess.Popen([server["command"], *server["args"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     env={**os.environ, **server.get("env", {})})
        self.next_id = 0

    def call(self, method, params=None):
        self.next_id += 1
        self.proc.stdin.write((json.dumps({"jsonrpc": "2.0", "id": self.next_id, "method": method,
                                           "params": params or {}}) + "\n").encode())
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            if not line:
                return None
            message = json.loads(line)
            if message.get("id") == self.next_id:
                return message


def result(**fields):
    state["costs"] += 0.002
    send({"type": "result", "subtype": "success", "is_error": False, "duration_ms": 10, "num_turns": 2,
          "stop_reason": "end_turn", "total_cost_usd": state["costs"],
          "usage": {"input_tokens": 12, "output_tokens": 8, "cache_read_input_tokens": 7,
                    "cache_creation_input_tokens": 3, "service_tier": "standard"},
          "modelUsage": {"claude-fake-1": {"inputTokens": 12, "outputTokens": 8}}, **fields})


def turn(prompt):
    if SCRIPT == "normal":
        text_message("msg_1", "Hello ", stop=False)
        name = state["tools"][0]["name"] if state["tools"] else "missing"
        call = {"type": "tool_use", "id": "toolu_1", "name": "mcp__agentic_complex__" + name, "input": {"path": "notes.txt"}}
        stream({"type": "content_block_start", "index": 1, "content_block": {**call, "input": {}}})
        stream({"type": "content_block_delta", "index": 1,
                "delta": {"type": "input_json_delta", "partial_json": json.dumps(call["input"])}})
        stream({"type": "content_block_stop", "index": 1})
        assistant("msg_1", [call])
        stream({"type": "message_delta", "delta": {"stop_reason": "tool_use"}})
        stream({"type": "message_stop"})
        reply = state["mcp"].call("tools/call", {"name": name, "arguments": call["input"]})
        log("tool_result", reply=reply)
        send({"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": (reply or {}).get("result", {}).get("content")}]},
            "parent_tool_use_id": None})
        text_message("msg_2", "world")
        result(result="world")
    elif SCRIPT == "auth":
        notice = "Invalid API key · Please run /login"
        assistant("msg_err", [{"type": "text", "text": notice}], model="<synthetic>", error="authentication_failed")
        result(is_error=True, result=notice, stop_reason="stop_sequence")
    elif SCRIPT == "rate":
        notice = "API Error: Request rejected (429) · you have been rate limited"
        assistant("msg_err", [{"type": "text", "text": notice}], model="<synthetic>", error="rate_limit")
        result(is_error=True, result=notice, api_error_status=429)
    elif SCRIPT == "permission":
        argv = state["argv"]
        tool = argv[argv.index("--permission-prompt-tool") + 1].removeprefix("mcp__agentic_complex__")
        reply = state["mcp"].call("tools/call", {"name": tool, "arguments": {
            "tool_name": "Bash", "input": {"command": "ls"}, "tool_use_id": "toolu_p"}})
        log("permission_reply", reply=reply)
        behavior = json.loads(reply["result"]["content"][0]["text"])["behavior"]
        text_message("msg_1", behavior)
        result(result=behavior)


def main():
    argv = state["argv"] = sys.argv[1:]
    log("argv", argv=argv, cwd=os.getcwd())
    config = json.loads(argv[argv.index("--mcp-config") + 1])
    server = config["mcpServers"]["agentic_complex"]
    state["mcp"] = Mcp(server)
    state["mcp"].call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                     "clientInfo": {"name": "fake-claude", "version": "0.1.0"}})
    state["tools"] = state["mcp"].call("tools/list")["result"]["tools"]
    send({"type": "system", "subtype": "init", "cwd": os.getcwd(), "model": "claude-fake-1", "permissionMode": "dontAsk",
          "tools": ["mcp__agentic_complex__" + t["name"] for t in state["tools"]] + EXTRA_TOOLS,
          "mcp_servers": [{"name": "agentic_complex", "status": "connected"}], "apiKeySource": "none"})
    for line in sys.stdin:
        message = json.loads(line)
        log("stdin", message=message)
        if message.get("type") == "control_request":
            response = {"commands": [], "models": [], "pid": os.getpid(), "claude_code_version": "2.1.327-fake"} \
                if message["request"].get("subtype") == "initialize" else {}
            send({"type": "control_response", "response": {"subtype": "success", "request_id": message["request_id"],
                                                           "response": response}})
        elif message.get("type") == "user":
            threading.Thread(target=turn, args=(message["message"]["content"],), daemon=True).start()


if __name__ == "__main__":
    main()
