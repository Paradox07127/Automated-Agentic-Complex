import type { Conversation, Message } from '../../domain';
import { fromConversation } from '../../domain/adapt';
import { at, NOW } from './clock';
import { C1, Q1, T1 } from './ids';
import { TOOL_ITEMS } from './runs';
import { WIRE_CONVERSATIONS, WIRE_CONVERSATIONS_BUSY } from './wire/chat';

/** Duration of a finished t1 tool item; chat tool rows read it so they match the tool distribution. */
function itemMs(name: string): number {
  const t = TOOL_ITEMS[T1]?.find((x) => x.name === name);
  if (!t || t.updated_at == null) throw new Error(`no finished t1 item ${name}`);
  return t.updated_at - t.created_at;
}

/** `GET /conversations` read at NOW; the list's top-level `busy` marks the active one. */
export const CONVERSATIONS: Conversation[] = WIRE_CONVERSATIONS.map((c) => {
  const conv = fromConversation(c, NOW);
  return conv.active && WIRE_CONVERSATIONS_BUSY ? { ...conv, busy: true } : conv;
});

/** Conversation C1. Times match T1's runs, deliveries and question Q1; replies with `turn_id` end when their TURNS row ends. */
export const MESSAGES: Record<string, Message[]> = {
  [C1]: [
    { kind: 'me', at: at(14, 14), text: '帮我整理这周的提交，出一份周报，放到 ~/Documents/周报。' },
    { kind: 'ai', at: at(14, 14, 12), text: '好，我先看这周 Endfield 仓库的提交记录，再按目录归到项目里。', ttft_ms: 1800, turn_ms: 12_000, turn_id: 'tr8' },
    {
      kind: 'tool',
      label: '执行命令',
      ms: itemMs('Bash · git log'),
      summary: 'git log --since=2026-10-26 --no-merges --oneline · 142 条',
      code: '$ git log --since=2026-10-26 --no-merges --oneline\n1e84f862 Answer input with a read-only side session while the foreground run works\n6e139f0a Auto-select a logged-in local CLI as the role runtime when none is saved\n… 共 142 条',
    },
    { kind: 'tool', label: '读取目录', ms: itemMs('读取目录'), summary: 'app/  agent/  pipeline/  docs/ · 4 个顶层目录' },
    { kind: 'task', task_id: T1 },
    { kind: 'ai', at: at(14, 20), text: '第一版按日期排好了，放在 ~/Documents/周报/2026-W44 周报.md。', turn_ms: 64_000 },
    { kind: 'me', at: at(14, 22), text: '按项目分组，不要按日期。' },
    { kind: 'tool', label: '写入文件', ms: itemMs('Write · 2026-W44 周报.md'), summary: '~/Documents/周报/2026-W44 周报.md · 6.2 KB' },
    {
      kind: 'ai',
      at: at(14, 26),
      text: '改好了：Companion 58 条、agentd 41 条、渲染管线 29 条、其他 14 条。v2 已交付，待复核。我接着生成提交统计表。',
      ttft_ms: 1100,
      turn_ms: 9000,
      turn_id: 'tr7',
    },
    { kind: 'question', question_id: Q1, at: at(14, 27, 40) },
    { kind: 'me', at: at(14, 29, 10), text: '顺便查下 HostLink 断线是哪次提交引入的？' },
    {
      kind: 'side',
      at: at(14, 29, 44),
      text: '初步看是 10-27 那组改 HostLink 心跳超时的提交。现在前台正在运行周报任务，我只读看了提交记录；要细查的话，等周报结束后可以开一个任务。',
      streaming: true,
    },
  ],
};

/** Last 15 minutes: foreground run-8d03 and one side run (side history unverified). */
export const DUAL_TRACK = {
  front: [{ run_id: 'run-8d03', start: at(14, 22, 5), end: null as number | null }],
  side: [{ id: 'side-1', start: at(14, 29, 10), end: at(14, 29, 44) as number | null }],
};

/** Whole-turn seconds for the last 20 turns of c1. */
export const TURN_SECONDS: number[] = [6.2, 3.1, 12, 4.4, 2.8, 9.6, 5.1, 3.3, 14, 4.8, 6.6, 2.9, 3.8, 21, 5.5, 4.1, 12, 64, 9, 3.2];
