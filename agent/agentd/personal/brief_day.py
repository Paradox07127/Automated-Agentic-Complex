"""Local calendar-day statistics for the daily brief."""
from bisect import bisect_right
from collections import Counter
from datetime import date, datetime, time, timedelta
import hashlib
import json
import math
from pathlib import Path

import c1
from infra import plugins
from observation.attention import CHROMIUM, _union
from observation.blacklist import HIDDEN
from personal.history import HEARD
from voice.speech import SAMPLE_RATE


NEED = {'done': ('agent', 'code'), 'err': ('agent', 'code'), 'turn': (), 'line': (), 'fg': ('scr',),
        'say': (), 'motion': (), 'touch': (), 'voice': ('voice',), 'mem': (), 'cost': (),
        'code': ('code',), 'shot': ('shot',), 'mask': ('scr', 'shot'), 'rem': ()}
# proactive_log triggers of channel 'line': Proactive's reason kinds and dispatch_report's announcement and job states
TRIGGERS = {'comment': '主动搭话', 'back': '你回来了', 'break': '提醒你休息', 'water': '提醒你喝水',
            'stuck': '你卡住了，问要不要帮忙', 'dispatch_done': '派的任务做完了',
            'dispatch_review': '派的任务等你确认', 'dispatch_failed': '派的任务没做成',
            'succeeded': '后台的活做完了', 'needs_review': '后台的活等你确认', 'failed': '后台的活没做成'}


def _counts(counts, limit=None, labels={}):
    return [{'key': key, 'label': labels.get(key, key), 'count': count} for key, count in counts.most_common(limit)]


def _motion_names(server):
    """Action id and clip -> the action's name in the current character's actions.json; {} without a package."""
    try:
        root = server.characters.package(server.character).root
    except ValueError:
        return {}
    names = {}
    for path in sorted(Path(root).glob('runtime/characters/*/c7/animation/actions.json')):
        for action in json.loads(path.read_text(encoding='utf-8'))['actions']:
            if action.get('name'):
                for key in (action['id'], *(action.get('clips') or [])):
                    names.setdefault(key, action['name'])
    return names


def _focus(server, enabled, sites_allowed, since, start, end, add):
    focus = {'enabled': enabled, 'away_min': 0, 'longest': None, 'pauses': [], 'apps': [], 'sites': []}
    if not enabled:
        return focus
    pauses = ((max(a, start), min(b, end)) for a, b in server._pauses + server._meetings)
    focus['pauses'] = [list(span) for span in _union((a, b) for a, b in pauses if b > a)]
    attention = server.attention
    if attention is None:
        return focus
    active = []
    for a, b, status in attention.afk_runs(since, end):
        if status == 'not-afk' and b > max(a, start):
            active.append((max(start, a), b))
        elif status == 'afk':
            focus['away_min'] += max(0, b - max(a, start)) / 60
        while a < b:
            local = datetime.fromtimestamp(a)
            boundary = a + 3600 - local.minute * 60 - local.second - local.microsecond / 1e6
            stop = min(b, boundary)
            add('fg', a, (stop - a) / 60 if status == 'not-afk' else 0)
            a = stop
    active = _union(active)
    if not active:
        return focus
    a, b = max(active, key=lambda span: span[1] - span[0])
    focus['longest'] = {'start': a, 'minutes': (b - a) / 60}
    with attention.lock:
        browser_fields = ("json_extract(data,'$.bundle_id'),json_extract(data,'$.url_host'),json_extract(data,'$.incognito')"
                          if sites_allowed else "NULL,NULL,NULL")
        windows = attention.db.execute(
            f"SELECT start,duration,json_extract(data,'$.app'),{browser_fields} FROM events WHERE bucket='window'"
            " AND start<? AND start+duration>? ORDER BY start", (end, start)).fetchall()
        sites = attention._range('browser', start, end) if sites_allowed else []

    def overlaps(a, b, spans, ends):
        i = bisect_right(ends, a)
        while i < len(spans) and spans[i][0] < b:
            x, y = spans[i]
            yield max(a, x), min(b, y)
            i += 1

    apps, hosts = Counter(), Counter()
    ends = [b for _, b in active]
    browser_spans = []
    for a, duration, app, bundle, host, private in windows:
        if not app or app == HIDDEN['app'] or duration <= 0:
            continue
        for x, y in overlaps(a, a + duration, active, ends):
            apps[app] += y - x
            if private or not sites_allowed:
                continue
            # C12 only supplies a Chrome/Edge host after ruling out private browsing. Safari cannot do that.
            if host and bundle in ('com.google.Chrome', 'chrome.exe', 'msedge.exe'):
                if host != HIDDEN['app'] and not attention.blacklist.hides_domain(host):
                    hosts[host] += y - x
            elif bundle in CHROMIUM or bundle in ('chrome.exe', 'msedge.exe', 'brave.exe'):
                browser_spans.append((x, y))
    browser_spans = _union(browser_spans)
    browser_ends = [b for _, b in browser_spans]
    for a, b, data in sites:
        host = data.get('url_host')
        if host and host != HIDDEN['app'] and not data.get('incognito') and data.get('window_focused', True) \
                and data.get('visible', True) and not attention.blacklist.hides(data):
            for x, y in overlaps(a, b, browser_spans, browser_ends):
                if y > x:
                    hosts[host] += y - x
    focus['apps'] = [{'name': name, 'minutes': s / 60} for name, s in apps.most_common(6)]
    focus['sites'] = [{'host': host, 'minutes': s / 60} for host, s in hosts.most_common(6)]
    return focus


