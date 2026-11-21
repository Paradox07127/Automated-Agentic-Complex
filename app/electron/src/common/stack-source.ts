// The desktop stack's cards: agentd's `/approvals` and `/tasks`, polled, with
// `/agent/interactions`, `/agent/tasks` and `/commitments` read at start and on feed events, and the feed's `announce`s,
// pushed to the pages as `stack.onCards` payloads; `stack.decide`, `later`, `collapse` and `complete` over them; and the
// cards the shell raises itself: avatar loading, computer use, voice hint, 屏幕识读 receipt, drop and resume notices. What
// goes to a system notification goes through `notifier`; without one it is taken as handled and shows nothing.
import { BridgeFailure } from './bridge.ts';
import type { ComputerUsePanelState, ComputerUsePhase } from './computer-control.ts';
import type { Cancel, EventSource, StreamEvent } from './page.ts';
import type { VoiceHint } from './push-to-talk.ts';
import { agentdError } from './routes.ts';
import {
  AGENT_NAMES, type CodingTask, codingCard, type Commitment, type Delivery, deliveryCard, deliveryTitle, dropItems,
  type HandedItem, type Interaction, isDecidable, isDecided, isHidden, mainRoute, ms, questionCard, questionsOf, reviewCard, type TaskRow, VOICE_HINT_ID,
  voiceCard,
} from './stack-cards.ts';

type Json = Record<string, unknown>;
export type NotifyMode = 'sound' | 'card' | 'silent';
export type AnnounceKind = 'done' | 'waiting' | 'error' | 'brief' | 'reminder';
/** `notify_*` per announcement kind and `system_notifications`, read on each announcement. */
export interface Notify { modes: Partial<Record<AnnounceKind, NotifyMode>>; systemNotifications?: boolean }

/** `body` is the reply's text. Throws when agentd cannot be reached. */
export type Request = (method: string, path: string, json?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: string }>;

/** One system notification (SystemNotifier's `Announcement` with the sound its mode gives); `id` names it for `withdraw` and
 *  `StackSource.notificationPath`. */
export interface SystemNote {
  id: string; kind: AnnounceKind; text: string; sound: boolean; sessionId: string | null; traceId: string | null; commitmentId: string | null;
}

export interface StackSourceOptions {
  request: Request;
  notify(): Notify;
  avatarHidden(): boolean;
  frontFullscreen(): boolean;
  playSound(): void;
  /** Posts and takes back system notifications; `post` resolves true once the system added it. */
  notifier?: { post(note: SystemNote): Promise<boolean>; withdraw(ids: string[]): void };
  /** Epoch ms. */
  clock?(): number;
  /** ms between `/approvals` reads while a panel shows the cards. */
  pollInterval?: number;
}

interface Approval {
  request_id: string; generation: number; display_session?: string | null; source?: string | null; session_id?: string | null;
  tool_name?: string | null; tool_summary?: string | null; kind?: string | null; content_preview?: string | null; cwd?: string | null;
  danger_rule?: string | null; status: string; summary_truncated: boolean; dangerous: boolean;
  summary_length?: number | null; options: string[]; session_scope?: { kind: string; detail?: string | null } | null;
  window_s: number; seconds_left: number;
  dispatch?: { target?: string; cwd?: string; prompt?: string; source?: string; utterance?: string | null; mode?: string;
    modes?: string[]; verify_cmd?: string | null } | null;
}
interface Announce {
  seq: number; level: string; headline: string; detail?: string | null; session_id?: string | null; trace_id?: string | null;
  project?: string | null; kind?: string | null; state?: string | null;
  /** A reminder's commitment id; of any other kind, the ledger task of its dispatch. */
  origin?: string | null;
  /** Every commitment a `reminder_due` merges; set on every `reminder_due`. */
  commitment_ids?: string[] | null;
  /** A reminder due during quiet: shown without sound. */
  silent?: boolean | null;
}

/** What a card was built from. */
type Record_ =
  | { kind: 'approval'; approval: Approval; fetchedAt: number }
  | { kind: 'question'; question: Interaction }
  | { kind: 'review'; row: TaskRow; delivery: Delivery }
  | { kind: 'codingReview'; task: CodingTask }
  | { kind: 'delivery'; row: TaskRow; delivery: Delivery }
  | { kind: 'reminder'; commitment: Commitment }
  | { kind: 'notice' }
  | { kind: 'computerUse' }
  | { kind: 'voiceHint'; hint: VoiceHint };
/** `native`: cards the shell raises itself (computer use, voice hint, avatar loading). */
type Part = 'approvals' | 'questions' | 'deliveries' | 'coding' | 'reminders' | 'announce' | 'native';
interface Entry {
  record: Record_; card: Json; at: number; title: string; part: Part; key: string; live: boolean; collapsed: boolean;
  receipt: string | null; outcome: { kind: string; at: number; text: string | null } | null; decided: boolean; until: number | null;
}
interface Fresh { id: string; key: string; record: Record_; card: Json; at: number; title: string }

const waits = (r: Record_) => r.kind === 'approval' || r.kind === 'question' || r.kind === 'review' || r.kind === 'codingReview';
/** A broker approval or a role's exact-call approval: both carry an `outcome`. */
const isApproval = (r: Record_) => r.kind === 'approval' || (r.kind === 'question' && r.question.kind === 'approval');
const deliveryOf = (r: Record_ | undefined) => (r?.kind === 'review' || r?.kind === 'delivery' ? r.delivery : null);

/** StackSource.AvatarLoading; `title` is the stage's, e.g. 正在加载角色. */
export type AvatarLoading =
  | { kind: 'hidden' }
  | { kind: 'loading'; character: string; title: string }
  | { kind: 'recovering'; character: string; seconds: number }
  | { kind: 'failed'; message: string };

/** The loading card's title by the startup status's `stage`. */
export const AVATAR_STAGE_TITLES: Readonly<Record<string, string>> = { starting: '正在启动角色', loading_character: '正在加载角色',
  loading_animations: '正在加载动作', preparing_graphics: '正在准备画面', connecting: '正在连接角色', ready: '角色已准备好', failed: '角色加载失败' };

export const TEST_APPROVAL_ID = 'settings-test-approval';
const AVATAR_LOADING_ID = 'avatar-loading';
const COMPUTER_USE_ID = 'computer-use';
/** ComputerUsePhase.title of the phases that show the computer use card. */
const COMPUTER_USE_TITLES: Partial<Record<ComputerUsePhase, string>> = { observing: '正在查看', executing: '正在操作', verifying: '正在检查结果',
  paused: '已暂停' };
const LOOK_LIFE_MS = 2_000;
const ELSEWHERE = '已在别处处理';
const EXPIRED = '已过期';
const LINGER_MS = 8_000;
const HISTORY_LIMIT = 20;
const DONE_LIFE_MS = 20_000;
const BRIEF_LIFE_MS = 30_000;
const DELIVERY_LIFE_MS = 30_000;
const VOICE_RESULT_LIFE_MS = 2_500;
/** Where a click on a reminder's system notification lands. */
const REMINDERS_PATH = '/overview?focus=reminders';
export const HIDDEN_POLL_MS = 5_000;

