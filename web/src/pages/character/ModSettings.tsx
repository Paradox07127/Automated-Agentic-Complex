// 角色页「模组设置」: the current appearance's switches from agentd's table (C6), each change sent through avatar.modSettings.set.
import { useEffect, useState } from 'react';
import { getBridge, type ModSettingAdjusted, type ModSettingValues } from '../../bridge';
import { Btn, Icon, Select, Toggle } from '../../ui';
import type { Toast } from './feedback';
import type { ModSettingRow } from './modSettingsTable';
import dark from './Rows.module.css';
import styles from './ModSettings.module.css';

export interface ModSettingsProps {
  character: string;
  appearance: string;
  /** The appearance's switches from the table. */
  settings: ModSettingRow[];
  disabled: boolean;
  toast: Toast;
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

/** More values than this: the value between the arrows opens a menu of them all. */
const MENU_OVER = 6;

/** One row per switch under its category's header row; a failed set goes back to the old values. */
export function ModSettings({ character, appearance, settings, disabled, toast }: ModSettingsProps) {
  const [stored, setStored] = useState<{ character: string; values: Record<string, ModSettingValues> }>();
  const [marks, setMarks] = useState<{ appearance: string; notes: Record<string, string>; error: string | null }>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    // Without the op (an older shell) every switch shows its default.
    void getBridge()
      .avatar.modSettings.get({ character })
      .then(
        (res) => res.appearances,
        () => ({}),
      )
      .then((values) => live && setStored({ character, values }));
    return () => {
      live = false;
    };
  }, [character]);

  if (stored?.character !== character || settings.length === 0) return null;
  const value = (s: ModSettingRow) => stored.values[appearance]?.[s.id] ?? s.default;
  const mark = marks?.appearance === appearance ? marks : undefined;
  const off = disabled || busy;
  const put = (values: ModSettingValues) => setStored((x) => (x && x.character === character ? { ...x, values: { ...x.values, [appearance]: values } } : x));

  /** Sends the whole set with `change` applied; `fail` words the error after the reason. */
  const send = (change: Record<string, number>, done: string, fail: (reason: string) => string) => {
    const before = stored.values[appearance] ?? {};
    const next = Object.fromEntries(settings.map((x) => [x.id, change[x.id] ?? value(x)]));
    put(next);
    setMarks({ appearance, notes: {}, error: null });
    setBusy(true);
    getBridge()
      .avatar.modSettings.set({ character, appearance, values: next })
      .then(
        (res) => {
          put(res.values);
          setMarks({ appearance, notes: Object.fromEntries(res.adjusted.map((a) => [a.id, ADJUSTED[a.reason]])), error: null });
          if (res.adjusted.length === 0) toast(done);
        },
        (e: unknown) => {
          put(before);
          setMarks({ appearance, notes: {}, error: fail(why(e)) });
        },
      )
      .finally(() => setBusy(false));
  };
  const pick = (s: ModSettingRow, v: number) => {
    const prev = value(s);
    send({ [s.id]: v }, `「${s.name}」已改成「${nameOf(s, v)}」`, (w) => `「${s.name}」没有改成：${w}，已改回「${nameOf(s, prev)}」`);
  };
  const reset = (title: string, rows: ModSettingRow[]) =>
    send(Object.fromEntries(rows.map((s) => [s.id, s.default])), `「${title}」已恢复默认`, (w) => `「${title}」没有恢复默认：${w}`);

  const control = (s: ModSettingRow) => {
    const two = shownValue(s);
    if (two) return <Toggle size="sm" label={s.name} on={value(s) === two.on} disabled={off} onChange={(on) => pick(s, on ? two.on : two.off)} />;
    const i = s.values.findIndex((x) => x.value === value(s));
    const step = (by: -1 | 1) => {
      const x = s.values[i + by];
      if (x) pick(s, x.value);
    };
    return (
      <span className={styles.step} role="group" aria-label={s.name}>
        <button type="button" className={styles.arrow} aria-label={`${s.name}：上一个`} disabled={off || i <= 0} onClick={() => step(-1)}>
          <Icon name="chevl" size={14} />
        </button>
        {s.values.length > MENU_OVER ? (
          <Select
              width={150}
              label={s.name}
              options={s.values.map((x) => ({ value: String(x.value), label: x.name }))}
              value={String(value(s))}
              defaultValue={String(s.default)}
              disabled={off}
              onChange={(v) => pick(s, Number(v))}
            />
        ) : (
          <span className={styles.val} data-mod-value="">
            {nameOf(s, value(s))}
          </span>
        )}
        <button type="button" className={styles.arrow} aria-label={`${s.name}：下一个`} disabled={off || i >= s.values.length - 1} onClick={() => step(1)}>
          <Icon name="chev" size={14} />
        </button>
      </span>
    );
  };

  return (
    <div className={styles.mods} role="group" aria-label="mod 设置">
      {GROUPS.map(([category, title]) => {
        const rows = settings.filter((s) => groupOf(s) === category);
        const changed = rows.some((s) => value(s) !== s.default);
        return (
          rows.length > 0 && (
            <div key={category} className={dark.list} role="group" aria-label={title} data-mod-group={category}>
              <div className={dark.head}>
                <span>{title}</span>
                <span className={dark.end}>
                  <Btn size="sm" variant="text" disabled={off || !changed} disabledReason={changed ? '' : '已是默认'} onClick={() => reset(title, rows)}>
                    恢复默认
                  </Btn>
                </span>
              </div>
              {rows.map((s) => {
                const note = mark?.notes[s.id];
                const moved = value(s) !== s.default;
                return (
                  <div key={s.id} className={dark.row} data-mod-setting={s.id} data-changed={moved || undefined}>
                    <span className={dark.lead}>{moved && <i className={dark.chg} title="已改" aria-label="已改" />}</span>
                    <span className={dark.main}>
                      <span className={dark.nm}>{s.name}</span>
                      <span className={dark.end}>{control(s)}</span>
                      {note && <span className={dark.note}>{note}</span>}
                    </span>
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
