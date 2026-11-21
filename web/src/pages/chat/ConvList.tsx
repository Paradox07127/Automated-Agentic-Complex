import { useRef, useState } from 'react';
import { formatClock, type Conversation } from '../../domain';
import { artSrc, IconBtn, Menu, SearchField, type MenuItem } from '../../ui';
import { CellsIn, SelMark } from './motion';
import styles from './ConvList.module.css';

const GROUPS: Array<Conversation['group']> = ['置顶', '今天', '更早'];

export interface ConvListProps {
  conversations: Conversation[];
  archived: Conversation[];
  selected: string | null;
  busy: boolean;
  now: number;
  /** Turns per hour of the last 24 h, oldest first, by conversation id. */
  hourly: Record<string, number[]>;
  /** Her character id: each contact cell shows her round head. */
  roleId?: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  manageItems: (c: Conversation) => MenuItem[];
  onOpenArchived: (id: string) => void;
}

export function whenOf(at: number, now: number): string {
  const d = new Date(at);
  if (d.toDateString() === new Date(now).toDateString()) return formatClock(at);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** A narrow column's failed read: one line 「没读到X · 重试」; the reason stays in the message area's error bar. */
export function FailLine({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <p role="alert" className={styles.fail}>
      没读到{what} │{' '}
      <button type="button" className={styles.retry} onClick={onRetry}>
        重试
      </button>
    </p>
  );
}

/** 24 h turns as a 120x14 line in the row's secondary text colour; the selected row's in its text colour. */
function HourSpark({ pts }: { pts: number[] }) {
  const w = 120;
  const h = 14;
  const max = Math.max(1, ...pts);
  const x = (i: number) => (i / Math.max(1, pts.length - 1)) * (w - 4) + 2;
  const y = (v: number) => h - 2 - (v / max) * (h - 4);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  const li = pts.length - 1;
  const n = pts.reduce((a, b) => a + b, 0);
  return (
    <svg className={styles.spark} role="img" aria-label={`近 24 小时 ${n} 轮`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={d} className={styles.sparkL} />
      <circle cx={x(li)} cy={y(pts[li] ?? 0)} r={2} className={styles.sparkD} />
    </svg>
  );
}

/** Contact cell head: her round icon in a rounded square, else the generic single head. */
function ContactHead({ roleId }: { roleId: string | null | undefined }) {
  const src = artSrc(roleId, 'round');
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={styles.head} aria-hidden="true">
      {src && failed !== src ? <img src={src} width={50} height={50} alt="" onError={() => setFailed(src)} /> : <i className={`${styles.generic} sns-avatar-generic`} />}
    </span>
  );
}

/** Conversation list: 置顶 / 今天 / 更早, each row an SNS contact cell (head, name, last time, turn count and, when it had turns in the last 24 h, a sparkline); right click manages it; 已归档 under the scroll. */
export function ConvList({ conversations, archived, selected, busy, now, hourly, roleId, onSelect, onNew, manageItems, onOpenArchived }: ConvListProps) {
  const [q, setQ] = useState('');
  const [ctx, setCtx] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const shown = conversations.filter((c) => !c.archived && (q.trim() === '' || c.title.includes(q.trim())));
  return (
    <nav ref={root} className={styles.root} aria-label="对话列表">
      <div className={styles.top}>
        <SearchField value={q} label="搜索对话" placeholder="搜索对话" onChange={setQ} />
        <IconBtn icon="plus" label={busy ? '角色执行中，结束后可新建' : '新建对话'} disabled={busy} onClick={onNew} />
      </div>
      <div className={styles.scroll}>
        {GROUPS.map((g) => {
          const rows = shown.filter((c) => c.group === g);
          if (rows.length === 0) return null;
          return (
            <div key={g} className={styles.group} role="group" aria-label={g}>
              <div className={styles.grp}>
                {g}
                <span className={styles.num}>{rows.length}</span>
              </div>
              {rows.map((c) => {
                const on = c.id === selected;
                const pts = hourly[c.id] ?? [];
                return (
                  <div
                    key={c.id}
                    className={styles.item}
                    data-g="cell"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtx(ctx === c.id ? null : c.id);
                    }}
                  >
                    <button type="button" className={styles.cv} data-g="cellBody" data-on={on || undefined} aria-current={on ? 'true' : undefined} onClick={() => onSelect(c.id)}>
                      <ContactHead roleId={roleId} />
                      <span className={styles.cvT}>
                        <span className={styles.title}>{c.title}</span>
                        {c.busy && busy && (
                          <span className={styles.run} title="执行中" aria-label="执行中">
                            ▶
                          </span>
                        )}
                      </span>
                      <span className={styles.when}>{whenOf(c.updated_at, now)}</span>
                      <span className={styles.cnt}>
                        <span className={styles.num}>{c.turn_count}</span> 轮
                      </span>
                      {pts.some((v) => v > 0) && <HourSpark pts={pts} />}
                    </button>
                    {on && <SelMark />}
                    {ctx === c.id && (
                      <div className={styles.ctx}>
                        <Menu label={`管理「${c.title}」`} items={manageItems(c)} open />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {shown.length > 0 && <CellsIn root={root} />}
      {archived.length > 0 && (
        <div className={styles.foot}>
          <Menu label={`已归档 ${archived.length}`} items={archived.map((a): MenuItem => ({ kind: 'item', label: a.title, onSelect: () => onOpenArchived(a.id) }))} />
        </div>
      )}
    </nav>
  );
}
