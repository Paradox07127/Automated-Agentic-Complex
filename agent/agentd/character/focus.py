"""The focus session the user starts (「陪我专注 25 分钟」): while it runs the gate lets only P0 and P1 through and she
works; at its end she suggests a break with a recap of counts only. A restart inside its window keeps it."""
import threading
import time

from character.behavior import CATEGORY_NAMES
from fsutil import atomic_write_json, read_json

MINUTES = range(5, 121)
COUNTS = ("sessions", "approvals", "reminders")
# The recap's words by reply language code; "harness" (None) takes the Chinese ones.
RECAP = {"zh-Hans": {"sessions": "完成了 {} 个 agent 会话", "approvals": "处理了 {} 张审批", "reminders": "送达了 {} 条提醒",
                     "app": "{} {} 分钟", "and": "，", "then": "；", "apps": "、", "done": "：{}",
                     "line": "这次专注了 {ran} 分钟{done}。休息 5 分钟？",
                     "names": {"coding": "写代码", "terminal": "终端", "browsing": "浏览网页", "assistant": "用 AI 助手",
                               "files": "整理文件", "reading": "看文档", "writing": "写东西", "canvas": "使用画布",
                               "meeting": "开会", "remote_desktop": "使用远程桌面"}},
         "en": {"sessions": "agent sessions done: {}", "approvals": "approvals handled: {}",
                "reminders": "reminders delivered: {}", "app": "{} {} min", "and": ", ", "then": "; ", "apps": ", ",
                "done": ": {}", "line": "Focused for {ran} min{done}. Take a 5-minute break?", "names": CATEGORY_NAMES},
         "ja": {"sessions": "agent セッション {} 件完了", "approvals": "承認 {} 件処理", "reminders": "リマインド {} 件送信",
                "app": "{} {} 分", "and": "、", "then": "；", "apps": "、", "done": "：{}",
                "line": "今回は {ran} 分集中したね{done}。5 分休憩する？",
                "names": {"coding": "コーディング", "terminal": "ターミナル", "browsing": "ウェブ閲覧",
                          "assistant": "AI アシスタント", "files": "ファイル整理", "reading": "ドキュメント閲覧",
                          "writing": "執筆", "canvas": "キャンバス", "meeting": "会議", "remote_desktop": "リモートデスクトップ"}}}
BEAT_GAP = 5.0  # seconds; a longer gap between two active heartbeats counts toward no category
SAVE_BEATS = 60.0  # seconds between saves of the category minutes alone
CATEGORIES_SHOWN = 3
UNSHOWN = {"other", "media", "game"}  # the recap names no leisure minutes: no guilt cue


class Focus:
    def __init__(self, path=None, clock=time.time, language=lambda: None):
        """path: the state dir's file the running session is kept in; None keeps it in memory only.
        language() -> the reply language code the recap is written in, None under "harness"."""
        self.path, self.clock, self.language = path, clock, language
        self.lock = threading.Lock()
        self.session = None  # {start, end, minutes, started_by, counts, categories: {category: seconds}}
        self._beat = None  # (ts, category) of the last active heartbeat
        self._saved_at = None
        try:
            saved = read_json(path) if path is not None else None
        except (OSError, ValueError):
            saved = None
        if isinstance(saved, dict) and isinstance(saved.get("end"), (int, float)) and self.clock() < saved["end"]:
            self.session = saved

    def running(self):
        return self.session is not None

    def start(self, minutes, started_by="user"):
        """The new session's public(); ValueError invalid_minutes or focus_running."""
        if type(minutes) is not int or minutes not in MINUTES:
            raise ValueError("invalid_minutes")
        with self.lock:
            if self.session is not None:
                raise ValueError("focus_running")
            now = self.clock()
            self.session = {"start": now, "end": now + minutes * 60, "minutes": minutes, "started_by": started_by,
                            "counts": dict.fromkeys(COUNTS, 0), "categories": {}}
            self._beat = None
            self._save()
            return self.public()

    def stop(self):
        """Ends the session now: the ended session with end set to now, or None when none runs."""
        with self.lock:
            return self._end(self.clock())

    def due(self):
        """The ended session once its time is up, else None."""
        with self.lock:
            if self.session is None or self.clock() < self.session["end"]:
                return None
            return self._end(self.session["end"])

    def count(self, kind, n=1):
        with self.lock:
            if self.session is not None:
                self.session["counts"][kind] += n
                self._save()

    def beat(self, category, ts, active):
        """A heartbeat taken while observation is on: the time since the last active one goes to that one's category."""
        with self.lock:
            if self.session is None:
                return
            last, self._beat = self._beat, (ts, category) if active else None
            if last is not None and 0 < ts - last[0] <= BEAT_GAP:
                categories = self.session["categories"]
                categories[last[1]] = categories.get(last[1], 0.0) + ts - last[0]
                if self._saved_at is None or ts - self._saved_at >= SAVE_BEATS:
                    self._saved_at = ts
                    self._save()

    def public(self):
        """GET /focus: {started_at, until, minutes, started_by}, or None."""
        session = self.session
        return None if session is None else {"started_at": session["start"], "until": session["end"],
                                             "minutes": session["minutes"], "started_by": session["started_by"]}

    def presence(self):
        """/desktop/presence: {until, minutes}, or None."""
        session = self.session
        return None if session is None else {"until": session["end"], "minutes": session["minutes"]}

    def recap(self, session):
        """focus_done's headline: how long it ran, what got done and app-category minutes, then a break."""
        words = RECAP.get(self.language(), RECAP["zh-Hans"])
        parts = [words[kind].format(session["counts"][kind]) for kind in COUNTS if session["counts"][kind]]
        minutes = sorted(((round(s / 60), c) for c, s in session["categories"].items() if c not in UNSHOWN),
                         key=lambda row: -row[0])
        apps = words["apps"].join(words["app"].format(words["names"][c], m)
                                  for m, c in minutes[:CATEGORIES_SHOWN] if m >= 1)
        done = words["and"].join(parts) + (words["then"] if parts and apps else "") + apps
        ran = round((session["end"] - session["start"]) / 60)
        return words["line"].format(ran=ran, done=words["done"].format(done) if done else "")

    def _end(self, end):
        session, self.session, self._beat = self.session, None, None
        if session is None:
            return None
        if self.path is not None:
            self.path.unlink(missing_ok=True)
        return {**session, "end": end}

    def _save(self):
        if self.path is not None:
            atomic_write_json(self.path, self.session)
