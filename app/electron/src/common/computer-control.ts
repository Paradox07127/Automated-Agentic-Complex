// Computer control's rules: the grants, their budget and lifetimes, the interruption tickets, the socket
// request and answer shapes, and what each request asks of the platform helper (CONTRACT §7.8). Times are Unix seconds.
import { type BlacklistRules, hides, isBrowser, type Rect, redactText } from './attention.ts';
import type { ShellPlatform } from './config.ts';
import type { Point, Rect as PlaceRect, ScreenInfo } from './placement.ts';

export type ControlPermission = 'observation' | 'text' | 'image' | 'control';
export const PERMISSIONS: readonly ControlPermission[] = ['observation', 'text', 'image', 'control'];
/** Each grant's title. */
export const PERMISSION_TITLES: Record<ControlPermission, string> = { observation: '观察控件', text: '读取文字', image: '查看截图', control: '执行操作' };

/** One exact window of one process generation, with its geometry. */
export interface ControlTarget { bundleId: string; pid: number; windowId: number; launchedAt: number; frame: Rect }

export function sameTarget(a: ControlTarget | null | undefined, b: ControlTarget | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.bundleId === b.bundleId && a.pid === b.pid && a.windowId === b.windowId && a.launchedAt === b.launchedAt
    && a.frame.x === b.frame.x && a.frame.y === b.frame.y && a.frame.width === b.frame.width && a.frame.height === b.frame.height;
}

export class ControlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The grants' constants (user decision 10-31) and its snapshot limits. */
export const CONSENT = { controlActions: 5, controlSeconds: 120, grantSeconds: 600, snapshotSeconds: 15, snapshotsKept: 16 } as const;

/** No model output can create a grant. `snapshot` takes the helper's snapshot id. */
export class ControlConsent {
  epoch = 0;
  sessionId: string | null = null;
  target: ControlTarget | null = null;
  permissions = new Set<ControlPermission>();
  expiresAt = 0;
  stopped = false;
  controlActionsLeft = 0;
  controlExpiresAt = 0;
  private snapshots = new Map<string, { epoch: number; target: ControlTarget; at: number }>();

  grant(sessionId: string, target: ControlTarget, permission: ControlPermission, now: number): void {
    if (this.sessionId !== sessionId || !sameTarget(this.target, target) || this.stopped || now >= this.expiresAt) {
      this.revoke();
      this.sessionId = sessionId;
      this.target = target;
      this.stopped = false;
      this.expiresAt = now + CONSENT.grantSeconds;
    }
    if (permission === 'control') {
      this.expiresAt = now + CONSENT.grantSeconds;
      this.controlActionsLeft = CONSENT.controlActions;
      this.controlExpiresAt = now + CONSENT.controlSeconds;
    }
    this.permissions.add(permission);
    this.epoch += 1;
    this.snapshots.clear();
  }

  revoke(): void {
    this.epoch += 1;
    this.permissions = new Set();
    this.snapshots.clear();
    this.sessionId = null;
    this.target = null;
    this.expiresAt = 0;
    this.stopped = true;
  }

  /** A finished task gives back its grant; nothing is left stopped. Returns whether the session held a live grant. */
  release(sessionId: string, now: number): boolean {
    if (this.sessionId !== sessionId) return false;
    const live = !this.stopped && now < this.expiresAt;
    this.revoke();
    this.stopped = false;
    return live;
  }

  /** When `granted` next shrinks by itself; null if nothing is live. */
  nextExpiry(now: number): number | null {
    if (this.sessionId === null || this.stopped || now >= this.expiresAt) return null;
    if (!this.permissions.has('control') || this.controlActionsLeft <= 0 || now >= this.controlExpiresAt) return this.expiresAt;
    return Math.min(this.controlExpiresAt, this.expiresAt);
  }

  /** One capability less, without extending the others. */
  revokeOne(permission: ControlPermission): void {
    if (!this.permissions.delete(permission)) return;
    this.invalidateSnapshots();
  }

