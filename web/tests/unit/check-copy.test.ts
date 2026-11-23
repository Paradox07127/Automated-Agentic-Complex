import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { copyHits, oldWordHits, run, titleHits, tsPieces } from '../../scripts/check-copy.mjs';

const texts = (src: string) => tsPieces(src).map(([, t]) => t.trim());

describe('check-copy JSX text extraction', () => {
  it('reads text that follows a child expression', () => {
    expect(texts('const a = <p>{n} 需新增 #10</p>;')).toContain('需新增 #10');
    expect(texts('const a = <p>出站 {x.label} #20 {y}</p>;')).toContain('#20');
  });

  it('reads text between two child expressions and after an adjacent pair', () => {
    expect(texts('const a = <p>{a}{b} NOW 坐着</p>;')).toContain('NOW 坐着');
    expect(texts('const a = <p>{a} 中间 {b}</p>;')).toContain('中间');
  });

  it('keeps line numbers of text after an expression', () => {
    expect(copyHits('x.tsx', 'const a = (\n  <p>\n    {n}\n    需新增 #6\n  </p>\n);')).toEqual(['4  [需新增, issue 编号]  需新增 #6']);
  });

  it('does not read code after a plain block as text', () => {
    expect(copyHits('x.tsx', 'function f() {\n  return 1;\n}\nconst NOW = 2;\n')).toEqual([]);
    expect(copyHits('x.tsx', 'const a = <p>{n} 条</p>;\n// 需新增 #6\n')).toEqual([]);
    expect(copyHits('x.tsx', 'function f(): Promise<void> {\n  return g();\n}\n\n/** user decision #3 */\nexport function h() {}\n')).toEqual([]);
  });

  it('still reads text right after a tag', () => {
    expect(copyHits('x.tsx', 'const a = <b>CONFIRM // 01</b>;')).toEqual(['1  [//]  CONFIRM // 01']);
  });

  it('lets // APPROVAL NOW through only inside an aria-hidden element', () => {
    expect(copyHits('x.tsx', 'const a = <span aria-hidden="true">APPROVAL // 02</span>;')).toEqual([]);
    expect(copyHits('x.tsx', "const a = <span className={s.slash} aria-hidden>{'//'}</span>;")).toEqual([]);
    expect(copyHits('x.tsx', 'const a = <b aria-hidden="true">{n} NOW</b>;')).toEqual([]);
    expect(copyHits('x.tsx', 'const a = <span aria-hidden="false">NOW</span>;')).toEqual(['1  [NOW]  NOW']);
    expect(copyHits('x.tsx', 'const a = <p><span aria-hidden="true">//</span> 需新增 // 2</p>;')).toEqual(['1  [需新增, //]  需新增 // 2']);
    expect(copyHits('x.tsx', 'const a = <span aria-hidden="true">需新增</span>;')).toEqual(['1  [需新增]  需新增']);
  });

  it('treats text under an aria-hidden ancestor as hidden, and text after that ancestor as visible', () => {
    expect(copyHits('x.tsx', 'const a = (\n  <div aria-hidden="true">\n    <span>APPROVAL</span>\n    <b>{n}</b> NOW\n    <i>{\'//\'}</i>\n  </div>\n);')).toEqual([]);
    expect(copyHits('x.tsx', 'const a = <i aria-hidden="true"><i>a</i><i /> NOW</i>;')).toEqual([]);
    expect(copyHits('x.tsx', 'const a = <p><i aria-hidden="true"><b>//</b></i> NOW</p>;')).toEqual(['1  [NOW]  NOW']);
  });
});

describe('check-copy missing-value wording', () => {
  it('lists on-screen 暂无, not comments', () => {
    expect(copyHits('x.tsx', "const a = <p>暂无记录</p>;\n// 暂无\nconst b = '暂无数据';\n")).toEqual(['1  [暂无]  暂无记录', '3  [暂无]  暂无数据']);
    expect(copyHits('x.tsx', "const a = <p>没有记录</p>;\n/** 不写「暂无数据」 */\n")).toEqual([]);
  });

  it('lists 数据停在 followed by a dash, not with a time', () => {
    expect(copyHits('x.tsx', "const a = '数据停在 —';\nconst b = `数据停在–`;\nconst c = '数据停在 - 点重试';\n")).toEqual(['1  [数据停在 —]  数据停在 —', '2  [数据停在 —]  数据停在–', '3  [数据停在 —]  数据停在 - 点重试']);
    expect(copyHits('x.tsx', 'const a = `数据停在 ${t}`;\n')).toEqual([]);
  });

  it('lists a · separator between meta items, not a · inside a phrase, a lone glyph or a comment', () => {
    expect(copyHits('x.tsx', "const a = '已产出 · 待决定';\nconst b = <span>· 重启后生效</span>;\nconst c = <i>不限时 ·</i>;\n// a · b\n")).toEqual([
      '1  [· 分隔]  已产出 · 待决定',
      '2  [· 分隔]  · 重启后生效',
      '3  [· 分隔]  不限时 ·',
    ]);
    expect(copyHits('x.tsx', "const a = ['已产出 │ 待决定', '免打扰·安静', '·'];\n")).toEqual([]);
  });

  it('lists a title that is 后台暂不提供, bare or as a branch', () => {
    expect(titleHits('x.tsx', '<dd title="后台暂不提供">—</dd>;\n')).toEqual(['1  [title 后台暂不提供]  title="后台暂不提供"']);
    expect(titleHits('x.tsx', "const a = 1;\n<span\n  title={d == null ? '后台暂不提供' : undefined}>\n")).toEqual(["3  [title 后台暂不提供]  title={d == null ? '后台暂不提供' : undefined}"]);
    expect(titleHits('x.tsx', "<span title={d != null ? undefined : '后台暂不提供'} />\n")).toHaveLength(1);
  });

  it('lets 后台暂不提供 through outside a title and as the fallback of a disabled reason', () => {
    expect(titleHits('x.tsx', "<InfoTip label=\"为什么没有值\">{u ? '后台暂不提供' : x}</InfoTip>;\n")).toEqual([]);
    expect(titleHits('x.tsx', "<b timelineReason=\"后台暂不提供\" />;\n")).toEqual([]);
    expect(titleHits('x.tsx', "<button aria-disabled title={off ? (reason ?? '后台暂不提供') : '在诊断时间线里定位'} />;\n")).toEqual([]);
    expect(titleHits('x.ts', 'const a = { title: "后台暂不提供" };\n')).toEqual([]);
  });
});

