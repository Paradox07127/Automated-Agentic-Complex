import { act as flush, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import type { StackCard as DomainStackCard } from '../../src/domain';
import { stackScenario } from '../../src/mock/stack';
import { keyActionFor } from '../../src/surfaces/stack/keys';
import type { StackCard } from '../../src/surfaces/stack/model';
import { useStackActions } from '../../src/surfaces/stack/useStackActions';
import { stubMatchMedia } from './mediaStub';

// Reminder fold and replies, and the stack actions only call routes the stack surface may send.

stubMatchMedia();
// The stack page runs on the stack surface; getBridge() builds its fake for the surface named here.
document.documentElement.dataset.surface = 'stack';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = '';
});

function cardOf(scenario: string, pick: (c: StackCard) => boolean): StackCard {
  const c = stackScenario(scenario).cards.find(pick);
  if (!c) throw new Error(`no matching card in ${scenario}`);
  return c;
}

const reminder = cardOf('delivery', (c) => c.kind === 'notice' && c.variant === 'reminder') as Extract<DomainStackCard, { kind: 'notice' }>;
const commitment = reminder.commitment_id!;

describe('reminder card', () => {
  it('esc on the top reminder folds it', () => {
    expect(keyActionFor(reminder, 'Escape')).toEqual({ type: 'collapse', id: reminder.id });
  });
});

function reminderHook() {
  const dispatch = vi.fn();
  const toast = vi.fn();
  const { result } = renderHook(() => useStackActions(dispatch, () => 0, true, { toast, setPause: vi.fn() }, () => reminder));
  const texts = () => toast.mock.calls.map((c) => (c[0] as { text: string }).text);
  return { act: result.current.act, dispatch, toast, texts };
}

describe('reminder replies from agentd', () => {
  it('a 503 完成 says so in Chinese, without the English code', async () => {
    vi.spyOn(getBridge().agentd, 'request').mockResolvedValue({ status: 503, body: null, error: { code: 'no_commitments' } });
    const h = reminderHook();
    await flush(async () => h.act({ type: 'complete', id: reminder.id, commitment }));
    expect(h.texts()).toHaveLength(1);
    expect(h.texts()[0]).toMatch(/^没能完成提醒/);
    expect(h.texts()[0]).not.toMatch(/[a-z_]{3,}/);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('a request the bridge refused is a failure, not a 完成', async () => {
    vi.spyOn(getBridge().agentd, 'request').mockResolvedValue({ status: 0, body: null, error: { code: 'surface_not_allowed' } });
    const h = reminderHook();
    await flush(async () => h.act({ type: 'complete', id: reminder.id, commitment }));
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.toast.mock.calls.map((c) => (c[0] as { tone?: string }).tone)).toEqual(['danger']);
  });

  it('延后 waits for agentd: a failure keeps the card and says so in Chinese', async () => {
    vi.spyOn(getBridge().agentd, 'request').mockResolvedValue({ status: 503, body: null, error: { code: 'no_commitments' } });
    const h = reminderHook();
    await flush(async () => h.act({ type: 'snooze', id: reminder.id, commitment, minutes: 15 }));
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.texts()).toHaveLength(1);
    expect(h.texts()[0]).toMatch(/^没能延后提醒/);
    expect(h.texts()[0]).not.toMatch(/[a-z_]{3,}/);
  });
});

describe('the stack page calls only what the stack surface allows', () => {
  it('resuming quiet sends {until: null}', async () => {
    const request = vi.spyOn(getBridge().agentd, 'request').mockResolvedValue({ status: 200, body: {} });
    const setPause = vi.fn();
    const toast = vi.fn();
    const now = 1_800_000_000_000;
    const { result } = renderHook(() => useStackActions(vi.fn(), () => now, true, { toast, setPause }, () => undefined));
    await flush(async () => result.current.resume('quiet'));
    expect(request).toHaveBeenCalledWith('PUT', '/observation/quiet', { until: null });
    expect(setPause).toHaveBeenLastCalledWith(null);
  });

  it('a request the bridge refused (status 0) is not reported as done', async () => {
    vi.spyOn(getBridge().agentd, 'request').mockResolvedValue({ status: 0, body: null, error: { code: 'surface_not_allowed' } });
    const setPause = vi.fn();
    const toast = vi.fn();
    const { result } = renderHook(() => useStackActions(vi.fn(), () => 0, true, { toast, setPause }, () => undefined));
    await flush(async () => result.current.resume('meeting'));
    expect(setPause).not.toHaveBeenCalled();
    expect(toast.mock.calls.map((c) => (c[0] as { tone: string }).tone)).toEqual(['danger']);
  });
});
