"""Connect Endfield's personal services to interchangeable, private harness sessions."""
import copy
from collections import deque
from datetime import datetime
import importlib.util
import json
import logging
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import threading
import time
import uuid

from brain.egress import redact
from brain.markers import MarkerStream
from brain.language import SYSTEM_RULE
from brain.persona import localized, render_brief_persona, render_persona
from character.binding import bound, effective
from character_agent.services.knowledge import DERIVED, KnowledgeService
from character_agent.services.interactions import InteractionService, QuestionTurn
from character_agent.services.memory_service import MemoryJournal
from character_agent.services.capabilities import describe as describe_capabilities
from character_agent.services.jobs import JobCoordinator, JobStore
from character_agent.services.orchestration import OrchestrationTurn
from character_agent.services.personal import persona_personal_instructions
from character_agent.presentation import PreparedReply
from character_agent.runtime import PersonalAgentRuntime
from character_agent.services.settings import RETENTION, ROUTES, RuntimeSettings
from character_agent.services import worklog_digest
from character_agent.services.store import RunStore
from character_agent.harness.discovery import DiscoveryService
from character_agent.harness.registry import DISCOVERED, HARNESSES, acp_agent, deepseek_account_command, harness, pi_catalog
from character_agent.services.workspace import WorkspaceService
from infra import plugins
from infra.localtime import local_time
from infra.platform import USER_MACHINE
from infra.store import checkpoint
from sessions.danger import COMMAND_TOOLS, FILE_TOOLS
from tool_gateway.gateway import SessionKey, ToolGateway
from tool_gateway.ledger import ledger_path
from tool_gateway.policy import POLICY
from traces.trace_store import TURN_TRACE, new_span_id, new_trace_id

SIDE_INSTRUCTIONS = (
    "<side_session>\n"
    "Side session: the main session is still working on what the user asked earlier, and the user has just said something else. "
    "Answer only this message; the main work goes on without you stopping, redoing or taking it over.\n"
    "- Reply briefly in character, at the length of an everyday line. If they ask about something else, answer only that, without foreground progress.\n"
    "- Asked how the foreground is going, say only what the foreground brief states (request, plan, state); for anything it lacks, say it is still "
    "in progress and details come when it is done. The brief is a snapshot: never claim the work finished, failed or was cancelled, and don't guess "
    "results. Without a brief, say only that the main session is busy.\n"
    "- This session only reads existing knowledge: no files, desktop actions, background work or memory changes. If the message needs them, "
    "say it has to wait until the main session is done and ask the user to say it again then.\n"
    "</side_session>")

# Goes ahead of the user's own words when they reach the foreground run through C8 steer.
STEER_NOTE = ("The user said this while you were working. A separate reply has already answered them aloud, so do not "
              "answer it again. If it changes what you are doing, adjust the work; otherwise continue.\n\n")

FOREGROUND_INSTRUCTIONS = (
    "<main_session>\n"
    "Main session: you answer the user directly; where these rules are silent, reason from them.\n"
    "- Sort each message; when unsure, take the cheaper reading (a short reply or one question).\n"
    "  - Chat: reply at line length; no task, job or write tool.\n"
    "  - Question: answer, after one search or read if needed.\n"
    "  - Venting: acknowledge the feeling briefly in your own way; no advice or task until asked, and never judge their personality or state from it.\n"
    "  - Quiet (\"be quiet\", \"I'm busy\"): one short acknowledgement, then stop: no questions, tips or status.\n"
    "  - A task missing a key fact (which file, when, for whom): ask_user for the most important one; default the rest and say so on delivery.\n"
    "  - A tap, gift or other event: react with the moment's feeling.\n"
    "- Tasks. Writing files, several tool steps or over 20 seconds: say you are starting, then background_start first, without reading or planning "
    "here; give it goal, material, deliverable and done criteria. Code or commands in the user's project, or an explicit ask for Claude Code "
    "or Codex: dispatch_session with the symptoms, project and done criteria you know, as soon as the user names the project and the change, without reading the code or asking for more details. Earlier work to continue: "
    "task_continue, not a new task_plan. Answerable from context, memory or one read: answer here.\n"
    "- Verify by receipt (artifact_verify, desktop_verify; avatar_facing_status); fix and recheck, or say it failed.\n"
    "- No folder scope but files needed: ask the user to pick folders in settings.\n"
    "- Before reminder_create, confirm the date, time zone and item. A reminder that played was not necessarily heard or done.\n"
    "- A write refused with an error ending in not_authorized or instruction_required needs the user's own words: ask them to say it in one "
    "sentence (for a reminder, the item and the time); never retry with your own wording.\n"
    "- In a window, check each step before the next.\n"
    "- Report the result first (done and where, or where stuck), citing only receipts; never state or guess a background result before it "
    "ends; name failed or unchecked parts and the next step.\n"
    "</main_session>")

# /say `surface` values as the context names them (api/speech.py SURFACES).
SURFACE_NAMES = {'quick_input': 'desktop quick input', 'bubble_reply': 'a reply to your bubble', 'thought_offer': 'accepting your suggestion', 'chat': 'the chat page'}
# lore tier -> label, in render order
LORE_LABELS = {"official": "Lore (game canon: your own life and world, not the user's)",
               "inferred": "Lore (guesswork, not canon: give it as your impression, hedged)",
               "fanon": f"Lore (your desktop life on {USER_MACHINE}, apart from the game story)"}

# Failure codes a failed job reports as its readable reason.
JOB_FAILURE_REASONS = frozenset({'auth_expired', 'rate_limited', 'quota_exhausted', 'native_login_required'})
# A model span's model while the harness runs its own default: the trace format refuses an empty one.
DEFAULT_MODEL = "default"
LOCKED_ROUTES = ("judge", "understand", "memory", "computer")  # their runs keep the harness's own tools off
PROFILE_LIMIT = 12  # stated/confirmed preferences & agreements injected per turn
PROFILE_CHARS = 6000
RELATED_FACTS = 8  # confirmed memory facts a turn's context carries beside the profile, matched on the user's words
RELATED_FACTS_CHARS = 3000  # characters of those facts' JSON (summed per item), the introducing sentence excluded
_INFER_CONVERSATION = object()


def finished_usage(answer):
    """model.finished's optional attrs: the cache reads, reasoning tokens, last prompt size and cost the harness reported for the run."""
    attrs = {key: answer.usage[name] for key, name in (("cached_tokens", "cache_read_input_tokens"),
             ("reasoning_tokens", "reasoning_output_tokens")) if isinstance(answer.usage.get(name), int)}
    if isinstance(answer.context_tokens, int):
        attrs["context_tokens"] = answer.context_tokens
    return attrs if answer.cost_usd is None else {**attrs, "cost_usd": answer.cost_usd}


def harness_danger(request):
    """(dangerous, rule) of a harness permission request: the command it runs, or the paths it edits, deletes or moves.
    Claude Code sends no kind; its title names the tool before the colon."""
    kind, raw = request.get("kind"), request.get("raw_input")
    if kind is None:
        tool = str(request.get("title") or "").split(":", 1)[0]
        kind = "execute" if tool in COMMAND_TOOLS else "edit" if tool in FILE_TOOLS else None
    if kind == "execute":
        command = raw.get("command") if isinstance(raw, dict) else None
        return POLICY.danger("Bash", (command if isinstance(command, str) else str(request.get("title") or ""),))
    if kind in ("edit", "delete", "move"):
        return POLICY.danger("Write", tuple(p for p in request.get("locations") or () if isinstance(p, str)))
    return False, None


class KernelNotReady(ValueError):
    def __init__(self, code, runtime):
        super().__init__(code)
        self.code, self.runtime = code, runtime


