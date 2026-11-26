"""Taps, gifts, rituals, proactive feedback and the gates they share."""
import datetime
import secrets

from brain.events import cue
from brain.persona import BASE_LANGUAGE
from daemon.constants import FEEDBACK
from personal.rituals import GREETING, TAP, TAPS, TEMPLATES, pick_line
from sessions import day_summary, threads
from api.views import _iso

# The renderer's touch regions; left and right are hers.
TAP_REGION_TEXT = {
    "head_top": "the top of your head",
    "head": "your head",
    "face": "your face",
    "cheek_l": "your left cheek",
    "cheek_r": "your right cheek",
    "hair": "your hair",
    "accessory": "an accessory you wear",
    "chest": "your chest",
    "waist": "your waist",
    "arm": "your arm",
    "hand_l": "your left hand",
    "hand_r": "your right hand",
    "leg": "your leg",
    "skirt": "your skirt hem",
    "body": "your body",
}
# The gift line's text, one gift and several, by reply language code: the model hears it and the chat shows it as
# the user's turn. "harness" (None) takes the Chinese one.
GIFT_TEXT = {"zh-Hans": ("（送了你一份礼物）", "（送了你 {count} 份礼物）"), "en": ("(gave you a gift)", "(gave you {count} gifts)"),
             "ja": ("（プレゼントを贈った）", "（プレゼントを {count} 個贈った）")}


