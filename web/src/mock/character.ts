import type { AvatarAction } from '../bridge/protocol';
import { fromCharacterState, isoToMs, isoWithOffset, msToEpochSec, type CharacterState, type WireCharacterState, type WireStatePoint } from '../domain';
import type { MockRoute } from './types';
import { at, HOUR, NOW, STATE_LOG, WIRE_CHARACTER_STATE } from './fixtures';

// Character page endpoints in agentd's shapes (server.py:1407-1415, 4649-4662, 4102-4111).

/**
 * Causes for jumps in STATE_LOG that the fixture leaves unexplained: the 13:40 mood drop and the
 * 7-day dips. The backend keeps the newest 8, so the oldest 7-day dip has none.
 */
const EXTRA_CAUSES: WireCharacterState['causes'] = [
  { attr: 'valence', cause: 'dispatch_failed', delta: -0.1, at: isoWithOffset(at(13, 40)) },
  { attr: 'valence', cause: 'task_failed', delta: -0.12, at: isoWithOffset(NOW - (56 - 39) * 3 * HOUR) },
  { attr: 'valence', cause: 'task_failed', delta: -0.12, at: isoWithOffset(NOW - (56 - 22) * 3 * HOUR) },
];

export const CAUSE_LIMIT = 8;

/** `GET /character/state` with every log jump explained, newest 8 causes; `activity` is a real DOING key. */
export const WIRE_STATE_WITH_CAUSES: WireCharacterState = {
  ...WIRE_CHARACTER_STATE,
  activity: 'sit',
  causes: [...WIRE_CHARACTER_STATE.causes, ...EXTRA_CAUSES].sort((a, b) => isoToMs(b.at) - isoToMs(a.at)).slice(0, CAUSE_LIMIT),
};

/** What the page shows for it. */
export const STATE_WITH_CAUSES: CharacterState = fromCharacterState(WIRE_STATE_WITH_CAUSES);

/** After DELETE /character/state: energy back to her target, mood at the baseline, no causes, nothing logged. */
export const WIRE_STATE_FRESH: WireCharacterState = {
  ...WIRE_STATE_WITH_CAUSES,
  energy: 0.8,
  valence: 0.2,
  engagement: 0,
  activity: null,
  labels: { energy: 'lively', mood: 'steady', engagement: 'idle' },
  causes: [],
};

const toWire = (p: { at: number; energy: number; valence: number; cause: string | null }): WireStatePoint => ({ ...p, at: msToEpochSec(p.at) });
const LOG = { d24: STATE_LOG.d24.map(toWire), d7: STATE_LOG.d7.map(toWire) };

const act = (section: string, id: string, label: string, enabled: boolean, extra: Partial<AvatarAction> = {}): AvatarAction => ({ id, label, enabled, defaultEnabled: true, section, ...extra });

/** Motion metadata as the host sends it; looping motions have no duration, and move motions cannot be played alone. */
const meta = (trigger: string, durationS: number | null, extra: Partial<AvatarAction> = {}): Partial<AvatarAction> => ({
  trigger, durationS, isNew: false, missingReason: null, playable: true, ...extra,
});
const lacks = (reason: string): Partial<AvatarAction> => ({ missing: true, missingReason: reason, playable: false });

/** What the fake bridge's `avatar.actions()` answers, in the protocol's shape (the prototype's motion table). */
export const MOTIONS: AvatarAction[] = [
  act('talk', 'talk', '开口说话', true, { requiredReason: '说话时必须有口型动作', ...meta('说话时', 2.4) }),
  act('talk', 'nod', '点头附和', true, meta('批准之后', 1.2)),
  act('talk', 'whisper', '小声说', true, meta('会议模式下说话', 2.6, { isNew: true })),
  act('react', 'click', '被点击', true, meta('点击角色', 0.8)),
  act('react', 'drag', '被拖起', true, { requiredReason: '拖动时必须有被拖起的姿势', ...meta('拖动时', null) }),
  act('react', 'think', '思考', false, meta('等待模型回复', 3, lacks('缺少 think_02'))),
  act('idle', 'idle', '站立待机', true, { requiredReason: '无其他动作时必须有待机动作', ...meta('空闲', null) }),
  act('idle', 'stretch', '伸懒腰', true, meta('久坐提醒', 3.4)),
  act('idle', 'watch', '看手表', false, meta('待批准超 5 分钟', 1.6)),
  act('move', 'walk', '走动', true, meta('自由活动', null, { playable: false })),
  act('move', 'sit', '坐在窗口顶上', true, meta('窗口静止 30 秒', null, { playable: false })),
  act('move', 'lean', '扶着窗沿', false, meta('靠近窗沿', null, lacks('缺少 lean_02'))),
  act('touch', 'wave', '挥手', true, meta('用户返回时', 1.8)),
  act('touch', 'hand', '递东西', false, meta('任务交付', 2.2)),
];

const ok = (body: unknown) => ({ status: 200, body });
const hashDemo = (name: string) => new RegExp(`[?&]demo=${name}(&|$)`).test(globalThis.location?.hash ?? '');
/** `?demo=state-none`: agentd runs without a character state. */
const noState = () => hashDemo('state-none');
/** `?demo=sparse`: the log starts at 13:20. */
const SPARSE_FROM = msToEpochSec(at(13, 20));
const NO_STATE = { status: 503, body: { error: 'no_state' } };

export const routes: MockRoute[] = [
  { method: 'GET', path: '/character/state', handler: () => (noState() ? NO_STATE : ok(WIRE_STATE_WITH_CAUSES)) },
  {
    method: 'GET',
    path: '/character/state/history',
    handler: ({ query }) => {
      if (noState()) return NO_STATE;
      const since = Number(query.get('since') ?? '-Infinity');
      const limit = Number(query.get('limit') ?? '1000');
      if (Number.isNaN(since)) return { status: 400, body: { error: 'invalid_since' } };
      if (!(limit >= 1 && limit <= 5000)) return { status: 400, body: { error: 'invalid_limit' } };
      // The fixture keeps a fine day and a coarse week; a range longer than a day reads the week.
      const all = since < msToEpochSec(NOW) - 25 * 3600 ? LOG.d7 : LOG.d24;
      const rows = hashDemo('sparse') ? all.filter((p) => p.at >= SPARSE_FROM) : all;
      return ok({ items: rows.filter((p) => p.at >= since).slice(-limit) });
    },
  },
  {
    method: 'DELETE',
    path: '/character/state',
    handler: ({ body }) => {
      const id = body != null && typeof body === 'object' ? (body as { character_id?: unknown }).character_id : undefined;
      if (typeof id !== 'string' || !id) return { status: 400, body: { error: 'invalid_character_id' } };
      if (noState()) return NO_STATE;
      if (id !== WIRE_STATE_WITH_CAUSES.character_id) return { status: 409, body: { error: 'character_changed', character_id: WIRE_STATE_WITH_CAUSES.character_id } };
      return ok(WIRE_STATE_FRESH);
    },
  },
];
