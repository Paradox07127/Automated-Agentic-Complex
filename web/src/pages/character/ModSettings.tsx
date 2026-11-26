// 角色页「模组设置」: the current appearance's switches from agentd's table (C6), each change sent through avatar.modSettings.set.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { getBridge, type ModSettingAdjusted, type ModSettingValues } from '../../bridge';
import { ErrBar, Icon, SRow, Switch } from '../../ui';
import { Diamond, Stepper, TitleBar, WhiteCapsule } from '../../ui/game';
import { useCompact } from './compact';
import type { Toast } from './feedback';
import type { ModSettingRow } from './modSettingsTable';
import { previewLookChanged } from './usePreview';
import head from './ModCard.module.css';
import rowStyles from './SettingRows.module.css';
import styles from './ModSettings.module.css';

export interface ModSettingsProps {
  character: string;
  appearance: { id: string; name: string };
  /** The appearance's switches from the table. */
  settings: ModSettingRow[];
  /** Why it is read only (角色未运行, 切换中); null when it is not. */
  ro: string | null;
  toast: Toast;
}

const ADJUSTED: Record<ModSettingAdjusted['reason'], string> = {
  defaulted: '当前角色包未包含该配置值，已按默认值渲染',
  unsupported: '当前角色模型不支持该开关',
};

const why = (e: unknown) => {
  const code = (e as { code?: string } | null)?.code;
  return code === 'failed' ? '角色渲染进程拒绝了该设置' : code === 'not_implemented' ? '当前版本暂不支持此功能' : '角色渲染进程无响应';
};

const nameOf = (s: ModSettingRow, v: number) => s.values.find((x) => x.value === v)?.name ?? String(v);

/** Groups in drawing order with their title bar's English; a switch without a category, or with one this page does not know, is 其他. */
const GROUPS: ReadonlyArray<[NonNullable<ModSettingRow['category']>, string, string]> = [
  ['clothing', '衣服', 'Clothing'],
  ['accessory', '道具', 'Accessory'],
  ['hair', '发型', 'Hair'],
  ['color', '颜色', 'Color'],
  ['other', '其他', 'Other'],
];
const groupOf = (s: ModSettingRow) => (GROUPS.some(([c]) => c === s.category) ? s.category : 'other');

/** The importer names the two values of a part that can be hidden 显示 and 隐藏. */
const shownValue = (s: ModSettingRow) => {
  const on = s.values.find((x) => x.name === '显示');
  const off = s.values.find((x) => x.name === '隐藏');
  return s.values.length === 2 && on && off ? { on: on.value, off: off.value } : null;
};

