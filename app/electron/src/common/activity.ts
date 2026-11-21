// The activity recorder's rules:
// the platform helper's `ax.notification` events (CONTRACT §7.4, §8) in, the body of agentd's `POST /context/events` out.
// The privacy rules are attention.ts's (`hides`, `redactText`, `isBrowser`); this file only applies them per event.
import { type AttentionWindow, type BlacklistRules, isBrowser, redactText } from './attention.ts';
import { type CaptureWindow, captureBlockReason, isSecureNode } from './capture-rules.ts';

export type ActivityKind = 'app' | 'window' | 'focus' | 'value' | 'selection';

/** One item of `POST /context/events`; every field is sent, null as null. */
export interface ActivityEvent {
  ts: number;
  kind: ActivityKind;
  app: string | null;
  bundleId: string | null;
  pid: number | null;
  window: string | null;
  urlHost: string | null;
  doc: string | null;
  role: string | null;
  subrole: string | null;
  label: string | null;
  /** `value`: the field's text; `selection`: the selected text. */
  value: string | null;
  valueLen: number | null;
  /** Characters lost by the changes merged into a `value` event, a stand-in for backspacing. */
  shrink: number | null;
  edits: number | null;
}

/** Read from the helper's `ax_element`. `key` is the helper's `element_key` (the element's `CFHash`), or, where the helper does not give one (Windows), a key made from what the element reads. */
export interface ActivityElement {
  key: string;
  pid: number;
  app: string | null;
  bundleId: string | null;
  role: string | null;
  subrole: string | null;
  /** AXTitle, else AXDescription, else AXPlaceholderValue (the helper's `label`). */
  label: string | null;
  valueLength: number | null;
  windowTitle: string | null;
  doc: string | null;
  selectedText: string | null;
  /** The field's text, only from a watch with `read_value`. */
  value: string | null;
}

/** The app and window events' element, which has no focused element (key ''). */
export function appElement(pid: number, app: string | null, bundleId: string | null, windowTitle: string | null = null,
  doc: string | null = null): ActivityElement {
  return { key: '', pid, app, bundleId, role: null, subrole: null, label: null, valueLength: null, windowTitle, doc, selectedText: null,
    value: null };
}

