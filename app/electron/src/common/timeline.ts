// The timeline recorder's rules: one record per user action (the helper's `input.action`) or front window, with the window's
// tree from `ax.window_tree`, in the body of agentd's `POST /context/timeline` out.
// The privacy rules are capture-rules.ts's and attention.ts's; this file only applies them per record.
import { type BlacklistRules, redactText } from './attention.ts';
import { type CaptureWindow, captureBlockReason, isSecureNode } from './capture-rules.ts';

export type TimelineKind = 'window' | 'click' | 'context_menu' | 'shortcut' | 'submit' | 'text_input' | 'selection';

export interface TimelineTarget {
  role: string | null;
  subrole: string | null;
  title: string | null;
  description: string | null;
  identifier: string | null;
  value: string | null;
}

export interface TimelineTree { mode: 'full' | 'diff'; text: string }

/** One item of `POST /context/timeline`, in its wire names; every key is sent, null as null. Times in Unix seconds. */
export interface TimelineRecord {
  ts: number;
  kind: TimelineKind;
  app: string | null;
  bundle_id: string | null;
  pid: number | null;
  window_id: number | null;
  window_title: string | null;
  url_host: string | null;
  target: TimelineTarget | null;
  keys: string | null;
  text: string | null;
  tree: TimelineTree | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** An `input.action`'s `target` (CONTRACT §7.12 `ax_element`), whose `label` is AXTitle, else AXDescription, else the placeholder. */
export function toTarget(raw: unknown): TimelineTarget | null {
  const o = obj(raw);
  if (!o) return null;
  return { role: str(o.role), subrole: str(o.subrole), title: str(o.title) ?? str(o.label), description: str(o.description),
    identifier: str(o.identifier), value: str(o.value) };
}

/** `allowActions` is share_actions (the recorder runs only with plugins.screen_awareness on);`allowTypedText` share_typed_text; `redact` redact_sensitive. */
export interface TimelinePolicy { allowActions: boolean; allowWindowText: boolean; allowTypedText: boolean; redact: boolean }

/** The policy when no settings are saved. */
export const DEFAULT_TIMELINE_POLICY: TimelinePolicy = { allowActions: false, allowWindowText: false, allowTypedText: false, redact: true };

/** The record as it may be queued, or null when it is dropped. Secure input keeps the record without what was typed or shown. */
export function filterRecord(record: TimelineRecord, window: CaptureWindow, rules: BlacklistRules, ownPids: readonly number[],
  policy: TimelinePolicy): TimelineRecord | null {
  if (!policy.allowActions) return null;
  const reason = captureBlockReason(window, rules, ownPids);
  if (reason !== null && reason !== 'secure_input') return null;
  const target = record.target && { ...record.target };
  const out: TimelineRecord = { ...record, url_host: window.window.urlHost, target, tree: record.tree && { ...record.tree } };
  if (reason === 'secure_input' || (target !== null && (target.role === 'AXSecureTextField' || target.subrole === 'AXSecureTextField'
    || isSecureNode(target.role ?? '', target.subrole, target.title, target.description)))) {
    out.text = null;
    out.tree = null;
    if (target) target.value = null;
    if (target?.role === 'AXStaticText') target.title = null;
  }
  if (!policy.allowWindowText) {
    out.tree = null;
    if (target?.role === 'AXStaticText') target.title = null;  // the helper names clicked text by the text itself
  }
  if (!policy.allowTypedText) {
    out.text = null;
    if (target) target.value = null;
  }
  if (policy.redact) {
    out.text = out.text === null ? null : redactText(out.text);
    out.window_title = out.window_title === null ? null : redactText(out.window_title);
    if (out.tree) out.tree.text = redactText(out.tree.text);
    if (target) {
      for (const k of ['title', 'description', 'value'] as const) if (target[k] !== null) target[k] = redactText(target[k]);
    }
  }
  return out;
}

/** Records waiting to be posted; past `CAPACITY` the oldest are dropped. */
export class TimelineQueue {
  static readonly CAPACITY = 500;
  static readonly BATCH = 50;
  private items: TimelineRecord[] = [];
  private droppedCount = 0;

  get count(): number { return this.items.length; }
  get dropped(): number { return this.droppedCount; }
  get records(): readonly TimelineRecord[] { return this.items; }

  append(more: readonly TimelineRecord[]): void {
    this.items.push(...more);
    this.trim();
  }

  drain(max: number = TimelineQueue.BATCH): TimelineRecord[] {
    return this.items.splice(0, max);
  }

  /** A batch whose post failed goes back to the front. */
  putBack(batch: readonly TimelineRecord[]): void {
    this.items.unshift(...batch);
    this.trim();
  }

  private trim(): void {
    const over = this.items.length - TimelineQueue.CAPACITY;
    if (over <= 0) return;
    this.items.splice(0, over);
    this.droppedCount += over;
  }
}
