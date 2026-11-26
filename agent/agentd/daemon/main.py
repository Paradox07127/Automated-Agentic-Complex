"""The agentd bootstrap: arguments, tokens, optional services and the serve loop."""
import argparse
import datetime
import json
import logging
import os
from pathlib import Path
import secrets
import signal
import sys
import threading
import traceback
from urllib.parse import urlsplit

from fsutil import atomic_write_json
from api.handler import C6_CONTRACT
from character_agent.harness.transport import PROTOCOL_VERSION as C8_PROTOCOL
from sessions.agent_meta import AgentMeta
from sessions.approvals import ApprovalBroker
from observation.attention import AttentionStore
from observation.timeline import Timeline
from character.behavior import Behavior
from character.binding import Bindings, effective
from observation.blacklist import Blacklist
from brain import characters
from observation.capture import CaptureManager
from character.character_state import CharacterState
from character.desk_log import DeskLog
from personal.commitments import Commitments
from tool_gateway.computer_use import ComputerControlConfig, endpoint_path
from daemon.agentd_server import AgentdServer
from daemon.error_record import FILE as ERROR_FILE, WINDOW_S, ErrorLog, appender
from traces.trace_store import TURN_TRACE
from personal.episodes import Episodes
from character.focus import Focus
from character.gate import Gate
from personal.history import History
from character.interactions import PRESETS, preset
from character.judge import Judge
from sessions.ledger import DEFAULT_ROOT
from personal.memory import Memory
from personal.worklog import WorkLog
from infra import paths, plugins
from character.proactive import Proactive
from character.proactive_log import ProactiveLog
from character.routine import Routine
from character.signals import Signals
from character_agent.services.worklog_digest import project
from character.thoughts import Thoughts
from personal.rituals import Rituals
from sessions.own import SessionManager
from infra.platform import make_private_tree, watch_parent as watch_parent_process
from infra.store import checkpoint, open_store
from sessions.tasks import TaskLedger
from infra.tokens import ensure_state_dir, read_token, write_secret
from traces.trace_store import TraceStore
from voice.voice_provider import NoVoice, RemoteWsVoice, make_provider

# C9 `--describe`: the contract versions this agentd implements.
DESCRIBE = {"component": "agentd", "c1_contract": "v2.6", "c6_contract": C6_CONTRACT, "c8_protocol": C8_PROTOCOL,
            "c9_contract": "v1"}


