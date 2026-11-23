import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { DEFAULT_PINS, type BriefDay } from '../../src/pages/overview/briefDay';
import { OverviewTab } from '../../src/pages/overview/OverviewTab';
import { initialStack, stackReducer } from '../../src/surfaces/stack/stackReducer';

afterEach(() => {
  delete window.agenticComplex;
});

describe('native focus and reminder landing', () => {
  it('a native push marked tab now brings the 历史 tab back to now', () => {
    const onHistory = { ...initialStack, tab: 'history' as const };
    const next = stackReducer(onHistory, { type: 'load', payload: { now: 1, cards: [], history: [], tab: 'now' } });
    expect(next.tab).toBe('now');
  });

  it('a push without a tab keeps the tab the user chose', () => {
    const onHistory = { ...initialStack, tab: 'history' as const };
    expect(stackReducer(onHistory, { type: 'load', payload: { now: 1, cards: [], history: [] } }).tab).toBe('history');
  });

  it('the brief’s 提醒 panel is the landing target for /overview?focus=reminders', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    window.agenticComplex = bridge;
    const day = (await bridge.agentd.request<BriefDay>('GET', '/brief/day?date=2026-11-20')).body!;
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <OverviewTab day={day} pins={DEFAULT_PINS} onPins={() => {}} go={() => {}} links={{}} isToday line={undefined} pending={null} running={null} done={undefined} convs={undefined} reminders={[]} onTask={() => {}} goPage={() => {}} />
      </QueryClientProvider>,
    );
    expect(container.querySelector('[data-nav-target="reminders"]')?.getAttribute('aria-label')).toBe('提醒');
  });
});
