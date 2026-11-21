import { DELIVERIES, pick } from '../../mock/fixtures';
import { DLV_T1_V2, DLV_T4_V1 } from '../../mock/fixtures/ids';
import type { ArtifactListProps } from './ArtifactList';

export const ArtifactListDemos: Array<{ name: string; props: ArtifactListProps }> = [
  { name: 'chips', props: { artifacts: pick(DELIVERIES, DLV_T1_V2).artifacts, canReveal: true } },
  { name: 'rows', props: { artifacts: pick(DELIVERIES, DLV_T4_V1).artifacts, layout: 'rows' } },
];
