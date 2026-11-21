import { Timeline } from '../../charts';
import { useDevMode } from '../../shell/devMode';
import { InfoTip, Plate, Region, type RegionSource } from '../../ui';
import { briefLanes } from './briefModel';
import type { OverviewSnapshot } from './load';
import type { OverviewBrief } from './loadBrief';
import type { Go, NavTarget } from './nav';
import { summaryText } from './today';
import styles from './Brief.module.css';

export interface BriefProps {
  /** The brief's reads and the snapshot together. */
  q: RegionSource<unknown>;
  snap: OverviewSnapshot;
  brief: OverviewBrief | undefined;
  now: number;
  go: Go;
}

interface NumProps {
  k: string;
  v: number | null;
  of?: number | null;
  to: string;
  target: NavTarget;
  mark?: boolean;
  /** Why `v` could not be read. */
  why?: string | null;
  go: Go;
}

/** A big number that opens the page behind it. */
function Num({ k, v, of, to, target, mark, why, go }: NumProps) {
  return (
    <div className={styles.metric}>
      <button type="button" className={styles.num} onClick={() => go(target)} aria-label={`${k} ${v ?? '没读到'}${of != null ? ` / ${of}` : ''}，前往${to}`}>
        <span className={styles.k}>
          {mark && <i className={styles.mk} aria-hidden="true" />}
          {k}
          <span className={styles.to}>{to} ›</span>
        </span>
        <span className={styles.v}>
          {v ?? '—'}
          {of != null && <small>/{of}</small>}
        </span>
      </button>
      {v == null && <div className={styles.reason}><InfoTip label={`${k}计数没读到的原因`}>{`没读到：${why ?? '原因不明'}`}</InfoTip></div>}
    </div>
  );
}

/** 03 工业简报（板）：标题、一句话小结、2 个数字链接、3 条泳道的今日时间轴，提醒画在刻度尺上。 */
export function Brief({ q, snap, brief, now, go }: BriefProps) {
  const shots = snap.quota?.screenshots ?? null;
  // The title stays while the brief loads or fails; the summary and numbers need the reads.
  const ready = q.data !== undefined && brief;
  const devMode = useDevMode();
  return (
    <div className={styles.wrap}>
      <Plate no="03" label="工业简报">
        <div className={styles.bh}>
          <div className={styles.bt}>
            <h3>工业简报</h3>
          </div>
          {ready && (
            <>
              <p className={styles.sum}>{summaryText(snap, ready, now)}</p>
              {devMode && (
                <div className={styles.nums}>
                  <Num k="截图" v={shots?.used ?? null} of={shots?.limit ?? null} why={snap.diag_error} to="管线" target={{ page: 'pipeline' }} go={go} />
                  <Num k="出错" v={snap.errors.length} to="诊断" target={{ page: 'diag' }} mark={snap.errors.length > 0} go={go} />
                </div>
              )}
            </>
          )}
        </div>
        {/* The shell lands reminders here (/overview?focus=reminders): they are the ▼ on the ruler inside. */}
        <div className={styles.reg} data-nav-target="reminders">
          <Region q={q} what="工业简报" reserve={{ height: 120 }} skel="chart">
            {() => {
              if (!brief) return null;
              const tl = briefLanes(snap, brief, now);
              return (
                <div className={styles.tl}>
                  <Timeline
                    label="今日时间轴"
                    st="ok"
                    empty="今天还没有活动"
                    lanes={tl.lanes}
                    t0={tl.t0}
                    t1={tl.t1}
                    now={now}
                    axisMarks={tl.marks}
                    labelW={76}
                    frame={false}
                    onPick={(it) => it.to && go(it.to as NavTarget)}
                  />
                </div>
              );
            }}
          </Region>
        </div>
      </Plate>
    </div>
  );
}
