// One 「设定」 page: its sections from sections.ts, then 「其他」 for unplaced @character rows.
import type { SettingValue } from '../../bridge';
import { SRow } from '../../ui';
import type { Native } from '../settings/native';
import { CHAR_SECTIONS, CHAR_TABS, DEV_ONLY_ROWS, OTHER_TITLE, placedTab, ROW_DESC, tabOf, type CharTab } from './sections';
import { control } from './settings';
import styles from './Tune.module.css';

export interface SettingRowsProps {
  n: Native;
  tab: CharTab;
  dev: boolean;
  set: (id: string, v: SettingValue, quiet?: boolean) => void;
  pending: Set<string>;
  offline: boolean;
}

const visible = (n: Native, dev: boolean, id: string) => n.rows[id]?.group === '@character' && (dev || !DEV_ONLY_ROWS.has(id));

const others = (n: Native, dev: boolean, tab: CharTab) =>
  Object.values(n.rows)
    .map((r) => r.id)
    .filter((id) => visible(n, dev, id) && placedTab(id) === null && tabOf(id) === tab);

export function SettingRows({ n, tab, dev, set, pending, offline }: SettingRowsProps) {
  const section = (key: string, title: string, ids: string[]) =>
    ids.length > 0 && (
      <section key={key} aria-label={title}>
        <div className={styles.sub}>{title}</div>
        {ids.map((id) => {
          const row = n.rows[id]!;
          return (
            <SRow
              key={id}
              id={id}
              title={row.label}
              desc={ROW_DESC[id]}
              control={control(row, n.saved[id], offline, (v, quiet) => set(id, v, quiet))}
              effect={row.restart === 'avatar' ? 'character' : 'now'}
              pending={pending.has(id)}
              {...(offline ? { disabled: true, disabledReason: '角色未运行' } : {})}
            />
          );
        })}
      </section>
    );

  return (
    <>
      {CHAR_SECTIONS.filter((s) => s.tab === tab).map((s) => section(s.id, s.title, s.rows.filter((id) => visible(n, dev, id))))}
      {section('other', OTHER_TITLE, others(n, dev, tab))}
    </>
  );
}

/** Pages with at least one visible row, in CHAR_TABS order. */
export function presentTabs(n: Native, dev: boolean): CharTab[] {
  return CHAR_TABS.map((t) => t.id).filter((tab) => others(n, dev, tab).length > 0 || CHAR_SECTIONS.some((s) => s.tab === tab && s.rows.some((id) => visible(n, dev, id))));
}
