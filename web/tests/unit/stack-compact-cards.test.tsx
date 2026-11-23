import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stackScenario } from '../../src/mock/stack';
import { ApprovalStackCard } from '../../src/surfaces/stack/cards/ApprovalStackCard';
import { HudRoot } from '../../src/surfaces/desktop/HudRoot';
import type { StackCard } from '../../src/surfaces/stack/model';
import { stubMatchMedia } from './mediaStub';
import { A1 } from '../../src/mock/fixtures/ids';

// Compact desktop cards and the shared system theme hook, on the HUD.

const LIGHT = '(prefers-color-scheme: light)';
const media = stubMatchMedia();
// The stack page runs on the stack surface; getBridge() builds its fake for the surface named here.
document.documentElement.dataset.surface = 'stack';
const stackDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/surfaces/stack');
const desktopDir = resolve(stackDir, '../desktop');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = '';
  document.documentElement.removeAttribute('data-theme');
});

function mount(hash: string) {
  window.location.hash = hash;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HudRoot />
    </QueryClientProvider>,
  );
}

const theme = () => document.documentElement.dataset.theme;

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.tsx?$/.test(e.name)) yield p;
  }
}

describe('the HUD follows the system appearance', () => {
  it('starts in the system theme and follows a switch while open', () => {
    media.set(LIGHT, true);
    mount('#/hud?still=1');
    expect(theme()).toBe('light');
    act(() => media.set(LIGHT, false));
    expect(theme()).toBe('dark');
    act(() => media.set(LIGHT, true));
    expect(theme()).toBe('light');
  });

  it('lets theme= in the URL win over the system', () => {
    media.set(LIGHT, true);
    mount('#/hud?still=1&theme=dark');
    expect(theme()).toBe('dark');
    act(() => media.set(LIGHT, false));
    cleanup();
    mount('#/hud?still=1&theme=light');
    expect(theme()).toBe('light');
  });

  it('uses the shell hook; the stack keeps no theme hook of its own', () => {
    expect(existsSync(join(stackDir, 'useStackTheme.ts'))).toBe(false);
    expect(readFileSync(join(desktopDir, 'HudRoot.tsx'), 'utf8')).toContain("from '../../shell/useSystemTheme'");
  });
});

describe('compact cards', () => {
  it('import no deprecated ui component and no paper card', () => {
    const banned = /\b(Eyebrow|Emblem|PaperCard|KvTag|FoldRow|NeedBox)\b/;
    const hits = [...files(stackDir)].filter((f) => banned.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('carry no English eyebrow', async () => {
    const { container } = mount('#/hud?still=1');
    fireEvent.click(await screen.findByRole('button', { name: /^展开全部/ }));
    expect(container.querySelectorAll('[data-card-id]').length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/\/\/|QUESTION|REVIEW|Delivery|CORE/);
  });

  it('approval timeline link says the card has no turn when it is off', () => {
    const card = stackScenario('default').cards.find((c) => c.id === A1) as Extract<StackCard, { kind: 'approval' }>;
    render(<ApprovalStackCard card={card} index={1} total={3} top act={() => {}} />);
    // The links sit in the folded 详情 section.
    fireEvent.click(screen.getByRole('button', { name: /^详情/ }));
    expect(screen.getByRole('button', { name: '时间线 ↗' }).getAttribute('title')).toBe('这次审批没有记到对话轮次');
  });
});
