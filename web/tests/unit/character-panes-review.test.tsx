// Review 11-22 on the character page's panes: 外观's import banner and progress, 设定's deep link, the name block's voice, 拍照 offline, 模组设置's chips, 动作表's 只看导入.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, AvatarDetails, ImportedMotionEntry, ImportState } from '../../src/bridge/protocol';
import { MOTIONS } from '../../src/mock/character';
import { CharacterSettings } from '../../src/pages/character/CharacterSettings';
import { LookPane } from '../../src/pages/character/LookPane';
import { ModSettings } from '../../src/pages/character/ModSettings';
import { outfitImportWarning } from '../../src/pages/character/labels';
import type { ModSettingRow } from '../../src/pages/character/modSettingsTable';
import { MotionTable, type MotionTableProps } from '../../src/pages/character/MotionTable';
import { useVoiceBinding } from '../../src/pages/character/NameBlock';
import { PhotoMode } from '../../src/pages/character/PhotoMode';
import { setDevMode } from '../../src/shell/devMode';
import { useOutfitImport, type OutfitImport } from '../../src/pages/character/useOutfitImport';

let bridge: AgenticComplexBridge;
const noop = () => {};

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true, capabilities: { nativeFilePicker: true } });
  window.agenticComplex = bridge;
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
  localStorage.clear();
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const FIELD = { ok: true as const, appearance: { id: 'imported_field', name: '野外装' }, warnings: [] };

describe('外观 · 刚导入 (c434#7)', () => {
  const hook = () => renderHook(({ character }) => useOutfitImport(noop, character), { initialProps: { character: 'si' } });

  it('does not carry her banner over to the next character', async () => {
    vi.spyOn(bridge.character, 'importOutfit').mockResolvedValue(FIELD);
    const { result, rerender } = hook();
    await act(async () => result.current.run());
    expect(result.current.landed?.id).toBe('imported_field');
    rerender({ character: 'voice_a' });
    expect(result.current.landed).toBeNull();
  });

  it('does not land an import on the character switched to meanwhile', async () => {
    let done!: (r: typeof FIELD) => void;
    vi.spyOn(bridge.character, 'importOutfit').mockReturnValue(new Promise((r) => (done = r)));
    const { result, rerender } = hook();
    act(() => result.current.run());
    rerender({ character: 'voice_a' });
    await act(async () => done(FIELD));
    expect(result.current.landed).toBeNull();
  });

  it('folds the banner away when that appearance is deleted', async () => {
    vi.spyOn(bridge.character, 'importOutfit').mockResolvedValue(FIELD);
    vi.spyOn(bridge.character, 'removeOutfit').mockResolvedValue({ ok: true } as never);
    const { result } = hook();
    await act(async () => result.current.run());
    await act(async () => result.current.remove('imported_field', '野外装'));
    expect(result.current.landed).toBeNull();
  });
});

describe('外观 · 导入进度 (5220#7)', () => {
  it('says 准备中, not Stage 0, before the first progress line', () => {
    const importing: ImportState = { running: true, kind: 'outfit', title: 'FieldWear', stage: null, fraction: 0 };
    const outfit: OutfitImport = { state: 'busy', run: noop, remove: noop, removing: false, landed: null, warned: null, dismiss: noop };
    render(
      <LookPane
        tab="import"
        character="si"
        appearances={[]}
        lookId="default"
        look={{ scale: 100, setScale: noop } as never}
        onWear={noop}
        layers={[]}
        onLayer={noop}
        onShowAll={noop}
        mods={undefined}
        modsUnreadable={false}
        ro={null}
        outfit={outfit}
        importing={importing}
        toast={noop}
      />,
    );
    const card = document.querySelector('[data-import-progress]') as HTMLElement;
    expect(card.textContent).not.toContain('Stage 0');
    expect(card.textContent).toContain('准备中');
  });
});

