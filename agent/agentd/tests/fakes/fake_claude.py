"""Stand-in for `claude -p --input-format stream-json --output-format stream-json` in tests.

"慢" streams until interrupted; "写文件" asks agentd's PermissionRequest hook from --settings first."""
import json
import queue
import sys
import threading
import time
import urllib.request

args = sys.argv[1:]
session = args[args.index("--resume") + 1] if "--resume" in args else f"fake-{int(time.time() * 1000)}"
settings = json.load(open(args[args.index("--settings") + 1], encoding="utf-8")) if "--settings" in args else {}
inbox = queue.Queue()


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def read():
    for line in sys.stdin:
        inbox.put(json.loads(line))
    inbox.put(None)


def ask_permission():
    hook = settings["hooks"]["PermissionRequest"][0]["hooks"][0]
    body = json.dumps({"hook_event_name": "PermissionRequest", "session_id": session, "cwd": ".",
                       "tool_name": "Write", "tool_input": {"file_path": "x.txt", "content": "hi"}}).encode()
    request = urllib.request.Request(hook["url"], data=body, headers={**hook["headers"],
                                                                      "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=hook["timeout"]) as response:
        decision = json.loads(response.read() or b"{}")
    return decision.get("hookSpecificOutput", {}).get("decision", {}).get("behavior", "deny")


def result(text, reason="completed"):
    emit({"type": "result", "subtype": "success", "is_error": False, "result": text,
          "session_id": session, "terminal_reason": reason})


threading.Thread(target=read, daemon=True).start()
while True:
    message = inbox.get()
    if message is None:
        break
    if message.get("type") != "user":
        continue
    text = message["message"]["content"]
    emit({"type": "system", "subtype": "init", "session_id": session})
    if "慢" in text:
        interrupted = False
        for i in range(200):
            emit({"type": "assistant", "message": {"content": [{"type": "text", "text": f"第{i}段"}]}})
            try:
                control = inbox.get(timeout=0.05)
            except queue.Empty:
                continue
            if control and control.get("type") == "control_request":
                emit({"type": "control_response", "response": {"subtype": "success",
                                                               "request_id": control["request_id"]}})
                interrupted = True
                break
        result("", "aborted_streaming" if interrupted else "completed")
    elif "写文件" in text:
        emit({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Write", "input": {"file_path": "x.txt", "content": "hi"}}]}})
        behavior = ask_permission()
        result("已写入 x.txt" if behavior == "allow" else "没有写：被拒绝了")
    else:
        emit({"type": "assistant", "message": {"content": [{"type": "text", "text": f"答：{text}"}]}})
        result(f"答：{text}")
