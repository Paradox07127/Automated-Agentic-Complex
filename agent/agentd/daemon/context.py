"""What the mouth and the body read: the situation, the live context and the activity."""
import datetime
import json
import os
import re
import time

from observation import activity
from character.behavior import BUSY, category
from brain.outbound import OutboundBlocked
from infra.localtime import local_time
from daemon.constants import VIEW_FRESH, RAW_KINDS
from observation import user_state
from observation.user_now import typing
from api.views import _window_id, _midnight

RECALL = re.compile(r"刚才(那|的)?(个)?(网)?页|上一页|之前(那|的)(个)?(网)?页")  # asks about an earlier page
USER_KINDS = RAW_KINDS + ("prompt",)  # events_raw kinds of the user's own doing; "agent" rows stay out of the state
APPROVAL_RECENT = 600.0  # seconds a decided or retired card stays in the mouth's context
APPROVAL_SHOWN = 3  # at most this many of them, the latest
# a card's end as the mouth reads it: the card's decision, or how it left pending without one
APPROVAL_RESULTS = {"allow": "approved", "allow_session": "approved (and the same kind for this session)", "deny": "denied",
                    "native": "answered in the agent's own dialog", "expired": "expired unanswered",
                    "tool_event": "handled on the agent's side", "agent_stopped": "withdrawn, the session stopped",
                    "session_ended": "withdrawn, the session ended"}
TASKS_SHOWN = 3  # the latest tasks in the mouth's context
# a task's state as the mouth reads it
TASK_STATES = {"proposed": "awaiting approval", "approved": "running", "running": "running", "waiting_user": "waiting for an answer",
               "returned": "to verify", "verifying": "to verify", "succeeded": "done", "failed": "failed",
               "needs_review": "awaiting the user's review", "expired": "expired", "denied": "cancelled", "cancelled": "cancelled",
               "interrupted": "interrupted", "accepted": "accepted by the user", "rejected": "sent back by the user"}
