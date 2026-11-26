"""Persistent reminders the user asked for ("提醒我…"): armed until due, triggered once, then fulfilled or missed."""
import json
import hashlib
import math
import re
import secrets
import threading
import time

TRANSITIONS = {"armed": ("armed", "triggered", "fulfilled", "missed", "cancelled"),
               "triggered": ("armed", "fulfilled", "missed", "cancelled"), "fulfilled": ("armed",),
               "missed": (), "cancelled": ()}
COLUMNS = ("id", "text", "due_at", "state", "created_at", "created_line", "delivered_line", "updated_at", "revision",
           "repeat", "trigger", "seen_at")
SELECT = f"SELECT {', '.join(COLUMNS)} FROM commitments"

ASK = "提醒我"
DIGITS = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
NUM = r"[0-9]+|[零一二两三四五六七八九十]+"
RELATIVE = re.compile(rf"(?:({NUM})\s*(分钟|个?小时|个半小时)|半小时)后")
REPEAT = {"每天": "daily", "每个工作日": "weekdays", "工作日": "weekdays"}
QUOTED = re.compile(r"「[^「」]*」")
SNOOZE_DELIVERED = 86400  # seconds after delivery a fulfilled reminder may still be snoozed back to armed
TRIGGER_TTL = 86400  # seconds an unfired trigger stays armed before it is missed
WAIT = re.compile(r"^(?:等\s*)?(claude|codex)\s*(?:做完|跑完)(?:了|以后|之后)?[，,]?\s*提醒我[\s：:，,]*(.*)$", re.I | re.S)
DATE = re.compile(r"今天|明天|大后天|后天|下周[一二三四五六日天]|[这本]?(?:周|星期|礼拜)[一二三四五六日天]")
DAY_PART = {"今晚": ("今天", "晚上"), "明早": ("明天", "早上"), "明晚": ("明天", "晚上")}
CLOCK = re.compile(rf"(?:({DATE.pattern})?\s*(早上|上午|中午|下午|晚上|凌晨)?|({'|'.join(DAY_PART)}))\s*"
                   rf"(?:([0-9]{{1,2}})(?:[:：]([0-9]{{2}}))?\s*(am|pm)|"
                   rf"([0-9]{{1,2}})[:：]([0-9]{{2}})|({NUM})点(?:半|({NUM})分)?)", re.I)
UNPARSED_TIME = re.compile(r"早上|上午|中午|下午|晚上|凌晨|傍晚|今晚|明早|明晚|月底前?|月初|下个?月|周末|下周|晚点|一会儿|"
                           r"[0-9零一二两三四五六七八九十]+[号日]")


def number(text):
    """Arabic digits, or a Chinese number from 零 to 五十九; None otherwise."""
    if text.isascii():
        return int(text)
    tens, ten, ones = text.partition("十")
    if not ten:
        return DIGITS.get(text) if len(text) == 1 else None
    tens = DIGITS.get(tens) if tens else 1
    ones = DIGITS.get(ones) if ones else 0
    if tens is None or ones is None or not 1 <= tens <= 5:
        return None
    return tens * 10 + ones


def _due(match, now):
    if match.re is RELATIVE:
        if match.group(1) is None:
            return now + 1800
        amount = number(match.group(1))
        unit = 60 if match.group(2) == "分钟" else 3600
        return None if amount is None else now + amount * unit + (1800 if match.group(2) == "个半小时" else 0)
    if match.re is DATE:
        if match.group() == "今天":
            return None
        day, part, hour, minute = match.group(), None, 9, 0
    else:
        day, part, day_part, ampm_hour, ampm_minute, ampm, hour, minute, cn_hour, cn_minute = match.groups()
        if day_part is not None:
            day, part = DAY_PART[day_part]
        if ampm is not None:
            hour, minute = int(ampm_hour), int(ampm_minute or 0)
            if not 1 <= hour <= 12 or part is not None:
                return None
            hour = hour % 12 + (12 if ampm.lower() == "pm" else 0)
        elif hour is None:
            hour = number(cn_hour)
            minute = 30 if match.group(0).endswith("半") else 0 if cn_minute is None else number(cn_minute)
        else:
            hour, minute = int(hour), int(minute)
    if hour is None or minute is None or hour > 23 or minute > 59:
        return None
    # 中午一点 is 13:00, 中午十一点 and 十二点 keep their hour.
    if part in ("下午", "晚上") and 1 <= hour <= 11 or part == "中午" and 1 <= hour <= 10:
        hour += 12
    elif part in ("晚上", "凌晨") and hour == 12:
        hour = 24 if part == "晚上" else 0  # 晚上十二点 is the midnight that ends that evening
    today = time.localtime(now)

    def at(days):
        return time.mktime((today.tm_year, today.tm_mon, today.tm_mday + days, hour, minute, 0, 0, 0, -1))

    days = {"明天": 1, "后天": 2, "大后天": 3}.get(day)
    if days is not None:
        return at(days)
    if day is not None and day != "今天":
        weekday = 6 if day[-1] in "日天" else DIGITS[day[-1]] - 1
        days = 7 - today.tm_wday + weekday if day.startswith("下周") else (weekday - today.tm_wday) % 7
        return at(days) if days or at(0) > now else at(7)
    if day == "今天":
        return at(0) if at(0) > now else None
    return at(0) if at(0) > now else at(1)