def _agent_tools(agent, enabled, since, start, stop, end, add):
    tools = {'enabled': enabled, 'by_name': [], 'files_changed': 0, 'run_minutes': 0, 'asked': 0}
    if not enabled or agent is None:
        return tools
    store = agent.store
    with store.lock:
        for began, ended, state in store.db.execute(
                'SELECT started_at,ended_at,state FROM character_runs WHERE started_at<? AND (ended_at>=? OR ended_at IS NULL)',
                (stop, since)):
            if ended is not None and ended < stop and state in ('completed', 'failed'):
                add('done' if state == 'completed' else 'err', ended)
            tools['run_minutes'] += max(0, min(ended if ended is not None else end, end) - max(began, start)) / 60
        names = Counter(dict(store.db.execute(
            "SELECT json_extract(metadata,'$.tool') AS tool,COUNT(*) FROM character_run_events"
            " WHERE kind='tool_started' AND at>=? AND at<? GROUP BY tool", (start, stop))))
        tools['by_name'] = _counts(names)
        tools['asked'] = store.db.execute(
            'SELECT COUNT(*) FROM character_interactions WHERE created_at>=? AND created_at<?', (start, stop)).fetchone()[0]
        writes = store.db.execute(
            "SELECT run_id,json_extract(metadata,'$.tool_call_id') FROM character_run_events"
            " WHERE kind='tool_finished' AND json_extract(metadata,'$.tool')='artifact_write' AND at>=? AND at<?",
            (start, stop)).fetchall()
    if writes and agent.workspace is not None:
        files = set()
        with agent.workspace.lock:
            for run_id, call_id in writes:
                # Workspace hashes the run id and the runtime's run-prefixed call id as its receipt key.
                effect = hashlib.sha256(f'{run_id}:{run_id}:{call_id}'.encode()).hexdigest()
                row = agent.workspace.db.execute(
                    "SELECT json_extract(receipt,'$.absolute_path') FROM effects WHERE id=? AND state='committed'",
                    (effect,)).fetchone()
                if row:
                    files.add(row[0])
        tools['files_changed'] = len(files)
    return tools


