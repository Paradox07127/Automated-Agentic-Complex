import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { QueueBar } from '../../src/features/approval';
import { stackScenario } from '../../src/mock/stack';
import { orderCards, type StackCard } from '../../src/surfaces/stack/model';
import { A2, Q1 } from '../../src/mock/fixtures/ids';

afterEach(cleanup);

// The stack theme tests moved to stack-compact-cards.test.tsx with the shell's useSystemTheme.

describe('queue readout wording', () => {
  it('says the count covers only the cards not on screen', () => {
    render(<QueueBar more={2} dangerous={1} />);
    expect(screen.getByTitle('只数没上屏的卡')).toBeTruthy();
  });
});

describe('stack pending order', () => {
  it('puts kind after time left and before waiting time', () => {
    const cards = stackScenario('default').cards.flatMap((c): StackCard[] => {
      if (c.id === A2 && c.kind === 'approval') return [{ ...c, item: { ...c.item, dangerous: false, seconds_left: 100, since: 2 } }];
      if (c.id === Q1 && c.kind === 'question') return [{ ...c, item: { ...c.item, seconds_left: 100, since: 1 } }];
      return [];
    });
    expect(orderCards(cards).map((c) => c.id)).toEqual([A2, Q1]);
  });
});
