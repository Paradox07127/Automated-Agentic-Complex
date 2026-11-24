"""Proactive nudges on /feed (C6): an alert for a dialog window, a comment after a long dwell."""
import collections
import datetime
import os
import re
import secrets
import threading
import time

from brain.events import cue
from brain.persona import PROMPT_USER
from character.behavior import CATEGORY_NAMES, category
from observation.activity import INTERPRETED_FRESH
from observation.blacklist import HIDDEN
from sessions.registry import own_app_wait
from observation.user_state import MODE_NAMES

LEVEL = "P2"
ALERT_EVERY = 600.0  # seconds between alerts for the same window
DWELL = 180  # seconds on one focus run before the judge is asked once
UNKNOWN_DWELL = 2 * DWELL  # the same for an app the rules do not recognise
UNKNOWN_IDLE = 60  # seconds since the last input within which the user counts as present at such an app
DIALOG_ROLES = {"AXSheet"}
DIALOG_SUBROLES = {"AXDialog", "AXSystemDialog"}
WANT_COMMENT = {"id": "want_comment", "type": "yes_no",
                "text": "The user has stayed in the same window this long; is it a good moment for the desktop character to "
                        "speak up on its own? From the given app category, minutes in the window, hour, activity, the "
                        "kinds of the latest actions in the window and the seconds since the last one (null: none "
                        "recorded), weigh "
                        "the cost of interrupting against the value of speaking: interrupting costs a lot during focused "
                        "writing, coding, watching video or a meeting, or a late-night push; speaking has value when a long "
                        "stop looks like being stuck, hesitating or flipping back and forth, or when a long stretch of the "
                        "same thing calls for a breather. Answer yes when the value is greater, else no."}
USEFUL = {"id": "useful", "type": "yes_no",
          "text": "From the given activity and app category, can the desktop character say one line right now that is "
                  "clearly useful for what {user_title} is doing? Useful means pointing out where they may be stuck, "
                  "reminding them of a related next step, or suggesting another approach. Small talk, reporting how long "
                  "they stayed or generic encouragement does not count as useful."}
RESPONSE_WINDOW = 60.0  # seconds after a proactive line ends in which a /say answers it
SUBJECT_MEMORY = 20  # comments whose subjects are not commented again
ENDED = {"done": "finished", "error": "hit an error"}  # registry outcome kinds a back report names
WAITING = {"awaiting_approval": "waiting for approval", "awaiting_input": "waiting for a reply"}
BREAK_INPUT = 20  # keys_60s + 6 x clicks_10s a beat needs for a break line
BEFORE_AWAY = 600  # away seconds after which a back line may name only what came before
BEFORE_FRESH = 600  # seconds before leaving that before_away may have been last in effect
STUCK_FOR = 120  # seconds the scene must stay stuck before the user is asked
STUCK_MEMORY = 20  # blockers that are not asked about again
STUCK_RETRY = 60  # seconds after a refused stuck line before the next try
# A task the interpreter reported blocked counts as stuck once WORK_RUNS analyses (the reporting one included) found
# it blocked or WORK_BLOCKED_FOR seconds passed; WORK_FRESH seconds after the last such analysis it is let go.
WORK_RUNS = 2
WORK_BLOCKED_FOR = 180
WORK_FRESH = 600
WAITED = ("waiting", "blocked")  # interpreter task states whose result_observed the user was waiting for
WANT_RESULT = {"id": "want_comment", "type": "yes_no",
               "text": "Something {user_title} was waiting for just got a result; is it a good moment for the desktop "
                       "character to say a line on its own? From the given hour and activity, weigh the cost of "
                       "interrupting against the value of speaking: interrupting costs a lot during focused typing, a "
                       "meeting, watching video or a late-night push; with the result just in, a line that is glad for "
                       "them or mentions the next step in passing has value. Answer yes when the value is greater, else no."}
