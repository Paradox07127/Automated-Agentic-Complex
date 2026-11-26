"""C2 speech relay:agentd is the only ws TTS client and forwards each stream to the avatar host.

Only session_epoch, turn_id and speech_id are rewritten, and in a clause's begin turn_generation and trace_id.
A stream that agentd cuts short (cancel, superseded, upstream drop) is closed with one synthesized
`cancelled` line, so the avatar host always sees an end."""
from collections import OrderedDict, deque
import http.client
import json
import re
import secrets
import socket
import threading
import time
from urllib.parse import urlsplit
import uuid

# How long the renderer may keep applying a speech's lines; covers synthesis plus playback of one line.
EXPIRES_MS = 120_000
# Seconds a TTS host gets to accept the connection: a host that is away answers nothing, and the line waits this long.
CONNECT_S = 5
# Seconds without a byte from a connected TTS before its stream counts as lost.
STREAM_S = 120
ENDS = ("complete", "cancelled")
EVENTS = ("speech.begin", "segment", "audio", "cues") + ENDS
REASONS = ("client_cancel", "superseded", "error")
# Recent speeches kept for cancel-by-id.
HISTORY = 256
SAMPLE_RATE = 48000  # C2 clock
PLAYING = ("started", "buffering", "resumed", "degraded")  # renderer receipts that leave the speech playing
OVER = ("ended", "interrupted", "failed", "unknown")
# The renderer sends receipts only on a change, so a silent one may still play its rest: wait that plus this slack
# (a buffering stall, the Companion hop) before taking the renderer as lost.
RECEIPT_STALE = 10.0
SPOKEN_LIMIT = 50  # characters; a longer line is shown whole but only its start is voiced (user, round 20)
CUT_POLL = 0.25  # seconds; the longest a cut waits to end a wait on the ensure or on the utterance before
_FIRST = re.compile(r"^.*?(?:[。！？!?]+|…+)")


def spoken_part(text, limit=SPOKEN_LIMIT):
    """The part of a line that goes to TTS: all of it up to limit, else the first sentence, cut at a comma if long."""
    if len(text) <= limit:
        return text
    first = _FIRST.match(text)
    if first and len(first.group()) <= limit:
        return first.group()
    comma = text.rfind("，", 0, limit)
    return text[:comma + 1] if comma > 0 else text[:limit]


def _line(raw, last_seq):
    """One TTS stream line once it is a C2 line that follows last_seq; ValueError otherwise."""
    line = json.loads(raw)
    if not isinstance(line, dict) or line.get("event") not in EVENTS or type(line.get("seq")) is not int \
            or line["seq"] != (0 if last_seq is None else last_seq + 1):
        raise ValueError("not the next C2 line")
    count = {"audio": "samples", "complete": "total_samples"}.get(line["event"])
    if count is not None and (type(line.get(count)) is not int or line[count] < 0):
        raise ValueError(f"{count} is not a sample count")
    return line


class _Speech:
    def __init__(self, turn_id, speech_id, generation=None, text=""):
        self.turn_id, self.speech_id = turn_id, speech_id
        self.generation = generation  # turn_generation it was spoken for; None is never compared
        self.text = text  # what went to synthesis
        self.reason = None  # set when agentd cuts the stream: client_cancel | superseded
        self.interrupted = False  # cancel() or a user's interrupted receipt hit it, during or after synthesis
        self.playback_end = None  # clock time the renderer should finish: first audio + total_samples / SAMPLE_RATE
        self.sent_samples = 0  # forwarded to the renderer so far
        self.total_samples = None  # from `complete`
        self.generated_at = None  # clock time of `complete` (generated_complete)
        self.played = None  # the renderer's latest receipt state, `unknown` once it is lost; None before any
        self.played_samples = 0  # on the C2 clock
        self.receipt_at = None
        self.playback_ended_at = None  # clock time of the `ended` receipt (playback_ended)
        self.sock = None
        self.done = threading.Event()
        self.v2 = None  # a clause's request fields; None for a whole line from speak()
        self.after = None  # the clause before it, which the renderer plays first
        self.state = None  # ready | failed | cancelled once over; cancelled also when a clause_end cut drops it
        self.keep = False  # a clause_end cut lets this stream run to its end whatever the generation