describe('外观 · 大小 (R20-10)', () => {
  it('keeps the newer size when an older size request fails, and rolls back only the newest one', async () => {
    const idle: ImportState = { running: false, kind: null, title: null, stage: null, fraction: 0 };
    const outfit: OutfitImport = { state: 'idle', run: noop, remove: noop, removing: false, landed: null, warned: null, dismiss: noop };
    function Pane() {
      const [scale, setScale] = useState(100);
      return (
        <LookPane
          tab="look"
          character="si"
          appearances={[]}
          lookId="default"
          look={{ scale, setScale } as never}
          onWear={noop}
          layers={[]}
          onLayer={noop}
          onShowAll={noop}
          mods={undefined}
          modsUnreadable={false}
          ro={null}
          outfit={outfit}
          importing={idle}
          toast={noop}
        />
      );
    }
    const asks: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
    vi.spyOn(bridge.avatar, 'setScale').mockImplementation(() => new Promise<void>((resolve, reject) => asks.push({ resolve, reject })));
    render(<Pane />);
    const range = screen.getByRole('slider', { name: '大小' }) as HTMLInputElement;
    fireEvent.change(range, { target: { value: '120' } });
    fireEvent.change(range, { target: { value: '140' } });
    await act(async () => asks[0]!.reject({ code: 'failed' }));
    expect(range.value).toBe('140');
    await act(async () => asks[1]!.reject({ code: 'failed' }));
    expect(range.value).toBe('120');
  });
});