def _coding_sessions(server, rows, since, stop, add):
    first = {}

    def activity(source, ident, at):
        if at is not None and since <= at < stop:
            key = (source, ident, date.fromtimestamp(at))
            first[key] = min(first.get(key, at), at)

    terminals = set()
    own_ends = []
    for source, ident, began, updated, state in rows(
            'SELECT target,COALESCE(native_id,session_id),started_at,updated_at,state FROM own_sessions'
            ' WHERE updated_at>=? AND started_at<?', (since, stop)):
        activity(source, ident, began)
        activity(source, ident, updated)
        if since <= updated < stop and state in ('done', 'error'):
            own_ends.append((source, ident, updated, state))
    for source, ident, at in rows(
            'SELECT s.target,COALESCE(s.native_id,s.session_id),MIN(l.ts) FROM own_session_lines l'
            " JOIN own_sessions s USING(session_id) WHERE l.ts>=? AND l.ts<? GROUP BY l.session_id,date(l.ts,'unixepoch','localtime')",
            (since, stop)):
        activity(source, ident, at)
    paused = server.observation_paused()
    if not paused and plugins.on('screen_awareness') and server.attention is not None:
        with server.attention.lock:
            observed = server.attention.db.execute(
                "SELECT app,label,MIN(ts) FROM events_raw WHERE kind IN ('agent','prompt') AND label IS NOT NULL"
                " AND app IN ('claude','codex') AND ts>=? AND ts<? GROUP BY app,label,date(ts,'unixepoch','localtime')",
                (since, stop)).fetchall()
        for source, ident, at in observed:
            activity(source, ident, at)
        observations = server.character_agent.observations if server.character_agent else None
        if observations is not None:
            for at, epoch, requires, raw in rows(
                    "SELECT at,consent_epoch,requires,metadata FROM observation_frames WHERE character_id=? AND at>=? AND at<?"
                    " AND origin='input_event' AND json_extract(metadata,'$.kind')='live_hook'",
                    (server.character, since, stop)):
                meta = json.loads(raw)
                if observations._allowed_row({'character_id': server.character, 'consent_epoch': epoch,
                                              'requires': json.loads(requires), 'metadata': meta}):
                    activity(meta['app'], meta['label'], at)
    if not paused:
        with server.registry.cv:
            for session in server.registry.sessions.values():
                activity(session.source, session.session_id, session.started_at)
                activity(session.source, session.session_id, session.last_event)
            for outcome in server.registry.outcomes:
                at, source, ident, kind = outcome['ts'], outcome['source'], outcome['session_id'], outcome['kind']
                if kind in ('expired', 'replay_dropped') or not since <= at < stop:
                    continue
                activity(source, ident, at)
                if kind in ('done', 'subagent_done', 'error', 'tool_failure'):
                    # A tool failure that puts the session in error has two outcomes at the same instant.
                    state = 'err' if kind in ('error', 'tool_failure') else 'done'
                    terminals.add((source, ident, at, state, outcome.get('agent_id')))
    seen_ends = {(source, ident, date.fromtimestamp(at), state) for source, ident, at, state, _ in terminals}
    for _, _, at, state, _ in terminals:
        add(state, at)
    for source, ident, at, kind in own_ends:
        state = 'err' if kind == 'error' else 'done'
        if (source, ident, date.fromtimestamp(at), state) not in seen_ends:
            add(state, at)
    for at in first.values():
        add('code', at)


