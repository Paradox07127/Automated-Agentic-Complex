"""Tap rituals:what a click on the character says, one at a time by priority. A daily kind counts once its
line completed, a break or water reminder once per time it fell due; ritual_log keeps both across restarts."""
import datetime
import json
import random
import re
import threading
import time

from character.proactive import WAITING

KINDS = ("break", "water", "birthday", "morning", "report")  # highest priority first
MORNING_FROM = 5  # local hour the morning greeting opens; the report time closes it
RETRY_AFTER = 60.0  # seconds a cancelled or failed ritual line waits before it is said again
WATER_STALE = 2 * 3600  # seconds a water reminder stays pending
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
BIRTHDAY = (re.compile(r"(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]"), re.compile(r"(?:\d{4}[-/.])?(\d{1,2})[-/.](\d{1,2})"))
# The text before .format goes through egress.authored; the fields filled in are observed, but {user_title} is the
# card's user_title.
TEMPLATES = {
    "break": "(Situation, not words from {user_title}: {user_title} touched you. They have been at the computer for "
             "{minutes} minutes straight. Use this touch to tell them how long it has been in one caring line, the way "
             "someone nearby mentions it in passing, not like a clock; do not push, do not lecture.)",
    "water": "(Situation, not words from {user_title}: {user_title} touched you. They have sat at the computer for "
             "{minutes} minutes in all, and you remember they should drink some water. Gently remind them to drink "
             "water in one line, like a passing bit of care; the time need not be mentioned.)",
    "birthday": "(Situation, not words from {user_title}: {user_title} touched you, and today is their birthday. Wish "
                "them a happy birthday in a line of your own: sincere, not too grand.)",
    "morning": "(Situation, not words from {user_title}: this is the first time {user_title} has touched you today; it "
               "is {weekday} {time}. Give them the first greeting of the day in one line: good morning before noon, "
               "and once past noon a greeting that fits the hour; you may add a little care about their day; do not "
               "announce the time.)",
    "report": "(Situation, not words from {user_title}: {user_title} touched you, and it is time for today's end-of-day "
              "report. What happened today is in the live material. Today {sessions} sessions were opened, "
              "sub-agents finished {agents_done} and failed {agents_failed}, "
              "and you opened {own_sessions} sessions for them; still waiting: {waiting}. "
              "Tell them in two or three sentences: first the main things done today and how far each got, then one "
              "sentence with the session count; if something is still waiting, mention it. "
              "Say it in your usual voice; do not read out times one by one, do not judge.)",
}
# A tap with no ritual pending; it goes through egress.authored too. Its region, if known, is the line's material.
TAP = ("(Situation, not words from {user_title}: {user_title} reached out and touched you lightly. You felt it; answer "
       "with a line or two in your own usual voice: if the earlier topic is not finished, carry on with that topic; "
       "with no topic, they most likely just want to see you and say hello, not hand you a task. React the way "
       "someone nearby would to a light touch, naturally and in keeping with your character; a light touch is "
       "nothing to make a fuss about. Where you were touched may shape your reaction but need not be said, and you "
       "may also just turn and talk to them; mention live details such as the time or sessions only when they truly "
       "matter. "
       "What you say is only your reaction; do not describe what they just did; vary your reaction each time, and "
       "do not ask every time what they want to do.)")
# TAP for count > 1 clicks since the last tap request.
TAPS = ("(Situation, not words from {user_title}: {user_title} touched you {count} times in a row. React in a line or "
        "two of short words, by the count: two or three touches feel like teasing you or wanting your attention, so "
        "you may ask curiously; "
        "the more touches, the more you may sound a little exasperated, or tease them back, still within your usual "
        "bounds. If the earlier topic is not finished, pick it up. "
        "What you say is only your reaction; do not state the count, do not describe what they just did.)")
# Her opening line on the desktop once the first-run guide is done (RitualsGlueMixin.greet); through egress.authored.
GREETING = ("(Situation, not words from {user_title}: {user_title} has just finished setting you up on this computer "
            "and chose to talk with you; you now stand on their desktop for the first time. Give them your opening "
            "line: one or two short sentences in your own usual voice, as a first hello. Do not describe the setup, do "
            "not list what you can do, and do not ask them for a task.)")
COUNTS = ("sessions","agents_done", "agents_failed", "gates_green", "gates_red", "guard_blocks", "own_sessions")


def pick_line(card, event, language, previous):
    choices = [entry[language] for entry in card.get("lines", {}).get(event, []) if language in entry]
    if not choices:
        return None
    return random.choice([text for text in choices if text != previous] or choices)


def _month_day(text):
    for pattern in BIRTHDAY:
        found = pattern.search(text or "")
        if found:
            return int(found.group(1)), int(found.group(2))
    return None


