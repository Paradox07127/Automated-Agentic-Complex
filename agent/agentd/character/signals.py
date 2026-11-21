"""Session and work signals rendered as quiet thoughts with their own delivery budget."""
import collections
import datetime
from pathlib import PurePath
import re
import threading
import time

from brain.language import mismatch
from character.reminder_offer import offer as reminder_offer
from character.repeat_finder import find as find_repeat
from character.thoughts import OWN_BUDGET, UNHEARD, _factor, _heard, _idle, _thread, _typing
from character_agent.services.semantic import room
from sessions.check_result import parse
from sessions.registry import APPS, HISTORY, own_app_wait

EVERY = 5.0
DAILY_CAP = 12
TASK_EVERY = 60
HOLD = 120  # seconds a signal held for typing waits for the pause; then it is dropped
RUNNING = ('running_tool', 'thinking', 'compacting', 'subagent')
# Error code -> reason, by reply language code; "harness" (None) takes the Chinese ones.
ERRORS = {'zh-Hans': {'rate_limit': '请求被限流了', 'rate_limit_error': '请求被限流了',
                      'authentication_failed': '认证失败了', 'authentication_error': '认证失败了',
                      'api_error': '接口出错了', 'api': '接口出错了', 'server_error': '服务出错了',
                      'billing_error': '额度不足了', 'overloaded_error': '服务繁忙',
                      'network_error': '网络出错了', 'timeout': '请求超时了'},
          'en': {'rate_limit': 'requests were rate limited', 'rate_limit_error': 'requests were rate limited',
                 'authentication_failed': 'authentication failed', 'authentication_error': 'authentication failed',
                 'api_error': 'the API returned an error', 'api': 'the API returned an error',
                 'server_error': 'the service returned an error', 'billing_error': 'the quota ran out',
                 'overloaded_error': 'the service is busy', 'network_error': 'the network failed',
                 'timeout': 'the request timed out'},
          'ja': {'rate_limit': 'リクエストが制限された', 'rate_limit_error': 'リクエストが制限された',
                 'authentication_failed': '認証に失敗した', 'authentication_error': '認証に失敗した',
                 'api_error': 'API でエラーが出た', 'api': 'API でエラーが出た', 'server_error': 'サービスでエラーが出た',
                 'billing_error': '利用枠が足りない', 'overloaded_error': 'サービスが混んでいる',
                 'network_error': 'ネットワークでエラーが出た', 'timeout': 'リクエストがタイムアウトした'}}
