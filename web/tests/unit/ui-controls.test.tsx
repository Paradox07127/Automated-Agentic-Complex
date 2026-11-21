import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Btn, IconBtn, Row, SecHead, Seg, Slider, SRow, Tabs, Toggle } from '../../src/ui';
import { MOUSE_ONLY_HINT } from '../../src/ui/Btn';

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

describe('Toggle', () => {
  it('is a switch that flips on click and reports the change', () => {
    const onChange = vi.fn();
    render(<Toggle on={false} label="窗口文字" onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: '窗口文字' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('keeps its own state when uncontrolled', () => {
    render(<Toggle on label="终端" size="sm" />);
    const sw = screen.getByRole('switch', { name: '终端' });
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('does not change while disabled and exposes the reason', () => {
    const onChange = vi.fn();
    render(<Toggle on={false} label="附上截图" disabled disabledReason="屏幕录制未允许" onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: '附上截图' });
    fireEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
    expect(sw.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(sw.getAttribute('aria-describedby') ?? '')?.textContent).toBe('屏幕录制未允许');
  });
});

describe('Seg', () => {
  const options = [
    { value: 'a', label: '全部' },
    { value: 'b', label: '角色', disabled: true },
    { value: 'c', label: '编码' },
  ];

  it('moves with arrow keys, skips disabled options and keeps one tab stop', () => {
    const onChange = vi.fn();
    render(<Seg label="来源" value="a" options={options} onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: '来源' });
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    fireEvent.keyDown(group, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('a');
  });

  it('ignores clicks on disabled options', () => {
    const onChange = vi.fn();
    render(<Seg label="来源" value="a" options={options} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '角色' }));
    expect(onChange).not.toHaveBeenCalled();
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
  it('fold buttons report aria-expanded and toggle', () => {
    render(<SecHead title="已完成" count={12} collapsed />);
    const fold = screen.getByRole('button', { name: /展开/ });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(fold);
    expect(screen.getByRole('button', { name: /收起/ }).getAttribute('aria-expanded')).toBe('true');
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

describe('SRow', () => {
  it('names the row, shows the effect tag and the disabled reason', () => {
    render(<SRow id="wintext" title="窗口文字" desc="关闭会删除已收集内容" effect="backend" pending disabled disabledReason="屏幕录制未允许" control={<Toggle on label="窗口文字" />} />);
    const row = screen.getByRole('group', { name: '窗口文字' });
    expect(row.id).toBe('set-wintext');
    expect(row.textContent).toContain('重启后生效');
    expect(row.textContent).toContain('不可用：屏幕录制未允许');
    expect(row.getAttribute('aria-disabled')).toBe('true');
  });
});
