// skins-09w: 角色页「服装分层」每层一行 显示 | 隐藏，调 avatar.setLayers；「全部显示」一次显示全部；导入的外观在外观行里标 MOD。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { CharacterEntry, AgenticComplexBridge } from '../../src/bridge/protocol';
import { CHARACTER_LAYERS, CHARACTER_LOOKS } from '../../src/mock/fixtures';
import { MOTIONS, STATE_WITH_CAUSES } from '../../src/mock/character';
import { Operator, type OperatorProps } from '../../src/pages/character/Operator';

const lookChanged = vi.hoisted(() => vi.fn());
vi.mock('../../src/pages/character/usePreview', async (actual) => ({
  ...(await actual<typeof import('../../src/pages/character/usePreview')>()),
  previewLookChanged: lookChanged,
}));

const noop = () => {};
let bridge: AgenticComplexBridge;

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  window.location.hash = '';
});

/** A layer's 开 / 关 switch: checked while the layer shows. */
const layer = (name: string) => within(screen.getByRole('group', { name: '服装分层' })).getByRole('switch', { name });
/** Turns a layer off, clicking its switch only while it is on. */
const hide = (name: string) => {
  const s = layer(name);
  if (s.getAttribute('aria-checked') === 'true') fireEvent.click(s);
};

const si = (layers?: CharacterEntry['layers']): CharacterEntry => ({
  id: 'si', name: '示例乙', en: 'SI', active: true, voice: true, appearances: CHARACTER_LOOKS.si ?? [], ...(layers ? { layers } : {}),
});

function Op(over: Partial<OperatorProps> = {}) {
  return (
    <Operator
      roster={[si(CHARACTER_LAYERS.map((l) => ({ ...l, visible: true })))]}
      current="si"
      sw={{ state: { phase: 'idle' }, request: noop, retry: noop, dismiss: noop }}
      offline={false}
      backoff={null}
      onRestart={noop}
      actions={MOTIONS}
      motionsError={null}
      onRetryMotions={noop}
      charState={STATE_WITH_CAUSES}
      toast={noop}
      pane="look"
      {...over}
    />
  );
}

