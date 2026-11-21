import { useMemo, useState } from 'react';
import { useDemo } from '../../shell/demo';
import { useDevMode } from '../../shell/devMode';
import { Icon, Sheet } from '../../ui';
import { localDate, pageNow } from '../observe/data';
import { rankFromSegments, rankFromSummary } from '../observe/model';
import { StatsSec } from '../observe/StatsSec';
import { useObserve } from '../observe/useObserve';
import { WebSec } from '../observe/WebSec';
import { activityText, type ActivitySummary } from './today';
import s from './DayTimeline.module.css';

/** 前台时长 and 浏览器与网站 of today; the observe reads mount with the sheet. */
function ActivitySheet({ onClose }: { onClose: () => void }) {
  const flags = useDemo();
  const devMode = useDevMode();
  const d = useObserve(flags, localDate(pageNow()), undefined);
  const rank = useMemo(() => (d.spans ? rankFromSegments(d.spans.segs) : rankFromSummary(d.apps)), [d.spans, d.apps]);
  const paused = d.pausedUntil != null && d.pausedUntil > d.now;
  return (
    <Sheet open title="今天的前台与网站" width={480} onClose={onClose}>
      <div className={s.sheet}>
        <StatsSec
          no="01"
          rank={rank}
          spans={d.spans}
          shots={devMode && d.src.now.data !== undefined ? (d.nowData?.screenshots ?? null) : null}
          q={d.src.time}
          start={d.start}
          paused={paused}
          initialView="app"
        />
        <WebSec no="02" hosts={d.hosts} browser={paused ? d.browser && { ...d.browser, current: null } : d.browser} q={d.src.web} />
      </div>
    </Sheet>
  );
}

/** 前台 5 小时 12 分 · 最多 Xcode · 网站 48 分 ›; opens today's foreground and site time. */
export function ActivityLine({ a }: { a: ActivitySummary | null }) {
  const [open, setOpen] = useState(false);
  const text = activityText(a);
  return (
    <>
      <button type="button" className={s.act} data-activity="" aria-label={`${text}，查看详情`} onClick={() => setOpen(true)}>
        <span>{text}</span>
        <span className={s.go} aria-hidden="true">
          <Icon name="chev" size={14} />
        </span>
      </button>
      {open && <ActivitySheet onClose={() => setOpen(false)} />}
    </>
  );
}
