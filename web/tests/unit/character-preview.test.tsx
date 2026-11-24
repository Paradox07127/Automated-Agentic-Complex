// Live preview of the character page: the stage's rect goes to avatar.preview.show; overlays, blocks and unmounting hide it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { PreviewPlacement } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import { ModSettings } from '../../src/pages/character/ModSettings';
import type { ModSettingRow } from '../../src/pages/character/modSettingsTable';
import { previewLookChanged, useLivePreview } from '../../src/pages/character/usePreview';
import { MODAL_ROOT_ID } from '../../src/ui';

function Probe({ action, blocked = false, character = 'birch', request }: { action?: string; blocked?: boolean; character?: string; request?: number }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const preview = useLivePreview(el, { character, action, blocked, request });
  return <><div ref={setEl} data-testid="stage" data-live={preview.phase === 'live' || undefined} data-progress={preview.progress ?? undefined} />
    {preview.phase === 'failed' && <button onClick={preview.retry}>重试预览</button>}</>;
}

const RECT = { x: 40, y: 120, width: 600, height: 360, top: 120, left: 40, right: 640, bottom: 480, toJSON: () => ({}) } as DOMRect;
let show: Mock<(at: PreviewPlacement) => Promise<boolean>>;
let hide: Mock<() => Promise<void>>;

beforeEach(() => {
  const bridge = createFakeBridge({ surface: 'main', still: true });
  show = vi.fn(async (_at: PreviewPlacement) => true);
  hide = vi.fn(async () => {});
  window.agenticComplex = { ...bridge, avatar: { ...bridge.avatar, preview: { ...bridge.avatar.preview, show, hide } } };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'stage' ? RECT : ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect);
  });
  const root = document.createElement('div');
  root.id = MODAL_ROOT_ID;
  document.body.append(root);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.getElementById(MODAL_ROOT_ID)?.remove();
  delete window.agenticComplex;
});