def occurrence(due_at, repeat, after):
    """The first time later than after at due_at's local clock time, from due_at's day on, on a day repeat allows."""
    t = time.localtime(due_at)
    days = 0
    while True:
        at = time.mktime((t.tm_year, t.tm_mon, t.tm_mday + days, t.tm_hour, t.tm_min, t.tm_sec, 0, 0, -1))
        if at > after and (repeat != "weekdays" or time.localtime(at).tm_wday < 5):
            return at
        days += 1


def parse_reminder(text, now):
    """(due_at, what, repeat) from "提醒我 [每天|工作日] <time> <what>" in the local time zone; repeat is None, "daily"
    or "weekdays"; None when the time or what is missing."""
    if ASK not in text:
        return None
    # A 「…」 span is a name (a dropped file's) and part of what; no repeat or time is read from inside it.
    masked = QUOTED.sub(lambda m: "\0" * len(m.group()), text)
    word = next((w for w in REPEAT if w in masked), None)
    repeat = REPEAT.get(word)
    if word is not None:
        at = masked.index(word)
        text, masked = text[:at] + text[at + len(word):], masked[:at] + masked[at + len(word):]
    match = RELATIVE.search(masked) or CLOCK.search(masked) or DATE.search(masked)
    if match is None:
        return None
    due_at = _due(match, now)
    what = (text[:match.start()] + text[match.end():]).replace(ASK, "", 1).strip().strip("：，").strip()
    before, after = masked[:match.start()].replace(ASK, "").rstrip(), masked[match.end():].replace(ASK, "").lstrip()
    # A second time expression touching the used one makes the time ambiguous; one inside the body is content.
    if due_at is None or not what or any(w.match(after) or any(m.end() == len(before) for m in w.finditer(before))
                                         for w in (RELATIVE, CLOCK, DATE, UNPARSED_TIME)):
        return None
    return (due_at if repeat is None else occurrence(due_at, repeat, now)), what, repeat


def parse_wait(text):
    """(trigger, what) from "[等] claude|codex 做完|跑完 提醒我 <what>"; None otherwise."""
    match = WAIT.match(text.strip())
    if match is None or not match.group(2).strip():
        return None
    return {"kind": "session_done", "agent": match.group(1).lower()}, match.group(2).strip()


# What a trigger waits for, by reply language code; "harness" (None) takes the Chinese words.
AWAITED = {'zh-Hans': {'approval': '审批等满 {minutes} 分钟', 'agent': '{agent} 做完', 'session': '会话做完'},
           'en': {'approval': 'an approval has waited {minutes} min', 'agent': '{agent} finishes',
                  'session': 'a session finishes'},
           'ja': {'approval': '承認待ち {minutes} 分', 'agent': '{agent} の完了', 'session': 'セッションの完了'}}


def awaited(trigger, language):
    """What a trigger waits for, in words of the reply language code."""
    words = AWAITED.get(language, AWAITED['zh-Hans'])
    if trigger["kind"] == "approval_waiting":
        return words['approval'].format(minutes=trigger['minutes'])
    return words['agent'].format(agent=trigger['agent']) if trigger.get("agent") else words['session']


