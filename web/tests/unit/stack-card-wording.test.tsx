import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act as flush, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { CountdownRing } from '../../src/charts';
import tokensJson from '../../src/design/tokens.json';
import { stackScenario } from '../../src/mock/stack';
import { DeliveryStackCard } from '../../src/surfaces/stack/cards/DeliveryStackCard';
import { QuestionStackCard } from '../../src/surfaces/stack/cards/QuestionStackCard';
import { ReviewStackCard } from '../../src/surfaces/stack/cards/ReviewStackCard';
import type { StackCard } from '../../src/surfaces/stack/model';
import { stubMatchMedia } from './mediaStub';

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.location.hash = '';
});

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const src = (p: string) => readFileSync(resolve(srcDir, p), 'utf8');

function rule(css: string, selector: string): string {
  const m = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m?.[1]) throw new Error(`no rule ${selector}`);
  return m[1];
}

/** The chain and the artifacts are folded; open the section first (a fold remembers its state by card id). */
function unfold(label: string) {
  const fold = screen.getByRole('button', { name: new RegExp(`^${label}`) });
  if (fold.getAttribute('aria-expanded') === 'false') fireEvent.click(fold);
}

function cardOf<K extends StackCard['kind']>(scenario: string, kind: K): Extract<StackCard, { kind: K }> {
  const c = stackScenario(scenario).cards.find((x) => x.kind === kind);
  if (!c) throw new Error(`no ${kind} card in ${scenario}`);
  return c as Extract<StackCard, { kind: K }>;
}

describe('wide display face', () => {
  it('bundles the variable HarmonyOS Sans SC', () => {
    const base = src('design/base.css');
    expect(base).toContain("font-family: 'HarmonyOS Sans SC'");
    expect(base).not.toContain('anybody');
    expect(tokensJson.type.family['font-wide']).toMatch(/^"HarmonyOS Sans SC"/);
  });
});

describe('countdown ring wording', () => {
  it('does not say 即将超时 once time is up', () => {
    render(<CountdownRing secondsLeft={0} windowS={55} />);
    const timer = screen.getByRole('timer');
    expect(timer.textContent).toContain('已超时');
    expect(timer.textContent).not.toContain('即将超时');
    expect(timer.getAttribute('aria-label')).not.toContain('即将超时');
  });

  it('writes urgentText in the last 10 s', () => {
    render(<CountdownRing secondsLeft={5} windowS={8} urgentText="即将重启" />);
    const timer = screen.getByRole('timer');
    expect(timer.textContent).toContain('即将重启');
    expect(timer.getAttribute('aria-label')).toContain('即将重启');
    expect(timer.textContent).not.toContain('即将超时');
  });
});

describe('review card', () => {
  it('offers 在 Finder 中显示 when the bridge can reveal files', () => {
    const act = vi.fn();
    const card = cardOf('review', 'review');
    if (card.source !== 'delivery') throw new Error('expected a delivery review');
    render(<ReviewStackCard card={card} index={1} top now={stackScenario('review').now} act={act} />);
    unfold('交付链与产物');
    // Reveal lives in each artifact row's ⋯ menu.
    const more = screen.getAllByRole('button', { name: /^更多操作：/ });
    expect(more).toHaveLength(card.delivery.artifacts.length);
    fireEvent.click(more[0]!);
    fireEvent.click(screen.getByRole('menuitem', { name: '在 Finder 中显示' }));
    expect(act).toHaveBeenCalledWith({ type: 'reveal', path: card.delivery.artifacts[0]!.absolute_path });
  });

  it('hides 在 Finder 中显示 without the capability', () => {
    // The fake bridge's capability object is a plain copy; flip the bit for this render only.
    const caps = getBridge().capabilities as { revealInFinder: boolean };
    caps.revealInFinder = false;
    try {
      render(<ReviewStackCard card={cardOf('review', 'review')} index={1} top now={0} act={() => {}} />);
      unfold('交付链与产物');
      fireEvent.click(screen.getAllByRole('button', { name: /^更多操作：/ })[0]!);
      expect(screen.getByRole('menuitem', { name: '复制路径' })).toBeTruthy();
      expect(screen.queryByRole('menuitem', { name: '在 Finder 中显示' })).toBeNull();
    } finally {
      caps.revealInFinder = true;
    }
  });

  it('says once that no artifact was opened (ArtifactList carries the readout)', () => {
    render(<ReviewStackCard card={cardOf('review', 'review')} index={1} top now={0} act={() => {}} />);
    unfold('交付链与产物');
    const says = (_: string, el: Element | null) => /^产物 0\/2 打开过$|还没看过产物/.test(el?.textContent?.trim() ?? '') && ![...(el?.children ?? [])].some((c) => /打开过|还没看过/.test(c.textContent ?? ''));
    expect(screen.getAllByText(says)).toHaveLength(1);
  });
});

describe('delivery card', () => {
  it('shows the verification pill and self-check cells', () => {
    const card = cardOf('delivery', 'delivery');
    render(<DeliveryStackCard card={card} index={1} top now={stackScenario('delivery').now} act={() => {}} />);
    unfold('交付链');
    expect(screen.getByText(card.delivery.verification_source === 'auto' ? '✓ 已自动检查' : '▲ 未验证')).toBeTruthy();
    expect(screen.getByRole('img', { name: /个产物尝试自检/ })).toBeTruthy();
  });

  it('a band title cut by the card keeps its full text as the tooltip', () => {
    const card = cardOf('delivery', 'delivery');
    const { container } = render(<DeliveryStackCard card={card} index={1} top now={stackScenario('delivery').now} act={() => {}} />);
    expect(container.querySelector(`b[title="${card.title}"]`)?.textContent).toBe(card.title);
  });
});

describe('cancel request undo', () => {
  it('waits 5 s with 撤销 before cancelling', () => {
    vi.useFakeTimers();
    const act = vi.fn();
    const card = cardOf('question', 'question');
    render(<QuestionStackCard card={card} index={1} top now={stackScenario('question').now} act={act} />);

    fireEvent.click(screen.getByRole('button', { name: '取消请求' }));
    expect(screen.getByText(/已取消这次提问/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(screen.getByRole('button', { name: '取消请求' })).toBeTruthy();
    flush(() => void vi.advanceTimersByTime(6000));
    expect(act).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消请求' }));
    flush(() => void vi.advanceTimersByTime(4600));
    expect(act).not.toHaveBeenCalled();
    flush(() => void vi.advanceTimersByTime(600));
    expect(act).toHaveBeenCalledWith({ type: 'cancel-question', id: card.id, expected_version: card.item.revision });
  });
});
