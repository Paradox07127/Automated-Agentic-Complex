import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChartBox, useChart } from '../../src/charts';
import { Missing, PageIssues, Region, RegionFail, type RegionSource } from '../../src/ui';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const AT = new Date(2026, 9, 29, 14, 31).getTime();
const ROWS = ['新对话', '整理周报'];
const list = (d: string[]) => (
  <ul>
    {d.map((r) => (
      <li key={r}>{r}</li>
    ))}
  </ul>
);
const region = (container: HTMLElement) => container.querySelector('[data-stub="Region"]') as HTMLElement;
const ok = (extra: Partial<RegionSource<string[]>> = {}): RegionSource<string[]> => ({ status: 'success', data: ROWS, dataUpdatedAt: AT, ...extra });
const failed = (data: string[] | undefined): RegionSource<string[]> => ({ status: 'error', data, error: new Error('后台没有响应'), dataUpdatedAt: data ? AT : 0 });

describe('Region: the eight placeholder states', () => {
  it('首次加载: nothing for 300 ms, then skeleton bars at the reserved height and no 正在读取 line (the page header says it once)', () => {
    vi.useFakeTimers();
    const { container } = render(
      <Region q={{ status: 'pending', data: undefined, isFetching: true }} what="会话" reserve={{ rows: 3 }}>
        {list}
      </Region>,
    );
    expect(region(container).dataset.state).toBe('wait');
    expect(region(container).textContent).toBe('');
    expect(region(container).style.minHeight).toBe('92px');
    act(() => vi.advanceTimersByTime(300));
    expect(region(container).dataset.state).toBe('loading');
    expect(region(container).getAttribute('aria-busy')).toBe('true');
    expect(region(container).textContent).toBe('');
    expect(region(container).querySelectorAll('i[aria-hidden]')).toHaveLength(3);
    expect(region(container).style.minHeight).toBe('92px');
  });

  it('读得慢: after 8 s the head reads 仍在读取 · 已等 N 秒 · 重试 and keeps counting', () => {
    vi.useFakeTimers();
    const refetch = vi.fn();
    const { container } = render(
      <Region q={{ status: 'pending', data: undefined, isFetching: true, refetch }} what="会话" reserve={{ height: 120 }}>
        {list}
      </Region>,
    );
    act(() => vi.advanceTimersByTime(8000));
    expect(region(container).dataset.state).toBe('slow');
    expect(screen.getByRole('status').textContent).toBe('仍在读取 │ 已等 8 秒 │ 重试');
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.getByRole('status').textContent).toContain('已等 12 秒');
    expect(region(container).style.minHeight).toBe('120px');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('刷新中: content stays and a 正在刷新 ring sits in the head slot', () => {
    const { container } = render(
      <Region q={ok({ isFetching: true })} what="会话">
        {list}
      </Region>,
    );
    expect(region(container).dataset.state).toBe('refreshing');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('progressbar', { name: '正在刷新' })).toBeTruthy();
    expect(region(container).textContent).toBe('新对话整理周报');
  });

  it('空: one left-aligned line with the reason and one action; the default says 还没有<what>', () => {
    const { container } = render(
      <Region q={ok({ data: [] })} what="会话" reserve={{ rows: 4 }} empty={{ text: '今天还没有会话', action: <button type="button">新对话</button> }}>
        {list}
      </Region>,
    );
    expect(region(container).dataset.state).toBe('empty');
    expect(region(container).textContent).toBe('今天还没有会话新对话');
    expect(region(container).style.minHeight).toBe('');
    cleanup();
    render(
      <Region q={ok({ data: [] })} what="会话">
        {list}
      </Region>,
    );
    expect(screen.getByRole('status').textContent).toBe('尚无会话');
    expect(screen.queryByText(/暂无/)).toBeNull();
  });

  it('部分失败: the rest shows as usual and the failed part writes its reason in place', () => {
    const retry = vi.fn();
    render(
      <Region q={ok()} what="会话">
        {(d) => (
          <>
            {list(d)}
            <RegionFail what="步骤" reason="接口不可用" onRetry={retry} />
          </>
        )}
      </Region>,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('alert').textContent).toBe('无法读取步骤：接口不可用 │ 重试');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('出错，有旧数据: data at full opacity with a 14:31 的数据 tag; without a page the reason stays next to it', () => {
    const { container } = render(
      <Region q={failed(ROWS)} what="会话" onRetry={() => undefined}>
        {list}
      </Region>,
    );
    const root = region(container);
    expect(root.dataset.state).toBe('stale');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toBe('14:31 的数据读取失败：后台没有响应 │ 重试');
    for (let n: HTMLElement | null = root; n; n = n.parentElement) {
      expect(n.style.opacity).toBe('');
      expect(n.hasAttribute('inert')).toBe(false);
    }
  });

  it('出错，有旧数据, inside PageIssues: one ErrBar at the top for the same reason, sections only show the tag', () => {
    const { container } = render(
      <PageIssues>
        <Region q={failed(ROWS)} what="会话">
          {list}
        </Region>
        <Region q={failed(['a'])} what="任务">
          {list}
        </Region>
      </PageIssues>,
    );
    const bars = screen.getAllByRole('alert');
    expect(bars).toHaveLength(1);
    expect(bars[0]?.textContent).toContain('读取会话、任务失败：后台没有响应');
    expect(bars[0]?.textContent).toContain('以下为 14:31 的缓存数据');
    // The banner carries 14:31 once; the sections do not repeat it.
    expect(container.querySelectorAll('[data-stub="Region"] [role="status"]')).toHaveLength(0);
  });

  it('出错，有旧数据, inside PageIssues: a section whose data is older than the banner says its own time', () => {
    const { container } = render(
      <PageIssues>
        <Region q={failed(ROWS)} what="会话">
          {list}
        </Region>
        <Region q={{ ...failed(['a']), dataUpdatedAt: AT + 20 * 60_000 }} what="任务">
          {list}
        </Region>
      </PageIssues>,
    );
    expect(screen.getByRole('alert').textContent).toContain('以下为 14:31 的缓存数据');
    const tags = [...container.querySelectorAll('[data-stub="Region"] [role="status"]')].map((t) => t.textContent);
    expect(tags).toEqual(['14:51 的数据']);
  });

  it('loading skeletons follow the section: rows, cards or a chart frame', () => {
    vi.useFakeTimers();
    const pending = { status: 'pending', data: undefined, isFetching: true } as const;
    const { container } = render(
      <>
        <Region q={pending} what="待处理" reserve={{ height: 160 }} skel="cards">
          {list}
        </Region>
        <Region q={pending} what="简报" reserve={{ height: 120 }} skel="chart">
          {list}
        </Region>
        <Region q={pending} what="进行中" reserve={{ height: 120 }} skel="rows">
          {list}
        </Region>
      </>,
    );
    act(() => vi.advanceTimersByTime(300));
    const [cards, chart, rows] = [...container.querySelectorAll('[data-stub="Region"]')];
    expect(cards?.querySelectorAll('i[aria-hidden]')).toHaveLength(2);
    expect(chart?.querySelectorAll('i[aria-hidden]')).toHaveLength(1);
    expect(rows?.querySelectorAll('i[aria-hidden]').length).toBeGreaterThan(2);
  });

  it('出错，没有数据: keeps the reserved height and writes 没有读到<what>：原因 · 重试', () => {
    const refetch = vi.fn();
    const { container } = render(
      <Region q={{ ...failed(undefined), refetch }} what="会话" reserve={{ height: 180 }}>
        {list}
      </Region>,
    );
    expect(region(container).dataset.state).toBe('failed');
    expect(region(container).style.minHeight).toBe('180px');
    expect(screen.getByRole('alert').textContent).toBe('无法读取会话：后台没有响应 │ 重试');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('断开: the page top stays quiet (the shell banner says it) and sections only add the tag', () => {
    const { container } = render(
      <PageIssues offline at={AT - 60 * 60_000}>
        <Region q={ok()} what="会话">
          {list}
        </Region>
        <Region q={failed(ROWS)} what="任务">
          {list}
        </Region>
      </PageIssues>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect([...container.querySelectorAll('[data-stub="Region"]')].map((r) => (r as HTMLElement).dataset.state)).toEqual(['offline', 'offline']);
    expect(screen.getAllByRole('status').map((t) => t.textContent)).toEqual(['14:31 的数据', '14:31 的数据']);
  });

  it('断开: a section read at the time the page banner gives adds no tag', () => {
    render(
      <PageIssues offline at={AT}>
        <Region q={ok()} what="会话">
          {list}
        </Region>
      </PageIssues>,
    );
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Missing', () => {
  it('unsupported and failed show — with a focusable ⓘ, not a title', () => {
    const { container } = render(
      <>
        <Missing why="unsupported" />
        <Missing why="failed" reason="后台拒绝访问" />
      </>,
    );
    expect(container.querySelector('[title]')).toBeNull();
    const tips = screen.getAllByRole('button', { name: '无数据说明' });
    expect(tips).toHaveLength(2);
    fireEvent.focus(tips[0]!);
    expect(screen.getByRole('tooltip').textContent).toBe('后台服务暂未提供');
    fireEvent.blur(tips[0]!);
    fireEvent.focus(tips[1]!);
    expect(screen.getByRole('tooltip').textContent).toBe('读取失败：后台拒绝访问');
    expect(container.textContent?.match(/—/g)).toHaveLength(2);
  });

  it('na writes the word, no dash', () => {
    const { container } = render(<Missing why="na" reason="不需要" />);
    expect(container.textContent).toBe('不需要');
  });
});

describe('charts keep stale data readable', () => {
  type St = 'ok' | 'error' | 'disconnected' | 'empty';
  function Box({ st, onRetry }: { st: St; onRetry?: () => void }) {
    const c = useChart(320);
    return (
      <ChartBox name="T" c={c} st={st} stoppedAt={AT} onRetry={onRetry} label="帧率" table={{ cols: ['时刻', '值'], rows: [['14:30', '60']] }} foot={<p data-legend="">图例</p>}>
        <svg role="img" aria-label="帧率：60" />
      </ChartBox>
    );
  }

  it('an error passes stoppedAt and onRetry down, keeps the legend and the table switch, and never dims', () => {
    const retry = vi.fn();
    const { container } = render(<Box st="error" onRetry={retry} />);
    const line = container.querySelector('[data-state="error"] [role="alert"]');
    expect(line?.textContent).toBe('读取失败 │ 14:31 的数据重试');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-legend]')).not.toBeNull();
    const stale = container.querySelector('[data-stale]') as HTMLElement;
    expect(stale.hasAttribute('inert')).toBe(false);
    expect(stale.className).toBe('');
    fireEvent.click(container.querySelector('[data-table-toggle]') as Element);
    expect(container.querySelector('[data-state="error"] [data-chart-table]')).not.toBeNull();
    expect(line?.isConnected).toBe(true);
  });

  it('disconnected reads 已断开 · 14:31 的数据', () => {
    const { container } = render(<Box st="disconnected" />);
    expect(container.querySelector('[data-state="disconnected"] [role="status"]')?.textContent).toBe('已断开 │ 14:31 的数据');
    expect(container.querySelector('[data-legend]')).not.toBeNull();
  });

  it('an empty chart is one line: no drawing, no table switch, no legend', () => {
    const { container } = render(<Box st="empty" />);
    expect(container.querySelector('svg:not([aria-hidden]), [data-table-toggle], [data-legend]')).toBeNull();
    expect(container.querySelector('[data-state="empty"]')?.textContent).toBe('帧率：没有数据');
  });
});
