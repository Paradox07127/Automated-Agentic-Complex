import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { InSession, type ApprovalStackItem } from '../../src/features/approval';
import { A1, A2 } from '../../src/mock/fixtures/ids';
import { stackScenario } from '../../src/mock/stack';
import { ApprovalStackCard } from '../../src/surfaces/stack/cards/ApprovalStackCard';
import { stubMatchMedia } from './mediaStub';

// A dangerous approval on the stack wears the red tape across its frame, as the bubble's 要你批准 card does, also when it
// sits in a session card as the compact block.

stubMatchMedia();
document.documentElement.dataset.surface = 'stack';
afterEach(cleanup);

const cardOf = (scenario: string, id?: string) => stackScenario(scenario).cards.find((c) => !id || c.id === id) as ApprovalStackItem;
const frame = (c: HTMLElement) => c.querySelector('[data-card-id]')!;

describe('the stack approval card in danger', () => {
  it.each([
    ['a broker approval', () => cardOf('default', A1)],
    ['a role approval', () => cardOf('role-approval-danger')],
  ])('%s in a session card carries the red tape', (_, card) => {
    const { container } = render(
      <InSession.Provider value>
        <ApprovalStackCard card={card()} index={1} total={1} top act={() => {}} />
      </InSession.Provider>,
    );
    expect(frame(container).hasAttribute('data-danger')).toBe(true);
  });

  it('a plain approval has none', () => {
    const { container } = render(<ApprovalStackCard card={cardOf('default', A2)} index={1} total={1} top act={() => {}} />);
    expect(frame(container).hasAttribute('data-danger')).toBe(false);
  });

  it('the tape is red', () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/surfaces/stack/CardFrame.module.css'), 'utf8');
    expect(css).toMatch(/\.frame\[data-danger\][^{]*\{[^}]*--tape-hi: var\(--ef-danger-vivid\)/);
  });
});
