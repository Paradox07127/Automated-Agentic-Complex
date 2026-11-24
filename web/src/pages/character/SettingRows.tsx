// One 「设定」 page: its sections from sections.ts, then 「其他」 for unplaced @character rows; each row a settings page row.
import { useRef, type KeyboardEvent } from 'react';
import type { SettingValue } from '../../bridge';
import { isDevMode, useDevMode } from '../../shell/devMode';
import { DevMark, EffectTag } from '../../ui';
import { MicroLabel } from '../../ui/game';
import type { Native } from '../settings/native';
import { CHAR_SECTIONS, CHAR_TABS, LIGHT_PAD, OTHER_TITLE, placedTab, ROW_DESC, SEG_LABELS, tabOf, DEV_ONLY_ROWS, type CharTab } from './sections';
import { useCompact } from './compact';
import { OptionRow } from './OptionRow';
import { gameControl, valueText } from './settings';
import styles from './SettingRows.module.css';

export interface SettingRowsProps {
  n: Native;
  tab: CharTab;
  /** Resolves false when the save failed. */
  set: (id: string, v: SettingValue, quiet?: boolean) => Promise<boolean>;
  /** Several rows in one save (主光方向's two values). */
  setMany: (changes: Record<string, SettingValue>) => Promise<boolean>;
  pending: Set<string>;
  /** Per row: why its last mid-drag save failed. */
  failed: Readonly<Record<string, string>>;
  offline: boolean;
}

const visible = (n: Native, id: string) => n.rows[id]?.group === '@character' && (!DEV_ONLY_ROWS.has(id) || isDevMode());

const others = (n: Native, tab: CharTab) =>
  Object.values(n.rows)
    .map((r) => r.id)
    .filter((id) => visible(n, id) && placedTab(id) === null && tabOf(id) === tab);

/** Every row SettingRows draws on this page. */
export function tabRows(n: Native, tab: CharTab): string[] {
  return [...CHAR_SECTIONS.filter((s) => s.tab === tab).flatMap((s) => s.rows.filter((id) => visible(n, id))), ...others(n, tab)];
}

export const isChanged = (n: Native, id: string) => n.saved[id] !== n.rows[id]?.default;

/** Pages with at least one visible row, in CHAR_TABS order. */
export function presentTabs(n: Native): CharTab[] {
  return CHAR_TABS.map((t) => t.id).filter((tab) => tabRows(n, tab).length > 0);
}

/** Section head on the training room (app-memory's yellow square and \\──□ rule); 「仅桌面」 where the preview does not follow. */
export function SecHead({ title, en, desktopOnly = false }: { title: string; en: string; desktopOnly?: boolean | undefined }) {
  return (
    <div className={styles.head}>
      <i className={styles.sq} aria-hidden="true" />
      <h3 className={styles.h}>{title}</h3>
      <MicroLabel>{en}</MicroLabel>
      <i className={styles.rule} aria-hidden="true" />
      {desktopOnly && (
        <span className={styles.desk} title="只作用在桌面上的角色，预览不跟随">
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M2 3h20v13H2zm2.5 2.5v8h15v-8zM8 19h8v2.5H8z" />
          </svg>
          仅桌面
        </span>
      )}
    </div>
  );
}

const NEXT: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };

/** 主光方向: 3×3 cells, 抬高 on top and 左偏 on the left; a click saves both values at once, the default cell is a hollow diamond. */
function LightPad({ n, disabled, setMany }: { n: Native; disabled: boolean; setMany: SettingRowsProps['setMany'] }) {
  const yaw = n.rows[LIGHT_PAD.yaw]!;
  const pitch = n.rows[LIGHT_PAD.pitch]!;
  const yaws = yaw.options ?? [];
  const pitches = [...(pitch.options ?? [])].reverse();
  const cur = { y: String(n.saved[LIGHT_PAD.yaw]), p: String(n.saved[LIGHT_PAD.pitch]) };
  const cells = useRef<Array<HTMLButtonElement | null>>([]);
  // The cell picked last while its save is out, and the count of picks.
  const asked = useRef<{ y: string; p: string } | null>(null);
  const picks = useRef(0);
  const pick = (y: string, p: string) => {
    // A pick compares with the newest one asked, so going back to the saved cell while another saves is sent too.
    const want = asked.current ?? cur;
    if (y === want.y && p === want.p) return;
    const k = ++picks.current;
    asked.current = { y, p };
    void setMany({ [LIGHT_PAD.yaw]: y, [LIGHT_PAD.pitch]: p }).then(() => {
      if (k === picks.current) asked.current = null;
    });
  };
  const move = (e: KeyboardEvent, r: number, c: number) => {
    const d = NEXT[e.key];
    if (!d) return;
    e.preventDefault();
    const nr = Math.min(pitches.length - 1, Math.max(0, r + d[0]));
    const nc = Math.min(yaws.length - 1, Math.max(0, c + d[1]));
    cells.current[nr * yaws.length + nc]?.focus();
  };
  const at = Math.max(0, pitches.findIndex((o) => o.value === cur.p)) * yaws.length + Math.max(0, yaws.findIndex((o) => o.value === cur.y));
  return (
    <span className={styles.pad}>
      <span className={styles.ax} aria-hidden="true">
        <span>水平</span>
        <b>{valueText(yaw, cur.y)}</b>
        <span>俯仰</span>
        <b>{valueText(pitch, cur.p)}</b>
      </span>
      <span className={styles.grid} role="radiogroup" aria-label="主光方向" style={{ gridTemplateColumns: `repeat(${yaws.length}, var(--cell))` }}>
        {pitches.map((p, r) =>
          yaws.map((y, c) => {
            const i = r * yaws.length + c;
            const on = y.value === cur.y && p.value === cur.p;
            const name = `${y.label}，${p.label}`;
            return (
              <button
                key={`${y.value}/${p.value}`}
                ref={(el) => {
                  cells.current[i] = el;
                }}
                type="button"
                role="radio"
                className={styles.cell}
                aria-checked={on}
                aria-label={name}
                title={name}
                tabIndex={i === at ? 0 : -1}
                data-default={(y.value === String(yaw.default) && p.value === String(pitch.default)) || undefined}
                disabled={disabled}
                onKeyDown={(e) => move(e, r, c)}
                onClick={() => pick(y.value, p.value)}
              >
                <i />
              </button>
            );
          }),
        )}
      </span>
    </span>
  );
}

