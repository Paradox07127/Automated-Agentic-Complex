// The attention heartbeat's rules: the platform helper's `attention.sample` reading (CONTRACT §7.3) in, the body of agentd's `POST /context/attention` and the derived scene state out.
import type { HelperAnswer } from './push-to-talk.ts';

export interface Rect { x: number; y: number; width: number; height: number }

export interface AttentionWindow {
  app: string | null;
  bundleId: string | null;
  pid: number | null;
  windowId: number | null;
  title: string | null;
  urlHost: string | null;
  /** `LSApplicationCategoryType` of the owning app. */
  category?: string | null;
}

/** AX role and subrole of the window that holds the focused element. */
export interface FocusWindow { role: string | null; subrole: string | null }

export interface InputCounters { keys: number; leftClicks: number; rightClicks: number; scrolls: number; moves: number }
export interface InputIdles { key: number; pointer: number; scroll: number; click: number }
/** Only counts and idle seconds; never a key code. */
export interface InputSnapshot {
  idles: InputIdles;
  keys10s: number;
  keys60s: number;
  clicks10s: number;
  scrolls30s: number;
  moves10s: number;
  switches60s: number;
  /** Left clicks near her but not on her; null leaves the field out. */
  nearClicks10s: number | null;
}

export type PresenceEdge = 'lock' | 'unlock' | 'sleep' | 'wake';

/** Null leaves an optional field out of the heartbeat. */
export interface AttentionSample {
  ts: number;
  front: AttentionWindow | null;
  /** null: the front window is a browser whose incognito state couldn't be read. */
  frontIncognito: boolean | null;
  mouse: AttentionWindow | null;
  idleSeconds: number;
  locked: boolean;
  asleep: boolean;
  focusRole: string | null;
  secureInput: boolean;
  fullscreen: boolean | null;
  cameraActive: boolean | null;
  micActive: boolean | null;
  userSpeaking: boolean | null;
  focusWindow: FocusWindow | null;
  input: InputSnapshot | null;
  micApps: string[] | null;
  frontAudioOut: boolean | null;
  frontVideo: boolean | null;
  frontGpu: number | null;
  screenCaptured: boolean | null;
  /** Set only on the beat sent for a presence edge. */
  edge: PresenceEdge | null;
  /** The front window's bounds in helper (CG global) coordinates; not sent to agentd. */
  frontBounds: Rect | null;
}

// The Windows ids are C12 §2.9's lower-case executable names of the same browsers; a Store-packaged one has an AUMID instead.
const BROWSERS = new Set(['com.apple.Safari', 'com.google.Chrome', 'com.microsoft.edgemac', 'com.brave.Browser',
  'company.thebrowser.Browser', 'org.mozilla.firefox', 'chrome.exe', 'msedge.exe', 'brave.exe', 'arc.exe', 'firefox.exe']);

export function isBrowser(bundleId: string | null | undefined): boolean {
  return bundleId != null && BROWSERS.has(bundleId);
}

/** A browser, or a Windows packaged app: its app_id is an AUMID (`PackageFamilyName!AppId`), which no executable name or
 *  bundle id here has, and it may be a browser. Its windows are not known to be non-private unless the browser says so. */
export function mayBePrivate(bundleId: string | null | undefined): boolean {
  return isBrowser(bundleId) || (bundleId != null && bundleId.includes('!'));
}

/** The AX title of the focused window when it has one, else the CG window name. */
export function chooseTitle(ax: string | null, cg: string | null): string | null {
  return ax !== null && ax !== '' ? ax : cg;
}

// ---- Blacklist

/** `<agentd_state_dir>/blacklist.json` v1, matched as agentd's blacklist.py does. */
export interface BlacklistRules {
  /** `allow` reads only the allow lists' windows and uses no blacklist key; `deny` reads all but the blacklist's. */
  mode: 'allow' | 'deny';
  /** Always true in allow mode. */
  incognito: boolean;
  bundles: ReadonlySet<string>;
  /** Folded app names. */
  names: ReadonlySet<string>;
  /** Folded domains. */
  domains: readonly string[];
  titles: readonly RegExp[];
  allowBundles: ReadonlySet<string>;
  /** Folded app names. */
  allowNames: ReadonlySet<string>;
  /** Folded domains. */
  allowDomains: readonly string[];
}

