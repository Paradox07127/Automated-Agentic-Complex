// 每日简报 › 总览 folds: 做完了, 聊了什么 and the reminders already rung start shut with a one-line summary, open on an error,
// stay flat at 3 rows or fewer; the 7-day comparison of each readout sits in its ⓘ.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { Task } from '../../src/domain/work';
import { DEFAULT_PINS, type BriefDay } from '../../src/pages/overview/briefDay';
import type { Reminder } from '../../src/pages/overview/load';
import type { DayConv } from '../../src/pages/overview/loadBrief';
import { OverviewTab, type OverviewTabProps } from '../../src/pages/overview/OverviewTab';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  delete window.agenticComplex;
});

const T0 = new Date('2026-11-20T09:00:00').getTime();
const task = (i: number, failed = false) => ({ task: { id: `t${i}`, title: `任务 ${i}`, source: 'role', updated_at: T0 + i * 60_000 } as Task, failed });
const conv = (i: number): DayConv => ({ id: `c${i}`, title: `话题 ${i}`, busy: false, updated_at: T0 + i * 60_000, turn_count: 2, turns: [{ t0: T0 + i * 60_000, t1: T0 + i * 60_000 }], last: null });
const reminder = (i: number, triggered: boolean): Reminder => ({ id: `r${i}`, title: `提醒 ${i}`, due_at: T0 + i * 3_600_000, triggered, seen_at: null });

async function draw(over: Partial<OverviewTabProps>) {
  const bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  const day = (await bridge.agentd.request<BriefDay>('GET', '/brief/day?date=2026-11-20')).body!;
  const props: OverviewTabProps = { day, pins: DEFAULT_PINS, onPins: () => {}, go: () => {}, isToday: true, line: '今天 3 个编码会话。', pending: null, running: null, done: [], convs: [], reminders: [], onTask: () => {}, goPage: () => {}, ...over };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <OverviewTab {...props} />
    </QueryClientProvider>,
  );
  return day;
}

const sec = (name: string) => screen.getByRole('region', { name });
const toggle = (name: string) => within(sec(name)).getByRole('button', { name: new RegExp(`^${name}`) });

describe('总览 folds', () => {
  it('做完了 and 今天聊了什么 start shut past 3 rows, with the count and the latest one as the summary', async () => {
    await draw({ done: [task(4), task(3), task(2), task(1)], convs: [conv(4), conv(3), conv(2), conv(1)] });
    for (const name of ['做完了', '今天聊了什么']) expect(toggle(name).getAttribute('aria-expanded')).toBe('false');
    expect(toggle('做完了').textContent).toMatch(/\[4\].*最近：任务 4 09:04/);
    expect(toggle('今天聊了什么').textContent).toMatch(/最近：话题 4 09:04/);
    expect(within(sec('做完了')).queryAllByRole('button', { name: /^任务/ })).toHaveLength(0);
    fireEvent.click(toggle('做完了'));
    expect(within(sec('做完了')).getAllByRole('button', { name: /^任务/ })).toHaveLength(4);
  });

  it('a failed task opens 做完了 and a failed read opens 聊了什么', async () => {
    await draw({ done: [task(4), task(3, true), task(2), task(1)], convs: null });
    expect(toggle('做完了').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('今天聊了什么').getAttribute('aria-expanded')).toBe('true');
    expect(sec('今天聊了什么').textContent).toContain('对话没有读到');
  });

  it('three rows or fewer stay flat, with no fold arrow', async () => {
    await draw({ done: [task(2), task(1)], convs: [conv(1)] });
    expect(within(sec('做完了')).queryByRole('button', { name: /^做完了/ })).toBeNull();
    expect(within(sec('做完了')).getAllByRole('button', { name: /^任务/ })).toHaveLength(2);
  });

  it('reminders already rung fold under the ones still to come once the list passes 3 rows', async () => {
    await draw({ reminders: [reminder(1, true), reminder(2, true), reminder(3, false), reminder(4, false)] });
    const panel = sec('提醒');
    const shut = within(panel).getByRole('button', { name: /^已提醒/ });
    expect(shut.getAttribute('aria-expanded')).toBe('false');
    expect(shut.textContent).toContain('提醒 1 10:00 │ 提醒 2 11:00');
    expect(within(panel).getAllByRole('button', { name: /^提醒 \d/ }).map((b) => b.textContent?.slice(0, 4))).toEqual(['提醒 3', '提醒 4']);
    fireEvent.click(shut);
    expect(within(panel).getAllByRole('button', { name: /^提醒 \d/ })).toHaveLength(4);
  });

  it('three reminders keep one list in time order', async () => {
    await draw({ reminders: [reminder(1, true), reminder(2, false), reminder(3, false)] });
    expect(within(sec('提醒')).queryByRole('button', { name: /^已提醒/ })).toBeNull();
    expect(within(sec('提醒')).getAllByRole('button', { name: /^提醒 \d/ })).toHaveLength(3);
  });
});

describe('总览 readouts', () => {
  it('the 7-day comparison is not on the band; it is in each readout’s ⓘ', async () => {
    const day = await draw({});
    const band = screen.getByRole('list', { name: '读数' });
    const first = within(band).getAllByRole('listitem')[0]!;
    const it = day.items.done;
    expect(it.avg7).not.toBeNull();
    const tip = within(first).getByRole('button', { name: '任务完成：和近 7 天比' });
    const text = within(first).getByRole('tooltip', { hidden: true });
    expect(text.hidden).toBe(true);
    expect(text.textContent).toMatch(/^比近 7 天均值[少多] /);
    fireEvent.focus(tip);
    expect(text.hidden).toBe(false);
  });
});
