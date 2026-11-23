// First-run step 01: the roster switches her, 导入 adds a package, and an empty library is skipped rather than finished.
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { CharacterEntry, AgenticComplexBridge } from '../../src/bridge/protocol';
import { OnboardingPage } from '../../src/pages/onboarding/Page';

function install(importPackage: AgenticComplexBridge['character']['importPackage']) {
  const fake = createFakeBridge({ surface: 'onboarding', still: true });
  let added: CharacterEntry[] = [];
  const list = vi.fn(async () => [...(await fake.character.list()), ...added]);
  const switchTo = vi.fn(fake.character.switchTo);
  const bridge: AgenticComplexBridge = {
    ...fake,
    character: {
      ...fake.character,
      list,
      switchTo,
      importPackage: async () => {
        const r = await importPackage();
        if (r.ok) added = [{ id: 'new', name: '新角色', en: 'NEW', appearances: [], active: false, voice: false }];
        return r;
      },
    },
  };
  window.agenticComplex = bridge;
  return { list, switchTo };
}

function mount() {
  const root = createRootRoute({ component: OnboardingPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  render(<RouterProvider router={router} />);
}

const guide = () => document.querySelector('[data-page="onboarding"]') as HTMLElement;
const bar = () => within(screen.getByRole('group', { name: '首次设置操作' }));

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe('首次设置 · 01 角色', () => {
  it('shows a cell per installed character with the current one checked, and whether she is on the desktop', async () => {
    install(async () => ({ ok: false, reason: 'cancelled' }));
    mount();
    const roster = await screen.findByRole('radiogroup', { name: '角色名册' });
    await waitFor(() => expect(within(roster).getAllByRole('radio')).toHaveLength(3));
    const cells = within(roster).getAllByRole('radio');
    expect(cells.map((c) => c.textContent?.replace(/[A-Z_ ]+|✓/g, ''))).toEqual(['示例乙', '示例甲', '示例丙']);
    expect(cells.map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(within(roster).getByRole('button', { name: /导入/ })).toBeTruthy();
    const desk = screen.getByRole('group', { name: '示例乙 在桌面上' });
    expect(desk.textContent).toContain('有声线');
    expect(within(guide()).getByText('必做')).toBeTruthy();
  });

  it('a cell switches her through the bridge', async () => {
    const { switchTo } = install(async () => ({ ok: false, reason: 'cancelled' }));
    mount();
    const roster = await screen.findByRole('radiogroup', { name: '角色名册' });
    await waitFor(() => expect(within(roster).getAllByRole('radio')).toHaveLength(3));
    fireEvent.click(within(roster).getAllByRole('radio')[1] as HTMLElement);
    await waitFor(() => expect(switchTo).toHaveBeenCalledWith('voice_a'));
    await screen.findByRole('group', { name: '示例甲 在桌面上' });
  });

  it('导入 asks the host for a package and reads the roster again', async () => {
    const importPackage = vi.fn(async () => ({ ok: true }));
    const { list } = install(importPackage);
    mount();
    const roster = await screen.findByRole('radiogroup', { name: '角色名册' });
    await waitFor(() => expect(within(roster).getAllByRole('radio')).toHaveLength(3));
    const reads = list.mock.calls.length;
    fireEvent.click(within(roster).getByRole('button', { name: /导入/ }));
    await waitFor(() => expect(within(roster).getAllByRole('radio')).toHaveLength(4));
    expect(importPackage).toHaveBeenCalledTimes(1);
    expect(list.mock.calls.length).toBeGreaterThan(reads);
  });
});

describe('首次设置 · 角色库为空', () => {
  function installEmpty() {
    const fake = createFakeBridge({ surface: 'onboarding', still: true });
    window.agenticComplex = { ...fake, character: { ...fake.character, list: async () => [] } };
  }

  it('says there is no character yet, offers 先不导入 and keeps 下一步 closed', async () => {
    installEmpty();
    mount();
    await within(document.body).findByText('还没有角色。导入一个角色包，角色就会出现在桌面上。');
    expect(within(guide()).getByText('可跳过')).toBeTruthy();
    expect(bar().getByRole('button', { name: '下一步' })).toHaveProperty('disabled', true);
    fireEvent.click(bar().getByRole('button', { name: '先不导入' }));
    await waitFor(() => expect(guide().getAttribute('data-step')).toBe('2'));
  });

  it('完成 does not say she is on the desktop', async () => {
    installEmpty();
    mount();
    await within(document.body).findByText(/还没有角色。/);
    fireEvent.click(screen.getByRole('tab', { name: '04 完成' }));
    await waitFor(() => expect(guide().getAttribute('data-step')).toBe('4'));
    expect(guide().textContent).toContain('设置完成');
    expect(guide().textContent).not.toContain('已在桌面就位');
    expect(guide().textContent).toContain('还没有角色');
  });
});
