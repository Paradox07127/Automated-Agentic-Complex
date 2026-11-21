// First-run step 1's media panel: the installed characters and 导入 in place of her portrait; the closing screen without one.
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
  const bridge: AgenticComplexBridge = {
    ...fake,
    character: {
      ...fake.character,
      list,
      importPackage: async () => {
        const r = await importPackage();
        if (r.ok) added = [{ id: 'new', name: '新角色', en: 'NEW', appearances: [], active: false }];
        return r;
      },
    },
  };
  window.agenticComplex = bridge;
  return list;
}

function mount() {
  const root = createRootRoute({ component: OnboardingPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  render(<RouterProvider router={router} />);
}

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe('首次设置 · 第 1 页：导入角色', () => {
  it('shows a card per installed character, the current one marked, and no stand-in figure', async () => {
    install(async () => ({ ok: false, reason: 'cancelled' }));
    mount();
    const roster = await screen.findByRole('list', { name: '角色名册' });
    await waitFor(() => expect(within(roster).getAllByRole('listitem')).toHaveLength(3));
    const cards = within(roster).getAllByRole('listitem');
    expect(cards.map((c) => c.textContent)).toEqual(['示例乙', '示例甲', '示例丙']);
    expect(cards.map((c) => c.getAttribute('aria-current'))).toEqual(['true', null, null]);
    for (const c of cards) expect(c.querySelector('svg, img')).toBeNull();
    expect(screen.getByRole('dialog').querySelector('path[fill="#A5E779"]')).toBeNull();
    expect(screen.getByRole('button', { name: '导入' })).toBeTruthy();
  });

  it('导入 asks the host for a package and reads the roster again', async () => {
    const importPackage = vi.fn(async () => ({ ok: true }));
    const list = install(importPackage);
    mount();
    const roster = await screen.findByRole('list', { name: '角色名册' });
    await waitFor(() => expect(within(roster).getAllByRole('listitem')).toHaveLength(3));
    const reads = list.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    await waitFor(() => expect(within(roster).getAllByRole('listitem')).toHaveLength(4));
    expect(importPackage).toHaveBeenCalledTimes(1);
    expect(list.mock.calls.length).toBeGreaterThan(reads);
    expect(within(roster).getByText('新角色')).toBeTruthy();
  });
});

describe('首次设置 · 角色库为空', () => {
  const guide = () => screen.getByRole('dialog');
  const press = (name: RegExp) => fireEvent.click(within(guide()).getByRole('button', { name }));
  const toReady = async () => {
    press(/^下一步/);
    await waitFor(() => expect(guide().getAttribute('data-step')).toBe('2'));
    fireEvent.click(within(guide()).getByRole('radio', { name: /^只陪伴/ }));
    press(/^下一步/);
    await waitFor(() => expect(guide().getAttribute('data-step')).toBe('3'));
  };

  function installEmpty() {
    const fake = createFakeBridge({ surface: 'onboarding', still: true });
    let imported = false;
    window.agenticComplex = {
      ...fake,
      character: {
        ...fake.character,
        list: async () => (imported ? [{ id: 'new', name: '新角色', en: 'NEW', appearances: [], active: true }] : []),
        importPackage: async () => ((imported = true), { ok: true }),
      },
    };
  }

  it('step 1 says there is no character yet instead of offering to open her', async () => {
    installEmpty();
    mount();
    await screen.findByRole('list', { name: '角色名册' });
    await waitFor(() => expect(guide().textContent).toContain('还没有角色'));
    expect(guide().textContent).not.toContain('她会出现在桌面上');
  });

  it('step 3 does not say she is on the desktop', async () => {
    installEmpty();
    mount();
    await screen.findByRole('list', { name: '角色名册' });
    await waitFor(() => expect(guide().textContent).toContain('还没有角色'));
    await toReady();
    expect(guide().textContent).not.toContain('已在桌面就位');
    expect(guide().textContent).toContain('设置完成');
    expect(guide().textContent).toContain('桌面上暂时看不到她');
  });

  it('step 3 keeps 已在桌面就位 with characters, also after an import on step 1', async () => {
    installEmpty();
    mount();
    await screen.findByRole('list', { name: '角色名册' });
    await waitFor(() => expect(guide().textContent).toContain('还没有角色'));
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    await within(await screen.findByRole('list', { name: '角色名册' })).findByText('新角色');
    await toReady();
    expect(guide().textContent).toContain('已在桌面就位');
  });

  it('step 3 says 已在桌面就位 when the library has characters', async () => {
    install(async () => ({ ok: false, reason: 'cancelled' }));
    mount();
    await screen.findByRole('list', { name: '角色名册' });
    await toReady();
    expect(guide().textContent).toContain('已在桌面就位');
  });
});