# The session and task lines by reply language code; "harness" (None) takes the Chinese ones.
LINES = {'zh-Hans': {'check_exit': '{agent} 的 {label} 没过（退出码 {exit}）',
                     'check_one': '{agent} 的 {label} 红了 {n} 条，都是 {suite}',
                     'check_some': '{agent} 的 {label} 红了 {n} 条：{suites} 等', 'check_n': '{agent} 的 {label} 红了 {n} 条',
                     'list': '、', 'check_offer': '开个会话看看？',
                     'check_reply_n': '帮我开一个会话看看 {project} 的 {label} 为什么红了 {n} 条',
                     'check_reply_exit': '帮我开一个会话看看 {project} 的 {label} 为什么没过',
                     'error_default': '会话出错了', 'tool': '工具', 'error_tools': '连着 3 次 {target} 失败',
                     'error': '{agent} 在 {project} 停下了：{detail}', 'error_offer': '要我看看报错吗？',
                     'error_reply': '帮我看看 {project} 那个会话为什么停了', 'done': '{agent} 在 {project} 做完了：{sentence}',
                     'task': '任务', 'approval': '{agent} 在等你批准 {target}，{minutes} 分钟了',
                     'quiet': '{agent} 的 {target} {minutes} 分钟没动静了', 'quiet_offer': '要我看看是不是卡住了？',
                     'quiet_reply': '帮我看看 {project} 那个会话是不是卡住了', 'due': '「{title}」的下一步该做了：{step}',
                     'due_offer': '开个会话做', 'due_reply': '帮我开一个会话做「{title}」的下一步：{step}',
                     'stalled': '「{title}」一天没动了，上次停在：{step}'},
         'en': {'check_exit': "{agent}'s {label} did not pass (exit code {exit})",
                'check_one': "{agent}'s {label} has {n} failing, all in {suite}",
                'check_some': "{agent}'s {label} has {n} failing: {suites} and more",
                'check_n': "{agent}'s {label} has {n} failing", 'list': ', ', 'check_offer': 'Open a session to look?',
                'check_reply_n': "Open a session to look at why {project}'s {label} has {n} failing",
                'check_reply_exit': "Open a session to look at why {project}'s {label} did not pass",
                'error_default': 'the session hit an error', 'tool': 'a tool', 'error_tools': '{target} failed 3 times in a row',
                'error': '{agent} stopped in {project}: {detail}', 'error_offer': 'Want me to look at the error?',
                'error_reply': 'Look at why that session in {project} stopped',
                'done': '{agent} finished in {project}: {sentence}', 'task': 'the task',
                'approval': '{agent} has been waiting {minutes} min for you to approve {target}',
                'quiet': "{agent}'s {target} has been quiet for {minutes} min",
                'quiet_offer': 'Want me to check whether it is stuck?',
                'quiet_reply': 'Check whether that session in {project} is stuck',
                'due': 'Time for the next step of "{title}": {step}', 'due_offer': 'Open a session for it',
                'due_reply': 'Open a session for the next step of "{title}": {step}',
                'stalled': '"{title}" has not moved for a day; it last stopped at: {step}'},
         'ja': {'check_exit': '{agent} の {label} が通らなかった（終了コード {exit}）',
                'check_one': '{agent} の {label} で {n} 件失敗、すべて {suite}',
                'check_some': '{agent} の {label} で {n} 件失敗：{suites} など', 'check_n': '{agent} の {label} で {n} 件失敗',
                'list': '、', 'check_offer': 'セッションを開いて見てみる？',
                'check_reply_n': 'セッションを開いて、{project} の {label} がなぜ {n} 件失敗したか見て',
                'check_reply_exit': 'セッションを開いて、{project} の {label} がなぜ通らなかったか見て',
                'error_default': 'セッションでエラーが出た', 'tool': 'ツール', 'error_tools': '{target} が 3 回続けて失敗',
                'error': '{agent} が {project} で止まった：{detail}', 'error_offer': 'エラーを見てみようか？',
                'error_reply': '{project} のあのセッションがなぜ止まったか見て',
                'done': '{agent} が {project} で終わった：{sentence}', 'task': 'タスク',
                'approval': '{agent} が {target} の承認を {minutes} 分待っている',
                'quiet': '{agent} の {target} が {minutes} 分動いていない', 'quiet_offer': '止まっていないか見てみようか？',
                'quiet_reply': '{project} のあのセッションが止まっていないか見て',
                'due': '「{title}」の次の一歩の時間：{step}', 'due_offer': 'セッションを開いてやる',
                'due_reply': 'セッションを開いて「{title}」の次の一歩をやって：{step}',
                'stalled': '「{title}」が一日止まっている。前回は：{step}'}}
# The repeat line by reply language code; "harness" (None) takes the Chinese one.
REPEAT = {'zh-Hans': '这周你有 {days} 天都在{what}', 'en': 'This week, on {days} days, you were {what}',
          'ja': '今週は {days} 日、「{what}」をしていたね'}


def _short(text, limit):
    return text if len(text) <= limit else text[:limit - 1] + '…'


