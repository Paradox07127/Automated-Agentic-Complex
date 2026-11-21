import { Seg } from '../../../ui';
import { failure } from '../api';
import { useSettings } from '../ctx';
import { labelOf } from '../registry';
import { SetRow } from '../SetRow';
import type { ProactiveState } from './SpeakCompanion';

type When = 'never' | 'asked' | 'active';

/** What each choice writes: config.json `mute` / `speakUp` and agentd's companion_mode (主动提示). */
const SPEAK_WHEN: Array<{ value: When; label: string; mute: boolean; speakUp: boolean; companion: boolean }> = [
  { value: 'never', label: '不开口', mute: true, speakUp: false, companion: false },
  { value: 'asked', label: '只在我问时', mute: false, speakUp: false, companion: false },
  { value: 'active', label: '主动', mute: false, speakUp: true, companion: true },
];

const TITLE = '她什么时候开口';

/** One question over 静音, 主动发言 and 主动提示; a mix that is none of the choices shows none chosen. */
export function SpeakWhenRow({ ps, disabled }: { ps: ProactiveState; disabled: boolean }) {
  const { model } = useSettings();
  const cur = { mute: model.value('mute') === true, speakUp: model.value('speakUp') === true, companion: ps.on };
  const chosen = SPEAK_WHEN.find((w) => w.mute === cur.mute && w.speakUp === cur.speakUp && w.companion === cur.companion);

  const pick = async (value: string) => {
    const w = SPEAK_WHEN.find((x) => x.value === value);
    if (!w) return;
    const changes = Object.fromEntries((['mute', 'speakUp'] as const).filter((id) => cur[id] !== w[id]).map((id) => [id, w[id]]));
    const ids = Object.keys(changes);
    // The model's own toast names a failed config.json write; nothing already written is undone.
    const nativeOk = ids.length === 0 || (await model.save(changes, ids.map(labelOf).join('、')));
    if (cur.companion !== w.companion) {
      try {
        await ps.saveCompanion(w.companion);
      } catch (e) {
        const before = nativeOk ? '' : `没有保存「${ids.map(labelOf).join('、')}」；`;
        model.notify({ message: `${before}没能${w.companion ? '开启' : '关闭'}主动提示：${failure(e).text}`, severity: 'danger', persistent: true });
        return;
      }
    }
  };

  return (
    <SetRow
      id="speakWhen"
      title={TITLE}
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
  );
}