describe('角色页 · 服装分层', () => {
  it('draws one switch row per layer and hides coat through avatar.setLayers', async () => {
    const set = vi.spyOn(bridge.avatar, 'setLayers');
    const toast = vi.fn();
    render(<Op toast={toast} />);
    fireEvent.click(screen.getByRole('tab', { name: '显示' }));
    expect(layer('披风').getAttribute('aria-checked')).toBe('true');
    expect(layer('外套').getAttribute('aria-checked')).toBe('true');
    hide('外套');
    await waitFor(() => expect(set).toHaveBeenCalledWith('si', { hide: ['coat'], show: [] }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('已隐藏「外套」'));
    expect(layer('外套').getAttribute('aria-checked')).toBe('false');
    // The stage preview shows again, so it draws her without the coat.
    expect(lookChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps the first switch when a second click comes before the first request settles', async () => {
    const pending: Array<{ ok: () => void; fail: () => void }> = [];
    const set = vi.spyOn(bridge.avatar, 'setLayers').mockImplementation(
      () => new Promise<void>((ok, fail) => void pending.push({ ok, fail: () => fail({ code: 'failed' }) })),
    );
    render(<Op />);
    fireEvent.click(screen.getByRole('tab', { name: '显示' }));
    hide('外套');
    hide('披风');
    pending[0]!.ok();
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(set).toHaveBeenLastCalledWith('si', { hide: ['cape'], show: [] });
    pending[1]!.ok();
    await waitFor(() => expect(layer('披风').getAttribute('aria-checked')).toBe('false'));
    expect(layer('外套').getAttribute('aria-checked')).toBe('false');
  });

  it('shows what the avatar reported when a switch fails', async () => {
    vi.spyOn(bridge.avatar, 'setLayers').mockRejectedValueOnce({ code: 'failed' });
    const toast = vi.fn();
    render(<Op toast={toast} />);
    fireEvent.click(screen.getByRole('tab', { name: '显示' }));
    hide('外套');
    await waitFor(() => expect(toast).toHaveBeenCalledWith('服装分层未完成：角色渲染进程无响应', { severity: 'danger' }));
    hide('披风');
    await waitFor(() => expect(layer('披风').getAttribute('aria-checked')).toBe('false'));
    expect(layer('外套').getAttribute('aria-checked')).toBe('true');
  });

  it('has no layer options without layers', () => {
    render(<Op roster={[si()]} />);
    expect(screen.queryByRole('tab', { name: '显示' })).toBeNull();
    expect(screen.queryByRole('group', { name: '服装分层' })).toBeNull();
    expect(screen.queryByRole('switch', { name: '外套' })).toBeNull();
  });

  it('全部显示 sends an empty hidden set, and is off while every layer shows', async () => {
    const set = vi.spyOn(bridge.avatar, 'setLayers');
    const toast = vi.fn();
    render(<Op toast={toast} roster={[si([{ id: 'coat', name: '外套', visible: false }, { id: 'cape', name: '披风', visible: true }])]} />);
    fireEvent.click(screen.getByRole('tab', { name: '显示' }));
    const all = screen.getByRole('button', { name: '全部显示' }) as HTMLButtonElement;
    // The title bar counts the hidden ones.
    expect(all.closest('[data-stub="TitleBar"]')?.textContent).toContain('隐藏 1');
    fireEvent.click(all);
    await waitFor(() => expect(set).toHaveBeenCalledWith('si', { hide: [], show: ['coat', 'cape'] }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('已全部显示'));
    expect(all.disabled).toBe(true);
  });

  it('changes only the layer clicked, so a layer hidden under another appearance stays hidden', async () => {
    const set = vi.spyOn(bridge.avatar, 'setLayers');
    const { rerender } = render(<Op roster={[si([{ id: 'coat', name: '外套', visible: true }])]} />);
    fireEvent.click(screen.getByRole('tab', { name: '显示' }));
    hide('外套');
    await waitFor(() => expect(set).toHaveBeenCalledWith('si', { hide: ['coat'], show: [] }));
    // She now wears an appearance whose only layer is the cape.
    rerender(<Op roster={[si([{ id: 'cape', name: '披风', visible: true }])]} />);
    hide('披风');
    await waitFor(() => expect(set).toHaveBeenLastCalledWith('si', { hide: ['cape'], show: [] }));
  });

  it('undoes a click with a second one before the first answers, and shows the asked state meanwhile', async () => {
    const pending: Array<() => void> = [];
    const set = vi.spyOn(bridge.avatar, 'setLayers').mockImplementation(() => new Promise<void>((ok) => void pending.push(ok)));
    render(<Op />);
    fireEvent.click(screen.getByRole('tab', { name: '显示' }));
    fireEvent.click(layer('外套'));
    expect(layer('外套').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(layer('外套'));
    expect(layer('外套').getAttribute('aria-checked')).toBe('true');
    pending[0]!();
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(set).toHaveBeenLastCalledWith('si', { hide: [], show: ['coat'] });
    pending[1]!();
    await waitFor(() => expect(layer('外套').getAttribute('aria-checked')).toBe('true'));
  });

  it('reads the roster again once she wears another appearance, so 显示 lists its layers', async () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    render(
      <QueryClientProvider client={qc}>
        <Op />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(within(screen.getByRole('group', { name: '外观' })).getByRole('button', { name: /^制服/ })).toBeTruthy());
    await new Promise((r) => setTimeout(r, 0));
    expect(invalidate).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('group', { name: '外观' })).getByRole('button', { name: /^制服/ }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['character', 'list'] }));
  });

  it('marks an imported appearance MOD in the appearance rows', () => {
    render(<Op />);
    const opts = within(screen.getByRole('group', { name: '外观' })).getAllByRole('button').filter((b) => b.hasAttribute('aria-pressed')).map((o) => o.textContent);
    expect(opts).toContain('夏装MOD导入的外观');
    expect(opts).toContain('日常默认外观 · 便装');
    expect(opts).toContain('制服外勤制服 · 带武器挂件');
  });
});

describe('角色页 · 大小', () => {
  const slider = () => screen.getByRole('slider', { name: '大小' }) as HTMLInputElement;
  const presets = () => {
    fireEvent.click(screen.getByRole('button', { name: '大小预设' }));
    return screen.getByRole('listbox', { name: '大小预设' });
  };
  const preset = (label: string) => fireEvent.click(within(presets()).getByRole('option', { name: label }));

  it('sets her size from a preset, the slider or a tick number, and reads it out once', async () => {
    const set = vi.spyOn(bridge.avatar, 'setScale');
    render(<Op />);
    await waitFor(() => expect(slider().value).toBe('100'));
    expect(within(presets()).getByRole('option', { name: '100%' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('option', { name: '125%' }));
    expect(set).toHaveBeenLastCalledWith(1.25);
    expect(slider().value).toBe('125');
    expect(document.querySelector('output')?.textContent).toBe('125%');
    fireEvent.change(slider(), { target: { value: '60' } });
    expect(set).toHaveBeenLastCalledWith(0.6);
    // 60 is no preset: none is chosen.
    expect(within(presets()).queryByRole('option', { selected: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '大小预设' }));
    fireEvent.click(screen.getByRole('button', { name: '大小 150%' }));
    expect(set).toHaveBeenLastCalledWith(1.5);
  });

  it('goes back to the old size and says why when the shell refuses it', async () => {
    vi.spyOn(bridge.avatar, 'setScale').mockRejectedValueOnce({ code: 'failed' });
    const toast = vi.fn();
    render(<Op toast={toast} />);
    await waitFor(() => expect(slider().value).toBe('100'));
    preset('150%');
    expect(slider().value).toBe('150');
    await waitFor(() => expect(slider().value).toBe('100'));
    expect(toast).toHaveBeenCalledWith('调整缩放未能完成：角色渲染进程无响应', { severity: 'danger' });
  });
});
