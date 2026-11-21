"""One bounded, metadata-only projection of role work for UI and avatar intent.

Run completion describes the model loop, not task verification or user acceptance.
Semantic maintenance runs have no `running` event and never animate as user work.
"""
import json
import time

from sessions.registry import PRIORITY

ACTIVE = ('running', 'waiting_user', 'awaiting_approval')
PHASES = {'tool_started': 'running_tool', 'verifying': 'thinking',
          'verification_failed': 'error', 'needs_review': 'awaiting_input',
          'waiting_user': 'awaiting_input'}
OUTCOMES = {'answered': ('done', 'acknowledge'), 'succeeded': ('done', 'celebrate'),
            'needs_review': ('awaiting_input', 'uncertain'), 'failed': ('error', 'apologize'),
            'background_pending': ('thinking', 'think')}


def project(store, character_id, now=None):
    """No prompts, answer text, checkpoints, paths or tool arguments leave this query."""
    now = time.time() if now is None else now
    with store.lock:
        if store._closed:
            return None
        rows = [dict(row) for row in store.db.execute("""
            SELECT r.run_id,r.conversation_id,r.generation,r.state,r.started_at,r.ended_at,
              (SELECT metadata FROM character_run_events e WHERE e.run_id=r.run_id AND e.kind='running'
               ORDER BY seq DESC LIMIT 1) AS started,
              (SELECT kind FROM character_run_events e WHERE e.run_id=r.run_id ORDER BY seq DESC LIMIT 1) AS phase,
              (SELECT metadata FROM character_run_events e WHERE e.run_id=r.run_id ORDER BY seq DESC LIMIT 1) AS metadata
            FROM character_runs r WHERE character_id=? AND
              (state IN ('running','waiting_user','awaiting_approval') OR ended_at>?)
              AND EXISTS(SELECT 1 FROM character_run_events e WHERE e.run_id=r.run_id AND e.kind='running')
            ORDER BY started_at DESC LIMIT 32
        """, (character_id, now - 8)).fetchall()]
        for row in rows:
            row['open_tool'] = None
            if row['state'] == 'running':
                open_tool = store.db.execute("""
                    SELECT s.metadata FROM character_run_events s WHERE s.run_id=? AND s.kind='tool_started'
                    AND json_extract(s.metadata,'$.tool_call_id') IS NOT NULL AND NOT EXISTS(
                      SELECT 1 FROM character_run_events f WHERE f.run_id=s.run_id AND f.seq>s.seq
                      AND f.kind='tool_finished' AND json_extract(f.metadata,'$.tool_call_id')=
                          json_extract(s.metadata,'$.tool_call_id')) ORDER BY s.seq DESC LIMIT 1
                """, (row['run_id'],)).fetchone()
                if open_tool:
                    row['open_tool'] = json.loads(open_tool['metadata']).get('tool')
        pending = []
        if store.db.execute("SELECT 1 FROM sqlite_master WHERE name='character_interactions'").fetchone():
            pending = store.db.execute("""
                SELECT i.run_id,i.kind,i.state,i.created_at,i.expires_at,r.conversation_id,r.generation
                FROM character_interactions i JOIN character_runs r ON r.run_id=i.run_id
                WHERE r.character_id=? AND (i.state='pending' OR (i.kind='question' AND i.state='answered'))
                  AND (i.expires_at>? OR (i.kind='question' AND i.expires_at=0))
                  AND r.state NOT IN ('cancelled','interrupted')
                ORDER BY i.created_at DESC LIMIT 32
            """, (character_id, now)).fetchall()
    candidates = []
    for row in rows:
        if row['state'] in ('cancelled', 'interrupted'):
            continue
        meta = json.loads(row['metadata'] or '{}')
        phase = row['phase'] or 'running'
        if row['open_tool'] and phase not in ('verifying', 'verified', 'needs_review', 'verification_failed'):
            phase = 'tool_started'
            meta['tool'] = row['open_tool']
        state = PHASES.get(phase, 'thinking')
        intent = outcome = None
        expires = None
        if row['state'] == 'waiting_user':
            # The interaction row below is the authority; an expired question is not live work.
            continue
        if row['state'] not in ACTIVE:
            expires = row['ended_at'] + 8
            if row['state'] == 'failed':
                state, intent, outcome = 'error', 'apologize', 'failed'
            else:
                outcome = meta.get('outcome')
                if outcome not in OUTCOMES or outcome == 'background_pending':
                    continue
                state, intent = OUTCOMES[outcome]
        started = json.loads(row['started'] or '{}')
        if started.get('work_kind') == 'background' and state in ('thinking', 'running_tool'):
            state = 'background'
        candidates.append(_focus(row, state, phase, expires, intent=intent, outcome=outcome,
                                 tool=meta.get('tool') if phase == 'tool_started' else None,
                                 backend=started.get('backend')))
    for row in pending:
        state = 'awaiting_approval' if row['kind'] == 'approval' else 'awaiting_input'
        backend = next((r['backend'] for r in candidates if r['run_id'] == row['run_id']), None)
        candidates.append(_focus(row, state, 'awaiting_approval' if row['kind'] == 'approval' else
                                 ('resume_required' if row['state'] == 'answered' else 'waiting_user'),
                                 row['expires_at'] or None, backend=backend))
    if not candidates:
        return None
    # Questions/approvals remain actionable while another run works. Stable IDs break ties.
    chosen = min(candidates, key=lambda r: (_rank(r['state']), -r['since'], r['run_id']))
    chosen['additional_runs'] = len({r['run_id'] for r in candidates}) - 1
    chosen['background_runs'] = sum(r['state'] == 'background' for r in candidates)
    chosen['background'] = [{'run_id': r['run_id'], 'generation': r['run_generation']}
                            for r in candidates if r['state'] == 'background']
    return chosen


def _rank(state):
    if state in ('awaiting_approval', 'awaiting_input'):
        return 0 if state == 'awaiting_approval' else 1
    if state == 'error':
        return 3
    if state in ('thinking', 'running_tool'):
        return 2
    if state == 'background':
        return 5
    return 4


def _focus(row, state, phase, expires, *, intent=None, outcome=None, tool=None, backend=None):
    return {'display_session': 'role:' + row['run_id'], 'state': state, 'priority': PRIORITY[state],
            'tool_name': tool, 'tool_category': None, 'expires_at': expires,
            'run_id': row['run_id'], 'conversation_id': row['conversation_id'],
            'run_generation': row['generation'], 'phase': phase, 'outcome': outcome,
            'intent_override': intent, 'backend': backend,
            'since': row['started_at'] if 'started_at' in row.keys() else row['created_at']}
