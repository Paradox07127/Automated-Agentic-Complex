import { useEffect, type ReactNode } from 'react';
import { Seg } from '../../../ui';
import { failure } from '../api';
import { useSettings } from '../ctx';
import { labelOf } from '../registry';
import { SetRow } from '../SetRow';
import type { ProactiveState } from './SpeakCompanion';

type When = 'never' | 'asked' | 'active';

/** What each choice writes: config.json `mute` / `speakUp` and agentd's companion_mode. */
const SPEAK_WHEN: Array<{ value: When; label: string; mute: boolean; speakUp: boolean; companion: boolean }> = [
  { value: 'never', label: '不开口', mute: true, speakUp: false, companion: false },
  { value: 'asked', label: '只在我问时', mute: false, speakUp: false, companion: false },
  { value: 'active', label: '主动', mute: false, speakUp: true, companion: true },
];

const TITLE = '她什么时候开口';

/** The rows SpeakGroup passes as `children`. */
const UNDER_ACTIVE = ['proactive', 'quiet_hours'];

/** The 主动程度 level agentd runs without proactive speech (interactions.py). */
export const SILENT_LEVEL = 'quiet';

const NAME: Record<string, string> = { mute: labelOf('mute'), speakUp: '主动发言', proactive: labelOf('proactive') };

/** One question over 静音, 主动发言, 主动提示 and a 主动程度 that keeps speech on; a mix that is none of the choices shows none chosen. `children` are the rows under 主动, rendered only while it is chosen. */
export function SpeakWhenRow({ ps, disabled, children }: { ps: ProactiveState; disabled: boolean; children?: ReactNode }) {
  const { model, hl, agentdOff, goRow } = useSettings();
  const silent = model.value('proactive') === SILENT_LEVEL;
  const raw = { mute: model.value('mute') === true, speakUp: model.value('speakUp') === true };
  const cur = { mute: raw.mute, speakUp: raw.speakUp && !silent, companion: ps.on };
  const chosen = SPEAK_WHEN.find((w) => w.mute === cur.mute && w.speakUp === cur.speakUp && w.companion === cur.companion);
  // Once agentd has answered (or cannot), a link to a row under 主动 that is not shown lands on this row.
  const childrenGone = chosen?.value !== 'active' && (ps.on !== null || agentdOff);
  useEffect(() => {
    if (hl && UNDER_ACTIVE.includes(hl) && childrenGone) goRow('speakWhen');
  }, [hl, childrenGone, goRow]);

  const pick = async (value: string) => {
    const w = SPEAK_WHEN.find((x) => x.value === value);
    if (!w) return;
    const changes: Record<string, boolean | string> = Object.fromEntries((['mute', 'speakUp'] as const).filter((id) => raw[id] !== w[id]).map((id) => [id, w[id]]));
    if (w.speakUp && silent) changes.proactive = 'balanced';
    const ids = Object.keys(changes);
    const names = ids.map((id) => NAME[id]).join('、');
    // The model's own toast names a failed config.json write; nothing already written is undone.
    const nativeOk = ids.length === 0 || (await model.save(changes, names));
    if (cur.companion !== w.companion) {
      try {
        await ps.saveCompanion(w.companion);
      } catch (e) {
        const before = nativeOk ? '' : `没有保存「${names}」；`;
        model.notify({ message: `${before}没能${w.companion ? '开启' : '关闭'}主动提示：${failure(e).text}`, severity: 'danger', persistent: true });
        return;
      }
    }
  };

  return (
    <>
      <SetRow
        id="speakWhen"
        title={TITLE}
        desc="主动：发现可以帮忙的时机时提示，也会说出想法。任务结果和你设置的提醒仍会送达。"
        disabled={disabled}
        disabledReason="后台不可写"
        control={
          <Seg
            label={TITLE}
            size="sm"
            value={chosen?.value ?? ''}
            options={SPEAK_WHEN.map((w) => ({ value: w.value, label: w.label, disabled, disabledReason: '后台不可写' }))}
            onChange={(v) => void pick(v)}
          />
        }
      />
      {chosen?.value === 'active' && children}
    </>
  );
}
