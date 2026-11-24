"""Attention timeline:ActivityWatch-style heartbeats in SQLite; active time = window ∩ not-AFK."""
from bisect import bisect_right
import collections
import json
import sqlite3
import threading
import time

from observation.blacklist import HIDDEN, TITLE_MAX, bare_host, normal_host
from observation.browser_stats import valid_metrics

PULSE = 5.0  # C6: POSTs more than 5 s apart leave an unknown gap, never filled from the last state
AFK_AFTER = 180.0  # HID idle seconds
GAZE_MIN = 5.0  # seconds on one window before it counts as a gaze
GAZE_INPUT = 5.0  # input this recent keeps the gaze on the front window
RETENTION = 7 * 86400
RAW_RETENTION = 48 * 3600  # events_raw: the Companion's AX events and hook prompts
PRUNE_EVERY = 3600
TOP = 20
WEB_PULSE = 80.0  # ActivityWatch's web watcher pulsetime; the extension beats every 60 s
TEXT_MAX = 2000
SELECTION_FRESH = 600.0  # seconds a selection may reach the mouth
PAGE_FRESH = 600.0  # seconds the current page's text may reach the mouth
RING_S = 300.0  # seconds the heartbeat's sensed fields stay in memory
SENSED = ("input", "front_audio_out", "front_video", "front_gpu", "screen_captured")  # C6 fields kept only in that ring, never in SQLite
BUCKETS = {"app": "window", "title": "window", "domain": "window"}
KEYS = {"app": "app", "title": "title", "domain": "url_host"}
# Extension identity of a browser message; a context row matches the current heartbeat on each both have.
IDENTITY = ("browser_session", "tab_id", "document_id", "revision")
# Browsers that can run the extension; only their windows borrow its url_host.
CHROMIUM = {"com.google.Chrome", "com.google.Chrome.canary", "com.microsoft.edgemac", "com.brave.Browser",
            "company.thebrowser.Browser"}
RAW_COLUMNS = ("ts", "kind", "app", "bundle_id", "window", "url_host", "doc", "role", "subrole", "label", "value",
               "value_len", "shrink", "edits", "input_near")
NEAR = 2.0  # a key, click or scroll this close to an AX event marks it input_near


