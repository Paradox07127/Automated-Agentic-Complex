"""GET and POST /sessions, session lines, POST /tasks/<id> and /commitments/<id>."""
from daemon.constants import MAX_SAY
from sessions.own import MODES
from api.views import _is_dir

UNKNOWN_ORIGIN = {"kind": "unknown", "term_program": None, "tty": None, "tmux_pane": None,
                  "tmux_socket": None, "pid": None, "entrypoint": None, "bundle_id": None,
                  "wezterm_pane": None, "kitty_window_id": None, "kitty_listen_on": None}


class SessionsMixin:
    def _sessions_list(self):
        manager = self.server.sessions
        if manager is None:
            return self._json(503, {"error": "no_sessions"})
        own = manager.native_ids()
        external, states = [], {}
        for s in self.server.registry.snapshot()["sessions"]:
            if s["source"] == "claude" and s["session_id"] in own:
                states[own[s["session_id"]].session_id] = s["effective_state"]
                continue
            external.append({"session_id": s["display_session"], "own": False, "target": s["source"],
                             "cwd": s["cwd"], "title": None, "state": s["effective_state"], "last_line": None,
                             "started_at": None, "updated_at": s["since"], "observed_at": s["observed_at"],
                             "origin": s["origin"] or {**UNKNOWN_ORIGIN}, "capabilities": s["capabilities"]})
        mine = []
        for session in list(manager.sessions.values()):
            item = session.to_dict()
            # The card is visible only through the hook, so the registry knows this state first.
            if states.get(session.session_id) == "awaiting_approval":
                item["state"] = "awaiting_approval"
            mine.append(item)
        self._json(200, {"sessions": external + mine})

    def _sessions_post(self, match, body):
        self._idempotent(lambda: self._session_command(match, body), body)

    def _session_command(self, match, body):
        """(code, body) of one session command; an accepted one is only started, not done."""
        manager = self.server.sessions
        if manager is None:
            return 503, {"error": "no_sessions"}
        if match is None:
            body = body if isinstance(body, dict) else {}
            for field, ok in (("target", body.get("target") in ("claude", "codex")),
                              ("cwd", _is_dir(body.get("cwd"))),
                              ("prompt", isinstance(body.get("prompt"), str) and body["prompt"].strip())):
                if not ok:
                    return 400, {"error": "invalid_session", "field": field}
            mode = body.get("mode", "read_only")
            if not isinstance(mode, str) or mode not in MODES:
                return 400, {"error": "unsupported_mode"}
            session = manager.create(body["target"], body["cwd"], body["prompt"], mode=mode)
            if session.state == "error":  # its CLI did not start
                return 502, {"error": "start_failed"}
            return 201, {"session_id": session.session_id, "state": "accepted"}
        session_id, action = match.groups()
        if session_id not in manager.sessions:
            return self._not_own_or_unknown(session_id)
        if action == "interrupt":
            result = manager.interrupt(session_id)
        else:
            text = body.get("text") if isinstance(body, dict) else None
            if not isinstance(text, str) or not text.strip() or len(text) > MAX_SAY:
                return 400, {"error": "invalid_text"}
            with self.server._announce_lock:  # before the turn starts, so its own end is not forgotten
                self.server._ended.pop(session_id, None)
            result = manager.message(session_id, text)
        code, error = {"started": (202, None), "interrupted": (202, None), "busy": (409, "busy"),
                       "idle": (409, "idle"), "unknown": (404, "unknown_session"),
                       "failed": (502, "start_failed"), "closed": (503, "shutting_down"), "archived": (409, "archived")}[result]
        return code, {"error": error} if error else {"state": "accepted"}

    def _not_own_or_unknown(self, session_id):
        known = any(s["display_session"] == session_id for s in self.server.registry.snapshot()["sessions"])
        return (409, {"error": "not_own"}) if known else (404, {"error": "unknown_session"})

    def _session_lines(self, session_id, query):
        manager = self.server.sessions
        if manager is None:
            return self._json(503, {"error": "no_sessions"})
        try:
            after = int(query.get("after", ["0"])[0])
        except ValueError:
            return self._json(400, {"error": "invalid_cursor"})
        found = manager.lines(session_id, after)
        if found is None:
            status, _ = self._not_own_or_unknown(session_id)
            if status == 404:
                return self._json(404, {"error": "unknown_session"})
            # External sessions keep no transcript here.
            return self._json(200, {"lines": [], "next": max(after, 0)})
        lines, cursor = found
        self._json(200, {"lines": lines, "next": cursor})

    def _task_review(self, task_id, verdict):
        """POST /tasks/<id>/accept|reject: the user settles a task that needs review."""
        tasks = self.server.tasks
        if tasks is None:
            return self._json(503, {"error": "no_tasks"})
        task = tasks.get(task_id)
        if task is None:
            return self._json(404, {"error": "unknown_task"})
        if task["target"] == "character":
            return self._json(409, {"error": "delivery_receipt_required"})
        if task["state"] != "needs_review":
            return self._json(409, {"error": "invalid_state"})
        delivery = (task["result"] or {}).get("delivery_id")
        return self._json(200, {"task": tasks.transition(task_id, "succeeded" if verdict == "accept" else "failed",
                                                         source="user", delivery_id=delivery)})

    def _commitment_action(self, commitment_id, action, body):
        """POST /commitments/<id>/cancel|snooze|complete: the user settles a reminder."""
        if action == "snooze" and (not isinstance(body, dict) or set(body) != {"minutes"}
                                   or type(body["minutes"]) is not int or body["minutes"] not in (5, 10, 15, 60)):
            return self._json(400, {"error": "invalid_payload", "field": "minutes"})
        commitments = self.server.commitments
        if commitments is None:
            return self._json(503, {"error": "no_commitments"})
        try:
            with commitments.lock:
                if action == "snooze":
                    item = commitments.postpone(commitment_id, self.server.clock() + body["minutes"] * 60)
                elif action == "complete":
                    item = commitments.complete(commitment_id)
                else:
                    item = commitments.cancel(commitment_id)
                done = "rescheduled" if action == "complete" and item["state"] == "armed" else \
                    {"cancel": "cancelled", "snooze": "snoozed", "complete": "completed"}[action]
                self.server.feed.publish("commitment", {"action": done, "commitment": item})
        except ValueError as e:
            return self._json(404 if str(e) == "unknown_commitment" else 409, {"error": str(e)})
        return self._json(200, {"commitment": item})

    def _commitment_seen(self, commitment_id, body):
        """POST /commitments/<id>/seen: the reminder's card was on screen, which delivers a due one-off reminder; a
        repeating one its tick already re-armed only records it."""
        if body != {}:
            return self._json(400, {"error": "invalid_payload"})
        commitments = self.server.commitments
        if commitments is None:
            return self._json(503, {"error": "no_commitments"})
        with commitments.lock:
            before = commitments._get(commitment_id)
            item = commitments.seen(commitment_id)
            if item is None:
                return self._json(404, {"error": "unknown_commitment"})
            if before["seen_at"] is None:
                self.server.feed.publish("commitment", {"action": "seen", "commitment": item})
            if item["state"] == "triggered" and item["repeat"] is None:
                item = commitments.fulfill(commitment_id, None)
                self.server.feed.publish("commitment", {"action": "fulfilled", "commitment": item})
        return self._json(200, {"commitment": item})

    def _schedules_get(self):
        store = self.server.schedules_store()
        if store is None:
            return self._json(503, {'error': 'no_schedules'})
        return self._json(200, {'schedules': store.list()})

    def _schedules_post(self, body):
        store = self.server.schedules_store()
        if store is None:
            return self._json(503, {'error': 'no_schedules'})
        if not isinstance(body, dict) or set(body) - {'title', 'instruction', 'trigger', 'enabled', 'conversation_id', 'scope_id'} \
                or not {'title', 'instruction', 'trigger'} <= set(body):
            return self._json(400, {'error': 'invalid_schedule'})
        try:
            if 'conversation_id' not in body:
                history = self.server.history
                body['conversation_id'] = history.conversations.active if history else None
            if 'scope_id' not in body:
                settings = getattr(self.server.character_agent, 'settings', None)
                body['scope_id'] = settings.snapshot().get('scope_id') if settings else None
            self.server.schedule_context(body['conversation_id'], body['scope_id'])
            item = store.add(**body)
        except ValueError as exc:
            return self._json(400, {'error': getattr(exc, 'code', str(exc))})
        return self._json(201, {'schedule': item})

    def _schedule_put(self, schedule_id):
        store = self.server.schedules_store()
        if store is None:
            return self._json(503, {'error': 'no_schedules'})
        try:
            changes = self._body()
            item = store.get(schedule_id)
            if item is None:
                raise ValueError('unknown_schedule')
            if isinstance(changes, dict):
                if changes.get('enabled') is True:
                    self.server.schedule_context(changes.get('conversation_id', item['conversation_id']),
                                                 changes.get('scope_id', item['scope_id']))
                elif 'conversation_id' in changes or 'scope_id' in changes:
                    self.server.schedule_context(changes.get('conversation_id'), changes.get('scope_id'))
            item = store.update(schedule_id, changes)
        except ValueError as exc:
            error = getattr(exc, 'code', str(exc))
            return self._json(404 if error == 'unknown_schedule' else 400, {'error': error})
        return self._json(200, {'schedule': item})

    def _schedule_delete(self, schedule_id):
        store = self.server.schedules_store()
        if store is None:
            return self._json(503, {'error': 'no_schedules'})
        if not store.delete(schedule_id):
            return self._json(404, {'error': 'unknown_schedule'})
        return self._json(200, {'deleted': True})

    def _schedule_run(self, schedule_id, body):
        store = self.server.schedules_store()
        if store is None:
            return self._json(503, {'error': 'no_schedules'})
        try:
            run = store.run_now(schedule_id)
            job = self.server._submit_schedule(store, run, manual=True)
        except ValueError as exc:
            error = getattr(exc, 'code', str(exc))
            return self._json(404 if error == 'unknown_schedule' else 409, {'error': error})
        except Exception:
            return self._json(503, {'error': 'schedule_unavailable'})
        return self._json(202, {'job_id': job['job_id']})
