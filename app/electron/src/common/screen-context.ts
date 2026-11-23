// The screen context capture's rules over the platform helper's answers (CONTRACT §7.2, §7.4–7.6, §7.10), and the bodies of agentd's `/context/text`, `/context/image` and `/look`.
// The privacy rules are attention.ts's and capture-rules.ts's; this file only applies them.
import { type AttentionSample, type BlacklistRules, decodeRect, mayBePrivate, type RawWindow, type Rect, redactText } from './attention.ts';
import { type CaptureWindow, captureBlockReason, isSecureNode } from './capture-rules.ts';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/** Counted in Unicode scalars, as agentd counts. */
export const scalarCount = (s: string): number => [...s].length;
const prefix = (s: string, n: number) => [...s].slice(0, n).join('');
const blank = (s: string) => s.trim() === '';

// ---- Consent

export type ScreenContextLevel = 'status' | 'focused' | 'window';

/** Separate consent for text and pixels. A narrower AX policy never silently expands to OCR. */
export interface ContextPolicy { allowText: boolean; allowImages: boolean; level: ScreenContextLevel; redact: boolean }

/** The policy used when config.json can't be read. */
export const DEFAULT_CONTEXT_POLICY: ContextPolicy = { allowText: false, allowImages: false, level: 'focused', redact: true };

/** config.json's `share_window_text`, `share_screenshots`, `screen_context_level` (unknown is `focused`), `redact_sensitive`. */
export function contextPolicy(s: Record<string, unknown>): ContextPolicy {
  const level = s.screen_context_level;
  return {
    allowText: s.share_window_text === true, allowImages: s.share_screenshots === true,
    level: level === 'status' || level === 'window' ? level : 'focused',
    redact: typeof s.redact_sensitive === 'boolean' ? s.redact_sensitive : true,
  };
}

export function allowsAutomaticText(p: ContextPolicy, axTrusted: boolean): boolean {
  return p.allowText && p.level !== 'status' && axTrusted;
}

export function allowsOCR(p: ContextPolicy): boolean {
  return p.allowText && p.allowImages && p.level === 'window';
}

/** A feed request's `mode`: `text`, `ocr` or `image`; anything else is refused. */
export function allowsRequest(p: ContextPolicy, mode: string): boolean {
  switch (mode) {
    case 'text': return p.allowText && p.level !== 'status';
    case 'ocr': return allowsOCR(p);
    case 'image': return p.allowImages;
    default: return false;
  }
}

/** A shared epoch: a read started under an older generation is dropped even if consent came back before it returned. */
export class ContextConsent {
  policy: ContextPolicy;
  generation = 0;

  constructor(policy: ContextPolicy) {
    this.policy = policy;
  }

  /** False when `next` is the policy already in force. */
  configure(next: ContextPolicy): boolean {
    const p = this.policy;
    if (p.allowText === next.allowText && p.allowImages === next.allowImages && p.level === next.level && p.redact === next.redact) return false;
    this.policy = next;
    this.generation += 1;
    return true;
  }

  invalidate(): void {
    this.generation += 1;
  }
}

/** ContextCapturer.configure: what agentd's `POST /context/privacy/sync` discards when consent narrows. */
export function revokedKinds(old: ContextPolicy, next: ContextPolicy): string[] {
  const out: string[] = [];
  if (old.allowText && (!next.allowText || (old.level === 'window' && next.level !== 'window'))) out.push('window_text');
  if (old.allowImages && !next.allowImages) out.push('screenshots');
  return out;
}

// ---- Automatic reads

/** agentd's presence values of an absence (observation/user_now.py ABSENT). */
const ABSENT = ['asleep', 'locked', 'away'];
const BACKOFF = [5, 10, 20, 30];
const NOTIFICATION_DELAY = 2;

/** When to read the front window's AX text; fed once per tick, times in seconds. Without an app, window or focus change,
 *  re-reads come after 5, 10, 20, then every 30 s, back to 5 s on a change. AX notifications ask for one read, at least
 *  2 s after the first unanswered one and 5 s after the last read. `user` is agentd's last `/user/coarse` answer: no
 *  reads while it calls the user away, and one when its absence ends. */
