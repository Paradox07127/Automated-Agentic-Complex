"""When agentd asks the shell for a window's text, a local OCR or an image, inside hard budgets.

This manager keeps window text and images in memory; on_image hands images to continuous observation,
which stores them with the text in tiers: screenshots 2 h, text 24 h, then only hashes and analyses 30 d.
Capture judgment is local; authorized image descriptions use the vision object."""
from collections import deque
import hashlib
import json
import secrets
import threading
import time

from observation.activity import VIDEO_BUNDLES
from character.behavior import category
from observation.blacklist import HIDDEN
from character.judge import Judge, RulesBackend
from infra.store import rewrite_jsonl

MIN_INTERVAL = 30.0
PER_HOUR = 20
PER_DAY = 200
AX_MIN = 200  # AX text shorter than this (chars) asks the shell for a local OCR
IMAGE_MIN = 200  # both AX and OCR must be below this many readable characters
OCR_TTL = 3.0  # seconds an OCR result may take
IMAGE_TTL = 60.0  # seconds an image request stays open
WINDOW_TEXT_MAX = 2_000_000  # transport pages bound requests; source text is never reduced to a prompt preview
WINDOW_TEXT_FRESH = 300.0  # seconds that text stays current
RESULTS_MAX = 32  # observations kept for result() and observation()
FAILURES = {"capture_failed": "failed", "permission_denied": "declined", "window_gone": "unavailable"}
TEXT_FAILURES = {**FAILURES, "ax_unavailable": "unavailable", "ax_empty": "unavailable"}  # of a look_window text request
NEXT_CHECK = {"30s": 30.0, "2min": 120.0, "10min": 600.0, "never": None}
QUESTIONS = [{"id": "need_image", "type": "yes_no", "text": "The window text does not show what this window is doing; is a screenshot needed?"},
             {"id": "next_check", "type": "choice", "options": list(NEXT_CHECK),
              "text": "How long until this window's text should be read again?"}]
RULES = {"need_image": lambda state, q: (state.get("visual", False) or state.get("first_empty", False)
             or state.get("ax_chars", state["text_chars"]) < IMAGE_MIN
             and state.get("ocr_chars", 0) < IMAGE_MIN, 0.6),
         "next_check": lambda state, q: ("10min" if state.get("image_taken") else "2min", 0.5)}


def image_size(data):
    """(media type, width, height) of PNG or baseline/progressive JPEG bytes, or None for anything else."""
    if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        return "image/png", int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if data[:2] != b"\xff\xd8":
        return None
    at = 2
    # Segments up to the first frame header (SOF0 or SOF2): FF marker, big-endian length, payload.
    while at + 4 <= len(data) and data[at] == 0xFF:
        marker, length = data[at + 1], int.from_bytes(data[at + 2:at + 4], "big")
        if marker in (0xC0, 0xC2) and length >= 7 and at + 9 <= len(data):
            return "image/jpeg", int.from_bytes(data[at + 7:at + 9], "big"), int.from_bytes(data[at + 5:at + 7], "big")
        if marker in (0xC0, 0xC2, 0xD9, 0xDA) or length < 2:
            return None
        at += 2 + length
    return None


