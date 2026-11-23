import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act as flush, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BarList, ChartState } from '../../src/charts';
import type { Message } from '../../src/domain';
import { FACTS, MESSAGES, NOW, pick, QUESTIONS, TOOL_ITEMS, TURNS } from '../../src/mock/fixtures';
import { stackScenario } from '../../src/mock/stack';
import { MessageList } from '../../src/pages/chat/MessageList';
import { QuestionCard } from '../../src/pages/chat/QuestionCard';
import { C1, Q1, T1 } from '../../src/mock/fixtures/ids';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.agenticComplex;
});

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const src = (p: string) => readFileSync(resolve(srcDir, p), 'utf8');
function rule(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m?.[2]) throw new Error(`no rule ${selector}`);
  return m[2];
}

const c1 = MESSAGES[C1] ?? [];

describe('one source per readout across pages', () => {
  it('derives chat tool durations from the run items', () => {
    const item = (name: string) => {
      const t = (TOOL_ITEMS[T1] ?? []).find((x) => x.name === name);
      if (!t || t.updated_at == null) throw new Error(`no finished item ${name}`);
      return t.updated_at - t.created_at;
    };
    const tools = c1.flatMap((m) => (m.kind === 'tool' ? [m] : []));
    expect(tools.map((m) => m.ms)).toEqual([item('Bash · git log'), item('读取目录'), item('Write · 2026-W44 周报.md')]);
    for (const m of tools) expect(m.summary).not.toMatch(/\d+(\.\d+)?\s*秒/);
  });

  it('writes GPU in ms on the desktop delivery card', () => {
    const card = stackScenario('delivery').cards.find((c) => c.kind === 'delivery');
    const summary = card && 'summary' in card ? (card.summary ?? '') : '';
    expect(summary).toMatch(/GPU[^。]*\d ms/);
    expect(summary).not.toMatch(/GPU[^。]*%/);
  });

  it('never uses a fact before it was recorded', () => {
    for (const f of FACTS) if (f.last_used_at != null) expect(f.last_used_at, f.id).toBeGreaterThanOrEqual(f.recorded_at);
  });
});

describe('chat replies point at their trace turn', () => {
  const replies = c1.flatMap((m) => (m.kind === 'ai' ? [m] : []));

  it('every reply with a first-token readout has a turn id', () => {
    for (const m of replies) if (m.ttft_ms != null) expect(m.turn_id, m.text).toBeTruthy();
  });

  it('the turn matches the reply time, whole-turn and first-token readouts', () => {
    for (const m of replies) {
      if (!m.turn_id) continue;
      const t = pick(TURNS, m.turn_id);
      expect(t.started_at + t.duration_ms, m.turn_id).toBe(m.at);
      expect(t.duration_ms, m.turn_id).toBe(m.turn_ms);
      const mark = t.marks.find((k) => k.label.startsWith('首字'));
      expect(mark?.at_ms, m.turn_id).toBe(m.ttft_ms);
      const before = c1.slice(0, c1.indexOf(m)).filter((x): x is Extract<Message, { kind: 'me' }> => x.kind === 'me').at(-1);
      if (before) expect(t.started_at, m.turn_id).toBeGreaterThanOrEqual(before.at);
    }
  });
});

describe('ChartState need', () => {
  it('draws the mock chart without a dev note; with the native bridge shows — and 后台暂不提供', () => {
    render(
      <ChartState state="ok" emptyText="" need={15}>
        图
      </ChartState>,
    );
    expect(screen.getByText('图')).toBeTruthy();
    expect(screen.queryByText(/需新增/)).toBeNull();
    cleanup();
    window.agenticComplex = {} as NonNullable<typeof window.agenticComplex>;
    render(
      <ChartState state="ok" emptyText="" need={15}>
        图
      </ChartState>,
    );
    expect(screen.queryByText(/需新增/)).toBeNull();
    expect(screen.getByText('后台暂不提供')).toBeTruthy();
  });
});

describe('cancelling a chat question waits 5 s with 撤销', () => {
  const q1 = pick(QUESTIONS, Q1);
  const card = (onCancel: () => void) => <QuestionCard at={q1.since} question={q1} roleName="示例甲" now={NOW} answered={null} onAnswer={() => {}} onCancel={onCancel} />;

  it('undo keeps the question; letting 5 s pass cancels it', () => {
    vi.useFakeTimers();
    const onCancel = vi.fn();
    render(card(onCancel));
    fireEvent.click(screen.getByRole('button', { name: '取消请求' }));
    expect(screen.getByText(/已取消这次提问/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(screen.getByRole('button', { name: '取消请求' })).toBeTruthy();
    flush(() => void vi.advanceTimersByTime(6000));
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消请求' }));
    flush(() => void vi.advanceTimersByTime(4600));
    expect(onCancel).not.toHaveBeenCalled();
    flush(() => void vi.advanceTimersByTime(600));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('a cancelled question reads 已取消这次提问, not 已回答', () => {
    render(<QuestionCard at={q1.since} question={null} roleName="示例甲" now={NOW} answered={null} cancelled onAnswer={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('已取消这次提问');
    expect(screen.queryByText(/已回答/)).toBeNull();
  });
});

describe('BarList labels', () => {
  it('puts the full label in title and elides the middle of a long one', () => {
    const label = 'developer.apple.com';
    const { container } = render(<BarList label="网站" rows={[{ key: 'a', label, value: 3 }]} />);
    const el = container.querySelector(`[title="${label}"]`);
    expect(el).toBeTruthy();
    const shown = el?.textContent ?? '';
    expect(shown).not.toBe(label);
    expect(shown).toMatch(/^dev.+….+com$/);
  });

  it('leaves a short label whole', () => {
    const { container } = render(<BarList label="应用" rows={[{ key: 'a', label: 'Xcode', value: 3 }]} />);
    expect(container.querySelector('[title="Xcode"]')?.textContent).toBe('Xcode');
  });
});

describe('settings titles and the character page', () => {
  // The unified spec (SPEC §4): group titles are the shared SecHead everywhere, settings included; the page keeps no title style or palette of its own.
  it('settings group titles are the shared SecHead and the page has no private palette', () => {
    expect(src('pages/settings/SetSection.tsx')).toContain('<SecHead');
    expect(src('pages/settings/section.module.css')).not.toMatch(/\.title\b/);
    expect(src('pages/settings/Page.module.css')).not.toMatch(/--s-/);
  });

  // SRow has no contour any more and the hero is gone, so neither rule is left in the page CSS.
  it('character page has no SRow contour override and no hero', () => {
    for (const f of ['Page', 'Operator', 'Stage', 'MotionTable']) {
      const css = src(`pages/character/${f}.module.css`);
      expect(css).not.toContain("[data-stub='SRow']::before");
      expect(css).not.toMatch(/(^|\n)\.hero\s*\{/);
    }
  });
});
