"""Run-scoped goal/job tools. Workers cannot recursively create more workers."""
from character_agent.services.interactions import REFUSED, approved


SCHEDULE_ACTIONS = {
    'zh-Hans': {'enable': '启用计划任务：{}', 'disable': '停用计划任务：{}', 'edit': '修改计划任务：{}',
                'delete': '删除计划任务：{}', 'run_now': '立即运行计划任务：{}'},
    'en': {'enable': 'Enable schedule: {}', 'disable': 'Disable schedule: {}', 'edit': 'Edit schedule: {}',
           'delete': 'Delete schedule: {}', 'run_now': 'Run schedule now: {}'},
    'ja': {'enable': 'スケジュールを有効にする：{}', 'disable': 'スケジュールを無効にする：{}', 'edit': 'スケジュールを編集：{}',
           'delete': 'スケジュールを削除：{}', 'run_now': 'スケジュールを今すぐ実行：{}'},
}


SETTINGS_CARD = {
    'zh-Hans': {'title': '修改设置：{}', 'on': '开', 'off': '关', 'none': '无', 'minutes': '{} 分钟',
                'companion_mode': '主动陪伴', 'quiet_enabled': '免打扰时段', 'quiet_ranges': '免打扰时间',
                'muted': '不主动说的类型', 'observation_pause_minutes': '暂停观察', 'reply_language': '回复语言'},
    'en': {'title': 'Change settings: {}', 'on': 'on', 'off': 'off', 'none': 'none', 'minutes': '{} min',
           'companion_mode': 'Companion mode', 'quiet_enabled': 'Quiet hours', 'quiet_ranges': 'Quiet hours ranges',
           'muted': 'Muted line kinds', 'observation_pause_minutes': 'Pause observation', 'reply_language': 'Reply language'},
    'ja': {'title': '設定を変更：{}', 'on': 'オン', 'off': 'オフ', 'none': 'なし', 'minutes': '{} 分',
           'companion_mode': 'コンパニオンモード', 'quiet_enabled': 'おやすみ時間', 'quiet_ranges': 'おやすみ時間の範囲',
           'muted': '話さない種類', 'observation_pause_minutes': '観察を一時停止', 'reply_language': '返信の言語'},
}


# Single-use approval card titles for changes to the user's own work, by reply language code.
WORK_CARD = {
    'zh-Hans': {'cancel_job': '取消后台任务：{}', 'continue': '继续任务：{}（{}）', 'completed': '完成目标：{}',
                'cancelled': '取消目标：{}', 'paused': '暂停目标：{}'},
    'en': {'cancel_job': 'Cancel background job: {}', 'continue': 'Continue task: {} ({})', 'completed': 'Complete goal: {}',
           'cancelled': 'Cancel goal: {}', 'paused': 'Pause goal: {}'},
    'ja': {'cancel_job': 'バックグラウンドタスクを取り消す：{}', 'continue': 'タスクを続ける：{}（{}）', 'completed': '目標を完了する：{}',
           'cancelled': '目標を取り消す：{}', 'paused': '目標を一時停止する：{}'},
}
# The schedule fields a card's action relies on; a change to any while it waits voids the approval.
SCHEDULE_SHOWN = ('title', 'instruction', 'trigger', 'enabled', 'conversation_id', 'scope_id')


def _when(trigger):
    if trigger['kind'] == 'session_done':
        return ' '.join(['session_done', trigger.get('target') or '*', trigger.get('project') or '*'])
    days = trigger['weekdays'] if trigger['kind'] == 'daily' else [trigger['weekday']]
    return f"{trigger['kind']} {trigger['at']} ({','.join(map(str, days))})"


def tool(name, description, properties=None, required=()):
    return {'name': name, 'description': description, 'input_schema': {'type': 'object', 'properties': properties or {},
        'required': list(required), 'additionalProperties': False}}


