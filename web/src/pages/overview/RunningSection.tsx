import { useRef, useState, type ReactNode } from 'react';
import { formatDuration, type ActiveRun, type Session, type VisualStateKey } from '../../domain';
import { useDevMode } from '../../shell/devMode';
import { Btn, Empty, Fold, fxCalm, Icon, Missing, Region, StatusTag, type IconName, type RegionSource } from '../../ui';
import { StatusLamp } from '../../ui/game';
import type { RunRow } from './briefModel';
import { Selected, TrackTip, useCellIn, type MissionTone } from './MissionFx';
import type { Go } from './nav';
import shared from './Page.module.css';
import styles from './RunningSection.module.css';

export interface RunningSectionProps {
  /** The `/sessions` and `/agent/runs` read. */
  q: RegionSource<unknown>;
  rows: RunRow[];
  convs: number;
  /** Coding sessions in the rows; undefined with 编码会话 off. */
  code?: number | undefined;
  activeRuns: Record<string, ActiveRun>;
  now: number;
  /** Plans were lost on a feed reset: step counts wait for the next plan event. */
  lost: boolean;
  go: Go;
  onJumpSession: (session: Session) => void;
  /** Count of enabled schedules (`enabled === true`); undefined with 个人代理 off, which leaves out the 定时任务 link. */
  schedules?: number | undefined;
}

/** At most this many rows; the rest fold into 「另有 N 个」. */
const SHOWN = 3;

const CODE_STATE: Readonly<Record<string, [VisualStateKey, string]>> = {
  running_tool: ['running_tool', '在跑'],
  running: ['running', '进行中'],
  accepted: ['running', '进行中'],
  thinking: ['thinking', '在想'],
  compacting: ['thinking', '整理上下文'],
  subagent: ['running', '子任务执行中'],
  awaiting_approval: ['awaiting_approval', '待批准'],
  awaiting_input: ['awaiting_input', '待回答'],
  idle: ['idle', '空闲'],
};

const RUN_LABEL: Readonly<Record<string, string>> = { thinking: '在想', running_tool: '在跑', awaiting_approval: '待批准', awaiting_input: '待回答', waiting_user: '待回答' };

const dirOf = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? cwd;

/** How long a row has run; under a second reads 刚开始. */
const elapsed = (ms: number) => (ms < 1000 ? '刚开始' : formatDuration(ms));

interface LineProps {
  icon: IconName;
  title: string;
  meta: ReactNode;
  /** The full last line when `meta` is not plain text. */
  metaTitle?: string;
  state: ReactNode;
  cap: ReactNode;
  label: string;
  onClick: () => void;
  /** Running work has a solid ink frame, background work a dashed one, idle work a chip fill. */
  frame?: 'run' | 'bg' | 'idle';
  /** Waits on you: the selection is drawn in yellow. */
  wait?: boolean;
}

const WAIT = new Set(['awaiting_approval', 'awaiting_input', 'waiting_user']);

/** A run waiting on the user keeps the yellow block; any other state is a lamp. */
const Mark = ({ state, label }: { state: VisualStateKey; label: string }) => (WAIT.has(state) ? <StatusTag state={state} label={label} /> : <StatusLamp state={state} label={label} />);

/** One record row: an icon slot, title and last line, state and a caption at the right; focus selects it as a mission cell. */
function Line({ icon, title, meta, metaTitle, state, cap, label, onClick, frame, wait }: LineProps) {
  const [sel, setSel] = useState(false);
  const [tip, setTip] = useState(false);
  const ic = useRef<HTMLSpanElement>(null);
  const tone: MissionTone = wait ? 'yellow' : frame === 'bg' ? 'green' : 'blue';
  const select = () => {
    setSel(true);
    setTip(!fxCalm());
  };
  return (
    <button type="button" className={styles.rr} data-frame={frame} data-sel={sel || undefined} onClick={onClick} onFocus={select} onBlur={() => setSel(false)} aria-label={label}>
      {sel && <Selected tone={tone} />}
      <span ref={ic} className={styles.rrIc} aria-hidden="true" data-g="ringOuter">
        <Icon name={icon} size={16} />
        {tip && <TrackTip root={ic} tone={tone} onDone={() => setTip(false)} />}
      </span>
      <span className={styles.rrB}>
        <span className={styles.rrT}>{title}</span>
        <span className={styles.rrM} title={typeof meta === 'string' ? meta : metaTitle}>
          {meta}
        </span>
      </span>
      <span className={styles.rrA}>
        {state}
        <span className={styles.cap}>{cap}</span>
      </span>
    </button>
  );
}

