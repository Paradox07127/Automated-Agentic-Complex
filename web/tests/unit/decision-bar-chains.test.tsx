import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChartState, SegMeter, SegMeterDemos, SmallMultiples, SmallMultiplesDemos } from '../../src/charts';
import { ApprovalCard, DecisionBar, DecisionReceipt, QuestionBox } from '../../src/features/approval';
import { DeliveryBox } from '../../src/features/delivery';
import { PlanProgress } from '../../src/features/plan';
import { PlanProgressDemos } from '../../src/features/plan/PlanProgress.demos';
import { FileImpact, StopConfirm, TaskDetail, TaskDrawer, ToolDist } from '../../src/features/task';
import { TaskDetailDemos } from '../../src/features/task/TaskDetail.demos';
import { TaskDrawerDemos } from '../../src/features/task/TaskDrawer.demos';
import { TaskNeeds } from '../../src/features/task/TaskNeeds';
import { APPROVALS, DELIVERIES, FILE_EFFECTS, NOW, pick, QUESTIONS, TOOL_ITEMS } from '../../src/mock/fixtures';
import { A2, Q1, T1 } from '../../src/mock/fixtures/ids';

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const src = (p: string) => readFileSync(resolve(srcDir, p), 'utf8');

const demo = <T,>(list: Array<{ name: string; props: T }>, name: string): T => {
  const d = list.find((x) => x.name === name);
  if (!d) throw new Error(`no demo ${name}`);
  return d.props;
};

const t1d = DELIVERIES.filter((d) => d.task_id === T1);

