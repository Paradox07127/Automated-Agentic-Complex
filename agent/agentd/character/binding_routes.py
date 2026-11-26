"""GET /characters/<id>/binding."""
from route_registry import CHARACTER_BINDING_PATH


def route(h, method, path):
    match = CHARACTER_BINDING_PATH.fullmatch(path)
    if match is None:
        return False
    cid, bindings = match[1], getattr(h.server, "bindings", None)
    if bindings is None:  # agentd answers HTTP before main() builds the bindings
        h.json(503, {"error": "no_bindings"})
    else:
        try:
            reply = bindings.effective(cid)
        except ValueError:
            h.json(404, {"error": "unknown_character"})
        else:
            h.json(200, reply)
    return True