/** One send: the values it changes, the words for the card, the toast and the rollback, and where the rollback bar goes (a row, a group, or under the card). */
interface Change {
  values: Record<string, number>;
  what: string;
  done: string;
  fail: (reason: string) => string;
  at: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The appearance card, the category jump bar, then one title bar per category over its rows; ↑↓ pick a row, ←→ change it, X goes back to its last value. */
export function ModSettings({ character, appearance, settings, ro, toast }: ModSettingsProps) {
  const id = appearance.id;
  const [stored, setStored] = useState<{ character: string; values: Record<string, ModSettingValues> }>();
  // Why the stored values could not be read: until a read succeeds the rows are read only, or a change would send defaults for the rest.
  const [unread, setUnread] = useState<{ character: string; why: string } | null>(null);
  const [reads, setReads] = useState(0);
  const [marks, setMarks] = useState<{ appearance: string; notes: Record<string, string>; fail: (Change & { text: string }) | null }>();
  const [run, setRun] = useState<{ ids: string[]; what: string } | null>(null);
  // Each row's value before its last change this session: the other end of 对比.
  const [prev, setPrev] = useState<{ appearance: string; values: Record<string, number> }>();
  const [cur, setCur] = useState<string>();
  const [at, setAt] = useState<string>();
  // The row itself holds focus (the keys act on it): the row's focus frame.
  const [focused, setFocused] = useState<string | null>(null);
  const compact = useCompact();
  const root = useRef<HTMLDivElement>(null);
  const groupRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    let live = true;
    void getBridge()
      .avatar.modSettings.get({ character })
      .then(
        (res) => {
          if (!live) return;
          setStored({ character, values: res.appearances });
          setUnread(null);
        },
        (e: unknown) => {
          if (!live) return;
          setStored((x) => (x?.character === character ? x : { character, values: {} }));
          setUnread({ character, why: (e as { code?: string } | null)?.code === 'not_implemented' ? '当前版本暂不支持此功能' : '角色渲染进程无响应' });
        },
      );
    return () => {
      live = false;
    };
  }, [character, reads]);

  if (stored?.character !== character || settings.length === 0) return null;
  const value = (s: ModSettingRow) => stored.values[id]?.[s.id] ?? s.default;
  const mark = marks?.appearance === id ? marks : undefined;
  const before = prev?.appearance === id ? prev.values : {};
  const failedRead = unread?.character === character ? unread.why : null;
  const off = ro != null || run != null || failedRead != null;
  const put = (values: ModSettingValues) => setStored((x) => (x && x.character === character ? { ...x, values: { ...x.values, [id]: values } } : x));

  /** Sends the whole set with `c.values` applied; a failure puts the old values back and bars where `c.at` says. */
  const send = (c: Change) => {
    const old = stored.values[id] ?? {};
    const next = Object.fromEntries(settings.map((x) => [x.id, c.values[x.id] ?? value(x)]));
    const moved = settings.filter((x) => next[x.id] !== value(x));
    const lastPrev = before;
    setPrev({ appearance: id, values: { ...before, ...Object.fromEntries(moved.map((x) => [x.id, value(x)])) } });
    put(next);
    setMarks({ appearance: id, notes: {}, fail: null });
    setRun({ ids: moved.map((x) => x.id), what: c.what });
    getBridge()
      .avatar.modSettings.set({ character, appearance: id, values: next })
      .then(
        (res) => {
          put(res.values);
          previewLookChanged();
          setMarks({ appearance: id, notes: Object.fromEntries(res.adjusted.map((a) => [a.id, ADJUSTED[a.reason]])), fail: null });
          if (res.adjusted.length === 0) toast(c.done);
        },
        (e: unknown) => {
          put(old);
          setPrev({ appearance: id, values: lastPrev });
          setMarks({ appearance: id, notes: {}, fail: { ...c, text: c.fail(why(e)) } });
        },
      )
      .finally(() => setRun(null));
  };
  const pick = (s: ModSettingRow, v: number) => {
    const was = value(s);
    send({ values: { [s.id]: v }, what: s.name, done: `「${s.name}」已调整为「${nameOf(s, v)}」`, fail: (w) => `「${s.name}」未能更改：${w}，已还原为「${nameOf(s, was)}」`, at: s.id });
  };
  const reset = (title: string, rows: ModSettingRow[], at: string | null) =>
    send({ values: Object.fromEntries(rows.map((s) => [s.id, s.default])), what: title, done: `「${title}」已恢复默认`, fail: (w) => `「${title}」未能恢复默认：${w}`, at });
  const flip = (s: ModSettingRow) => {
    const v = before[s.id];
    if (v !== undefined && v !== value(s) && !off) pick(s, v);
  };
  const step = (s: ModSettingRow, by: -1 | 1) => {
    const two = shownValue(s);
    // 显示 is always on the left.
    const x = two ? { value: by < 0 ? two.on : two.off } : s.values[s.values.findIndex((y) => y.value === value(s)) + by];
    if (x && x.value !== value(s) && !off) pick(s, x.value);
  };

  const groups = GROUPS.map(([category, title, en]) => ({ category, title, en, rows: settings.filter((s) => groupOf(s) === category) })).filter((g) => g.rows.length > 0);
  const moved = (s: ModSettingRow) => value(s) !== s.default;
  const current = cur && settings.some((s) => s.id === cur) ? cur : groups[0]?.rows[0]?.id;
  const here = at && groups.some((g) => g.category === at) ? at : groups[0]?.category;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-mod-setting]');
    const s = settings.find((x) => x.id === row?.dataset.modSetting);
    if (!row || !s) return;
    const onRow = e.target === row;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const all = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-mod-setting]') ?? []);
      all[all.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else if (onRow && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) step(s, e.key === 'ArrowLeft' ? -1 : 1);
    else if (onRow && e.key === ' ' && shownValue(s)) step(s, value(s) === shownValue(s)?.on ? 1 : -1);
    else if (onRow && e.key === 'Enter') row.querySelector<HTMLElement>('[aria-haspopup]')?.click();
    else if (e.key === 'x' || e.key === 'X') flip(s);
    else return;
    e.preventDefault();
  };

  const control = (s: ModSettingRow) => {
    const two = shownValue(s);
    if (two)
      return (
        <Switch variant="setting" label={s.name} checked={value(s) === two.on} disabled={off} onChange={(on) => pick(s, on ? two.on : two.off)} />
      );
    return (
      <Stepper
        label={s.name}
        compact={compact}
        options={s.values.map((x) => ({ value: String(x.value), label: x.name }))}
        value={String(value(s))}
        defaultValue={String(s.default)}
        disabled={off}
        onChange={(v) => pick(s, Number(v))}
      />
    );
  };

  const failBar = (where: string | null) =>
    mark?.fail && mark.fail.at === where ? (
      <div className={styles.err}>
        <span className={styles.errTag} aria-hidden="true">
          ROLLBACK
        </span>
        <span role="alert">{mark.fail.text}</span>
        <WhiteCapsule label="再试一次" icon="refresh" disabled={off} onClick={() => mark.fail && send(mark.fail)} />
      </div>
    ) : null;

  const sync = ro ?? (failedRead ? '无法读取已保存的设置（当前只读）' : run ? `正在应用「${run.what}」…` : mark?.fail ? '上次修改未生效，已恢复原值' : '设置与实时显示一致');
  const anyMoved = settings.some(moved);

  return (
    <div ref={root} className={styles.mods} role="group" aria-label="模组设置" data-off={off || undefined} onKeyDown={onKey}>
      <div className={head.card} data-mod-card="">
        <span className={head.flag} aria-hidden="true">
          <span>模组</span>
        </span>
        <div className={head.info}>
          <div className={head.t}>
            <h3 className={head.nm}>{appearance.name}</h3>
            <span className={head.id}>{id}</span>
          </div>
          <div className={head.acts}>
            <span className={head.sync} role="status" data-sync={ro ? 'ro' : run ? 'busy' : mark?.fail ? 'fail' : 'ok'}>
              <i aria-hidden="true" />
              {sync}
            </span>
            <WhiteCapsule label="全部恢复默认" icon="refresh" disabled={off || !anyMoved} disabledReason={anyMoved ? '' : '已是默认'} onClick={() => reset('全部开关', settings, null)} />
          </div>
        </div>
      </div>
      {failedRead && <ErrBar message={`读取模组设置失败：${failedRead}`} onRetry={() => setReads((n) => n + 1)} />}
      {failBar(null)}
      <div className={head.jump} role="group" aria-label="跳到类别">
        <span className={head.jumpLbl}>跳到</span>
        {groups.map((g) => (
          <button
            key={g.category}
            type="button"
            className={head.chip}
            aria-current={g.category === here || undefined}
            onClick={() => {
              setAt(g.category);
              groupRefs.current[g.category]?.scrollIntoView({ block: 'start' });
            }}
          >
            {g.title}
            <b>{g.rows.length}</b>
            {g.rows.some(moved) && <Diamond tone="yellow" size={5} />}
          </button>
        ))}
        <span className={head.keys} aria-hidden="true">
          <kbd>↑↓</kbd>选行<kbd>←→</kbd>换值<kbd>X</kbd>对比上一值
        </span>
      </div>
      {groups.map((g, gi) => {
        const changed = g.rows.filter(moved).length;
        return (
          <div
            key={g.category}
            ref={(el) => {
              groupRefs.current[g.category] = el;
            }}
            className={styles.group}
            role="group"
            aria-label={g.title}
            data-mod-group={g.category}
          >
            <TitleBar
              title={g.title}
              micro={`${g.en} / ${pad(gi + 1)}`}
              count={g.rows.length}
              changed={changed}
              actions={<WhiteCapsule label="恢复默认" icon="refresh" disabled={off || changed === 0} disabledReason={changed ? '' : '已是默认'} onClick={() => reset(g.title, g.rows, `group:${g.category}`)} />}
            />
            {failBar(`group:${g.category}`)}
            {g.rows.map((s) => {
              const note = mark?.notes[s.id];
              const was = before[s.id];
              const busy = run?.ids.includes(s.id);
              const fail = mark?.fail?.at === s.id;
              return (
                <div key={s.id}>
                  <div
                    className={styles.slot}
                    data-mod-setting={s.id}
                    data-changed={moved(s) || undefined}
                    data-busy={busy || undefined}
                    data-fail={fail || undefined}
                    tabIndex={s.id === current ? 0 : -1}
                    onFocus={(e) => {
                      setCur(s.id);
                      setAt(g.category);
                      if (e.target === e.currentTarget) setFocused(s.id);
                    }}
                    onBlur={(e) => e.target === e.currentTarget && setFocused(null)}
                  >
                    <SRow
                      id={`mod-${s.id}`}
                      title={s.name}
                      className={rowStyles.row}
                      desc={busy ? '应用中' : (note ?? (moved(s) ? `默认：${nameOf(s, s.default)}` : undefined))}
                      modified={moved(s)}
                      data-focused={focused === s.id || undefined}
                      data-state={busy ? 'busy' : fail ? 'fail' : undefined}
                      control={
                        <>
                          {was !== undefined && was !== value(s) && !busy && (
                            <button type="button" className={styles.flip} disabled={off} onClick={() => flip(s)}>
                              <Icon name="sync" size={12} />
                              对比「{nameOf(s, was)}」
                              <kbd aria-hidden="true">X</kbd>
                            </button>
                          )}
                          {control(s)}
                        </>
                      }
                    />
                  </div>
                  {failBar(s.id)}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
