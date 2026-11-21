// The timeline recorder over the platform helper (`input.actions`, `ax.window_tree`): each front window and each click,
// context menu, shortcut and submit of the user's becomes a `POST /context/timeline` record, the window with its whole
// tree and the actions with what changed in it, while agentd runs and plugins.screen_awareness and share_actions are on.
import { type ActivityEvent, captureWindow } from '../../common/activity.ts';
import type { AttentionSample, AttentionWindow, BlacklistRules } from '../../common/attention.ts';
import { type CaptureWindow, captureBlockReason } from '../../common/capture-rules.ts';
import type { HelperAnswer } from '../../common/push-to-talk.ts';
import {
  filterRecord, type TimelineKind, type TimelinePolicy, TimelineQueue, type TimelineRecord, type TimelineTree, toTarget,
} from '../../common/timeline.ts';

export interface TimelinePorts {
  helper: { request(op: string, params?: Record<string, unknown>): Promise<HelperAnswer> };
  /** `POST /context/timeline`; the HTTP status, 0 when agentd could not be reached. */
  post(body: { records: TimelineRecord[] }): Promise<number>;
  /** `<agentd_state_dir>/blacklist.json`'s rules now. */
  blacklist(): BlacklistRules;
  /** Read at each record and tick. */
  policy(): TimelinePolicy;
  /** This shell's processes (main and helper), never recorded. */
  ownPids(): readonly number[];
  /** Unix milliseconds. */
  now(): number;
  /** Runs `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void;
  log(line: string): void;
}

const TICK_MS = 500;
const POST_SECONDS = 5;
/** The actions within this of the first are one tree read. */
const READ_DELAY_MS = 300;
/** A read that found no change is made once more this much later: what the click started may still be changing. */
const RETRY_DELAY_MS = 700;
/** Seconds an action of an app not yet sampled in front waits for the sample that shows it (one beat is 1 s). */
const EARLY_S = 1.5;
const READ_KINDS = new Set(['click', 'context_menu', 'submit']);

/** A record and the window it was made in, which it is filtered against; `retried` once its read found no change. */
interface Pending { record: TimelineRecord; window: CaptureWindow; retried?: boolean }

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function base(kind: TimelineKind, ts: number, w: AttentionWindow): TimelineRecord {
  return { ts, kind, app: w.app, bundle_id: w.bundleId, pid: w.pid, window_id: w.windowId, window_title: w.title, url_host: w.urlHost,
    target: null, keys: null, text: null, tree: null };
}

export class TimelineRecorder {
  private readonly ports: TimelinePorts;
  private readonly queue = new TimelineQueue();
  private latestSample: AttentionSample | null = null;
  private cancelTick: (() => void) | null = null;
  /** `input.actions` as last asked for. */
  private actions = false;
  /** The front window recorded last. */
  private shown: { pid: number; windowId: number | null } | null = null;
  /** The tree agentd last took for `shown`, which the helper diffs against. */
  private treeId: string | null = null;
  /** The record with the tree queued last for `shown`, whose id becomes `treeId` when a post of it succeeds. */
  private unsent: { record: TimelineRecord; treeId: string } | null = null;
  /** Bumped by each window change and stop, so an older window's tree is dropped. */
  private generation = 0;
  private reading = false;
  private windowPending: Pending | null = null;
  /** Actions waiting for the next read, and the ones the read in flight is for. */
  private waiting: Pending[] = [];
  private inflight: Pending[] = [];
  /** `input.action`s whose pid was not the sampled front, with their time: an app switched to before the next beat. */
  private early: { data: Record<string, unknown>; ts: number }[] = [];
  private cancelRead: (() => void) | null = null;
  private posting = false;
  private lastPost = 0;
  private loggedFailure: string | null = null;
  private loggedRefusal = false;

  constructor(ports: TimelinePorts) {
    this.ports = ports;
  }

  private get running(): boolean {
    return this.cancelTick !== null;
  }

  /** agentd is up and plugins.screen_awareness is on. */
  start(): void {
    if (this.running) return;
    this.lastPost = this.seconds();
    this.cancelTick = this.ports.every(TICK_MS, () => this.tick());
    if (this.ports.policy().allowActions) this.setActions(true);
  }

