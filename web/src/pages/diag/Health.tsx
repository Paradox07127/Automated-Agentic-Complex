import type { ReactNode } from 'react';
import type { AppInfo } from '../../bridge/protocol';
import { formatClock, type Health as HealthData } from '../../domain';
import { HealthChain } from '../../features/health';
import { Btn, Skel } from '../../ui';
import type { Go } from '../overview/nav';
import type { DiagIssue } from './status';
import styles from './Dg.module.css';

export interface HealthRowProps {
  health: HealthData | null;
  now: number;
  issues: DiagIssue[];
  /** Observation reads window text only (screenshot sharing is off). */
  textOnly: boolean;
  /** agentd is gone; the data below is from this time. */
  staleAt: number | null;
  go: Go;
  onNode: (n: 'agentd' | 'runtime' | 'avatar' | 'voice') => void;
  onRestartAgentd: () => void;
  onVoiceReset: () => void;
  /** Where the web files and agentd come from; null before it is read. */
  source: AppInfo | null;
  /** The process rows, read apart from /diag/state. */
  children?: ReactNode;
}

/** Health strip: the alert when agentd is gone, the link chain, each problem as a mark, text and its fix, then the processes. */
export function HealthRow({ health, now, issues, textOnly, staleAt, go, onNode, onRestartAgentd, onVoiceReset, source, children }: HealthRowProps) {
  return (
    <div className={styles.health}>
      {staleAt != null && (
        <div className={styles.alert} role="alert">
          <span className={styles.icD} aria-hidden="true">
            !
          </span>
          <span>
            后台服务无响应{staleAt > 0 && ' │ 数据截至 '}
            {staleAt > 0 && <span className="num">{formatClock(staleAt)}</span>}
          </span>
          <span className={styles.sp} />
          <Btn variant="secondary" size="sm" tail="refresh" onClick={onRestartAgentd}>
            重启后台服务
          </Btn>
        </div>
      )}
      <div className={styles.healthR}>
        <div className={styles.hch}>{health ? <HealthChain layout="wide" health={health} now={now} onNode={onNode} onVoiceReset={onVoiceReset} /> : <Skel rows={3} />}</div>
        {(issues.length > 0 || textOnly || source) && (
          <div className={styles.issues}>
            {issues.map((i) => (
              <span key={i.id} className={styles.issue} role="status" title={i.code}>
                <span className={styles.icA} aria-hidden="true">
                  ▲
                </span>
                {i.title}
                {i.detail && <span className={styles.t3}>{i.detail}</span>}
                {i.to && (
                  <Btn variant="text" size="sm" onClick={() => i.to && go(i.to)}>
                    前往设置
                  </Btn>
                )}
              </span>
            ))}
            {textOnly && <span className={styles.t3}>观察只读取窗口文字，不截图</span>}
            {source && <SourceLine info={source} />}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

/** 运行来源: the packaged app, or a dev deployment marked in the warning colour so a test does not run the wrong build. */
function SourceLine({ info }: { info: AppInfo }) {
  const dev = info.source === 'dev';
  return (
    <p className={styles.source} data-dev={dev || undefined}>
      {dev && (
        <span className={styles.icA} aria-hidden="true">
          ▲
        </span>
      )}
      <span className={styles.t3}>运行来源</span>
      {dev ? (
        <span>
          开发目录 │ <span className="num" data-selectable title={info.devCommit}>{info.devCommit.slice(0, 9) || '没有收据'}</span>
          {info.devDirty && ' │ 含未提交改动'}
        </span>
      ) : (
        <span>
          正式打包{info.buildGit && <> │ <span className="num">{info.buildGit.slice(0, 9)}</span></>}
        </span>
      )}
    </p>
  );
}
