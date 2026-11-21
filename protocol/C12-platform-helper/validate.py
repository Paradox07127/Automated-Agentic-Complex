"""Check one C12 platform-helper NDJSON session (both directions, in order) against ops.json. Exit 0 when valid."""
import base64
import binascii
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCALARS = {
    "any": lambda v: True,
    "str": lambda v: isinstance(v, str),
    "str+": lambda v: isinstance(v, str) and bool(v),
    "int": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "int+": lambda v: isinstance(v, int) and not isinstance(v, bool) and v > 0,
    "uint": lambda v: isinstance(v, int) and not isinstance(v, bool) and v >= 0,
    "num": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "bool": lambda v: isinstance(v, bool),
    "obj": lambda v: isinstance(v, dict),
    "b64": lambda v: isinstance(v, str) and _is_base64(v),
}
ENUM = re.compile(r"^enum\(([^()]+)\)$")
ARRAY = re.compile(r"^arr<(.+)>$")


def _is_base64(text):
    try:
        base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        return False
    return True


def load_spec(path=os.path.join(HERE, "ops.json")):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def type_error(value, kind, types, path):
    """None when `value` has type `kind`, else the path and the expected type."""
    if kind.endswith("?"):
        if value is None:
            return None
        kind = kind[:-1]
    if kind in SCALARS:
        return None if SCALARS[kind](value) else f"{path} not {kind}"
    enum = ENUM.match(kind)
    if enum:
        return None if isinstance(value, str) and value in enum.group(1).split("|") else f"{path} not {kind}"
    array = ARRAY.match(kind)
    if array:
        if not isinstance(value, list):
            return f"{path} not {kind}"
        for i, item in enumerate(value):
            err = type_error(item, array.group(1), types, f"{path}[{i}]")
            if err:
                return err
        return None
    if kind in types:
        if not isinstance(value, dict):
            return f"{path} not {kind}"
        return fields_error(value, types[kind].get("fields", {}), types[kind].get("optional", {}), types, path)
    return f"{path}: unknown type {kind}"


def fields_error(value, required, optional, types, path):
    for key, kind in required.items():
        if key not in value:
            return f"{path}.{key} missing"
        err = type_error(value[key], kind, types, f"{path}.{key}")
        if err:
            return err
    for key, kind in optional.items():
        if key in value:
            err = type_error(value[key], kind, types, f"{path}.{key}")
            if err:
                return err
    return None


def check_spec(spec):
    """None when ops.json is internally consistent, else the first problem."""
    types, groups, platforms = spec["types"], spec["groups"], set(spec["platforms"])

    def kinds(fields):
        return [kind for kind in fields.values()]

    def known(kind):
        kind = kind.rstrip("?")
        array = ARRAY.match(kind)
        if array:
            return known(array.group(1))
        return kind in SCALARS or bool(ENUM.match(kind)) or kind in types

    for name, shape in types.items():
        for kind in kinds(shape.get("fields", {})) + kinds(shape.get("optional", {})):
            if not known(kind):
                return f"type {name}: unknown type {kind}"
    for name, op in spec["ops"].items():
        if op.get("group") not in groups:
            return f"op {name}: unknown group"
        if not op.get("platforms") or not set(op["platforms"]) <= platforms:
            return f"op {name}: platforms"
        for section in ("params", "params_optional", "result", "result_optional"):
            for kind in kinds(op.get(section, {})):
                if not known(kind):
                    return f"op {name}: unknown type {kind}"
        for key in op.get("params_one_of", []):
            if key not in op.get("params_optional", {}):
                return f"op {name}: params_one_of key {key} is not an optional param"
        for event in op.get("events", []):
            opened = spec["events"].get(event, {})
            if name not in opened.get("after", []) + opened.get("during", []):
                return f"op {name}: event {event} does not name it in after or during"
        if set(op.get("errors", [])) & set(spec["common_errors"]):
            return f"op {name}: repeats a common error"
        if not isinstance(op.get("timeout_ms"), int) or op["timeout_ms"] <= 0:
            return f"op {name}: timeout_ms"
    for name, event in spec["events"].items():
        for op in event.get("after", []) + event.get("during", []):
            if name not in spec["ops"].get(op, {}).get("events", []):
                return f"event {name}: op {op} does not list it"
        for kind in kinds(event.get("data", {})) + kinds(event.get("data_optional", {})):
            if not known(kind):
                return f"event {name}: unknown type {kind}"
    return None