class Rituals:
    def __init__(self, db, clock=time.time, report_time="17:30", memory=None, summary=None, on_change=None, arc=None,
                 greeted=None):
        """db: the shared store; report_time: local "HH:MM"; memory: Memory, for a confirmed birthday;
        summary(day) -> day_summary.summarize's result for local date day, or None; on_change() runs after
        something that may change pending(); arc(day) -> what was worked on local date day, or None;
        greeted(date) -> whether her return performance already welcomed the user on that local date, so the
        morning greeting is not due."""
        hour, minute = report_time.split(":")
        self.report_time = (int(hour), int(minute))
        self.db, self.clock, self.memory, self.summary, self.on_change = db, clock, memory, summary, on_change
        self.arc, self.greeted = arc, greeted or (lambda day: False)
        self._pending = {}  # "break" / "water" -> (its template's fields, clock time it fell due)
        self._lock = threading.Lock()
        now = self.clock()
        for kind, data, due_at in db.execute("SELECT kind, data, at FROM ritual_pending").fetchall():
            # Water goes stale as _due drops it; a break has no such rule, so it lasts its local day.
            fresh = (now - due_at < WATER_STALE) if kind == "water" else (_day(due_at) == _day(now))
            if fresh:
                self._pending[kind] = (json.loads(data), due_at)
            else:
                db.execute("DELETE FROM ritual_pending WHERE kind = ?", (kind,))
        db.commit()

    def pending(self, now=None):
        """The kinds a tap may say now, highest priority first; one waiting out RETRY_AFTER is still pending."""
        return [kind for kind, _ in self._due(self.clock() if now is None else now)]

    def pick(self, now=None):
        """(kind, its template's fields) of the highest pending kind not waiting out RETRY_AFTER, or None."""
        now = self.clock() if now is None else now
        return next(((kind, data) for kind, data in self._due(now) if not self._held(kind, now)), None)

    def begin(self, kind, line_id):
        """line_id says kind from now; it counts once settled(line_id, "completed")."""
        now = self.clock()
        with self._lock:
            self.db.execute("INSERT INTO ritual_log (day, kind, line_id, state, at) VALUES (?, ?, ?, 'started', ?)",
                            (_day(now), kind, line_id, now))
            self.db.commit()

    def settled(self, line_id, state):
        """How line_id ended: "completed" counts; any other state waits out RETRY_AFTER and stays pending."""
        with self._lock:
            row = self.db.execute("SELECT kind FROM ritual_log WHERE line_id = ?", (line_id,)).fetchone()
            if row is None:
                return
            self.db.execute("UPDATE ritual_log SET state = ?, at = ? WHERE line_id = ?", (state, self.clock(), line_id))
            if state == "completed":
                self._pending.pop(row[0], None)
                self.db.execute("DELETE FROM ritual_pending WHERE kind = ?", (row[0],))
            self.db.commit()
        self._changed()

    def set_pending(self, kind, data):
        """A break or water reminder fell due; data: its template's fields."""
        with self._lock:
            self._pending[kind] = (dict(data), self.clock())
            self.db.execute("INSERT OR REPLACE INTO ritual_pending (kind, data, at) VALUES (?, ?, ?)",
                            (kind, json.dumps(self._pending[kind][0]), self._pending[kind][1]))
            self.db.commit()
        self._changed()

    def clear_pending(self, kind):
        with self._lock:
            cleared = self._pending.pop(kind, None) is not None
            self.db.execute("DELETE FROM ritual_pending WHERE kind = ?", (kind,))
            self.db.commit()
        if cleared:
            self._changed()

    def clear(self):
        """Forget both persisted completions and pending reminders during a full reset."""
        with self._lock:
            self._pending.clear()
            self.db.execute("DELETE FROM ritual_log")
            self.db.execute("DELETE FROM ritual_pending")
            self.db.commit()

    def today(self, now=None):
        """[{kind, line_id, at}] of the rituals said to the end today, oldest first."""
        day = _day(self.clock() if now is None else now)
        with self._lock:
            rows = self.db.execute("SELECT kind, line_id, at FROM ritual_log WHERE day = ? AND state = 'completed'"
                                   " ORDER BY at, rowid", (day,)).fetchall()
        return [{"kind": kind, "line_id": line_id, "at": at} for kind, line_id, at in rows]

    def _changed(self):
        if self.on_change is not None:
            self.on_change()

    def _due(self, now):
        """(kind, fields) of each pending kind in priority order; lazy, so pick() reads the ledger only if it must."""
        local = datetime.datetime.fromtimestamp(now)
        day = local.date().isoformat()
        with self._lock:
            water = self._pending.get("water")
            if water is not None and now - water[1] >= WATER_STALE:
                del self._pending["water"]
            due = dict(self._pending)
        for kind in ("break", "water"):
            if kind in due:
                yield kind, dict(due[kind][0])
        if self._birthday(local) and not self._done("birthday", day):
            yield "birthday", {}
        evening = (local.hour, local.minute) >= self.report_time
        if not evening and local.hour >= MORNING_FROM and not self._done("morning", day) \
                and not self.greeted(local.date()):
            yield "morning", {"weekday": WEEKDAYS[local.weekday()], "time": f"{local:%H:%M}"}
        if evening and not self._done("report", day):
            summary = self.summary(day) if self.summary is not None else None
            arc_text = self.arc(day) if self.arc is not None else None
            counted = bool(summary) and any(summary.values())
            if counted or arc_text:  # only a day with some session event or episode has a report
                if not counted:
                    summary = {**dict.fromkeys(COUNTS, 0), "waiting": []}
                waiting = "; ".join(f"{w['name']} {w.get('word') or WAITING[w['state']]}" for w in summary["waiting"]) or "none"
                yield "report", {**{k: v for k, v in summary.items() if k != "waiting"}, "waiting": waiting,
                                 "arc": arc_text or "no record"}

    def _birthday(self, local):
        if self.memory is None:
            return False
        return any(fact["kind"] == "birthday" and not fact["quiet"] and _month_day(fact["text"]) == (local.month, local.day)
                   for fact in self.memory.active(["confirmed_by_user"]))

    def _done(self, kind, day):
        with self._lock:
            return self.db.execute("SELECT 1 FROM ritual_log WHERE day = ? AND kind = ? AND state = 'completed'",
                                   (day, kind)).fetchone() is not None

    def _held(self, kind, now):
        """A line of kind that did not complete ended less than RETRY_AFTER ago."""
        with self._lock:
            at = self.db.execute("SELECT MAX(at) FROM ritual_log WHERE kind = ? AND state NOT IN ('started', 'completed')",
                                 (kind,)).fetchone()[0]
        return at is not None and now - at < RETRY_AFTER


def _day(t):
    return datetime.date.fromtimestamp(t).isoformat()
