// 每日简报的「她」「时间」页签：开关决定换哪一块，网站没有记录时不占位，时间页签里有这一天的时间线。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { DEFAULT_PINS, type BriefDay } from '../../src/pages/overview/briefDay';
import type { BriefTabProps } from '../../src/pages/overview/briefTabs';
import { HerTab } from '../../src/pages/overview/HerTab';
import { TimeTab } from '../../src/pages/overview/TimeTab';

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

const read = async (sw?: string) => {
  const bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  const r = await bridge.agentd.request<BriefDay>('GET', `/brief/day?date=2026-11-20${sw == null ? '' : `&sw=${sw}`}`);
  if (!r.body) throw new Error('no body');
  return r.body;
};

const draw = (tab: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{tab}</QueryClientProvider>);
// The time tab reads the demo flags from the URL for its timeline.
const routed = (tab: ReactNode) => {
  const router = createRouter({ routeTree: createRootRoute({ component: () => tab }), history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
};
const props = (day: BriefDay): BriefTabProps => ({ day, pins: DEFAULT_PINS, onPins: () => {}, go: () => {} });
const panel = (name: string) => screen.queryByRole('region', { name });

describe('brief her tab', () => {
  it('shows her tools when every switch is on', async () => {
    draw(<HerTab {...props(await read())} />);
    expect(panel('她替你动手')).not.toBeNull();
    expect(panel('她在桌面上')).toBeNull();
  });

  it('shows how often you touched her in the side column when voice is off', async () => {
    draw(<HerTab {...props(await read('scr,read'))} />);
    const side = screen.getByRole('region', { name: '她这一天' });
    expect(side.textContent).not.toContain('出声');
    expect(side.textContent).toContain('你碰她');
  });

  it('shows her desk and her voice when only voice is on', async () => {
    draw(<HerTab {...props(await read('voice'))} />);
    expect(panel('她替你动手')).toBeNull();
    expect(panel('她在桌面上')).not.toBeNull();
    const side = screen.getByRole('region', { name: '她这一天' });
    expect(side.textContent).toContain('出声');
  });

  it('names why she spoke by agentd’s label', async () => {
    const day = await read();
    draw(<HerTab {...props({ ...day, her: { ...day.her, why: [{ key: 'break', label: '提醒你休息', count: 2 }, { key: 'new_kind', label: 'new_kind', count: 1 }] } })} />);
    expect(screen.getByRole('img', { name: /^她为什么开口：/ }).getAttribute('aria-label')).toBe('她为什么开口：提醒你休息 2 次，new_kind 1 次');
  });
});

describe('brief time tab', () => {
  it('lists sites when there are any', async () => {
    routed(<TimeTab {...props(await read())} />);
    expect(await screen.findByRole('region', { name: '11 月 20 日时间线' })).not.toBeNull();
    expect(panel('应用')).not.toBeNull();
    expect(panel('网站')).not.toBeNull();
  });

  it('drops the sites panel when sites are empty', async () => {
    const day = await read('scr');
    expect(day.focus.sites).toEqual([]);
    routed(<TimeTab {...props(day)} />);
    expect(await screen.findByRole('region', { name: '应用' })).not.toBeNull();
    expect(panel('网站')).toBeNull();
  });
});