function Row({ r, p }: { r: RunRow; p: RunningSectionProps }) {
  const { go, now } = p;
  const devMode = useDevMode();
  if (r.k === 'conv') {
    const c = r.conv;
    const ago = Math.max(1, Math.round((now - c.updated_at) / 60_000));
    return (
      <Line
        icon="send"
        frame={c.busy ? 'run' : 'idle'}
        title={c.title}
        meta={c.last ? `「${c.last}」` : '还没有回复'}
        state={c.busy ? <StatusLamp state="running" label="执行中" /> : <span className={styles.cap}><span className="num">{ago}</span> 分钟前</span>}
        cap={devMode && <>第 <span className="num">{c.turn_count}</span> 轮</>}
        label={`对话「${c.title}」，前往对话页`}
        onClick={() => go({ page: 'chat', conv: c.id })}
      />
    );
  }
  if (r.k === 'task') {
    const t = r.task;
    const run = p.activeRuns[t.id];
    const steps = run?.plan && !p.lost ? run.plan.steps : [];
    const step = steps.find((s) => s.status === 'in_progress' || s.status === 'waiting');
    const label = run ? (RUN_LABEL[run.state] ?? '执行中') : '执行中';
    return (
      <Line
        icon="bolt"
        frame="bg"
        wait={WAIT.has(run?.state ?? '')}
        title={t.title || '已撤回的任务'}
        meta={`角色任务 │ ${run?.tool ?? step?.text ?? label}`}
        state={<Mark state={run?.state ?? 'running'} label={label} />}
        cap={steps.length ? <>步骤 <span className="num">{steps.filter((s) => s.status === 'completed').length + (step ? 1 : 0)}/{steps.length}</span></> : <span className="num">{run ? elapsed(now - run.started_at) : <Missing why="na" />}</span>}
        label={`角色任务「${t.title}」，${label}，打开任务详情`}
        onClick={() => go({ page: 'tasks', sel: t.id })}
      />
    );
  }
  const s = r.session;
  const [state, text] = CODE_STATE[s.state] ?? ['running', '进行中'];
  return (
    <Line
      icon="tool"
      frame={s.state === 'idle' ? 'idle' : s.kind === 'ext' ? 'bg' : 'run'}
      wait={WAIT.has(s.state)}
      title={s.title}
      meta={
        <>
          {s.agent} │ <span className={styles.mono}>{dirOf(s.cwd)}</span>
          {s.last_line ? ` │ 「${s.last_line}」` : ''}
        </>
      }
      metaTitle={`${s.agent} │ ${dirOf(s.cwd)}${s.last_line ? ` │ 「${s.last_line}」` : ''}`}
      state={<Mark state={state} label={text} />}
      cap={<span className="num">{elapsed(now - (r.started ?? s.since))}</span>}
      label={`${s.agent} │ ${s.title}，${text}，${s.task_id ? '打开任务详情' : '前往编码会话'}`}
      onClick={() => {
        if (s.task_id) go({ page: 'tasks', sel: s.task_id });
        else p.onJumpSession(s);
      }}
    />
  );
}

/** A list cell; it fades in as a mission cell. */
function Cell({ run, children }: { run?: string; children: ReactNode }) {
  const ref = useCellIn<HTMLLIElement>();
  return (
    <li ref={ref} data-run={run} data-nav-target={run && `task-${run}`} data-g="cell">
      {children}
    </li>
  );
}

const titleOf = (r: RunRow) => (r.k === 'conv' ? r.conv.title : r.k === 'task' ? r.task.title || '已撤回的任务' : r.session.title);

/**
 * 02 进行中：执行中的对话、角色任务和编码会话，最多 3 行，其余收进「另有 N 个」折叠段。
 * 收起的行里等你的不自动打开：它们要你做的事在 01 待处理。
 */
export function RunningSection(p: RunningSectionProps) {
  const { rows, go } = p;
  const shown = rows.slice(0, SHOWN);
  const hidden = rows.slice(SHOWN);
  const loaded = p.q.data !== undefined;
  const cells = (list: RunRow[]) =>
    list.map((r) => (
      <Cell key={r.id} run={r.id}>
        <Row r={r} p={p} />
      </Cell>
    ));
  return (
    <div className={shared.run}>
      <Fold
        id="running"
        variant="head"
        label="进行中"
        head={{ no: '02' }}
        count={loaded ? rows.length : undefined}
        defaultOpen
        autoOpen={p.q.status === 'error'}
        right={
          <>
            {loaded && (
              <span className={styles.headCap}>
                对话 <span className="num">{p.convs}</span>
                {p.code !== undefined && (
                  <>
                    {' '}│ 编码 <span className="num">{p.code}</span>
                  </>
                )}
              </span>
            )}
            {p.schedules !== undefined && (
              <Btn size="sm" variant="text" onClick={() => go({ page: 'tasks', tab: 'sched' })}>
                {p.schedules > 0 ? (
                  <>
                    定时任务 │ <span className="num">{p.schedules}</span> 个开着
                  </>
                ) : (
                  '定时任务'
                )}
              </Btn>
            )}
          </>
        }
      >
        {/* Three rows high. */}
        <Region q={p.q} what="进行中的工作" reserve={{ height: 180 }} skel="rows" isEmpty={() => false}>
          {() => (
            <>
              <ul className={styles.rows} aria-label="进行中">
                {cells(shown)}
                {p.code === 0 && (
                  <Cell>
                    <Empty inline title="当前没有编码会话" />
                  </Cell>
                )}
              </ul>
              {hidden.length > 0 && (
                <div className={styles.rest}>
                  <Fold id="running-rest" label={`另有 ${hidden.length} 个`} summary={hidden.map(titleOf).join(' │ ')}>
                    <ul className={styles.rows} aria-label="进行中的其余">
                      {cells(hidden)}
                    </ul>
                  </Fold>
                </div>
              )}
            </>
          )}
        </Region>
      </Fold>
    </div>
  );
}
