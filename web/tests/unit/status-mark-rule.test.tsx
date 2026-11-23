// Rows show their state as a StatusLamp; StatusTag stays only for what waits on the user (待批准、待回答、待复核).
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskDrawer } from '../../src/features/task';
import { TaskDrawerDemos } from '../../src/features/task/TaskDrawer.demos';
import { TraceLine } from '../../src/features/trace';
import type { RunRow } from '../../src/pages/overview/briefModel';
import { RunningSection } from '../../src/pages/overview/RunningSection';
import { HudCard } from '../../src/surfaces/stack/HudCard';
import { Nameplate } from '../../src/ui';

afterEach(cleanup);
const noop = () => {};

const demo = <P,>(list: Array<{ name: string; props: P }>, name: string) => list.find((d) => d.name === name)!.props;
const stub = (el: Element) => [...el.querySelectorAll('[data-stub="StatusLamp"], [data-stub="StatusTag"]')].map((e) => e.getAttribute('data-stub'));

describe(' status marks', () => {
  it('a task waiting on review keeps the yellow block; a stopped task gets a lamp', () => {
    const waiting = render(<TaskDrawer {...demo(TaskDrawerDemos, 'review')} />);
    expect(waiting.container.querySelector('dd [data-stub="StatusTag"]')?.textContent).toBe('待复核');
    cleanup();
    const stopped = render(<TaskDrawer {...demo(TaskDrawerDemos, 'stopped')} />);
    expect(stopped.container.querySelector('dd [data-stub="StatusLamp"]')?.textContent).toContain('已取消');
    expect(stopped.container.querySelector('dd [data-stub="StatusTag"]')).toBeNull();
  });

  it('a trace step and a name plate show a lamp with its word', () => {
    expect(stub(render(<TraceLine title="读取目录" state="failed" />).container)).toEqual(['StatusLamp']);
    const plate = render(<Nameplate name="示例乙" state="running_tool" status="正在执行 │ 整理本周提交周报" />).container;
    expect(plate.querySelector('[data-stub="StatusLamp"]')?.textContent).toBe('正在执行 │ 整理本周提交周报');
  });

  it('a desk card head shows a lamp, and the yellow block only for a question to her', () => {
    expect(stub(render(<HudCard title="电脑操作" state="running" />).container)).toEqual(['StatusLamp']);
    cleanup();
    expect(stub(render(<HudCard title="拖进来的文件" state="awaiting_input" />).container)).toEqual(['StatusTag']);
  });

  it('a running row in 进行中 shows a lamp; a session waiting on approval keeps the yellow block', () => {
    const session = { id: 's1', kind: 'code', agent: 'Codex', title: '修 HostLink', cwd: '/w/app', task_id: null, since: 0, last_line: null } as const;
    const rows = [
      { k: 'code', session: { ...session, state: 'running_tool' } },
      { k: 'code', session: { ...session, id: 's2', state: 'awaiting_approval' } },
    ] as unknown as RunRow[];
    const { container } = render(<RunningSection q={{ status: 'success', data: true }} rows={rows} convs={0} code={2} activeRuns={{}} now={1000} lost={false} go={noop} onJumpSession={noop} />);
    expect(stub(container)).toEqual(['StatusLamp', 'StatusTag']);
  });
});
