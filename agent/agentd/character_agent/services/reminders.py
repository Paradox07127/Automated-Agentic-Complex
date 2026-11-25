"""Run-scoped reminder tools backed by the product's persistent reminder store."""
from datetime import datetime
import hashlib
import math
import re

from character_agent.services.instruction_guard import positive_instruction
from character_agent.services.workspace import _validate_arguments
from personal.commitments import SNOOZE_DELIVERED

# One-character verbs need 个/条 right after them, so 确定一下提醒 is not an ask.
CREATE = re.compile(r'提醒我|提醒一下|叫我|喊我|リマインドして|(?:设置|创建|添加|新建|安排).{0,16}(?:提醒|闹钟)|'
                    r'(?:建|加|设|定)(?:一?个|一?条).{0,16}(?:提醒|闹钟)|'
                    r'\bremind\s+me\b|\b(?:set|create|add)\b.{0,24}\b(?:reminder|alarm)\b', re.I)
CANCEL = re.compile(r'取消|删除|撤销|\b(?:cancel|delete|remove)\b', re.I)
RESCHEDULE = re.compile(r'改到|改成|改为|修改|推迟|延后|提前|\b(?:reschedule|snooze|postpone|move)\b', re.I)
# 已经…了 may not hold a negation, so 已经不想做了 is not a done.
COMPLETE = re.compile(r'(?:做|办|弄|写|交)完了|完成了|搞定了|已经[^，,。！？!?；;不没未别]{0,12}?了|标记.{0,4}完成|打卡|'
                      r'\b(?:done|finished)\b|\bmark\b.{0,24}\b(?:complete|completed|done)\b', re.I)
AGAIN = re.compile(r'再(?:提醒|叫|喊)我')
SNOOZE = re.compile(rf'{RESCHEDULE.pattern}|(?:稍后|晚点|晚些|等会儿?|待会儿?|过.{{0,8}}?|后){AGAIN.pattern}', re.I)
# A reminder pointed at instead of named: the only active one, or for RECENT words the newest created.
POINTER = r'(?:刚才|刚刚|上一个|上个|最新|那个|这个|它)'
REFERENCE = re.compile(rf'{POINTER}(?:那个|这个|的|那条|这条)?提醒|(?:把|将){POINTER}|'
                       rf'(?:取消|删除|撤销|推迟|延后|提前)掉?{POINTER}|'
                       r'\b(?:that|this|last|latest)\s+(?:one|reminder)\b|\b(?:cancel|delete|remove|reschedule|snooze|postpone|move)\s+(?:it|that)\b', re.I)
RECENT = re.compile(r'刚才|刚刚|上一?个|最新|\b(?:last|latest)\b', re.I)
TIME = re.compile(r'(?:\d|[零一二两三四五六七八九十半])\s*(?:分钟|小时|个小时|点|[时時]|[:：]\d)|'
                  r'\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|half\s+an?|an?)\s*'
                  r'(?:minutes?|hours?|seconds?|am\b|pm\b)|\b\d{1,2}:\d{2}', re.I)
# What the instruction must say for each trigger kind and repeat a reminder_create asks for.
ASKED = {'session_done': re.compile(r'(?:claude|codex|会话|session).{0,12}?(?:做完|跑完|完成|结束|\bfinish|\bdone\b|\bcomplete|\bends?\b)', re.I),
         'approval_waiting': re.compile(r'审批|批准|\bapprov', re.I),
         'daily': re.compile(r'每天|每日|毎日|\bevery\s*day\b|\bdaily\b', re.I),
         'weekdays': re.compile(r'工作日|\bweekdays?\b', re.I)}


def tool(name, description, properties, required=()):
    return {'name': name, 'description': description, 'input_schema': {'type': 'object',
        'properties': properties, 'required': list(required), 'additionalProperties': False}}