/** No file: the empty allow list, which reads nothing. */
export const EMPTY_BLACKLIST: BlacklistRules = { mode: 'allow', incognito: true, bundles: new Set(), names: new Set(), domains: [],
  titles: [], allowBundles: new Set(), allowNames: new Set(), allowDomains: [] };

/** The Companion's own bundle, hidden whatever the blacklist file says. */
export const OWN_BUNDLES: readonly string[] = ['local.agenticcomplex.companion'];

const fold = (s: string) => s.toLowerCase();

const strings = (v: unknown): string[] => (Array.isArray(v) && v.every((s) => typeof s === 'string') ? v : []);

/** A pattern NSRegularExpression would take; one that compiles neither way is skipped. */
function pattern(p: string): RegExp | null {
  for (const flags of ['u', '']) {
    try {
      return new RegExp(p, flags);
    } catch { /* next */ }
  }
  return null;
}

const record = (v: unknown): Record<string, unknown> =>
  (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});

export function parseBlacklist(json: unknown): BlacklistRules {
  const o = record(json), allow = record(o.allow);
  const mode = o.mode === 'deny' ? 'deny' : 'allow';
  return {
    mode,
    incognito: mode === 'allow' || o.incognito === true,
    bundles: new Set(strings(o.bundle_ids)),
    names: new Set(strings(o.app_names).map(fold)),
    domains: strings(o.domains).map(fold),
    titles: strings(o.title_patterns).map(pattern).filter((r): r is RegExp => r !== null),
    allowBundles: new Set(strings(allow.bundle_ids)),
    allowNames: new Set(strings(allow.app_names).map(fold)),
    allowDomains: strings(allow.domains).map(fold),
  };
}

/** `host` folded: it is one of `domains` or a subdomain of one. */
const under = (host: string, domains: readonly string[]) => domains.some((d) => host === d || host.endsWith(`.${d}`));

/** `ownPids`: this shell's processes, which are hidden before any rule. In allow mode a window with a URL host is read
 *  by its host alone, any other by its bundle id or app name. */
export function hides(rules: BlacklistRules, w: AttentionWindow, ownPids: readonly number[]): boolean {
  if ((w.pid !== null && ownPids.includes(w.pid)) || OWN_BUNDLES.includes(w.bundleId ?? '')) return true;
  if (rules.mode === 'allow') {
    if (w.urlHost !== null && w.urlHost !== '') return !under(fold(w.urlHost), rules.allowDomains);
    return !((w.bundleId !== null && rules.allowBundles.has(w.bundleId))
      || (w.app !== null && w.app !== '' && rules.allowNames.has(fold(w.app))));
  }
  if (w.bundleId !== null && rules.bundles.has(w.bundleId)) return true;
  if (w.app !== null && rules.names.has(fold(w.app))) return true;
  if (w.urlHost !== null && w.urlHost !== '' && under(fold(w.urlHost), rules.domains)) return true;
  const title = w.title ?? '';
  return rules.titles.some((r) => r.test(title));
}

// ---- Redaction

// NSRegularExpression is ICU: \w, \b and \d are Unicode-aware there, so they are spelled out here.
const W = String.raw`[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}‌‍]`;
const D = String.raw`\p{Nd}`;
const SECRET_KEY = String.raw`(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|passwd|password|secret|authorization)["']?\s*[:=]\s*)`;
const SECRET_MARKERS = ['key', 'token', 'passwd', 'password', 'secret', 'authorization'];
const BASIC_VALUE = /^[A-Za-z0-9+/]{4,}={0,2}$/u;
const BEARER_VALUE = /^(?=[A-Za-z0-9._~+/-]*?(?:[0-9]|[._~+/-][A-Za-z0-9]))[A-Za-z0-9._~+/-]+=*$/u;