export function SettingRows({ n, tab, set, setMany, pending, failed, offline }: SettingRowsProps) {
  const compact = useCompact();
  // Re-renders when 开发者模式 flips; visible() reads it.
  useDevMode();
  const row = (id: string) => {
    const r = n.rows[id]!;
    const changed = isChanged(n, id);
    return (
      <div key={id} id={`set-${id}`} className={styles.row} data-changed={changed || undefined} role="group" aria-label={r.label} title={changed ? ROW_DESC[id] : undefined}>
        <OptionRow
          id={id}
          title={r.label}
          marks={
            (DEV_ONLY_ROWS.has(id) || r.restart === 'avatar') && (
              <span className={styles.marks}>
                {DEV_ONLY_ROWS.has(id) && <DevMark />}
                {r.restart === 'avatar' && <EffectTag target="character" pending={pending.has(id)} />}
              </span>
            )
          }
          desc={failed[id] ?? (changed ? `默认：${valueText(r, r.default)}` : ROW_DESC[id])}
          {...(failed[id] ? { descTone: 'bad' as const } : {})}
          modified={changed}
          reset={{ label: `恢复「${r.label}」的默认`, disabled: offline, onPress: () => set(id, r.default) }}
          control={gameControl(r, n.saved[id], offline, (v, quiet) => set(id, v, quiet), SEG_LABELS[id], compact)}
        />
      </div>
    );
  };

  const pad = () => {
    const yaw = n.rows[LIGHT_PAD.yaw]!;
    const pitch = n.rows[LIGHT_PAD.pitch]!;
    const changed = isChanged(n, LIGHT_PAD.yaw) || isChanged(n, LIGHT_PAD.pitch);
    return (
      <div key="pad" id={`set-${LIGHT_PAD.yaw}`} className={styles.row} data-changed={changed || undefined} data-pad="" role="group" aria-label="主光方向">
        <OptionRow
          id={LIGHT_PAD.yaw}
          title="主光方向"
          desc={changed ? `默认：${valueText(yaw, yaw.default)}（正中）` : '点格子换方向，正中是原作'}
          modified={changed}
          reset={{ label: '恢复「主光方向」的默认', disabled: offline, onPress: () => setMany({ [LIGHT_PAD.yaw]: yaw.default, [LIGHT_PAD.pitch]: pitch.default }) }}
          control={<LightPad n={n} disabled={offline} setMany={setMany} />}
        />
      </div>
    );
  };

  const section = (key: string, title: string, en: string, ids: string[], desktopOnly = false) => {
    if (ids.length === 0) return null;
    const both = ids.includes(LIGHT_PAD.yaw) && ids.includes(LIGHT_PAD.pitch);
    return (
      <section key={key} className={styles.sec} aria-label={title}>
        <SecHead title={title} en={en} desktopOnly={desktopOnly} />
        {ids.map((id) => (both && id === LIGHT_PAD.yaw ? pad() : both && id === LIGHT_PAD.pitch ? null : row(id)))}
      </section>
    );
  };

  return (
    <>
      {CHAR_SECTIONS.filter((s) => s.tab === tab).map((s) =>
        section(
          s.id,
          s.title,
          s.en,
          s.rows.filter((id) => visible(n, id)),
          s.desktopOnly,
        ),
      )}
      {section('other', OTHER_TITLE, 'Other', others(n, tab))}
    </>
  );
}