describe(' copy: no dev notes, issue numbers or `//` on screen', () => {
  it('DeliveryBox heads with 交付 vN', () => {
    const { container } = render(<DeliveryBox deliveries={t1d} now={NOW} />);
    expect(container.textContent).toContain('交付 v2');
    expect(container.textContent).not.toContain('//');
  });

  it('StopConfirm, ToolDist and FileImpact carry no dev notes', () => {
    const { container } = render(
      <>
        <StopConfirm open target="汇总 10 月开销表" />
        <ToolDist tools={TOOL_ITEMS[T1] ?? []} now={NOW} />
        <FileImpact files={FILE_EFFECTS[T1] ?? []} />
      </>,
    );
    expect(container.textContent).not.toMatch(/\/\/|未核实|需新增|#\d/);
  });

  it('an expired approval marks its consequence ▲ 未验证 instead of （未核实）', () => {
    const { container } = render(<DecisionReceipt outcome={{ kind: 'expired', at: NOW }} agent="Codex" />);
    expect(container.textContent).not.toContain('未核实');
    expect(container.textContent).toContain('▲ 未验证');
  });

  it('ChartState need: mock data shows the chart; a missing backend field shows — with 后台暂不提供', () => {
    render(
      <ChartState state="ok" emptyText="" need={15}>
        图
      </ChartState>,
    );
    expect(screen.getByText('图')).toBeTruthy();
    expect(screen.queryByText(/需新增|mock/)).toBeNull();
    cleanup();
    window.agenticComplex = {} as NonNullable<typeof window.agenticComplex>;
    const { container } = render(
      <ChartState state="ok" emptyText="" need={15}>
        图
      </ChartState>,
    );
    expect(screen.queryByText('图')).toBeNull();
    expect(container.textContent).toContain('—');
    expect(container.querySelector('[data-stub="InfoTip"]')?.textContent).toContain('后台暂不提供');
  });
});

describe(' DecisionBar on questions and reviews', () => {
  it('QuestionBox submits and cancels from a question DecisionBar', () => {
    const { container } = render(<QuestionBox question={pick(QUESTIONS, Q1)} now={NOW} />);
    const bar = container.querySelector('[data-stub="DecisionBar"][data-kind="question"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(within(bar).getByRole('button', { name: '提交回答' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: '取消请求' })).toBeTruthy();
  });

  it('the review block in TaskDetail is a review DecisionBar', () => {
    const { container } = render(<TaskDetail {...demo(TaskDetailDemos, 'review')} />);
    const bar = container.querySelector('[data-stub="DecisionBar"][data-kind="review"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(within(bar).getByRole('button', { name: '接受这一版' })).toBeTruthy();
    expect(container.querySelector('[data-stub="NeedBox"]')).toBeNull();
  });

  it('the drawer decision row is a review DecisionBar', () => {
    const { container } = render(<TaskDrawer {...demo(TaskDrawerDemos, 'review')} />);
    const bar = container.querySelector('[data-stub="DecisionBar"][data-kind="review"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(within(bar).getByRole('button', { name: '接受这一版' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: '驳回…' })).toBeTruthy();
  });

  it('the compact desk QuestionBox keeps its one row of small buttons, no status tag', () => {
    const { container } = render(<QuestionBox question={pick(QUESTIONS, Q1)} now={NOW} compact />);
    expect(container.querySelector('[data-stub="DecisionBar"]')).toBeNull();
    expect(container.querySelector('[data-stub="StatusTag"]')).toBeNull();
    for (const name of ['提交回答', '取消请求']) expect(screen.getByRole('button', { name }).getAttribute('data-size')).toBe('sm');
  });

  it('pressing 驳回… from the keyboard keeps focus on that button', () => {
    render(<TaskDrawer {...demo(TaskDrawerDemos, 'review')} />);
    const btn = screen.getByRole('button', { name: '驳回…' });
    btn.focus();
    fireEvent.keyDown(btn, { key: 'Enter' });
    fireEvent.click(btn);
    expect(document.activeElement?.textContent).toBe('收起');
    expect(document.activeElement).toBe(btn);
  });

  it('secondaryEmphasis turns the primary into a secondary button; loading marks it busy', () => {
    render(<DecisionBar kind="review" secondaryEmphasis primary={{ label: '接受', loading: true }} />);
    const btn = screen.getByRole('button', { name: '接受' });
    expect(btn.getAttribute('data-variant')).toBe('secondary');
    expect(btn.getAttribute('aria-busy')).toBe('true');
  });

  it('TaskNeeds shows one yellow primary at most', () => {
    const q1 = pick(QUESTIONS, Q1);
    const pending = [q1, { ...q1, id: 'q2', title: '另一个问题' }];
    const { container, rerender } = render(<TaskNeeds review={null} pending={pending} now={NOW} />);
    const primaries = () => container.querySelectorAll('[data-stub="Btn"][data-variant="primary"]');
    expect(primaries()).toHaveLength(1);
    expect(primaries()[0]?.closest('[data-stub="DecisionBar"]')?.textContent).toContain(q1.title);
    rerender(<TaskNeeds review={t1d[t1d.length - 1] ?? null} pending={[...pending, pick(APPROVALS, A2)]} now={NOW} />);
    expect(primaries()).toHaveLength(1);
  });
});

describe(' chains and links', () => {
  it('DeliveryBox puts the version chain and the delivery chain in one row', () => {
    const { container } = render(<DeliveryBox deliveries={t1d} now={NOW} />);
    const vc = container.querySelector('[data-stub="VersionChain"]');
    const dc = container.querySelector('[data-stub="DeliveryChain"]');
    expect(vc?.parentElement).toBe(dc?.parentElement);
    expect(vc?.closest('header')).not.toBeNull();
  });

  it('the drawer version row holds both chains', () => {
    const { container } = render(<TaskDrawer {...demo(TaskDrawerDemos, 'review')} />);
    const vc = container.querySelector('[data-stub="VersionChain"]');
    expect(vc?.parentElement?.querySelector(':scope > [data-stub="DeliveryChain"]')).not.toBeNull();
  });

  it('approval links read 会话 ↗ without brackets', () => {
    const { container } = render(<ApprovalCard approval={pick(APPROVALS, A2)} onOpenSession={() => {}} />);
    expect(screen.getByRole('button', { name: '会话 ↗' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/\[(会话|时间线) ↗\]/);
  });
});

describe(' charts', () => {
  it('a snapshot SegMeter says 重连后显示步骤', () => {
    const { container } = render(<SegMeter {...demo(SegMeterDemos, 'snapshot')} />);
    expect(container.textContent).toContain('重连后显示步骤');
  });

  it('a snapshot PlanProgress names no plan version: stored plan items carry none (runtime.py publish_plan)', () => {
    const props = demo(PlanProgressDemos, 'snapshot');
    const { container } = render(<PlanProgress {...props} />);
    expect(container.textContent).toContain('已保存的计划');
    expect(container.textContent).not.toMatch(/第 \d+ 版/);
    expect(container.textContent).not.toContain('重新连接');
  });

  it('the 暂停 label keeps clear of the dashed target line', () => {
    for (const name of ['render', 'minute']) {
      const { container } = render(<SmallMultiples {...demo(SmallMultiplesDemos, name)} />);
      const svg = container.querySelector('svg[data-series="fps"]') as SVGSVGElement;
      const label = [...svg.querySelectorAll('text')].find((t) => t.textContent === '暂停') as SVGTextElement;
      const line = svg.querySelector('line[data-ref]') as SVGLineElement;
      const baseline = Number(label.getAttribute('y'));
      const refY = Number(line.getAttribute('y1'));
      // The label glyphs span about 12 px above the baseline.
      expect(refY < baseline - 13 || refY > baseline + 2, `${name}: ref ${refY} vs label ${baseline}`).toBe(true);
      cleanup();
    }
  });

  it('DiffPreview and DeliveryBox styles use the new tokens only', () => {
    for (const p of ['features/approval/DiffPreview.module.css', 'features/delivery/DeliveryBox.module.css']) {
      expect(src(p), p).not.toMatch(/--ef-(paper|fs-caption|fs-code|track-text)\b/);
    }
  });
});