describe('check-copy old wording', () => {
  it('lists visible strings that use a replaced word, not comments', () => {
    expect(oldWordHits('x.tsx', "const a = <p>等你批准</p>;\n// 就地输入\nconst b = '看一下';\n")).toEqual(['1  [等你]  等你批准', '3  [看一下]  看一下']);
  });

  it('keeps the new words clear and matches short words only as a whole string', () => {
    expect(oldWordHits('x.tsx', "const a = ['派发任务', '查看诊断', '已退回', '已拦截', '对话', '确认', '推断'];")).toEqual([]);
    expect(oldWordHits('x.tsx', "const a = ['对', '看诊断', '退回', '交派任务'];")).toEqual(['1  [对]  对', '1  [看诊断]  看诊断', '1  [退回]  退回', '1  [交派任务]  交派任务']);
  });

  it('lists the old session-state words, not the table words', () => {
    expect(oldWordHits('x.tsx', "const a = ['待审批 · 2 张', '执行工具', '运行工具', '等待审批'];")).toEqual([
      '1  [待审批]  待审批 · 2 张',
      '1  [执行工具]  执行工具',
      '1  [运行工具]  运行工具',
      '1  [待审批, 等待审批]  等待审批',
    ]);
    expect(oldWordHits('x.tsx', "const a = ['待批准 · 2 张', '在跑', '在想', '待回答'];")).toEqual([]);
  });

  it('matches 执行工具 and 运行工具 only as status text', () => {
    expect(oldWordHits('x.tsx', "const a = [' 执行工具 ', '执行工具 · Bash', '运行工具 · Edit', '在跑 · Bash', '内核原生执行工具', '运行工具时提醒'];")).toEqual([
      '1  [执行工具]  执行工具',
      '1  [执行工具]  执行工具 · Bash',
      '1  [运行工具]  运行工具 · Edit',
    ]);
    expect(oldWordHits('x.tsx', "const a = ['内核待审批', '先等待审批再说'];")).toEqual(['1  [待审批]  内核待审批', '1  [待审批, 等待审批]  先等待审批再说']);
    expect(oldWordHits('x.tsx', "const a = ['执行工具 │ Bash', '在跑 │ Bash'];")).toEqual(['1  [执行工具]  执行工具 │ Bash']);
  });

  it('lists 她 in visible strings, except in the character-authored chat fixture', () => {
    const src = "const a = ['点击穿过她', '点击穿过角色'];\n// 她的按钮\n";
    expect(oldWordHits('x.tsx', src)).toEqual(['1  [她]  点击穿过她']);
    expect(oldWordHits('/w/web/src/mock/fixtures/chatDemo.ts', src)).toEqual([]);
    expect(oldWordHits('/w/web/src/mock/fixtures/chatDemo.ts', "const a = '她说';")).toEqual(['1  [她说]  她说']);
  });

  it('fails the check on a replaced word', () => {
    const root = mkdtempSync(join(tmpdir(), 'check-copy-'));
    for (const d of ['src/pages/p', 'src/features', 'src/surfaces', 'src/ui', 'src/charts']) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'src/pages/p/A.tsx'), 'export const A = () => <p>等你回答</p>;\n');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(run(root)).toBe(1);
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the check on a 后台暂不提供 title', () => {
    const root = mkdtempSync(join(tmpdir(), 'check-copy-'));
    for (const d of ['src/pages/p', 'src/features', 'src/surfaces', 'src/ui', 'src/charts']) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'src/ui/A.tsx'), 'export const A = () => <dd title="后台暂不提供">—</dd>;\n');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(run(root)).toBe(1);
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