class CharacterAgentController:
    def __init__(self, server, state_dir, *, python=None, session_factory=None, credential=None, harness_sites=None):
        self.server, self.state_dir = server, Path(state_dir)
        self.harness_sites = harness_sites or {}
        from character_agent.harness.profile_cleanup import purge_runner_indexes, purge_idle_runner_actors
        runner_root = self.state_dir / 'character-agent' / 'runner'
        # Remove vendor history indexes before any runtime can use them, but
        # do not let recursive disposal of idle actors block backend readiness.
        if plugins.on("harness_bridge"):
            purge_runner_indexes(runner_root, apply=True, remove_idle=False)
            from character_agent.harness.codex_runner import discard_log_db
            discard_log_db(runner_root / 'codex')
        self.settings = RuntimeSettings(state_dir)
        self.python = python or sys.executable
        self.session_factory_override, self.credential_override = session_factory, credential
        self._auto_chosen = False
        self.workspace = (WorkspaceService(self.state_dir / "character-agent" / "files", egress=server.egress)
                          if plugins.on("personal_agent") else None)
        self.runtime = None
        self._closing = False
        self.store = RunStore(ledger_path(self.state_dir), retention=self.retention)
        self.tools = ToolGateway(self.store, computer_control=lambda: server.computer_control,
                                 egress=lambda: server.egress, report=server.broker.report)
        from character.looks import Looks
        self.looks = Looks(server)
        self._presentation_lock = threading.RLock()
        self._presentation_fault = False
        self._role_outcomes = deque(maxlen=256)
        self._continuation_epoch = uuid.uuid4().hex
        if server.history is not None:
            server.history.conversations.run_store = self.store
        self.interactions = InteractionService(self.store, self._interaction_event,
            resume=self.continue_interaction, waiting=self._waiting_interaction)
        self.discovery = DiscoveryService(path=self.state_dir / "runtime-discovery.json") if plugins.on("harness_bridge") else None
        self._runtime_config = None
        self._lock = threading.RLock()
        self._availability = None
        self._last_public = None
        # What the last Pi session with Pi's own tools reported: SDK version, tools and shells found, approval, folder.
        self._pi_facts = None
        # Pi provider -> {model id: whether Pi's offline catalog prices it}.
        self._pi_prices = {}
        # ACP registry id -> initialize probe of its local command, from the last refresh.
        self._acp_probes = {}
        # ACP registry id -> whether its last session start got past the agent's authentication.
        self._acp_logins = {}
        from character_agent.services.kernel_login import KernelLogin
        self.logins = KernelLogin(self.state_dir, on_acp_login=self._acp_signed_in)
        self.memory_journal = (MemoryJournal(server.memory, interactions=self.interactions, language=lambda: self.semantic.reply())
                               if server.memory is not None else None)
        from character_agent.services.semantic import SemanticService
        from character_agent.services.memory_pipeline import MemoryPipeline
        from brain.language import ReplyLanguage
        self.reply_language = ReplyLanguage()
        self.semantic = SemanticService(self)
        self.memory_pipeline = MemoryPipeline(self) if plugins.on("light_ai") else None
        from character_agent.services.observation_briefs import ObservationBriefs
        self.observation_briefs = ObservationBriefs(self) if plugins.on("daily_brief") and server.memory is not None else None
        from character_agent.services.observation import ObservationService
        self.observations = ObservationService(self) if plugins.on("screen_awareness") and server.memory is not None else None
        if self.observations: self.observations.restore_report_consents()
        from character_agent.services.worklog import WorkLogService
        self.worklog = WorkLogService(self) if plugins.on("daily_brief") and server.memory is not None else None
        self._background_runtimes = {}
        self._side_runtimes = {}  # line_id of a side line or one she starts herself -> (cancel event, its one-off runtime)
        self._main_line, self._main_heard = None, []  # the latest line on self.runtime, and the turns its delivery left
        # That line's history at its prepare, and the replies that may add its own turn (StreamedReply, PreparedReply).
        self._main_seen = ([], [])
        self._turn = threading.local()  # native_tools: False while this thread runs a side or unremembered role turn
        self._foreground_request = ''  # the start of the latest foreground input, for a side line's brief
        self.jobs = JobCoordinator(JobStore(server.memory), self._execute_job, self._cancel_job,
            emit=self._job_event) if plugins.on("personal_agent") and server.memory is not None else None
        from character_agent.services.deliveries import DeliveryService
        self.deliveries = DeliveryService(server.memory, self.store, server.tasks, self.jobs.store,
            emit=lambda event: server.feed.publish("delivery", event), validate_scope=self.workspace.validate_scope) if self.jobs else None
        if self.jobs:
            self._recover_jobs()
            self._recover_deliveries()
        self._runner_cleanup_stop = threading.Event()
        def clean_idle():
            try: purge_idle_runner_actors(runner_root, stopped=self._runner_cleanup_stop.is_set)
            except (OSError, ValueError) as exc:
                print('idle runner cleanup: ' + type(exc).__name__, file=sys.stderr)
        self._runner_cleanup = None
        if plugins.on("harness_bridge"):
            self._runner_cleanup = threading.Thread(target=clean_idle, name='idle-runner-cleanup', daemon=True)
            self._runner_cleanup.start()

    def _recover_deliveries(self):
        """Reconcile a process exit between task settlement and delivery commit."""
        if self.deliveries is None: return
        with self.store.lock:
            runs = [row[0] for row in self.store.db.execute(
                "SELECT run_id FROM character_runs WHERE task_id IS NOT NULL AND delivery_eligible=1 AND delivery_revoked=0 AND state IN ('completed','failed') ORDER BY started_at")]
        for ident in runs:
            self.deliveries.produce(ident)

    def _waiting_interaction(self, run_id, job_id):
        checkpoint = self.store.load_checkpoint(run_id=run_id)
        if checkpoint:
            task_id = checkpoint['task_id']
            self.store.finish(run_id, 'waiting_user', task_id=task_id, dependencies=checkpoint['dependencies'])
            if task_id and self.server.tasks.get(task_id)['state'] == 'running':
                self.server.tasks.transition(task_id, 'waiting_user')
        if job_id and self.jobs:
            self.jobs.store.settle(job_id, 'waiting_user', expected_run_id=run_id)
            self.jobs.publish()

    def _job_event(self, event):
        job = self.jobs.store.get(event['job_id'], private=True)
        payload = job.get('payload') or {} if job else {}
        self.server.feed.publish('background_job', {**event, 'source':'task_notice', 'not_user_authorization':True,
            'run_id':job['run_id'] if job else None, 'conversation_id':job['conversation_id'] if job else None,
            'character_id':payload.get('character_id'), 'parent_run_id':payload.get('source_run_id')})
        kind = {'succeeded': 'job_done', 'needs_review': 'job_done', 'failed': 'job_failed'}.get(event['state'])
        if kind and self.server.behavior is not None:
            self.server.behavior.event(kind)
        if job and self.deliveries:
            self.deliveries.produce(job['run_id'])
        if job and job['payload'] and job['payload'].get('source_run_id'):
            self._settle_background_parent(job['payload']['source_run_id'])

    def _settle_background_parent(self, run_id):
        run = self.store.get(run_id)
        if not run or run['state'] != 'completed' or not run.get('task_id') or not isinstance(run.get('result'), dict): return
        ids = run['result'].get('background_jobs', [])
        if not ids: return
        jobs = [self.jobs.store.get(i) for i in ids]
        if any(not j or j['state'] in ('running', 'queued', 'waiting_user') for j in jobs): return
        # No parent-specific content check was run. Child completion alone does
        # not certify a larger goal, even when each child passed its own checks.
        with self._lock:
            task = self.server.tasks.get(run['task_id'])
            if not task or task['state'] != 'running': return
            if all(j['state'] == 'cancelled' for j in jobs):
                self.server.tasks.transition(task['task_id'], 'cancelled', result={'reason': 'background_work_cancelled', 'background_jobs': ids})
                return
            self.server.tasks.transition(task['task_id'], 'returned')
            self.server.tasks.transition(task['task_id'], 'verifying')
            failed = any(j['state'] in ('failed', 'cancelled', 'interrupted') for j in jobs)
            self.server.tasks.transition(task['task_id'], 'failed' if failed else 'needs_review',
                result={'reason': 'background_work_returned', 'background_jobs': ids,
                    'validation_scope': 'child_tasks_only', 'child_states': {j['job_id']: j['state'] for j in jobs}})
        if self.deliveries: self.deliveries.produce(run_id)

    def _recover_jobs(self):
        for job in self.jobs.store.list(states=('running',), limit=None):
            if self.jobs.is_active(job['job_id'], job['run_id']): continue
            if self.jobs.store.leased(job['job_id']): continue
            run = self.store.get(job['run_id'])
            task = self.server.tasks.get(run['task_id']) if run and run.get('task_id') and self.server.tasks else None
            if run and run['state'] == 'completed' and task:
                self.jobs.store.settle(job['job_id'], task['state'] if task['state'] in ('succeeded', 'failed', 'needs_review') else 'interrupted',
                    {'task_id': task['task_id'], 'recovered': True, 'validation': task['result']}, expected_run_id=job['run_id'])
            else:
                if task and task['state'] in ('running', 'returned', 'verifying'):
                    self.server.tasks.transition(task['task_id'], 'interrupted')
                self.jobs.store.settle(job['job_id'], 'interrupted', {'reason': 'process_restarted'}, expected_run_id=job['run_id'])
        if self.jobs.store.list(states=('queued',), limit=1): self.jobs.start()
        self.jobs.publish()
        for parent_id in self.jobs.store.source_parents():
            self._settle_background_parent(parent_id)

    def submit_job(self, title, user_request, instruction, scope_id=None, *, goal_id=None, config=None,
                   character_id=None, source_run_id=None, expected_outputs=None, resume_run_id=None,
                   conversation_id=_INFER_CONVERSATION, valid=lambda: True):
        if self.jobs is None: raise ValueError('job_store_unavailable')
        if not isinstance(user_request, str) or not 1 <= len(user_request) <= 8000 or not isinstance(instruction, str) or not 1 <= len(instruction) <= 8000:
            raise ValueError('invalid_job_instruction')
        if scope_id: self.workspace.validate_scope(scope_id)
        if not config:
            self._auto_select()
            route = self.public()['routes']['background']
            if not route['ready']: raise KernelNotReady(route['error'], route['backend'])
        config = dict(config or self.settings.snapshot())
        if config['backend'] not in HARNESSES: raise ValueError('unsupported_harness')
        _, epoch = self.server.sync_privacy()
        if not valid() or self.server.resetting or self.server.closing: raise ValueError('run_cancelled')
        payload = {'user_request': user_request, 'instruction': instruction, 'scope_id': scope_id,
                   'config': config, 'character_id': character_id or self.server.character, 'consent_epoch': epoch,
                   'source_run_id': source_run_id, 'expected_outputs': expected_outputs}
        if resume_run_id: payload['resume_run_id'] = resume_run_id
        require_conversation = conversation_id is not _INFER_CONVERSATION and conversation_id is not None
        if conversation_id is _INFER_CONVERSATION:
            source = self.store.get(source_run_id) if source_run_id else None
            conversation_id = source['conversation_id'] if source else self.server.history.conversations.active if self.server.history else None
        job = self.jobs.store.submit(title, payload, goal_id, conversation_id=conversation_id, source_turn_id=source_run_id,
                                     require_conversation=require_conversation)
        self.jobs.start(); return job

    def _job_tasks(self):
        """{task_id: job} over every job's current run and the run it resumes."""
        owned = {}
        for job in self.jobs.store.list(limit=None, private=True) if self.jobs else ():
            for run_id in (job['run_id'], job['previous_run_id'], (job['payload'] or {}).get('resume_run_id')):
                task_id = (self.store.get(run_id) or {}).get('task_id') if run_id else None
                if task_id: owned.setdefault(task_id, job)
        return owned

    def adopt_task(self, task_id, user_request, instruction, *, source_run_id=None, **submit):
        """A queued background job that resumes the latest checkpoint of a foreground task of this character."""
        task = self.server.tasks.get(task_id) if self.server.tasks else None
        checkpoint = self.store.load_checkpoint(task_id=task_id)
        run = self.store.get(checkpoint['run_id']) if checkpoint else None
        if task is None or task['target'] != 'character' or run and run['character_id'] != (submit.get('character_id') or self.server.character):
            raise ValueError('unknown_task')
        if run is None or run['run_id'] == source_run_id: raise ValueError('checkpoint_missing')
        return self.submit_job(task['title'][:200], user_request, instruction, checkpoint['scope_id'],
                               source_run_id=source_run_id, resume_run_id=run['run_id'], **submit)

    def _execute_job(self, job, cancel):
        server = self.server
        started = time.monotonic()
        trace = server._open_trace(job['run_id'], job['generation'], 'background', '', remember=False, detached=True)
        traced = TURN_TRACE.set(trace['trace_id'])
        result = {}
        error = None
        try:
            result = self._run_job(job, cancel, trace)
            error = result.get('error')
            return result
        except Exception as exc:
            error = exc
            raise
        finally:
            run = self.store.get(job['run_id'])
            state = run['state'] if run and run['state'] != 'running' else 'cancelled' if cancel.is_set() else 'failed'
            server._turn_settled(trace, state, started, error, result.get('job_state'))
            TURN_TRACE.reset(traced)

    def _run_job(self, job, cancel, trace):
        s, p = self.server, job['payload']
        config, cid = p['config'], p['character_id']
        config = RuntimeSettings.route(config, 'background')
        current = lambda: not cancel.is_set() and not s.resetting and not s.closing and s.consent.snapshot()[1] == p['consent_epoch'] \
            and self.jobs.store.get(job['job_id']) is not None
        card, motion = bound(s.characters.load_card(cid), effective(s, cid))
        setting = self.settings.snapshot()['reply_language']
        card = localized(card, self.reply_language.current(setting))
        system = render_brief_persona(card) + '\n' + persona_personal_instructions(card)
        system += ('\n<background_job>\n'
                   'Background job: the user handed you this work and is not waiting on your words; they will read your result directly and '
                   'the character will report it, so it must stand on its own.\n'
                   'First settle what the request must deliver and what counts as done. The assignment in the material is the main session\'s plan: '
                   'where it conflicts with the user\'s latest request, follow the user, and it never widens permission. Then plan, work step by step '
                   'and check the result against the request; fix and check again on failure. Use ask_user only for a missing fact that would make '
                   'the result wrong; otherwise assume, and state the assumption in the result.\n'
                   'Start no sub-jobs and don\'t move the character or the desktop.\n'
                   'Deliver readable text without speech, intent or motion markers. The first sentence is the result: what was done and where the '
                   'output is, or where it is stuck. Then the complete deliverable, free of the everyday line length; end briefly with what was '
                   'checked and what could not be checked or finished. The character\'s voice takes at most the first sentence.\n'
                   '</background_job>')
        if p['scope_id']:
            scope = self.workspace.get_scope(p['scope_id'])
            system += ('\nAuthorized material, to read with your own file tools: '
                       + s.egress.observed(', '.join([f['path'] for f in scope.get('files', [])] + [r['path'] + '/' for r in scope['roots']])) + '.')
        if p['scope_id']:
            system += '\nYou may read the authorized material as needed. Use task_plan only when the job must produce files: list them in outputs, write them, and check each with artifact_verify. When you answer from material, put the answer in the result.'
        else:
            system += '\nThis job has no authorized folder: deliver text in the result, without task_plan or file tools. If files were asked for, deliver the content as text and say the user must pick folders in settings before it can be written to files.'
        if setting != 'harness':
            system += '\n' + SYSTEM_RULE
        context = {'local_time': local_time(datetime.now().astimezone()), 'background_assignment': s.egress.user_text(p['instruction'])}
        conversations = s.history.conversations if s.history else None
        if conversations and conversations.get(job['conversation_id']):
            context['recent_conversation'] = [{'user': s.egress.user_text(turn['user_text']), 'reply': s.egress.observed(turn['reply'])}
                                              for turn in conversations.turns(job['conversation_id'], limit=6)['turns']]
        knowledge = self.knowledge(character_id=cid)
        runtime = PersonalAgentRuntime(self.state_dir / 'character-agent', self._session_factory_bound(config, job['run_id']),
            lambda: knowledge, self.workspace, tasks=s.tasks, backend=config['backend'], model=self._model(config),
            event_sink=lambda event: self._event(event, work_kind='background', job_id=job['job_id']),
            run_store=self.store, tools=self.tools, effort=config['_turn_effort'])
        with self._lock: self._background_runtimes[job['run_id']] = (job['job_id'], runtime)
        span, started = new_span_id(), time.monotonic()
        s._step(trace, "model.started", span, attrs={"model": runtime.model or DEFAULT_MODEL, "call": "character_agent"})
        try:
            resume_id = job['previous_run_id']
            if not resume_id or not self.store.load_checkpoint(run_id=resume_id):
                resume_id = p.get('resume_run_id')
            answer = runtime.run(run_id=job['run_id'], text=s.egress.user_text(p['user_request']), system_prompt=system,
                history=[], context=json.dumps(context,ensure_ascii=False), before_input=self.reply_language.tag(setting), language=self.semantic.reply(),
                character_id=cid, generation=job['generation'], conversation_id=job['conversation_id'], scope_id=p['scope_id'], cancelled=cancel, is_current=current,
                expected_outputs=p.get('expected_outputs'), resume_run_id=None if p.get('start_fresh') else resume_id,
                knowledge_service=knowledge, mode='background',
                question_session=QuestionTurn(self.interactions, config['interactive_tools'], job["run_id"], cid,
                                              p["user_request"], p["scope_id"], job["job_id"]),
                on_first_token=lambda: s._step(trace, "model.first_token", span),
                on_tool=lambda *event: s._trace_tool(trace, *event))
            adapter = harness(runtime.backend)
            s._step(trace, "model.finished", span, status="failed" if answer.error else "ok",
                    duration_ms=round((time.monotonic() - started) * 1000), attrs={
                        "model": answer.model or DEFAULT_MODEL, "provider": adapter.provider or config.get('provider') or 'unknown',
                        "account_label": runtime.backend + "_" + config["auth_source"],
                        "input_tokens": answer.usage.get("input_tokens") or 0,
                        "output_tokens": answer.usage.get("output_tokens") or 0, "stop_reason": answer.error or "end_turn",
                        **finished_usage(answer)})
            task = s.tasks.get(answer.task_id) if answer.task_id and s.tasks else None
            # A run refused before it began (scope_changed, effect_unknown) has no row.
            run = self.store.get(job['run_id']) or {}
            failure = (run.get('result') or {}).get('failure') or {} if answer.error else {}
            return {'job_state': 'cancelled' if not current() else 'waiting_user' if run.get('state') == 'waiting_user' else 'failed' if answer.error else task['state'] if task else 'needs_review',
                    'run_id': job['run_id'], 'task_id': answer.task_id, 'reply': answer.text,
                    'error': answer.error, 'reason': failure.get('code') if failure.get('code') in JOB_FAILURE_REASONS else None,
                    'validation': answer.result}
        finally:
            runtime.close()
            with self._lock: self._background_runtimes.pop(job['run_id'], None)
            self.tools.close(job['run_id'], 'run_end')

    def _cancel_job(self, ident):
        with self._lock:
            runtimes = [runtime for job_id, runtime in self._background_runtimes.values() if job_id == ident]
        job = self.jobs.store.get(ident, private=True)
        interrupted = job['state'] == 'interrupted'
        reason = job['result']['reason'] if interrupted else 'user_cancelled_task'
        run = self.store.get(job['run_id'])
        if run and run['state'] == 'waiting_user':
            self.store.finish(run['run_id'], job['state'], task_id=run['task_id'], dependencies=run['dependencies'],
                result={'error': reason})
            if run['task_id']: self.server.tasks.transition(run['task_id'], job['state'])
            self.interactions.invalidate(run_ids={run['run_id']})
        elif run is None and (job['payload'] or {}).get('resume_run_id'):
            original = self.store.get(job['payload']['resume_run_id'])
            if original and original['state'] == 'waiting_user' and original['task_id']:
                task = self.server.tasks.get(original['task_id'])
                if task and task['state'] == 'waiting_user':
                    self.server.tasks.transition(original['task_id'], job['state'])
        for runtime in runtimes: runtime.cancel(reason, interrupted=interrupted)

    def resume_job(self, ident, *, text='', use_current_backend=False):
        job = self.jobs.store.get(ident, private=True) if self.jobs else None
        if job is None: raise ValueError('unknown_job')
        missing_checkpoint = self.store.load_checkpoint(run_id=job['run_id']) is None
        if self.tools.ledger.unsettled(job['run_id']): raise ValueError('effect_unknown')
        if any(e['state'] != 'committed' for e in self.tools.ledger.reconcile(job['run_id'], self.workspace)): raise ValueError('effect_unknown')
        if missing_checkpoint and (self.tools.ledger.effects(job['run_id']) or self.workspace.run_artifacts(job['run_id'])):
            raise ValueError('checkpoint_missing')
        start_fresh = missing_checkpoint and not job['payload'].get('resume_run_id')
        if job['payload']['scope_id']: self.workspace.validate_scope(job['payload']['scope_id'])
        if use_current_backend: self._auto_select()
        config = self.settings.snapshot() if use_current_backend else None
        if config and config['backend'] not in HARNESSES: raise ValueError('unsupported_harness')
        _, epoch = self.server.sync_privacy()
        value = self.jobs.store.resume(ident, text=text, config=config, consent_epoch=epoch, start_fresh=start_fresh); self.jobs.start(); return value

    def update_goal(self, ident, revision, state):
        if state == 'completed':
            for job in self.jobs.store.list(goal_id=ident, states=('succeeded', 'accepted'), limit=None, private=True):
                # A text-only result has no files to check again.
                if job['payload'].get('expected_outputs') is None and not self.workspace.run_artifacts(job['run_id']): continue
                check = self.workspace.verify_run(job['run_id'], job['payload']['scope_id'])
                if not check.get('ok'): raise ValueError('goal_results_not_current')
        value = self.jobs.store.update_goal(ident, revision, state)
        if state in ('paused', 'cancelled'):
            for job in self.jobs.store.list(goal_id=ident, states=('running', 'queued', 'waiting_user'), limit=None):
                self.jobs.cancel(job['job_id'], 'goal_' + state, interrupted=state == 'paused')
        return value

    def _credential(self, config=None):
        config = config or self.settings.snapshot()
        if self.credential_override:
            return self.credential_override()
        h = harness(config["backend"])
        if h and h.provider is None and not config["provider"]:
            return self._pi_route(config)[1]
        provider = h.provider if h and h.provider else config["provider"]
        if provider == "anthropic":
            return self.settings.credential(self.server.models)
        models = self.server.models.snapshot() if self.server.models else {}
        value = models.get("backends", {}).get(provider, {})
        if provider == "openai" and value.get("base_url", "https://api.openai.com/v1").rstrip("/") != "https://api.openai.com/v1":
            raise ValueError("unsupported_openai_endpoint")
        if not value.get("api_key"):
            raise ValueError("missing_provider_api_key")
        return value["api_key"]

    def installed_runtimes(self, refresh=False, *, wait=True):
        if self.discovery is None:
            return []
        rows = (self.discovery.scan(refresh, wait=wait) if isinstance(self.discovery, DiscoveryService)
                else self.discovery.scan(refresh))["runtimes"]
        return [{**row, "backend": backend,
                 "login_command": shlex.quote(row["path"]) + HARNESSES[backend].login_suffix
                 if row.get("path") and backend in HARNESSES and HARNESSES[backend].login_suffix else None}
                for row in rows for backend in (DISCOVERED.get(row["backend"], row["backend"]),)]

    def _selected_runtime(self, config, *, wait=True):
        if config['runtime_source'] == 'local' and config['executable'] and hasattr(self.discovery, 'inspect_runtime'):
            found = self.discovery.inspect_runtime(config['executable'],
                HARNESSES[config['backend']].discovery_name,
                **({'wait': wait} if isinstance(self.discovery, DiscoveryService) else {}))
            return {**found, 'backend': config['backend']} if found else None
        candidates = [r for r in self.installed_runtimes(wait=wait) if r["backend"] == config["backend"] and
                      (not config["executable"] or r["path"] == config["executable"])]
        if not candidates and config["executable"]:
            found = self.discovery.inspect_runtime(config["executable"],
                HARNESSES[config["backend"]].discovery_name)
            if found:
                candidates = [{**found, "backend": config["backend"]}]
        candidates.sort(key=lambda r: (not r.get("entry_supported", False), not r["authenticated"]))
        return candidates[0] if candidates else None

    def _auto_select(self, refresh=False, *, wait=True):
        """Without a saved choice, keep the bundled pi; only when it is unavailable or 「pi 账号与凭据」 gives it no
        connection, take a logged-in local Codex.
        Turn paths pass refresh False: after the first choice they skip discovery, whose probes take seconds."""
        if self.settings.saved or self.settings.error or self.session_factory_override is not None:
            return False
        if self._auto_chosen and not refresh:
            return True
        choice = {}
        pi = next(row for row in self.available_backends(wait=wait) if row["id"] == "pi")["available"]
        if pi:
            try:
                self._pi_route(RuntimeSettings.validate({}))
            except ValueError as failure:
                pi = str(failure) != "pi_connection_missing"
        if not pi:
            rows = self.installed_runtimes(wait=wait)
            if not rows and not wait: return False
            if any(r["backend"] == "codex" and r["entry_supported"] and r["authenticated"] for r in rows):
                choice = {"backend": "codex", "runtime_source": "local", "executable": None,
                          "auth_source": "existing_login"}
        self.settings.apply_default(choice)
        self._auto_chosen = True
        return True

    def _pi_available(self):
        from character_agent.harness.pi_config import resolve_pi_runtime
        node, runtime = resolve_pi_runtime(self.harness_sites.get("harness.pi"))
        return Path(node).is_file() and (Path(runtime) / "node_modules/@earendil-works/pi-coding-agent/package.json").is_file()

    def _pi_backend(self):
        """Pi's available_backends row, read without runtime discovery."""
        enabled = plugins.on("light_ai")
        available = enabled and (self.session_factory_override is not None or self._pi_available())
        return {"id": "pi", "available": available, "reason": "runtime_missing" if enabled else "plugin_off"}

    def available_backends(self, *, wait=True):
        rows = self.installed_runtimes(wait=wait)
        pi = plugins.on("light_ai") and self._pi_available()
        from character_agent.harness import acp_agents
        acp = self.discovery is not None and (bool(acp_agents.find_local()) or any(
            shutil.which(runner, path=acp_agents.search_path()) for runner in ("npx", "uvx")))
        found = {row["backend"] for row in rows if row["entry_supported"]}
        if pi: found.add("pi")
        if acp: found.add("acp")
        backends = []
        for key, h in HARNESSES.items():
            enabled = plugins.on("light_ai" if key == "pi" else "harness_bridge")
            available = enabled and (key in found or self.session_factory_override is not None)
            reason = None if available else "runtime_missing" if enabled else "plugin_off"
            backends.append({"id": key, "title": h.title, "available": available, "reason": reason})
        return backends

    def public(self, discover=False, *, wait=True):
        if discover and self.discovery is not None:
            self.discovery.scan(refresh=True)
            wait = True
        pending = (not wait and isinstance(self.discovery, DiscoveryService) and
                   self.discovery.scan(wait=False)['scanned_at'] is None)
        auto_selected = self._auto_select(refresh=discover, wait=wait)
        config = self.settings.snapshot()
        available = self.available_backends(wait=wait)
        error, selected = self._readiness(config, available, pending, wait, self.settings.error)
        h = harness(config["backend"])
        routes = {}
        for purpose in ROUTES:
            entry = config["routes"].get(purpose)
            if entry is None:
                failure = (self._readiness(config, available, pending, wait, self.settings.error, locked=True)[0]
                           if purpose in LOCKED_ROUTES and config["backend"] == "acp" else error)
                routes[purpose] = {"backend": config["backend"], "acp_agent": config["acp_agent"] if config["backend"] == "acp" else None,
                                   "model": None, "effort": None, "follows_main": True, "ready": failure is None, "error": failure}
            else:
                failure = self._readiness(RuntimeSettings.route(config, purpose), available, pending, wait,
                                          locked=purpose in LOCKED_ROUTES)[0]
                routes[purpose] = {**entry, "follows_main": False, "ready": failure is None, "error": failure}
        value = {**config, "routes": routes, "ready": error is None, "error": error, "auto_selected": auto_selected, "available_backends": available,
                "installed_runtimes": self.installed_runtimes() if discover else [],
                "selected_runtime": selected, "busy": self.busy(),
                "capability_flags": {"product_checkpoint": True, "cost_limit_supported": h is not None and h.cost_limit_supported,
                    # A session override runs no Pi runtime.
                    "catalog_priced": config["backend"] == "pi" and error is None and not self.session_factory_override
                        and self._catalog_priced(config),
                    "native_images": False, "custom_tools": True},
                "pi_session": self._pi_facts, "product_login": self.logins.public()}
        self._last_public = value
        value["capabilities"] = describe_capabilities(config, selected, computer_use_ready=self._computer_use_ready(config))
        from character_agent.services.providers import catalog
        value['provider_profiles'] = catalog()
        return value

    def route_error(self, config):
        """The readiness error of a routed kernel config (RuntimeSettings.route) for a run that keeps the harness's own
        tools off; None when it can run."""
        available = [self._pi_backend()] if config["backend"] == "pi" else self.available_backends()
        return self._readiness(config, available, False, True, locked=True)[0]

    def _readiness(self, config, available, pending, wait, error=None, locked=False):
        """(error, selected runtime) of a kernel config as /character/runtime reports them; error None is ready.
        locked: its runs keep the harness's own tools off."""
        selected = None
        h = harness(config["backend"])
        if h:
            entry = next(row for row in available if row["id"] == config["backend"])
            if not entry["available"]:
                error = 'runtime_discovery_pending' if pending and entry['reason'] != 'plugin_off' else entry["reason"]
            elif self.server.no_character or plugins.on("light_ai") and self.server.mouth is None:
                error = "character_context_unavailable"
            elif not self.session_factory_override:
                if h.discovery_name:
                    selected = self._selected_runtime(config, wait=wait)
                    if selected is None:
                        error = ('runtime_probe_pending' if not wait and isinstance(self.discovery, DiscoveryService)
                                 and config['executable'] and os.access(config['executable'], os.X_OK) else
                                 "local_runtime_missing")
                    elif not selected["entry_supported"]:
                        error = "runtime_protocol_unavailable"
                    elif config["auth_source"] == "existing_login" and not selected["authenticated"]:
                        error = "native_login_required"
                    elif config["auth_source"] == "product_login":
                        signed_in = self.logins.signed_in(config["backend"], selected["path"], wait)
                        error = "product_login_checking" if signed_in is None else None if signed_in else "product_login_required"
                elif config["backend"] == "acp":
                    error = self._acp_error(config, wait, locked)
                elif h.provider is None:
                    if config["runtime_source"] == "local" and (not config["executable"] or
                            not os.access(config["executable"], os.X_OK)):
                        error = "local_node_missing"
                    elif config["provider"] and not config["model"]:
                        error = "pi_provider_model_required"
                if h.provider is None and error is None:
                    try:
                        self._pi_connection(config)
                    except ValueError as failure:
                        error = str(failure)
                # pi's existing_login is the credential Endfield holds, not a native login. DeepSeek Harness's key: _acp_error.
                if (config["auth_source"] == "api_key" and config["backend"] != "acp" or
                        h.provider is None and config["auth_source"] == "existing_login") and error is None:
                    try:
                        self._credential(config)
                    except ValueError as failure:
                        error = str(failure)
        return error, selected

    def _acp_error(self, config, wait, locked):
        from character_agent.harness.acp_agents import lockable
        agent = acp_agent(config)
        if agent is None:
            return "acp_agent_missing"
        if locked and not lockable(agent):
            return "acp_agent_unrestricted"
        if agent["id"] == "deepseek-harness":
            if config["auth_source"] == "api_key":
                return None if self.deepseek_key() else "missing_provider_api_key"
            signed_in = self.logins.signed_in("deepseek", deepseek_account_command(agent), wait)
            return "product_login_checking" if signed_in is None else None if signed_in else "product_login_required"
        probe = self._acp_probes.get(agent["id"])
        if probe is not None and not probe["ok"]:
            return "acp_auth_required"
        if self._acp_logins.get(agent["id"]) is False and (probe is None or probe["auth_methods"]):
            return "acp_auth_required"
        return None

    def deepseek_key(self):
        """The DeepSeek API key saved under 「AI 账号」, or None."""
        return ((self.server.models.snapshot() if self.server.models else {}).get("backends", {}).get("deepseek") or {}).get("api_key") or None

    def _acp_signed_in(self, agent_id, signed_in):
        self._acp_logins[agent_id] = signed_in
        self._acp_probes.pop(agent_id, None)

    def login(self, action, body):
        """POST /character/login/<action>: start, cancel or log out the sign-in of the saved kernel: Codex or Claude Code
        in the app's own profile (product_login), or the ACP agent in its own login. `method_id` picks an ACP method."""
        if set(body) - ({"method_id"} if action == "start" else set()) or not isinstance(body.get("method_id", ""), str):
            raise ValueError("invalid_payload")
        if action == "cancel":
            return self.logins.cancel()
        config = self.settings.snapshot()
        if config["backend"] == "acp":
            agent = acp_agent(config)
            if agent is None:
                raise ValueError("acp_agent_missing")
            if agent["id"] == "deepseek-harness":
                if config["auth_source"] != "existing_login":
                    raise ValueError("product_login_not_selected")
                if action == "logout":
                    return self.logins.logout("deepseek")
                return self.logins.start("deepseek", deepseek_account_command(agent))
            if action == "logout":
                return self.logins.logout("acp", agent=agent)
            from character_agent.harness.acp_agents import probe
            methods = probe(agent["command"], agent.get("env"))["auth_methods"]
            # Without a pick, the first method that takes no API key or gateway (input the page does not collect): the page
            # lists the methods only after a probe.
            method = next((m for m in methods if m.get("id") == body["method_id"]) if "method_id" in body else
                          (m for m in methods if not {"api-key", "gateway"} & set(m.get("_meta") or {})), None)
            if method is None:
                raise ValueError("unknown_auth_method")
            return self.logins.start("acp", agent=agent, method=method)
        if config["auth_source"] != "product_login":
            raise ValueError("product_login_not_selected")
        selected = self._selected_runtime(config)
        if selected is None:
            raise ValueError("local_runtime_missing")
        if action == "logout":
            return self.logins.logout(config["backend"], selected["path"])
        return self.logins.start(config["backend"], selected["path"])

    def acp_agents(self, refresh=False):
        """Local ACP agents (initialize-probed on refresh) and the registry's npx/uvx ones, which are never run here."""
        from concurrent.futures import ThreadPoolExecutor
        from character_agent.harness import acp_agents
        local, launchable = acp_agents.find_local(), acp_agents.launchable()
        if refresh and local:
            def probe(agent):
                env = {"PATH": acp_agents.search_path(), **acp_agents.PROFILE_ENV.get(agent["id"], {})}
                return acp_agents.probe(agent["command"], env, timeout=10)
            with ThreadPoolExecutor(max_workers=len(local)) as pool:
                probes = dict(zip((a["id"] for a in local), pool.map(probe, local)))
            with self._lock:
                self._acp_probes = probes
        versions = {agent["id"]: agent["version"] for agent in acp_agents.registry()["agents"]}
        rows = []
        for agent in local + launchable:
            probe = self._acp_probes.get(agent["id"]) if agent["source"] == "local" else None
            info = probe["agent_info"] if probe and isinstance(probe["agent_info"], dict) else {}
            rows.append({"id": agent["id"], "name": agent["name"],
                         # A local install's version is known only from its own initialize reply.
                         "version": info.get("version") if agent["source"] == "local" else versions[agent["id"]],
                         "source": agent["source"], "command": agent["command"],
                         "probe": {key: probe[key] for key in ("ok", "agent_info", "auth_methods", "error")}
                         if probe else None,
                         "native_backend": acp_agents.NATIVE_BACKENDS.get(agent["id"])})
        path = acp_agents.search_path()
        return {"agents": rows, "npx": bool(shutil.which("npx", path=path)), "uvx": bool(shutil.which("uvx", path=path))}

    def acp_install(self, agent_id):
        """The user's 安装 click: a global npm/uv install of one registry agent, so it lists as local afterwards."""
        from character_agent.harness import acp_agents
        return acp_agents.install(agent_id)

    def _harness_permission(self, request, source, agent_name):
        """One harness permission request as an approval card; the allow_once option id once the user allows it.
        source: claude, codex, pi or acp_agent."""
        run_id = request["run_id"]
        run = self.store.get(run_id)
        allow = next((o["option_id"] for o in request.get("options") or []
                      if isinstance(o, dict) and o.get("kind") == "allow_once"), None)
        if run is None or allow is None:
            return None
        # The card is stored and shown: its command may carry a credential.
        preview = {"source": source, "agent": agent_name, "title": request.get("title"), "kind": request.get("kind"),
                   "locations": request.get("locations"),
                   "raw_input": json.loads(redact(json.dumps(request.get("raw_input"), ensure_ascii=False), contacts=False)[0])}
        if isinstance(preview["title"], str): preview["title"] = redact(preview["title"], contacts=False)[0]
        dangerous, rule = harness_danger(request)
        try:
            self.interactions.approve(run_id, preview,
                valid=lambda: (self.store.get(run_id) or {}).get("state") in ("running", "awaiting_approval"),
                character_id=run["character_id"], scope_id=run["scope_id"], language=self.semantic.reply(),
                dangerous=dangerous, danger_rule=rule)
        except ValueError:
            return None
        return allow

    def capability(self):
        """No process or network probe from polling diagnostics."""
        status = self._last_public
        if status is None:
            return {"state": "unknown", "reason": "runtime_not_scanned"}
        return {"state": "configured" if status["ready"] else "unavailable", "reason": status["error"]}

    def retention(self):
        """Seconds history is kept under the history_retention setting; None keeps it all."""
        return RETENTION[self.settings.snapshot()["history_retention"]]

    def _foreground_runtime(self):
        return self.runtime

    def busy(self):
        return bool(self.runtime and self.runtime.busy())

    def cancel_sides(self, events, reason):
        """Interrupt the side runs of these line cancel events; the events themselves are the server's."""
        with self._lock:
            runtimes = [runtime for cancel, runtime in self._side_runtimes.values() if cancel in events]
        for runtime in runtimes:
            runtime.cancel(reason)

    def _side_runtime(self, run_id):
        with self._lock:
            return self._side_runtimes.get(run_id, (None, None))[1]

    def _foreground_brief(self):
        foreground = self.runtime
        with foreground._lock if foreground else self._lock:
            active = dict(foreground._active) if foreground and foreground._active else None
        if active is None:
            return ''
        task = self.server.tasks.get(active['task_id']) if active.get('task_id') and self.server.tasks else None
        plan = next((item['summary'] for item in self.store.items(active['run_id'])
                     if item['item_id'] == active['run_id'] + ':plan'), None)
        return '\nForeground brief (state at query time): ' + json.dumps({
            'run_id': active['run_id'], 'request': self._foreground_request,
            'task': {'title': task['title'], 'state': task['state']} if task else None, 'plan': plan}, ensure_ascii=False)

    def delivered(self, history, line_id):
        if self.runtime:
            self.runtime.delivered(history)
        if line_id == self._main_line:
            # What the line saw and its own turn; a side line's turn added meanwhile stays unheard.
            seen, replies = self._main_seen
            own = [reply.turn for reply in replies if reply.turn is not None]
            self._main_heard = [turn for turn in history if any(turn is t for t in [*seen, *own])]

    def configure(self, data):
        if not isinstance(data, dict):
            raise ValueError("invalid_runtime_settings")
        with self._lock:
            old = self.settings.snapshot()
            # The executable belongs to the kernel it was picked for, as in RuntimeSettings.route.
            carried = {"executable": None} if data.get("backend", old["backend"]) != old["backend"] else {}
            config = RuntimeSettings.validate({**old, **carried, **data})
            if config["scope_id"] and self.workspace is not None:
                self.workspace.validate_scope(config["scope_id"])
            # Unchanged, or retention (read at each cleanup) and reply language (read at each turn) only: the running
            # runtime keeps going. Compared and saved under the lock, so a PUT read before another change cannot write
            # back stale settings.
            kept = ("history_retention", "reply_language")
            keep = {**old, **{key: config[key] for key in kept}} == config
            if keep:
                self.settings.save(config)
                if self._runtime_config is not None:
                    self._runtime_config.update({key: config[key] for key in kept})
        if keep:
            return self._configured()
        if self.jobs and old["interactive_tools"] and not config["interactive_tools"]:
            self.jobs.cancel_all('tools_disabled')
        self.cancel("runtime_changed")
        with self._lock:
            if self.runtime:
                self.runtime.close()
                self.runtime = None
            self.settings.save(config)
            self._runtime_config = None
        return self._configured()

    def _configured(self):
        # The GET's discovery cache: a forced rescan takes seconds and would hold back the settings switch.
        value = self.public()
        value["installed_runtimes"] = self.installed_runtimes()
        return value

    def continue_interaction(self, ident, revision):
        card = self.interactions.get(ident)
        if card is None: raise ValueError('interaction_version_changed')
        runtime = self._background_runtimes.get(card['run_id'], (None, None))[1] if card else None
        runtime = runtime or self.runtime
        if runtime and runtime._active and runtime._active['run_id'] == card['run_id']:
            with runtime._serial: pass
        # Match server.say's lock order. Never wait for a worker while holding
        # the turn fence: cancellation must remain able to release that worker.
        routes = self.public()['routes'] if card['data'] and not card['data']['job_id'] else None
        with self.server._switch_lock, self.server._turn_lock:
            return self._continue_interaction(ident, revision, routes)

    def _continue_interaction(self, ident, revision, routes):
        row = self.interactions.claim(ident, revision)
        try:
            data = row['data']
            run = self.store.get(row['run_id'])
            if run is None or run['state'] == 'cancelled': raise ValueError('interaction_cancelled')
            if run and run['state'] not in ('completed', 'failed', 'interrupted', 'cancelled', 'waiting_user'): raise ValueError('interaction_still_running')
            if not data['job_id'] and row['conversation_id'] != self.server.history.conversations.active:
                raise ValueError('conversation_not_active')
            if data['character_id'] != self.server.character: raise ValueError('interaction_character_changed')
            if (data['scope_id'] or data['job_id']) and self.workspace is None:
                raise ValueError('plugin_off')
            if data['scope_id']: self.workspace.validate_scope(data['scope_id'])
            if self.tools.ledger.unsettled(row['run_id']): raise ValueError('effect_unknown')
            checkpoint = self.store.load_checkpoint(run_id=row['run_id'])
            if checkpoint is None: raise ValueError('checkpoint_missing')
            if not checkpoint.get('pending_tool'): raise ValueError('checkpoint_question_missing')
            # The checkpoint hands the answer to the resumed harness prompt.
            checkpoint['pending_tool']['result'] = {'answers': {key: [self.server.egress.user_text(value) for value in values]
                                                                for key, values in row['answer']['answers'].items()}}
            if not self.store.checkpoint(row['run_id'], checkpoint['task_id'], checkpoint):
                raise ValueError('interaction_cancelled')
            # Includes synchronous privacy invalidation during checkpoint validation.
            claimed = self.interactions.get(ident)
            current_run = self.store.get(row['run_id'])
            if claimed is None or claimed['state'] != 'resuming' or claimed['revision'] != revision + 1 or \
                    current_run is None or current_run['state'] == 'cancelled':
                raise ValueError('interaction_cancelled')
            if data['job_id']:
                value = self.resume_job(data['job_id'], use_current_backend=True)
                code = 202
            elif checkpoint['task_id'] and data['scope_id'] and (checkpoint.get('expected_outputs') or checkpoint.get('planned_outputs')):
                task = self.server.tasks.get(checkpoint['task_id']) if self.server.tasks else None
                if not task or task['state'] != 'waiting_user':
                    raise ValueError('interaction_cancelled')
                # Answering authorizes this saved task to continue. Give the worker the original
                # checked checkpoint instead of asking a new foreground model to re-plan it.
                route = routes['background']
                if not route['ready']: raise KernelNotReady(route['error'], route['backend'])
                value = self.submit_job(task['title'][:200], checkpoint['goal'], checkpoint['goal'], config=self.settings.snapshot(),
                    scope_id=data['scope_id'], character_id=data['character_id'], source_run_id=row['run_id'],
                    resume_run_id=row['run_id'], expected_outputs=checkpoint.get('expected_outputs'),
                    conversation_id=row['conversation_id'])
                code = 202
            else:
                if self.busy(): raise ValueError('character_busy')
                code, value = self.server.say(checkpoint['goal'],
                    scope_id=data['scope_id'], resume_run_id=row['run_id'], ready_chat=routes['chat'])
            if code == 202:
                # Product-owned lineage lets a stop racing after dispatch find
                # this exact continuation, including before its worker starts.
                continuation = {'run_id': value['run_id'],
                    'generation': value.get('generation', self.server.turn_generation),
                    'conversation_id': row['conversation_id'], 'character_id': data['character_id'],
                    'job_id': value.get('job_id') or data['job_id'], 'dispatch_epoch': self._continuation_epoch}
                with self.store.lock:
                    current_run = self.store.get(row['run_id'])
                    if current_run:
                        result = dict(current_run['result'] or {})
                        result['continuation'] = continuation
                        self.store.db.execute('UPDATE character_runs SET result=? WHERE run_id=?',
                            (json.dumps(result), row['run_id']))
                        self.store.db.commit()
            self.interactions.settle(ident, code == 202)
            return code, value
        except Exception:
            self.interactions.settle(ident, False)
            raise

    def _permitted(self, source, row=None):
        server = self.server
        if source in ('observations','task_context') and getattr(self,'observations',None):
            return self.observations.allowed()
        if source == 'briefs':
            return not server.resetting and not server.observation_paused()
        if source == "task_context": source = "behavior"
        if server.resetting:
            return False
        if source in ("history", "commitments"):
            return True
        if source in ('sessions', 'tasks', 'days'):  # work memory: each row needs the consents its inputs needed
            if server.observation_paused(): return False
            permissions = server.consent.snapshot()[0]
            return row is None or all(permissions.get(r, False) for r in row['requires'])
        if source == "memory":
            if row and row.get("source") not in ("asserted_by_user", "confirmed_by_user"):
                return server.page_text_allowed() and not server.observation_paused()
            return True
        if source == 'episodes' and row:
            requirements = {r for t in row.get('threads',[]) for r in t.get('requires',[])}
            if requirements and server.observation_paused(): return False
            permissions = server.consent.snapshot()[0]
            if any(not permissions.get(r,False) for r in requirements): return False
            try:
                scopes = {v for t in row.get('threads', []) for v in t.get('scope_ids', [])}
                if scopes and self.workspace is None: return False
                for scope in scopes: self.workspace.validate_scope(scope)
            except ValueError: return False
            return True
        if server.observation_paused() or not server.page_text_allowed():
            return False
        return source in ("episodes", "behavior")

    def _behavior(self):
        server = self.server
        if not self._permitted("behavior") or server.attention is None:
            return {"available": False}
        scene = server.activity()
        snapshot = server.attention.focus_snapshot()
        at = (snapshot or {}).get("observed_at")
        if not scene or not isinstance(at, (int, float)):
            return {"available": False}
        return {**scene, "available": True, "observed_at": at, "expires_at": at + 120}

    def knowledge(self, temporary=False, character_id=None):
        s = self.server
        permitted = (lambda source, row=None: source == "memory" and
                     (row is None or row.get("source") in ("asserted_by_user", "confirmed_by_user")) and not s.resetting) if temporary else self._permitted
        return KnowledgeService(s.memory, s.history, s.episodes, s.commitments,
            egress=s.egress, permitted=permitted, character_id=character_id or s.character, behavior_context=self._behavior,
            task_understanding=(lambda: self.observations.task_understanding_context(character_id))
                if not temporary and getattr(self, "observations", None) else None,
            observation_briefs=getattr(self, 'observation_briefs', None) if not temporary else None,
            observations=getattr(self,'observations',None) if not temporary else None,
            worklog=s.worklog if not temporary else None)

    def _computer_use_ready(self, config):
        bridge = self.server.computer_control
        return bool(bridge) and self._can_run_desktop_task(RuntimeSettings.route(config, 'computer'), bridge)

    def _can_run_desktop_task(self, config, bridge):
        from tool_gateway.computer_toolset import available
        # The computer route's own readiness (locked: the sub-run keeps the agent's tools off); never waits on a login.
        if config['backend'] == 'acp' and self._acp_error(config, False, True):
            return False
        probe = self._acp_probes.get(config['acp_agent']) if config['backend'] == 'acp' else None
        return available(config, bridge, probe and probe['capabilities'])

    def _avatar_motions(self):
        """(avatar_motions_list's rows, ids of the playable rows the user switched off): the performer's rows minus the
        current chooser's missing and switched-off ones; ([], set()) without a performer."""
        motion, chooser = getattr(self.server, 'motion', None), self.server.spatial.chooser
        if motion is None:
            return [], set()
        rows = [m for m in motion.motions() if chooser is None or m['id'] not in chooser.pack.missing]
        off = {m['id'] for m in rows if chooser is not None and not chooser.switches.get(m['id'], True)}
        return [m for m in rows if m['id'] not in off], off

    def _native(self, name, args, *, run_id, is_current):
        if not is_current():
            return {"error": {"code": "run_cancelled"}}
        if name == 'avatar_facing_status':
            if not isinstance(args,dict) or set(args)-{'behavior_id'} or 'behavior_id' in args and \
                    (not isinstance(args['behavior_id'],str) or not 1<=len(args['behavior_id'])<=64):
                return {'error':{'code':'invalid_arguments'}}
            return self.server.spatial.facing_status(args.get('behavior_id'))
        if name == 'avatar_face':
            from observation.facing_decisions import validate
            try:
                if not isinstance(args,dict) or set(args)-{'yaw_degrees','reason','hold_seconds'}:raise ValueError()
                value={'yaw_degrees':args.get('yaw_degrees'),'reason':args.get('reason'),'hold_seconds':args.get('hold_seconds',60)}
                validate(value)
                if value['yaw_degrees'] is None:raise ValueError()
                if getattr(self.server,'facing_decisions',None):self.server.facing_decisions.defer(value['hold_seconds'])
                trace = self.server._turn_trace
                trace = trace if trace and trace['turn_id'] == run_id and self.server._traced(trace) else None
                linkage = {'trace_id': trace['trace_id'], 'trace_turn_id': run_id,
                           'trace_epoch': (trace['reset'], trace['history'], trace['trace_generation'])} if trace else {}
                result = self.server.spatial.request_facing(value['yaw_degrees'], value['reason'], value['hold_seconds'],
                                                           valid=is_current, **linkage)
                if trace and result.get('accepted'):
                    self.server._step(trace, 'behavior.dispatched', new_span_id(),
                        attrs={'behavior_id': result['behavior_id'], 'behavior_type': 'face'})
                return result
            except (ValueError,TypeError):return {'error':{'code':'invalid_facing_decision'}}
        if name == 'avatar_motions_list':
            if args != {}:
                return {'error':{'code':'invalid_arguments'}}
            return {'motions': self._avatar_motions()[0]}
        if name == 'avatar_motion':
            if not isinstance(args,dict) or set(args)!={'action_id','reason'} \
                    or not all(isinstance(v,str) for v in args.values()) \
                    or not 1<=len(args['action_id'])<=64 or not 1<=len(args['reason'])<=200:
                return {'error':{'code':'invalid_arguments'}}
            listed, off = self._avatar_motions()
            if args['action_id'] in off:
                return {'accepted':False,'reason':'switched_off'}
            if args['action_id'] not in {m['id'] for m in listed}:
                return {'accepted':False,'reason':'unknown_action'}
            trace = self.server._turn_trace
            trace = trace if trace and trace['turn_id'] == run_id and self.server._traced(trace) else None
            linkage = {'trace_turn_id': run_id,
                       'trace_epoch': (trace['reset'], trace['history'], trace['trace_generation'])} if trace else {}
            result = self.server.motion.play_action(args['action_id'],
                generation=trace['generation'] if trace else self.server.turn_generation,
                trace_id=trace['trace_id'] if trace else new_trace_id(), **linkage)
            if trace and result['accepted']:
                self.server._step(trace, 'behavior.dispatched', new_span_id(),
                    attrs={'behavior_id': result['behavior_id'], 'behavior_type': 'perform'})
            return result
        if name == 'avatar_outfits_list':
            return {'error':{'code':'invalid_arguments'}} if args != {} else self.looks.outfits()
        if name == 'avatar_outfit':
            return self.looks.change(args)
        self.tools.verdict(run_id, name, self.tools.policy.desktop("character", name))
        if name == 'desktop_task':
            from tool_gateway.computer_toolset import run_desktop_task
            config = RuntimeSettings.route(self.settings.snapshot(), 'computer')
            if not self._can_run_desktop_task(config, self.server.computer_control):
                return {'error': {'code': 'desktop_task_unavailable'}}
            actor = 'desktop-task-' + uuid.uuid4().hex
            return run_desktop_task(lambda method, params, **options: self.tools.desktop.computer_call(
                SessionKey('character', run_id, None), method, params, **options), args,
                # The sub-run reads untrusted screenshots: no harness tools and no workspace beyond the leased window.
                config=config, session_factory=lambda definitions, sub: self._session_factory(definitions, sub, actor,
                    native_tools=False, private_workspace=True, max_turns=sub.get('max_turns')),
                is_current=is_current, report=lambda event: self.tools.report('desktop.task_member', event, run_id))
        return self.tools.desktop.call(SessionKey("character", run_id, None), name, args)

    def _model(self, config):
        h = harness(config["backend"])
        model = config["model"] or (h.default_model if h else "")
        if not model and h and h.provider is None and not config["provider"]:
            try:
                model = self._pi_route(config)[2]
            except ValueError:
                pass
        return model

    def _pi_route(self, config):
        """(pi connection, key, model) of the provider saved in 「pi 账号与凭据」, for pi without a runtime provider."""
        from models.model_auth import ModelError
        models = self.server.models
        if models is None:
            raise ValueError("pi_connection_missing")
        try:
            provider, backend, key = models.connection()
        except ModelError as error:
            if str(error) == "secret_store_unavailable":
                raise ValueError(str(error)) from error
            raise ValueError("pi_connection_missing") from None
        return self._pi_mapped(config, provider, backend, key), key, backend.get("model", "")

    def _pi_mapped(self, config, provider, backend, key):
        if config["auth_source"] == "local_no_auth" and provider != "compatible":
            raise ValueError("local_no_auth_requires_compatible")
        if provider == "compatible":
            # pi's existing_login is the credential Endfield holds.
            auth = "api_key" if config["auth_source"] == "existing_login" else config["auth_source"]
            value = self._pi_connection({**config, "provider": "compatible", "auth_source": auth})
        elif provider in ("anthropic", "openai", "deepseek", "xai"):
            base_url = backend["base_url"].rstrip("/")
            if provider == "openai" and base_url != "https://api.openai.com/v1":
                raise ValueError("unsupported_openai_endpoint")
            # Pi's catalog model; the runner reroutes it only when base_url is not the catalog's.
            value = {"provider": provider, "auth_source": "api_key", "base_url": base_url}
        elif provider == "chatgpt":
            value = {"provider": "chatgpt", "auth_source": "api_key", "base_url": backend["base_url"].rstrip("/"),
                     "api": "openai-responses", "max_output_tokens": backend["max_output_tokens"]}
        elif provider == "pi_catalog" and backend["pi_provider"]:
            value = {"provider": backend["pi_provider"], "auth_source": "api_key", "base_url": ""}
        else:
            raise ValueError("pi_connection_missing")
        if value["auth_source"] != "none" and not key:
            raise ValueError("pi_connection_missing")
        return value

    def _pi_connection(self, config):
        provider = config["provider"]
        if not provider:
            value, _, model = self._pi_route(config)
            if not (config["model"] or model):
                raise ValueError("select_model")
            return value
        from character_agent.services.providers import PROFILES, connection
        if provider in PROFILES:
            return connection(provider, self.server.models.snapshot(), config['auth_source'])
        if provider != "compatible":
            if config["auth_source"] == "local_no_auth":
                raise ValueError("local_no_auth_requires_compatible")
            return {"provider": provider, "auth_source": config["auth_source"]}
        from urllib.parse import urlsplit
        compatible = self.server.models.snapshot()["backends"]["compatible"]
        endpoint = self.server.models.llm_url
        if endpoint is None:
            raise ValueError("llm_service_off")
        auth = "none" if config["auth_source"] == "local_no_auth" else config["auth_source"]
        if auth == "none" and urlsplit(endpoint).hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("unauthenticated_provider_requires_loopback")
        if auth == "existing_login":
            raise ValueError("native_login_requires_native_provider")
        return {"provider": "compatible", "auth_source": auth, "base_url": endpoint, "api": "openai-completions",
                "supports_images": compatible["supports_images"], "max_output_tokens": compatible["max_output_tokens"]}

    def _pi_ready(self, event):
        self._pi_facts = {key: event[key] for key in ("sdk_version", "builtin_tools", "builtin_tools_unavailable", "shell",
                                                       "tool_approval", "workspace_dir")}

    def _catalog_priced(self, config):
        """Whether Pi's offline catalog prices the main connection's model; only then does Pi count USD and stop a run at
        max_budget_usd."""
        provider = self._pi_connection(config)["provider"]
        if provider not in self._pi_prices:
            try:
                models = pi_catalog(self, provider)["models"]
            except ValueError:
                # A runtime that cannot list its catalog runs no session either; /character/runtime still answers.
                return False
            self._pi_prices[provider] = {m["id"]: m["priced"] for m in models}
        return self._pi_prices[provider].get(self._model(config), False)

    def _session_factory(self, definitions, config, actor_id=None, native_tools=True, max_turns=None, private_workspace=False,
                         spoken=False):
        """native_tools False: the harness's own tools stay off (semantic work, read-only role turns).
        max_turns: a semantic purpose's turn ceiling; None keeps the harness default."""
        if not plugins.on("light_ai" if config["backend"] == "pi" else "harness_bridge"):
            raise ValueError("plugin_off")
        if self.session_factory_override:
            return self.session_factory_override(definitions)
        key = self._credential(config) if config["auth_source"] == "api_key" else ""
        runner_root = self.state_dir / "character-agent" / "runner" / config["backend"]
        if actor_id: runner_root = runner_root / 'jobs' / actor_id
        # private: an empty directory of the actor's own, never the user's workspace
        workspace = runner_root / "workspace" if private_workspace else self.settings.workspace()
        if private_workspace:
            workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
        common = dict(state_dir=runner_root,
            api_key=key, model=self._model(config), runtime_source=config["runtime_source"],
            workspace_dir=str(workspace), native_tools=native_tools)
        # Only Pi's config has a turn ceiling; the semantic service counts tool calls for every harness.
        if max_turns is not None and config["backend"] == "pi":
            common["max_turns"] = max_turns
        return HARNESSES[config["backend"]].session(self, config, common, definitions)

    def prewarm(self):
        """Start the chat runtime's harness session ahead of the next typed turn, which takes it over."""
        with self._lock:
            if self._closing or self.server.closing:
                raise ValueError("shutting_down")
            runtime = self._ensure_runtime("chat")
            backend = self._runtime_config["backend"]
        if not harness(backend).warm_start:
            return
        # The tools a remembered typed turn on the main session runs with (_prepare's native).
        native = self.jobs is not None
        self._turn.native_tools = native
        try:
            session = runtime.warm_session(harness_tools=native)
        finally:
            del self._turn.native_tools
        if session is None:
            return
        try:
            session.prewarm()
        finally:
            with self._lock:
                # A settings, credential or history change meanwhile closed this session or the runtime it belongs to.
                retired = self._closing or self.server.closing or self.runtime is not runtime or runtime._session is not session
        if retired:
            raise ValueError("runtime_changed")

    def _ensure_runtime(self, purpose="chat", current=None):
        if purpose == "chat":
            self._auto_select()
        with self._lock:
            if current and not current():
                return None
            snapshot = self.settings.snapshot()
            config = RuntimeSettings.route(snapshot, purpose)
            runtime, previous = self.runtime, self._runtime_config
            native = self.tools.registry.native_definitions(
                desktop=bool(self.server.computer_control), desktop_task=self._computer_use_ready(snapshot))
            if runtime is None or config != previous or native != runtime.native_tools:
                if runtime:
                    runtime.close()
                runtime = PersonalAgentRuntime(self.state_dir / "character-agent", self._session_factory_bound(config, spoken=True),
                    self.knowledge, self.workspace, tasks=self.server.tasks, backend=config["backend"],
                    model=self._model(config), event_sink=self._event, run_store=self.store, tools=self.tools,
                    native_tools=native, native_handler=self._native, effort=config['_turn_effort'])
                if self.server.history is not None:
                    runtime.conversation_id = self.server.history.conversations.active
                self.runtime, self._runtime_config = runtime, config
            return runtime

    def _session_factory_bound(self, config, actor_id=None, spoken=False):
        return lambda definitions: self._session_factory(definitions, config, actor_id,
            native_tools=getattr(self._turn, 'native_tools', True), spoken=spoken)

    def _event(self, event, *, work_kind='foreground', job_id=None):
        event = {**event, 'work_kind': 'semantic' if str(event.get('phase', '')).startswith('semantic_') else work_kind}
        if job_id is not None:
            event['job_id'] = job_id
        if 'item_id' not in event and event.get('run_id'):
            with self.store.lock:
                owner = self.store.db.execute('SELECT conversation_id,generation,character_id FROM character_runs WHERE run_id=?',
                                              (event['run_id'],)).fetchone()
            if owner:
                event.update(conversation_id=owner['conversation_id'], generation=owner['generation'])
                if event['work_kind'] != 'semantic' and owner['character_id'] == self.server.character:
                    self._role_outcome(event)
                    if event.get('phase') in ('completed', 'failed'):
                        self._role_worklog(event)
        if event.get('type') == 'plan':
            self.server.feed.publish('plan', {key: value for key, value in event.items() if key != 'type'})
        else:
            self.server.feed.publish("agent_item" if 'item_id' in event else "agent_run", event)
        if 'item_id' not in event and event.get('type') != 'plan':
            self.refresh_presentation()

    def _role_outcome(self, event):
        """Her own bounded affect follows verified work, never an inferred user's emotion."""
        phase, outcome = event.get('phase'), event.get('outcome')
        kind = 'task_failed' if phase == 'failed' or phase == 'completed' and outcome == 'failed' else \
            'task_verified' if phase == 'completed' and outcome == 'succeeded' else None
        if kind is None or self.server.state is None or self.server.resetting or self.server.closing or self.server.switch:
            return
        with self._presentation_lock:
            if event['run_id'] in self._role_outcomes:
                return
            self._role_outcomes.append(event['run_id'])
            try:
                self.server.state.on_event(kind)
            except Exception:
                logging.getLogger(__name__).warning('role_affect_unavailable')

    def _role_worklog(self, event):
        """One work-memory card per task of hers, updated whenever a run of it ends."""
        s = self.server
        task = s.tasks.get(event['task_id']) if s.worklog is not None and s.tasks and event.get('task_id') else None
        run = self.store.get(event['run_id'])
        # delivery_eligible is the run's remember and allow_actions; a temporary conversation leaves it 0.
        if task is None or not run['delivery_eligible'] or run['delivery_revoked'] or s.memory is not None and s.memory.paused():
            return
        if event['phase'] == 'failed' or event.get('outcome') == 'failed':
            status, authority, blockers = 'active', 'agent_claimed', [(event.get('error') or 'verification_failed')[:80]]
        elif event.get('outcome') == 'succeeded':
            status, blockers = 'done', []
            authority = 'agent_claimed' if (run['result'] or {}).get('validation_scope') == 'no_deliverable' else 'tool_verified'
        else:
            status, authority, blockers = 'active', 'agent_claimed', []
        answer = next((item['text'] for item in reversed(self.store.items(run['run_id']))
                       if item['kind'] == 'assistant_text' and item['phase'] != 'commentary'), '')
        marks = MarkerStream()
        answer = marks.feed(answer)[0] + marks.close()[0]
        try:
            s.worklog.upsert_task({'id': 'task-role-' + task['task_id'], 'project': '',
                'title': task['title'][:40], 'goal': '', 'goal_authority': '', 'status': status, 'status_authority': authority,
                'progress': answer.strip()[:120], 'next_step': '', 'blockers': blockers,
                'first_at': run['started_at'], 'last_at': time.time(), 'requires': []}, run_id=run['run_id'])
        except Exception:
            logging.getLogger(__name__).warning('role_worklog_unavailable')

    def _interaction_event(self, event):
        self.server.feed.publish('agent_interaction', event)
        self.refresh_presentation()

    def refresh_presentation(self):
        from character_agent.services.embodiment import project
        with self._presentation_lock:
            try:
                def identity():
                    return (self.server.character, self.server.turn_generation, bool(self.server.resetting),
                            bool(self.server.closing), bool(self.server.switch))
                before = identity()
                focus = None if any(before[2:]) else project(self.store, before[0])
                if before != identity():
                    return  # A changed character/turn will publish its own authoritative view.
                self.server.registry.set_role_focus(focus, generation=before[1])
                self._presentation_fault = False
            except Exception:
                # Presentation is a read model: its failure cannot fail a tool, a turn, or the server ticker.
                # Do not log the exception text, which could contain private stored content.
                if not self._presentation_fault:
                    logging.getLogger(__name__).warning('role_presentation_unavailable')
                self._presentation_fault = True
                self.server.registry.set_role_focus(None, generation=self.server.turn_generation)

    def cancel_conversation(self, conversation_id, run_id, generation):
        with self.server._turn_lock:
            root = self.store.get(run_id)
            if root and root['conversation_id'] == conversation_id and root['generation'] == generation and \
                    isinstance(root.get('result'), dict) and root['result'].get('continuation'):
                return self._cancel_run(run_id, generation)
            return self._cancel_conversation(conversation_id, run_id, generation)

    def _cancel_conversation(self, conversation_id, run_id, generation):
        """Stop the foreground or side run; the conversation's background jobs stop only through their own cancel."""
        side = self._side_runtime(run_id)
        if side is not None:
            # A side run stops alone: the foreground run and the conversation's jobs keep going.
            if side.cancel('client_cancel', run_id=run_id, generation=generation, conversation_id=conversation_id) is None:
                return 409, {'error': 'run_finished'}
            self.server.cancel_run_speech(run_id)
            return 202, {'run_id': run_id, 'cancellation_requested': True}
        runtime = self._foreground_runtime()
        cancelled = None
        with runtime._lock if runtime else self._lock:
            active = runtime._active if runtime else None
            if active and active['conversation_id'] == conversation_id:
                current = active
            else:
                with self.store.lock:
                    current = self.store.db.execute('SELECT run_id,generation FROM character_runs WHERE conversation_id=? ORDER BY started_at DESC LIMIT 1', (conversation_id,)).fetchone()
                if current is None and self.jobs:
                    current = next((job for job in self.jobs.store.list(limit=None) if job['conversation_id'] == conversation_id), None)
            identity = {'run_id': current['run_id'] if current else None, 'generation': current['generation'] if current else None}
            if identity != {'run_id': run_id, 'generation': generation}:
                return 409, {'error': 'run_changed', **identity}
            if runtime:
                cancelled = runtime.cancel('client_cancel', run_id=run_id, generation=generation, conversation_id=conversation_id)
            run = self.store.get(run_id)
            if run and run['state'] == 'waiting_user' and \
                    not any(job['run_id'] == run_id for job in (self.jobs.store.list(limit=None) if self.jobs else ())):
                self._cancel_waiting_run(run)
        if cancelled: self.tools.close(cancelled, 'turn_cancelled')
        voiced = self.server._voiced
        speech_run = self.store.get(voiced[0]) if voiced else None
        if speech_run and speech_run['conversation_id'] == conversation_id:
            self.server.cancel_run_speech(speech_run['run_id'])
        return 202, {'run_id': run_id, 'cancellation_requested': True}

    def _cancel_waiting_run(self, run):
        with self.store.lock:
            if self.store.get(run['run_id'])['state'] != 'waiting_user': return False
            self.store.finish(run['run_id'], 'cancelled', task_id=run['task_id'], dependencies=run['dependencies'],
                result={'error': 'client_cancel'})
        if run['task_id'] and self.server.tasks and self.server.tasks.get(run['task_id'])['state'] == 'waiting_user':
            self.server.tasks.transition(run['task_id'], 'cancelled')
        if self.workspace: self.workspace.cancel_run(run['run_id'])
        self.interactions.invalidate(run_ids={run['run_id']})
        return True

    def cancel_run(self, run_id, generation):
        with self.server._turn_lock:
            return self._cancel_run(run_id, generation)

    def _cancel_run(self, run_id, generation):
        visited = set()
        for _ in range(64):
            if run_id in visited: return 409, {'error': 'continuation_changed'}
            visited.add(run_id)
            root = self.store.get(run_id)
            if root is None: break
            if root['generation'] != generation:
                return 409, {'error': 'run_changed', 'run_id': run_id, 'generation': root['generation']}
            continuation = (root.get('result') or {}).get('continuation')
            if not continuation: break
            if continuation.get('conversation_id') != root['conversation_id'] or \
                    continuation.get('character_id') != root['character_id'] or \
                    not isinstance(continuation.get('run_id'), str) or type(continuation.get('generation')) is not int:
                return 409, {'error': 'continuation_changed'}
            next_id, next_generation = continuation['run_id'], continuation['generation']
            job = None
            if continuation.get('job_id'):
                job = self.jobs.store.get(continuation['job_id'], private=True) if self.jobs else None
                if job is None or job['conversation_id'] != root['conversation_id'] or \
                        (job['payload'] or {}).get('character_id') != root['character_id']:
                    return 409, {'error': 'continuation_changed'}
            target = self.store.get(next_id)
            if target is not None and (target['conversation_id'] != root['conversation_id'] or
                    target['character_id'] != root['character_id'] or target['generation'] != next_generation):
                return 409, {'error': 'continuation_changed'}
            if job and (job['run_id'], job['generation']) != (next_id, next_generation) and \
                    not (target and (target.get('result') or {}).get('continuation')):
                return 409, {'error': 'run_changed', 'run_id': job['run_id'], 'generation': job['generation']}
            if target is None and not continuation.get('job_id'):
                # say has registered the cancel event before launching its thread.
                # Its generation is sufficient to avoid touching a later unrelated turn.
                if continuation.get('dispatch_epoch') != self._continuation_epoch:
                    return 409, {'error': 'run_finished'}
                cut = self.server.cancel_turn('client_cancel', generation=next_generation)
                if cut[0] == 'stale': return 409, {'error': 'run_finished'}
                return 202, {'run_id': next_id, 'cancellation_requested': True}
            run_id, generation = next_id, next_generation
        else:
            return 409, {'error': 'continuation_changed'}
        job = next((job for job in self.jobs.store.list(limit=None) if job['run_id'] == run_id), None) if self.jobs else None
        runtime = self._background_runtimes.get(run_id, (None, None))[1] if job else self._side_runtime(run_id) or self._foreground_runtime()
        cancelled = None
        with runtime._lock if runtime else self._lock:
            run = self.store.get(run_id)
            current = job or run
            if current is None and runtime and runtime._active and runtime._active['run_id'] == run_id:
                current = runtime._active
            if current is None: return 404, {'error': 'unknown_run'}
            if current['generation'] != generation:
                return 409, {'error': 'run_changed', 'run_id': current['run_id'], 'generation': current['generation']}
            if run and run['state'] not in ('running', 'waiting_user') or job and job['state'] not in ('queued', 'running', 'waiting_user'):
                return 409, {'error': 'run_finished'}
            if not job or run is not None:
                cancelled = runtime.cancel('client_cancel', run_id=run_id, generation=generation) if runtime else None
                if run and run['state'] == 'waiting_user' and self._cancel_waiting_run(run): cancelled = run_id
                if cancelled is None: return 409, {'error': 'run_finished'}
        if job and not self.jobs.cancel(job['job_id'], run_id=run_id, generation=generation) and cancelled is None:
            return 409, {'error': 'run_finished'}
        if cancelled and not job: self.tools.close(cancelled, 'turn_cancelled')
        self.server.cancel_run_speech(run_id)
        return 202, {'run_id': run_id, 'cancellation_requested': True}

    def cancel(self, reason="cancelled", *, fact_ids=None, context_kind=None):
        with self.server._turn_lock:
            return self._cancel(reason, fact_ids=fact_ids, context_kind=context_kind)

    def _continued_runs(self, run_ids):
        """Follow only product continuation receipts, bounded and scoped to their owner."""
        pending, found = list(run_ids), {}
        visited = set()
        while pending and len(visited) < 64:
            ident = pending.pop()
            if ident in visited: continue
            visited.add(ident)
            run = self.store.get(ident)
            link = (run.get('result') or {}).get('continuation') if run else None
            if not isinstance(link, dict) or link.get('conversation_id') != run['conversation_id'] or \
                    link.get('character_id') != run['character_id'] or not isinstance(link.get('run_id'), str) or \
                    type(link.get('generation')) is not int:
                continue
            target = self.store.get(link['run_id'])
            if target is not None:
                if target['conversation_id'] != run['conversation_id'] or target['character_id'] != run['character_id'] or \
                        target['generation'] != link['generation']: continue
            elif link.get('dispatch_epoch') != self._continuation_epoch or link.get('job_id'):
                continue
            found[link['run_id']] = link['generation']
            pending.append(link['run_id'])
        return found

    def _cancel(self, reason="cancelled", *, fact_ids=None, context_kind=None):
        if reason in ('context_changed','scope_revoked') and getattr(self,'observations',None):
            self.observations.clear()
        if reason in ('context_changed', 'scope_revoked', 'observations_deleted') and getattr(self, 'observation_briefs', None):
            self.observation_briefs.clear()
        if fact_ids is not None or context_kind is not None:
            affected = set()
            if fact_ids is not None:
                fact_ids = set(fact_ids)
                current = {}
                for fact_id in fact_ids:
                    try: current[fact_id] = self.server.memory.versions(fact_id)[-1]['version']
                    except KeyError: current[fact_id] = None
                # A run that read the version the change made, as the correcting run itself does, still holds.
                stale = lambda d: d.get('source') == 'memory' and d.get('id') in fact_ids and d.get('version') != current[d['id']]
                with self.store.lock:
                    rows = self.store.db.execute('SELECT run_id,dependencies FROM character_runs').fetchall()
                affected.update(run_id for run_id, raw in rows if any(stale(d) for d in json.loads(raw)))
            if context_kind is not None:
                affected.update(run_id for run_id, kinds in tuple(self.server._line_context.values()) if context_kind in kinds)
            continued = self._continued_runs(affected)
            affected.update(continued)
            for ident, generation in continued.items():
                if self.store.get(ident) is None:
                    self.server.cancel_turn('context_cleared', generation=generation)
            with self._lock:
                foreground = self.runtime
                runtimes = [foreground] if foreground else []
                runtimes.extend(runtime for _, runtime in self._background_runtimes.values())
                sides = [runtime for _, runtime in self._side_runtimes.values()]
                runtimes.extend(sides)
            for runtime in runtimes:
                with runtime._lock:
                    active = runtime._active
                    if active and fact_ids is not None and any(stale(d) for d in active['knowledge'].dependencies()):
                        affected.add(active['run_id'])
                    if runtime is foreground or runtime in sides:
                        # An ended run's words stay in the session it ran on; invalidate ends that session too.
                        for run_id in affected:
                            runtime.invalidate(reason, run_id=run_id, interrupted=True)
            if self.jobs:
                for job in self.jobs.store.list(states=('queued', 'running', 'waiting_user'), limit=None):
                    if job['run_id'] in affected or job['previous_run_id'] in affected:
                        affected.add(job['run_id'])
                        self.jobs.cancel(job['job_id'], reason, interrupted=True,
                            run_id=job['run_id'], generation=job['generation'])
            self.store.redact_items(affected)
            if self.deliveries: self.deliveries.revoke(affected)
            self.interactions.invalidate(run_ids=affected)
            for run_id in affected: self.tools.close(run_id, reason)
            if self.memory_journal:
                self.memory_journal.redact(reason)
            return
        if reason == 'context_changed':
            with self.store.lock:
                observed = [row[0] for row in self.store.db.execute('SELECT run_id,dependencies FROM character_runs')
                    if any(d.get('source') in DERIVED for d in json.loads(row[1]))]
            self.store.redact_items(observed)
            if self.deliveries: self.deliveries.revoke(observed)
        if reason == "shutdown":
            with self._lock:
                self._closing = True
        if reason != "turn_cancelled": self.semantic.cancel()
        if reason in ('context_changed', 'scope_revoked', 'memory_changed', 'history_cleared', 'shutdown'):
            with self.store.lock:
                roots = [] if self.store._closed else [row[0] for row in self.store.db.execute(
                    "SELECT run_id FROM character_runs WHERE state='waiting_user'")]
            for ident, generation in self._continued_runs(roots).items():
                if self.store.get(ident) is None:
                    self.server.cancel_turn('context_cleared', generation=generation)
        if self.memory_journal and reason in ('context_changed', 'scope_revoked', 'memory_changed'):
            self.memory_journal.redact(reason)
        with self._lock:
            foreground = [self.runtime] if self.runtime else []
            sides = [side for _, side in self._side_runtimes.values()]
        # Before invalidate, so the ending run's own run_end release cannot take the lease first.
        self.tools.close_all(reason)
        for runtime in foreground:
            if reason != "turn_cancelled" or runtime.busy():
                runtime.invalidate(reason)
        for side in sides:
            side.cancel(reason)
        if self.jobs and reason not in ('turn_cancelled', 'runtime_changed'):
            self.jobs.cancel_all(reason)
        if reason in ("history_cleared", "context_changed", "scope_revoked", "memory_changed"):
            self.interactions.invalidate()

    def cancel_task(self, task_id):
        with self.server._turn_lock:
            return self._cancel_task(task_id)

    def _cancel_task(self, task_id):
        if self.jobs:
            children = []
            for job in self.jobs.store.list(limit=None):
                run = self.store.get(job['run_id'])
                if run and run.get('task_id') == task_id and job['state'] in ('queued', 'running', 'waiting_user'):
                    return self.jobs.cancel(job['job_id'])
                private = self.jobs.store.get(job['job_id'], private=True)
                parent_id = (private['payload'] or {}).get('source_run_id') if private else None
                parent = self.store.get(parent_id) if parent_id else None
                if parent and parent.get('task_id') == task_id and job['state'] in ('queued', 'running', 'waiting_user'):
                    children.append(job['job_id'])
            if children:
                if self.runtime: self.runtime.cancel('user_cancelled_task', task_id=task_id)
                for ident in children: self.jobs.cancel(ident)
                return True
        with self.store.lock:
            waiting = self.store.db.execute("SELECT run_id FROM character_runs WHERE task_id=? AND state='waiting_user'", (task_id,)).fetchall()
        if waiting:
            cancelled = False
            for row in waiting:
                run = self.store.get(row['run_id'])
                if run and self._cancel_run(run['run_id'], run['generation'])[0] == 202:
                    cancelled = True
            return cancelled
        with self._lock:
            runtime = self.runtime
            run_id = runtime.cancel("user_cancelled_task", task_id=task_id) if runtime else None
        if run_id: self.tools.close(run_id, "user_cancelled_task")
        return run_id is not None

    def forget(self):
        self.interactions.invalidate()
        self.cancel("history_cleared")
        self._foreground_request = ''
        if self.memory_journal is not None:
            self.memory_journal.clear()
        if getattr(self, "deliveries", None): self.deliveries.forget()
        if getattr(self, "observation_briefs", None): self.observation_briefs.clear()
        if getattr(self, "observations", None): self.observations.clear()
        if self.jobs: self.jobs.store.clear()
        if self.runtime:
            self.runtime.forget()
        else:
            self.store.forget()
        if self.workspace: self.workspace.forget()
        with self._lock:
            config = self.settings.snapshot()
            if config["scope_id"]:
                self.settings.save({**config, "scope_id": None})

    def drop_default_scope(self, scope_id):
        """The default scope can never validate again (expired, revoked, gone): later turns go without it and warn no more."""
        with self._lock:
            config = self.settings.snapshot()
            if config["scope_id"] == scope_id:
                self.settings.save({**config, "scope_id": None})

    def data_counts(self):
        """Row counts of the character agent's own databases, for reset verification."""
        counts = {}
        with self.store.lock:
            for table in ("character_runs", "character_run_events", "character_effects", "character_checkpoints", "character_interactions"):
                counts[table] = self.store.db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0]
        if self.workspace is None:
            return counts
        with self.workspace.lock:
            for table in ("scopes", "expectations", "cancelled_runs", "artifacts", "effects"):
                counts["character_workspace_" + table] = self.workspace.db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0]
        return counts

    def list_memory_runs(self, limit=50):
        rows = self.memory_journal.list(limit) if self.memory_journal else []
        return rows

    def memory_run_details(self, run_id):
        return self.memory_journal.get(run_id) if self.memory_journal else None

    def close(self):
        self._runner_cleanup_stop.set()
        if self._runner_cleanup: self._runner_cleanup.join(timeout=1)
        self.interactions.close()
        if self.memory_pipeline: self.memory_pipeline.close()
        if self.worklog: self.worklog.close()
        if self.observations: self.observations.close()
        if self.observation_briefs: self.observation_briefs.close()
        self.cancel("shutdown")
        if self.jobs: self.jobs.close()
        if self.runtime:
            self.runtime.close()
        from character_agent.harness.transport import join_reapers
        join_reapers()

    def prepare(self, line_id, text, cancel, generation, source, trace, *, side=False, **options):
        """Run the harness outside server's mouth lock; return a presentation-only provider.
        side: answer this input in a new read-only session while the foreground run keeps working.
        A line she starts herself (any source but text and voice) also runs in a session of its own, so it does not
        close the typing session; its tools stay the foreground's."""
        one_off = source not in ('text', 'voice') and not side
        if not side and not one_off:
            self._foreground_request = text[:300] if trace.get('remember', True) else ''
            return self._prepare(line_id, text, cancel, generation, source, trace, **options)
        foreground = self.runtime
        if side and source in ('text', 'voice') and trace and trace.get('remember', True) and foreground is not None:
            # The user's words as an ordinary turn sends them: keys stay hidden from the harness.
            steered = STEER_NOTE + (self.server.egress or self.server.mouth.egress).user_text(text)
            settled = lambda accepted, code: self.server._step(trace, "steer.settled", new_span_id(),  # noqa: E731
                                                               attrs={"accepted": accepted, "code": code})
            threading.Thread(target=foreground.steer, args=(steered, settled), name='foreground-steer', daemon=True).start()
        self._auto_select()
        snapshot = self.settings.snapshot()
        config = RuntimeSettings.route(snapshot, 'chat')
        native = dict(native_tools=self.tools.registry.native_definitions(desktop=bool(self.server.computer_control),
            desktop_task=self._computer_use_ready(snapshot)), native_handler=self._native) if one_off else {}
        runtime = PersonalAgentRuntime(self.state_dir / 'character-agent',
            self._session_factory_bound(config, ('line-' if one_off else 'side-') + line_id, spoken=True),
            self.knowledge, self.workspace, tasks=self.server.tasks, backend=config['backend'], model=self._model(config),
            event_sink=self._event, run_store=self.store, tools=self.tools, effort=config['_turn_effort'], **native)
        with self._lock:
            self._side_runtimes[line_id] = (cancel, runtime)
        try:
            return self._prepare(line_id, text, cancel, generation, source, trace, runtime=runtime, side=side, **options)
        finally:
            with self._lock:
                self._side_runtimes.pop(line_id, None)
            runtime.close()

    def _assemble_turn_context(self, server, trace, text, wait, refused, turn_started, cancel, line_id,
                               source, side, resume_run_id, lore, egress):
        """Build turn context string once, uniting observations, active work, profile preferences and related facts."""
        used = []
        server.sync_privacy()  # a consent revoked in the saved config holds for the observation context too
        observed = self.observations.context() if getattr(self, 'observations', None) and trace.get('remember', True) else None
        front = server.capture.window_text() if server.capture is not None else None
        # The mouth's copy of the front window's text goes when a current source of the observation context is that text.
        held = front is not None and observed is not None and any(
            s['total_chars'] == len(front['text']) and front['text'].startswith(s['preview'])
            for s in observed.get('current_sources', ()))  # an unavailable context has none
        context = server.context(text, wait, refused, used, now=turn_started, window=not held)
        if not side and not resume_run_id and server.history:
            asked = self.interactions.pending_questions(server.history.conversations.active)
            if asked:
                context += '\nYour open questions to the user: ' + '; '.join('"' + q + '"' for q in asked) + \
                    '. This message does not answer them and their cards stay open: reply to this message, and ask again only if it relates.'
        if trace.get('surface'):
            context += '\nSent from: ' + SURFACE_NAMES[trace['surface']]
        if source == 'voice':
            context += '\nSent by voice: the text is speech recognition, so a word that makes no sense may be misheard; go by the likely meaning.'
        if trace.get('quote'):
            context += '\nQuoted selection (from ' + (trace['quote']['app'] or 'an unknown app') + '): "' + trace['quote']['text'] + '"'
        if trace.get('reply_to', {}).get('kind') == 'turn':
            quoted = trace['reply_to']
            context += '\nEarlier conversation (quoted reply): ' + json.dumps(
                {'speaker': quoted['speaker'], 'text': quoted['text']}, ensure_ascii=False)
        elif trace.get('reply_to'):
            replied = server.proactive_log and server.proactive_log.text(trace['reply_to']['kind'], trace['reply_to']['id'])
            if not replied and trace['reply_to']['kind'] == 'line' and server.history:
                # Her answers are not in proactive_log: the line_id is the turn_id of its row in this conversation.
                conversation_id = server.history.conversations.active
                with server.history.lock:
                    row = server.history.db.execute(
                        "SELECT h.reply FROM history_turns h JOIN conversation_turns t USING(event_id)"
                        " WHERE t.conversation_id=? AND h.turn_id=? AND h.state IN ('completed','interrupted')"
                        " ORDER BY h.id DESC LIMIT 1", (conversation_id, trace['reply_to']['id'])).fetchone()
                replied = row and row[0]
            context += '\nReplying to your line: "' + replied + '"; carry on from it.' if replied else '\nReplying to an earlier line of yours whose text is gone: follow this message and don\'t invent what you said.'
        material = server._line_material.pop(cancel, None)
        if material:
            context += "\nReminder source material: " + material
        for tier, header in LORE_LABELS.items():
            entries = [f"\n- {entry['text']}" for entry in lore if entry["tier"] == tier]
            if entries:
                context += "\n" + header + ":" + "".join(entries)
        if self.jobs and trace.get('remember', True):
            goals = [{k: goal[k] for k in ('goal_id', 'title', 'state', 'revision')} for goal in self.jobs.store.goals()
                     if goal['state'] in ('active', 'paused')][:10]
            active = server.history.conversations.active if server.history else None
            jobs = sorted(({'job_id': job['job_id'], 'title': job['title'][:60], 'state': job['state'],
                            'updated_at': job['updated_at'], 'same_conversation': job['conversation_id'] == active}
                           for job in self.jobs.store.list()
                           if job['state'] in ('queued', 'running', 'needs_review', 'failed', 'interrupted', 'waiting_user') and
                           job['updated_at'] >= turn_started.timestamp() - 7 * 86400),
                          key=lambda job: (not job['same_conversation'], -job['updated_at']))[:10]
            index, kept = {'goals': goals, 'jobs': jobs}, len(jobs)
            while len(json.dumps(jobs, ensure_ascii=False)) > 2000:
                jobs.pop()
            if len(jobs) < kept:
                index['jobs_truncated'] = kept - len(jobs)
            owned = self._job_tasks()
            tasks = [{'task_id': run['task_id'], 'title': task['title'][:60], 'state': task['state'],
                      'updated_at': task['updated_at'], 'same_conversation': run['conversation_id'] == active}
                     for run in self.store.tasks_since(server.character, turn_started.timestamp() - 7 * 86400)
                     if run['task_id'] not in owned
                     for task in [server.tasks.get(run['task_id']) if server.tasks else None] if task][:5]
            while len(json.dumps(tasks, ensure_ascii=False)) > 800:
                tasks.pop()
            index['tasks'] = tasks
            context += '\nGoals and background work (state at query time; failed and interrupted are past states, see updated_at; use the tools for details or changes): ' + json.dumps(index, ensure_ascii=False)
        if server.tasks and trace.get('remember', True):
            recent = server.tasks.agent_dispatches(server.character, since=turn_started.timestamp() - 7 * 86400, limit=-1)
            terminal = {'succeeded', 'needs_review', 'failed', 'accepted', 'rejected', 'cancelled',
                        'interrupted', 'denied', 'expired'}
            recent = [task for task in recent if task['state'] in terminal] + \
                     [task for task in recent if task['state'] not in terminal]
            dispatched = [{k: task[k] for k in ('title', 'target', 'state', 'task_id')} for task in recent[:5]]
            if dispatched:
                context += '\nTasks you dispatched recently (finished first; state at query time, awaiting confirmation means not started; details via dispatch_status): ' + json.dumps(dispatched, ensure_ascii=False)
        if side:
            context += self._foreground_brief()
        if not side and trace.get('remember', True) and getattr(server, 'spatial', None):
            context += '\nLast body receipt (requested_yaw is the requested angle, not the measured pose; until a completion receipt arrives, the motion is not done): ' + \
                json.dumps(server.spatial.facing_status(), ensure_ascii=False)
        context = egress.observed(context)
        server._line_context[cancel] = (line_id, {kind for kind, _ in used})
        knowledge = self.knowledge(temporary=not trace.get("remember", True))
        profile = knowledge.call("personal_profile", {"limit": PROFILE_LIMIT, "max_chars": PROFILE_CHARS})
        context += "\nThe user's stated preferences and agreements: " + json.dumps(profile, ensure_ascii=False)
        facts = knowledge.related_facts(text, {item["id"] for item in profile.get("items", [])},
                                        limit=RELATED_FACTS, max_chars=RELATED_FACTS_CHARS)
        if facts:
            context += "\nFacts the user stated or confirmed that share words with this message: " + \
                json.dumps(facts, ensure_ascii=False, separators=(",", ":"))
        if not side and trace.get('remember', True) and server.worklog is not None and not server.observation_paused():
            projects = {worklog_digest.project(s['cwd']) for s in server.registry.snapshot()['sessions']} - {None}
            worked = server.worklog.inject(turn_started.timestamp(), projects=projects)
            if worked:
                context += '\n' + egress.observed(worked)
        if observed is not None:
            context += '\nOngoing observations and current tasks (evidence and inferences are marked apart; never state an inference as fact; look back with observation_read or observation_image, which also read changes not yet analyzed): '+json.dumps(observed,ensure_ascii=False)
        server._context_assembled(trace, used, lore)
        return context, knowledge

    def _prepare(self, line_id, text, cancel, generation, source, trace, *, scope_id=None, expected_outputs=None,
                 wait=None, refused=None, resume_run_id=None, runtime=None, side=False, look_wait_ms=0):
        turn_started = datetime.now().astimezone()
        setting = self.settings.snapshot()['reply_language']
        server = self.server
        _, consent_epoch = server.sync_privacy()
        consent_epoch = server._line_consent.get(cancel, consent_epoch)
        current = lambda: not cancel.is_set() and server.turn_generation == generation and not server.resetting \
            and server.consent.snapshot()[1] == consent_epoch
        main = runtime is None
        runtime = runtime or self._ensure_runtime("chat", current=current)
        if runtime is None:
            return PreparedReply(server.mouth, "", "", error="cancelled")
        waited = time.monotonic()
        with server._mouth_lock:
            lock_wait_ms = round((time.monotonic() - waited) * 1000)
            server._apply_window_ops()
            mouth = server.mouth
            if not current():
                return PreparedReply(mouth, "", runtime.model, error="cancelled")
            if source in ("text", "voice"):
                self.reply_language.observe(setting, text)
            history = copy.deepcopy(mouth.history)
            unheard = set()  # indexes in history of the turns since the last delivery of a line on self.runtime
            if main:
                self._main_line = line_id
                unheard = {i for i, turn in enumerate(mouth.history) if not any(turn is t for t in self._main_heard)}
                self._main_seen = (list(mouth.history), [reply for reply in (getattr(cancel, 'answer', None),) if reply])
            card, motion = bound(server.characters.load_card(server.character), effective(server))
            embodied = server.characters.package(server.character).render_enabled
            lore = mouth.pick_lore(text) if hasattr(mouth, "pick_lore") else []
        building = time.monotonic()
        if not current():
            return PreparedReply(mouth, "", runtime.model, error="cancelled")
        egress = server.egress or mouth.egress
        card = localized(card, self.reply_language.current(setting))
        system = render_persona(card, motion, getattr(mouth, "motion_phrases", None), embodied=embodied) + "\n\n" + \
            persona_personal_instructions(card) + "\n" + (SIDE_INSTRUCTIONS if side else FOREGROUND_INSTRUCTIONS)
        if not trace.get("remember", True):
            system += ("\nThis is a temporary conversation: nothing enters long-term memory, so propose no memory changes, write no files, "
                       "take no desktop actions and start no background work; only answer and read existing knowledge. If the user wants "
                       "those, ask them to switch back to a normal conversation first.")
        if setting != "harness":
            system += "\n" + SYSTEM_RULE
        # The card's style note and the reply language come last, right before the user's words.
        before_input = "<reply_style>\n" + card["post_history_instructions"] + "\n</reply_style>" + \
            ("\n" + self.reply_language.tag(setting) if setting != "harness" else "")
        replayed, missed = [], []
        for index, turn in enumerate(history):
            for message in turn:
                # Her lines may retell the screen; the user's own words keep their contacts.
                message["content"] = egress.user_text(message["content"]) \
                    if message.get("role") == "user" else egress.observed(message["content"])
            replayed.append(turn)
            if index in unheard:
                missed.append({'user': turn[0]['content'], 'you': turn[1]['content']})
        history = replayed
        unheard = '\nTurns this session has not seen, since its last reply here (oldest first; the user may answer them): ' + \
            json.dumps(missed, ensure_ascii=False) if missed else None
        context, knowledge = self._assemble_turn_context(
            server, trace, text, wait, refused, turn_started, cancel, line_id,
            source, side, resume_run_id, lore, egress)
        main_session = not side
        route_config = RuntimeSettings.route(self.settings.snapshot(), "chat")
        if scope_id:
            scope = self.workspace.get_scope(scope_id)
            names = [f['path'] for f in scope.get('files', [])] + [r['path'] + '/' for r in scope['roots']]
            context += '\nSelected material (read it with your own file tools, without asking which): '
            context += egress.observed(', '.join(names[:10])) + (f' ({len(names)} in all)' if len(names) > 10 else '')
        memory_session = self.memory_journal.turn(line_id, egress.user_text(text), runtime.backend, runtime.model,
            server.character, {"system_prompt": system, "history": history, "context": context},
            allowed=source in ("text", "voice") and trace.get("remember", True)) if self.memory_journal and main_session else None
        span, started = new_span_id(), time.monotonic()
        server._step(trace, "model.started", span, attrs={"model": runtime.model or DEFAULT_MODEL, "call": "character_agent"})
        # Only the user's own remembered turn gets the harness's own file and shell tools; no other turn reuses its session.
        native = self.jobs is not None and main_session and source in ("text", "voice") and trace.get("remember", True)
        self._turn.native_tools = native
        try:
            # The native grant outlives the run by minutes and blocks the next run's session with desktop_busy.
            with self.tools.session(SessionKey("character", line_id,
                    server.history.conversations.active if server.history else None)):
                answer = runtime.run(run_id=line_id, text=egress.user_text(text), system_prompt=system, history=history,
                    character_id=server.character, generation=generation, scope_id=scope_id, context=context, unheard=unheard, before_input=before_input, language=self.semantic.reply(),
                    cancelled=cancel, is_current=current, expected_outputs=expected_outputs, resume_run_id=resume_run_id,
                    allow_actions=main_session and source in ("text", "voice") and trace.get("remember", True),
                    mode='embodied_only' if not side and trace.get('remember', True) and source in ('gift', 'ritual', 'tap') else None,
                    remember=trace.get("remember", True),
                    knowledge_service=knowledge, memory_session=memory_session, harness_tools=native,
                    orchestration_session=OrchestrationTurn(self, egress.user_text(text), self.settings.snapshot(), server.character,
                        scope_id, line_id, utterance=text) if main_session and self.jobs and trace.get('remember', True) else None,
                    question_session=QuestionTurn(self.interactions, self.settings.snapshot()['interactive_tools'], line_id,
                                                  server.character, egress.user_text(text), scope_id)
                        if main_session and self.jobs and trace.get("remember", True) else None,
                    conversation_id=trace.get("conversation_id") or (server.history.conversations.active if server.history else None),
                    on_first_token=lambda: server._step(trace, "model.first_token", span),
                    on_tool=lambda *event: server._trace_tool(trace, *event),
                    setup_ms={"context_build_ms": round((time.monotonic() - building) * 1000),
                              "lock_wait_ms": lock_wait_ms, "look_wait_ms": look_wait_ms})
        finally:
            del self._turn.native_tools
        result = answer.result or {}
        trace["waiting_user"] = result.get("state") == "waiting_user"
        trace["outcome"] = "background_pending" if result.get("background_jobs") else "failed" if result.get("ok") is False else None
        if self.jobs: self._settle_background_parent(line_id)
        if self.deliveries:
            self.deliveries.produce(line_id, remember=trace.get('remember', True), summary=answer.text)
        for fact_id, deleted in memory_session.changed if memory_session else []:
            checkpoint(server.memory)
            server.feed.publish("memory", {"action": "deleted" if deleted else "corrected", "fact_id": fact_id})
            server._memory_changed(fact_id, deleted=deleted)
        for fact_id in memory_session.stored if memory_session else []:
            server.feed.publish('memory', {'action': 'added', 'fact_id': fact_id})
        h = harness(runtime.backend)
        provider = h.provider if h and h.provider else route_config.get('provider') or 'unknown'
        channel = runtime.backend + "_" + route_config["auth_source"]
        trace["model_route"] = {"provider": provider, "account_label": channel, "model": answer.model}
        server._step(trace, "model.finished", span, status="failed" if answer.error else "ok",
            duration_ms=int((time.monotonic() - started) * 1000), attrs={"model": answer.model or DEFAULT_MODEL,
            "provider": provider, "account_label": channel,
            "input_tokens": answer.usage.get("input_tokens", 0) or 0, "output_tokens": answer.usage.get("output_tokens", 0) or 0,
            "stop_reason": answer.error or "end_turn", **finished_usage(answer)})
        if server.usage and (answer.usage or answer.cost_usd is not None):
            from types import SimpleNamespace
            server.usage.record(answer.model, "character_agent", SimpleNamespace(**answer.usage),
                                status="failed" if answer.error else "completed",
                                provider=provider, channel=channel,
                                cost_usd=answer.cost_usd, cost_source="sdk_estimate" if answer.cost_usd is not None else None)
        reply = PreparedReply(mouth, answer.text, answer.model, answer.usage, answer.facts, answer.error,
                              final_item_id=answer.final_item_id, remember=trace.get("remember", True))
        if main and self._main_line == line_id:
            self._main_seen[1].append(reply)
        return reply