  /** The queue is kept for the next start. */
  stop(): void {
    if (!this.running) return;
    this.cancelTick?.();
    this.cancelTick = null;
    this.early = [];
    if (this.actions) this.setActions(false);
  }

  /** Each AttentionSampler sample (`onSample`): a new front window is recorded with its whole tree, then the early
   *  actions of the app it shows in front. */
  update(sample: AttentionSample): void {
    this.latestSample = sample;
    const early = this.early;
    this.early = [];
    if (!this.running || !this.actions || sample.locked || sample.asleep) return;
    this.showWindow(sample);
    const f = sample.front;
    for (const e of early) if (f !== null && e.data.pid === f.pid && this.seconds() - e.ts <= EARLY_S) this.act(e.data, sample, f, e.ts);
  }

  private showWindow(sample: AttentionSample): void {
    const f = sample.front;
    const next = f && f.pid !== null ? { pid: f.pid, windowId: f.windowId } : null;
    if (next?.pid === this.shown?.pid && next?.windowId === this.shown?.windowId) return;
    this.leaveWindow();
    this.shown = next;
    if (!f || !next) return;
    const window = this.frontWindow(sample, f);
    const reason = captureBlockReason(window, this.ports.blacklist(), this.ports.ownPids());
    if (reason !== null && reason !== 'secure_input') return;
    const pending = { record: base('window', this.seconds(), f), window };
    if (reason === 'secure_input') {
      this.enqueue(pending);
      return;
    }
    this.windowPending = pending;
    void this.read();
  }

  /** A helper event; only `input.action` is read, and only for the sampled front window. */
  event(name: string, data: Record<string, unknown>): void {
    if (name !== 'input.action' || !this.running || !this.actions) return;
    const s = this.latestSample;
    if (!s || s.locked || s.asleep || typeof data.pid !== 'number') return;
    if (s.front === null || data.pid !== s.front.pid) {
      this.early.push({ data, ts: this.seconds() });
      return;
    }
    this.act(data, s, s.front, this.seconds());
  }

  /** An action in `f`, the front window of sample `s`, at `ts`. */
  private act(data: Record<string, unknown>, s: AttentionSample, f: AttentionWindow, ts: number): void {
    const kind = data.kind;
    if (kind !== 'click' && kind !== 'context_menu' && kind !== 'shortcut' && kind !== 'submit') return;
    const window = this.frontWindow(s, f);
    const reason = captureBlockReason(window, this.ports.blacklist(), this.ports.ownPids());
    if (reason !== null && reason !== 'secure_input') return;
    const record = { ...base(kind, ts, f), target: toTarget(data.target), keys: str(data.keys) };
    if (!READ_KINDS.has(kind) || reason === 'secure_input') {
      this.enqueue({ record, window });
      return;
    }
    this.waiting.push({ record, window });
    this.scheduleRead();
  }

  /** ActivityRecorder's queued events: a value is the text typed, a selection the text selected. */
  mirror(e: ActivityEvent): void {
    if (!this.running || !this.actions || (e.kind !== 'value' && e.kind !== 'selection')) return;
    const s = this.latestSample;
    if (!s || s.locked || s.asleep) return;
    const window = captureWindow(e, s.front, s.frontIncognito, s.secureInput);
    const windowId = s.front !== null && s.front.pid === e.pid ? s.front.windowId : null;
    this.enqueue({ window, record: { ...base(e.kind === 'value' ? 'text_input' : 'selection', e.ts, { ...window.window, windowId }),
      target: { role: e.role, subrole: e.subrole, title: e.label, description: null, identifier: null, value: null }, text: e.value } });
  }

  private seconds(): number {
    return this.ports.now() / 1000;
  }

  private frontWindow(s: AttentionSample, f: AttentionWindow): CaptureWindow {
    return { window: f, incognito: s.frontIncognito, secureInput: s.secureInput };
  }

  private setActions(on: boolean): void {
    this.actions = on;
    if (!on) {
      this.leaveWindow();
      this.shown = null;
    }
    void this.ports.helper.request('input.actions', { enabled: on }).then((reply) => {
      if (!reply.ok) this.ports.log(`TIMELINE input.actions failed code=${reply.error.code}`);
    });
  }

