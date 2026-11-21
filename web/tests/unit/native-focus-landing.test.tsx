import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Brief } from '../../src/pages/overview/Brief';
import { overviewOf } from '../../src/pages/overview/load';
import { initialStack, stackReducer } from '../../src/surfaces/stack/stackReducer';

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

  it('the brief ruler, where reminders are drawn, is the landing target for /overview?focus=reminders', () => {
    const { container } = render(<Brief q={{ status: 'pending', data: undefined }} snap={overviewOf({})} brief={undefined} now={1_000_000} go={() => {}} />);
    expect(container.querySelector('[data-nav-target="reminders"]')).not.toBeNull();
  });
});
