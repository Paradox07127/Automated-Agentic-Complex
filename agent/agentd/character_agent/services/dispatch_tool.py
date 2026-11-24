"""Run-scoped delegation tools: proposals wait for the existing dispatch card."""
from pathlib import Path

from character_agent.services.workspace import _validate_arguments
from tool_gateway.protected_paths import secret_path


class DispatchTurn:
    def __init__(self, controller, text, source_run_id, character_id):
        self.controller, self.text = controller, text
        self.run_id, self.character_id = source_run_id, character_id
        self.current = lambda: False

    def open(self, current):
        self.current = current

    @staticmethod
    def tool_definitions():
        return [
            {'name': 'dispatch_session',
             'description': 'Start a Claude Code or Codex session in a project folder on the user\'s computer to change code, run commands or do long engineering work. '
                 'It only shows the user a confirmation card and the session starts once they allow it, so until then say you asked for confirmation, not that work began; '
                 'you are called to report when the session ends. It is refused while this conversation already has a dispatch card awaiting confirmation. '
                 'Returns task_id with state awaiting_confirmation.',
             'input_schema': {'type': 'object', 'additionalProperties': False, 'required': ['backend', 'prompt'],
                 'properties': {
                     'backend': {'type': 'string', 'enum': ['claude', 'codex'], 'description': 'claude for Claude Code or codex for Codex, as the user asked.'},
                     'project': {'type': 'string', 'maxLength': 200, 'description': 'Project folder name, matched against known sessions\' directories; with no match and no cwd, the focused session\'s directory, else the workspace.'},
                     'cwd': {'type': 'string', 'maxLength': 1024, 'description': 'Absolute project path; only when the user gave an exact path.'},
                     'prompt': {'type': 'string', 'minLength': 1, 'maxLength': 8000, 'description': 'The complete task for the session: goal, background, constraints and done criteria, readable without this chat.'},
                     'title': {'type': 'string', 'maxLength': 80, 'description': 'Short title on the confirmation card; defaults to the first line of prompt.'}}}},
            {'name': 'dispatch_status', 'description': 'Read the Claude Code and Codex tasks you dispatched: the latest few without task_id, or only that one with it. '
                 'Use it when the user asks how dispatched work is going and answer from the returned state; awaiting confirmation means not started.',
             'input_schema': {'type': 'object', 'additionalProperties': False, 'properties': {
                 'task_id': {'type': 'string', 'maxLength': 64, 'description': 'The task_id dispatch_session returned.'},
                 'limit': {'type': 'integer', 'minimum': 1, 'maximum': 5, 'description': 'How many tasks to return at most; default 5.'}}}},
        ]

    @staticmethod
    def _directory(value):
        path = Path(value)
        if not path.is_absolute() or secret_path(path.as_posix()):
            raise ValueError('invalid_cwd')
        try:
            resolved = path.resolve(strict=True)
            if not resolved.is_dir() or resolved in (Path('/'), Path.home().resolve()) \
                    or secret_path(resolved.as_posix()):
                raise ValueError('invalid_cwd')
        except (OSError, RuntimeError):
            raise ValueError('invalid_cwd') from None
        return str(resolved)

    def _resolve_cwd(self, args):
        server = self.controller.server
        project = args.get('project')
        if 'cwd' in args:
            return {'cwd': self._directory(args['cwd']),
                    'cwd_from': {'source': 'agent', 'project': project, 'matched': 'cwd'}}
        snapshot = server.registry.snapshot()
        paths = [s['cwd'] for s in snapshot['sessions'] if s.get('cwd')]
        with server.tasks.lock:
            paths += [row[0] for row in server.tasks.db.execute(
                'SELECT cwd FROM own_sessions UNION SELECT cwd FROM tasks').fetchall()]
        known = set()
        for value in paths:
            try:
                known.add(self._directory(value))
            except ValueError:
                continue
        paths = sorted(known)
        if project:
            matches = [p for p in paths if Path(p).name.casefold() == project.casefold()]
            if len(matches) > 1:
                return {'error': {'code': 'ambiguous_project', 'candidates': matches}}
            if matches:
                return {'cwd': matches[0], 'cwd_from': {'source': 'agent', 'project': project, 'matched': 'project'}}
        focus = snapshot['focus']['display_session']
        focused = next((s.get('cwd') for s in snapshot['sessions'] if s['display_session'] == focus), None)
        if focused:
            try:
                return {'cwd': self._directory(focused),
                        'cwd_from': {'source': 'agent', 'project': project, 'matched': 'focus'}}
            except ValueError:
                pass
        return {'cwd': self._directory(str(self.controller.settings.workspace())),
                'cwd_from': {'source': 'agent', 'project': project, 'matched': 'workspace'}}

    def _status(self, args):
        return {'tasks': self.controller.server.tasks.agent_dispatches(self.character_id,
            task_id=args.get('task_id'), limit=args.get('limit', 5))}

    def call(self, name, args, _tool_call_id=None):
        try:
            definitions = {t['name']: t['input_schema'] for t in self.tool_definitions()}
            if name not in definitions:
                raise ValueError('unknown_dispatch_tool')
            _validate_arguments(args, definitions[name])
            server = getattr(self.controller, 'server', None)
            if server is None or server.tasks is None or server.dispatcher.tasks is None:
                raise ValueError('dispatch_unavailable')
            if name == 'dispatch_status':
                if not self.current():
                    raise ValueError('run_cancelled')
                return self._status(args)
            if not args['prompt'].strip():
                raise ValueError('invalid_arguments')
            # Outside broker.cv: the permission hook takes registry.cv before broker.cv.
            resolved = self._resolve_cwd(args)
            if 'error' in resolved:
                return resolved
            run = self.controller.store.get(self.run_id)
            conversation_id = run['conversation_id'] if run else server.history.conversations.active if server.history else None
            with server.broker.cv:
                if not self.current():
                    raise ValueError('run_cancelled')
                pending = [r for r in server.broker.pending() if r['kind'] == 'dispatch']
                if len(pending) >= 3 or any((r['dispatch'] or {}).get('source') == 'agent' and
                        (r['dispatch'].get('requested_by') or {}).get('conversation_id') == conversation_id for r in pending):
                    raise ValueError('too_many_pending')
                requested_by = {'kind': 'agent', 'run_id': self.run_id, 'conversation_id': conversation_id,
                                'character_id': self.character_id}
                request = server.dispatcher.propose(args['backend'], resolved['cwd'], args['prompt'], source='agent',
                    utterance=self.text[:500], cwd_from=resolved['cwd_from'],
                    title=args.get('title', args['prompt'].strip().splitlines()[0][:80]), requested_by=requested_by)
                return {'task_id': request.request_id, 'request_id': request.request_id, 'state': 'awaiting_confirmation',
                        'target': args['backend'], **resolved, 'expires_in_s': 600}
        except ValueError as error:
            return {'error': {'code': str(error)}}
