import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilterChips } from '../../src/ui/FilterChips';
import { KV } from '../../src/ui/KV';
import { Switch } from '../../src/ui/Switch';
import { Table, TableCell, TableHead, TableRow } from '../../src/ui/Table';

afterEach(cleanup);

describe('Switch', () => {
  it('is a role=switch that reports aria-checked and flips once on Space, Enter and click', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Switch checked={false} label="窗口文字" onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: '窗口文字' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.keyDown(sw, { key: ' ' });
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<Switch checked label="窗口文字" onChange={onChange} />);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(sw, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('does nothing while disabled and gives the reason as its description', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} label="附上截图" disabled disabledReason="屏幕录制未允许" onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: '附上截图' });
    fireEvent.click(sw);
    fireEvent.keyDown(sw, { key: ' ' });
    expect(onChange).not.toHaveBeenCalled();
    expect(sw.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(sw.getAttribute('aria-describedby') ?? '')?.textContent).toBe('屏幕录制未允许');
  });
});

describe('Table', () => {
  const rows = ['a', 'b', 'c'];
  const table = (props: { selected?: string | null; onSelect?: (id: string) => void; onOpen?: (id: string) => void }) => (
    <Table
      label="运行记录"
      head={
        <TableHead menu>
          <TableCell head>任务</TableCell>
          <TableCell head num>
            轮次
          </TableCell>
        </TableHead>
      }
      {...props}
    >
      {rows.map((id, i) => (
        <TableRow key={id} id={id} menu={<button type="button">⋯</button>}>
          <TableCell>任务 {id}</TableCell>
          <TableCell num>{i + 1}</TableCell>
        </TableRow>
      ))}
    </Table>
  );
  const rowEls = () => screen.getAllByRole('row').slice(1);

  it('moves the selection with ↑↓, stops at the ends and opens the row on ↵', () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    render(table({ onSelect, onOpen }));
    const [a, b, c] = rowEls();
    expect(a?.tabIndex).toBe(0);
    expect(b?.tabIndex).toBe(-1);
    a?.focus();
    fireEvent.keyDown(a as HTMLElement, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenLastCalledWith('b');
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c as HTMLElement, { key: 'ArrowUp' });
    expect(onSelect).toHaveBeenLastCalledWith('b');
    fireEvent.keyDown(b as HTMLElement, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('b');
  });

  it('marks the selected row and makes it the Tab stop; uncontrolled clicks select too', () => {
    render(table({ selected: 'c' }));
    const [a, , c] = rowEls();
    expect(c?.getAttribute('aria-selected')).toBe('true');
    expect(c?.tabIndex).toBe(0);
    expect(a?.tabIndex).toBe(-1);
    fireEvent.click(a?.querySelector('td') as HTMLElement);
    expect(a?.getAttribute('aria-selected')).toBe('true');
    expect(c?.getAttribute('aria-selected')).toBe('false');
  });

  it('selected on a row it does not have, its first row is the Tab stop', () => {
    render(table({ selected: 'missing' }));
    const [a, b, c] = rowEls();
    expect([a?.tabIndex, b?.tabIndex, c?.tabIndex]).toEqual([0, -1, -1]);
  });

  it('leaves ↵ on the row-end ⋯ to the button', () => {
    const onOpen = vi.fn();
    render(table({ onOpen }));
    const menu = screen.getAllByRole('button', { name: '⋯' })[0] as HTMLElement;
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('has a column header per column plus the ⋯ column, and right-aligned number cells', () => {
    render(table({}));
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['任务', '轮次', '']);
    const num = screen.getByRole('columnheader', { name: '轮次' });
    expect(num.dataset.num).toBeDefined();
    expect(screen.getByRole('grid', { name: '运行记录' })).toBeTruthy();
  });
});

describe('FilterChips', () => {
  const options = [
    { value: 'all', label: '全部', count: 50 },
    { value: 'waiting', label: '等你', count: 5 },
    { value: 'failed', label: '失败', count: 2 },
  ];

  it('single: picks one, shows counts and walks with ←→', () => {
    const onChange = vi.fn();
    render(<FilterChips label="按状态筛选" options={options} value={['all']} onChange={onChange} />);
    const chips = screen.getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['全部50', '等你5', '失败2']);
    expect(chips[0]?.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chips[1] as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith(['waiting']);
    chips[0]?.focus();
    fireEvent.keyDown(chips[0] as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(chips[1]);
    fireEvent.keyDown(chips[1] as HTMLElement, { key: 'ArrowLeft' });
    fireEvent.keyDown(chips[0] as HTMLElement, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(chips[2]);
  });

  it('multiple: toggles each chip on and off independently', () => {
    render(<FilterChips label="按来源筛选" multiple options={options} value={['failed']} />);
    const [all, waiting, failed] = screen.getAllByRole('button');
    fireEvent.click(all as HTMLElement);
    expect(all?.getAttribute('aria-pressed')).toBe('true');
    expect(failed?.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(failed as HTMLElement);
    expect(failed?.getAttribute('aria-pressed')).toBe('false');
    expect(waiting?.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('KV', () => {
  it('lists keys and values, marks mono values and shows — for missing data', () => {
    render(
      <KV
        items={[
          { key: '状态', value: '进行中' },
          { key: '工作目录', value: '~/Documents', mono: true },
          { key: '退出码', value: null },
        ]}
      />,
    );
    const values = Array.from(document.querySelectorAll('dd'));
    expect(Array.from(document.querySelectorAll('dt')).map((d) => d.textContent)).toEqual(['状态', '工作目录', '退出码']);
    expect(values.slice(0, 2).map((d) => d.textContent)).toEqual(['进行中', '~/Documents']);
    expect(values[1]?.dataset.mono).toBeDefined();
    expect(values[2]?.querySelector('[data-stub="Missing"]')?.getAttribute('data-why')).toBe('unsupported');
    expect(values[2]?.hasAttribute('title')).toBe(false);
  });

  it('shows — for an undefined value too', () => {
    render(<KV items={[{ key: '退出码', value: undefined }]} />);
    expect(document.querySelector('dd [data-stub="Missing"]')?.textContent).toMatch(/^—/);
  });
});
