import { ACTIVITY_LABEL, formatClock } from '../../domain';
import { Btn, Menu, Missing, Region, reasonOf, usePageIssue, type RegionSource } from '../../ui';
import type { NowData, TaskGuess } from './data';
import s from './Observe.module.css';

export interface NowBandProps {
  data: NowData | null;
  guess: TaskGuess | null;
  pausedUntil: number | null;
  /** Last activity time while nothing is in front (sparse). */
  lastActive: number | null;
  onCorrect: (code: string | null, label: string) => void;
  onReject: (g: TaskGuess) => void;
  onClear: (types: string[]) => void;
}

/** Height of the band with one row, so the sections below do not move when it arrives. */
const NOW_H = 46;
const always = () => false;

/** 现在 on its own read (/diag/state): a skeleton of the band's height while it loads; with nothing read, the cause goes to the page top. */
export function NowSlot({ q, ...band }: NowBandProps & { q: RegionSource<unknown> }) {
  const failed = q.status === 'error' && q.data === undefined ? reasonOf(q.error) : null;
  usePageIssue(failed != null ? { what: '现在', reason: failed, ...(q.refetch ? { retry: () => void q.refetch?.() } : {}) } : null);
  if (failed != null) {
    return (
      <section className={s.now} aria-label="现在">
        <Label />
        <span className={s.it}>
          <Missing why="failed" reason={failed} />
        </span>
      </section>
    );
  }
  return (
    <Region q={q} what="现在" reserve={{ height: NOW_H }} isEmpty={always}>
      {() => <NowBand {...band} />}
    </Region>
  );
}

/** Codes a correction may pick: everything but `unknown`. */
const CHOICES = Object.entries(ACTIVITY_LABEL).filter(([k]) => k !== 'unknown');

function Label() {
  return <span className={s.nowL}>现在</span>;
}

/** 现在（横带）：焦点、推断 [更正 ▾]、任务 [否认]、本轮上下文 [清除]；暂停时整条斜纹。 */
export function NowBand({ data, guess, pausedUntil, lastActive, onCorrect, onReject, onClear }: NowBandProps) {
  if (pausedUntil != null) {
    return (
      <div className={s.now} data-paused="" role="status" aria-label="现在">
        <Label />
        <span className={s.it}>
          <span className={s.k}>状态</span>
          <span>
            已暂停 │ 不截图、不读取窗口文字 │ <span className="num">{formatClock(pausedUntil)}</span> 恢复
          </span>
        </span>
      </div>
    );
  }
  const clearable = data?.items.filter((i) => i.clearable) ?? [];
  const act = data?.activity;
  return (
    <section className={s.now} aria-label="现在">
      <Label />
      <span className={s.it} title={data?.focus ? `${data.focus.app} — ${data.focus.title}` : undefined}>
        <span className={s.k}>焦点</span>
        {data?.focus ? (
          <>
            <b>{data.focus.app}</b>
            {data.focus.dwellS != null && <span className={`${s.cap} num`}>{Math.round(data.focus.dwellS / 60)} 分</span>}
          </>
        ) : (
          <span className={s.t2}>
            无前台活动
            {lastActive != null && (
              <>
                {' │ 上次活动 '}
                <span className="num">{formatClock(lastActive)}</span>
              </>
            )}
          </span>
        )}
      </span>
      {act && (
        <span className={s.it}>
          <span className={s.k}>推断</span>
          <span>{act.label}</span>
          {act.corrected && <span className={s.cap}>已更正</span>}
          <Menu
            label="更正"
            items={[
              ...CHOICES.filter(([k]) => k !== act.code).map(([k, label]) => ({
                kind: 'item' as const,
                label,
                onSelect: () => onCorrect(k, label),
              })),
              ...(act.corrected
                ? [
                    { kind: 'sep' as const },
                    {
                      kind: 'item' as const,
                      label: '撤销更正',
                      onSelect: () => onCorrect(null, ''),
                    },
                  ]
                : []),
            ]}
          />
        </span>
      )}
      {guess && (
        <span className={s.it}>
          <span className={s.k}>任务</span>
          <b>{guess.task}</b>
          <Btn size="sm" variant="text" onClick={() => onReject(guess)}>
            否认
          </Btn>
        </span>
      )}
      <span className={s.it}>
        <span className={s.k}>本轮上下文</span>
        {data && data.items.length > 0 ? (
          <>
            {data.items.map((i) => (
              <span key={i.type} className={s.tag}>
                {i.label}
              </span>
            ))}
            {clearable.length > 0 && (
              <Btn size="sm" variant="text" onClick={() => onClear(clearable.map((i) => i.type))}>
                清除
              </Btn>
            )}
          </>
        ) : (
          <span className={s.cap}>未读取</span>
        )}
      </span>
    </section>
  );
}
