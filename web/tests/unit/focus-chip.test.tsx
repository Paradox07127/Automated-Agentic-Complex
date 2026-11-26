import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { ConsoleSlot } from '../../src/surfaces/desktop/cmd/console/ConsoleSlot';
import { StackCardView } from '../../src/surfaces/stack/StackCardView';
import { stubMatchMedia } from './mediaStub';

// Legacy focus recap is still readable, while the menu exposes no focus timer.

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete window.agenticComplex;
});

it('does not show focus presets or start a timer from the menu bar', () => {
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  const request = vi.spyOn(bridge.agentd, 'request');
  render(<ConsoleSlot state={null} presence={{ focus: { until: Date.now() / 1000 + 600 } }} close={vi.fn()} />);
  expect(screen.queryByText(/陪我专注|25 分钟|50 分钟/)).toBeNull();
  expect(request).not.toHaveBeenCalledWith('POST', '/focus', expect.anything());
});

describe('focus_done', () => {
  it('shows the recap headline on the stack card native makes of a P1 announcement', () => {
    const title = '这次专注了 25 分钟：完成了 2 个 agent 会话。休息 5 分钟？';
    render(<StackCardView card={{ id: 'announce-7', kind: 'error', at: 0, task_id: '', title, reason: '' }} index={1} total={1} top now={0} act={vi.fn()} />);
    screen.getByText(title);
  });
});
