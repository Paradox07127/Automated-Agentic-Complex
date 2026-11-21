import type { CodeBlockProps } from './CodeBlock';

const LOG_TEXT = [
  '14:32:04.118 INFO  agentd.feed seq=18422 line final lane=side',
  '14:32:03.902 INFO  agentd.control_panel POST /conversations/c1/messages 200 12ms',
  '14:32:01.440 WARN  companion.permissions automation not granted; browser url and terminal jump disabled',
  '14:31:58.003 INFO  agentd.brain turn tr1 decided route=reply model=claude-sonnet-4-5 1.12s',
  '14:31:40.771 INFO  host.render fps=60 p95=15.6ms gpu=6.1ms',
  '14:31:02.512 INFO  agentd.proactive skip: spoke 3m ago',
  '14:30:12.006 INFO  agentd.deliveries delivery dlv-t1-v2 viewed by companion',
  '14:27:00.390 INFO  agentd.deliveries delivery dlv-t1-v2 presented',
  '14:24:03.901 ERROR agentd.observe summary failed: upstream timeout after 900ms',
  '14:20:44.115 INFO  companion.hostlink reconnected after 2 heartbeats missed',
].join('\n');
const LONG_TEXT = Array.from({ length: 4 }, () => LOG_TEXT).join('\n');

export const CodeBlockDemos: Array<{ name: string; props: CodeBlockProps }> = [
  { name: 'short', props: { code: LOG_TEXT, label: 'agentd 日志' } },
  { name: 'long', props: { code: LONG_TEXT, label: 'agentd 日志' } },
  { name: 'nowrap', props: { code: LOG_TEXT, wrap: false, label: 'agentd 日志' } },
];