function elementEvent(e: ActivityElement, kind: ActivityKind, ts: number): ActivityEvent {
  return { ts, kind, app: e.app, bundleId: e.bundleId, pid: e.pid, window: e.windowTitle, urlHost: null, doc: e.doc,
    role: e.role, subrole: e.subrole, label: e.label, value: null, valueLen: null, shrink: null, edits: null };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/** An `ax.notification`'s `element` (CONTRACT §7.12 `ax_element`) as the focused element of the watched app; null when the
 *  helper could not read one. The key is `element_key`, else the element's pid, roles and label. */
export function decodeElement(raw: unknown, pid: number, app: string | null, bundleId: string | null): ActivityElement | null {
  const o = obj(raw);
  if (!o) return null;
  const role = str(o.role), subrole = str(o.subrole), label = str(o.label);
  return {
    key: str(o.element_key) ?? JSON.stringify([pid, role, str(o.native_role), subrole, label]), pid, app, bundleId, role, subrole, label,
    valueLength: int(o.value_length), windowTitle: str(o.window_title), doc: str(o.doc), selectedText: str(o.selected_text),
    value: str(o.value),
  };
}

// ---- Coalescing

interface ValueGroup { element: ActivityElement; first: number; last: number; shrink: number; edits: number }
type Pending = { event: ActivityEvent } | { group: ValueGroup; closedAt: number };

/** Turns AX notifications into few events. Every event leaves through `tick`, stamped with the time it was closed, so a
 *  batch stays in time order. Times in Unix seconds. */
export class ActivityCoalescer {
  static readonly VALUE_QUIET = 1.5;
  static readonly VALUE_MAX_SPAN = 10;
  static readonly SELECTION_QUIET = 0.8;

  private outbox: Pending[] = [];
  private group: ValueGroup | null = null;
  private focusedKey: string | null = null;
  private knownLength: number | null = null;
  private selection: { element: ActivityElement; at: number } | null = null;
  private lastSelection: { key: string; text: string } | null = null;
  private lastFocus: { key: string; role: string | null; label: string | null } | null = null;
  private lastWindow: { title: string | null; doc: string | null } | null = null;
  private lastApp: { pid: number; bundleId: string | null } | null = null;

  app(e: ActivityElement, ts: number): void {
    if (this.lastApp && this.lastApp.pid === e.pid && this.lastApp.bundleId === e.bundleId) return;
    this.lastApp = { pid: e.pid, bundleId: e.bundleId };
    this.lastWindow = null;
    this.lastFocus = null;
    this.outbox.push({ event: elementEvent(e, 'app', ts) });
  }

  window(e: ActivityElement, ts: number): void {
    if (this.lastWindow && this.lastWindow.title === e.windowTitle && this.lastWindow.doc === e.doc) return;
    this.lastWindow = { title: e.windowTitle, doc: e.doc };
    this.outbox.push({ event: elementEvent(e, 'window', ts) });
  }

  focus(e: ActivityElement, ts: number): void {
    const last = this.lastFocus;
    if (last && last.key === e.key && last.role === e.role && last.label === e.label) return;
    if (this.group && this.group.element.key !== e.key) this.close(ts);
    this.lastFocus = { key: e.key, role: e.role, label: e.label };
    if (this.focusedKey !== e.key) this.knownLength = e.valueLength;
    this.focusedKey = e.key;
    this.outbox.push({ event: elementEvent(e, 'focus', ts) });
  }

  /** `e.valueLength` is the length right after the change. */
  valueChanged(e: ActivityElement, ts: number): void {
    const open = this.group;
    // A field emptied in one change (sent on Return, cleared) ends the run at its last edit, before the Return's submit,
    // else the run's text would be '' and a timeline would read the submit as coming before the typing.
    const emptied = e.valueLength === 0 && this.focusedKey === e.key && (this.knownLength ?? 0) > 1;
    if (open && open.element.key === e.key && emptied) this.close(open.last);
    else if (open && (open.element.key !== e.key || ts - open.first >= ActivityCoalescer.VALUE_MAX_SPAN)) this.close(ts);
    if (this.focusedKey !== e.key) this.knownLength = null;
    this.focusedKey = e.key;
    const next = this.group ?? { element: e, first: ts, last: ts, shrink: 0, edits: 0 };
    if (this.knownLength !== null && e.valueLength !== null && e.valueLength < this.knownLength) next.shrink += this.knownLength - e.valueLength;
    if (e.valueLength !== null) this.knownLength = e.valueLength;
    next.element = e;
    next.last = ts;
    next.edits += 1;
    this.group = next;
  }

  selectionChanged(e: ActivityElement, ts: number): void {
    this.selection = { element: e, at: ts };
  }

  /** The value event carries the length and the text the last change reported. */
  tick(now: number): ActivityEvent[] {
    const open = this.group;
    if (open && (now - open.last >= ActivityCoalescer.VALUE_QUIET || now - open.first >= ActivityCoalescer.VALUE_MAX_SPAN)) this.close(now);
    const pending = this.selection;
    if (pending && now - pending.at >= ActivityCoalescer.SELECTION_QUIET) {
      this.selection = null;
      const text = pending.element.selectedText ?? '';
      const last = this.lastSelection;
      if (text !== '' && (last === null || last.key !== pending.element.key || last.text !== text)) {
        this.lastSelection = { key: pending.element.key, text };
        const event = elementEvent(pending.element, 'selection', now);
        event.value = text;
        event.valueLen = [...text].length;
        this.outbox.push({ event });
      }
    }
    const out = this.outbox.map((p) => {
      if ('event' in p) return p.event;
      const event = elementEvent(p.group.element, 'value', p.closedAt);
      event.value = p.group.element.value;
      event.valueLen = p.group.element.valueLength;
      event.shrink = p.group.shrink;
      event.edits = p.group.edits;
      return event;
    });
    this.outbox = [];
    return out;
  }

  /** Into the outbox in time order: a run closed at its last edit can be older than events queued since. */
  private close(ts: number): void {
    if (!this.group) return;
    const after = this.outbox.findIndex((p) => ('event' in p ? p.event.ts : p.closedAt) > ts);
    this.outbox.splice(after === -1 ? this.outbox.length : after, 0, { group: this.group, closedAt: ts });
    this.group = null;
  }
}

// ---- Blocking (capture-rules.ts)

export const WINDOW_MAX = 256;
export const DOC_MAX = 512;
export const LABEL_MAX = 120;

/** Counted in code points, as agentd counts. */
const prefix = (s: string, n: number) => [...s].slice(0, n).join('');

/** The sampled front window's state with the event's own window title, which may be
 *  newer than the sample's. A browser shares one pid across windows, so the sample is trusted only when the titles agree. */
export function captureWindow(e: ActivityEvent, front: AttentionWindow | null, frontIncognito: boolean | null,
  secureInput: boolean): CaptureWindow {
  const same = (front?.pid ?? null) === e.pid && (e.window === null || e.window === (front?.title ?? null));
  const window: AttentionWindow = { app: e.app, bundleId: e.bundleId, pid: e.pid, windowId: null,
    title: e.window ?? (same ? front?.title ?? null : null), urlHost: same ? front?.urlHost ?? null : null };
  return { window, incognito: same ? frontIncognito : (isBrowser(e.bundleId) ? null : false), secureInput };
}

/** ActivityRecorder.Policy: `share_typed_text`, `sense_input_counts`, `redact_sensitive`. */
export interface ActivityPolicy { allowTypedText: boolean; senseCounts: boolean; redact: boolean }

/** ActivityRecorder.Policy's values when no settings are saved. */
export const DEFAULT_POLICY: ActivityPolicy = { allowTypedText: false, senseCounts: false, redact: true };

/** The event as it may be queued, or null when it is dropped. */
export function filterEvent(e: ActivityEvent, window: CaptureWindow, rules: BlacklistRules, ownPids: readonly number[],
  policy: ActivityPolicy): ActivityEvent | null {
  const reason = captureBlockReason(window, rules, ownPids);
  if (reason === 'blacklisted') return null;
  if (reason === 'incognito' || reason === 'browser_unknown') {
    return { ts: e.ts, kind: e.kind, app: e.app, bundleId: e.bundleId, pid: e.pid, window: null, urlHost: null, doc: null,
      role: null, subrole: null, label: null, value: null, valueLen: null, shrink: null, edits: null };
  }
  const out = { ...e, urlHost: window.window.urlHost };
  if (reason === 'secure_input' || e.role === 'AXSecureTextField' || e.subrole === 'AXSecureTextField'
    || isSecureNode(e.role ?? '', e.subrole, e.label)) {
    out.value = null;
    out.valueLen = null;
    out.shrink = null;
    out.edits = null;
  }
  if (!policy.allowTypedText) out.value = null;
  if (!policy.senseCounts) {
    out.valueLen = null;
    out.shrink = null;
    out.edits = null;
  }
  if (policy.redact) {
    out.window = out.window === null ? null : redactText(out.window);
    out.label = out.label === null ? null : redactText(out.label);
    out.value = out.value === null ? null : redactText(out.value);
  }
  out.window = out.window === null ? null : prefix(out.window, WINDOW_MAX);
  out.doc = out.doc === null ? null : prefix(out.doc, DOC_MAX);
  out.label = out.label === null ? null : prefix(out.label, LABEL_MAX);
  return out;
}

// ---- Queue and body (ActivityEventQueue, AgentdClient.postActivityEvents)

/** Events waiting to be posted; past `CAPACITY` the oldest are dropped. */
export class ActivityEventQueue {
  static readonly CAPACITY = 500;
  static readonly BATCH = 50;
  private items: ActivityEvent[] = [];
  private droppedCount = 0;

  get count(): number { return this.items.length; }
  get dropped(): number { return this.droppedCount; }
  get events(): readonly ActivityEvent[] { return this.items; }

  append(more: readonly ActivityEvent[]): void {
    this.items.push(...more);
    this.trim();
  }

  drain(max: number = ActivityEventQueue.BATCH): ActivityEvent[] {
    return this.items.splice(0, max);
  }

  /** A batch whose post failed goes back to the front. */
  putBack(batch: readonly ActivityEvent[]): void {
    this.items.unshift(...batch);
    this.trim();
  }

  private trim(): void {
    const over = this.items.length - ActivityEventQueue.CAPACITY;
    if (over <= 0) return;
    this.items.splice(0, over);
    this.droppedCount += over;
  }
}

/** Body of `POST /context/events`. */
export function eventsBody(batch: readonly ActivityEvent[]): { events: Record<string, unknown>[] } {
  return {
    events: batch.map((e) => ({
      ts: e.ts, kind: e.kind, app: e.app, bundle_id: e.bundleId, pid: e.pid, window: e.window, url_host: e.urlHost, doc: e.doc,
      role: e.role, subrole: e.subrole, label: e.label, value: e.value, value_len: e.valueLen, shrink: e.shrink, edits: e.edits,
    })),
  };
}
