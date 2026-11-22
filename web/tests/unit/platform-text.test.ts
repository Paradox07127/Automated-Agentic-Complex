// Key and Finder wording on each shell, and the settings rows the platform helper's ops decide.
import { describe, expect, it } from 'vitest';
import { hotkeyText, keyText, revealText } from '../../src/bridge/platformText';
import { rowShown } from '../../src/pages/settings/registry';
import { PLUGINS } from '../../src/bridge/plugins.generated';
import type { PluginState } from '../../src/shell/plugins';

describe('platform wording', () => {
  it('keeps the macOS glyphs and spells Ctrl, Alt and Shift on Windows', () => {
    for (const text of ['⌘K', '搜索设置… ⌘F', '输入消息，⌘↩ 发送给 X', '⌘↵', '⇧⏎ 换行']) expect(keyText(text, 'mac')).toBe(text);
    expect(keyText('⌘K', 'windows')).toBe('Ctrl+K');
    expect(keyText('搜索设置… ⌘F', 'windows')).toBe('搜索设置… Ctrl+F');
    expect(keyText('输入消息，⌘↩ 发送给 X', 'windows')).toBe('输入消息，Ctrl+↩ 发送给 X');
    expect(keyText('⇧⌘K', 'windows')).toBe('Shift+Ctrl+K');
  });

  it('names a hot key\'s ⌘ the Windows key and leaves a lone cap without +', () => {
    for (const caps of ['⌃⌥L', '右⌥', '⌃Space', '⇧⌘K']) expect(hotkeyText(caps, 'mac')).toBe(caps);
    expect(hotkeyText('⌃⌥L', 'windows')).toBe('Ctrl+Alt+L');
    expect(hotkeyText('⌃Space', 'windows')).toBe('Ctrl+Space');
    expect(hotkeyText('右⌥', 'windows')).toBe('右Alt');
    expect(hotkeyText('⇧⌘K', 'windows')).toBe('Shift+Win+K');
    expect(hotkeyText('要带 ⌃、⌥ 或 ⌘', 'windows')).toBe('要带 Ctrl、Alt 或 Win');
    expect(hotkeyText('只有这一项可以单用右 ⌥', 'windows')).toBe('只有这一项可以单用右 Alt');
  });

  it('shows in 资源管理器 on Windows and in Finder on macOS', () => {
    expect(revealText('在 Finder 中显示', 'mac')).toBe('在 Finder 中显示');
    expect(revealText('在 Finder 中显示', 'windows')).toBe('在资源管理器中显示');
    expect(revealText('已在 Finder 中显示：a.txt', 'windows')).toBe('已在资源管理器中显示：a.txt');
  });
});

describe('settings rows by the helper\'s ops', () => {
  const plugins = Object.fromEntries(PLUGINS.map((p) => [p.id, true])) as PluginState;
  const all = { helperPushToTalk: true, helperWindowText: true, helperTypedText: true, helperActionTimeline: true, helperSelectedText: true };
  const ROWS = ['hk_ptt', 'asr', 'wintext', 'grain', 'typing', 'actions', 'hk_sel'];

  it('shows every row when the helper has every op', () => {
    for (const id of [...ROWS, 'web', 'hk_quick']) expect(rowShown(id, plugins, false, all), id).toBe(true);
  });

  it('hides 窗口文字 and 屏幕理解粒度 when the helper lacks ax.window_text, and only them', () => {
    const caps = { ...all, helperWindowText: false };
    expect(ROWS.filter((id) => !rowShown(id, plugins, false, caps))).toEqual(['wintext', 'grain']);
  });

  it('hides each row whose ops are missing', () => {
    const none = { helperPushToTalk: false, helperWindowText: false, helperTypedText: false, helperActionTimeline: false, helperSelectedText: false };
    expect(ROWS.filter((id) => rowShown(id, plugins, true, none))).toEqual([]);
    expect(rowShown('hk_quick', plugins, false, none)).toBe(true);
  });
});
