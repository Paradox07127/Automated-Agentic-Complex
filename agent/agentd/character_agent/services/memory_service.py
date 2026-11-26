"""Role-owned memory tools and an inspectable generation journal, outside SDK state.

An added fact is the user's own only when its text is a verbatim excerpt of the current
user message; any other is a candidate, never silently a confirmed user fact. Correcting
or forgetting a fact waits for the user's single-use approval card.
Mutations and their receipts commit in the same transaction as the fact.
"""
import hashlib
import json
import sqlite3
import threading
import time
import uuid
import weakref

from character_agent.services.interactions import approved
from personal.memory import KINDS

DETAIL_KEEP = 48 * 3600
RUN_KEEP = 30 * 86400
# The single-use approval card's titles for her correcting or forgetting a fact, by reply language code.
CHANGE_CARD = {'zh-Hans': {'correct': '更正记忆：{} → {}', 'forget': '忘记记忆：{}'},
               'en': {'correct': 'Correct memory: {} → {}', 'forget': 'Forget memory: {}'},
               'ja': {'correct': '記憶を訂正する：{} → {}', 'forget': '記憶を忘れる：{}'}}


def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


def error(code):
    return {"error": {"code": code, "retryable": False}}


class MemoryJournal:
    def __init__(self, memory, clock=time.time, *, interactions, language=lambda: None):
        """interactions: the approval cards correct and forget wait for; None asks no one.
        language: the reply language code for those cards."""
        self.memory, self.clock = memory, clock
        self.interactions, self.language = interactions, language
        with self.memory.lock:
            # No SDK session survives an agentd process restart. Close its audit
            # span too, and let _purge apply the normal interrupted-content rule.
            self.memory.db.execute("UPDATE memory_agent_runs SET state='interrupted',finished_at=? WHERE state='running'",
                                   (self.clock(),))
            self._purge()
            self.memory.db.commit()
        self._schedule_purge()

    def _schedule_purge(self):
        reference = weakref.ref(self)
        def purge():
            journal = reference()
            if journal is None: return
            try:
                with journal.memory.lock:
                    journal._purge()
                    journal.memory.db.commit()
            except sqlite3.ProgrammingError:
                return  # The owner has closed its store.
            journal._schedule_purge()
        timer = threading.Timer(3600,purge)
        timer.daemon = True
        timer.start()

    def _purge(self):
        db, now = self.memory.db, self.clock()
        rows = db.execute("SELECT run_id,detail FROM memory_agent_runs WHERE state IN ('failed','cancelled','interrupted','rejected')"
                          " AND detail IS NOT NULL").fetchall()
        for ident,raw in rows:
            detail = json.loads(raw)
            if isinstance(detail.get('request'),str):
                request = json.loads(detail['request'])
                proposals = [p for p in detail.get('proposals',[]) if p['receipt'].get('outcome') in ('stored','candidate','corrected','forgotten','unchanged')]
                db.execute('UPDATE memory_agent_runs SET detail=? WHERE run_id=?',
                    (dump({**MemoryTurn.fingerprints(request),'proposals':proposals}),ident))
        db.execute("UPDATE memory_agent_runs SET detail=NULL,redacted_reason='expired' WHERE started_at<? AND detail IS NOT NULL",
                   (now - DETAIL_KEEP,))
        db.execute("DELETE FROM memory_agent_events WHERE run_id IN (SELECT run_id FROM memory_agent_runs WHERE started_at<?)",
                   (now - RUN_KEEP,))
        db.execute("DELETE FROM memory_agent_runs WHERE started_at<?", (now - RUN_KEEP,))

    def list(self, limit=50):
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("invalid_limit")
        with self.memory.lock:
            self._purge()
            rows = self.memory.db.execute("SELECT run_id,backend,model,character_id,started_at,finished_at,state,"
                "prompt_version,redacted_reason FROM memory_agent_runs ORDER BY started_at DESC,rowid DESC LIMIT ?", (limit,)).fetchall()
            self.memory.db.commit()
        keys = ("run_id", "backend", "model", "character_id", "started_at", "finished_at", "state", "prompt_version", "redacted_reason")
        return [dict(zip(keys, row)) for row in rows]

    def index(self, start, end, kinds):
        """Content-free daily projection for the timeline's run inspector."""
        with self.memory.lock:
            self._purge()
            rows=self.memory.db.execute("SELECT r.run_id,r.backend,r.model,r.started_at,r.finished_at,r.state,r.prompt_version,"
                "MIN(e.start),MAX(e.end),MIN(e.id) FROM memory_agent_runs r LEFT JOIN episodes e ON e.run_id=r.run_id "
                "WHERE r.started_at>=? AND r.started_at<? GROUP BY r.run_id ORDER BY r.started_at DESC,r.rowid DESC",(start,end)).fetchall()
            self.memory.db.commit()
        return [{'run_id':ident,'kind':version.removesuffix('-v2'),'backend':backend,'model':model,'started_at':at,
            'span_start':first,'span_end':last,'episode_id':episode,'outcome':state,'error':None,'attempt':1,
            'duration_ms':round(((done or at)-at)*1000),'reasons':[]} for ident,backend,model,at,done,state,version,first,last,episode in rows
            if version.removesuffix('-v2') in kinds]

    def get(self, run_id):
        with self.memory.lock:
            self._purge()
            row = self.memory.db.execute("SELECT backend,model,character_id,started_at,finished_at,state,prompt_version,"
                "input_sha256,detail,redacted_reason FROM memory_agent_runs WHERE run_id=?", (run_id,)).fetchone()
            events = self.memory.db.execute("SELECT seq,at,event,metadata FROM memory_agent_events WHERE run_id=? ORDER BY seq", (run_id,)).fetchall()
            self.memory.db.commit()
        if row is None:
            return None
        keys = ("backend", "model", "character_id", "started_at", "finished_at", "state", "prompt_version", "input_sha256", "detail", "redacted_reason")
        result = {"run_id": run_id, **dict(zip(keys, row))}
        result["detail"] = json.loads(row[8]) if row[8] else None
        if result['detail'] is not None and not isinstance(result['detail'].get('request'),str):
            result['detail'] = {**result['detail'], 'user_input':'', 'request':'', 'request_truncated':False,
                                'proposals':result['detail'].get('proposals',[])}
        result["events"] = [{"seq": seq, "at": at, "event": event, **json.loads(meta)} for seq, at, event, meta in events]
        return result

    def clear(self):
        with self.memory.lock:
            self.memory.db.execute("DELETE FROM memory_agent_events")
            self.memory.db.execute("DELETE FROM memory_agent_runs")
            self.memory.db.commit()

    def redact(self, reason):
        with self.memory.lock:
            self.memory.content_epoch += 1
            self.memory.db.execute('UPDATE memory_agent_runs SET detail=NULL,redacted_reason=? WHERE detail IS NOT NULL', (reason,))
            self.memory.db.commit()

    def turn(self, run_id, text, backend, model, character_id, request, *, allowed=True, purpose='conversation'):
        return MemoryTurn(self, run_id, text, backend, model, character_id, request, allowed, purpose)


