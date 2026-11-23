"""POST /character and the switch, GET /character/state/history, PUT /avatar/visibility, /character/state/switch and /behavior/motion_prefs, POST /behavior/receipts, /behavior/motion_state, /behavior/user_play, /interaction/record and /character/greeting."""
from brain.outbound import OutboundBlocked
import c1
from character.desk_log import COUNTED


def _id64(value):
    return isinstance(value, str) and 0 < len(value.encode()) <= 64


def _motion_state_ok(body):
    """C3 rule 54's motion_state without v and type."""
    return isinstance(body, dict) and set(body) == c1.MOTION_STATE_KEYS | {"clip"} and body["origin"] in c1.ORIGINS \
        and (_id64(body["behavior_id"]) and body["origin"] != "user"
             or body["behavior_id"] is None and body["origin"] != "agent") \
        and body["phase"] in (c1.USER_PHASES if body["origin"] == "user" else c1.MOTION_STATE_PHASES) \
        and isinstance(body["resting"], bool) \
        and isinstance(body["busy"], bool) and _id64(body["clip"])


def _key(value):
    """C3 rule 51 (j): a chain key, pool key or clip name."""
    return isinstance(value, str) and 0 < len(value.encode()) <= 128


def _table(value, limit, ok):
    return isinstance(value, dict) and len(value) <= limit and all(_key(k) and ok(v) for k, v in value.items())


def _pool_ok(rows):
    return isinstance(rows, list) and 1 <= len(rows) <= 64 and all(
        isinstance(r, dict) and set(r) == {"clip", "weight"} and _key(r["clip"]) and type(r["weight"]) is int
        and 1 <= r["weight"] <= 100000 for r in rows) and len({r["clip"] for r in rows}) == len(rows)


def _motion_prefs_ok(body):
    """{character_id, action_switches, motion_overrides}: C3 rule 28's switch table and rule 51's overrides within its
    (j) limits."""
    if not isinstance(body, dict) or set(body) != {"character_id", "action_switches", "motion_overrides"}:
        return False
    o = body["motion_overrides"]
    is_bool = lambda v: isinstance(v, bool)  # noqa: E731
    return _id64(body["character_id"]) and _table(body["action_switches"], 128, is_bool) \
        and isinstance(o, dict) and set(o) == {"chains", "pools", "blend_in"} and _table(o["chains"], 512, is_bool) \
        and _table(o["pools"], 64, _pool_ok) and _table(o["blend_in"], 512, lambda v: isinstance(v, (int, float))
                                                        and not isinstance(v, bool) and 0 <= v <= 2)