def _matches(trigger, kind, attrs):
    if trigger["kind"] != kind:
        return False
    if kind == "approval_waiting":
        return attrs["minutes"] >= trigger["minutes"]
    return trigger.get("agent") in (None, attrs["agent"]) and trigger.get("session_id") in (None, attrs["session_id"])


def _row(row):
    if row is None:
        return None
    item = dict(zip(COLUMNS, row))
    item["trigger"] = item["trigger"] and json.loads(item["trigger"])
    return item


class Commitments:
    def __init__(self, db, lock=None, clock=time.time):
        self.db, self.clock = db, clock
        self.lock = threading.RLock() if lock is None else lock
        self._next = None  # next_due()'s answer until a write; None: not known

    def _get(self, commitment_id):
        return _row(self.db.execute(f"{SELECT} WHERE id = ?", (commitment_id,)).fetchone())

    def next_due(self):
        """The earliest time due() or expire() can find an item; inf when none can."""
        with self.lock:
            if self._next is None:
                due, created = self.db.execute(
                    "SELECT MIN(due_at), MIN(CASE WHEN due_at IS NULL THEN created_at END) FROM commitments"
                    " WHERE state = 'armed'").fetchone()
                self._next = min(math.inf if due is None else due,
                                 math.inf if created is None else created + TRIGGER_TTL)
            return self._next

    def _move(self, commitment_id, state, now, delivered_line=None, due_at=None, expected_revision=None):
        item = self._get(commitment_id)
        if item is None:
            raise ValueError("unknown_commitment")
        if expected_revision is not None and item["revision"] != expected_revision:
            raise ValueError("commitment_changed")
        if state not in TRANSITIONS[item["state"]]:
            raise ValueError("illegal_transition")
        self._next = None
        # Each time it comes due its card is unseen again.
        changed = self.db.execute("UPDATE commitments SET state = ?, updated_at = ?, delivered_line = COALESCE(?, delivered_line),"
                        " due_at = COALESCE(?, due_at), revision = revision + 1,"
                        " seen_at = CASE ? WHEN 'triggered' THEN NULL ELSE seen_at END WHERE id = ? AND revision = ?",
                        (state, now, delivered_line, due_at, state, commitment_id, item["revision"]))
        if changed.rowcount != 1:
            raise ValueError("commitment_changed")
        return self._get(commitment_id)

    def _series(self, commitment_id):
        return self.db.execute("SELECT series_at FROM commitments WHERE id = ?", (commitment_id,)).fetchone()[0]

    def _rearm(self, item, now, delivered_line=None):
        """A repeating item armed at its series' next own time after now; a snoozed re-delivery it held is dropped."""
        series = self._series(item["id"])
        due_at = occurrence(item["due_at"], item["repeat"], max(now, item["due_at"])) if series is None \
            else occurrence(series, item["repeat"], now)
        item = self._move(item["id"], "armed", now, delivered_line=delivered_line, due_at=due_at)
        self.db.execute("UPDATE commitments SET series_at = NULL WHERE id = ?", (item["id"],))
        return item

    def _receipt(self, request_key, request, item=None):
        if request_key is None:
            return None
        key = "character-reminder:" + request_key
        encoded = 'sha256:' + hashlib.sha256(json.dumps(request, sort_keys=True, ensure_ascii=False,
                                                       allow_nan=False).encode()).hexdigest()
        if item is None:
            row = self.db.execute("SELECT request, answer FROM idempotency_receipts WHERE key = ?", (key,)).fetchone()
            if row:
                if row[0] != encoded:
                    raise ValueError("reminder_request_changed")
                receipt = json.loads(row[1])
                if receipt.get('deleted'):
                    raise ValueError('reminder_deleted')
                return receipt
        else:
            self.db.execute("INSERT INTO idempotency_receipts (key, request, answer, at) VALUES (?, ?, ?, ?)",
                            (key, encoded, json.dumps(item, ensure_ascii=False), self.clock()))

    def add(self, text, due_at, created_line=None, *, repeat=None, trigger=None, request_key=None):
        """due_at None with a trigger: armed until fire() matches it."""
        now = self.clock()
        commitment_id = secrets.token_hex(6)
        with self.lock, self.db:
            if request_key is not None and not self.db.in_transaction:
                self.db.execute("BEGIN IMMEDIATE")
            request = {"operation": "create", "text": text, "due_at": due_at, "created_line": created_line,
                       "repeat": repeat, **({"trigger": trigger} if trigger else {})}
            old = self._receipt(request_key, request)
            if old is not None:
                return old
            self._next = None
            self.db.execute("INSERT INTO commitments (id, text, due_at, state, created_at, created_line, updated_at,"
                            " repeat, trigger) VALUES (?, ?, ?, 'armed', ?, ?, ?, ?, ?)",
                            (commitment_id, text, due_at, now, created_line, now, repeat,
                             trigger and json.dumps(trigger, ensure_ascii=False)))
            item = self._get(commitment_id)
            self._receipt(request_key, request, item)
            self.db.commit()
            return item

    def due(self, now=None):
        """Armed items whose time has come, now triggered; each is returned once."""
        now = self.clock() if now is None else now
        with self.lock:
            ids = [r[0] for r in self.db.execute("SELECT id FROM commitments WHERE state = 'armed' AND due_at <= ?"
                                                 " ORDER BY due_at", (now,))]
            items = [self._move(commitment_id, "triggered", now) for commitment_id in ids]
            if items:
                self.db.commit()
            self._next = None
        return items

    def fire(self, kind, attrs):
        """Armed reminders waiting for a trigger of kind that attrs match ({agent, session_id} for session_done,
        {minutes} waited for approval_waiting), now due; each fires once."""
        with self.lock:
            now = self.clock()
            items = [self._move(item["id"], "armed", now, due_at=now)
                     for item in map(_row, self.db.execute(f"{SELECT} WHERE state = 'armed' AND due_at IS NULL"
                                                          " AND trigger IS NOT NULL ORDER BY created_at").fetchall())
                     if _matches(item["trigger"], kind, attrs)]
            if items:
                self.db.commit()
        return items

    def expire(self, now=None):
        """Armed reminders whose trigger has not fired within TRIGGER_TTL, now missed."""
        now = self.clock() if now is None else now
        with self.lock:
            ids = [r[0] for r in self.db.execute("SELECT id FROM commitments WHERE state = 'armed' AND due_at IS NULL"
                                                 " AND created_at <= ? ORDER BY created_at", (now - TRIGGER_TTL,))]
            items = [self._move(commitment_id, "missed", now) for commitment_id in ids]
            if items:
                self.db.commit()
            self._next = None
        return items

    def fulfill(self, commitment_id, line_id):
        """Fulfilled; a repeating one is re-armed at its next time instead."""
        with self.lock:
            now, item = self.clock(), self._get(commitment_id)
            if item is not None and item["repeat"] is not None:
                item = self._rearm(item, now, line_id)
            else:
                item = self._move(commitment_id, "fulfilled", now, delivered_line=line_id)
            self.db.commit()
        return item

    def complete(self, commitment_id, *, expected_revision=None, request_key=None):
        """The user is done with the occurrence it delivered: as fulfill, except that a repeating one its delivery
        already re-armed at its series' own time stays as it is."""
        with self.lock, self.db:
            if request_key is not None and not self.db.in_transaction:
                self.db.execute("BEGIN IMMEDIATE")
            request = {"operation": "complete", "id": commitment_id, "revision": expected_revision}
            old = self._receipt(request_key, request)
            if old is not None:
                return old
            now, item = self.clock(), self._get(commitment_id)
            if item is not None and expected_revision is not None and item["revision"] != expected_revision:
                raise ValueError("commitment_changed")
            # updated_at is created_at until a first occurrence re-arms it: before that there is none to keep.
            if item is not None and item["repeat"] is not None and item["state"] == "armed" \
                    and item["updated_at"] > item["created_at"] and self._series(commitment_id) is None:
                pass
            elif item is not None and item["repeat"] is not None:
                item = self._rearm(item, now)
            else:
                item = self._move(commitment_id, "fulfilled", now, expected_revision=expected_revision)
            self._receipt(request_key, request, item)
            self.db.commit()
        return item

    def seen(self, commitment_id):
        """Its card was on screen: the first receipt since it came due is kept; None for an unknown id."""
        with self.lock:
            self.db.execute("UPDATE commitments SET seen_at = ? WHERE id = ? AND seen_at IS NULL",
                            (self.clock(), commitment_id))
            self.db.commit()
            return self._get(commitment_id)

    def cancel(self, commitment_id, *, expected_revision=None, request_key=None):
        with self.lock, self.db:
            if request_key is not None and not self.db.in_transaction:
                self.db.execute("BEGIN IMMEDIATE")
            request = {"operation": "cancel", "id": commitment_id, "revision": expected_revision}
            old = self._receipt(request_key, request)
            if old is not None:
                return old
            item = self._move(commitment_id, "cancelled", self.clock(), expected_revision=expected_revision)
            self._receipt(request_key, request, item)
            self.db.commit()
        return item

    def snooze(self, commitment_id, due_at, *, expected_revision=None, request_key=None):
        with self.lock, self.db:
            if request_key is not None and not self.db.in_transaction:
                self.db.execute("BEGIN IMMEDIATE")
            request = {"operation": "reschedule", "id": commitment_id, "due_at": due_at, "revision": expected_revision}
            old = self._receipt(request_key, request)
            if old is not None:
                return old
            now, item = self.clock(), self._get(commitment_id)
            if item is not None and item["state"] == "fulfilled" and now - item["updated_at"] > SNOOZE_DELIVERED:
                raise ValueError("illegal_transition")
            item = self._move(commitment_id, "armed", now, due_at=due_at, expected_revision=expected_revision)
            self.db.execute("UPDATE commitments SET series_at = NULL WHERE id = ?", (commitment_id,))  # the series moves too
            self._receipt(request_key, request, item)
            self.db.commit()
        return item

    def postpone(self, commitment_id, due_at, *, expected_revision=None, request_key=None):
        """Its delivered occurrence said again at due_at: as snooze, except that a repeating one goes on at its series'
        own time after that."""
        with self.lock, self.db:
            if request_key is not None and not self.db.in_transaction:
                self.db.execute("BEGIN IMMEDIATE")
            item = self._get(commitment_id)
            if item is None or item["repeat"] is None:
                return self.snooze(commitment_id, due_at, expected_revision=expected_revision, request_key=request_key)
            request = {"operation": "postpone", "id": commitment_id, "due_at": due_at, "revision": expected_revision}
            old = self._receipt(request_key, request)
            if old is not None:
                return old
            series = self._series(commitment_id) or item["due_at"]
            item = self._move(commitment_id, "armed", self.clock(), due_at=due_at, expected_revision=expected_revision)
            self.db.execute("UPDATE commitments SET series_at = ? WHERE id = ?", (series, commitment_id))
            self._receipt(request_key, request, item)
            self.db.commit()
        return item

    def recover(self, now=None, grace=600):
        """At startup: armed items overdue by more than grace, and triggered ones a restart kept from delivery, are
        missed, except that a repeating one is re-armed at its next time; returns them as they were when missed."""
        now = self.clock() if now is None else now
        with self.lock:
            ids = [r[0] for r in self.db.execute("SELECT id FROM commitments WHERE (state = 'armed' AND due_at < ?)"
                                                 " OR state = 'triggered' ORDER BY due_at", (now - grace,))]
            items = []
            for commitment_id in ids:
                item = self._get(commitment_id)
                if item["repeat"] is None:
                    items.append(self._move(commitment_id, "missed", now))
                else:
                    self._rearm(item, now)
                    items.append(item)
            self.db.commit()
        return items

    def delete(self, commitment_id):
        with self.lock, self.db:
            self._next = None
            deleted = self.db.execute("DELETE FROM commitments WHERE id = ?", (commitment_id,)).rowcount > 0
            # Keep a content-free replay tombstone, so an in-flight retry cannot
            # recreate a reminder after the user deletes it.
            self.db.execute("UPDATE idempotency_receipts SET answer = ? WHERE key LIKE 'character-reminder:%'"
                            " AND json_valid(answer) AND json_extract(answer, '$.id') = ?",
                            (json.dumps({'id': commitment_id, 'deleted': True}), commitment_id))
            self.db.commit()
        return deleted

    def list(self, states=None):
        with self.lock:
            if states is None:
                rows = self.db.execute(f"{SELECT} ORDER BY due_at").fetchall()
            else:
                rows = self.db.execute(f"{SELECT} WHERE state IN ({', '.join('?' * len(states))}) ORDER BY due_at",
                                       tuple(states)).fetchall()
        return [_row(row) for row in rows]