class ReminderTurn:
    def __init__(self, controller, text, source_run_id, *, answers=()):
        self.controller, self.text, self.run_id = controller, text, source_run_id
        # The user's own answers to ask_user in this run; they may supply only a reminder's time.
        self.answers = answers
        self.current = lambda: False

    def open(self, current):
        self.current = current

    @staticmethod
    def tool_definitions():
        quote = {'type': 'string', 'minLength': 2, 'maxLength': 2000,
                 'description': 'The complete current user instruction, copied verbatim.'}
        due = {'type': 'string', 'minLength': 20, 'maxLength': 64,
               'description': 'Future ISO 8601 date and time with an explicit UTC offset, e.g. 2026-11-18T09:00:00+08:00. Ask the user if their date/time is ambiguous.'}
        trigger = {'type': 'object', 'additionalProperties': False, 'required': ['kind'],
                   'description': 'Instead of due_at: session_done fires when a Claude or Codex session finishes (agent omitted: either; session_id: only that one); approval_waiting fires when an approval has waited minutes. Missed if it has not fired within 24 h.',
                   'properties': {'kind': {'type': 'string', 'enum': ['session_done', 'approval_waiting']},
                                  'agent': {'type': 'string', 'enum': ['claude', 'codex']},
                                  'session_id': {'type': 'string', 'minLength': 1, 'maxLength': 128},
                                  'minutes': {'type': 'integer', 'minimum': 1, 'maximum': 1440}}}
        return [
            tool('reminders_list', 'Read the user\'s saved reminders with id, text, local due time, repeat or trigger, status and current revision, plus the current local time. '
                 'Use it when the user asks what reminders they have, and before reminder_update, which needs the id and revision; active_only (default true) hides finished and cancelled ones. '
                 'A fulfilled status never proves the user heard it or finished the underlying task.',
                 {'offset': {'type': 'integer', 'minimum': 0, 'maximum': 10000},
                  'limit': {'type': 'integer', 'minimum': 1, 'maximum': 20},
                  'active_only': {'type': 'boolean', 'description': 'Only armed or triggered reminders; defaults to true.'}}),
            tool('reminder_create', 'Save a reminder that notifies the user later, only one this user message explicitly asks for; '
                 'for work you should do on a schedule use schedule_propose, for a long-term objective goal_create. '
                 'Timing: due_at for one time, plus repeat daily or weekdays (Mon-Fri) at due_at\'s local time when the user asks for a repeat, due_at being its first time; '
                 'or trigger instead of due_at for when a session finishes or an approval has waited, where agent alone is enough and no session lookup is needed. '
                 'text must occur in instruction_quote; when you asked for the time with ask_user, put the verbatim time words of the answer in time_quote. Returns the saved id and exact time.',
                 {'text': {'type': 'string', 'minLength': 1, 'maxLength': 500, 'description': 'What to remind about, as words from instruction_quote.'}, 'due_at': due,
                  'repeat': {'type': 'string', 'enum': ['daily', 'weekdays'], 'description': 'Only when the user asked for a repeating reminder.'}, 'trigger': trigger,
                  'instruction_quote': quote,
                  'time_quote': {**quote, 'description': 'Verbatim time words from the user\'s answer to your ask_user question, when the time is not in instruction_quote.'}},
                 ('text', 'instruction_quote')),
            tool('reminder_update', 'Cancel, reschedule, complete or snooze the reminder the user names in the current message, with its id and current revision from reminders_list '
                 'and a verbatim current instruction naming it. If the user points at it instead ("that one"), quote their sentence and give the id it means: '
                 'the only active reminder, or the newest for "the last one"; if that is unclear, ask which one first. '
                 'complete when the user says they have done the thing it reminds about ("done", "做完了"); '
                 'snooze when they want it again later ("remind me again in ten minutes", "十分钟后再提醒我"). '
                 'For reschedule and snooze give the new due_at, which the quote must contain; if they give no time, ask for one. '
                 'This changes only the reminder, not the underlying task.',
                 {'reminder_id': {'type': 'string', 'minLength': 1, 'maxLength': 128},
                  'expected_revision': {'type': 'integer', 'minimum': 1, 'description': 'The reminder\'s current revision from reminders_list.'},
                  'action': {'type': 'string', 'enum': ['cancel', 'reschedule', 'complete', 'snooze']},
                  'instruction_quote': quote, 'due_at': {**due, 'description': 'reschedule and snooze only: the new time. ' + due['description']}},
                 ('reminder_id', 'expected_revision', 'action', 'instruction_quote')),
        ]

    @staticmethod
    def _time(value, now):
        if not isinstance(value, str):
            raise ValueError('invalid_reminder_time')
        try:
            when = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except (ValueError, TypeError):
            raise ValueError('invalid_reminder_time') from None
        if when.tzinfo is None or when.utcoffset() is None:
            raise ValueError('reminder_timezone_required')
        due = when.timestamp()
        if not math.isfinite(due) or not now < due <= now + 366 * 86400:
            raise ValueError('reminder_time_out_of_range')
        return due

    @staticmethod
    def _trigger(value, repeat):
        """The store's trigger: session_done with agent (None: either) and an optional session_id, or
        approval_waiting with minutes; a trigger never repeats."""
        if repeat is None and value['kind'] == 'session_done' and 'minutes' not in value:
            return {'kind': 'session_done', 'agent': value.get('agent'),
                    **({'session_id': value['session_id']} if 'session_id' in value else {})}
        if repeat is None and value['kind'] == 'approval_waiting' and set(value) == {'kind', 'minutes'}:
            return {'kind': 'approval_waiting', 'minutes': value['minutes']}
        raise ValueError('invalid_reminder_trigger')

    @staticmethod
    def _public(item):
        return {**item, 'due_at_iso': None if item['due_at'] is None else
                datetime.fromtimestamp(item['due_at']).astimezone().isoformat(),
                'delivery_evidence': 'not_confirmed' if item['seen_at'] is None else 'card_shown',
                'underlying_task_completed': None}

    def call(self, name, args, _tool_call_id=None):
        try:
            definitions = {t['name']: t['input_schema'] for t in self.tool_definitions()}
            if name not in definitions:
                raise ValueError('unknown_reminder_tool')
            _validate_arguments(args, definitions[name])
            store = getattr(getattr(self.controller, 'server', None), 'commitments', None)
            if store is None:
                raise ValueError('reminders_unavailable')
            with store.lock:
                if not self.current():
                    raise ValueError('run_cancelled')
                if name == 'reminders_list':
                    records = store.list(('armed', 'triggered') if args.get('active_only', True) else None)
                    offset, limit = args.get('offset', 0), args.get('limit', 10)
                    page = records[offset:offset + limit]
                    return {'items': [self._public(i) for i in page],
                            'next_offset': offset + len(page) if offset + len(page) < len(records) else None,
                            'now': datetime.fromtimestamp(store.clock()).astimezone().isoformat()}
                quote = args['instruction_quote']
                if quote not in self.text:
                    raise ValueError('reminder_instruction_required')
                if name == 'reminder_create':
                    if args['text'] not in quote or not positive_instruction(self.text, CREATE, targets=(quote,)):
                        raise ValueError('reminder_instruction_required')
                    if ('due_at' in args) == ('trigger' in args):
                        raise ValueError('reminder_time_or_trigger_required')
                    trigger = self._trigger(args['trigger'], args.get('repeat')) if 'trigger' in args else None
                    modes = (trigger and trigger['kind'], args.get('repeat'))
                    time_quote = args.get('time_quote')
                    if time_quote is not None and not any(time_quote in answer for answer in self.answers):
                        raise ValueError('reminder_instruction_required')
                    if (trigger is None or trigger['kind'] == 'approval_waiting') and not TIME.search(quote) \
                            and not (time_quote is not None and TIME.search(time_quote)) \
                            or not all(ASKED[mode].search(quote) for mode in modes if mode):
                        raise ValueError('reminder_time_instruction_required')
                    due = None if trigger else self._time(args['due_at'], store.clock())
                    identity = [self.run_id, name, quote, args['text'], due, args.get('repeat'), trigger, time_quote]
                    key = hashlib.sha256(repr(identity).encode()).hexdigest()
                    item = store.add(args['text'], due, self.run_id, repeat=args.get('repeat'), trigger=trigger,
                                     request_key=key)
                    action = 'added'
                else:
                    item = store._get(args['reminder_id'])
                    pattern = {'cancel': CANCEL, 'reschedule': RESCHEDULE, 'complete': COMPLETE,
                               'snooze': SNOOZE}[args['action']]
                    if not positive_instruction(self.text, pattern, targets=(quote,)):
                        raise ValueError('reminder_target_not_authorized')
                    active = store.list(('armed', 'triggered'))
                    if item is not None and positive_instruction(quote, pattern, targets=(item['id'], item['text'])):
                        matching = [i for i in active if i['text'] == item['text']]
                        if len(matching) > 1 and item['id'] not in quote:
                            raise ValueError('reminder_target_ambiguous')
                    else:
                        # 再提醒我 points at the reminder it would repeat.
                        refs = tuple(m.group() for m in REFERENCE.finditer(quote)) + \
                            (tuple(m.group() for m in AGAIN.finditer(quote)) if args['action'] == 'snooze' else ())
                        if not refs or not positive_instruction(quote, pattern, targets=refs):
                            raise ValueError('reminder_target_not_authorized')
                        if args['action'] == 'snooze':
                            # A one-time reminder that just played is fulfilled but may still be snoozed.
                            active += [i for i in store.list(('fulfilled',))
                                       if store.clock() - i['updated_at'] <= SNOOZE_DELIVERED]
                        if len(active) > 1 and not any(RECENT.search(r) for r in refs):
                            raise ValueError('reminder_target_ambiguous')
                        newest = max(active, key=lambda i: i['created_at'], default=None)
                        if item is None or newest is None or item['id'] != newest['id']:
                            raise ValueError('reminder_target_not_authorized')
                    key = hashlib.sha256(repr([self.run_id, name, quote, item['id'], args['action']]).encode()).hexdigest()
                    if args['action'] in ('cancel', 'complete') and 'due_at' in args:
                        raise ValueError('unexpected_reminder_time')
                    if args['action'] == 'cancel':
                        item = store.cancel(item['id'], expected_revision=args['expected_revision'], request_key=key)
                        action = 'cancelled'
                    elif args['action'] == 'complete':
                        item = store.complete(item['id'], expected_revision=args['expected_revision'], request_key=key)
                        action = 'completed'
                    else:
                        if not TIME.search(quote):
                            raise ValueError('reminder_time_instruction_required')
                        due = self._time(args.get('due_at'), store.clock())
                        item = store.snooze(item['id'], due, expected_revision=args['expected_revision'], request_key=key)
                        action = 'snoozed'
                receipt_revision = item['revision']
                latest = store._get(item['id'])
                if latest is None:
                    raise ValueError('reminder_deleted')
                if latest['revision'] == receipt_revision:
                    self.controller.server.feed.publish('commitment', {'action': action, 'commitment': latest})
            return {'reminder': self._public(latest), 'write_receipt_revision': receipt_revision,
                    'authority': 'current_user_instruction', 'saved': True}
        except (ValueError, OverflowError, OSError) as exc:
            return {'error': {'code': str(exc)}}
