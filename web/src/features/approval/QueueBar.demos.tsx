import { A1, A2, A3, Q1 } from '../../mock/fixtures/ids';
import type { QueueBarProps } from './QueueBar';

export const QueueBarDemos: Array<{ name: string; props: QueueBarProps }> = [
  {
    name: 'default',
    props: {
      more: 4,
      dangerous: 0,
      notices: 1,
      cells: [
        { id: A1, dangerous: true, current: true, label: '■ 危险 │ 审批（当前）' },
        { id: A2, dangerous: false, label: '审批' },
        { id: A3, dangerous: false, label: '审批' },
        { id: Q1, dangerous: false, label: '提问' },
        { id: 'r1', dangerous: false, label: '复核' },
      ],
    },
  },
  { name: 'danger-behind', props: { more: 2, dangerous: 1, expanded: true } },
];