export class CaptureTriggers {
  private started = false;
  private windowId: number | null = null;
  private app: string | null = null;
  private focus: string | null = null;
  private absent = false;
  private lastRead = -Infinity;
  private step = 0;
  private notifiedAt: number | null = null;

  update(now: number, frontWindowId: number | null, frontApp: string | null, focusedElement: string | null,
    user: { presence: string; absence: unknown }): boolean {
    const nowAway = ABSENT.includes(user.presence);
    const returned = this.absent && user.absence === null;
    const changed = !this.started || frontApp !== this.app || frontWindowId !== this.windowId || focusedElement !== this.focus || returned;
    this.started = true;
    this.windowId = frontWindowId;
    this.app = frontApp;
    this.focus = focusedElement;
    this.absent = user.absence !== null;
    if (changed) {
      this.lastRead = now;
      this.step = 0;
      this.notifiedAt = null;
      return true;
    }
    if (!nowAway && this.notifiedAt !== null && now - this.notifiedAt >= NOTIFICATION_DELAY && now - this.lastRead >= BACKOFF[0]!) {
      this.lastRead = now;
      this.step = 0;
      this.notifiedAt = null;
      return true;
    }
    if (!nowAway && now - this.lastRead >= BACKOFF[this.step]!) {
      this.lastRead = now;
      this.step = Math.min(this.step + 1, BACKOFF.length - 1);
      this.notifiedAt = null;
      return true;
    }
    return false;
  }

  /** A re-read found new content. */
  contentChanged(): void {
    this.step = 0;
  }

  /** The front app posted a value, title or focus change. */
  axNotified(now: number): void {
    if (this.notifiedAt === null) this.notifiedAt = now;
  }
}

/** Incognito state and URL host per window id, learned from front-window samples, because only the front window's can be read. */
export class BrowserWindowMemory {
  private readonly seen = new Map<number, { incognito: boolean | null; urlHost: string | null }>();

  record(windowId: number, incognito: boolean | null, urlHost: string | null): void {
    // Window ids only grow; forgetting all of them errs towards blocking.
    if (this.seen.size >= 1000) this.seen.clear();
    this.seen.set(windowId, { incognito, urlHost });
  }

  /** A browser window never seen in front reads as unknown, which blocks it. */
  lookup(windowId: number, bundleId: string | null): { incognito: boolean | null; urlHost: string | null } {
    return this.seen.get(windowId) ?? { incognito: mayBePrivate(bundleId) ? null : false, urlHost: null };
  }
}

// ---- The window a request names

/** `windows.list`'s windows (CONTRACT §7.12 `window`), front to back; malformed entries are skipped. */
export function decodeWindows(result: Obj): RawWindow[] {
  const list = Array.isArray(result.windows) ? result.windows : [];
  const out: RawWindow[] = [];
  for (const v of list) {
    const o = obj(v);
    const bounds = o && decodeRect(o.bounds);
    const windowId = o && int(o.window_id), pid = o && int(o.pid);
    if (!o || !bounds || windowId === null || pid === null) continue;
    out.push({ windowId, pid, bounds, title: str(o.title), appName: str(o.app_name), appId: str(o.app_id) });
  }
  return out;
}

/** ContextCapturer.captureWindowNow: the listed window `windowId` with the browser state the front sample gives, or the
 *  one last seen for it; null when it is not on screen. `bounds` is CG global, as `ax.window_text`'s `window_bounds`. */
export function windowNow(windows: readonly RawWindow[], windowId: number, sample: AttentionSample | null,
  memory: BrowserWindowMemory, secureInput: boolean): { window: CaptureWindow; bounds: Rect } | null {
  const w = windows.find((x) => x.windowId === windowId);
  if (!w) return null;
  const isFront = sample?.front?.windowId === windowId;
  const remembered = memory.lookup(windowId, w.appId);
  return {
    window: {
      window: { app: w.appName, bundleId: w.appId, pid: w.pid, windowId, title: w.title,
        urlHost: isFront ? sample?.front?.urlHost ?? null : remembered.urlHost },
      incognito: isFront ? sample?.frontIncognito ?? null : remembered.incognito,
      secureInput,
    },
    bounds: w.bounds,
  };
}

