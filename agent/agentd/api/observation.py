"""PUT and DELETE /observation, PUT /context/activity, DELETE /context/items and /blacklist."""
import re
from urllib.parse import parse_qs, urlparse

import idna

from observation import activity
from observation.blacklist import ALLOW_FIELDS, FIELDS, MODES, bare_host, entry_hides, normal_host
from observation.privacy import PAUSE_MAX
from daemon.constants import CLEARABLE, SEEN
from infra.store import checkpoint
from api.views import _midnight, _iso

RANGES = {"15m": 900, "1h": 3600}  # DELETE /observation; "today" is since local midnight
OBSERVED_SOURCES = ("observed_context", "inferred_hypothesis")  # facts DELETE /observation takes with it
BLACKLIST_VALUE_MAX = 200
CORRECTION_MAX = 240  # minutes PUT /context/activity may hold for


def _entry(field, value):
    """value as the list `field` holds it: a domain as the lower-case IDNA A-label browsers report (UTS 46), without its
    root dot, or, when IDNA refuses a host blacklist.HOST takes (a bracketed IPv6 address, an underscore), its
    normal_host(); None when a domain is no host name."""
    if field != "domains":
        return value
    try:
        return idna.encode(value, uts46=True).decode("ascii").removesuffix(".")
    except UnicodeError:
        return normal_host(value) if bare_host(value) else None


def _stored(values, field, value):
    """The entries of values that are value in the form _entry gives, however they were spelled when saved."""
    return [v for v in values if isinstance(v, str) and _entry(field, v) == value]


