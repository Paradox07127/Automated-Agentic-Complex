import { BarList } from '../../charts';
import type { RawFoldProps } from './RawFold';

const LOG_LINES = [
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
];
const LOG_TEXT = LOG_LINES.join('\n');
const levels = [{ key: 'INFO', label: 'INFO', value: 8 }, { key: 'WARN', label: 'WARN', value: 1 }, { key: 'ERROR', label: 'ERROR', value: 1 }];

export const RawFoldDemos: Array<{ name: string; props: RawFoldProps }> = [
  {
    name: 'default',
    props: {
      summary: [`最近 ${LOG_LINES.length} 行：错误 1，警告 1`, '错误：agentd.observe 14:24:03.901'],
      children: <BarList rows={levels} label="日志级别" />,
      raw: LOG_TEXT,
      rawLabel: '运行日志',
      actions: [{ kind: 'item', label: '在 Finder 中显示' }],
    },
  },
  { name: 'open', props: { summary: ['3 个阶段，最慢 模型调用 1.1 s'], raw: LOG_TEXT, rawLabel: '运行输出', defaultOpen: true } },
];