const titleOf = (a: Approval) => `${a.tool_name ?? ''}: ${a.tool_summary ?? ''}`;

/** A path segment, `:`, `/`, `?`, `%`, `=` and `+` escaped; null for a value no route can name. */
export function segment(value: string): string | null {
  if (value === '' || new TextEncoder().encode(value).length > 2048) return null;
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** fetched_at − (window_s − seconds_left) s: the broker keeps no epoch start. */
function approvalSince(a: Approval, fetchedAt: number): number {
  return fetchedAt - ms(a.window_s - a.seconds_left);
}

export function approvalCard(a: Approval, fetchedAt: number): Json {
  const agent = AGENT_NAMES[a.source ?? ''] ?? a.source ?? '';
  const dispatch = a.kind === 'dispatch';
  const item: Json = {
    id: a.request_id, kind: 'approval', task_id: dispatch ? `task:${a.request_id}` : null, title: titleOf(a),
    source: a.display_session ? `${agent} · ${a.display_session}` : agent, since: approvalSince(a, fetchedAt), generation: a.generation,
    approval_kind: dispatch ? 'dispatch' : 'tool', agent: a.source ?? '', display_session: a.display_session ?? null,
    session_id: a.session_id ?? '', tool: a.tool_name ?? '', summary_truncated: a.summary_truncated, cwd: a.cwd ?? null,
    dangerous: a.dangerous, options: a.options,
    session_scope: a.session_scope ? { kind: a.session_scope.kind, detail: a.session_scope.detail ?? '' } : null,
    dispatch: a.dispatch ? {
      target: a.dispatch.target ?? '', cwd: a.dispatch.cwd ?? '', prompt: a.dispatch.prompt ?? '', source: a.dispatch.source ?? '',
      utterance: a.dispatch.utterance ?? null, modes: a.dispatch.modes ?? [], mode: a.dispatch.mode ?? '', verify_cmd: a.dispatch.verify_cmd ?? null,
    } : null,
    status: a.status, window_s: a.window_s, seconds_left: a.seconds_left, fetched_at: fetchedAt,
    scope_ok: a.options.includes('allow_session'),
  };
  if (a.tool_summary != null) item.cmd = a.tool_summary;
  if (a.content_preview != null) item.content_preview = a.content_preview;
  if (a.summary_length != null) item.orig_len = a.summary_length;
  if (a.danger_rule != null) item.danger_rule = a.danger_rule;
  // Own sessions and dispatches open their task; anything else is an external terminal session.
  const own = dispatch || a.display_session?.startsWith('own:') === true;
  return { id: a.request_id, kind: 'approval', item, session: own ? 'task' : 'terminal', task_id: null };
}

/** web surfaces/stack/sessions.ts `isChatCard`: the chat window shows these, the stack page leaves them out. */
function isChatCard(card: Json): boolean {
  return card.kind === 'notice' && card.variant !== 'computer';
}

function parse<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

export class StackSource implements EventSource {
  pendingCount = 0;
  /** Whether a panel that shows the cards is up; while none is, `/approvals` and `/tasks` are read every `HIDDEN_POLL_MS`. */
  shown: () => boolean = () => true;
  onCount: (n: number) => void = () => {};
  /** The ids of the stack page's cards (no chat window cards) on each push; none once stopped. */
  onPush: (ids: string[]) => void = () => {};

  private readonly options: StackSourceOptions;
  private readonly clock: () => number;
  private entries = new Map<string, Entry>();
  private order: string[] = [];
  private history: Json[] = [];
  /** Results of announcements already handled, by `seq`; the feed and the bubble both hand them over. */
  private announced = new Map<number, boolean>();
  /** Progress announcement ids per agentd slot, so a terminal one takes them back. */
  private progress = new Map<string, string[]>();
  /** Announcement ids posted as system notifications. */
  private notified: string[] = [];
  /** `delivery_id#revision` already reported presented, or in flight. */
  private presented = new Set<string>();
  /** Delivery cards that ran out their time or went to a system notification; a later read does not bring them back. */
  private retired = new Set<string>();
  /** Card ids sent to a system notification instead of the stack. */
  private sentAway = new Set<string>();
  /** What a click on each of those notifications opens; kept past `stop`, as the notifications are. */
  private awayPaths = new Map<string, string>();
  private subscribers = new Map<number, (e: StreamEvent) => void>();
  private lastSubscriber = 0;
  private lastBody: string | null = null;
  private loaded = false;
  private offline = false;
  /** Bumped by `stop`, so reads that started before it are dropped. */
  private epoch = 0;
  /** Bumped by every new poll, so the one it replaces does not schedule another. */
  private pollGen = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private systemPaused = false;
  private feedCancel: Cancel | null = null;
  private refreshing = false;
  private again = false;

  constructor(options: StackSourceOptions) {
    this.options = options;
    this.clock = options.clock ?? Date.now;
  }

  /** Reads everything once, then `/approvals` and `/tasks` every poll interval; `feed`'s events read the rest again and its
   *  `announce`s become cards. */
  start(feed: EventSource | null): void {
    if (this.running) return;
    this.running = true;
    this.feedCancel = feed?.subscribe(null, (e) => this.handle(e), () => {
      this.announced.clear();
      this.requestRefresh();
    }) ?? null;
    if (!this.systemPaused) this.poll(true);
  }

  /** The screen locked or the Mac or its display asleep: no polls until it ends, then a read at once. */
  setSystemPaused(paused: boolean): void {
    if (paused === this.systemPaused) return;
    this.systemPaused = paused;
    if (!this.running) return;
    this.pollGen += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!paused) this.poll(!this.loaded);
  }

  private poll(full: boolean): void {
    const gen = ++this.pollGen;
    // A refresh that throws is a failed read like any other: the next poll still comes.
    void this.refresh(full).catch(() => {}).then(() => {
      if (!this.running || gen !== this.pollGen || this.systemPaused) return;
      const interval = this.options.pollInterval ?? 1000;
      this.timer = setTimeout(() => this.poll(false), this.shown() ? interval : Math.max(interval, HIDDEN_POLL_MS));
    });
  }

  /** A panel was shown or hidden: one that brings the cards up reads at once instead of after the hidden interval. */
  visibilityChanged(): void {
    if (!this.running || !this.shown() || this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.poll(false);
  }

  /** agentd is gone: drops the cards and pushes the `offline` error, once until a read answers again. */
  stop(): void {
    this.running = false;
    this.pollGen += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.feedCancel?.();
    this.feedCancel = null;
    this.epoch += 1;
    this.entries.clear();
    this.order = [];
    this.announced.clear();
    this.progress.clear();
    this.presented.clear();
    this.sentAway.clear();
    this.options.notifier?.withdraw(this.notified);
    this.notified = [];
    const wasOffline = this.offline;
    this.offline = true;
    this.loaded = false;
    this.lastBody = null;
    this.updateCount();
    if (wasOffline) return;
    const event = this.errorEvent();
    for (const s of this.subscribers.values()) s(event);
    this.onPush([]);
  }

  subscribe(_afterSeq: string | null, onEvent: (e: StreamEvent) => void, _onReload?: () => void): Cancel {
    const id = ++this.lastSubscriber;
    this.subscribers.set(id, onEvent);
    if (this.offline) onEvent(this.errorEvent());
    else if (this.loaded) {
      onEvent(this.cardsEvent());
      this.presentShown();
    }
    return () => { this.subscribers.delete(id); };
  }

  private handle(e: StreamEvent): void {
    if (e.event === 'announce') this.announce(e.data);
    else if (e.event === 'commitment') {
      this.settleCommitment(e.data);
      this.requestRefresh();
    } else if (e.event === 'agent_interaction' || e.event === 'delivery') this.requestRefresh();
  }

  /** A reminder cancelled, snoozed or completed elsewhere: its due card leaves for history. The `/commitments` read lists
   *  only triggered rows, so it cannot tell a settled reminder from a delivered one. */
  private settleCommitment(data: string): void {
    const c = parse<{ action?: string; commitment?: { id?: string } }>(data);
    const id = c?.commitment?.id;
    if (typeof id !== 'string' || !['cancelled', 'snoozed', 'completed'].includes(c?.action ?? '')) return;
    const now = this.clock();
    for (const x of [...this.order]) {
      const e = this.entries.get(x);
      if (e?.part === 'announce' && e.card.commitment_id === id) this.toHistory(x, now, null);
    }
    this.publish();
  }

  /** One full read at a time; a request during one runs one more after it. */
  requestRefresh(): void {
    if (this.refreshing) {
      this.again = true;
      return;
    }
    this.refreshing = true;
    void (async () => {
      do {
        this.again = false;
        await this.refresh().catch(() => {});
      } while (this.again);
      this.refreshing = false;
    })();
  }

  /** 404, or a 503 for a store agentd runs without (`no_tasks`, `no_commitments`; any 503 for `/approvals`), means none of
   *  these; any other failure keeps the cards it had. `pick` takes the list out of the reply; undefined is a failed read. */
  private async read<T>(path: string, pick: (body: Json) => T | undefined, any503 = false): Promise<T | 'absent' | 'failed'> {
    const epoch = this.epoch;
    let reply: { status: number; body: string };
    try {
      reply = await this.options.request('GET', path);
    } catch {
      return 'failed';
    }
    const body = parse<Json>(reply.body);
    if (reply.status === 404 || (reply.status === 503
      && (any503 || ['no_tasks', 'no_commitments'].includes(agentdError(reply.status, body).code)))) {
      if (epoch === this.epoch) this.offline = false;
      return 'absent';
    }
    const value = reply.status >= 200 && reply.status < 300 && body !== null && typeof body === 'object' ? pick(body) : undefined;
    if (value === undefined) return 'failed';
    if (epoch === this.epoch) this.offline = false;
    return value;
  }

  /** Every page of `/agent/tasks`. */
  private async readTasks(): Promise<TaskRow[] | 'absent' | 'failed'> {
    const rows: TaskRow[] = [];
    let path = '/agent/tasks?limit=50';
    for (;;) {
      const page = await this.read(path, (b) => (Array.isArray(b.tasks) ? b : undefined));
      if (page === 'absent' || page === 'failed') return page;
      rows.push(...page.tasks as TaskRow[]);
      const cursor = typeof page.next_cursor === 'string' ? segment(page.next_cursor) : null;
      if (cursor === null) return rows;
      path = `/agent/tasks?limit=50&cursor=${cursor}`;
    }
  }

  /** `full` false reads only the polled lists (`/approvals`, `/tasks`); feed events and `start` read everything. */
  async refresh(full = true): Promise<void> {
    const epoch = this.epoch;
    // A row that is not an object fails the whole read.
    const list = <T>(key: string) => (b: Json) => (Array.isArray(b[key])
      && (b[key] as unknown[]).every((row) => row !== null && typeof row === 'object' && !Array.isArray(row)) ? b[key] as T[] : undefined);
    const approvals = await this.read('/approvals', list<Approval>('approvals'), true);
    if (epoch !== this.epoch) return;
    if (approvals !== 'failed') this.syncApprovals(approvals === 'absent' ? [] : approvals);
    const coding = await this.read('/tasks', list<CodingTask>('tasks'));
    if (epoch !== this.epoch) return;
    if (coding !== 'failed') this.syncCoding(coding === 'absent' ? [] : coding);
    if (full) {
      const questions = await this.read('/agent/interactions', list<Interaction>('requests'));
      if (epoch !== this.epoch) return;
      if (questions !== 'failed') this.syncQuestions(questions === 'absent' ? [] : questions);
      const tasks = await this.readTasks();
      if (epoch !== this.epoch) return;
      if (tasks !== 'failed') this.syncDeliveries(tasks === 'absent' ? [] : tasks);
      const reminders = await this.read('/commitments?state=triggered', list<Commitment>('commitments'));
      if (epoch !== this.epoch) return;
      if (reminders !== 'failed') this.syncReminders(reminders === 'absent' ? [] : reminders);
    }
    this.sweep();
  }

  private syncApprovals(list: Approval[]): void {
    const now = this.clock();
    const added = this.sync('approvals', list.map((a) => ({ id: a.request_id, key: String(a.generation),
      record: { kind: 'approval', approval: a, fetchedAt: now }, card: approvalCard(a, now), at: approvalSince(a, now), title: titleOf(a) })));
    if (added.length > 0 && this.options.notify().modes.waiting === 'sound') this.options.playSound();
  }

  private syncQuestions(list: Interaction[]): void {
    const now = this.clock();
    this.sync('questions', list.filter((q) => q.state === 'pending').map((q) => ({ id: q.request_id, key: String(q.revision),
      record: { kind: 'question', question: q }, card: questionCard(q, now), at: ms(q.created_at ?? 0), title: questionsOf(q)[0]?.question ?? '' })));
  }

  private syncDeliveries(rows: TaskRow[]): void {
    const fresh: Fresh[] = [];
    for (let row of rows) {
      let d = row.delivery;
      if (isHidden(row) || !d || isDecided(d)) continue;
      const reviewId = `r-${d.delivery_id}`, doneId = `d-${d.delivery_id}`;
      // A presented receipt already gave a newer revision than this read.
      const known = deliveryOf((this.entries.get(reviewId) ?? this.entries.get(doneId))?.record);
      if (known && known.generation === d.generation && known.revision > d.revision) {
        d = known;
        row = { ...row, delivery: known };
      }
      const key = `${d.delivery_id}#${d.revision}#${d.generation}`, title = deliveryTitle(row, d);
      if (isDecidable(row)) {
        fresh.push({ id: reviewId, key, record: { kind: 'review', row, delivery: d }, card: reviewCard(row, d),
          at: ms(d.presented_at ?? d.produced_at ?? 0), title: `${title} v${d.delivery_version ?? 1}` });
      } else if (!this.retired.has(d.delivery_id) && (d.state === 'produced' || this.entries.has(doneId))) {
        // Only a delivery not yet shown anywhere opens a card; one already up stays for its lifetime.
        const taskId = d.canonical_task_id ?? row.canonical_task_id;
        if (!this.entries.has(doneId)
          && this.sendAway(doneId, 'done', title, mainRoute('/overview', [['sel', taskId], ['focus', `task-${taskId}`]]))) {
          this.retired.add(d.delivery_id);
          continue;
        }
        fresh.push({ id: doneId, key, record: { kind: 'delivery', row, delivery: d }, card: deliveryCard(row, d), at: ms(d.produced_at ?? 0), title });
      }
    }
    this.sync('deliveries', fresh);
    this.presentShown();
  }

  private syncCoding(list: CodingTask[]): void {
    this.sync('coding', list.filter((t) => t.state === 'needs_review' && t.target !== 'character').map((t) => ({ id: `c-${t.task_id}`,
      key: String(t.updated_at ?? 0), record: { kind: 'codingReview', task: t }, card: codingCard(t), at: ms(t.updated_at ?? 0), title: t.title ?? '' })));
  }

  private syncReminders(list: Commitment[]): void {
    this.sync('reminders', list.filter((c) => c.state === 'triggered'
      // A due announcement's card already stands for its commitment.
      && ![...this.entries.values()].some((e) => e.part === 'announce' && e.card.commitment_id === c.id)
      && (this.entries.has(`rem-${c.id}`) || !this.sendAway(`rem-${c.id}`, 'reminder', c.text, REMINDERS_PATH, c.id)))
      .map((c) => ({ id: `rem-${c.id}`, key: c.id, record: { kind: 'reminder', commitment: c },
        card: { id: `rem-${c.id}`, kind: 'notice', variant: 'reminder', title: c.text, commitment_id: c.id }, at: ms(c.due_at ?? 0),
        title: `提醒 · ${c.text}` })));
  }

  /** While she is hidden or a fullscreen app is in front, a new delivery or reminder card goes to a system notification
   *  instead, posted once per id; a click on it opens main window route `path`. True when it stays off the stack. */
  private sendAway(id: string, kind: AnnounceKind, text: string, path: string, commitmentId: string | null = null): boolean {
    const settings = this.options.notify(), hidden = this.options.avatarHidden(), fullscreen = this.options.frontFullscreen();
    if (!settings.systemNotifications || !(hidden || fullscreen)) return false;
    if (!this.sentAway.has(id)) {
      this.sentAway.add(id);
      this.awayPaths.set(id, path);
      const mode = settings.modes[kind] ?? 'silent';
      if (mode !== 'silent') {
        this.post({ id, kind, text, sound: mode === 'sound', sessionId: null, traceId: null, commitmentId }, commitmentId !== null ? [commitmentId] : []);
      }
    }
    return true;
  }

  /** Posts `note`; once the system added it, tells agentd that it showed each of `due`. */
  private post(note: SystemNote, due: string[]): void {
    const notifier = this.options.notifier;
    if (!notifier) return;
    void notifier.post(note).then((added) => { if (added) this.see(due); });
  }

  /** Tells agentd that a notification showed each commitment; the reply is not read. */
  private see(ids: string[]): void {
    for (const id of ids) {
      const s = segment(id);
      // A failed receipt is not retried.
      if (s !== null) this.options.request('POST', `/commitments/${s}/seen`, {}).catch(() => {});
    }
  }

  /** Returns the ids that were not on the stack before. */
  private sync(part: Part, fresh: Fresh[]): string[] {
    const now = this.clock();
    const added: string[] = [];
    for (const f of fresh) {
      const until = part === 'deliveries' && !waits(f.record) ? now + DELIVERY_LIFE_MS : null;
      const e = this.entries.get(f.id);
      if (e) {
        if (e.key === f.key) continue;
        Object.assign(e, { key: f.key, record: f.record, card: f.card, at: f.at, title: f.title, live: true, receipt: null, outcome: null,
          decided: false, until });
      } else {
        const entry = this.entry(f.record, f.card, f.at, f.title, part, f.key);
        entry.until = until;
        this.entries.set(f.id, entry);
        this.order.push(f.id);
        added.push(f.id);
      }
    }
    const ids = new Set(fresh.map((f) => f.id));
    for (const id of [...this.order]) {
      const e = this.entries.get(id);
      if (!ids.has(id) && e?.part === part && e.live) this.vanish(id, now, false);
    }
    return added;
  }

  private entry(record: Record_, card: Json, at: number, title: string, part: Part, key: string): Entry {
    return { record, card, at, title, part, key, live: true, collapsed: false, receipt: null, outcome: null, decided: false, until: null };
  }

  /** Presented receipts for the delivery cards on the stack, once a page is subscribed to show them. */
  private presentShown(): void {
    if (this.subscribers.size === 0) return;
    for (const id of this.order) {
      const e = this.entries.get(id);
      if (e?.live && (e.record.kind === 'review' || e.record.kind === 'delivery')) this.present(e.record.row, e.record.delivery);
    }
  }

  /** Sends the presented receipt once per revision for a delivery still just produced; its reply is the record then. */
  private present(row: TaskRow, d: Delivery): void {
    const id = segment(d.delivery_id);
    if (d.state !== 'produced' || d.presented_at != null || id === null) return;
    if (this.presented.has(`${d.delivery_id}#${d.revision}`)) return;
    this.presented.add(`${d.delivery_id}#${d.revision}`);
    const epoch = this.epoch;
    void (async () => {
      let reply: { status: number; body: string };
      try {
        reply = await this.options.request('POST', `/agent/deliveries/${id}/presented`, { expected_revision: d.revision, generation: d.generation });
      } catch {
        return;
      }
      const delivery = reply.status >= 200 && reply.status < 300 ? parse<{ delivery?: Delivery }>(reply.body)?.delivery : undefined;
      if (typeof delivery?.delivery_id !== 'string' || epoch !== this.epoch) return;
      this.presented.add(`${delivery.delivery_id}#${delivery.revision}`);
      this.replace({ ...row, delivery }, delivery);
    })();
  }

  private replace(row: TaskRow, d: Delivery): void {
    for (const id of [`r-${d.delivery_id}`, `d-${d.delivery_id}`]) {
      const e = this.entries.get(id);
      const known = deliveryOf(e?.record);
      if (!e?.live || !known || known.generation !== d.generation || known.revision >= d.revision) continue;
      if (e.record.kind === 'review') Object.assign(e, { record: { kind: 'review', row, delivery: d }, card: reviewCard(row, d) });
      else Object.assign(e, { record: { kind: 'delivery', row, delivery: d }, card: deliveryCard(row, d) });
      e.key = `${d.delivery_id}#${d.revision}#${d.generation}`;
    }
    this.publish();
  }

  /** Feed `announce` data. A `reminder_*` is a reminder (`reminder_due` the card that snoozes or completes its commitment,
   *  silent while quiet), the P1 `focus_done` recap a done notice, else P1 is an error card, a terminal one a done notice,
   *  the rest brief notices. Returns true when a card or a system notification shows it, or its kind is set to 不提示; the
   *  same `seq` again returns the first answer. */
  announce(data: string): boolean {
    const a = parse<Announce>(data);
    if (!a || typeof a.seq !== 'number' || typeof a.level !== 'string' || typeof a.headline !== 'string') return false;
    const known = this.announced.get(a.seq);
    if (known !== undefined) return known;
    const handled = this.place(a);
    this.announced.set(a.seq, handled);
    this.publish();
    return handled;
  }

  private place(a: Announce): boolean {
    const id = `announce-${a.seq}`, terminal = a.state === 'terminal';
    const reminder = a.kind?.startsWith('reminder_') === true;
    const kind: AnnounceKind = reminder ? 'reminder' : a.kind === 'focus_done' ? 'done' : a.level === 'P1' ? 'error' : terminal ? 'done' : 'brief';
    const slot = a.session_id ?? a.project ?? a.kind ?? '';
    if (terminal) {
      const gone = this.progress.get(slot) ?? [];
      for (const old of gone) {
        if (this.entries.delete(old)) this.order = this.order.filter((x) => x !== old);
      }
      this.progress.delete(slot);
      const withdrawn = this.notified.filter((x) => gone.includes(x));
      this.notified = this.notified.filter((x) => !withdrawn.includes(x));
      this.options.notifier?.withdraw(withdrawn);
    } else if (kind === 'brief') {
      this.progress.set(slot, [...(this.progress.get(slot) ?? []), id]);
    }
    const settings = this.options.notify();
    // SystemNotifier.deliver: a silent reminder never sounds.
    const mode = reminder && a.silent === true && settings.modes[kind] === 'sound' ? 'card' : settings.modes[kind] ?? 'silent';
    const due = a.kind === 'reminder_due' ? a.commitment_ids as string[] : [];
    if (mode === 'silent') return true;
    // 简报 never becomes a system notification.
    const system = (settings.systemNotifications ?? false) && kind !== 'brief';
    if (system && (this.options.avatarHidden() || this.options.frontFullscreen())) {
      this.notified.push(id);
      if (reminder) this.awayPaths.set(id, REMINDERS_PATH);
      this.post({ id, kind, text: a.headline, sound: mode === 'sound', sessionId: a.session_id ?? null, traceId: a.trace_id ?? null,
        commitmentId: reminder ? a.origin ?? null : null }, due);
      return true;
    }
    // There is no card spot next to her while she is hidden.
    if (this.options.avatarHidden()) return false;
    const now = this.clock();
    let card: Json;
    let until: number | null = null;
    if (kind === 'error') {
      card = { id, kind: 'error', task_id: a.session_id ?? '', title: a.headline, reason: a.detail ?? '' };
    } else if (kind === 'done') {
      card = { id, kind: 'notice', variant: 'done', title: a.headline };
      // Outside a reminder `origin` is the dispatch's ledger task; the page opens it from the card.
      if (a.origin != null) card.task_id = `task:${a.origin}`;
      until = now + DONE_LIFE_MS;
    } else if (kind === 'reminder' && a.kind === 'reminder_due') {
      card = { id, kind: 'notice', variant: 'reminder', title: a.headline };
      if (a.origin != null) card.commitment_id = a.origin;
      if (due.length > 0) card.commitment_ids = due;
      // It takes the place of its commitment's listed card.
      if (a.origin != null && this.entries.delete(`rem-${a.origin}`)) this.order = this.order.filter((x) => x !== `rem-${a.origin}`);
    } else {
      card = { id, kind: 'notice', variant: 'brief', title: a.headline };
      until = now + BRIEF_LIFE_MS;
    }
    if (kind !== 'error' && a.detail != null) card.body = a.detail;
    const entry = this.entry({ kind: 'notice' }, card, now, a.headline, 'announce', id);
    entry.until = until;
    this.entries.set(id, entry);
    this.order.push(id);
    if (mode === 'sound') this.options.playSound();
    return true;
  }

  /** 去处理: pushes the cards once more with `"tab": "now"`, so the page leaves 历史 for the cards. */
  focusNow(): void {
    if (this.offline || !this.loaded) return;
    const event: StreamEvent = { event: 'stack.cards', id: null, data: JSON.stringify({ ...this.snapshot(), tab: 'now' }) };
    for (const s of this.subscribers.values()) s(event);
  }

  /** The main window route a click on a delivery or reminder notification this source posted opens; null for any other id. */
  notificationPath(id: string): string | null { return this.awayPaths.get(id) ?? null; }

  entryOf(id: string): Readonly<Entry> | undefined { return this.entries.get(id); }

  /** Exercises the real desktop approval card. Its decision is kept in this stack. */
  showTestApproval(): boolean {
    if (this.offline || this.options.avatarHidden() || this.options.frontFullscreen()) return false;
    const now = this.clock();
    const a: Approval = {
      request_id: TEST_APPROVAL_ID, generation: now, display_session: null, source: 'agentd', session_id: null, tool_name: '测试审批',
      tool_summary: '允许一次演示操作？', kind: 'tool', content_preview: '测试只更新这张卡片。', cwd: null, danger_rule: null,
      status: 'pending', dispatch: null, summary_truncated: false, dangerous: false, summary_length: null, options: ['allow', 'deny'],
      session_scope: null, window_s: 55, seconds_left: 55,
    };
    if (!this.entries.has(TEST_APPROVAL_ID)) this.order.push(TEST_APPROVAL_ID);
    const entry = this.entry({ kind: 'approval', approval: a, fetchedAt: now }, approvalCard(a, now), now, titleOf(a), 'native', String(now));
    entry.until = now + 55_000;
    this.entries.set(TEST_APPROVAL_ID, entry);
    if (this.options.notify().modes.waiting === 'sound') this.options.playSound();
    this.publish();
    this.focusNow();
    return true;
  }

  /** P2 avatar loading: loading and recovering follow the host, failed waits for 重新启动 or 关闭, hidden takes it away. */
  setAvatarLoading(state: AvatarLoading): void {
    const id = AVATAR_LOADING_ID;
    if (state.kind === 'hidden') {
      if (this.entries.has(id)) this.drop(id);
      return;
    }
    const card: Json = { id, kind: 'notice', variant: 'loading' };
    if (state.kind === 'loading') Object.assign(card, { phase: 'loading', title: state.title, character: state.character });
    else if (state.kind === 'recovering') {
      Object.assign(card, { phase: 'recovering', title: '角色恢复中', character: state.character, retry_at: this.clock() + state.seconds * 1000 });
    } else Object.assign(card, { phase: 'failed', title: state.message });
    this.put(id, { kind: 'notice' }, card, card.title as string);
  }

  /** P0 电脑操作 while a session is at work; 收起 only folds it, 停止 is `computerUse.stop`. Any other phase, or null, sends
   *  the card to history. */
  setComputerUse(state: ComputerUsePanelState | null): void {
    const id = COMPUTER_USE_ID, title = state && COMPUTER_USE_TITLES[state.phase];
    if (!state || title === undefined) {
      if (this.entries.has(id)) this.retire(id);
      return;
    }
    // The panel state has no window title.
    const card: Json = { id, kind: 'notice', variant: 'computer', title, phase: state.phase, target_app: state.targetApp, target_title: null,
      action: state.action, scopes: state.scopeChips };
    this.put(id, { kind: 'computerUse' }, card, '电脑操作');
  }

  /** P3 push-to-talk hint. A result stays `VOICE_RESULT_LIFE_MS`; 麦克风被拒 stays until the user closes it. null ends a
   *  recording or download, which then leaves without history. */
  setVoiceHint(hint: VoiceHint | null): void {
    const id = VOICE_HINT_ID, record = this.entries.get(id)?.record;
    const shown = record?.kind === 'voiceHint' ? record.hint : null;
    if (hint === null) {
      if (shown && (shown.kind === 'listening' || shown.kind === 'downloading')) this.drop(id);
      return;
    }
    if (shown && JSON.stringify(shown) === JSON.stringify(hint)) return;
    const card = voiceCard(hint);
    this.put(id, { kind: 'voiceHint', hint }, card, card.title as string,
      hint.kind === 'sent' || hint.kind === 'discarded' ? VOICE_RESULT_LIFE_MS : null);
  }

  /** P3 屏幕识读 receipt naming the window read; it lasts `LOOK_LIFE_MS`. */
  addLookReceipt(title: string): void {
    this.addNotice(`look-${this.clock()}`, 'look', `已识读：${title}`, {}, LOOK_LIFE_MS);
  }

  /** 交给她: what was dropped on her, as paths, links and text; it stays until an action or 关闭. */
  addDrop(items: HandedItem[], truncated: boolean): void {
    this.addNotice(`drop-${this.clock()}`, 'drop', `交给她 · ${items.length} 项`, { items: dropItems(items), truncated });
  }

  /** A notice the shell raises itself, e.g. after an answer that needs the main window to continue. */
  addNotice(id: string, variant: string, title: string, extra: Json = {}, lifeMs: number | null = null): void {
    const now = this.clock();
    if (!this.entries.has(id)) this.order.push(id);
    const entry = this.entry({ kind: 'notice' }, { ...extra, id, kind: 'notice', variant, title }, now, title, 'announce', id);
    entry.until = lifeMs === null ? null : now + lifeMs;
    this.entries.set(id, entry);
    this.publish();
  }

  /** Keeps the card's place, arrival time and fold. */
  private put(id: string, record: Record_, card: Json, title: string, lifeMs: number | null = null): void {
    const until = lifeMs === null ? null : this.clock() + lifeMs;
    const e = this.entries.get(id);
    if (e) Object.assign(e, { record, card, title, until });
    else {
      const entry = this.entry(record, card, this.clock(), title, 'native', id);
      entry.until = until;
      this.entries.set(id, entry);
      this.order.push(id);
    }
    this.publish();
  }

  /** Gone without a history row. */
  private drop(id: string): void {
    this.entries.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.publish();
  }

  decideTestApproval(id: string, verdict: string): void {
    const e = this.entries.get(id);
    if (e) e.until = this.clock() + LINGER_MS;
    this.settle(id, verdict === 'allow' ? 'approved' : 'denied', verdict === 'allow' ? '测试已批准' : '测试已拒绝');
  }

  /** This panel's decision went through: the card shows `receipt` and goes to history once agentd drops it. */
  settle(id: string, outcome: string | null, receipt: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.decided = true;
    e.receipt = receipt;
    if (outcome !== null && isApproval(e.record)) e.outcome = { kind: outcome, at: this.clock(), text: receipt };
    this.publish();
  }

  /** agentd no longer has this version (404/409): the card shows 已在别处处理 for a moment. */
  markElsewhere(id: string): void {
    if (!this.entries.has(id)) return;
    this.vanish(id, this.clock(), true);
    this.publish();
  }

  /** agentd says the role approval lapsed (400 `approval_expired`): the card shows 已过期 for a moment. */
  markExpired(id: string): void {
    if (!this.entries.has(id)) return;
    this.vanish(id, this.clock(), true, true);
    this.publish();
  }

  /** An error, notice, voice hint or delivery card leaves for history; any other card folds into the page's queue bar, kept
   *  across reads and updates. A reminder only folds: agentd lists it until it is snoozed or done. */
  collapse(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    if (e.record.kind === 'notice' || e.record.kind === 'delivery' || e.record.kind === 'voiceHint') this.toHistory(id, this.clock(), null);
    else e.collapsed = true;
    this.publish();
    return true;
  }

  /** The card leaves for history now, under `title` when given. */
  retire(id: string, title: string | null = null): void {
    this.toHistory(id, this.clock(), title);
    this.publish();
  }

  /** `lapsed` says agentd reported the deadline passed, whatever the local clock says. */
  private vanish(id: string, now: number, forced: boolean, lapsed = false): void {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.decided && !forced) return this.toHistory(id, now, null);
    const r = e.record;
    if (r.kind === 'approval') {
      const deadline = r.fetchedAt + ms(r.approval.seconds_left);
      e.outcome = !forced && deadline <= now ? { kind: 'expired', at: now, text: null } : { kind: 'elsewhere', at: now, text: ELSEWHERE };
      e.receipt = null;
    } else if (r.kind === 'question') {
      const expires = r.question.expires_at ?? 0;
      const expired = lapsed || (!forced && expires > 0 && ms(expires) <= now);
      e.receipt = expired ? EXPIRED : ELSEWHERE;
      if (r.question.kind === 'approval') {
        e.outcome = expired ? { kind: 'expired', at: now, text: null } : { kind: 'elsewhere', at: now, text: ELSEWHERE };
      }
    } else if (r.kind === 'review' || r.kind === 'codingReview') {
      e.receipt = ELSEWHERE;
    } else return this.toHistory(id, now, null);
    e.live = false;
    e.decided = false;
    e.until = now + LINGER_MS;
  }

  private toHistory(id: string, now: number, title: string | null): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (e.record.kind === 'delivery') this.retired.add(e.record.delivery.delivery_id);
    const shown = title ?? (e.decided ? e.receipt : null) ?? e.title;
    this.history.unshift({ id: `h-${id}-${now}`, at: now, title: shown, card: this.render(e) });
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
  }

  /** Moves cards whose time is up to history, lets questions past their deadline go (an approval that lapses while its asker
   *  waits sends no event), and pushes when anything changed. */
  sweep(): void {
    const now = this.clock();
    for (const id of [...this.order]) {
      const e = this.entries.get(id);
      if (!e) continue;
      if (e.until !== null && e.until <= now) this.toHistory(id, now, null);
      else if (e.live && e.record.kind === 'question') {
        const expires = e.record.question.expires_at ?? 0;
        if (expires > 0 && ms(expires) <= now) this.vanish(id, now, false);
      }
    }
    this.publish();
  }

  snapshot(): { now: number; cards: Json[]; history: Json[] } {
    return { now: this.clock(), cards: this.order.flatMap((id) => { const e = this.entries.get(id); return e ? [this.render(e)] : []; }),
      history: this.history };
  }

  private render(e: Entry): Json {
    const card: Json = { ...e.card, at: e.at };
    if (e.collapsed) card.collapsed = true;
    if (e.receipt !== null) card.receipt = e.receipt;
    if (e.outcome) card.outcome = e.outcome.text === null ? { kind: e.outcome.kind, at: e.outcome.at } : { ...e.outcome };
    return card;
  }

  private publish(): void {
    this.updateCount();
    const { cards, history } = this.snapshot();
    const body = JSON.stringify({ cards, history });
    if (this.offline || (this.loaded && body === this.lastBody)) return;
    this.loaded = true;
    this.lastBody = body;
    const event = this.cardsEvent();
    for (const s of this.subscribers.values()) s(event);
    this.onPush(this.order.filter((id) => { const e = this.entries.get(id); return !!e && !isChatCard(e.card); }));
  }

  /** An approval, question, review or delivery card still waiting for the user: C3 rule 39 shows it with her snap. */
  presents(id: string): boolean {
    const e = this.entries.get(id);
    return !!e && e.live && !e.decided && (waits(e.record) || e.record.kind === 'delivery');
  }

  private updateCount(): void {
    const count = [...this.entries.values()].filter((e) => e.live && !e.decided && waits(e.record)).length;
    if (count === this.pendingCount) return;
    this.pendingCount = count;
    this.onCount(count);
  }

  private cardsEvent(): StreamEvent {
    return { event: 'stack.cards', id: null, data: JSON.stringify(this.snapshot()) };
  }

  private errorEvent(): StreamEvent {
    return { event: 'stack.cards', id: null, data: '{"error":{"code":"offline","detail":"后台已断开"}}' };
  }
}