/** Basic credentials are base64 of `user:password`; a word like `arithmetic` only looks like base64. */
function basicCredential(value: string): boolean {
  if (!BASIC_VALUE.test(value) || value.length % 4 !== 0) return false;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0))).includes(':');
  } catch {
    return false;
  }
}

/** Outside an Authorization header a scheme word counts only before a credential-shaped value, so prose keeps it. */
function credential(match: string, auth: string | undefined, scheme: string, value: string): string {
  if (auth !== undefined) return `${auth}[凭据已遮蔽]`;
  const shaped = scheme.toLowerCase() === 'basic' ? basicCredential(value) : BEARER_VALUE.test(value);
  return shaped ? '[凭据已遮蔽]' : match;
}

const REDACTIONS: { markers: string[]; expression: RegExp; replacement: string | typeof credential }[] = [
  { markers: ['bearer', 'basic'],
    expression: new RegExp(String.raw`((?<!${W})["']?authorization["']?\s*[:=]\s*)?(?<!${W})(bearer|basic)\s+([^\s,;"'<>]+)`, 'giu'),
    replacement: credential },
  // A capture may end inside a quoted value or its final escape: redact through the end of the input then.
  { markers: SECRET_MARKERS, expression: new RegExp(String.raw`${SECRET_KEY}(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$))`, 'giu'), replacement: '$1[已遮蔽]' },
  { markers: SECRET_MARKERS, expression: new RegExp(String.raw`${SECRET_KEY}[^\s,;"'}]+`, 'giu'), replacement: '$1[已遮蔽]' },
  { markers: ['sk-', 'gh'], expression: new RegExp(String.raw`(?<!${W})(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})`, 'gu'), replacement: '[密钥已遮蔽]' },
  { markers: ['@'], expression: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/gu, replacement: '[邮箱已遮蔽]' },
  { markers: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
    expression: new RegExp(String.raw`(?<!${W})(?!${D}{4}-${D}{2}-${D}{2}(?:(?!${W})|T))\+?(?:${D}[ ()-]*){9,14}${D}(?!${W})`, 'gu'),
    replacement: '[电话已遮蔽]' },
];

/** A rule runs only when its literal marker is in the text. */
export function redactText(text: string): string {
  const lower = text.toLowerCase();
  return REDACTIONS.reduce((value, { markers, expression, replacement }) => {
    if (!markers.some((m) => lower.includes(m))) return value;
    return typeof replacement === 'string' ? value.replace(expression, replacement) : value.replace(expression, replacement);
  }, text);
}

// ---- Scene readings

/** `window` and `displays` in helper (CG global) coordinates. A zoomed window leaves the menu bar out, so it doesn't count. */
export function coversDisplay(window: Rect, displays: readonly Rect[]): boolean {
  return displays.some((d) => d.x >= window.x && d.y >= window.y && d.x + d.width <= window.x + window.width
    && d.y + d.height <= window.y + window.height);
}

/** One state per device, null when unread: unknown unless some is known active or all are known idle. */
function anyActive(states: readonly (boolean | null)[]): boolean | null {
  if (states.includes(true)) return true;
  return states.includes(null) ? null : false;
}

/** CONTRACT §7.12 `audio_client`; `app` is its app name, for the blacklist. */
export interface AudioClient { pid: number; bundleId: string | null; app: string | null; runningInput: boolean; runningOutput: boolean | null }

const MIC_APPS_MAX = 16;

/** Bundle ids recording now, without our own processes, blacklisted ones as `<hidden>`, at most 16; a client with no
 *  bundle id is left out. `frontOut`: whether the front process plays audio, null when unknown. */
export function audioApps(clients: readonly AudioClient[], ownPids: readonly number[], frontPid: number | null,
  rules: BlacklistRules): { mic: string[]; frontOut: boolean | null } {
  const mic: string[] = [];
  for (const c of clients) {
    if (!c.runningInput || ownPids.includes(c.pid) || c.bundleId === null) continue;
    const w = { app: c.app, bundleId: c.bundleId, pid: c.pid, windowId: null, title: null, urlHost: null };
    const name = hides(rules, w, ownPids) ? '<hidden>' : c.bundleId;
    if (!mic.includes(name)) mic.push(name);
  }
  const frontOut = frontPid === null ? null : anyActive(clients.filter((c) => c.pid === frontPid).map((c) => c.runningOutput));
  return { mic: mic.slice(0, MIC_APPS_MAX), frontOut };
}