/** A window known only by the id agentd named, for a failure report. */
export function namedWindow(windowId: number): CaptureWindow {
  return { window: { app: null, bundleId: null, pid: null, windowId, title: null, urlHost: null }, incognito: null, secureInput: false };
}

/** The sample's front window as a capture target; null without one. */
export function frontWindow(sample: AttentionSample): CaptureWindow | null {
  return sample.front ? { window: sample.front, incognito: sample.frontIncognito, secureInput: sample.secureInput } : null;
}

/** The `error` agentd's `/context/image` accepts in place of an image. */
export type CaptureFailure = 'capture_failed' | 'permission_denied' | 'window_gone' | 'ax_unavailable' | 'ax_empty';

/** Why content captured from `pinned` must not be sent now that the window reads as `now`; null when unchanged. */
export function captureTargetChange(pinned: CaptureWindow, now: CaptureWindow | null, rules: BlacklistRules,
  ownPids: readonly number[]): CaptureFailure | null {
  if (!now || now.window.windowId !== pinned.window.windowId || now.window.pid !== pinned.window.pid) return 'window_gone';
  if (captureBlockReason(now, rules, ownPids) !== null) return 'permission_denied';
  if (now.incognito !== pinned.incognito) return 'permission_denied';
  // Another page in the same window.
  if (now.window.urlHost !== pinned.window.urlHost) return 'capture_failed';
  return null;
}

/** A `capture.window` error code as agentd's failure. */
export function captureFailure(code: string): CaptureFailure {
  return code === 'permission_denied' || code === 'window_gone' ? code : 'capture_failed';
}

/** For a `look_window` text request: `ax`, or the failure to report. Never OCR: agentd asks for an
 *  image itself when AX can't read the window. `block` is captureBlockReason's result. */
export function windowReadPlan(windowFound: boolean, allowsText: boolean, block: string | null, axTrusted: boolean): 'ax' | CaptureFailure {
  if (!windowFound) return 'window_gone';
  if (!allowsText || block !== null) return 'permission_denied';
  if (!axTrusted) return 'ax_unavailable';
  return 'ax';
}

// ---- Feed requests

/** `event: request` on `GET /feed`: agentd asks for the text, OCR text or screenshot of a window. */
export interface FeedRequest { seq: number; requestId: string; windowId: number; mode: string; reason: string }

/** Null for another event or a body without every field. */
export function feedRequest(e: { event: string; data: string }): FeedRequest | null {
  if (e.event !== 'request') return null;
  let o: Obj | null;
  try {
    o = obj(JSON.parse(e.data));
  } catch {
    return null;
  }
  if (!o) return null;
  const seq = int(o.seq), windowId = int(o.window_id), requestId = str(o.request_id), mode = str(o.mode), reason = str(o.reason);
  if (seq === null || windowId === null || requestId === null || mode === null || reason === null) return null;
  return { seq, requestId, windowId, mode, reason };
}

// ---- Observations

/** `bounds` is `[x, y, width, height]`. */
export interface ObservationNode {
  id: number; parent: number; role: string; label: string | null; value: string | null; selection: string | null; bounds: number[] | null;
}

/** What was actually read, not what a transport page fits. */
export interface ObservationCoverage {
  status: string; scope: string; reasons: string[]; capturedNodes: number; capturedChars: number; nextCursor: string | null;
}

export interface Observation { snapshotId: string; text: string; nodes: ObservationNode[]; coverage: ObservationCoverage }

const rectArray = (r: Rect | null) => (r === null ? null : [r.x, r.y, r.width, r.height]);

/** An `ax.window_text` answer: the text and the node texts redacted when `redact`, password-like
 *  nodes (and what hangs under them) left out, the counts taken after both. */
