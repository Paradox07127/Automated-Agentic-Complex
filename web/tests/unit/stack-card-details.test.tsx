import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAgentdTask, type CodingReview } from '../../src/domain';
import { stackScenario } from '../../src/mock/stack';
import { HudRoot } from '../../src/surfaces/desktop/HudRoot';
import { priorityOf, type StackCard } from '../../src/surfaces/stack/model';
import { StackCardView } from '../../src/surfaces/stack/StackCardView';
import { stubMatchMedia } from './mediaStub';

// Stack card leftovers and the resume notice.

stubMatchMedia();
// The stack page runs on the stack surface; getBridge() builds its fake for the surface named here.
document.documentElement.dataset.surface = 'stack';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = '';
});

function cardOf<K extends StackCard['kind']>(scenario: string, pick: (c: StackCard) => boolean): Extract<StackCard, { kind: K }> {
  const c = stackScenario(scenario).cards.find(pick);
  if (!c) throw new Error(`no matching card in ${scenario}`);
  return c as Extract<StackCard, { kind: K }>;
}

const isRole = (c: StackCard) => c.kind === 'question' && c.item.interaction_kind === 'approval';
const isPlainQuestion = (c: StackCard) => c.kind === 'question' && c.item.interaction_kind !== 'approval';

describe('question card emphasis', () => {
  it('a question card below the top one demotes 提交回答 to secondary', () => {
    const q = cardOf<'question'>('question', isPlainQuestion);
    render(<StackCardView card={q} index={2} total={2} top={false} now={0} act={() => {}} />);
    expect(screen.getByRole('button', { name: '提交回答' }).getAttribute('data-variant')).toBe('secondary');
  });

  it('the role-approval demo on the HUD shows a plain question beside it with one yellow primary button', async () => {
    expect(stackScenario('role-approval').cards.some(isPlainQuestion)).toBe(true);
    window.location.hash = '#/hud?demo=role-approval&still=1';
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <HudRoot />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^展开全部/ }));
    await screen.findByRole('button', { name: '批准' });
    await screen.findByRole('button', { name: '发送' });
    expect(container.querySelectorAll('[data-stub="Btn"][data-variant="primary"]').length).toBeLessThanOrEqual(1);
  });
});

describe('role approval ⋯ menu', () => {
  it('cancels the request with the card revision', () => {
    const card = cardOf<'question'>('role-approval', isRole);
    const act = vi.fn();
    render(<StackCardView card={card} index={1} total={1} top now={0} act={act} />);
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '取消这个请求' }));
    expect(act).toHaveBeenLastCalledWith({ type: 'cancel-question', id: card.id, expected_version: card.item.revision });
  });
});

describe('coding review task id', () => {
  it('is canonical and 打开任务 selects it', () => {
    // @ts-expect-error a coding review carries the canonical task id native pushes (`task:<id>`)
    const bare: CodingReview['task_id'] = 'not-canonical';
    expect(bare).toBe('not-canonical');
    const card = cardOf<'review'>('coding-review', (c) => c.kind === 'review' && c.source === 'coding');
    expect(isAgentdTask(card.item.task_id)).toBe(true);
    const act = vi.fn();
    render(<StackCardView card={card} index={1} total={1} top now={0} act={act} />);
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '打开任务' }));
    expect(act).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'open', to: { page: 'overview', sel: card.item.task_id } }));
  });
});

describe('done, brief and resume notices', () => {
  const variant = (v: string) => cardOf<'notice'>('notices', (c) => c.kind === 'notice' && c.variant === v);

  it('done and brief show their title and body; brief is a P3 hint', () => {
    for (const v of ['done', 'brief']) {
      const card = variant(v);
      render(<StackCardView card={card} index={1} total={1} top now={0} act={() => {}} />);
      screen.getByText(card.title);
      screen.getByText(card.body!);
      cleanup();
    }
    expect(priorityOf(variant('done'))).toBe(2);
    expect(priorityOf(variant('brief'))).toBe(3);
  });

  it('resume says the answer is saved and opens the task page at the card task', () => {
    const card = variant('resume');
    expect(card.task_id).toBeTruthy();
    const act = vi.fn();
    render(<StackCardView card={card} index={1} total={1} top now={0} act={act} />);
    screen.getByText('回答已保存 · 在主窗口继续');
    fireEvent.click(screen.getByRole('button', { name: '打开任务' }));
    expect(act).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'open', to: { page: 'overview', sel: card.task_id } }));
  });
});
