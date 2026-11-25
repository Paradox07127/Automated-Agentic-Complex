import type { ReactNode } from 'react';
import { formatClock } from '../domain';
import { Btn } from './Btn';
import { Icon } from './Icon';
import { useBannerAt, usePageIssue } from './PageIssues';
import { SkelShapes } from './Skel';
import { Spinner } from './Spinner';
import { useRegion, type RegionSource } from './useRegion';
import styles from './Region.module.css';

/** 区块占位：首次加载、读得慢、刷新中、空、出错有旧数据、出错没有数据、断开，同一套画法和文案。 */
export interface RegionProps<T> {
  /** react-query 结果，或者同样形状的对象 */
  q: RegionSource<T>;
  /** 错误文案里的对象名，例如「会话」 */
  what: string;
  /** 和正常态一样高：预计行数或像素高 */
  reserve?: { rows: number } | { height: number };
  /** 加载时骨架的形状，随区块内容；默认按 reserve：给行数画行，给高度画整块 */
  skel?: 'rows' | 'cards' | 'chart';
  /** 判空，默认空数组算空 */
  isEmpty?: (data: T) => boolean;
  /** 空态：一行原因，最多一个动作；默认「还没有<what>」 */
  empty?: { text: string; action?: ReactNode };
  /** 重试，默认 q.refetch */
  onRetry?: () => void;
  /** 有数据时的内容 */
  children: (data: T) => ReactNode;
}

const ROW_PX = 22;
const HEAD_PX = 26;

const reservedPx = (r: RegionProps<unknown>['reserve']) => (r == null ? undefined : 'height' in r ? r.height : HEAD_PX + r.rows * ROW_PX);

function Retry({ onRetry }: { onRetry?: (() => void) | undefined }) {
  if (!onRetry) return null;
  return (
    <>
      {' │ '}
      <button type="button" className={styles.link} onClick={onRetry}>
        重试
      </button>
    </>
  );
}

export interface RegionFailProps {
  /** 没读到的对象 */
  what: string;
  /** 原因 */
  reason: string;
  onRetry?: (() => void) | undefined;
}

/** 就地写的失败行「没有读到X：原因 · [重试]」；区块整体没数据时用它，部分读取失败时放在失败的那一块里。 */
export function RegionFail({ what, reason, onRetry }: RegionFailProps) {
  return (
    <p role="alert" className={styles.fail} data-region-fail="">
      <span className={styles.sq} aria-hidden="true" />
      <span>
        无法读取{what}：{reason}
        <Retry onRetry={onRetry} />
      </span>
    </p>
  );
}

export function Region<T>({ q, what, reserve, skel, isEmpty, empty, onRetry, children }: RegionProps<T>) {
  const v = useRegion(q, isEmpty);
  const retry = onRetry ?? (q.refetch ? () => void q.refetch?.() : undefined);
  const atPage = usePageIssue(v.state === 'stale' ? { what, reason: v.reason, at: v.at, retry } : null);
  const bannerAt = useBannerAt(v.state === 'offline' ? null : v.reason);
  const minHeight = reservedPx(reserve);
  const box = (extra: ReactNode, busy = false) => (
    <div className={styles.region} data-stub="Region" data-state={v.state} aria-busy={busy || undefined} style={{ minHeight }}>
      {extra}
    </div>
  );

  switch (v.state) {
    case 'wait':
      return box(null, true);
    case 'loading':
    case 'slow': {
      const rows = reserve && 'rows' in reserve ? reserve.rows : 0;
      const px = reservedPx(reserve) ?? 0;
      const shape = skel ?? (rows > 0 ? 'rows' : 'block');
      // Rows and cards fill the reserved height when only a height is given.
      const n = rows || (shape === 'cards' ? 2 : Math.max(2, Math.floor((px - 16) / ROW_PX)));
      return box(
        <>
          {v.state === 'slow' && (
            <p role="status" className={styles.head}>
              仍在读取 │ 已等 <span className={styles.num}>{v.waited}</span> 秒
              <Retry onRetry={retry} />
            </p>
          )}
          <SkelShapes shape={shape} rows={n} />
        </>,
        true,
      );
    }
    case 'failed':
      return box(<RegionFail what={what} reason={v.reason} onRetry={retry} />);
    case 'empty':
      return (
        <div className={styles.region} data-stub="Region" data-state="empty">
          <p role="status" className={styles.empty}>
            <Icon name="grid" size={14} />
            <span>{empty?.text ?? `尚无${what}`}</span>
            {empty?.action}
          </p>
        </div>
      );
    default: {
      const data = v.data as T;
      // The page banner already gives the time of the data below it; a section repeats it only when its own differs.
      const sameAsBanner = (v.state === 'offline' || atPage) && v.at != null && bannerAt != null && formatClock(v.at) === formatClock(bannerAt);
      const tag = (v.state === 'stale' || v.state === 'offline') && !sameAsBanner;
      return (
        <div className={styles.region} data-stub="Region" data-state={v.state}>
          {v.state === 'refreshing' && (
            <span className={styles.spin}>
              <Spinner label="正在刷新" />
            </span>
          )}
          {tag && (
            <p className={styles.tag} role="status">
              <span>
                {v.at != null ? (
                  <>
                    <span className={styles.num}>{formatClock(v.at)}</span> 的数据
                  </>
                ) : (
                  '之前读取的缓存数据'
                )}
              </span>
              {v.state === 'stale' && !atPage && (
                <span className={styles.why}>
                  读取失败：{v.reason}
                  <Retry onRetry={retry} />
                </span>
              )}
            </p>
          )}
          {children(data)}
        </div>
      );
    }
  }
}

const AT = new Date(2026, 9, 29, 14, 31).getTime();
const rows = ['新对话 │ 14:02', '整理周报 │ 13:40', '修复登录 │ 11:15'];
const list = (d: string[]) => (
  <ul className={styles.demoList}>
    {d.map((r) => (
      <li key={r}>{r}</li>
    ))}
  </ul>
);
const base = { what: '会话', reserve: { rows: 3 }, children: list } as const;

export const RegionDemos: Array<{ name: string; props: RegionProps<string[]> }> = [
  { name: 'ok', props: { ...base, q: { status: 'success', data: rows, dataUpdatedAt: AT } } },
  { name: 'loading', props: { ...base, q: { status: 'pending', data: undefined, isFetching: true } } },
  { name: 'slow', props: { ...base, q: { status: 'pending', data: undefined, isFetching: true, startedAt: Date.now() - 12_000, refetch: () => undefined } } },
  { name: 'refreshing', props: { ...base, q: { status: 'success', data: rows, isFetching: true, dataUpdatedAt: AT } } },
  { name: 'empty', props: { ...base, q: { status: 'success', data: [], dataUpdatedAt: AT }, empty: { text: '今天还没有会话', action: <Btn size="sm" variant="secondary">新对话</Btn> } } },
  { name: 'stale', props: { ...base, q: { status: 'error', data: rows, error: new Error('后台没有响应'), dataUpdatedAt: AT, refetch: () => undefined } } },
  { name: 'failed', props: { ...base, q: { status: 'error', data: undefined, error: new Error('后台没有响应'), refetch: () => undefined } } },
];