def build_capture(feed, attention, semantic, state_dir, share_window_text, share_screenshots, *, budget_db=None, budget_lock=None):
    """Local capture judgment; authorized vision uses the selected role harness."""
    from character_agent.services.semantic import SemanticVision
    def focus():
        window = attention.focus() if attention is not None else None
        return None if window is None else {**window, "category": attention.app_category(window)}
    blacklist = attention.blacklist if attention is not None else Blacklist(paths.blacklist(state_dir))
    return CaptureManager(feed, blacklist, focus, Path(state_dir) / "capture.jsonl",
                          vision=SemanticVision(semantic) if share_screenshots else None,
                          judge_log=Path(state_dir) / "capture-judge.jsonl", budget_db=budget_db, budget_lock=budget_lock,
                          spawn=lambda fn: threading.Thread(target=fn, daemon=True).start(), share_text=share_window_text,
                          app_category=attention.app_category if attention is not None else None)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=paths.AGENTD_PORT)
    parser.add_argument("--state-dir", default=paths.STATE_DIR_DEFAULT,
                        help="holds hook.token and ui-runtime.json (both 0600)")
    parser.add_argument("--computer-control-socket", help="Companion native desktop JSONL socket; omitted disables MCP bridge")
    parser.add_argument("--computer-control-token-file", help="0600 credential for the native desktop socket")
    parser.add_argument("--privacy-config", help="Native config.json; re-read text consent before each decision dispatch")
    parser.add_argument("--hook-timeout", type=float, default=60.0,
                        help="PermissionRequest hook timeout configured in Claude/Codex")
    parser.add_argument("--margin", type=float, default=5.0,
                        help="approval deadline = hook timeout - margin")
    parser.add_argument("--proactive", action=argparse.BooleanOptionalAction, default=True,
                        help="proactive speech (gate master switch); on by default")
    parser.add_argument("--interaction-preset", choices=tuple(PRESETS), default="balanced",
                        help="background interaction cadence: quiet, balanced (default), active")
    parser.add_argument("--character-catalog", type=Path,
                        help="verified CharacterLibrary/current.json; AGENTD_DEV_CATALOG or characters/sample-library/current.json when absent")
    parser.add_argument("--character",
                        help="character id: card, lore, TTS voice; default: the catalog's default_character, "
                        "none for a library without characters")
    parser.add_argument("--harness-site", dest="harness_sites", action="append", default=[], metavar="ID=DIR",
                        help="component site directory for harness.pi (node/bin/node and pi-runtime/)")
    parser.add_argument("--tts-url", help="remote TTS service base URL, e.g. http://127.0.0.1:9888 over ssh -L")
    parser.add_argument("--tts-ssh-host", help="ssh host of the remote TTS whenever --tts-url is its tunnel")
    parser.add_argument("--tts-ensure-host",
                        help="ssh host that runs --tts-ensure-script to start the remote TTS host's service on demand")
    parser.add_argument("--tts-ensure-script", default=None,
                        help="script on the remote TTS host whose `ensure` starts the TTS and answers ready or fail")
    parser.add_argument("--motion-url", help="Kimodo motion service base URL; no generated motion without it")
    parser.add_argument("--motion-ssh-host",
                        help="ssh host of the motion service whenever --motion-url is its tunnel; part of its endpoint")
    parser.add_argument("--motion-ensure-host",
                        help="ssh host that runs --motion-ensure-script to start the motion service on demand")
    parser.add_argument("--motion-ensure-script",
                        help="script on the motion host whose `ensure` starts the service and answers ready or fail")
    parser.add_argument("--llm-url", help="OpenAI-compatible model API base URL, e.g. http://127.0.0.1:11434/v1; "
                        "the compatible provider is off without it")
    parser.add_argument("--llm-ssh-host",
                        help="ssh host of the model API whenever --llm-url is its tunnel; part of its endpoint")
    parser.add_argument("--llm-ensure-host",
                        help="ssh host that runs --llm-ensure-script to start the model API on demand")
    parser.add_argument("--llm-ensure-script",
                        help="script on the model API host whose `ensure` starts the API and answers ready or fail")
    parser.add_argument("--share-page-text", action="store_true",
                        help="collect browser page/selection text and allow it in model context; off by default")
    parser.add_argument("--share-window-text", action="store_true",
                        help="let window text (AX / OCR) reach the selected agent harness; off by default")
    parser.add_argument("--share-typed-text", action="store_true",
                        help="keep AX input field text and hook prompts in events_raw; off by default")
    parser.add_argument("--share-agent-sessions", action="store_true",
                        help="keep live coding-session content; Companion enables this by default")
    parser.add_argument("--plugin-on", action="append", choices=plugins.DEFAULTS, default=[], metavar="ID")
    parser.add_argument("--plugin-off", action="append", choices=plugins.DEFAULTS, default=[], metavar="ID")
    parser.add_argument("--share-screenshots", action="store_true",
                        help="request budgeted window screenshots and describe them with Claude; off by default")
    parser.add_argument("--tts-token-file", default=os.environ.get("AAC_TTS_TOKEN_FILE"), help="TTS credential reference basename; default $AAC_TTS_TOKEN_FILE, "
                        "else tts-token in the state directory")
    parser.add_argument("--redact", action=argparse.BooleanOptionalAction, default=True,
                        help="mask API keys, tokens, emails and phone numbers before any model call; on by default")
    parser.add_argument("--mute", action=argparse.BooleanOptionalAction, default=False,
                        help="lines are shown as text only, as after the spoken 静音; off by default")
    parser.add_argument("--ledger-root", default=DEFAULT_ROOT,
                        help="harness event ledger the day summaries read (read only)")
    parser.add_argument("--exit-with-parent", action=argparse.BooleanOptionalAction, default=True,
                        help="shut down cleanly when the process that started agentd exits; on by default")
    parser.add_argument("--describe", action="store_true",
                        help="print one JSON line with the contract versions and exit, touching no port or state dir")
    args = parser.parse_args(argv)
    harness_sites = {}
    for pair in args.harness_sites:
        component, separator, directory = pair.partition("=")
        if not separator:
            parser.error("--harness-site: expected ID=DIR")
        if component != "harness.pi":
            parser.error(f"--harness-site: unknown harness component {component}")
        if component in harness_sites:
            parser.error(f"--harness-site: duplicate harness component {component}")
        if not Path(directory).is_absolute():
            parser.error("--harness-site: DIR must be an absolute directory")
        if not Path(directory).is_dir():
            parser.error(f"--harness-site: directory does not exist: {directory}")
        harness_sites[component] = directory
    args.harness_sites = harness_sites
    for flag in ("motion_url", "llm_url"):
        if getattr(args, flag) is None:
            continue
        parts = urlsplit(getattr(args, flag))
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password \
                or parts.query or parts.fragment:
            parser.error(f"--{flag.replace('_', '-')}: expected an http:// or https:// URL without user information")
        if flag == "llm_url" and parts.scheme == "http" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
            parser.error("--llm-url: http:// only to localhost; use https://")  # a model API key travels in the clear
        setattr(args, flag, getattr(args, flag).rstrip("/"))
    for service in ("tts", "motion", "llm"):
        host = getattr(args, f"{service}_ssh_host")
        if host is not None and (not host or any(c.isspace() for c in host) or getattr(args, f"{service}_url") is None):
            parser.error(f"--{service}-ssh-host: expected a host name, given with --{service}-url")
    if args.describe:
        print(json.dumps(DESCRIBE, sort_keys=True, separators=(",", ":")))
        sys.exit(0)
    if bool(args.computer_control_socket) != bool(args.computer_control_token_file):
        parser.error("--computer-control-socket and --computer-control-token-file must be given together")
    args.repository = characters.Repository(args.character_catalog)
    if args.character is None:
        args.character = args.repository.default()
    return args