describe('外观 · 导入提示', () => {
  it('keeps each imported appearance\'s import warnings under its row, folded until opened, and none under an original one', () => {
    const idle: ImportState = { running: false, kind: null, title: null, stage: null, fraction: 0 };
    const outfit: OutfitImport = { state: 'idle', run: noop, remove: noop, removing: false, landed: null, warned: null, dismiss: noop };
    render(
      <LookPane
        tab="look"
        character="si"
        appearances={[
          { id: 'default', name: '日常', desc: '', kind: 'original' },
          { id: 'mod_1', name: '野外装', desc: '', kind: 'imported', warnings: ['setting_fixed:glow', 'texture_unbound:Tex/14.dds'] },
        ]}
        lookId="default"
        look={{ scale: 100, setScale: noop } as never}
        onWear={noop}
        layers={[]}
        onLayer={noop}
        onShowAll={noop}
        mods={undefined}
        modsUnreadable={false}
        ro={null}
        outfit={outfit}
        importing={idle}
        toast={noop}
      />,
    );
    const row = within(document.querySelector('[data-look="mod_1"]') as HTMLElement);
    const fold = row.getByRole('button', { name: '2 处导入提示' });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(row.queryByRole('list', { name: '「野外装」导入提示' })).toBeNull();
    fireEvent.click(fold);
    const items = () => within(row.getByRole('list', { name: '「野外装」导入提示' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(items()).toEqual(['01这个开关在 mod 里写死了，不能切换', `02${outfitImportWarning('texture_unbound:Tex/14.dds')}`]);
    fireEvent.click(fold);
    expect(row.queryByRole('list', { name: '「野外装」导入提示' })).toBeNull();
    fireEvent.click(fold);
    expect(items()).toHaveLength(2);
    const original = within(document.querySelector('[data-look="default"]') as HTMLElement);
    expect(original.queryByRole('button', { name: /导入提示/ })).toBeNull();
  });
});

describe('设定 · deep link (5220#24)', () => {
  it('brings the linked row into view once, not again after each save', async () => {
    setDevMode(false);
    const into = vi.fn();
    Element.prototype.scrollIntoView = into;
    const save = vi.spyOn(bridge.settings, 'save');
    try {
      render(
        <QueryClientProvider client={client()}>
          <CharacterSettings tab="render" row="rnd.dof" offline={false} onRestart={noop} avatar={false} onTab={noop} toast={noop} />
        </QueryClientProvider>,
      );
      await screen.findByRole('radiogroup', { name: '景深' });
      await waitFor(() => expect(into).toHaveBeenCalledTimes(1));
      fireEvent.click(within(screen.getByRole('radiogroup', { name: '景深' })).getByRole('radio', { name: '近景时' }));
      await waitFor(() => expect(save).toHaveBeenLastCalledWith({ 'rnd.dof': 'closeup' }));
      await waitFor(() => expect(within(screen.getByRole('radiogroup', { name: '景深' })).getByRole('radio', { name: '近景时' }).getAttribute('aria-checked')).toBe('true'));
      expect(into).toHaveBeenCalledTimes(1);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });
});

describe('名字块 · 语音绑定 (949c#7)', () => {
  it('reads her voice again after a failed read', async () => {
    const req = vi.spyOn(bridge.agentd, 'request').mockRejectedValueOnce({ code: 'unavailable' });
    const { result, rerender } = renderHook(({ on }) => useVoiceBinding('si', on), { initialProps: { on: true } });
    await waitFor(() => expect(req).toHaveBeenCalledTimes(1));
    await act(async () => {});
    req.mockResolvedValue({ status: 200, body: { voice: { voice_id: 'v_si', language: 'zh' } } } as never);
    rerender({ on: false });
    rerender({ on: true });
    await waitFor(() => expect(result.current).toEqual({ voiceId: 'v_si', language: 'zh' }));
  });
});

describe('拍照 · 角色未运行 (949c#13)', () => {
  it('greys aperture and focus while she is not running, and opens the camera again when she is back', async () => {
    const base = await bridge.avatar.details();
    vi.spyOn(bridge.avatar, 'details').mockResolvedValue({ ...base, photo: true, capture: true } satisfies AvatarDetails);
    const set = vi.spyOn(bridge.avatar.photo, 'set').mockResolvedValue(undefined as never);
    const qc = client();
    const at = (offline: boolean) => (
      <QueryClientProvider client={qc}>
        <PhotoMode avatar offline={offline} />
      </QueryClientProvider>
    );
    const ui = render(at(false));
    const aperture = () => screen.getByRole('slider', { name: '光圈' }) as HTMLInputElement;
    await waitFor(() => expect(aperture().disabled).toBe(false));
    fireEvent.change(aperture(), { target: { value: '5.6' } });
    ui.rerender(at(true));
    expect(aperture().disabled).toBe(true);
    expect((screen.getByRole('radio', { name: '手动' }) as HTMLButtonElement).disabled).toBe(true);
    set.mockClear();
    ui.rerender(at(false));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ active: true, aperture: 32, focus: 'auto' }));
    expect(document.querySelector('[data-readout="aperture"]')?.textContent).toBe('f/32');
  });
});

describe('模组设置 · 类别 (949c#17)', () => {
  const row = (id: string, category: ModSettingRow['category']): ModSettingRow => ({ id, name: id, category, default: 0, values: [{ value: 0, name: '一' }, { value: 1, name: '二' }, { value: 2, name: '三' }] });

  it('marks the first chip when the new appearance has no category the old one was on', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    try {
      const at = (id: string, settings: ModSettingRow[]) => <ModSettings character="si" appearance={{ id, name: id }} settings={settings} ro={null} toast={noop} />;
      const ui = render(at('a', [row('coat', 'clothing'), row('tail', 'hair')]));
      const chips = () => within(screen.getByRole('group', { name: '跳到类别' })).getAllByRole('button');
      await waitFor(() => expect(chips()).toHaveLength(2));
      fireEvent.click(chips()[1]!);
      expect(chips()[1]!.getAttribute('aria-current')).toBe('true');
      ui.rerender(at('b', [row('coat', 'clothing'), row('glow', 'color')]));
      expect(chips().map((c) => c.getAttribute('aria-current'))).toEqual(['true', null]);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });
});

describe('动作表 · 只看导入 (949c#25)', () => {
  const a = MOTIONS[0]!;
  const imp: ImportedMotionEntry = { id: a.id, clip: `imported_${a.id}`, title: a.label, format: 'vmd', durationS: 2, hasBgm: false, createdAt: null, warnings: [] };
  const at = (imported: Record<string, ImportedMotionEntry>) => {
    const p: MotionTableProps = {
      groups: [{ key: 'idle', name: '待机', rows: MOTIONS.slice(0, 3).map((x, i) => ({ a: x, no: String(i + 1) })) }],
      value: () => true,
      changed: {},
      sel: '',
      onSel: noop,
      onToggle: noop,
      hours: null,
      offline: false,
      lock: false,
      sparse: false,
      saving: false,
      onUndo: noop,
      onSave: noop,
      imported,
    };
    return <MotionTable {...p} />;
  };

  it('stays off after the last imported row goes and a new one comes', () => {
    const ui = render(at({ [a.id]: imp }));
    fireEvent.click(screen.getByRole('button', { name: '只看导入 1' }));
    expect(screen.getByRole('button', { name: '只看导入 1' }).getAttribute('aria-pressed')).toBe('true');
    ui.rerender(at({}));
    ui.rerender(at({ [a.id]: imp }));
    expect(screen.getByRole('button', { name: '只看导入 1' }).getAttribute('aria-pressed')).toBe('false');
  });
});