export function axObservation(result: Obj, redact: boolean): { matched: boolean; observation: Observation } {
  const safe = (v: string | null) => (v !== null && redact ? redactText(v) : v);
  const dropped = new Set<number>();
  const nodes: ObservationNode[] = [];
  for (const v of Array.isArray(result.nodes) ? result.nodes : []) {
    const o = obj(v);
    const id = o && int(o.id), parent = o && int(o.parent), role = o && str(o.role);
    if (!o || id === null || parent === null || role === null) continue;
    const label = str(o.label);
    if (dropped.has(parent) || isSecureNode(role, null, label)) {
      dropped.add(id);
      continue;
    }
    nodes.push({ id, parent, role, label: safe(label), value: safe(str(o.value)), selection: safe(str(o.selection)),
      bounds: rectArray(decodeRect(o.bounds)) });
  }
  const text = safe(str(result.text) ?? '') ?? '';
  const c = obj(result.coverage);
  return {
    matched: result.matched === true,
    observation: {
      snapshotId: str(result.snapshot_id) ?? '', text, nodes,
      coverage: {
        status: str(c?.status) ?? 'partial', scope: str(c?.scope) ?? '',
        reasons: Array.isArray(c?.reasons) ? c.reasons.filter((r): r is string => typeof r === 'string') : [],
        capturedNodes: nodes.length, capturedChars: scalarCount(text), nextCursor: str(c?.next_cursor),
      },
    },
  };
}

/** An `ocr.recognize` answer. The helper's line boxes are normalized with the
 *  origin at the top left; agentd reads them with the origin at the bottom left (CONTRACT §7.6). The text is not redacted
 *  here. */
export function ocrObservation(result: Obj, snapshotId: string): Observation {
  const nodes: ObservationNode[] = [];
  for (const v of Array.isArray(result.lines) ? result.lines : []) {
    const o = obj(v);
    const text = o && str(o.text), b = o && decodeRect(o.bounds);
    if (text === null) continue;
    nodes.push({ id: nodes.length, parent: -1, role: 'OCRText', label: null, value: text, selection: null,
      bounds: b === null ? null : [b.x, 1 - b.y - b.height, b.width, b.height] });
  }
  const text = str(result.text) ?? '';
  return {
    snapshotId, text, nodes,
    coverage: { status: 'partial', scope: 'window_image_ocr_normalized_bottom_left', reasons: ['ocr_can_miss_visual_content'],
      capturedNodes: nodes.length, capturedChars: scalarCount(text), nextCursor: null },
  };
}

/** observationTextPages: transport pages keep every Unicode scalar; an empty text is one empty page. */
export function textPages(text: string, pageScalars = 64_000): string[] {
  const all = [...text];
  const pages: string[] = [];
  for (let i = 0; i < all.length; i += pageScalars) pages.push(all.slice(i, i + pageScalars).join(''));
  return pages.length === 0 ? [''] : pages;
}

// ---- Bodies

export const TITLE_MAX = 512;

/** JSONEncoder leaves nil optionals out. */
function nodeJson(n: ObservationNode): Obj {
  const out: Obj = { id: n.id, parent: n.parent, role: n.role };
  if (n.label !== null) out.label = n.label;
  if (n.value !== null) out.value = n.value;
  if (n.selection !== null) out.selection = n.selection;
  if (n.bounds !== null) out.bounds = n.bounds;
  return out;
}

function coverageJson(c: ObservationCoverage): Obj {
  const out: Obj = { status: c.status, scope: c.scope, reasons: c.reasons, captured_nodes: c.capturedNodes, captured_chars: c.capturedChars };
  if (c.nextCursor !== null) out.next_cursor = c.nextCursor;
  return out;
}

/** The pages of `POST /context/text`, and the signature an automatic read is deduplicated by; null
 *  when the window has no id or is blocked. The text and title are redacted when `redact`, the title cut to 512 scalars. */
