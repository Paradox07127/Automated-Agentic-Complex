"""AgentdServer, the HTTP server that composes the daemon mixins, and StateView."""
from collections import OrderedDict, deque
from http.server import ThreadingHTTPServer
import json
import secrets
import threading
import time

from api.handler import Handler
from sessions.approvals import ApprovalBroker
from brain import characters
from character.character_state import INTENSITY, TIRED
from daemon.announce import AnnounceMixin
from daemon.character_switch import CharacterSwitchMixin
from daemon.constants import SPEECH_TRACES
from daemon.context import ContextMixin
from daemon.diagnostics import DiagnosticsMixin
from daemon.error_record import ErrorLog
from daemon.ingest import IngestMixin
from daemon.lifecycle import LifecycleMixin
from daemon.memory_sync import MemorySyncMixin
from daemon.rituals_glue import RitualsGlueMixin
from daemon.speech_control import SpeechControlMixin
from daemon.switches import SwitchesMixin
from daemon.tracing import TracingMixin
from daemon.turns import TurnsMixin
from character.feed import Feed
from character.focus import Focus
from character.gate import Gate
from character.interactions import preset
from character.proactive import WANT_COMMENT
from character.returning import Return
from sessions.ledger import DEFAULT_ROOT
from observation.desktop_presence import PresenceFeed
from observation.privacy import ConsentPolicy, saved_switch
from sessions.registry import Registry
from sessions.dispatch import Dispatcher
from observation.spatial import Spatial
from observation.user_now import UserNow
from observation.user_state import UserState
from traces.motion_lane import MotionLane
from traces.stage_times import StageTimes
from api.views import _iso
from voice.voice_provider import NoVoice

PROACTIVE_LINES = 64  # proactive lines POST /feedback still knows
DIAG_ITEMS = 512  # /diag/stream items kept for a reconnect


class StateView:
    """Her state as Spatial, Behavior, the Gate and the mouth read it. With affects_behavior off every event
    still reaches server.state, but each weight and factor is 1, she is neither tired nor engaged, and she has no
    labels or summary."""

    def __init__(self, server):
        self.server = server

    def __getattr__(self, name):  # on_event, advance, flush; without server.state (no character) they do nothing
        state = self.server.state
        return (lambda *_, **__: None) if state is None else getattr(state, name)

    @property
    def affects(self):
        """Without server.state (no character) she reads as with affects_behavior off."""
        return self.server.state_affects and self.server.state is not None

    def snapshot(self):
        if self.server.state is None:
            return {"character_id": None, "energy": TIRED, "valence": None, "engagement": 0.0, "activity": None,
                    "labels": None, "causes": []}
        snapshot = self.server.state.snapshot()
        if self.server.state_affects:
            return snapshot
        return {**snapshot, "energy": max(snapshot["energy"], TIRED), "engagement": 0.0}

    def labels(self):
        return self.server.state.labels() if self.affects else None

    def summary(self, user):
        return self.server.state.summary(user) if self.affects else ""

    def weights(self, kinds):
        return self.server.state.weights(kinds) if self.affects else [1.0] * len(kinds)

    def tick_scale(self):
        return self.server.state.tick_scale() if self.affects else 1.0

    def intensity_range(self):
        return self.server.state.intensity_range() if self.affects else INTENSITY

    def walk_scale(self):
        return self.server.state.walk_scale() if self.affects else 1.0

    def comment_scale(self):
        return self.server.state.comment_scale() if self.affects else 1.0

    def mood_label(self, default):
        return self.server.state.mood_label(default) if self.affects else default