def ensurer(service, host, script):
    """The ServiceEnsurer of --<service>-ensure-host and --<service>-ensure-script, or None without both."""
    from infra.service_ensure import ServiceEnsurer
    return ServiceEnsurer(service, host, script) if host and script else None


def service_endpoint(args, service):
    """The endpoint a service's credential belongs to: its --<service>-url and --<service>-ssh-host, "" when absent."""
    return {"url": getattr(args, f"{service}_url") or "", "ssh_host": getattr(args, f"{service}_ssh_host") or ""}


def clear_moved_credentials(state_dir, services):
    """services: {id: (endpoint, clear)}. Runs clear for each service whose endpoint differs from the one recorded at
    the last start, then records this start's endpoints; a service without a record is only recorded."""
    path = Path(state_dir) / "service-endpoints.json"
    try:
        recorded = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        recorded = {}
    for service, (endpoint, clear) in services.items():
        if service in recorded and recorded[service] != endpoint:
            clear()
            print(f"agentd: {service} endpoint changed; credential cleared", file=sys.stderr)
        recorded[service] = endpoint
    atomic_write_json(path, recorded)


def flush_errors(server):
    """Writes the error counts whose minute is over, until agentd stops."""
    while not server._stopped.wait(WINDOW_S):
        server.errors.flush()