  check(sessionId: string, target: ControlTarget, permission: ControlPermission, now: number): void {
    const control = permission === 'control';
    if (this.stopped) throw new ControlError('stopped', '任务已停止；重新授权后才可继续');
    if (now >= this.expiresAt) throw new ControlError(control ? 'approval_required' : 'grant_expired', '本次任务授权已过期');
    if (this.sessionId !== sessionId) throw new ControlError('session_not_granted', '此会话没有获得桌面授权');
    if (!sameTarget(this.target, target)) {
      throw new ControlError(control ? 'approval_required' : 'target_changed', '目标窗口或进程已改变，请重新观察和授权');
    }
    if (!this.permissions.has(permission)) {
      throw new ControlError(control ? 'approval_required' : 'permission_required', `需要单独授权：${permission}`);
    }
    if (!this.granted(now).has(permission)) throw new ControlError('approval_required', '本次操作授权已用完或已过期，需要重新允许');
  }

  /** What is usable at `now`: control drops out once its act budget or its window is spent. */
  granted(now: number): Set<ControlPermission> {
    if (this.controlActionsLeft > 0 && now < this.controlExpiresAt) return new Set(this.permissions);
    return new Set([...this.permissions].filter((p) => p !== 'control'));
  }

  snapshot(sessionId: string, target: ControlTarget, now: number, id: string): string {
    this.check(sessionId, target, 'observation', now);
    for (const [key, s] of this.snapshots) if (now - s.at >= CONSENT.snapshotSeconds) this.snapshots.delete(key);
    if (this.snapshots.size >= CONSENT.snapshotsKept) {
      const oldest = [...this.snapshots].reduce((a, b) => (b[1].at < a[1].at ? b : a))[0];
      this.snapshots.delete(oldest);
    }
    this.snapshots.set(id, { epoch: this.epoch, target, at: now });
    return id;
  }

  validate(snapshotId: string, sessionId: string, target: ControlTarget, permission: ControlPermission, now: number): void {
    this.check(sessionId, target, permission, now);
    const s = this.snapshots.get(snapshotId);
    if (!s || s.epoch !== this.epoch) throw new ControlError('stale_snapshot', '观察已失效，请重新观察');
    if (!(now - s.at < CONSENT.snapshotSeconds) || now < s.at || !sameTarget(s.target, target)) {
      throw new ControlError('stale_snapshot', '观察已过期或窗口已移动');
    }
  }

  /** Spends one act of the control budget; a text write ends the control grant at once. */
  consumeControl(text: boolean): void {
    this.controlActionsLeft = text ? 0 : Math.max(0, this.controlActionsLeft - 1);
    if (this.controlActionsLeft === 0) this.permissions.delete('control');
  }

  /** The granted session asking for another window ends its control grant, even if the window comes back. */
  targetRequested(sessionId: string, target: ControlTarget): void {
    if (this.sessionId !== sessionId || this.target === null || sameTarget(this.target, target)) return;
    this.permissions.delete('control');
    this.controlActionsLeft = 0;
  }

  invalidateSnapshots(): void {
    this.epoch += 1;
    this.snapshots.clear();
  }
}

/** A queued grant cannot undo a later Stop or user takeover. */
export class ControlInterruption {
  private revision = 0;
  private stoppedNow = false;
  private owner: string | null = null;

  get isStopped(): boolean {
    return this.stoppedNow;
  }

  prepare(session: string): void {
    this.revision += 1;
    this.owner = session;
  }

  ticket(): number {
    return this.revision;
  }

  interrupt(): number {
    this.revision += 1;
    this.stoppedNow = true;
    return this.revision;
  }

  interruptSession(session: string): boolean {
    if (this.owner !== session) return false;
    this.revision += 1;
    this.stoppedNow = true;
    return true;
  }

  activate(ticket: number, session: string): boolean {
    if (this.revision !== ticket) return false;
    this.stoppedNow = false;
    this.owner = session;
    return true;
  }
}

// ---- The panel's state

export type ComputerUsePhase = 'disabled' | 'ready' | 'waitingPermission' | 'observing' | 'executing' | 'verifying' | 'paused'
  | 'completed' | 'failed';