class AgentdServer(AnnounceMixin, TurnsMixin, SpeechControlMixin, ContextMixin, SwitchesMixin, IngestMixin,
                   CharacterSwitchMixin, RitualsGlueMixin, MemorySyncMixin, TracingMixin, DiagnosticsMixin,
                   LifecycleMixin, ThreadingHTTPServer):
    state_dir = None
    daemon_threads = True
    # A page opens several independent reads at once. Buffer that burst until accept() catches up.
    request_queue_size = max(32, ThreadingHTTPServer.request_queue_size)
    no_character = False  # main(): the library has no character; api.handler.CHARACTER_ROUTES answer 409 no_character

    @property
    def trace(self):
        return self._trace_store

    @trace.setter
    def trace(self, store):
        self._trace_store = store
        if store is not None and hasattr(store, "db"):
            # main() attaches the trace store once the shared database is open.
            with store.lock:
                row = store.db.execute("SELECT event FROM trace_events WHERE kind='judge.decided' AND EXISTS "
                    "(SELECT 1 FROM json_each(event, '$.attrs.answers') AS answer "
                    "WHERE json_extract(answer.value, '$.id')=?) ORDER BY id DESC LIMIT 1",
                    (WANT_COMMENT["id"],)).fetchone()
            if row is not None:
                event = json.loads(row[0])
                self._last_judge = {"backend": event["attrs"]["backend"], "answers": event["attrs"]["answers"],
                                    "at": event["t_wall"]}

    @property
    def voice(self):
        return self._voice

    @voice.setter
    def voice(self, provider):
        if hasattr(self, '_voice'):
            self._voice.on_change = None
        self._voice = provider
        provider.on_change = lambda state: self.feed.publish('voice_state', state.wire(provider.clock()))

    def __init__(self, address, hook_token, ui_token, registry=None, broker=None,
                 tick_interval=0.5, gate=None, mouth=None,
                 events_token=None, speech=None, attention=None, sessions=None, share_page_text=False,
                 capture=None, interaction_preset="balanced", repository=None, integration_token=None):
        """repository: the character library (brain.characters.Repository); None reads the development sources."""
        self.interaction = preset(interaction_preset)
        self.startup_stage = "ready"  # main() walks it through its init stages; before "publishing" only /health answers
        self.degraded = []  # names of optional subsystems that failed to start
        self.hook_token = hook_token
        self.ui_token = ui_token
        # Read-only token for the renderer: GET /events and /state, never a decision.
        self.events_token = events_token
        # External agents' MCP server and CLI: the /integration/* routes only, so they propose and never decide.
        self.integration_token = integration_token
        self.integration_proposals = OrderedDict()  # api.integration: reminder request_id -> its outcome so far
        self.registry = registry or Registry()
        self.broker = broker or ApprovalBroker()
        self.feed = Feed()
        self.presence_feed = PresenceFeed(self)  # main runs its loop
        self._announce_slots = {}  # slot key -> (slotted at, feed seq, headline, kind, level), oldest first (see announce)
        self._ended = {}  # slot key -> clock time its terminal announcement was slotted or voiced
        self._announce_lock = threading.Lock()
        self._reported_tasks = set()
        self.gate = gate or Gate(interaction_preset=self.interaction.name)
        self.gate.enabled = self.gate.enabled and self.interaction.proactive_speech
        self.focus = Focus(clock=lambda: self.clock())  # main() gives it its state-dir file
        self.mouth = mouth
        self.models = None  # app-owned model settings and ChatGPT registrations
        self.character_agent = None  # personal services + selectable harness; initialized after existing stores
        self.facing_decisions = None  # quiet role decisions; no fixed focus-time orientation policy
        self.activity_decisions = None
        self.characters = repository or characters.Repository()
        self.character = self.characters.default()  # id of the card the mouth, voice and behavior use
        self.character_voice_enabled = True
        self.character_generation = 0  # +1 per committed switch
        self.switch = None  # the open character switch {switch_id, to, expires_at, card, mouth}, or None
        self._committed = {}  # switch_id -> (clock time of its commit, the commit's 200 body)
        # Control-panel sends validate the active conversation and enter say atomically.
        self._switch_lock = threading.RLock()
        self.mouth_factory = None  # character id -> Mouth; None while the mouth is off
        self.speech = speech  # SpeechRelay to the ws TTS; None keeps lines text-only
        self.attention = attention  # AttentionStore; None answers the attention endpoints with 503
        self.timeline = None  # observation.timeline.Timeline; None answers POST /context/timeline with 503
        # Text collection and sharing are opt-in; saved revocations take effect without restart.
        self.share_page_text = share_page_text
        self.share_typed_text = False  # --share-typed-text: AX field text and hook prompts may be kept
        self.share_agent_sessions = False  # --share-agent-sessions: live coding-session content may be kept
        self.privacy_config = None
        self._live_lock = threading.Lock()  # one PUT /settings/live applies at a time
        self.consent = ConsentPolicy(lambda: self.privacy_config, lambda: {
            "window_text": self.capture is not None and self.capture.share_text,
            "page_text": self.share_page_text,
            "screenshots": self.capture is not None and self.capture.vision is not None,
            "typed_text": self.share_typed_text,
            "agent_sessions": self.share_agent_sessions})
        self.computer_control = getattr(sessions, "computer_control", None)
        self.sessions = sessions  # SessionManager for own sessions; None answers /sessions with 503
        self.capture = capture  # CaptureManager; None answers /context/text, /context/image, /look with 503
        self.clock = time.time  # the pause and DELETE /observation cutoffs, the announce slots' TTL
        self.motion_lane = MotionLane(self._trace)
        # with or without plug-ins; main runs its tick loop
        self.user_now = UserNow(clock=lambda: self.clock(), lane=self.motion_lane)
        self.coarse_logged = None  # user_now revision the last /user/coarse log line was for
        self.paused_until = None  # PUT /observation/paused: clock time the pause ends, or None
        self.quiet_until = None  # PUT /observation/quiet: clock time quiet ends, or None
        self._quiet_meeting = False
        self._pauses = []  # [start, end] of each pause in the last RAW_PAST seconds, for events sent after it
        self._meetings = []  # the same for the meeting switch; apart, so resuming a pause does not end a meeting
        self.correction = None  # PUT /context/activity: {"activity", "until", "focus_id"}, or None
        self.user_state = UserState(lambda *row: self.attention.log_state(*row))
        self.agent_meta = None  # AgentMeta: hook sessions' titles; None knows none
        self._judgment = None  # the latest on-device state judgment with "ts" it was asked at
        self._judge_lock = threading.Lock()
        self._state_generation = 0  # forget_user_state() bumps it; a judgment asked before that is dropped
        self._state_lock = threading.Lock()  # activity() read to update vs forget_user_state(); taken before _judge_lock
        self.episodes = None  # Episodes; None keeps no episodes
        self.worklog = None  # WorkLog; None keeps no work memory
        self.avatar ={"visible": True, "reason": None, "since": _iso(self.clock())}  # PUT /avatar/visibility
        self.dispatcher = Dispatcher(self.broker, sessions)
        self._decision_traces = OrderedDict()  # decision key -> {"trace_id", "last", "at"} (see _decision)
        self._decision_lock = threading.Lock()
        self.gate.on_decision = self.broker.on_decision = self.dispatcher.on_decision = self._decision
        self.diag = Feed(DIAG_ITEMS)  # /diag/stream items: state, trace, decision
        self.diag_boot = secrets.token_hex(4)  # names this process in /diag/stream ids
        self._diag_lock = threading.Lock()
        self._diag_seen = {}  # block -> (its data without DIAG_VOLATILE, updated_at)
        self.hook_files = {}  # "claude" / "codex" -> the hook settings file /diag/state checks; main sets both
        self._hook_installed = {}  # hook file -> ((mtime_ns, size), or None while missing; its installed value)
        self._hook_edit_lock = threading.Lock()
        self.hook_seen = {}  # "claude" / "codex" -> time.time() of the last hook request
        self._diag_sent = None  # the updated_at values of the last state item
        self._diag_clients = 0
        self.speech_readers = 0  # open GET /speech streams, i.e. renderers
        self._started_at = time.time()
        self._assembled = None  # (time, items) of the latest context.assembled
        self._refused = None  # the latest refused look (see look)
        self._speech_failed = None  # the latest speech_failed: {speech_id, reason, at}
        self._tts_last = None  # how the TTS ended the latest speech: {result, at}
        self._speaking = None  # speech_id spoken last; _audible holds the ones whose audio began
        self._audible = deque(maxlen=SPEECH_TRACES)
        self._browser_at = None  # time of the latest extension message
        self._last_judge = None  # the latest proactive judge.decided: {backend, answers, at}
        self.behavior = None  # Behavior; gets dispatch results for its react
        self.state = None  # CharacterState: her own energy, engagement and mood; None records nothing
        self.state_affects = True  # PUT /character/state/switch; kept in memory only
        self.state_view = StateView(self)
        # +1 per turn: a line, look or speech of an older generation is dropped.
        self.turn_generation = 0
        # spatial behaviors on /events; main() starts its loop
        self.spatial = Spatial(self.spatial_situation, self.registry.publish_event, lambda: self.turn_generation,
                               self.registry.epoch, interaction_preset=self.interaction.name,
                               trace_epoch=self._trace_epoch, lane=self.motion_lane,
                               walk_bias=lambda: self.behavior.walk_bias() if self.behavior is not None else None)
        self.registry.consumed = self.spatial.consumed
        self.registry.on_intent = self.spatial.motion_intent
        self.spatial.use_motion(self.motion_chooser(self.character))
        # the one performance on a user.return; greet_on_resume is the shell's saved setting
        self.returning = Return(self.spatial, lambda: self.privacy_config is None
                                or saved_switch(self.privacy_config, "greet_on_resume", default=True),
                                clock=lambda: self.clock())
        self.spatial.consumed.seen = self.returning.ended
        self.proactive = None  # Proactive; sees every stored heartbeat
        self.proactive_log = None
        self.thoughts = None  # Thoughts: session transitions and the spatial poll's scene reach it; None thinks nothing
        self.signals = None  # Signals: session and work signals as thoughts; a return releases the ones it held
        self.user_now.subscribe(self.user_event)
        self._feedback_lock = threading.Lock()
        self._feedback_seen = set()
        self._proactive_lines = deque(maxlen=PROACTIVE_LINES)  # line_ids of the proactive lines started
        self.rituals = None  # Rituals; None answers POST /interaction/tap with {"kind": null}
        self._ritual_kinds = []  # the pending kinds the last /feed pending item named
        self._ritual_since = None  # self.clock() when that item was published
        self._ritual_lock = threading.Lock()
        self._gift_pending = None
        self._last_scripted = {}  # (character, event) -> last authored line started
        self.history = None  # History; None keeps lines off disk and answers /history with 503
        self.tasks = None  # TaskLedger; main shares it with the dispatcher and sessions; None answers /tasks 503
        self.commitments = None  # Commitments; None answers 「提醒我…」 with 503
        self.ledger_root = DEFAULT_ROOT  # the harness event ledger GET /day/segments reads; main sets --ledger-root
        self.memory = None  # Memory; None injects no facts and answers /memory with 503
        # Facts the latest line used: {line_id, cancel, facts: {(fact_id, version)}, texts: {fact_id: text as used},
        # entry: its mouth.history turn}
        self._turn_facts = None
        self._line_entries = OrderedDict()  # line_id -> its mouth.history turn, for lines sent to TTS
        self._heard = OrderedDict()  # line_id -> what was heard of it; a cut can come before its row (see _settle)
        # line_id -> (its user message, the user messages of the window's turns before it, oldest first, (fact_id,
        # version, text as used) of each fact it used) of a line the user cut, cancelled until a receipt says some of
        # it was heard
        self._cut_lines = OrderedDict()
        # ("keep", turn, the user messages of the window's turns before it, oldest first), ("heard", turn, None): its
        # assistant message is now turn[1], and ("drop", turn, None) changes to mouth.history that only a holder of
        # _mouth_lock makes (see _apply_window_ops); guarded by _write_lock
        self._window_ops = []
        self._voiced = None  # (turn_id, utterance_id, interrupt_policy) of the latest line or announcement voiced
        self.egress = None  # the EgressPolicy every model call shares; its redactions feed the diagnostics
        self.usage = None  # UsageMeter every model call records into; None shows null in /diag/state
        self.trace = None  # TraceStore (T1); None emits nothing and answers /trace/* with 503
        self.desk = None  # DeskLog; None records no touches or desk spans and answers /interaction/record with 503
        self.trace_errors = 0  # events the store refused; a line never stops for its trace
        self.errors = ErrorLog(lambda line: None)  # main writes it to <support>/logs/agentd-error.jsonl
        self._speech_failed_turns = deque(maxlen=SPEECH_TRACES)  # turn_ids with a speech_failed record
        self.stage_times = StageTimes()  # the traced spans /diag/state `stages` takes its medians from
        self._turn_trace = None  # the current turn's trace (see _open_trace); a cancel lands in it
        self._speech_traces = OrderedDict()  # speech_id -> the trace of the line it voices
        self._early_speech = OrderedDict()  # speech_id -> relay events that came before speak() returned
        self._speech_trace_lock = threading.Lock()
        self.muted = False
        self.voice = NoVoice()  # VoiceProvider; speech and tts_ensurer are its relay() and ensurer once main() builds it
        self.tts_ensurer = None  # ServiceEnsurer that starts the ws TTS on demand (--tts-ensure-host)
        self.tts_credential = None  # TtsCredential; main() builds it
        self._line_cancel = threading.Event()
        self._live_lines = set()  # cancel events of lines still waiting or streaming
        self._side_lines = set()  # cancel events of side lines (input while the foreground run works), until they end
        self._line_context = {}  # cancel event of the last main line and of each side line -> (line_id, types used)
        self._line_consent = {}  # cancel event -> consent epoch at context assembly
        self._line_material = {}  # cancel event -> start_line's material, until its context is assembled
        self._context_cut = set()  # cancel events of live lines ended by a cleared or corrected context item
        self._user_cut = set()  # cancel events of live lines the user cut: a key, 「停下」, new input or a switch
        self._turn_lock = threading.RLock()
        self._look = None  # request_id of the look the current turn waits for
        # One line streams at a time; the mouth's history is not thread-safe.
        self._mouth_lock = threading.Lock()
        self._slot_lock = threading.Lock()  # claim_line's check and start are one step
        self._receipts = OrderedDict()  # Idempotency-Key -> {"request", "done", "answer"}
        self._receipts_lock = threading.Lock()
        self.receipts_db = None  # the store load_receipts gave; None keeps receipts in memory only
        self._stopped = threading.Event()
        self._sync_privacy_due = True
        self.closing = False  # set by shutdown_cleanly: new tasks and approvals get 503 shutting_down
        self._closing_lock = threading.Lock()
        self.resetting = False  # set while POST /reset runs: writes get 503 resetting, background writers wait
        self._reset_lock = threading.Lock()
        self.reset_generation = 0  # +1 per POST /reset: a turn's trace and row from before it are not stored after
        self.history_generation = 0  # +1 per chat clear (see clear_history), fencing a turn as reset_generation does
        self.trace_generation = 0  # +1 per DELETE /attention: a trace opened before it stores nothing after it
        self._write_lock = threading.Lock()  # a turn's reset_generation check and its write are one step
        super().__init__(address, Handler)
        # TTL expiry and coalesced tool events must surface without new hook traffic.
        self._ticker = threading.Thread(target=self._tick_loop, args=(tick_interval,), daemon=True)
        self._ticker.start()
