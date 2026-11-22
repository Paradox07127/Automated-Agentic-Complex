"""The HTTP Handler: the guard every request passes, the dispatch to each route's owner, replies and SSE."""
import datetime
import functools
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler
from importlib import import_module
import json
import re
import sys
import threading
import time
from urllib.parse import parse_qs, urlparse

from api.character import CharacterMixin
from api.context import ContextInputMixin
from api.diag import DiagMixin
from api.episodes import EpisodesMixin
from api.hooks import HooksMixin
from api.memory import MemoryMixin
from api.observation import ObservationMixin
from api.sessions import SessionsMixin
from api.settings import SettingsMixin
from api.speech import SpeechMixin
from models import capabilities
from observation.blacklist import ALLOW_FIELDS
from personal.commitments import TRANSITIONS
from daemon.constants import VIEW_FRESH, RECEIPTS_KEPT, NO_HISTORY, SEEN
from daemon.rituals_glue import TAP_REGION_TEXT
from sessions.events import normalize_claude, normalize_codex
from route_registry import COMMITMENT_PATH, REGISTRY, SERVER, SESSION_PATH, TASK_PATH, routes_table
from infra import plugins
from infra.store import checkpoint
from tools import install_hooks
from api.views import _fact_text, _midnight, _iso

NORMALIZERS = {"/hook/claude": normalize_claude, "/hook/codex": normalize_codex}
MAX_BODY = 32 * 1024 * 1024
DRAIN_TIMEOUT = 2  # seconds finish waits for the rest of a body no handler read
C6_CONTRACT = "v1"  # protocol/C6-agentd-api/CONTRACT.md; /health and C9 --describe report it
IDEMPOTENCY_KEY_MAX = 128  # bytes of an Idempotency-Key header
# Endpoints that store nothing while observation is paused.
PAUSED_INPUTS = ("/context/attention", "/context/events", "/context/timeline", "/context/browser", "/context/text",
                 "/context/image")
ROUTES = routes_table()
# Hook disconnect error details by reply language code; "harness" (None) takes the Chinese ones.
HOOK_DETAILS = {
    "zh-Hans": {"hook_file_unavailable": "后台尚未定位此工具的配置文件，请重启后台后重试",
                "hook_settings_unreadable_or_changed": "配置无法解析或正在被其他程序修改，请重新检查后重试",
                "hook_settings_write_failed": "无法读取或写入配置文件，请检查文件权限后重试"},
    "en": {"hook_file_unavailable":
               "The background service has not found this tool's settings file yet; restart it and try again",
           "hook_settings_unreadable_or_changed":
               "The settings cannot be parsed or another program is changing them; check them and try again",
           "hook_settings_write_failed":
               "The settings file cannot be read or written; check its permissions and try again"},
    "ja": {"hook_file_unavailable": "バックグラウンドがこのツールの設定ファイルをまだ見つけていません。再起動してからもう一度お試しください",
           "hook_settings_unreadable_or_changed": "設定を解析できないか、別のプログラムが変更中です。確認してからもう一度お試しください",
           "hook_settings_write_failed": "設定ファイルを読み書きできません。ファイルの権限を確認してからもう一度お試しください"}}
# (method, path) of the routes that answer 409 no_character while the library has no character.
CHARACTER_ROUTES = frozenset({
    ("GET", "/character/state"), ("GET", "/character/state/history"), ("DELETE", "/character/state"),
    ("PUT", "/character/state/switch"), ("POST", "/say"), ("POST", "/voice/test"), ("POST", "/look"),
    ("POST", "/interaction/tap"), ("POST", "/interaction/gift"), ("POST", "/motions/generate"), ("POST", "/character"),
    ("POST", "/character/prepare"), ("POST", "/character/commit"), ("POST", "/character/abort")})


def _find(method, path):
    """The first registry route for method and path, with the pattern's match (None for a literal path)."""
    for route in REGISTRY:
        if route.method != method:
            continue
        if isinstance(route.path, str):
            if route.path == path:
                return route, None
        elif match := route.path.fullmatch(path):
            return route, match
    return None, None


