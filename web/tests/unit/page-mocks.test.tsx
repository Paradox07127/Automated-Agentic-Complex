// Page leftovers: task mocks in agentd's shapes, the run plan item, activity labels in Chinese, the overview
// kernel-off demo and the motions save reason.
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import { createDispatcher } from '../../src/bridge/fake/agentd';
import { exampleRoutes } from '../../src/bridge/fake/endpoints';
import { ACTIVITY_LABEL, activityLabel } from '../../src/domain';
import { mockRoutes, type MockRoute } from '../../src/mock';
import { MOTIONS } from '../../src/mock/character';
import { NOW, WIRE_INTERACTIONS, WIRE_TASK_ROWS } from '../../src/mock/fixtures';
import { T1 } from '../../src/mock/fixtures/ids';
import { NO_REASON } from '../../src/pages/character/labels';
import { MotionTable } from '../../src/pages/character/MotionTable';
import { groupMotions, useMotions } from '../../src/pages/character/useMotions';
import { useOverview } from '../../src/pages/overview/useOverview';
import { loadOverview } from './overviewReads';

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const dispatch = (extra: MockRoute[] = []) => createDispatcher([...exampleRoutes, ...mockRoutes, ...extra]);
const serve = (extra: MockRoute[] = []) => {
  const d = dispatch(extra);
  return vi.spyOn(getBridge().agentd, 'request').mockImplementation((method, path, body) => d(method, path, body));
};

/** jobs.py JOB_COLUMNS without the private payload: what job_record returns. */
const JOB_KEYS = ['job_id', 'goal_id', 'title', 'state', 'run_id', 'previous_run_id', 'result', 'created_at', 'updated_at', 'conversation_id', 'source_turn_id', 'generation'].sort();

describe('task mocks answer what the task and chat pages send', () => {
  const job = T1.slice('job:'.length);
  const row = WIRE_TASK_ROWS.find((r) => r.canonical_task_id === T1)!;

  it('POST /agent/jobs and /agent/jobs/{id}/resume answer 202 with the job record', async () => {
    const d = dispatch();
    const created = await d('POST', '/agent/jobs', { title: '周报', text: '整理这周的提交' });
    expect(created.status).toBe(202);
    expect(Object.keys(created.body as object).sort()).toEqual(JOB_KEYS);
    const resumed = await d('POST', `/agent/jobs/${job}/resume`, { text: '按作者拆一列', use_current_backend: true });
    expect(resumed.status).toBe(202);
    const body = resumed.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(JOB_KEYS);
    expect(body).toMatchObject({ job_id: job, state: 'queued', previous_run_id: row.run_id, generation: row.generation + 1 });
  });

  it('POST /tasks/{id}/continue resumes the owning job (http.py), else 404 for a task that is not the character’s', async () => {
    const d = dispatch();
    const r = await d('POST', `/tasks/character-${row.run_id}/continue`, { text: '继续' });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ job_id: job, state: 'queued' });
    expect((await d('POST', '/tasks/nope/continue', { text: '' })).status).toBe(404);
  });

  it('accept / reject and dismiss answer without a 404', async () => {
    const d = dispatch();
    const q = WIRE_INTERACTIONS[0]!;
    expect((await d('POST', `/agent/interactions/${q.request_id}/dismiss`, { expected_version: q.revision })).body).toEqual({ dismissed: true });
    const delivery = row.delivery!;
    const body = { expected_revision: delivery.revision, generation: delivery.generation, delivery_id: delivery.delivery_id };
    expect((await d('POST', `/agent/tasks/${T1}/accept`, body)).status).toBe(200);
    expect((await d('POST', `/agent/tasks/${T1}/reject`, body)).status).toBe(200);
  });

  it('a run keeps its plan as the runtime.py plan item', async () => {
    const r = await dispatch()('GET', `/agent/runs/${row.run_id}/items`, undefined);
    const plan = (r.body as { items: Array<Record<string, unknown>> }).items.find((i) => i.kind === 'plan');
    expect(plan).toMatchObject({ run_id: row.run_id, item_id: `${row.run_id}:plan`, text: '' });
    expect(plan?.seq).toBeGreaterThanOrEqual(1);
    expect((plan?.steps as Array<Record<string, unknown>>).every((s) => Object.keys(s).sort().join() === 'status,text')).toBe(true);
  });
});

describe('activity labels live in domain', () => {
  it('names every activity.py activity in Chinese and an unknown id 其他活动', () => {
    expect(ACTIVITY_LABEL.editing_code).toBe('写代码');
    expect(activityLabel('editing_code')).toBe('写代码');
    expect(activityLabel('juggling')).toBe('其他活动');
  });

  it('the overview reads the current activity from /diag/state context and shows it in Chinese', async () => {
    const diag = (activity: string | null) => [{ method: 'GET' as const, path: '/diag/state', handler: () => ({ status: 200, body: { context: { activity: activity && { activity, confidence: 0.9, corrected: false, until: null, mode: 'rule', state: 'stable' } } } }) }];
    serve(diag('watching_video'));
    expect((await loadOverview(null, false)).activity).toBe('看视频');
    vi.restoreAllMocks();
    serve(diag('juggling'));
    const s = await loadOverview(null, false);
    expect(s.activity).toBe('其他活动');
  });
});

describe('overview kernel read', () => {
  it('reads /character/runtime?demo=logged-out under the fake bridge for demo kernel-off', async () => {
    const spy = serve();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const hook = renderHook(() => useOverview('kernel-off', null), { wrapper });
    await waitFor(() => expect(hook.result.current.data.health?.runtime.ready).toBe(false));
    expect(spy.mock.calls.filter(([, p]) => p.startsWith('/character/runtime'))).toEqual([['GET', '/character/runtime?demo=logged-out', undefined]]);
    expect(hook.result.current.data.kernel?.runtime.authenticated).toBe(false);
  });
});

/** The character motion table with its save logic. */
function Motions({ toast }: { toast: (m: string) => void }) {
  const m = useMotions({ actions: MOTIONS, toast });
  return (
    <MotionTable
      groups={groupMotions(MOTIONS)}
      value={m.value}
      changed={m.changed}
      sel=""
      onSel={() => {}}
      onToggle={m.toggle}
      hours={null}
      offline={false}
      lock={false}
      sparse={false}
      saving={m.saving}
      onUndo={m.undo}
      onSave={m.save}
    />
  );
}

describe('small fixes', () => {
  it('motions: an adjusted reason the page does not know says NO_REASON, not the code', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    window.agenticComplex = bridge;
    const toast = vi.fn();
    vi.spyOn(bridge.avatar, 'setActionSwitches').mockResolvedValue({ switches: { nod: true }, adjusted: [{ id: 'nod', reason: 'host_policy_x' }] });
    render(<Motions toast={toast} />);
    const nod = screen.getByRole('switch', { name: '点头附和' });
    expect(nod.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(nod);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(String(toast.mock.calls[0]?.[0])).toContain(NO_REASON);
    expect(String(toast.mock.calls[0]?.[0])).not.toContain('host_policy_x');
  });

  it('motions: a name cut by the column keeps its full text as the tooltip', () => {
    window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
    render(<Motions toast={vi.fn()} />);
    expect(screen.getByText('点头附和').getAttribute('title')).toBe('点头附和');
  });
});
