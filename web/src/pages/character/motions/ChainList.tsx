import { useState } from 'react';
import { Btn, FilterChips, SearchField } from '../../../ui';
import { ChainRow } from './ChainRow';
import { shows, type ChainFilter, type ChainGroup, type ChainRow as Row } from './graph';
import styles from './MotionSettings.module.css';

export interface ChainListProps {
  groups: ChainGroup[];
  value: (key: string) => boolean;
  unsaved: (key: string) => boolean;
  /** Chain key → why the avatar did not take it at the last save. */
  adjusted: Record<string, string>;
  /** Chain key → note, as shown. */
  note: (key: string) => string;
  lock: string | null;
  playBlock: string | null;
  onToggle: (key: string, on: boolean) => void;
  /** Sets every chain of the group that can change. */
  onGroup: (group: ChainGroup, on: boolean) => void;
  onPlay: (row: Row) => void;
  onOpen: (key: string) => void;
}

const FILTERS: Array<{ value: ChainFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'on', label: '开' },
  { value: 'off', label: '关' },
  { value: 'chg', label: '已改' },
  { value: 'new', label: '新' },
];

/** 全部动作：开关计数，筛选和搜索，然后每组一节（组头带整组开、整组关），每条链一行。 */
export function ChainList(p: ChainListProps) {
  const [filter, setFilter] = useState<ChainFilter>('all');
  const [q, setQ] = useState('');
  const all = p.groups.flatMap((g) => g.rows);
  const on = all.filter((r) => p.value(r.key)).length;
  const count = (f: ChainFilter) => all.filter((r) => shows(r, p.value(r.key), f, '')).length;
  const shown = p.groups.map((g) => ({ g, rows: g.rows.filter((r) => shows(r, p.value(r.key), filter, q)) })).filter((x) => x.rows.length > 0);
  const n = shown.reduce((s, x) => s + x.rows.length, 0);

  return (
    <div className={styles.list}>
      <div className={styles.counts}>
        <b className={styles.num}>
          开 {on} │ 关 {all.length - on} │ 已改 {count('chg')}
        </b>
        <span>
          显示 {n} / {all.length} 条
        </span>
      </div>
      <div className={styles.bar}>
        <span className={styles.q}>
          <SearchField value={q} label="搜索动作" placeholder="搜名字或分组" onChange={setQ} />
        </span>
        <FilterChips
          label="按开关筛选"
          options={FILTERS.map((f) => ({ ...f, count: count(f.value) }))}
          value={[filter]}
          onChange={(v) => setFilter((v[0] as ChainFilter | undefined) ?? 'all')}
        />
      </div>
      {shown.map(({ g, rows }) => {
        const free = g.rows.filter((r) => !r.required);
        const off = p.lock ?? (free.length === 0 ? '这一组都是基础动作' : null);
        return (
          <section key={g.id} aria-label={g.title} className={styles.group}>
            <div className={styles.gh}>
              <b>{g.title}</b>
              <span className={styles.num}>
                {g.rows.length} 条 │ 开 {g.rows.filter((r) => p.value(r.key)).length}
              </span>
              <span className={styles.acts}>
                <Btn size="sm" variant="quiet" disabled={off != null} {...(off != null ? { disabledReason: off } : {})} onClick={() => p.onGroup(g, true)}>
                  整组开
                </Btn>
                <Btn size="sm" variant="quiet" disabled={off != null} {...(off != null ? { disabledReason: off } : {})} onClick={() => p.onGroup(g, false)}>
                  整组关
                </Btn>
              </span>
            </div>
            <ul className={styles.rows}>
              {rows.map((r) => (
                <ChainRow
                  key={r.key}
                  row={r}
                  on={p.value(r.key)}
                  unsaved={p.unsaved(r.key)}
                  adjusted={p.adjusted[r.key] ?? null}
                  lock={p.lock}
                  playBlock={p.playBlock}
                  note={p.note(r.key)}
                  onToggle={(v) => p.onToggle(r.key, v)}
                  onPlay={() => p.onPlay(r)}
                  onOpen={() => p.onOpen(r.key)}
                />
              ))}
            </ul>
          </section>
        );
      })}
      {n === 0 && <div className={styles.none}>没有符合的动作</div>}
    </div>
  );
}
