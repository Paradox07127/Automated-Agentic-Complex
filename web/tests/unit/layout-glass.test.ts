// The main window over its glass ground: the shell sets <html data-window-glass> and --ef-glass-alpha
// (app/electron/src/common/appearance.ts applyPage). jsdom does not cascade these sheets, so the rules are read as text.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '../../src', path), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
}

describe('window glass', () => {
  it('leaves the body clear and drops the grain', () => {
    const base = read('design/base.css');
    expect(rule(base, 'html[data-window-glass] body')).toMatch(/background: transparent;/);
    expect(rule(base, 'html[data-window-glass] body::after')).toMatch(/content: none;/);
  });

  it('lays the main area\'s ground over the glass only at --ef-glass-alpha; 主页 stays bare', () => {
    const layout = read('shell/Layout.module.css');
    expect(rule(layout, ':global(html[data-window-glass]) .main')).toMatch(/background: color-mix\(in srgb, var\(--ef-base\) var\(--ef-glass-alpha\), transparent\);/);
    expect(rule(layout, '.window[data-bare] .main')).toMatch(/background: transparent;/);
  });

  it('keeps the 主页 map\'s lines but not its solid disc, and no vignette', () => {
    const home = read('pages/home/Home.module.css');
    const map = rule(home, ':global(html[data-window-glass]) .map');
    expect(map).toMatch(/repeating-linear-gradient\(0deg/);
    expect(map).toMatch(/repeating-linear-gradient\(90deg/);
    expect(map).not.toMatch(/radial-gradient/);
    const page = rule(home, ':global(html[data-window-glass]) .page');
    expect(page).not.toMatch(/#000 30%/);
    expect(page).toMatch(/var\(--ef-glass-alpha\)/);
  });

  it('leaves dialogs, menus and sheets on their own opaque grounds', () => {
    for (const sheet of ['ui/Dialog.module.css', 'ui/Menu.module.css', 'ui/Sheet.module.css']) {
      expect(read(sheet), sheet).not.toMatch(/data-window-glass/);
    }
  });
});
