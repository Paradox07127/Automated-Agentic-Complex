"""Small desktop read model. No transcripts, tool arguments or model reasoning."""
import time
from contextlib import nullcontext
from pathlib import PurePath

from sessions.agent_state import agent_state
from sessions.events import tool_category
from sessions.registry import DESKTOP_DONE_SECONDS, own_app_wait


ACTIVE = frozenset(('thinking', 'running_tool', 'awaiting_approval', 'awaiting_input', 'compacting', 'subagent',
                    'background'))
# Fixed text the desktop shows, by reply language code; "harness" (None) takes the Chinese one.
LABELS = {
    'zh-Hans': {'thinking': '在想', 'running_tool': '在跑', 'awaiting_approval': '待批准',
                'awaiting_input': '待回答', 'compacting': '在整理上下文', 'subagent': '在派子任务',
                'done': '完成', 'background': '在后台做', 'error': '出错了', 'stale': '没有新动静', 'idle': '空闲'},
    'en': {'thinking': 'Thinking', 'running_tool': 'Running', 'awaiting_approval': 'Needs approval',
           'awaiting_input': 'Needs an answer', 'compacting': 'Tidying context', 'subagent': 'Delegating a sub-task',
           'done': 'Done', 'background': 'Working in the background', 'error': 'Error', 'stale': 'No recent activity',
           'idle': 'Idle'},
    'ja': {'thinking': '考え中', 'running_tool': '実行中', 'awaiting_approval': '承認待ち',
           'awaiting_input': '回答待ち', 'compacting': 'コンテキスト整理中', 'subagent': 'サブタスクを依頼中',
           'done': '完了', 'background': 'バックグラウンドで作業中', 'error': 'エラー', 'stale': '動きなし', 'idle': '待機中'}}
TOOL_VERBS = {
    'zh-Hans': {'Edit': '改', 'MultiEdit': '改', 'NotebookEdit': '改', 'apply_patch': '改',
                'Write': '写入', 'Read': '读取', 'Bash': '运行', 'shell': '运行',
                'exec_command': '运行', 'local_shell': '运行', 'WebFetch': '访问',
                'WebSearch': '搜索', 'Glob': '查找', 'Grep': '搜索'},
    'en': {'Edit': 'Edit', 'MultiEdit': 'Edit', 'NotebookEdit': 'Edit', 'apply_patch': 'Edit',
           'Write': 'Write', 'Read': 'Read', 'Bash': 'Run', 'shell': 'Run',
           'exec_command': 'Run', 'local_shell': 'Run', 'WebFetch': 'Open',
           'WebSearch': 'Search', 'Glob': 'Find', 'Grep': 'Search'},
    'ja': {'Edit': '編集', 'MultiEdit': '編集', 'NotebookEdit': '編集', 'apply_patch': '編集',
           'Write': '書き込み', 'Read': '読み込み', 'Bash': '実行', 'shell': '実行',
           'exec_command': '実行', 'local_shell': '実行', 'WebFetch': 'アクセス',
           'WebSearch': '検索', 'Glob': '探索', 'Grep': '検索'}}
ACTIVITIES = {
    'zh-Hans': {'think': '思考中', 'wait': '等待回应', 'sleep': '休息中', 'relax': '空闲',
                'read': '阅读中', 'reading': '阅读中', 'sit': '坐着陪你', 'observe': '留意周围',
                'short_walk': '散步中', 'climb_window_top': '坐到窗口边', 'lean': '靠着窗沿'},
    'en': {'think': 'Thinking', 'wait': 'Waiting for a reply', 'sleep': 'Resting', 'relax': 'Idle',
           'read': 'Reading', 'reading': 'Reading', 'sit': 'Sitting with you', 'observe': 'Looking around',
           'short_walk': 'Taking a walk', 'climb_window_top': 'Sitting on the window edge',
           'lean': 'Leaning on the window'},
    'ja': {'think': '考え中', 'wait': '返事待ち', 'sleep': '休憩中', 'relax': '待機中',
           'read': '読書中', 'reading': '読書中', 'sit': 'そばに座っている', 'observe': '周りを見ている',
           'short_walk': '散歩中', 'climb_window_top': 'ウィンドウの縁に座っている', 'lean': 'ウィンドウにもたれている'}}
