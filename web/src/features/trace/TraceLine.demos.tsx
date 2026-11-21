import { CodeBlock } from './CodeBlock';
import type { TraceLineProps } from './TraceLine';

const OUTPUT = [
  '14:32:04.118 agentd.feed seq=18422 line final lane=side',
  '14:32:03.902 agentd.control_panel POST /conversations/c1/messages 200 12ms',
  '14:32:01.440 companion.permissions automation not granted; browser url and terminal jump disabled',
  '14:31:58.003 agentd.brain turn tr1 decided route=reply model=claude-sonnet-4-5 1.12s',
  '14:31:40.771 host.render fps=60 p95=15.6ms gpu=6.1ms',
  '14:31:02.512 agentd.proactive skip: spoke 3m ago',
].join('\n');

export const TraceLineDemos: Array<{ name: string; props: TraceLineProps }> = [
  { name: 'tool', props: { icon: 'tool', title: '执行命令', desc: 'git log --since=monday --author=me --stat', state: 'completed', durationMs: 400, children: <CodeBlock code={OUTPUT} label="命令输出" /> } },
  { name: 'open', props: { icon: 'tool', title: '执行命令', desc: 'git log --since=monday --author=me --stat', state: 'completed', durationMs: 400, defaultOpen: true, children: <CodeBlock code={OUTPUT} label="命令输出" /> } },
  { name: 'failed', props: { icon: 'file', title: '读取目录', desc: '~/Downloads：资料授权已撤销', state: 'failed', durationMs: 10_000 } },
  { name: 'running', props: { icon: 'tool', title: '执行命令', desc: 'python 统计', state: 'running_tool', durationMs: null } },
];