class ObservationMixin:
    def _observation_put(self, path):
        """PUT /observation/paused {minutes}, /observation/meeting {on}, /observation/quiet {until}."""
        try:
            body = self._body()
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        if path == "/observation/quiet":
            if not isinstance(body, dict) or "until" not in body:
                return self._json(400, {"error": "invalid_payload"})
            until = body["until"]
            now = self.server.clock()
            if until is not None and not (isinstance(until, (int, float)) and not isinstance(until, bool)
                                          and now < until <= now + PAUSE_MAX * 60):
                return self._json(400, {"error": "invalid_payload"})
            self.server.set_quiet_until(until)
            return self._json(200, {"quiet_until": self.server.observation_state()["quiet_until"]})
        if path == "/observation/meeting":
            on = body.get("on") if isinstance(body, dict) else None
            if not isinstance(on, bool):
                return self._json(400, {"error": "invalid_payload"})
            self.server.set_meeting(on)
            return self._json(200, {"meeting": on})
        minutes = body.get("minutes") if isinstance(body, dict) else None
        if not (isinstance(minutes, int) and not isinstance(minutes, bool) and 0 <= minutes <= PAUSE_MAX):
            return self._json(400, {"error": "invalid_payload"})
        self.server.set_paused_until(self.server.clock() + minutes * 60 if minutes else None)
        self._json(200, {"paused_until": self.server.observation_state()["paused_until"]})

    def _activity_put(self):
        """PUT /context/activity:the user's correction of the activity, or {"activity": null} to remove it."""
        try:
            body = self._body()
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        server = self.server
        if isinstance(body, dict) and "activity" in body and body["activity"] is None:
            server.correction = None
            return self._json(200, {"activity": None, "until": None, "focus_id": None,
                                    "cancelled_line": server._context_changed("activity")})
        chosen, minutes = (body.get("activity"), body.get("minutes")) if isinstance(body, dict) else (None, None)
        if not (chosen in activity.ACTIVITIES and chosen != "unknown" and isinstance(minutes, int)
                and not isinstance(minutes, bool) and 1 <= minutes <= CORRECTION_MAX):
            return self._json(400, {"error": "invalid_payload"})
        scene = server.activity()
        until, focus_id = server.clock() + minutes * 60, scene and scene["focus_id"]
        server.correction = {"activity": chosen, "until": until, "focus_id": focus_id}
        self._json(200, {"activity": chosen, "until": _iso(until), "focus_id": focus_id,
                         "cancelled_line": server._context_changed("activity")})

    def _observation_delete(self):
        """DELETE /observation?range=:what was seen since the cutoff, and the facts inferred from it."""
        span = parse_qs(urlparse(self.path).query).get("range", [None])[0]
        if span not in (*RANGES, "today"):
            return self._json(400, {"error": "invalid_range"})
        server = self.server
        if server.attention is None:
            return self._json(503, {"error": "no_attention"})
        now = server.clock()
        cutoff = now - RANGES[span] if span in RANGES else _midnight(now)
        events, context = server.attention.delete_since(cutoff)
        if getattr(server, "timeline", None) is not None:
            server.timeline.clear(since=cutoff)
        controller = server.character_agent
        continuous = getattr(controller, "observations", None)
        if continuous:
            continuous.delete_since(cutoff)
        server.forget_user_state()
        ids = server.episodes.delete_since(cutoff) if server.episodes is not None else []
        observations =server.capture.forget_since(cutoff) if server.capture is not None else 0
        if server.proactive is not None and server.proactive.judge is not None:
            server.proactive.judge.forget_since(cutoff)
        facts = server.memory.delete_since(cutoff, OBSERVED_SOURCES) if server.memory is not None else []
        for fact_id in facts:
            server.feed.publish("memory", {"action": "deleted", "fact_id": fact_id})
        server._memories_changed(facts, deleted=True, reason="observations_deleted")
        derived = server._forget_derived(ids, reason="observations_deleted")
        if server.trace is not None:  # one file with the episodes' in main()
            checkpoint(server.trace)
        for kind in SEEN:
            server._context_changed(kind, reason="observations_deleted")
        body = {"events": events, "context": context, "observations": observations,
                "facts": len(set(facts) | set(derived))}
        self._json(200, body if server.episodes is None else {**body, "episodes": len(ids)})

    def _context_item_delete(self, kind):
        """DELETE /context/items/<type>:the item she sees now goes; the live line that used it ends."""
        if kind not in CLEARABLE:
            return self._json(400, {"error": "invalid_type"})
        server = self.server
        if kind in ("page", "selection"):
            cleared = server.attention is not None and server.attention.clear_on_page(kind) > 0
        elif server.capture is None:
            cleared = False
        else:
            cleared = server.capture.forget_view() if kind == "view" else server.capture.forget_window_text()
        self._json(200, {"type": kind, "cleared": cleared, "cancelled_line": server._context_changed(kind)})

    def _blacklist_remove(self):
        """DELETE /blacklist {field, value, list}: one entry out; records it hid stay deleted."""
        try:
            body = self._body()
        except ValueError:
            body = None
        field, value = (body.get("field"), body.get("value")) if isinstance(body, dict) else (None, None)
        allow = isinstance(body, dict) and body.get("list") == "allow"
        if not (isinstance(body, dict) and body.get("list", "deny") in ("allow", "deny")
                and field in (ALLOW_FIELDS if allow else FIELDS)
                and isinstance(value, str) and 0 < len(value) <= BLACKLIST_VALUE_MAX
                and (value := _entry(field, value)) is not None):
            return self._json(400, {"error": "invalid_payload"})
        if self.server.attention is None:
            return self._json(503, {"error": "no_attention"})
        blacklist = self.server.attention.blacklist
        blacklist._load()
        values = blacklist.data.get("allow", {}).get(field, []) if allow else blacklist.data.get(field, [])
        remove = blacklist.allow_remove if allow else blacklist.remove
        removed = any([remove(field, stored) for stored in _stored(values, field, value)])
        if allow and removed:
            self._forget_hidden(blacklist.hides)
        self._json(200, {"removed": removed})

    def _forget_hidden(self, hides, field=None, delete_existing=False, summaries=()):
        """Stops capture and the judge using what hides matches; with delete_existing its records go too, and what the
        interpreter made from summaries (the "tl-" ids of timeline summaries already dropped). Returns capture
        requests dropped."""
        dropped = 0
        if self.server.capture is not None:
            dropped = self.server.capture.forget_hidden(hides, field, delete_existing)
        if self.server.proactive is not None and self.server.proactive.judge is not None:
            self.server.proactive.judge.forget_hidden(hides, field)
        observations=getattr(getattr(self.server,'character_agent',None),'observations',None)
        if observations: observations.forget_hidden(hides, delete_existing, summaries)
        return dropped

    def _blacklist_add(self, body):
        """POST /blacklist:one entry; with delete_existing, the records it hides go too."""
        attention = self.server.attention
        if attention is None:
            return self._json(503, {"error": "no_attention"})
        field, value = (body.get("field"), body.get("value")) if isinstance(body, dict) else (None, None)
        if isinstance(body, dict) and body.get("list") == "allow":
            if not (field in ALLOW_FIELDS and isinstance(value, str) and 0 < len(value) <= BLACKLIST_VALUE_MAX
                    and (value := _entry(field, value)) is not None):
                return self._json(400, {"error": "invalid_payload"})
            return self._json(200, {"added": attention.blacklist.allow_add(field, value),
                                    "deleted": {"events": 0, "context": 0, "observations": 0}})
        if not (field in FIELDS and isinstance(value, str) and 0 < len(value) <= BLACKLIST_VALUE_MAX
                and body.get("list", "deny") == "deny" and isinstance(body.get("delete_existing"), bool)
                and (value := _entry(field, value)) is not None):
            return self._json(400, {"error": "invalid_payload"})
        if field == "title_patterns":
            try:
                re.compile(value)
            except re.error:
                return self._json(400, {"error": "invalid_pattern"})
        added = attention.blacklist.add(field, value)
        deleted = {"events": 0, "context": 0, "observations": 0}
        hides = lambda window: entry_hides(field, value, window)  # noqa: E731
        timeline, summaries = getattr(self.server, "timeline", None), ()
        if body["delete_existing"] and timeline is not None:
            # Before the observation purge: it also takes what cites a summary dropped here, by its "tl-" id.
            kept = timeline.summarized()
            timeline.delete_hidden(hides)
            summaries = [f"tl-{segment}" for segment in kept - timeline.summarized()]
        deleted["observations"] = self._forget_hidden(hides, field, body["delete_existing"], summaries)
        if body["delete_existing"]:
            deleted["events"], deleted["context"] = attention.delete_hidden(hides)
            self.server.forget_user_state()
            if self.server.episodes is not None:
                self.server._forget_derived(self.server.episodes.delete_matching(hides))
                if self.server.worklog is not None:
                    self.server.worklog.delete_matching(hides)
                checkpoint(self.server.episodes)
        self._json(200, {"added": added, "deleted": deleted})

    def _blacklist_defaults(self):
        """POST /blacklist/defaults:the default entries the user removed come back; records stay as they are."""
        if self.server.attention is None:
            return self._json(503, {"error": "no_attention"})
        self._json(200, {"added": self.server.attention.blacklist.restore_defaults()})

    def _blacklist_mode(self, body):
        """POST /blacklist/mode {mode}: reads only the allow list or everything but the blacklist; records stay."""
        mode = body.get("mode") if isinstance(body, dict) else None
        if mode not in MODES:
            return self._json(400, {"error": "invalid_payload"})
        if self.server.attention is None:
            return self._json(503, {"error": "no_attention"})
        blacklist = self.server.attention.blacklist
        blacklist.set_mode(mode)
        self._forget_hidden(blacklist.hides)
        self._json(200, {"mode": mode})