const GESTURE_MS = 1_500;
const CONFIRM_MS = 1_000;

/** `stack.decide`, `later`, `collapse` and `complete`. Each request is built from the record of the card
 *  the source last pushed under that id, and only for the generation or revision it showed; the page's own strings never
 *  reach a path. */
export class StackDecisions {
  private readonly inFlight = new Set<string>();
  private readonly source: StackSource;
  private readonly request: Request;
  private readonly confirm: (text: string) => Promise<boolean>;
  private readonly lastRegionClick: () => number | null;
  private readonly clock: () => number;

  /** `lastRegionClick` is the last mouse down (epoch ms) the panel saw inside an interactive region; `confirm` is the native
   *  dialog asked when there was none. */
  constructor(source: StackSource, request: Request, confirm: (text: string) => Promise<boolean>, lastRegionClick: () => number | null,
    clock: () => number = Date.now) {
    this.source = source;
    this.request = request;
    this.confirm = confirm;
    this.lastRegionClick = lastRegionClick;
    this.clock = clock;
  }

  /** `decision` is protocol.ts `StackDecision` as the page sent it, with `confirmed` from its `DecideOptions`. */
  async decide(id: string, decision: unknown): Promise<void> {
    const d = decision as Json | null;
    if (!d || typeof d !== 'object' || typeof d.kind !== 'string') throw invalid('a StackDecision');
    const entry = this.source.entryOf(id);
    if (!entry) throw invalid(`no card ${id}`);
    if (!entry.live) throw new BridgeFailure('stale', 'card_gone');
    // A second try would get agentd's 409 and cover this panel's receipt with 已在别处处理.
    if (entry.decided) throw new BridgeFailure('busy', 'decided');
    if (this.inFlight.has(id)) throw new BridgeFailure('busy', id);
    this.inFlight.add(id);
    try {
      const r = entry.record, kind = d.kind;
      if (kind === 'approval' && r.kind === 'approval') await this.approve(id, r.approval, entry.part, d);
      else if (kind === 'answer' && r.kind === 'question') await this.answer(id, r.question, d);
      else if (kind === 'cancel-question' && r.kind === 'question') {
        const expected = d.expected_version;
        if (!Number.isInteger(expected)) throw invalid('expected_version');
        if (expected !== r.question.revision) throw new BridgeFailure('stale', 'interaction_version_changed');
        await this.post(id, `/agent/interactions/${seg(r.question.request_id)}/dismiss`, { expected_version: expected });
        this.source.settle(id, null, '已取消这个请求');
        this.source.requestRefresh();
      } else if ((kind === 'accept' || kind === 'reject') && r.kind === 'review') await this.review(id, r.row, r.delivery, kind === 'accept', d);
      else if ((kind === 'accept' || kind === 'reject') && r.kind === 'codingReview') {
        // The ledger routes take no body. A note has nowhere to go: agentd's `/tasks/:id/continue` takes character tasks only.
        if (d.task_id !== `task:${r.task.task_id}`) throw invalid('not this card\'s task');
        await this.post(id, `/tasks/${seg(r.task.task_id)}/${kind}`, undefined);
        await this.settleReview(id, kind === 'accept', d.note, () => null);
      } else throw invalid(`${kind} does not fit card ${id}`);
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async approve(id: string, a: Approval, part: Part, d: Json): Promise<void> {
    const verdict = d.verdict, generation = d.generation;
    if (typeof verdict !== 'string' || !['allow', 'allow_session', 'deny'].includes(verdict) || !a.options.includes(verdict)
      || !Number.isInteger(generation)) throw invalid('verdict and generation');
    const dispatch = a.kind === 'dispatch';
    if (verdict === 'allow_session' && (a.dangerous || dispatch)) throw invalid('allow_session on a dangerous or dispatch card');
    const mode = d.mode;
    if (mode !== undefined && mode !== null) {
      if (typeof mode !== 'string' || !dispatch) throw invalid('mode on a dispatch card only');
      const modes = a.dispatch?.modes ?? [];
      if (modes.length > 0 && !modes.includes(mode)) throw invalid(`mode ${mode}`);
    }
    if (generation !== a.generation) throw new BridgeFailure('stale', 'generation_changed');
    if (id === TEST_APPROVAL_ID && part === 'native') return this.source.decideTestApproval(id, verdict);
    if (verdict === 'allow' && a.dangerous) {
      await this.gesture(`批准这条危险操作？\n\n${a.tool_summary ?? titleOf(a)}`, d.confirmed === true);
    } else if (verdict !== 'deny' && dispatch && ((mode as string | undefined) ?? a.dispatch?.mode) === 'workspace_write') {
      await this.gesture(`允许这个任务改写工作区里的文件？\n\n${a.dispatch?.prompt ?? ''}`, false);
    }
    const body: Json = { decision: verdict, generation: a.generation };
    if (typeof mode === 'string') body.mode = mode;
    await this.post(id, `/approvals/${seg(a.request_id)}/decision`, body);
    const receipt = verdict === 'deny' ? '已拒绝' : verdict === 'allow_session' ? '已批准（本会话同类操作）' : '已批准';
    this.source.settle(id, verdict === 'deny' ? 'denied' : 'approved', receipt);
  }

  /** A recent click in a region is the user's gesture, anything else asks natively. A `confirmed` decision counts only a
   *  click within `CONFIRM_MS` and never asks natively. */
  private async gesture(message: string, confirmed: boolean): Promise<void> {
    const click = this.lastRegionClick();
    if (click !== null) {
      const age = this.clock() - click;
      if (age >= 0 && age <= (confirmed ? CONFIRM_MS : GESTURE_MS)) return;
    }
    if (confirmed) throw new BridgeFailure('declined', 'no click within the confirm window');
    if (!(await this.confirm(message))) throw new BridgeFailure('declined', 'native confirmation');
  }

  private async answer(id: string, q: Interaction, d: Json): Promise<void> {
    const expected = d.expected_version, raw = d.answers;
    if (!Number.isInteger(expected) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('expected_version and answers');
    const answers: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(raw)) {
      // agentd's limits: 1–8 strings per question, each 1–4000 characters after trimming.
      if (!Array.isArray(value) || value.length < 1 || value.length > 8
        || !value.every((s) => typeof s === 'string' && [...s.trim()].length >= 1 && [...s.trim()].length <= 4000)) {
        throw invalid(`answers for ${key}`);
      }
      answers[key] = value as string[];
    }
    const ids = questionsOf(q).map((x) => x.id);
    const keys = Object.keys(answers);
    if (keys.length !== new Set(ids).size || !keys.every((k) => ids.includes(k))) throw invalid('one answer per question');
    const approval = q.kind === 'approval';
    const only = (list: string[], word: string) => list.length === 1 && list[0] === word;
    if (approval && !Object.values(answers).every((a) => only(a, '允许') || only(a, '拒绝'))) throw invalid('允许 or 拒绝');
    if (expected !== q.revision) throw new BridgeFailure('stale', 'interaction_version_changed');
    const refused = Object.values(answers).some((a) => only(a, '拒绝'));
    if (approval && !refused && q.data?.dangerous === true) {
      await this.gesture(`批准这条危险操作？\n\n${q.data.preview_text ?? questionsOf(q)[0]?.question ?? ''}`, d.confirmed === true);
    }
    const reply = await this.post(id, `/agent/interactions/${seg(q.request_id)}/answer`, { expected_version: expected, answers });
    const receipt = !approval ? '已回答' : refused ? '已拒绝' : '已允许';
    this.source.settle(id, approval ? (refused ? 'denied' : 'approved') : null, receipt);
    this.source.requestRefresh();
    if (parse<Json>(reply)?.resume_required === true) {
      const job = q.data?.job_id;
      this.source.addNotice(`resume-${q.request_id}`, 'resume', '回答已保存 · 在主窗口继续', { task_id: job != null ? `job:${job}` : null }, 60_000);
    }
  }

  private async review(id: string, row: TaskRow, delivery: Delivery, accept: boolean, d: Json): Promise<void> {
    const task = d.task_id, deliveryId = d.delivery_id, revision = d.expected_revision, generation = d.generation;
    if (typeof task !== 'string' || typeof deliveryId !== 'string' || !Number.isInteger(revision) || !Number.isInteger(generation)) {
      throw invalid('task_id, delivery_id, expected_revision and generation');
    }
    if (task !== row.canonical_task_id || deliveryId !== delivery.delivery_id) throw invalid('not this card\'s delivery');
    if (revision !== delivery.revision || generation !== delivery.generation) throw new BridgeFailure('stale', 'delivery_version_changed');
    await this.post(id, `/agent/tasks/${seg(row.canonical_task_id)}/${accept ? 'accept' : 'reject'}`,
      { expected_revision: revision, generation, delivery_id: deliveryId });
    await this.settleReview(id, accept, d.note, (note) => {
      // Copied from the 问题与任务 page's resume: a job resumes with the note, a ledger task continues with it.
      if (row.job_id != null) return { path: `/agent/jobs/${seg(row.job_id)}/resume`, body: { text: note, use_current_backend: false } };
      if (row.task_id != null) return { path: `/tasks/${seg(row.task_id)}/continue`, body: { text: note } };
      return null;
    });
  }

  /** `follow` names the route the trimmed note goes to after a reject; null when the task has none. */
  private async settleReview(id: string, accept: boolean, note: unknown, follow: (note: string) => { path: string; body: Json } | null):
    Promise<void> {
    const text = (typeof note === 'string' ? note : '').trim();
    if (accept) return this.source.settle(id, null, '已接受这一版');
    this.source.settle(id, null, text === '' ? '已退回' : `已退回：${text}`);
    if (text === '') return;
    const target = follow(text);
    if (target === null) throw new BridgeFailure('partial', 'no_target');
    let reply: { status: number; body: string };
    try {
      reply = await this.request('POST', target.path, target.body);
    } catch {
      throw new BridgeFailure('partial', 'offline');
    }
    if (reply.status < 200 || reply.status >= 300) throw new BridgeFailure('partial', agentdError(reply.status, parse<unknown>(reply.body)).code);
  }

  /** 延后: a due reminder snoozes `minutes` (agentd takes 10 or 60; none is 10); any other card only folds away. */
  async later(id: string, minutes: unknown): Promise<void> {
    const m = minutes ?? 10;
    if (m !== 10 && m !== 60) throw invalid('minutes 10 or 60');
    const entry = this.source.entryOf(id);
    if (!entry) throw invalid(`no card ${id}`);
    if (entry.record.kind !== 'reminder') return this.collapse(id);
    if (this.inFlight.has(id)) throw new BridgeFailure('busy', id);
    this.inFlight.add(id);
    try {
      await this.post(id, `/commitments/${seg(entry.record.commitment.id)}/snooze`, { minutes: m });
      this.source.retire(id, m === 60 ? '提醒 · 延后 1 小时' : '提醒 · 延后 10 分钟');
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** An error, notice or delivery card moves to history; any other card folds, and a reminder stays due in agentd. */
  collapse(id: string): void {
    if (!this.source.collapse(id)) throw invalid(`no card ${id}`);
  }

  /** A due reminder's 完成: agentd completes it, then it leaves for history; it stays if agentd did not. */
  async complete(id: string): Promise<void> {
    const r = this.source.entryOf(id)?.record;
    if (r?.kind !== 'reminder') throw invalid(`no reminder ${id}`);
    if (this.inFlight.has(id)) throw new BridgeFailure('busy', id);
    this.inFlight.add(id);
    try {
      await this.post(id, `/commitments/${seg(r.commitment.id)}/complete`, {});
      this.source.retire(id, '提醒 · 已完成');
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** 404 and 409 mean agentd no longer has this version: the card shows 已在别处处理. */
  private async post(id: string, path: string, body: Json | undefined): Promise<string> {
    let reply: { status: number; body: string };
    try {
      reply = await this.request('POST', path, body);
    } catch (e) {
      throw new BridgeFailure('offline', e instanceof Error ? e.message : String(e));
    }
    if (reply.status >= 200 && reply.status < 300) return reply.body;
    const code = agentdError(reply.status, parse<unknown>(reply.body)).code;
    if (reply.status === 404 || reply.status === 409) {
      this.source.markElsewhere(id);
      throw new BridgeFailure('stale', code);
    }
    // agentd answers a lapsed role approval with 400, not 409.
    if (reply.status === 400 && code === 'approval_expired') {
      this.source.markExpired(id);
      throw new BridgeFailure('stale', code);
    }
    throw new BridgeFailure('failed', code);
  }
}

function seg(value: string): string {
  const s = segment(value);
  if (s === null) throw invalid('an id no route can name');
  return s;
}

const invalid = (detail: string) => new BridgeFailure('invalid_args', detail);