export function contextTextBodies(w: CaptureWindow, text: string, source: 'ax' | 'ocr', requestId: string | null,
  observation: Observation, redact: boolean, rules: BlacklistRules, ownPids: readonly number[]): { bodies: Obj[]; signature: string } | null {
  const windowId = w.window.windowId;
  if (windowId === null || captureBlockReason(w, rules, ownPids) !== null) return null;
  const safeText = redact ? redactText(text) : text;
  const title = w.window.title === null ? null : prefix(redact ? redactText(w.window.title) : w.window.title, TITLE_MAX);
  // The nodes' structure only: a frame whose bounds alone moved is not sent again.
  const signature = `${title ?? ''}\u0000${safeText}\u0000${observation.nodes.length}\u0000${observation.nodes.map((n) => n.role).join('\u0001')}`;
  const pages = textPages(safeText);
  const bodies = pages.map((page, index) => {
    const body: Obj = {
      window_id: windowId, app: w.window.app ?? '', bundle_id: w.window.bundleId, title, text: page, source,
      secure_input: w.secureInput, incognito: w.incognito ?? true, url_host: w.window.urlHost,
      request_id: index === 0 ? requestId : null,
      coverage: coverageJson(observation.coverage), nodes: observation.nodes.map(nodeJson), snapshot_id: observation.snapshotId,
      snapshot_page: index, snapshot_pages: pages.length,
    };
    if (w.window.pid !== null) body.pid = w.window.pid;
    return body;
  });
  return { bodies, signature };
}

/** `POST /context/image` with the JPEG; null when the window has no id or is blocked. */
export function contextImageBody(w: CaptureWindow, requestId: string, jpegBase64: string, rules: BlacklistRules,
  ownPids: readonly number[]): Obj | null {
  if (w.window.windowId === null || captureBlockReason(w, rules, ownPids) !== null) return null;
  return { request_id: requestId, window_id: w.window.windowId, url_host: w.window.urlHost, jpeg_base64: jpegBase64 };
}

/** `POST /context/image` in place of an image. It carries no window content, so the blacklist doesn't hold it back;
 *  `url_host` is always null, as the report may be for a window held back for its domain. */
export function imageFailureBody(w: CaptureWindow, requestId: string, failure: CaptureFailure): Obj | null {
  if (w.window.windowId === null) return null;
  return { request_id: requestId, window_id: w.window.windowId, url_host: null, error: failure };
}

/** An agentd answer; `status` 0 when agentd could not be reached. */
export interface AgentdReply { status: number; body: Obj | null }

export type ContextResult =
  | { kind: 'accepted' } | { kind: 'blocked'; reason: string } | { kind: 'rejected'; status: number; error: string } | { kind: 'failed' };

export type LookResult =
  | { kind: 'requested'; requestId: string } | { kind: 'blocked'; reason: string } | { kind: 'rejected'; status: number; error: string }
  | { kind: 'failed' };

const rejected = (r: AgentdReply) => ({ kind: 'rejected' as const, status: r.status, error: str(r.body?.error) ?? '' });

/** `/context/text`: 202 with `accepted`. */
export function textResult(r: AgentdReply): ContextResult {
  if (r.status === 0) return { kind: 'failed' };
  const accepted = r.body?.accepted;
  if (r.status === 202 && typeof accepted === 'boolean') return accepted ? { kind: 'accepted' } : { kind: 'blocked', reason: str(r.body?.reason) ?? '' };
  return rejected(r);
}

/** `/context/image`: an image is accepted with 202, a failure report with 200. */
export function imageResult(r: AgentdReply, okStatus: 200 | 202): ContextResult {
  if (r.status === 0) return { kind: 'failed' };
  if (r.status === okStatus) return { kind: 'accepted' };
  if (r.status === 409 && r.body?.error === 'blocked') return { kind: 'blocked', reason: str(r.body?.reason) ?? '' };
  return rejected(r);
}

/** `/look`: 202 with the request id agentd will send on the feed. */
export function lookResult(r: AgentdReply): LookResult {
  if (r.status === 0) return { kind: 'failed' };
  const requestId = str(r.body?.request_id);
  if (r.status === 202 && requestId !== null) return { kind: 'requested', requestId };
  if (r.status === 409 && r.body?.error === 'blocked') return { kind: 'blocked', reason: str(r.body?.reason) ?? '' };
  return rejected(r);
}

/** For the log: metadata only. */
export function resultText(r: ContextResult | LookResult | null): string {
  if (r === null) return 'skipped';
  switch (r.kind) {
    case 'blocked': return `blocked(${r.reason})`;
    case 'rejected': return `rejected(${r.status}, ${r.error})`;
    case 'requested': return `requested(${r.requestId})`;
    default: return r.kind;
  }
}

