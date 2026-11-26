"""User fact memory:small, editable, versioned facts in the shared store, split by trust for injection."""
import datetime
import hashlib
import heapq
import json
import re
import threading
import time
import unicodedata
import uuid

from personal.history import terms

SOURCES = ("asserted_by_user", "observed_context", "inferred_hypothesis", "confirmed_by_user")
TRUSTED = ("asserted_by_user", "confirmed_by_user")
KINDS = ("fact", "preference", "experience", "agreement", "name", "birthday")
STATES = ("active", "candidate", "corrected", "deleted", "rejected")  # candidates are reviewable, never injected
OBSERVED = ("observed_context", "inferred_hypothesis")
CONSOLIDATED = "state IN ('active', 'candidate') AND source IN ('observed_context', 'inferred_hypothesis')"
COLUMNS = ("fact_id", "version", "kind", "text", "source", "evidence", "occurred_at", "recorded_at", "last_used_at",
           "reinforcement", "reinforced_at", "owner")
STALE_AFTER = 30 * 86400  # seconds since last use (or recording) after which a fact is stale
# N.E.K.O. memory/evidence.py (Apache-2.0) EVIDENCE_REIN_HALF_LIFE_DAYS = 30; there is no disputation signal here.
REINFORCE_HALF_LIFE = 30 * 86400
RESIDENT_KINDS = ("name", "agreement")  # trusted facts of these kinds go into every turn, query or not
RESIDENTS = 3
SELECT_CHARS = 200  # characters of fact text one turn may carry, residents included
CUT_MARK, CUT_LEAST = "…（完整见记忆页）", 20  # ends a fact cut to the room left; least characters kept before it
RELEVANT = 0.15  # least score a fact needs: one bigram shared with a fact of up to six bigrams
LOW_TRUST_RELEVANT = 0.5  # least bigram overlap for an unconfirmed fact, whatever its score
INJECTED_WITHIN, INJECTED_WEIGHT = 6 * 3600, 0.5  # seconds; a fact the last few turns carried steps back
MENTIONED_WITHIN, MENTIONED_WEIGHT = 3 * 86400, 0.3  # seconds; one she said lately steps back further
MENTION_RUN, MENTION_OVERLAP = 4, 0.3  # characters in a row, or bigram overlap, for a reply to mention a fact
RECENT_USES = 5
CLEARS = {"facts": " WHERE kind NOT IN ('name', 'birthday')", "all": ""}  # scope -> the facts clear(scope) deletes


class VersionConflict(ValueError):
    def __init__(self, current_version):
        super().__init__("version_conflict")
        self.current_version = current_version


class CascadeChanged(ValueError):
    """The other facts a correction or deletion retires are no longer the ones its preview showed."""
    def __init__(self, fact_ids):
        super().__init__("cascade_changed")
        self.fact_ids = fact_ids


def bigrams(text):
    """Character bigrams of each run of word characters; a one-character run stands for itself."""
    return {run[i:i + 2] for run in re.findall(r"\w+", text.lower()) for i in range(max(len(run) - 1, 1))}


def normalized_text(text):
    return ' '.join(unicodedata.normalize('NFKC', text).casefold().split())


def _fts_body(text):
    return " ".join(terms(text or ""))


def _fts_query(query):
    tokens = list(dict.fromkeys(terms(query or "")))
    return " OR ".join(f'"{t}"' for t in tokens) if tokens else None


def overlap(a, b):
    """Shared bigrams over the bigrams of the shorter text: a short query or fact can match in full."""
    return _overlap(bigrams(a), bigrams(b))


def _overlap(x, y):
    return len(x & y) / min(len(x), len(y)) if x and y else 0.0


def mentions(reply, text):
    """Whether a reply says a fact again: MENTION_RUN characters of it in a row, or MENTION_OVERLAP of its bigrams."""
    return any(text[i:i + MENTION_RUN] in reply for i in range(len(text) - MENTION_RUN + 1)) \
        or overlap(reply, text) >= MENTION_OVERLAP


def _episode(item):
    """Whether an evidence item names an episode: "episode:<id>@<YYYY-MM-DD>"."""
    return isinstance(item, str) and item.startswith("episode:")


def _clears(scope, owner):
    """The WHERE clause and its arguments that pick the facts clear(scope, owner) deletes."""
    if owner is None:
        return CLEARS[scope], ()
    return f"{CLEARS[scope] or ' WHERE 1'} AND owner IS ?", (None if owner == "shared" else owner,)


def evidence_score(reinforcement, reinforced_at, now):
    """N.E.K.O. effective_reinforcement: the summed signals halve every REINFORCE_HALF_LIFE after the last one.
    It is shown, never used to confirm a fact."""
    if not reinforcement or reinforced_at is None or now <= reinforced_at:
        return float(reinforcement)
    return reinforcement * 0.5 ** ((now - reinforced_at) / REINFORCE_HALF_LIFE)


