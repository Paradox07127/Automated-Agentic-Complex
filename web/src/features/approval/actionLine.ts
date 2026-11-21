// What an approval asks to do, as one short Chinese line: 「改 HostLink.swift」, 「运行 swift test」, 「访问 api.github.com」.
import { AGENT_NAME, type ApprovalDispatch } from '../../domain';

export interface ActionLine {
  /** file: target is the file name; run: the command; url: the host; other: whatever the call named. */
  kind: 'file' | 'run' | 'url' | 'other';
  /** 改, 运行, 访问…; empty when the whole line is in `target`. */
  verb: string;
  target: string;
  /** The untrimmed target, for the tooltip and 详情. */
  full: string;
}

const VERB: Readonly<Record<string, [ActionLine['kind'], string]>> = {
  Edit: ['file', '改'],
  MultiEdit: ['file', '改'],
  NotebookEdit: ['file', '改'],
  apply_patch: ['file', '改'],
  Write: ['file', '写入'],
  Read: ['file', '读取'],
  Bash: ['run', '运行'],
  shell: ['run', '运行'],
  exec_command: ['run', '运行'],
  local_shell: ['run', '运行'],
  WebFetch: ['url', '访问'],
  WebSearch: ['other', '搜索'],
  Glob: ['other', '查找'],
  Grep: ['other', '搜索'],
};

const baseName = (path: string) => path.replace(/\/+$/, '').split('/').at(-1) || path;

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** `arguments.command` of a role approval's call preview, when it is a shell call. */
function previewCommand(preview: string | null): string | null {
  if (!preview) return null;
  try {
    const p = JSON.parse(preview) as { arguments?: { command?: unknown } };
    return typeof p.arguments?.command === 'string' ? p.arguments.command : null;
  } catch {
    return null;
  }
}

/** `hideInternal`: a session row drops host-internal servers; an approval always names what it lets run. */
function mcpAction(tool: string, hideInternal: boolean): ActionLine | null {
  if (!tool.startsWith('mcp__')) return null;
  const [server = '', ...parts] = tool.slice(5).split('__');
  if (hideInternal && (server.startsWith('ccd_') || server === 'agentic_complex')) return { kind: 'other', verb: '', target: '', full: '' };
  const name = parts.join('__');
  const target = name ? `${server} 的 ${name}` : server;
  return { kind: 'other', verb: '用', target, full: `用 ${target}` };
}

export function actionLine(a: { tool: string; cmd?: string | null; title: string; dispatch: ApprovalDispatch | null; previewText?: string | null }): ActionLine {
  if (a.dispatch) {
    const to = AGENT_NAME[a.dispatch.target] ?? a.dispatch.target;
    return { kind: 'other', verb: `派给 ${to}`, target: a.dispatch.prompt, full: a.dispatch.prompt };
  }
  const mcp = mcpAction(a.tool, false);
  if (mcp) return mcp;
  const cmd = a.cmd ?? '';
  const known = VERB[a.tool];
  if (known && cmd) {
    const [kind, verb] = known;
    const target = kind === 'file' ? baseName(cmd) : kind === 'url' ? hostOf(cmd) : cmd;
    return { kind, verb, target, full: cmd };
  }
  if (!a.tool) {
    const run = previewCommand(a.previewText ?? null);
    if (run) return { kind: 'run', verb: '运行', target: run, full: run };
    return { kind: 'other', verb: '', target: a.title, full: a.title };
  }
  return cmd ? { kind: 'other', verb: a.tool, target: cmd, full: cmd } : { kind: 'other', verb: '', target: a.title, full: a.title };
}

/**
 * A session row's tool as the same line: 「运行 swift test」, 「搜索」. `target` is agentd's short one (desktop presence
 * `target`: a file name, host, program or description, or `server · tool` for MCP), shown as is.
 */
const DESCRIBED = new Set(['Bash', 'Task', 'Agent']);

export function toolAction(tool: string, target: string | null): ActionLine {
  const mcp = mcpAction(tool, true);
  if (mcp) return mcp;
  const known = VERB[tool];
  const t = target ?? '';
  // A Bash or Task description is already a sentence; a bare program name has no space.
  if (known && !(DESCRIBED.has(tool) && /\s/.test(t))) return { kind: known[0], verb: known[1], target: t, full: t };
  return { kind: known?.[0] ?? 'other', verb: '', target: t || tool, full: t || tool };
}
