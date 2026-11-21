import { NOW } from '../../mock/fixtures';
import type { DecisionReceiptProps } from './DecisionReceipt';

export const DecisionReceiptDemos: Array<{ name: string; props: DecisionReceiptProps }> = [
  { name: 'approved', props: { outcome: { kind: 'approved', at: NOW } } },
  { name: 'expired', props: { outcome: { kind: 'expired', at: NOW }, agent: 'Codex' } },
  { name: 'elsewhere', props: { outcome: { kind: 'elsewhere', at: NOW - 60_000 } } },
];