SOURCES = {"prompt": "a prompt to an AI", "search": "a search box", "field": "an input field"}  # where on_mind was typed
class ContextMixin:
    _scene = None  # the scene spatial_situation() last read, for the behavior tick
    _busy_since = None  # clock time the focus session went busy, as the behavior tick saw it; None while not busy
    _presence = None  # (presence, clock time) of user_now's presence as the behavior tick first saw it

    def situation(self):
        """For the behavior tick: states, counts and an app category only, never titles or text."""
        window = self.attention.focus() if self.attention is not None else None
        declared = self.attention.app_category(window) if window is not None else None
        if declared is not None:
            window = {**window, "category": declared}
        state = self.registry.snapshot()["focus"]["state"]
        self._busy_since = (self._busy_since or self.clock()) if state in BUSY else None
        scene, user, now = self._scene, self.user_now.snapshot(), self.clock()
        presence = {"present": "active", "unknown": "unknown"}.get(user["presence"], "afk")
        if self._presence is None or self._presence[0] != presence:
            self._presence = (presence, now)
        # An absence began at the last input.
        since = user["absence"]["since"] if presence == "afk" else self._presence[1]
        holds = scene["holds"] if scene is not None else []
        jobs = getattr(getattr(self, "character_agent", None), "jobs", None)  # none without a character agent or its jobs
        return {"hour": datetime.datetime.now().hour, "focus_state": state,
                "pending": len(self.broker.pending()), "presence": presence,
                "presence_s": now - since, "category": category(window),
                "focus": self.focus.running(), "busy_since": self._busy_since,
                "own_job": bool(jobs and jobs.store.list(states=("queued", "running"), limit=1)),
                "scene": scene and scene["activity"], "meeting": user["doing"] in ("meeting", "sharing"),
                "fullscreen": "fullscreen" in holds, "typing": typing(user)}

    def spatial_situation(self):
        """For the spatial behaviors:see Spatial's observe(). Its scene goes to the thoughts too."""
        scene = self._scene = self.activity()
        if self.thoughts is not None:
            self.thoughts.observe(scene)
        run = self.attention.dwell() if self.attention is not None else None
        window_id = run[2].get("window_id") if run is not None else None
        focus = self.registry.snapshot()["focus"]
        trace, user = self._turn_trace, self.user_now.snapshot()
        situation = {"fullscreen": self.gate.fullscreen, "user_speaking": self.gate.user_speaking,
                "speaking": self.busy() or bool(self._live_lines),
                "voicing": self.speech is not None and self.speech.busy(), "line_id": trace and trace["turn_id"],
                "typing": typing(user), "absence": user["absence"] and dict(user["absence"]),
                "session": focus["display_session"],
                "state": focus["state"], "related": scene["related_session_ids"] if scene is not None else [],
                "window_id": window_id if _window_id(window_id) else None, "activity": scene and scene["activity"],
                "idle_s": self.attention.idle_s() if self.attention is not None else None}
        if trace is not None and not trace["done"] and self._traced(trace):
            situation["turn_trace"] = (trace["trace_id"], trace["turn_id"], self._trace_epoch())
        if self.facing_decisions is not None:
            controller = self.character_agent
            cid, generation, consent = self.character, self.turn_generation, self.consent.snapshot()[1]
            facing_mode = 'auto'
            if self.privacy_config is not None:
                try:
                    with open(self.privacy_config, encoding="utf-8") as source:
                        facing_mode = json.load(source).get('render_facing_mode', 'auto')
                except (OSError, ValueError):
                    facing_mode = None
            valid = lambda: controller is not None and not self.closing and not self.resetting \
                and self.quiet_until is None \
                and self.character == cid and self.turn_generation == generation \
                and self.consent.snapshot()[1] == consent and controller._permitted('behavior')
            context = {k:situation[k] for k in ('activity','state','typing','user_speaking','speaking','voicing','session','window_id')}
            context.update(presence=user["presence"],doing=user["doing"],
                           giving_way=situation['fullscreen'] and self.spatial.switches['fullscreen_give_way'],
                           attending=any(b['type'] in ('listen','attend_session') for b in self.spatial.running()),
                           character_id=cid,turn_generation=generation,focus_seconds=run[1] if run else 0,
                           role={k:v for k,v in self.character_state().items() if k in ('energy','engagement','labels')},
                           facing_execution=self.spatial.facing_status())
            self.facing_decisions.apply(context,allowed=self.quiet_until is None and self.spatial.facing_available() and facing_mode == 'auto',valid=valid)
        return situation

    def _focus_cwd(self):
        """(cwd, display_session, state) of the focus session; all None without one."""
        snapshot = self.registry.snapshot()
        focus = snapshot["focus"]
        return next(((s["cwd"], focus["display_session"], focus["state"]) for s in snapshot["sessions"]
                     if s["display_session"] == focus["display_session"]), (None, None, None))

    def context(self, said=None, look=None, refused=None, used=None, now=None, window=True):
        """said: the user's line; look: the request_id of this line's look; refused: why its look was refused.
        used: a list that gets (type, observation_id) of each source the text draws on. now: the turn's aware local time.
        window: whether the front window's text goes in; False when the turn's observation context holds that text."""
        if used is not None:
            used.append(("sessions", None))
        now = now or datetime.datetime.now().astimezone()
        snapshot = self.registry.snapshot()
        shared = self.external_session_activity_allowed()
        sessions = "; ".join(f"{s['display_session']} ({os.path.basename(s['cwd'] or '') or '?'}) "
                            f"{s['effective_state']}" for s in snapshot["sessions"][:8]) or "none" \
            if shared else str(len(snapshot["sessions"]))
        focus = f"{snapshot['focus']['display_session'] or 'none'} " if shared else ""
        mine = self.state_view.summary(self.user_title()) if self.state is not None else ""  # "" while her state is as usual
        if mine and self.egress is not None:
            try:
                self.egress.authored("state", mine)
            except OutboundBlocked:  # her state is left out; the line goes on
                mine = ""
        lines = (f"Local time: {local_time(now)}",
                 f"Sessions: {sessions}", f"Focus: {focus}{snapshot['focus']['state']}",
                 self._approvals_context(snapshot) if shared else f"Pending approvals: {len(self.broker.pending())}",
                 self._tasks_context(), self._interrupted(),
                 self._attention_context(said, look, refused, used, window), mine)
        return "\n".join(line for line in lines if line)

    def _approvals_context(self, snapshot):
        """Each pending card as it reads, and how the cards of the last APPROVAL_RECENT seconds ended."""
        def card(r, limit):
            if r["kind"] == "dispatch":
                d = r["dispatch"] or {}
                where = os.path.basename(d.get("cwd") or "") or "?"
                return f"dispatch for {d.get('target')} to do \"{(d.get('prompt') or '')[:limit]}\" in {where}"
            return f"{r['display_session']} wants {r['tool_name']}: {(r['tool_summary'] or '')[:limit]}"

        pending = self.broker.pending()
        text = "Pending approvals ({}): {}".format(len(pending), "; ".join(
            f"{card(r, 200)} ({'dangerous, ' if r['dangerous'] else ''}{int(r['seconds_left'])} s left)" for r in pending)) \
            if pending else "Pending approvals: none"
        ended = self.broker.recent(APPROVAL_RECENT)[-APPROVAL_SHOWN:]
        if ended:
            now = time.time()
            failures = [o for o in snapshot["outcomes"] if o["kind"] == "tool_failure"]
            lines = []
            for r in ended:
                result = APPROVAL_RESULTS.get(r["decision"] if r["ended_by"] == "card" else r["ended_by"], "withdrawn")
                at = now - r["ago_s"]
                failed = r["decision"] in ("allow", "allow_session") and any(
                    o["display_session"] == r["display_session"] and o.get("tool_name") == r["tool_name"]
                    and o["ts"] >= at for o in failures)
                lines.append(f"{card(r, 80)}: {result}{', then failed to run' if failed else ''}, "
                             f"{round(r['ago_s'] / 60)} min ago")
            text += f"\nRecent approvals: {'; '.join(lines)}"
        return text

    def _tasks_context(self):
        """The latest TASKS_SHOWN tasks and how each stands; "" without any."""
        latest = self.tasks.list(limit=TASKS_SHOWN) if self.tasks is not None else []
        if not latest:
            return ""
        return "Recent tasks: {}".format("; ".join(f"\"{t['title']}\" {TASK_STATES[t['state']]}" for t in latest))

    def _interrupted(self):
        if self.speech is not None and self.speech.interrupted():
            return "The user cut off your last line: answer what they say now, without repeating the cut-off line."
        return ""

    def activity(self):
        """ActivityContext of the live stores (no judge) with the user's correction, or None without attention.
        A correction that no longer holds is dropped here."""
        if self.attention is None:
            return None
        correction = self.correction
        inputs = activity.snapshot(self.attention, self.registry, self.capture, self.sessions,
                                   self.user_now.snapshot(), self.gate.fullscreen)
        inputs["interpreted"] = self._interpreted(inputs["now"])
        scene = activity.assemble(inputs, correction=correction)
        if self.activity_decisions is not None:
            scene = self.activity_decisions.apply(inputs, scene)
        if correction is not None and not scene["corrected"] and self.correction is correction:
            self.correction = None
        now = inputs["now"]
        with self._state_lock:  # a forget_user_state() meanwhile would be undone by update()
            kinds = USER_KINDS if self.external_session_activity_allowed() else RAW_KINDS
            events = self.attention.recent_events(now - user_state.ERROR_WINDOW, kinds=kinds)
            derived = user_state.derive(events, inputs, scene, now)
            current = self.user_state.update(derived, now, at_once=scene["corrected"],
                                             absence=self.user_now.snapshot()["absence"])
        before = current["before_away"]
        return {**scene, **self._consented_state(current),
                "before_away": before and {**self._consented_state(before), "ts": before["ts"]}, "now": self._now()}

    def _now(self):
        """The timeline's now state (observation.now.shown) as consent allows; None without a timeline or while observation
        is paused. Without page_text it keeps the app, the times and the kinds of the actions, typed text included, but
        no title, page, target or selected text."""
        if self.timeline is None or self.observation_paused():
            return None
        now = self.timeline.now()
        if self.page_text_allowed():
            return now
        return {**now, "window": None, "artifact": None, "url_host": None,
                "actions": [{**a, "target": None, "text": None if a["kind"] == "selection" else a["text"]}
                            for a in now["actions"]]}

    def _interpreted(self, now):
        """The continuous interpreter's fresh tasks for assemble(); none without its service or its consent."""
        service = getattr(getattr(self, "character_agent", None), "observations", None)
        if not service:
            return []
        return activity.interpreted(service.understanding(), service.get, now)

    def forget_user_state(self):
        """Observations were deleted or consent revoked: the held state and judgment may quote them."""
        with self._state_lock:
            with self._judge_lock:
                self._state_generation += 1
                self._judgment = None
            self.user_state.clear()

    def _consented_state(self, current):
        """mode, state and evidence; thread only with page_text, on_mind and blocker only with typed_text."""
        page, typed = self.page_text_allowed(), self.consent.snapshot()[0]["typed_text"]
        return {"mode": current["mode"], "state": current["state"], "evidence": current["evidence"],
                "thread": current["thread"] if page else None, "on_mind": current["on_mind"] if typed else None,
                "blocker": current["blocker"] if typed else None}

    def _attention_context(self, said=None, look=None, refused=None, used=None, window=True):
        """window: whether the front window's text goes in (see context)."""
        self.sync_privacy()
        note = used.append if used is not None else lambda _: None
        text = self._screen_context(said, note) if self.attention is not None else ""
        if refused is not None:
            text += f"\nCould not see the user's window this time (reason: {refused})"
        elif look is not None:
            # Only this line's own observation answers it; an older view never stands in.
            seen = self.capture.observation(look) or {"status": "unknown", "reason": None, "text": None}
            if seen["status"] == "ready" and seen["text"]:
                text += f"\nThe user's window, just looked at: {seen['text']}"
                note(("view", look))
            else:
                why = "timeout" if seen["status"] == "pending" else seen["reason"] or seen["status"]
                text += f"\nCould not see the user's window this time (reason: {why})"
        else:
            view = self.capture.view() if self.capture is not None else None
            if view and datetime.datetime.now().timestamp() - view["ts"] <= VIEW_FRESH:
                text += f"\nThe user's window, just looked at: {view['text']}"
                note(("view", view["request_id"]))
        window = self.capture.window_text() if window and self.capture is not None else None
        if window:
            content=window['text']
            text += f"\nText in the user's front window ({window['app']} \"{window['title'] or ''}\"; a preview, observation_read has all of it): {content[:12000]}"
            if len(content)>12000: text+=f"\n{len(content)} characters in all; the end: {content[-4000:]}"
            note(("window_text", None))
        return text

    def _screen_context(self, said, note):
        scene = self.activity()
        text = f"Scene: {scene['activity']} (confidence {scene['confidence']})"
        if self.page_text_allowed():  # subject and facts carry window titles
            text += f", subject: {scene['subject'] or 'none'}; {'; '.join(f['text'] for f in scene['facts'])}"
        note(("activity", None))
        text += f"\nInferred state: {scene['mode']}"
        text += f", {scene['state']}" if scene["state"] != "unknown" else ""
        text += f", working on: {scene['thread']}" if scene["thread"] else ""
        if scene["on_mind"]:
            mind = scene["on_mind"]
            text += (f"; recently typed: \"{mind['text']}\" ({SOURCES[mind['source']]}, "
                     f"{round(self.attention.clock() - mind['ts'])} s ago)")
        text += f"; stuck on: \"{scene['blocker']}\"" if scene["blocker"] else ""
        text += "\nThe user is relaxing: keep to light topics and don't bring up work, code or to-dos; answer as usual if they ask about work." \
            if scene["mode"] == "relaxing" else ""
        current = scene["now"]
        if current is not None and current["basis"]:
            def clock(ts):
                return datetime.datetime.fromtimestamp(ts).strftime("%H:%M:%S")
            where = current["app"] and (current["app"] + (f' "{current["artifact"]}"' if current["artifact"] else "")
                                        + f" since {clock(current['since'])}")
            actions = "; ".join(
                clock(a["ts"]) + f" {a['kind']}" + (f" {a['keys']}" if a["keys"] else "")
                + (f" on {a['target']}" if a["target"] else "") + (f" in {a['app']}" if a["app"] != current["app"] else "")
                + (f': "{a["text"]}"' if a["text"] else "") for a in current["actions"])
            text += "\nNow: " + "; ".join(p for p in (where, actions and f"latest actions: {actions}") if p)
        summary = self.attention.summary(_midnight(), datetime.datetime.now().timestamp(), "app")
        top = ", ".join(f"{i['key']} {round(i['seconds'] / 60)} min" for i in summary["items"][:5])
        text += f"\nActive today: {round(summary['active_s'] / 60)} min; most used: {top}" if summary["items"] else ""
        selection = self.attention.latest_selection() if self.page_text_allowed() else None
        if selection:
            text += f"\nText the user selected in {selection['url_host'] or 'the browser'}: {selection['text'][:500]}"
            note(("selection", None))
        if self.page_text_allowed():
            page = self.attention.current_page()
            if page:
                text += (f"\nWeb page the user is reading ({page['url_host'] or 'browser'} \"{page['title'] or ''}\"): "
                         f"{page['text'][:1500]}")
                note(("page", None))
            page = self.attention.recent_page() if said and RECALL.search(said) else None
            if page:
                text += (f"\nWeb page the user read at {datetime.datetime.fromtimestamp(page['ts']):%H:%M} "
                         f"({page['url_host'] or 'browser'} \"{page['title'] or ''}\"): {page['text'][:1500]}")
                note(("page", None))
        return text