class Signals:
    def __init__(self, gate, thoughts, registry, *, sessions=None, scene=lambda: None,
                 allowed=lambda row: True, pending=lambda: [], clock=time.time, worklog=None,
                 semantic=None, report_time=(17, 30), egress=None, spawn=_thread,
                 work_allowed=lambda row: True):
        self.gate, self.thoughts, self.registry = gate, thoughts, registry
        self.sessions, self.scene, self.allowed, self.pending, self.clock = sessions, scene, allowed, pending, clock
        self._lock = threading.RLock()
        self._turns = {}
        self._seen = collections.OrderedDict()
        self._cooldowns = {}
        self._held = None
        self._held_at = None  # clock time _held was held for typing; None when held for an absence
        self._day, self._count, self._tick_at = None, 0, None
        self.worklog, self.semantic, self.report_time = worklog, semantic, report_time
        self.egress, self.spawn, self.work_allowed = egress, spawn, work_allowed
        self._task_at = self._present_since = self._repeat_day = None
        self._category_days = {}
        self._repeat_running = False

    def _own(self, sid):
        return sid.startswith('own:') or self.sessions is not None and self.sessions.own_id(sid) != sid

    def _turn(self, event):
        return self._turns.setdefault(event.key, {'start': event.ts, 'check': None, 'sent': set(),
                                                 'work': None, 'ended': False, 'message': '', 'error': ''})

    def on_hook(self, event, body):
        if event.agent_id or self._own(event.session_id):
            return
        with self._lock:
            if event.kind == 'prompt_submit':
                self._turns.pop(event.key, None)
                if self._held is not None and self._held[1]['display_session'] == f'{event.source}:{event.session_id}':
                    self._held = None
            turn = self._turn(event)
            if turn['ended'] and event.kind != 'prompt_submit':
                return
            if event.kind in ('tool_end', 'tool_failure'):
                result = parse(event.tool_name, body.get('tool_input'), body)
                if result is not None:
                    turn['check'] = result
            if event.kind == 'stop':
                message = body.get('last_assistant_message')
                turn['message'] = message if isinstance(message, str) else ''
            if event.kind == 'stop_failure':
                error = body.get('error_type') or body.get('error')
                turn['error'] = error if isinstance(error, str) else ''

    def on_transition(self, was, row, event):
        if row is None or event.agent_id or self._own(event.session_id) or not self.allowed(row):
            return False
        with self._lock:
            if event.kind == 'prompt_submit' and self._turn(event)['ended']:
                self._turns.pop(event.key)
            turn = self._turn(event)
            if turn['ended']:
                return False
            state = row['effective_state']
            if state in ('running_tool', 'thinking'):
                turn['work'] = state
            elif state != 'stale':
                turn['work'] = None
            agent = APPS.get(row['source'], row['source'])
            project = PurePath(row.get('cwd') or '').name or row['session_id']
            handled = False
            check = turn['check']
            language = self._language()
            lines = LINES.get(language, LINES['zh-Hans'])
            if event.kind in ('stop', 'stop_failure') and check and (check['failed'] or check['exit'] not in (0, None)):
                n, label, suites = check['failed'] or None, check['label'], check['suites']
                if n is None:
                    text = lines['check_exit'].format(agent=agent, label=label, exit=check['exit'])
                elif len(suites) == 1:
                    text = lines['check_one'].format(agent=agent, label=label, n=n, suite=suites[0])
                elif suites:
                    text = lines['check_some'].format(agent=agent, label=label, n=n, suites=lines['list'].join(suites[:2]))
                else:
                    text = lines['check_n'].format(agent=agent, label=label, n=n)
                handled = self._emit('check_failed', row, text, lines['check_offer'],
                                     lines['check_reply_n' if n is not None else 'check_reply_exit'].format(
                                         project=project, label=label, n=n),
                                     subject=(row['display_session'], label, tuple(sorted(check['names']))), cooldown=600)
            if not handled and state == 'error' and was != 'error':
                target = row.get('last_tool_target') or event.tool_target or event.tool_name or lines['tool']
                detail = ERRORS.get(language, ERRORS['zh-Hans']).get(turn['error'], lines['error_default']) \
                    if event.kind == 'stop_failure' else lines['error_tools'].format(target=target)
                handled = self._emit('session_error', row, lines['error'].format(agent=agent, project=project, detail=detail),
                                     lines['error_offer'], lines['error_reply'].format(project=project), cooldown=600)
            if event.kind == 'stop' and not handled and not turn['sent'].intersection(('check_failed', 'session_error')) \
                    and event.ts - turn['start'] >= 600 and turn['message']:
                sentence = re.split(r'(?<=[。！？.!?])\s*|\n', turn['message'].strip(), maxsplit=1)[0]
                handled = self._emit('turn_done', row,
                                     lines['done'].format(agent=agent, project=project, sentence=_short(sentence, 40)),
                                     cooldown=1800)
            if event.kind in ('stop', 'stop_failure', 'interrupt', 'session_end'):
                turn['ended'] = True
            return handled

    def tick(self, now):
        with self._lock:
            if self._tick_at is not None and now - self._tick_at < EVERY:
                return
            self._tick_at = now
            scene = self.scene()
            if scene is None or _idle(scene):
                self._present_since = None
            elif self._present_since is None:
                self._present_since = now
            rows = self.registry.snapshot(now)['sessions']
            live = {(r['source'], r['session_id']): r for r in rows}
            pending = {r['request_id'] for r in self.pending()}
            if self._held_at is not None and now - self._held_at >= HOLD:
                self._held = self._held_at = None
            if self._held is not None and not _idle(self.scene()) and not _typing(self.gate, now):
                args = self._held
                self._held = None
                reason, held_row = args[:2]
                key = (held_row['source'], held_row['session_id'])
                turn = self._turns.get(key)
                if turn is not None:
                    turn['sent'].discard(reason)
                current = live.get(key)
                valid = reason not in ('approval_wait', 'run_quiet')
                if reason == 'approval_wait':
                    valid = current is not None and current['effective_state'] == 'awaiting_approval' \
                        and 90 <= now - current['since'] < 120 \
                        and not pending.intersection(current['pending_approvals'])
                elif reason == 'run_quiet':
                    valid = current is not None and current['effective_state'] == 'stale' \
                        and current['observed_at'] == held_row['observed_at']
                if valid:
                    if reason == 'task_due':
                        self._seen.pop((reason, args[5]), None)
                    self._emit(*args, now=now)
            held_key = None if self._held is None else (self._held[1]['source'], self._held[1]['session_id'])
            self._turns = {key: turn for key, turn in self._turns.items() if key in live or key == held_key}
            lines = LINES.get(self._language(), LINES['zh-Hans'])
            for row in rows:
                if self._own(row['session_id']) or not self.allowed(row):
                    self._turns.pop((row['source'], row['session_id']), None)
                    continue
                turn = self._turns.get((row['source'], row['session_id']))
                if turn is None or turn['ended']:
                    continue
                agent = APPS.get(row['source'], row['source'])
                project = PurePath(row.get('cwd') or '').name or row['session_id']
                target = row.get('tool_target') or row.get('last_tool_target') or lines['task']
                if row['effective_state'] == 'awaiting_approval' and 90 <= now - row['since'] < 120 \
                        and (own_app_wait(row) or not pending.intersection(row['pending_approvals'])):
                    minutes = max(1, int((now - row['since']) / 60))
                    self._emit('approval_wait', row, lines['approval'].format(agent=agent, target=target, minutes=minutes),
                               now=now)
                elif row['effective_state'] == 'stale' and turn['work'] in ('running_tool', 'thinking') \
                        and now - row['observed_at'] >= 900:
                    minutes = int((now - row['observed_at']) / 60)
                    self._emit('run_quiet', row, lines['quiet'].format(agent=agent, target=target, minutes=minutes),
                               lines['quiet_offer'], lines['quiet_reply'].format(project=project), now=now)
            if self.worklog is not None:
                if self._task_at is None or now - self._task_at >= TASK_EVERY:
                    self._task_at = now
                    self._tasks(now, rows)
                self._repeat(now)

    def _language(self):
        return None if self.semantic is None else self.semantic.reply()

    def _version(self):
        return self.worklog.character(), self.worklog.generation

    def _summary_allowed(self, summary):
        sid = summary['session_key']
        return not self._own(sid) and self.work_allowed(summary) and self.allowed(
            {'source': summary.get('agent') or 'worklog', 'session_id': sid, 'cwd': summary.get('cwd')})

    def _task_eligible(self, reason, card, now, rows):
        if card['status'] != 'active' or not self.work_allowed(card):
            return False
        linked = self.worklog.sessions_for_task(card['id'])
        if any(not self._summary_allowed(s) for s in linked):
            return False
        if reason == 'task_due':
            return card.get('next_due_at') is not None and card['next_due_at'] <= now
        running = {(r['source'], r['session_id']) for r in rows if r['effective_state'] in RUNNING}
        return self._present_since is not None and now - self._present_since >= 300 \
            and card['last_at'] < now - 86400 \
            and not any((s.get('agent'), s['session_key']) in running for s in linked)

    def _tasks(self, now, rows):
        language = self._language()
        lines = LINES.get(language, LINES['zh-Hans'])
        for card in self.worklog.tasks(('active',)):
            title, step = card['title'], card['next_step']
            for reason in ('task_due', 'task_stalled'):
                if not self._task_eligible(reason, card, now, rows):
                    continue
                due = card.get('next_due_at')
                row = {'category': 'task', 'source': 'task', 'session_id': card['id'],
                       'display_session': f"task:{card['id']}", 'observed_at': due if reason == 'task_due' else now,
                       'card': card, 'version': self._version()}
                if reason == 'task_due':
                    self._emit(reason, row, lines['due'].format(title=title, step=step), lines['due_offer'],
                               lines['due_reply'].format(title=title, step=step), subject=(card['id'], due), now=now)
                else:
                    offer, reply = reminder_offer(title, step, now, language=language) or (None, None)
                    self._emit(reason, row, lines['stalled'].format(title=title, step=step), offer, reply,
                               cooldown=72 * 3600, now=now)

    def _work_valid(self, reason, row, now):
        if self.worklog is None or row['version'] != self._version():
            return False
        if row['category'] == 'task':
            card = next((c for c in self.worklog.tasks(('active',)) if c['id'] == row['card']['id']), None)
            return card == row['card'] and self._task_eligible(reason, card, now,
                                                              self.registry.snapshot(now)['sessions'])
        return all(self._summary_allowed(s) for s in row['evidence'])

    def _repeat(self, now):
        moment = datetime.datetime.fromtimestamp(now)
        if self.semantic is None or self._repeat_running or self._repeat_day == moment.date() \
                or (moment.hour, moment.minute) < self.report_time:
            return
        if any(self.gate.check(category, moment, 'P2') not in OWN_BUDGET for category in ('repeat', 'thought')):
            return
        self._repeat_day = moment.date()
        version = self._version()
        summaries = [s for n in range(7)
                     for s in self.worklog.sessions_on((moment.date() - datetime.timedelta(days=n)).isoformat())
                     if s['state'] == 'completed' and self._summary_allowed(s)]
        if len({s['day'] for s in summaries}) < 3:
            return
        self._repeat_running = True
        self.spawn(lambda: self._find_repeat(summaries, version))

    def _find_repeat(self, summaries, version):
        try:
            if version != self._version() or not all(self._summary_allowed(s) for s in summaries):
                return
            language = self.semantic.reply()
            for _ in range(2):  # a finding clearly in another language than the reply's is generated once more
                found = find_repeat(summaries, self.semantic, egress=self.egress, reply=language)
                if found is None or language is None or not mismatch(language, found['what']):
                    break
            else:
                return
            if found is None:
                return
            evidence = [s for s in summaries if s['id'] in found['evidence']]
            what, days = found['what'], len({s['day'] for s in evidence})
            now = self.clock()
            row = {'category': 'repeat', 'source': 'repeat', 'session_id': what,
                   'display_session': f'repeat:{what}', 'observed_at': now, 'version': version, 'evidence': evidence}
            offer, reply = reminder_offer(what, '', now, repeat='daily', language=language) or (None, None)
            text = REPEAT.get(language, REPEAT['zh-Hans']).format(days=days, what=what)
            with self._lock:
                self._emit('repeat', row, text, offer, reply,
                           cooldown=14 * 86400, now=now)
        finally:
            with self._lock:
                self._repeat_running = False

    def _emit(self, reason, row, text, offer=None, reply=None, subject=None, cooldown=0, *, now=None):
        now = self.clock() if now is None else now
        category = row.get('category', 'session')
        if not self.allowed(row) or (self._own(row['session_id']) if category == 'session'
                                     else not self._work_valid(reason, row, now)):
            return False
        turn = self._turns.get((row['source'], row['session_id']))
        if category == 'session' and (turn is None or reason in ('approval_wait', 'run_quiet') and reason in turn['sent']):
            return False
        key = (reason, subject) if subject is not None else None
        cool_key = (reason, row['display_session'])
        if key in self._seen or now - self._cooldowns.get(cool_key, float('-inf')) < cooldown:
            return False
        moment = datetime.datetime.fromtimestamp(now)
        if any(self.gate.check(kind, moment, 'P2') not in OWN_BUDGET for kind in (category, 'thought')):
            return False
        if self._day != moment.date():
            self._day, self._count = moment.date(), 0
        if self._count >= DAILY_CAP:
            return False
        if category in ('task', 'repeat') and self._category_days.get(category) == moment.date():
            return False
        log = self.thoughts.log
        if log is not None and reason != 'approval_wait':  # a waiting approval reaches the user whatever the feedback
            unheard = _heard(log, f'signal.{reason}', now)[1]
            if now - self._cooldowns.get(cool_key, float('-inf')) < cooldown * _factor(log, unheard):
                return False
            # A reason without a cooldown, mostly unheard, shows once a day.
            if not cooldown and unheard >= UNHEARD and self._category_days.get(reason) == moment.date():
                return False
        idle = _idle(self.scene())
        if idle or _typing(self.gate, now):
            if turn is not None:
                turn['sent'].add(reason)
            # A replaced due signal must not be rediscovered on return.
            if reason == 'task_due':
                self._seen[key] = True
                while len(self._seen) > HISTORY:
                    self._seen.popitem(last=False)
            if self._held is None or row['observed_at'] >= self._held[1]['observed_at']:
                self._held = (reason, row, text, offer, reply, subject, cooldown)
                self._held_at = None if idle else now
            return True
        most = 60 if self.semantic is None else room(60, self.semantic.reply())
        self.thoughts.post({'text': _short(text, most), 'offer': offer, 'reply': reply,
                            'reason': f'signal.{reason}',
                            'session_id': row['display_session'] if category == 'session' else None})
        self._count += 1
        if turn is not None:
            turn['sent'].add(reason)
        if category in ('task', 'repeat'):
            self._category_days[category] = moment.date()
        if not cooldown:
            self._category_days[reason] = moment.date()
        self._cooldowns[cool_key] = now
        if key is not None:
            self._seen[key] = True
            while len(self._seen) > HISTORY:
                self._seen.popitem(last=False)
        return True
