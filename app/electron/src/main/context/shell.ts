// The screen context capturer as index.ts starts it: its ports over agentd's client, the blacklist file and config.json.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AttentionSample, Rect } from '../../common/attention.ts';
import {
  type AgentdReply, contextPolicy, type LookResult, lookResult, resultText, type SelectionDecision,
} from '../../common/screen-context.ts';
import { BlacklistFile } from '../attention/blacklist.ts';
import { NO_ANSWER, type UserAnswer } from '../attention/sampler.ts';
import { type ContextPorts, startContext } from './capturer.ts';

type Agentd = { request(method: string, path: string, json?: unknown): Promise<{ status: number; body: Buffer }> };

export interface ShellContextOptions {
  /** The shell's arguments: `--no-attention` (test and host runs) starts no capturer, so no window is read. */
  argv: readonly string[];
  helper: ContextPorts['helper'];
  agentd: Agentd;
  /** `agentd_state_dir`, which holds blacklist.json. */
  agentdStateDir: string;
  /** config.json as saved now; `{}` when it cannot be read. */
  settings(): Record<string, unknown>;
  /** The attention sampler, whose `user` the automatic reads follow; null without one. */
  attention(): { readonly user: UserAnswer } | null;
  ownPids(): readonly number[];
  log(line: string): void;
  /** Tests drive the timers; Unix milliseconds. */
  clock?: Pick<ContextPorts, 'now' | 'every' | 'after'>;
  /** ContextCapturer.onLook: each 屏幕识读 that ended, with the front window's title when it was asked (null when unknown). */
  onLook?(title: string | null, result: LookResult): void;
}

export interface ShellContext {
  /** On while agentd runs. */
  agentd(running: boolean): void;
  helper(running: boolean): void;
  event(name: string, data: Record<string, unknown>): void;
  /** Each attention sample (`onSample`). */
  sampled(s: AttentionSample): void;
  /** Every `/feed` event. */
  feed(e: { event: string; data: string }): void;
  /** ContextCapturer.lookNow's answer. */
  look(): Promise<LookResult>;
  /** The selected text for `hotkey_selection`. */
  readSelection(): Promise<{ decision: SelectionDecision; app: string | null }>;
  ownCaptureRecent(): boolean;
  stop(): void;
}

/** A POST to agentd; status 0 when agentd could not be reached, a null body when it is not a JSON object. */
export function agentdPost(agentd: Agentd): ContextPorts['post'] {
  return async (path, body) => {
    try {
      const reply = await agentd.request('POST', path, body);
      let json: unknown = null;
      try {
        json = JSON.parse(reply.body.toString('utf8'));
      } catch { /* not JSON: null */ }
      return { status: reply.status, body: typeof json === 'object' && json !== null && !Array.isArray(json) ? json as AgentdReply['body'] : null };
    } catch {
      return { status: 0, body: null };
    }
  };
}

/** The main window's `app.look`: agentd's `POST /look` without the capturer. */
export function agentdLook(agentd: Agentd, log: (line: string) => void): () => Promise<LookResult> {
  const post = agentdPost(agentd);
  return async () => {
    const result = lookResult(await post('/look', {}));
    log(`web-main look: ${resultText(result)}`);
    return result;
  };
}

/** A look agentd took puts 已识读 on the desktop stack, when there is one. */
export function lookReceipt(stack: () => { addLookReceipt(title: string): void } | null): (title: string | null, result: LookResult) => void {
  return (title, result) => {
    if (result.kind === 'requested') stack()?.addLookReceipt(title ?? '前台窗口');
  };
}

/** A screen capture by the ambient sampler or the context capturer is running or just ended. */
export function anyOwnCapture(ambient: () => { readonly ownCaptureRecent: boolean } | null,
  context: () => { ownCaptureRecent(): boolean } | null): () => boolean {
  return () => (ambient()?.ownCaptureRecent ?? false) || (context()?.ownCaptureRecent() ?? false);
}

/** Idle until agentd runs; null with `--no-attention`. */
export function shellContext(o: ShellContextOptions): ShellContext | null {
  if (o.argv.includes('--no-attention')) return null;
  const blacklist = new BlacklistFile(join(o.agentdStateDir, 'blacklist.json'));
  const clock = o.clock ?? {
    now: Date.now,
    every: (ms: number, fn: () => void) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    },
    after: (ms: number, fn: () => void) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };
  const capturer = startContext({
    helper: o.helper, post: agentdPost(o.agentd), blacklist: () => blacklist.rules(),
    // `store.saved()` nil is the default policy, `contextPolicy({})`.
    policy: () => contextPolicy(o.settings()),
    user: () => o.attention()?.user ?? NO_ANSWER,
    ownPids: o.ownPids, newId: () => randomUUID().toUpperCase(), now: clock.now, every: clock.every, after: clock.after, log: o.log,
  });
  return {
    agentd: (running) => { if (running) capturer.start(); else capturer.stop(); },
    helper: (running) => capturer.helper(running),
    event: (name, data) => capturer.event(name, data),
    sampled: (s) => capturer.update(s),
    feed: (e) => capturer.feed(e),
    look: async () => {
      const { title, result } = await capturer.look();
      o.onLook?.(title, result);
      return result;
    },
    readSelection: () => capturer.readSelection(),
    ownCaptureRecent: () => capturer.ownCaptureRecent(),
    stop: () => capturer.stop(),
  };
}
