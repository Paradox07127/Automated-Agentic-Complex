"""Proactive speech gate:P0 always passes; everything else must clear every rule."""
import datetime
import secrets
import threading

from character.interactions import preset


class Gate:
    """Times are local naive datetimes; context flags are set by whoever observes them."""

    COMPANION = ("comment", "stuck")

    def __init__(self, enabled=False, quiet=(22, 8), same_cooldown=None, cross_cooldown=30.0,
                 daily_limit=20, state_scale=None, interaction_preset="balanced", db=None):
        """state_scale: None, or a callable giving her state's factor on the comment cooldown; below 1 counts as 1.
        db: a store connection the day's count and refusals (gate_day) and the muted categories (gate_mute) are kept
        in; None keeps them in memory only."""
        self.interaction = preset(interaction_preset)
        self.enabled = enabled and self.interaction.proactive_speech
        self._quiet = quiet  # (start hour, end hour), local; may cross midnight; equal hours: none
        self.same_cooldown = self.interaction.same_cooldown if same_cooldown is None else same_cooldown
        self.cross_cooldown = cross_cooldown
        self.daily_limit = daily_limit
        self.user_speaking = self.fullscreen = self.meeting = False
        self.meeting_manual = False  # PUT /observation/meeting; heartbeats set only meeting
        self.focus = False  # a focus session runs: only P0 and P1 pass
        self.muted = frozenset()  # categories the user turned off; their P0 and P1 lines still pass
        self.last_key = None  # the latest heartbeat's time of the last key, or None without key counts; no rule reads it
        self._last = {}
        self._last_any = None
        self._day, self._count = None, 0
        self._blocked = 0  # non-P0 lines refused on self._day
        self.scale = {}  # category -> factor on same_cooldown
        self.state_scale = state_scale
        self.on_decision = None  # callable(kind, attrs, key); whatever it raises is dropped
        self.db = db
        self._companion = None  # None: on with proactive speech
        self._db_lock = threading.Lock()
        if db is not None:
            today = datetime.date.today()
            row = db.execute("SELECT count, blocked FROM gate_day WHERE day = ?", (today.isoformat(),)).fetchone()
            if row is not None:
                self._day, (self._count, self._blocked) = today, row
            self.muted = frozenset(kind for (kind,) in db.execute("SELECT kind FROM gate_mute"))

    @property
    def companion(self):
        """The stored choice; without one, on with proactive speech."""
        with self._db_lock:
            if self.db is None:
                stored = self._companion
            else:
                row = self.db.execute("SELECT value FROM proactive_settings WHERE key = 'companion_mode'").fetchone()
                stored = None if row is None else row[0] == "true"
        return self.enabled if stored is None else stored

    def set_companion(self, on):
        with self._db_lock:
            if self.db is not None:
                with self.db:
                    self.db.execute("INSERT OR REPLACE INTO proactive_settings (key, value) VALUES ('companion_mode', ?)",
                                    ("true" if on else "false",))
            self._companion = on

    @property
    def quiet(self):
        """(start hour, end hour) as stored, else as constructed."""
        with self._db_lock:
            if self.db is None:
                return self._quiet
            rows = dict(self.db.execute("SELECT key, value FROM proactive_settings"
                                        " WHERE key IN ('quiet_start', 'quiet_end')").fetchall())
        if len(rows) < 2:
            return self._quiet
        return int(rows["quiet_start"]), int(rows["quiet_end"])

    @quiet.setter
    def quiet(self, hours):
        self._quiet = hours

    def set_quiet(self, start, end):
        with self._db_lock:
            if self.db is not None:
                with self.db:
                    self.db.executemany("INSERT OR REPLACE INTO proactive_settings (key, value) VALUES (?, ?)",
                                        [("quiet_start", str(start)), ("quiet_end", str(end))])
            self._quiet = (start, end)

    def set_muted(self, categories):
        """The categories whose P2 and lower lines are refused from now on, replacing the ones before."""
        muted = frozenset(categories)
        with self._db_lock:
            if self.db is not None:
                with self.db:
                    self.db.execute("DELETE FROM gate_mute")
                    self.db.executemany("INSERT INTO gate_mute (kind) VALUES (?)", [(kind,) for kind in sorted(muted)])
            self.muted = muted

    def admit(self, category, level, now=None, key=None, commit=True):
        """Return (True, None) and count it, or (False, reason) and count only the refusal (non-P0).
        key: groups this decision with the events of what it is for; None gives it its own.
        commit False: an admitted line is counted later, by commit()."""
        now = now or datetime.datetime.now()
        reason = None if level == "P0" else self._reason(category, now, level)
        if commit and level != "P0" and reason is None:
            self.commit(category, now)
        if reason is not None:
            if self._day != now.date():
                self._day, self._count, self._blocked = now.date(), 0, 0
            self._blocked += 1
            self._save()
        self.report(category, level, reason, key)
        return reason is None, reason

    def report(self, category, level, reason, key=None):
        """Records a decision on a line of category, refused for reason or (None) admitted; counts nothing."""
        if self.on_decision is not None:
            try:
                self.on_decision("gate.decided", {"kind": category, "level": level, "speak": reason is None,
                                                  "reason": reason}, key or secrets.token_hex(8))
            except Exception:  # a decision record never changes the decision
                pass

    def commit(self, category, now=None):
        """Start the cooldowns of a non-P0 line and add it to the daily count."""
        now = now or datetime.datetime.now()
        if self._day != now.date():
            self._day, self._count, self._blocked = now.date(), 0, 0
        self._last[category] = self._last_any = now
        self._count += 1
        self._save()

    def _save(self):
        """Writes self._day's row and drops the rows of days before the 7 that end on it."""
        if self.db is None:
            return
        with self._db_lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO gate_day (day, count, blocked) VALUES (?, ?, ?)",
                            (self._day.isoformat(), self._count, self._blocked))
            self.db.execute("DELETE FROM gate_day WHERE day < ?",
                            ((self._day - datetime.timedelta(days=6)).isoformat(),))

    def check(self, category, now=None, level=None):
        """The reason a non-P0 admit at level would give now, or None; counts and reports nothing."""
        return self._reason(category, now or datetime.datetime.now(), level)

    def _reason(self, category, now, level=None):
        if not self.enabled:
            return "disabled"
        if category in self.COMPANION and not self.companion:
            return "companion_off"
        if category in self.muted and level != "P1":
            return "muted"
        if self.meeting or self.meeting_manual:
            return "meeting"
        if self.focus and level != "P1":
            return "focus"
        if self.user_speaking:
            return "user_speaking"
        if self.fullscreen:
            return "fullscreen"
        start, end = self.quiet
        if (start <= now.hour or now.hour < end) if start > end else start <= now.hour < end:
            return "quiet_hours"
        if self._day != now.date():
            self._day, self._count, self._blocked = now.date(), 0, 0
        if self._count >= self.daily_limit:
            return "daily_limit"
        last = self._last.get(category)
        scale = self.scale.get(category, 1)
        if category == "comment" and self.state_scale is not None:
            scale *= max(1, self.state_scale())
        if last and (now - last).total_seconds() < self.same_cooldown * scale:
            return "same_cooldown"
        if self._last_any and (now - self._last_any).total_seconds() < self.cross_cooldown:
            return "cross_cooldown"
        return None