def startup_privacy(server):
    """What a switch that is off covers goes at startup: turning it off restarts agentd, and agentd may have been
    stopped then, so the first snapshot never sees the revocation. Only summaries that depend on a switch now off go,
    with what was derived from them."""
    permissions, level = server.consent.snapshot()[0], server.consent.level
    if not permissions["typed_text"]:
        if server.attention is not None:
            server.attention.clear_typed_text()
        if getattr(server, "timeline", None) is not None:
            server.timeline.clear_typed_text()
    if not permissions["agent_sessions"] and server.attention is not None:
        server.attention.clear_agent_sessions()
    # Only the window level keeps window trees; a narrower one may have been saved while agentd was stopped.
    if (not permissions["window_text"] or level != "window") and getattr(server, "timeline", None) is not None:
        server.timeline.clear_trees()
    off = {k for k in ("page_text", "typed_text", "agent_sessions") if not permissions.get(k, True)}
    if off and server.worklog is not None:
        server.worklog.delete_permissions(off)
    if server.episodes is None:
        return
    if not off:
        return
    deleted = server.episodes.delete_permissions(off)
    server._forget_derived(deleted)
    if deleted:
        checkpoint(server.episodes)


def start_optional(server, name, start):
    """Run an optional subsystem's startup step; a failure goes to stderr and into server.degraded instead of ending
    agentd. Whether it started."""
    try:
        start()
    except Exception:
        print(f"agentd: {name} failed to start; running without it", file=sys.stderr)
        traceback.print_exc()
        server.degraded.append(name)
        return False
    return True


def thought_work(server, allowed, cwds):
    """Up to 2 active cards of the cwds' projects with their next steps, and today's headline; allowed(row): the
    row's consents hold."""
    projects = {project(cwd) for cwd in cwds} - {None}
    cards = [c for c in server.worklog.tasks(("active",)) if c["project"] in projects and allowed(c)][:2]
    lines = [f"- Active task: {c['title']}" + (f"; next step: {c['next_step']}" if c["next_step"] else "") for c in cards]
    today = server.worklog.day(datetime.date.fromtimestamp(server.clock()).isoformat())
    if today is not None and today["headline"] and allowed(today):
        lines.append(f"Today so far: {today['headline']}")
    return "\n".join(lines)[:400]