/** ContextCapturer.lookNow: the front window's title, else its app; null when unknown. */
export function lookTitle(sample: AttentionSample | null): string | null {
  const f = sample?.front;
  return [f?.title, f?.app].find((s): s is string => typeof s === 'string' && s !== '') ?? null;
}

// ---- Selection

/** agentd's `POST /say` limit (`MAX_SAY`), counted in Unicode scalars. */
export const SAY_LIMIT = 2000;
/** 100 scalars under `SAY_LIMIT` leave room for a quick input action's instruction or prefix. */
export const SELECTION_LIMIT = SAY_LIMIT - 100;
/** nspasteboard.org markers of a password or a one-off item. */
const SKIPPED_TYPES = ['org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType'];

export interface SelectionRead { source: 'selection' | 'clipboard'; text: string; truncated: boolean }

/** `refused` says why nothing was read; `empty`: no selected text and no usable clipboard text. */
export type SelectionDecision = { kind: 'read'; read: SelectionRead } | { kind: 'refused'; message: string } | { kind: 'empty' };

/** The clipboard's first item (CONTRACT §7.12 `clip_item`). */
export interface ClipItem { types: string[]; text: string | null }

/** `clipboard.read`'s first item; null when there is none (a concealed clipboard has none). */
export function firstClipItem(result: Obj): ClipItem | null {
  const o = obj(Array.isArray(result.items) ? result.items[0] : null);
  if (!o) return null;
  return { types: Array.isArray(o.types) ? o.types.filter((t): t is string => typeof t === 'string') : [], text: str(o.text) };
}

/** captureBlockReason for the front window, except that an incognito window refuses whatever the blacklist says. */
export function selectionBlockReason(front: CaptureWindow | null, rules: BlacklistRules, ownPids: readonly number[]): string | null {
  if (!front) return 'no_window';
  return captureBlockReason(front, rules, ownPids) ?? (front.incognito === true ? 'incognito' : null);
}

export function selectionMessage(reason: string): string {
  switch (reason) {
    case 'secure_input': return '安全输入中，没有读取';
    case 'blacklisted': return '这个窗口在黑名单里，没有读取';
    case 'incognito': return '无痕窗口，没有读取';
    case 'browser_unknown': return '看不出这个浏览器窗口是不是无痕，没有读取';
    default: return '没找到前台窗口，没有读取';
  }
}

function clip(text: string, source: SelectionRead['source'], limit: number): SelectionRead {
  return scalarCount(text) > limit ? { source, text: prefix(text, limit), truncated: true } : { source, text, truncated: false };
}

/** `axText` and `clipboard` are called only once the checks before them pass, each at most once. */
export async function decideSelection(secureInput: boolean, blockReason: string | null, axText: () => Promise<string | null>,
  clipboard: () => Promise<ClipItem | null>, limit: number): Promise<SelectionDecision> {
  if (secureInput) return { kind: 'refused', message: selectionMessage('secure_input') };
  if (blockReason !== null) return { kind: 'refused', message: selectionMessage(blockReason) };
  const text = await axText();
  if (text !== null && !blank(text)) return { kind: 'read', read: clip(text, 'selection', limit) };
  const item = await clipboard();
  if (!item || item.types.some((t) => SKIPPED_TYPES.includes(t)) || item.text === null || blank(item.text)) return { kind: 'empty' };
  return { kind: 'read', read: clip(item.text, 'clipboard', limit) };
}

// ---- Our own capture

/** Our own capture lights the capture indicator from about 0.7 s after it starts to 1 s after it ends; the attention
 *  sampler keeps its `screen_captured` from before while this says recent. Times in Unix milliseconds. */
export class OwnCapture {
  static readonly LINGER_MS = 3000;
  private at = -Infinity;
  private running = 0;

  note(delta: number, now: number): void {
    this.at = now;
    this.running += delta;
  }

  recent(now: number): boolean {
    return this.running > 0 || now - this.at < OwnCapture.LINGER_MS;
  }
}
