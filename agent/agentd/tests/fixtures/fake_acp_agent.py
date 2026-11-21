#!/usr/bin/env python3
"""Scripted ACP v1 agent for test_acp_runner.py; stdout is ACP JSON-RPC only.

FAKE_ACP_SCRIPT picks the prompt turn (normal, cancel, exit, fs, permissions, edit, own_tool, json, thought, echo).
json answers one JSON object, after calling observation_image when the bridge lists it.
FAKE_ACP_SYSTEM_PROMPT is append (default), override or none.
FAKE_ACP_SESSION is model (default: a model config option), levels (model, mode and
thought_level config options), modes (no config options, session modes only) or dsh (DeepSeek
Harness's grouped models with JSON-string values and off/low/high/max effort).
FAKE_ACP_CLOSE=1 declares sessionCapabilities.close.
FAKE_ACP_LOG names a JSON-lines file that records what the agent received.
FAKE_ACP_GRANDCHILD=1 starts, with session/new, a process that holds a file open in the session cwd and
appends to <FAKE_ACP_LOG>.beat every 50 ms for 30 s.
"""
import json
import os
import subprocess
import sys
import threading

SCRIPT = os.environ.get("FAKE_ACP_SCRIPT", "normal")
SYSTEM_PROMPT = os.environ.get("FAKE_ACP_SYSTEM_PROMPT", "append")
SESSION = os.environ.get("FAKE_ACP_SESSION", "model")
CLOSE = os.environ.get("FAKE_ACP_CLOSE") == "1"
LOG = os.environ.get("FAKE_ACP_LOG")
GRANDCHILD = os.environ.get("FAKE_ACP_GRANDCHILD") == "1"
BEAT = ("import sys, time\nheld = open('held.txt', 'w')\nfor _ in range(600):\n"
        "    with open(sys.argv[1], 'a') as beat:\n        beat.write('.')\n    time.sleep(.05)\n")

write_lock = threading.Lock()
waiting = {}
cancelled = threading.Event()
state = {"next_id": 100, "mcp": None, "tools": [], "session": "sess_fake", "options": []}
PERMISSION_OPTIONS = [{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                      {"optionId": "allow-always", "name": "Always allow", "kind": "allow_always"},
                      {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"},
                      {"optionId": "reject-always", "name": "Always reject", "kind": "reject_always"}]
PERMISSION_CALLS = [
    {"toolCallId": "call_exec", "title": "ls -la", "kind": "execute"},
    {"toolCallId": "call_edit", "title": "Edit notes.txt", "kind": "edit",
     "locations": [{"path": "/work/notes.txt", "line": 3}], "rawInput": {"path": "/work/notes.txt", "new_text": "hi"}},
    {"toolCallId": "call_other", "title": "Do something"}]


def select(option_id, name, category, values, current):
    return {"id": option_id, "name": name, "category": category, "type": "select", "currentValue": current,
            "options": [{"value": value, "name": value.title()} for value in values]}


def session_options():
    model = {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "fake-small",
             "options": [{"group": "all", "name": "All", "options": [
                 {"value": "fake-small", "name": "Small"}, {"value": "fake-large", "name": "Large"}]}]}
    if SESSION == "dsh":
        flash, pro = (json.dumps(["deepseek-official", name], separators=(",", ":"))
                      for name in ("deepseek-v4-flash", "deepseek-v4-pro"))
        return [{"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": flash,
                 "options": [{"group": "deepseek-official", "name": "DeepSeek", "options": [
                     {"value": flash, "name": "deepseek-v4-flash"}, {"value": pro, "name": "deepseek-v4-pro"}]}]},
                select("reasoning_effort", "Reasoning effort", "thought_level", ["off", "low", "high", "max"], "high")]
    if SESSION == "levels":
        return [model, select("mode", "Mode", "mode", ["default", "plan"], "default"),
                select("effort", "Effort", "thought_level", ["low", "medium", "high"], "medium")]
    return [] if SESSION == "modes" else [model]


def log(event, **fields):
    if LOG:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"event": event, **fields}) + "\n")


