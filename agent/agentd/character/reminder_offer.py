"""Reminder proposals whose deterministic parse preserves the intended time and work."""
import time

from personal.commitments import parse_reminder

# (chip label, reply it sends) for (tomorrow, daily) by reply language code; "harness" (None) takes the Chinese ones.
# parse_reminder reads only the Chinese reply; the others go to the character, who sets the reminder with its tool.
TEXTS = {'zh-Hans': (('明天 9 点提醒我', '提醒我明天9点接着做{title}：{step}'), ('每天 9 点提醒我', '提醒我每天9点{title}')),
         'en': (('Remind me tomorrow at 9', 'Remind me tomorrow at 9:00 to continue "{title}": {step}'),
                ('Remind me daily at 9', 'Remind me every day at 9:00: {title}')),
         'ja': (('明日 9 時にリマインド', '明日 9 時に「{title}」の続きをリマインドして：{step}'),
                ('毎日 9 時にリマインド', '毎日 9 時にリマインドして：{title}'))}


def offer(title, next_step, now, repeat=None, language=None):
    """(label, reply) in language, or None unless the Chinese reply parses back to the same time and work."""
    local = time.localtime(now)

    def nine(days):
        return time.mktime((local.tm_year, local.tm_mon, local.tm_mday + days, 9, 0, 0, 0, 0, -1))

    if repeat is None:
        what, due = f'接着做{title}：{next_step}', nine(1)
    elif repeat == 'daily':
        what = title
        due = nine(0) if nine(0) > now else nine(1)
    else:
        return None
    daily = repeat == 'daily'
    if parse_reminder(TEXTS['zh-Hans'][daily][1].format(title=title, step=next_step), now) != (due, what, repeat):
        return None
    label, reply = TEXTS.get(language, TEXTS['zh-Hans'])[daily]
    return label, reply.format(title=title, step=next_step)