export type GrantState = 'off' | 'allowed' | 'systemPermissionRequired' | 'unavailable';

export const DEFAULT_ACTION = '只有你启用后，才会查看或操作指定窗口。';

export interface ComputerUsePanelState {
  phase: ComputerUsePhase;
  targetApp: string | null;
  action: string;
  scopeChips: string[];
  permissions: Partial<Record<ControlPermission, GrantState>>;
  pendingGrants: ControlPermission[];
  showsPermissionChoices: boolean;
  canResume: boolean;
  /** The shown request's opaque id, which a grant click carries back; null when no request is shown. */
  challenge: string | null;
}

export function initialPanelState(): ComputerUsePanelState {
  return { phase: 'disabled', targetApp: null, action: DEFAULT_ACTION, scopeChips: [], permissions: {}, pendingGrants: [],
    showsPermissionChoices: true, canResume: false, challenge: null };
}

export const grantState = (s: ComputerUsePanelState, p: ControlPermission): GrantState => s.permissions[p] ?? 'off';

/** A grant button can ask now: not already asked, and in a state a click acts on. */
export function canRequest(s: ComputerUsePanelState, p: ControlPermission): boolean {
  return !s.pendingGrants.includes(p) && ['off', 'allowed', 'systemPermissionRequired'].includes(grantState(s, p));
}

/** Protocol.ts `ComputerUseState` of `computerUse.state` and `computerUse.onState`. */
export function computerUseState(s: ComputerUsePanelState): { granted: ControlPermission[]; active: boolean } {
  return { granted: PERMISSIONS.filter((p) => grantState(s, p) === 'allowed'),
    active: s.phase === 'observing' || s.phase === 'executing' || s.phase === 'verifying' };
}

/** The panel's words. */
export const MESSAGES = {
  stopped: '已停止；需要重新授权才可继续',
  dismissed: '已收起并停止电脑操作',
  closed: '电脑操作已关闭',
  intervened: '你已接管输入；授权保留，点击继续后恢复。',
  systemPermission: '系统权限尚未授予；授权后再点对应按钮。所有选项均可跳过。',
  noChallenge: '请先让会话请求指定窗口，再选择权限。',
  waiting: `请明确选择此窗口可用的权限；不选择就不会读取或操作。执行操作：允许在此窗口内操作最多 ${CONSENT.controlActions} 次（${CONSENT.controlSeconds / 60} 分钟内），写入文字一次即用完。`,
  disabled: '设置 › 能力 中启用电脑操作；每个窗口仍需单独授权。',
} as const;

/** Display redaction, not an assertion that every secret is recognized; whitespace runs become
 *  one space, and past `limit` code points the text is cut and ends in an ellipsis. */
export function displayText(raw: string, limit: number): string {
  const safe = redactText([...raw].slice(0, 2048).join('')).split(/\s+/u).filter((s) => s !== '').join(' ');
  const points = [...safe];
  return points.length > limit ? `${points.slice(0, limit).join('')}…` : safe;
}

/** ComputerUsePanelState.forDisplay: what the panel, the stack card and `computerUse.onState` are given. */
export function displayState(s: ComputerUsePanelState): ComputerUsePanelState {
  return { ...s, targetApp: s.targetApp === null ? null : displayText(s.targetApp, 48), action: displayText(s.action, 180),
    scopeChips: s.scopeChips.slice(0, 4).map((c) => displayText(c, 24)) };
}

// ---- The panel's window; rects in the placement space (y up, as AppKit's)

export const PANEL_WIDTH = 336;

const containsPoint = (r: PlaceRect, p: Point) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

/** The top quarter of her body on the visible frame of the screen her head is on; without her
 *  body, a point 16 pt in from the main screen's visible top right. */