INTENTIONS = {
    'zh-Hans': {'running': '我在整理这次请求。', 'capabilities_checked': '我在整理这次请求。',
                'first_token': '我在组织回答。', 'tool_started': '我在处理任务所需的资料和操作。',
                'tool_finished': '我在检查工具返回的结果。', 'task_started': '我正在处理这项任务。',
                'verified': '结果已通过检查，正在整理交付。', 'needs_review': '结果还需要确认。',
                'background_pending': '后台任务仍在继续。', 'verifying': '我在核验实际结果。',
                'verification_failed': '结果没有通过检查。', 'waiting_user': '我在等你的回答。',
                'resume_required': '回答已收到，等待继续任务。', 'awaiting_approval': '这一步需要你批准。',
                'completed': '这一轮已结束。'},
    'en': {'running': "I'm sorting out this request.", 'capabilities_checked': "I'm sorting out this request.",
           'first_token': "I'm putting the answer together.",
           'tool_started': "I'm working on the material and steps the task needs.",
           'tool_finished': "I'm checking what the tool returned.", 'task_started': "I'm working on this task.",
           'verified': 'The result passed its check; I am preparing the delivery.',
           'needs_review': 'The result still needs confirming.',
           'background_pending': 'The background task is still going.', 'verifying': "I'm verifying the actual result.",
           'verification_failed': 'The result did not pass its check.', 'waiting_user': "I'm waiting for your answer.",
           'resume_required': 'Got your answer; waiting to continue the task.',
           'awaiting_approval': 'This step needs your approval.', 'completed': 'This round is over.'},
    'ja': {'running': 'この依頼を整理しています。', 'capabilities_checked': 'この依頼を整理しています。',
           'first_token': '答えをまとめています。', 'tool_started': 'タスクに必要な資料と操作を進めています。',
           'tool_finished': 'ツールの結果を確認しています。', 'task_started': 'このタスクに取り組んでいます。',
           'verified': '結果は確認を通りました。仕上げています。', 'needs_review': '結果はまだ確認が必要です。',
           'background_pending': 'バックグラウンドのタスクは続いています。', 'verifying': '実際の結果を検証しています。',
           'verification_failed': '結果は確認を通りませんでした。', 'waiting_user': 'あなたの答えを待っています。',
           'resume_required': '答えを受け取りました。タスクの再開を待っています。',
           'awaiting_approval': 'この手順にはあなたの承認が必要です。', 'completed': 'このラウンドは終わりました。'}}
TOOL_INTENTIONS = {
    'zh-Hans': {'knowledge_search': '我先查查与你有关的记录。', 'knowledge_read': '我在核对找到的资料。',
                'behavior_context': '我在确认眼前的情况。', 'artifact_verify': '我在检查结果是否符合要求。',
                'memory_propose': '我在整理值得记住的内容。',
                'desktop_observe': '我先看看你授权的窗口。', 'desktop_act': '我正在操作你授权的窗口。',
                'desktop_verify': '我在确认刚才的操作结果。'},
    'en': {'knowledge_search': "I'm checking the records about you first.", 'knowledge_read': "I'm checking what I found.",
           'behavior_context': "I'm confirming what is in front of me.",
           'artifact_verify': "I'm checking whether the result meets the requirements.",
           'memory_propose': "I'm sorting out what is worth remembering.",
           'desktop_observe': "I'm looking at the window you authorized first.",
           'desktop_act': "I'm operating the window you authorized.",
           'desktop_verify': "I'm checking the result of that action."},
    'ja': {'knowledge_search': 'まずあなたに関する記録を調べます。', 'knowledge_read': '見つけた資料を確かめています。',
           'behavior_context': '目の前の状況を確認しています。', 'artifact_verify': '結果が要件を満たすか確認しています。',
           'memory_propose': '覚えておくべきことを整理しています。',
           'desktop_observe': 'まず許可されたウィンドウを見てみます。', 'desktop_act': '許可されたウィンドウを操作しています。',
           'desktop_verify': 'さっきの操作の結果を確かめています。'}}
