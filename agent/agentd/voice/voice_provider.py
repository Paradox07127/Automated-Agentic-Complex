"""Where agentd's voice (TTS) comes from, and the state of that voice as a pure state machine.

`step` and `observe` are pure; a VoiceProvider holds the current VoiceState and applies them."""
from dataclasses import dataclass, replace
import http.client
import threading
import time

from voice.speech import SpeechRelay
from infra.service_ensure import ServiceEnsurer

STATES = ("unknown", "probing", "ready", "cold", "unreachable", "off")
IDLE = 600.0  # seconds; ws stops the TTS after TTS_IDLE_S (local tool `tts_ondemand.sh`, not in the public repo), so an older success predicts `cold`
_READY = ("ensure_ready", "speech_complete", "speech_cancelled", "probe_ready")
PROBE_TIMEOUT = 3.0  # seconds for the startup GET <tts_url>/health


@dataclass(frozen=True)
class VoiceState:
    provider: str  # "remote-ws" | "none"
    state: str  # one of STATES
    reason: str | None  # "not_configured" | "start_failed" | a speech failure code | "ensure:<first line>"
    since: float  # monotonic time of the last state change
    last_ok: float | None  # monotonic time of the last success
    retry_after: float | None  # monotonic end of the ensurer's negative cache, as the ensurer reported it

    def wire(self, now):
        left = None if self.retry_after is None or self.retry_after <= now else round(self.retry_after - now, 1)
        return {"provider": self.provider, "state": self.state, "reason": self.reason, "retry_after_s": left}


def step(s, event, now, reason=None, retry_after=None):
    """The state after `event` at `now`; `reason` is the failure code or ensure line, `retry_after` the ensurer's."""
    if s.state == "off":
        return s
    if event == "ensure_started":
        return _to(s, "probing", now, reason=None, retry_after=None)
    if event in _READY:
        clears = {"retry_after": None} if event == "ensure_ready" else {}
        return _to(s, "ready", now, reason=None, last_ok=now, **clears)
    if event == "ensure_failed":
        return _to(s, "unreachable", now, reason=f"ensure:{reason}", retry_after=retry_after)
    if event == "speech_failed":
        return _to(s, "unreachable", now, reason=reason)
    if event == "reset":
        return _to(s, "unknown", now, reason=None, retry_after=None)
    if event == "probe_started":
        return _to(s, "probing", now, reason=None)
    if event == "probe_cold":
        return _to(s, "cold", now, reason=f"probe:{reason}")
    if event == "probe_unreachable":
        return _to(s, "unreachable", now, reason=f"probe:{reason}")
    return s


def observe(s, now, idle=IDLE):
    """The state at `now` after the clock rules: a success older than `idle` (None: never) turns ready into cold;
    a past retry_after clears."""
    if idle is not None and s.state == "ready" and s.last_ok is not None and now - s.last_ok > idle:
        s = replace(s, state="cold", since=s.last_ok + idle)
    if s.retry_after is not None and now > s.retry_after:
        s = replace(s, retry_after=None)
    return s


def _to(s, state, now, **changes):
    return replace(s, state=state, since=s.since if state == s.state else now, **changes)


def _shown(s):
    return s.provider, s.state, s.reason, s.retry_after


class VoiceProvider:
    """One voice source: its state, its SpeechRelay (None means text only) and its ServiceEnsurer (None when none)."""
    name = ""
    idle = IDLE
    ensurer = None
    on_change = None  # callable(VoiceState), called once per change of what wire() shows

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self._lock = threading.Lock()
        self._state = self._initial(clock())

    def _initial(self, now):
        return VoiceState(self.name, "unknown", None, now, None, None)

    def state(self):
        return self._apply(lambda s, now: s)

    def relay(self):
        return None

    def on_speech(self, kind, attrs):
        """SpeechRelay events as server.on_speech_event receives them."""
        if kind == "speech.failed":
            self._apply(lambda s, now: step(s, "speech_failed", now, reason=attrs.get("reason")))
        elif kind == "speech.finished":
            event = "speech_cancelled" if attrs.get("cancelled") else "speech_complete"
            self._apply(lambda s, now: step(s, event, now))

    def reset(self, why):
        self._apply(lambda s, now: step(s, "reset", now))

    def _apply(self, change):
        with self._lock:
            now = self.clock()
            before = self._state
            self._state = after = observe(change(observe(before, now, self.idle), now), now, self.idle)
        if self.on_change is not None and _shown(after) != _shown(before):
            self.on_change(after)
        return after


class NoVoice(VoiceProvider):
    """No TTS: always off and text only; `reason` is "not_configured" or "start_failed"."""
    name = "none"

    def __init__(self, reason="not_configured", clock=time.monotonic):
        self.reason = reason
        super().__init__(clock)

    def _initial(self, now):
        return VoiceState(self.name, "off", self.reason, now, None, None)


class RemoteWsVoice(VoiceProvider):
    """The ws TTS: a SpeechRelay, plus the ServiceEnsurer that starts it on demand when one is given."""
    name = "remote-ws"

    def __init__(self, speech, ensurer=None, clock=time.monotonic):
        super().__init__(clock)
        self.speech, self.ensurer = speech, ensurer
        if ensurer is not None:
            ensurer.on_change = self._on_ensure

    def relay(self):
        return self.speech

    def reset(self, why):
        if self.ensurer is not None:
            self.ensurer.clear_negative()
        super().reset(why)

    def probe(self):
        """GET <tts_url>/health in a background thread, which it returns: ready on 200; otherwise cold when the
        ensurer can start the TTS, unreachable without one. Leaves the ensurer's negative cache alone."""
        self._apply(lambda s, now: step(s, "probe_started", now))
        thread = threading.Thread(target=self._probe, daemon=True)
        thread.start()
        return thread

    def _probe(self):
        speech, why = self.speech, None
        connection = http.client.HTTPSConnection if speech.scheme == "https" else http.client.HTTPConnection
        conn = connection(speech.host, speech.port, timeout=PROBE_TIMEOUT)
        headers = {"Authorization": f"Bearer {speech.token}"} if speech.token else {}
        try:
            conn.request("GET", f"{speech.base}/health", headers=headers)
            response = conn.getresponse()
            response.read()
            if response.status != 200:
                why = f"http_{response.status}"
        except (OSError, http.client.HTTPException) as e:
            why = type(e).__name__
        finally:
            conn.close()
        event = "probe_ready" if why is None else "probe_cold" if self.ensurer is not None else "probe_unreachable"
        self._apply(lambda s, now: step(s, event, now, reason=why))

    def _on_ensure(self, event, why, retry_after):
        self._apply(lambda s, now: step(s, event, now, reason=why, retry_after=retry_after))


def make_provider(args, bindings, epoch, token):
    """The provider agentd's arguments ask for: no --tts-url means NoVoice("not_configured")."""
    if not args.tts_url:
        return NoVoice("not_configured")
    voice, language = bindings.voice(args.character) or (args.character, "zh")
    ensurer = None
    if args.tts_ensure_host and args.tts_ensure_script:
        ensurer = ServiceEnsurer("tts", args.tts_ensure_host, args.tts_ensure_script)
    speech = SpeechRelay(args.tts_url, epoch, character=voice, language=language, token=token, ensurer=ensurer)
    return RemoteWsVoice(speech, ensurer)
