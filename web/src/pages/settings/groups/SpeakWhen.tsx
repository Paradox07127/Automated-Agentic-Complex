import { useEffect, type ReactNode } from 'react';
import { failure } from '../api';
import { useSettings } from '../ctx';
import { GameSeg } from '../../../ui/game';
import { labelOf } from '../registry';
import { SetRow } from '../SetRow';
import type { ProactiveState } from './SpeakCompanion';

type When = 'asked' | 'active';

/** What each choice writes: config.json `speakUp` and agentd's companion_mode. Staying silent altogether is 出声 off plus 只在我问时. */
const SPEAK_WHEN: Array<{ value: When; label: string; speakUp: boolean; companion: boolean }> = [
  { value: 'asked', label: '只在我问时', speakUp: false, companion: false },
  { value: 'active', label: '主动', speakUp: true, companion: true },
];

const TITLE = labelOf('speakWhen');

/** The 主动程度 level agentd runs without proactive speech (interactions.py). */
export const SILENT_LEVEL = 'quiet';

const NAME: Record<string, string> = { speakUp: '主动发言', proactive: labelOf('proactive') };

/**
 * One question over 主动发言, 主动提示 and a 主动程度 that keeps speech on; a mix that is neither choice shows none chosen.
 * `children` are the rows under 主动, rendered while it is chosen; `asked` stands in for them under 只在我问时.
 */
export function SpeakWhenRow({ ps, disabled, children, asked }: { ps: ProactiveState; disabled: boolean; children?: ReactNode; asked?: ReactNode }) {
  const { model, hl, agentdOff, goRow } = useSettings();
  const silent = model.value('proactive') === SILENT_LEVEL;
  const raw = model.value('speakUp') === true;
  const cur = { speakUp: raw && !silent, companion: ps.on };
  const chosen = SPEAK_WHEN.find((w) => w.speakUp === cur.speakUp && w.companion === cur.companion);
  // Once agentd has answered (or cannot), a link to 免打扰时段 while it is not shown lands on this row.
  const childrenGone = chosen?.value !== 'active' && (ps.on !== null || agentdOff);
  useEffect(() => {
    if (hl === 'quiet_hours' && childrenGone) goRow('speakWhen');
  }, [hl, childrenGone, goRow]);

  const pick = async (value: string) => {
    const w = SPEAK_WHEN.find((x) => x.value === value);
    if (!w) return;
    const changes: Record<string, boolean | string> = raw === w.speakUp ? {} : { speakUp: w.speakUp };
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
      }
    }
  };

  return (
    <>
      <SetRow
        id="speakWhen"
        title={TITLE}
        desc={chosen?.value === 'active' ? '看到能帮忙的时机会提一句，也会说出想法' : '只回答你；任务结果和你设的提醒照常送达'}
        info="主动：看到能帮忙的时机时提示，也会说出想法；要「看到 › 屏幕感知」打开才有时机可判断。完全不出声：再把上面的「出声」改成只显示文字。"
        disabled={disabled}
        disabledReason="后台不可写"
        control={<GameSeg variant="setting" label={TITLE} value={chosen?.value ?? ''} options={SPEAK_WHEN} disabled={disabled} onChange={(v) => void pick(v)} />}
      />
      {chosen?.value === 'active' ? children : asked}
    </>
  );
}