MUTABLE = ("comment", "back", "break", "water", "stuck", "thought", "session", "task", "repeat")  # gate categories the user may mute; thought: character.thoughts
LINE_KINDS = 64  # started lines whose category a later /feedback mute can find
LESS_STEP, LESS_MAX = 1.5, 4  # each 少说点 multiplies the shared line and thought factor by LESS_STEP, up to LESS_MAX
# A line's "why now" text, shown with it, by reply language code; "harness" (None) takes the Chinese one.
REASONS = {"zh-Hans": {"back": "你离开了 {minutes} 分钟，刚回来", "break": "你已经连续用电脑 {minutes} 分钟",
                       "water": "可以喝口水", "stuck": "你像是卡在一个问题上 {minutes} 分钟了",
                       "result": "你等的一件事有结果了", "long_dwell": "你在这个窗口停了 {minutes} 分钟"},
           "en": {"back": "You were away for {minutes} min and just came back",
                  "break": "You have been at the computer for {minutes} min straight", "water": "Time for some water",
                  "stuck": "You seem to have been stuck on a problem for {minutes} min",
                  "result": "Something you were waiting for has a result",
                  "long_dwell": "You have been in this window for {minutes} min"},
           "ja": {"back": "{minutes} 分離れていて、戻ってきたところ", "break": "もう {minutes} 分続けてパソコンを使っている",
                  "water": "そろそろ水を一口", "stuck": "{minutes} 分ほど問題で手が止まっているみたい",
                  "result": "待っていたことに結果が出た", "long_dwell": "このウィンドウに {minutes} 分いる"}}


def _thread(fn):
    threading.Thread(target=fn, daemon=True).start()


def _care(scene):
    """May a care line (back, break, water) be said over scene: an app the rules do not recognise holds none."""
    return scene is None or scene["can_interrupt"] or scene["activity"] == "unknown" and not scene["holds"]


def _version(scene):
    return None if scene is None else (scene["activity"], scene["subject"], scene["focus_id"])