  /** The window's actions still waiting for a tree go without one. */
  private leaveWindow(): void {
    this.generation += 1;
    this.treeId = null;
    this.unsent = null;
    this.cancelRead?.();
    this.cancelRead = null;
    for (const p of [...(this.windowPending ? [this.windowPending] : []), ...this.inflight, ...this.waiting]) this.enqueue(p);
    this.windowPending = null;
    this.inflight = [];
    this.waiting = [];
  }

  private scheduleRead(ms = READ_DELAY_MS): void {
    if (this.cancelRead !== null || this.reading) return;
    // A one-shot on the periodic port.
    const cancel = this.ports.every(ms, () => {
      cancel();
      this.cancelRead = null;
      void this.read();
    });
    this.cancelRead = cancel;
  }

  /** One `ax.window_tree` at a time: the pending window's whole tree first, else the waiting actions' diff. */
  private async read(): Promise<void> {
    const shown = this.shown;
    if (this.reading || !shown) return;
    const windowRead = this.windowPending;
    const batch = windowRead ? [windowRead] : this.waiting.splice(0);
    if (batch.length === 0) return;
    this.windowPending = null;
    this.reading = true;
    this.inflight = batch;
    const generation = this.generation;
    const params = windowRead || this.treeId === null ? { pid: shown.pid } : { pid: shown.pid, previous: this.treeId };
    const reply = await this.ports.helper.request('ax.window_tree', params);
    this.reading = false;
    let retry = false;
    if (generation === this.generation) {
      this.inflight = [];
      retry = this.carry(batch, reply, windowRead !== null);
    }
    if (this.windowPending) void this.read();
    else if (this.waiting.length > 0) this.scheduleRead(retry ? RETRY_DELAY_MS : READ_DELAY_MS);
  }

  /** The tree goes on the last record of the batch; the helper diffs against it next only when agentd gets it. An
   *  action batch's first no_change puts it back to wait for one more read instead; true then. */
  private carry(batch: Pending[], reply: HelperAnswer, windowRead: boolean): boolean {
    if (reply.ok && reply.result.mode === 'no_change' && !windowRead && batch.some((p) => !p.retried)) {
      this.waiting.unshift(...batch.map((p) => ({ ...p, retried: true })));
      return true;
    }
    let tree: TimelineTree | null = null;
    if (!reply.ok) {
      if (reply.error.code !== this.loggedFailure) this.ports.log(`TIMELINE ax.window_tree failed code=${reply.error.code}`);
      this.loggedFailure = reply.error.code;
    } else {
      this.loggedFailure = null;
      const r = reply.result, mode = r.mode;
      if (r.matched === true && r.secure !== true && typeof r.text === 'string' && (mode === 'full' || (mode === 'diff' && !windowRead))) {
        tree = { mode, text: r.text };
      }
    }
    const last = batch.at(-1)!;
    for (const p of batch.slice(0, -1)) this.enqueue(p);
    const kept = this.enqueue({ ...last, record: { ...last.record, tree } });
    if (tree && kept?.tree) {
      // Until agentd takes this tree, a diff would have no base there.
      this.treeId = null;
      this.unsent = reply.ok && typeof reply.result.tree_id === 'string' ? { record: kept, treeId: reply.result.tree_id } : null;
    }
    return false;
  }

  private enqueue(p: Pending): TimelineRecord | null {
    const kept = filterRecord(p.record, p.window, this.ports.blacklist(), this.ports.ownPids(), this.ports.policy());
    if (kept) this.queue.append([kept]);
    return kept;
  }

  private tick(): void {
    const policy = this.ports.policy();
    if (policy.allowActions !== this.actions) this.setActions(policy.allowActions);
    const now = this.seconds();
    if (!this.actions || this.posting || this.queue.count === 0
      || (this.queue.count < TimelineQueue.BATCH && now - this.lastPost < POST_SECONDS)) return;
    const batch = this.queue.drain();
    this.posting = true;
    this.lastPost = now;
    void this.ports.post({ records: batch }).then((status) => {
      this.posting = false;
      if (status >= 400 && status < 500) {
        if (!this.loggedRefusal) this.ports.log(`TIMELINE post refused status=${status}`);
        this.loggedRefusal = true;
      } else if (status < 200 || status >= 300) {
        this.queue.putBack(batch);
      } else {
        this.loggedRefusal = false;
        if (this.unsent && batch.includes(this.unsent.record)) {
          this.treeId = this.unsent.treeId;
          this.unsent = null;
        }
      }
    });
  }
}