def main(secret_store=None):
    os.umask(0o077)
    class TimestampedStderr:
        def __init__(self, stream):
            self.stream, self.start, self.turn = stream, True, None
            self.lock = threading.Lock()

        def write(self, text):
            with self.lock:
                for part in text.splitlines(keepends=True):
                    if self.start:
                        stamp = datetime.datetime.now().astimezone().isoformat(timespec="milliseconds")
                        self.stream.write(f"{stamp} pid={os.getpid()} ")
                        # A traceback's indented lines continue the line above and stay untagged.
                        self.turn = None if part[:1].isspace() else TURN_TRACE.get()
                    self.start = part.endswith("\n")
                    if self.start and self.turn is not None:
                        part = f"{part[:-1]} trace_id={self.turn}\n"
                    self.stream.write(part)
            return len(text)

        def flush(self):
            with self.lock:
                self.stream.flush()

        def __getattr__(self, name):
            return getattr(self.stream, name)

    sys.stderr = TimestampedStderr(sys.stderr)
    # The stream stamps each line with its time and pid; INFO and above, so logger.info lines reach agentd.log.
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one INFO line per request, with its URL
    parent = os.getppid()
    args = parse_args()
    plugins.resolve(args.plugin_on, args.plugin_off)
    light = plugins.on("light_ai")
    awareness = plugins.on("screen_awareness")
    needs_runtime = light or awareness or any(plugins.on(i) for i in (
        "screen_reading", "daily_brief", "personal_agent", "harness_bridge"))
    interaction = preset(args.interaction_preset)
    state_dir = Path(args.state_dir)
    ensure_state_dir(state_dir)
    make_private_tree(state_dir)
    from infra.secrets import ModelError, system_store
    from voice.credential import TtsCredential
    if secret_store is None:
        secret_store = system_store(state_dir)
    hook_path = paths.hook_token(state_dir)
    if not hook_path.exists():
        write_secret(hook_path, secrets.token_urlsafe(24) + "\n")
    hook_token = read_token(hook_path)
    ui_token = secrets.token_urlsafe(24)
    events_token = secrets.token_urlsafe(24)
    integration_token = secrets.token_urlsafe(24) if plugins.on("external_access") else None
    repository = args.repository
    if args.character is not None:
        repository.load_card(args.character)
    db = paths.agentd_db(state_dir)
    store_db = open_store(db)
    store_lock = store_db._idle_lock
    memory = Memory(store_db, lock=store_lock)
    from models.model_backends import ModelSettings
    from brain.outbound import OutboundGuard, resolve_windows
    from brain.provider import Mouth
    models = ModelSettings(state_dir, secret_store, llm_url=args.llm_url,
                           llm_ensurer=ensurer("llm", args.llm_ensure_host, args.llm_ensure_script)) if needs_runtime else None
    from motion.settings import MotionSettings
    motion_settings = MotionSettings(state_dir, secret_store)
    moved = {"motion": (service_endpoint(args, "motion"), motion_settings.clear_token)}
    if models is not None:
        moved["llm"] = (service_endpoint(args, "llm"), lambda: models.clear_key("compatible"))
    clear_moved_credentials(state_dir, moved)
    guard = OutboundGuard(resolve_windows(state_dir), paths.outbound_guard_log(state_dir))
    from brain.egress import EgressPolicy
    # One policy for every model call, so the diagnostics see one set of mask counts.
    egress = EgressPolicy(guard=guard, redact=args.redact)
    from models.usage import UsageMeter
    usage = UsageMeter(store_db, lock=store_lock)
    def motion_phrases(cid):
        """The phrases of cid's game gestures for the [motion:] rule; none for the development sources."""
        from motion import catalog
        try:
            root = repository.package(cid).root
        except ValueError:
            return []
        return catalog.phrases(catalog.load(root))
    factory = lambda cid: Mouth(character=cid, persona_path=repository.card_path(cid), lore_path=repository.lore_path(cid),
                                egress=egress, motion_phrases=motion_phrases(cid))  # noqa: E731
    # No character: no mouth, and the routes in api.handler.CHARACTER_ROUTES answer 409 no_character.
    chat = light or plugins.on("harness_bridge")
    mouth = factory(args.character) if chat and args.character is not None else None
    mouth_off = "no_character" if args.character is None else "plugin_off"
    attention = AttentionStore(paths.attention_db(state_dir), Blacklist(paths.blacklist(state_dir))) if awareness else None
    server = AgentdServer(("127.0.0.1", args.port), hook_token, ui_token,
                          broker=ApprovalBroker(args.hook_timeout, args.margin),
                          gate=Gate(enabled=args.proactive, interaction_preset=interaction.name, state_scale=lambda: server.state_view.comment_scale(), db=store_db, db_lock=store_lock),
                          mouth=mouth, events_token=events_token, integration_token=integration_token,
                          attention=attention, share_page_text=awareness and args.share_page_text,
                          interaction_preset=interaction.name, repository=repository)
    # The socket is bound: /health answers from here while the rest starts; daemon, so a fatal init error still exits.
    server.state_dir = state_dir
    # The shell passes <support>/tts-token, so its logs folder is beside it (C9, C10).
    logs = Path(args.tts_token_file).parent / "logs" if args.tts_token_file else state_dir / "logs"
    server.errors = ErrorLog(appender(logs / ERROR_FILE))
    threading.Thread(target=flush_errors, args=(server,), daemon=True).start()
    server.startup_stage, server.degraded = "init", []
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    server.startup_stage = "storage"
    if awareness:
        server.timeline = Timeline(paths.timeline_db(state_dir), attention.blacklist)
    server.character, server.mouth_factory = args.character, factory if chat else None
    server.no_character = args.character is None
    server.models = models
    server.privacy_config = args.privacy_config
    server.muted = args.mute
    if chat or plugins.on("personal_agent"):
        server.history = History(store_db, lock=store_lock, character_id=server.character, catalog=repository)
    if light:
        server.proactive_log = ProactiveLog(store_db, lock=store_lock)
        server.proactive_log.prune()
    if light or plugins.on("daily_brief"):
        server.episodes = Episodes(store_db, lock=store_lock)
    if plugins.on("daily_brief"):
        server.worklog = WorkLog(store_db, lambda: server.character, lock=store_lock)
    if plugins.on("personal_agent"):
        server.tasks = TaskLedger(store_db, lock=store_lock)
    server.ledger_root = args.ledger_root
    server.memory = memory
    server.load_pause()
    server.focus = Focus(paths.focus(state_dir), clock=lambda: server.clock(),
                         language=lambda: server.character_agent.semantic.reply() if server.character_agent else None)
    server.gate.focus = server.focus.running()
    server.user_now.set_overrides(focus_timer=server.gate.focus)
    server.load_receipts(store_db, lock=store_lock)
    server.trace = TraceStore(store_db, lock=store_lock, producer_epoch=server.registry.epoch, retention=server.history_retention)
    server.desk = DeskLog(store_db, lock=store_lock, retention=server.history_retention)
    server.spatial.parked = lambda on: server.desk.span("edge", on)
    from motion.performer import Performer
    server.motion = Performer(motion_settings, server.registry.publish_event,
                              lambda: server.characters.package(server.character).root, state_dir / "motion-cache",
                              offer=server.spatial.offer, trace=server._trace, service_url=args.motion_url,
                              ensurer=ensurer("motion", args.motion_ensure_host, args.motion_ensure_script))
    server.bindings = Bindings(state_dir, repository, lambda: server.motion.settings.backend)
    server.character_voice_enabled = args.character is not None and server.bindings.voice(args.character) is not None
    if server.mouth is not None:
        server.mouth.refresh_system(effective(server))  # the bindings are built after the mouth
    if plugins.on("motion_generation"):
        server.motion.prewarm(server.motion.settings.backend if args.character is None else effective(server)["motion"]["driver"])
    if args.character is not None:  # without a character server.state stays None and records nothing
        server.state = CharacterState(store_db, lambda cid: repository.load_card(cid).get("state_profile"))
        server.state.retention = server.history_retention
        server.state.use(args.character)
    server.spatial.state = server.state_view
    server.spatial.stage = lambda: server.user_now.snapshot()["stage"]
    server.spatial.keep(paths.spatial(state_dir))
    if mouth is not None:
        server.load_window()
    server.egress, server.usage = egress, usage
    from observation.activity_decisions import ActivityDecisions
    from character_agent.integration import CharacterAgentController
    from character_agent.services.semantic import SemanticJudge
    server.privacy_config = args.privacy_config
    server.share_typed_text = awareness and args.share_typed_text
    server.share_agent_sessions = plugins.on("coding_sessions") and args.share_agent_sessions
    if plugins.on("coding_sessions"):
        server.agent_meta = AgentMeta()
    if awareness or plugins.on("screen_reading"):
        server.capture = build_capture(server.feed, attention, None, state_dir,
                                       args.share_window_text, args.share_screenshots, budget_db=store_db, budget_lock=store_lock)
    startup_privacy(server)
    server.startup_stage = "character_agent"
    if needs_runtime:
        server.character_agent = CharacterAgentController(server, state_dir, harness_sites=args.harness_sites)
    if plugins.on("harness_bridge"):
        server.character_agent.discovery.warm()  # the runtime probes take seconds; the main window reads them first
    if awareness:
        server.activity_decisions = ActivityDecisions(server.character_agent.semantic, interaction.model_every)
        from observation.facing_decisions import FacingDecisions
        server.facing_decisions = FacingDecisions(server.character_agent.semantic,
            lambda yaw,reason,hold,valid: server.spatial.request_facing(yaw,reason,hold,source='decision',valid=valid),
            interaction.model_every)
    if args.share_screenshots and server.capture is not None:
        from character_agent.services.semantic import SemanticVision
        server.capture.vision=SemanticVision(server.character_agent.semantic)
    server.startup_stage = "observation"
    if awareness:
        server.capture.on_image=server.character_agent.observations.ingest_image
        server.capture.budget.min_interval=5
        server.capture.budget.per_hour=120
        server.capture.budget.per_day=1500
        start_optional(server, "observations", server.character_agent.observations.start)
    server.startup_stage = "sessions"
    if plugins.on("computer_use") and args.computer_control_socket:
        server.computer_control = ComputerControlConfig(endpoint_path(args.computer_control_socket),
                                                       str(Path(args.computer_control_token_file).expanduser().resolve()))
    if plugins.on("coding_sessions") or plugins.on("personal_agent"):
        server.sessions = server.dispatcher.sessions = SessionManager(
            server.broker, server.announce, state_dir, f"http://127.0.0.1:{server.server_port}", hook_token,
            args.hook_timeout, store=store_db, computer_control=server.computer_control,
            reply_language=server.reply_language_code)
        server.sessions.tasks = server.dispatcher.tasks = server.tasks
    if light and args.tts_url:
        server.startup_stage = "speech"

    tts_path = args.tts_token_file or state_dir / paths.TTS_TOKEN
    server.tts_credential = TtsCredential(tts_path, secret_store)

    def start_voice():
        try:
            token = server.tts_credential.get() if args.tts_url else None
        except ModelError as error:
            server.voice = NoVoice(str(error))
            server.degraded.append("speech")
            return
        if args.tts_url and token is None:
            server.errors.record("tts_token_missing", "no TTS token saved; set it in 设置 or run tools/tts_token.py ensure")
        server.voice = make_provider(args, server.bindings, server.registry.epoch, token)
        if server.voice.relay() is not None:
            server.voice.relay().on_event = server.on_speech_event
    if light and not start_optional(server, "speech", start_voice):
        server.voice = NoVoice("start_failed")  # text-only, as without --tts-url
    server.speech, server.tts_ensurer = server.voice.relay(), server.voice.ensurer
    if isinstance(server.voice, RemoteWsVoice):
        server.voice.probe()
    server.startup_stage = "recovery"
    if server.tasks is not None:
        start_optional(server, "recover_tasks", server.recover_tasks)  # once the voice is set up, so its announcements can be spoken
    commitments = Commitments(store_db, lock=store_lock)
    # server.commitments stays None on a failure, which the reminder routes and ticks answer as unavailable
    start_optional(server, "recover_commitments", lambda: server.recover_commitments(commitments))
    server.startup_stage = "memory"
    if light:
        start_optional(server, "memory_pipeline", server.character_agent.memory_pipeline.start)
    if plugins.on("daily_brief"):
        start_optional(server, "worklog", server.character_agent.worklog.start)
    server.startup_stage = "behavior"
    if plugins.on("coding_sessions"):
        server.hook_files = {"claude": Path(paths.CLAUDE_SETTINGS).expanduser(),
                             "codex": (Path(paths.CODEX_HOME) / paths.CODEX_HOOKS).expanduser()}  # tools/install_hooks.py defaults
    server.rituals = Rituals(store_db, memory=memory, lock=store_lock,
                             summary=server.day_session_summary if plugins.on("daily_brief") else None,
                             arc=server.day_arc if plugins.on("daily_brief") else None, on_change=server.ritual_check,
                             greeted=server.returning.welcomed_on)
    if awareness and light:
        server.proactive = Proactive(attention, server.gate, server.feed.publish, server.start_line, server.busy,
                                     judge=Judge(SemanticJudge(server.character_agent.semantic, "proactive_decide"),
                                                 paths.proactive_judge_log(state_dir)), activity=server.activity, claim=server.claim_line,
                                     sessions=server.registry.snapshot,
                                     break_minutes=60, water_minutes=90, deliver="speak",
                                     log=server.proactive_log, user=server.user_title,
                                     language=server.character_agent.semantic.reply,
                                     absence=lambda: server.user_now.snapshot()["absence"])

    def work_signal_allowed(row):
        permissions = server.consent.snapshot()[0]
        return not server.observation_paused() and all(permissions.get(item, False) for item in row['requires'])

    if light:
        server.thoughts = Thoughts(server.gate, server._proactive_publish, server.character_agent.semantic,
                                   scene=server.activity, context=server._attention_context,
                                   sessions=lambda: {"sessions": [row for row in server.registry.snapshot()["sessions"]
                                                                  if server._signals_allowed(row)]},
                                   consent=server.page_text_allowed,
                                   egress=egress, work=(lambda cwds: thought_work(server, work_signal_allowed, cwds)) if server.worklog else None,
                                   log=server.proactive_log, user=server.user_title,
                                   presence=lambda: server.user_now.snapshot()["presence"])

    def interpreted(character, body):
        """The continuous interpreter's committed analysis of the shown character reaches her thoughts and lines."""
        if character == server.character:
            server.thoughts.interpreted(body)
            server.proactive.interpreted(body)

    if server.proactive is not None:
        server.character_agent.observations.listeners.append(interpreted)

    if light:
        server.signals = Signals(server.gate, server.thoughts, server.registry, sessions=server.sessions,
                                 presence=lambda: server.user_now.snapshot()["presence"],
                                 allowed=server._signals_allowed,
                                 pending=server.broker.pending, clock=server.clock, worklog=server.worklog,
                                 semantic=server.character_agent.semantic,
                                 report_time=server.rituals.report_time, egress=egress,
                                 work_allowed=work_signal_allowed,
                                 absent=lambda: server.user_now.snapshot()["absence"] is not None)
    server.spatial.routine = Routine(state=server.state_view)
    server.behavior = Behavior(server.situation, server.registry.set_activity,
                               backend=None, routine=server.spatial.routine,
                               speaking=lambda: server.speech is not None and server.speech.busy(),
                               state=server.state_view, interaction_preset=interaction.name,
                               version=lambda: (server.character, server.character_generation, server.reset_generation,
                                                server.turn_generation, server.gate.meeting, server.gate.fullscreen))
    server.behavior.on_decision = server._decision
    if server.capture is not None:
        server.capture.judge.on_decision = server._decision
    if server.proactive is not None and server.proactive.judge is not None:
        server.proactive.judge.on_decision = server._decision
    threading.Thread(target=server.behavior.run, args=(server._stopped, server.polls_paused), daemon=True).start()
    threading.Thread(target=server.spatial.run, args=(server._stopped, server.polls_paused), daemon=True).start()
    threading.Thread(target=server.presence_feed.run, args=(server._stopped,), daemon=True).start()
    threading.Thread(target=server.user_now.run, args=(server._stopped,), daemon=True).start()
    # shutdown_cleanly waits for serve_forever to return, so it cannot run inside the handler.
    stop = lambda *_: threading.Thread(target=server.shutdown_cleanly).start()  # noqa: E731
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if args.exit_with_parent:
        watch_parent_process(parent, lambda: threading.Thread(target=server.shutdown_cleanly).start(), hard=False)
    server.startup_stage = "publishing"
    # Written once every route answers: tools wait for these files before their first request.
    runtime = paths.ui_runtime(state_dir)
    write_secret(runtime, json.dumps({"schema": 1, "base_url": f"http://127.0.0.1:{server.server_port}",
                                      "ui_token": ui_token}, indent=2))
    write_secret(paths.events_runtime(state_dir),
                 json.dumps({"schema": 1, "base_url": f"http://127.0.0.1:{server.server_port}",
                             "events_token": events_token}, indent=2))
    if integration_token:
        write_secret(paths.integration_runtime(state_dir),
                     json.dumps({"schema": 1, "base_url": f"http://127.0.0.1:{server.server_port}",
                                 "integration_token": integration_token}, indent=2))
    else:
        paths.integration_runtime(state_dir).unlink(missing_ok=True)
    server.startup_stage = "ready"
    print(f"agentd listening on 127.0.0.1:{server.server_port}; hook token: {hook_path.resolve()}; "
          f"ui runtime: {runtime.resolve()}; character: {args.character}; "
          f"mouth: {'on' if mouth else f'off ({mouth_off})'}",
          flush=True)
    try:
        while serving.is_alive():  # a timed join lets the main thread take signals
            serving.join(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        runtime.unlink(missing_ok=True)
        if models is not None:
            models.auth.cancel()
        server.shutdown_cleanly()
        server.server_close()
        server.errors.flush(everything=True)
    print("agentd: shut down cleanly", file=sys.stderr, flush=True)
