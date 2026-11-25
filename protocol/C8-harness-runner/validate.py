"""Check one C8 harness-runner NDJSON frame stream (one runner process). Exit 0 when valid."""
import json
import sys

PROTOCOL_VERSION = 1
# Equals MAX_FRAME in agent/agentd/character_agent/harness/transport.py; the trailing newline counts.
MAX_FRAME = 40 * 1024 * 1024

ITEM_STATUSES = {"started", "delta", "completed"}
TYPES = {
    "any": lambda v: True,
    "str": lambda v: isinstance(v, str),
    "nonempty_str": lambda v: isinstance(v, str) and bool(v),
    "bool": lambda v: isinstance(v, bool),
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "str_or_null": lambda v: v is None or isinstance(v, str),
    "array_or_null": lambda v: v is None or isinstance(v, list),
    "object_or_null": lambda v: v is None or isinstance(v, dict),
    "str_array": lambda v: isinstance(v, list) and all(isinstance(x, str) for x in v),
    "str_array_or_null": lambda v: v is None or isinstance(v, list) and all(isinstance(x, str) for x in v),
    "permission_options": lambda v: isinstance(v, list) and all(
        isinstance(o, dict) and all(isinstance(o.get(k), str) for k in ("option_id", "name", "kind")) for o in v),
    "item_status": lambda v: isinstance(v, str) and v in ITEM_STATUSES,
    "steps": lambda v: isinstance(v, list) and all(
        isinstance(s, dict) and isinstance(s.get("text"), str) and isinstance(s.get("status"), str) for s in v),
}
# agentd -> runner; these frames carry no seq.
TO_RUNNER = {
    "init": {"config": "object", "system_prompt": "str", "tools": "array"},
    "query": {"run_id": "str", "prompt": "str", "history": "array_or_null"},
    "tool_result": {"tool_call_id": "str", "run_id": "str", "result": "any", "is_error": "bool"},
    "permission_result": {"run_id": "str", "request_id": "str", "option_id": "str_or_null"},
    "interrupt": {"run_id": "str"},
    "steer": {"run_id": "str", "steer_id": "str", "text": "nonempty_str"},
    "close": {},
    "list_models": {"runtime_dir": "str", "provider": "str_or_null"},
}
# runner -> agentd; every frame carries seq.
FROM_RUNNER = {
    "ready": {"tool_names": "str_array", "tool_inventory_verified": "bool", "model": "str", "capabilities": "object"},
    "tool_request": {"run_id": "str", "tool_call_id": "nonempty_str", "name": "str", "args": "object"},
    "text_delta": {"run_id": "str", "text": "str"},
    "item": {"run_id": "str", "item_id": "str", "kind": "str", "status": "item_status"},
    "plan": {"run_id": "str", "title": "str_or_null", "steps": "steps", "source": "str"},
    "permission_request": {"run_id": "str", "request_id": "nonempty_str", "title": "str", "kind": "str_or_null",
                           "locations": "str_array_or_null", "raw_input": "object_or_null",
                           "options": "permission_options"},
    "result": {"run_id": "str", "success": "bool", "subtype": "str"},
    "error": {"code": "str"},
    "steer_result": {"run_id": "str", "steer_id": "str", "accepted": "bool", "code": "str_or_null"},
    "models": {"providers": "array", "models": "array"},
}
OPTIONAL = {
    "query": {"ask_user_result": "object"},
    "ready": {"session_id": "str_or_null", "run_id": "str"},
    "tool_request": {"item_id": "str", "kind": "str", "status": "str"},
    "text_delta": {"item_id": "str", "kind": "str", "status": "item_status"},
    "result": {"session_id": "str"},
    "error": {"run_id": "str", "message": "str", "failure": "object"},
}
# Equals CAPABILITIES in agent/agentd/character_agent/harness/transport.py.
CAPABILITIES = {
    "cancel": ("native", "process_kill"),
    "tool_injection": ("in_process", "dynamic_tools", "mcp_stdio", "mcp_http"),
    "builtin_tools": ("disabled_verified", "unverified"),
    "system_prompt": ("native", "prompt_prefix"),
    "usage": ("usd", "tokens", "none"),
    "event_scope": ("session", "global"),
    "native_questions": (True, False),
}
# Checked when present; a ready without it is a runner that cannot steer.
OPTIONAL_CAPABILITIES = {"steer": ("native", "unsupported")}


def check(lines):
    last_seq, ready, frames = 0, False, 0
    for n, line in enumerate(lines):
        if not line.strip():
            continue
        if len(line.rstrip("\n").encode("utf-8")) + 1 > MAX_FRAME:
            return f"line {n}: frame larger than MAX_FRAME"
        try:
            frame = json.loads(line)
        except ValueError:
            return f"line {n}: not JSON"
        if not isinstance(frame, dict):
            return f"line {n}: frame is not an object"
        if frame.get("v") != PROTOCOL_VERSION or isinstance(frame.get("v"), bool):
            return f"line {n}: v must be {PROTOCOL_VERSION}"
        kind = frame.get("type")
        if kind in FROM_RUNNER:
            seq = frame.get("seq")
            if not isinstance(seq, int) or isinstance(seq, bool) or seq <= 0:
                return f"line {n}: seq must be a positive integer"
            if seq <= last_seq:
                return f"line {n}: seq must increase"
            last_seq = seq
            if not ready and kind not in ("ready", "error"):
                return f"line {n}: {kind} before ready"
            required = FROM_RUNNER[kind]
        elif kind in TO_RUNNER:
            required = TO_RUNNER[kind]
        else:
            return f"line {n}: unknown type {kind!r}"
        for key, expected in required.items():
            if key not in frame or not TYPES[expected](frame[key]):
                return f"line {n}: {kind}.{key} missing or not {expected}"
        for key, expected in OPTIONAL.get(kind, {}).items():
            if key in frame and not TYPES[expected](frame[key]):
                return f"line {n}: {kind}.{key} not {expected}"
        if kind == "ready":
            err = check_capabilities(frame["capabilities"])
            if err:
                return f"line {n}: {err}"
            ready = True
        frames += 1
    return None if frames else "stream has no frames"


def check_capabilities(capabilities):
    for key, allowed in CAPABILITIES.items():
        if key not in capabilities:
            return f"capabilities.{key} missing"
        value = capabilities[key]
        valid = isinstance(value, bool) if key == "native_questions" else isinstance(value, str) and value in allowed
        if not valid:
            return f"capabilities.{key} must be one of {', '.join(map(json.dumps, allowed))}"
    for key, allowed in OPTIONAL_CAPABILITIES.items():
        if key in capabilities and capabilities[key] not in allowed:
            return f"capabilities.{key} must be one of {', '.join(map(json.dumps, allowed))}"
    return None


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        err = check(f.readlines())
    if err:
        print(err)
    sys.exit(1 if err else 0)
