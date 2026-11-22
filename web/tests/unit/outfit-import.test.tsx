// skins-15w: 角色页「导入」页签的「导入外观…」调 character.importOutfit，成功后导入的外观列在下面、外观选项里也有；每个导入的外观可以删除。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { NOW } from '../../src/mock/fixtures';
import { MOTIONS, STATE_WITH_CAUSES } from '../../src/mock/character';
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
function Harness({ toast, pane }: { toast: Toast; pane: 'import' | 'look' }) {
  const list = useQuery({ queryKey: ['character', 'list'], queryFn: () => window.agenticComplex!.character.list() });
  if (!list.data) return null;
  const cur = list.data.find((c) => c.active)?.id ?? list.data[0]?.id ?? '';
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

/** Opens on 导入; `show('look')` switches to the 外观 pane, as the page's tab does. */
const mount = (toast: Toast = noop) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const at = (pane: 'import' | 'look') => (
    <QueryClientProvider client={client}>
      <Harness toast={toast} pane={pane} />
    </QueryClientProvider>
  );
  const ui = render(at('import'));
  return { ...ui, show: (pane: 'import' | 'look') => ui.rerender(at(pane)) };
};

const looks = () => screen.queryByRole('list', { name: '导入的外观' });
const look = async (name: string) => within(await screen.findByRole('group', { name }));

