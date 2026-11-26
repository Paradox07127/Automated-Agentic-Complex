"""T1 trace events in the shared store: agentd's own, those posted by Companion and Avatar."""
import contextvars
from datetime import datetime, timedelta, timezone
import json
import secrets
import threading
import time
import uuid

from traces.trace_format import ENDS, HEAD_MAX, KINDS, TEXT_MAX, VERSION, validate_event

# The trace_id of the turn the current thread works for; agentd's stderr lines end with it (see daemon.main).
TURN_TRACE = contextvars.ContextVar("turn_trace", default=None)
BATCH_MAX = 200
PAGE_MAX = 200
REMOTE_PRODUCERS = ("companion", "avatar")
# the motion lane's inputs a replay rebuilds Spatial from (see tools/motion_replay.py)
REPLAY_INPUTS = frozenset({"spatial.began", "situation.observed", "motion.chooser", "motion.intent", "motion.input",
                           "motion.clock", "motion.prefs", "motion.return", "behavior.switches",
                           "behavior.capabilities", "behavior.cancel_all", "interaction.preset"})
DAEMON_EVENTS = frozenset({"tool.started", "tool.settled", "turn.settled", "behavior.dispatched", "behavior.receipt",
                           "behavior.refused", "signal.changed", "stage.changed", "motion.chosen", "motion.state",
                           "steer.settled", *REPLAY_INPUTS})
LOCAL_PRODUCERS = ("agentd", "tts")  # tts: the speech relay's lines, written by agentd
PURGE_EVERY = 3600
FORGET_CHUNK = 500  # turn_ids per query, under SQLite's bound-parameter limit
# Stored even past the daily cap, besides ENDS and any status other than ok.
KEPT_KINDS = {"input.received", "gate.decided", "judge.decided", "behavior.ticked", "behavior.receipt", "egress.checked", "trace.dropped",
              "proactive.feedback", "signal.changed", "stage.changed", *REPLAY_INPUTS}
KEPT_PREFIXES = ("dispatch.", "approval.", "cancel.")
DECISION_KINDS = ("gate.decided", "judge.decided", "behavior.ticked", "proactive.feedback")
DECISION_PREFIXES = ("dispatch", "approval")
COLUMNS = ("event_id", "trace_id", "turn_id", "producer", "producer_epoch", "seq", "kind", "status", "t_wall",
           "t_recv_wall", "day", "stored_at", "event", "text")


def new_trace_id():
    return str(uuid.uuid4())


def new_span_id():
    return secrets.token_hex(8)


def _local(t):
    return datetime.fromtimestamp(t, timezone.utc).astimezone()


def _wall(t):
    return _local(t).isoformat(timespec="milliseconds")


def _parse(wall):
    parsed = datetime.fromisoformat(wall)
    if parsed.utcoffset() is None:
        raise ValueError('trace_time_zone_required')
    return parsed


def _kept(event):
    kind = event["kind"]
    return kind in KEPT_KINDS or kind.startswith(KEPT_PREFIXES) or kind in ENDS or event["status"] != "ok"


