// Every overview section read at once, composed the way the page composes them; for tests that check the composed view.
import { errText } from '../../src/pages/overview/errors';
import { overviewOf, readDay, readRole, readRunning, readSnapshot, type OverviewSnapshot } from '../../src/pages/overview/load';

const ok = <T>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : undefined);
const err = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? errText(r.reason) : undefined);

/** Rejects as the 待处理 read does when `/agent/snapshot` fails. */
export async function loadOverview(demo: string | null, fail: boolean): Promise<OverviewSnapshot> {
  const snapshot = await readSnapshot(demo, fail);
  const [running, role, day] = await Promise.allSettled([readRunning({ sessions: true, runs: true }), readRole(demo), readDay(demo, snapshot.now)]);
  return overviewOf({ snapshot, running: ok(running), runningError: err(running), role: ok(role), day: ok(day), dayError: err(day) });
}