class CharacterMixin:
    def _character(self, body):
        cid = body.get("id") if isinstance(body, dict) else None
        try:
            if not isinstance(cid, str):
                raise ValueError(cid)
            changed = self.server.set_character(cid)
        except ValueError:
            return self._json(400, {"error": "unknown_character"})
        except OutboundBlocked:
            return self._json(409, {"error": "outbound_blocked"})
        if changed is None:
            return self._json(409, {"error": "switching"})
        return self._json(200, {"id": cid, "changed": changed})

    def _switch(self, path, body):
        """POST /character/prepare {id}, /character/commit and /character/abort {switch_id}."""
        if path == "/character/prepare":
            cid = body.get("id") if isinstance(body, dict) else None
            if not isinstance(cid, str):
                return self._json(400, {"error": "unknown_character"})
            return self._json(*self.server.prepare_switch(cid))
        switch_id = body.get("switch_id") if isinstance(body, dict) else None
        switch_id = switch_id if isinstance(switch_id, str) else None  # anything else is an unknown switch
        step = self.server.commit_switch if path == "/character/commit" else self.server.abort_switch
        return self._json(*step(switch_id))

    def _character_state_history(self, query):
        if self.server.state is None:
            return self._json(503, {"error": "no_state"})
        try:
            since = float(query["since"][0]) if "since" in query else None
        except ValueError:
            return self._json(400, {"error": "invalid_since"})
        try:
            limit = int(query.get("limit", ["1000"])[0])
            if not 1 <= limit <= 5000:
                raise ValueError(limit)
        except ValueError:
            return self._json(400, {"error": "invalid_limit"})
        return self._json(200, {"items": self.server.state.history(since, limit)})

    def _avatar_put(self):
        """PUT /avatar/visibility {visible, reason}:Companion's word on whether the character is shown."""
        try:
            body = self._body()
        except ValueError:
            return self._json(400, {"error": "invalid_payload"})
        visible, reason = (body.get("visible"), body.get("reason")) if isinstance(body, dict) else (None, None)
        if not isinstance(visible, bool) or not (reason is None or isinstance(reason, str)
                                                 and len(reason.encode()) <= 64):
            return self._json(400, {"error": "invalid_payload"})
        self._json(200, self.server.set_avatar(visible, reason))

    def _state_switch_put(self):
        """PUT /character/state/switch {affects_behavior}:off, her state is still recorded but changes nothing
        she does or says; kept in memory only."""
        try:
            body = self._body()
        except ValueError:
            return self._json(400, {"error": "invalid_payload"})
        if not isinstance(body, dict) or set(body) != {"affects_behavior"} \
                or not isinstance(body["affects_behavior"], bool):
            return self._json(400, {"error": "invalid_payload"})
        self.server.state_affects = body["affects_behavior"]
        self._json(200, {"affects_behavior": self.server.state_affects})

    def _behavior_receipt(self, body):
        """POST /behavior/receipts: the avatar host's execution receipt (C1 §3), forwarded by the Companion."""
        if not isinstance(body, dict) or c1.check_message({**body, "event": "receipt"}):
            return self._json(400, {"error": "invalid_receipt"})
        applied, why = self.server.spatial.receipt(body)
        linkage = self.server.spatial.receipt_trace(body["behavior_id"]) if applied else None
        if linkage is not None:
            from daemon.tracing import trace_error
            trace_id, turn_id, behavior_type, epoch = linkage
            with self.server.spatial._lock:
                record = self.server.spatial.records.get(body["behavior_id"])
                dispatched = record.get("dispatched") if record is not None else None
            with self.server._write_lock:
                if not self.server.resetting and epoch == self.server._trace_epoch():
                    self.server._trace("behavior.receipt", trace_id, turn_id=turn_id, causation_id=dispatched,
                        turn_generation=None if turn_id is None else body["turn_generation"],
                        attrs={"behavior_id": body["behavior_id"], "behavior_type": behavior_type, "phase": body["phase"],
                               "reason": trace_error(body.get("reason"))})
        self._json(200, {"applied": applied, "why": why})

    def _motion_state(self, body):
        """POST /behavior/motion_state: the renderer's clip boundary (C3 rule 54), forwarded by the Companion."""
        if not _motion_state_ok(body):
            return self._json(400, {"error": "invalid_motion_state"})
        self.server.spatial.motion_state(body)
        if body["phase"] == "started":
            self._motion_started(body["behavior_id"], body["clip"])
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _motion_started(self, behavior_id, clip):
        """motion.started, which the daily brief counts: in its behavior's trace after its dispatch, a clip of no
        behavior or of one from a forgotten trace in a trace of its own."""
        from traces.trace_store import new_trace_id
        spatial = self.server.spatial
        linkage = spatial.receipt_trace(behavior_id) if behavior_id is not None else None
        with self.server._write_lock:
            if self.server.resetting:
                return
            trace_id, cause = new_trace_id(), None
            if linkage is not None and linkage[3] == self.server._trace_epoch():
                with spatial._lock:
                    record = spatial.records.get(behavior_id)
                    trace_id, cause = linkage[0], record.get("dispatched") if record is not None else None
            self.server._trace("motion.started", trace_id, causation_id=cause,
                               attrs={"behavior_id": behavior_id, "clip": clip})

    def _behavior_user_play(self, body):
        """POST /behavior/user_play {playing}: the Companion asks the renderer for the user's own play, or none is asked
        for or plays any more; her body behaviors give way to it until then."""
        if not isinstance(body, dict) or set(body) != {"playing"} or not isinstance(body["playing"], bool):
            return self._json(400, {"error": "invalid_payload"})
        self.server.spatial.user_play(body["playing"])
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _motion_prefs_put(self):
        """PUT /behavior/motion_prefs: the current character's action switches and motion overrides as the
        Companion's config.json keeps them; her chooser holds them until the next character switch."""
        try:
            body = self._body()
        except ValueError:
            return self._json(400, {"error": "invalid_motion_prefs"})
        if not _motion_prefs_ok(body):
            return self._json(400, {"error": "invalid_motion_prefs"})
        with self.server._switch_lock:  # a commit swaps her chooser under it
            if body["character_id"] != self.server.character:
                return self._json(409, {"error": "character_changed"})
            reply = self.server.spatial.set_motion_prefs(body["action_switches"], body["motion_overrides"])
        if reply is None:
            return self._json(409, {"error": "no_motion"})
        self._json(200, {"character_id": body["character_id"], **reply})

    def _record(self, body):
        """POST /interaction/record {kind}: one touch of hers or greeting for the daily brief, forwarded by the Companion."""
        if not isinstance(body, dict) or set(body) != {"kind"} or body["kind"] not in COUNTED:
            return self._json(400, {"error": "invalid_payload"})
        if self.server.desk is None:
            return self._json(503, {"error": "no_desk_log"})
        self.server.desk.count(body["kind"])
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _greeting(self, body):
        """POST /character/greeting {}: her opening line once the first-run guide is done, sent by the Companion after
        her greeting motion; a line she starts counts as a greeting in the daily brief."""
        if body != {}:
            return self._json(400, {"error": "invalid_payload"})
        status, reply = self.server.greet()
        if status == 202 and self.server.desk is not None:
            self.server.desk.count("greet")
        self._json(status, reply)