def _traces(rows, switches, spatial, since, start, stop, now, add):
    motions = Counter()
    seated, seat_spans = {}, []
    seats = give_way = 0
    kinds = ['motion.started', 'behavior.receipt']
    if switches['voice']:
        kinds.append('speech.finished')
    if switches['scr'] or switches['shot']:
        kinds.append('egress.checked')
    for kind, wall, raw in rows(
            f"SELECT kind,t_wall,json_extract(event,'$.attrs') FROM trace_events WHERE kind IN ({','.join('?' * len(kinds))})"
            " AND julianday(t_wall) BETWEEN julianday(?,'unixepoch') AND julianday(?,'unixepoch')"
            " AND (julianday(t_wall)<=julianday(?,'unixepoch') OR"
            "      (kind='behavior.receipt' AND json_extract(event,'$.attrs.behavior_type')='climb_window_top'))"
            " ORDER BY julianday(t_wall),id", (*kinds, since, now, stop)):
        at = datetime.fromisoformat(wall).timestamp()
        attrs = json.loads(raw)
        if kind == 'behavior.receipt' and attrs['behavior_type'] == 'climb_window_top':
            phase, ident = attrs['phase'], attrs['behavior_id']
            if phase == 'running' and at < stop and ident not in seated:
                seated[ident] = at
                seats += at >= start
            elif phase in c1.ENDED and ident in seated:
                a, b = max(start, seated.pop(ident)), min(stop, at)
                if b > a:
                    seat_spans.append((a, b))
        if not since <= at < stop:
            continue
        if kind == 'motion.started':
            add('motion', at)
            if at >= start:
                motions[attrs['clip']] += 1
        elif kind == 'speech.finished':
            add('voice', at, attrs['total_samples'] / SAMPLE_RATE)
        elif kind == 'egress.checked':
            add('mask', at, attrs['redactions'])
        elif attrs['phase'] == 'cancelled' and attrs['reason'] == 'give_way' and at >= start:
            give_way += 1
    if seated:
        for behavior in spatial.running():
            began = seated.get(behavior['behavior_id'])
            if began is not None:
                seat_spans.append((max(began, start), min(now, stop)))
    desk = {}
    if seats or seat_spans:
        desk['window_top'] = {'key': 'window_top', 'label': '坐窗顶', 'count': seats,
                              'minutes': sum(b - a for a, b in _union(seat_spans)) / 60}
    if give_way:
        desk['give_way'] = {'key': 'give_way', 'label': '给窗口让路', 'count': give_way, 'minutes': None}
    return motions, desk


def _desk_log(rows, running, since, start, stop, end, add):
    """character.desk_log's rows: her.touch, the edge and greet rows of her.desk, and on_desk_min."""
    touch, spans = dict.fromkeys(('pat', 'pinch', 'drag', 'wheel'), 0), {'visible': [], 'edge': []}
    greets = edges = 0
    for row, kind, at, until in rows('SELECT id,kind,at,until FROM desk_log WHERE at<? AND COALESCE(until,at)>=?'
                                     ' ORDER BY at,id', (stop, since)):
        if kind == 'greet':
            greets += at >= start
        elif kind in touch:
            add('touch', at)
            if at >= start:
                touch[kind] += 1
        else:
            a, b = max(at, start), min(end if row in running else until, end)
            if b > a:
                spans[kind].append((a, b))
            if kind == 'edge':
                edges += at >= start
    desk = {}
    if edges or spans['edge']:
        desk['edge'] = {'key': 'edge', 'label': '屏幕边缘陪你', 'count': edges,
                        'minutes': sum(b - a for a, b in _union(spans['edge'])) / 60}
    if greets:
        desk['greet'] = {'key': 'greet', 'label': '迎接', 'count': greets, 'minutes': None}
    on_desk = sum(b - a for a, b in _union(spans['visible'])) / 60 if spans['visible'] else None
    return touch, desk, on_desk