/** The Settings switches `sense_input_counts` and `sense_audio_apps`: an off switch leaves its field out, and `input` is
 *  not called at all. */
export function sensedFields(senseInput: boolean, senseAudioApps: boolean, audio: { mic: string[]; frontOut: boolean | null } | null,
  input: () => InputSnapshot | null): { input: InputSnapshot | null; micApps: string[] | null; frontAudioOut: boolean | null } {
  return { input: senseInput ? input() : null, micApps: senseAudioApps ? audio?.mic ?? null : null, frontAudioOut: audio?.frontOut ?? null };
}

/** The indicator stays up this long (s) after the mic or camera stops. */
export const INDICATOR_LINGER = 3;

/** Whether the screen is captured, with the memory of the last mic or camera use and of the value from before our own
 *  capture. Times in Unix seconds. */
export class CaptureTracker {
  private micOrCameraAt: number | null = null;
  private last: boolean | null = null;

  update(ts: number, indicatorShown: boolean | null, micActive: boolean | null, cameraActive: boolean | null,
    ownCaptureRecent: boolean): boolean | null {
    if (micActive === true || cameraActive === true) this.micOrCameraAt = ts;
    if (ownCaptureRecent) return this.last;
    const inUseAgo = this.micOrCameraAt === null ? null : ts - this.micOrCameraAt;
    if (indicatorShown === null) this.last = null;
    else if (!indicatorShown) this.last = false;
    else if (micActive !== false || cameraActive !== false) this.last = null;
    else this.last = inUseAgo !== null && inUseAgo < INDICATOR_LINGER ? null : true;
    return this.last;
  }
}

/** Sliding counts over the last 60 s, from counter deltas between samples and front bundle changes. */
export class InputActivity {
  private last: InputCounters | null = null;
  private lastBundle: string | null = null;
  private steps: { ts: number; keys: number; clicks: number; scrolls: number; moves: number; switches: number }[] = [];

  /** A null bundle (no front app) is skipped, so A, none, A is not a switch. Counters are UInt32s that wrap. */
  record(ts: number, c: InputCounters, frontBundleId: string | null, idles: InputIdles): InputSnapshot {
    const step = { ts, keys: 0, clicks: 0, scrolls: 0, moves: 0, switches: 0 };
    const p = this.last;
    if (p !== null) {
      step.keys = (c.keys - p.keys) >>> 0;
      step.clicks = ((c.leftClicks - p.leftClicks) >>> 0) + ((c.rightClicks - p.rightClicks) >>> 0);
      step.scrolls = (c.scrolls - p.scrolls) >>> 0;
      step.moves = (c.moves - p.moves) >>> 0;
    }
    this.last = c;
    if (frontBundleId !== null) {
      if (this.lastBundle !== null && this.lastBundle !== frontBundleId) step.switches = 1;
      this.lastBundle = frontBundleId;
    }
    this.steps = this.steps.filter((s) => ts - s.ts < 60);
    this.steps.push(step);
    const sum = (window: number, key: 'keys' | 'clicks' | 'scrolls' | 'moves' | 'switches') =>
      this.steps.filter((s) => ts - s.ts < window).reduce((n, s) => n + s[key], 0);
    return { idles, keys10s: sum(10, 'keys'), keys60s: sum(60, 'keys'), clicks10s: sum(10, 'clicks'), scrolls30s: sum(30, 'scrolls'),
      moves10s: sum(10, 'moves'), switches60s: sum(60, 'switches'), nearClicks10s: null };
  }
}

// ---- Presence