class RitualsGlueMixin:
    def _scripted_line(self, event):
        """(event, text) for start_line, or None when this card has no matching translation."""
        if self.character is None:
            return None
        card = self.characters.load_card(self.character)
        agent = self.character_agent
        language = agent.reply_language.current(agent.settings.snapshot()["reply_language"]) if agent else None
        text = pick_line(card, event, language or BASE_LANGUAGE, self._last_scripted.get((self.character, event)))
        return (event, text) if text is not None else None

    def tap(self, count=1, region=None):
        """POST /interaction/tap:the highest pending ritual, or else a tap line for count clicks, on an idle
        mouth. (status, body)."""
        lane = self._line_lane()
        with self._slot_lock, self._switch_lock:
            if self.switch is not None:
                return 409, {"error": "switching"}
            picked = scripted = None
            if self.mouth is None or lane is None:
                picked = self.rituals.pick() if self.rituals is not None else None
                if picked:
                    event = "greeting_morning" if picked[0] == "morning" else picked[0]
                    scripted = self._scripted_line(event)
                elif region in ("cheek_l", "cheek_r"):
                    scripted = self._scripted_line("cheek_pinch") or self._scripted_line("tap")
                else:
                    event = "head_pat" if region in ("head", "head_top", "hair") else "tap"
                    scripted = self._scripted_line(event)
                if scripted is None:
                    return (503, {"error": "no_llm"}) if self.mouth is None else (200, {"kind": None})
            if self.resetting or self.busy() or self._live_lines:
                speaking = self._mouth_lock.locked() or (self.speech is not None and self.speech.busy())
                working = not speaking and (bool(self._live_lines) or
                                            self.character_agent is not None and self.character_agent.busy())
                return 409, {"error": "busy", "while": "working" if working else "speaking"}
            if scripted is None and self.rituals is not None:
                picked = self.rituals.pick()
            if picked is None:
                facts, aim = TAP if count == 1 else TAPS
                line_id = secrets.token_hex(6)
                place = TAP_REGION_TEXT[region] if region is not None else "you"
                facts = facts.format(count=count, place=place, user_title=self.user_title())
                self.start_line(line_id, cue("tap", facts, aim, region=region, count=count),
                                reason={"code": "tap"}, source="tap", scripted=scripted)
                return 202, {"line_id": line_id, "kind": "tap"}
            kind, data = picked
            facts, aim = TEMPLATES[kind]
            line_id = secrets.token_hex(6)
            self.rituals.begin(kind, line_id)  # before the line: it may settle before start_line returns
            self.start_line(line_id, cue(kind, facts.format(**data, user_title=self.user_title()), aim),
                            reason={"code": "ritual", "kind": kind}, source="ritual", scripted=scripted,
                            material=f"Today so far: {data['arc']}" if kind == "report" else None)
        return 202, {"line_id": line_id, "kind": kind}

    def greet(self):
        """POST /character/greeting: her opening line once the first-run guide is done, on an idle mouth: the card's
        greeting_morning line, else one the model makes from GREETING. (status, body)."""
        lane = self._line_lane()
        with self._slot_lock, self._switch_lock:
            if self.switch is not None:
                return 409, {"error": "switching"}
            scripted = self._scripted_line("greeting_morning")
            if scripted is None and (self.mouth is None or lane is None):
                return (503, {"error": "no_llm"}) if self.mouth is None else (200, {"line_id": None})
            if self.resetting or self.busy() or self._live_lines:
                return 409, {"error": "busy"}
            facts, aim = GREETING
            line_id = secrets.token_hex(6)
            self.start_line(line_id, cue("first_meeting", facts.format(user_title=self.user_title()), aim),
                            reason={"code": "ritual", "kind": "greeting"}, source="ritual", scripted=scripted)
        return 202, {"line_id": line_id}

    def gift(self, body):
        if not isinstance(body, dict) or set(body) - {"action_id"} or "action_id" in body and \
                (not isinstance(body["action_id"], str) or len(body["action_id"].encode()) > 64):
            return 400, {"error": "invalid_payload"}
        with self._slot_lock:
            if self._gift_pending is None:
                self._gift_pending = {"gift_id": secrets.token_hex(6), "count": 0, "action_ids": []}
            gift = self._gift_pending
            gift["count"] += 1
            if "action_id" in body:
                gift["action_ids"].append(body["action_id"])
            self.feed.publish("gift", {"gift_id": gift["gift_id"], "state": "queued", "count": gift["count"],
                                       "line_id": None})
            gift_id = gift["gift_id"]
        self._gift_due()
        return 202, {"gift_id": gift_id}

    def _gift_due(self):
        if self._gift_pending is None:  # _line_lane asks the runtime, which stats every local backend's path
            return
        lane = self._line_lane()
        with self._slot_lock:
            with self._switch_lock:
                with self._turn_lock:
                    if self._gift_pending is None or self.resetting or self.closing or self.switch is not None \
                            or self.busy() or self._live_lines:
                        return
                    scripted = None
                    if self.mouth is None or lane is None:
                        scripted = self._scripted_line("gift")
                        if scripted is None:
                            gift = self._gift_pending
                            self._gift_pending = None
                            self.feed.publish("gift", {"gift_id": gift["gift_id"], "state": "failed",
                                                       "count": gift["count"], "line_id": None, "reason": "no_llm"})
                            return
                    gift = self._gift_pending
                    one, many = GIFT_TEXT.get(self.reply_language_code(), GIFT_TEXT["zh-Hans"])
                    text = one if gift["count"] == 1 else many.format(count=gift["count"])
                    if self.start_line(secrets.token_hex(6), text, source="gift", gift=gift, scripted=scripted) is not False:
                        self._gift_pending = None

    def ritual_check(self):
        """A /feed pending item when the kinds a tap may say changed: a reminder came or went, a line settled, or
        the clock passed a window."""
        if self.rituals is None:
            return
        with self._ritual_lock:
            kinds = self.rituals.pending()
            if kinds == self._ritual_kinds:
                return
            self._ritual_kinds, self._ritual_since = kinds, self.clock()
            self.feed.publish("pending", {"kinds": kinds, "since": _iso(self._ritual_since)})

    def _day_own_sessions(self):
        return [] if self.sessions is None else [s.to_dict() for s in list(self.sessions.sessions.values())]

    def day_segments(self, day):
        own = self._day_own_sessions()
        if self.external_session_activity_allowed():
            rows = day_summary.segments(self.ledger_root, day, own)
            if self.external_session_activity_allowed():
                return rows
        return day_summary.segments(None, day, own)

    def day_session_summary(self, day):
        own = self._day_own_sessions()
        if self.external_session_activity_allowed():
            result = day_summary.summarize(self.ledger_root, day, self.registry.snapshot(), own)
            if self.external_session_activity_allowed():
                return result
        return day_summary.summarize(None, day, {"sessions": []}, own)

    def day_arc(self, day):
        """What the user worked on local date day ("YYYY-MM-DD"): the headline, project summaries and open loops of
        its permitted day summary; without one, from the episodes, whose text needs page_text."""
        summary = self.worklog.day(day) if self.worklog is not None and self.character_agent else None
        if summary is not None and summary["state"] == "completed" \
                and self.character_agent._permitted("days", summary):
            body = summary["body"]
            parts = [summary["headline"]] + [f"{p['project']}: {p['summary']}" if p["project"] else p["summary"]
                                             for p in body.get("projects", [])]
            if body.get("open_loops"):
                parts.append("Still open: " + ", ".join(body["open_loops"]))
            return ". ".join(part.rstrip("。.") for part in parts)[:threads.ARC_CHARS]
        if self.episodes is None or not self.page_text_allowed():
            return None
        date = datetime.date.fromisoformat(day)
        start, end = (datetime.datetime.combine(d, datetime.time()).timestamp()
                      for d in (date, date + datetime.timedelta(days=1)))
        return threads.day_arc(self.episodes.between(start, end, character_id=self.character))

    def _proactive_publish(self, event, data):
        if event == "thought" and self.proactive_log is not None:
            self.proactive_log.shown(data["id"], "thought", data["reason"], data.get("session_id"), data["text"],
                                     data.get("offer"), data.get("reply"),
                                     datetime.datetime.fromisoformat(data["at"]).timestamp())
        return self.feed.publish(event, data)

    def _log_proactive_line(self, line_id, text, reason):
        if self.proactive_log is not None:
            scene = self.activity()
            subject = scene and (scene.get("subject") or scene.get("focus_id"))
            self.proactive_log.shown(line_id, "line", (reason or {}).get("kind", "comment"), subject,
                                     text, None, None, self.clock())

    def _proactive_voiced(self, line_id, text="", reason=None):
        """The gate counts a proactive line only now, and Proactive waits for its answer."""
        self._log_proactive_line(line_id, text, reason)
        # back and break lines are committed by Proactive itself; every other proactive line is a comment.
        if not (self.proactive is not None and self.proactive.voiced(line_id)):
            self.gate.commit("comment")

    def feedback(self, line_id, value, mute=False):
        """line_id: a proactive line's or a logged thought's id. The first explicit vote wins; retries cannot relabel
        or reward twice. mute: see Proactive.feedback."""
        with self._feedback_lock:
            if self.resetting or value not in FEEDBACK:
                return False
            if line_id in self._proactive_lines:
                channel = "line"
                if line_id in self._feedback_seen:
                    if mute and value == "dont_disturb" and self.proactive is not None:
                        self.proactive.feedback(line_id, value, mute, "line")
                    return True
                self._feedback_seen.intersection_update(self._proactive_lines)
                self._feedback_seen.add(line_id)
            else:
                entry = self.proactive_log and self.proactive_log.entry(line_id)
                if not entry or entry[0] != "thought":
                    return False
                channel = "thought"
                if entry[1] in FEEDBACK:
                    return True
            self._decision("proactive.feedback", {"line_id": line_id, "value": value}, line_id)
            if self.proactive is not None:
                self.proactive.feedback(line_id, value, mute, channel)
            if self.proactive_log is not None:
                self.proactive_log.feedback(line_id, value, self.clock())
            if self.state is not None and value == "useful":
                self.state.on_event("feedback_useful")
            return True

    def polls_paused(self):
        """skip of the behavior tick and Spatial loops: True during quiet, a reset or a switch."""
        self._quiet_due()
        return self.resetting or self.switch is not None or self.quiet_until is not None

    def _user_started(self, turn_id):
        """Whether the line voiced under turn_id came from /say, not from start_line or announce."""
        return not turn_id.startswith("announce-") and turn_id not in self._proactive_lines

    def _text_only(self, source):
        """A line or announcement of `source` is shown, not voiced: muted, or the character is hidden and the user
        did not start it (source "proactive", "announce", "ritual" or "tap"), or a ritual or tap line in a meeting."""
        self._quiet_due()
        return not self.character_voice_enabled or self.muted or not self.avatar["visible"] and source not in ("text", "voice", "gift") \
            or source in ("ritual", "tap") and (self.gate.meeting or self.gate.meeting_manual)

    def busy(self):
        return self._mouth_lock.locked() or (self.speech is not None and self.speech.busy()) or \
            (self.character_agent is not None and self.character_agent.busy())