describe('useLivePreview', () => {
  it('reports the stage rect and marks the stage live once the shell draws her', async () => {
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(show).toHaveBeenCalledWith({ x: 40, y: 120, w: 600, h: 360 }));
    await waitFor(() => expect(getByTestId('stage').dataset.live).toBe('true'));
  });

  it('places it over the page\'s preview layer when there is one, so she can reach past the stage', async () => {
    const layer = document.createElement('div');
    layer.dataset.previewLayer = '';
    layer.getBoundingClientRect = () => ({ x: 0, y: 64, width: 1000, height: 700, top: 64, left: 0, right: 1000, bottom: 764, toJSON: () => ({}) }) as DOMRect;
    document.body.append(layer);
    render(<Probe />);
    await waitFor(() => expect(show).toHaveBeenCalledWith({ x: 0, y: 64, w: 1000, h: 700 }));
    layer.remove();
  });

  it('keeps her shown under menus, dialogs, the modal root and toasts when the page has a preview layer', async () => {
    const layer = document.createElement('div');
    layer.dataset.previewLayer = '';
    layer.getBoundingClientRect = () => ({ x: 0, y: 64, width: 1000, height: 700, top: 64, left: 0, right: 1000, bottom: 764, toJSON: () => ({}) }) as DOMRect;
    document.body.append(layer);
    render(<Probe />);
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    const over = { x: 40, y: 120, width: 300, height: 200, top: 120, left: 40, right: 340, bottom: 320, toJSON: () => ({}) } as DOMRect;
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.getBoundingClientRect = () => over;
    const toast = document.createElement('div');
    toast.dataset.stub = 'Toast';
    toast.getBoundingClientRect = () => over;
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const sheet = document.createElement('div');
    try {
      act(() => {
        document.body.append(menu, toast, dialog);
        document.getElementById(MODAL_ROOT_ID)?.append(sheet);
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(hide).not.toHaveBeenCalled();
    } finally {
      act(() => [menu, toast, dialog, sheet, layer].forEach((el) => el.remove()));
    }
  });

  it('shows through an ancestor laid out as display: contents even when it sets overflow', async () => {
    render(
      <div style={{ display: 'contents', overflowX: 'hidden', overflowY: 'auto' }}>
        <Probe />
      </div>,
    );
    await waitFor(() => expect(show).toHaveBeenCalledWith({ x: 40, y: 120, w: 600, h: 360 }));
  });

  it('plays the picked action and shows again for another character', async () => {
    const { rerender } = render(<Probe action="wave" />);
    await waitFor(() => expect(show).toHaveBeenLastCalledWith({ x: 40, y: 120, w: 600, h: 360, action: 'wave' }));
    rerender(<Probe character="voice_a" />);
    await waitFor(() => expect(show).toHaveBeenLastCalledWith({ x: 40, y: 120, w: 600, h: 360 }));
    expect(show).toHaveBeenCalledTimes(2);
    expect(hide).not.toHaveBeenCalled();
  });

  it('replays the same action when clicked again without reloading it on identical geometry', async () => {
    const { rerender } = render(<Probe action="wave" request={1} />);
    await waitFor(() => expect(show).toHaveBeenLastCalledWith({ x: 40, y: 120, w: 600, h: 360, action: 'wave', request: 1 }));
    rerender(<Probe action="wave" request={2} />);
    await waitFor(() => expect(show).toHaveBeenLastCalledWith({ x: 40, y: 120, w: 600, h: 360, action: 'wave', request: 2 }));
    act(() => window.dispatchEvent(new Event('resize')));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('hides while a dialog sits in the modal root and shows again once it closes', async () => {
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    const dialog = document.createElement('div');
    act(() => document.getElementById(MODAL_ROOT_ID)?.append(dialog));
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
    expect(getByTestId('stage').dataset.live).toBeUndefined();
    act(() => dialog.remove());
    await waitFor(() => expect(show).toHaveBeenCalledTimes(2));
  });

  it('hides for the command palette, and for a menu or toast only where it overlaps the stage', async () => {
    render(<Probe />);
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    const far = document.createElement('div');
    far.dataset.stub = 'Toast';
    far.getBoundingClientRect = () => ({ x: 900, y: 600, width: 100, height: 36, top: 600, left: 900, right: 1000, bottom: 636, toJSON: () => ({}) }) as DOMRect;
    act(() => document.body.append(far));
    await new Promise((r) => setTimeout(r, 50));
    expect(hide).not.toHaveBeenCalled();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.getBoundingClientRect = () => ({ x: 500, y: 100, width: 200, height: 120, top: 100, left: 500, right: 700, bottom: 220, toJSON: () => ({}) }) as DOMRect;
    act(() => document.body.append(menu));
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
    act(() => menu.remove());
    await waitFor(() => expect(show).toHaveBeenCalledTimes(2));
    const palette = document.createElement('div');
    palette.setAttribute('role', 'dialog');
    act(() => document.body.append(palette));
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(2));
    act(() => {
      palette.remove();
      far.remove();
    });
  });

  it('hides while the stage is blocked by its own overlay', async () => {
    const { rerender } = render(<Probe />);
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    rerender(<Probe blocked />);
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
  });

  it('hides on unmount', async () => {
    const { unmount } = render(<Probe />);
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    unmount();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('hides when the shell cannot draw it and does not ask again for the same action', async () => {
    show.mockRejectedValue(Object.assign(new Error('failed'), { code: 'failed' }));
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event('resize')));
    await new Promise((r) => setTimeout(r, 50));
    expect(show).toHaveBeenCalledTimes(1);
    expect(getByTestId('stage').dataset.live).toBeUndefined();
  });

  it('shows again once a mod switch is accepted, so the stage draws her new look', async () => {
    const set = vi.fn(async ({ values }: { values: Record<string, number> }) => ({ values, adjusted: [] }));
    const bridge = window.agenticComplex!;
    window.agenticComplex = { ...bridge, avatar: { ...bridge.avatar, modSettings: { ...bridge.avatar.modSettings, set } } };
    const settings: ModSettingRow[] = [{ id: 'coat', name: '外套', category: 'clothing', default: 1, values: [{ value: 0, name: '隐藏' }, { value: 1, name: '显示' }] }];
    const { findByRole } = render(<><Probe /><ModSettings character="birch" appearance={{ id: 'summer', name: '夏装' }} settings={settings} ro={null} toast={() => {}} /></>);
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    const coat = await findByRole('switch', { name: '外套' });
    expect(coat.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(coat);
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(show).toHaveBeenCalledTimes(2));
    expect(show).toHaveBeenLastCalledWith({ x: 40, y: 120, w: 600, h: 360 });
  });

  it('shows again when a render setting is saved, and a failed reload offers the retry with the same settings', async () => {
    const qc = new QueryClient();
    // `saved` is keyed by row id (app/electron/src/common/settings.ts snapshot()).
    qc.setQueryData(['character', 'settings'], { rows: {}, saved: { 'rnd.outline': 'original', 'beh.stay': false }, statuses: {} });
    const { getByRole, getByTestId } = render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>);
    await waitFor(() => expect(getByTestId('stage').dataset.live).toBe('true'));
    // A setting that is not a render one shows nothing again.
    act(() => qc.setQueryData(['character', 'settings'], { rows: {}, saved: { 'rnd.outline': 'original', 'beh.stay': true }, statuses: {} }));
    await new Promise((r) => setTimeout(r, 50));
    expect(show).toHaveBeenCalledTimes(1);
    show.mockRejectedValueOnce(Object.assign(new Error('failed'), { code: 'failed' }));
    act(() => qc.setQueryData(['character', 'settings'], { rows: {}, saved: { 'rnd.outline': 'subtle', 'beh.stay': true }, statuses: {} }));
    await waitFor(() => expect(getByRole('button', { name: '重试预览' })).toBeTruthy());
    expect(show).toHaveBeenCalledTimes(2);
    expect(getByTestId('stage').dataset.live).toBeUndefined();
    fireEvent.click(getByRole('button', { name: '重试预览' }));
    await waitFor(() => expect(getByTestId('stage').dataset.live).toBe('true'));
    expect(show).toHaveBeenCalledTimes(3);
  });

  it('shows again for her physics switch, which is a 行为 row the preview draws with', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['character', 'settings'], { rows: {}, saved: { 'beh.physics': true }, statuses: {} });
    render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>);
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    act(() => qc.setQueryData(['character', 'settings'], { rows: {}, saved: { 'beh.physics': false }, statuses: {} }));
    await waitFor(() => expect(show).toHaveBeenCalledTimes(2));
  });

  it('a failed preview tries again once her look or a render setting changes', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['character', 'settings'], { rows: {}, saved: { 'rnd.outline': 'original' }, statuses: {} });
    show.mockRejectedValueOnce(Object.assign(new Error('failed'), { code: 'failed' }));
    const { getByTestId } = render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>);
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
    show.mockRejectedValueOnce(Object.assign(new Error('failed'), { code: 'failed' }));
    act(() => previewLookChanged());
    await waitFor(() => expect(show).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(2));
    act(() => qc.setQueryData(['character', 'settings'], { rows: {}, saved: { 'rnd.outline': 'subtle' }, statuses: {} }));
    await waitFor(() => expect(getByTestId('stage').dataset.live).toBe('true'));
    expect(show).toHaveBeenCalledTimes(3);
  });

  it('offers a manual retry when the shell returns false', async () => {
    show.mockResolvedValueOnce(false);
    const { getByRole, getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByRole('button', { name: '重试预览' })).toBeTruthy());
    fireEvent.click(getByRole('button', { name: '重试预览' }));
    await waitFor(() => expect(getByTestId('stage').dataset.live).toBe('true'));
    expect(show).toHaveBeenCalledTimes(2);
  });
});

