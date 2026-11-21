import { FILE_EFFECTS } from '../../mock/fixtures';
import { T1 } from '../../mock/fixtures/ids';
import type { FileImpactProps } from './FileImpact';

export const FileImpactDemos: Array<{ name: string; props: FileImpactProps }> = [
  { name: 'default', props: { files: FILE_EFFECTS[T1] ?? [] } },
  { name: 'empty', props: { files: [] } },
];
