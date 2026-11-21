import { NOW, TOOL_ITEMS } from '../../mock/fixtures';
import { T1 } from '../../mock/fixtures/ids';
import type { ToolDistProps } from './ToolDist';

export const ToolDistDemos: Array<{ name: string; props: ToolDistProps }> = [
  { name: 'default', props: { tools: TOOL_ITEMS[T1] ?? [], now: NOW } },
  { name: 'selected', props: { tools: TOOL_ITEMS[T1] ?? [], now: NOW, selected: 'Write' } },
  { name: 'none', props: { tools: [], now: NOW } },
];
