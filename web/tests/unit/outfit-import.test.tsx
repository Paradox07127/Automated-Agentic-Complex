// skins-15w: 外观的「导入」页签的黄色键调 character.importOutfit，进度卡跟着导入走；导入完「刚导入」横幅落在模组设置或外观最上面；导入的外观在外观页签的行上删除。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { NOW } from '../../src/mock/fixtures';
import { MOTIONS, STATE_WITH_CAUSES } from '../../src/mock/character';
import { useModTable } from '../../src/pages/character/LookPane';
import { Operator } from '../../src/pages/character/Operator';
import type { Toast } from '../../src/pages/character/feedback';
import { OUTFIT_IMPORT_REASON, OUTFIT_IMPORT_UNKNOWN, outfitImportReason, outfitImportWarning } from '../../src/pages/character/labels';

const noop = () => {};

function use(picker: boolean): AgenticComplexBridge {
  const bridge = createFakeBridge({ surface: 'main', still: true, capabilities: { nativeFilePicker: picker } });
  window.agenticComplex = bridge;
  return bridge;
}

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  window.location.hash = '';
});

/** The roster comes from the page's `['character', 'list']` query, as in Page.tsx; the page opens on 导入. */
function Harness({ toast, pane, current }: { toast: Toast; pane: 'import' | 'look' | 'motion'; current?: string | undefined }) {
  const list = useQuery({ queryKey: ['character', 'list'], queryFn: () => window.agenticComplex!.character.list() });
  if (!list.data) return null;
  const cur = current ?? list.data.find((c) => c.active)?.id ?? list.data[0]?.id ?? '';
  return (
    <Operator
      roster={list.data}
      current={cur}
      sw={{ state: { phase: 'idle' }, request: noop, retry: noop, dismiss: noop }}
      offline={false}
      backoff={null}
      onRestart={noop}
      actions={MOTIONS}
      motionsError={null}
      onRetryMotions={noop}
      charState={STATE_WITH_CAUSES}
      toast={toast}
      pane={pane}
    />
  );
}

/** Opens 外观's 导入 tab; `show('look')` switches to the 外观 pane, as the page's tab does. */
const mount = async (toast: Toast = noop) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const at = (pane: 'import' | 'look' | 'motion', current?: string) => (
    <QueryClientProvider client={client}>
      <Harness toast={toast} pane={pane} current={current} />
    </QueryClientProvider>
  );
  const ui = render(at('look'));
  // 导入 opened from 外观 imports outfit mods.
  fireEvent.click(await screen.findByRole('tab', { name: '导入' }));
  ui.rerender(at('import'));
  return { ...ui, show: (pane: 'import' | 'look' | 'motion', current?: string) => ui.rerender(at(pane, current)) };
};

const key = () => screen.findByRole('button', { name: '选择模组目录…' });
/** An appearance row of 外观 and what sits on it (删除…, WEARING). */
const look = async (name: string) => within((await screen.findByRole('button', { name: new RegExp(`^${name}`) })).closest('[data-look]') as HTMLElement);