export function headAnchor(body: PlaceRect | null, screens: readonly ScreenInfo[]): { head: PlaceRect; visible: PlaceRect } {
  if (body) {
    const screen = screens.find((s) => containsPoint(s.frame, { x: body.x + body.w / 2, y: body.y + body.h })) ?? screens[0];
    return { head: { x: body.x, y: body.y + body.h - body.h / 4, w: body.w, h: body.h / 4 }, visible: screen?.visibleFrame ?? body };
  }
  const visible = screens[0]?.visibleFrame ?? { x: 0, y: 0, w: 0, h: 0 };
  return { head: { x: visible.x + visible.w - 16, y: visible.y + visible.h - 16, w: 0, h: 0 }, visible };
}

/** Above her head (below it when there is no room), inside the visible frame; an open panel
 *  keeps its place and its top edge, and its height while the pointer is on it. */
export function panelFrame(head: PlaceRect, visible: PlaceRect, fittingHeight: number, current: PlaceRect | null, pointer: Point): PlaceRect {
  const fit = Math.min(Math.max(220, fittingHeight), Math.max(220, visible.h - 24));
  if (current) {
    const h = containsPoint(current, pointer) ? current.h : fit;
    return { x: Math.max(visible.x + 12, Math.min(current.x, visible.x + visible.w - current.w - 12)),
      y: Math.max(visible.y + 12, Math.min(current.y + current.h - h, visible.y + visible.h - h - 12)), w: current.w, h };
  }
  const x = Math.min(Math.max(head.x + head.w / 2 - PANEL_WIDTH / 2, visible.x + 12), visible.x + visible.w - PANEL_WIDTH - 12);
  let y = head.y + head.h + 12;
  if (y + fit > visible.y + visible.h) y = Math.max(visible.y + 12, head.y - fit - 12);
  return { x, y, w: PANEL_WIDTH, h: fit };
}

/** The phases StackSource.setComputerUse makes a card of; the web desktop then hides the panel. */
export const CARD_PHASES: ReadonlySet<ComputerUsePhase> = new Set(['observing', 'executing', 'verifying', 'paused']);

// ---- The socket's requests and answers (docs/architecture/tool-gateway.md)

/** A `control.request` event's request (the helper took its token off): the fields the host reads. */
export interface ControlRequest {
  id: unknown;
  method: string | null;
  sessionId: string | null;
  params: Record<string, unknown>;
  waitForPermission: boolean;
  waitForResume: boolean;
}

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null);

/** A request object as the socket handler reads it; null when it is not an object (the socket closes without an answer). */
export function decodeRequest(raw: unknown): ControlRequest | null {
  const o = obj(raw);
  if (!o) return null;
  return { id: o.id ?? null, method: typeof o.method === 'string' ? o.method : null,
    sessionId: typeof o.session_id === 'string' ? o.session_id : null, params: obj(o.params) ?? {},
    waitForPermission: o.wait_for_permission === true, waitForResume: o.wait_for_resume === true };
}

/** A session id the host takes: non-empty, at most 128 UTF-8 bytes. */
export function validSession(s: string | null): s is string {
  return s !== null && s !== '' && new TextEncoder().encode(s).length <= 128;
}

export type ControlResponse = Record<string, unknown>;

export const okResponse = (id: unknown, result: Record<string, unknown>): ControlResponse => ({ id: id ?? null, result });

/** `retryable` is written only on the answers that set it. */
export function errorResponse(id: unknown, code: string, message: string, retryable?: boolean): ControlResponse {
  return { id: id ?? null, error: { code, message, ...(retryable !== undefined && { retryable }) } };
}

/** A JSON number that is not a boolean. */
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** Absent is null; anything but a whole number in 1…max is `invalid_target`. */
export function requestedInteger(raw: Record<string, unknown>, key: string, max: number): number | null {
  if (!(key in raw) || raw[key] === null) return null;
  const n = num(raw[key]);
  if (n === null || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > max) {
    throw new ControlError('invalid_target', `${key}必须是有效正整数`);
  }
  return n;
}

export const PID_MAX = 2 ** 31 - 1;
export const WINDOW_ID_MAX = 2 ** 32 - 1;

