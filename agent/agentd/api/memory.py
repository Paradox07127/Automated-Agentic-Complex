"""GET /history, and GET, POST, PUT, PATCH and DELETE /memory."""
from urllib.parse import parse_qs, urlparse

from daemon.constants import NO_HISTORY
from personal.memory import KINDS, SOURCES
from infra.store import checkpoint
from api.views import _fact_text

NO_MEMORY = {"error": "no_memory", "detail": "记忆没有开启"}


class MemoryMixin:
    def _history(self, path, query):
        history = self.server.history
        if history is None:
            return self._json(503, NO_HISTORY)
        if path == "/history/export":
            return self._json(200, {"turns": history.export()})
        try:
            before = int(query["before"][0]) if "before" in query else None
            turns, after = history.page(before, int(query.get("limit", ["50"])[0]))
        except ValueError:
            return self._json(400, {"error": "invalid_cursor"})
        self._json(200, {"turns": turns, "next": after})

    def _memory_read(self, path, owner=None):
        memory = self.server.memory
        if memory is None:
            return self._json(503, NO_MEMORY)
        facts = memory.active(owner=owner)
        if path == "/memory/export":
            return self._json(200, {"facts": facts})
        facts += memory.candidates(owner=owner)
        uses = memory.uses()
        unused = {"uses_today": 0, "last_injected_at": None, "last_mentioned_at": None, "recent_uses": []}
        facts = [{**fact, "state": fact.get("state", "active"), **uses.get(fact["fact_id"], unused)} for fact in facts]
        self._json(200, {"paused": memory.paused(), "facts": facts,
                         "counts": {source: sum(f["source"] == source for f in facts) for source in SOURCES}})

    def _memory_post(self, confirm_match, body):
        memory = self.server.memory
        if memory is None:
            return self._json(503, NO_MEMORY)
        if confirm_match:
            if not isinstance(body, dict) or type(body.get('expected_version')) is not int:
                return self._json(400, {'error':'expected_version_required'})
            from personal.memory import VersionConflict
            try:
                if urlparse(self.path).path.endswith('/reject'):
                    memory.reject(confirm_match.group(1), expected_version=body['expected_version'])
                    result, action = {'rejected':True}, 'rejected'
                else:
                    result, action = {"version": memory.confirm(confirm_match.group(1), expected_version=body['expected_version'])}, 'confirmed'
                self.server.feed.publish('memory', {'action':action, 'fact_id':confirm_match.group(1)})
                return self._json(200, result)
            except VersionConflict as error:
                return self._json(409, {'error':'version_conflict', 'current_version':error.current_version})
            except KeyError:
                return self._json(404, {"error": "unknown_fact"})
        text = _fact_text(body)
        if text is None:
            return self._json(400, {"error": "invalid_text"})
        kind = body.get("kind", "fact")
        if kind not in KINDS:
            return self._json(400, {"error": "invalid_kind"})
        source = "confirmed_by_user" if kind in ("name", "birthday") else "asserted_by_user"
        if body.get('expected_absent') is True:
            if kind not in ('name', 'birthday'): return self._json(400, {'error':'invalid_kind'})
            from personal.memory import VersionConflict
            try:
                return self._json(201, {'fact_id':memory.add(text, source, kind=kind, manual=True, expected_absent=True)})
            except VersionConflict as error:
                return self._json(409, {'error':'version_conflict', 'current_version':error.current_version})
        fact_id = memory.reinforce(text, kind, source, manual=True)
        if fact_id is not None:
            return self._json(200, {"fact_id": fact_id, "reinforced": True})
        self._json(201, {"fact_id": memory.add(text, source, kind=kind, manual=True)})

    def _fact_versions_get(self, fact_id):
        memory = self.server.memory
        if memory is None:
            return self._json(503, NO_MEMORY)
        try:
            return self._json(200, {"versions": memory.versions(fact_id)})
        except KeyError:
            return self._json(404, {"error": "unknown_fact"})

    def _fact_cascade_get(self, fact_id):
        memory = self.server.memory
        if memory is None:
            return self._json(503, NO_MEMORY)
        try:
            return self._json(200, {"fact_ids": memory.tombstoned(fact_id)})
        except KeyError:
            return self._json(404, {"error": "unknown_fact"})

    def _fact_mark_put(self, fact_id, mark):
        found = self._memory_body()
        if found is None:
            return
        memory, body = found
        on = body.get(mark) if isinstance(body, dict) else None
        if not isinstance(on, bool):
            return self._json(400, {"error": "invalid_payload"})
        try:
            memory.set_mark(fact_id, mark, on)
        except KeyError:
            return self._json(404, {"error": "unknown_fact"})
        self.server.feed.publish("memory", {"action": mark, "fact_id": fact_id, mark: on})
        self._json(200, {mark: on})

    def _memory_body(self):
        """(memory, body) for a PUT or PATCH; None once an error is answered."""
        if self.server.memory is None:
            self._json(503, NO_MEMORY)
        else:
            try:
                return self.server.memory, self._body()
            except ValueError as e:
                self._json(400, {"error": str(e)})
        return None

    def _memory_delete(self, fact_match):
        memory = self.server.memory
        if memory is None:
            return self._json(503, NO_MEMORY)
        if fact_match:
            try:
                version = int(parse_qs(urlparse(self.path).query).get('expected_version', [''])[0])
            except ValueError:
                return self._json(400, {'error':'expected_version_required'})
            from personal.memory import VersionConflict
            try:
                memory.delete(fact_match.group(1), expected_version=version)
            except VersionConflict as error:
                return self._json(409, {'error':'version_conflict', 'current_version':error.current_version})
            except KeyError:
                return self._json(404, {"error": "unknown_fact"})
            self.server._memory_changed(fact_match.group(1), deleted=True)
            checkpoint(memory)
            return self._json(200, {"deleted": True})
        query = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        scope, owner = query.get("scope", [None])[0], query.get("owner", [None])[0]
        if scope not in ("facts", "history", "all") or (owner is not None and (scope != "facts" or not owner)):
            return self._json(400, {"error": "invalid_scope"})
        facts = 0
        if scope != "history":
            cleared = memory.cleared(scope, owner)
            said = [line_id for fact_id in cleared for line_id in memory.lines(fact_id)]
            facts = memory.clear(scope, owner)
            self.server._memories_changed(cleared, deleted=True, said=said)
        history = 0
        if scope != "facts" and self.server.history is not None:
            history = self.server.clear_history()
        checkpoint(memory)
        self._json(200, {"facts_deleted": facts, "history_deleted": history})