def send(message):
    with write_lock:
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")
        sys.stdout.flush()


def request(method, params):
    with write_lock:
        state["next_id"] += 1
        request_id = state["next_id"]
    event = threading.Event()
    waiting[request_id] = [event, None]
    send({"id": request_id, "method": method, "params": params})
    event.wait(10)
    return waiting.pop(request_id)[1]


def update(body):
    send({"method": "session/update", "params": {"sessionId": state["session"], "update": body}})


def chunk(text):
    update({"sessionUpdate": "agent_message_chunk", "messageId": "msg_1", "content": {"type": "text", "text": text}})


class Mcp:
    def __init__(self, server):
        env = {**os.environ, **{e["name"]: e["value"] for e in server.get("env", [])}}
        self.proc = subprocess.Popen([server["command"], *server["args"]], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, env=env)
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

    def notify(self, method):
        self.proc.stdin.write((json.dumps({"jsonrpc": "2.0", "method": method}) + "\n").encode())
        self.proc.stdin.flush()


def call_tool(arguments):
    name = state["tools"][0]["name"] if state["tools"] else "missing"
    reply = state["mcp"].call("tools/call", {"name": name, "arguments": arguments})
    log("tool_result", name=name, reply=reply)
    return reply


def turn(request_id, params):
    text = "".join(block.get("text", "") for block in params.get("prompt", []) if block.get("type") == "text")
    log("prompt", text=text)
    stop = "end_turn"
    if SCRIPT == "normal":
        chunk("Hello ")
        update({"sessionUpdate": "tool_call", "toolCallId": "call_1", "title": "Reading the fixture",
                "name": state["tools"][0]["name"] if state["tools"] else None, "kind": "read", "status": "pending"})
        call_tool({"path": "notes.txt"})
        update({"sessionUpdate": "tool_call_update", "toolCallId": "call_1", "status": "completed"})
        update({"sessionUpdate": "tool_call", "toolCallId": "call_2", "title": "rm -rf build", "kind": "execute",
                "status": "pending"})
        answer = request("session/request_permission", {"sessionId": state["session"],
            "toolCall": {"toolCallId": "call_2", "title": "rm -rf build", "kind": "execute"},
            "options": [{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                        {"optionId": "allow-always", "name": "Always allow", "kind": "allow_always"},
                        {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}]})
        log("permission", answer=answer)
        update({"sessionUpdate": "tool_call_update", "toolCallId": "call_2", "status": "failed"})
        update({"sessionUpdate": "plan", "entries": [
            {"content": "Read the notes", "priority": "high", "status": "completed"},
            {"content": "Answer", "priority": "medium", "status": "in_progress"}]})
        update({"sessionUpdate": "usage_update", "used": 10, "size": 100})
        chunk("world")
    elif SCRIPT == "cancel":
        chunk("Working")
        call_tool({"path": "slow"})
        log("cancel_seen", seen=cancelled.wait(5))
        chunk(" late text")
        stop = "cancelled"
    elif SCRIPT == "exit":
        chunk("partial")
        os._exit(3)
    elif SCRIPT == "fs":
        log("fs_reply", reply=request("fs/read_text_file", {"sessionId": state["session"], "path": "/etc/hosts"}))
        log("terminal_reply", reply=request("terminal/create", {"sessionId": state["session"], "command": "ls"}))
        chunk("no files")
    elif SCRIPT == "permissions":
        for call in PERMISSION_CALLS:
            answer = request("session/request_permission", {"sessionId": state["session"], "toolCall": call,
                                                            "options": PERMISSION_OPTIONS})
            log("permission", tool=call["toolCallId"], answer=answer)
        chunk("done")
    elif SCRIPT == "edit":
        answer = request("session/request_permission", {"sessionId": state["session"], "toolCall": PERMISSION_CALLS[1],
                                                        "options": PERMISSION_OPTIONS})
        log("permission", tool="call_edit", answer=answer)
        chunk("edited")
    elif SCRIPT == "own_tool":
        # claude-agent-acp asks for the bridge's own tools as mcp__<server>__<tool> with no kind.
        call = {"toolCallId": "call_own", "title": f"mcp__agentic_complex__{state['tools'][0]['name']}",
                "rawInput": {"path": "notes.txt"}}
        answer = request("session/request_permission", {"sessionId": state["session"], "toolCall": call,
                                                        "options": PERMISSION_OPTIONS})
        log("permission", tool="call_own", answer=answer)
        chunk("used")
    elif SCRIPT == "json":
        if any(t["name"] == "observation_image" for t in state["tools"]):
            reply = state["mcp"].call("tools/call", {"name": "observation_image", "arguments": {}})
            log("tool_result", name="observation_image", reply=reply)
        chunk('{"description": "a terminal window"}')
    elif SCRIPT == "thought":
        update({"sessionUpdate": "agent_thought_chunk", "messageId": "thought_1",
                "content": {"type": "text", "text": "Checking the notes"}})
        chunk("Answer")
        send({"id": request_id, "result": {"stopReason": stop, "usage": {
            "totalTokens": 30, "inputTokens": 12, "outputTokens": 8, "thoughtTokens": 3,
            "cachedReadTokens": 7, "cachedWriteTokens": 3}}})
        return
    else:
        chunk("echo")
    send({"id": request_id, "result": {"stopReason": stop}})


def handle(message):
    method, params, request_id = message.get("method"), message.get("params") or {}, message.get("id")
    if method == "initialize":
        log("initialize", params=params)
        session = {} if SYSTEM_PROMPT == "none" else {"systemPrompt": {}} if SYSTEM_PROMPT == "append" else \
            {"systemPrompt": {"mode": {"override": {}}}}
        if CLOSE:
            session["close"] = {}
        send({"id": request_id, "result": {"protocolVersion": 1,
            "agentCapabilities": {"loadSession": False, "sessionCapabilities": session},
            "agentInfo": {"name": "fake-acp", "title": "Fake ACP", "version": "0.1.0"},
            "authMethods": [{"id": "fake-login", "name": "Fake login"}]}})
    elif method == "session/new":
        log("session_new", params=params)
        if GRANDCHILD:
            subprocess.Popen([sys.executable, "-I", "-B", "-c", BEAT, LOG + ".beat"], cwd=params["cwd"],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        state["mcp"] = Mcp(params["mcpServers"][0])
        state["mcp"].call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                         "clientInfo": {"name": "fake-acp", "version": "0.1.0"}})
        state["mcp"].notify("notifications/initialized")
        state["tools"] = state["mcp"].call("tools/list")["result"]["tools"]
        log("tools", tools=state["tools"])
        state["options"] = session_options()
        result = {"sessionId": state["session"], "configOptions": state["options"]}
        if SESSION == "modes":
            result = {"sessionId": state["session"], "modes": {"currentModeId": "default", "availableModes": [
                {"id": "default", "name": "Default"}, {"id": "plan", "name": "Plan"}]}}
        send({"id": request_id, "result": result})
    elif method == "session/set_config_option":
        log("set_config_option", params=params)
        for option in state["options"]:
            if option["id"] == params.get("configId"):
                option["currentValue"] = params.get("value")
        send({"id": request_id, "result": {"configOptions": state["options"]}})
    elif method == "session/set_mode":
        log("set_mode", params=params)
        send({"id": request_id, "result": {}})
    elif method == "session/close":
        log("session_close", params=params)
        send({"id": request_id, "result": {}})
    elif method == "session/prompt":
        cancelled.clear()
        threading.Thread(target=turn, args=(request_id, params), daemon=True).start()
    elif method == "session/cancel":
        log("session_cancel", params=params)
        cancelled.set()
    elif request_id is not None and method is None and request_id in waiting:
        waiting[request_id][1] = message
        waiting[request_id][0].set()
    elif request_id is not None and method is not None:
        send({"id": request_id, "error": {"code": -32601, "message": "Method not found"}})


def main():
    for line in sys.stdin:
        handle(json.loads(line))


if __name__ == "__main__":
    main()