export function coordinate(v: unknown): number | null {
  const n = num(v);
  return n !== null && Number.isFinite(n) && Math.abs(n) <= 100000 ? n : null;
}

/** The scroll's delta_y clamped to ±600, or `invalid_scroll`. */
export function scrollDelta(v: unknown): number {
  const n = num(v);
  if (n === null || !Number.isFinite(n) || !Number.isInteger(n) || Math.abs(n) > 10000) {
    throw new ControlError('invalid_scroll', 'delta_y必须是有限整数');
  }
  return Math.max(-600, Math.min(600, n));
}

/** `desktop_act`'s actions per platform: the Windows helper sends no synthetic input, so it has no click or scroll. */
export const ACTIONS: Readonly<Record<ShellPlatform, readonly string[]>> = {
  mac: ['press', 'set_value', 'type', 'click', 'scroll'], windows: ['press', 'set_value', 'type'],
};
export const ACTION_GAP_SECONDS = 0.25;
export const WAIT_SECONDS = 180;
export const TEXT_BYTES = 4096;
export const DRIVER = 'endfield-native-ax-v1';

/** `control.act`'s params for a checked `desktop_act`; throws the code a refusal before acting gives. */
export function actParams(snapshotId: string, params: Record<string, unknown>, frame: Rect, elementKnown: boolean): Record<string, unknown> {
  const action = params.action;
  if (typeof action !== 'string') throw new ControlError('invalid_action', '缺少动作类型');
  const element = typeof params.element_id === 'string' && elementKnown ? params.element_id : null;
  switch (action) {
    case 'press':
      if (element === null) throw new ControlError('element_required', 'AXPress需要观察中的element_id');
      return { snapshot_id: snapshotId, action, element_id: element };
    case 'set_value': case 'type': {
      const text = params.text;
      if (element === null || typeof text !== 'string' || new TextEncoder().encode(text).length > TEXT_BYTES) {
        throw new ControlError('invalid_text', '需要element_id及最多4096字节文字');
      }
      return { snapshot_id: snapshotId, action, element_id: element, text };
    }
    case 'click': case 'scroll': {
      const x = coordinate(params.x), y = coordinate(params.y);
      if (x === null || y === null || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
        throw new ControlError('invalid_point', '坐标必须在授权窗口内');
      }
      return action === 'click' ? { snapshot_id: snapshotId, action, x, y }
        : { snapshot_id: snapshotId, action, x, y, delta_y: scrollDelta(params.delta_y) };
    }
    default:
      throw new ControlError('unsupported', '只支持press/set_value/type/click/scroll');
  }
}

/** The helper's error codes (CONTRACT §7.8) as agentd's; anything else is its catch-all `native_error`. */
const HELPER_CODES: Record<string, [string, string]> = {
  permission_denied: ['ax_permission_required', 'macOS辅助功能权限未授予'],
  window_gone: ['target_changed', '目标进程、窗口或几何已改变，请重新观察并授权'],
  target_changed: ['target_changed', '目标进程、窗口或几何已改变，请重新观察并授权'],
  element_gone: ['element_required', '需要新观察中的element_id'],
  element_required: ['element_required', '需要新观察中的element_id'],
  stale_snapshot: ['stale_snapshot', '请先取得新的desktop_observe结果'],
  secure_element: ['secure_element', '不操作密码控件'],
  secure_input: ['secure_input', '安全输入已开启，暂停电脑操作'],
  action_refused: ['action_refused', '控件未接受动作；请观察结果，不要盲目重放'],
  unsupported_action: ['unsupported', '这台电脑不支持这个动作（Windows 不支持 click/scroll，用 press/set_value/type）'],
  invalid_text: ['invalid_text', '需要element_id及最多4096字节文字'],
  invalid_point: ['invalid_point', '坐标必须在授权窗口内'],
  invalid_scroll: ['invalid_scroll', 'delta_y必须是有限整数'],
  foreground_required: ['foreground_required', '坐标操作只用于已经在前台的授权窗口；不会抢焦点'],
  occluded_target: ['occluded_target', '点击位置被其它窗口遮住或不能验证'],
  too_large: ['image_too_large', '截图超过本次工具预算'],
};