def brief_day(server, day: date, now: float):
    since, start, tomorrow = (datetime.combine(day + timedelta(days=n), time.min).timestamp() for n in (-7, 0, 1))
    end = min(now, tomorrow)
    # Include an event exactly at now, while keeping tomorrow's midnight exclusive.
    stop = min(math.nextafter(now, math.inf), tomorrow)
    consent, _ = server.consent.snapshot()
    switches = {'scr': plugins.on('screen_awareness'),
                'read': plugins.on('screen_reading') and (consent['window_text'] or consent['page_text']),
                'shot': consent['screenshots'], 'code': plugins.on('coding_sessions') and consent['agent_sessions'],
                'agent': plugins.on('personal_agent'),
                'voice': server.speech is not None and not server.muted and server.character_voice_enabled}
    items = {key: {'enabled': not need or any(switches[s] for s in need), 'today': 0,
                   'hours': None if key in ('mask', 'cost') else [0] * 24, 'avg7': None, 'yesterday': None}
             for key, need in NEED.items()}
    previous = {key: Counter() for key in items}

    def add(key, at, value=1):
        local = datetime.fromtimestamp(at)
        if at < start:
            previous[key][local.date()] += value
        else:
            item = items[key]
            item['today'] += value
            if item['hours'] is not None:
                item['hours'][local.hour] += value

    def rows(query, params):
        with server.memory.lock:
            return server.memory.db.execute(query, params).fetchall()

    lines, reasons, replied = {}, Counter(), 0
    for at, source, reply, resume in rows(
            f"SELECT ended_at,source,reply,resume_run_id FROM history_turns WHERE {HEARD} AND reply!=''"
            " AND source IN ('text','voice','gift','tap','ritual') AND ended_at>=? AND ended_at<? ORDER BY ended_at,id",
            (since, stop)):
        add('line', at)
        if source in ('text', 'voice') and resume is None:
            add('turn', at)
            if at >= start:
                lines['reply'] = {'at': at, 'kind': 'reply', 'text': reply, 'note': '回你的问题'}
    for at, reason, text, outcome in rows(
            "SELECT shown_at,trigger,text,outcome FROM proactive_log WHERE channel='line' AND shown_at>=? AND shown_at<?"
            " ORDER BY shown_at,rowid", (since, stop)):
        add('say', at)
        add('line', at)
        if at >= start:
            reasons[reason] += 1
            answered = outcome == 'replied'
            replied += answered
            kind = 'self' if answered else 'miss'
            lines[kind] = {'at': at, 'kind': kind, 'text': text, 'note': '你回了这句' if answered else '你没回'}

    for key, query in (
            ('mem', 'SELECT recorded_at FROM facts WHERE version=1 AND recorded_at>=? AND recorded_at<?'),
            ('rem', "SELECT due_at FROM commitments WHERE state!='cancelled' AND due_at>=? AND due_at<?"),
            ('shot', "SELECT settled_at FROM capture_budget WHERE state='sent' AND settled_at>=? AND settled_at<?")):
        if items[key]['enabled']:
            for at, in rows(query, (since, stop)):
                add(key, at)
    for stored_day, cost in rows('SELECT day,SUM(cost_usd) FROM model_usage WHERE day BETWEEN ? AND ? GROUP BY day',
                                 (date.fromtimestamp(since).isoformat(), day.isoformat())):
        add('cost', datetime.fromisoformat(stored_day).timestamp(), cost)
    if switches['agent']:
        for at, state in rows("SELECT at,kind FROM task_events WHERE kind IN ('succeeded','failed') AND at>=? AND at<?",
                              (since, stop)):
            add('done' if state == 'succeeded' else 'err', at)
    tools = _agent_tools(server.character_agent, switches['agent'], since, start, stop, end, add)
    if switches['code']:
        _coding_sessions(server, rows, since, stop, add)
    focus = _focus(server, switches['scr'], switches['read'] and consent['page_text'], since, start, end, add)
    motions, desk = _traces(rows, switches, server.spatial, since, start, stop, now, add)
    touch, logged, on_desk = _desk_log(rows, server.desk.running() if server.desk is not None else set(),
                                       since, start, stop, end, add)
    desk.update(logged)
    mood = rows('SELECT at,energy,valence FROM character_state_log WHERE character_id=? AND at>=? AND at<? ORDER BY at,id',
                (server.character, start, stop))
    for key, totals in previous.items():
        if totals:
            items[key]['avg7'] = sum(totals.values()) / 7
            items[key]['yesterday'] = totals.get(day - timedelta(days=1))
    her = {'said': {'total': items['line']['today'], 'self': items['say']['today'], 'replied': replied},
           'lines': [lines[k] for k in ('self', 'reply', 'miss') if k in lines], 'touch': touch,
           'why': _counts(reasons, labels=TRIGGERS), 'motions': _counts(motions, 6, _motion_names(server)),
           'desk': [desk[key] for key in ('window_top', 'edge', 'give_way', 'greet') if key in desk], 'tools': tools,
           'mood': [list(row) for row in mood], 'on_desk_min': on_desk}
    return {'date': day.isoformat(), 'partial': day == date.fromtimestamp(now), 'switches': switches,
            'items': items, 'focus': focus, 'her': her}
