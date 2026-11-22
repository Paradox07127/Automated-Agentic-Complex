"""POST /character and the switch, GET /character/state/history, PUT /avatar/visibility and /character/state/switch, POST /behavior/receipts and /behavior/motion_state."""
from brain.outbound import OutboundBlocked
import c1


def _id64(value):
    return isinstance(value, str) and 0 < len(value.encode()) <= 64


def _motion_state_ok(body):
    """C3 rule 54's motion_state without v and type."""
    return isinstance(body, dict) and set(body) == c1.MOTION_STATE_KEYS | {"clip"} and body["origin"] in c1.ORIGINS \
        and (_id64(body["behavior_id"]) or body["behavior_id"] is None and body["origin"] == "local") \
        and body["phase"] in c1.MOTION_STATE_PHASES and isinstance(body["resting"], bool) \
        and isinstance(body["busy"], bool) and _id64(body["clip"])


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
            with self.server._write_lock:
                if not self.server.resetting and epoch == self.server._trace_epoch():
                    self.server._trace("behavior.receipt", trace_id, turn_id=turn_id, turn_generation=body["turn_generation"],
                        attrs={"behavior_id": body["behavior_id"], "behavior_type": behavior_type, "phase": body["phase"],
                               "reason": trace_error(body.get("reason"))})
        self._json(200, {"applied": applied, "why": why})

    def _motion_state(self, body):
        """POST /behavior/motion_state: the renderer's clip boundary (C3 rule 54), forwarded by the Companion."""
        if not _motion_state_ok(body):
            return self._json(400, {"error": "invalid_motion_state"})
        self.server.spatial.motion_state(body)
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()
