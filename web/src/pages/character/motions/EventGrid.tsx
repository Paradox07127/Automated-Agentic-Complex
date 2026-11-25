import { useRef, type KeyboardEvent } from 'react';
import { Diamond, MicroLabel } from '../../../ui/game';
import type { Lane } from './LoopMap';
import styles from './Events.module.css';

export interface EventGridProps {
  cells: Lane[];
  groupTitle: (id: string) => string;
  sel: string | null;
  onSel: (key: string) => void;
}

const POSTURE: Record<string, string> = { sit: '坐着', floor: '坐地上', lie: '躺着' };

/** 事件反应：事件池按图里的分组排成格，每格是事件 key、姿态、条数，已改黄菱形、有会硬切的链红点；点格选这个池。 */
export function EventGrid({ cells, groupTitle, sel, onSel }: EventGridProps) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const groups: Array<[string, Lane[]]> = [];
  for (const c of cells) {
    const last = groups[groups.length - 1];
    if (last && last[0] === c.pool.group) last[1].push(c);
    else groups.push([c.pool.group, [c]]);
  }
  const at = Math.max(0, cells.findIndex((c) => c.pool.key === sel));
  const onKey = (e: KeyboardEvent) => {
    const by = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!by || cells.length === 0) return;
    e.preventDefault();
    const key = cells[(at + by + cells.length) % cells.length]!.pool.key;
    onSel(key);
    refs.current.get(key)?.focus();
  };
  if (cells.length === 0) return <p className={styles.none}>当前角色包中没有可编辑的事件池</p>;
  return (
    <div className={styles.events} role="radiogroup" aria-label="事件池" onKeyDown={onKey}>
      {groups.map(([id, list]) => (
        <div key={id} className={styles.group}>
          <span className={styles.gt}>{groupTitle(id)}</span>
          <div className={styles.cells}>
            {list.map((c) => {
              const p = c.pool;
              const on = p.key === sel;
              return (
                <button
                  key={p.key}
                  ref={(el) => {
                    if (el) refs.current.set(p.key, el);
                    else refs.current.delete(p.key);
                  }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={p.key === cells[at]?.pool.key ? 0 : -1}
                  className={styles.cell}
                  data-pool-cell={p.key}
                  data-bad={c.bad || undefined}
                  title={[p.key, `${c.n} 条`, c.hard > 0 ? `${c.hard} 条会硬切` : null, c.proposed > 0 ? `建议 ${c.proposed}` : null].filter(Boolean).join(' │ ')}
                  onClick={() => onSel(p.key)}
                >
                  <span className={styles.band} aria-hidden="true">
                    <MicroLabel>Event</MicroLabel>
                  </span>
                  <b className={styles.key}>{p.key.split('@')[0]}</b>
                  <span className={styles.meta}>
                    {POSTURE[p.posture] && <span className={styles.pos}>{POSTURE[p.posture]}</span>}
                    {c.n} 条
                    {c.hard > 0 && <i className={styles.hard} aria-label="有会硬切的链" />}
                    {c.changed && <Diamond tone="yellow" size={6} />}
                    {c.proposed > 0 && (
                      <span className={styles.pr} data-proposed="">
                        {c.proposed}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