describe('角色页 · 导入外观', () => {
  it('has no import button without a native file picker', async () => {
    use(false);
    mount();
    await screen.findByRole('region', { name: '外观与 mod' });
    expect(screen.queryByRole('button', { name: '导入外观…' })).toBeNull();
  });

  it('lists the imported appearances on 导入, and neither 导入外观… nor 删除 on 外观', async () => {
    use(true);
    const { show } = mount();
    await screen.findByRole('button', { name: '导入外观…' });
    expect(within(looks()!).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['夏装', '野外装']);
    show('look');
    await screen.findByRole('listbox', { name: '外观' });
    expect(screen.queryByRole('button', { name: '导入外观…' })).toBeNull();
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
  });

  it('calls character.importOutfit and disables the button while it runs', async () => {
    const bridge = use(true);
    const imp = vi.spyOn(bridge.character, 'importOutfit').mockReturnValue(new Promise(() => {}));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '导入外观…' }));
    expect(imp).toHaveBeenCalledTimes(1);
    const busy = await screen.findByRole('button', { name: '导入中…' });
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(busy);
    expect(imp).toHaveBeenCalledTimes(1);
  });

  it('lists the new appearance with its warning in words until closed, and offers it 导入 on 外观', async () => {
    use(true);
    const toast = vi.fn();
    const { show } = mount(toast);
    fireEvent.click(await screen.findByRole('button', { name: '导入外观…' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('已导入「示例外观」，有 1 处要留意：这个开关在 mod 里写死了，不能切换', { severity: 'warning' }));
    const row = await look('示例外观');
    expect(row.getByRole('list', { name: '「示例外观」导入提示' }).textContent).toBe('这个开关在 mod 里写死了，不能切换');
    fireEvent.click(row.getByRole('button', { name: '关闭提示' }));
    expect(screen.queryByRole('list', { name: '「示例外观」导入提示' })).toBeNull();
    show('look');
    const opts = within(await screen.findByRole('listbox', { name: '外观' })).getAllByRole('option');
    expect(opts.map((o) => o.textContent)).toContain('示例外观导入');
  });

  it('puts the new appearance on and, when it has mod switches, opens 模组设置 on it', async () => {
    const bridge = use(true);
    vi.spyOn(bridge.character, 'importOutfit').mockResolvedValue({ ok: true, appearance: { id: 'imported_field', name: '野外装' }, warnings: [] });
    const wear = vi.spyOn(bridge.avatar, 'setAppearance');
    const { show } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '导入外观…' }));
    await waitFor(() => expect(wear).toHaveBeenCalledWith('imported_field'));
    await waitFor(() => expect(window.location.hash).toContain('pane=look'));
    show('look');
    const tab = await screen.findByRole('tab', { name: '模组设置' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('group', { name: 'mod 设置' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '外观' }));
    expect(within(screen.getByRole('listbox', { name: '外观' })).getByRole('option', { selected: true }).textContent).toBe('野外装导入');
  });

  it('puts the new appearance on and stays on 导入 when it has no mod switches', async () => {
    const bridge = use(true);
    const wear = vi.spyOn(bridge.avatar, 'setAppearance');
    const read = vi.spyOn(bridge.agentd, 'request');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '导入外观…' }));
    await waitFor(() => expect(wear).toHaveBeenCalledWith('mod_1a2b3c4d'));
    await waitFor(() => expect(read.mock.calls.filter(([, path]) => path === '/characters/si/mod-settings').length).toBeGreaterThan(1));
    await Promise.all(read.mock.results.map((r) => r.value));
    expect(window.location.hash).not.toContain('pane=look');
  });

  it('says nothing when the user cancels the panel', async () => {
    const bridge = use(true);
    vi.spyOn(bridge.character, 'importOutfit').mockRejectedValue({ code: 'cancelled' });
    const toast = vi.fn();
    mount(toast);
    fireEvent.click(await screen.findByRole('button', { name: '导入外观…' }));
    await screen.findByRole('button', { name: '导入外观…' });
    await Promise.resolve();
    expect(toast).not.toHaveBeenCalled();
  });

  it('says why in words when outfit_tool refuses the mod', async () => {
    const bridge = use(true);
    vi.spyOn(bridge.character, 'importOutfit').mockRejectedValue({ code: 'unmapped_component', detail: 'unmapped_component:TextureOverrideBody' });
    const toast = vi.fn();
    mount(toast);
    fireEvent.click(await screen.findByRole('button', { name: '导入外观…' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        '导入外观没有完成：模组里的「TextureOverrideBody」对不上这个角色的模型，可能是给别的角色做的；请确认角色，或换一个模组',
        { severity: 'danger' },
      ),
    );
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('桌面角色没有给出原因'), expect.anything());
  });

  it('says what the import left out, the first two in words', async () => {
    window.location.hash = '#/character?demo=outfitwarn';
    use(true);
    const toast = vi.fn();
    mount(toast);
    fireEvent.click(await screen.findByRole('button', { name: '导入外观…' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        '已导入「示例外观」，有 3 处要留意：贴图「Textures/Body-Emission.dds」找不到该套的部件，没有用上；贴图「Textures/Body-Diffuse.dds」没有缩小用的多级图，远看可能发虚',
        { severity: 'warning' },
      ),
    );
    expect((await look('示例外观')).getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('角色页 · 删除导入的外观', () => {
  it('asks first, then removes it, says so and reads the roster again', async () => {
    const bridge = use(true);
    await bridge.character.importOutfit();
    const remove = vi.spyOn(bridge.character, 'removeOutfit');
    const toast = vi.fn();
    mount(toast);
    fireEvent.click((await look('示例外观')).getByRole('button', { name: '删除…' }));
    const dialog = await screen.findByRole('dialog', { name: '删除「示例外观」' });
    expect(dialog.textContent).toContain('模组设置');
    expect(dialog.textContent).toContain('恢复成导入前的样子');
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    expect(remove).toHaveBeenCalledWith('mod_1a2b3c4d');
    await waitFor(() => expect(toast).toHaveBeenCalledWith('已删除「示例外观」'));
    await waitFor(() => expect(screen.queryByRole('group', { name: '示例外观' })).toBeNull());
  });

  it('cancel keeps the appearance', async () => {
    const bridge = use(true);
    await bridge.character.importOutfit();
    const remove = vi.spyOn(bridge.character, 'removeOutfit');
    mount();
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
    mount(toast);
    fireEvent.click((await look('示例外观')).getByRole('button', { name: '删除…' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(`删除外观没有完成：${OUTFIT_IMPORT_REASON.busy}`, { severity: 'danger' }));
    expect((await look('示例外观')).getByRole('button', { name: '删除…' }).getAttribute('aria-disabled')).not.toBe('true');
  });

  it('is disabled while it runs', async () => {
    const bridge = use(true);
    await bridge.character.importOutfit();
    vi.spyOn(bridge.character, 'removeOutfit').mockReturnValue(new Promise(() => {}));
    mount();
    fireEvent.click((await look('示例外观')).getByRole('button', { name: '删除…' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '删除' }));
    expect((await screen.findByRole('button', { name: '删除中…' })).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('button', { name: '导入外观…' }).getAttribute('aria-disabled')).toBe('true');
    expect((await look('夏装')).getByRole('button', { name: '删除…' }).getAttribute('aria-disabled')).toBe('true');
  });
});

describe('导入外观 · 要留意的地方', () => {
  it('names the file or section after the code, and keeps a code it does not know as it came', () => {
    expect(outfitImportWarning('texture_unbound:Textures/a.dds')).toBe('贴图「Textures/a.dds」找不到该套的部件，没有用上');
    expect(outfitImportWarning('bones_appended:S_actor_body:3')).toBe('模组给「S_actor_body」新加了骨骼');
    expect(outfitImportWarning('shapekey_ignored')).toBe('模组的形态键没有套上');
    expect(outfitImportWarning('brand_new:x')).toBe('brand_new:x');
  });

  it('says the mod-settings codes in one sentence each', () => {
    expect(outfitImportWarning('setting_fixed:glow')).toBe('这个开关在 mod 里写死了，不能切换');
    expect(outfitImportWarning('variant_unplaced')).toBe('有贴图变体找不到对应部件，没有导入');
    expect(outfitImportWarning('segment_unmappable:3')).toBe('有部件对不上角色模型，没有导入');
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
      '认不出模组的贴图「body.dds」该套在哪个部件上；可以换一个模组，或等更新',
    );
    expect(outfitImportReason('unsupported_geometry', 'unsupported_geometry:custom_shader_output:ResourceBodyPosition')).toBe(
      '模组的「ResourceBodyPosition」用自己的着色器生成模型，本程序还不支持；可以换一个模组，或等更新',
    );
    expect(outfitImportReason('unsupported_geometry', 'unsupported_geometry:shapekey_default:2')).toBe(
      '模组默认打开了形态键，本程序还不支持；可以换一个模组，或等更新',
    );
    expect(outfitImportReason('unsupported_mod', 'summer: unsupported_mod:nothing_to_import')).toBe(OUTFIT_IMPORT_REASON.nothing_to_import);
  });

  it('falls back to the code words, then to words of its own for a code it does not know', () => {
    expect(outfitImportReason('unsupported_geometry', 'unsupported_geometry:new_kind:X')).toBe(OUTFIT_IMPORT_REASON.unsupported_geometry);
    expect(outfitImportReason('texture_format', undefined)).toBe(OUTFIT_IMPORT_REASON.texture_format);
    expect(outfitImportReason('internal', 'unknown_character: si')).toBe('unknown_character: si');
    expect(outfitImportReason('no_such_code', 'no_such_code:x')).toBe(OUTFIT_IMPORT_UNKNOWN);
  });
});
