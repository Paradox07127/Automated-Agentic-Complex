// Round three of the shared props: LoadBar follows the theme, IndexCell enters in order, DevMark is named, the modified line is shared with the settings rows.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsPage } from '../../src/pages/settings/Page';
import { DevMark } from '../../src/ui/DevMark';
import { SRow } from '../../src/ui/SRow';
import { IndexCell } from '../../src/ui/game/IndexCell';
import { LoadBar } from '../../src/ui/game/LoadBar';
import { pluginsOn, pluginsReset, pluginsSaved } from './plugins';

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

describe('LoadBar follows the theme', () => {
  it('takes the light ink on a dark theme unless a tone is given, and the dark ink again inside a light island', () => {
    const css = read('ui/game/LoadBar.module.css');
    expect(rules(css, '.bar')).toContain('color: var(--lb-ink)');
    expect(rules(css, '.bar')).toContain('--lb-ink: var(--ef-g-label)');
    expect(rules(css, ":global([data-theme='dark']) .bar:not([data-tone])")).toContain('--lb-ink: var(--ef-g-tick)');
    expect(rules(css, ".bar[data-tone='dark']")).toContain('--lb-ink: var(--ef-g-tick)');
    expect(rules(css, ":global([data-theme='dark'] [data-theme='light']) .bar:not([data-tone])")).toContain('--lb-ink: var(--ef-g-label)');
  });

  it('marks a fixed light tone so the theme does not move it', () => {
    const { container } = render(<LoadBar fraction={0.5} tone="light" />);
    expect(container.querySelector('[data-stub="LoadBar"]')?.getAttribute('data-tone')).toBe('light');
  });
});

describe('IndexCell entrance order', () => {
  it('hands its index to the 40 ms stagger', () => {
    render(<IndexCell icon={null} label="偏好" count={6} i={2} />);
    expect((screen.getByRole('button', { name: /偏好/ }) as HTMLElement).style.getPropertyValue('--i')).toBe('2');
    expect(rules(read('ui/game/IndexCell.module.css'), '.cell')).toContain('animation-delay: calc(var(--i, 0) * 40ms)');
  });
});

describe('DevMark name', () => {
  it('reads as 开发者 and still shows DEV', () => {
    render(<DevMark />);
    const mark = screen.getByRole('img', { name: '开发者' });
    expect(mark.textContent).toBe('DEV');
  });
});

describe('shared modified line', () => {
  it('draws the SRow line with the shared ModLine', () => {
    const { container } = render(<SRow id="a" title="主动程度" control="活跃" modified />);
    expect(container.querySelector('[data-stub="SRow"] [data-mod-line]')).not.toBeNull();
    const line = rules(read('ui/SRow.module.css'), '.mod');
    expect(line).toContain('var(--ef-power-low)');
    expect(line).toContain('width: 2px');
  });

  describe('settings rows', () => {
    beforeEach(() => pluginsOn());
    afterEach(() => {
      pluginsReset();
      delete window.agenticComplex;
    });

    it('marks a native row whose value differs from its default, and only that row', async () => {
      await pluginsSaved();
      const root = createRootRoute({ component: SettingsPage });
      const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1&group=privacy'] }) });
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      // The demo user turned 窗口文字 on (default off) and left 你输入的文字 off.
      const changed = await screen.findByRole('group', { name: '窗口文字' });
      expect(changed.querySelector('[data-mod-line]')).not.toBeNull();
      expect(changed.getAttribute('aria-describedby')).toContain('set-wintext-mod');
      expect(document.getElementById('set-wintext-mod')?.textContent).toBe('和默认不同');
      const same = screen.getByRole('group', { name: '你输入的文字' });
      expect(same.querySelector('[data-mod-line]')).toBeNull();
    });
  });
});