class AttentionStore:
    def __init__(self, path, blacklist, clock=time.time):
        self.blacklist, self.clock = blacklist, clock
        self.lock = threading.Lock()
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.execute("PRAGMA secure_delete=ON")  # deleted rows are zeroed, so free pages keep no copy of them
        self.db.execute("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, bucket TEXT NOT NULL,"
                        " start REAL NOT NULL, duration REAL NOT NULL, data TEXT NOT NULL)")
        self.db.execute("CREATE INDEX IF NOT EXISTS events_bucket_start ON events (bucket, start)")
        self.db.execute("CREATE TABLE IF NOT EXISTS context (id INTEGER PRIMARY KEY, ts REAL NOT NULL,"
                        " kind TEXT NOT NULL, url_host TEXT, title TEXT, text TEXT NOT NULL, browser_session TEXT,"
                        " tab_id INTEGER, document_id TEXT, revision INTEGER)")
        self.db.execute("CREATE TABLE IF NOT EXISTS events_raw (id INTEGER PRIMARY KEY, ts REAL, kind TEXT, app TEXT,"
                        " bundle_id TEXT, window TEXT, url_host TEXT, doc TEXT, role TEXT, subrole TEXT, label TEXT,"
                        " value TEXT, value_len INTEGER, shrink INTEGER, edits INTEGER, input_near INTEGER)")
        self.db.execute("CREATE INDEX IF NOT EXISTS events_raw_ts ON events_raw (ts)")
        self.db.execute("CREATE TABLE IF NOT EXISTS state_log (id INTEGER PRIMARY KEY, ts REAL, mode TEXT, state TEXT,"
                        " evidence TEXT)")
        self._pruned = None
        self._secure = False  # the last heartbeat's secure_input: extension text is not kept while set
        self._locked_asleep = False
        self._browser_after = float("-inf")  # reject queued pre-lock/pre-wake extension messages
        self._idle = None  # the last heartbeat's idle_s
        self._ring = collections.deque()  # {"ts", each SENSED field the beat had, front's "category"}, oldest first
        self._last_inputs = collections.deque()  # (beat ts, time of that beat's latest input), oldest first
        self._browser_metrics = None  # UI-only numeric snapshot, never persisted or sent to the model
        self._browser_samples = 0
        self._front = (None, None)  # (timestamp, bundle_id) of the latest scrubbed front app
        self.typed_generation = 0  # clear_typed_text() bumps it; a batch checked before that keeps no text
        # clear_browser_text() and every delete bump it; page or selection text checked before that is not kept
        self.context_generation = 0
        self.raw_floor = float("-inf")  # clock time of the last delete; nothing from before it is stored
        self._beat_ts = float("-inf")  # the ts of the last heartbeat taken

    def close(self):
        # SQLite may release the GIL in a read. Closing on another thread must
        # serialize with that read, just like every other store operation.
        with self.lock:
            self.db.close()

    def secure_input(self):
        """The last heartbeat's secure_input flag."""
        return self._secure

    def browser_capture_allowed(self):
        return not self._secure and not self._locked_asleep

    def idle_s(self):
        """The last heartbeat's idle_s, or None before any heartbeat."""
        return self._idle

    def inputs(self, window_s=RING_S):
        """The ring entries of the last window_s seconds (at most RING_S), oldest first."""
        with self.lock:
            self._trim()
            since = self.clock() - min(window_s, RING_S)
            return [dict(e) for e in self._ring if e["ts"] >= since]

    def app_category(self, window):
        """The latest beat's category only when its front bundle matches window."""
        with self.lock:
            self._trim()
            bundle = window.get("bundle_id")
            if bundle and self._ring and self._front == (self._ring[-1]["ts"], bundle):
                return self._ring[-1].get("category")
        return None

    def _trim(self):
        since = self.clock() - RING_S
        while self._ring and self._ring[0]["ts"] < since:
            self._ring.popleft()
        while self._last_inputs and self._last_inputs[0][0] < since:
            self._last_inputs.popleft()

    def _input_near(self, ts):
        """1, 0 or None (no beat NEAR s after ts yet, or no kept beat saw the window) for an event at ts."""
        if any(abs(last - ts) <= NEAR for _, last in self._last_inputs):
            return 1
        after = next((last for beat_ts, last in self._last_inputs if beat_ts >= ts + NEAR), None)
        if after is None:
            return None
        # A later input hides the window from that beat, so 0 needs no input since before the window or a beat before ts.
        if after < ts - NEAR or self._last_inputs[0][0] <= ts:
            return 0
        return None

    def ingest(self, beat):
        """One heartbeat; False, changing nothing, for one at or before raw_floor or older than the last one taken."""
        ts, idle = float(beat["ts"]), float(beat["idle_s"])
        front = self.blacklist.scrub(beat["front"])
        category = front.pop("category", None)  # ring only, like SENSED
        secure = bool(beat.get("secure_input"))
        locked_asleep = bool(beat.get("locked") or beat.get("asleep"))
        if secure:
            front.pop("title", None)
        mouse = self.blacklist.scrub(beat.get("mouse"))
        if mouse is not None:
            mouse.pop("category", None)
        afk = idle >= AFK_AFTER or bool(beat.get("locked")) or bool(beat.get("asleep"))
        sensed = {k: beat[k] for k in SENSED if k in beat}
        if category is not None:
            sensed["category"] = category
        idles = [v for k, v in (beat.get("input") or {}).items()
                 if k in ("key_idle_s", "click_idle_s", "scroll_idle_s")]
        last_input = ts - (min(idles) if idles else idle)
        with self.lock:
            if ts <= self.raw_floor or ts < self._beat_ts:
                return False
            self._beat_ts, self._idle = ts, idle
            was_allowed = self.browser_capture_allowed()
            self._secure, self._locked_asleep = secure, locked_asleep
            allowed = self.browser_capture_allowed()
            if was_allowed != allowed:
                self._browser_after = ts
            if not allowed:
                self._browser_metrics = None
                if was_allowed and (last := self._last("browser")) is not None:
                    # End even an audible interval at the OS boundary, without waiting for Chrome.
                    self._heartbeat("browser", ts, {**last[3], "window_focused": False,
                                                     "visible": False, "audible": False}, WEB_PULSE)
            self._front = (ts, front.get("bundle_id"))
            if "input" not in beat:
                for entry in self._ring:
                    entry.pop("input", None)
            if sensed:
                self._ring.append({"ts": ts, **sensed})
            self._last_inputs.append((ts, last_input))
            self._trim()
            self._prune()
            if self._last_inputs:
                since = min(beat_ts for beat_ts, _ in self._last_inputs) - NEAR
                pending = self.db.execute("SELECT id, ts FROM events_raw WHERE input_near IS NULL AND ts >= ?",
                                          (since,)).fetchall()
                self.db.executemany("UPDATE events_raw SET input_near = ? WHERE id = ?",
                                    [(near, rowid) for rowid, event_ts in pending
                                     if (near := self._input_near(event_ts)) is not None])
            self._heartbeat("window", ts, front)
            self._afk(ts, idle, afk)
            if not afk:
                away = mouse is not None and idle >= GAZE_INPUT and front != HIDDEN \
                    and mouse.get("window_id") != front.get("window_id")
                self._heartbeat("focus", ts, mouse if away else front)
            self.db.commit()
        return True

    def ingest_events(self, events, typed_generation=None):
        """Checked Companion events (dicts of RAW_COLUMNS) into events_raw: a blacklisted one goes, one at or before
        raw_floor, and every value while the last heartbeat had secure input. With a typed_generation other than
        the current one every value goes too. Returns (stored, dropped)."""
        with self.lock:
            self._prune()
            stale = typed_generation is not None and typed_generation != self.typed_generation
            kept = [event for event in events if event["ts"] > self.raw_floor and not self._raw_hidden(event)]
            self._trim()
            rows = [tuple(self._input_near(event["ts"]) if column == "input_near"
                          else None if column == "value" and (self._secure or stale) else event.get(column)
                          for column in RAW_COLUMNS)
                    for event in kept]
            self.db.executemany(f"INSERT INTO events_raw ({', '.join(RAW_COLUMNS)})"
                                f" VALUES ({', '.join('?' * len(RAW_COLUMNS))})", rows)
            self.db.commit()
        return len(kept), len(events) - len(kept)

    def recent_events(self, since, kinds=None, limit=500):
        """The latest `limit` events_raw rows from since (of kinds, when given), oldest first; the blacklist is
        checked again here."""
        sql = f"SELECT id, {', '.join(RAW_COLUMNS)} FROM events_raw WHERE ts >= ?"
        args = [since]
        if kinds is not None:
            sql += f" AND kind IN ({', '.join('?' * len(kinds))})"
            args += list(kinds)
        with self.lock:
            rows = self.db.execute(sql + " ORDER BY ts DESC, id DESC", args).fetchall()
        events = (dict(zip(("id", *RAW_COLUMNS), row)) for row in rows)
        kept = [event for event in events if not self._raw_hidden(event)][:limit]
        return kept[::-1]

    def log_state(self, ts, mode, state, evidence):
        """One user_state change that took effect; evidence is a list of rule codes, never text."""
        with self.lock:
            self._prune()
            self.db.execute("INSERT INTO state_log (ts, mode, state, evidence) VALUES (?, ?, ?, ?)",
                            (ts, mode, state, ",".join(evidence)))
            self.db.commit()

    def state_log_since(self, since):
        """[{"ts", "mode", "state", "evidence"}] from since, oldest first."""
        with self.lock:
            rows = self.db.execute("SELECT ts, mode, state, evidence FROM state_log WHERE ts >= ? ORDER BY ts, id",
                                   (since,)).fetchall()
        return [{"ts": ts, "mode": mode, "state": state, "evidence": evidence.split(",") if evidence else []}
                for ts, mode, state, evidence in rows]

    def _raw_hidden(self, event):
        return event.get("app") == HIDDEN["app"] or self.blacklist.hides(_raw_window(event))

    def ingest_browser(self, message, generation=None):
        """One extension message: a heartbeat for the timeline, page / selection text kept locally, or a
        selection_cleared kept as a context row with empty text; nothing at or before raw_floor, and no context row
        with a generation other than context_generation. Returns the page or selection it admitted, with its whole
        text, else None."""
        ts, kind = float(message["ts"]), message["type"]
        ids = {f: message.get(f) for f in IDENTITY}
        host = message.get("url_host")
        sent_hidden = host == HIDDEN["app"]  # the extension's own blacklist hid the tab
        host = normal_host(host) if bare_host(host) else None
        title = message.get("title")
        title = title if isinstance(title, str) else None
        admitted = None
        with self.lock:
            if not self.browser_capture_allowed() or ts < self._browser_after or ts <= self.raw_floor:
                return None
            hidden = sent_hidden or self.blacklist.hides({"url_host": host, "title": title})
            title = title[:TITLE_MAX] if title is not None and not hidden else None
            self._prune()
            if kind == "heartbeat":
                audible = bool(message.get("audible"))
                data = {"url_host": HIDDEN["app"], "audible": audible, "window_focused": False, "visible": False} if hidden else \
                    {"url_host": host, "title": title, "audible": audible, **ids,
                     "window_focused": message.get("window_focused", True), "visible": message.get("visible", True)}
                self._heartbeat("browser", ts, data, WEB_PULSE)
                if not data.get("window_focused", True) or hidden:
                    self._browser_metrics = None
            elif kind == "metrics":
                current = self._last("browser")
                if (not hidden and self.browser_capture_allowed() and valid_metrics(message.get("metrics")) and current is not None
                        and 0 <= ts - (current[1] + current[2]) <= WEB_PULSE
                        and current[3].get("window_focused", True) and current[3].get("visible", True)
                        and all(ids[k] is not None and ids[k] == current[3].get(k) for k in IDENTITY)
                        and host == current[3].get("url_host")
                        and (self._browser_metrics is None or ts >= self._browser_metrics["ts"])):
                    self._browser_metrics = {"ts": ts, "url_host": host, "title": title, **ids, "metrics": message["metrics"]}
                    self._browser_samples += 1
            elif not hidden and generation in (None, self.context_generation) \
                    and (kind == "selection_cleared" or not self._secure and (kind == "page" or message.get("text"))):
                text = "" if kind == "selection_cleared" else message["text"][:TEXT_MAX]
                self.db.execute("INSERT INTO context (ts, kind, url_host, title, text, browser_session, tab_id,"
                                " document_id, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                (ts, kind, host, title, text, *(ids[f] for f in IDENTITY)))
                if kind != "selection_cleared":
                    admitted = {"ts": ts, "type": kind, "url_host": host, "title": title, **ids, "text": message["text"]}
            self.db.commit()
        return admitted

    def context(self):
        with self.lock:
            rows = self.db.execute("SELECT ts, kind, url_host, title, text FROM context ORDER BY ts").fetchall()
        return [dict(zip(("ts", "kind", "url_host", "title", "text"), row)) for row in rows]

    def latest_selection(self):
        """The latest selection while it is recent and on the page the browser still shows, else None."""
        return self._on_page("selection", SELECTION_FRESH)

    def current_page(self):
        """The text of the page the browser still shows while it is recent, else None."""
        return self._on_page("page", PAGE_FRESH)

    def recent_page(self, within=7200):
        """The latest page text within `within` seconds that is not the page the browser shows, else None."""
        now = self.clock()
        with self.lock:
            rows = self.db.execute("SELECT ts, url_host, title, text FROM context WHERE kind = 'page' AND ts >= ?"
                                   " ORDER BY ts DESC", (now - within,)).fetchall()
            page = self._last("browser")
        current = None
        if page is not None and now - (page[1] + page[2]) <= WEB_PULSE:
            current = (page[3].get("url_host"), page[3].get("title"))
        row = next((r for r in rows if (r[1], r[2]) != current), None)
        if row is None or self._withheld(row):
            return None
        return dict(zip(("ts", "url_host", "title", "text"), row))

    def _on_page(self, kind, fresh):
        now = self.clock()
        columns = "ts, url_host, title, text, " + ", ".join(IDENTITY)
        fields = IDENTITY if kind == "page" else IDENTITY[:3]
        with self.lock:
            page = self._last("browser")
            data = {} if page is None else page[3]
            rows = self.db.execute(f"SELECT {columns} FROM context WHERE kind = ? AND url_host IS ? AND title IS ?"
                                   " ORDER BY ts DESC", (kind, data.get("url_host"), data.get("title"))).fetchall()
            row = next((r for r in rows if _same(dict(zip(IDENTITY, r[4:])), data, fields)), None)
            cleared = [] if row is None or kind != "selection" else self.db.execute(
                f"SELECT {columns} FROM context WHERE kind = 'selection_cleared' AND ts > ?", (row[0],)).fetchall()
        if (row is None or page is None or now - row[0] > fresh or row[0] < self._browser_after or not row[3]
                or not data.get("window_focused", True) or not data.get("visible", True)):
            return None
        _, start, duration, _ = page
        if now - (start + duration) > WEB_PULSE:
            return None
        ids = dict(zip(IDENTITY, row[4:]))
        if any(_same(dict(zip(IDENTITY, c[4:])), ids, IDENTITY[:3]) for c in cleared):
            return None
        if self._withheld(row):
            return None
        return dict(zip(("ts", "url_host", "title", "text"), row))

    def clear_on_page(self, kind):
        """DELETE /context/items/<kind>: every `kind` row of the page the browser shows now goes (the identity
        _on_page matches), so no older row of that page takes its place. Returns the number deleted."""
        fields = IDENTITY if kind == "page" else IDENTITY[:3]
        with self.lock:
            page = self._last("browser")
            if page is None or self.clock() - (page[1] + page[2]) > WEB_PULSE:
                return 0
            data = page[3]
            rows = self.db.execute("SELECT id, " + ", ".join(IDENTITY) + " FROM context WHERE kind = ?"
                                   " AND url_host IS ? AND title IS ?",
                                   (kind, data.get("url_host"), data.get("title"))).fetchall()
            gone = [(row[0],) for row in rows if _same(dict(zip(IDENTITY, row[1:])), data, fields)]
            self.db.executemany("DELETE FROM context WHERE id = ?", gone)
            self.db.commit()
        return len(gone)

    def _withheld(self, row):
        """Kept text checked again when used: secure input now on, or its page blacklisted since."""
        return not self.browser_capture_allowed() or self.blacklist.hides({"url_host": row[1], "title": row[2]})

    def _last(self, bucket):
        row = self.db.execute("SELECT id, start, duration, data FROM events WHERE bucket = ?"
                              " ORDER BY start DESC, id DESC LIMIT 1", (bucket,)).fetchone()
        return None if row is None else (row[0], row[1], row[2], json.loads(row[3]))

    def _heartbeat(self, bucket, ts, data, pulse=PULSE):
        last = self._last(bucket)
        if last is not None:
            rowid, start, duration, previous = last
            if ts < start + duration:
                return  # older than what is stored: out of order or replayed
            if ts <= start + duration + pulse:
                self.db.execute("UPDATE events SET duration = ? WHERE id = ?", (ts - start, rowid))
                if previous == data:
                    return
        self._insert(bucket, ts, 0.0, data)

    def _afk(self, ts, idle, afk):
        if not afk:
            return self._heartbeat("afk", ts, {"status": "not-afk"})
        data, last = {"status": "afk"}, self._last("afk")
        if last is not None and last[3] == data and ts <= last[1] + last[2] + PULSE:
            self.db.execute("UPDATE events SET duration = ? WHERE id = ?", (max(last[2], ts - last[1]), last[0]))
            return
        # AFK starts at the last input, so the idle run-up before the threshold is not active time;
        # across an unknown gap (or with no earlier beat) it starts now.
        start = ts - idle if last is not None and ts - (last[1] + last[2]) <= PULSE else ts
        if last is not None and last[3] != data:
            start = max(start, last[1])  # a not-afk run begins after a gap or an AFK run: never reach before it
        if last is not None and last[1] + last[2] > start:
            if last[3] == data:
                start = last[1] + last[2]
            else:
                self.db.execute("UPDATE events SET duration = ? WHERE id = ?", (max(0.0, start - last[1]), last[0]))
        self._insert("afk", start, ts - start, data)

    def _insert(self, bucket, start, duration, data):
        self.db.execute("INSERT INTO events (bucket, start, duration, data) VALUES (?, ?, ?, ?)",
                        (bucket, start, duration, json.dumps(data, ensure_ascii=False, sort_keys=True)))

    def _prune(self):
        now = self.clock()
        if self._pruned is None or now - self._pruned >= PRUNE_EVERY:
            self.db.execute("DELETE FROM events WHERE start + duration < ?", (now - RETENTION,))
            self.db.execute("DELETE FROM context WHERE ts < ?", (now - RETENTION,))
            self.db.execute("DELETE FROM events_raw WHERE ts < ?", (now - RAW_RETENTION,))
            self.db.execute("DELETE FROM state_log WHERE ts < ?", (now - RETENTION,))
            self._pruned = now

    def _range(self, bucket, since, until):
        rows = self.db.execute("SELECT start, duration, data FROM events WHERE bucket = ? AND start < ?"
                               " AND start + duration > ? ORDER BY start", (bucket, until, since)).fetchall()
        return [(max(s, since), min(s + d, until), json.loads(data)) for s, d, data in rows]

    def events(self, bucket):
        with self.lock:
            rows = self.db.execute("SELECT start, duration, data FROM events WHERE bucket = ? ORDER BY start",
                                   (bucket,)).fetchall()
        return [{"start": s, "duration": d, "data": json.loads(data)} for s, d, data in rows]

    def summary(self, since, until, by):
        with self.lock:
            afk = self._range("afk", since, until)
            spans = self._range(BUCKETS[by], since, until)
            browser = self._range("browser", since, until)
        not_afk = [(a, b) for a, b, data in afk if data["status"] == "not-afk"]
        # As in ActivityWatch: an audible tab keeps the time active even while AFK.
        active = _union(not_afk + [(a, b) for a, b, data in browser if data.get("audible") and data.get("window_focused", True)
                               and data.get("visible", True) and not self.blacklist.hides(data)])
        active_ends = [end for _, end in active]
        totals = {}
        for a, b, data in spans:
            if by == "domain" and self.blacklist.hides(data):
                continue
            if by == "domain" and data.get("url_host") is None and data.get("bundle_id") in CHROMIUM:
                parts = [(max(a, x), min(b, y), d.get("url_host")) for x, y, d in browser if min(b, y) > max(a, x)
                         and d.get("window_focused", True) and d.get("visible", True) and not self.blacklist.hides(d)]
            else:
                key = data.get(KEYS[by]) or (None if by == "domain" else data.get("app"))
                parts = [(a, b, key)]
            for a2, b2, key in parts:
                if key is None or key == HIDDEN["app"] and by == "domain":
                    continue
                for index in range(bisect_right(active_ends, a2), len(active)):
                    x, y = active[index]
                    if x >= b2:
                        break
                    overlap = min(b2, y) - max(a2, x)
                    if overlap > 0:
                        totals[key] = totals.get(key, 0.0) + overlap
        items = sorted(totals.items(), key=lambda kv: -kv[1])[:TOP]
        active_s = sum(b - a for a, b in not_afk)
        afk_s = sum(b - a for a, b, data in afk if data["status"] == "afk")
        return {"since": since, "until": until, "active_s": round(active_s, 1), "afk_s": round(afk_s, 1),
                "unknown_s": round(max(0.0, until - since - active_s - afk_s), 1),
                "items": [{"key": k, "seconds": round(v, 1)} for k, v in items]}

    def afk_runs(self, since, until):
        """[(start, end, "afk" | "not-afk")] of the afk heartbeats, cut to [since, until), oldest first."""
        with self.lock:
            rows = self._range("afk", since, until)
        return [(a, b, data["status"]) for a, b, data in rows]

    def browser_summary(self, since, until):
        summary = self.summary(since, until, "domain")
        with self.lock:
            latest = self._last("browser")
            metrics = self._browser_metrics
            connected = latest is not None and 0 <= until - (latest[1] + latest[2]) <= WEB_PULSE
            focused = bool(connected and latest[3].get("window_focused", True) and latest[3].get("visible", True))
            current = None
            if (focused and self.browser_capture_allowed() and metrics is not None and 0 <= until - metrics["ts"] <= 15
                    and all(metrics.get(k) == latest[3].get(k) for k in IDENTITY)
                    and not self.blacklist.hides(metrics)):
                current = {"at": metrics["ts"], "url_host": metrics["url_host"], **metrics["metrics"]}
            rows = self._range("browser", since, until)
            runs = []
            for _, _, data in rows:
                if (not data.get("window_focused", True) or not data.get("visible", True)
                        or not data.get("url_host") or data.get("url_host") == HIDDEN["app"] or self.blacklist.hides(data)):
                    continue
                key = tuple(data.get(k) for k in ("browser_session", "tab_id", "document_id", "url_host"))
                if not runs or runs[-1] != key:
                    runs.append(key)
            return {**summary, "connected": connected, "focused": focused, "current": current,
                    "page_switches": max(0, len(runs) - 1), "samples_received": self._browser_samples}

    def presence(self):
        """("active" | "afk", seconds in that status up to the latest beat, that afk event as events() gives it), or
        None when beats stopped."""
        with self.lock:
            last = self._last("afk")
        if last is None or self.clock() - (last[1] + last[2]) > PULSE:
            return None
        return ("afk" if last[3]["status"] == "afk" else "active"), last[2], \
            {"start": last[1], "duration": last[2], "data": last[3]}

    def focus(self):
        """The window the user has looked at for at least GAZE_MIN seconds up to now, or None."""
        with self.lock:
            last = self._last("focus")
        if last is None:
            return None
        _, start, duration, data = last
        if duration >= GAZE_MIN and self.clock() - (start + duration) <= PULSE:
            return data
        return None

    def focus_snapshot(self):
        """Current focus plus the observed heartbeat time, without inventing freshness."""
        with self.lock:
            last = self._last("focus")
        if last is None:
            return None
        _, start, duration, data = last
        observed_at = start + duration
        if duration < GAZE_MIN or not 0 <= self.clock() - observed_at <= PULSE:
            return None
        return {"focus": data, "observed_at": observed_at}

    def dwell(self):
        """(start, seconds, data) of the current focus run, or None when beats stopped."""
        with self.lock:
            last = self._last("focus")
        if last is None or self.clock() - (last[1] + last[2]) > PULSE:
            return None
        return last[1], last[2], last[3]

    def delete_since(self, cutoff):
        """Events that start at or after cutoff and context, events_raw and state_log rows from it go; an event running
        across it ends there. Returns (events deleted, context rows deleted)."""
        with self.lock:
            self.raw_floor = self.clock()
            self.context_generation += 1
            events = self.db.execute("DELETE FROM events WHERE start >= ?", (cutoff,)).rowcount
            self.db.execute("UPDATE events SET duration = ? - start WHERE start + duration > ?", (cutoff, cutoff))
            context = self.db.execute("DELETE FROM context WHERE ts >= ?", (cutoff,)).rowcount
            self.db.execute("DELETE FROM events_raw WHERE ts >= ?", (cutoff,))
            self.db.execute("DELETE FROM state_log WHERE ts >= ?", (cutoff,))
            self.db.commit()
            self._ring = collections.deque(e for e in self._ring if e["ts"] < cutoff)
            self._last_inputs = collections.deque(e for e in self._last_inputs if e[0] < cutoff)
            self._browser_metrics = None
            self._browser_samples = 0
        return events, context

    def delete_hidden(self, hides):
        """Window, focus and browser events whose data hides(data) matches go, and context rows whose page it
        matches, and events_raw rows whose window it matches. Returns (events deleted, context rows deleted)."""
        with self.lock:
            self.context_generation += 1
            if self._browser_metrics is not None and hides(self._browser_metrics):
                self._browser_metrics = None
            rows = self.db.execute("SELECT id, data FROM events WHERE bucket IN ('window', 'focus', 'browser')")
            events = [(rowid,) for rowid, data in rows.fetchall() if hides(json.loads(data))]
            rows = self.db.execute("SELECT id, url_host, title FROM context")
            context = [(rowid,) for rowid, host, title in rows.fetchall() if hides({"url_host": host, "title": title})]
            rows = self.db.execute("SELECT id, app, bundle_id, url_host, window FROM events_raw")
            raw = [(row[0],) for row in rows.fetchall()
                   if hides(_raw_window(dict(zip(("app", "bundle_id", "url_host", "window"), row[1:]))))]
            self.db.executemany("DELETE FROM events WHERE id = ?", events)
            self.db.executemany("DELETE FROM context WHERE id = ?", context)
            self.db.executemany("DELETE FROM events_raw WHERE id = ?", raw)
            self.db.commit()
        return len(events), len(context)

    def clear(self):
        return sum(self.clear_tables().values())

    def clear_tables(self):
        """Every table emptied in one transaction: {"events": deleted, "context": deleted, "events_raw": deleted};
        state_log is emptied too but not counted."""
        with self.lock:
            self.raw_floor = self.clock()
            self.context_generation += 1
            deleted = {"events": self.db.execute("DELETE FROM events").rowcount,
                       "context": self.db.execute("DELETE FROM context").rowcount,
                       "events_raw": self.db.execute("DELETE FROM events_raw").rowcount}
            self.db.execute("DELETE FROM state_log")
            self.db.commit()
            self._ring.clear()
            self._last_inputs.clear()
            self._browser_metrics = None
            self._browser_samples = 0
        return deleted

    def clear_browser_text(self, dry=False):
        """Consent revoked: discard cached browser正文/selection without deleting app-duration history.
        dry: the number of rows it would delete, deleting nothing."""
        with self.lock:
            if dry:
                return self.db.execute("SELECT COUNT(*) FROM context").fetchone()[0]
            self.context_generation += 1
            self.db.execute("DELETE FROM context")
            self.db.commit()

    def clear_typed_text(self, dry=False):
        """typed_text revoked or not allowed: every kept value goes; the rows stay.
        dry: the number of values it would drop, dropping nothing."""
        with self.lock:
            if dry:
                return self.db.execute("SELECT COUNT(*) FROM events_raw WHERE value IS NOT NULL").fetchone()[0]
            self.typed_generation += 1
            self.db.execute("UPDATE events_raw SET value = NULL")
            self.db.commit()


def _union(spans):
    merged = []
    for a, b in sorted(spans):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged]


def _same(a, b, fields):
    """Whether a and b agree on each of `fields` that both have non-null."""
    return all(a.get(f) is None or b.get(f) is None or a.get(f) == b.get(f) for f in fields)


def _raw_window(event):
    """An events_raw row as the window the blacklist judges; its window title is matched as the title."""
    return {"app": event.get("app"), "bundle_id": event.get("bundle_id"), "url_host": event.get("url_host"),
            "title": event.get("window")}
