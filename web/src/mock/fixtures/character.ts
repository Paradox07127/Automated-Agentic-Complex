import type { CharacterProfile, CharacterState, StatePoint } from '../../domain';
import { fromCharacterState, fromStatePoint } from '../../domain/adapt';
import type { WireStatePoint } from '../../domain/wire';
import type { ModSettingsTable } from '../../pages/character/modSettingsTable';
import { at, HOUR, MINUTE, NOW, SECOND } from './clock';
import { WIRE_CHARACTER_STATE } from './wire/system';

export const CHARACTERS: CharacterProfile[] = [
  { id: 'si', name: '示例乙', en: 'SI', active: true },
  { id: 'voice_a', name: '示例甲', en: 'VOICE_A', active: false },
  { id: 'cedar', name: '示例丙', en: 'CEDAR QIANYU', active: false },
];

/** Characters whose package has no voice profile (示例甲). */
export const NO_VOICE: ReadonlySet<string> = new Set(['voice_a']);

/** Range rule for valence: baseline ± 0.6, may go negative (character_state.py:11,23,266-270). */
export const VALENCE_SPAN = 0.6;

/** Mood baseline of her card; agentd does not send it yet, so only demos and the history chart use it. */
const BASELINE = 0.2;

/** `/character/state`. baseline, walk_scale and comment_scale are not sent; the demo adds them. */
export const CHARACTER_STATE: CharacterState = { ...fromCharacterState(WIRE_CHARACTER_STATE), baseline: BASELINE, walk_scale: 2, comment_scale: 1.5 };

const ENERGY = WIRE_CHARACTER_STATE.energy ?? 0;
const VALENCE = WIRE_CHARACTER_STATE.valence ?? 0;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;
const valence = (v: number) => round2(clamp(v, BASELINE - VALENCE_SPAN, BASELINE + VALENCE_SPAN));
const point = (t: number, energy: number, v: number, cause: string | null = null): WireStatePoint => ({ at: t / SECOND, energy, valence: v, cause });

/** 24 h at 30-minute steps, ending at NOW with the current values. */
function day(): WireStatePoint[] {
  return Array.from({ length: 49 }, (_, i) => {
    const t = NOW - (48 - i) * 30 * MINUTE;
    if (i === 48) return point(t, ENERGY, VALENCE, 'user_spoke');
    const d = new Date(t);
    const h = d.getHours() + d.getMinutes() / 60;
    const awake = h >= 8 && t > NOW - 20 * HOUR;
    const energy = awake ? clamp(0.86 - (h - 8) * 0.085 + (h > 12.6 && h < 13.4 ? 0.05 : 0), 0.31, 0.9) : 0.9;
    const dip = t >= at(10, 15) && t < at(11, 2) ? 0.26 : t >= at(11, 2) ? 0.2 + (t > at(13, 40) ? 0.1 : 0) : 0;
    return point(t, round2(energy), valence(0.2 + 0.12 * Math.sin(i / 5) - dip), t === at(10, 30) ? 'task_failed' : null);
  });
}

/** 7 days at 3-hour steps, ending at NOW. */
function week(): WireStatePoint[] {
  return Array.from({ length: 57 }, (_, i) => {
    const t = NOW - (56 - i) * 3 * HOUR;
    if (i === 56) return point(t, ENERGY, VALENCE, 'user_spoke');
    return point(t, round2(0.55 + 0.3 * Math.cos((i / 8) * Math.PI * 2)), valence(0.2 + 0.25 * Math.sin(i / 4.3) - (i % 17 === 5 ? 0.3 : 0)));
  });
}

/** `/character/state/history` items (character_state_log). */
export const STATE_LOG: { d24: StatePoint[]; d7: StatePoint[] } = { d24: day().map(fromStatePoint), d7: week().map(fromStatePoint) };

/** Appearances per character (`CharacterEntry.appearances`). */
export const CHARACTER_LOOKS: Record<string, Array<{ id: string; name: string; desc: string; kind?: 'original' | 'imported' }>> = {
  si: [
    { id: 'daily', name: '日常', desc: '默认外观 · 便装', kind: 'original' },
    { id: 'uniform', name: '制服', desc: '外勤制服 · 带武器挂件', kind: 'original' },
    { id: 'imported_summer', name: '夏装', desc: '导入的外观', kind: 'imported' },
    { id: 'imported_field', name: '野外装', desc: '导入的外观', kind: 'imported' },
  ],
  voice_a: [{ id: 'daily', name: '日常', desc: '默认外观', kind: 'original' }],
  cedar: [{ id: 'daily', name: '日常', desc: '默认外观', kind: 'original' }],
};

/** Switch tables per character and appearance (GET /characters/:id/mod-settings `appearances`); only 夏装 and 野外装 have one. */
export const MOD_SETTINGS: Record<string, ModSettingsTable['appearances']> = {
  si: {
    imported_summer: {
      settings: [
        { id: 'skirt', name: '裙长', category: 'clothing', default: 0, values: [{ value: 0, name: '长' }, { value: 1, name: '短' }] },
        { id: 'color', name: '配色', category: 'color', default: 0, values: [{ value: 0, name: '原色' }, { value: 1, name: '黑' }, { value: 2, name: '白' }] },
      ],
    },
    imported_field: {
      settings: [
        { id: 'glow', name: 'glow', default: 0, values: [{ value: 0, name: '选项 1' }, { value: 1, name: '选项 2' }] },
        { id: 'tint', name: 'Hair Color', category: 'color', default: 0, values: [{ value: 0, name: 'Black' }, { value: 1, name: 'Red' }, { value: 2, name: 'Silver' }] },
        { id: 'jacket', name: '外套', category: 'clothing', default: 0, values: [{ value: 0, name: '显示' }, { value: 1, name: '隐藏' }] },
        { id: 'bag', name: '背包', category: 'accessory', default: 1, values: [{ value: 0, name: '隐藏' }, { value: 1, name: '显示' }] },
        { id: 'ponytail', name: '马尾', category: 'hair', default: 0, values: [{ value: 0, name: '显示' }, { value: 1, name: '隐藏' }] },
        { id: 'gloves', name: '手套', category: 'clothing', default: 1, values: [{ value: 0, name: '显示' }, { value: 1, name: '隐藏' }] },
      ],
    },
  },
};

/** Outfit layers of the current character's appearance (`CharacterEntry.layers`); the fake bridge sets `visible`. */
export const CHARACTER_LAYERS: Array<{ id: string; name: string }> = [
  { id: 'coat', name: '外套' },
  { id: 'cape', name: '披风' },
];

/** The prepare rejection switching to 示例丙 hits (CharacterSwitch hands the reason to the UI). */
export const SWITCH_REJECT = { id: 'cedar', stage: 'avatar', reason: '加载资源失败：资源包缺少待机动作 idle_01' } as const;