class Proactive:
    def __init__(self, store, gate, publish, start_line, busy, judge=None, clock=time.time, spawn=_thread,
                 activity=None, claim=None, sessions=None, break_minutes=0, water_minutes=0, deliver="speak",
                 on_pending=None, on_clear=None, log=None, user=lambda: PROMPT_USER, language=lambda: None,
                 absence=lambda: None):
        """publish(event, data) -> /feed; start_line(line_id, text, reason=, material=) runs a mouth line, material
        (observed text or None) going to its live context only; busy() -> a line or speech is in progress; judge
        None turns comments off. activity() -> activity.assemble's result or None; claim(line_id, text, recheck,
        reason, material=) -> True when it started the line on an idle mouth, used instead of busy() and
        start_line when given; recheck() -> may the line still be voiced. Whoever runs the line calls
        gate.commit("comment") and voiced() once it is voiced. sessions() -> Registry.snapshot(); None turns
        back reports off. break_minutes: active minutes before a break line; 0 turns it off.
        deliver "tap": a due break, and every water_minutes of active time a water reminder, go to
        on_pending(kind, data) to wait for a tap on the character instead of being said; on_clear("break") once
        the break clock restarts. In "speak" mode water waits for a quiet moment. water_minutes 0 turns it off.
        log: the ProactiveLog
        unanswered lines are marked ignored in and the 少说点 factor is kept in; None keeps neither.
        user() -> the shown character's user_title, which the lines and judge questions name the user by.
        language() -> the reply language code, None under "harness"; the lines' reason texts are in it.
        absence() -> user_now's open absence or None: the break and water clocks stand still through it and start
        over at its return (back)."""
        self.store, self.gate, self.publish, self.start_line, self.busy = store, gate, publish, start_line, busy
        self.user, self.language, self.absence = user, language, absence
        self.judge, self.clock, self.spawn = judge, clock, spawn
        self.activity, self.claim, self.sessions = activity, claim, sessions
        self._back = None  # line_id of the last started back report; voiced() starts the back cooldown
        self.break_minutes, self.water_minutes = break_minutes, water_minutes
        self.deliver, self.on_pending, self.on_clear = deliver, on_pending, on_clear
        self._water_s = 0.0  # active seconds since the last water reminder
        self._water_beat = None  # clock time of the last active heartbeat; None after an inactive one
        self._water_retry_at = 0.0
        self._water_line = None
        self._break_line = None  # line_id of the last started break line; voiced() starts the break cooldown
        self._break_retry_at = 0.0
        self._active_since = None  # clock time the user's present run began; None while away
        self._break_due = None  # clock time the next break line is due
        self._stuck_line = None  # line_id of the last started stuck line; voiced() starts the stuck cooldown
        self._stuck_since = None  # clock time the scene became stuck on _stuck_key; None while it is not
        self._stuck_key = None  # (thread, blocker without digits) of the present stuck run
        self._stuck_retry_at = None  # clock time a refused stuck line may be tried again
        self._stuck_asked = collections.deque(maxlen=STUCK_MEMORY)  # (thread, blocker without digits) asked about
        self._work_states = {}  # task_key -> state in the interpreter's last analysis
        self._work_blocked = {}  # task_key -> {"title", "summary", "since", "runs", "seen"} reported blocked
        gate.cooldown.update({"break": break_minutes * 60, "water": water_minutes * 60})
        self._lock = threading.Lock()
        self._rest_lock = threading.Lock()  # the break and water clocks and their minutes
        self._alerted = {}  # window_id -> clock time of its last alert
        self._asked = None  # start of the focus run the judge was asked about
        self._held_dwell = None  # (focus start, local hold reason), suppress repeated skip notices
        self._present = False  # the last heartbeat had input within UNKNOWN_IDLE seconds
        self._subjects = collections.deque(maxlen=SUBJECT_MEMORY)
        self._judge_lines = collections.OrderedDict()  # bounded local line -> judge id for explicit feedback
        self._line_kinds = collections.OrderedDict()  # line_id -> gate category of the last LINE_KINDS started lines
        self._pending = None  # (line_id, subject) of the last started comment; voiced() takes its subject
        self.misses = 0  # proactive lines in a row that got no answer
        self._open = None  # [line_id, clock time its speech ended or None] of a voiced line not yet settled
        self.log = log
        if log is not None:
            self._scale()

    @property
    def factor(self):
        """The comment cooldown's multiplier."""
        return min(4, 2 ** (self.misses // 3))

    def voiced(self, line_id):
        """A proactive line was voiced; the one before it, still unanswered, is a miss. True when it was a back or
        break line, which Proactive commits itself."""
        with self._lock:
            if self._open is not None:
                self._missed()
            self._open = [line_id, None]
            if self._pending is not None and self._pending[0] == line_id:
                self._subjects.append(self._pending[1])
                self._pending = None
            if self._back == line_id:
                self._back = None
                self.gate.commit("back")
                return True
            if self._break_line == line_id:
                self._break_line = None
                self.gate.commit("break")
                return True
            if self._water_line == line_id:
                self._water_line = None
                self.gate.commit("water")
                return True
            if self._stuck_line == line_id:
                self._stuck_line = None
                self.gate.commit("stuck")
                return True
            return False

    def said(self, reply_to=None):
        """A /say arrived: it answers the open line only when reply_to names it."""
        with self._lock:
            self._close()
            if self._open is not None and reply_to == {"kind": "line", "id": self._open[0]}:
                self._answered(self._open[0])

    def feedback(self, line_id, value, mute=False, channel="line"):
        """useful answers line_id; less settles it without a miss; dont_disturb and dismissed settle it as a miss
        when it is the open line, and dont_disturb with mute turns its category off in the gate. useful and less, on
        a line or a thought (channel "thought", which touches no line), divide or multiply the 少说点 factor."""
        with self._lock:
            self._close()
            if self.log is not None and value in ("useful", "less"):
                less = self.log.less()
                self.log.set_less(min(LESS_MAX, less * LESS_STEP) if value == "less" else max(1, less / LESS_STEP))
            if channel == "line" and value == "useful":
                self._answered(line_id)
            elif channel == "line" and self._open is not None and self._open[0] == line_id:
                if value == "less":
                    self._open = None
                else:
                    self._missed()
            self._scale()
            if mute and value == "dont_disturb" and line_id in self._line_kinds:
                self.gate.set_muted(self.gate.muted | {self._line_kinds[line_id]})
            judge_id = self._judge_lines.pop(line_id, None) if value in ("useful", "dont_disturb") else None
        if judge_id is not None and value in ("useful", "dont_disturb"):
            try:
                self.judge.feedback(judge_id, value, source="user")
            except Exception:  # diagnostics must not affect the user's control
                pass

    def reset_feedback(self):
        with self._lock:
            self._judge_lines.clear()
            self._line_kinds.clear()
            self._pending = self._open = None
            self._subjects.clear()

    def reset(self):
        """POST /reset and a consent revocation: the interpreter's work and the stuck run, window-derived, go."""
        with self._lock:
            self._work_states, self._work_blocked = {}, {}
            self._stuck_since = self._stuck_key = self._stuck_retry_at = None
            self._stuck_asked.clear()

    def _close(self):
        """The open line is a miss once RESPONSE_WINDOW has passed since its speech ended."""
        if self._open is None:
            return
        now = self.clock()
        if self._open[1] is None:
            if not self.busy():
                self._open[1] = now
        elif now - self._open[1] > RESPONSE_WINDOW:
            if self.log is not None:
                self.log.ignore(self._open[0], now)
            self._missed()

    def _missed(self):
        self.misses, self._open = self.misses + 1, None
        self._scale()

    def _answered(self, line_id):
        if self._open is not None and self._open[0] == line_id:
            self._open = None
        self.misses = 0
        self._scale()

    def _scale(self):
        self.gate.scale["comment"] = self.factor * (self.log.less() if self.log is not None else 1)

    def beat(self, body):
        """Called after each heartbeat is stored."""
        with self._lock:
            self._close()
        self._alert(body)
        with self._rest_lock:
            self._break(body)
            self._water(body)
        self._stuck()
        if self.judge is not None:
            self._dwell(body)

    def back(self, away_s):
        """The user is back after away_s seconds: one line naming the sessions that ended, failed or began to
        wait meanwhile, by name and state only, then the scene's before_away when it was in effect up to
        BEFORE_FRESH seconds before leaving; without such sessions, before_away alone after BEFORE_AWAY seconds away,
        else silent. The break and water clocks skip the absence even when no beat saw it open."""
        if self.break_minutes:
            self._break_reset()
        self._water_beat = None
        if self.sessions is None:
            return
        now = self.clock()
        since = now - away_s
        snapshot = self.sessions()
        names = {s["display_session"]: os.path.basename(s["cwd"] or "") or s["display_session"]
                 for s in snapshot["sessions"]}
        news = {o["display_session"]: ENDED[o["kind"]] for o in snapshot["outcomes"]
                if o["kind"] in ENDED and o["ts"] >= since}
        news.update({s["display_session"]: own_app_wait(s) or WAITING[s["effective_state"]] for s in snapshot["sessions"]
                     if s["effective_state"] in WAITING and s["since"] >= since})
        scene = self._scene()
        before = scene and scene.get("before_away")
        if before is not None and before["ts"] < since - BEFORE_FRESH:
            before = None
        key = secrets.token_hex(6)
        if not news and (before is None or away_s < BEFORE_AWAY):
            self.gate.report("back", LEVEL, "short_away" if away_s < BEFORE_AWAY else "no_before_away", key)
            return
        # Observed text goes in material, the line's live context, never in its text, which history keeps.
        material = before and "; ".join(([f"Doing before leaving: {before['thread']}"] if before["thread"] else [])
                                        + ([f"stuck on \"{before['blocker']}\""] if before["blocker"] else [])) or None
        user = self.user()
        was = before and (f"Before leaving, {user} was {MODE_NAMES[before['mode']]}"
                          + (". What exactly they were doing before leaving is in the live material" if material else ""))
        head = f"{user} was away for {round(away_s / 60)} minutes and just came back to the computer."
        if not news:
            text = cue("back", f"{head} {was}.",
                       "Welcome them back in one sentence; you may pick up what they were doing before leaving in "
                       "passing, like \"you were just…\", to help them get their train of thought back; do not ask "
                       "where they went or say how long they were away.")
        else:
            report = "; ".join(f"{names.get(session, session)} {state}" for session, state in news.items())
            text = (cue("back", f"{head} While away: {report}. {was}.",
                        "Welcome them back in one short sentence: first the names and states of these sessions, then a "
                        "few words on what they were doing before leaving; like a message handed over in passing, not "
                        "a list read out.") if before else
                    cue("back", f"{head} While away: {report}.",
                        "Welcome them back in one short sentence, giving only the names and states of these sessions, "
                        "like a message handed over in passing."))
        line_reason = {"code": "back", "kind": "back", "text": self._reason("back", minutes=round(away_s / 60)),
                       "away_min": round(away_s / 60), "before": before is not None}

        def recheck():
            return _care(self._scene()) and self.gate.check("back") is None

        if not _care(scene):
            speak, reason = False, "cannot_interrupt"
        elif self.claim is None and self.busy():
            speak, reason = False, "busy"
        else:
            speak, reason = self.gate.admit("back", LEVEL, datetime.datetime.fromtimestamp(now), key=key,
                                            commit=False)
        if reason in ("cannot_interrupt", "busy"):
            self.gate.report("back", LEVEL, reason, key)
        if speak:
            self._back = key  # before the claim: its line may be voiced before claim returns
        if speak and self.claim is not None:
            speak = self.claim(key, text, recheck, line_reason, material=material)
            reason = None if speak else "busy"
        line_id = key if speak else None
        self._nudge("back", None, line_id, speak, reason)
        if speak and self.claim is None:
            self.start_line(line_id, text, reason=line_reason, material=material)

    def _break(self, body):
        """One line naming how long the user has been at the computer, due break_minutes into a present run and
        break_minutes after the last one, voiced or not, on a beat with typing or clicking."""
        if not self.break_minutes:
            return
        now = self.clock()
        if self.absence() is not None:
            self._break_reset()
            return
        if self._active_since is None:
            self._active_since, self._break_due = now, now + self.break_minutes * 60
        counts = body.get("input") or {}
        if now < self._break_due \
                or counts.get("keys_60s", 0) + 6 * counts.get("clicks_10s", 0) < BREAK_INPUT:
            return
        minutes = round((now - self._active_since) / 60)
        if self.deliver == "tap":
            self._break_due = now + self.break_minutes * 60
            self.on_pending("break", {"minutes": minutes})
            return
        if body["idle_s"] < 3 or now < self._break_retry_at:
            return
        self._break_retry_at = now + 30
        user = self.user()
        text = cue("break", f"{user} has been at the computer for {minutes} minutes straight.",
                   "Tell them this length of time in one caring sentence, like someone nearby mentioning it in "
                   "passing, not announcing the time; do not push, do not lecture.")
        line_reason = {"code": "break", "kind": "break", "text": self._reason("break", minutes=minutes),
                       "minutes": minutes}
        if self._offer_rest(now, text, line_reason):
            self._break_due = now + self.break_minutes * 60

    def _offer_rest(self, now, text, line_reason):
        key = secrets.token_hex(6)
        scene = self._scene()
        kind = line_reason["kind"]

        def recheck():
            return _care(self._scene()) and self.gate.check(
                kind, datetime.datetime.fromtimestamp(self.clock())) is None

        if not _care(scene):
            speak, reason = False, "cannot_interrupt"
        elif self.claim is None and self.busy():
            speak, reason = False, "busy"
        else:
            speak, reason = self.gate.admit(kind, LEVEL, datetime.datetime.fromtimestamp(now), key=key,
                                            commit=False)
        if speak:
            if kind == "break":
                self._break_line = key
            else:
                self._water_line = key
        if speak and self.claim is not None:
            speak = self.claim(key, text, recheck, line_reason)
            reason = None if speak else "busy"
        line_id = key if speak else None
        self._nudge(kind, None, line_id, speak, reason)
        if speak and self.claim is None:
            self.start_line(line_id, text, reason=line_reason)
        return speak

    def _break_reset(self):
        """The user was away: the break clock starts over, and a pending break reminder has been taken."""
        self._active_since = self._break_due = None
        self._break_retry_at = 0.0
        if self.deliver == "tap":
            self.on_clear("break")

    def _water(self, body):
        """Active time between heartbeats adds up, across absences, to a water reminder every water_minutes."""
        if not self.water_minutes:
            return
        now = self.clock()
        if self.absence() is not None:
            self._water_beat = None
            return
        if self._water_beat is not None:
            self._water_s += now - self._water_beat
        self._water_beat = now
        if self._water_s < self.water_minutes * 60:
            return
        if self.deliver == "tap":
            self._water_s = 0.0
            self.on_pending("water", {"minutes": self.water_minutes})
            return
        # Wait for a short pause in input and try at most once per cooldown interval.
        if body["idle_s"] < 3 or now < self._water_retry_at:
            return
        self._water_retry_at = now + 30
        user = self.user()
        text = cue("water", f"{user} has been sitting for quite a while, and you remember it is time they had some "
                            "water.",
                   "Gently remind them to drink water in one sentence, like a passing word of care; do not give the "
                   "time, do not ask questions.")
        if self._offer_rest(now, text, {"code": "water", "kind": "water", "text": self._reason("water")}):
            self._water_s = 0.0

    def _stuck(self):
        """One line asking whether to help, once per blocker, at a pause after the scene has been stuck for
        STUCK_FOR seconds; while the scene is not stuck, once per task the interpreter keeps finding blocked
        (_work_stuck), its work event the line's material. Such a task may also be asked about at an app the
        rules do not recognise."""
        if self.gate.check("stuck", datetime.datetime.fromtimestamp(self.clock())) == "companion_off":
            return
        scene = self._scene()
        now = self.clock()
        work = None
        if scene is not None and scene.get("state") == "stuck":
            thread, blocker = scene.get("thread"), scene.get("blocker")
            asked = (thread, re.sub(r"\d", "", blocker) if blocker else None)
            if asked != self._stuck_key:  # a new blocker is stuck on from now
                self._stuck_since, self._stuck_key = now, asked
            since = self._stuck_since
            if now - since < STUCK_FOR:
                return
        else:
            self._stuck_since = self._stuck_key = None
            work = None if scene is None else self._work_stuck(now)
            if work is None:
                return
            asked, since = ("work", work["task_key"]), work["since"]
        if self.gate.typing or asked in self._stuck_asked \
                or self._stuck_retry_at is not None and now < self._stuck_retry_at:
            return
        key = secrets.token_hex(6)
        # thread and blocker reach the model through the scene in the line's live context, as consent allows.
        user = self.user()
        text = cue("stuck", f"{user} seems to have been stuck on a problem for a while; where is in the live material.",
                   "In one short sentence, gently ask whether they want you to help take a look; you may name the "
                   "sticking point from the material in a few words so they know what you are looking at; do not "
                   "guess the cause, do not lecture, do not push.")
        material = work and f"What continuous observation saw them stuck on: {work['title']} — {work['summary']}"
        minutes = round((now - since) / 60)
        line_reason = {"code": "stuck", "kind": "stuck", "text": self._reason("stuck", minutes=minutes),
                       "minutes": minutes}

        def interruptible(now_scene):
            return now_scene["can_interrupt"] or work is not None and self._unknown(now_scene)

        def recheck():
            now_scene = self._scene()
            return (now_scene is None or interruptible(now_scene)) and self.gate.check("stuck") is None

        if not interruptible(scene):
            speak, reason = False, "cannot_interrupt"
        elif self.claim is None and self.busy():
            speak, reason = False, "busy"
        else:
            speak, reason = self.gate.admit("stuck", LEVEL, datetime.datetime.fromtimestamp(now), key=key,
                                            commit=False)
        if speak:
            self._stuck_line = key  # before the claim: its line may be voiced before claim returns
        if speak and self.claim is not None:
            speak = self.claim(key, text, recheck, line_reason, material=material)
            reason = None if speak else "busy"
        line_id = key if speak else None
        self._nudge("stuck", None, line_id, speak, reason)
        self._stuck_retry_at = None if speak else now + STUCK_RETRY
        if speak:
            self._stuck_asked.append(asked)
        if speak and self.claim is None:
            self.start_line(line_id, text, reason=line_reason, material=material)

    def interpreted(self, body):
        """A committed analysis of the continuous interpreter. Its blocked work events are kept for _stuck while
        later analyses do not find the task otherwise; a result_observed event of a task the last analysis saw in a
        WAITED state may start a comment (_result). A backlog batch, whose newest observation is older than
        INTERPRETED_FRESH, adds neither."""
        now = self.clock()
        tasks = {t["task_key"]: t["state"] for t in body["task_updates"]}
        current = now - (body["batch"].get("newest_observed_at") or 0) <= INTERPRETED_FRESH
        finished = None
        with self._lock:
            known, self._work_states = self._work_states, tasks
            for key, work in list(self._work_blocked.items()):
                if tasks.get(key, "blocked") != "blocked" or now - work["seen"] > WORK_FRESH:
                    del self._work_blocked[key]
                elif key in tasks:
                    work["runs"], work["seen"] = work["runs"] + 1, now
            for event in body["work_events"] if current else ():
                key = event["task_key"]
                if event["state"] == "blocked":
                    self._work_blocked.setdefault(key, {"title": event["title"], "summary": event["summary"],
                                                        "since": now, "runs": 1, "seen": now})
                    continue
                self._work_blocked.pop(key, None)
                if event["state"] == "result_observed" and known.get(key) in WAITED:
                    finished = event
        if finished is not None and self.judge is not None:
            self.spawn(lambda: self._result(finished))

    def _work_stuck(self, now):
        """{"task_key", "title", "summary", "since", ...} of the first task the interpreter reported blocked that
        counts as stuck, was found blocked within WORK_FRESH seconds and was not asked about, or None."""
        with self._lock:
            return next((dict(work, task_key=key) for key, work in self._work_blocked.items()
                         if (work["runs"] >= WORK_RUNS or now - work["since"] >= WORK_BLOCKED_FOR)
                         and now - work["seen"] <= WORK_FRESH and ("work", key) not in self._stuck_asked), None)

    def _result(self, event):
        """One comment on a result that ended a task the user waited for, when the comment judge and gate let it.
        Only the trigger, the hour and the activity label reach the judge; the event goes in the line's material."""
        now = self.clock()
        key = secrets.token_hex(6)
        scene = self._scene()
        if scene is not None and not scene["can_interrupt"] and not self._unknown(scene):
            reason = "cannot_interrupt"
        elif self.claim is None and self.busy():
            reason = "busy"
        else:
            reason = self.gate.check("comment", datetime.datetime.fromtimestamp(now))
        if reason == "companion_off":
            return
        if reason is not None:
            self._nudge("comment", None, None, False, reason)
            return
        state = {"trigger": "result_observed", "hour": datetime.datetime.fromtimestamp(now).hour,
                 "activity": scene and scene["activity"]}
        judged = self.judge.ask(state, self._questions(WANT_RESULT, USEFUL), key=key,
                                valid=lambda: not (self.gate.user_speaking or self.gate.meeting or self.gate.fullscreen))
        if judged is None:
            return
        if self.gate.check("comment", datetime.datetime.fromtimestamp(self.clock())) == "companion_off":
            return
        answers = {a["id"]: a["value"] for a in judged["answers"]}
        if answers[WANT_RESULT["id"]] is not True:
            return

        def recheck():
            now_scene = self._scene()
            return (now_scene is None or now_scene["can_interrupt"] or self._unknown(now_scene)) \
                and self.gate.check("comment") is None

        user = self.user()
        text = cue("result", f"Something {user} was waiting for just got a result; what it is is in the live material.",
                   "In one short sentence be glad for them, or mention in passing what they could do next; name only "
                   "that thing from the material, do not retell it, do not take credit.")
        material = f"Result continuous observation saw: {event['title']} — {event['summary']}"
        line_reason = {"code": "result", "kind": "comment", "text": self._reason("result")}
        speak = False
        if answers[USEFUL["id"]] is not True:
            reason = "not_useful"
        elif self.gate.user_speaking:
            reason = "user_speaking"
        elif self.claim is None and self.busy():
            reason = "busy"
        else:
            speak, reason = self.gate.admit("comment", LEVEL, datetime.datetime.fromtimestamp(now), key=key,
                                            commit=False)
        if speak:
            with self._lock:
                self._judge_lines[key] = judged["judge_id"]
                while len(self._judge_lines) > 64:
                    self._judge_lines.popitem(last=False)
        if speak and self.claim is not None:
            speak = self.claim(key, text, recheck, line_reason, material=material)
            reason = None if speak else "busy"
        line_id = key if speak else None
        self._nudge("comment", None, line_id, speak, reason)
        if speak and self.claim is None:
            self.start_line(line_id, text, reason=line_reason, material=material)

    def _alert(self, body):
        window = body.get("focus_window") or {}
        if window.get("role") not in DIALOG_ROLES and window.get("subrole") not in DIALOG_SUBROLES:
            return
        window_id = self.store.blacklist.scrub(body["front"]).get("window_id")
        if not isinstance(window_id, int) or isinstance(window_id, bool):
            return
        now = self.clock()
        with self._lock:
            self._alerted = {w: t for w, t in self._alerted.items() if now - t < ALERT_EVERY}
            if window_id in self._alerted:
                return
            self._alerted[window_id] = now
        self._nudge("alert", window_id, None, False, None)

    def _unknown(self, scene):
        """An app the rules do not recognise, with nothing else holding, while the user is present at it: the
        judge alone decides a comment there."""
        return scene is not None and scene["activity"] == "unknown" and not scene["holds"] and self._present

    def _comment_hold(self, scene, now):
        """Cheap local eligibility before any model call; never commits the speech budget."""
        if scene is not None and not scene["can_interrupt"] and not self._unknown(scene):
            return "cannot_interrupt"
        subject = scene and (scene["subject"] or scene["focus_id"])
        if subject is not None and subject in self._subjects:
            return "same_subject"
        if self.busy():
            return "busy"
        return self.gate.check("comment", datetime.datetime.fromtimestamp(now))

    def _hold_comment(self, start, data, reason):
        with self._lock:
            if self._held_dwell == (start, reason):
                return
            self._held_dwell = (start, reason)
        self._nudge("comment", data.get("window_id"), None, False, reason)

    def _dwell(self, body):
        self._present = body["idle_s"] < UNKNOWN_IDLE and not body.get("locked") and not body.get("asleep")
        if self.gate.check("comment", datetime.datetime.fromtimestamp(self.clock())) == "companion_off":
            return
        run = self.store.dwell()
        if run is None:
            return
        start, seconds, data = run
        if seconds < DWELL or data.get("app") == HIDDEN["app"]:
            return
        with self._lock:
            if self._asked == start:
                return
        scene = self._scene()
        if seconds < UNKNOWN_DWELL and self._unknown(scene):
            return
        reason = self._comment_hold(scene, self.clock())
        if reason is not None:
            self._hold_comment(start, data, reason)
            return  # A later beat may become eligible without changing focus.
        with self._lock:
            if self._asked == start:
                return
            self._asked, self._held_dwell = start, None
        self.spawn(lambda: self._comment(start, seconds, data))

    def _scene(self):
        return self.activity() if self.activity is not None else None

    def _reason(self, code, **values):
        return REASONS.get(self.language(), REASONS["zh-Hans"])[code].format(**values)

    def _questions(self, *questions):
        """The judge questions with {user_title} filled in."""
        user = self.user()
        return [{**q, "text": q["text"].format(user_title=user)} for q in questions]

    def _comment(self, start, seconds, data):
        now = self.clock()
        if self.gate.check("comment", datetime.datetime.fromtimestamp(now)) == "companion_off":
            return
        key = secrets.token_hex(6)  # the judge, the gate and the line they start share one trace
        scene = self._scene()
        run = self.store.dwell()
        if run is None or run[0] != start:
            return
        reason = self._comment_hold(scene, now)
        if reason is not None:
            with self._lock:
                if self._asked == start:
                    self._asked = None
            self._hold_comment(start, data, reason)
            return
        asked = _version(scene)
        # Only the app category, minutes, hour, activity label and action kinds reach the judge, never a title or target.
        current = scene and scene["now"]
        done = [a for a in current["actions"] if a["app"] == current["app"] and a["ts"] >= current["since"]] \
            if current and current["app"] else []
        state = {"category": category({**data, "category": self.store.app_category(data)}),
                 "dwell_min": round(seconds / 60),
                 "hour": datetime.datetime.fromtimestamp(now).hour, "activity": scene and scene["activity"],
                 "actions": [a["kind"] for a in done], "idle_s": round(now - done[-1]["ts"]) if done else None}
        def still_current():
            run = self.store.dwell()
            return run is not None and run[0] == start and not (self.gate.user_speaking or self.gate.meeting or self.gate.fullscreen)
        judged = self.judge.ask(state, self._questions(WANT_COMMENT, USEFUL), key=key, valid=still_current)
        if judged is None:
            return
        if self.gate.check("comment", datetime.datetime.fromtimestamp(self.clock())) == "companion_off":
            return
        answers = {a["id"]: a["value"] for a in judged["answers"]}
        if answers[WANT_COMMENT["id"]] is not True:
            return

        def same_run():
            run = self.store.dwell()
            return run is not None and run[0] == start

        def recheck():
            """Before the line's first clause is voiced."""
            now_scene = self._scene()
            return (same_run() and _version(now_scene) == asked
                    and (now_scene is None or now_scene["can_interrupt"] or self._unknown(now_scene))
                    and self.gate.check("comment") is None)

        scene = self._scene()
        subject = scene and (scene["subject"] or scene["focus_id"])
        user = self.user()
        text = cue("long_dwell", f"{user} has stayed in the same window for {state['dwell_min']} minutes, activity: "
                                 f"{CATEGORY_NAMES[state['category']]}.",
                   "You want to speak up on your own: pick one concrete thing from the live material tied to what they "
                   "are doing right now and say it; one short sentence is enough; do not say how long they have "
                   "stayed.")
        line_reason = {"code": "long_dwell", "kind": "comment",
                       "text": self._reason("long_dwell", minutes=state["dwell_min"]),
                       "activity": state["activity"], "dwell_min": state["dwell_min"]}
        speak, reason = False, None
        if answers[USEFUL["id"]] is not True:
            reason = "not_useful"
        elif not same_run():
            reason = "focus_changed"
        elif self.gate.user_speaking:
            reason = "user_speaking"
        elif _version(scene) != asked:
            reason = "activity_changed"
        elif scene is not None and not scene["can_interrupt"] and not self._unknown(scene):
            reason = "cannot_interrupt"
        elif subject is not None and subject in self._subjects:
            reason = "same_subject"
        elif self.claim is None and self.busy():
            reason = "busy"
        else:
            # Counted only once the line is voiced: a refused, failed or cancelled line takes nothing.
            speak, reason = self.gate.admit("comment", LEVEL, datetime.datetime.fromtimestamp(now), key=key,
                                            commit=False)
        if speak:
            with self._lock:
                self._judge_lines[key] = judged["judge_id"]
                while len(self._judge_lines) > 64:
                    self._judge_lines.popitem(last=False)
        if speak and subject is not None:
            self._pending = (key, subject)  # before the claim: its line may be voiced before claim returns
        if speak and self.claim is not None:
            speak = self.claim(key, text, recheck, line_reason)
            reason = None if speak else "busy"
        line_id = key if speak else None
        self._nudge("comment", data.get("window_id"), line_id, speak, reason)
        if speak and self.claim is None:
            self.start_line(line_id, text, reason=line_reason)

    def _nudge(self, kind, target, line_id, speak, reason):
        if line_id is not None:
            with self._lock:
                self._line_kinds[line_id] = kind
                while len(self._line_kinds) > LINE_KINDS:
                    self._line_kinds.popitem(last=False)
        self.publish("nudge", {"nudge_id": secrets.token_hex(6), "kind": kind, "level": LEVEL, "target": target,
                               "line_id": line_id, "speak": speak, "gate": reason})
