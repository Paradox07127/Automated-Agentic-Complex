import { describe, expect, it } from 'vitest';
import { compare, count, hits, skipped } from '../../scripts/check-ui.mjs';

describe('check-ui counts', () => {
  it('counts a bare <button> only when it has a className', () => {
    const src = 'const a = (\n  <>\n    <button className={s.x} onClick={() => go(1 > 0)}>a</button>\n    <button onClick={f}>b</button>\n  </>\n);';
    expect(count('x.tsx', src)).toEqual({ btn: 1 });
    expect(hits('x.tsx', src).btn).toEqual([3]);
  });

  it('counts a <button> styled inline only, and any element with role="button"', () => {
    expect(count('x.tsx', '<button style={{ padding: 4 }} onClick={f}>a</button>')).toEqual({ btn: 1 });
    expect(count('x.tsx', '<div role="button" className="k" tabIndex={0}>a</div>\n<span role="button">b</span>')).toEqual({ btn: 2 });
    expect(count('x.tsx', '<Btn role="button">a</Btn>')).toEqual({});
  });

  it('counts px font sizes in CSS, the font shorthand included', () => {
    expect(count('x.css', '.a { font-size: 13px; }\n.b { font-size: var(--ef-fs-caption); }\n.c { font-size:10.5px }')).toEqual({ fontPx: 2 });
    expect(count('x.css', '.x{font:500 13px/1 var(--f)}\n.y { font: 700 24px / 1 var(--ef-font-sans); }\n.z { font: italic var(--ef-fw-medium) 12px var(--f); }')).toEqual({ fontPx: 3 });
    expect(count('x.css', '.a { font: var(--ef-t-text); }\n.b { font: var(--ef-fw-medium) var(--ef-fs-title-1) / 1.4 var(--ef-font-sans); }')).toEqual({});
    expect(count('x.tsx', "const s = 'font-size: 13px';")).toEqual({});
  });

  it('counts a numeric inline fontSize in TSX and TS', () => {
    expect(count('x.tsx', '<b style={{ fontSize: 13 }} />\n<b style={{ fontSize: "12px" }} />\n<b style={{ fontSize: "var(--ef-fs-caption)" }} />')).toEqual({ fontPx: 2 });
    expect(count('x.ts', 'export const s = { fontSize: 11.5 };')).toEqual({ fontPx: 1 });
  });

  it('counts colour literals in CSS, TSX and TS', () => {
    const css = '.a { color: #fff; background: rgba(0, 0, 0, 0.5); border-color: rgb(1 2 3); fill: color(srgb 1 0 0); }';
    expect(count('x.css', css)).toEqual({ color: 4 });
    expect(count('x.tsx', '<path fill="#0d3c6b" />\n<a href="#section" />\n<i>&#123;</i>')).toEqual({ color: 1 });
    expect(count('x.ts', "export const RED = '#ff0000';\nconst h = 'hsl(0 100% 50%)';")).toEqual({ color: 2 });
  });

  it('counts hsl() and the colour names white and black in CSS, not names that only contain them', () => {
    expect(count('x.css', '.a { color: hsl(0 0% 100%); background: hsla(0, 0%, 0%, 0.5); }')).toEqual({ color: 2 });
    expect(count('x.css', '.a { color: white; border: 1px solid black; }')).toEqual({ color: 2 });
    expect(count('x.css', '.white:hover .black { white-space: nowrap; color: var(--ef-white); }\n:global(.black) .a { x: 1 }')).toEqual({});
  });

  it('does not count hits inside comments', () => {
    expect(count('x.css', '/* font-size: 13px; color: #fff; */\n.a { color: var(--x); }')).toEqual({});
    const tsx = "/* <button className=\"x\"> */\nconst a = <p>{/* #fff */}</p>;\nconst u = 'http://x/#fff';";
    expect(count('x.tsx', tsx)).toEqual({ color: 1 });
  });

  it('keeps the code after a URL in JSX text', () => {
    expect(count('x.tsx', '<p>见 https://example.com</p><button className="k">a</button>')).toEqual({ btn: 1 });
    expect(count('x.tsx', 'const a = 1; // <button className="k">')).toEqual({});
  });

  it('skips tests and demos', () => {
    expect(skipped('src/pages/a/demos.ts')).toBe(true);
    expect(skipped('src/features/task/TaskDetail.demos.tsx')).toBe(true);
    expect(skipped('src/pages/a/Page.test.tsx')).toBe(true);
    expect(skipped('src/pages/a/Page.tsx')).toBe(false);
  });
});

describe('check-ui baseline', () => {
  it('fails a count above the baseline and a file the baseline does not list', () => {
    const { over, ok } = compare({ 'src/a.css': { fontPx: 3 }, 'src/b.tsx': { btn: 1 } }, { 'src/a.css': { fontPx: 2 } });
    expect(over).toEqual([
      ['src/a.css', 'fontPx', 3, 2],
      ['src/b.tsx', 'btn', 1, 0],
    ]);
    expect(ok).toBe(false);
  });

  it('fails a count below the baseline too, so the baseline only goes down', () => {
    const { over, loose, ok } = compare({ 'src/a.css': { color: 1 } }, { 'src/a.css': { color: 2 }, 'src/gone.css': { fontPx: 1 } });
    expect(over).toEqual([]);
    expect(loose).toEqual([
      ['src/a.css', 'color', 1, 2],
      ['src/gone.css', 'fontPx', 0, 1],
    ]);
    expect(ok).toBe(false);
    expect(compare({ 'src/a.css': { color: 2 } }, { 'src/a.css': { color: 2 } }).ok).toBe(true);
  });
});