class Budget:
    """Image uploads: MIN_INTERVAL apart, PER_HOUR per rolling hour, PER_DAY per rolling day.

    With db (the shared store) each request is reserved, then sent or released once; reserved and sent
    ones count, and a restart reloads them. Without db a reservation counts at once and is never given back."""

    def __init__(self, clock=time.time, min_interval=MIN_INTERVAL, per_hour=PER_HOUR, per_day=PER_DAY, db=None, lock=None):
        self.clock, self.min_interval, self.per_hour, self.per_day = clock, min_interval, per_hour, per_day
        self.times = deque()
        self.db = db
        self._lock = (threading.RLock() if db is None else db._idle_lock) if lock is None else lock
        self.held = {}  # with db: request_id -> reserved_at of each reserved or sent request of the last day
        if db is not None:
            now = clock()
            with self._lock:
                # Request ids live only in the process that made them: one still reserved here can never settle.
                db.execute("UPDATE capture_budget SET state = 'released', settled_at = ? WHERE state = 'reserved'",
                           (now,))
                db.commit()
                self.held = dict(db.execute("SELECT request_id, reserved_at FROM capture_budget"
                                            " WHERE state IN ('reserved', 'sent') AND reserved_at > ?"
                                            " ORDER BY reserved_at", (now - 86400,)))

    def check(self, look=False):
        """None when one more upload fits, else the limit's name. look skips interval and hourly cap."""
        now = self.clock()
        if self.db is None:
            while self.times and self.times[0] <= now - 86400:
                self.times.popleft()
            times = self.times
        else:
            with self._lock:
                self.held = {r: t for r, t in self.held.items() if t > now - 86400}
                times = sorted(self.held.values())
        if len(times) >= self.per_day:
            return "daily_cap"
        if look:
            return None
        if times and now - times[-1] < self.min_interval:
            return "min_interval"
        if sum(1 for t in times if t > now - 3600) >= self.per_hour:
            return "hourly_cap"
        return None

    def reserve(self, request_id, look=False):
        now = self.clock()
        if self.db is None:
            self.times.append(now)
            return
        with self._lock:
            self.db.execute("INSERT INTO capture_budget (request_id, state, look, reserved_at)"
                            " VALUES (?, 'reserved', ?, ?)", (request_id, int(look), now))
            self.db.commit()
            self.held[request_id] = now

    def sent(self, request_id):
        """The image went to the model: the reservation is spent for good."""
        self._settle(request_id, "sent")

    def release(self, request_id):
        """The image never went out (failed, refused, expired, cancelled): the reservation is given back."""
        with self._lock:
            if self._settle(request_id, "released"):
                self.held.pop(request_id, None)

    def spend(self):
        """One upload without a request id: reserved and sent at once."""
        request_id = secrets.token_hex(6)
        self.reserve(request_id)
        self.sent(request_id)

    def today(self):
        """Since local midnight: {"used": sent, "reserved": in flight, "released": given back, "limit"}."""
        now = self.clock()
        midnight = time.mktime(time.localtime(now)[:3] + (0, 0, 0, 0, 0, -1))
        if self.db is None:
            return {"used": sum(1 for t in self.times if t >= midnight), "reserved": 0, "released": 0,
                    "limit": self.per_day}
        with self._lock:
            counts = dict(self.db.execute("SELECT state, COUNT(*) FROM capture_budget WHERE reserved_at >= ?"
                                          " GROUP BY state", (midnight,)))
        return {"used": counts.get("sent", 0), "reserved": counts.get("reserved", 0),
                "released": counts.get("released", 0), "limit": self.per_day}

    def _settle(self, request_id, state):
        """reserved -> state; True when it moved. A request already sent or released stays as it is."""
        if self.db is None:
            return False
        with self._lock:
            moved = self.db.execute("UPDATE capture_budget SET state = ?, settled_at = ?"
                                    " WHERE request_id = ? AND state = 'reserved'",
                                    (state, self.clock(), request_id)).rowcount
            self.db.commit()
            return bool(moved)


