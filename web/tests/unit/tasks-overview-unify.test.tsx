// 任务页和每日简报换用共用组件：验收条件 Fold、星期 Btn pressed、组头 SecHead、产物 ContextMenu、急事卡详情折叠、禁用原因。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { getBridge } from '../../src/bridge';
import { createDispatcher } from '../../src/bridge/fake/agentd';
import { exampleRoutes } from '../../src/bridge/fake/endpoints';
import { sortPending } from '../../src/domain';
import { mockRoutes } from '../../src/mock';
import { DELIVERIES, NOW, pick } from '../../src/mock/fixtures';
import { DLV_T1_V2 } from '../../src/mock/fixtures/ids';
import { ITEM_ORDER, type BriefDay } from '../../src/pages/overview/briefDay';
import { DetailTab } from '../../src/pages/overview/DetailTab';
import type { OverviewSnapshot } from '../../src/pages/overview/load';
import { OverviewPage } from '../../src/pages/overview/Page';
import { PendingSection } from '../../src/pages/overview/PendingSection';
import { Artifacts } from '../../src/pages/tasks/Artifacts';
import { CreateForm, draftFor } from '../../src/pages/tasks/CreateForm';
import { newDraft } from '../../src/pages/tasks/draft';
import { Editor } from '../../src/pages/tasks/Editor';
import { Group } from '../../src/pages/tasks/List';
import { loadOverview } from './overviewReads';
import { pluginsOn, pluginsReset } from './plugins';

const noop = async () => {};

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe('tasks page: shared components', () => {
  it('验收条件 in the create form is a Fold', () => {
    const onChange = vi.fn();
    render(<CreateForm draft={draftFor('role')} onChange={onChange} goals={[]} canPick onPickFolder={noop} />);
    const head = screen.getByRole('button', { name: /验收条件/ });
    expect(head.closest('[data-stub="Fold"]')).toBeTruthy();
    expect(head.textContent).not.toMatch(/[▸▾]/);
    fireEvent.click(head);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ acceptanceOpen: true }));
  });

  it('the weekday picker is a row of pressed Btns', () => {
    const onChange = vi.fn();
    render(<Editor draft={newDraft('sched')} onChange={onChange} who="管理员" scopes={[]} conversations={[]} canPick onPickFolder={noop} problem={null} now={NOW} />);
    const sat = screen.getByRole('button', { name: '周六' });
    expect(sat.getAttribute('data-stub')).toBe('Btn');
    expect(sat.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: '周一' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(sat);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ weekdays: [1, 2, 3, 4, 5, 6] }));
  });

  it('a group head is a SecHead with the count and the note behind ⓘ', () => {
    render(<Group group={{ key: 'run', title: '在跑', note: '角色任务和派出的编码会话', rows: [] }} start={0} selected={null} onSelect={noop} />);
    const head = screen.getByRole('heading', { name: '在跑' }).closest('[data-stub="SecHead"]');
    expect(head).toBeTruthy();
    expect(head?.textContent).toContain('0');
    expect(within(head as HTMLElement).getByRole('button')).toBeTruthy();
  });

  it("an artifact's right-click menu is the shared ContextMenu", () => {
    const arts = pick(DELIVERIES, DLV_T1_V2).artifacts;
    render(<Artifacts deliveries={[pick(DELIVERIES, DLV_T1_V2)]} canReveal={false} nativeOff={{}} onOpen={noop} onReveal={noop} onCopy={noop} onRevert={noop} />);
    fireEvent.contextMenu(within(screen.getByRole('group', { name: '产物' })).getByRole('button', { name: new RegExp(arts[0]!.name) }));
    expect(screen.getByRole('menu', { name: arts[0]!.name }).hasAttribute('data-context')).toBe(true);
  });
});

describe('每日简报: shared components', () => {
  let snap: OverviewSnapshot;
  beforeAll(async () => {
    const dispatch = createDispatcher([...exampleRoutes, ...mockRoutes]);
    const spy = vi.spyOn(getBridge().agentd, 'request').mockImplementation((method, path, body) => dispatch(method, path, body));
    snap = await loadOverview(null, false);
    spy.mockRestore();
  });

  it("the urgent card keeps its rule, folder and links in the card's closed 详情 fold", () => {
    const items = sortPending(snap.pending);
    const { container } = render(<PendingSection q={{ status: 'success', data: true }} items={items} now={NOW} at={NOW} sessions={snap.sessions} receipt={null} go={noop} onApprove={noop} onAnswer={noop} onReply={noop} onJumpSession={noop} />);
    const card = container.querySelector('[data-stub="ApprovalCard"]') as HTMLElement;
    expect(card.textContent).not.toContain('命中危险规则');
    const fold = within(card).getByRole('button', { name: /详情/ });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(fold);
    expect(card.textContent).toContain('命中危险规则');
  });

  it('a star that cannot be added is a round IconBtn that says why', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    const day = (await bridge.agentd.request<BriefDay>('GET', '/brief/day?date=2026-11-20')).body!;
    const pins = ITEM_ORDER.slice(0, 6);
    render(<DetailTab day={day} pins={pins} onPins={noop} go={noop} links={{}} />);
    const star = screen.getAllByRole('button', { name: /^放进总览：/ })[0]!;
    expect(star.getAttribute('data-stub')).toBe('IconBtn');
    expect(star.getAttribute('data-shape')).toBe('round');
    expect(star.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(star.getAttribute('aria-describedby')!)?.textContent).toMatch(/6/);
  });
});

describe('每日简报: the day pager says why it stops', () => {
  beforeEach(() => {
    pluginsReset();
    pluginsOn('daily_brief');
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    pluginsReset();
  });

  it('后一天 on today is disabled with a reason', async () => {
    const root = createRootRoute({ component: OverviewPage });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const next = await screen.findByRole('button', { name: '后一天' });
    await waitFor(() => expect(next.getAttribute('aria-disabled')).toBe('true'));
    expect(document.getElementById(next.getAttribute('aria-describedby')!)?.textContent).toContain('今天');
  });
});
