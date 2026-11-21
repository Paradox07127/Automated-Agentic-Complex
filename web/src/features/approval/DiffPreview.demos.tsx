import { APPROVALS, pick } from '../../mock/fixtures';
import { A2 } from '../../mock/fixtures/ids';
import type { DiffPreviewProps } from './DiffPreview';

export const DiffPreviewDemos: Array<{ name: string; props: DiffPreviewProps }> = [
  { name: 'open', props: { preview: pick(APPROVALS, A2).content_preview ?? '', defaultOpen: true } },
  { name: 'closed', props: { preview: pick(APPROVALS, A2).content_preview ?? '' } },
];
