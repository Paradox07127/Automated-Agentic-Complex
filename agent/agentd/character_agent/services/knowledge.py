"""Read-only, provenance-aware access to the personal assistant's existing stores.

No SDK state is authoritative here. Re-read source rows and permission decisions
on every call, and keep dependencies for material actually returned to a run.
"""
import base64
import datetime
import hashlib
import json
import re
import threading
import time

from brain.egress import EgressPolicy
from brain.outbound import OutboundBlocked
from personal.history import terms
from personal.memory import TRUSTED
from character_agent.services.personal import activity_assessment


SOURCES = ("memory", "history", "episodes", "commitments", "behavior", "task_context", "briefs", "observations", "tasks", "days")
DERIVED = frozenset(("episodes", "behavior", "task_context", "briefs", "observations", "tasks", "days"))
DAYS_BACK = 31  # local dates whose day and week summaries the days source scans, today included
MAX_SCAN = 1000
MAX_LIMIT = 20
MAX_CHARS = 16000
MAX_DEPENDENCIES = 2048
PROFILE_KINDS = frozenset(("name", "birthday", "preference", "agreement"))
PREFERENCE_WORDS = ("偏好", "习惯", "平时", "风格", "沟通方式", "回答方式", "呈现方式", "usual", "prefer", "style", "format")
ALIASES = (
    ("简短", "简洁", "精简", "简要", "concise", "brief"),
    ("安静", "清静", "quiet"),
    ("结论", "总结", "conclusion", "summary"),
    ("价格", "费用", "成本", "预算", "price", "cost", "budget"),
    ("报告", "文档", "资料", "report", "document"),
    ("表格", "比较表", "对比表", "table", "comparison"),
)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _digest(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _bounded_int(value, default, low, high):
    value = default if value is None else value
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError("invalid_limit")
    return value


def _tokens(text):
    tokens = set(terms(text))
    lower = text.lower()
    for n, group in enumerate(ALIASES):
        if any(word in lower for word in group):
            tokens.add(f"concept:{n}")
    return tokens


def _error(code):
    return {"error": {"code": code, "retryable": False}}


def _related(query, row):
    query_words = _tokens(query)
    score = len(query_words & _tokens(row["text"])) / max(1, len(query_words))
    if any(word in query.lower() for word in PREFERENCE_WORDS) and row["source"] == "memory" \
            and row["kind"] in ("preference", "agreement"):
        score += 1.0
    return score


class KnowledgeService:
    """All configured sources remain subject to a fresh permitted(source, row).

    Without a callback only direct user facts, conversation history and reminders
    are exposed. Observational sources require explicit permission. Memory.paused
    controls automatic storage in the existing product, not reading old facts.
    """

    def __init__(self, memory=None, history=None, episodes=None, commitments=None,
                 egress=None, permitted=None, character_id=None, behavior_context=None, clock=time.time, task_understanding=None, task_context=None, observation_briefs=None, observations=None, worklog=None):
        self.memory, self.history = memory, history
        self.episodes, self.commitments = episodes, commitments
        self.egress = egress if egress is not None else EgressPolicy()
        self.permitted, self.character_id = permitted, character_id
        self.behavior_context, self.clock = behavior_context, clock
        self.task_understanding = task_understanding if task_understanding is not None else task_context
        self.observation_briefs = observation_briefs
        self.observations = observations
        self.worklog = worklog
        self.observation_images = set()
        self.observation_mode = False
        self._dependencies, self._overflow = {}, False
        self._lock = threading.RLock()

    @staticmethod
    def tool_definitions():
        from character_agent.services.observation import ObservationService
        sources = {"type": "array", "items": {"type": "string", "enum": list(SOURCES)}, "maxItems": len(SOURCES)}
        properties = {"query": {"type": "string", "maxLength": 2000, "description": "A few concrete words likely to appear in the record (person, project, topic, date); matching is by shared words. Empty lists the most recent items."},
                      "sources": {**sources, "description": "Limit the search to these sources; omit to search all permitted ones. commitments are reminders."},
                      "limit": {"type": "integer", "minimum": 1, "maximum": MAX_LIMIT, "description": "Items per page."},
                      "max_chars": {"type": "integer", "minimum": 1024, "maximum": MAX_CHARS, "description": "Upper bound on returned text."},
                      "cursor": {"type": "string", "maxLength": 1024, "description": "next_cursor from the previous page of the same request."}}
        return [
            {"name": "personal_profile", "description": "Read the preferences, agreements and personal facts the user has explicitly stated or confirmed, each with its source. "
                "Use it before tailoring advice to their tastes, or when they ask what you know or remember about them. "
                "It holds no inferred profile; an empty page means nothing is recorded yet. "
                "Read-only: to add, correct or forget an item use memory_propose. Page with limit and cursor (next_cursor from the last reply).",
             "input_schema": {"type": "object", "properties": {k: v for k, v in properties.items() if k not in ("sources", "query")}, "additionalProperties": False}},
            {"name": "knowledge_search", "description": "Search what you may recall about the user and past work: memory, conversation history, episodes, reminders (commitments), activity assessments, task context, observation briefs (source: briefs), observations, tasks and days. "
                "Use it when the user refers to something earlier or an answer depends on past context, not for what is already in this conversation. "
                "Returns bounded excerpts with source and id plus next_cursor; open one in full with knowledge_read. "
                "It does not search the user's selected files. Next steps in a brief are suggestions, never authorization, and finding nothing does not prove nothing happened.",
             "input_schema": {"type": "object", "properties": properties, "additionalProperties": False}},
            {"name": "knowledge_read", "description": "Read one item returned by knowledge_search in full, by the source and id of a search result; never guess an id. "
                "Use it when an excerpt is cut off or you need the exact wording before quoting it, correcting a memory or continuing past work. "
                "Deleted, corrected or revoked material is not returned, so a missing item may have been removed by the user.",
             "input_schema": {"type": "object", "properties": {"source": {"type": "string", "enum": list(SOURCES), "description": "The source field of the search result."},
                 "id": {"type": "string", "minLength": 1, "maxLength": 256, "description": "The id field of the search result."}, "max_chars": properties["max_chars"]},
                 "required": ["source", "id"], "additionalProperties": False}},
            {"name": "task_context", "description": "Read the current consented guesses about what the user is working on (task hypotheses) and local activity summaries, each with evidence and an expiry. "
                "Use it to connect help or a remark to their current work, or before offering work-related help unprompted. "
                "Everything here is a correctable guess, never a fact or permission to act. No arguments.",
             "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}},
            {"name": "behavior_context", "description": "Read the latest consented assessment of the user's recent activity (such as focus or breaks), with its expiry. "
                "Use it to choose your tone, timing or body facing so you fit what they are doing. "
                "It is provisional, never proof of feelings, intention or permission, and may be empty or expired; never present it to the user as a diagnosis. No arguments.",
             "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}},
        ] + ObservationService.tools()

    def _allowed(self, source, row=None):
        if source not in SOURCES:
            return False
        if source == "history" and row is not None and self.character_id is not None and row["character_id"] != self.character_id:
            return False
        if self.permitted is not None:
            try:
                return self.permitted(source, row) is True
            except Exception:
                return False
        return source not in DERIVED

    def sanitize(self, value, part="knowledge", depth=0, *, observed=None, complete=False):
        """Mask/bound already-authorized context; this does not grant source access."""
        if observed is None:
            observed=self.observation_mode or isinstance(value,dict) and value.get('source') in ('observations','task_context','behavior','briefs')
        if isinstance(value,dict) and value.get('source')=='observations': complete=True
        if depth > 12 and not complete:
            return "[nested content omitted]"
        if isinstance(value, str):
            return self.egress.observed(value) if observed else self.egress.replayed(part, value)
        if isinstance(value, list):
            return [self.sanitize(item,part,depth+1,observed=observed,complete=complete) for item in (value if complete else value[:100])]
        if isinstance(value, dict):
            identifiers={'id','source_id','observation_id','previous_id','reference','version','revision','hash','source_sha256','image_sha256','content_hash'}
            def clean(key,item):
                # Generated opaque IDs are protocol addresses. A phone-like numeric run inside a UUID is not a phone number.
                if part == 'orchestration' and isinstance(item, str):
                    if key == 'job_id' and re.fullmatch(r'[a-f0-9]{32}', item): return item
                    if key == 'run_id' and re.fullmatch(r'bg-[a-f0-9]{32}', item): return item
                if key in identifiers and isinstance(item,str) and re.fullmatch(r'(?:[a-z_]+:)?(?:(?:obs|work|brief|analysis|semantic|seg)-)?(?:[a-f0-9]{32}|[a-f0-9]{64}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})',item): return item
                return self.sanitize(item,part,depth+1,observed=observed,complete=complete)
            items=list(value.items())
            return {self.sanitize(str(key),part,depth+1,observed=observed,complete=complete):clean(key,item)
                    for key,item in (items if complete else items[:100])}
        return value if value is None or isinstance(value, (bool, int, float)) else str(type(value).__name__)

    def _record(self, source, ident, *, text, authority, version=None, at=None, kind=None,
                evidence=(), stale=False, details=None):
        record = {"source": source, "id": str(ident), "reference": f"{source}:{ident}", "version": version,
                  "authority": authority, "text": text, "recorded_at": at, "kind": kind,
                  "evidence": list(evidence)[:20], "validity": "stale" if stale else "current"}
        if details:
            record["details"] = details
        return record

    def _fact(self, row):
        return self._record("memory", row["fact_id"], text=row["text"], authority=row["source"],
                            version=row["version"], at=row["recorded_at"], kind=row["kind"],
                            evidence=row["evidence"], stale=row.get("stale", False),
                            details={"occurred_at": row.get("occurred_at"),
                                     "uncertainty": None if row["source"] in TRUSTED else "Unconfirmed observation or inference; not a user assertion."})

    def _history(self, row):
        if row["source"] not in ("text", "voice") or row["state"] not in ("completed", "interrupted"):
            return None
        return self._record("history", row["turn_id"],
                            text=f"User: {row['user_text']}\nCharacter ({row['character_id']}): {row['reply']}",
                            authority="conversation_record", version=row["id"], at=row["started_at"],
                            evidence=[row["event_id"]], details={"character_id": row["character_id"],
                                "state": row["state"], "uncertainty": "Assistant statements are attributed conversation, not verified external outcomes."})

    def _episode(self, row):
        return self._record("episodes", row["id"], text=f"{row['title']}\n{row['description']}",
                            authority="user_edited_summary" if row.get("edited") else "observed_summary",
                            version=row.get("version"), at=row.get("created_at"),
                            evidence=[row["run_id"]] if row.get("run_id") else [],
                            details={k: row.get(k) for k in ("start", "end", "threads", "user_actions", "agent_actions", "open_questions", "presence")} | {"structured_fields_authority":"prior_model_output_after_user_edit" if row.get("edited") else "model_extraction"})

    def _commitment(self, row):
        return self._record("commitments", row["id"], text=row["text"], authority="user_requested_reminder",
                            version=row["updated_at"], at=row["created_at"], evidence=[row["created_line"]] if row["created_line"] else [],
                            details={"due_at": row["due_at"], "state": row["state"],
                                "uncertainty": "Fulfilled means the reminder was delivered, not that the user completed the underlying activity."})

    def _behavior(self):
        if self.behavior_context is None:
            return None
        raw = self.behavior_context() if callable(self.behavior_context) else self.behavior_context
        assessment = activity_assessment(raw, self.clock())
        if not assessment["available"]:
            return None
        return self._record("behavior", "current", text="Recent activity cues; not a judgement of the user's psychology or personality.",
                            authority="inferred_hypothesis", version=assessment["observed_at"], at=assessment["observed_at"],
                            evidence=assessment["assessment"].get("source_refs", []), details=assessment)

    def _task_context(self):
        if self.task_understanding is None: return None
        context = self.task_understanding() if callable(self.task_understanding) else self.task_understanding.context()
        if not context.get('available'): return None
        # Task evidence changes when the hypothesis changes, not every time an
        # unrelated frame arrives or a queue-age timer advances. Live capture
        # coverage is available separately through observation_status/read.
        context={key:context[key] for key in ('available','character_id','consent_epoch','version',
            'hypotheses','segments','task_corrections','uncertainties') if key in context}
        hypotheses = context.get('hypotheses', [])
        if not hypotheses and not context.get('segments'): return None
        return self._record('task_context', 'current', text='Current task hypotheses (unconfirmed): '+ '; '.join(r['task'] for r in hypotheses),
            authority='inferred_hypothesis', version=_digest(context),
            evidence=[ref for row in hypotheses for ref in row.get('source_refs', [])], details=context)

    def _raw_rows(self, source, query="", profile=False):
        """Yield a bounded candidate set. Item permission is checked before serialization."""
        if not self._allowed(source):
            return
        if source == "memory" and self.memory is not None:
            candidates = []
            for row in reversed(self.memory.visible(self.character_id)):
                if self._allowed(source, row) and (row["source"] in TRUSTED or self.permitted is not None):
                    item = self._fact(row)
                    if profile and (item["kind"] not in PROFILE_KINDS or item["authority"] not in TRUSTED):
                        continue
                    if query.strip() and _related(query, item) == 0:
                        continue
                    candidates.append(item)
            yield from candidates[:MAX_SCAN]
        elif source == "history" and self.history is not None:
            if query.strip():
                # Query the existing FTS index before bounding candidate count;
                # long-term history is not restricted to the last 1,000 turns.
                for match in self.history.search(query, k=MAX_SCAN, skip_recent=0, character_id=self.character_id):
                    row = self._raw_read(source, match["turn_id"])
                    if row is not None:
                        yield row
                return
            before, seen = None, 0
            while seen < MAX_SCAN:
                rows, before = self.history.page(before=before, limit=min(200, MAX_SCAN - seen), stored=True)
                seen += len(rows)
                for row in rows:
                    if self._allowed(source, row):
                        item = self._history(row)
                        if item is not None:
                            yield item
                if before is None:
                    break
        elif source == "episodes" and self.episodes is not None:
            # The existing store has no bounded reverse-page API. Fetch IDs under
            # its lock, then use get() so its current summary/version shape wins.
            if query.strip():
                ids = [row["id"] for row in self.episodes.search(query, k=MAX_SCAN)]
            else:
                with self.episodes.lock:
                    ids = [row[0] for row in self.episodes.db.execute("SELECT id FROM episodes ORDER BY start DESC, id DESC LIMIT ?", (MAX_SCAN,))]
            for ident in ids:
                row = self.episodes.get(ident)
                if row is not None and self._allowed(source, row):
                    yield self._episode(row)
        elif source == "commitments" and self.commitments is not None:
            for row in self.commitments.list()[:MAX_SCAN]:
                if self._allowed(source, row):
                    yield self._commitment(row)
        elif source == "task_context":
            item = self._task_context()
            if item is not None and self._allowed(source, item): yield item
        elif source == "behavior":
            item = self._behavior()
            if item is not None and self._allowed(source, item):
                yield item
        elif source == 'briefs' and self.observation_briefs is not None:
            for row in self.observation_briefs.list():
                yield self._brief(row)
        elif source == 'observations' and self.observations is not None:
            for item in self.observations.search(query).get('items',[]):
                row=self.observations.get(item['id'])
                if row is not None: yield self._observation(row)
        elif source == 'tasks' and self.worklog is not None:
            for row in self.worklog.tasks()[:MAX_SCAN]:
                if self._allowed(source, row):
                    yield self._task(row)
        elif source == 'days' and self.worklog is not None:
            today = datetime.date.fromtimestamp(self.clock())
            for back in range(DAYS_BACK):
                for period in ('day', 'week'):
                    row = self.worklog.day((today - datetime.timedelta(days=back)).isoformat(), period)
                    if row is not None and row['state'] == 'completed' and self._allowed(source, row):
                        yield self._day(row)

    def _task(self, row):
        return self._record('tasks', row['id'], text='\n'.join(t for t in (row['title'], row['goal'], row['progress'], row['next_step']) if t),
            authority='user_corrected' if row['edited'] else 'inferred', version=row['revision'], at=row['last_at'], kind=row['status'],
            details={k: row[k] for k in ('project', 'goal_authority', 'status', 'status_authority', 'blockers', 'first_at', 'sessions')})

    def _day(self, row):
        body = row['body']
        text = '\n'.join([row['headline']] + [f"{p.get('project')}：{p.get('summary')}" for p in body.get('projects', [])])
        return self._record('days', row['id'], text=text, authority='inferred', version=row['generated_at'],
            at=row['generated_at'], kind=row['period'], evidence=row['sources'],
            details={'date': row['date'], 'partial': row['partial'], **{k: body.get(k, []) for k in ('projects', 'open_loops', 'tomorrow')}})

    def _observation(self,row):
        return self._record('observations',row['id'],text=row['text'],authority='observed_analysis' if row['origin']=='work_event' else 'observed_content',
            version=row['revision'],at=row['at'],kind=row['origin'],evidence=[row['id']],
            details={'metadata':row['metadata'],'content_hash':row['content_hash']})

    def _brief(self, row):
        return self._record('briefs', row['id'], text=_json(row), authority='observed_analysis',
            version=_digest(row), at=row['generated_at'], kind=row['period'],
            evidence=[r['source_id'] for section in ('observed_details','recurring_problems','next_steps') for item in row[section] for r in item['evidence']])

    def _raw_read(self, source, ident):
        if not self._allowed(source):
            return None
        if source=='observations' and self.observations is not None:
            row=self.observations.get(ident)
            return self._observation(row) if row is not None else None
        if source == 'briefs' and self.observation_briefs is not None:
            row = self.observation_briefs.get(ident)
            return self._brief(row) if row is not None else None
        # Direct reads cover an explicitly selected item outside a search's scan
        # window without making the entire source available to the model.
        if source == "history" and self.history is not None:
            from personal.history import SELECT, COLUMNS
            with self.history.lock:
                raw = self.history.db.execute(SELECT + " WHERE turn_id = ? ORDER BY id DESC LIMIT 1", (ident,)).fetchone()
            row = dict(zip(COLUMNS, raw)) if raw is not None else None
            return self._history(row) if row is not None and self._allowed(source, row) else None
        if source == "episodes" and self.episodes is not None:
            row = self.episodes.get(ident)
            return self._episode(row) if row is not None and self._allowed(source, row) else None
        if source == "memory" and self.memory is not None:
            return next((self._fact(row) for row in self.memory.visible(self.character_id) if row["fact_id"] == ident
                         and self._allowed(source, row) and (row["source"] in TRUSTED or self.permitted is not None)), None)
        return next((row for row in self._raw_rows(source) if row["id"] == ident), None)

    def _dependency(self, row):
        return {"source": row["source"], "id": row["id"], "version": row["version"], "hash": _digest(self._stable_record(row))}

    @staticmethod
    def _stable_record(row):
        # Same immutable revision, seen again: update visible last-seen time
        # without invalidating a model's already-read content dependency.
        return {key:value for key,value in row.items() if key!='recorded_at'} if row.get('source')=='observations' else row

    def _remember(self, row, clean):
        with self._lock:
            key = (row["source"], row["id"])
            if key not in self._dependencies and len(self._dependencies) >= MAX_DEPENDENCIES:
                self._overflow = True
                return
            self._dependencies[key] = {**self._dependency(row), "export_hash": _digest(self._stable_record(clean))}

    def dependencies(self):
        with self._lock:
            deps = [dict(d) for d in self._dependencies.values()]
            return deps + ([{"source": "overflow", "id": "context", "version": None, "hash": ""}] if self._overflow else [])

    def record_prompt_uses(self, run_id):
        """Call only when dispatching a prompt or returning material to its tool loop."""
        if self.memory is not None:
            self.memory.record_uses([(d['id'], d['version']) for d in self.dependencies()
                                     if d['source'] == 'memory'], run_id, 'injected')

    def own_memory_change(self, fact_id):
        """Only an acknowledged mutation by this run can replace its old fact dependency."""
        with self._lock:
            self._dependencies.pop(("memory", fact_id), None)

    def valid(self, dependencies=None):
        for dep in self.dependencies() if dependencies is None else dependencies:
            if not isinstance(dep, dict) or dep.get("source") not in SOURCES:
                return False
            try:
                row = self._raw_read(dep["source"], dep["id"])
                if row is None or any(dep.get(k) != value for k, value in self._dependency(row).items()):
                    return False
                if dep.get("export_hash") != _digest(self._stable_record(self.sanitize(row))):
                    return False  # guard/redaction policy can change after the read
            except (ValueError, TypeError, KeyError, OutboundBlocked):
                return False
        return True

    def fingerprint(self):
        """Fingerprint the visible source state, without retaining private content."""
        records = [self._dependency(row) for source in SOURCES for row in self._raw_rows(source)]
        return _digest({"sources": records, "permissions": {s: self._allowed(s) for s in SOURCES}})

    @staticmethod
    def _fit(item, budget):
        if len(_json(item)) <= budget:
            return item, False
        item = dict(item)
        item.pop("details", None)
        item["details_omitted"] = True
        item["evidence"] = item["evidence"][:3]
        if len(_json({**item, "text": ""})) > budget:
            item["evidence"] = []
            item["evidence_omitted"] = True
        text, lo, hi = item["text"], 0, len(item["text"])
        item["truncated"] = True
        while lo < hi:
            mid = (lo + hi + 1) // 2
            item["text"] = text[:mid]
            if len(_json(item)) <= budget:
                lo = mid
            else:
                hi = mid - 1
        item["text"] = text[:lo]
        return (item if len(_json(item)) <= budget else None), True

    def _page(self, rows, args, query_key):
        limit = _bounded_int(args.get("limit"), 8, 1, MAX_LIMIT)
        budget = _bounded_int(args.get("max_chars"), 6000, 1024, MAX_CHARS)
        snapshot = _digest([self._dependency(row) for row in rows])
        offset = 0
        cursor = args.get("cursor")
        if cursor is not None:
            try:
                if not isinstance(cursor, str) or len(cursor) > 1024:
                    raise ValueError()
                cursor_data = json.loads(base64.urlsafe_b64decode(cursor.encode()))
                if cursor_data["query"] != query_key or cursor_data["snapshot"] != snapshot:
                    return _error("cursor_stale")
                offset = _bounded_int(cursor_data["offset"], 0, 0, len(rows))
            except (ValueError, KeyError, TypeError, UnicodeError):
                return _error("invalid_cursor")
        items, truncated = [], False
        next_offset = offset
        for row in rows[offset:]:
            if len(items) >= limit or budget < 256:
                break
            try:
                clean = self.sanitize(row)
            except OutboundBlocked:
                next_offset += 1
                continue
            full_clean = clean
            clean, clipped = self._fit(clean, budget)
            if clean is None:
                break
            # Permission is rechecked immediately before material leaves. A
            # concurrent deletion is also detected by valid() at dispatch.
            if self._raw_read(row["source"], row["id"]) != row:
                return _error("source_changed")
            items.append(clean)
            self._remember(row, full_clean)
            budget -= len(_json(clean))
            truncated |= clipped
            next_offset += 1
        next_cursor = None
        if next_offset < len(rows) and next_offset > offset:
            next_cursor = base64.urlsafe_b64encode(_json({"query": query_key, "snapshot": snapshot, "offset": next_offset}).encode()).decode()
        return {"items": items, "next_cursor": next_cursor, "truncated": truncated,
                "retrieval": {"method": "bounded_lexical_and_alias", "candidate_limit_per_source": MAX_SCAN,
                              "complete_corpus_search": False}, "material_is_instruction": False}

    def call(self, name, args):
        try:
            return self._call(name, args)
        except (ValueError, TypeError, KeyError):
            return _error("invalid_arguments")

    def _call(self, name, args):
        schemas = {d["name"]: d["input_schema"] for d in self.tool_definitions()}
        if name not in schemas:
            return _error("unknown_tool")
        if not isinstance(args, dict) or set(args) - schemas[name]["properties"].keys():
            return _error("invalid_arguments")
        if name.startswith('observation_'):
            if self.observations is None or not self._allowed('observations'): return _error('source_not_permitted')
            source_id=args.get('observation_id')
            row=self.observations.get(source_id) if source_id else None
            if source_id and row is None: return _error('source_unavailable')
            if row is not None:
                record=self._observation(row)
                self._remember(record,self.sanitize(record))
            if name=='observation_status': return self.observations.context()
            if name=='observation_search': return self.observations.search(**args)
            if name=='observation_read': return self.observations.read(source_id,args.get('offset',0),args.get('max_chars',16000),args.get('query'),args.get('part','text'))
            if name=='observation_changes': return self.observations.changes(source_id,args.get('max_chars',16000),args.get('offset',0))
            if name=='observation_image':
                result=self.observations.image(source_id)
                if 'content' in result: self.observation_images.add(source_id)
                return result
            if name=='observation_refresh': return self.observations.refresh(args.get('mode','text'),source_id)
        if name == "knowledge_read":
            source, ident = args.get("source"), args.get("id")
            if source not in SOURCES or not isinstance(ident, str) or not 1 <= len(ident) <= 256:
                return _error("invalid_arguments")
            if not self._allowed(source):
                return _error("source_not_permitted")
            row = self._raw_read(source, ident)
            if row is None:
                return _error("source_unavailable")
            return self._page([row], args, _digest([name, source, ident]))
        if name in ("behavior_context", "task_context"):
            source = "behavior" if name == "behavior_context" else "task_context"
            if not self._allowed(source):
                return {"available": False, "reason": "source_not_permitted", "items": []}
            rows = list(self._raw_rows(source))
            if not rows:
                return {"available": False, "reason": "no_fresh_observation", "items": []}
            result = self._page(rows, args, _digest([name]))
            return {"available": "error" not in result, **result}
        if name == "personal_profile":
            rows = list(self._raw_rows("memory", profile=True))
            return {**self._page(rows, args, _digest([name])),
                    "memory_storage_paused": bool(self.memory is not None and self.memory.paused()),
                    "profile_kind": "user_confirmed_preferences_not_inferred_personality"}
        query = args.get("query", "")
        sources = args.get("sources", list(SOURCES))
        if not isinstance(query, str) or len(query) > 2000 or not isinstance(sources, list) or not sources \
                or len(sources) > len(SOURCES) or any(s not in SOURCES for s in sources):
            return _error("invalid_arguments")
        sources = list(dict.fromkeys(sources))
        return self._page(self._ranked(query, sources), args, _digest([name, query, sources]))

    def _ranked(self, query, sources):
        ranked = []
        for source in sources:
            for row in self._raw_rows(source, query=query):
                score = _related(query, row)
                if query.strip() and score == 0:
                    continue
                ranked.append((score, row))
        ranked.sort(key=lambda item: (-item[0], -(item[1]["recorded_at"] or 0), item[1]["reference"]))
        return [row for _, row in ranked]

    def related_facts(self, query, exclude, *, limit, max_chars):
        """User-stated or confirmed memory facts sharing words with query, ranked as knowledge_search ranks them."""
        if not query.strip():
            return []
        rows = [row for row in self._ranked(query, ["memory"]) if row["authority"] in TRUSTED and row["id"] not in exclude]
        return self._page(rows, {"limit": limit, "max_chars": max_chars}, _digest(["related_facts", query])).get("items", [])