/** A `presence.edge` event (CONTRACT §8): lock and unlock as they are; the system and display ones go to the sleep state. */
export function helperEdge(edge: unknown): { lock: boolean } | { system: boolean } | { display: boolean } | null {
  switch (edge) {
    case 'lock': return { lock: true };
    case 'unlock': return { lock: false };
    case 'sleep': return { system: true };
    case 'wake': return { system: false };
    case 'display_sleep': return { display: true };
    case 'display_wake': return { display: false };
    default: return null;
  }
}

/** A system wake may precede display wake: asleep until both have resumed. */
export class AttentionSleepState {
  private system = false;
  private display = false;

  get asleep(): boolean {
    return this.system || this.display;
  }

  update(change: { system?: boolean; display?: boolean }): PresenceEdge | null {
    const was = this.asleep;
    if (change.system !== undefined) this.system = change.system;
    if (change.display !== undefined) this.display = change.display;
    if (was === this.asleep) return null;
    return this.asleep ? 'sleep' : 'wake';
  }
}

/** Lets each edge through once: a repeat of the last edge on its pair within `DEBOUNCE` seconds yields nothing, as when a
 *  notification and the lock read report the same lock. */
export class PresenceEdges {
  static readonly DEBOUNCE = 2;
  private lastLock: { edge: PresenceEdge; ts: number } | null = null;
  private lastSleep: { edge: PresenceEdge; ts: number } | null = null;

  observe(edge: PresenceEdge, ts: number): PresenceEdge | null {
    const lockPair = edge === 'lock' || edge === 'unlock';
    const last = lockPair ? this.lastLock : this.lastSleep;
    if (last !== null && last.edge === edge && ts - last.ts < PresenceEdges.DEBOUNCE) return null;
    if (lockPair) this.lastLock = { edge, ts };
    else this.lastSleep = { edge, ts };
    return edge;
  }
}

/** AttentionBeats: a beat each second while running, none while paused, where each second only polls the lock, and one at
 *  once when the pause ends. `every` runs `fn` each `ms` until the returned function is called. */
export class AttentionBeats {
  static readonly INTERVAL_MS = 1000;
  paused = false;
  private readonly beat: () => void;
  private readonly poll: () => void;
  private readonly every: (ms: number, fn: () => void) => () => void;
  private cancel: (() => void) | null = null;

  constructor(beat: () => void, poll: () => void, every: (ms: number, fn: () => void) => () => void) {
    this.beat = beat;
    this.poll = poll;
    this.every = every;
  }

  get running(): boolean {
    return this.cancel !== null;
  }

