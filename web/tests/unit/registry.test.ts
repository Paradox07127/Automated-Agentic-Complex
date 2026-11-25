import { describe, expect, it } from 'vitest';
import { findRoute, pageRoutes } from '../../src/shell/registry';
import { parseDemo } from '../../src/shell/demo';
import { searchSettings } from '../../src/pages/settings/registry';

const pages = ['home', 'overview', 'chat', 'memory', 'character', 'mmd', 'settings', 'diag'];
const hidden = ['onboarding', 'tasks'];

describe('route registry', () => {
  it('auto-registers the 8 pages and the hidden onboarding page', () => {
    expect(pageRoutes.map((r) => r.id).sort()).toEqual([...pages, ...hidden].sort());
  });

  it('keeps id, path and directory aligned and orders are unique', () => {
    const modules = import.meta.glob('../../src/pages/*/route.ts', { eager: true });
    const dirs = Object.keys(modules).map((k) => k.split('/').at(-2));
    expect(dirs.sort()).toEqual(pageRoutes.map((r) => r.id).sort());
    for (const r of pageRoutes) expect(r.path).toBe(`/${r.id}`);
    expect(new Set(pageRoutes.map((r) => r.order)).size).toBe(pageRoutes.length);
  });

  it('gives every route at least one demo', () => {
    for (const r of pageRoutes) expect(r.demos.length).toBeGreaterThan(0);
  });

  it('sorts 主页 / 每日简报 / 对话 / 记忆 first with ⌘0–⌘3, then 角色 ⌘4, MMD, 设置 ⌘, with 诊断 only in 开发者模式', () => {
    const app = pageRoutes.filter((r) => r.nav !== false);
    expect(app.map((r) => r.id)).toEqual(pages);
    expect(app.filter((r) => r.group === 'primary').map((r) => r.id)).toEqual(['home', 'overview', 'chat', 'memory']);
    expect(app.flatMap((r) => (r.hotkey ? [r.hotkey] : []))).toEqual(['⌘0', '⌘1', '⌘2', '⌘3', '⌘4', '⌘,']);
    expect(app.filter((r) => r.devOnly).map((r) => r.id)).toEqual(['diag']);
    expect(findRoute('/overview')?.title).toBe('每日简报');
    expect(findRoute('/home')?.title).toBe('主页');
  });
});

describe('character settings search', () => {
  it('finds every character row under 角色 › 行为 or 角色 › 画面', () => {
    expect(searchSettings('描边')).toContainEqual(
      expect.objectContaining({ id: 'rnd.outline', group: '@character', section: '角色 › 画面' }),
    );
    expect(searchSettings('朝向').map((r) => r.id)).toContain('beh.watch');
    expect(searchSettings('抗锯齿').map((r) => r.id)).toContain('rnd.aa');
    expect(searchSettings('待在原地').find((r) => r.id === 'beh.stay')?.section).toBe('角色 › 行为');
    expect(searchSettings('缩放').map((r) => r.id)).toContain('rnd.zoom');
    expect(searchSettings('晃动').map((r) => r.id)).toContain('rnd.sway');
    expect(searchSettings('近景').map((r) => r.id)).toContain('rnd.closeup');
    expect(searchSettings('相机').map((r) => r.id)).toContain('rnd.track');
    for (const id of ['rnd.zoom', 'rnd.sway', 'rnd.closeup', 'rnd.track']) expect(searchSettings('镜头').find((r) => r.id === id)?.section, id).toBe('角色 › 画面');
  });
});

describe('demo URL state', () => {
  it('parses state, still, demo and theme', () => {
    expect(parseDemo('?state=loading&still=1&demo=palette&theme=light')).toEqual({
      state: 'loading',
      still: true,
      demo: 'palette',
      theme: 'light',
    });
  });

  it('ignores unknown states and leaves theme to the system', () => {
    expect(parseDemo('?state=bogus')).toEqual({ state: null, still: false, demo: null, theme: null });
  });
});

describe('model settings search', () => {
  it('finds the Pi catalog provider in 模型服务, where it is picked, and the compatible-API capability rows', () => {
    const ids = (q: string) => searchSettings(q).map((r) => r.id);
    expect(ids('服务提供方')).toContain('svc');
    expect(ids('openrouter')).toEqual(['svc']);
    expect(ids('上下文长度')).toContain('ctxWindow');
    expect(ids('最大输出')).toContain('maxOut');
    expect(ids('图像输入')).toContain('images');
    expect(ids('reasoning')).toContain('reasoning');
  });
});