class Memory:
    def __init__(self, db, lock=None, clock=time.time):
        self.db, self.clock = db, clock
        self.lock = threading.Lock() if lock is None else lock
        self.revision = 0  # bumped on every write; callers compare it before committing a reply
        self.content_epoch = 0  # revokes in-flight diagnostic content on pause/correction/deletion
        with self.lock:
            missing = self.db.execute("SELECT id, text FROM facts WHERE state IN ('active', 'candidate')"
                                      " AND text IS NOT NULL AND id NOT IN (SELECT rowid FROM facts_fts)").fetchall()
            if missing:
                self.db.executemany("INSERT INTO facts_fts (rowid, body) VALUES (?, ?)",
                                    [(row_id, _fts_body(text)) for row_id, text in missing])
                self.db.commit()

    def _redact_agent_journal(self):
        """Under lock: conservative erasure of diagnostic copies, including other runs' context."""
        self.content_epoch += 1
        self.db.execute("UPDATE memory_agent_runs SET detail=NULL,redacted_reason='memory_changed'")

    def _forget_words(self, fact_id):
        """Under lock: suppress every kept text of fact_id and the turns it came from; returns their evidence refs."""
        refs = []
        for text,evidence in self.db.execute('SELECT text,evidence FROM facts WHERE fact_id=? AND text IS NOT NULL',(fact_id,)).fetchall():
            self.db.execute('INSERT OR REPLACE INTO memory_tombstones VALUES(?,?)',
                (hashlib.sha256(normalized_text(text).encode()).hexdigest(), self.clock()))
            sources = {'history:'+str(turn or ident) for ident,turn in self.db.execute(
                'SELECT id,turn_id FROM history_turns WHERE instr(user_text,?)>0 OR instr(reply,?)>0',(text,text))}
            cited = json.loads(evidence)
            sources.update('history:'+ref[len('role_run:'):] for ref in cited if ref.startswith('role_run:'))
            refs += cited
            self.db.executemany('INSERT OR REPLACE INTO agent_memory_processed VALUES(?,?)',[(v,'forgotten') for v in sources])
        return refs

    def _tombstone(self, fact_id, within=None):
        """Suppress existing sources as well as the deleted words (normalized_text), and drop every affected fact's
        search rows; the caller retires fact_id itself.

        Automatic extraction must not replay the source into a fresh diagnostic
        log after the user erased a memory. All writes stay in the caller's transaction.
        within, from clear(): the fact_ids being cleared; an episode a fact outside them cites stays, with that fact.
        """
        by_episode = {}
        for ident, evidence in self.db.execute("SELECT fact_id,evidence FROM facts WHERE state IN ('active','candidate')"):
            for ref in json.loads(evidence):
                if _episode(ref): by_episode.setdefault(ref.split('@', 1)[0], set()).add(ident)
        pending, affected, removed_episodes = [fact_id], set(), set()
        while pending:
            current = pending.pop()
            if current in affected: continue
            affected.add(current)
            sources = set()
            for ref in self._forget_words(current):
                if _episode(ref):
                    ident=ref.split(':',1)[1].split('@',1)[0]
                    if within is not None and not by_episode.get('episode:' + ident, set()) <= within: continue
                    row=self.db.execute('SELECT threads FROM episodes WHERE id=? AND version=3',(ident,)).fetchone()
                    if row:
                        sources.update(v for t in json.loads(row[0]) for v in t.get('evidence',[]) if isinstance(v,str))
                        removed_episodes.add(ident)
                        pending.extend(by_episode.get('episode:' + ident, set()) - affected)
            self.db.executemany('INSERT OR REPLACE INTO agent_memory_processed VALUES(?,?)',[(v,'forgotten') for v in sources])
        # A v3 summary is shared by a batch. Retiring it must retire every dependent
        # fact, including confirmed versions, rather than leave claims without evidence.
        # The requested fact is handled by the caller (which may replace it with a correction).
        self.db.executemany('DELETE FROM fact_sightings WHERE fact_id=?', [(ident,) for ident in affected])
        self.db.executemany("DELETE FROM facts_fts WHERE rowid IN (SELECT id FROM facts WHERE fact_id=?)",
                            [(ident,) for ident in affected])
        self.db.executemany("UPDATE facts SET text=NULL,state='deleted' WHERE fact_id=?",
                            [(ident,) for ident in affected - {fact_id}])
        for table,key in (('episodes_fts','rowid'),('summary_corrections','episode_id'),('episodes','id')):
            self.db.executemany(f'DELETE FROM {table} WHERE {key}=?',[(v,) for v in removed_episodes])
        return affected

    def tombstoned(self, fact_id):
        """The other fact_ids correcting or deleting fact_id retires (the walk of _tombstone), sorted; KeyError unless
        fact_id is active or a candidate. Writes nothing."""
        with self.lock:
            if not self._live(fact_id):
                raise KeyError(fact_id)
            return self._cascade(fact_id)

    def _cascade(self, fact_id):
        """Under lock: tombstoned(fact_id) without the liveness check."""
        by_episode = {}
        for ident, evidence in self.db.execute("SELECT fact_id,evidence FROM facts WHERE state IN ('active','candidate')"):
            for ref in json.loads(evidence):
                if _episode(ref): by_episode.setdefault(ref.split('@', 1)[0], set()).add(ident)
        pending, affected = [fact_id], set()
        while pending:
            current = pending.pop()
            if current in affected: continue
            affected.add(current)
            for evidence, in self.db.execute('SELECT evidence FROM facts WHERE fact_id=? AND text IS NOT NULL', (current,)).fetchall():
                for ref in json.loads(evidence):
                    if _episode(ref):
                        ident = ref.split(':', 1)[1].split('@', 1)[0]
                        if self.db.execute('SELECT 1 FROM episodes WHERE id=? AND version=3', (ident,)).fetchone():
                            pending.extend(by_episode.get('episode:' + ident, set()) - affected)
        return sorted(affected - {fact_id})

    def _check_cascade(self, fact_id, cascade):
        """Under lock: raises CascadeChanged unless cascade (the previewed ids; None: unchecked) is what it retires."""
        if cascade is not None and sorted(set(cascade)) != (current := self._cascade(fact_id)):
            raise CascadeChanged(current)

    def revoked_with(self, fact_ids):
        """Content-free closure of retired facts sharing the requested facts' evidence.

        Keep these links after erasure so the delivery layer can retract dependent
        speech/history too. A replacement active version is never reported as deleted.
        """
        with self.lock:
            refs, live = {}, set()
            for ident, state, evidence in self.db.execute('SELECT fact_id,state,evidence FROM facts'):
                refs.setdefault(ident, set()).update(ref.split('@', 1)[0] for ref in json.loads(evidence) if _episode(ref))
                if state in ('active', 'candidate'): live.add(ident)
            pending, visited = list(fact_ids), set()
            while pending:
                ident = pending.pop()
                if ident in visited: continue
                visited.add(ident)
                pending.extend(other for other in refs.keys() - live - visited if refs.get(ident, set()) & refs[other])
            return (visited & refs.keys()) - live

    def add(self, text, source, kind="fact", evidence=(), occurred_at=None, manual=False, state="active", expected_absent=False,
            by="user"):
        if not text or not text.strip():
            raise ValueError("blank text")
        if source not in SOURCES:
            raise ValueError(f"unknown source {source!r}")
        if kind not in KINDS:
            raise ValueError(f"unknown kind {kind!r}")
        if kind in ("name", "birthday") and source != "confirmed_by_user":
            raise ValueError(f"{kind} must be confirmed_by_user")
        if kind == "preference" and source == "observed_context" and state != "candidate":
            raise ValueError("an observed opinion is not a user preference")
        if state not in ("active", "candidate"):
            raise ValueError(f"unknown state {state!r}")
        if state == "candidate" and source not in OBSERVED:
            raise ValueError("only an observed or inferred fact can be a candidate")
        fact_id = str(uuid.uuid4())
        with self.lock:
            if self._paused() and not manual:
                return None
            if expected_absent:
                old = self.db.execute("SELECT version FROM facts WHERE kind=? AND state IN ('active','candidate')", (kind,)).fetchone()
                if old: raise VersionConflict(old[0])
            self._insert(fact_id, 1, kind, text, source, json.dumps(list(evidence)), occurred_at, state=state, by=by)
            self.db.commit()
            self.revision += 1
        return fact_id

    def reinforce(self, text, kind="fact", source="asserted_by_user", manual=False):
        """The user said an active fact again: +1 to its score; returns its fact_id, or None (no such fact, or paused).
        Not a write the revision counts: the score is not in the facts a reply is made from."""
        with self.lock:
            if self._paused() and not manual:
                return None
            row = self.db.execute("SELECT id, fact_id FROM facts WHERE state = 'active' AND kind = ? AND text = ?"
                                  " AND source = ? AND owner IS NULL ORDER BY id DESC", (kind, text, source)).fetchone()
            if row is None:
                return None
            self.db.execute("UPDATE facts SET reinforcement = reinforcement + 1, reinforced_at = ? WHERE id = ?",
                            (self.clock(), row[0]))
            self.db.commit()
        return row[1]

    def correct(self, fact_id, text, *, expected_version=None, cascade=None):
        """cascade: the other fact_ids its preview (tombstoned) showed; CascadeChanged when they differ now."""
        return self._revise(fact_id, text, expected_version=expected_version, cascade=cascade)

    def confirm(self, fact_id, *, expected_version=None):
        return self._revise(fact_id, None, expected_version=expected_version)

    def reject(self, fact_id, *, expected_version):
        """Reject only a candidate, retaining a content-free suppression key."""
        with self.lock:
            row = self.db.execute("SELECT version,text FROM facts WHERE fact_id=? AND state='candidate'", (fact_id,)).fetchone()
            if row is None: raise KeyError(fact_id)
            if row[0] != expected_version: raise VersionConflict(row[0])
            self.db.execute('INSERT OR REPLACE INTO memory_tombstones VALUES(?,?)',
                            (hashlib.sha256(normalized_text(row[1]).encode()).hexdigest(), self.clock()))
            self.db.execute("DELETE FROM facts_fts WHERE rowid IN (SELECT id FROM facts WHERE fact_id=?)", (fact_id,))
            self.db.execute("UPDATE facts SET state='rejected',text=NULL WHERE fact_id=?", (fact_id,))
            self.db.execute('DELETE FROM fact_sightings WHERE fact_id=?', (fact_id,))
            self._redact_agent_journal()
            self.db.commit()
            self.revision += 1

    def _suppressed(self, text):
        """Under lock: whether a deletion or rejection of the same normalized text suppresses text."""
        key = hashlib.sha256(normalized_text(text).encode()).hexdigest()
        return self.db.execute('SELECT 1 FROM memory_tombstones WHERE digest=?', (key,)).fetchone() is not None

    def _sight(self, fact_id, sources, confidence):
        """Under the extraction transaction: independent evidence, never user-confirmation provenance."""
        self.db.executemany('INSERT OR IGNORE INTO fact_sightings VALUES(?,?,?,?)',
                            [(fact_id, s['source_id'], time.strftime('%Y-%m-%d', time.localtime(s['at'])), confidence)
                             for s in sources])
        days = self.db.execute('SELECT COUNT(DISTINCT day) FROM fact_sightings WHERE fact_id=? AND confidence>=0.8',
                               (fact_id,)).fetchone()[0]
        if days >= 3:
            self.db.execute("UPDATE facts SET state='active' WHERE fact_id=? AND state='candidate'", (fact_id,))

    def delete(self, fact_id, *, expected_version=None, cascade=None):
        """cascade as in correct()."""
        with self.lock:
            if expected_version is not None:
                row = self.db.execute("SELECT version FROM facts WHERE fact_id=? AND state IN ('active','candidate')", (fact_id,)).fetchone()
                if row is None: raise KeyError(fact_id)
                if row[0] != expected_version: raise VersionConflict(row[0])
            self._check_cascade(fact_id, cascade)
            self._tombstone(fact_id)
            changed = self.db.execute("UPDATE facts SET state = 'deleted', text = NULL WHERE fact_id = ?",
                                      (fact_id,)).rowcount
            if not changed:
                raise KeyError(fact_id)
            self._redact_agent_journal()
            self.db.commit()
            self.revision += 1

    def delete_since(self, cutoff, sources):
        """Deletes the facts whose active or candidate version came from `sources` and was recorded at or after
        cutoff; returns their fact_ids."""
        with self.lock:
            fact_ids = [row[0] for row in self.db.execute(
                f"SELECT fact_id FROM facts WHERE state IN ('active', 'candidate') AND recorded_at >= ?"
                f" AND source IN ({', '.join('?' * len(sources))})", (cutoff, *sources))]
            if fact_ids:
                affected = set(fact_ids)
                for fact_id in fact_ids: affected.update(self._tombstone(fact_id))
                fact_ids += sorted(affected - set(fact_ids))
                self._redact_agent_journal()
                self.db.executemany("UPDATE facts SET state = 'deleted', text = NULL WHERE fact_id = ?",
                                    [(fact_id,) for fact_id in fact_ids])
                self.db.commit()
                self.revision += 1
        return fact_ids

    def support(self, fact_id, evidence):
        """A consolidation found an observed fact again: its evidence gains the new items and its score +1; the text
        stays. False when memory is paused, the fact is locked or there is no such active or candidate observed fact."""
        with self.lock:
            if self._paused() or self._locked(fact_id):
                return False
            row = self.db.execute(f"SELECT id, evidence FROM facts WHERE fact_id = ? AND {CONSOLIDATED}",
                                  (fact_id,)).fetchone()
            if row is None:
                return False
            merged = list(dict.fromkeys(json.loads(row[1]) + list(evidence)))
            self.db.execute("UPDATE facts SET evidence = ?, reinforcement = reinforcement + 1, reinforced_at = ?"
                            " WHERE id = ?", (json.dumps(merged), self.clock(), row[0]))
            self.db.commit()
            self.revision += 1
        return True

    def promote(self, fact_id):
        """A candidate becomes active; False when fact_id is not a candidate."""
        with self.lock:
            changed = self.db.execute("UPDATE facts SET state = 'active' WHERE fact_id = ? AND state = 'candidate'",
                                      (fact_id,)).rowcount
            if changed:
                self.db.commit()
                self.revision += 1
        return bool(changed)

    def consolidated(self):
        """The active and candidate observed facts with an "episode:" evidence item, with their state."""
        with self.lock:
            rows = self.db.execute(f"SELECT {', '.join(COLUMNS)}, state FROM facts WHERE {CONSOLIDATED}"
                                   " ORDER BY recorded_at, id").fetchall()
        facts = [dict(zip((*COLUMNS, "state"), row)) for row in rows]
        for fact in facts:
            fact["evidence"] = json.loads(fact["evidence"])
        return [fact for fact in facts if any(_episode(item) for item in fact["evidence"])]

    def delete_derived(self, episode_ids=None):
        """Deletes the active and candidate observed facts with evidence from any of episode_ids (None: from any
        episode), every version as delete() does; returns their fact_ids."""
        with self.lock:
            fact_ids = self._derived(episode_ids)
            if fact_ids:
                affected = set(fact_ids)
                for fact_id in fact_ids: affected.update(self._tombstone(fact_id))
                fact_ids += sorted(affected - set(fact_ids))
                self._redact_agent_journal()
                self.db.executemany("UPDATE facts SET state = 'deleted', text = NULL WHERE fact_id = ?",
                                    [(fact_id,) for fact_id in fact_ids])
                self.db.commit()
                self.revision += 1
        return fact_ids

    def _derived(self, episode_ids):
        """Under the lock: the active and candidate observed facts with evidence from any of episode_ids (None: any)."""
        prefixes = None if episode_ids is None else tuple(f"episode:{row_id}@" for row_id in episode_ids)
        rows = self.db.execute(f"SELECT fact_id, evidence FROM facts WHERE {CONSOLIDATED}").fetchall()
        return [fact_id for fact_id, evidence in rows
                if any(_episode(item) and (prefixes is None or item.startswith(prefixes)) for item in json.loads(evidence))]

    def derived_preview(self, episode_ids, gone=()):
        """(fact_ids, episode ids) that delete_derived(episode_ids) would retire once the episodes in gone are
        deleted, following v3 episodes as _tombstone does; deletes nothing."""
        gone = {str(ident) for ident in gone}
        with self.lock:
            pending = self._derived(episode_ids)
            by_episode = {}
            for ident, evidence in self.db.execute("SELECT fact_id,evidence FROM facts WHERE state IN ('active','candidate')"):
                for ref in json.loads(evidence):
                    if _episode(ref): by_episode.setdefault(ref.split('@', 1)[0], set()).add(ident)
            affected, episodes = set(), set()
            while pending:
                current = pending.pop()
                if current in affected: continue
                affected.add(current)
                for (evidence,) in self.db.execute('SELECT evidence FROM facts WHERE fact_id=? AND text IS NOT NULL',
                                                   (current,)).fetchall():
                    for ref in json.loads(evidence):
                        if not _episode(ref): continue
                        ident = ref.split(':', 1)[1].split('@', 1)[0]
                        if ident not in gone and self.db.execute('SELECT 1 FROM episodes WHERE id=? AND version=3',
                                                                 (ident,)).fetchone():
                            episodes.add(ident)
                            pending.extend(by_episode.get('episode:' + ident, set()) - affected)
        return affected, episodes

    def active(self, sources=None, *, owner=None):
        return self._records('active', sources, owner=owner)

    def visible(self, character_id):
        return self._records('active', where=" AND (owner IS NULL OR owner=?)", args=(character_id,))

    def candidates(self, *, owner=None):
        return [{**row,'state':'candidate'} for row in self._records('candidate', owner=owner)]

    def search(self, query, *, character_id=None, states=("active",), k=200):
        """FTS5 BM25 search over indexed facts matching `states`; returns [(fact_id, score), ...] best-first."""
        fts = _fts_query(query)
        if fts is None or not states:
            return []
        marks = ", ".join("?" * len(states))
        owner_sql = "AND f.owner IS NULL" if character_id is None else "AND (f.owner IS NULL OR f.owner = ?)"
        args = (fts, *states, *(() if character_id is None else (character_id,)), k)
        with self.lock:
            rows = self.db.execute(
                f"SELECT f.fact_id, bm25(facts_fts) FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid"
                f" WHERE facts_fts MATCH ? AND f.state IN ({marks}) {owner_sql}"
                f" ORDER BY bm25(facts_fts), f.recorded_at DESC, f.id DESC LIMIT ?", args).fetchall()
        # SQLite bm25() returns negative scores where lower is better; normalize to strictly positive higher-is-better.
        return [(fact_id, max(1e-6, -float(score))) for fact_id, score in rows]

    def similar(self, text, kind, k=5, *, character_id=None):
        with self.lock:
            rows = self.db.execute("SELECT fact_id,text FROM facts WHERE kind=? AND state IN ('active','candidate')"
                                   " AND (owner IS NULL OR owner=?) ORDER BY recorded_at DESC,id DESC", (kind, character_id)).fetchall()
        query_grams = bigrams(text)
        def score(row):
            return _overlap(query_grams, bigrams(row[1]))
        if k is None or k < 0:
            matches = sorted(rows, key=score, reverse=True)[:k]
        else:
            matches = heapq.nlargest(k, rows, key=score)
        return [{"fact_id": fact_id, "text": value} for fact_id, value in matches]

    def _records(self, state, sources=None, *, owner=None, where="", args=()):
        if sources is not None:
            where += f" AND source IN ({', '.join('?' * len(sources))})"
            args += tuple(sources)
        if owner is not None:
            where += " AND owner IS ?"
            args += (None if owner == "shared" else owner,)
        with self.lock:
            rows = self.db.execute(f"SELECT {', '.join('f.' + c for c in COLUMNS)}, COALESCE(m.locked, 0),"
                                   f" COALESCE(m.quiet, 0) FROM facts f LEFT JOIN fact_marks m ON m.fact_id = f.fact_id"
                                   f" WHERE state = ?{where} ORDER BY recorded_at, id", (state,*args)).fetchall()
        facts = [dict(zip((*COLUMNS, "locked", "quiet"), row)) for row in rows]
        now = self.clock()
        for fact in facts:
            fact["locked"], fact["quiet"] = bool(fact["locked"]), bool(fact["quiet"])
            fact["evidence"] = json.loads(fact["evidence"])
            fact["stale"] = (fact["last_used_at"] or fact["recorded_at"]) < now - STALE_AFTER
            fact["score"] = evidence_score(fact.pop("reinforcement"), fact.pop("reinforced_at"), now)
        return facts

    def touch(self, fact_ids):
        """Mark the active versions as used now; not a write the revision counts."""
        fact_ids = list(fact_ids)
        with self.lock:
            self.db.execute(f"UPDATE facts SET last_used_at = ? WHERE state = 'active'"
                            f" AND fact_id IN ({', '.join('?' * len(fact_ids))})", (self.clock(), *fact_ids))
            self.db.commit()

    def text(self, fact_id):
        """The active version's text; None once the fact is deleted."""
        with self.lock:
            row = self.db.execute("SELECT text FROM facts WHERE fact_id = ? AND state = 'active'",
                                  (fact_id,)).fetchone()
        return None if row is None else row[0]

    def injectable(self, character_id=None):
        facts = [f for f in self.visible(character_id) if not f["quiet"]]
        return {"trusted": [f for f in facts if f["source"] in TRUSTED],
                "low_trust": [f for f in facts if f["source"] not in TRUSTED]}

    def select(self, query, k=2, now=None, derived=False, character_id=None):
        """The facts one turn carries, split as injectable() splits them: up to RESIDENTS trusted name and agreement
        facts, then up to k more by bigram overlap with query times 1 + evidence score, none under RELEVANT;
        SELECT_CHARS of text in all. Without derived, no OBSERVED fact: the consolidator writes them from episodes.
        A fact marked quiet is never carried."""
        now = self.clock() if now is None else now
        facts = [f for f in self.visible(character_id) if not f["quiet"]]
        if not derived:
            facts = [f for f in facts if f["source"] not in OBSERVED]
        with self.lock:
            recent_uses = set(self.db.execute(
                "SELECT DISTINCT fact_id, mode FROM fact_uses WHERE (mode='injected' AND used_at>?)"
                " OR (mode='mentioned' AND used_at>?)", (now - INJECTED_WITHIN, now - MENTIONED_WITHIN)))

        query_grams = bigrams(query)

        def score(fact):
            related = _overlap(query_grams, bigrams(fact["text"]))
            if fact["source"] not in TRUSTED and related < LOW_TRUST_RELEVANT:
                return 0.0
            weight = 1 + fact["score"]  # a fact never said again has evidence score 0
            for mode, factor in (("injected", INJECTED_WEIGHT), ("mentioned", MENTIONED_WEIGHT)):
                if (fact["fact_id"], mode) in recent_uses:
                    weight *= factor
            return related * weight

        residents = sorted((f for f in facts if f["kind"] in RESIDENT_KINDS and f["source"] in TRUSTED),
                           key=lambda f: (f["kind"] != "name", -f["recorded_at"]))
        chosen, chars = [], 0
        for fact in residents:
            if len(chosen) < RESIDENTS and chars + len(fact["text"]) <= SELECT_CHARS:
                chosen.append(fact)
                chars += len(fact["text"])
        taken = {f["fact_id"] for f in chosen}
        ranked = sorted(((score(f), f) for f in facts if f["fact_id"] not in taken),
                        key=lambda pair: (-pair[0], -pair[1]["recorded_at"]))
        relevant = 0
        for value, fact in ranked:
            if relevant == k or value < RELEVANT:
                break
            room = SELECT_CHARS - chars
            if len(fact["text"]) > room >= len(CUT_MARK) + CUT_LEAST:
                fact = {**fact, "text": fact["text"][:room - len(CUT_MARK)] + CUT_MARK}
            if chars + len(fact["text"]) <= SELECT_CHARS:
                chosen.append(fact)
                chars += len(fact["text"])
                relevant += 1
        return {"trusted": [f for f in chosen if f["source"] in TRUSTED],
                "low_trust": [f for f in chosen if f["source"] not in TRUSTED]}

    def record_uses(self, uses, line_id, mode):
        """uses: (fact_id, version) pairs line_id carried ("injected") or said again ("mentioned")."""
        at = self.clock()
        with self.lock:
            self.db.executemany("INSERT INTO fact_uses (fact_id, version, line_id, used_at, mode)"
                                " SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM fact_uses"
                                " WHERE fact_id=? AND version=? AND line_id=? AND mode=?)",
                                [(fact_id, version, line_id, at, mode, fact_id, version, line_id, mode)
                                 for fact_id, version in uses])
            self.db.commit()

    def lines(self, fact_id):
        """The line_ids whose reply said the fact again, oldest first."""
        with self.lock:
            rows = self.db.execute("SELECT line_id FROM fact_uses WHERE fact_id = ? AND mode = 'mentioned'"
                                   " ORDER BY rowid", (fact_id,)).fetchall()
        return list(dict.fromkeys(line_id for line_id, in rows))

    def uses(self, now=None):
        """fact_id -> uses_today (lines since local midnight), last_injected_at, last_mentioned_at and its
        RECENT_USES latest {line_id, at, mode}, for every fact with a use."""
        now = self.clock() if now is None else now
        midnight = datetime.datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        with self.lock:
            rows = self.db.execute("SELECT fact_id, line_id, used_at, mode FROM fact_uses"
                                   " ORDER BY used_at DESC, rowid DESC").fetchall()
        found = {}
        for fact_id, line_id, at, mode in rows:
            entry = found.setdefault(fact_id, {"uses_today": set(), "last_injected_at": None,
                                               "last_mentioned_at": None, "recent_uses": []})
            if at >= midnight:
                entry["uses_today"].add(line_id)
            if entry[f"last_{mode}_at"] is None:
                entry[f"last_{mode}_at"] = at
            if len(entry["recent_uses"]) < RECENT_USES:
                entry["recent_uses"].append({"line_id": line_id, "at": at, "mode": mode})
        for entry in found.values():
            entry["uses_today"] = len(entry["uses_today"])
        return found

    def paused(self):
        with self.lock:
            return self._paused()

    def set_paused(self, on):
        with self.lock:
            if self._paused() and not on:
                self.db.execute("INSERT OR REPLACE INTO memory_settings VALUES('agent_memory_since',?)",(str(self.clock()),))
            self.content_epoch += 1
            self.db.execute("INSERT OR REPLACE INTO memory_settings (key, value) VALUES ('paused', ?)",
                            ("1" if on else "0",))
            self.db.commit()

    def setting(self, key):
        """A value saved in memory_settings by set_setting, or None."""
        with self.lock:
            row = self.db.execute("SELECT value FROM memory_settings WHERE key = ?", (key,)).fetchone()
        return None if row is None else row[0]

    def set_setting(self, key, value):
        """value None removes the key."""
        with self.lock:
            if value is None:
                self.db.execute("DELETE FROM memory_settings WHERE key = ?", (key,))
            else:
                self.db.execute("INSERT OR REPLACE INTO memory_settings (key, value) VALUES (?, ?)", (key, value))
            self.db.commit()

    def cleared(self, scope="facts", owner=None):
        """The fact_ids clear(scope, owner) would delete."""
        where, args = _clears(scope, owner)
        with self.lock:
            rows = self.db.execute(f"SELECT DISTINCT fact_id FROM facts{where}", args).fetchall()
        return [fact_id for fact_id, in rows]

    def clear(self, scope="facts", owner=None):
        """scope "facts" keeps the user's name and birthday; "all" deletes every row. owner, as in active(): only
        that character's facts ("shared": only the shared ones). Returns how many active or candidate facts it deleted."""
        where, args = _clears(scope, owner)
        with self.lock:
            deleted = self.db.execute(f"SELECT COUNT(DISTINCT fact_id) FROM facts{where or ' WHERE 1'}"
                                      " AND state IN ('active', 'candidate')", args).fetchone()[0]
            cleared = {fact_id for fact_id, in self.db.execute(f"SELECT DISTINCT fact_id FROM facts{where}", args)}
            for fact_id in cleared: self._tombstone(fact_id, cleared)
            self._redact_agent_journal()
            self.db.execute("DELETE FROM fact_uses" + (f" WHERE fact_id IN (SELECT fact_id FROM facts{where})" if where else ""),
                            args)
            if where:
                self.db.execute(f"DELETE FROM facts_fts WHERE rowid IN (SELECT id FROM facts{where})", args)
            else:
                self.db.execute("DELETE FROM facts_fts")
            self.db.execute(f"DELETE FROM facts{where}", args)
            self.db.execute("DELETE FROM fact_marks WHERE fact_id NOT IN (SELECT fact_id FROM facts)")
            self.db.commit()
            self.revision += 1
        return deleted

    def export(self):
        return self.active()

    def versions(self, fact_id):
        """Every kept version of an active or candidate fact, oldest first, the current one last; KeyError otherwise.
        by is None for a version written before agentd recorded who wrote it."""
        with self.lock:
            if not self._live(fact_id):
                raise KeyError(fact_id)
            rows = self.db.execute("SELECT version, text, source, changed_by, recorded_at FROM facts"
                                   " WHERE fact_id = ? AND text IS NOT NULL ORDER BY version", (fact_id,)).fetchall()
        return [dict(zip(("version", "text", "source", "by", "at"), row)) for row in rows]

    def set_mark(self, fact_id, mark, on):
        """mark "locked": consolidation and her memory tool leave the fact alone; "quiet": it stays searchable but no
        turn carries it unasked. KeyError when the fact is not active or a candidate."""
        with self.lock:
            if not self._live(fact_id):
                raise KeyError(fact_id)
            self.db.execute("INSERT OR IGNORE INTO fact_marks (fact_id) VALUES (?)", (fact_id,))
            self.db.execute(f"UPDATE fact_marks SET {mark} = ? WHERE fact_id = ?", (int(on), fact_id))
            self.db.commit()

    def _live(self, fact_id):
        return self.db.execute("SELECT 1 FROM facts WHERE fact_id = ? AND state IN ('active', 'candidate')",
                               (fact_id,)).fetchone() is not None

    def _locked(self, fact_id):
        """Under lock."""
        row = self.db.execute("SELECT locked FROM fact_marks WHERE fact_id = ?", (fact_id,)).fetchone()
        return row is not None and row[0] == 1

    def _paused(self):
        row = self.db.execute("SELECT value FROM memory_settings WHERE key = 'paused'").fetchone()
        return row is not None and row[0] == "1"

    def _insert(self, fact_id, version, kind, text, source, evidence, occurred_at, reinforcement=0, reinforced_at=None,
                state="active", owner=None, *, by):
        """by: who wrote this version: "user" (the memory page), "character" (her memory tool), "pipeline"
        (consolidation) or "integration" (a proposal from POST /integration/memory)."""
        row_id = self.db.execute("INSERT INTO facts (fact_id, version, kind, text, source, evidence, occurred_at, recorded_at,"
                        " state, reinforcement, reinforced_at, owner, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (fact_id, version, kind, text, source, evidence, occurred_at, self.clock(), state,
                         reinforcement, reinforced_at, owner, by)).lastrowid
        if text and state in ("active", "candidate"):
            self.db.execute("INSERT INTO facts_fts (rowid, body) VALUES (?, ?)", (row_id, _fts_body(text)))

    def _revise(self, fact_id, text, *, expected_version=None, cascade=None):
        """Supersede the active version with one the user has touched; text None keeps the old text."""
        if text is not None and not text.strip():
            raise ValueError("blank text")
        with self.lock:
            row = self.db.execute("SELECT id, version, kind, text, source, evidence, occurred_at, reinforcement,"
                                  " reinforced_at, owner FROM facts WHERE fact_id = ? AND state IN ('active','candidate')",
                                  (fact_id,)).fetchone()
            if row is None:
                raise KeyError(fact_id)
            row_id, version, kind, old_text, source, evidence, occurred_at, reinforcement, reinforced_at, owner = row
            if expected_version is not None and version != expected_version:
                raise VersionConflict(version)
            if source in ("inferred_hypothesis", "observed_context") or text is None:
                source = "confirmed_by_user"
            if text is not None:
                self._check_cascade(fact_id, cascade)
                self._tombstone(fact_id)
                # The user's replacement claim cannot cite a summary just erased.
                evidence = json.dumps([ref for ref in json.loads(evidence) if not _episode(ref) or
                    self.db.execute('SELECT 1 FROM episodes WHERE id=?', (ref.split(':', 1)[1].split('@', 1)[0],)).fetchone()])
            self.db.execute("UPDATE facts SET state = 'corrected' WHERE id = ?", (row_id,))
            self.db.execute("DELETE FROM facts_fts WHERE rowid = ?", (row_id,))
            if text is not None: self._redact_agent_journal()
            # A corrected text is a new claim; confirming keeps the signals the same words already had.
            kept = (reinforcement, reinforced_at) if text is None else ()
            self._insert(fact_id, version + 1, kind, old_text if text is None else text, source, evidence,
                         occurred_at, *kept, owner=owner, by="user")
            self.db.commit()
            self.revision += 1
        return version + 1
