// 设置 › 显示 › 外观 on the main window: the native theme, the window's glass ground, what its page shows of them, and zoom.
import type { ShellPlatform } from './config.ts';
import type { SettingValue } from './settings.ts';

export type ThemeSource = 'system' | 'light' | 'dark';

export interface Appearance {
  theme: ThemeSource;
  /** The window has a glass ground: the row says 磨砂 and the system can draw it. */
  glass: boolean;
  /** Percent of the page's ground laid over the glass. */
  glassAlpha: number;
  /** 减少动效 is on; off follows the system's setting. */
  reduceMotion: boolean;
  zoom: number;
}

/** What the main window's page takes over `APPEARANCE_CHANNEL`. */
export type PageAppearance = Pick<Appearance, 'glass' | 'glassAlpha' | 'reduceMotion'>;

export const APPEARANCE_CHANNEL = 'appearance';

/** Windows 11 22H2 (build 22621) is the first Windows that takes a background material. */
export function glassSupported(platform: ShellPlatform, release: string): boolean {
  if (platform === 'mac') return true;
  const [major = 0, , build = 0] = release.split('.').map(Number);
  return major >= 10 && build >= 22621;
}

/** `values` are settings.ts `current` values; `glassAllowed` is false where the system draws no glass or reduces transparency. */
export function appearanceOf(values: Record<string, SettingValue>, glassAllowed: boolean): Appearance {
  return {
    theme: values.app_theme as ThemeSource,
    glass: glassAllowed && values.window_background === 'glass',
    glassAlpha: Number(values.window_glass_alpha),
    reduceMotion: values.reduce_motion === 'on',
    zoom: Number(values.ui_zoom) / 100,
  };
}

/** The main window's constructor options for its ground. Acrylic, not mica: it blurs whatever is behind the window, as
 *  macOS's under-window vibrancy does, where mica tints with the wallpaper only. */
export function mainWindowGround(platform: ShellPlatform, glass: boolean) {
  if (platform === 'windows') return glass ? { backgroundMaterial: 'acrylic' as const } : {};
  return glass
    ? { vibrancy: 'under-window' as const, visualEffectState: 'followWindow' as const, backgroundColor: '#00000000' }
    : { backgroundColor: '#00000000' };
}

export interface AppearanceTargets {
  theme: { themeSource: ThemeSource };
  window: {
    setVibrancy(type: 'under-window' | null): void;
    setBackgroundMaterial(material: 'acrylic' | 'none'): void;
    webContents: { setZoomMode(mode: 'isolated'): void; setZoomFactor(factor: number): void; send(channel: string, page: PageAppearance): void };
  } | null;
}

/** Sets the theme only when it differs: setting it fires nativeTheme's `updated`, which applies again. The zoom is the main
 *  window's own; the default per-origin zoom would reach the desktop panels, which load from the same origin. */
export function applyAppearance(a: Appearance, platform: ShellPlatform, t: AppearanceTargets): void {
  if (t.theme.themeSource !== a.theme) t.theme.themeSource = a.theme;
  if (!t.window) return;
  if (platform === 'windows') t.window.setBackgroundMaterial(a.glass ? 'acrylic' : 'none');
  else t.window.setVibrancy(a.glass ? 'under-window' : null);
  const contents = t.window.webContents;
  contents.setZoomMode('isolated');
  contents.setZoomFactor(a.zoom);
  contents.send(APPEARANCE_CHANNEL, { glass: a.glass, glassAlpha: a.glassAlpha, reduceMotion: a.reduceMotion });
}

interface RootLike {
  toggleAttribute(name: string, force: boolean): boolean;
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): string };
}

/** `<html data-window-glass>` and `--ef-glass-alpha` over glass only; `<html data-reduce-motion>` while 减少动效 is on. */
export function applyPage(root: RootLike, p: PageAppearance): void {
  root.toggleAttribute('data-window-glass', p.glass);
  if (p.glass) root.style.setProperty('--ef-glass-alpha', `${p.glassAlpha}%`);
  else root.style.removeProperty('--ef-glass-alpha');
  root.toggleAttribute('data-reduce-motion', p.reduceMotion);
}
