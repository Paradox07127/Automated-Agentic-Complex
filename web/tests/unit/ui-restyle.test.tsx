// Restyled base components keep their props; buttons are capsules with a round icon slot.
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Banner, Btn, Card, Empty, ErrBar, Paper, Plate, Row, RowPlate, SecHead, Tabs } from '../../src/ui';

afterEach(cleanup);

describe('Btn', () => {
  it.each(['primary', 'secondary', 'ghost', 'danger', 'text', 'link'] as const)('marks the variant %s', (variant) => {
    render(<Btn variant={variant}>好</Btn>);
    expect(screen.getByRole('button', { name: '好' }).getAttribute('data-variant')).toBe(variant);
  });

  it('has three heights', () => {
    render(<Btn size="lg">好</Btn>);
    expect(screen.getByRole('button').getAttribute('data-size')).toBe('lg');
  });

  it('draws the round icon slot on primary, secondary and danger; a check by default, after the Kbd', () => {
    const { container } = render(
      <Btn variant="primary" kbd="⏎">
        批准
      </Btn>,
    );
    const button = screen.getByRole('button');
    expect(button.getAttribute('data-tail')).toBe('check');
    expect(container.querySelector('kbd')?.textContent).toBe('⏎');
    expect(button.lastElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(button.lastElementChild?.querySelector('svg')).not.toBeNull();
    expect(button.textContent).toBe('批准⏎');
  });

  it('puts tail, else icon, in the slot; small buttons get a slot only with tail', () => {
    const { rerender } = render(
      <Btn variant="secondary" icon="plus" tail="look">
        屏幕识读
      </Btn>,
    );
    expect(screen.getByRole('button').getAttribute('data-tail')).toBe('look');
    rerender(
      <Btn variant="primary" icon="plus">
        新建
      </Btn>,
    );
    expect(screen.getByRole('button').getAttribute('data-tail')).toBe('plus');
    rerender(
      <Btn variant="primary" size="sm" icon="plus">
        新建
      </Btn>,
    );
    const small = screen.getByRole('button');
    expect(small.getAttribute('data-tail')).toBeNull();
    expect(small.firstElementChild?.getAttribute('data-icon')).toBe('plus');
    rerender(
      <Btn variant="primary" size="sm" tail="look">
        屏幕识读
      </Btn>,
    );
    expect(screen.getByRole('button').getAttribute('data-tail')).toBe('look');
  });

  it('keeps a leading icon and no slot on ghost and text', () => {
    for (const variant of ['ghost', 'text'] as const) {
      const { container, unmount } = render(
        <Btn variant={variant} icon="plus">
          新建
        </Btn>,
      );
      const button = screen.getByRole('button');
      expect(button.getAttribute('data-tail')).toBeNull();
      expect(button.firstElementChild?.getAttribute('data-icon')).toBe('plus');
      expect(container.querySelectorAll('svg')).toHaveLength(1);
      unmount();
    }
  });
});

describe('Tabs keyboard', () => {
  const tabs = [
    { id: 'p', label: '待处理', count: 3 },
    { id: 'a', label: '全部任务' },
    { id: 'g', label: '目标' },
  ];

  it('moves selection and focus with arrows, Home and End; only the selected tab is in the Tab order', () => {
    const onChange = vi.fn();
    function Host() {
      const [v, setV] = useState('p');
      return (
        <Tabs
          tabs={tabs}
          value={v}
          keys={false}
          onChange={(id) => {
            onChange(id);
            setV(id);
          }}
        />
      );
    }
    render(<Host />);
    const list = screen.getByRole('tablist');
    const [p, a, g] = screen.getAllByRole('tab');
    expect([p, a, g].map((t) => t?.tabIndex)).toEqual([0, -1, -1]);
    p?.focus();
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('a');
    expect(document.activeElement).toBe(a);
    expect(a?.getAttribute('aria-selected')).toBe('true');
    expect([p, a, g].map((t) => t?.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(list, { key: 'End' });
    expect(document.activeElement).toBe(g);
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(p);
    fireEvent.keyDown(list, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('p');
  });

  it('writes the count as [n] and draws no keycaps when keys is off', () => {
    const { container } = render(<Tabs tabs={tabs} value="p" keys={false} />);
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('待处理[3]');
    expect(container.querySelector('kbd')).toBeNull();
  });

  it('always shows Q before the first tab and E after the last', () => {
    render(<Tabs tabs={tabs} value="p" />);
    const list = screen.getByRole('tablist');
    expect(list.firstElementChild?.textContent).toBe('Q');
    expect(list.lastElementChild?.textContent).toBe('E');
    expect(list.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('panel levels and list rows', () => {
  it('Plate hides its number tag from readers; Paper reads light tokens in both themes', () => {
    const { container } = render(
      <>
        <Plate no="02">板</Plate>
        <Paper>纸</Paper>
      </>,
    );
    expect(container.querySelector('[data-stub="Plate"] [aria-hidden="true"]')?.textContent).toBe('02');
    expect(container.querySelector('[data-stub="Paper"]')?.getAttribute('data-theme')).toBe('light');
  });

  it('RowPlate keeps its actions outside the row button and marks the selection', () => {
    const onClick = vi.fn();
    render(<RowPlate icon="file" title="整理本周提交周报" meta="待复核" selected onClick={onClick} actions={<Btn variant="text" size="sm">查看原文</Btn>} />);
    const row = screen.getByRole('button', { name: /整理本周提交周报/ });
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(row.querySelector('button')).toBeNull();
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '查看原文' }).closest('[data-stub="RowPlate"]')).not.toBeNull();
  });
});

describe('SecHead', () => {
  it('diag is a plain heading with a status dot, no icon block', () => {
    const { container } = render(<SecHead variant="diag" title="进程" tone="failed" right="4 个 · 1 个不正常" />);
    const head = container.querySelector('[data-stub="SecHead"]');
    expect(head?.querySelector('svg')).toBeNull();
    expect(head?.querySelector('[data-dot]')?.getAttribute('data-dot')).toBe('failed');
    expect(screen.getByRole('heading', { name: '进程' })).toBeTruthy();
  });

  it('shows the section number as decoration, no English eyebrow, and keeps [n]', () => {
    const { container } = render(<SecHead no="01" title="待处理" count={3} tone="waiting" />);
    const hidden = [...container.querySelectorAll('[aria-hidden="true"]')].map((n) => n.textContent);
    expect(hidden).toContain('01');
    expect(container.textContent).toContain('[3]');
    expect(screen.getByRole('heading', { name: '待处理' })).toBeTruthy();
  });

  it('draws no dot without a tone', () => {
    const { container } = render(<SecHead title="其他" />);
    expect(container.querySelector('[data-dot]')).toBeNull();
  });
});

describe('Row', () => {
  it('selected rows stay in the page theme and draw no pointer', () => {
    const { container } = render(<Row title="修 HostLink" selected />);
    expect(container.querySelector('[data-theme]')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
  });
});

describe('Empty', () => {
  it('is one line and one action', () => {
    const { container } = render(<Empty title="没有符合筛选的任务" desc="「只看失败」打开时只列出失败的运行" icon="tune" action={<Btn>清除筛选</Btn>} />);
    const lines = container.querySelectorAll('p, h1, h2, h3, h4');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toContain('没有符合筛选的任务');
    expect(lines[0]?.textContent).toContain('只列出失败的运行');
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

describe('Banner and ErrBar', () => {
  it('carry no hatch block', () => {
    const { container } = render(
      <>
        <Banner severity="danger" title="后台服务断开" />
        <ErrBar message="步骤接口不可用" />
      </>,
    );
    expect(container.querySelectorAll('span[aria-hidden="true"]:empty')).toHaveLength(0);
  });
});

describe('Card', () => {
  it('has no dot group and no section number', () => {
    const { container } = render(
      <Card title="今天" right="本周">
        内容
      </Card>,
    );
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
  });
});
