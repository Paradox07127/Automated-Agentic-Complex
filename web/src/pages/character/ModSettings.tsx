// 角色页「mod 设置」: the current appearance's switches from agentd's table (C6), each pick sent through avatar.modSettings.set.
import { useEffect, useState } from 'react';
import { getBridge, type ModSettingAdjusted, type ModSettingValues } from '../../bridge';
import { Select, Toggle } from '../../ui';
import type { Toast } from './feedback';
import { readModSettings, type ModSettingRow, type ModSettingsTable } from './modSettingsTable';
import styles from './ModSettings.module.css';

export interface ModSettingsProps {
  character: string;
  appearance: string;
  disabled: boolean;
  toast: Toast;
}

interface Read {
  character: string;
  table: ModSettingsTable['appearances'];
  stored: Record<string, ModSettingValues>;
}

const ADJUSTED: Record<ModSettingAdjusted['reason'], string> = {
  defaulted: '角色包里没有这个值，按默认值画',
  unsupported: '角色不认识这个开关',
};

const why = (e: unknown) => {
  const code = (e as { code?: string } | null)?.code;
  return code === 'failed' ? '角色没有接受' : code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应';
};

const nameOf = (s: ModSettingRow, v: number) => s.values.find((x) => x.value === v)?.name ?? String(v);

/** Groups in drawing order; a switch without a category, or with one this page does not know, is 其他. */
const GROUPS: ReadonlyArray<[NonNullable<ModSettingRow['category']>, string]> = [
  ['clothing', '衣服'],
  ['accessory', '道具'],
  ['hair', '发型'],
  ['color', '颜色'],
  ['other', '其他'],
];
const groupOf = (s: ModSettingRow) => (GROUPS.some(([c]) => c === s.category) ? s.category : 'other');

/** The importer names the two values of a part that can be hidden 显示 and 隐藏. */
const shownValue = (s: ModSettingRow) => {
  const on = s.values.find((x) => x.name === '显示');
  const off = s.values.find((x) => x.name === '隐藏');
  return s.values.length === 2 && on && off ? { on: on.value, off: off.value } : null;
};

/** One row per switch under its category, nothing when the appearance has no table; a failed set goes back to the old value. */
export function ModSettings({ character, appearance, disabled, toast }: ModSettingsProps) {
  const [read, setRead] = useState<Read>();
  const [marks, setMarks] = useState<{ appearance: string; notes: Record<string, string>; error: string | null }>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    // Without the op (an older shell) every switch shows its default.
    const stored = getBridge().avatar.modSettings.get({ character }).then((r) => r.appearances, () => ({}));
    void Promise.all([readModSettings(character), stored]).then(
      ([t, s]) => live && setRead({ character, table: t.appearances, stored: s }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [character]);

  const settings = read?.character === character ? read.table[appearance]?.settings : undefined;
  if (!read || !settings || settings.length === 0) return null;
  const value = (s: ModSettingRow) => read.stored[appearance]?.[s.id] ?? s.default;
  const mark = marks?.appearance === appearance ? marks : undefined;
  const put = (values: ModSettingValues) =>
    setRead((r) => (r && r.character === character ? { ...r, stored: { ...r.stored, [appearance]: values } } : r));

  const pick = (s: ModSettingRow, v: number) => {
    const before = read.stored[appearance] ?? {};
    const prev = value(s);
    const next = Object.fromEntries(settings.map((x) => [x.id, x.id === s.id ? v : value(x)]));
    put(next);
    setMarks({ appearance, notes: {}, error: null });
    setBusy(true);
    getBridge()
      .avatar.modSettings.set({ character, appearance, values: next })
      .then(
        (r) => {
          put(r.values);
          setMarks({ appearance, notes: Object.fromEntries(r.adjusted.map((a) => [a.id, ADJUSTED[a.reason]])), error: null });
          if (r.adjusted.length === 0) toast(`「${s.name}」已改成「${nameOf(s, v)}」`);
        },
        (e: unknown) => {
          put(before);
          setMarks({ appearance, notes: {}, error: `「${s.name}」没有改成：${why(e)}，已改回「${nameOf(s, prev)}」` });
        },
      )
      .finally(() => setBusy(false));
  };

  const control = (s: ModSettingRow) => {
    const two = shownValue(s);
    if (two) return <Toggle size="sm" label={s.name} on={value(s) === two.on} disabled={disabled || busy} onChange={(on) => pick(s, on ? two.on : two.off)} />;
    return (
      <Select
        width={150}
        label={s.name}
        options={s.values.map((x) => ({ value: String(x.value), label: x.name }))}
        value={String(value(s))}
        defaultValue={String(s.default)}
        disabled={disabled || busy}
        onChange={(v) => pick(s, Number(v))}
      />
    );
  };

  return (
    <div className={styles.mods} role="group" aria-label="mod 设置">
      <span className={styles.head}>mod 设置</span>
      {GROUPS.map(([category, title]) => {
        const rows = settings.filter((s) => groupOf(s) === category);
        return (
          rows.length > 0 && (
            <div key={category} className={styles.group} role="group" aria-label={title} data-mod-group={category}>
              <span className={styles.head}>{title}</span>
              {rows.map((s) => {
                const note = mark?.notes[s.id];
                return (
                  <div key={s.id} className={styles.row}>
                    <span className={styles.k}>{s.name}</span>
                    {control(s)}
                    {note && <span className={styles.note}>{note}</span>}
                  </div>
                );
              })}
            </div>
          )
        );
      })}
      {mark?.error && (
        <p className={styles.err} role="alert">
          {mark.error}
        </p>
      )}
    </div>
  );
}