# The role's doing by tool category.
ROLE_DOING = {
    'zh-Hans': {'command': '在跑命令', 'read': '在读文件', 'write': '在改文件', 'search': '在查资料'},
    'en': {'command': 'Running a command', 'read': 'Reading a file', 'write': 'Editing a file', 'search': 'Looking things up'},
    'ja': {'command': 'コマンド実行中', 'read': 'ファイルを読んでいる', 'write': 'ファイルを編集中', 'search': '調べ物中'}}
PHRASES = {
    'zh-Hans': {'unknown': '状态不明', 'use': '用 {tool}', 'use_of': '用 {server} 的 {name}', 'subtask': '{place} · 子任务',
                'background': '后台任务', 'working': '我正在处理这次请求。', 'review': '待你复核',
                'passed': '结果已通过检查。', 'approval': '需要你批准一次操作', 'stale': '{minutes} 分钟没动静'},
    'en': {'unknown': 'Unknown state', 'use': 'Using {tool}', 'use_of': 'Using {name} from {server}',
           'subtask': '{place} · sub-task', 'background': 'Background task', 'working': "I'm working on this request.",
           'review': 'Needs your review', 'passed': 'The result passed its check.',
           'approval': 'An action needs your approval', 'stale': 'Quiet for {minutes} min'},
    'ja': {'unknown': '状態不明', 'use': '{tool} を使用', 'use_of': '{server} の {name} を使用', 'subtask': '{place} · サブタスク',
           'background': 'バックグラウンドタスク', 'working': 'この依頼に取り組んでいます。', 'review': 'あなたの確認待ち',
           'passed': '結果は確認を通りました。', 'approval': '操作の承認が必要です', 'stale': '{minutes} 分間動きなし'}}
# A stack card's status, in the order the cards sort by.
STATUSES = ('needs_you', 'error', 'done', 'running', 'stale')
SESSIONS_SHOWN = 8
REMINDERS_SHOWN = 5


def _reminders(commitments, now):
    """Armed or triggered reminders due on now's local day, and triggered ones overdue from before it, by due time."""
    t = time.localtime(now)
    today = time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1))
    tomorrow = time.mktime((t.tm_year, t.tm_mon, t.tm_mday + 1, 0, 0, 0, 0, 0, -1))
    return [{'id': c['id'], 'text': c['text'], 'due_at': c['due_at'], 'state': c['state']}
            for c in commitments.list(('armed', 'triggered'))
            if c['due_at'] is not None and c['due_at'] < tomorrow and (c['due_at'] >= today or c['state'] == 'triggered')]


def _action(row):
    """A hook session's current tool and its target, else its last ones; (None, None) before any tool."""
    if not row:
        return None, None
    if row['tool_name']:
        return row['tool_name'], row['tool_target']
    return row['last_tool_name'], row['last_tool_target']


def _in(table, language):
    return table.get(language, table['zh-Hans'])


def _doing(state, tool, target, language):
    phrases = _in(PHRASES, language)
    label = _in(LABELS, language).get(state, phrases['unknown'])
    if state == 'awaiting_approval':
        return ' '.join(part for part in (label, target) if part)
    if state != 'running_tool' or not tool:
        return label
    if tool in ('Bash', 'Task', 'Agent') and target and (tool != 'Bash' or ' ' in target):
        return target
    if tool.startswith('mcp__'):
        server, _, name = tool[5:].partition('__')
        if server.startswith('ccd_') or server == 'agentic_complex':
            return label
        return phrases['use_of'].format(server=server, name=name) if name else phrases['use'].format(tool=server)
    return ' '.join(part for part in (_in(TOOL_VERBS, language).get(tool, phrases['use'].format(tool=tool)), target)
                    if part)


def _role_doing(state, tool, language):
    labels = _in(LABELS, language)
    if state == 'running_tool':
        category = tool_category(tool)
        doing = _in(ROLE_DOING, language)
        return doing.get(category, doing.get({'knowledge_read': 'read', 'knowledge_search': 'search'}.get(tool), labels[state]))
    return labels.get(state, _in(PHRASES, language)['unknown'])


def _place(cwd, language):
    """The cwd's name; under `<repo>/.claude/worktrees/<name>` the repository's, since the worktree name is a random id."""
    parts = PurePath(cwd).parts
    for i in range(1, len(parts) - 2):
        if parts[i:i + 2] == ('.claude', 'worktrees'):
            return _in(PHRASES, language)['subtask'].format(place=parts[i - 1])
    return PurePath(cwd).name


