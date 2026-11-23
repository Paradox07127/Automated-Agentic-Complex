import { ACTIVITY_LABEL, formatClock, formatMs } from '../../domain';
import { Btn, Menu } from '../../ui';
import { DarkRow, GameTable, StatusLamp, WhiteCapsule, type GameTableRow } from '../../ui/game';
import type { NowData, TaskGuess } from '../observe/data';
import type { InterpRun } from './data';
import { None, Panel, Reads } from './Detail';
import { median } from './model';
import styles from './Views.module.css';

/** Codes a correction may pick: everything but `unknown`. */
const CHOICES = Object.entries(ACTIVITY_LABEL).filter(([k]) => k !== 'unknown');

const COLS = [
  { key: 'at', label: '时间', width: '76px' },
  { key: 'ms', label: '用时', width: '60px' },
  { key: 'res', label: '结果', width: '84px' },
  { key: 'piece', label: '片段', width: 'minmax(0, 1fr)' },
];

export interface NowActs {
  onCorrect: (code: string | null, label: string) => void;
  onReject: (g: TaskGuess) => void;
  onClear: (types: string[]) => void;
}

/** 她现在的理解：焦点、推断 [更正]、任务 [否认]、本轮上下文 [清除]；唯一能当场纠正推断的地方。 */
function Now({ now, guess, onCorrect, onReject, onClear }: { now: NowData | null; guess: TaskGuess | null } & NowActs) {
  const act = now?.activity;
  const clearable = now?.items.filter((i) => i.clearable) ?? [];
  const key = (k: string) => <span className={styles.key}>{k}</span>;
  return (
    <div className={styles.now}>
      <DarkRow
        lead={key('焦点')}
        micro="FOCUS"
        title={
          now?.focus ? (
            <>
              <span className={styles.vh}>焦点：</span>
              {now.focus.app}
              {now.focus.dwellS != null && <small className={`${styles.dim} num`}>{Math.round(now.focus.dwellS / 60)} 分</small>}
            </>
          ) : (
            <span className={styles.dim}>无前台活动</span>
          )
        }
      />
      <DarkRow
        lead={key('推断')}
        micro="GUESS"
        title={
          act ? (
            <>
              <span className={styles.vh}>推断：</span>
              {act.label}
              {act.corrected && <span className={styles.chip}>已更正</span>}
            </>
          ) : (
            <span className={styles.dim}>还不确定</span>
          )
        }
        end={
          act && (
            <Menu
              label="更正"
              align="right"
              items={[
                { kind: 'head', label: '更正推断（一小时内按此理解）' },
                ...CHOICES.filter(([k]) => k !== act.code).map(([k, label]) => ({ kind: 'item' as const, label, onSelect: () => onCorrect(k, label) })),
                ...(act.corrected ? [{ kind: 'sep' as const }, { kind: 'item' as const, label: '撤销更正', onSelect: () => onCorrect(null, '') }] : []),
              ]}
            />
          )
        }
      />
      <DarkRow
        lead={key('任务')}
        micro="TASK"
        title={
          guess ? (
            <>
              <span className={styles.vh}>任务：</span>
              {guess.task}
              {guess.expiresAt != null && <small className={`${styles.dim} num`}>到 {formatClock(guess.expiresAt)}</small>}
            </>
          ) : (
            <span className={styles.dim}>没有推断</span>
          )
        }
        end={guess && <WhiteCapsule label="否认" icon="close" onClick={() => onReject(guess)} />}
      />
      <DarkRow
        lead={key('上下文')}
        micro="CONTEXT"
        title={
          now && now.items.length > 0 ? (
            <span className={styles.chips}>
              <span className={styles.vh}>本轮上下文：</span>
              {now.items.map((i) => (
                <span key={i.type} className={styles.chip}>
                  {i.label}
                </span>
              ))}
            </span>
          ) : (
            <span className={styles.dim}>本轮没有读取</span>
          )
        }
        end={clearable.length > 0 && <WhiteCapsule label="清除" icon="del" onClick={() => onClear(clearable.map((i) => i.type))} />}
      />
    </div>
  );
}

/** 理解：用时和失败读数；左边她现在的理解，右边今天每一次理解。 */
export function InterpView({
  runs,
  now,
  guess,
  selected,
  onSelect,
  onEpisode,
  ...acts
}: { runs: InterpRun[]; now: NowData | null; guess: TaskGuess | null; selected: string | null; onSelect: (id: string) => void; onEpisode: (id: number) => void } & NowActs) {
  const ok = runs.filter((r) => r.outcome !== 'failed');
  const fails = runs.length - ok.length;
  const p50 = median(ok.map((r) => r.durationMs));
  const rows: GameTableRow[] = runs.map((r) => {
    const failed = r.outcome === 'failed';
    const ep = r.episodeId;
    return {
      id: r.id,
      ...(failed ? { tone: 'fail' as const } : {}),
      cells: {
        at: <span className="num">{formatClock(r.at, { seconds: true })}</span>,
        ms: <span className="num">{formatMs(r.durationMs)}</span>,
        res: <StatusLamp state={failed ? 'failed' : 'ok'} label={failed ? '失败' : '完成'} />,
        piece: failed ? <span className={styles.bad}>{r.error ?? '理解失败'}</span> : (r.piece ?? '—'),
      },
      ...(ep != null
        ? {
            end: (
              <Btn size="sm" variant="ghost" onClick={() => onEpisode(ep)}>
                时间线
              </Btn>
            ),
          }
        : {}),
    };
  });
  return (
    <>
      {runs.length > 0 && (
        <Reads
          cells={[
            { value: p50 == null ? '—' : (p50 / 1000).toFixed(1), unit: p50 == null ? undefined : 's', label: '用时中位数' },
            { value: fails, label: '失败', tone: fails > 0 ? 'bad' : 'ink' },
            { value: <span className={styles.mono}>{runs[0]?.model ?? '—'}</span>, label: '模型', tone: 'ink', opt: true },
          ]}
        />
      )}
      <div className={styles.cols}>
        <Panel title="现在的理解" micro="CURRENT">
          <Now now={now} guess={guess} {...acts} />
        </Panel>
        <Panel title="最近理解" count={runs.length} micro="INTERPRET LOG">
          {rows.length > 0 ? <GameTable label="最近理解" columns={COLS} endWidth="auto" rows={rows} selected={selected} onSelect={onSelect} /> : <None title="今天还没有理解记录" icon="kernel" />}
        </Panel>
      </div>
    </>
  );
}
