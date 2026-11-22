import { useRef, useState } from 'react';
import type { AvatarAction, ImportedMotionEntry } from '../../bridge';
import { Btn, Icon, SearchField, Toggle } from '../../ui';
import { SelMark } from './charMotion';
import { SaveNote } from './Commit';
import { motionFormatLabel } from './labels';
import dark from './Rows.module.css';
import styles from './MotionTable.module.css';

export interface MotionRow {
  a: AvatarAction;
  /** Running number across the table. */
  no: string;
}

export interface MotionGroup {
  key: string;
  name: string;
  rows: MotionRow[];
}

export interface MotionTableProps {
  groups: MotionGroup[];
  value: (a: AvatarAction) => boolean;
  /** Ids with an unsaved switch. */
  changed: Record<string, boolean>;
  sel: string;
  onSel: (id: string) => void;
  onToggle: (a: AvatarAction, on: boolean) => void;
  /** Today's plays by motion id; null where nobody counts them. */
  hours: Record<string, number[]> | null;
  offline: boolean;
  /** A switch is running: input pauses. */
  lock: boolean;
  sparse: boolean;
  saving: boolean;
  onUndo: () => void;
  onSave: () => void;
  /** Name, 必需 and the switch only; trigger, duration and today's plays stay on the 调参 page; the save line is the page's bottom bar. */
  compact?: boolean;
  /** The page already has a fixed save bar. */
  externalCommit?: boolean;
  /** Imported motions by action id: their rows carry the format tag. */
  imported?: Record<string, ImportedMotionEntry>;
}

const NO_IMPORTS: Record<string, ImportedMotionEntry> = {};
const sum = (v: number[] | undefined) => (v ?? []).reduce((a, b) => a + b, 0);
const secs = (d: number) => `${d.toFixed(1)} s`;
const NO_PLAY = '由行为触发 │ 不支持单独预览';

