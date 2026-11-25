import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Btn, IconBtn, RadioDot, Row, SecHead, Slider, SRow, Switch, Tabs } from '../../src/ui';
import { MOUSE_ONLY_HINT } from '../../src/ui/Btn';
import { Select } from '../../src/ui/Select';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});

describe('Btn', () => {
  it('clicks, and ignores clicks while disabled or loading', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Btn onClick={onClick}>保存</Btn>);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Btn onClick={onClick} disabled disabledReason="还有 1 个任务没完成">
        保存
      </Btn>,
    );
    const b = screen.getByRole('button', { name: '保存' });
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.getAttribute('title')).toBe('还有 1 个任务没完成');
    expect(document.getElementById(b.getAttribute('aria-describedby') ?? '')?.textContent).toBe('还有 1 个任务没完成');
    fireEvent.click(b);

    rerender(
      <Btn onClick={onClick} loading>
        保存
      </Btn>,
    );
    expect(screen.getByRole('button', { name: '保存' }).getAttribute('aria-busy')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('mouse-only buttons block ⏎ and space and say why', () => {
    render(
      <Btn variant="danger" mouseOnly>
        批准
      </Btn>,
    );
    const b = screen.getByRole('button', { name: '批准' });
    expect(fireEvent.keyDown(b, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyUp(b, { key: ' ' })).toBe(false);
    expect(screen.getByRole('status').textContent).toBe(MOUSE_ONLY_HINT);
    expect(fireEvent.keyDown(b, { key: 'a' })).toBe(true);
  });
});

describe('IconBtn', () => {
  it('has a label, a tooltip and a pressed state', () => {
    render(<IconBtn icon="pin" label="固定" pressed />);
    const b = screen.getByRole('button', { name: '固定' });
    expect(b.getAttribute('title')).toBe('固定');
    expect(b.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('RadioDot', () => {
  it('selects on click and on space, and says it is checked', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<RadioDot checked={false} label="任务完成：出声" onSelect={onSelect} />);
    const dot = screen.getByRole('radio', { name: '任务完成：出声' });
    expect(dot.getAttribute('aria-checked')).toBe('false');
    expect(dot.tabIndex).toBe(0);
    fireEvent.click(dot);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(fireEvent.keyDown(dot, { key: ' ' })).toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(2);
    rerender(<RadioDot checked label="任务完成：出声" onSelect={onSelect} />);
    expect(dot.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(dot);
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('ignores clicks and space while disabled; without onSelect it leaves the tab order to the row', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<RadioDot checked={false} label="提醒：不提示" disabled onSelect={onSelect} />);
    const dot = screen.getByRole('radio', { name: '提醒：不提示' });
    fireEvent.click(dot);
    fireEvent.keyDown(dot, { key: ' ' });
    expect(onSelect).not.toHaveBeenCalled();
    expect(dot.getAttribute('aria-disabled')).toBe('true');
    rerender(<RadioDot checked label="Codex" size="sm" />);
    const sm = screen.getByRole('radio', { name: 'Codex' });
    expect(sm.getAttribute('data-size')).toBe('sm');
    expect(sm.tabIndex).toBe(-1);
  });
});

describe('Tabs', () => {
  const tabs = [
    { id: 'p', label: '待处理', count: 3 },
    { id: 'a', label: '全部任务' },
    { id: 'g', label: '目标' },
  ];

  it('switches with arrows inside the tablist and Q/E anywhere else', () => {
    const onChange = vi.fn();
    render(<Tabs tabs={tabs} value="p" onChange={onChange} />);
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('待处理');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('g');
    fireEvent.keyDown(window, { key: 'e' });
    expect(onChange).toHaveBeenLastCalledWith('a');
  });

  it('writes 读不到 in place of a count that could not be read, never 0', () => {
    render(<Tabs tabs={[{ id: 'r', label: '角色任务', count: 'error' }, ...tabs]} value="r" />);
    const tab = screen.getByRole('tab', { name: /角色任务/ });
    expect(tab.textContent).toBe('角色任务读不到');
    expect(tab.querySelector('[data-error]')?.textContent).toBe('读不到');
  });

  it('leaves Q/E alone while typing', () => {
    const onChange = vi.fn();
    render(
      <>
        <input aria-label="搜索" />
        <Tabs tabs={tabs} value="p" onChange={onChange} />
      </>,
    );
    fireEvent.keyDown(screen.getByRole('textbox', { name: '搜索' }), { key: 'q' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Row', () => {
  it('activates with ⏎ and space, not while disabled', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Row title="整理周报" onClick={onClick} />);
    const row = screen.getByRole('button');
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(2);
    rerender(<Row title="整理周报" onClick={onClick} disabled disabledReason="已归档" />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button').getAttribute('aria-disabled')).toBe('true');
  });

  // Selection is surface-2 + an accent bar in the page theme, no inverse block.
  it('selected rows stay in the page theme', () => {
    const { container, rerender } = render(<Row title="修 HostLink" selected />);
    expect(container.querySelector('[data-theme]')).toBeNull();
    act(() => document.documentElement.setAttribute('data-theme', 'light'));
    rerender(<Row title="修 HostLink" selected />);
    expect(container.querySelector('[data-theme]')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('SecHead', () => {
  it('has no fold button of its own; a folding group title is Fold variant="head"', () => {
    render(<SecHead title="已完成" count={12} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/展开|收起/)).toBeNull();
  });
});

describe('Slider', () => {
  it('lets the readout be typed and clamps to the range', () => {
    const onChange = vi.fn();
    render(<Slider label="大小" value={100} min={50} max={200} unit="%" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /大小：100%/ }));
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '500' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(200);
  });

  it('does not open the readout editor while disabled', () => {
    render(<Slider label="大小" value={100} min={50} max={200} disabled />);
    fireEvent.click(screen.getByRole('button', { name: /大小/ }));
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('disabled while open', () => {
  it('a Select list closes when the Select is disabled, and an option picked from it changes nothing', () => {
    const onChange = vi.fn();
    const options = [
      { value: '8', label: '08:00' },
      { value: '9', label: '09:00' },
    ];
    const { rerender } = render(<Select label="简报时间" value="8" options={options} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '简报时间' }));
    const option = screen.getByRole('option', { name: '09:00' });
    rerender(<Select label="简报时间" value="8" options={options} onChange={onChange} disabled />);
    fireEvent.click(option);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a Slider drops what was typed when it is disabled, and Enter changes nothing', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Slider label="光圈" value={2} min={1} max={16} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /光圈：2/ }));
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '8' } });
    rerender(<Slider label="光圈" value={2} min={1} max={16} onChange={onChange} disabled />);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });
});

describe('SRow', () => {
  it('names the row, shows the effect tag and the disabled reason', () => {
    render(<SRow id="wintext" title="窗口文字" desc="关闭会删除已收集内容" effect="backend" pending disabled disabledReason="屏幕录制未允许" control={<Switch checked label="窗口文字" />} />);
    const row = screen.getByRole('group', { name: '窗口文字' });
    expect(row.id).toBe('set-wintext');
    expect(row.textContent).toContain('重启后生效');
    expect(row.textContent).toContain('不可用：屏幕录制未允许');
    expect(row.getAttribute('aria-disabled')).toBe('true');
  });
});