class _Utterance:
    def __init__(self, utterance_id, turn_id, generation, trace_id, policy, voice_profile_id):
        self.utterance_id, self.turn_id, self.generation = utterance_id, turn_id, generation
        self.trace_id, self.policy, self.voice_profile_id = trace_id, policy, voice_profile_id
        self.clauses = []  # _Speech per clause, in clause_index order
        self.queue = deque()  # clauses not requested yet
        self.closed = False  # end_utterance: no more clauses come
        self.stopped = None  # why its clauses are no longer requested
        self.finished = threading.Event()  # its worker is gone: the TTS is free for the next utterance
        self.waits_on = None  # the utterance before, when this one was stopped before that one finished


def endpoint(tts_url):
    """urlsplit(tts_url) of a usable TTS address: http or https, without user information."""
    parts = urlsplit(tts_url)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password \
            or re.search(r"[\x00-\x20\x7f]", parts.hostname):
        raise ValueError("TTS URL must be an http:// or https:// endpoint without user information")
    return parts


class SpeechRelay:
    def __init__(self, tts_url, epoch, character, language, buffer=512, clock=time.monotonic, token=None,
                 ensurer=None):
        """character, language: the TTS voice of the character on screen (its card's tts block).
        token: the TTS service's bearer token; None sends no Authorization header.
        ensurer: a ServiceEnsurer that starts the TTS when it is unreachable; None reports unreachable at once."""
        parts = endpoint(tts_url)
        self.scheme = parts.scheme
        self.host, self.port, self.base = parts.hostname, parts.port or (443 if parts.scheme == "https" else 80), parts.path.rstrip("/")
        self.epoch = str(epoch)
        self.character, self.language = character, language
        self.token = token
        self.ensurer = ensurer
        self.cv = threading.Condition()
        self.items = deque(maxlen=buffer)
        self.seq = 0
        self.stream_epoch = secrets.token_hex(4)  # names this buffer in `<stream_epoch>-<stream_seq>` cursors
        self._current = None
        self._speeches = OrderedDict()
        self._lock = threading.Lock()
        self._wake = threading.Condition(self._lock)  # an utterance got a clause, was ended or stopped
        self._utterance = None  # the latest begin_utterance
        self._utterances = OrderedDict()
        self.clock = clock
        self.generation = None  # agentd's current turn_generation; None compares nothing
        self.on_event = None  # T1 trace: callable(kind, speech_id, attrs); whatever it raises is dropped

    def speak(self, turn_id, text, generation=None):
        """Start a new speech for a finished line; a running one ends as superseded first."""
        stopped = []
        with self._lock:
            self._stop(self._current, "superseded", stopped)
            speech = self._current = _Speech(turn_id, secrets.token_hex(6), generation, text)
            self._speeches[speech.speech_id] = speech
            while len(self._speeches) > HISTORY:
                self._speeches.popitem(last=False)
        self._settle(stopped)
        threading.Thread(target=self._run, args=(speech, text), daemon=True).start()
        return speech.speech_id

    def begin_utterance(self, turn_id, generation=None, trace_id=None, interrupt_policy="immediate"):
        """Open a line spoken clause by clause; the previous one ends by its own interrupt_policy."""
        utterance = _Utterance(secrets.token_hex(6), turn_id, generation, trace_id or str(uuid.uuid4()),
                               interrupt_policy, f"{self.character}.{self.language}.default")
        stopped = []
        with self._lock:
            before = self._utterance
            if before is not None:
                self._end(before, "superseded", stopped)
            self._utterance = utterance
            self._utterances[utterance.utterance_id] = utterance
            while len(self._utterances) > HISTORY:
                self._utterances.popitem(last=False)
        self._settle(stopped)
        threading.Thread(target=self._work, args=(utterance, before), daemon=True).start()
        return utterance.utterance_id

    def add_clause(self, utterance_id, text):
        """Queue the utterance's next clause: its speech_id, None once the utterance was ended or stopped."""
        with self._lock:
            utterance = self._utterances[utterance_id]
            if utterance.closed or utterance.stopped:
                return None
            index = len(utterance.clauses)
            speech = _Speech(utterance.turn_id, secrets.token_hex(6), utterance.generation, text)
            speech.after = utterance.clauses[-1] if utterance.clauses else None
            # clause_id is the utterance_id plus the index: unique within the utterance, apart from speech_id.
            speech.v2 = {"utterance_id": utterance_id, "clause_id": f"{utterance_id}.c{index}",
                         "clause_index": index, "spoken_text_revision": 1,
                         "voice_profile_id": utterance.voice_profile_id, "interrupt_policy": utterance.policy,
                         "turn_generation": utterance.generation if utterance.generation is not None else 0,
                         "trace_id": utterance.trace_id}
            utterance.clauses.append(speech)
            utterance.queue.append(speech)
            self._speeches[speech.speech_id] = speech
            while len(self._speeches) > HISTORY:
                self._speeches.popitem(last=False)
            self._wake.notify_all()
            return speech.speech_id

    def end_utterance(self, utterance_id):
        """No more clauses come; the utterance is over once the queued ones have gone out."""
        with self._lock:
            self._utterances[utterance_id].closed = True
            self._wake.notify_all()

    def cancel_utterance(self, utterance_id, reason="client_cancel", immediate=False):
        """Stop an utterance by its interrupt_policy, or as immediate whatever its policy; what _cut returns."""
        stopped = []
        try:
            with self._lock:
                return self._cut(self._utterances[utterance_id], reason, stopped, immediate)
        finally:
            self._settle(stopped)

    def utterance(self, utterance_id):
        """Snapshot of the clauses: clause_index, clause_id, speech_id, text, state (None until over),
        played (the avatar host's latest receipt state, None before any)."""
        with self._lock:
            return tuple({"clause_index": c.v2["clause_index"], "clause_id": c.v2["clause_id"],
                          "speech_id": c.speech_id, "text": c.text, "state": c.state, "played": c.played}
                         for c in self._utterances[utterance_id].clauses)

    def was_cut(self, utterance_id):
        """True when the utterance was stopped before it ran its course; False also once it left the history."""
        with self._lock:
            utterance = self._utterances.get(utterance_id)
            return utterance is not None and utterance.stopped is not None

    def heard_utterance(self, utterance_id):
        """What the user heard: the clauses the avatar host reported ended, the heard part of an interrupted one, nothing
        after it."""
        parts = []
        for clause in self._utterances[utterance_id].clauses:
            if clause.interrupted:
                parts.append(self.heard(clause.speech_id)[0])
                break
            if clause.played == "ended" or clause.keep and clause.state is None:  # a kept one is played whole
                parts.append(clause.text)
        return "".join(parts)

    def utterance_of(self, speech_id):
        speech = self._speeches.get(speech_id)
        return speech.v2["utterance_id"] if speech is not None and speech.v2 is not None else None

    def clause_of(self, speech_id):
        speech = self._speeches.get(speech_id)
        return speech.v2["clause_id"] if speech is not None and speech.v2 is not None else None

    def clause_ref(self, speech_id):
        """{utterance_id, clause_id, spoken_text_revision} of a clause, None when it is no clause."""
        speech = self._speeches.get(speech_id)
        if speech is None or speech.v2 is None:
            return None
        return {key: speech.v2[key] for key in ("utterance_id", "clause_id", "spoken_text_revision")}

    def _cut(self, utterance, reason, stopped, immediate=False):
        """The speech_id of the first clause it cut that streamed or played, True when it only stopped clauses
        still to come, False when it had nothing left to request or play."""
        live = utterance.stopped is None and not utterance.finished.is_set() \
            or any(self._playing(c) for c in utterance.clauses)
        if not live:
            return False
        cut = next((c.speech_id for c in utterance.clauses if self._playing(c)), True)
        self._end(utterance, reason, stopped, interrupt=True, immediate=immediate)
        return cut

    def _end(self, utterance, reason, stopped, interrupt=False, immediate=False):
        """No more of its clauses are requested. Under immediate (its policy, or the flag) the one streaming is
        cut too; under clause_end it streams to its end and the synthesized ones after the one playing are dropped."""
        utterance.stopped = utterance.stopped or reason
        for clause in utterance.queue:
            clause.reason, clause.state = reason, "cancelled"
            clause.done.set()
        utterance.queue.clear()
        self._wake.notify_all()
        if utterance.policy == "immediate" or immediate:
            for clause in utterance.clauses:
                if interrupt and self._playing(clause):
                    clause.interrupted = True
                self._stop(clause, reason, stopped)
            return
        streaming = self._current if self._current in utterance.clauses and not self._current.done.is_set() \
            else None
        current = next((c for c in utterance.clauses if self._playing(c)), None) or streaming
        if current is None:
            return
        if current is streaming:
            streaming.keep = True
        for clause in utterance.clauses[utterance.clauses.index(current) + 1:]:
            if clause is streaming:
                self._stop(clause, reason, stopped)
            elif clause.state == "ready":
                clause.reason, clause.state = reason, "cancelled"

    def _work(self, utterance, before):
        # The TTS synthesizes one request at a time. One stopped while it waits ends at once and hands
        # its wait on, so the utterance after it still waits for the one still synthesizing.
        while before is not None:
            if before.finished.wait(CUT_POLL):
                before = before.waits_on
            elif utterance.stopped is not None:
                utterance.waits_on = before
                break
        try:
            while True:
                with self._wake:
                    while not utterance.queue and not utterance.closed and utterance.stopped is None:
                        self._wake.wait()
                    if utterance.stopped is not None or not utterance.queue:
                        break
                    speech = self._current = utterance.queue.popleft()
                self._run(speech, speech.text)
        finally:
            utterance.finished.set()

    def cancel(self, reason="client_cancel", immediate=False):
        """Cancel the speech playing now: the speech_id cut (True when only clauses still to come were),
        False when none plays.

        Synthesis outruns playback: after `complete` the avatar host still plays its buffer until playback_end,
        so a cancel then only marks the speech interrupted (the stream has already ended).
        An utterance still being requested or played is stopped by its interrupt_policy instead,
        or as immediate when immediate is set."""
        stopped = []
        try:
            with self._lock:
                if self._utterance is not None:
                    cut = self._cut(self._utterance, reason, stopped, immediate)
                    if cut:
                        return cut
                speech = self._current
                if not self._playing(speech):
                    return False
                if not speech.done.is_set():
                    self._stop(speech, reason, stopped)
                speech.interrupted = True
                return speech.speech_id
        finally:
            self._settle(stopped)

    def busy(self):
        """True while the latest speech plays by the avatar host's receipts, or, before any, streams or is estimated to play;
        or any clause of the latest utterance is queued or does."""
        with self._lock:
            utterance = self._utterance
            return self._playing(self._current) \
                or utterance is not None and any(self._playing(c) for c in utterance.clauses)

    def played(self):
        """The avatar host's latest receipt state for the latest speech; None before any."""
        with self._lock:
            speech = self._current
            if speech is None:
                return None
            self._expire(speech)
            return speech.played

    def turn_of(self, speech_id):
        speech = self._speeches.get(speech_id)
        return speech.turn_id if speech is not None else None

    def receipt(self, speech_id, state, sample, rate, reason=None):
        """The avatar host's playback receipt: (applied, why), why one of unknown_speech, superseded, already_ended."""
        with self._lock:
            speech = self._speeches.get(speech_id)
            if speech is None:
                return False, "unknown_speech"
            # An old speech's end still settles that speech (what was heard of it); its progress is moot.
            if speech.generation is not None and self.generation is not None and not speech.keep \
                    and speech.generation != self.generation and state not in ("ended", "interrupted", "failed"):
                return False, "superseded"
            self._expire(speech)
            if speech.played in OVER:
                return False, "already_ended"
            if state == "interrupted" and reason == "connection_lost":
                state = "unknown"
            elif state == "interrupted":
                speech.interrupted = True
            speech.played, speech.receipt_at = state, self.clock()
            speech.played_samples = round(sample * SAMPLE_RATE / rate)
            if state == "ended":
                speech.playback_ended_at = speech.receipt_at
            return True, None

    def heard(self, speech_id):
        """(the part of the text the user heard, the whole text): the played share when interrupted, else all."""
        speech = self._speeches[speech_id]
        if not speech.interrupted:
            return speech.text, speech.text
        if speech.total_samples is None:  # cut while synthesizing: which part of the text was voiced is unknown
            return "", speech.text
        share = min(1.0, speech.played_samples / speech.total_samples) if speech.total_samples else 0.0
        return speech.text[:round(len(speech.text) * share)], speech.text

    def _expire(self, speech):
        if speech.played not in PLAYING:
            return
        total = speech.total_samples if speech.total_samples is not None else speech.sent_samples
        left = max(0, total - speech.played_samples) / SAMPLE_RATE
        if self.clock() > speech.receipt_at + left + RECEIPT_STALE:
            speech.played = "unknown"

    def _playing(self, speech):
        if speech is None or speech.interrupted or speech.state == "cancelled":
            return False
        if speech.played is not None:
            self._expire(speech)
            return speech.played in PLAYING
        if not speech.done.is_set():
            return True
        return not speech.reason and speech.playback_end is not None and self.clock() < speech.playback_end

    def interrupted(self):
        """turn_id of the latest utterance when a cut left part of it unsaid, else of the latest speech when
        cancel() cut it, else None."""
        with self._lock:
            utterance = self._utterance
            if utterance is not None and any(c.interrupted or c.state == "cancelled" for c in utterance.clauses):
                return utterance.turn_id
            speech = self._current
            return speech.turn_id if speech is not None and speech.interrupted else None

    def cancel_speech(self, speech_id, reason="client_cancel"):
        """Cancel one speech by id: "cancelled", "ended" (already over) or "unknown".
        A clause cuts its whole utterance as immediate."""
        stopped = []
        try:
            with self._lock:
                speech = self._speeches.get(speech_id)
                if speech is None:
                    return "unknown"
                if speech.v2 is not None:
                    live = not speech.done.is_set() or self._playing(speech)
                    if live and self._cut(self._utterances[speech.v2["utterance_id"]], reason, stopped,
                                          immediate=True):
                        return "cancelled"
                    return "ended"
                if speech.done.is_set():
                    if not self._playing(speech):
                        return "ended"
                    speech.interrupted = True  # stream over, the renderer still plays it: as cancel() does
                    return "cancelled"
                self._stop(speech, reason, stopped)
                return "cancelled"
        finally:
            self._settle(stopped)

    def reset(self):
        """Every buffered line dropped under a new stream_epoch; stream_seq keeps counting for the streams still open."""
        with self.cv:
            self.items.clear()
            self.stream_epoch = secrets.token_hex(4)

    def stream_state(self):
        """{stream_epoch, oldest_seq, latest_seq}; oldest_seq is latest_seq + 1 when nothing is held."""
        with self.cv:
            return {"stream_epoch": self.stream_epoch,
                    "oldest_seq": self.items[0]["seq"] if self.items else self.seq + 1, "latest_seq": self.seq}

    def since(self, seq):
        with self.cv:
            return [item for item in self.items if item["seq"] > seq]

    def wait(self, seq, timeout):
        with self.cv:
            if self.seq <= seq:
                self.cv.wait(timeout)

    def _stop(self, speech, reason, stopped):
        """Marks the speech cut; one that streams goes into stopped, for _settle once the lock is released."""
        if speech is None or speech.done.is_set():
            return
        speech.reason = speech.reason or reason
        if speech.sock is None:
            return  # still connecting or ensuring: the worker sees the reason when that ends, before any line
        try:
            speech.sock.shutdown(socket.SHUT_RDWR)  # unblocks the worker's read at once
        except OSError:
            pass
        stopped.append(speech)

    def _settle(self, stopped):
        for speech in stopped:
            speech.done.wait(5)  # its end line must precede the next speech.begin

    def _publish(self, line):
        with self.cv:
            self.seq += 1
            self.items.append({"seq": self.seq, "data": line})
            self.cv.notify_all()

    def _connection(self, scheme, host, port):
        # HTTPSConnection's default context verifies the peer certificate and hostname.
        connection = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
        return connection(host, port, timeout=CONNECT_S)

    def _run(self, speech, text):
        ids = {"session_epoch": self.epoch, "turn_id": speech.turn_id, "speech_id": speech.speech_id}
        expires_at_ms = int(time.time() * 1000) + EXPIRES_MS
        body = json.dumps({"character": self.character, "language": self.language, "text": text,
                           "allow_unvalidated_pilot": True, "accelerated": True, **ids, **(speech.v2 or {}),
                           "expires_at_ms": expires_at_ms}).encode()
        last_seq, sent, ended, first_audio, failure = None, 0, False, None, "empty_stream"
        conn = None
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        try:
            conn = self._connection(self.scheme, self.host, self.port)
            for retried in (False, True):
                try:
                    conn.connect()
                    conn.sock.settimeout(STREAM_S)
                    speech.sock = conn.sock
                    if speech.reason:
                        return
                    conn.request("POST", f"{self.base}/speech_stream", body, headers)
                    response = conn.getresponse()
                    break
                except OSError:
                    # Over ssh -L a stopped ws TTS shows up here, after connect() succeeded, as a dropped connection.
                    if retried or self.ensurer is None or speech.reason:
                        raise
                    speech.sock = None  # _stop leaves an ensuring worker to the reason check after it
                    self.ensurer.request()
                    deadline = time.monotonic() + min(60.0, expires_at_ms / 1000 - time.time())
                    while True:
                        step = min(CUT_POLL, max(0.0, deadline - time.monotonic()))
                        waited = time.monotonic()
                        ready = self.ensurer.wait_ready(step)
                        if speech.reason:
                            return
                        if ready:
                            break
                        # wait_ready answers False before its timeout only once the ensure ended without ready;
                        # half a step leaves room for timer slack.
                        if time.monotonic() >= deadline or time.monotonic() - waited < step / 2:
                            raise
                    conn.close()
                    conn = self._connection(self.scheme, self.host, self.port)
            if response.status != 200:
                failure = f"http_{response.status}"
                return
            for raw in response:
                if speech.generation is not None and self.generation is not None and not speech.keep \
                        and speech.generation != self.generation:
                    speech.reason = speech.reason or "superseded"
                if speech.reason:
                    break
                line = {**_line(raw, last_seq), **ids}
                if line["event"] == "speech.begin" and speech.v2 is not None:
                    line.update(turn_generation=speech.v2["turn_generation"], trace_id=speech.v2["trace_id"])
                last_seq = line["seq"]
                first = line["event"] == "audio" and first_audio is None
                if line["event"] == "audio":
                    sent += line["samples"]
                    speech.sent_samples = sent
                    first_audio = first_audio or self.clock()
                self._publish(line)
                if first:
                    self._event("speech.first_audio", speech, {})
                if line["event"] == "complete":
                    self._event("speech.finished", speech, {"total_samples": line["total_samples"]})
                elif line["event"] == "cancelled":  # the TTS ended it itself
                    self._event("speech.finished", speech, {"total_samples": sent, "cancelled": True})
                if line["event"] in ENDS:
                    if line["event"] == "complete":
                        speech.total_samples, speech.generated_at = line["total_samples"], self.clock()
                    if line["event"] == "complete" and first_audio is not None:
                        before = speech.after.playback_end if speech.after is not None else None
                        start = first_audio if before is None else max(first_audio, before)
                        speech.playback_end = start + line["total_samples"] / SAMPLE_RATE
                    ended = True
                    break
        except OSError:
            failure = "unreachable"
        except (ValueError, KeyError, http.client.HTTPException):
            failure = "bad_stream"
        finally:
            if conn is not None:
                conn.close()
            if last_seq is None and not speech.reason:
                # nothing reached /speech, so the renderer never saw a begin; the end goes out as an event.
                self._event("speech.failed", speech, {"reason": failure})
            if last_seq is not None and not ended:
                self._publish({"event": "cancelled", **ids, "seq": last_seq + 1,
                               "reason": speech.reason or "error", "last_sample_sent": sent})
                self._event("speech.finished", speech, {"total_samples": sent, "cancelled": True})
            speech.state = "ready" if speech.total_samples is not None else "cancelled" if speech.reason else "failed"
            speech.done.set()

    def _event(self, kind, speech, attrs):
        if self.on_event is None:
            return
        try:
            self.on_event(kind, speech.speech_id, attrs)
        except Exception:  # tracing never stops the relay
            pass