  start(): void {
    if (this.cancel !== null) return;
    this.cancel = this.every(AttentionBeats.INTERVAL_MS, () => this.tick());
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  tick(): void {
    if (this.paused) this.poll();
    else this.beat();
  }

  setPaused(value: boolean): void {
    if (value === this.paused) return;
    this.paused = value;
    if (!value && this.running) this.beat();
  }
}

// ---- The helper's reading (CONTRACT §7.3, §7.12)

export interface RawWindow { windowId: number; pid: number; bounds: Rect; title: string | null; appName: string | null; appId: string | null }

export interface RawAttention {
  ts: number;
  front: { pid: number; name: string | null; appId: string | null; category: string | null; window: RawWindow | null;
    /** The focused window's AX title; null when the helper gave none (Windows does not). */
    focusedWindowTitle: string | null } | null;
  mouse: RawWindow | null;
  idleSeconds: number;
  locked: boolean;
  secureInput: boolean;
  focusRole: string | null;
  focusWindowRole: string | null;
  focusWindowSubrole: string | null;
  cameraActive: boolean | null;
  micActive: boolean | null;
  audioClients: AudioClient[] | null;
  inputCounters: InputCounters | null;
  inputIdles: InputIdles | null;
  videoPids: number[] | null;
  frontGpuBusy: number | null;
  captureIndicator: boolean | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

export function decodeRect(v: unknown): Rect | null {
  const o = obj(v);
  if (!o) return null;
  const [x, y, width, height] = [num(o.x), num(o.y), num(o.width), num(o.height)];
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}

function decodeWindow(v: unknown): RawWindow | null {
  const o = obj(v);
  const bounds = o && decodeRect(o.bounds);
  if (!o || !bounds || num(o.window_id) === null || num(o.pid) === null) return null;
  return { windowId: o.window_id as number, pid: o.pid as number, bounds, title: str(o.title), appName: str(o.app_name), appId: str(o.app_id) };
}

/** `attention.sample`'s result; a field that is missing or of another type reads as null. */
export function decodeAttention(r: Record<string, unknown>): RawAttention {
  const front = obj(r.front);
  const counters = obj(r.input_counters), idles = obj(r.input_idles);
  const c = counters && [num(counters.keys), num(counters.left_clicks), num(counters.right_clicks), num(counters.scrolls), num(counters.moves)];
  const i = idles && [num(idles.key), num(idles.pointer), num(idles.scroll), num(idles.click)];
  return {
    ts: num(r.ts) ?? 0,
    front: front && num(front.pid) !== null
      ? { pid: front.pid as number, name: str(front.name), appId: str(front.app_id), category: str(front.category), window: decodeWindow(front.window),
        focusedWindowTitle: str(front.focused_window_title) }
      : null,
    mouse: decodeWindow(r.mouse_window),
    idleSeconds: num(r.idle_s) ?? 0,
    locked: r.locked === true,
    secureInput: r.secure_input === true,
    focusRole: str(r.focus_role),
    focusWindowRole: str(r.focus_window_role),
    focusWindowSubrole: str(r.focus_window_subrole),
    cameraActive: bool(r.camera_active),
    micActive: bool(r.mic_active),
    audioClients: Array.isArray(r.audio_clients)
      ? r.audio_clients.map(obj).filter((a): a is Obj => a !== null && num(a.pid) !== null).map((a) => ({
        pid: a.pid as number, bundleId: str(a.app_id), app: str(a.name), runningInput: a.running_input === true, runningOutput: bool(a.running_output),
      }))
      : null,
    inputCounters: c && c.every((n) => n !== null)
      ? { keys: c[0]!, leftClicks: c[1]!, rightClicks: c[2]!, scrolls: c[3]!, moves: c[4]! } : null,
    inputIdles: i && i.every((n) => n !== null) ? { key: i[0]!, pointer: i[1]!, scroll: i[2]!, click: i[3]! } : null,
    videoPids: Array.isArray(r.video_pids) ? r.video_pids.filter((p): p is number => typeof p === 'number') : null,
    frontGpuBusy: num(r.front_gpu_busy),
    captureIndicator: bool(r.capture_indicator),
  };
}

const SAFARI = 'com.apple.Safari';
const CHROME = 'com.google.Chrome';

/** AttentionSampler.browserState: only Safari and Chrome are asked (`browser.front_tab`). */
export function browserAsks(bundleId: string | null): boolean {
  return bundleId === SAFARI || bundleId === CHROME;
}

/** AttentionSampler.browserState: an app that is not mayBePrivate is known not incognito; another browser, a packaged app,
 *  or a tab that could not be read (no Automation grant, an error), is unknown. `reply` is the `browser.front_tab` answer,
 *  null when not asked. */
export function browserState(bundleId: string | null, reply: HelperAnswer | null): { host: string | null; incognito: boolean | null } {
  if (!mayBePrivate(bundleId)) return { host: null, incognito: false };
  if (reply === null || !reply.ok) return { host: null, incognito: null };
  return { host: str(reply.result.url_host), incognito: bool(reply.result.incognito) };
}

/** What the sample needs besides the helper's reading. */
export interface SampleContext {
  browser: { host: string | null; incognito: boolean | null };
  /** `screens.list` frames, in helper coordinates. */
  displays: readonly Rect[];
  asleep: boolean;
  userSpeaking: boolean | null;
  sensed: { input: InputSnapshot | null; micApps: string[] | null; frontAudioOut: boolean | null };
  screenCaptured: boolean | null;
}

/** AttentionSampler.sample from the helper's reading. */
export function composeSample(raw: RawAttention, c: SampleContext): AttentionSample {
  const f = raw.front;
  const frontBounds = f?.window?.bounds ?? null;
  const front: AttentionWindow | null = f && {
    app: f.name, bundleId: f.appId, pid: f.pid, windowId: f.window?.windowId ?? null,
    // A window that may be incognito gets no title.
    title: mayBePrivate(f.appId) && c.browser.incognito !== false ? null : chooseTitle(f.focusedWindowTitle, f.window?.title ?? null),
    urlHost: c.browser.host, category: f.category,
  };
  const mouse: AttentionWindow | null = raw.mouse && {
    app: raw.mouse.appName, bundleId: raw.mouse.appId, pid: raw.mouse.pid, windowId: raw.mouse.windowId, title: null, urlHost: null,
  };
  const focusWindow = raw.focusWindowRole === null && raw.focusWindowSubrole === null ? null
    : { role: raw.focusWindowRole, subrole: raw.focusWindowSubrole };
  return {
    ts: raw.ts, front, frontIncognito: f ? c.browser.incognito : false, mouse, idleSeconds: raw.idleSeconds, locked: raw.locked,
    asleep: c.asleep, focusRole: raw.focusRole, secureInput: raw.secureInput,
    fullscreen: frontBounds !== null && coversDisplay(frontBounds, c.displays),
    cameraActive: raw.cameraActive, micActive: raw.micActive, userSpeaking: c.userSpeaking, focusWindow,
    input: c.sensed.input, micApps: c.sensed.micApps, frontAudioOut: c.sensed.frontAudioOut,
    frontVideo: f && raw.videoPids ? raw.videoPids.includes(f.pid) : null,
    frontGpu: f ? raw.frontGpuBusy : null,
    screenCaptured: c.screenCaptured, edge: null, frontBounds,
  };
}

// ---- The heartbeat body

const TITLE_MAX = 256;

/** Body of `POST /context/attention`. agentd rejects a non-object `front`, so a missing front window is sent with every
 *  field null. */
export function attentionPayload(s: AttentionSample, rules: BlacklistRules, ownPids: readonly number[], redact: boolean): Record<string, unknown> {
  const hidden = { app: '<hidden>' };
  let front: Record<string, unknown>;
  let hiddenFrontId: number | null = null;
  let frontHidden = false;
  if (s.front && ((s.frontIncognito === true && rules.incognito) || hides(rules, s.front, ownPids))) {
    front = hidden;
    hiddenFrontId = s.front.windowId;
    frontHidden = true;
  } else if (s.front && s.frontIncognito === null && mayBePrivate(s.front.bundleId)) {
    // Incognito state unknown (always for Safari): only the app, as content capture blocks it as browser_unknown.
    front = { app: s.front.app, bundle_id: s.front.bundleId };
  } else {
    const w = s.front ?? { app: null, bundleId: null, pid: null, windowId: null, title: null, urlHost: null };
    // agentd truncates by code points, so the title is cut the same way.
    const title = w.title === null ? null : [...(redact ? redactText(w.title) : w.title)].slice(0, TITLE_MAX).join('');
    front = { app: w.app, bundle_id: w.bundleId, pid: w.pid, window_id: w.windowId, title, url_host: w.urlHost };
    if (w.category != null) front.category = w.category;
    if (s.secureInput) delete front.title;
  }
  let mouse: Record<string, unknown> | null = null;
  if (s.mouse) {
    const w = s.mouse;
    const hide = hides(rules, w, ownPids) || (hiddenFrontId !== null && w.windowId === hiddenFrontId);
    mouse = hide ? hidden : { app: w.app, bundle_id: w.bundleId, pid: w.pid, window_id: w.windowId };
  }
  const payload: Record<string, unknown> = {
    ts: s.ts, front, mouse, idle_s: s.idleSeconds, locked: s.locked, asleep: s.asleep, focus_role: s.focusRole, secure_input: s.secureInput,
  };
  const optional: [string, unknown][] = [
    ['fullscreen', s.fullscreen], ['camera_active', s.cameraActive], ['mic_active', s.micActive], ['user_speaking', s.userSpeaking],
    ['mic_apps', s.micApps], ['front_audio_out', s.frontAudioOut], ['front_video', s.frontVideo], ['front_gpu', s.frontGpu],
    ['screen_captured', s.screenCaptured], ['edge', s.edge],
  ];
  for (const [key, value] of optional) if (value !== null) payload[key] = value;
  payload.focus_window = !frontHidden && s.focusWindow ? { role: s.focusWindow.role, subrole: s.focusWindow.subrole } : null;
  if (s.input) {
    const i = s.input;
    const input: Record<string, unknown> = {
      key_idle_s: i.idles.key, pointer_idle_s: i.idles.pointer, scroll_idle_s: i.idles.scroll, click_idle_s: i.idles.click,
      keys_10s: i.keys10s, keys_60s: i.keys60s, clicks_10s: i.clicks10s, scrolls_30s: i.scrolls30s, moves_10s: i.moves10s,
      switches_60s: i.switches60s,
    };
    if (i.nearClicks10s !== null) input.near_clicks_10s = i.nearClicks10s;
    payload.input = input;
  }
  return payload;
}

// ---- Reflex and log lines

/** C3's global y of a helper rect's top and height (main display's top left, y down), or of a point at height 0, which
 *  also takes a C3 point back; `mainHeight` is the main display's height. index.ts gives the one of its platform. */
export type HelperY = (top: number, height: number, mainHeight: number) => number;

/** macOS: C3 is in AppKit points, y up from the main display's bottom left. */
export const appKitY: HelperY = (top, height, mainHeight) => mainHeight - top - height;

/** Windows: C3 is in the helper's own physical pixels, y down. */
export const helperY: HelperY = (top) => top;

/** A rect in helper coordinates in C3 global points (AppKit's by default); `mainHeight` is the main display's height. */
export function toAppKit(r: Rect, mainHeight: number, y: HelperY = appKitY): Rect {
  return { x: r.x, y: y(r.y, r.height, mainHeight), width: r.width, height: r.height };
}

export interface ReflexState { kind: 'video' | 'game'; rect: Rect }

/** "video" while the front app plays one, "game" for a games-category app or a fullscreen window that kept the GPU busy for
 *  3 beats; null otherwise. Rects in C3 global points (AppKit's by default). */
export class Reflex {
  /** AttentionSampler.gameGpu: a saturating Metal loop reads about 0.4 of wall time on the Mac it was measured on. */
  static readonly GAME_GPU = 0.2;
  private gpuBeats = 0;
  private readonly y: HelperY;

