"""Announcement slots, the tick and ledger loops, and task and commitment recovery."""
import datetime
import time

from infra import plugins
from brain.language import SUPPORTED
from character import dispatch_report
from daemon.turns import TEXT_HOLD_MAX_MS, TEXT_HOLD_MS
from observation.summary import Summarizer
from personal.commitments import awaited, parse_reminder, parse_wait
from sessions.ledger import TERMINAL
from traces.trace_store import new_trace_id

DIAG_EVERY = 1.0  # seconds between checks for a changed /diag/state while a stream is open
ANNOUNCE_TTL = 15.0  # seconds an announcement waits in its slot for speech to end
COUNTED = ("daily_limit", "same_cooldown", "cross_cooldown")  # gate reasons a slot's own admission sets off
RITUAL_EVERY = 30.0  # seconds between checks for pending rituals the clock alone changed (see ritual_check)
EXPIRE_EVERY = 60.0  # seconds between timeline expiries, which otherwise run only when records come in
JOB_REPORT_WITHIN = 24 * 3600.0  # seconds after a conversation job ends that she still tells its result
# Announcement headlines by reply language code; "harness" (None) takes the Chinese ones.
HEADLINES = {
    'zh-Hans': {'task_expired': '「{title}」没开始就过期了', 'task_interrupted': '「{title}」被重启打断了',
                'reminder_wait': '好，等 {awaited}提醒你{what}。', 'reminder_set': '好，{day}{time}提醒你{what}。',
                'daily': '每天 ', 'weekdays': '工作日 ', 'tomorrow': '明天 ', 'date': '{month:02d}-{day:02d} 周{weekday} ',
                'weekday_names': '一二三四五六日',
                'missed_wait': '错过了提醒：{text}（24 小时没等到 {awaited}）', 'missed_time': '错过了提醒：{text}（原定 {time}）',
                'due': '提醒你：{items}', 'separator': '；'},
    'en': {'task_expired': '"{title}" expired before it started', 'task_interrupted': '"{title}" was cut off by a restart',
           'reminder_wait': "OK, when {awaited}, I'll remind you: {what}.",
           'reminder_set': "OK, I'll remind you {day}at {time}: {what}.",
           'daily': 'every day ', 'weekdays': 'on weekdays ', 'tomorrow': 'tomorrow ',
           'date': 'on {weekday} {month:02d}-{day:02d} ', 'weekday_names': ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'),
           'missed_wait': 'Missed reminder: {text} (gave up after waiting 24 hours until {awaited})',
           'missed_time': 'Missed reminder: {text} (was set for {time})',
           'due': 'Reminder: {items}', 'separator': '; '},
    'ja': {'task_expired': '「{title}」は始まる前に期限切れになりました', 'task_interrupted': '「{title}」は再起動で中断されました',
           'reminder_wait': 'わかりました。{awaited}になったら{what}をお知らせします。',
           'reminder_set': 'わかりました。{day}{time}に{what}をお知らせします。',
           'daily': '毎日 ', 'weekdays': '平日 ', 'tomorrow': '明日 ', 'date': '{month:02d}-{day:02d}（{weekday}） ',
           'weekday_names': '月火水木金土日',
           'missed_wait': 'リマインダーを逃しました：{text}（24 時間待っても{awaited}になりませんでした）',
           'missed_time': 'リマインダーを逃しました：{text}（予定 {time}）',
           'due': 'お知らせです：{items}', 'separator': '、'}}