describe('角色页 · 导入外观', () => {
  it('has no import key without a native file picker', async () => {
    use(false);
    await mount();
    await screen.findByRole('heading', { name: '导入外观模组' });
    expect(screen.queryByRole('button', { name: '选择模组目录…' })).toBeNull();
  });

  it('imports on 导入 only, and offers 删除… on the imported rows of 外观 only', async () => {
    use(true);
    const { show } = await mount();
    await key();
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
    expect(screen.queryByRole('group', { name: '外观' })).toBeNull();
    show('look');
    await screen.findByRole('group', { name: '外观' });
    expect(screen.queryByRole('button', { name: '选择模组目录…' })).toBeNull();
    expect((await look('夏装')).getByRole('button', { name: '删除…' })).toBeTruthy();
    expect((await look('野外装')).getByRole('button', { name: '删除…' })).toBeTruthy();
    expect((await look('日常')).queryByRole('button', { name: '删除…' })).toBeNull();
  });

  it('calls character.importOutfit and disables the key while it runs', async () => {
    const bridge = use(true);
    const imp = vi.spyOn(bridge.character, 'importOutfit').mockReturnValue(new Promise(() => {}));
    await mount();
    fireEvent.click(await key());
    expect(imp).toHaveBeenCalledTimes(1);
    const busy = (await screen.findByRole('button', { name: '导入中…' })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(imp).toHaveBeenCalledTimes(1);
  });

  it('lands the new appearance on top of 外观 with its warning in words until 收起提示, and lists it there', async () => {
    use(true);
    const toast = vi.fn();
    const { show } = await mount(toast);
    fireEvent.click(await key());
    await waitFor(() => expect(toast).toHaveBeenCalledWith('已导入「示例外观」，有 1 处要留意：该开关已在模组中固定，不支持切换', { severity: 'warning' }));
    // It has no switches, so it stays on 导入 and the banner waits on 外观.
    expect(screen.queryByRole('list', { name: '「示例外观」导入提示' })).toBeNull();
    show('look');
    const banner = (await screen.findByText(/已导入/)).closest('[role="status"]') as HTMLElement;
    expect(banner.textContent).toContain('已导入「示例外观」');
    expect(banner.textContent).toContain('1 处导入提示');
    expect(within(screen.getByRole('list', { name: '「示例外观」导入提示' })).getByRole('listitem').textContent).toBe('01该开关已在模组中固定，不支持切换');
    expect((await look('示例外观')).getByRole('button', { pressed: true }).textContent).toBe('示例外观MOD导入的外观');
    fireEvent.click(within(banner).getByRole('button', { name: '收起提示' }));
    expect(screen.queryByRole('list', { name: '「示例外观」导入提示' })).toBeNull();
    expect(screen.queryByText(/已导入「示例外观」/)).toBeNull();
  });

  it('puts the new appearance on and, when it has mod switches, opens 模组设置 on it under the landed banner', async () => {
    const bridge = use(true);
    vi.spyOn(bridge.character, 'importOutfit').mockResolvedValue({ ok: true, appearance: { id: 'imported_field', name: '野外装' }, warnings: [] });
    const wear = vi.spyOn(bridge.avatar, 'setAppearance');
    const { show } = await mount();
    fireEvent.click(await key());
    await waitFor(() => expect(wear).toHaveBeenCalledWith('imported_field'));
    await waitFor(() => expect(window.location.hash).toContain('pane=look'));
    show('look');
    const tab = await screen.findByRole('tab', { name: '模组设置' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('group', { name: '模组设置' })).toBeTruthy();
    expect(screen.getByText(/已导入/).closest('[role="status"]')?.textContent).toContain('已导入「野外装」，已按类别整理 6 个开关项');
    fireEvent.click(screen.getByRole('tab', { name: '外观' }));
    expect((await look('野外装')).getByRole('button', { pressed: true })).toBeTruthy();
    // The banner belongs to 模组设置 while she wears it.
    expect(screen.queryByText(/已导入/)).toBeNull();
  });

  it('puts the new appearance on and stays on 导入 when it has no mod switches', async () => {
    const bridge = use(true);
    const wear = vi.spyOn(bridge.avatar, 'setAppearance');
    const read = vi.spyOn(bridge.agentd, 'request');
    await mount();
    fireEvent.click(await key());
    await waitFor(() => expect(wear).toHaveBeenCalledWith('mod_1a2b3c4d'));
    await waitFor(() => expect(read.mock.calls.filter(([, path]) => path === '/characters/si/mod-settings').length).toBeGreaterThan(1));
    await Promise.all(read.mock.results.map((r) => r.value));
    expect(window.location.hash).not.toContain('pane=look');
  });

  it('says nothing when the user cancels the panel', async () => {
    const bridge = use(true);
    vi.spyOn(bridge.character, 'importOutfit').mockRejectedValue({ code: 'cancelled' });
    const toast = vi.fn();
    await mount(toast);
    fireEvent.click(await key());
    await key();
    await Promise.resolve();
    expect(toast).not.toHaveBeenCalled();
  });

  it('says why in words when outfit_tool refuses the mod', async () => {
    const bridge = use(true);
    vi.spyOn(bridge.character, 'importOutfit').mockRejectedValue({ code: 'unmapped_component', detail: 'unmapped_component:TextureOverrideBody' });
    const toast = vi.fn();
    await mount(toast);
    fireEvent.click(await key());
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        '导入外观没有完成：模组中的「TextureOverrideBody」无法匹配当前角色模型，可能适用于其他角色；请确认目标角色或更换模组',
        { severity: 'danger' },
      ),
    );
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('桌面角色没有给出原因'), expect.anything());
  });

  it('says what the import left out, the first two in words', async () => {
    use(true);
    const toast = vi.fn();
    const { show } = await mount(toast);
    // After mount: opening the tab writes the hash.
    window.location.hash = '#/character?demo=outfitwarn';
    fireEvent.click(await key());
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        '已导入「示例外观」，有 3 处要留意：贴图「Textures/Body-Emission.dds」未找到对应部件，未应用；贴图「Textures/Body-Diffuse.dds」缺少多级渐远纹理（Mipmaps），远景显示可能较模糊',
        { severity: 'warning' },
      ),
    );
    show('look');
    expect(within(await screen.findByRole('list', { name: '「示例外观」导入提示' })).getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('角色页 · 导入进度', () => {
  it('shows the folder, the six stages and the percent while an outfit imports, and nothing for another kind', async () => {
    const bridge = use(true);
    vi.spyOn(bridge.character, 'importState').mockResolvedValue({ running: true, kind: 'outfit', title: 'FieldWear_v2', stage: 'write', fraction: 0.58 });
    await mount();
    const bar = await screen.findByRole('progressbar', { name: '写入角色包' });
    expect(bar.getAttribute('aria-valuenow')).toBe('58');
    const card = bar.closest('[data-import-progress]') as HTMLElement;
    expect(card.textContent).toContain('FieldWear_v2');
    expect(Array.from(card.querySelectorAll('li')).map((l) => [l.textContent, l.dataset.state ?? ''])).toEqual([
      ['读取文件', 'done'],
      ['合成外观', 'done'],
      ['写入角色包', 'cur'],
      ['校验', ''],
      ['发布', ''],
      ['载入角色', ''],
    ]);
    expect(((await screen.findByRole('button', { name: '导入中…' })) as HTMLButtonElement).disabled).toBe(true);
  });

  it('holds the key while a motion import runs, without an outfit progress card', async () => {
    const bridge = use(true);
    vi.spyOn(bridge.character, 'importState').mockResolvedValue({ running: true, kind: 'motion', title: 'Dance', stage: 'retarget', fraction: 0.4 });
    await mount();
    await waitFor(async () => expect(((await key()) as HTMLButtonElement).disabled).toBe(true));
    expect((await key()).title).toBe('另一项导入尚未完成');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const FIELD = { ok: true as const, appearance: { id: 'imported_field', name: '野外装' }, warnings: [] };
type Import = Awaited<ReturnType<AgenticComplexBridge['character']['importOutfit']>>;

describe('角色页 · 导入外观之后', () => {
  it('does not open 模组设置 when putting the new appearance on fails', async () => {
    const bridge = use(true);
    vi.spyOn(bridge.character, 'importOutfit').mockResolvedValue(FIELD);
    vi.spyOn(bridge.avatar, 'setAppearance').mockRejectedValue({ code: 'failed' });
    const read = vi.spyOn(bridge.agentd, 'request');
    const toast = vi.fn();
    await mount(toast);
    fireEvent.click(await key());
    await waitFor(() => expect(toast).toHaveBeenCalledWith('切换外观未完成：角色渲染进程无响应', { severity: 'danger' }));
    await waitFor(() => expect(read.mock.calls.filter(([, path]) => path === '/characters/si/mod-settings').length).toBeGreaterThan(1));
    await Promise.all(read.mock.results.map((r) => r.value));
    await act(async () => {});
    expect(window.location.hash).not.toContain('pane=look');
  });

  it('stays 导入中 until the new appearance is on', async () => {
    const bridge = use(true);
    vi.spyOn(bridge.character, 'importOutfit').mockResolvedValue(FIELD);
    const on = deferred<void>();
    const wear = vi.spyOn(bridge.avatar, 'setAppearance').mockReturnValue(on.promise);
    await mount();
    fireEvent.click(await key());
    await waitFor(() => expect(wear).toHaveBeenCalledWith('imported_field'));
    expect(screen.getByRole('button', { name: '导入中…' })).toBeTruthy();
    await act(async () => on.resolve());
    expect(await key()).toBeTruthy();
  });

  it('neither puts it on nor opens the character page after the page is gone', async () => {
    const bridge = use(true);
    const done = deferred<Import>();
    vi.spyOn(bridge.character, 'importOutfit').mockReturnValue(done.promise);
    const wear = vi.spyOn(bridge.avatar, 'setAppearance');
    const ui = await mount();
    fireEvent.click(await key());
    ui.unmount();
    await act(async () => done.resolve(FIELD));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(wear).not.toHaveBeenCalled();
    expect(window.location.hash).not.toContain('pane=look');
  });

  it('does not put it on the character switched to meanwhile', async () => {
    const bridge = use(true);
    const done = deferred<Import>();
    vi.spyOn(bridge.character, 'importOutfit').mockReturnValue(done.promise);
    const wear = vi.spyOn(bridge.avatar, 'setAppearance');
    const { show } = await mount();
    fireEvent.click(await key());
    show('import', 'voice_a');
    await act(async () => done.resolve(FIELD));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(wear).not.toHaveBeenCalled();
    expect(window.location.hash).not.toContain('pane=look');
  });

  it('stays where the user went during a long import instead of opening 模组设置', async () => {
    const bridge = use(true);
    const done = deferred<Import>();
    vi.spyOn(bridge.character, 'importOutfit').mockReturnValue(done.promise);
    const wear = vi.spyOn(bridge.avatar, 'setAppearance');
    const { show } = await mount();
    fireEvent.click(await key());
    show('motion');
    await act(async () => done.resolve(FIELD));
    await waitFor(() => expect(wear).toHaveBeenCalledWith('imported_field'));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(window.location.hash).not.toContain('pane=look');
  });

  it('keeps the newer of two mod-table reads', async () => {
    const bridge = use(true);
    const replies: Array<(id: string) => void> = [];
    vi.spyOn(bridge.agentd, 'request').mockImplementation(
      () =>
        new Promise((r) =>
          replies.push((id) =>
            r({ status: 200, body: { character: 'si', package_sha256: '', schema: '', appearances: { [id]: { settings: [{ id: 'glow', name: '发光', default: 0, values: [{ value: 0, name: '关' }] }] } } } as never }),
          ),
        ),
    );
    const { result } = renderHook(() => useModTable('si', false));
    let older: Promise<unknown> = Promise.resolve();
    let newer: Promise<unknown> = Promise.resolve();
    act(() => {
      older = result.current.reload();
      newer = result.current.reload();
    });
    await act(async () => {
      replies[1]!('new');
      await newer;
    });
    await act(async () => {
      replies[0]!('old');
      await older;
    });
    expect(Object.keys(result.current.looks)).toEqual(['new']);
  });
});

describe('角色页 · 删除导入的外观', () => {
  /** Opens on 外观, where 删除… sits on each imported row. */
  const onLook = async (toast: Toast = noop) => (await mount(toast)).show('look');

  it('asks first, then removes it, says so and reads the roster again', async () => {
    const bridge = use(true);
    await bridge.character.importOutfit();
    const remove = vi.spyOn(bridge.character, 'removeOutfit');
    const toast = vi.fn();
    await onLook(toast);
    fireEvent.click((await look('示例外观')).getByRole('button', { name: '删除…' }));
    const dialog = await screen.findByRole('dialog', { name: '删除「示例外观」' });
    expect(dialog.textContent).toContain('模组设置');
    expect(dialog.textContent).toContain('恢复至导入前状态');
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    expect(remove).toHaveBeenCalledWith('si', 'mod_1a2b3c4d');
    await waitFor(() => expect(toast).toHaveBeenCalledWith('已删除「示例外观」'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^示例外观/ })).toBeNull());
  });

  it('cancel keeps the appearance', async () => {
    const bridge = use(true);
    await bridge.character.importOutfit();
    const remove = vi.spyOn(bridge.character, 'removeOutfit');
    await onLook();
    fireEvent.click((await look('示例外观')).getByRole('button', { name: '删除…' }));
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(remove).not.toHaveBeenCalled();
  });

  it('says why in words when outfit_tool does not remove it', async () => {
    const bridge = use(true);
    await bridge.character.importOutfit();
    vi.spyOn(bridge.character, 'removeOutfit').mockRejectedValue({ code: 'busy', detail: 'another outfit import is running' });
    const toast = vi.fn();
    await onLook(toast);
    fireEvent.click((await look('示例外观')).getByRole('button', { name: '删除…' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(`删除外观没有完成：${OUTFIT_IMPORT_REASON.busy}`, { severity: 'danger' }));
    expect(((await look('示例外观')).getByRole('button', { name: '删除…' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('is disabled while it runs, and so is the import key', async () => {
    const bridge = use(true);
    await bridge.character.importOutfit();
    vi.spyOn(bridge.character, 'removeOutfit').mockReturnValue(new Promise(() => {}));
    const { show } = await mount();
    show('look');
    fireEvent.click((await look('示例外观')).getByRole('button', { name: '删除…' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '删除' }));
    expect(((await screen.findByRole('button', { name: '删除中…' })) as HTMLButtonElement).disabled).toBe(true);
    expect(((await look('夏装')).getByRole('button', { name: '删除…' }) as HTMLButtonElement).disabled).toBe(true);
    show('import');
    expect(((await key()) as HTMLButtonElement).disabled).toBe(true);
    expect((await key()).title).toBe('删除外观尚未完成');
  });
});

describe('导入外观 · 要留意的地方', () => {
  it('names the file or section after the code, and keeps a code it does not know as it came', () => {
    expect(outfitImportWarning('texture_unbound:Textures/a.dds')).toBe('贴图「Textures/a.dds」未找到对应部件，未应用');
    expect(outfitImportWarning('bones_appended:S_actor_body:3')).toBe('模组为「S_actor_body」追加了骨骼');
    expect(outfitImportWarning('shapekey_ignored')).toBe('模组的形态键未应用');
    expect(outfitImportWarning('brand_new:x')).toBe('brand_new:x');
  });

  it('names after a skipped shader patch the textures that only it reads', () => {
    expect(outfitImportWarning('shader_patch_ignored:Cutout.ini')).toBe('模组中的「Cutout.ini」修改了游戏着色器，未应用');
    expect(outfitImportWarning('shader_patch_ignored:Skin.ini:Assets/a.dds:Assets/b.dds'))
      .toBe('模组中的「Skin.ini」修改了游戏着色器，未应用；其专用贴图「Assets/a.dds」「Assets/b.dds」亦未应用');
  });

  it('says the mod-settings codes in one sentence each', () => {
    expect(outfitImportWarning('setting_fixed:glow')).toBe('该开关已在模组中固定，不支持切换');
    expect(outfitImportWarning('variant_unplaced')).toBe('部分贴图变体未找到对应部件，未导入');
    expect(outfitImportWarning('segment_unmappable:3')).toBe('部分部件无法匹配当前角色模型，未导入');
  });
});

/** IMPORT_REASONS of agent/agentd/outfit_tool.py, read from the file so a new code fails here until it has words. */
const IMPORT_REASONS = [
  ...readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../agent/agentd/outfit_tool.py'), 'utf8')
    .match(/^IMPORT_REASONS = \(([^)]*)\)/m)![1]!
    .matchAll(/"(\w+)"/g),
].map((m) => m[1]!);

describe('导入外观 · 失败原因', () => {
  it('has words of its own for every IMPORT_REASONS code', () => {
    expect(IMPORT_REASONS.length).toBeGreaterThan(30);
    expect(IMPORT_REASONS.filter((code) => !(code in OUTFIT_IMPORT_REASON))).toEqual([]);
  });

  it('names the mod file or section a prefixed detail carries', () => {
    expect(outfitImportReason('texture_mismatch', 'summer: texture_mismatch:3:body.dds: candidates a; b')).toBe(
      '无法识别模组贴图「body.dds」对应的模型部件；请更换模组或等待后续版本支持',
    );
    expect(outfitImportReason('unsupported_geometry', 'unsupported_geometry:custom_shader_output:ResourceBodyPosition')).toBe(
      '模组中的「ResourceBodyPosition」使用自定义着色器生成模型，当前版本暂不支持；请更换模组或等待后续版本支持',
    );
    expect(outfitImportReason('unsupported_geometry', 'unsupported_geometry:shapekey_default:2')).toBe(
      '模组默认启用了形态键，当前版本暂不支持；请更换模组或等待后续版本支持',
    );
    expect(outfitImportReason('unsupported_mod', 'summer: unsupported_mod:nothing_to_import')).toBe(OUTFIT_IMPORT_REASON.nothing_to_import);
  });

  it('falls back to the code words, then to words of its own for a code it does not know', () => {
    expect(outfitImportReason('unsupported_geometry', 'unsupported_geometry:new_kind:X')).toBe(OUTFIT_IMPORT_REASON.unsupported_geometry);
    expect(outfitImportReason('missing_channel', undefined)).toBe(OUTFIT_IMPORT_REASON.missing_channel);
    expect(outfitImportReason('internal', 'unknown_character: si')).toBe('unknown_character: si');
    expect(outfitImportReason('no_such_code', 'no_such_code:x')).toBe(OUTFIT_IMPORT_UNKNOWN);
  });
});
