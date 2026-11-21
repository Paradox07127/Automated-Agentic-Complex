"""POST /say, /speech/cancel, /speech/playback, /turn/cancel, /feedback and /voice/reset, and GET /speech."""
import json
import os
from urllib.parse import parse_qs, urlparse

from daemon.constants import FEEDBACK, MAX_SAY
from infra.tokens import write_secret
from voice.speech import REASONS, endpoint
from api.views import _is_dir
from voice.voice_provider import RemoteWsVoice
from voice.voice_test import check

PLAYBACK_STATES = ("started", "buffering", "resumed", "ended", "interrupted", "failed", "degraded")
SURFACES = ("quick_input", "bubble_reply", "thought_offer", "chat")


class SpeechMixin:
    def _say(self, body):
        """(code, body) of one /say."""
        text = body.get("text") if isinstance(body, dict) else None
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_SAY:
            return 400, {"error": "invalid_text"}
        source = body.get("source", "text")
        if source not in ("text", "voice"):
            return 400, {"error": "invalid_source"}
        look = body.get("look", False)
        if not isinstance(look, bool):
            return 400, {"error": "invalid_look"}
        cwd = body.get("cwd")
        if cwd is not None and not (_is_dir(cwd) and os.path.isabs(cwd)):
            return 400, {"error": "invalid_payload", "field": "cwd"}
        verify_cmd = body.get("verify_cmd")
        if verify_cmd is not None and not isinstance(verify_cmd, str):
            return 400, {"error": "invalid_payload", "field": "verify_cmd"}
        voice_timing = body.get("voice_timing")
        if voice_timing is not None:
            keys = ("pressed_ms", "released_ms", "final_ms")
            marks = [voice_timing.get(k) for k in keys] if isinstance(voice_timing, dict) else []
            if source != "voice" or len(marks) != 3 \
                    or not all(isinstance(m, int) and not isinstance(m, bool) and m > 0 for m in marks) \
                    or not marks[0] <= marks[1] <= marks[2]:
                return 400, {"error": "invalid_payload", "field": "voice_timing"}
            voice_timing = dict(zip(keys, marks))
        surface = body.get("surface")
        if surface is not None and surface not in SURFACES:
            return 400, {"error": "invalid_payload", "field": "surface"}
        quote = body.get("quote")
        if quote is not None:
            if not isinstance(quote, dict) or not set(quote) <= {"text", "app"} \
                    or not isinstance(quote.get("text"), str) or not quote["text"].strip() or len(quote["text"]) > MAX_SAY \
                    or not isinstance(quote.get("app"), (str, type(None))):
                return 400, {"error": "invalid_payload", "field": "quote"}
            quote = {"text": quote["text"], "app": quote.get("app")}
        reply_to = body.get("reply_to")
        if reply_to is not None and (not isinstance(reply_to, dict) or set(reply_to) != {"kind", "id"}
                                     or reply_to["kind"] not in ("line", "thought")
                                     or not isinstance(reply_to["id"], str) or not reply_to["id"]):
            return 400, {"error": "invalid_payload", "field": "reply_to"}
        look_window = body.get("look_window")
        positive = lambda value: isinstance(value, int) and not isinstance(value, bool) and value > 0  # noqa: E731
        if look_window is not None and (look or not isinstance(look_window, dict)
                                        or not set(look_window) <= {"window_id", "pid"}
                                        or not positive(look_window.get("window_id"))
                                        or "pid" in look_window and not positive(look_window["pid"])):
            return 400, {"error": "invalid_payload", "field": "look_window"}
        from character_agent.routes.http import validate_say
        try:
            options = validate_say(body)
        except ValueError as error:
            return 400, {"error": str(error)}
        return self.server.say(text, source, body.get("no_memory") is not True, look, cwd, verify_cmd,
                               voice_timing=voice_timing, surface=surface, quote=quote, reply_to=reply_to,
                               look_window=look_window, **options)

    def _speech_cancel(self, body):
        relay = self.server.speech
        if relay is None:
            return self._json(503, {"error": "no_tts"})
        if not isinstance(body, dict):
            return self._json(400, {"error": "invalid_payload"})
        speech_id = body.get("speech_id")
        reason = body.get("reason", "client_cancel")
        barge_in = reason == "barge_in"
        if barge_in:
            reason = "client_cancel"  # C2 `cancelled` has no barge_in reason
        if "speech_id" not in body:
            if reason not in REASONS:
                return self._json(400, {"error": "invalid_payload"})
            if barge_in:  # the user talks over her: the whole turn ends, the line still being generated too
                cut = any(self.server.cancel_turn(self.server._keeping("barge_in"))[2].values())
            else:
                cut = self.server._cut("tap", reason=reason)[2]["speech"]
            if not cut:
                return self._json(404, {"error": "no_speech"})
            return self._json(202, {"ok": True})
        if not isinstance(speech_id, str) or reason not in REASONS:
            return self._json(400, {"error": "invalid_payload"})
        utterance_id = relay.utterance_of(speech_id)
        voiced = (relay.turn_of(speech_id), utterance_id, None) if utterance_id is not None else None
        result = relay.cancel_speech(speech_id, reason)
        if result == "unknown":
            return self._json(404, {"error": "unknown_speech"})
        if result == "ended":
            return self._json(409, {"error": "already_ended"})
        self.server._speech_cancelled(speech_id, reason)
        self.server._dropped(voiced)
        self._json(202, {"ok": True})

    def _speech_playback(self, body):
        if self.server.speech is None:
            return self._json(503, {"error": "no_speech"})
        short = lambda value: isinstance(value, str) and 0 < len(value.encode()) <= 64  # noqa: E731
        count = lambda value: isinstance(value, int) and not isinstance(value, bool) and value >= 0  # noqa: E731
        if not isinstance(body, dict) or not short(body.get("speech_id")) \
                or not (body.get("clause_id") is None or isinstance(body["clause_id"], str)) \
                or body.get("state") not in PLAYBACK_STATES or not count(body.get("sample")) \
                or not count(body.get("rate")) or body["rate"] == 0 \
                or body["state"] in ("interrupted", "failed", "degraded") and not short(body.get("reason")):
            return self._json(400, {"error": "invalid_payload"})
        applied, why = self.server.playback(body["speech_id"], body["state"], body["sample"], body["rate"],
                                            body.get("reason"))
        self._json(200, {"applied": applied, "why": why})

    def _turn_cancel(self, body):
        generation = body.get("generation") if isinstance(body, dict) else None
        line_id = body.get("line_id") if isinstance(body, dict) else None
        if not isinstance(body, dict) or body.get("reason") not in ("barge_in", "client_cancel") \
                or not (generation is None or isinstance(generation, int) and not isinstance(generation, bool)) \
                or not (line_id is None or isinstance(line_id, str) and 0 < len(line_id.encode()) <= 64):
            return self._json(400, {"error": "invalid_payload"})
        result = self.server.cancel_turn(self.server._keeping(body["reason"]), generation, line_id)
        if result[0] == "stale_line":
            return self._json(409, {"error": "stale_line"})
        if result[0] == "stale":
            return self._json(409, {"error": "stale_generation", "generation": result[1]})
        self._json(202, {"generation": result[1], "cancelled": result[2]})

    def _feedback(self, body):
        line_id = body.get("line_id") if isinstance(body, dict) else None
        if not isinstance(line_id, str) or not 0 < len(line_id.encode()) <= 64 or body.get("value") not in FEEDBACK \
                or not isinstance(body.get("mute", False), bool):
            return self._json(400, {"error": "invalid_payload"})
        if not self.server.feedback(line_id, body["value"], body.get("mute", False)):
            return self._json(404, {"error": "unknown_line"})
        self._json(200, {})

    def _speech(self):
        """C2 NDJSON for the avatar host: a `stream.hello` line, then lines from now on (or after ?after=) with their
        `stream_seq`; blank-line heartbeat every 10 s."""
        relay = self.server.speech
        if relay is None:
            return self._json(503, {"error": "no_tts"})
        after = parse_qs(urlparse(self.path).query).get("after", [None])[0]
        try:  # before the headers, as in _sse
            seq, state, problem = self._stream_cursor(relay, after)
        except ValueError:
            return self._json(400, {"error": "invalid_cursor"})
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with self.server._diag_lock:
            self.server.speech_readers += 1
        try:
            controls = [{"event": "stream.hello", **state}]
            if problem:
                controls.append({"event": f"stream.{problem[0]}", **problem[1]})
            for line in controls:
                self.wfile.write((json.dumps(line) + "\n").encode())
            while True:
                for item in relay.since(seq):
                    self.wfile.write((json.dumps({**item["data"], "stream_seq": item["seq"]}, ensure_ascii=False)
                                      + "\n").encode())
                    seq = item["seq"]
                self.wfile.flush()
                relay.wait(seq, 10)
                if not relay.since(seq):
                    self.wfile.write(b"\n")
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with self.server._diag_lock:
                self.server.speech_readers -= 1

    def _voice_reset(self):
        """POST /voice/reset: forget the voice's failures and probe a remote-ws voice again; {"tts": wire}."""
        voice = self.server.voice
        voice.reset("user")
        if isinstance(voice, RemoteWsVoice):
            voice.probe()
        self._json(200, {"tts": voice.state().wire(voice.clock())})

    def _voice_test(self, body):
        if not isinstance(body, dict) or any(key in body and not isinstance(body[key], str)
                                             for key in ("url", "token")):
            return self._json(400, {"error": "invalid_payload"})
        relay = self.server.speech
        if relay is None:
            return self._json(503, {"error": "no_tts"})
        host = f"[{relay.host}]" if ":" in relay.host else relay.host
        url = body.get("url", f"{relay.scheme}://{host}:{relay.port}{relay.base}")
        try:
            parts = endpoint(url)
            own = (parts.scheme, parts.hostname, parts.port or (443 if parts.scheme == "https" else 80)) == \
                (relay.scheme, relay.host, relay.port)
        except ValueError:
            own = False
        # The saved token goes only to the address it was saved for; another address gets the caller's token or none.
        self._json(200, check(url, body.get("token", relay.token if own else None), relay.character, relay.language))

    def _voice_token(self, body):
        token = body.get("token") if isinstance(body, dict) else None
        if not isinstance(token, str) or not token.strip():
            return self._json(400, {"error": "invalid_token"})
        token = token.strip()
        write_secret(self.server.tts_token_file, token)
        if self.server.speech is not None:
            self.server.speech.token = token
        self._json(200, {"ok": True})