class AnnounceMixin:
    _schedules = None  # schedules_store()'s store, kept so its next due time outlives a tick
    _reports_marker = None  # the jobs and schedules _schedules_due last reported with nothing left untold

    def reply_language_code(self):
        """The code of the language the user picked for fixed text; None (Chinese, the app's language) under "auto",
        "harness" or while no character agent runs."""
        agent = self.character_agent
        setting = None if agent is None else agent.settings.snapshot()['reply_language']
        return setting if setting in SUPPORTED else None

    def _headlines(self):
        return HEADLINES.get(self.reply_language_code(), HEADLINES['zh-Hans'])

    def _tick_loop(self, interval):
        checked = ritual_checked = time.monotonic()
        presentation_checked = expired = 0.0
        summaries = Summarizer(self) if plugins.on("screen_awareness") else None
        while not self._stopped.wait(interval):
            self._quiet_due()
            self.sync_privacy()
            if time.monotonic() - presentation_checked >= .5:
                presentation_checked = time.monotonic()
                controller = self.character_agent
                if controller is not None and hasattr(controller, 'refresh_presentation'):
                    controller.refresh_presentation()
                    briefs = getattr(controller, 'observation_briefs', None)
                    if briefs is not None:
                        try: briefs.tick()
                        except Exception: pass  # reporting must never stop registry/interaction ticks
                else:
                    self.registry.set_role_focus(None, generation=self.turn_generation)
            self._signals_due()
            self.registry.tick()
            if self.sessions is not None:
                self.sessions.reap()
            if summaries and self.capture is not None and not self.observation_paused() and not self.resetting:
                self.capture.tick()
            if self._diag_clients and time.monotonic() - checked >= DIAG_EVERY:
                checked = time.monotonic()
                self._diag_check()
            if time.monotonic() - ritual_checked >= RITUAL_EVERY:
                ritual_checked = time.monotonic()
                try:
                    self.ritual_check()
                except Exception:  # a failed check must not stop the registry ticks
                    pass
            try:
                if self._commitments_waiting():
                    self._commitments_due()
            except Exception:  # a failed reminder must not stop the registry ticks
                pass
            try:
                marker = self._schedules_waiting() if plugins.on("personal_agent") else None
                if marker is not None:
                    self._schedules_due(marker)
            except Exception:
                pass  # a failed schedule must not stop registry ticks
            if self.timeline is not None and time.monotonic() - expired >= EXPIRE_EVERY:
                expired = time.monotonic()
                try:
                    self.timeline.expire(self.clock())
                except Exception:
                    pass  # a failed expiry must not stop registry ticks
            try:
                if summaries: summaries.tick()
            except Exception:
                pass  # a failed summary must not stop registry ticks
            try:
                if self.desk is not None:
                    self.desk.tick()
            except Exception:
                pass  # a failed write must not stop registry ticks
            self._switch_due()
            self._gift_due()
            self._focus_due()
            self._announce_due()

    def schedules_store(self):
        if self.memory is None:
            return None
        store = self._schedules
        if store is None or store.db is not self.memory.db or store.lock is not self.memory.lock:
            from personal.schedules import Schedules
            store = self._schedules = Schedules(self.memory.db, lock=self.memory.lock, clock=lambda: self.clock())
        return store

    def _commitments_waiting(self):
        """Whether _commitments_due has anything to do: an approval is waiting, or a reminder can be due."""
        commitments = self.commitments
        return commitments is not None and (bool(self.broker.pending())
                                            or commitments.next_due() <= commitments.clock())

    def _schedules_waiting(self):
        """None when _schedules_due has nothing to do: no schedule is due, and neither the jobs nor the schedules
        changed since it last left no report untold; else the marker to pass it."""
        controller, store = self.character_agent, self.schedules_store()
        if controller is None or controller.jobs is None or store is None:
            return ()  # _schedules_due returns at once
        marker = (controller, controller.jobs.store, controller.jobs.store.revision, store,
                  store.revision)
        if store.next_due() <= store.clock() or marker != self._reports_marker:
            return marker
        return None

    def schedule_context(self, conversation_id, scope_id):
        if conversation_id is not None:
            if not isinstance(conversation_id, str) or self.history is None or not self.history.conversations.get(conversation_id):
                raise ValueError('schedule_conversation_unavailable')
        if scope_id is not None:
            workspace = getattr(self.character_agent, 'workspace', None)
            if not isinstance(scope_id, str) or not scope_id:
                raise ValueError('invalid_schedule')
            if workspace is None:
                raise ValueError('scope_unavailable')
            workspace.validate_scope(scope_id)

    def _submit_schedule(self, store, run, *, manual=False):
        item = run['schedule']
        controller = self.character_agent

        def current():
            saved = store.get(item['schedule_id'])
            return not self.resetting and not self.closing and self.character_agent is controller \
                and saved is not None and (manual or saved['enabled']) \
                and all(saved[key] == item[key] for key in ('instruction', 'trigger', 'conversation_id', 'scope_id'))

        try:
            if controller is None or not current():
                raise ValueError('schedule_unavailable')
            self.schedule_context(item['conversation_id'], item['scope_id'])
            job = controller.submit_job(item['title'], item['instruction'], item['instruction'],
                                        scope_id=item['scope_id'], conversation_id=item['conversation_id'], valid=current)
            store.submitted(run, job['job_id'])
            return job
        except Exception as exc:
            from daemon.tracing import trace_error
            error = (trace_error(getattr(exc, 'code', str(exc))) if isinstance(exc, ValueError) else None) or 'schedule_unavailable'
            store.submitted(run, error=error, halt=error in (
                'scope_expired', 'scope_revoked', 'scope_changed', 'unknown_scope', 'schedule_conversation_unavailable'))
            raise

    def _schedules_due(self, marker=None):
        """marker: _schedules_waiting()'s, kept when no report is left untold; with one, only a due schedule is
        claimed."""
        controller = self.character_agent
        if self.resetting or self.closing or controller is None or controller.jobs is None:
            return
        store = self.schedules_store()
        if store is None:
            return
        runs = store.due() if marker is None or store.next_due() <= store.clock() else ()
        for run in runs:
            try:
                self._submit_schedule(store, run)
            except Exception:
                pass  # each failed submission is recorded; other schedules still run
        untold = [self._schedule_reports(store), self._job_reports(store)]
        self._reports_marker = None if any(untold) else marker

    def _schedules_session_done(self, announcement):
        if self.resetting or self.closing:
            return
        store = self.schedules_store()
        if store is None:
            return
        session_id = announcement.get('session_id')
        session = self.sessions.sessions.get(session_id) if self.sessions is not None else None
        task = self.tasks.get(self._origin(announcement)) if self.tasks is not None and self._origin(announcement) else None
        target = getattr(session, 'target', None) or (task or {}).get('target')
        if target not in ('claude', 'codex'):
            return
        event_key = [session_id, self._origin(announcement), announcement.get('ts'), announcement['kind']]
        for run in store.fire(target, announcement.get('project'), event_key):
            try:
                self._submit_schedule(store, run)
            except Exception:
                pass

    def _schedule_reports(self, store):
        """Once across restarts (the delivery's told event), like _job_reports; an unbound schedule's result goes to
        the active conversation. True when a report is left untold that a later tick may tell without a job or
        schedule changing."""
        controller = self.character_agent
        if controller is None or controller.jobs is None:
            return False
        untold = False
        for run in store.jobs():
            key = 'schedule-report-' + run['run_id']
            with self._announce_lock:
                if key in self._reported_tasks:
                    continue
            job = controller.jobs.store.get(run['job_id'], private=True)
            if not job or job['state'] not in ('succeeded', 'needs_review', 'failed'):
                continue
            deliveries = getattr(controller, 'deliveries', None)
            if deliveries is None:
                continue
            delivery = deliveries.produce(job['run_id'])
            if delivery is None:
                untold = True
                continue
            if delivery['redacted'] or deliveries.was_told(delivery['delivery_id']):
                continue
            item = store.get(run['schedule_id'])
            if item is None:
                continue
            character = (job.get('payload') or {}).get('character_id')
            conversation_id = job.get('conversation_id')
            _, epoch = self.sync_privacy()

            def recheck(character=character, epoch=epoch, ident=run['schedule_id'], conversation_id=conversation_id):
                _, current_epoch = self.sync_privacy()
                # A result the user asked for: the gate's be-quiet reasons hold it back, its budget does not.
                return current_epoch == epoch and character == self.character and not self.resetting \
                    and not self.closing and self.quiet_until is None and not self._text_only('announce') \
                    and self.gate.check('job_report', level='P1') in (None, *COUNTED) \
                    and (self.history is None or conversation_id in (None, self.history.conversations.active)) \
                    and self.character_agent is controller and store.get(ident) is not None

            if not recheck():
                untold = True
                continue
            kind = {'succeeded': 'dispatch_done', 'needs_review': 'dispatch_review'}.get(job['state'], 'dispatch_failed')
            result = job.get('result') or {}
            task = {'task_id': result.get('task_id') or job['job_id'], 'title': item['title'],
                    'target': 'local background job', 'cwd': ''}
            instruction, material, reason = dispatch_report.build(task, {'kind': kind, 'headline': job['state'],
                                                                        'detail': delivery['summary'] or result.get('error')},
                                                                 self.user_title())
            with self._announce_lock:
                if key in self._reported_tasks:
                    continue
                self._reported_tasks.add(key)
            claimed = False
            try:
                claimed = self.claim_line(key, instruction, recheck, reason=reason, material=material,
                                          conversation_id=conversation_id, resume_run_id=job['run_id'],
                                          on_voiced=lambda ident=delivery['delivery_id']: deliveries.told(ident))
            finally:
                if not claimed:
                    untold = True
                    with self._announce_lock:
                        self._reported_tasks.discard(key)
        return untold

    def _job_reports(self, store):
        """A job handed off in a conversation, ended: one line of hers in that conversation, once across restarts
        (the delivery's told event); _reported_tasks only keeps two ticks of this process from claiming it twice.
        True when one is left untold that a later tick may tell without a job changing."""
        controller = self.character_agent
        deliveries = getattr(controller, 'deliveries', None)
        if deliveries is None:
            return False
        untold = False
        scheduled = {run['job_id'] for run in store.jobs()}
        for job in reversed(controller.jobs.store.results_since(self.clock() - JOB_REPORT_WITHIN)):
            if job['state'] not in ('succeeded', 'needs_review', 'failed') or not job['conversation_id'] \
                    or not (job.get('payload') or {}).get('source_run_id') or job['job_id'] in scheduled:
                continue
            key = 'job-report-' + job['job_id']
            with self._announce_lock:
                if key in self._reported_tasks:
                    continue
            delivery = deliveries.produce(job['run_id'])
            if delivery is None:
                untold = True
                continue
            if delivery['redacted'] or deliveries.was_told(delivery['delivery_id']):
                continue
            payload = job.get('payload') or {}
            character = payload.get('character_id')
            _, epoch = self.sync_privacy()

            def recheck(character=character, epoch=epoch, ident=job['job_id']):
                _, current_epoch = self.sync_privacy()
                return current_epoch == epoch and character == self.character and not self.resetting \
                    and not self.closing and self.quiet_until is None and self.character_agent is controller \
                    and self.gate.check('job_report', level='P1') in (None, *COUNTED) \
                    and controller.jobs.store.get(ident) is not None

            if not recheck():
                untold = True
                continue
            handoff = None
            if payload.get('source_run_id') and self.history is not None:
                try:
                    turns = self.history.conversations.turns(job['conversation_id'], limit=200)['turns']
                except ValueError:
                    continue  # its conversation is gone
                handoff = next((turn['reply'] for turn in reversed(turns)
                                if turn['turn_id'] == payload['source_run_id'] and turn['reply']), None)
            instruction, material, reason = dispatch_report.build_job(job, handoff, delivery, self.user_title())
            with self._announce_lock:
                if key in self._reported_tasks:
                    continue
                self._reported_tasks.add(key)
            claimed = False
            try:
                claimed = self.claim_line(key, instruction, recheck, reason=reason, material=material,
                                          conversation_id=job['conversation_id'], resume_run_id=job['run_id'],
                                          on_voiced=lambda ident=delivery['delivery_id']: deliveries.told(ident))
            finally:
                if not claimed:
                    untold = True
                    with self._announce_lock:
                        self._reported_tasks.discard(key)
        return untold

    def _signals_due(self):
        signals = getattr(self, "signals", None)
        if signals is not None:
            signals.tick(self.clock())

    def _announce_due(self):
        """One tick: expired slots are dropped; with speech idle the oldest slotted announcement is voiced."""
        with self._announce_lock:
            now = self.clock()
            for key in [key for key, (at, *_) in self._announce_slots.items() if now - at >= ANNOUNCE_TTL]:
                del self._announce_slots[key]
            for key in [key for key, at in self._ended.items() if now - at >= ANNOUNCE_TTL]:
                del self._ended[key]
            if not self._announce_slots or self.speech is None or self._text_only("announce") or self.closing \
                    or self.resetting or self.switch is not None or self.speech.busy():
                return
            _, seq, headline, kind, level = self._announce_slots.pop(next(iter(self._announce_slots)))
            if level == "P0" or self.gate.check(kind, level=level) in (None, *COUNTED):  # a gate closed since is a drop
                self._voice_announcement(seq, headline)

    def announce(self, announcement):
        self._quiet_due()
        speak, reason = (False, None) if announcement.get("silent") else self.gate.admit(announcement["kind"],
                                                                                         announcement["level"])
        terminal = announcement["kind"] in TERMINAL
        origin = self._origin(announcement)
        with self._decision_lock:
            decided = self._decision_traces.get(origin)
        item = self.feed.publish("announce", {**announcement, "origin": origin, "speak": speak, "gate": reason,
                                              "state": "terminal" if terminal else "progress",
                                              "trace_id": decided["trace_id"] if decided else None})
        if self.behavior is not None and announcement["kind"] in ("dispatch_done", "dispatch_failed", "session_failed"):
            self.behavior.event(announcement["kind"])
        if self.state is not None and announcement["kind"] in ("dispatch_done", "dispatch_failed"):
            self.state.on_event(announcement["kind"])
        if announcement["kind"] in ("dispatch_done", "dispatch_returned", "dispatch_review", "dispatch_failed",
                                    "dispatch_closed"):
            self._dispatch_finished(announcement)
        if announcement['kind'] in ('dispatch_done', 'dispatch_review', 'session_failed'):
            try:
                self._schedules_session_done(announcement)
            except Exception:
                pass  # scheduling must not interrupt the original announcement
        if not speak or self.speech is None or self._text_only("announce") or self.closing:
            # The host does not return to a session pose after a text line, so she greets only while idle.
            if speak and announcement["kind"] == "reminder_due" and not self.closing and self.avatar["visible"] \
                    and self.registry.snapshot()["focus"]["state"] == "idle":
                self._show_announcement(item["seq"], announcement["headline"])
            return
        if announcement['kind'] in dispatch_report.REPORTED and self.character_agent is not None \
                and self._report_dispatch(announcement):
            return True
        session_id = announcement.get("session_id")
        if session_id and self.sessions is not None:
            session_id = self.sessions.own_id(session_id)  # one slot per own session, whichever id names it
        key = session_id or announcement.get("project") or announcement["kind"]
        with self._announce_lock:
            now = self.clock()
            ended = self._ended.get(key)
            if announcement["level"] != "P0" and not terminal and ended is not None and now - ended < ANNOUNCE_TTL:
                return  # a late progress never covers the state its key ended in
            if terminal:
                self._ended[key] = now
            self._announce_slots.pop(key, None)
            # Voiced like a mouth line; only P0 cuts a speech still playing, the rest wait in their key's slot.
            # While a character switch is open every one waits.
            if announcement["level"] != "P0" and self.speech.busy() or self.switch is not None:
                self._announce_slots[key] = (now, item["seq"], announcement["headline"], announcement["kind"],
                                             announcement["level"])
            else:
                self._voice_announcement(item["seq"], announcement["headline"])
        return True

    def _report_dispatch(self, announcement):
        task_id = self._origin(announcement)
        if self.tasks is None or task_id is None:
            return False
        with self._announce_lock:
            if task_id in self._reported_tasks:
                return True
        task = self.tasks.get(task_id)
        state = {'dispatch_done': 'succeeded', 'dispatch_review': 'needs_review',
                 'dispatch_failed': 'failed'}[announcement['kind']]
        character = self.character

        def eligible(task):
            owner = (task or {}).get('requested_by') or {}
            return task is not None and task['state'] == state and owner.get('kind') == 'agent' \
                and owner.get('character_id') == character and self.character == character

        permissions, epoch = self.sync_privacy()
        if not eligible(task) or not permissions['agent_sessions']:
            return False

        def recheck():
            permissions, current_epoch = self.sync_privacy()
            return permissions['agent_sessions'] and current_epoch == epoch and eligible(self.tasks.get(task_id)) \
                and not self.closing and not self.resetting and self.quiet_until is None \
                and not self._text_only('announce') and (announcement['level'] == 'P0' or
                    self.gate.check(announcement['kind'], level=announcement['level']) in (None, *COUNTED))

        instruction, material, reason = dispatch_report.build(task, announcement, self.user_title())
        if not recheck():
            return False
        with self._announce_lock:
            if task_id in self._reported_tasks:
                return True
            self._reported_tasks.add(task_id)  # reserve before claim_line can start its thread
        claimed = False
        try:
            claimed = self.claim_line(f'report-{task_id}', instruction, recheck, reason=reason, material=material)
            return claimed
        finally:
            if not claimed:
                with self._announce_lock:
                    self._reported_tasks.discard(task_id)

    def _voice_announcement(self, seq, headline):
        utterance = self._begin_utterance(f"announce-{seq}", self.turn_generation, None, "clause_end")
        self._speaking = self.speech.add_clause(utterance, headline)
        self.speech.end_utterance(utterance)

    def _show_announcement(self, seq, headline):
        """An announcement shown only as text: the host's body greets it as a text-only line, in the current turn."""
        line_id, generation, trace_id = f"announce-{seq}", self.turn_generation, new_trace_id()
        self._text_line(line_id, generation, trace_id)
        self._clause_intent(line_id, "greet", generation, trace_id, None)
        self._text_line(line_id, generation, trace_id, min(TEXT_HOLD_MAX_MS, TEXT_HOLD_MS * len(headline)))

    def _dispatch_finished(self, announcement):
        """dispatch.finished in the dispatch card's trace, once: for the first turn its own session ends, or for the
        card itself when no session started."""
        origin = self._origin(announcement)
        with self._decision_lock:
            known = origin in self._decision_traces
        if known:
            self._decision("dispatch.finished", {"request_id": origin, "result": announcement["kind"]}, origin)
            with self._decision_lock:
                self._decision_traces.pop(origin, None)

    def _origin(self, announcement):
        """The decision key an announcement comes from: its own origin, else its own session's dispatch card."""
        origin = announcement.get("origin")
        if origin is None:
            session = self.sessions.sessions.get(announcement.get("session_id")) if self.sessions is not None else None
            origin = getattr(session, "origin", None)
        return origin

    def recover_tasks(self):
        """At startup: one announcement per task the restart cut off (tasks.recover)."""
        for task_id, state in self.tasks.recover():
            task = self.tasks.get(task_id)
            kind, level = {"expired": ("task_expired", "P2"), "interrupted": ("task_interrupted", "P1")}[state]
            headline = self._headlines()[kind].format(title=task['title'])
            self.announce({"ts": time.time(), "level": level, "kind": kind, "headline": headline,
                           "project": task["cwd"], "session_id": task["session_id"], "detail": None,
                           "origin": task_id})

    def _remind(self, text):
        """「提醒我…」: keep the reminder and confirm it aloud."""
        if self.commitments is None:
            return 503, {"error": "no_commitments"}
        now = self.commitments.clock()
        wait = parse_wait(text)
        if wait is not None:
            trigger, what = wait
            item = self.commitments.add(what, None, created_line=None, trigger=trigger)
            self.feed.publish("commitment", {"action": "added", "commitment": item})
            self._announce_commitment("reminder_set", "P0",
                                      self._headlines()["reminder_wait"].format(
                                          awaited=awaited(trigger, self.reply_language_code()), what=what),
                                      item["id"])
            return 200, {"command": "remind", "commitment": item}
        reminder = parse_reminder(text, now)
        if reminder is None:
            return 409, {"error": "no_reminder_time"}
        due_at, what, repeat = reminder
        item = self.commitments.add(what, due_at, created_line=None, repeat=repeat)
        self.feed.publish("commitment", {"action": "added", "commitment": item})
        due = time.localtime(due_at)
        days = (datetime.date(*due[:3]) - datetime.date(*time.localtime(now)[:3])).days
        words = self._headlines()
        day = {"daily": words["daily"], "weekdays": words["weekdays"]}.get(repeat) or {0: "", 1: words["tomorrow"]}.get(
            days, words["date"].format(month=due.tm_mon, day=due.tm_mday, weekday=words["weekday_names"][due.tm_wday]))
        self._announce_commitment("reminder_set", "P0", words["reminder_set"].format(
            day=day, time=time.strftime('%H:%M', time.localtime(due_at)), what=what), item["id"])
        return 200, {"command": "remind", "commitment": item}

    def _commitments_due(self):
        """One tick: every reminder now due in one announcement, so no P0 cuts another; during quiet a silent card."""
        self._quiet_due()
        if self.commitments is None:
            return
        silent = self.quiet_until is not None
        waits = [a["window_s"] - a["seconds_left"] for a in self.broker.pending()]
        if waits:
            self.commitments.fire("approval_waiting", {"minutes": max(waits) / 60})
        for item in self.commitments.expire():
            self.feed.publish("commitment", {"action": "missed", "commitment": item})
            self._announce_commitment("reminder_missed", "P1", self._headlines()["missed_wait"].format(
                text=item['text'], awaited=awaited(item['trigger'], self.reply_language_code())), item["id"])
        with self.commitments.lock:  # A user action cannot race between triggering and delivery.
            items = self.commitments.due()
            if not items:
                return
            words = self._headlines()
            headline = words["due"].format(items=words["separator"].join(i["text"] for i in items))
            delivered = self._announce_commitment("reminder_due", "P0", headline,
                                                  items[0]["id"], silent=silent,
                                                  commitment_ids=[i["id"] for i in items])
            if delivered or silent:
                self.focus.count("reminders", len(items))
            for item in items:
                # A repeating one re-arms even unheard, or it would stay triggered and never come again.
                if delivered or silent or item["repeat"] is not None:
                    done = self.commitments.fulfill(item["id"], "silent_card" if silent else None)
                    action = "rescheduled" if done["state"] == "armed" else "fulfilled"
                    self.feed.publish("commitment", {"action": action, "commitment": done})

    def recover_commitments(self, commitments=None):
        """At startup: one announcement per reminder the restart missed (commitments.recover).
        commitments: the store to recover and then serve; None recovers self.commitments."""
        commitments = commitments or self.commitments
        missed = commitments.recover()
        self.commitments = commitments  # only now may a tick see it, or an overdue reminder would be said as due
        for item in missed:
            self._announce_commitment("reminder_missed", "P1", self._headlines()["missed_time"].format(
                text=item['text'], time=time.strftime('%H:%M', time.localtime(item['due_at']))), item["id"])

    def focus_start(self, minutes):
        """POST /focus: the session's public(); ValueError as Focus.start."""
        started = self.focus.start(minutes)
        self.gate.focus = True
        self.user_now.set_overrides(focus_timer=True)
        return started

    def focus_stop(self):
        """DELETE /focus: ends it early with its recap; False when none runs."""
        session = self.focus.stop()
        if session is not None:
            self._focus_ended(session)
        return session is not None

    def _focus_due(self):
        session = self.focus.due()
        if session is not None:
            self._focus_ended(session)

    def _focus_ended(self, session):
        self.gate.focus = False
        self.user_now.set_overrides(focus_timer=False)
        self.announce({"ts": time.time(), "level": "P1", "kind": "focus_done", "headline": self.focus.recap(session),
                       "project": None, "session_id": None, "detail": None, "origin": None})

    def _announce_commitment(self, kind, level, headline, origin, silent=False, commitment_ids=None):
        """silent: a card only, never voiced (quiet mode); commitment_ids: every reminder the headline joins."""
        return self.announce({"ts": time.time(), "level": level, "kind": kind, "headline": headline, "project": None,
                              "session_id": None, "detail": None, "origin": origin,
                              **({"silent": True} if silent else {}),
                              **({"commitment_ids": commitment_ids} if commitment_ids is not None else {})})
