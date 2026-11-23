import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LineChart, type Pt } from '../../src/charts/LineChart';
import * as ui from '../../src/ui';
import * as game from '../../src/ui/game';
import { ICON_PATHS } from '../../src/ui/iconPaths';
import { Icon } from '../../src/ui/Icon';
import { SRow } from '../../src/ui/SRow';
import { SearchField } from '../../src/ui/SearchField';
import { SecHead } from '../../src/ui/SecHead';
import { Select } from '../../src/ui/Select';
import { Sheet } from '../../src/ui/Sheet';
import { LoadBar } from '../../src/ui/game/LoadBar';

afterEach(cleanup);

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const read = (f: string) => readFileSync(resolve(src, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations of every rule whose selector list contains `sel` exactly. */
function rules(css: string, sel: string): string {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1]!.split(',').some((s) => s.trim() === sel))
    .map((m) => m[2]!)
    .join('');
}

describe('SearchField maxLength', () => {
  it('hands maxLength to the input', () => {
    render(<SearchField value="" label="搜索记忆" maxLength={40} />);
    expect(screen.getByRole('textbox', { name: '搜索记忆' }).getAttribute('maxlength')).toBe('40');
  });
});

describe('Select prefix', () => {
  it('writes the prefix before the value, and the trigger is still named by label', () => {
    render(<Select label="排序方式" prefix="排序" value="new" options={[{ value: 'new', label: '最新' }]} />);
    const trigger = screen.getByRole('button', { name: '排序方式' });
    expect(trigger.textContent).toBe('排序最新');
    expect(trigger.querySelector('[data-prefix]')?.textContent).toBe('排序');
  });
});

describe('Sheet widths', () => {
  it('opens 560 and 640 wide, and never wider than the window less 48', () => {
    for (const width of [560, 640] as const) {
      render(<Sheet open title="生成记录" width={width} />);
      expect(screen.getByRole('dialog').getAttribute('data-width')).toBe(String(width));
      cleanup();
      expect(rules(read('ui/Sheet.module.css'), `.panel[data-width='${width}']`)).toContain(`width: min(${width}px, calc(100% - 48px));`);
    }
  });
});

describe('Icon star', () => {
  it('draws a star on the 24 grid', () => {
    expect(ICON_PATHS.star).toMatch(/^M[\d.\s,zZMmHhVvLl-]+$/);
    const { container } = render(<Icon name="star" />);
    expect(container.querySelector('svg')?.getAttribute('data-icon')).toBe('star');
  });
});

describe('SecHead lead and DevMark', () => {
  it('puts the lead right before the title', () => {
    render(<SecHead title="收藏" lead={<span data-testid="lead">★</span>} />);
    const h = screen.getByRole('heading', { name: '收藏' });
    expect(h.previousElementSibling?.contains(screen.getByTestId('lead'))).toBe(true);
  });

  it('puts the lead inside the toggle of a folding head too', () => {
    render(
      <SecHead
        title="收藏"
        lead={<span data-testid="lead">★</span>}
        fold={{ open: false, bodyId: 'b', chev: null, onToggle: () => undefined, onKeyDown: () => undefined }}
      />,
    );
    expect(screen.getByRole('button', { name: /收藏/ }).contains(screen.getByTestId('lead'))).toBe(true);
  });

  it('draws the DEV mark with the shared DevMark', () => {
    expect(typeof (ui as Record<string, unknown>).DevMark).toBe('function');
    const { container } = render(<SecHead title="画质" dev />);
    expect(container.querySelector('[data-stub="DevMark"]')?.textContent).toBe('DEV');
  });
});

describe('SRow modified', () => {
  it('marks a row whose value differs from the default, with a 2 px short-of-power line on the left', () => {
    const { container, rerender } = render(<SRow id="a" title="主动程度" control="适中" />);
    const row = container.querySelector('[data-stub="SRow"]')!;
    expect(row.hasAttribute('data-modified')).toBe(false);
    rerender(<SRow id="a" title="主动程度" control="活跃" modified />);
    expect(row.hasAttribute('data-modified')).toBe(true);
    expect(screen.getByRole('group', { name: '主动程度' }).getAttribute('aria-describedby')).toContain('set-a-mod');
    expect(document.getElementById('set-a-mod')?.textContent).toBe('和默认不同');
    const line = rules(read('ui/SRow.module.css'), '.mod');
    expect(line).toContain('var(--ef-power-low)');
    expect(line).toContain('width: 2px');
  });
});

