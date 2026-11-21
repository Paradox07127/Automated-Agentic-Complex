// The activity recorder over the platform helper (CONTRACT §7.2 `workspace.watch`, §7.4 `ax.watch`): the front app's
// focus, value, selection and window changes become `POST /context/events` batches while agentd runs and
// `plugins.screen_awareness` is on.
import {
  ActivityCoalescer, type ActivityElement, type ActivityEvent, ActivityEventQueue, type ActivityPolicy, appElement, captureWindow, decodeElement,
  eventsBody, filterEvent,
} from '../../common/activity.ts';
import { type AttentionSample, type BlacklistRules, hides } from '../../common/attention.ts';
import type { HelperAnswer } from '../../common/push-to-talk.ts';

export interface ActivityPorts {
  helper: { request(op: string, params?: Record<string, unknown>): Promise<HelperAnswer> };
  /** `POST /context/events`; the HTTP status, 0 when agentd could not be reached. */
  post(body: { events: Record<string, unknown>[] }): Promise<number>;
  /** `<agentd_state_dir>/blacklist.json`'s rules now. */
  blacklist(): BlacklistRules;
  /** Read at each notification and tick: `share_typed_text`, `sense_input_counts`, `redact_sensitive`. */
  policy(): ActivityPolicy;
  /** This shell's processes (main and helper), never watched. */
  ownPids(): readonly number[];
  /** Unix milliseconds. */
  now(): number;
  /** Runs `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void;
  log(line: string): void;
  /** Each event as it is queued (TimelineRecorder.mirror). */
  timeline?(e: ActivityEvent): void;
}

/** The AX notifications under their CONTRACT §7.4 names. */
const NOTIFICATIONS = ['focus', 'window', 'title', 'value', 'selection'];
/** The recorder's own `ax.watch`, beside the screen context's. */
const WATCH_ID = 'activity';
/** Electron and Chromium apps build their AX tree only when asked. */
const MANUAL_ACCESSIBILITY = new Set(['com.microsoft.VSCode', 'com.todesktop.230313mzl4w4u92', 'com.openai.codex',
  'com.anthropic.claudefordesktop', 'md.obsidian']);
const TICK_MS = 500;
const POST_SECONDS = 5;

interface Front { pid: number; name: string | null; bundleId: string | null }

