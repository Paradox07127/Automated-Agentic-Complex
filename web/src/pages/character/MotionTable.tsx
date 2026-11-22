import { useRef, useState } from 'react';
import type { AvatarAction, ImportedMotionEntry } from '../../bridge';
import { Btn, Icon } from '../../ui';
import { DarkRow, Diamond, GameSeg, MicroLabel, TitleBar, type DarkRowMark } from '../../ui/game';
import { SaveNote } from './Commit';
import { useCompact } from './compact';
import { motionFormatLabel, SECTIONS } from './labels';
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
  /** The page already has a fixed save bar. */
  externalCommit?: boolean;
  /** Imported motions by action id: their rows carry the format tag. */
  imported?: Record<string, ImportedMotionEntry>;
}

const NO_IMPORTS: Record<string, ImportedMotionEntry> = {};
const sum = (v: number[] | undefined) => (v ?? []).reduce((a, b) => a + b, 0);
const NO_PLAY = '由行为触发 │ 不支持单独预览';
const ON_OFF = [
  { value: 'on', label: '开' },
  { value: 'off', label: '关' },
];

function Lock() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <rect x="3" y="7" width="10" height="7" fill="currentColor" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/** 动作表：搜索和两个筛选、分区跳转条、列头，然后按分区的深色行（吸顶组头带已开 / 总数和分区说明）；点行在舞台上预览，开关整组提交。 */
export function MotionTable(p: MotionTableProps) {
  const [q, setQ] = useState('');
  const [onlyMiss, setOnlyMiss] = useState(false);
  const [onlyImpOn, setOnlyImp] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const compact = useCompact();
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
    const mark: DarkRowMark = a.missing ? 'missing' : a.playable === false ? 'auto' : 'play';
    return (
      <div
        key={a.id}
        className={styles.r}
        // Dark in either theme (the 调参 page has no dark panel around it).
        data-theme="dark"
        role="row"
        aria-selected={on}
        data-motion={a.id}
        data-miss={a.missing || undefined}
        data-off={(!v && !a.missing) || undefined}
        title={mark === 'auto' ? NO_PLAY : undefined}
      >
        <div role="gridcell">
          <DarkRow
            mark={mark}
            compact={compact}
            selected={on}
            micro={on ? 'Preview' : 'Agentic'}
            onPress={() => pick(a.id)}
            title={
              <span className={styles.cells}>
                <span className={styles.nm}>
                  <span className={styles.lb} title={a.label}>
                    {a.label}
                  </span>
                  {a.isNew && <span className={styles.new}>新</span>}
                  {imp && <span className={styles.fmt}>{motionFormatLabel(imp.format)}</span>}
                  {a.media?.bgm && <span className={styles.media}>BGM</span>}
                  {a.media?.face && <span className={styles.media}>表情</span>}
                  {a.media?.camera && <span className={styles.media}>相机</span>}
                  {a.id in p.changed && (
                    <span className={styles.chg} role="img" title="未保存" aria-label="未保存">
                      <Diamond tone="yellow" size={8} />
                    </span>
                  )}
                </span>
                <span className={styles.tr} title={a.missing ? (a.missingReason ?? '缺资源') : (a.trigger ?? undefined)}>
                  {a.missing ? `⊘ ${(a.missingReason ?? '缺资源').replace(/^缺少\s*/, '缺 ')}` : (a.trigger ?? '')}
                </span>
                <span className={styles.du}>
                  {a.durationS != null ? (
                    <>
                      {a.durationS.toFixed(1)}
                      <small>s</small>
                    </>
                  ) : (
                    '—'
                  )}
                </span>
                {p.hours && (
                  <span className={styles.ct} title="今日播放次数" data-zero={count === 0 || undefined}>
                    {a.missing ? '' : count}
                  </span>
                )}
              </span>
            }
            end={
              <span className={styles.end}>
                <span className={styles.req}>
                  {a.requiredReason && (
                    <span className={styles.tag} title={a.requiredReason}>
                      <Lock />
                      <span className={styles.tagT}>必需</span>
                    </span>
                  )}
                </span>
                <GameSeg
                  variant="onoff"
                  size={compact ? 'compact' : 'normal'}
                  label={a.label}
                  value={v ? 'on' : 'off'}
                  options={lockReason ? ON_OFF.map((o) => ({ ...o, title: lockReason })) : ON_OFF}
                  disabled={lockReason != null}
                  onChange={(x) => p.onToggle(a, x === 'on')}
                />
              </span>
            }
          />
        </div>
      </div>
    );
  };

  return (
    <div className={styles.mt} data-count={p.hours ? '' : undefined} data-motions="">
      <div className={styles.bar}>
        <span className={styles.q}>
          <span className={styles.qi} aria-hidden="true">
            <Icon name="search" size={14} />
          </span>
          <input
            className={styles.qin}
            value={q}
            placeholder="搜索动作"
            aria-label="搜索动作"
            onChange={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && q) setQ('');
            }}
          />
          {q ? (
            <button type="button" className={styles.qx} aria-label="清除搜索" title="清除搜索" onClick={() => setQ('')}>
              <Icon name="close" size={12} />
            </button>
          ) : (
            <span className={styles.qm}>
              <MicroLabel>Search</MicroLabel>
            </span>
          )}
        </span>
        <button type="button" className={styles.chip} aria-label={`仅显示缺资源 ${missN}`} aria-pressed={onlyMiss} onClick={() => setOnlyMiss((x) => !x)}>
          <i className={styles.box} aria-hidden="true" />
          <span className={styles.miss}>⊘</span>
          <span className={styles.long}>仅显示</span>缺资源 <span className={styles.cn}>{missN}</span>
        </button>
        {impN > 0 && (
          <button type="button" className={styles.chip} aria-label={`只看导入 ${impN}`} aria-pressed={onlyImp} onClick={() => setOnlyImp(!onlyImp)}>
            <i className={styles.box} aria-hidden="true" />
            <span className={styles.long}>只看</span>导入 <span className={styles.cn}>{impN}</span>
          </button>
        )}
      </div>
      <span className={styles.jump} role="group" aria-label="跳转到分区" data-hscroll="">
        {p.groups.map((g) => (
          <button key={g.key} type="button" aria-label={`跳转到 ${g.name}`} aria-current={g.key === here || undefined} onClick={() => jump(g.key)}>
            {g.name}
          </button>
        ))}
      </span>
      <div className={styles.cols} aria-hidden="true">
        <span className={styles.cells}>
          <span>
            名称 <MicroLabel>Name</MicroLabel>
          </span>
          <span className={styles.trH}>
            触发 <MicroLabel>Trigger</MicroLabel>
          </span>
          <span className={styles.duH}>时长</span>
          {p.hours && <span className={styles.ctH}>今日</span>}
        </span>
        <span className={styles.colsEnd}>
          开关 <MicroLabel>On/Off</MicroLabel>
        </span>
      </div>
      <div className={styles.list} ref={listRef} role="grid" aria-label="全部动作">
        {p.groups.map((g) => {
          const shown = g.rows.filter((x) => (!onlyMiss || x.a.missing) && (!onlyImp || x.a.id in imported) && (!qq || `${x.a.label}${x.a.trigger ?? ''}`.includes(qq)));
          return (
            <div key={g.key} className={styles.grp} data-group={g.key} role="rowgroup">
              <div className={styles.gh}>
                <TitleBar
                  title={g.name}
                  micro={`Sec / ${(g.key || 'etc').toUpperCase()}`}
                  count={g.rows.filter((x) => p.value(x.a)).length}
                  total={g.rows.length}
                  {...(SECTIONS[g.key] && !compact ? { note: SECTIONS[g.key]?.note } : {})}
                />
              </div>
              {shown.map(row)}
              {shown.length === 0 && <div className={styles.none}>{onlyMiss ? '本组无缺资源动作' : onlyImp ? '本组无导入动作' : '无匹配动作'}</div>}
            </div>
          );
        })}
      </div>
      {!p.externalCommit && (
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
