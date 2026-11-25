import type { StreamEvent, Unsubscribe } from '../../../bridge';

// Scripted `/feed` events for screenshots (the bubble plays `reply` for `#/bubble?demo=speech|hidden`); `still=1` delivers them all at once.

export const COMM_DEMOS = ['reply', 'proactive', 'side', 'error', 'subtitle', 'long'] as const;
export type CommDemo = (typeof COMM_DEMOS)[number];

type Line = Record<string, unknown>;

const REPLY = '我看了你的终端，构建失败在第 42 行：tokens.css 里少了一个分号，后面的变量全被吞掉了。补上之后重新跑一次就好。';
const LONG = [
  '整理好了，这周的提交一共 37 次，分成三块：',
  '第一块是桌面层迁到网页，通讯条、浮窗栈和指令环都换成了同一套组件，样式跟着系统深浅走。',
  '第二块是记忆页，检索加了按时间过滤，删除前会先列出会受影响的条目。',
  '第三块是诊断页，把后台服务和角色进程的状态并到一张表里，出错时直接给出重启入口。',
  '另外有 4 次是修测试，主要是截图基线跟着新的字体更新了。',
  '还有两件没做完：任务轨的步骤展开，和角色面板的镜头按钮，我记在待处理里了。',
  '要我把这份总结写进周报吗？',
].join('');
const SIDE = '主任务那边正在执行测试。你问的那个文件在 web/src/surfaces 下面，我只读看了一眼，没有改动。';

const line = (id: string, text: string, extra: Line = {}): Line => ({
  line_id: id,
  text_delta: text,
  final: false,
  cancelled: false,
  error: null,
  run_id: null,
  lane: 'character',
  reason: null,
  ...extra,
});

/** A line streamed in pieces of `step` characters, then its final event. */
function streamed(id: string, text: string, extra: Line = {}, step = 3): Line[] {
  const chars = [...text];
  const parts: Line[] = [];
  for (let i = 0; i < chars.length; i += step) parts.push(line(id, chars.slice(i, i + step).join(''), extra));
  return [...parts, line(id, '', { ...extra, final: true })];
}

/** A `turn_accepted` event; `event` names it for `playDemo`, which sends every other entry as a `line`. */
const accepted = (id: string): Line => ({ event: 'turn_accepted', line_id: id, conversation_id: null, source: 'text', trace_id: `t-${id}`, side: false });

function script(demo: CommDemo): Line[] {
  switch (demo) {
    case 'reply':
      return [accepted('d-reply'), ...streamed('d-reply', REPLY)];
    case 'subtitle':
      return streamed('d-reply', REPLY);
    case 'long':
      return streamed('d-long', LONG, {}, 6);
    case 'proactive':
      return streamed('d-pro', '这个窗口你已经看了一阵了，要不要我帮你把报错整理一下？', { reason: { code: 'long_dwell', kind: 'comment', text: '你在这个窗口停了 12 分钟', activity: 'coding', dwell_min: 12 } });
    case 'error':
      return [line('d-err', '我去读一下那个日志'), line('d-err', '', { final: true, error: 'kernel_timeout' })];
    case 'side': {
      const run = { run_id: 'd-run', lane: 'agent' };
      return [line('d-run', '正在运行完整测试，完成后我将把失败的用例列给你。', run), ...streamed('d-side', SIDE, { lane: 'side' })];
    }
  }
}

/** Plays a demo as `/feed` events, one piece every 60 ms; `still` sends them all now. */
export function playDemo(demo: CommDemo, still: boolean, onEvent: (e: StreamEvent) => void): Unsubscribe {
  const events = script(demo).map(({ event, ...d }, i) => ({ event: typeof event === 'string' ? event : 'line', id: String(i + 1), data: JSON.stringify(d) }));
  if (still) {
    let live = true;
    queueMicrotask(() => live && events.forEach(onEvent));
    return () => void (live = false);
  }
  let i = 0;
  const t = setInterval(() => {
    const e = events[i++];
    if (e) onEvent(e);
    else clearInterval(t);
  }, 60);
  return () => clearInterval(t);
}
