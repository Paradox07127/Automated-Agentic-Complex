import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { QuestionBox } from '../../src/features/approval';
import { DeliveryChain } from '../../src/features/delivery';
import { TaskDrawer } from '../../src/features/task';
import { TaskDrawerDemos } from '../../src/features/task/TaskDrawer.demos';
import { TraceLine } from '../../src/features/trace';
import { DELIVERIES, NOW, pick, QUESTIONS } from '../../src/mock/fixtures';
import { CmdPalette } from '../../src/shell/CmdPalette';
import { paletteItems } from '../../src/shell/CmdPalette.data';
import { ToastHost } from '../../src/shell/toast';
import { pageRoutes } from '../../src/shell/registry';
import { DLV_T1_V2, Q1 } from '../../src/mock/fixtures/ids';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const demo = <P,>(list: Array<{ name: string; props: P }>, name: string) => list.find((d) => d.name === name)!.props;

describe(' ⌘K actions', () => {
  it('the action group offers 快速输入 and 免打扰', () => {
    const actions = paletteItems('', pageRoutes, undefined).filter((i) => i.group === '动作');
    expect(actions.map((a) => a.label)).toEqual(expect.arrayContaining(['快速输入', '免打扰 30 分钟']));
    expect(paletteItems('免打扰', pageRoutes, undefined).map((i) => i.label)).toContain('免打扰 30 分钟');
  });

  it('runs them through the same agentd calls as the overview menu', async () => {
    const spy = vi.spyOn(getBridge().agentd, 'request');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const name of ['快速输入', '免打扰 30 分钟']) {
      const ui = render(
        <QueryClientProvider client={client}>
          <CmdPalette routes={pageRoutes} onClose={() => {}} />
        </QueryClientProvider>,
      );
      await act(async () => fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: new RegExp(name) })));
      ui.unmount();
    }
    // 快速输入 goes through the native op, never an agentd route.
    expect(spy.mock.calls.filter(([, p]) => p === '/desktop/quick-input')).toEqual([]);
    // 免打扰 sends agentd's PUT /observation/quiet with an epoch-second deadline 30 minutes out.
    const quiet = spy.mock.calls.find(([m, p]) => m === 'PUT' && p === '/observation/quiet');
    const until = (quiet?.[2] as { until: number } | undefined)?.until;
    expect(until).toBeGreaterThanOrEqual(Math.floor((NOW + 30 * 60_000) / 1000));
    // Seconds, not milliseconds: an epoch-ms value would be ~1.8e12.
    expect(until).toBeLessThan(2e10);
  });

  it('calls the state 免打扰 in its toast, never 安静', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CmdPalette routes={pageRoutes} onClose={() => {}} />
        <ToastHost />
      </QueryClientProvider>,
    );
    await act(async () => fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: /免打扰 30 分钟/ })));
    const said = [...document.querySelectorAll('[data-kind] > *')].map((t) => t.textContent ?? '');
    expect(said.some((t) => t.includes('免打扰'))).toBe(true);
    expect(said.filter((t) => t.includes('安静'))).toEqual([]);
  });
});

describe(' TraceLine description font', () => {
  it('sets only the command or path part in mono, never the Chinese', () => {
    const { container } = render(<TraceLine title="读取目录" desc="~/Downloads：资料授权已撤销" state="failed" />);
    const mono = [...container.querySelectorAll('[data-mono]')].map((e) => e.textContent);
    expect(mono).toEqual(['~/Downloads']);
    expect(container.textContent).toContain('~/Downloads：资料授权已撤销');
  });

  it('an all-Chinese description has no mono part', () => {
    const { container } = render(<TraceLine title="整理" desc="按作者分组统计" state="completed" />);
    expect(container.querySelector('[data-mono]')).toBeNull();
  });
});

describe(' TaskDrawer inside a Sheet', () => {
  it('drops its own title row and keeps one 在任务中打开', () => {
    const { container } = render(<TaskDrawer {...demo(TaskDrawerDemos, 'review')} inSheet />);
    expect(container.querySelector('h2')).toBeNull();
    expect(screen.getAllByText(/在任务中打开/)).toHaveLength(1);
    expect(screen.getAllByText(/打开过/)).toHaveLength(1);
  });
});

describe(' QuestionBox next to another primary', () => {
  it('secondaryEmphasis turns 提交回答 into a secondary button', () => {
    render(<QuestionBox question={pick(QUESTIONS, Q1)} now={NOW} secondaryEmphasis />);
    expect(screen.getByRole('button', { name: '提交回答' }).getAttribute('data-variant')).toBe('secondary');
  });
});

describe(' desk DeliveryChain', () => {
  it('puts span durations on a second line instead of squeezing them between nodes', () => {
    const { container } = render(<DeliveryChain delivery={pick(DELIVERIES, DLV_T1_V2)} now={NOW} size="desk" />);
    expect(container.querySelector('ol')?.textContent).not.toMatch(/\d m/);
    expect(container.textContent).toContain('1 分 │ 3 分');
  });
});