def _answers_500(method):
    """An uncaught exception before any status line is sent answers 500 instead of dropping the connection."""
    @functools.wraps(method)
    def handle(self):
        self._replied = False
        stage = self.server.startup_stage
        if stage != "ready" and self.command == "GET" and urlparse(self.path).path == "/health":
            return self._json(200, {"status": "starting", "stage": stage, "degraded": self.server.degraded,
                                    "c6_contract": C6_CONTRACT})
        # File-based clients can connect during publication; health waits for both runtime files.
        if stage not in ("publishing", "ready"):
            return self._json(503, {"error": "starting"})
        try:
            return method(self)
        except Exception:
            if self._replied:
                raise
            self.server.handle_error(self.request, self.client_address)
            self._json(500, {"error": "internal_error", "route": f"{self.command} {urlparse(self.path).path}"})
    return handle


class Handler(BaseHTTPRequestHandler, HooksMixin, SessionsMixin, MemoryMixin, EpisodesMixin, ObservationMixin, ContextInputMixin, SpeechMixin, DiagMixin, CharacterMixin, SettingsMixin):
    protocol_version = "HTTP/1.1"
    # True while the request carries a body that no handler has read yet; set per request in parse_request.
    _unread_body = False
    _replied = False

    def log_message(self, *_args):
        pass  # Hook bodies carry prompts and tool input; never log them.

    def send_response(self, code, message=None):
        self._replied = True
        super().send_response(code, message)

    def parse_request(self):
        if not super().parse_request():
            return False
        hosts = self.headers.get_all("Host", [])
        host = re.fullmatch(r"(?:127\.0\.0\.1|localhost|\[::1\])(?::([0-9]+))?", hosts[0], re.I) \
            if len(hosts) == 1 else None
        has_body = bool(self.headers.get("Content-Length", "0").strip().lstrip("0")
                        or self.headers.get("Transfer-Encoding"))
        self._unread_body = has_body
        if host is None or host[1] is not None and host[1].lstrip("0") != str(self.server.server_port):
            code, error = 400, "invalid_host"
        elif "Origin" in self.headers or any(value != "none" for value in self.headers.get_all("Sec-Fetch-Site", [])):
            code, error = 403, "cross_site"
        elif self.command == "OPTIONS":
            code, error = 405, "method_not_allowed"
        elif self.command in ("POST", "PUT", "PATCH") and has_body and "Content-Type" in self.headers \
                and self.headers.get_content_type() != "application/json":
            code, error = 415, "unsupported_media_type"
        else:
            self.route, self.route_match = _find(self.command, urlparse(self.path).path)
            if self.route is None:
                code, error = 404, "not_found"
            elif self.route.tokens and not any(getattr(self.server, name) and self._auth(getattr(self.server, name))
                                               for name in self.route.tokens):
                code, error = 401, "unauthorized"
            else:
                return True
        self.close_connection = True
        self._json(code, {"error": error})
        return False

    def _json(self, code, data):
        raw = json.dumps(data, ensure_ascii=False).encode()
        if self._unread_body:
            self.close_connection = True  # leftover body bytes would be parsed as the next request
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            if self.close_connection:
                self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # Closing a panel or cancelling a fetch is an expected disconnect.
            # Do not turn it into duplicate handler tracebacks or retry a reply.
            self.close_connection = True

    def finish(self):
        # A close with the body unread resets the connection, and Windows then drops the reply the client has not read.
        if self._unread_body and not self.headers.get("Transfer-Encoding"):
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if 0 < size <= MAX_BODY:
                    self.connection.settimeout(DRAIN_TIMEOUT)
                    while size > 0 and (chunk := self.rfile.read(min(size, 1 << 16))):
                        size -= len(chunk)
            except (OSError, ValueError):
                pass
        super().finish()

    def _auth(self, token):
        value = self.headers.get("Authorization", "")
        return value.startswith("Bearer ") and hmac.compare_digest(value[7:].encode(), token.encode())

    def _resetting(self):
        """True once a 503 resetting is sent: no write lands while POST /reset runs."""
        if not self.server.resetting:
            return False
        self._json(503, {"error": "resetting"})
        return True

    def _body(self):
        size = int(self.headers.get("Content-Length", "0"))
        # RFC 9112 §6.1: a request with both Transfer-Encoding and Content-Length must end the connection.
        if not 0 < size <= MAX_BODY or self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            raise ValueError("invalid_body_size")
        self._unread_body = False
        return json.loads(self.rfile.read(size))

    def json(self, code, data):
        self._json(code, data)

    def body(self):
        return self._body()

    def auth(self, token):
        return self._auth(token)

    @_answers_500
    def do_GET(self):
        self._dispatch()

    do_POST = do_PUT = do_PATCH = do_DELETE = do_GET

    def _dispatch(self):
        """Hands the request to the owner of the route parse_request matched."""
        route, path = self.route, urlparse(self.path).path
        if route.plugin and not plugins.on(route.plugin):
            return self._json(409, {"error": "plugin_off", "plugin": route.plugin})
        if route.shared_plugins and not any(map(plugins.on, route.shared_plugins)):
            return self._json(409, {"error": "plugin_off", "plugin": route.shared_plugins[0]})
        if self.server.no_character and (self.command, path) in CHARACTER_ROUTES:
            return self._json(409, {"error": "no_character"})
        if route.owner != SERVER and import_module(route.owner).route(self, self.command, path):
            return
        if self.command != "GET" and path not in ("/reset", "/interaction/gift") and self._resetting():
            return
        if route.owner != SERVER:  # the owner's route() declined a path the registry matched
            if self.command == "POST":
                self.server.sync_privacy()
            return self._json(404, {"error": "not_found"})
        groups = self.route_match.groups() if self.route_match else ()
        if self.command == "POST" and path not in ("/integrations/hooks/disconnect", "/context/privacy/sync"):
            return self._post(route.action, groups)
        getattr(self, route.action)(*groups)

    def _post(self, action, groups):
        """A handler-owned POST's steps before its action: privacy sync, the shutdown guard, then the body."""
        path = urlparse(self.path).path
        self.server.sync_privacy()
        session_match = SESSION_PATH.match(path)
        task_match = TASK_PATH.match(path)
        commitment_match = COMMITMENT_PATH.match(path)
        if self.server.closing and (path in ("/sessions", "/say") or session_match):
            return self._json(503, {"error": "shutting_down"})
        if path in ("/reset", "/voice/reset"):
            return getattr(self, action)()
        try:
            body = None if action == "_schedule_run" and not self._unread_body \
                or session_match and session_match.group(2) == "interrupt" or task_match \
                or commitment_match and commitment_match.group(2) != "snooze" else self._body()
        except (ValueError, TypeError, AttributeError) as e:
            if path == "/interaction/gift":
                return self._json(400, {"error": "invalid_payload"})
            if commitment_match and commitment_match.group(2) == "snooze":
                return self._json(400, {"error": "invalid_payload", "field": "minutes"})
            return self._json(400, {"error": str(e) if isinstance(e, ValueError) else "invalid_payload"})
        if path in PAUSED_INPUTS and self.server.observation_paused():
            return self._json(200, {"paused": True})
        getattr(self, action)(*groups, body=body)

    # GET actions

    def _health(self):
        return self._json(200, {"status": "ok", "degraded": self.server.degraded, "c6_contract": C6_CONTRACT})

    def _browser_policy(self):
        attention = self.server.attention
        enabled = (attention is not None and not self.server.observation_paused()
                   and not self.server.resetting and attention.browser_capture_allowed())
        return self._json(200, {"enabled": enabled, "text_enabled": enabled and self.server.page_text_allowed()})

    def _agent_snapshot(self):
        # Read the locked watermark before any body so changes during collection remain replayable.
        state = self.server.feed.stream_state()
        snapshot = {"stream_epoch": state["stream_epoch"], "seq": state["latest_seq"]}
        def collect(code, body):
            unavailable = code == 503 or code == 409 and (
                body.get("error") == "plugin_off" or part == "conversations" and body.get("error") == "no_character")
            snapshot[part] = None if unavailable else body
        # Each part runs its own route through _dispatch; reader carries only server, command, path, the route, _auth and _json, so a GET handler that needs more fails test_agent_snapshot.
        reader = Handler.__new__(Handler)
        reader.server, reader.command, reader._auth, reader._json = self.server, "GET", self._auth, collect
        for part, route_path in (("conversations", "/conversations"),
                                 ("interactions", "/agent/interactions"),
                                 ("jobs", "/agent/jobs"), ("tasks", "/tasks"),
                                 ("personal_tasks", "/agent/tasks"), ("deliveries", "/agent/deliveries"),
                                 ("task_understanding", "/task-understanding"),
                                 ("commitments", "/commitments?state=armed&state=triggered"),
                                 ("approvals", "/approvals")):
            reader.path = route_path
            reader.route, reader.route_match = _find("GET", urlparse(route_path).path)
            reader._dispatch()
        return self._json(200, snapshot)

    def _diag_observation(self, request_id):
        self.server.sync_privacy()
        capture = self.server.capture
        if capture is None:
            return self._json(503, {"error": "observation_unavailable"})
        detail = capture.diagnostic_observation(request_id,
            paused=self.server.observation_paused(), fresh_seconds=VIEW_FRESH)
        if detail is None:
            return self._json(404, {"error": "observation_not_found"})
        for field in ("requested_at", "observed_at"):
            detail[field] = _iso(detail[field]) if detail[field] is not None else None
        items = self.server._assembled[1] if self.server._assembled is not None else None
        detail["used_in_last_turn"] = None if items is None else any(
            item.get("type") == "view" and item.get("observation_id") == detail["request_id"] for item in items)
        return self._json(200, detail)

    def _model_settings(self):
        if self.server.models is None:
            return self._json(503, {"error": "models_unavailable"})
        return self._json(200, {**self.server.models.public(), "mouth_ready": self.server.mouth is not None})

    def _tasks_get(self):
        if self.server.tasks is None:
            return self._json(503, {"error": "no_tasks"})
        return self._json(200, {"tasks": self.server.tasks.list()})

    def _commitments_get(self):
        if self.server.commitments is None:
            return self._json(503, {"error": "no_commitments"})
        states = parse_qs(urlparse(self.path).query).get("state")
        if states is not None and any(state not in TRANSITIONS for state in states):
            return self._json(400, {"error": "invalid_state"})
        return self._json(200, {"commitments": self.server.commitments.list(states)})

    def _capabilities(self):
        return self._json(200, capabilities.collect(self.server))

    def _day_get(self):
        """GET /day/segments, /episodes and /summary/runs of ?date=, today by default."""
        path = urlparse(self.path).path
        day = parse_qs(urlparse(self.path).query).get("date", [datetime.date.today().isoformat()])[0]
        try:  # fromisoformat alone also takes 20261022 and 2026-W43-4
            valid = bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", day)) and bool(datetime.date.fromisoformat(day))
        except ValueError:
            valid = False
        if not valid:
            return self._json(400, {"error": "invalid_date"})
        if path == "/episodes":
            return self._episodes_day(day)
        if path == "/summary/runs":
            return self._summary_runs(day)
        return self._json(200, {"date": day, "projects": self.server.day_segments(day)})

    def _focus_get(self):
        return self._json(200, {"focus": self.server.focus.public()})

    def _desktop_presence(self):
        if self.server.resetting or self.server.closing:
            return self._json(503, {"error": "presence_unavailable"})
        from observation.desktop_presence import snapshot
        return self._json(200, snapshot(self.server))

    def _desktop_session_seen(self, body):
        import math
        if not isinstance(body, dict) or set(body) - {'session_id', 'updated_at'} or \
                not isinstance(body.get('session_id'), str) or not 1 <= len(body['session_id']) <= 200:
            return self._json(400, {'error': 'invalid_session'})
        updated = body.get('updated_at')
        if updated is not None and (type(updated) not in (int, float) or not math.isfinite(updated)):
            return self._json(400, {'error': 'invalid_session'})
        if self.server.resetting or self.server.closing:
            return self._json(503, {'error': 'presence_unavailable'})
        from observation.desktop_presence import acknowledge
        seen = acknowledge(self.server, body['session_id'], updated)
        self.server.presence_feed.poke()
        return self._json(200, {'seen': seen})

    def _character_state(self):
        if self.server.state is None:
            return self._json(503, {"error": "no_state"})
        return self._json(200, self.server.character_state())

    def _state_history(self):
        return self._character_state_history(parse_qs(urlparse(self.path).query))

    def _state(self):
        return self._json(200, {**self.server.registry.snapshot(), "character": self.server.character,
                                "character_generation": self.server.character_generation,
                                "switching": self.server.switch_state(),
                                "turn_generation": self.server.turn_generation,
                                "observation": self.server.observation_state(),
                                "avatar": dict(self.server.avatar)})

    def _blacklist_get(self):
        if self.server.attention is None:
            return self._json(503, {"error": "no_attention"})
        blacklist = self.server.attention.blacklist
        blacklist._load()
        allow = blacklist.data.get("allow", {})
        return self._json(200, {**blacklist.data, "mode": blacklist.mode,
                                "allow": {f: allow.get(f, []) for f in ALLOW_FIELDS}})

    def _approvals(self):
        return self._json(200, {"approvals": self.server.broker.pending()})

    def _attention_browser(self):
        if self.server.attention is None:
            return self._json(503, {"error": "no_attention"})
        summary = self.server.attention.browser_summary(_midnight(), self.server.attention.clock())
        if self.server.observation_paused():
            summary.update(current=None, focused=False)
        return self._json(200, summary)

    def _attention_summary_get(self):
        return self._attention_summary(parse_qs(urlparse(self.path).query))

    def _history_get(self):
        return self._history(urlparse(self.path).path, parse_qs(urlparse(self.path).query))

    def _memory_get(self):
        url = urlparse(self.path)
        return self._memory_read(url.path, parse_qs(url.query).get("owner", [None])[0])

    def _trace_get(self, _trace_id=None):
        return self._trace_read(urlparse(self.path).path, self.route_match, parse_qs(urlparse(self.path).query))

    def _diag_state(self):
        with_text = parse_qs(urlparse(self.path).query).get("with_text", ["0"])[0] == "1"
        return self._json(200, self.server.diag_state(with_text))

    def _lines_get(self, session_id):
        return self._session_lines(session_id, parse_qs(urlparse(self.path).query))

    def _feed(self):
        feed = self.server.feed
        return self._sse(feed.since, feed.wait, stream=feed)

    def _events(self):
        registry = self.server.registry
        # Fresh subscribers get the current intent only, not history, with the turn_generation (C2 rule 8).
        intents = lambda seq: [{"seq": i["seq"], "event": i.get("event", "intent"),
                                "data": {k: v for k, v in i.items() if k != "event"}}
                               for i in registry.intents_since(seq)]

        def current():
            # Spatial publishes under its lock and then the registry lock.
            with self.server.spatial._lock, registry.cv:
                behaviors, reactions = self.server.spatial.running(), self.server.spatial.reactions()
                registry.tick()
                return {**registry.current_intent, "seq": registry.intent_seq, "turn_generation": self.server.turn_generation,
                        "behaviors": behaviors, "consumed": self.server.spatial.consumed.ids(),
                        "stage": self.server.spatial.stage_level(),
                        **({} if reactions is None else {"reactions": reactions})}

        self._sse(intents, registry.wait_for_intent, snapshot=current)

    # POST actions; all but the two below get the body _post read

    def _hooks_disconnect(self):
        try:
            body = self._body()
        except ValueError:
            return self._json(400, {"error": "invalid_payload"})
        if not isinstance(body, dict) or set(body) != {"target"} or body.get("target") not in ("claude", "codex"):
            return self._json(400, {"error": "invalid_target"})
        target = body["target"]
        hook_file = self.server.hook_files.get(target)
        if hook_file is None:
            return self._json(503, {"error": "hook_file_unavailable", "detail": self._hook_detail("hook_file_unavailable")})
        try:
            with self.server._hook_edit_lock:
                result = install_hooks.disconnect(hook_file, f"http://127.0.0.1:{self.server.server_port}")
                self.server._hook_installed.pop(hook_file, None)
        except install_hooks.Refused:
            return self._json(409, {"error": "hook_settings_unreadable_or_changed",
                                    "detail": self._hook_detail("hook_settings_unreadable_or_changed")})
        except OSError:
            return self._json(500, {"error": "hook_settings_write_failed", "detail": self._hook_detail("hook_settings_write_failed")})
        return self._json(200, {"target": target, **result})

    def _hook_detail(self, error):
        return HOOK_DETAILS.get(self.server.reply_language_code(), HOOK_DETAILS["zh-Hans"])[error]

    def _privacy_sync(self):
        try:
            body = self._body()
        except ValueError:
            return self._json(400, {"error": "invalid_payload"})
        if not isinstance(body, dict) or set(body) - {"revoke", "dry_run"} or \
                not isinstance(body.get("revoke", []), list) or \
                any(kind not in ("window_text", "page_text", "screenshots", "typed_text", "agent_sessions")
                    for kind in body.get("revoke", [])) or not isinstance(body.get("dry_run", False), bool):
            return self._json(400, {"error": "invalid_payload"})
        if body.get("dry_run"):
            return self._json(200, {"dry_run": True, "counts": self.server.privacy_preview(body.get("revoke", []))})
        permissions, epoch = self.server.sync_privacy(body.get("revoke", []))
        return self._json(200, {"permissions": permissions, "consent_epoch": epoch})

    def _hook_post(self, body):
        path = urlparse(self.path).path
        try:
            event = NORMALIZERS[path](body)
        except (ValueError, TypeError, AttributeError) as e:
            return self._json(400, {"error": str(e) if isinstance(e, ValueError) else "invalid_payload"})
        self._hook(path, event, body)

    def _say_post(self, body):
        return self._idempotent(lambda: self._say(body), body)

    def _session_post(self, *_groups, body):
        return self._sessions_post(self.route_match, body)

    def _context_capture(self, body):
        """POST /context/text, /context/image and /look."""
        path = urlparse(self.path).path
        if self.server.capture is None:
            return self._json(503, {"error": "no_attention"})
        if path == "/look":
            return self._json(*self.server.look())
        return self._context_text(body) if path == "/context/text" else self._context_image(body)

    def _fact_post(self, *_groups, body):
        return self._memory_post(self.route_match, body)

    def _blacklist_defaults_post(self, body):
        return self._blacklist_defaults()

    def _tap(self, body):
        count = body.get("count", 1) if isinstance(body, dict) else 1
        if type(count) is not int or not 1 <= count <= 20:
            return self._json(400, {"error": "invalid_payload", "field": "count"})
        region = body.get("region") if isinstance(body, dict) else None
        if region is not None and not (isinstance(region, str) and region in TAP_REGION_TEXT):
            print(f"agentd: /interaction/tap region ignored: {type(region).__name__}", file=sys.stderr)
            region = None
        if not plugins.on("light_ai"):
            return self._json(200, {"kind": None})
        return self._json(*self.server.tap(count, region=region))

    def _gift(self, body):
        return self._json(*self.server.gift(body))

    def _focus_post(self, body):
        if not isinstance(body, dict) or set(body) != {"minutes"} or type(body["minutes"]) is not int:
            return self._json(400, {"error": "invalid_payload", "field": "minutes"})
        try:
            return self._json(200, {"focus": self.server.focus_start(body["minutes"])})
        except ValueError as error:
            return self._json(400 if str(error) == "invalid_minutes" else 409, {"error": str(error)})

    def _model_post(self, body):
        return self._models_post(urlparse(self.path).path, body)

    def _switch_post(self, body):
        return self._switch(urlparse(self.path).path, body)

    def _task_post(self, task_id, verdict, body):
        return self._task_review(task_id, verdict)

    # PUT, PATCH and DELETE actions

    def _observation_mode_put(self):
        return self._observation_put(urlparse(self.path).path)

    def _memory_paused_put(self):
        found = self._memory_body()
        if found is None:
            return
        memory, body = found
        paused = body.get("paused") if isinstance(body, dict) else None
        if not isinstance(paused, bool):
            return self._json(400, {"error": "invalid_payload"})
        memory.set_paused(paused)
        self._json(200, {"paused": paused})

    def _fact_patch(self, fact_id):
        found = self._memory_body()
        if found is None:
            return
        memory, body = found
        text = _fact_text(body)
        if text is None:
            return self._json(400, {"error": "invalid_text"})
        if not isinstance(body, dict) or type(body.get('expected_version')) is not int:
            return self._json(400, {'error':'expected_version_required'})
        from personal.memory import VersionConflict
        try:
            version = memory.correct(fact_id, text, expected_version=body['expected_version'])
        except VersionConflict as error:
            return self._json(409, {'error':'version_conflict', 'current_version':error.current_version})
        except KeyError:
            return self._json(404, {"error": "unknown_fact"})
        self.server._memory_changed(fact_id)
        self._json(200, {"version": version})

    def _memory_remove(self, _fact_id=None):
        return self._memory_delete(self.route_match)

    def _episode_remove(self, episode_id):
        return self._episode_delete(int(episode_id))

    def _character_state_delete(self):
        try:
            body = self._body()
        except ValueError:
            body = None
        expected = body.get("character_id") if isinstance(body, dict) else None
        if not isinstance(expected, str) or not expected:
            return self._json(400, {"error": "invalid_character_id"})
        status, reply = self.server.reset_character_state(expected)
        return self._json(status, reply)

    def _focus_delete(self):
        if not self.server.focus_stop():
            return self._json(409, {"error": "no_focus"})
        return self._json(200, {"focus": None})

    def _history_delete(self):
        if self.server.history is None:
            return self._json(503, NO_HISTORY)
        return self._json(200, {"deleted": self.server.clear_history()})

    def _attention_delete(self):
        if self.server.attention is None:
            return self._json(503, {"error": "no_attention"})
        if self.server.capture is not None:
            self.server.capture.clear()
        trace = self.server.trace  # T1: trace events are cleared with the attention records
        deleted = self.server.attention.clear()
        if self.server.timeline is not None:
            self.server.timeline.clear()
        self.server.forget_user_state()
        if self.server.episodes is not None:
            self.server.episodes.clear()
            self.server._forget_derived(None)
            checkpoint(self.server.episodes)
        any(self.server._context_changed(kind) for kind in SEEN)
        with self.server._write_lock:  # what was written before the +1 is cleared, what comes after it is not stored
            self.server.trace_generation += 1
            trace_deleted = trace.clear() if trace is not None else 0
        if trace is not None:
            checkpoint(trace)
        self._json(200, {"deleted": deleted, "trace_deleted": trace_deleted})

    def _idempotent(self, run, body):
        """With an Idempotency-Key, a repeat of the same request gets the first answer and runs nothing.
        run() gives the (code, body) answer."""
        key = self.headers.get("Idempotency-Key")
        if key is None:
            return self._json(*run())
        if not 0 < len(key) <= IDEMPOTENCY_KEY_MAX:
            return self._json(400, {"error": "invalid_idempotency_key"})
        # A digest, so the request text (a /say text) never reaches the store.
        request = hashlib.sha256(json.dumps([self.path, body], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        server = self.server
        with server._receipts_lock:
            receipt = server._receipts.get(key)
            if receipt is None:
                receipt = server._receipts[key] = {"request": request, "done": threading.Event(), "answer": None}
                while len(server._receipts) > RECEIPTS_KEPT:
                    server._receipts.popitem(last=False)
                first = True
            else:
                first = False
        if receipt["request"] != request:
            return self._json(409, {"error": "idempotency_conflict"})
        if first:
            try:
                receipt["answer"] = run()
            finally:
                receipt["done"].set()
            # 这一轮不记: even a digest of a short private text could be matched against guesses.
            if server.receipts_db is not None and not (isinstance(body, dict) and body.get("no_memory") is True):
                with server._receipts_lock, server.receipts_db as db:
                    db.execute("INSERT OR REPLACE INTO idempotency_receipts (key, request, answer, at)"
                               " VALUES (?, ?, ?, ?)",
                               (key, request, json.dumps(receipt["answer"], ensure_ascii=False), time.time()))
                    db.execute("DELETE FROM idempotency_receipts WHERE rowid NOT IN"
                               " (SELECT rowid FROM idempotency_receipts ORDER BY rowid DESC LIMIT ?)", (RECEIPTS_KEPT,))
        receipt["done"].wait()
        self._json(*(receipt["answer"] or (500, {"error": "internal"})))

    def _sse(self, since, wait, snapshot=None, stream=None):
        """Stream since(seq) items as `id: seq / event: <event>`; resume via Last-Event-ID.
        stream: the buffer (/feed) whose ids are `<stream_epoch>-<seq>`, sent after a `stream` item and any
        `reset` / `gap`."""
        try:
            raw = self.headers.get("Last-Event-ID") or parse_qs(urlparse(self.path).query).get("after", [None])[0]
            if stream is None:
                seq = int(raw) if raw is not None else None
            else:
                seq, state, problem = self._stream_cursor(stream, raw)
        except ValueError:
            return self._json(400, {"error": "invalid_cursor"})
        # Fix the cursor before the headers go out: a client may publish as soon as it sees them.
        current = snapshot() if seq is None else None
        if current is not None:
            seq = current["seq"]
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            if current is not None:
                self.wfile.write(("event: snapshot\ndata: " + json.dumps(current) + "\n\n").encode())
            if stream is not None:
                for event, data in [("stream", state)] + ([problem] if problem else []):
                    self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
            while True:
                for item in since(seq):
                    ident = item["seq"] if stream is None else f"{stream.stream_epoch}-{item['seq']}"
                    self.wfile.write((f"id: {ident}\nevent: {item['event']}\ndata: "
                                      + json.dumps(item["data"], ensure_ascii=False) + "\n\n").encode())
                    seq = item["seq"]
                self.wfile.write(b": heartbeat\n\n")
                self.wfile.flush()
                wait(seq, 10)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