def _without_heads(value):
    if isinstance(value, dict):
        if set(value) == {"len", "head"}:
            return {"len": value["len"]}
        return {k: _without_heads(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_without_heads(v) for v in value]
    return value


def _blank_heads(value):
    if isinstance(value, dict):
        if set(value) == {"len", "head"}:
            return {"len": value["len"], "head": ""}
        return {k: _blank_heads(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_blank_heads(v) for v in value]
    return value


def _event(row, with_text):
    event = json.loads(row[0])
    if with_text and row[1] is not None:
        event["text"] = json.loads(row[1])
    return event


class TraceStore:
    def __init__(self, db, producer_epoch, lock=None, clock=time.time, mono=time.monotonic, daily_cap=50000,
                 dropped_every=1000, retention=lambda: None):
        """retention() -> seconds an event is kept, None to keep every event."""
        self.db, self.producer_epoch, self.clock, self.mono = db, producer_epoch, clock, mono
        self.retention = retention
        self.daily_cap, self.dropped_every = daily_cap, dropped_every
        self.lock = threading.Lock() if lock is None else lock
        self.seq = dict.fromkeys(LOCAL_PRODUCERS, 0)
        self.dropped, self.dropped_since, self.dropped_day = 0, None, None
        self.purged_at = None

    def emit(self, kind, trace_id, *, turn_id=None, turn_generation=None, span_id=None, parent_span_id=None,
             causation_id=None, status="ok", attrs=None, texts=None, duration_ms=None, producer="agentd"):
        if producer not in LOCAL_PRODUCERS:
            raise ValueError(f"producer {producer!r} is not agentd's to write")
        with self.lock:
            event_id = self._emit(kind, trace_id, turn_id=turn_id, turn_generation=turn_generation, span_id=span_id,
                                  parent_span_id=parent_span_id, causation_id=causation_id, status=status,
                                  attrs=attrs, texts=texts, duration_ms=duration_ms, producer=producer)
            self.db.commit()
        return event_id

    def _emit(self, kind, trace_id, *, turn_id, turn_generation, span_id, parent_span_id, causation_id, status,
              attrs, texts, duration_ms, producer="agentd"):
        now = self.clock()
        self._roll_day(now)
        attrs, text = dict(attrs or {}), {}
        for key, full in (texts or {}).items():
            attrs[key] = {"len": len(full), "head": full[:HEAD_MAX]}
            text[key] = full[:TEXT_MAX]
        event = {"v": VERSION, "event_id": str(uuid.uuid4()), "trace_id": trace_id, "turn_id": turn_id,
                 "turn_generation": turn_generation, "span_id": span_id or new_span_id(),
                 "parent_span_id": parent_span_id, "causation_id": causation_id, "producer": producer,
                 "producer_epoch": self.producer_epoch, "seq": self.seq[producer] + 1, "kind": kind, "t_wall": _wall(now),
                 "t_mono_ms": int(self.mono() * 1000), "status": status, "attrs": attrs}
        if duration_ms is not None:
            event["duration_ms"] = duration_ms
        if text:
            event["text"] = text
        errors = validate_event(event)
        if errors:
            raise ValueError(f"invalid {kind} event: {'; '.join(errors)}")
        self.seq[producer] += 1
        return event["event_id"] if self._write(event, now) else None

    def ingest(self, events):
        """POST /trace/events: store what Companion and Avatar sent; events dropped by the daily cap count as accepted."""
        if len(events) > BATCH_MAX:
            raise ValueError("too_many")
        accepted, rejected = 0, []
        with self.lock:
            for index, event in enumerate(events):
                if isinstance(event, dict) and isinstance(event.get("text"), dict):
                    event = {**event, "text": {k: v[:TEXT_MAX] if isinstance(v, str) else v
                                               for k, v in event["text"].items()}}
                errors = validate_event(event)
                if errors:
                    error = errors[0]
                elif event["producer"] not in REMOTE_PRODUCERS:
                    error = "producer_not_allowed"
                elif event["kind"] in DAEMON_EVENTS:
                    error = "kind_not_allowed"
                elif self.db.execute("SELECT 1 FROM trace_events WHERE event_id = ?",
                                     (event["event_id"],)).fetchone():
                    error = "duplicate_event_id"
                else:
                    now = self.clock()
                    self._roll_day(now)
                    self._write({**event, "t_recv_wall": _wall(now)}, now)
                    accepted += 1
                    continue
                rejected.append({"index": index, "error": error})
            self.db.commit()
        return {"accepted": accepted, "rejected": rejected}

    def _roll_day(self, now):
        # Before the new event takes its seq, so the report of the previous day comes first.
        if self.dropped and _local(now).date().isoformat() != self.dropped_day:
            self._report_dropped()

    def _write(self, event, now):
        day = _local(now).date().isoformat()
        if self.purged_at is None or now - self.purged_at >= PURGE_EVERY:
            keep = self.retention()
            if keep is not None:
                self.db.execute("DELETE FROM trace_events WHERE stored_at < ?", (now - keep,))
            self.purged_at = now
        if not _kept(event):
            stored = self.db.execute("SELECT COUNT(*) FROM trace_events WHERE day = ?", (day,)).fetchone()[0]
            if stored >= self.daily_cap:
                if not self.dropped:
                    self.dropped_since, self.dropped_day = _wall(now), day
                self.dropped += 1
                if self.dropped >= self.dropped_every:
                    self._report_dropped()
                return False
        event = dict(event)
        text = event.pop("text", None)
        self.db.execute(f"INSERT INTO trace_events ({', '.join(COLUMNS)}) VALUES ({', '.join('?' * len(COLUMNS))})",
                        (event["event_id"], event["trace_id"], event["turn_id"], event["producer"],
                         event["producer_epoch"], event["seq"], event["kind"], event["status"], event["t_wall"],
                         event.get("t_recv_wall"), day, now, json.dumps(event, ensure_ascii=False),
                         None if text is None else json.dumps(text, ensure_ascii=False)))
        return True

    def _report_dropped(self):
        count, since = self.dropped, self.dropped_since
        self.dropped = 0
        self._emit("trace.dropped", new_trace_id(), turn_id=None, turn_generation=None, span_id=None,
                   parent_span_id=None, causation_id=None, status="ok", attrs={"count": count, "since": since},
                   texts=None, duration_ms=None)

    def clear(self):
        with self.lock:
            deleted = self.db.execute("DELETE FROM trace_events").rowcount
            self.db.commit()
        return deleted

    def forget(self, turn_ids):
        """The words of these turns' events go (text and each head); the events stay. The number of events changed."""
        turn_ids, changed = list(turn_ids), 0
        with self.lock:
            for start in range(0, len(turn_ids), FORGET_CHUNK):
                chunk = turn_ids[start:start + FORGET_CHUNK]
                where = f"turn_id IN ({', '.join('?' * len(chunk))})"
                rows = self.db.execute(f"SELECT id, event FROM trace_events WHERE {where}", chunk).fetchall()
                for row_id, raw in rows:
                    event = json.loads(raw)
                    event["attrs"] = _blank_heads(event["attrs"])
                    self.db.execute("UPDATE trace_events SET event = ?, text = NULL WHERE id = ?",
                                    (json.dumps(event, ensure_ascii=False), row_id))
                changed += len(rows)
            self.db.commit()
        return changed

    def turn(self, trace_id, with_text=False):
        """Every event of one trace, ordered by wall time moved onto agentd's clock per producer epoch."""
        with self.lock:
            rows = self.db.execute("SELECT event, text FROM trace_events WHERE trace_id = ? ORDER BY id",
                                   (trace_id,)).fetchall()
        events = [_event(row, with_text) for row in rows]
        lags = {}
        for e in events:
            lag = lags.setdefault((e["producer"], e["producer_epoch"]), [])
            if "t_recv_wall" in e:
                lag.append(_parse(e["t_recv_wall"]) - _parse(e["t_wall"]))
        skew = {group: min(lag) if lag else timedelta(0) for group, lag in lags.items()}
        events.sort(key=lambda e: (_parse(e["t_wall"]) + skew[(e["producer"], e["producer_epoch"])],
                                   e["producer"], e["producer_epoch"], e["seq"]))
        return {"trace_id": trace_id, "events": events,
                "skew_ms": {f"{p}/{epoch}": round(s / timedelta(milliseconds=1)) for (p, epoch), s in skew.items()}}

    def turns(self, since=None, limit=50, source=None, result=None, *, turn_id=None, trace_id=None):
        """One row per trace with an input.received, newest first."""
        if type(limit) is not int or not 1 <= limit <= PAGE_MAX:
            raise ValueError(f"limit must be 1-{PAGE_MAX}")
        # Select the page before decoding JSON in Python. Decoding every retained
        # input while holding the writer lock made opening diagnostics contend
        # with ordinary interactions. Keep the first input's ownership per trace.
        where, args = [], []
        for name, value in (('turn_id', turn_id), ('trace_id', trace_id)):
            if value is not None:
                if not isinstance(value, str) or not 1 <= len(value) <= 128 or not value.strip():
                    raise ValueError(f'invalid {name}')
                where.append(f'i.{name}=?')
                args.append(value)
        if since is not None:
            where.append('julianday(t_wall)>=julianday(?)')
            args.append(_parse(since).isoformat())
        if source is not None:
            where.append("json_extract(event,'$.attrs.source')=?")
            args.append(source)
        sql = ("SELECT event FROM trace_events AS i WHERE kind='input.received' AND NOT EXISTS "
               "(SELECT 1 FROM trace_events AS older WHERE older.trace_id=i.trace_id "
               "AND older.kind='input.received' AND older.id<i.id)")
        if where: sql += ' AND ' + ' AND '.join(where)
        sql += ' ORDER BY julianday(t_wall) DESC,id ASC'
        # Result filtering needs to examine older candidates until the page fills.
        if result is None:
            sql += ' LIMIT ?'; args.append(limit)
        with self.lock:
            selected = []
            for (raw,) in self.db.execute(sql, args):
                event = json.loads(raw)
                found = self.db.execute("SELECT event FROM trace_events WHERE trace_id = ?",
                                        (event["trace_id"],)).fetchall()
                # Filtering alone needs parsing under the snapshot lock. Otherwise
                # leave presentation work until after releasing the writer fence.
                decoded = [json.loads(row[0]) for row in found] if result is not None else None
                if result is not None and self._result(decoded) != result:
                    continue
                selected.append((event, found, decoded))
                if len(selected) == limit:
                    break
        rows = []
        for event, found, decoded in selected:
            events = decoded if decoded is not None else [json.loads(row[0]) for row in found]
            walls = [_parse(e['t_wall']) for e in events]
            text = event["attrs"]["text"]
            finished = next((e for e in reversed(events) if e["kind"] == "model.finished"), None)
            model = finished["attrs"] if finished else {}
            terminal = next((e["attrs"] for e in reversed(events) if e["kind"] == "turn.settled"), {})
            rows.append({"trace_id": event["trace_id"], "turn_id": event["turn_id"],
                         "source": event["attrs"]["source"], "head": None if text is None else text["head"],
                         "len": None if text is None else text["len"],
                         "producers": sorted({e['producer'] for e in events}),
                         "started_at": event["t_wall"], "result": self._result(events),
                         "provider": model.get("provider"), "account_label": model.get("account_label"),
                         "model": model.get("model"),
                         "error_code": terminal.get("error_code") or (
                             model.get("stop_reason") if finished and finished["status"] == "failed" else None),
                         "turn_state": terminal.get("state"), "turn_outcome": terminal.get("outcome"),
                         "duration_ms": round((max(walls) - min(walls)) / timedelta(milliseconds=1))})
        return rows

    @staticmethod
    def _result(events):
        kinds = {e["kind"] for e in events}
        statuses = {e["status"] for e in events}
        if any(e["status"] == "blocked" and e["kind"].startswith(("gate.", "egress.")) for e in events):
            return "blocked"
        if any(e["kind"].startswith("cancel.") or
               (e["kind"] == "playback.interrupted" and e["attrs"].get("reason") != "connection_lost") or
               (e["status"] == "cancelled" and not (e["kind"] == "playback.interrupted" and
                                                     e["attrs"].get("reason") == "connection_lost"))
               for e in events):
            return "interrupted"
        if "failed" in statuses:
            return "failed"
        if any(e["kind"] == "turn.settled" and e["attrs"].get("outcome") == "failed" for e in events):
            return "failed"
        # A line can start playing before the model has finished producing further clauses.
        # line.parsed comes after the final voice() call, so it closes the set of speech requests.
        if (any(e["kind"] == "model.finished" and e["status"] == "ok" for e in events) and
                any(e["kind"] == "line.parsed" and e["status"] == "ok" for e in events)):
            speech = [e for e in events if e["kind"] == "speech.requested"]
            playback = [e for e in events if e["kind"].startswith("playback.")]
            observed_speech = [e for e in events if e["kind"].startswith(("speech.", "playback."))]
            if not observed_speech:
                return "text_generated"  # not evidence that a UI displayed the text or played audio
            requested = {e["attrs"].get("speech_id") for e in speech}
            ended = {e["attrs"].get("speech_id") for e in playback
                     if e["kind"] == "playback.ended" and e["status"] == "ok"}
            observed = {e["attrs"].get("speech_id") for e in observed_speech}
            if (speech and None not in observed and observed == requested and requested <= ended and
                    all(e["status"] == "ok" for e in observed_speech)):
                return "completed"
            return "unknown"
        if any(e["kind"] == "turn.settled" and e["attrs"]["state"] == "completed" for e in events) and \
                any(e["kind"] == "input.received" and e["attrs"]["source"] == "background" for e in events):
            return "completed"  # this run has no speech lane to verify
        if {"model.finished", "turn.settled"} & kinds or any(k.startswith(("speech.", "playback.")) for k in kinds):
            return "unknown"
        return "open"

    def decisions(self, kind=None, since=None, limit=100, trace_id=None, request_id=None):
        """Gate, judge, behavior, dispatch and approval events, newest first; kind may be a dispatch/approval prefix.
        trace_id and request_id (attrs.request_id) narrow them further."""
        if type(limit) is not int or not 1 <= limit <= PAGE_MAX:
            raise ValueError(f"limit must be 1-{PAGE_MAX}")
        where = (f"(kind IN ({', '.join('?' * len(DECISION_KINDS))})"
                 f"{''.join(' OR kind LIKE ?' for _ in DECISION_PREFIXES)})")
        args = [*DECISION_KINDS, *(f"{p}.%" for p in DECISION_PREFIXES)]
        if kind in DECISION_PREFIXES:
            where, args = f"{where} AND kind LIKE ?", [*args, f"{kind}.%"]
        elif kind is not None:
            where, args = f"{where} AND kind = ?", [*args, kind]
        if trace_id is not None:
            where, args = f"{where} AND trace_id = ?", [*args, trace_id]
        if request_id is not None:
            where, args = f"{where} AND json_extract(event, '$.attrs.request_id') = ?", [*args, request_id]
        if since is not None:
            where += ' AND julianday(t_wall)>=julianday(?)'
            args.append(_parse(since).isoformat())
        with self.lock:
            rows = self.db.execute(f"SELECT event, NULL FROM trace_events WHERE {where} ORDER BY id DESC LIMIT ?",
                                   [*args, limit]).fetchall()
        return [_event(row, False) for row in rows]

    def events(self, since=None, until=None, kinds=None, limit=PAGE_MAX, cursor=None):
        """Every trace's events with since <= t_wall <= until, in stored order, text as {len, head} only;
        (page, cursor of the next page or None). kinds narrows them to those kinds."""
        if type(limit) is not int or not 1 <= limit <= PAGE_MAX:
            raise ValueError(f"limit must be 1-{PAGE_MAX}")
        if cursor is not None and not (isinstance(cursor, str) and cursor.isdigit()):
            raise ValueError("invalid cursor")
        where, args = ["id > ?"], [0 if cursor is None else int(cursor)]
        if since is not None:
            where.append("julianday(t_wall)>=julianday(?)")
            args.append(_parse(since).isoformat())
        if until is not None:
            where.append("julianday(t_wall)<=julianday(?)")
            args.append(_parse(until).isoformat())
        if kinds is not None:
            if not kinds or any(k not in KINDS for k in kinds):
                raise ValueError("unknown kind")
            where.append(f"kind IN ({', '.join('?' * len(kinds))})")
            args += kinds
        with self.lock:
            rows = self.db.execute(f"SELECT id, event FROM trace_events WHERE {' AND '.join(where)} ORDER BY id LIMIT ?",
                                   [*args, limit + 1]).fetchall()
        page = [json.loads(raw) for _, raw in rows[:limit]]
        return page, str(rows[limit - 1][0]) if len(rows) > limit else None

    def export(self, with_text=False):
        """Every event, oldest first; without text the attrs keep only the len of each text value."""
        with self.lock:
            rows = self.db.execute("SELECT event, text FROM trace_events ORDER BY id").fetchall()
        events = [_event(row, with_text) for row in rows]
        if not with_text:
            for event in events:
                event["attrs"] = _without_heads(event["attrs"])
        return events
