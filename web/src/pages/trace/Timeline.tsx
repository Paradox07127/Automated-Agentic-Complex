import { useState } from 'react';
import { useDemo } from '../../shell/demo';
import { ActivityLine } from '../overview/ActivityLine';
import { DayTimeline, EpisodeSheet } from '../overview/DayTimeline';
import { useGo, useNow } from '../overview/nav';
import type { TimelineEntry } from '../overview/today';
import { useOverview } from '../overview/useOverview';
import { useToday } from '../overview/useToday';

/** 今日时间线: an episode opens here, a coding session opens on the briefing page, a conversation opens the chat. */
export function TraceTimeline() {
  const { state, demo, still } = useDemo();
  const go = useGo();
  const ov = useOverview(demo, state);
  const now = useNow(ov.data.now, still);
  const today = useToday(ov, demo, state, null, now);
  const [ep, setEp] = useState<string | null>(null);
  const open = (e: TimelineEntry) => {
    if (e.open.ep) setEp(e.open.ep);
    else if (e.open.sel) go({ page: 'overview', sel: e.open.sel });
    else if (e.open.conv) go({ page: 'chat', conv: e.open.conv });
  };
  return (
    <>
      <DayTimeline q={today.timeline} summaries={today.summaries} now={now} onOpen={open} right={<ActivityLine a={today.activity} />} />
      {ep && <EpisodeSheet ep={ep} onClose={() => setEp(null)} />}
    </>
  );
}