/** `ax.watch` of `front`; `typed` is share_typed_text, which the selected text and the value are read for. */
function watchParams(front: Front, typed: boolean): Record<string, unknown> {
  return { pid: front.pid, notifications: NOTIFICATIONS, read_selected_text: typed, read_value: typed,
    ...(front.bundleId !== null && MANUAL_ACCESSIBILITY.has(front.bundleId) && { manual_accessibility: true }), watch_id: WATCH_ID };
}

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export class ActivityRecorder {
  private readonly ports: ActivityPorts;
  private readonly coalescer = new ActivityCoalescer();
  private readonly queue = new ActivityEventQueue();
  private latestSample: AttentionSample | null = null;
  private cancelTick: (() => void) | null = null;
  private target: Front | null = null;
  /** The pid the helper watches and whether it sends the selected text and the value. */
  private watched: { pid: number; selected: boolean } | null = null;
  /** `workspace.watch` answered; after a restart the supervisor asks for it and the `ax.watch` again (CONTRACT §6.4). */
  private workspaceWatched = false;
  private focusedInfo: ActivityElement | null = null;
  /** Bumped by each attach and stop, so an older attach's answers are dropped. */
  private generation = 0;
  private posting = false;
  private lastPost = 0;
  private loggedFailure: string | null = null;

  constructor(ports: ActivityPorts) {
    this.ports = ports;
  }

  private get running(): boolean {
    return this.cancelTick !== null;
  }

  /** Each AttentionSampler sample (`onSample`). */
  update(sample: AttentionSample): void {
    this.latestSample = sample;
  }

  /** agentd is up and `plugins.screen_awareness` is on. */
  start(): void {
    if (this.running) return;
    this.lastPost = this.seconds();
    this.cancelTick = this.ports.every(TICK_MS, () => this.tick());
    void this.watchWorkspace();
  }

  /** The queue is kept for the next start. */
  stop(): void {
    if (!this.running) return;
    this.cancelTick?.();
    this.cancelTick = null;
    this.generation += 1;
    this.detach();
    void this.unwatch();
  }

  /** The helper said hello (true) or went (false). The watches that answered come back with the supervisor; the ones that
   *  never did are asked for here. */
  helper(running: boolean): void {
    if (!running || !this.running) return;
    if (!this.workspaceWatched) void this.watchWorkspace();
    else if (this.watched === null) void this.attachFront();
  }

  /** A helper event; `workspace.changed` for a new front app and `ax.notification` are read. */
  event(name: string, data: Record<string, unknown>): void {
    if (!this.running) return;
    if (name === 'workspace.changed' && data.reason === 'front_app') {
      if (typeof data.front_pid === 'number') void this.attachFront();
      else void this.attach(null);
    } else if (name === 'ax.notification' && (data.watch_id === undefined || data.watch_id === WATCH_ID)) {
      this.handle(data);
    }
  }

  private seconds(): number {
    return this.ports.now() / 1000;
  }

  private paused(): boolean {
    const s = this.latestSample;
    return s !== null && (s.locked || s.asleep);
  }

  private async watchWorkspace(): Promise<void> {
    const reply = await this.ports.helper.request('workspace.watch', { enabled: true });
    if (reply.ok) this.workspaceWatched = true;
    else this.ports.log(`ACTIVITY workspace.watch failed code=${reply.error.code}`);
    await this.attachFront();
  }

  /** NSWorkspace.frontmostApplication: the front of an `attention.sample` without titles, input or audio. */
  private async attachFront(): Promise<void> {
    const generation = ++this.generation;
    const reply = await this.ports.helper.request('attention.sample', {});
    if (generation !== this.generation) return;
    const f = reply.ok && typeof reply.result.front === 'object' && reply.result.front !== null
      ? reply.result.front as Record<string, unknown> : null;
    const front = f && typeof f.pid === 'number'
      ? { pid: f.pid, name: typeof f.name === 'string' ? f.name : null, bundleId: typeof f.app_id === 'string' ? f.app_id : null } : null;
    await this.attach(front, generation);
  }

  /** ActivityRecorder.attach: our own and blacklisted apps are not watched. */
  private async attach(front: Front | null, generation = ++this.generation): Promise<void> {
    if (!this.running || generation !== this.generation) return;
    this.detach();
    if (!front || hides(this.ports.blacklist(), { app: front.name, bundleId: front.bundleId, pid: front.pid, windowId: null,
      title: null, urlHost: null }, this.ports.ownPids())) {
      if (this.watched) await this.unwatch();
      return;
    }
    const selected = this.ports.policy().allowTypedText;
    const reply = await this.ports.helper.request('ax.watch', watchParams(front, selected));
    if (!this.running || generation !== this.generation) return;
    if (!reply.ok) {
      this.watched = null;
      if (reply.error.code !== this.loggedFailure) this.ports.log(`ACTIVITY ax.watch failed pid=${front.pid} code=${reply.error.code}`);
      this.loggedFailure = reply.error.code;
      return;
    }
    this.loggedFailure = null;
    this.watched = { pid: front.pid, selected };
    this.target = front;
    if (this.paused()) return;
    const now = this.seconds();
    this.coalescer.app(appElement(front.pid, front.name, front.bundleId), now);
    // The watch's answer carries the window and the focus once (not on Windows).
    if ('window' in reply.result) this.windowChanged(front, obj(reply.result.window), now);
    const element = decodeElement(reply.result.element, front.pid, front.name, front.bundleId);
    if (element) {
      this.focusedInfo = element;
      this.coalescer.focus(element, now);
    }
  }

  /** ActivityRecorder.refreshWindow with the window the helper read. */
  private windowChanged(target: Front, window: Record<string, unknown> | null, now: number): void {
    const title = str(window?.title), doc = str(window?.doc);
    if (this.focusedInfo) this.focusedInfo = { ...this.focusedInfo, windowTitle: title, doc };
    this.coalescer.window(appElement(target.pid, target.name, target.bundleId, title, doc), now);
  }

  private detach(): void {
    this.target = null;
    this.focusedInfo = null;
  }

  private async unwatch(): Promise<void> {
    this.watched = null;
    await this.ports.helper.request('ax.watch', { pid: null, notifications: [], watch_id: WATCH_ID });
  }

  /** ActivityRecorder.handle. The helper sends the focused element and, with `source_key`, the key of the one notified: a
   *  value or selection change counts when that is the element last focused. Without `source_key` (Windows) the focused
   *  element stands in for the one notified. */
  private handle(data: Record<string, unknown>): void {
    const target = this.target;
    if (!target || data.pid !== target.pid || this.paused()) return;
    const now = this.seconds();
    const element = decodeElement(data.element, target.pid, target.name, target.bundleId);
    const source = str(data.source_key);
    const focused = this.focusedInfo;
    const fromFocused = focused !== null && element !== null
      && (source === null ? element.key === focused.key : source === focused.key && element.key === source);
    switch (data.notification) {
      case 'focus':
        if (!element) return;
        this.focusedInfo = element;
        this.coalescer.focus(element, now);
        return;
      case 'window':
      case 'title':
        if ('window' in data) {
          this.windowChanged(target, obj(data.window), now);
          return;
        }
        if (!element) return;
        if (this.focusedInfo) this.focusedInfo = { ...this.focusedInfo, windowTitle: element.windowTitle, doc: element.doc };
        this.coalescer.window(appElement(target.pid, target.name, target.bundleId, element.windowTitle, element.doc), now);
        return;
      case 'value':
        if (!fromFocused || !focused || !element) return;
        this.focusedInfo = { ...focused, valueLength: element.valueLength, value: element.value };
        this.coalescer.valueChanged(this.focusedInfo, now);
        return;
      case 'selection':
        if (!fromFocused || !focused || !element) return;
        this.coalescer.selectionChanged({ ...focused,
          selectedText: this.ports.policy().allowTypedText ? element.selectedText : null }, now);
        return;
    }
  }

  private tick(): void {
    const now = this.seconds();
    const policy = this.ports.policy();
    // `ax.watch` reads the selected text and the value only when asked: a change of share_typed_text watches again.
    if (this.target && this.watched && this.watched.selected !== policy.allowTypedText) void this.rewatch(this.target, policy.allowTypedText);
    const sample = this.latestSample;
    if (!sample || sample.locked || sample.asleep) return;
    const rules = this.ports.blacklist(), ownPids = this.ports.ownPids();
    for (const event of this.coalescer.tick(now)) {
      const window = captureWindow(event, sample.front, sample.frontIncognito, sample.secureInput);
      const kept = filterEvent(event, window, rules, ownPids, policy);
      if (kept) {
        this.queue.append([kept]);
        this.ports.timeline?.(kept);
      }
    }
    if (this.posting || this.queue.count === 0
      || (this.queue.count < ActivityEventQueue.BATCH && now - this.lastPost < POST_SECONDS)) return;
    const batch = this.queue.drain();
    this.posting = true;
    this.lastPost = now;
    void this.ports.post(eventsBody(batch)).then((status) => {
      this.posting = false;
      if (status < 200 || status >= 300) this.queue.putBack(batch);
    });
  }

  private async rewatch(front: Front, selected: boolean): Promise<void> {
    this.watched = { pid: front.pid, selected };
    const reply = await this.ports.helper.request('ax.watch', watchParams(front, selected));
    if (!reply.ok) this.ports.log(`ACTIVITY ax.watch failed pid=${front.pid} code=${reply.error.code}`);
  }
}

/** The recorder, idle until `start()`. */
export function startActivity(ports: ActivityPorts): ActivityRecorder {
  return new ActivityRecorder(ports);
}
