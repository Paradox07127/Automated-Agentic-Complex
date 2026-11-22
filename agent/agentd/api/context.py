"""POST /context/attention, /context/events, /context/timeline, /context/browser, /context/text and /context/image, and GET /attention/summary."""
import base64
import binascii
import datetime
import math
import time
from types import MappingProxyType
from urllib.parse import parse_qs, urlparse

from infra import plugins
from character.behavior import category
from observation.attention import AFK_AFTER, BUCKETS
from observation.browser_stats import valid_metrics
from observation.capture import TEXT_FAILURES, image_size
from observation.privacy import saved_switch
from observation.user_now import CONTENT_KINDS, typing
from daemon.constants import RAW_PAST
from api.views import _url_host, _window_id, _focus_window, _raw_event, _timeline_record, _midnight

MAX_WINDOW_TEXT = 2_000_000
MAX_IMAGE_EDGE = 16384
GATE_FLAGS = ("fullscreen", "camera_active", "mic_active", "user_speaking")  # optional heartbeat bools
# POST /context/events: batch size, the kinds the Companion sends, string caps, counts, accepted ts window
EVENTS_MAX = 200
RECORDS_MAX = 200  # POST /context/timeline batch size

# POST /user/coarse: the whole allowlist; any other key, at either level, is a 400.
COARSE_BOOLS = {"locked", "asleep", "fullscreen"}
COARSE_NULLABLE = {"front_video", "front_audio_out", "camera_active", "mic_active", "screen_captured", "user_speaking"}
COARSE_KEYS = COARSE_BOOLS | COARSE_NULLABLE | {"ts", "idle_s", "edge", "front_gpu", "input"}
COARSE_COUNTS = {"key_idle_s", "pointer_idle_s", "keys_10s", "keys_60s", "switches_60s"}