/** 动作表：一个连续列表，分区是吸顶组头和一排页签（点了跳过去）；行：播放标记、名称、触发、时长、今日（有计数时）、必需、开关；底栏整组提交。 */
export function MotionTable(p: MotionTableProps) {
  const [q, setQ] = useState('');
  const [onlyMiss, setOnlyMiss] = useState(false);
  const [onlyImpOn, setOnlyImp] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // The section tab last jumped to, else the selected motion's.
  const [at, setAt] = useState<string | null>(null);
  const qq = q.trim();
  const all = p.groups.flatMap((g) => g.rows);
  const missN = all.filter((r) => r.a.missing).length;
  const imported = p.imported ?? NO_IMPORTS;
  const impN = all.filter((r) => r.a.id in imported).length;
  // Off by itself once the last imported row is gone.
  const onlyImp = onlyImpOn && impN > 0;
  const n = Object.keys(p.changed).length;
  const here = at ?? p.groups.find((g) => g.rows.some((r) => r.a.id === p.sel))?.key ?? p.groups[0]?.key;
  const pick = (id: string) => {
    setAt(null);
    p.onSel(id);
  };
  const jump = (key: string) => {
    setAt(key);
    const box = listRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-group="${key}"]`);
    if (!box || !el) return;
    if (box.scrollHeight > box.clientHeight) box.scrollTop = el.offsetTop;
    else el.scrollIntoView({ block: 'start' });
  };

  const row = ({ a }: MotionRow) => {
    const v = p.value(a);
    const on = p.sel === a.id;
    const count = sum(p.hours?.[a.id]);
    const imp = imported[a.id];
    const lockReason = p.offline ? '角色未运行' : p.lock ? '切换中 │ 输入暂停' : a.missing ? '缺资源' : a.requiredReason;
    return (
      <div
        key={a.id}
        className={`${dark.row} ${styles.row}`}
        // Dark in either theme (the 调参 page has no dark panel around it): its switch takes the dark tokens.
        data-theme="dark"
        role="row"
        aria-selected={on}
        tabIndex={0}
        data-motion={a.id}
        data-miss={a.missing || undefined}
        data-off={(!v && !a.missing) || undefined}
        onClick={() => pick(a.id)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
            e.preventDefault();
            pick(a.id);
          }
        }}
      >
        <span className={dark.lead}>
          <span className={styles.mk}>
            {a.playable === false && !a.missing ? (
              <span className={styles.noPlay} title={NO_PLAY}>
                <Icon name="play" size={14} label={NO_PLAY} />
              </span>
            ) : (
              !a.missing && <Icon name="play" size={14} />
            )}
            {on && <SelMark />}
          </span>
        </span>
        <span className={styles.cells}>
          <span className={styles.nm}>
            <span className={styles.lb} title={a.label}>
              {a.label}
            </span>
            {a.isNew && <span className={styles.new}>新</span>}
            {imp && <span className={styles.fmt}>{motionFormatLabel(imp.format)}</span>}
            {a.media?.bgm && <span className={styles.fmt}>BGM</span>}
            {a.media?.face && <span className={styles.fmt}>表情</span>}
            {a.media?.camera && <span className={styles.fmt}>相机</span>}
            {a.id in p.changed && <i className={dark.chg} title="未保存" aria-label="未保存" />}
          </span>
          {!p.compact && (
            <>
              <span className={styles.tr} title={a.missing ? (a.missingReason ?? '缺资源') : (a.trigger ?? undefined)}>
                {a.missing ? `⊘ ${(a.missingReason ?? '缺资源').replace(/^缺少\s*/, '缺 ')}` : (a.trigger ?? '')}
              </span>
              <span className={styles.du}>{a.durationS != null ? secs(a.durationS) : '—'}</span>
              {p.hours && (
                <span className={styles.ct} title="今日播放次数" data-zero={count === 0 || undefined}>
                  {a.missing ? '' : count}
                </span>
              )}
            </>
          )}
          <span>
            {a.requiredReason && (
              <span className={dark.tag} title={a.requiredReason}>
                必需
              </span>
            )}
          </span>
          <span className={styles.tg} onClick={(e) => e.stopPropagation()}>
            <Toggle size="sm" on={v} label={a.label} disabled={lockReason != null} disabledReason={lockReason ?? ''} onChange={(x) => p.onToggle(a, x)} />
          </span>
        </span>
      </div>
    );
  };

  return (
    <div className={styles.mt} data-nocount={!p.hours || undefined} data-compact={p.compact || undefined} data-motions="">
      <div className={styles.bar}>
        <span className={styles.q}>
          <SearchField value={q} label="搜索动作" placeholder="搜索动作" onChange={setQ} />
        </span>
        <button type="button" className={styles.chip} aria-pressed={onlyMiss} onClick={() => setOnlyMiss((x) => !x)}>
          ⊘ 仅显示缺资源 <span className={styles.num}>{missN}</span>
        </button>
        {impN > 0 && (
          <button type="button" className={styles.chip} aria-pressed={onlyImp} onClick={() => setOnlyImp(!onlyImp)}>
            只看导入 <span className={styles.num}>{impN}</span>
          </button>
        )}
        <span className={styles.jump} role="group" aria-label="跳转到分区" data-hscroll="">
          {p.groups.map((g) => (
            <button key={g.key} type="button" aria-label={`跳转到 ${g.name}`} aria-current={g.key === here || undefined} onClick={() => jump(g.key)}>
              {g.name}
            </button>
          ))}
        </span>
      </div>
      <div className={styles.cols} aria-hidden="true">
        <span className={styles.cells}>
          <span>名称</span>
          {!p.compact && (
            <>
              <span>触发</span>
              <span>时长</span>
              {p.hours && <span>今日</span>}
            </>
          )}
          <span />
          <span />
        </span>
      </div>
      <div className={styles.list} ref={listRef} role="grid" aria-label="全部动作">
        {p.groups.map((g) => {
          const shown = g.rows.filter((x) => (!onlyMiss || x.a.missing) && (!onlyImp || x.a.id in imported) && (!qq || `${x.a.label}${x.a.trigger ?? ''}`.includes(qq)));
          return (
            <div key={g.key} className={dark.list} data-group={g.key} role="rowgroup">
              <div className={`${dark.head} ${styles.gh}`}>
                <span>{g.name}</span>
                <span className={`${dark.meta} ${styles.num}`}>
                  {g.rows.filter((x) => p.value(x.a)).length}/{g.rows.length}
                </span>
              </div>
              {shown.map(row)}
              {shown.length === 0 && <div className={styles.none}>{onlyMiss ? '本组无缺资源动作' : onlyImp ? '本组无导入动作' : '无匹配动作'}</div>}
            </div>
          );
        })}
      </div>
      {!p.compact && !p.externalCommit && (
        <div className={styles.save}>
          <SaveNote offline={p.offline} n={n} sparse={p.sparse} />
          {!p.offline && n > 0 && (
            <>
              <span className={styles.sp} />
              <Btn variant="quiet" onClick={p.onUndo}>
                撤销
              </Btn>
              <Btn variant="primary" loading={p.saving} onClick={p.onSave}>
                保存
              </Btn>
            </>
          )}
        </div>
      )}
    </div>
  );
}