def check(lines, spec=None):
    spec = spec or load_spec()
    ops, events, types = spec["ops"], spec["events"], spec["types"]
    pending, answered, enabled = {}, set(), set()
    last_id = last_seq = 0
    hello = None
    closed = False
    for n, line in enumerate(lines):
        if not line.strip():
            continue
        if len(line.rstrip("\n").encode("utf-8")) + 1 > spec["max_line_bytes"]:
            return f"line {n}: longer than max_line_bytes"
        try:
            msg = json.loads(line)
        except ValueError:
            return f"line {n}: not JSON"
        if not isinstance(msg, dict):
            return f"line {n}: not an object"
        if msg.get("v") != spec["protocol"] or isinstance(msg.get("v"), bool):
            return f"line {n}: v must be {spec['protocol']}"
        if closed:
            return f"line {n}: message after shutdown"
        kinds = [k for k in ("op", "ok", "event") if k in msg]
        if len(kinds) != 1:
            return f"line {n}: exactly one of op, ok, event"
        if kinds[0] == "op":
            op = msg["op"]
            rid = msg.get("id")
            if not SCALARS["int+"](rid) or rid <= last_id:
                return f"line {n}: id must be a positive integer above every earlier id"
            last_id = rid
            if hello is None and op != "hello":
                return f"line {n}: {op} before the hello response"
            if op not in ops:
                return f"line {n}: unknown op {op!r}"
            params = msg.get("params")
            if not isinstance(params, dict):
                return f"line {n}: params missing or not an object"
            spec_op = ops[op]
            err = fields_error(params, spec_op.get("params", {}), spec_op.get("params_optional", {}), types, f"{op}.params")
            if err:
                return f"line {n}: {err}"
            one_of = spec_op.get("params_one_of")
            if one_of and sum(key in params for key in one_of) != 1:
                return f"line {n}: {op}.params needs exactly one of {', '.join(one_of)}"
            if op == "cancel" and params["target"] not in pending and params["target"] not in answered:
                return f"line {n}: cancel names no earlier request"
            pending[rid] = op
        elif kinds[0] == "ok":
            rid = msg.get("id")
            if rid not in pending:
                return f"line {n}: response to no outstanding request"
            op = pending.pop(rid)
            answered.add(rid)
            if hello is None and op != "hello":
                return f"line {n}: helper answered before hello"
            spec_op = ops[op]
            if msg["ok"] is True:
                err = fields_error(msg.get("result"), spec_op.get("result", {}), spec_op.get("result_optional", {}), types,
                                   f"{op}.result") if isinstance(msg.get("result"), dict) else f"{op}.result not obj"
                if err:
                    return f"line {n}: {err}"
                if op == "hello":
                    err = check_hello(msg["result"], spec)
                    if err:
                        return f"line {n}: {err}"
                    hello = msg["result"]
                elif hello["platform"] not in spec_op["platforms"] or op not in hello["ops"]:
                    return f"line {n}: {op} succeeded on {hello['platform']}, which does not support it"
                enabled.add(op)
                if op == "shutdown":
                    closed = True
            elif msg["ok"] is False:
                err = check_error(msg.get("error"), spec_op, spec["common_errors"])
                if err:
                    return f"line {n}: {op}: {err}"
                if op == "hello":
                    return f"line {n}: hello failed"
            else:
                return f"line {n}: ok must be a boolean"
        else:
            name = msg["event"]
            if hello is None:
                return f"line {n}: event before hello"
            if name not in events:
                return f"line {n}: unknown event {name!r}"
            seq = msg.get("seq")
            if not SCALARS["int+"](seq) or seq <= last_seq:
                return f"line {n}: seq must increase"
            last_seq = seq
            during = set(events[name].get("during", []))
            if during and not during & set(pending.values()):
                return f"line {n}: {name} outside a pending {' or '.join(sorted(during))}"
            if not during and not enabled & set(events[name]["after"]):
                return f"line {n}: {name} before a successful {' or '.join(events[name]['after'])}"
            data = msg.get("data")
            err = fields_error(data, events[name]["data"], events[name].get("data_optional", {}), types,
                               f"{name}.data") if isinstance(data, dict) else f"{name}.data not obj"
            if err:
                return f"line {n}: {err}"
    if hello is None:
        return "session has no hello response"
    if pending:
        return f"requests without a response: {sorted(pending)}"
    return None


def check_hello(result, spec):
    if result["protocol"] != spec["protocol"]:
        return "hello: protocol mismatch"
    for op in result["ops"]:
        if op not in spec["ops"] or result["platform"] not in spec["ops"][op]["platforms"]:
            return f"hello: lists {op}, which {result['platform']} does not support"
    for event in result["events"]:
        if event not in spec["events"]:
            return f"hello: lists unknown event {event}"
    return None


def check_error(error, spec_op, common):
    if not isinstance(error, dict):
        return "error not an object"
    if not isinstance(error.get("code"), str) or not isinstance(error.get("message"), str):
        return "error.code and error.message must be strings"
    if "retryable" in error and not isinstance(error["retryable"], bool):
        return "error.retryable not bool"
    if error["code"] not in common and error["code"] not in spec_op.get("errors", []):
        return f"error code {error['code']!r} not listed"
    return None


if __name__ == "__main__":
    loaded = load_spec()
    problem = check_spec(loaded)
    if not problem:
        with open(sys.argv[1], encoding="utf-8") as f:
            problem = check(f.readlines(), loaded)
    if problem:
        print(problem)
    sys.exit(1 if problem else 0)