def _status(row):
    if row['approvals'] or row['state'] in ('awaiting_approval', 'awaiting_input'):
        return 'needs_you'
    if row['state'] in ('error', 'stale'):
        return row['state']
    return 'done' if row['state'] == 'done' else 'running'


def _session_rows(server, language):
    with getattr(server.registry, 'cv', nullcontext()):
        registry = server.registry.snapshot()
        retired = list(getattr(server.registry, 'desktop_retired', {}).values())
        titles = server.registry.titles() if server.consent.snapshot()[0]['typed_text'] else {}
    manager = server.sessions
    native = manager.native_ids() if manager else {}
    hooks, sessions, observed_waiting = {}, [], 0
    for row in registry['sessions'] + retired:
        if row['source'] == 'claude' and row['session_id'] in native:
            hooks[native[row['session_id']].session_id] = row
            continue
        own_app = own_app_wait(row) is not None
        if own_app:
            observed_waiting += 1  # its own app asks; Agentic Complex cannot answer, so it is no approval here
        tool, target = _action(row)
        state, updated = row['effective_state'], row['since']
        # Registry's short animation TTL changes done and error to idle. Keep the receipt, without extending work state.
        if state == 'idle' and row.get('completed_at') is not None:
            state, updated = 'done', row['completed_at']
        elif state == 'idle' and row.get('failed_at') is not None:
            state, updated = 'error', row['failed_at']
        elif state == 'stale':
            updated = row['observed_at']  # its last event, not when the registry noticed the silence
        sessions.append({'id': row['display_session'], 'backend': row['source'],
                         'title': titles.get(row['display_session']) or
                         (_place(row['cwd'], language) if row.get('cwd') else row['source']),
                         'state': state, 'updated_at': updated, 'started_at': row.get('started_at'),
                         'tool': tool, 'target': target, 'own_app': own_app})
    if manager:
        for session in list(manager.sessions.values()):
            row = session.to_dict()
            hook = hooks.get(row['session_id'], {})
            tool, target = _action(hook)
            sessions.append({'id': row['session_id'], 'backend': row['target'],
                             'title': row.get('title') or (_place(row['cwd'], language) if row.get('cwd') else row['target']),
                             'state': 'awaiting_approval' if hook.get('effective_state') == 'awaiting_approval' else row['state'],
                             'updated_at': row['updated_at'], 'started_at': row.get('started_at'),
                             'tool': tool, 'target': target, 'own_app': False})
    return sessions, observed_waiting


def acknowledge(server, session_id, updated_at=None):
    """Only the completion, failure or silence the user opened is seen; an old click cannot hide newer work."""
    with server.registry.cv:
        sessions, _ = _session_rows(server, server.reply_language_code())
        row = next((s for s in sessions if s['id'] == session_id and s['state'] in ('done', 'error', 'stale')), None)
        if row is None or updated_at is not None and row['updated_at'] != updated_at:
            return False
        current = {s['id']: s['updated_at'] for s in sessions if s['state'] in ('done', 'error', 'stale')}
        kept = {key: at for key, at in server.registry.desktop_seen.items() if current.get(key) == at}
        server.registry.desktop_seen = {**kept, session_id: row['updated_at']}
        return True