class MemoryTurn:
    def __init__(self, journal, run_id, text, backend, model, character_id, request, allowed, purpose='conversation'):
        self.journal, self.memory = journal, journal.memory
        self.run_id, self.text, self.backend, self.model = run_id, text, backend, model
        self.character_id, self.request, self.allowed = character_id, request, allowed
        self.epoch, self.current, self.opened = None, lambda: False, False
        self.changed, self.receipts = [], {}
        self.stored = []
        self.purpose = purpose
        self.detail = None

    @staticmethod
    def fingerprints(request):
        result = {}
        for key,value in request.items():
            text = value if isinstance(value,str) else dump(value)
            result[key] = {'sha256':hashlib.sha256(text.encode()).hexdigest(),'length':len(text)}
        return result

    @staticmethod
    def tool_definitions():
        return [{"name": "memory_propose", "description":
            "Remember, correct or forget a durable fact about the user when it should be saved or updated. "
            "An add is stored as the user's own only when text and evidence_quote are the same verbatim excerpt of the current user message; "
            "otherwise it is kept as a candidate for the user to review. "
            "For correct and forget, first find the fact (personal_profile or knowledge_read), then pass its fact_id and current version "
            "as expected_version; the user sees a confirmation card and nothing changes until they allow it (error user_declined otherwise). "
            "Read the receipt's outcome (stored, candidate, unchanged, corrected, forgotten) before telling the user what happened.",
            "input_schema": {"type": "object", "properties": {
                "operation": {"type": "string", "enum": ["add", "correct", "forget"], "description": "add a new fact, correct an existing one, or forget one."},
                "text": {"type": "string", "maxLength": 2000, "description": "The fact as stored (required for add and correct)."},
                "scope": {"type": "string", "enum": ["shared", "character"], "description": "For add, use character for nicknames, promises, private jokes and instructions specific to this relationship. General user facts are shared (default)."},
                "kind": {"type": "string", "enum": list(KINDS), "description": "Category; defaults to fact. Ignored for correct/forget."},
                "evidence_quote": {"type": "string", "maxLength": 2000, "description": "Optional verbatim excerpt of the current user message this change is based on."},
                "fact_id": {"type": "string", "maxLength": 128, "description": "correct/forget only: id of the existing fact."},
                "expected_version": {"type": "integer", "minimum": 1, "description": "correct/forget only: the fact's current version."},
                "target_quote": {"type": "string", "maxLength": 2000, "description": "Optional phrase identifying the target fact."}},
                "required": ["operation"], "additionalProperties": False}}]

    def open(self, current):
        self.current = current
        with self.memory.lock:
            if not self.allowed or self.memory._paused() or not current():
                return
            self.epoch = self.memory.content_epoch
            self.journal._purge()
            # Preserve the assembled request and visible output, never a pretend chain of thought.
            request = dump(self.request)
            detail = {"user_input": self.text, "request": request, "request_truncated": False,
                      "proposals": [], "context_refs": [], "output": None}
            if self.purpose != 'conversation': self.detail = detail
            stored = self.fingerprints(self.request) if self.detail is not None else detail
            self.memory.db.execute("INSERT INTO memory_agent_runs VALUES(?,?,?,?,?,NULL,'running',?,?,?,NULL)",
                (self.run_id, self.backend, self.model, self.character_id, self.journal.clock(), self.purpose + '-v2',
                 hashlib.sha256(request.encode()).hexdigest(), dump(stored)))
            self.memory.db.commit()
            self.opened = True

    def assembled(self, *, prompt, system_prompt, history, tools, continuation=None):
        """Bind the journal to the actual product request just before inference.

        Checkpoints and extension tools are assembled after open(). Recording the
        controller's earlier context alone omitted what the adapter actually saw.
        """
        request = {'system_prompt':system_prompt, 'prompt':prompt, 'history':history, 'tools':tools,
                   'continuation':continuation or {}}
        raw = dump(request)
        with self.memory.lock:
            if not self._valid(): return
            row = self.memory.db.execute('SELECT detail FROM memory_agent_runs WHERE run_id=?', (self.run_id,)).fetchone()
            if not row or not row[0]: return
            self.request = json.loads(raw)
            detail = self.detail if self.detail is not None else json.loads(row[0])
            detail['request'] = raw
            stored = self.fingerprints(self.request) if self.detail is not None else detail
            self.memory.db.execute('UPDATE memory_agent_runs SET input_sha256=?,detail=? WHERE run_id=?',
                (hashlib.sha256(raw.encode()).hexdigest(), dump(stored), self.run_id))
            self.memory.db.commit()

    def record(self, event, value):
        with self.memory.lock:
            if not self._valid(): return
            row = self.memory.db.execute('SELECT detail FROM memory_agent_runs WHERE run_id=?',(self.run_id,)).fetchone()
            if row and row[0]:
                detail = self.detail if self.detail is not None else json.loads(row[0])
                detail.setdefault('trace', []).append(dump({'event':event, **value}))
                if self.detail is None:
                    self.memory.db.execute('UPDATE memory_agent_runs SET detail=? WHERE run_id=?',(dump(detail), self.run_id))
                self._event(event, {'outcome':value.get('outcome'), 'reason':value.get('code')})
                self.memory.db.commit()

    def commit_extraction(self, receipt, proposals):
        """Join the caller's domain transaction; never commit a detached audit receipt."""
        db = self.memory.db
        if not db.in_transaction:
            raise RuntimeError('memory_transaction_required')
        row = db.execute('SELECT detail FROM memory_agent_runs WHERE run_id=?', (self.run_id,)).fetchone()
        if not self._valid() or row is None or row[0] is None:
            raise ValueError('memory_journal_unavailable')
        outcome = 'no_new_knowledge' if receipt['no_new_knowledge'] else 'committed'
        detail = self.detail if self.detail is not None else json.loads(row[0])
        detail.setdefault('trace', []).append(dump({'event':'memory_commit', **receipt}))
        detail['proposals'] = proposals
        db.execute('UPDATE memory_agent_runs SET state=?,detail=?,finished_at=? WHERE run_id=?',
            (outcome,dump(detail),self.journal.clock(),self.run_id))
        self._event('memory_commit', {'outcome':outcome,'stored':len(receipt['accepted']),'rejected':len(receipt['rejected'])})
        return outcome

    def outcome(self, state):
        if state == 'rejected':
            self.finish(state)
            return
        with self.memory.lock:
            if self._valid():
                self.memory.db.execute('UPDATE memory_agent_runs SET state=? WHERE run_id=?',(state,self.run_id))
                self.memory.db.commit()

    def _valid(self):
        return self.opened and self.allowed and self.current() and not self.memory._paused() and self.epoch == self.memory.content_epoch

    def _event(self, event, metadata, proposal=None):
        db = self.memory.db
        seq = db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM memory_agent_events WHERE run_id=?", (self.run_id,)).fetchone()[0]
        db.execute("INSERT INTO memory_agent_events VALUES(?,?,?,?,?)", (self.run_id, seq, self.journal.clock(), event, dump(metadata)))
        if proposal is not None:
            row = db.execute("SELECT detail FROM memory_agent_runs WHERE run_id=?", (self.run_id,)).fetchone()
            if row and row[0]:
                detail = json.loads(row[0])
                detail["proposals"].append(proposal)
                db.execute("UPDATE memory_agent_runs SET detail=? WHERE run_id=?", (dump(detail), self.run_id))

    def call(self, name, args, call_id=None):
        if name != "memory_propose" or not isinstance(args, dict):
            return error("invalid_memory_proposal")
        digest = hashlib.sha256(dump(args).encode()).hexdigest()
        with self.memory.lock:
            if not self._valid():
                return error("memory_write_not_allowed")
            if call_id and call_id in self.receipts:
                old_hash, receipt = self.receipts[call_id]
                return receipt if old_hash == digest else error("memory_call_conflict")
            card = self._card(args)
        if card is not None:
            language = self.journal.language()
            if not approved(self.journal.interactions, self.run_id, CHANGE_CARD.get(language, CHANGE_CARD['zh-Hans'])[args['operation']]
                            .format(*card), dict(args), valid=self.current, character_id=self.character_id, language=language):
                return error('user_declined')
        with self.memory.lock:
            if not self._valid():
                return error("memory_write_not_allowed")
            revision, epoch, changed_count, stored_count = self.memory.revision, self.memory.content_epoch, len(self.changed), len(self.stored)
            db = self.memory.db
            changed = False
            try:
                with db:
                    # One transaction holds the fact and its receipt. IMMEDIATE takes the write lock before
                    # the reads, against any other connection to the file (the agentd stores share this one).
                    db.execute("BEGIN IMMEDIATE")
                    db.execute("SAVEPOINT role_memory_change")
                    try:
                        result = self._change(args, approved=card is not None)
                        if not self._valid():
                            raise ValueError("memory_write_not_allowed")
                    except (ValueError, KeyError) as exc:
                        db.execute("ROLLBACK TO role_memory_change")
                        result = error(str(exc).strip("'"))
                        self.memory.revision, self.memory.content_epoch = revision, epoch
                        self.epoch = epoch
                    db.execute("RELEASE role_memory_change")
                    metadata = {"operation": args.get("operation") if args.get("operation") in ("add", "correct", "forget") else "invalid",
                                "outcome": "rejected" if result.get("error") else result["outcome"],
                                "reason": result.get("error", {}).get("code"),
                                **{k: result[k] for k in ("fact_id", "version") if k in result}}
                    valid = self._valid()
                    if not valid:
                        db.execute("UPDATE memory_agent_runs SET detail=NULL,redacted_reason='context_revoked' WHERE run_id=?", (self.run_id,))
                    self._event("proposal", metadata, {"proposal": args, "receipt": result} if valid else None)
                changed = not result.get("error")
            finally:
                if not changed:
                    self.memory.revision, self.memory.content_epoch = revision, epoch
                    self.epoch = epoch
                    del self.changed[changed_count:]
                    del self.stored[stored_count:]
            if call_id:
                self.receipts[call_id] = digest, result
            return result

    def _card(self, args):
        """Under lock: what the approval card for a correct or forget shows (the fact's text, then the new text), or None
        when none is due: another operation, no approval service, or a call the store refuses anyway."""
        op = args.get('operation')
        if op not in ('correct', 'forget') or self.journal.interactions is None:
            return None
        row = self.memory.db.execute("SELECT version,text FROM facts WHERE fact_id=? AND state='active' AND (owner IS NULL OR owner=?)",
                                     (args.get('fact_id'), self.character_id)).fetchone()
        if row is None or args.get('expected_version') != row[0] or self.memory._locked(args['fact_id']):
            return None
        return (row[1], args.get('text', '')) if op == 'correct' else (row[1],)

    def _change(self, args, approved=False):
        """approved: the user allowed this correct or forget on its card."""
        allowed = {"operation", "text", "kind", "scope", "evidence_quote", "fact_id", "expected_version", "target_quote"}
        scope = args.get("scope", "shared")
        if set(args) - allowed or scope not in ("shared", "character"):
            raise ValueError("invalid_memory_proposal")
        op, quote, text = args.get("operation"), args.get("evidence_quote"), args.get("text", "")
        if op not in ("add", "correct", "forget") or not isinstance(text, str) or len(text) > 2000 \
                or (quote is not None and (not isinstance(quote, str) or not 2 <= len(quote) <= 2000)):
            raise ValueError("unsupported_user_evidence")
        if op != "forget" and not text.strip():
            raise ValueError("memory_requires_verbatim_evidence")
        kind = args.get("kind", "fact")
        if kind not in KINDS:
            raise ValueError("invalid_kind")
        db = self.memory.db
        ident, version = args.get("fact_id"), args.get("expected_version")
        if op != "add":
            row = db.execute("SELECT version,kind,text,owner FROM facts WHERE fact_id=? AND state='active' AND (owner IS NULL OR owner=?)", (ident,self.character_id)).fetchone()
            if row is None:
                raise ValueError("unknown_fact")
            if isinstance(version, bool) or version != row[0]:
                raise ValueError("memory_version_changed")
            if self.memory._locked(ident):
                raise ValueError("memory_locked")
            # No card was shown: the fact only now matches expected_version.
            if self.journal.interactions is not None and not approved:
                raise ValueError("memory_version_changed")
            target = args.get("target_quote")
            if target is not None and (not isinstance(target, str) or len(target) > 2000):
                raise ValueError("memory_target_not_authorized")
            kind = row[1]
        if op == "add":
            if ident is not None or version is not None:
                raise ValueError("invalid_memory_proposal")
            # A name or birthday becomes the user's own only when they confirm it themselves (Memory.add).
            explicit = quote is not None and text == quote and quote in self.text and kind not in ("name", "birthday")
            source, state = ("asserted_by_user", "active") if explicit else ("inferred_hypothesis", "candidate")
            # Her own guess must not bring back words the user had erased; the user asking again may.
            if not explicit and self.memory._suppressed(text):
                raise ValueError('previously_rejected')
            owner = self.character_id if scope == "character" else None
            old = db.execute("SELECT fact_id,version FROM facts WHERE text=? AND kind=? AND source=? AND state=? AND owner IS ?",
                             (text, kind, source, state, owner)).fetchone()
            if old:
                return {"outcome": "unchanged", "fact_id": old[0], "version": old[1]}
            ident, version = str(uuid.uuid4()), 1
            self.memory._insert(ident, version, kind, text, source, dump(["role_run:" + self.run_id]), None, state=state, owner=owner,
                                by="character")
            outcome, authority = ("stored", "current_user_message") if explicit else ("candidate", "model_proposed")
            self.stored.append(ident)
        elif op == "correct":
            self.memory._tombstone(ident)
            db.execute("UPDATE facts SET state='corrected' WHERE fact_id=? AND state='active'", (ident,))
            version += 1
            self.memory._insert(ident, version, kind, text, "asserted_by_user", dump(["role_run:" + self.run_id]), None, owner=row[3],
                                by="character")
            self.memory._redact_agent_journal()
            self.epoch = self.memory.content_epoch
            self.changed.append((ident, False))
            outcome = "corrected"
        else:
            self.memory._tombstone(ident)
            db.execute("UPDATE facts SET text=NULL,state='deleted' WHERE fact_id=?", (ident,))
            # Keep reference-only use IDs until the controller retracts prior
            # turns. Erasing them first would lose the history-erasure links.
            self.memory._redact_agent_journal()
            self.epoch = self.memory.content_epoch
            self.changed.append((ident, True))
            outcome = "forgotten"
        self.memory.revision += 1
        if op != "add":
            authority = "user_approved" if approved else "model_proposed"
        return {"outcome": outcome, "fact_id": ident, "version": version, "source": authority}

    def context(self, dependencies, mode="retrieved"):
        with self.memory.lock:
            if not self._valid():
                return
            self._event("context", {"mode": mode, "references": [{k: d.get(k) for k in ("source", "id", "version")} for d in dependencies]})
            self.memory.db.commit()

    def finish(self, state, output="", model=None, usage=None):
        with self.memory.lock:
            if not self.opened:
                return
            self.model = model or self.model
            # Extraction succeeds only when its domain transaction commits.
            deferred = self.purpose == 'memory_extract' and state == 'completed'
            row = self.memory.db.execute("SELECT detail FROM memory_agent_runs WHERE run_id=?", (self.run_id,)).fetchone()
            stored = json.loads(row[0]) if row and row[0] else {}
            proposals = [p for p in stored.get('proposals',[]) if p['receipt'].get('outcome') in ('stored','candidate','corrected','forgotten','unchanged')]
            if not self._valid() and not (proposals and self.allowed and not self.memory._paused() and self.epoch == self.memory.content_epoch):
                self.memory.db.execute("UPDATE memory_agent_runs SET detail=NULL,redacted_reason='context_revoked' WHERE run_id=?", (self.run_id,))
            else:
                if row and row[0]:
                    if state in ('failed','cancelled','interrupted','rejected') or not self._valid():
                        detail = {**self.fingerprints(self.request), 'proposals':proposals}
                    else:
                        detail = self.detail if self.detail is not None else json.loads(row[0])
                        detail["output"] = output
                        detail["output_truncated"] = False
                        detail["usage"] = usage or {}
                    if not deferred:
                        self.memory.db.execute("UPDATE memory_agent_runs SET detail=? WHERE run_id=?", (dump(detail), self.run_id))
            if deferred:
                self.memory.db.execute("UPDATE memory_agent_runs SET model=? WHERE run_id=?", (self.model, self.run_id))
            else:
                self.memory.db.execute("UPDATE memory_agent_runs SET state=?,model=?,finished_at=? WHERE run_id=?",
                    (state, self.model, self.journal.clock(), self.run_id))
            self.memory.db.commit()