export function helperFailure(code: string): ControlError {
  const known = HELPER_CODES[code];
  return known ? new ControlError(known[0], known[1]) : new ControlError('native_error', '桌面工具未能完成');
}

export function targetJSON(t: ControlTarget): Record<string, unknown> {
  return { bundle_id: t.bundleId, pid: t.pid, window_id: t.windowId, process_generation: t.launchedAt,
    bounds: { x: t.frame.x, y: t.frame.y, width: t.frame.width, height: t.frame.height } };
}

/** Redacted, at most 512 characters. */
export const safeText = (s: string): string => [...redactText(s)].slice(0, 512).join('');

/** `control.observe`'s elements as `desktop_observe` gives them: text redacted and only when asked. */
export function observedElements(raw: unknown, text: boolean): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(obj).filter((e): e is Record<string, unknown> => e !== null && typeof e.element_id === 'string').map((e) => ({
    element_id: e.element_id, role: e.role, enabled: e.enabled ?? true,
    ...(text && { title: safeText(typeof e.title === 'string' ? e.title : '') }),
    ...(text && 'value' in e && { value: safeText(typeof e.value === 'string' ? e.value : '') }),
    ...(obj(e.bounds) && { bounds: e.bounds }),
    actions: Array.isArray(e.actions) ? e.actions.filter((a) => a === 'AXPress') : [],
  }));
}

/** One running app as `apps.running` gives it (CONTRACT §7.12 `app`). */
export interface RunningApp { pid: number; name: string | null; appId: string; launchedAt: number }

export function decodeApps(result: Record<string, unknown>): RunningApp[] {
  const apps = Array.isArray(result.apps) ? result.apps.map(obj) : [];
  return apps.filter((a): a is Record<string, unknown> => a !== null && Number.isInteger(a.pid)).map((a) => ({
    pid: a.pid as number, name: typeof a.name === 'string' ? a.name : null, appId: typeof a.app_id === 'string' ? a.app_id : '',
    launchedAt: typeof a.launched_at === 'number' ? a.launched_at : 0,
  }));
}

/** The choice of app: by pid and bundle id, never this shell's own processes, exactly one. */
export function chooseApp(apps: readonly RunningApp[], pid: number | null, bundle: string | null, ownPids: readonly number[]): RunningApp {
  const found = apps.filter((a) => (pid === null || a.pid === pid) && (bundle === null || a.appId === bundle) && !ownPids.includes(a.pid));
  if ((pid === null && bundle === null) || found.length !== 1 || found[0].appId === '') {
    throw new ControlError('target_ambiguous', '请指定一个正在运行的应用bundle_id或pid');
  }
  return found[0];
}

/** The refusals of an app: browsers, then the blacklist by app. */
export function appRefusal(app: RunningApp, rules: BlacklistRules, ownPids: readonly number[]): ControlError | null {
  if (isBrowser(app.appId)) return new ControlError('browser_driver_required', '此原生桥暂不读取或操作浏览器；请使用按标签页授权的结构化浏览器工具');
  if (hides(rules, { app: app.name, bundleId: app.appId, pid: app.pid, windowId: null, title: null, urlHost: null }, ownPids)) {
    return new ControlError('blacklisted', '此应用已被排除');
  }
  return null;
}

/** The refusal by window title. `title` is the window's CG title, null when it cannot be read (no
 *  Screen Recording): while any title rule exists such a window is refused, since the AX observation would still read it. */
export function titleRefusal(app: RunningApp, title: string | null, rules: BlacklistRules, ownPids: readonly number[]): ControlError | null {
  if (title === null) {
    return rules.titles.length > 0 ? new ControlError('blacklisted', '读不到窗口标题，无法核对标题排除规则') : null;
  }
  if (hides(rules, { app: app.name, bundleId: app.appId, pid: app.pid, windowId: null, title, urlHost: null }, ownPids)) {
    return new ControlError('blacklisted', '此窗口标题被排除');
  }
  return null;
}
