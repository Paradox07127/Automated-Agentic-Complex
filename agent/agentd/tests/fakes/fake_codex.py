"""Stand-in for `codex app-server` (JSON-RPC lines on stdio, no "jsonrpc" field) in tests.

"慢" streams deltas until turn/interrupt; "写文件" sends a commandExecution approval request first."""
import json
import queue
import sys
import threading

inbox, replies = queue.Queue(), queue.Queue()
state = {"turn": 0, "thread": None}


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def read():
    for line in sys.stdin:
        msg = json.loads(line)
        (replies if "method" not in msg else inbox).put(msg)
    inbox.put(None)


def complete(thread, turn, status, text):
    if text:
        emit({"method": "item/completed", "params": {"threadId": thread, "turnId": turn, "item": {
            "type": "agentMessage", "id": "m1", "text": text, "phase": "final_answer"}}})
    emit({"method": "turn/completed", "params": {"threadId": thread, "turn": {
        "id": turn, "status": status, "items": [], "error": None}}})


def run_turn(thread, turn, text):
    emit({"method": "turn/started", "params": {"threadId": thread, "turn": {"id": turn, "status": "inProgress"}}})
    if "慢" in text:
        for i in range(200):
            emit({"method": "item/agentMessage/delta", "params": {"threadId": thread, "turnId": turn,
                                                                  "itemId": "m1", "delta": f"第{i}段"}})
            try:
                msg = inbox.get(timeout=0.05)
            except queue.Empty:
                continue
            if msg and msg["method"] == "turn/interrupt":
                emit({"id": msg["id"], "result": {}})
                return complete(thread, turn, "interrupted", None)
        return complete(thread, turn, "completed", "慢慢说完了")
    if "写文件" in text:
        emit({"method": "item/started", "params": {"threadId": thread, "turnId": turn, "item": {
            "type": "commandExecution", "id": "c1", "command": "touch x.txt"}}})
        emit({"id": 100, "method": "item/commandExecution/requestApproval", "params": {
            "threadId": thread, "turnId": turn, "itemId": "c1", "startedAtMs": 0,
            "command": "touch x.txt", "cwd": ".", "reason": "needs write"}})
        decision = replies.get(timeout=30)["result"]["decision"]
        return complete(thread, turn, "completed", "已写入 x.txt" if decision == "accept" else "没有写：被拒绝了")
    emit({"method": "item/agentMessage/delta", "params": {"threadId": thread, "turnId": turn,
                                                          "itemId": "m1", "delta": f"答：{text}"}})
    complete(thread, turn, "completed", f"答：{text}")


threading.Thread(target=read, daemon=True).start()
while True:
    msg = inbox.get()
    if msg is None:
        break
    method, params = msg["method"], msg.get("params") or {}
    if method == "initialize":
        emit({"id": msg["id"], "result": {"userAgent": "fake", "codexHome": "/tmp"}})
    elif method in ("thread/start", "thread/resume"):
        state["thread"] = params.get("threadId") or "thr-1"
        if method == "thread/start":
            assert (params["sandbox"], "approvalPolicy" in params) == ("read-only", False), params
        emit({"id": msg["id"], "result": {"thread": {"id": state["thread"]}}})
    elif method == "turn/start":
        state["turn"] += 1
        turn = f"turn-{state['turn']}"
        emit({"id": msg["id"], "result": {"turn": {"id": turn, "status": "inProgress"}}})
        run_turn(params["threadId"], turn, params["input"][0]["text"])