describe('LoadBar dark tone', () => {
  it('marks the dark tone on both variants', () => {
    const { container, rerender } = render(<LoadBar fraction={0.5} tone="dark" />);
    expect(container.querySelector('[data-stub="LoadBar"]')?.getAttribute('data-tone')).toBe('dark');
    rerender(<LoadBar fraction={0.5} variant="port" label="额度" tone="dark" />);
    expect(container.querySelector('[data-stub="LoadBar"]')?.getAttribute('data-tone')).toBe('dark');
    rerender(<LoadBar fraction={0.5} />);
    expect(container.querySelector('[data-stub="LoadBar"]')?.hasAttribute('data-tone')).toBe(false);
  });
});

describe('ReadoutPlate compact', () => {
  it('lays the eyebrow flat so it does not set the plate height', () => {
    expect(rules(read('ui/game/Readout.module.css'), '.plate[data-compact] .eyebrow')).toContain('writing-mode: horizontal-tb');
  });
});

describe('LineChart limits', () => {
  const pts: Pt[] = Array.from({ length: 7 }, (_, i) => [1_000_000 + i * 600_000, i]);

  it('gives each limit its own tone and spoken name', () => {
    const { container } = render(
      <LineChart label="内存" w={400} series={[{ id: 'm', label: '内存', pts }]} limit={[{ v: 2, label: '注意 2', tone: 'warning', name: '注意线' }, { v: 5, tone: 'danger', name: '过高线' }]} />,
    );
    const lines = [...container.querySelectorAll('[data-limit]')];
    expect(lines.map((g) => g.getAttribute('data-limit'))).toEqual(['warning', 'danger']);
    expect([...container.querySelectorAll('[data-limit] text')].map((t) => t.textContent)).toEqual(['注意 2', '过高线 5']);
    expect(container.querySelector('svg[role="img"]')!.getAttribute('aria-label')).toMatch(/注意线 2；过高线 5$/);
  });

  it('takes a node as the empty state', () => {
    const onClick = vi.fn();
    render(
      <LineChart
        label="帧耗时"
        series={[]}
        empty={
          <>
            还没有记录 <button type="button" onClick={onClick}>开始记录</button>
          </>
        }
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '开始记录' }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe('ui/game literal colours', () => {
  const files = ['DarkRow', 'RailCell', 'StationCard', 'DeviceRow'].map((n) => `ui/game/${n}.module.css`);
  const literal = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;

  it('uses tokens only', () => {
    for (const f of files) expect(read(f), f).not.toMatch(literal);
    expect(rules(read('ui/game/GameFrame.module.css'), ".frame[data-variant='media']")).not.toMatch(literal);
    expect(rules(read('ui/game/GameFrame.module.css'), ":global([data-theme='light']) .frame[data-variant='media']")).not.toMatch(literal);
  });

  it('draws the device row with the diagnostics nameplate ink', () => {
    expect(read('ui/game/DeviceRow.module.css')).toContain('var(--ef-g-watch-ink)');
  });

  it('hands its children the ink for the dark plate', () => {
    expect(rules(read('ui/game/DarkRow.module.css'), '.row')).toMatch(/--dr-ink:/);
    expect(rules(read('ui/game/DarkRow.module.css'), '.row')).toContain('color: var(--dr-ink)');
  });
});

describe('IndexCell', () => {
  it('is a pressable index cell with its count at the end and a pending dot', () => {
    const IndexCell = (game as Record<string, unknown>).IndexCell as (p: Record<string, unknown>) => ReactElement;
    expect(typeof IndexCell).toBe('function');
    const onClick = vi.fn();
    const { container, rerender } = render(<IndexCell icon={<i data-testid="ic" />} label="待确认" count={3} pending onClick={onClick} />);
    const cell = screen.getByRole('button', { name: /待确认/ });
    expect(cell.getAttribute('aria-pressed')).toBe('false');
    expect(cell.contains(screen.getByTestId('ic'))).toBe(true);
    expect(cell.lastElementChild?.getAttribute('role')).toBe('img');
    expect(container.querySelector('[data-count]')?.textContent).toBe('3');
    fireEvent.click(cell);
    expect(onClick).toHaveBeenCalled();
    rerender(<IndexCell icon={null} label="全部" count="—" pressed />);
    expect(screen.getByRole('button', { name: /全部/ }).getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(rules(read('ui/game/IndexCell.module.css'), '.cell')).toContain('height: 46px');
  });
});