class OrchestrationTurn:
    def __init__(self, controller, text, config, character_id, scope_id, source_run_id, *, utterance=None):
        self.controller, self.text, self.config = controller, text, dict(config)
        self.character_id, self.scope_id, self.source_run_id = character_id, scope_id, source_run_id
        self.current = lambda: False
        self.spawned = []
        from character_agent.services.reminders import ReminderTurn
        self.reminders = ReminderTurn(controller, text, source_run_id, character_id=character_id,
                                      scope_id=scope_id)
        from character_agent.services.dispatch_tool import DispatchTurn
        self.dispatch = DispatchTurn(controller, text if utterance is None else utterance, source_run_id, character_id)

    def open(self, current):
        self.current = current
        self.reminders.open(current)
        self.dispatch.open(current)

    @staticmethod
    def tool_definitions():
        text = {'type': 'string', 'minLength': 1, 'maxLength': 2000}
        ident = {'type': 'string', 'minLength': 1, 'maxLength': 128}
        page = {'offset': {'type': 'integer', 'minimum': 0, 'maximum': 90}, 'limit': {'type': 'integer', 'minimum': 1, 'maximum': 10}}
        from character_agent.services.reminders import ReminderTurn
        from character_agent.services.dispatch_tool import DispatchTurn
        from observation.privacy import PAUSE_MAX
        from brain import language
        from character.proactive import MUTABLE
        hour = {'type': 'integer', 'minimum': 0, 'maximum': 23}
        settings = {'companion_mode': {'type': 'boolean', 'description': 'Whether you may speak up on your own.'},
                    'quiet_enabled': {'type': 'boolean', 'description': 'Whether quiet hours hold your own lines.'},
                    'quiet_ranges': {'type': 'array', 'maxItems': 8, 'description': 'The whole list of quiet hours as [start, end] '
                        'local hours, e.g. [[22, 8]] for 22:00 to 08:00; start and end differ.',
                        'items': {'type': 'array', 'minItems': 2, 'maxItems': 2, 'items': hour}},
                    'muted': {'type': 'array', 'maxItems': len(MUTABLE), 'description': 'The whole list of line kinds you do not say on your own.',
                        'items': {'type': 'string', 'enum': list(MUTABLE)}},
                    'observation_pause_minutes': {'type': 'integer', 'minimum': 0, 'maximum': PAUSE_MAX,
                        'description': 'Pause watching the screen for this many minutes from now; 0 resumes.'},
                    'reply_language': {'type': 'string', 'enum': list(language.SETTINGS),
                        'description': 'auto follows the user\'s language; harness leaves it to the kernel.'}}
        schedule = {'title': {'type': 'string', 'minLength': 1, 'maxLength': 200, 'description': 'Short name shown on the schedules page.'},
                  'instruction': {**text, 'description': 'What each run should do, complete enough to work without this conversation.'},
                  'trigger': {'type': 'object', 'additionalProperties': False, 'required': ['kind'],
                      'description': 'System local time. daily requires at (HH:MM) and weekdays (Monday=1, Sunday=7); weekly requires weekday and at. session_done: omit target or project to match any.',
                      'properties': {
                      'kind': {'type': 'string', 'enum': ['daily', 'weekly', 'session_done']},
                      'at': {'type': 'string', 'description': '24-hour local time HH:MM, e.g. "09:00".'},
                      'weekdays': {'type': 'array', 'minItems': 1, 'maxItems': 7, 'description': 'daily: days it runs, Monday=1 ... Sunday=7.',
                          'items': {'type': 'integer', 'minimum': 1, 'maximum': 7}},
                      'weekday': {'type': 'integer', 'minimum': 1, 'maximum': 7, 'description': 'weekly: the one day it runs, Monday=1.'},
                      'target': {'type': 'string', 'enum': ['claude', 'codex'], 'description': 'session_done: which agent; omit for either.'},
                      'project': {'type': 'string', 'description': 'session_done: project folder name; omit for any.'}}}}
        return [*ReminderTurn.tool_definitions(), *DispatchTurn.tool_definitions(),
            tool('schedule_propose', 'Propose a recurring background task that you will run on your own at a set local time (daily or weekly) '
                 'or each time a Claude/Codex session finishes, e.g. "every weekday at 9:00 summarise yesterday\'s commits". '
                 'To notify the user at a time use reminder_create, and for a long-term objective without a timetable use goal_create. '
                 'Saved disabled by default; set enabled=true to ask the user immediately to confirm enabling it via an approval card.',
                 {**schedule, 'enabled': {'type': 'boolean', 'description': 'If true, opens an approval card to enable immediately.'}},
                 ('title', 'instruction', 'trigger')),
            tool('schedules_list', 'Read a bounded page of saved local schedules with their trigger and enabled state, when the user asks what is scheduled. '
                 'Read-only: change one with schedule_update. Follow next_offset for more.', page),
            tool('schedule_update', 'Enable, disable, edit, delete or run now one saved schedule, with its schedule_id from schedules_list or schedule_propose. '
                 'Every call shows the user a confirmation card and changes nothing until they allow it; until the result comes back '
                 'say only that you asked them to confirm, never that it is enabled, changed, deleted or running. '
                 'edit takes at least one of title, instruction and trigger and replaces only those; other actions take none. '
                 'Returns the schedule\'s new state, or error user_declined when the user refused, approval_expired when they did not answer the card in time (nothing was done), or user_dismissed when they dismissed it without deciding.',
                 {'schedule_id': {**ident, 'description': 'The schedule\'s schedule_id.'},
                  'action': {'type': 'string', 'enum': ['enable', 'disable', 'edit', 'delete', 'run_now']}, **schedule},
                 ('schedule_id', 'action')),
            tool('settings_read', 'Read the settings you may change with settings_update: companion mode (speaking up on your own), '
                 'quiet hours, muted line kinds with the kinds allowed, the observation pause and quiet ends, and the reply language '
                 'with the values allowed. Other settings are not readable or changeable here.'),
            tool('settings_update', 'Change one or more of the settings settings_read returns when the user asks; give only those to change. '
                 'Every call shows the user a confirmation card and changes nothing until they allow it; until the result comes back '
                 'say only that you asked them to confirm, never that it is changed. '
                 'Returns the new settings, or error user_declined when the user refused, approval_expired when they did not answer the card in time (nothing was done), or user_dismissed when they dismissed it without deciding.', settings),
            tool('goals_list', 'Read a bounded page of the user\'s durable goals with goal_id, title, current version and status '
                 '(active, paused, completed, cancelled). Use it when the user asks about their goals, and before goal_update, '
                 'which needs the goal_id and current version. Follow next_offset for more.', page),
            tool('goal_create', 'Create a durable personal goal that you keep following over days or weeks, e.g. "create a goal to run three times a week". '
                 'Use it only when the current message explicitly asks for a goal or ongoing follow-up; a one-off task, '
                 'a timed reminder (reminder_create) or a recurring automatic job (schedule_propose) is not a goal. '
                 'objective_quote is saved as the goal\'s objective. Returns the goal with its goal_id.',
                 {'title': {'type': 'string', 'maxLength': 200, 'description': 'Short name for the goal.'},
                  'objective_quote': {**text, 'description': 'The user\'s words that state the goal.'}}, ('title', 'objective_quote')),
            tool('goal_update', 'Change a goal\'s status when the current user message asks for that change and names the goal by title or id: '
                 'active resumes it, paused pauses it, completed or cancelled closes it. expected_version is its current version from goals_list; '
                 'a stale one is refused. Completion requires all associated work to have verified results. '
                 'Closing shows the user a confirmation card and changes nothing until they allow it; '
                 'it returns error user_declined when they refused, approval_expired when they did not answer the card in time (nothing was done), or user_dismissed when they dismissed it without deciding.',
                 {'goal_id': ident, 'expected_version': {'type': 'integer', 'minimum': 1, 'description': 'The goal\'s current version from goals_list.'},
                  'state': {'type': 'string', 'enum': ['active', 'paused', 'completed', 'cancelled']}}, ('goal_id', 'expected_version', 'state')),
            tool('background_start', 'Run an authorized part of the current request in the background while you keep talking with the user: '
                 'work that writes files, takes several tool steps or more than about 20 seconds. The same character and kernel own it. '
                 'It inherits the current file scope and cannot widen permission or start nested jobs. '
                 'Returns the job id with state queued, which is not completed; check background_status before reporting a result.',
                 {'title': {'type': 'string', 'maxLength': 200, 'description': 'Short name the user sees in the task list.'},
                  'instruction': {**text, 'description': 'Self-contained instructions: what to do, which material to use, and the expected output.'},
                  'goal_id': {**ident, 'description': 'Optional goal this job serves.'}}, ('title', 'instruction')),
            tool('background_status', 'Read a bounded page of background jobs with state, verification status and result summaries, '
                 'when the user asks how a job is going or to find the job_id or task_id to continue or cancel. '
                 'Filter states (e.g. queued and running) to find older active work. A result is done only when verified is true.',
                 {**page,'states':{'type':'array','items':{'type':'string','enum':['queued','running','succeeded','needs_review','failed','cancelled','interrupted']},'maxItems':7,
                  'description':'Only jobs in these states; omit for all.'}}),
            tool('background_cancel', 'Cancel only the background job the user names in the current message (by its title or id, '
                 'or a plain "stop it" when exactly one job is active); take job_id from background_start or background_status. '
                 'New chat alone never cancels a job. Shows the user a confirmation card and cancels nothing until they allow it. '
                 'Returns whether the job was cancelled, or error user_declined when they refused, approval_expired when they did not answer the card in time (nothing was done), or user_dismissed when they dismissed it without deciding.', {'job_id': ident}, ('job_id',)),
            tool('task_continue', 'Continue earlier work only when the user explicitly asks to continue a previous task or background job. '
                 'Find it first in the task index or background_status, then pass its task_id or job_id; the current user message is its new instruction. '
                 'Shows the user a confirmation card first and continues nothing until they allow it (otherwise error user_declined, approval_expired when the card went unanswered, or user_dismissed). '
                 'The continuation is queued in the background with the same task, file scope and checkpoint; '
                 'queued is not completed. Use it instead of a new task_plan or background_start for the same work.',
                 {'task_id': {**ident, 'description': 'The earlier task; give this or job_id.'}, 'job_id': {**ident, 'description': 'The earlier background job; give this or task_id.'}}),
        ]

    def call(self, name, args, tool_call_id=None):
        if name in {t['name'] for t in self.reminders.tool_definitions()}:
            value = self.reminders.call(name, args, tool_call_id)
        elif name in {t['name'] for t in self.dispatch.tool_definitions()}:
            value = self.dispatch.call(name, args, tool_call_id)
        else:
            value = self._dispatch(name, args)
        return self.controller.knowledge().sanitize(value, part='orchestration')

    def _dispatch(self, name, args):
        c = self.controller
        if not self.current() or c.jobs is None: return {'error': {'code': 'run_cancelled'}}
        definitions = {d['name']: d['input_schema'] for d in self.tool_definitions()}
        from character_agent.services.workspace import _validate_arguments
        try:
            if name not in definitions: raise ValueError('unknown_orchestration_tool')
            _validate_arguments(args, definitions[name])
            if name in ('schedule_propose', 'schedules_list', 'schedule_update'):
                store = c.server.schedules_store()
                if store is None:
                    raise ValueError('no_schedules')
                if name == 'schedule_propose':
                    from personal.schedules import validate_trigger
                    enabled = bool(args.get('enabled'))
                    history = c.server.history
                    conversation_id = history.conversations.active if history else None
                    if enabled:
                        validate_trigger(args['trigger'])
                        if not args['title'].strip() or not args['instruction'].strip():
                            raise ValueError('invalid_schedule')
                        c.server.schedule_context(conversation_id, self.scope_id)
                        language = c.semantic.reply()
                        title = SCHEDULE_ACTIONS.get(language, SCHEDULE_ACTIONS['zh-Hans'])['enable'].format(args['title'])
                        if (outcome := self._approved(title, args, language)) != 'allowed':
                            return {'error': {'code': REFUSED[outcome]}}
                        c.server.schedule_context(conversation_id, self.scope_id)
                    item = store.add(args['title'], args['instruction'], args['trigger'], enabled=False,
                        created_from='agent_proposal', conversation_id=conversation_id, scope_id=self.scope_id)
                    if enabled:
                        item = store.update(item['schedule_id'], {'enabled': True})
                        return {'schedule': item, 'message': 'Enabled after user confirmation.'}
                    return {'schedule': item, 'message': 'Saved disabled; it runs only after the user enables it on the schedules page.'}
                if name == 'schedule_update':
                    return self._schedule_update(store, args)
                records = store.list()
                offset, limit = args.get('offset', 0), args.get('limit', 10)
                page = records[offset:offset + limit]
                return {'schedules': page, 'next_offset': offset + len(page) if offset + len(page) < len(records) else None}
            if name == 'settings_read':
                return self._settings_read()
            if name == 'settings_update':
                return self._settings_update(args)
            if name in ('goals_list', 'background_status'):
                records = c.jobs.store.goals() if name == 'goals_list' else c.jobs.store.list(states=args.get('states') or None)
                offset, limit = args.get('offset', 0), args.get('limit', 10)
                page = records[offset:offset + limit]
                for record in page:
                    if 'objective' in record and len(record['objective']) > 4000:
                        record['objective'] = record['objective'][:4000]; record['objective_truncated'] = True
                    result = record.get('result')
                    if result:
                        validation = result.get('validation') or {}
                        record['result'] = {'reply': (result.get('reply') or '')[:4000],
                            'reply_truncated': len(result.get('reply') or '') > 4000, 'error': result.get('error'),
                            'task_id': result.get('task_id'), 'verified': validation.get('ok'),
                            'artifacts': [{k: a.get(k) for k in ('path', 'absolute_path', 'sha256', 'version')} for a in validation.get('artifacts', [])[:12]]}
                return {'goals' if name == 'goals_list' else 'jobs': page,
                    'next_offset': offset + len(page) if offset + len(page) < len(records) else None}
            if name == 'goal_create':
                quote = args['objective_quote']
                if not args['title'].strip() or not quote.strip():
                    raise ValueError('explicit_goal_instruction_required')
                return c.jobs.store.create_goal(args['title'], quote)
            if name == 'goal_update':
                if args['state'] in ('completed', 'cancelled', 'paused'):
                    goal = c.jobs.store.goal(args['goal_id'])
                    if goal is None:
                        raise ValueError('unknown_goal')
                    if goal['revision'] != args['expected_version']:
                        raise ValueError('goal_version_changed')
                    if (outcome := self._approved_work(args['state'], args, goal['title'])) != 'allowed':
                        return {'error': {'code': REFUSED[outcome]}}
                return c.update_goal(args['goal_id'], args['expected_version'], args['state'])
            if name == 'background_start':
                job = c.submit_job(args['title'], self.text, args['instruction'], self.scope_id,
                    goal_id=args.get('goal_id'), config=self.config, character_id=self.character_id, source_run_id=self.source_run_id,
                    valid=self.current)
                self.spawned.append(job['job_id'])
                return job
            if name == 'background_cancel':
                job = c.jobs.store.get(args['job_id'])
                if job is None:
                    raise ValueError('unknown_job')
                if (outcome := self._approved_work('cancel_job', args, job['title'])) != 'allowed':
                    return {'error': {'code': REFUSED[outcome]}}
                return {'job_id': args['job_id'], 'cancelled': c.jobs.cancel(args['job_id'])}
            if name == 'task_continue':
                if not args.get('task_id') and not args.get('job_id'):
                    raise ValueError('continue_target_required')
                job_id = args.get('job_id') or (c._job_tasks().get(args['task_id']) or {}).get('job_id')
                if job_id:
                    target = c.jobs.store.get(job_id)
                    if target is None:
                        raise ValueError('unknown_job')
                else:
                    target = c.server.tasks.get(args['task_id']) if c.server.tasks else None
                    if target is None:
                        raise ValueError('unknown_task')
                if (outcome := self._approved_work('continue', args, target['title'], self.text)) != 'allowed':
                    return {'error': {'code': REFUSED[outcome]}}
                job = c.resume_job(job_id, text=self.text) if job_id else c.adopt_task(args['task_id'], self.text, self.text,
                    config=self.config, character_id=self.character_id, source_run_id=self.source_run_id, valid=self.current)
                self.spawned.append(job['job_id'])
                return {k: job[k] for k in ('job_id', 'run_id', 'state')}
        except ValueError as exc:
            return {'error': {'code': str(exc)}}

    def _approved(self, title, args, language):
        return approved(self.controller.interactions, self.source_run_id, title, dict(args), valid=self.current,
                        character_id=self.character_id, scope_id=self.scope_id, language=language)

    def _approved_work(self, action, args, *names):
        language = self.controller.semantic.reply()
        return self._approved(WORK_CARD.get(language, WORK_CARD['zh-Hans'])[action].format(*names), args, language)

    def _schedule_update(self, store, args):
        """One schedule change behind a single-use approval card, through the store calls the /schedules routes make."""
        from personal.schedules import validate_trigger
        c, ident, action = self.controller, args['schedule_id'], args['action']
        changes = {k: args[k] for k in ('title', 'instruction', 'trigger') if k in args}
        if (action == 'edit') != bool(changes):
            raise ValueError('invalid_schedule_update')
        item = store.get(ident)
        if item is None:
            raise ValueError('unknown_schedule')
        label = item['title']
        if action == 'edit':
            if 'trigger' in changes:
                changes['trigger'] = validate_trigger(changes['trigger'])
            shown = lambda key, value: _when(value) if key == 'trigger' else value
            label += ' (' + '; '.join(f'{shown(k, item[k])} → {shown(k, v)}' for k, v in changes.items()) + ')'
        language = c.semantic.reply()
        title = SCHEDULE_ACTIONS.get(language, SCHEDULE_ACTIONS['zh-Hans'])[action].format(label)
        if (outcome := self._approved(title, args, language)) != 'allowed':
            return {'error': {'code': REFUSED[outcome]}}
        if action == 'enable':
            c.server.schedule_context(item['conversation_id'], item['scope_id'])
        if action in ('enable', 'disable'):
            changes = {'enabled': action == 'enable'}
        saved = store.get(ident)
        if saved is None:
            raise ValueError('unknown_schedule')
        if any(saved[key] != item[key] for key in SCHEDULE_SHOWN):
            raise ValueError('schedule_changed')
        if action == 'delete':
            store.delete(ident)
            return {'schedule': None, 'deleted': True}
        if action == 'run_now':
            job = c.server._submit_schedule(store, store.run_now(ident), manual=True)
            return {'schedule': store.get(ident), 'job_id': job['job_id']}
        return {'schedule': store.update(ident, changes, expected={key: item[key] for key in SCHEDULE_SHOWN})}

    def _settings_read(self):
        from brain.language import SETTINGS
        from character.proactive import MUTABLE
        c = self.controller
        gate, observed = c.server.gate, c.server.observation_state()
        on, ranges = gate.quiet_settings
        return {'companion_mode': gate.companion, 'quiet_enabled': on, 'quiet_ranges': ranges, 'muted': sorted(gate.muted),
                'mutable_kinds': list(MUTABLE), 'paused_until': observed['paused_until'], 'quiet_until': observed['quiet_until'],
                'reply_language': c.settings.snapshot()['reply_language'], 'reply_languages': list(SETTINGS)}

    def _settings_update(self, args):
        """One change set behind a single-use approval card, through the calls the /proactive, /observation and
        /character/runtime routes make."""
        c = self.controller
        if not args:
            raise ValueError('invalid_settings_update')
        if any(start == end for start, end in args.get('quiet_ranges', ())):
            raise ValueError('invalid_quiet_ranges')
        current = self._settings_read()
        language = c.semantic.reply()
        words = SETTINGS_CARD.get(language, SETTINGS_CARD['zh-Hans'])
        def shown(key, value):
            if isinstance(value, bool):
                return words['on' if value else 'off']
            if key == 'quiet_ranges':
                return ', '.join(f'{start}:00–{end}:00' for start, end in value) or words['none']
            if key == 'muted':
                return ', '.join(sorted(set(value))) or words['none']
            if key == 'observation_pause_minutes':
                return words['minutes'].format(value) if value else words['off']
            return value
        before = lambda key: words['on' if current['paused_until'] else 'off'] if key == 'observation_pause_minutes' \
            else shown(key, current[key])  # noqa: E731
        title = words['title'].format('; '.join(f'{words[k]}: {before(k)} → {shown(k, v)}' for k, v in args.items()))
        if (outcome := self._approved(title, args, language)) != 'allowed':
            return {'error': {'code': REFUSED[outcome]}}
        server = c.server
        gate = server.gate
        if 'companion_mode' in args:
            gate.set_companion(args['companion_mode'])
        if 'quiet_enabled' in args or 'quiet_ranges' in args:
            on, ranges = gate.quiet_settings
            gate.set_quiet(args.get('quiet_enabled', on), args.get('quiet_ranges', ranges))
        if 'muted' in args:
            gate.set_muted(args['muted'])
        if 'observation_pause_minutes' in args:
            minutes = args['observation_pause_minutes']
            server.set_paused_until(server.clock() + minutes * 60 if minutes else None)
        if 'reply_language' in args:
            c.configure({'reply_language': args['reply_language']})
        return self._settings_read()
