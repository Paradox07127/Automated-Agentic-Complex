"""avatar_outfits_list and avatar_outfit: she changes her own worn appearance, layers or mod switches. Companion carries
out each `/feed` `looks` event with the calls its menu makes, so it remembers the choice the same way, and answers with
POST /avatar/looks/receipts; the tool waits for that receipt."""
from collections import OrderedDict
import secrets
import threading

from character import mod_settings_routes
from character_library import PackageError

RECEIPT_PATH = "/avatar/looks/receipts"
WAIT_S = 10.0  # C3 rule 16's set_appearance timeout
KEPT = 32  # requests a late receipt can still answer
APPEARANCE_FIELDS = ("id", "name", "kind", "desc")
LAYER_FIELDS = ("id", "name", "appearances")

OUTFITS_LIST_TOOL = {"name": "avatar_outfits_list", "description":
    "List what your current character can wear with avatar_outfit: appearances [{id, name, kind, desc}], layers "
    "[{id, name, appearances}] you can hide or show, mod_settings {appearance id: {settings: [{id, name, values, "
    "default}]}} of the appearances that have mod switches, and current {appearance, values}: what you wore and its "
    "switch values after your last avatar_outfit, or null before one.",
    "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}}

_ID = {"type": "string", "minLength": 1, "maxLength": 64}
OUTFIT_TOOL = {"name": "avatar_outfit", "description":
    "Change your own outfit when it fits the conversation: wear another appearance, hide or show layers, or set mod "
    "switches of one appearance; give at least one of appearance, layers and mods, with ids and values from "
    "avatar_outfits_list. Companion carries it out and remembers it as if the user had picked it. Returns {ok, "
    "appearance, values} (what you now wear and its switch values) once Companion is done; ok false comes with a "
    "reason (unknown_appearance, unknown_layer, unknown_mod_setting, invalid_mod_value, timeout or the renderer's "
    "own), and then do not describe the change as done.",
    "input_schema": {"type": "object", "properties": {
        "appearance": {**_ID, "description": "An appearance id to wear."},
        "layers": {"type": "object", "description": "Layer ids to hide and to show; the other layers stay as they are.",
                   "properties": {"hide": {"type": "array", "items": _ID}, "show": {"type": "array", "items": _ID}},
                   "additionalProperties": False},
        "mods": {"type": "object", "description": "Switch values of one appearance's mod settings; the switches left "
                 "out keep their value.",
                 "properties": {"appearance": _ID, "values": {"type": "object", "minProperties": 1, "maxProperties": 64,
                                "additionalProperties": {"type": "integer", "minimum": 0, "maximum": 255}}},
                 "required": ["appearance", "values"], "additionalProperties": False},
        "reason": {"type": "string", "minLength": 1, "maxLength": 200,
                   "description": "Short note on why, for the log; not spoken."}},
        "required": ["reason"], "additionalProperties": False}}


def _id(value):
    return isinstance(value, str) and 1 <= len(value) <= 64


def _values(value):
    return isinstance(value, dict) and len(value) <= 64 and all(_id(k) and type(v) is int for k, v in value.items())


def _change(args):
    """The `looks` event's change for well-formed avatar_outfit args; None for others."""
    if not isinstance(args, dict) or not set(args) <= {"appearance", "layers", "mods", "reason"} or set(args) == {"reason"} \
            or not isinstance(args.get("reason"), str) or not 1 <= len(args["reason"]) <= 200:
        return None
    change = {}
    if "appearance" in args:
        if not _id(args["appearance"]):
            return None
        change["appearance"] = args["appearance"]
    if "layers" in args:
        layers = args["layers"]
        if not isinstance(layers, dict) or not set(layers) <= {"hide", "show"}:
            return None
        hide, show = layers.get("hide", []), layers.get("show", [])
        if not all(isinstance(ids, list) and all(map(_id, ids)) for ids in (hide, show)) or not hide + show \
                or set(hide) & set(show):
            return None
        change["layers"] = {"hide": hide, "show": show}
    if "mods" in args:
        mods = args["mods"]
        if not isinstance(mods, dict) or set(mods) != {"appearance", "values"} or not _id(mods["appearance"]) \
                or not _values(mods["values"]) or not mods["values"]:
            return None
        change["mod_settings"] = {"appearance": mods["appearance"], "values": mods["values"]}
    return change


def _refusal(change, listed):
    """The reason a well-formed change does not fit the character's list; None when it fits."""
    appearances = {a["id"] for a in listed["appearances"]}
    if "appearance" in change and change["appearance"] not in appearances:
        return "unknown_appearance"
    layers = {layer["id"] for layer in listed["layers"]}
    if "layers" in change and not set(change["layers"]["hide"] + change["layers"]["show"]) <= layers:
        return "unknown_layer"
    if "mod_settings" in change:
        mods = change["mod_settings"]
        if mods["appearance"] not in appearances:
            return "unknown_appearance"
        settings = {s["id"]: s for s in listed["mod_settings"].get(mods["appearance"], {}).get("settings", [])}
        if not set(mods["values"]) <= set(settings):
            return "unknown_mod_setting"
        if any(value not in {v["value"] for v in settings[switch]["values"]} for switch, value in mods["values"].items()):
            return "invalid_mod_value"
    return None


def _receipt_ok(body):
    """{request_id, ok, reason?, appearance, values}: appearance is null while no character is shown."""
    return isinstance(body, dict) and set(body) - {"reason"} == {"request_id", "ok", "appearance", "values"} \
        and _id(body["request_id"]) and isinstance(body["ok"], bool) \
        and ("reason" not in body or isinstance(body["reason"], str) and len(body["reason"]) <= 200) \
        and (body["appearance"] is None or _id(body["appearance"])) and _values(body["values"])


class Looks:
    """The requests this process sent, the look the last receipt reported, and the waits for receipts."""

    def __init__(self, server):
        self.server = server
        self._cv = threading.Condition()
        self._sent = OrderedDict()  # request_id -> the character it was checked against
        self._waiting = set()
        self._answers = {}
        self._current = None  # {character, appearance, values}

    def outfits(self):
        """avatar_outfits_list's reply for the current character."""
        server = self.server
        try:
            package = server.characters.package(server.character)
            pack, table = mod_settings_routes.read(package)
        except PackageError as error:  # an installed file changed since install
            return {"error": {"code": str(error)}}
        except ValueError:
            return {"error": {"code": "unknown_character"}}
        with self._cv:
            current = self._current
        return {"character": package.id,
                "appearances": [{k: a[k] for k in APPEARANCE_FIELDS if k in a} for a in (pack or {}).get("appearances", [])],
                "layers": [{k: layer[k] for k in LAYER_FIELDS if k in layer} for layer in (pack or {}).get("layers", [])],
                "mod_settings": table["appearances"],
                "current": {"appearance": current["appearance"], "values": current["values"]}
                if current is not None and current["character"] == package.id else None}

    def change(self, args):
        """avatar_outfit: checks args against the list, publishes one `looks` event and waits WAIT_S for its receipt."""
        change = _change(args)
        if change is None:
            return {"error": {"code": "invalid_arguments"}}
        listed = self.outfits()
        if "error" in listed:
            return listed
        reason = _refusal(change, listed)
        if reason is not None:
            return {"ok": False, "reason": reason}
        request_id = secrets.token_hex(8)
        with self._cv:
            self._sent[request_id] = listed["character"]
            while len(self._sent) > KEPT:
                self._sent.popitem(last=False)
            self._waiting.add(request_id)
        self.server.feed.publish("looks", {"request_id": request_id, **change})
        with self._cv:
            self._cv.wait_for(lambda: request_id in self._answers, WAIT_S)
            self._waiting.discard(request_id)
            receipt = self._answers.pop(request_id, None)
        if receipt is None:
            return {"ok": False, "reason": "timeout"}
        return {k: receipt[k] for k in ("ok", "reason", "appearance", "values") if k in receipt}

    def receipt(self, body):
        """True when body is the first receipt of a request this process sent."""
        with self._cv:
            character = self._sent.pop(body["request_id"], None)
            if character is None:
                return False
            self._current = {"character": character, "appearance": body["appearance"], "values": body["values"]}
            if body["request_id"] in self._waiting:
                self._answers[body["request_id"]] = body
                self._cv.notify_all()
            return True


def route(h, method, path):
    if path != RECEIPT_PATH:
        return False
    try:
        body = h.body()
    except ValueError:
        body = None
    if not _receipt_ok(body):
        h.json(400, {"error": "invalid_receipt"})
        return True
    looks = getattr(h.server.character_agent, "looks", None)
    h.json(200, {"applied": looks is not None and looks.receipt(body)})
    return True