describe('load progress', () => {
  it('takes a full load\'s share from avatar.preview.onProgress; the first show counts 0 until a report or a frame, a clip change none', async () => {
    let push: (p: { fraction: number } | null) => void = () => {};
    const off = vi.fn();
    vi.spyOn(window.agenticComplex!.avatar.preview, 'onProgress').mockImplementation((cb) => ((push = cb), off));
    let draw: (on: boolean) => void = () => {};
    show.mockImplementation(() => new Promise<boolean>((r) => { draw = r; }));
    const { getByTestId, rerender, unmount } = render(<Probe />);
    const stage = getByTestId('stage');
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(stage.dataset.progress).toBe('0');
    act(() => push({ fraction: 0.6 }));
    expect(stage.dataset.progress).toBe('0.6');
    // The first frame ends the report before the show answers: no fall back to 0 in between.
    act(() => push(null));
    expect(stage.dataset.progress).toBeUndefined();
    await act(async () => draw(true));
    expect(stage.dataset.live).toBe('true');
    // Another action only swaps the clip: nothing reports.
    rerender(<Probe action="wave" />);
    await waitFor(() => expect(show).toHaveBeenCalledTimes(2));
    expect(stage.dataset.progress).toBeUndefined();
    await act(async () => draw(true));
    // A new output size builds anew while she is live.
    act(() => push({ fraction: 0.05 }));
    expect(stage.dataset.progress).toBe('0.05');
    act(() => push(null));
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('reports none while the preview is hidden or failed', async () => {
    let push: (p: { fraction: number } | null) => void = () => {};
    vi.spyOn(window.agenticComplex!.avatar.preview, 'onProgress').mockImplementation((cb) => ((push = cb), () => {}));
    show.mockRejectedValue(Object.assign(new Error('failed'), { code: 'failed' }));
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
    act(() => push({ fraction: 0.6 }));
    expect(getByTestId('stage').dataset.progress).toBeUndefined();
  });
});

describe('the stage transition', () => {
  it('does not sweep the stage across the page with reduced motion, from the system or the app', () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/pages/character/Stage.module.css'), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.stage \{\s*transition: none;/);
    expect(css).toMatch(/:global\(\[data-reduce-motion\]\) \.stage[^{]*\{\s*transition: none;/);
  });
});
