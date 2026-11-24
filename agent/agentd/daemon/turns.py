"""A turn: /say and /look, claiming and running a line, and its history row."""
import contextvars
import datetime
import re
import secrets
import sqlite3
import sys
import threading
import time

from voice.clauses import MIN_CLAUSE, ClauseSplitter
from daemon.error_record import failure
from infra import plugins
from brain.language import mismatch
from brain.markers import MarkerStream
from character.binding import effective
from brain.parser import parse_command
from daemon.constants import LINE_ENTRIES
from personal.commitments import parse_reminder, parse_wait
from personal.memory import mentions
from voice.speech import PLAYING
from sessions.tasks import check_verify
from traces.trace_format import OBSERVATION_STATES
from traces.trace_store import TURN_TRACE, new_span_id
from api.views import _marked, _ms_since
from models.model_auth import ModelError

LOOK_WAIT = 20.0  # seconds a 「看一下」 line waits for the image description before answering anyway
SIDE_SPEECH_WAIT = 5.0  # seconds a side line's reply waits for the speech before it to end
# How long the host keeps her speaking after a completed text-only line: ms per shown character, at most ms.
TEXT_HOLD_MS, TEXT_HOLD_MAX_MS = 60, 3000
# observation state -> event status; declined and unavailable are policy outcomes, not faults; failed stays failed
OBSERVED = {"ready": "ok", "declined": "ok", "unavailable": "ok", "cancelled": "cancelled", "expired": "expired"}


TOOL_REQUEST = re.compile(
    r"[a-z][a-z0-9+.-]*://\S|www\.\S|(?:~/|(?<![a-z0-9])/|[a-z]:\\)[^\s/]|[\w-]+\.[a-z][a-z0-9]*"
    r"|(?:打开|运行|执行|安装|修改|改一下|修一下|写个|创建|删除|搜索|查一下|整理|发给|下载)(?![了过])\s*\w"
    r"|(?:^\s*|请\s*|帮我\s*|能不能\s*|可以\s*|\b(?:please|can you|could you)\s+)(?:"
    r"(?:看看|看一下)(?:这个|一下)?(?:窗口|屏幕)|(?:接着|继续)刚才"
    r"|(?:open|run|execute|install|edit|create|delete|search|download)\s+\w"
    r"|look at (?:this|the) (?:screen|window)\b|continue (?:the|that) task\b|remember (?:my|that)\b"
    r"|(?:set|add|cancel|remove|change|update|move|snooze|postpone|reschedule)\b.*\breminders?\b"
    r"|remind\s+me\b|记住|记一下|别忘了|别让我忘了"
    r"|(?:(?:今天|明天|明早|今晚|后天|[一二三四五六七八九十两半\d]+(?:分钟|小时|天|点|:\d+)(?:后)?)[^，。！？]*?)?(?:提醒我|叫我)"
    r"|(?:设置|添加|取消|撤销|更改|推迟|延后|提前).*提醒|(?:把.*)?提醒.*(?:取消|删除|撤销|改|推迟|延后|提前))"
    r"|リマインドして", re.I)


def foreground_route(text, *, command=None, scope_id=None, look=False, reply_to=None):
    if command or scope_id or look or reply_to or TOOL_REQUEST.search(text):
        return "chat"
    return "quick"


