import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import { stackScenario } from '../../src/mock/stack';
import { StackCardView } from '../../src/surfaces/stack/StackCardView';
import type { StackCard } from '../../src/surfaces/stack/model';
import { HudRoot } from '../../src/surfaces/desktop/HudRoot';
import { stubMatchMedia } from './mediaStub';
import { A2 } from '../../src/mock/fixtures/ids';
import { fromInteraction, type Question } from '../../src/domain';
import { NOW, WIRE_INTERACTION_APPROVAL_DANGER } from '../../src/mock/fixtures';

// Role approvals, coding reviews, native reply codes on the HUD, and the onCards error push.

stubMatchMedia();
// The stack page runs on the stack surface; getBridge() builds its fake for the surface named here.
document.documentElement.dataset.surface = 'stack';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = '';
  delete window.agenticComplex;
});

function mount(hash: string) {
  window.location.hash = hash;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HudRoot />
    </QueryClientProvider>,
  );
}

function cardOf<K extends StackCard['kind']>(scenario: string, pick: (c: StackCard) => boolean): Extract<StackCard, { kind: K }> {
  const c = stackScenario(scenario).cards.find(pick);
  if (!c) throw new Error(`no matching card in ${scenario}`);
  return c as Extract<StackCard, { kind: K }>;
}

/** The native shim rejects with an Error carrying `code` and `detail` (the shim's `failure`). */
function nativeError(code: string, detail?: string) {
  return Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, detail });
}

describe('role approval card (interaction_kind approval)', () => {
  it('is the broker paper card with its question, countdown and preview, and answers every question with 允许 or 拒绝', () => {
    const card = cardOf<'question'>('role-approval', (c) => c.kind === 'question' && c.item.interaction_kind === 'approval');
    const act = vi.fn();
    const { container } = render(<StackCardView card={card} index={1} total={2} top now={stackScenario('role-approval').now} act={act} />);
    expect(container.querySelector('[data-stub="ApprovalCard"]')).toBeTruthy();
    expect(screen.queryByText(/APPROVAL/)).toBeNull();
    expect(container.querySelector('[data-stub="CountdownRing"]')).toBeTruthy();
    expect(screen.getByRole('heading', { name: card.item.questions[0]!.question })).toBeTruthy();
    expect(screen.getByText(/"path": "~\/Documents\/开销\/10 月\.xlsx"/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '会话 ↗' })).toBeNull();
    const ids = card.item.questions.map((q) => q.id);
    expect(ids.length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    expect(act).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'answer', id: card.id, expected_version: card.item.revision, answers: Object.fromEntries(ids.map((id) => [id, ['允许']])) }),
    );
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(act).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'answer', answers: Object.fromEntries(ids.map((id) => [id, ['拒绝']])) }));
    expect(screen.queryByText(/命中危险规则/)).toBeNull();
  });

  it('a dangerous call shows its rule and 批准 takes a second click', () => {
    const item = fromInteraction(WIRE_INTERACTION_APPROVAL_DANGER, NOW) as Question;
    expect([item.dangerous, item.danger_rule]).toEqual([true, 'rm_recursive']);
    const card: Extract<StackCard, { kind: 'question' }> = { id: item.id, kind: 'question', at: NOW, item };
    const act = vi.fn();
    render(<StackCardView card={card} index={1} total={1} top now={NOW} act={act} />);
    expect(screen.queryByText(/APPROVAL/)).toBeNull();
    expect(screen.getByText('命中危险规则：强制递归删除')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    expect(act).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认批准' }));
    expect(act).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'answer', id: card.id, answers: { decision: ['允许'] } }));
  });

  it('a timed-out role approval says the call did not run, with no 去终端', () => {
    const base = cardOf<'question'>('role-approval', (c) => c.kind === 'question' && c.item.interaction_kind === 'approval');
    const card = { ...base, item: { ...base.item, seconds_left: 0 } };
    render(<StackCardView card={card} index={1} total={1} top now={NOW} act={() => {}} />);
    expect(screen.getByText('已超时 │ 请求已失效')).toBeTruthy();
    expect(screen.getByText('后果：这次调用没有执行')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '去终端 ↗' })).toBeNull();
    expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
  });

  it('keeps plain questions on the question box', () => {
    const q = cardOf<'question'>('question', (c) => c.kind === 'question');
    render(<StackCardView card={q} index={1} total={1} top now={0} act={() => {}} />);
    expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
    expect(screen.getByRole('button', { name: '提交回答' })).toBeTruthy();
  });
});

describe('coding review card (review source coding)', () => {
  it('marks every review with its source', () => {
    const reviews = [...stackScenario('review').cards, ...stackScenario('coding-review').cards].filter((c) => c.kind === 'review');
    expect(new Set(reviews.map((c) => c.kind === 'review' && c.source))).toEqual(new Set(['delivery', 'coding']));
  });

  it('accepts and rejects without a delivery or a note', () => {
    const card = cardOf<'review'>('coding-review', (c) => c.kind === 'review' && c.source === 'coding');
    const act = vi.fn();
    const { container } = render(<StackCardView card={card} index={1} total={1} top now={0} act={act} />);
    expect(container.querySelector('[data-stub="DeliveryChain"]')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '接受' }));
    expect(act).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'accept', id: card.id, task_id: card.item.task_id }));
    fireEvent.click(screen.getByRole('button', { name: '驳回' }));
    expect(act).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'reject', id: card.id, task_id: card.item.task_id, note: '' }));
  });
});

describe('native decision reply codes', () => {
  it('turns a stale approval decision into a 「别处处理」 receipt, not a failure', async () => {
    vi.spyOn(getBridge().stack, 'decide').mockRejectedValue(nativeError('stale', 'approval_not_pending'));
    mount('#/hud?demo=default&still=1');
    // A2 waits on its session line, which the folded bar shows only once expanded.
    const bar = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-hud-bar]');
      if (!el) throw new Error('no bar');
      return el;
    });
    fireEvent.click(bar);
    const card = await waitFor(() => {
      const el = document.querySelector(`[data-card-id="${A2}"]`);
      if (!el) throw new Error('no card');
      return el as HTMLElement;
    });
    const deny = [...card.querySelectorAll('button')].find((b) => b.textContent?.includes('拒绝'));
    fireEvent.click(deny!);
    await waitFor(() => expect(card.textContent).toContain('这张卡被别处处理了'));
    expect(card.textContent).not.toContain('没能送达决定');
  });
});

describe('onCards error push', () => {
  it('the fake hands an {error} payload to onError, as the native shim does', async () => {
    window.location.hash = '#/?demo=offline';
    const bridge = createFakeBridge({ surface: 'stack' });
    const cb = vi.fn();
    const onError = vi.fn();
    bridge.stack.onCards(cb, onError);
    await waitFor(() => expect(onError).toHaveBeenCalledWith({ code: 'offline', detail: '后台已断开' }));
    expect(cb).not.toHaveBeenCalled();
  });
});