class CaptureManager:
    def __init__(self, feed, blacklist, focus, log_path, clock=time.time, rules=None, backend=None, vision=None,
                 judge_log=None, budget_db=None, budget_lock=None, spawn=None, share_text=None, app_category=None):
        """focus() returns the scrubbed focus window or None; judgment always uses local rules.
        app_category(window) -> the window's declared app category or None; None takes the focus window's.
        vision.describe(image, user) -> text for PNG or JPEG bytes, or None for no image requests at all;
        user is True for an image the user asked for by look().
        budget_db: the shared store that keeps the image budget across restarts, or None."""
        self.feed, self.blacklist, self.focus, self.log_path, self.clock = feed, blacklist, focus, log_path, clock
        self.spawn, self.app_category = spawn, app_category
        rules = rules or RulesBackend(RULES)
        self.judge = Judge(rules, judge_log, clock=clock)
        self.share_text = backend is not None if share_text is None else bool(share_text)
        self.vision = vision
        self.budget = Budget(clock, db=budget_db, lock=budget_lock)
        self.windows = {}  # window_id -> {"meta", "hash", "ocr_for", "block": None|"secure_input"|"incognito"}
        self.open = {}  # request_id -> (window_id, reason, deadline)
        self.due = None  # (window_id, ts) of the next text request
        self._secure = False  # the last attention heartbeat's secure_input: blocks every window
        self._view = None
        self.observations = {}  # request_id -> one request's record (see _request); leaves pending once
        # +1 when secure input turns on, the blacklist file is reloaded or DELETE /attention runs.
        self.policy_epoch = 0
        self._revision = blacklist.revision
        self.latest = {}  # window_id -> request_id of its newest image request
        self._lock = threading.RLock()
        self._log_pruned_at = self.clock()
        rewrite_jsonl(self.log_path, lambda row: row.get("ts", 0) >= self._log_pruned_at - 7 * 86400)
        self._pending_text_decision = None
        self._focus_decision = None
        self._text_deciding = False
        self.consent = None  # () -> (live permissions, epoch), installed by AgentdServer
        self._consent_scope = None
        self.on_image = None  # authorized raw keyframes go directly to the role observation service

    def _allowed(self, kind):
        if self.consent is None:
            return self.share_text if kind == "window_text" else self.vision is not None
        return self.consent()[0][kind]

    def text(self, body, *, one_shot=False):
        """One POST /context/text body (validated by the server). Returns the response body."""
        window_id = body["window_id"]
        meta = {k: body.get(k) for k in ("window_id", "app", "bundle_id", "title", "url_host")}
        with self._lock:
            self._expire()
            self._sync_policy()
            period = tuple(meta.get(k) for k in ("bundle_id", "title", "url_host"))
            answered = self.observations.get(body.get("request_id"))
            checking = answered is not None and answered["window_id"] == window_id and answered["mode"] == "text" \
                and answered["status"] == "pending" and answered["policy_epoch"] == self.policy_epoch
            if one_shot and not (checking and answered.get("_look_window")):
                return {"accepted": False, "reason": "unknown_request"}
            if body["source"] == "ocr":
                # A rejected OCR must not create the window's state: _blocked needs its "meta".
                known = self.windows.get(window_id, {})
                if answered is None or answered["window_id"] != window_id or answered["mode"] not in ("ocr", "text") \
                        or answered["status"] != "pending" or answered["policy_epoch"] != self.policy_epoch \
                        or answered["_reason"] == "low_ax_text" and (answered.get("_period") != period \
                            or known.get("period") != period or answered.get("_ax_hash") != known.get("ax_hash")):
                    return {"accepted": False, "reason": "stale_ocr"}
                if answered["mode"] == "ocr" and self.clock() - answered["requested_at"] > OCR_TTL:
                    self._settle(answered["request_id"], "expired")
                    return {"accepted": False, "reason": "stale_ocr"}
            state = self.windows.setdefault(window_id, {"hash": None, "ocr_for": None})
            if state.get("period") != period:
                state.update(period=period, hash=None, ocr_for=None, ax_hash=None, ax_chars=0,
                             ocr_chars=0, image_taken=False, ocr_decision=None)
            state["meta"] = meta
            state["block"] = "incognito" if body.get("incognito") else \
                "secure_input" if body.get("secure_input") else None
            blocked = self._blocked(window_id)
            # An OCR body got here only as its own request's answer.
            if checking or body["source"] == "ocr":
                self._settle(answered["request_id"], "declined" if blocked else "ready", blocked,
                             body["text"] if checking and answered.get("_look_window") and not blocked else None)
            if blocked:
                return {"accepted": False, "reason": blocked}
            if one_shot:
                return {"accepted": True}
            content = body["text"]
            digest = hashlib.sha256(f"{body['source']}\0{content}".encode()).hexdigest()
            preserve_ocr = body["source"] == "ax" and digest == state.get("ax_hash") and state["ocr_chars"] > 0
            if self._allowed("window_text") and not preserve_ocr:
                state["text"], state["text_ts"] = content, self.clock()
                state["text_epoch"] = self.policy_epoch
            first_empty = state["hash"] is None and not content.strip()
            focus = self.focus()
            # focus() is None before the gaze dwell and may be another window; only this window's category applies.
            window = {**(focus if focus and focus.get("window_id") == window_id else {}), **meta}
            if self.app_category is not None:
                window["category"] = self.app_category(meta)
            visual = category(window) in ("canvas", "video", "remote_desktop", "game") \
                or window.get("bundle_id") in VIDEO_BUNDLES \
                or (window.get("category") or "").rsplit(".", 1)[-1] in ("video", "graphics-design")
            if body["source"] == "ax":
                if state.get("ax_hash") != digest:
                    state["ocr_chars"] = 0
                    state["ocr_for"] = None
                state["ax_hash"], state["ax_chars"] = digest, len(content.strip())
                if state["ax_chars"] < AX_MIN and state["ocr_for"] != digest and not visual and not first_empty:
                    state["ocr_for"] = digest
                    request_id = self._request(window_id, "ocr", "low_ax_text")
                    self.observations[request_id].update(_period=period, _ax_hash=digest)
                    state["ocr_request"] = request_id
            else:
                state["ocr_chars"] = len(content.strip())
                state["ocr_decision"] = None
            if (digest == state["hash"] or preserve_ocr) and not checking:
                return {"accepted": True}
            if preserve_ocr:
                digest = state["hash"]
            else:
                state["hash"] = digest
            judged = {"app": meta["app"], "source": body["source"], "text_chars": len(content.strip()),
                      "ax_chars": state["ax_chars"], "ocr_chars": state["ocr_chars"], "visual": visual,
                      "first_empty": first_empty, "image_taken": state["image_taken"]}
            epoch = self.policy_epoch
        def valid():
            with self._lock:
                self._sync_policy()
                focus = self.focus()
                return self.policy_epoch == epoch and self.windows.get(window_id, {}).get("hash") == digest \
                    and focus is not None and focus.get("window_id") == window_id and not self._blocked(window_id)
        def decide():
            with self._lock:
                if not valid():
                    if self.policy_epoch == epoch and state["hash"] == digest and not self._blocked(window_id):
                        self._focus_decision = (window_id, decide)
                    return
                self._focus_decision = None
                window = {**(self.focus() or {}), **meta}
                judged["visual"] = category(window) in ("canvas", "video", "remote_desktop", "game") \
                    or window.get("bundle_id") in VIDEO_BUNDLES \
                    or (window.get("category") or "").rsplit(".", 1)[-1] in ("video", "graphics-design")
            answers = {a["id"]: a["value"] for a in self.judge.ask(judged, QUESTIONS, valid=valid)["answers"]}
            self._apply_text_decision(window_id, answers, valid)
        with self._lock:
            ocr = self.observations.get(state.get("ocr_request"))
            if body["source"] == "ax" and state["ax_chars"] < AX_MIN and not first_empty and not visual \
                    and ocr is not None and ocr["status"] == "pending":
                state["ocr_decision"] = (ocr["expires_at"], decide)
                return {"accepted": True}
        if self.spawn is None:
            decide()
        else:
            self._enqueue_text_decision(decide)
        return {"accepted": True}

    def _enqueue_text_decision(self, decide):
        # A burst of changed text retains one running and one latest pending decision,
        # rather than creating one waiting thread for every observation.
        with self._lock:
            self._pending_text_decision = decide
            if self._text_deciding:
                return
            self._text_deciding = True
        def drain():
            while True:
                with self._lock:
                    pending, self._pending_text_decision = self._pending_text_decision, None
                    if pending is None:
                        self._text_deciding = False
                        return
                try:
                    pending()
                except Exception:
                    pass  # retain local capture rules; continue with the newest observation
        try:
            self.spawn(drain)
        except Exception:
            with self._lock:
                self._text_deciding = False
                self._pending_text_decision = None
            raise

    def _apply_text_decision(self, window_id, answers, valid):
        with self._lock:
            if not valid():
                return
            delay = 30 if self.on_image is not None else NEXT_CHECK[answers["next_check"]]
            self.due = None if delay is None else (window_id, self.clock() + delay)
            repeat_due = self.on_image is not None and self.clock()-self.windows[window_id].get('image_at',0)>=30
            if answers["need_image"] and self.vision is not None and not self._blocked(window_id) \
                    and (not self.windows[window_id]["image_taken"] or repeat_due) \
                    and not any(r["window_id"] == window_id and r["mode"] == "image" and r["status"] == "pending"
                                and r["_period"] == self.windows[window_id]["period"]
                                and r["policy_epoch"] == self.policy_epoch for r in self.observations.values()):
                self._image_request(window_id, "judge")

    def look(self, window_id=None, mode="text"):
        """POST /look:an image of the focus window without the judge.
        window_id (a /say look_window): that window's text, or with mode "image" its image, instead."""
        if (window_id is None or mode == "image") and (self.vision is None or not self._allowed("screenshots")):
            return 409, {"error": "vision_off", "status": "unavailable"}
        with self._lock:
            self._sync_policy()
            window = self.focus() if window_id is None else {"window_id": window_id}
            if self._secure:
                return 409, {"error": "blocked", "reason": "secure_input", "status": "declined"}
            if window is None:
                return 409, {"error": "no_focus", "status": "unavailable"}
            if window == HIDDEN or window.get("window_id") is None:
                return 409, {"error": "blocked", "reason": "blacklisted", "status": "declined"}
            blocked = self._blocked(window["window_id"])
            if blocked:
                return 409, {"error": "blocked", "reason": blocked, "status": "declined"}
            if window_id is not None and mode == "text":
                if not self._allowed("window_text"):
                    return 409, {"error": "permission_unavailable", "status": "unavailable"}
                request_id = self._request(window_id, "text", "look_window")
                self.observations[request_id]["_look_window"] = True
                return 202, {"request_id": request_id, "status": "pending"}
            if window_id is not None and window_id not in self.windows and (self.focus() or {}).get("window_id") != window_id:
                # No metadata to check against the blacklist: the image could show a hidden app.
                return 409, {"error": "blocked", "reason": "unknown_window", "status": "declined"}
            denied, request_id = self._image_request(window["window_id"], "look" if window_id is None else "look_window",
                                                     look=True)
            if denied:
                return 409, {"error": denied, "status": "unavailable"}
            return 202, {"request_id": request_id, "status": "pending"}

    def image(self, request_id, window_id, image, url_host=None):
        """POST /context/image: PNG or JPEG bytes answering an open image request."""
        with self._lock:
            self._expire()
            opened = self.open.get(request_id)
            if opened is None or opened[0] != window_id:
                return 404, {"error": "unknown_request"}
            blocked = "blacklisted" if url_host and self.blacklist.hides_domain(url_host) else \
                self._blocked(window_id)
            if request_id not in self.open:  # cancelled by a policy change found just now
                return 404, {"error": "unknown_request"}
            del self.open[request_id]
            if blocked:
                self.budget.release(request_id)
                self._settle(request_id, "declined", blocked)
                return 409, {"error": "blocked", "reason": blocked, "status": "declined"}
            meta = {**self.observations.get(request_id, {}).get("_meta", {}), **({"url_host": url_host} if url_host else {})}
            epoch = self.policy_epoch
            if self.on_image is None:
                self.budget.sent(request_id)
            self._log("upload", window_id, opened[1], request_id)
        if self.on_image is not None:
            ident=self.on_image(window_id,request_id,image,meta,capture_valid=lambda:epoch==self.policy_epoch and not self._secure)
            with self._lock:
                state=self.windows.get(window_id)
                if state is not None: state['image_at']=self.clock()
                if ident:
                    self.budget.sent(request_id)
                    self._settle(request_id,'ready',text='Raw image captured; read this revision with observation_image. Ongoing understanding is still processing it.')
                else:
                    self.budget.release(request_id)
                    self._settle(request_id,'cancelled','observation_not_permitted')
        else:
            threading.Thread(target=self._describe, args=(window_id, request_id, image, opened[1] in ("look", "look_window")),
                             daemon=True).start()
        return 202, {"accepted": True, "request_id": request_id, "status": "pending"}

    def refresh(self, mode='text', window_id=None):
        with self._lock:
            self._sync_policy()
            focus=self.focus()
            if not focus or focus.get('window_id') is None or window_id is not None and window_id!=focus['window_id']:
                return {'state':'unavailable','reason':'source_not_current'}
            ident=focus['window_id']
            blocked=self._blocked(ident)
            if blocked: return {'state':'unavailable','reason':blocked}
            if mode=='image':
                denied,request=self._image_request(ident,'observation_refresh')
                return {'state':'resource_limited' if denied else 'pending','reason':denied,'request_id':request}
            if not self._allowed('window_text') or mode=='ocr' and not self._allowed('screenshots'):
                return {'state':'unavailable','reason':'permission_unavailable'}
            return {'state':'pending','request_id':self._request(ident,mode,'observation_refresh')}

    def failure(self, request_id, window_id, error):
        """POST /context/image with an error (a FAILURES key) instead of image bytes; a pending look_window text
        request takes a TEXT_FAILURES key."""
        with self._lock:
            self._expire()
            record = self.observations.get(request_id)
            if record is not None and record.get("_look_window") and record["status"] == "pending" \
                    and record["window_id"] == window_id:
                self._settle(request_id, TEXT_FAILURES[error], error)
                self._log("failure", window_id, error, request_id)
                return 200, {"request_id": request_id, "status": TEXT_FAILURES[error]}
            opened = self.open.get(request_id)
            if opened is None or opened[0] != window_id:
                return 404, {"error": "unknown_request"}
            if error not in FAILURES:
                return 400, {"error": "invalid_payload"}
            del self.open[request_id]
            self.budget.release(request_id)
            self._settle(request_id, FAILURES[error], error)
            self._log("failure", window_id, error, request_id)
            return 200, {"request_id": request_id, "status": FAILURES[error]}

    def tick(self):
        with self._lock:
            self._sync_policy()
            self._expire()
            pending, focus = self._focus_decision, self.focus()
            if pending is not None and focus is not None and focus.get("window_id") == pending[0]:
                self._focus_decision = None
                pending[1]()
            for state in self.windows.values():
                pending = state.get("ocr_decision")
                if pending is not None and pending[0] <= self.clock():
                    state["ocr_decision"] = None
                    pending[1]()
            if self.due is not None and self.due[1] <= self.clock():
                window_id, self.due = self.due[0], None
                if not self._blocked(window_id):
                    self._request(window_id, "text", "next_check")

    def secure_input(self, on):
        """From each /context/attention heartbeat; True holds until a heartbeat says False."""
        with self._lock:
            if on and not self._secure:
                self._bump()
            self._secure = bool(on)

    def window_text(self):
        """With --share-window-text, the focus window's latest text while fresh: {"app", "title", "text"} or None."""
        with self._lock:
            self._sync_policy()
            if not self._allowed("window_text"):
                return None
            state = self._focus_text()
            return None if state is None else \
                {"app": state["meta"]["app"], "title": state["meta"]["title"], "text": state["text"]}

    def forget_window_text(self):
        """DELETE /context/items/window_text: the text window_text() returns is dropped; False when there is none."""
        if not self.share_text:
            return False
        with self._lock:
            state = self._focus_text()
            if state is None:
                return False
            for key in ("text", "text_ts", "text_epoch"):
                state.pop(key)
            return True

    def _focus_text(self):
        """The focus window's state while its text is current, else None."""
        self._sync_policy()
        window = self.focus()
        if window is None or window == HIDDEN or window.get("window_id") is None:
            return None
        state = self.windows.get(window["window_id"])
        if state is None or "text" not in state or self._blocked(window["window_id"]) \
                or state["text_epoch"] != self.policy_epoch \
                or self.clock() - state["text_ts"] > WINDOW_TEXT_FRESH:
            return None
        return state

    def view(self):
        """The latest vision description while its window has the focus and nothing blocks it:
        {"window_id", "request_id", "text", "ts", "policy_epoch"} or None."""
        with self._lock:
            self._sync_policy()
            view = self._view
            if view is None or self._blocked(view["window_id"]) or view["policy_epoch"] != self.policy_epoch:
                return None
            window = self.focus()
            if window is None or window.get("window_id") != view["window_id"]:
                return None
            return view

    def forget_view(self):
        """DELETE /context/items/view: the view view() returns is dropped; False when there is none."""
        with self._lock:
            view = self.view()
            if view is None:
                return False
            self._view = None
            record = self.observations.get(view["request_id"])
            if record is not None:
                record["text"], record["reason"] = None, "deleted"
            return True

    def result(self, request_id):
        """One request's status (pending, ready, declined, unavailable, expired, cancelled, failed) or "unknown"."""
        with self._lock:
            self._expire()
            record = self.observations.get(request_id)
            return "unknown" if record is None else record["status"]

    def observation(self, request_id):
        """A copy of one request's record, or None."""
        with self._lock:
            self._sync_policy()
            self._expire()
            record = self.observations.get(request_id)
            return None if record is None else {k: v for k, v in record.items() if not k.startswith("_")}

    def observations_snapshot(self):
        """Copies of every kept request's record, oldest first."""
        with self._lock:  # the dict changes under the capture lock
            return [self.observation(request_id) for request_id in list(self.observations)]

    def diagnostic_observation(self, request_id, *, paused=False, fresh_seconds=300):
        """Bounded, in-memory detail for the local UI; never returns screenshot pixels.

        Policy and blacklist are rechecked under the same lock that owns observations. Historical
        descriptions are labelled separately from a fresh view currently eligible for context.
        """
        with self._lock:
            self._sync_policy()
            self._expire()
            record = self.observations.get(request_id)
            if record is None:
                return None
            blocked = self._blocked(record["window_id"]) or self.blacklist.hides(record.get("_meta") or {})
            allowed = self._allowed("screenshots") and not blocked and record["policy_epoch"] == self.policy_epoch
            raw = record.get("text") if allowed and record["mode"] == "image" else None
            current = self.view() if allowed and not paused else None
            current = bool(current and current["request_id"] == request_id and self.clock() - current["ts"] <= fresh_seconds)
            return {
                "request_id": request_id, "mode": record["mode"], "status": record["status"],
                "reason": record["reason"], "app": record["app"] if allowed else None,
                "requested_at": record["requested_at"], "observed_at": record["observed_at"],
                "current": current, "description": raw[:4000] if isinstance(raw, str) else None,
                "description_truncated": isinstance(raw, str) and len(raw) > 4000,
                "content_available": bool(isinstance(raw, str) and raw),
            }

    def cancel(self, request_id, reason):
        """Withdraw an image request still waiting for its upload; True when it was open."""
        with self._lock:
            if self.open.pop(request_id, None) is None:
                return False
            self.budget.release(request_id)
            self._settle(request_id, "cancelled", reason)
            return True

    def clear(self):
        """DELETE /attention: a policy change; requests in flight are cancelled, views and texts dropped."""
        with self._lock:
            self._bump()
            self.latest.clear()

    def forget_since(self, cutoff):
        """DELETE /observation: requests made, and the view and window texts received, at or after cutoff are
        dropped. Returns the number of requests dropped."""
        with self._lock:
            rewrite_jsonl(self.log_path, lambda row: row.get("ts", 0) < cutoff)
            self.judge.forget_since(cutoff)
            if self._view is not None and self._view["ts"] >= cutoff:
                self._view = None
            for state in self.windows.values():
                if "text_ts" in state and state["text_ts"] >= cutoff:
                    for key in ("text", "text_ts", "text_epoch"):
                        state.pop(key, None)
            return self._drop([r for r, record in self.observations.items() if record["requested_at"] >= cutoff])

    def forget_hidden(self, hides, field=None, delete_existing=True):
        """POST /blacklist: the requests of windows whose metadata hides(meta) matches are
        dropped; the reloaded blacklist drops every view and window text. Returns the number of requests dropped."""
        with self._lock:
            self._sync_policy()
            hidden = {w for w, state in self.windows.items() if hides(state["meta"])}
            self.judge.forget_hidden(hides, field)
            if not delete_existing:
                return 0
            rewrite_jsonl(self.log_path, lambda row: row.get("window_id") not in hidden)
            return self._drop([r for r, record in self.observations.items() if record["window_id"] in hidden])

    def _drop(self, request_ids):
        for request_id in request_ids:
            record = self.observations[request_id]
            state = self.windows.get(record["window_id"])
            if state is not None and state.get("ocr_request") == request_id:
                state["ocr_decision"] = None
            del self.observations[request_id]
            if self.open.pop(request_id, None) is not None:
                self.budget.release(request_id)
        self.latest = {w: r for w, r in self.latest.items() if r not in request_ids}
        return len(request_ids)

    def _sync_policy(self):
        self.blacklist._load()
        scope = self.consent() if self.consent is not None else None
        if self.blacklist.revision != self._revision or scope != self._consent_scope:
            self._consent_scope = scope
            self._bump()

    def _bump(self):
        """Nothing seen or asked for under the previous policy is used any more."""
        self.policy_epoch += 1
        self.due = self._pending_text_decision = self._focus_decision = None
        self._revision = self.blacklist.revision
        self._view = None
        for request_id in self.open:
            self.budget.release(request_id)
        self.open.clear()
        for request_id, record in self.observations.items():
            self._settle(request_id, "cancelled", "policy_changed")
            if record["text"] is not None:
                record["text"], record["reason"] = None, "policy_changed"
            record.pop("_meta", None)
            record.pop("_period", None)
            record.pop("_ax_hash", None)
        for state in self.windows.values():
            for key in ("text", "text_ts", "text_epoch"):
                state.pop(key, None)
            state["hash"] = state["ocr_for"] = state["ax_hash"] = None
            state["ocr_decision"] = None

    def _blocked(self, window_id):
        """None, or why nothing of this window may be requested or kept."""
        self._sync_policy()
        if self._secure:
            return "secure_input"
        state = self.windows.get(window_id)
        if state is None:
            return None
        return "blacklisted" if self.blacklist.hides(state["meta"]) else state["block"]

    def _image_request(self, window_id, reason, look=False):
        if not self._allowed("screenshots"):
            return "vision_off", None
        denied = self.budget.check(look=look)
        if denied:
            self._log("deny", window_id, denied)
            return denied, None
        request_id = self._request(window_id, "image", reason)
        self.budget.reserve(request_id, look)
        self.open[request_id] = (window_id, reason, self.observations[request_id]["expires_at"])
        self.latest[window_id] = request_id
        self._log("request", window_id, reason, request_id)
        return None, request_id

    def _request(self, window_id, mode, reason):
        request_id, now = secrets.token_hex(6), self.clock()
        meta = self.windows.get(window_id, {}).get("meta", {})
        focus = self.focus()
        if not meta and focus is not None and focus.get("window_id") == window_id:
            meta = focus
        self.observations[request_id] = {
            "request_id": request_id, "mode": mode, "purpose": "current", "window_id": window_id,
            "app": meta.get("app"), "requested_at": now, "observed_at": None, "expires_at": now + (OCR_TTL if mode == "ocr" else IMAGE_TTL),
            "policy_epoch": self.policy_epoch, "status": "pending", "reason": None, "text": None,
            "_meta": {k: meta.get(k) for k in ("app", "bundle_id", "title", "url_host")},
            "_reason": reason, "_period": self.windows.get(window_id, {}).get("period"),
            "_ax_hash": self.windows.get(window_id, {}).get("ax_hash")}
        while len(self.observations) > RESULTS_MAX:
            oldest = next(iter(self.observations))
            del self.observations[oldest]
            if self.open.pop(oldest, None) is not None:
                self.budget.release(oldest)
        self.feed.publish("request", {"request_id": request_id, "window_id": window_id, "mode": mode,
                                      "reason": reason})
        return request_id

    def _describe(self, window_id, request_id, image, user):
        with self._lock:
            self._sync_policy()
            record = self.observations.get(request_id)
            if not self._allowed("screenshots") or record is None or record["status"] != "pending":
                return
            vision = self.vision  # PUT /settings/live may take it away under the lock
        try:
            text = vision.describe(image, user=user)
        except Exception as e:  # a failed look also drops this window's previous view
            self._log("vision_error", window_id, type(e).__name__, request_id)
            with self._lock:
                self._settle(request_id, "failed", "vision_error")
                if self._view is not None and self._view["window_id"] == window_id:
                    self._view = None
            return
        with self._lock:
            self._sync_policy()
            record = self.observations.get(request_id)
            # Cancelled, or asked for under an older policy: the description is dropped.
            if record is None or record["status"] != "pending" or record["policy_epoch"] != self.policy_epoch:
                return
            self._settle(request_id, "ready", text=text)
            # A late description of a window that lost the focus must not replace the focus window's view.
            focus = self.focus()
            if self.latest.get(window_id) == request_id and focus is not None and focus.get("window_id") == window_id:
                self._view = {"window_id": window_id, "request_id": request_id, "text": text, "ts": self.clock(),
                              "policy_epoch": self.policy_epoch}

    def _settle(self, request_id, status, reason=None, text=None):
        """Moves a pending record to its one terminal status; settling it again is a no-op."""
        record = self.observations.get(request_id)
        if record is None or record["status"] != "pending":
            return
        record.update(status=status, reason=reason, text=text)
        state = self.windows.get(record["window_id"])
        if record["mode"] == "image" and status == "ready" and state is not None \
                and record["policy_epoch"] == self.policy_epoch and record["_period"] == state.get("period"):
            state["image_taken"] = True
        if status not in ("expired", "cancelled"):
            record["observed_at"] = self.clock()

    def _expire(self):
        now = self.clock()
        for request_id, (_, _, deadline) in list(self.open.items()):
            if deadline < now:
                del self.open[request_id]
                self.budget.release(request_id)
                self._settle(request_id, "expired")
        for request_id, record in self.observations.items():
            if record["mode"] != "image" and record["expires_at"] < now:
                self._settle(request_id, "expired")

    def truncate_log(self):
        """The log file emptied; False without one."""
        if self.log_path is None:
            return False
        with self._lock, open(self.log_path, "w", encoding="utf-8"):
            return True

    def _log(self, event, window_id, reason, request_id=None):
        # Reasons and ids only: never window text or image bytes.
        if self.log_path is None:
            return
        record = {"ts": self.clock(), "event": event, "window_id": window_id, "reason": reason,
                  "request_id": request_id}
        with self._lock:
            now = self.clock()
            if now - self._log_pruned_at >= 3600:
                rewrite_jsonl(self.log_path, lambda row: row.get("ts", 0) >= now - 7 * 86400)
                self._log_pruned_at = now
            with open(self.log_path, "a", encoding="utf-8") as stream:
                stream.write(json.dumps(record) + "\n")