def snapshot(server, now=None):
    now = time.time() if now is None else now
    language = server.reply_language_code()
    labels, intentions, phrases = _in(LABELS, language), _in(INTENTIONS, language), _in(PHRASES, language)
    sessions, observed_waiting = _session_rows(server, language)
    seen = getattr(server.registry, 'desktop_seen', {})
    work = [{'effective_state': s['state'], 'since': s['updated_at']} for s in sessions]
    sessions = [s for s in sessions if s['state'] in ACTIVE or
                s['state'] == 'done' and now - s['updated_at'] < DESKTOP_DONE_SECONDS and seen.get(s['id']) != s['updated_at'] or
                s['state'] == 'error' and now - s['updated_at'] < DESKTOP_DONE_SECONDS and seen.get(s['id']) != s['updated_at'] or
                s['state'] == 'stale' and seen.get(s['id']) != s['updated_at']]
    character = server.character_state()
    character_id = character.get('character_id') or server.character
    activities = _in(ACTIVITIES, language)
    role = {'state': 'idle', 'activity': activities.get(server.registry.activity, labels['idle']),
            'doing': activities.get(server.registry.activity, labels['idle']),
            'intention': None, 'backend': None, 'mood': (character.get('labels') or {}).get('mood'), 'background_runs': 0,
            'background': []}
    controller = server.character_agent
    from character_agent.services.embodiment import project
    run = project(controller.store, character_id, now) if controller else None
    if run:
        jobs = getattr(controller, 'jobs', None)
        titles = {job['run_id']: job['title'] for job in jobs.store.list(states=('running',), limit=None)} if jobs else {}
        role['background'] = [{**r, 'title': ' '.join(titles.get(r['run_id'], phrases['background']).split())[:80]} for r in run['background']]
        role.update(state=run['state'], activity=labels.get(run['state'], phrases['unknown']), backend=run['backend'],
                    doing=_role_doing(run['state'], run['tool_name'], language),
                    intention=intentions.get(run['phase'], phrases['working']),
                    run_id=run['run_id'], conversation_id=run['conversation_id'],
                    generation=run['run_generation'], phase=run['phase'], outcome=run['outcome'],
                    additional_runs=run['additional_runs'], background_runs=run['background_runs'], since=run['since'])
        ended_at = controller.store.get(run['run_id'])['ended_at'] if run['state'] in ('done', 'error') else None
        # A finished run is fresh from its finish, not its start.
        work.append({'effective_state': run['state'], 'since': ended_at or run['since']})
        if run['phase'] == 'tool_started':
            role['intention'] = _in(TOOL_INTENTIONS, language).get(run['tool_name'], intentions['tool_started'])
        if run['outcome'] == 'needs_review':
            role.update(activity=phrases['review'], intention=intentions['needs_review'])
        elif run['outcome'] == 'failed':
            role['intention'] = intentions['verification_failed']
        elif run['outcome'] == 'succeeded':
            role['intention'] = phrases['passed']
    elif server._mouth_lock.locked():
        role.update(state='thinking', activity=labels['thinking'], doing=labels['thinking'], intention=intentions['running'])
    pending = {kind: [] for kind in ('questions', 'approvals', 'tasks', 'results')}
    interactions = getattr(controller, 'interactions', None)
    if interactions:
        for row in interactions.list():
            if row['kind'] == 'question' and row['state'] == 'pending':
                pending['questions'].append({'id': row['request_id'], 'generation': row['generation'],
                    'title': row['data']['questions'][0]['question'], 'since': row['created_at']})
            elif row['kind'] == 'approval' and row['state'] == 'pending':
                pending['approvals'].append({'id': row['request_id'], 'generation': row['generation'],
                    'title': phrases['approval'], 'since': row['created_at']})
    broker = server.broker
    approvals = {}
    with broker.cv:
        # Approval creation uses the broker's monotonic clock, not epoch seconds.
        offset = now - broker.clock()
        for row in broker.pending():
            request = broker._requests[row['request_id']]
            pending['approvals'].append({'id': row['request_id'], 'generation': row['generation'],
                'title': (row['tool_name'] or row['kind']) + ': ' + (row['tool_summary'] or ''),
                'since': offset + request.created})
            approvals.setdefault(row['display_session'], []).append(row['request_id'])
    for row in sessions:
        row['approvals'] = approvals.get(row['id'], [])
        row['status'] = _status(row)
    sessions.sort(key=lambda s: (STATUSES.index(s['status']), -s['updated_at'], s['id']))
    for row in sessions:
        row['title'] = ' '.join(str(row['title']).split())[:80]
        row['activity'] = labels.get(row['state'], phrases['unknown'])
        if row['target'] is not None:
            row['target'] = ' '.join(row['target'].split())
        row['doing'] = (phrases['stale'].format(minutes=max(1, int(now - row['updated_at']) // 60))
                        if row['state'] == 'stale' else _doing(row['state'], row['tool'], row['target'], language))
    jobs = getattr(controller, 'jobs', None)
    if jobs:
        for row in jobs.store.list(states=('queued', 'running', 'interrupted', 'needs_review'), limit=None):
            pending['tasks'].append({'id': row['job_id'], 'generation': row['generation'],
                'title': row['title'], 'since': row['created_at'], 'state': row['state']})
    deliveries = getattr(controller, 'deliveries', None)
    if deliveries:
        for row in deliveries.list(limit=100, character_id=character_id)['deliveries']:
            if row['state'] in ('produced', 'presented', 'viewed') and not row.get('redacted'):
                pending['results'].append({'id':row['delivery_id'], 'generation':row['generation'],
                    'revision':row['revision'], 'title':row['title'], 'since':row['produced_at'],
                    'state':row['state'], 'canonical_task_id':row['canonical_task_id']})
    waiting = [row['since'] for row in pending['questions'] + pending['approvals']]
    for kind, rows in list(pending.items()):
        rows.sort(key=lambda row: -row['since'])
        for row in rows: row['title'] = ' '.join(row['title'].split())[:80]
        pending[kind] = rows[:3]
        pending[kind + '_more'] = max(0, len(rows) - 3)
    reminders = _reminders(server.commitments, now) if server.commitments is not None else []
    pending['reminders'] = reminders[:REMINDERS_SHOWN]
    pending['reminders_more'] = max(0, len(reminders) - REMINDERS_SHOWN)
    pending['observed_waiting'] = observed_waiting
    ritual = None
    if server.rituals is not None:
        server.ritual_check()  # brings /feed up to date first, so both name the same kind and since
        with server._ritual_lock:
            if server._ritual_kinds:
                ritual = {'kind': server._ritual_kinds[0], 'since': server._ritual_since}
    ended = [(row['effective_state'], row['since']) for row in work if row['effective_state'] in ('done', 'error')]
    thoughts = getattr(server, 'thoughts', None)
    voice = getattr(server, 'voice', None)
    paused = getattr(server, 'observation_paused', None)
    proactive = (getattr(getattr(server, 'interaction', None), 'proactive_speech', True)
                 and getattr(getattr(server, 'gate', None), 'enabled', True))
    return {'sampled_at': now, 'character_id': character_id, 'role': role,
            'sessions': sessions[:SESSIONS_SHOWN], 'additional_sessions': max(0, len(sessions) - SESSIONS_SHOWN),
            'pending': pending, 'ritual': ritual, 'agent': agent_state({'sessions': work}, waiting, ended, now),
            'focus': server.focus.presence(), 'proactive_speech': proactive,
            'thought': thoughts.latest() if proactive and thoughts is not None else None,
            'voice': {'state': voice.state().state, 'muted': getattr(server, 'muted', False)} if voice is not None
            else {'state': 'off', 'muted': False},
            'observation': {'paused': paused() if paused is not None else False}}


class PresenceFeed:
    """Publishes `presence` on /feed when the snapshot, sampled_at aside, is not the one last published. Checked on
    each other feed item and each poke, else every `interval` seconds, at most once per `min_gap`."""

    def __init__(self, server, interval=1.0, min_gap=0.25):
        self.server, self.interval, self.min_gap = server, interval, min_gap
        self._last = None
        self._poked = False

    def poke(self):
        """Something the snapshot reads changed without a feed item: a hook event or a seen card."""
        feed = self.server.feed
        with feed.cv:
            self._poked = True
            feed.cv.notify_all()

    def check(self, now=None):
        """The `presence` item published, or None when the snapshot is unchanged or agentd is resetting or closing."""
        server = self.server
        if server.resetting or server.closing:
            return None
        value = snapshot(server, now)
        del value['sampled_at']
        if value == self._last:
            return None
        self._last = value
        return server.feed.publish('presence', {})

    def run(self, stopped):
        feed = self.server.feed
        while not stopped.is_set():
            with feed.cv:
                self._poked = False
                seen = feed.seq
            try:
                item = self.check()
            except Exception:  # the host only polls while /feed is down, so this loop must outlive a bad read
                item = None
            if item is not None and item['seq'] == seen + 1:
                seen = item['seq']
            if stopped.wait(self.min_gap):
                return
            with feed.cv:
                if feed.seq == seen and not self._poked:
                    feed.cv.wait(self.interval)
