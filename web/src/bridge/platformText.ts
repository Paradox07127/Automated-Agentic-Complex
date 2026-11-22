// Key and file-manager wording on the shell's platform: the macOS text is the source, Windows gets its own words.
import type { AgenticComplexBridge } from './protocol';

export type ShellPlatform = AgenticComplexBridge['platform'];

/** In-window shortcuts: the page reads ⌘ as Ctrl on Windows. */
const PAGE_WORDS: Readonly<Record<string, string>> = { '⌘': 'Ctrl', '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' };
/** Global hot keys: `command` is the Windows key there. */
const HOTKEY_WORDS: Readonly<Record<string, string>> = { ...PAGE_WORDS, '⌘': 'Win' };

/** Not getBridge(): modules the fake bridge imports use this too. A plain browser counts as macOS. */
export function shellPlatform(): ShellPlatform {
  return window.agenticComplex?.platform ?? 'mac';
}

function spell(text: string, words: Readonly<Record<string, string>>): string {
  // A word joins the key after it with +, not the text after a cap (`右⌥`, `⌃、⌥`).
  return text.replace(/[⌘⌃⌥⇧]/g, (glyph: string, at: number) => words[glyph] + (/^[^\s、，。）)]/.test(text.slice(at + 1)) ? '+' : ''));
}

/** A main-window shortcut hint: `⌘K` stays on macOS, `Ctrl+K` on Windows. */
export function keyText(text: string, platform: ShellPlatform = shellPlatform()): string {
  return platform === 'windows' ? spell(text, PAGE_WORDS) : text;
}

/** A global hot key's caps: `⌃⌥L` stays on macOS, `Ctrl+Alt+L` on Windows, ⌘ there being the Windows key. */
export function hotkeyText(caps: string, platform: ShellPlatform = shellPlatform()): string {
  return platform === 'windows' ? spell(caps, HOTKEY_WORDS) : caps;
}

/** 「在 Finder 中显示」 and its toasts name 资源管理器 on Windows. */
export function revealText(text: string, platform: ShellPlatform = shellPlatform()): string {
  return platform === 'windows' ? text.replace('在 Finder 中', '在资源管理器中') : text;
}
