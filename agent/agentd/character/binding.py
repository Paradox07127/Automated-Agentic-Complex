"""Per-character voice, motion and persona overrides; absent keys use package or global defaults."""
from copy import deepcopy
import json
from pathlib import Path
import threading

from brain.language import SUPPORTED
from brain.persona import BASE_LANGUAGE, LOCALIZED, SECTIONS, render_persona
from fsutil import atomic_write_json


def effective(server, cid=None):
    """cid's effective binding, the current character's by default. Before main() builds server.bindings: no persona
    overrides and the global motion backend (game without server.motion)."""
    cid = server.character if cid is None else cid
    bindings = getattr(server, "bindings", None)
    if bindings is not None:
        return bindings.effective(cid)
    motion = getattr(server, "motion", None)
    return {"motion": {"driver": "game" if motion is None else motion.settings.backend}, "persona": {"overrides": {}}}


def bound(card, binding):
    """(card with binding's persona overrides, render_persona's motion: True for the generated driver, "game" for the game
    one); binding None: (card, False)."""
    if binding is None:
        return card, False
    overrides = binding["persona"]["overrides"]
    card = {**card, **overrides}
    mine = {key: value for key, value in overrides.items() if key in LOCALIZED}
    if mine:  # localized() would put the package translation, or no examples, over the user's own fields
        card["i18n"] = {code: {**card.get("i18n", {}).get(code, {}), **mine} for code in SUPPORTED if code != BASE_LANGUAGE}
    return card, binding["motion"]["driver"] == "generated" or "game"


class Bindings:
    def __init__(self, state_dir, repository, motion_backend):
        self.path = Path(state_dir) / "character-bindings.json"
        self.repository, self.motion_backend = repository, motion_backend
        self._lock = threading.RLock()
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            saved = {"revision": 0, "characters": {}}
        self.revision = saved["revision"]
        known = repository.ids()
        self._characters = {cid: record for cid, record in saved["characters"].items() if cid in known}

    def effective(self, cid):
        with self._lock:
            if cid not in self.repository.ids():
                raise ValueError("unknown_character")
            record = self._characters.get(cid, {})
            voice = record.get("voice")
            if voice is not None:
                voice = {**voice, "source": "user"}
            else:
                package = self.repository.voice(cid)
                voice = None if package is None else {"voice_id": package[0], "language": package[1], "source": "package"}
            motion = record.get("motion")
            persona = record.get("persona")
            return {"character_id": cid, "revision": self.revision, "voice": voice,
                    "motion": {"driver": self.motion_backend(), "source": "global"} if motion is None
                              else {**motion, "source": "user"},
                    "persona": {"overrides": {}, "source": "package"} if persona is None
                               else {"overrides": deepcopy(persona["overrides"]), "source": "user"}}

    def voice(self, cid):
        voice = self.effective(cid)["voice"]
        return None if voice is None else (voice["voice_id"], voice["language"])

    def update(self, cid, body, check=None):
        known = self.repository.ids()
        if cid not in known:
            return 404, {"error": "unknown_character"}
        if not isinstance(body, dict) or type(body.get("revision")) is not int \
                or set(body) - {"revision", "voice", "motion", "persona"}:
            return 400, {"error": "invalid_payload"}
        for key, fields in (("voice", {"voice_id", "language"}), ("motion", {"driver"}), ("persona", {"overrides"})):
            value = body.get(key)
            if value is not None and (not isinstance(value, dict) or set(value) != fields):
                return 400, {"error": "invalid_payload"}
        voice, motion, persona = body.get("voice"), body.get("motion"), body.get("persona")
        if voice is not None and any(not isinstance(value, str) or not 0 < len(value) <= 64 for value in voice.values()):
            return 400, {"error": "invalid_voice"}
        if motion is not None and motion["driver"] not in ("game", "generated"):
            return 400, {"error": "invalid_motion_driver"}
        if persona is not None:
            overrides = persona["overrides"]
            if not isinstance(overrides, dict) or set(overrides) - {*SECTIONS, "post_history_instructions", "familiarity_rules"}:
                return 400, {"error": "invalid_persona_override"}
            card = self.repository.load_card(cid)
            try:
                for key, value in overrides.items():
                    original = card.get(key, "")
                    if not (type(value) is type(original) or type(value) in (int, float) and type(original) in (int, float)) \
                            or len(json.dumps(value, ensure_ascii=False, allow_nan=False)) > 20000:
                        return 400, {"error": "invalid_persona_override"}
                render_persona({**card, **overrides})
            except (ValueError, KeyError, TypeError):
                return 400, {"error": "invalid_persona_override"}
        with self._lock:
            if body["revision"] != self.revision:
                return 409, {"error": "revision_conflict", "revision": self.revision}
            characters = {key: value for key, value in self._characters.items() if key in known}
            record = dict(characters.get(cid, {}))
            for key in ("voice", "motion", "persona"):
                if key in body:
                    if body[key] is None:
                        record.pop(key, None)
                    else:
                        record[key] = deepcopy(body[key])
            if check is not None:
                check({"motion": record.get("motion", {"driver": self.motion_backend()}),
                       "persona": record.get("persona", {"overrides": {}})})
            if record:
                characters[cid] = record
            else:
                characters.pop(cid, None)
            revision = self.revision + 1
            atomic_write_json(self.path, {"revision": revision, "characters": characters})
            self.revision, self._characters = revision, characters
            return 200, self.effective(cid)