class ContextInputMixin:
    def _user_coarse(self, body):
        def number(value):
            return type(value) is int or type(value) is float and math.isfinite(value)

        if not (isinstance(body, dict) and body.keys() <= COARSE_KEYS
                and number(body.get("ts")) and number(body.get("idle_s")) and body["idle_s"] >= 0
                and all(type(body[k]) is bool for k in COARSE_BOOLS & body.keys())
                and all(body[k] is None or type(body[k]) is bool for k in COARSE_NULLABLE & body.keys())
                and body.get("edge") in (None, "lock", "unlock", "sleep", "wake")
                and (body.get("front_gpu") is None or number(body["front_gpu"]) and 0 <= body["front_gpu"] <= 1)
                and ("input" not in body or isinstance(body["input"], dict) and body["input"].keys() <= COARSE_COUNTS
                     and all(number(v) and v >= 0 for v in body["input"].values())
                     and saved_switch(self.server.privacy_config, "sense_input_counts"))):
            return self._json(400, {"error": "invalid_coarse"})
        user_now = self.server.user_now
        user_now.coarse(body)
        now, gate = user_now.snapshot(), self.server.gate
        gate.fullscreen, gate.user_speaking = now["flags"]["fullscreen"], now["flags"]["user_speaking"]
        gate.meeting, gate.typing = now["doing"] in ("meeting", "sharing"), typing(now)
        self._json(200, {"presence": now["presence"], "stage": now["stage"],
                         "absence": now["absence"] and dict(now["absence"]), "revision": now["revision"]})

    def _user_now(self):
        user_now = self.server.user_now
        events = user_now.events()  # before the snapshot, so no event is newer than it
        snapshot = {k: dict(v) if isinstance(v, MappingProxyType) else v for k, v in user_now.snapshot().items()}
        self._json(200, {"snapshot": snapshot, "events": events})

    def _attention_beat(self, body):
        store = self.server.attention
        if store is None:
            return self._json(503, {"error": "no_attention"})
        number = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
        # C6 `input` carries only counts and idle seconds of these kinds, never a key or a position.
        input_keys = {"key_idle_s", "pointer_idle_s", "scroll_idle_s", "click_idle_s", "keys_10s", "keys_60s",
                      "clicks_10s", "scrolls_30s", "moves_10s", "switches_60s", "near_clicks_10s"}
        counts = lambda v: isinstance(v, dict) and all(k in input_keys and number(n) and n >= 0 for k, n in v.items())
        apps = lambda v: isinstance(v, list) and len(v) <= 16 and all(isinstance(a, str) for a in v)
        if not (isinstance(body, dict) and number(body.get("ts")) and number(body.get("idle_s"))
                and body["idle_s"] >= 0 and isinstance(body.get("front"), dict)
                and isinstance(body.get("mouse"), (dict, type(None)))
                and _focus_window(body.get("focus_window"))
                and all(isinstance(body.get(k, False), bool) for k in GATE_FLAGS)
                and isinstance(body["front"].get("category"), (str, type(None)))
                and ("input" not in body or counts(body["input"]))
                and ("mic_apps" not in body or apps(body["mic_apps"]))
                and isinstance(body.get("front_audio_out"), (bool, type(None)))
                and isinstance(body.get("front_video"), (bool, type(None)))
                and (body.get("front_gpu") is None or number(body["front_gpu"]) and 0 <= body["front_gpu"] <= 1)
                and isinstance(body.get("screen_captured"), (bool, type(None)))
                and body.get("edge") in (None, "lock", "unlock", "sleep", "wake")):
            return self._json(400, {"error": "invalid_attention"})
        store.ingest(body)
        self.server.focus.beat(category(body["front"]), body["ts"], body["idle_s"] < AFK_AFTER
                               and not body.get("locked") and not body.get("asleep"))
        if self.server.character_agent is not None:
            pipeline = self.server.character_agent.memory_pipeline
            if pipeline: pipeline.tick(pipeline.clock())
        if self.server.proactive is not None:
            self.server.proactive.beat(body)
        if self.server.capture is not None:
            self.server.capture.secure_input(body.get("secure_input") is True)
        kind = category(store.blacklist.scrub(body["front"]))
        self.server.user_now.content(body["ts"], kind if kind in CONTENT_KINDS else None)
        self._json(200, {})

    def _attention_events(self, body):
        """POST /context/events: each event is checked on its own; a bad one is dropped, not the batch."""
        store = self.server.attention
        if store is None:
            return self._json(503, {"error": "no_attention"})
        if not isinstance(body, dict) or not isinstance(body.get("events"), list) or not body["events"]:
            return self._json(400, {"error": "invalid_events"})
        if len(body["events"]) > EVENTS_MAX:
            return self._json(400, {"error": "too_many_events"})
        generation = store.typed_generation  # before consent, so a revocation in between drops the values
        now, typed = self.server.clock(), self.server.consent.snapshot()[0]["typed_text"]
        kept = [row for row in (_raw_event(event, now) for event in body["events"])
                if row is not None and not self.server.paused_at(row["ts"])]
        if not typed:
            for row in kept:
                row["value"] = None
        stored, _ = store.ingest_events(kept, typed_generation=generation)
        controller = self.server.character_agent
        observations=getattr(controller,'observations',None)
        if observations and stored: observations.ingest_inputs(store.recent_events(now-RAW_PAST,limit=200))
        self._json(200, {"stored": stored, "dropped": len(body["events"]) - stored})

    def _timeline_post(self, body):
        """POST /context/timeline: each record is checked on its own; a bad one is dropped, not the batch."""
        timeline = self.server.timeline
        if timeline is None:
            return self._json(503, {"error": "no_timeline"})
        config = self.server.privacy_config  # None: no saved settings, the startup flags alone decide
        if self.server.observation_paused() or (config is not None and not saved_switch(config, "share_actions")):
            return self._json(200, {"paused": True})
        if not isinstance(body, dict) or not isinstance(body.get("records"), list) or not body["records"]:
            return self._json(400, {"error": "invalid_records"})
        if len(body["records"]) > RECORDS_MAX:
            return self._json(400, {"error": "too_many_records"})
        tree_generation = timeline.tree_generation
        generation = timeline.typed_generation  # before consent, so a revocation in between drops the text
        now, typed = self.server.clock(), self.server.consent.snapshot()[0]["typed_text"]
        kept = [row for row in (_timeline_record(record, now) for record in body["records"])
                if row is not None and not self.server.paused_at(row["ts"])]
        with self.server.consent.lock:
            consent, level = self.server.consent.snapshot()[0], self.server.consent.level
        secure = self.server.attention is not None and self.server.attention.secure_input()
        for row in kept:
            if secure or not consent["window_text"] or level != "window":
                row["tree"] = None  # a tree is the window's text
            if secure or not typed:
                row["text"] = None
                if row["target"] is not None:
                    row["target"]["value"] = None
        stored = timeline.ingest(kept, typed_generation=generation, tree_generation=tree_generation)
        self._json(200, {"stored": stored, "dropped": len(body["records"]) - stored})

    def _timeline_summaries_get(self):
        """GET /context/timeline/summaries: stored 10-minute timeline summaries, or FTS matches for ?q=."""
        timeline = self.server.timeline
        if timeline is None:
            return self._json(503, {"error": "no_timeline"})
        params = parse_qs(urlparse(self.path).query)
        raw_limit = (params.get("limit") or ["50"])[0]
        try:
            limit = int(raw_limit)
        except ValueError:
            return self._json(400, {"error": "invalid_limit"})
        if not 1 <= limit <= 100:
            return self._json(400, {"error": "invalid_limit"})
        query = (params.get("q") or [""])[0].strip()
        if query:
            items = timeline.search_summaries(query, limit=limit)
        else:
            raw_since = (params.get("since") or [None])[0]
            since = None
            if raw_since is not None:
                try:
                    since = float(raw_since)
                except ValueError:
                    return self._json(400, {"error": "invalid_since"})
                if not math.isfinite(since):
                    return self._json(400, {"error": "invalid_since"})
            items = timeline.summaries(since=since, limit=limit)
        self._json(200, {"summaries": items})

    def _timeline_summary_delete(self, raw_segment):
        """DELETE /context/timeline/summaries/<segment>: delete one 10-minute timeline summary."""
        timeline = self.server.timeline
        if timeline is None:
            return self._json(503, {"error": "no_timeline"})
        try:
            segment = int(raw_segment)
        except ValueError:
            return self._json(400, {"error": "invalid_segment"})
        deleted = timeline.delete_summary(segment)
        self._json(200, {"deleted": deleted, "segment": segment})

    def _context_text(self, body):
        optional_str = lambda v: v is None or isinstance(v, str)
        if not (isinstance(body, dict) and _window_id(body.get("window_id")) and isinstance(body.get("app"), str)
                and optional_str(body.get("bundle_id")) and optional_str(body.get("title"))
                and isinstance(body.get("text"), str) and len(body["text"]) <= MAX_WINDOW_TEXT
                and body.get("source") in ("ax", "ocr") and isinstance(body.get("secure_input", False), bool)
                and isinstance(body.get("incognito", False), bool)
                and optional_str(body.get("request_id")) and _url_host(body.get("url_host"))):
            return self._json(400, {"error": "invalid_payload"})
        count,page=body.get('snapshot_pages',1),body.get('snapshot_page',0)
        if type(count) is not int or type(page) is not int or not 1<=count<=10000 or not 0<=page<count or count>1 and not isinstance(body.get('snapshot_id'),str):
            return self._json(400,{'error':'invalid_observation_pages'})
        result = self.server.capture.text(body, one_shot=not plugins.on("screen_awareness"))
        observations=getattr(getattr(self.server,'character_agent',None),'observations',None)
        if result.get('accepted') and observations: observations.ingest_text(body)
        self._json(202,result)

    def _context_image(self, body):
        if not (isinstance(body, dict) and isinstance(body.get("request_id"), str)
                and _window_id(body.get("window_id")) and _url_host(body.get("url_host"))):
            return self._json(400, {"error": "invalid_payload"})
        fields = [field for field in ("png_base64", "jpeg_base64") if field in body]
        if not fields:  # the Companion could not take the image
            if body.get("error") not in TEXT_FAILURES:
                return self._json(400, {"error": "invalid_payload"})
            return self._json(*self.server.capture.failure(body["request_id"], body["window_id"], body["error"]))
        if len(fields) > 1 or not isinstance(body[fields[0]], str):
            return self._json(400, {"error": "invalid_payload"})
        try:
            image = base64.b64decode(body[fields[0]], validate=True)
        except binascii.Error:
            return self._json(400, {"error": "invalid_payload"})
        size = image_size(image)
        if size is None or size[0] != {"png_base64": "image/png", "jpeg_base64": "image/jpeg"}[fields[0]]:
            return self._json(400, {"error": "invalid_payload"})
        if max(size[1], size[2]) > MAX_IMAGE_EDGE or size[1]*size[2]>64_000_000:
            return self._json(413, {"error": "too_large"})
        self._json(*self.server.capture.image(body["request_id"], body["window_id"], image, body.get("url_host")))

    def _browser(self, body):
        store = self.server.attention
        if store is None:
            return self._json(503, {"error": "no_attention"})
        optional_str = lambda v: v is None or isinstance(v, str)
        optional_id = lambda v: v is None or isinstance(v, str) and len(v) <= 64
        # The upper bound is SQLite's INTEGER range.
        optional_int = lambda v, low: v is None or isinstance(v, int) and not isinstance(v, bool) and low <= v < 2**63
        if not (isinstance(body, dict) and body.get("type") in ("heartbeat", "page", "selection", "selection_cleared", "metrics")
                and isinstance(body.get("ts"), (int, float)) and not isinstance(body["ts"], bool)
                and math.isfinite(body["ts"])
                and all(k not in body or type(body[k]) is bool for k in ("window_focused", "visible", "audible"))
                and optional_str(body.get("url_host")) and optional_str(body.get("title"))
                and optional_id(body.get("browser_session")) and optional_id(body.get("document_id"))
                and optional_int(body.get("tab_id"), -2**63) and optional_int(body.get("revision"), 1)
                and (body["type"] in ("heartbeat", "selection_cleared")
                     or body["type"] == "metrics" and valid_metrics(body.get("metrics"))
                     or body["type"] == "page" and isinstance(body.get("text"), str)
                     or body["type"] == "selection" and isinstance(body.get("text"), str) and body["text"].strip())):
            return self._json(400, {"error": "invalid_browser"})
        # Enforce the switch again: an older extension or a policy response in flight cannot bypass it.
        if body["type"] in ("page", "selection") and not self.server.page_text_allowed():
            return self._json(200, {})
        store.ingest_browser(body)
        observations=getattr(getattr(self.server,'character_agent',None),'observations',None)
        if observations and body['type'] in ('page','selection'):
            observations.ingest('browser',body['text'],metadata={k:v for k,v in body.items() if k!='text'},at=body['ts'],
                source_key='browser:'+str(body.get('browser_session'))+':'+str(body.get('tab_id'))+':'+body['type'])
        self.server._browser_at = time.time()
        self._json(200, {})

    def _attention_summary(self, query):
        if self.server.attention is None:
            return self._json(503, {"error": "no_attention"})
        by = query.get("by", ["app"])[0]
        if by not in BUCKETS:
            return self._json(400, {"error": "invalid_by"})
        try:
            since = float(query["since"][0]) if "since" in query else _midnight()
        except ValueError:
            return self._json(400, {"error": "invalid_since"})
        self._json(200, self.server.attention.summary(since, datetime.datetime.now().timestamp(), by))
