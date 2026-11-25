import { describe, expect, it } from 'vitest';
import { compare, count, hits, skipped } from '../../scripts/check-ui.mjs';

describe('check-ui counts', () => {
  it('counts a bare <button> only when it has a className', () => {
    const src = 'const a = (\n  <>\n    <button className={s.x} onClick={() => go(1 > 0)}>a</button>\n    <button onClick={f}>b</button>\n  </>\n);';
    expect(count('x.tsx', src)).toEqual({ btn: 1 });
    expect(hits('x.tsx', src).btn).toEqual([3]);
  });

  it('counts retired components imported from ui, not names that only contain them', () => {
    const src = [
      "import { Btn, Modal, type ModalProps } from '../../ui';",
      "import {\n  GameSeg,\n  Seg as Picker,\n} from '../../ui/game';",
      "import { Toggle } from './Toggle';",
      "import OpenSec from '../../ui/OpenSec';",
      "import modal from '../../ui/Modal.module.css';",
    ].join('\n');
    expect(count('x.tsx', src)).toEqual({ retired: 3 });
  });

  it('counts <Btn> variants outside the kept set', () => {
    const src = '<Btn variant="quiet">a</Btn>\n<Btn variant="primary" />\n<Btn size="sm" variant={\'cancel\'} />\n<BtnDense variant="quiet" />\n<Btn>b</Btn>';
    expect(count('x.tsx', src)).toEqual({ btnVariant: 2 });
  });

  it('counts px font sizes in CSS only', () => {
    expect(count('x.css', '.a { font-size: 13px; }\n.b { font-size: var(--ef-fs-caption); }\n.c { font-size:10.5px }')).toEqual({ fontPx: 2 });
    expect(count('x.tsx', "const s = 'font-size: 13px';")).toEqual({});
  });

  it('counts colour literals in CSS and TSX', () => {
    const css = '.a { color: #fff; background: rgba(0, 0, 0, 0.5); border-color: rgb(1 2 3); fill: color(srgb 1 0 0); }';
    expect(count('x.css', css)).toEqual({ color: 4 });
    expect(count('x.tsx', '<path fill="#0d3c6b" />\n<a href="#section" />\n<i>&#123;</i>')).toEqual({ color: 1 });
  });

  it('does not count hits inside comments', () => {
    expect(count('x.css', '/* font-size: 13px; color: #fff; */\n.a { color: var(--x); }')).toEqual({});
    const tsx = "// import { Modal } from '../../ui';\n/* <button className=\"x\"> */\nconst a = <p>{/* <Btn variant=\"quiet\" /> #fff */}</p>;\nconst u = 'http://x/#fff';";
    expect(count('x.tsx', tsx)).toEqual({ color: 1 });
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
    const { over } = compare({ 'src/a.css': { fontPx: 3 }, 'src/b.tsx': { btn: 1 } }, { 'src/a.css': { fontPx: 2 } });
    expect(over).toEqual([
      ['src/a.css', 'fontPx', 3, 2],
      ['src/b.tsx', 'btn', 1, 0],
    ]);
  });

  it('passes and reports counts that fell below the baseline', () => {
    const { over, loose } = compare({ 'src/a.css': { color: 1 } }, { 'src/a.css': { color: 2 }, 'src/gone.css': { fontPx: 1 } });
    expect(over).toEqual([]);
    expect(loose).toEqual([
      ['src/a.css', 'color', 1, 2],
      ['src/gone.css', 'fontPx', 0, 1],
    ]);
  });
});
