import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLandingFocus } from '../../src/shell/nav';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function Landing({ focus }: { focus: string }) {
  useLandingFocus(focus, '', true);
  return null;
}

const row = (attrs: Record<string, string>) => {
  const el = document.createElement('div');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

describe('landing highlight', () => {
  it('skips the leaving page copy and marks the live row', async () => {
    const ghost = row({ 'data-page-exit': 'overview' });
    const stale = row({ 'data-nav-target': 'task-1' });
    ghost.appendChild(stale);
    document.body.appendChild(ghost);
    render(<Landing focus="task-1" />);
    const live = row({ 'data-nav-target': 'task-1' });
    await act(async () => {
      document.body.appendChild(live);
    });
    expect(stale.hasAttribute('data-nav-hl')).toBe(false);
    expect(live.hasAttribute('data-nav-hl')).toBe(true);
  });

  it('moves the mark when the row it marked unmounts and the page renders it again', async () => {
    const first = row({ 'data-nav-target': 'task-1' });
    document.body.appendChild(first);
    render(<Landing focus="task-1" />);
    expect(first.hasAttribute('data-nav-hl')).toBe(true);
    const next = row({ 'data-nav-target': 'task-1' });
    await act(async () => {
      first.remove();
      document.body.appendChild(next);
    });
    expect(next.hasAttribute('data-nav-hl')).toBe(true);
  });
});