  constructor(y: HelperY = appKitY) {
    this.y = y;
  }

  /** `videoRect`: `ax.video_rect` of the front app, in helper coordinates; null when not read or none. */
  update(s: AttentionSample, mainHeight: number | null, videoRect: Rect | null): ReflexState | null {
    this.gpuBeats = s.fullscreen === true && (s.frontGpu ?? 0) >= Reflex.GAME_GPU ? this.gpuBeats + 1 : 0;
    if (mainHeight === null) return null;
    const frame = s.frontBounds && toAppKit(s.frontBounds, mainHeight, this.y);
    if (s.frontVideo === true && s.front?.pid != null) {
      const rect = videoRect ? toAppKit(videoRect, mainHeight, this.y) : frame;
      if (rect) return { kind: 'video', rect };
    }
    if (frame && (s.front?.category?.endsWith('games') === true || this.gpuBeats >= 3)) return { kind: 'game', rect: frame };
    return null;
  }
}

const flag = (v: boolean | null) => (v === null ? 'nil' : String(v));

export function gateLine(s: AttentionSample): string {
  return `ATTENTION gate fullscreen=${flag(s.fullscreen)} camera=${flag(s.cameraActive)} mic=${flag(s.micActive)} speaking=${flag(s.userSpeaking)}`;
}

export function focusLine(s: AttentionSample): string {
  return s.focusWindow ? `ATTENTION focus_window role=${s.focusWindow.role ?? 'nil'} subrole=${s.focusWindow.subrole ?? 'nil'}` : 'ATTENTION focus_window nil';
}