class TurnsMixin:
    # Completed lines checked against the reply language, and those clearly in another language (/diag/state turn).
    language_lines = language_mismatched = 0

    def _line_lane(self, wait=False):
        """"kernel" when the character agent's chat route is ready; None means there is no way to run a new line: the
        caller starts none."""
        if self.character_agent is not None and self.character_agent.public(wait=wait)["routes"]["chat"]["ready"]:
            return "kernel"
        return None

    def say(self, text, source="text", remember=True, look=False, cwd=None, verify_cmd=None, voice_timing=None,
            scope_id=None, expected_outputs=None, resume_run_id=None, surface=None, quote=None, reply_to=None,
            look_window=None, conversation_id=None, ready_chat=None):
        """Run one /say: a deterministic command, or a new streamed line. Returns (status, body).
        remember False: a 「记住…」 in this turn writes no fact, and no dispatch card opens.
        look True: a line that is no command runs as 「看一下」. cwd: a dispatch's directory, before the focus's.
        look_window: {"window_id", "pid"?} of a window to read instead of the focus window, as look does.
        verify_cmd: the command whose exit code verifies a dispatch's result (tasks.check_verify).
        voice_timing: {"pressed_ms", "released_ms", "final_ms"} in Unix ms of a voice turn, or None.
        surface: the entry the text was typed in. quote: {"text", "app"} of a selection, for this turn's context only.
        reply_to: {"kind": "line"|"thought", "id"} of what of hers the text answers."""
        if self.closing:
            return 503, {"error": "shutting_down"}
        if not remember and (expected_outputs is not None or resume_run_id is not None):
            return 400, {"error": "temporary_action_not_allowed"}
        if self.switch is not None:  # no new input while a character switch is open
            return 409, {"error": "switching"}
        with self._announce_lock:  # nothing slotted before the user's input is voiced after it
            self._announce_slots.clear()
        if self.proactive is not None:
            self.proactive.said(reply_to)
        if self.proactive_log is not None:
            self.proactive_log.said(text, reply_to, self.clock())
        if self.state is not None:
            self.state.on_event("user_spoke")  # that she was spoken to, never what was said
        command = None if resume_run_id or reply_to and reply_to["kind"] == "turn" else parse_command(text, names=self.characters.names())
        if not plugins.on("screen_reading") and (look or look_window or quote or command and command["action"] == "look"):
            return 409, {"error": "plugin_off", "plugin": "screen_reading"}
        if not plugins.on("personal_agent") and (scope_id or expected_outputs or resume_run_id or
                                                  command and command["action"] == "dispatch"):
            return 409, {"error": "plugin_off", "plugin": "personal_agent"}
        deterministic = command is not None
        stop_task = command is not None and command['action'] == 'stop_task'
        if stop_task and self.character_agent.jobs \
                and self.character_agent.jobs.store.list(states=('queued', 'running'), limit=None):
            command = None  # Resolve an explicit background target through the role's job tools.
        runtime = []  # the role's public() status, asked at most once a turn

        def runtime_status():
            if not runtime:
                runtime.append(self.character_agent.public())
            return runtime[0]
        dispatch_target = None
        if command and command['action'] == 'dispatch' and remember and cwd is None and verify_cmd is None \
                and self._focus_cwd()[0] is None and runtime_status()['routes']['background']['ready']:
            dispatch_target, command = command['target'], None
        reminder_unparsed = False
        if command and command["action"] == "remind" and self.commitments is not None \
                and runtime_status()['routes']['chat']['ready'] and parse_wait(command["text"]) is None \
                and parse_reminder(command["text"], self.commitments.clock()) is None:
            reminder_unparsed, command = True, None  # The role asks for the time the parser could not read.
        if command is None or command["action"] == "look":
            if self.mouth is None:
                return (409, {"error": "no_character"}) if self.no_character else (503, {"error": "no_llm"})
            scope_warning = None
            explicit_scope = scope_id is not None or resume_run_id is not None
            scope_id = (scope_id or self.character_agent.settings.snapshot().get("scope_id")) if remember and plugins.on("personal_agent") else None
            preferred = foreground_route(text, command=deterministic, scope_id=explicit_scope,
                                         look=look or look_window, reply_to=reply_to)
            quick = self.character_agent.quick_status() if preferred == "quick" and expected_outputs is None else None
            chat = None
            while True:
                if not quick or not quick["ready"] or self.character_agent.busy():
                    chat = ready_chat or runtime_status()["routes"]["chat"]
                with self._switch_lock:
                    if self.closing:
                        return 503, {"error": "shutting_down"}
                    if self.switch is not None:
                        return 409, {"error": "switching"}
                    if conversation_id and conversation_id != self.history.conversations.active:
                        return 409, {"error": "conversation_not_active"}
                    side = resume_run_id is None and expected_outputs is None and not stop_task and self.character_agent.busy()
                    if side and chat is None:
                        quick = None
                        continue
                    route = "quick" if quick and quick["ready"] and not side else "chat"
                    status = quick if route == "quick" else chat
                    if not status["ready"]:
                        return 503, {"error": status["error"], "runtime": status["backend"]}
                    if scope_id:
                        try:
                            self.character_agent.workspace.validate_scope(scope_id)
                        except ValueError as error:
                            if explicit_scope:
                                return 409, {"error": getattr(error, "code", "scope_changed")}
                            scope_warning = getattr(error, "code", "scope_changed")
                            if scope_warning in ("scope_expired", "scope_revoked", "unknown_scope"):
                                self.character_agent.drop_default_scope(scope_id)
                            scope_id = None
                    with self._turn_lock:  # a cancel of the old generation cannot cut the new line
                        if side:
                            generation, cancel = self.turn_generation, threading.Event()
                            self._end_sides("superseded")
                            self._side_lines.add(cancel)
                        else:
                            generation = self._cut("supersede")[1]
                            cancel = self._line_cancel = threading.Event()
                    line_id, body, wait, refused = secrets.token_hex(6), {}, None, None
                    if scope_warning:
                        body["scope_warning"] = scope_warning
                    trace = self._open_trace(line_id, generation, source, text, remember=remember,
                                             voice_timing=voice_timing)
                    trace['route'] = route
                    if dispatch_target:
                        trace['dispatch_target'] = dispatch_target
                    if reminder_unparsed:
                        trace['reminder_unparsed'] = True
                    if resume_run_id:
                        trace['resume_run_id'] = resume_run_id
                    if surface:
                        trace['surface'] = surface
                    if quote:
                        trace['quote'] = quote
                    if reply_to:
                        trace['reply_to'] = reply_to
                    if command is not None or look or look_window:
                        # 「看一下」: ask for an image first and answer once its description is in (at once if refused).
                        body["command"] = "look"
                        if self.capture is not None:
                            code, looked = self.look(window=look_window)
                            if code == 202:
                                wait = looked["request_id"]
                                asked = self.capture.observation(wait)
                                self._step(trace, "observation.requested", trace["observation"],
                                           attrs={"request_id": wait, "mode": asked["mode"], "purpose": "current",
                                                  "window_id": asked["window_id"]})
                            else:
                                refused = looked.get("reason") or looked["error"]
                                # Capture gives a refused look no request_id; this one names it in the trace only.
                                self._step(trace, "observation.settled", trace["observation"],
                                           status=OBSERVED.get(looked["status"], "failed"), duration_ms=0,
                                           attrs={"request_id": secrets.token_hex(6), "state": looked["status"]})
                    self._look = wait
                    options = {"remember": remember, "voice_timing": voice_timing, "scope_id": scope_id,
                               "expected_outputs": expected_outputs, "resume_run_id": resume_run_id, "side": side}
                    body.update(run_id=line_id, runtime=status["backend"])
                    if not remember:
                        body["runtime_reason"] = "temporary_read_only"
                    try:
                        trace["conversation_id"] = self.history.conversations.active if self.history is not None else None
                    except sqlite3.Error:
                        trace["conversation_id"] = None  # a store error must not refuse the input
                    trace["quick_admitted"] = route == "quick"
                    running = self.character_agent.begin_quick(trace, scope_id) if trace["quick_admitted"] else None
                    self._live_lines.add(cancel)
                    self.feed.publish("turn_accepted", {"line_id": line_id, "conversation_id": trace["conversation_id"],
                                                        "source": source, "trace_id": trace["trace_id"], "side": side})
                    if running:
                        running()
                    self.spatial.wake()  # its next poll sends the think of a speaking line now
                    threading.Thread(target=self._run_character_line,
                                     args=(line_id, text, cancel, generation, wait, refused, source, trace),
                                     kwargs=options, daemon=True).start()
                    return 202, {"line_id": line_id, "generation": generation, "trace_id": trace["trace_id"], **body}
        with self._switch_lock:
            if self.switch is not None:
                return 409, {"error": "switching"}
            if conversation_id and conversation_id != self.history.conversations.active:
                return 409, {"error": "conversation_not_active"}
            return self._run_command(command, remember, cwd, verify_cmd, source, text)

    def _run_command(self, command, remember, cwd, verify_cmd, source, text):
        action = command["action"]
        if action == "dispatch":
            if not remember:  # its prompt would stay in own_sessions and the CLI's own session
                return 409, {"error": "no_memory_dispatch"}
            try:
                verify_cmd = check_verify("read_only", verify_cmd)  # the card opens in read_only
            except ValueError as error:
                return 400, {"error": str(error)}
            if cwd is not None:
                cwd_from = {"source": "explicit"}
            else:
                cwd, display_session, state = self._focus_cwd()
                if cwd is None:
                    return 409, {"error": "no_cwd"}
                cwd_from = {"source": "focus", "display_session": display_session, "state": state}
            request = self.dispatcher.propose(command["target"], cwd, command["prompt"], source,
                                              text if source == "voice" else None, cwd_from=cwd_from,
                                              verify_cmd=verify_cmd)
            return 202, {"command": "dispatch", "request_id": request.request_id}
        if action == "remind":
            return self._remind(command["text"])
        if action == "stop":
            self._cut(self._keeping("stop"))
        elif action in ("mute", "unmute"):
            self.muted = action == "mute"
            if self.muted:
                self._cut("mute")
        elif action == "deny":
            # Voice may only deny, and only when the card it means is unambiguous.
            pending = self.broker.pending()
            if len(pending) != 1:
                return 409, {"error": "no_pending_approval" if not pending else "ambiguous_approval"}
            ok, reason = self.broker.decide(pending[0]["request_id"], pending[0]["generation"], "deny")
            if not ok:
                return 409, {"error": reason}
            return 200, {"command": "deny", "request_id": pending[0]["request_id"]}
        elif action == "stop_task":
            if self.character_agent.busy():
                self._cut("stop")
                return 200, {"command": action, "runtime": "character"}
            # As with 「拒绝」: only when the session it means is unambiguous.
            busy = [s for s in list(self.sessions.sessions.values()) if s.busy] if self.sessions is not None else []
            if len(busy) != 1:
                return 409, {"error": "no_task" if not busy else "ambiguous_task"}
            self.sessions.interrupt(busy[0].session_id)
            self.sessions.move_task(busy[0].origin, "cancelled", result={"reason": "stop_task"})
        else:
            self.feed.publish("command", command)
        return 200, {"command": action}

    def look(self, window=None):
        """POST /look and 「看一下」: capture.look(); a refusal is kept for the diagnostics.
        window: a /say look_window, whose text is asked for instead of the focus window's image."""
        self.sync_privacy()
        if self.observation_paused():
            status, looked = 409, {"error": "paused", "reason": "paused", "status": "unavailable"}
        elif window is None:
            status, looked = self.capture.look()
        else:
            status, looked = self.capture.look(window_id=window["window_id"])
        if status != 202:
            self._refused = {"request_id": None, "state": looked["status"],
                             "detail": looked.get("reason") or looked["error"], "at": time.time()}
        return status, looked

    def start_line(self, line_id, text, recheck=None, reason=None, source="proactive", material=None, gift=None,
                   conversation_id=None, resume_run_id=None, scripted=None, on_voiced=None):
        """A proactive line; unlike /say it cuts nothing, so callers check busy() first (see claim_line).
        It continues the trace its gate and judge decisions opened under line_id, if there is one.
        recheck: () -> bool, asked once before the first clause is voiced; False cancels the line.
        reason: why it is said, on each of its /feed line items. source "ritual" or "tap": a tap's line (see tap),
        which neither the gate nor /feedback counts. material: observed text for this line's live context only, never
        its text, which history, the mouth's turns and the trace keep.
        conversation_id: the conversation its row and /feed items go to, not the active one.
        resume_run_id: the run its row follows; the UI then shows the row without its text (History.record).
        scripted: (card event, localized text) to deliver directly.
        on_voiced: () -> None, called once its first clause is voiced or, text-only, all its text is shown; a line
        that ends without it frees line_id in _reported_tasks, so a later tick claims it again."""
        with self._switch_lock:
            if self.closing or self.resetting:
                return False
            with self._feedback_lock:
                if source == "proactive":
                    self._proactive_lines.append(line_id)
            generation = self._new_turn()
            cancel = self._line_cancel = threading.Event()
            with self._decision_lock:
                decided = self._decision_traces.pop(line_id, None)
            trace = self._open_trace(line_id, generation, source, text,
                                     *((decided["trace_id"], decided["last"]) if decided else ()), gift=gift)
            if conversation_id is not None:
                trace["conversation_id"] = conversation_id
            if resume_run_id is not None:
                trace["resume_run_id"] = resume_run_id
            self._live_lines.add(cancel)  # live from now, not from when its thread first runs (see claim_line)
            if scripted is not None:
                event, reply = scripted
                self._last_scripted[self.character, event] = reply
                threading.Thread(target=self._run_line, args=(line_id, text, cancel, generation),
                                 kwargs=dict(source=source, trace=trace, recheck=recheck, reason=reason, scripted=reply,
                                             on_voiced=on_voiced),
                                 daemon=True).start()
                return
        if material:
            self._line_material[cancel] = material
        if source in ("ritual", "tap") and self.tts_ensurer is not None and not self._text_only(source):
            self.tts_ensurer.request()  # the character agent's turn runs before _run_line's own request
        threading.Thread(target=self._run_character_line,
            args=(line_id, text, cancel, generation, None, None, source, trace),
            kwargs={"recheck": recheck, "reason": reason, "on_voiced": on_voiced}, daemon=True).start()

    def claim_line(self, line_id, text, recheck=None, reason=None, material=None, conversation_id=None,
                   resume_run_id=None, on_voiced=None):
        """start_line on an idle mouth as one step: False when a line or speech is in progress."""
        lane = self._line_lane()
        with self._slot_lock, self._switch_lock:
            if self.resetting or self.switch is not None or self.busy() or self._live_lines:
                return False
            scripted = None
            if lane is None:
                if reason and reason.get("code") == "back":
                    scripted = self._scripted_line("greeting_back")
                if scripted is None:
                    return False
            return self.start_line(line_id, text, recheck, reason, material=material, conversation_id=conversation_id,
                                   resume_run_id=resume_run_id, scripted=scripted, on_voiced=on_voiced) is not False

    def _run_character_line(self, line_id, text, cancel, generation, wait=None, refused=None, source="text", trace=None,
                            remember=True, voice_timing=None, scope_id=None, expected_outputs=None, resume_run_id=None,
                            recheck=None, reason=None, side=False, on_voiced=None):
        """The harness runs outside the delivery lock; only its completed reply enters the speech pipeline.
        side: a side line (see say), whose cancel is in _side_lines until this returns."""
        started = time.monotonic()
        traced = TURN_TRACE.set(trace["trace_id"])
        trace["agent_line"] = True
        trace["run_id"] = None if side else line_id  # a side session answers read-only, outside the foreground run
        self._live_lines.add(cancel)
        _, epoch = self.sync_privacy()
        self._line_consent[cancel] = epoch
        try:
            if recheck is not None and not recheck():
                cancel.set()
                return
            looked = time.monotonic()
            if wait is not None:
                wait = self._await_look(wait, cancel, generation, cancel.wait)
                seen = self.capture.result(wait)
                if seen == "pending":
                    seen = "cancelled" if self._stale(cancel, generation) else "expired"
                seen = seen if seen in OBSERVATION_STATES else "failed"
                self._step(trace, "observation.settled", trace["observation"], status=OBSERVED.get(seen, "failed"),
                           attrs={"request_id": wait, "state": seen}, duration_ms=_ms_since(looked))
            if self.closing:  # shutting down: _run_line ends the line cancelled without reading a reply
                self._run_line(line_id, text, cancel, generation, refused, source, trace,
                               remember=remember, voice_timing=voice_timing, reason=reason, on_voiced=on_voiced)
                return
            prepare = lambda: self.character_agent.prepare(line_id, text, cancel, generation, source, trace,
                scope_id=scope_id, expected_outputs=expected_outputs, wait=wait, refused=refused,
                resume_run_id=resume_run_id, side=side, look_wait_ms=_ms_since(looked))
            worker = None
            if side:
                prepared = prepare()
            else:
                prepared, worker = self._prepare_streamed(prepare, line_id, text, cancel, source, trace, reason)
            trace['final_item_id'] = prepared.final_item_id
            if side and self.speech is not None:
                deadline = time.monotonic() + SIDE_SPEECH_WAIT
                while self.speech.busy() and not self._stale(cancel, generation) and time.monotonic() < deadline:
                    cancel.wait(0.05)
            self._run_line(line_id, text, cancel, generation, refused, source, trace,
                           remember=remember, voice_timing=voice_timing, prepared=prepared, recheck=recheck, reason=reason,
                           on_voiced=on_voiced)
            if worker is not None:
                worker.join()
            # The foreground session's projection is its own; a side reply does not move it.
            if not side and not self._stale(cancel, generation):
                self.character_agent.delivered(self.mouth.history)
        except Exception as error:
            code, trace["line_message"] = failure(error)
            trace["line_state"], trace["line_error"] = "failed", code
            trace['final_item_id'] = None
            self._record(trace, source, text, "", "failed", time.time())
            self._line(trace, "", [], [], cancel, generation, source, final=True, error=code)
        finally:
            state = trace.get("line_state") or ("cancelled" if cancel.is_set() else "failed")
            if state == "completed" and trace.get("waiting_user"):
                state = "waiting_user"
            if trace.get("quick_admitted"):
                self.character_agent.settle_quick(line_id, state, trace.get("line_error"))
            self._turn_settled(trace, state, started, trace.get("line_error"), trace.get("outcome"),
                               trace.get("line_message"))
            trace["done"] = True
            self._unvoiced(trace, line_id, on_voiced)
            self._live_lines.discard(cancel)
            self._line_consent.pop(cancel, None)
            if side:
                self._line_context.pop(cancel, None)
                self._side_lines.discard(cancel)
            TURN_TRACE.reset(traced)

    def _unvoiced(self, trace, line_id, on_voiced):
        """A line given on_voiced that ended without calling it frees its claim (see start_line)."""
        if on_voiced is not None and not trace.get("voiced"):
            with self._announce_lock:
                self._reported_tasks.discard(line_id)

    def _prepare_streamed(self, prepare, line_id, text, cancel, source, trace, reason):
        """prepare() on a thread of its own: (its reply, None) when it ends before its run's final answer begins,
        else (a StreamedReply of that answer, the thread), so the line starts with the answer's first text."""
        from character_agent.presentation import StreamedReply
        streamed = cancel.answer = StreamedReply(self.mouth)

        def settled():
            trace['final_item_id'] = streamed.final_item_id
            if not streamed.memory_changed:  # those changes take their lines back after this line, as before it
                self._use_facts(trace, cancel, streamed, self._fact_query(text, source, reason), source)
        streamed.settled = settled

        def run():
            try:
                streamed.prepared(prepare())
            except Exception as error:
                streamed.prepared(failure=error)
        worker = threading.Thread(target=contextvars.copy_context().run, args=(run,), daemon=True)
        worker.start()
        if streamed.begun():
            return streamed, worker
        worker.join()
        if streamed.failure is not None:
            raise streamed.failure
        return streamed.reply, None

    def _await_look(self, wait, cancel, generation, pause):
        """Holds a line until its look settles, the line goes stale or LOOK_WAIT passes; returns the request_id
        waited for last. A look_window text read that found no text asks once for that window's image in the same wait."""
        deadline = time.monotonic() + LOOK_WAIT
        while True:
            while not self._stale(cancel, generation) and time.monotonic() < deadline \
                    and self.capture.result(wait) == "pending":
                pause(0.05)
            if self._stale(cancel, generation) or time.monotonic() >= deadline:
                return wait
            seen = self.capture.observation(wait)
            if self._stale(cancel, generation) or time.monotonic() >= deadline or seen is None \
                    or seen["mode"] != "text" or seen["reason"] not in ("ax_empty", "ax_unavailable"):
                return wait
            status, looked = self.capture.look(window_id=seen["window_id"], mode="image")
            if status != 202:
                return wait
            wait = looked["request_id"]

    def _context_assembled(self, trace, used, lore):
        """context.assembled, before the model call: used as context(..., used) fills it, lore as pick_lore returns."""
        at = datetime.datetime.now().astimezone().isoformat(timespec="milliseconds")
        items = [{"type": kind, "observation_id": seen_id, "at": at} for kind, seen_id in used]
        items += [{"type": "lore", "observation_id": e["id"], "at": at, "reason": e["reason"]} for e in lore]
        self._assembled = (time.time(), items)
        self._step(trace, "context.assembled", new_span_id(), attrs={"items": items})

    def _run_line(self, line_id, text, cancel, generation, refused=None, source="text", trace=None,
                  recheck=None, reason=None, remember=True, voice_timing=None, prepared=None, scripted=None,
                  on_voiced=None):
        """refused: why the line's look was refused.
        A newer turn_generation cancels the line as its cancel event does. source: the history row's source.
        trace: this turn's trace from _open_trace; None opens one here. recheck, reason: see start_line.
        remember False, voice_timing: see _open_trace. prepared: the character agent's reply the line streams.
        scripted: plain text from the card, ready to deliver without agent context or a model. on_voiced: see start_line."""
        self._live_lines.add(cancel)
        started_at = time.time()
        started = time.monotonic()
        trace = trace or self._open_trace(line_id, generation, source, text, remember=remember,
                                          voice_timing=voice_timing)
        traced = TURN_TRACE.set(trace["trace_id"])
        state = "failed"  # until the line settles
        error = None
        shown = None  # once a text-only line's text_line started went out: the hold_ms its ended carries
        try:
            with self._mouth_lock:
                self._apply_window_ops()
                if scripted is not None and recheck is not None and not recheck():
                    cancel.set()
                if self._stale(cancel, generation):  # stopped while waiting: no paid model call
                    state = "cancelled"
                    self._record(trace, source, text, "", state, started_at)
                    self._line(trace, "", [], [], cancel, generation, source, final=True, reason=reason)
                    self._cancel_acked(trace)
                    return
                markers, error, spoken, raw, intents, used = MarkerStream(), None, [], [], [], []
                said, utterance = [], None  # clauses cut from the reply; the utterance voicing them, once begun
                marks = []  # (offset in the spoken text, intent) of each marker, in order
                last_clause = None  # (speech_id, whether it got a clause_intent) of the latest clause voiced
                changed = False  # a fact this line was made from changed before one of its clauses was voiced
                shown_intent = False  # this line's one shown-only clause_intent went out
                performed = False  # this line's first motion marker was parsed
                policy = "clause_end" if source == "proactive" else "immediate"
                language = getattr(self.speech, "language", None)
                splitter = ClauseSplitter(language if language in MIN_CLAUSE else "zh")

                def memory_cut():
                    """A fact this line was made from changed: the turn ends as on DELETE /memory/facts/<id>."""
                    if cancel is self._line_cancel:
                        self.cancel_turn("memory_changed", generation)  # stale, and so a no-op, once a newer turn began
                    cancel.set()

                def voice(clauses, last=False):
                    """Each clause goes to TTS at once, as the next of the line's utterance, then the first
                    marker in it as its clause_intent. last: the reply's final clauses."""
                    nonlocal utterance, last_clause, changed
                    end = said[-1].end if said else 0
                    said.extend(clauses)
                    if last and not clauses and last_clause is not None and not last_clause[1] \
                            and not self._stale(cancel, generation):
                        # A sentence end voices its clause at once, before a marker written after it arrives.
                        intent = next((intent for at, intent in marks if at >= end), None)
                        if intent is not None:
                            self._clause_intent(line_id, intent, generation, trace["trace_id"],
                                                self.speech.clause_ref(last_clause[0]))
                    for n, clause in enumerate(clauses):
                        start, end = end, clause.end  # marks are offsets in the shown text, code and all
                        if last and n == len(clauses) - 1:
                            end = float("inf")  # a marker after the last character belongs to the last clause
                        if self.speech is None or self._text_only(source) or self._stale(cancel, generation):
                            return
                        if self._facts_changed(line_id):
                            changed = True
                            memory_cut()  # stale from here, as after a failed delivery check
                            return
                        if utterance is None:
                            if recheck is not None and not recheck():
                                cancel.set()  # stale from here: nothing voiced, the row and /feed end cancelled
                                return
                            if source == "proactive":
                                self._proactive_voiced(line_id, "".join(spoken).strip(), reason)
                            if on_voiced is not None:
                                trace["voiced"] = True
                                on_voiced()
                            if self.state is not None:
                                self.state.on_event("line")  # she voices it from here
                            utterance = self._begin_utterance(line_id, generation, trace["trace_id"], policy)
                            trace["utterance_id"] = utterance  # the line's feed events carry it from the next one
                        speech_id = self.speech.add_clause(utterance, clause)
                        if speech_id is not None:
                            self._speech_requested(trace, speech_id, line_id, clause)
                            intent = next((intent for at, intent in marks if start <= at < end), None)
                            last_clause = (speech_id, intent is not None)
                            if intent is not None:
                                self._clause_intent(line_id, intent, generation, trace["trace_id"],
                                                    self.speech.clause_ref(speech_id))

                def show(text):
                    """A line shown only as text: text_line started at its first visible text, then its first marker
                    as its clause_intent, so the host's body talks with the words."""
                    nonlocal shown, shown_intent
                    if utterance is not None or not (self.speech is None or self._text_only(source)) \
                            or self._stale(cancel, generation):
                        return
                    if shown is None and text.strip():
                        shown = 0
                        self._text_line(line_id, generation, trace["trace_id"])
                    if shown is not None and intents and not shown_intent:
                        shown_intent = True
                        self._clause_intent(line_id, intents[0], generation, trace["trace_id"], None)
                mouth = prepared
                _, consent_epoch = self.sync_privacy()
                self._line_consent[cancel] = consent_epoch
                if scripted is None:
                    context = self.context(text, None, refused, used)
                    material = self._line_material.pop(cancel, None)
                    context += f"{material}。" if material else ""
                    if hasattr(mouth, "dispatch_allowed"):
                        mouth.dispatch_allowed = lambda: not self._stale(cancel, generation)
                if cancel not in self._side_lines:  # a main line's context replaces the last main line's
                    for key in [key for key in tuple(self._line_context) if key not in self._side_lines]:
                        self._line_context.pop(key, None)
                self._line_context[cancel] = (line_id, {kind for kind, _ in used})
                past = getattr(mouth, "history", [])
                last_before = past[-1] if past else None  # the last turn before this line's stream
                earlier = [turn[0] for turn in past]
                if self.tts_ensurer is not None and not self._text_only(source):
                    self.tts_ensurer.request()  # a cold TTS starts while the model writes the line
                if scripted is None:
                    self._use_facts(trace, cancel, mouth, self._fact_query(text, source, reason), source)
                    stream = mouth.stream(text, context)
                else:
                    stream = (scripted,)
                try:
                    if self._stale(cancel, generation):
                        cancel.set()
                        stream = iter(())
                    for delta in stream:
                        if self._stale(cancel, generation):
                            break
                        raw.append(delta)
                        piece, at = _marked(markers, delta) if scripted is None else ((delta, [], []), [])
                        if markers.motions and not performed:
                            performed, motion = True, getattr(self, "motion", None)  # None: no performer, the marker is dropped
                            driver = None if motion is None else effective(self)["motion"]["driver"]
                            if driver in ("generated", "game"):
                                play = motion.start if driver == "generated" and plugins.on("motion_generation") else motion.gesture
                                play(markers.motions[0]["prompt"], markers.motions[0]["seconds"], generation,
                                     trace["trace_id"], trace["remember"])
                        marks += [(sum(map(len, spoken)) + offset, intent) for offset, intent in at]
                        spoken.append(piece[0])
                        intents += piece[1]
                        self._line(trace, *piece, cancel, generation, source, reason=reason)
                        show(piece[0])
                        voice(splitter.feed(piece[0]))
                except Exception as e:  # the line ends either way; the error name goes to the client
                    error = str(e) if isinstance(e, ModelError) else getattr(e, "code", None) or type(e).__name__
                finally:
                    close = getattr(stream, "close", None)
                    if close is not None:
                        close()
                tail = markers.close()
                spoken.append(tail[0])
                intents += tail[1]
                words = "".join(spoken).strip()
                state = "cancelled" if self._stale(cancel, generation) else "failed" if error else "completed"
                if state == "cancelled":
                    error = None  # closing an interrupted HTTP stream is cancellation, not provider failure
                # The mouth rebuilds each turn's list for every request but keeps its user message.
                if not self._current(trace) and past and (last_before is None or past[-1][0] is not last_before[0]):
                    past.pop()  # a reset or a chat clear emptied the mouth's window after this line began
                turn = self._turn_facts if self._turn_facts and self._turn_facts["line_id"] == line_id else None
                if turn is not None and state == "completed" and past:
                    turn["entry"] = past[-1]  # a finished stream has just appended this turn
                if changed or state == "completed" and self._facts_changed(line_id):
                    if not changed:
                        memory_cut()
                    state, error = "cancelled", "memory_changed"
                    if turn is not None:
                        past[:] = [t for t in past if t is not turn["entry"]]
                if not error and not self._stale(cancel, generation):
                    voice(splitter.feed(tail[0]) + splitter.close(), last=True)
                    if self._stale(cancel, generation):  # the delivery check or a cancel stopped its last clauses
                        state = "cancelled"
                if state == "cancelled" and past and (last_before is None or past[-1][0] is not last_before[0]):
                    past.pop()  # an unsaid reply leaves the mouth's window
                if utterance is not None:
                    self.speech.end_utterance(utterance)
                    if error == "memory_changed":
                        self.speech.cancel_utterance(utterance, immediate=True)
                if state == "cancelled" and cancel in self._context_cut:
                    error = "context_cleared"
                cut = state == "cancelled" and not error and cancel in self._user_cut and utterance is not None \
                    and self.speech_readers  # receipts are the record only while a renderer reads the speech stream
                kept = self._heard.get(line_id) if cut else None  # what was heard of a line the user cut
                if cut and kept is None \
                        and not any(clause["played"] in PLAYING for clause in self.speech.utterance(utterance)):
                    kept = self.speech.heard_utterance(utterance)  # each clause ended: no receipt settles it
                if kept:
                    state = "interrupted"
                if turn is not None and self.memory is not None and state in ("completed", "interrupted"):
                    self.memory.record_uses([(fact_id, version) for fact_id, version in turn["facts"]
                                             if turn["texts"].get(fact_id)
                                             and mentions(kept or words, turn["texts"][fact_id])],
                                            line_id, "mentioned")
                self._record(trace, source, text, kept or words, state, started_at, kept or "".join(raw))
                self._step(trace, "line.parsed", new_span_id(), texts={"text": words},
                           attrs={"line_id": line_id, "intents": intents, "target": None,
                                  "first_sentence_only": "".join(said).strip() != words})
                if state == "completed":
                    show(words)  # text or a marker only the tail held back
                    reply_language = self.reply_language_code()
                    if reply_language is not None:
                        self.language_lines += 1
                        self.language_mismatched += mismatch(reply_language, words)
                if utterance is None and intents and state == "completed" and not shown_intent \
                        and not self._stale(cancel, generation):
                    self._clause_intent(line_id, intents[0], generation, trace["trace_id"], None)  # shown only
                self._line(trace, *tail, cancel, generation, source, final=True, error=error, reason=reason)
                if shown is not None and state == "completed":
                    shown = min(TEXT_HOLD_MAX_MS, TEXT_HOLD_MS * len(words))
                if source == "gift" and state == "completed":
                    self.feed.publish("gift", {**trace["gift"], "state": "answered", "line_id": line_id})
                if utterance is None and words and not error and not self._stale(cancel, generation):
                    if source == "proactive":
                        self._proactive_voiced(line_id, words, reason)  # a line nobody hears counts once it is all shown
                    if on_voiced is not None:
                        trace["voiced"] = True
                        on_voiced()
                    if self.state is not None:
                        self.state.on_event("line")
                if source == "proactive" and utterance is not None and words:
                    self._log_proactive_line(line_id, words, reason)
                if self._stale(cancel, generation):
                    self._cancel_acked(trace)
                    if cut:
                        with self._write_lock:
                            if self._current(trace):
                                user = {"role": "user", "content": text}
                                if kept:
                                    self._keep_turn(line_id, user, earlier, kept)
                                else:
                                    self._cut_lines[line_id] = (user, earlier, self._line_facts(line_id), trace.get("conversation_id"))
                                    while len(self._cut_lines) > LINE_ENTRIES:
                                        self._cut_lines.popitem(last=False)
                        if not kept:  # an end receipt that came before the line was in _cut_lines
                            self._dropped((line_id, utterance, None))
                elif utterance is not None and not error and past:  # a finished stream has just appended this turn
                    with self._write_lock:
                        if self._current(trace):
                            self._line_entries[line_id] = past[-1]
                            while len(self._line_entries) > LINE_ENTRIES:
                                self._line_entries.popitem(last=False)
                if line_id in self._heard:  # cut before its row and window turn existed
                    self._settle(line_id, self._heard[line_id])
                self._apply_window_ops()
        finally:
            trace["line_state"], trace["line_error"] = state, error
            if not trace.get("agent_line"):
                self._turn_settled(trace, state, started, error)
            if shown is not None:  # a started text_line ends even when its line went stale
                self._text_line(line_id, generation, trace["trace_id"], shown)
            self._window_changed()  # a receipt queued after the last apply, or on a path that never applied
            if source == "ritual" and self.rituals is not None:
                try:  # while still live: a tap after it sees what it changed
                    self.rituals.settled(line_id, state)
                except Exception as e:  # a failed ritual_log write must not leave this line live, which blocks every later line
                    print(f"agentd: ritual settle failed: {type(e).__name__}", file=sys.stderr)
            trace["done"] = True
            if not trace.get("agent_line"):  # _run_character_line ends a character line's liveness once its turn settles
                self._unvoiced(trace, line_id, on_voiced)
                self._live_lines.discard(cancel)
            self._line_consent.pop(cancel, None)
            self._line_material.pop(cancel, None)  # a line that ended before its context was assembled
            self._context_cut.discard(cancel)
            self._user_cut.discard(cancel)
            TURN_TRACE.reset(traced)

    def _record(self, trace, source, text, reply, state, started_at, raw_reply=None):
        if self.history is None or not trace["remember"]:
            return
        with self._write_lock:
            if not self._current(trace):
                return
            try:
                character = trace.get("character_id", self.character)
                self.history.record(turn_id=trace["turn_id"], source=source, character_id=character,
                                    persona_revision=self.characters.revision(character), user_text=text,
                                    reply=reply, state=state, started_at=started_at, raw_reply=raw_reply,
                                    conversation_id=trace.get("conversation_id"), resume_run_id=trace.get("resume_run_id"))
            except sqlite3.Error:
                pass  # a lost row must not end the line

    def _stale(self, cancel, generation):
        if self.closing:
            return True
        _, epoch = self.sync_privacy()
        return cancel.is_set() or self.turn_generation != generation or \
            (cancel in self._line_consent and self._line_consent[cancel] != epoch)

    def _line(self, trace, text, intents, points, cancel, generation, source, final=False, error=None,
              reason=None):
        if text or intents or points or final:
            # Applying revocation may emit cancellation traces, which also take _write_lock.
            stale = self._stale(cancel, generation)
            with self._write_lock:
                if trace["reset"] != self.reset_generation:
                    return
                if "conversation_id" not in trace:
                    try:
                        trace["conversation_id"] = self.history.conversations.active if self.history is not None else None
                    except sqlite3.Error:
                        trace["conversation_id"] = None  # a store error must not end the line
                run_id = trace.get("run_id")
                self.feed.publish("line", {"line_id": trace["turn_id"], "text_delta": text, "intents": intents,
                                           "points": points, "final": final,
                                           "speak": self.speech is not None and not self._text_only(source),
                                           "utterance_id": trace.get("utterance_id"),
                                           "cancelled": stale or cancel.is_set() or self.turn_generation != generation, "error": error,
                                           "generation": generation, "reason": reason,
                                           "remembered": bool(trace["remember"] and self.history is not None),
                                           "run_id": run_id,
                                           **(trace.get("model_route", {}) if final else {}),
                                           "lane": "agent" if run_id else "side" if cancel in self._side_lines else "character",
                                           "conversation_id": trace["conversation_id"],
                                           **({'final_item_id': trace['final_item_id']} if final and 'final_item_id' in trace else {})})
