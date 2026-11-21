"""GET/PUT /characters/<id>/binding; live voice changes and a prompt refresh for the current character."""
from brain.outbound import OutboundBlocked
from brain.provider import chat_system
from route_registry import CHARACTER_BINDING_PATH


def route(h, method, path):
    match = CHARACTER_BINDING_PATH.fullmatch(path)
    if match is None:
        return False
    cid, bindings = match[1], getattr(h.server, "bindings", None)
    if bindings is None:  # agentd answers HTTP before main() builds the bindings
        h.json(503, {"error": "no_bindings"})
    elif method == "GET":
        try:
            reply = bindings.effective(cid)
        except ValueError:
            h.json(404, {"error": "unknown_character"})
        else:
            h.json(200, reply)
    else:
        try:
            body = h.body()
        except ValueError:
            body = None
        with h.server._switch_lock:
            try:
                was, before = bindings.voice(cid), bindings.effective(cid)
            except ValueError:
                h.json(404, {"error": "unknown_character"})
                return True
            egress = getattr(h.server, "egress", None)
            if egress is None:
                egress = getattr(h.server.mouth, "egress", None)

            def check(binding):
                chat_system(bindings.repository.load_card(cid), binding, egress)

            try:
                status, reply = bindings.update(cid, body, check=check if egress is not None else None)
            except OutboundBlocked:
                status, reply = 409, {"error": "outbound_blocked"}
            if status == 200 and cid == h.server.character:
                voice = reply["voice"]
                voice = None if voice is None else (voice["voice_id"], voice["language"])
                if voice != was:
                    h.server.character_voice_enabled = voice is not None
                    if voice is not None and h.server.speech is not None:
                        h.server.speech.character, h.server.speech.language = voice
                if (reply["motion"]["driver"], reply["persona"]["overrides"]) != \
                        (before["motion"]["driver"], before["persona"]["overrides"]) and h.server.mouth is not None:
                    h.server.mouth.refresh_system(reply)  # from the next turn
        h.json(status, reply)
    return True
