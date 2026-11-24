// Computer control over the platform helper (CONTRACT §7.8): agentd's desktop tools come in
// as `control.request` events from the endpoint `control.listen` made, the grants and refusals are checked here
// (src/common/computer-control.ts), and only then does the helper observe, act or read. One request runs at a time; a Stop, a cancel or the user's own input interrupts at once and is cleaned up after it.
import type { BlacklistRules } from '../../common/attention.ts';
import type { ShellPlatform } from '../../common/config.ts';
import {
  ACTION_GAP_SECONDS, ACTIONS, actParams, appRefusal, canRequest, chooseApp, type ComputerUsePanelState, type ComputerUsePhase,
  computerUseState, ControlConsent, ControlError, ControlInterruption, type ControlPermission, type ControlRequest,
  type ControlResponse, type ControlTarget, DEFAULT_ACTION, decodeApps, decodeRequest, displayState, DRIVER, errorResponse, grantState,
  helperFailure, initialPanelState, MESSAGES, observedElements, okResponse, PERMISSION_TITLES, PERMISSIONS, PID_MAX, requestedInteger,
  sameTarget, targetJSON, titleRefusal, validSession, WAIT_SECONDS, WINDOW_ID_MAX,
} from '../../common/computer-control.ts';
import type { HelperAnswer } from '../../common/push-to-talk.ts';
import { PushSource } from '../../common/push.ts';
import { decodeWindows } from '../../common/screen-context.ts';
import { shellPlatform } from '../platform/index.ts';

export interface ControlPorts {
  /** `signal`'s abort sends C12 `cancel` for the request in flight. */
  helper: { request(op: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<HelperAnswer> };
  /** `control.listen`'s endpoint and token file (common/agentd.ts `controlEndpoint`). */
  endpoint: { path: string; tokenFile: string };
  /** config.json's `computer_use` plug-in now; false while config.json fails to load. */
  enabled(): boolean;
  /** `<agentd_state_dir>/blacklist.json`'s rules now. */
  blacklist(): BlacklistRules;
  /** This shell's processes (main and helper), never a target. */
  ownPids(): readonly number[];
  /** Unix milliseconds. */
  now(): number;
  /** Runs `fn` once after `ms`; the returned function cancels it. */
  after(ms: number, fn: () => void): () => void;
  /** A fresh unique id (an act's `action_id`). */
  newId(): string;
  log(line: string): void;
}

/** Compared by identity; `id` is what the panel shows and its grant click carries back. */
interface Challenge { id: string; session: string; target: ControlTarget }

/** Concurrent executions: ordinary requests at once; cancel and release always get through. */
const EXECUTIONS = 4;

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null);
const errorCode = (r: ControlResponse): string | null => {
  const e = obj(r.error);
  return e && typeof e.code === 'string' ? e.code : null;
};

export class ControlHost {
  /** `computerUse.onState`: protocol.ts `ComputerUseState` on every published state, none replayed. */
  readonly events = new PushSource('state', { replay: false });
  /** Each published panel state, for the desktop panel and the stack card; `raise` false updates a shown panel in place and
   *  never brings a hidden one forward. */
  onPanel: (state: ComputerUsePanelState, raise: boolean) => void = () => {};
  private readonly ports: ControlPorts;
  private readonly actions: readonly string[];
  private readonly consent = new ControlConsent();
  private readonly interruption = new ControlInterruption();
  private pending: Challenge | null = null;
  private presented: Challenge | null = null;
  /** The live observation: the helper's snapshot id, its target and its element ids. */
  private snapshots = new Map<string, { target: ControlTarget; elements: Set<string> }>();
  private userPaused = false;
  private active = false;
  private lastActionAt = 0;
  private inputMonitorAvailable = false;
  private system: { ax: boolean | null; screen: boolean | null } = { ax: null, screen: null };
  private names = new Map<number, string | null>();
  private panel: ComputerUsePanelState = initialPanelState();
  private shown: { phase: ComputerUsePhase; action: string } = { phase: 'ready', action: DEFAULT_ACTION };
  private expiryRefresh = 0;
  private cancelExpiry: (() => void) | null = null;
  private stopped = false;
  private executing = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private decision = 0;
  private readonly waiters = new Set<() => void>();
  /** Bumped when the helper goes: a request of an earlier helper is never answered, its `conn` is the new helper's. */
  private helperGeneration = 0;
  /** The `control.act` at the helper now; every interruption aborts it. */
  private acting: AbortController | null = null;

  constructor(ports: ControlPorts, platform: ShellPlatform = shellPlatform()) {
    this.ports = ports;
    this.actions = ACTIONS[platform];
  }

  /** What the panel shows now. */
  get state(): ComputerUsePanelState {
    return this.panel;
  }

  /** Asks the helper for the endpoint and the input monitor. */
  start(): Promise<void> {
    return this.listen();
  }

  /** The helper said hello (true) or went (false). A new helper has no endpoint and no snapshots (CONTRACT §6.4–§6.5). */
  helper(running: boolean): void {
    if (this.stopped) return;
    if (running) {
      void this.listen();
      return;
    }
    this.inputMonitorAvailable = false;
    this.helperGeneration += 1;
    // Its waiting requests end.
    this.notify();
    void this.enqueue(() => {
      this.consent.invalidateSnapshots();
      this.snapshots.clear();
    });
  }

  /** A helper event: `control.request` is answered, `input.activity` is the user taking over. */
  event(name: string, data: Record<string, unknown>): void {
    if (this.stopped) return;
    if (name === 'input.activity') this.userIntervened();
    else if (name === 'control.request' && Number.isInteger(data.conn)) void this.serve(data.conn as number, data.request);
  }

  /** The panel's 停止 and `computerUse.stop`. */
  stopControl(): Promise<void> {
    return this.stopWith(MESSAGES.stopped);
  }

  /** The panel's 收起. */
  dismiss(): Promise<void> {
    return this.stopWith(MESSAGES.dismissed);
  }

  /** The shell quits: the grant ends and nothing is published after. */
  stop(): Promise<void> {
    this.stopped = true;
    this.cancelExpiry?.();
    void this.ports.helper.request('input.watch', { enabled: false });
    return this.stopWith(MESSAGES.closed);
  }

  /** The panel's grant button: only a user's click on the challenge `shown`; a granted one is
   *  taken back. */
  async grant(permission: ControlPermission, shown: string | null): Promise<void> {
    if (this.stopped) return;
    const challenge = this.presented;
    if (challenge === null) {
      this.update({ ...this.panel, phase: 'waitingPermission', action: MESSAGES.noChallenge }, false);
      return;
    }
    if (challenge.id !== shown) {
      this.update({ ...this.panel, phase: 'waitingPermission', action: '授权目标已更新，请核对当前窗口后重新选择权限' }, false);
      return;
    }
    if (!canRequest(this.panel, permission)) return;
    const allowed = grantState(this.panel, permission) === 'allowed';
    this.update({ ...this.panel, pendingGrants: [...this.panel.pendingGrants, permission], action: `正在确认${PERMISSION_TITLES[permission]}…` }, false);
    if (allowed) return this.revoke(permission, challenge);
    // Taken at the click: a Stop while the system permissions are read still wins.
    const ticket = this.interruption.ticket();
    const system = await this.systemPermissions();
    // Only an explicit user click may show a system permission prompt.
    if (permission !== 'image' && !system.ax) {
      await this.ports.helper.request('permissions.request', { kind: 'accessibility' });
      return this.enqueue(() => this.publish('waitingPermission', MESSAGES.systemPermission));
    }
    if (permission === 'image' && !system.screen) {
      await this.ports.helper.request('permissions.request', { kind: 'screenRecording' });
      return this.enqueue(() => this.publish('waitingPermission', MESSAGES.systemPermission));
    }
    if (!this.inputMonitorAvailable) await this.watchInput();
    return this.enqueue(async () => {
      if (this.pending !== challenge) return this.publish('waitingPermission', '授权目标已更新，请核对当前窗口后重新选择权限');
      const fresh = this.ports.enabled() ? await this.resolve({ pid: challenge.target.pid, window_id: challenge.target.windowId }).catch(() => null) : null;
      if (!this.ports.enabled() || fresh === null || !sameTarget(fresh.target, challenge.target)) {
        return this.publish('failed', '授权目标已改变，请让会话重新观察');
      }
      if (!(this.userPaused || this.interruption.activate(ticket, challenge.session))) {
        return this.publish('paused', '授权请求已被后来的停止撤销');
      }
      this.consent.grant(challenge.session, fresh.target, permission, this.now());
      this.snapshots.clear();
      this.publish(this.userPaused ? 'paused' : 'ready', this.userPaused ? '授权已更新；点击继续后恢复。' : '权限已更新。');
      this.notify();
    });
  }

  /** The panel's 继续 after the user took over. */
  resume(): Promise<void> {
    const ticket = this.interruption.ticket();
    return this.enqueue(async () => {
      // A click queued behind the one that resumed.
      if (!this.userPaused) return;
      const p = this.pending, c = this.consent;
      const giveUp = (message: string) => {
        c.revoke();
        this.pending = null;
        this.userPaused = false;
        this.snapshots.clear();
        this.publish('paused', message);
        this.notify();
      };
      if (!this.ports.enabled() || p === null || c.sessionId !== p.session || !sameTarget(c.target, p.target)
        || c.stopped || !(this.now() < c.expiresAt)) return giveUp('授权已过期，请重新发起任务。');
      const fresh = await this.resolve({ pid: p.target.pid, window_id: p.target.windowId }).catch(() => null);
      if (fresh === null || !sameTarget(fresh.target, p.target)) return giveUp('窗口已改变，请重新发起任务并授权。');
      if (!this.interruption.activate(ticket, p.session)) return this.publish('paused', '你已接管输入；请再次点击继续。');
      this.userPaused = false;
      c.invalidateSnapshots();
      this.snapshots.clear();
      this.publish('ready', '已继续；会先重新观察窗口。');
      this.notify();
    });
  }

  /** The user's own key, click or scroll: the task pauses and its observations end; the grant stays. */
  userIntervened(): Promise<void> {
    this.interrupt();
    return this.enqueue(() => {
      if (!this.active && this.consent.sessionId === null) return;
      this.userPaused = true;
      this.consent.invalidateSnapshots();
      this.snapshots.clear();
      this.active = false;
      this.publish('paused', MESSAGES.intervened);
      this.notify();
    });
  }

  /** One socket request, answered with `control.respond`. */
  async serve(conn: number, raw: unknown): Promise<void> {
    const generation = this.helperGeneration;
    const request = decodeRequest(raw);
    let response: ControlResponse;
    if (request === null) response = errorResponse(null, 'invalid_request', '请求缺少会话或方法', false);
    else if (request.method === 'desktop_cancel' || request.method === 'desktop_release') response = await this.handle(request);
    else if (this.executing >= EXECUTIONS) response = errorResponse(request.id, 'bridge_busy', '桌面工具繁忙，请先等待或取消当前任务');
    else {
      this.executing += 1;
      try {
        response = await this.handle(request);
      } finally {
        this.executing -= 1;
      }
    }
    if (generation !== this.helperGeneration) return;
    const sent = await this.ports.helper.request('control.respond', { conn, response });
    if (!sent.ok) this.ports.log(`computer control: answer not sent code=${sent.error.code}`);
  }

  /** `wait_for_permission` and `wait_for_resume` wait up to 180 s for the user's decision. */
  async handle(request: ControlRequest): Promise<ControlResponse> {
    const deadline = this.ports.now() + WAIT_SECONDS * 1000;
    const generation = this.helperGeneration;
    const gone = () => errorResponse(request.id, 'native_error', '桌面工具未能完成', false);
    if (request.method === 'desktop_act' && request.waitForResume) {
      let revision = this.decision;
      const response = await this.handleOnce(request);
      const code = errorCode(response);
      if (code !== 'user_paused' && code !== 'permission_required') return response;
      while (await this.waitDecision(revision, deadline)) {
        if (generation !== this.helperGeneration) return gone();
        revision = this.decision;
        const [same, ready] = await this.enqueue(() => {
          const action = request.params.action;
          const needsText = action === 'set_value' || action === 'type';
          const granted = this.consent.granted(this.now());
          return [this.pending?.session === request.sessionId, !this.userPaused && !this.consent.stopped
            && this.now() < this.consent.expiresAt && granted.has('control') && (!needsText || granted.has('text'))];
        });
        if (!same) return errorResponse(request.id, 'stopped', '任务已停止');
        // An action is never replayed after a pause; the model must get a fresh snapshot.
        if (ready) return errorResponse(request.id, 'stale_snapshot', '已继续；请重新观察窗口后再决定操作');
      }
      return errorResponse(request.id, 'permission_timeout', '等待继续超时；请重新发起任务');
    }
    if (request.method !== 'desktop_observe' || !request.waitForPermission) return this.handleOnce(request);
    for (;;) {
      const revision = this.decision;
      const response = await this.handleOnce(request);
      const code = errorCode(response);
      if (code !== 'permission_required' && code !== 'user_paused') return response;
      if (!await this.waitDecision(revision, deadline)) {
        return errorResponse(request.id, 'permission_timeout', '等待授权超时；请重新发起任务');
      }
      if (generation !== this.helperGeneration) return gone();
      if (!await this.enqueue(() => this.pending?.session === request.sessionId)) return errorResponse(request.id, 'stopped', '任务已停止');
    }
  }

  private handleOnce(request: ControlRequest): Promise<ControlResponse> {
    const { id, sessionId: session } = request;
    if (request.method === 'desktop_cancel') {
      if (!validSession(session) || !this.interruption.interruptSession(session)) {
        return Promise.resolve(errorResponse(id, 'session_not_granted', '此会话没有待执行的桌面任务', false));
      }
      this.acting?.abort();
      // The interruption is at once; the cleanup waits for the request in flight.
      void this.enqueue(() => {
        const c = this.consent;
        const owner = !c.stopped && this.now() < c.expiresAt ? c.sessionId : this.pending?.session;
        if (owner !== session || !this.interruption.isStopped) return;
        c.revoke();
        this.pending = null;
        this.userPaused = false;
        this.snapshots.clear();
        this.active = false;
        this.publish('paused', '任务已取消');
        this.notify();
      });
      return Promise.resolve(okResponse(id, { cancelled: true, cleanup_pending: true }));
    }
    if (request.method === 'desktop_release') {
      if (!validSession(session)) return Promise.resolve(errorResponse(id, 'invalid_request', '请求缺少会话或方法', false));
      if (this.interruption.interruptSession(session)) this.acting?.abort();
      return this.enqueue(() => {
        const owned = this.consent.sessionId === session, asked = this.pending?.session === session;
        const released = this.consent.release(session, this.now());
        if (!owned && !asked) return okResponse(id, { released: false });
        if (asked) this.pending = null;
        if (owned) {
          this.userPaused = false;
          this.snapshots.clear();
          this.active = false;
        }
        if (this.shown.phase === 'completed' || this.shown.phase === 'failed') this.publish(this.shown.phase, this.shown.action, false);
        else this.publish('ready', DEFAULT_ACTION, false);
        this.notify();
        return okResponse(id, { released });
      });
    }
    return this.enqueue(async () => {
      try {
        const method = request.method;
        if (!validSession(session) || method === null) throw new ControlError('invalid_request', '请求缺少会话或方法');
        const params = request.params;
        if (method === 'desktop_status') return okResponse(id, await this.status(session, params));
        if (!this.ports.enabled()) {
          this.consent.revoke();
          throw new ControlError('disabled', '电脑操作未启用：设置 › 能力 中启用后重启后台');
        }
        if (!['desktop_observe', 'desktop_act', 'desktop_verify'].includes(method)) throw new ControlError('unknown_method', '未知的桌面工具');
        if (method !== 'desktop_observe' && this.userPaused && this.consent.sessionId === session) {
          throw new ControlError('user_paused', '用户已接管；请在授权卡点击继续并重新观察');
        }
        if (method === 'desktop_observe') return okResponse(id, await this.observe(session, params));
        if (method === 'desktop_act') return okResponse(id, await this.act(session, params));
        return okResponse(id, await this.verify(session, params));
      } catch (e) {
        if (e instanceof ControlError) {
          if (e.code !== 'permission_required' && e.code !== 'user_paused') this.publish('failed', e.message);
          return errorResponse(id, e.code, e.message, false);
        }
        this.ports.log(`computer control: ${String(e)}`);
        this.publish('failed', '桌面工具未能完成');
        return errorResponse(id, 'native_error', '桌面工具未能完成', false);
      }
    });
  }

  private async status(session: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const enabled = this.ports.enabled();
    const c = this.consent, now = this.now();
    if (!enabled) {
      c.revoke();
      this.snapshots.clear();
      this.publish('disabled', MESSAGES.disabled);
    }
    const system = await this.systemPermissions();
    const live = c.sessionId === session && !c.stopped && now < c.expiresAt;
    const granted = c.granted(now);
    const status: Record<string, unknown> = {
      enabled, ax_trusted: system.ax, screen_capture: system.screen, session_granted: live, paused: this.userPaused && c.sessionId === session,
      permissions: live ? PERMISSIONS.filter((p) => granted.has(p)) : [], input_monitor_ready: this.inputMonitorAvailable, driver: DRIVER,
      actions: [...this.actions],
    };
    const target = obj(params.target);
    if (enabled && target) status.windows = await this.statusTargets(target);
    return status;
  }

  /** One app's windows the rules let through, ids and geometry only, at most 32. */
  private async statusTargets(raw: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const pid = requestedInteger(raw, 'pid', PID_MAX), bundle = typeof raw.bundle_id === 'string' ? raw.bundle_id : null;
    if (pid === null && bundle === null) throw new ControlError('target_required', '请指定应用bundle_id或pid');
    const ownPids = this.ports.ownPids();
    let app;
    try {
      app = chooseApp(decodeApps(await this.call('apps.running', {})), pid, bundle, ownPids);
    } catch (e) {
      if (e instanceof ControlError && e.code === 'target_ambiguous') throw new ControlError('target_ambiguous', '应用不唯一或尚未运行');
      throw e;
    }
    const refusal = appRefusal(app, this.ports.blacklist(), ownPids);
    if (refusal) throw refusal;
    const windows = decodeWindows(await this.call('windows.list', { pid: app.pid, layer0_only: true, include_titles: true }));
    return windows.filter((w) => w.pid === app.pid && titleRefusal(app, w.title, this.ports.blacklist(), ownPids) === null).slice(0, 32)
      .map((w) => ({ window_id: w.windowId, pid: app.pid, bundle_id: app.appId, bounds: w.bounds }));
  }

  /** The one running app and its one visible window the request names, or why not. Every
   *  observe, act and verify passes the title rules here. */
  private async resolve(raw: Record<string, unknown>): Promise<{ target: ControlTarget }> {
    const pid = requestedInteger(raw, 'pid', PID_MAX), bundle = typeof raw.bundle_id === 'string' ? raw.bundle_id : null;
    const ownPids = this.ports.ownPids();
    const app = chooseApp(decodeApps(await this.call('apps.running', {})), pid, bundle, ownPids);
    const refusal = appRefusal(app, this.ports.blacklist(), ownPids);
    if (refusal) throw refusal;
    const windows = decodeWindows(await this.call('windows.list', { pid: app.pid, layer0_only: true, include_titles: true }))
      .filter((w) => w.pid === app.pid);
    const requested = requestedInteger(raw, 'window_id', WINDOW_ID_MAX);
    const candidates = windows.filter((w) => requested === null || w.windowId === requested);
    if (candidates.length !== 1) throw new ControlError('target_ambiguous', '需要指定唯一的可见window_id；不会替你选择其它窗口');
    const w = candidates[0];
    const titled = titleRefusal(app, w.title, this.ports.blacklist(), ownPids);
    if (titled) throw titled;
    this.names.set(app.pid, app.name);
    return { target: { bundleId: app.appId, pid: app.pid, windowId: w.windowId, launchedAt: app.launchedAt, frame: w.bounds } };
  }

  private async current(target: ControlTarget): Promise<void> {
    const fresh = await this.resolve({ pid: target.pid, window_id: target.windowId });
    if (!sameTarget(fresh.target, target)) throw new ControlError('target_changed', '目标进程、窗口或几何已改变，请重新观察并授权');
  }

  private require(permission: ControlPermission, session: string, target: ControlTarget): void {
    const c = this.consent;
    if (!this.ports.enabled()) {
      c.revoke();
      throw new ControlError('disabled', '电脑操作已关闭');
    }
    try {
      c.check(session, target, permission, this.now());
    } catch {
      c.targetRequested(session, target);
      if (c.sessionId !== null && c.sessionId !== session && this.now() < c.expiresAt && !c.stopped) {
        throw new ControlError('desktop_busy', '另一个会话正在使用此桌面，请先停止它');
      }
      if (this.pending?.session !== session || !sameTarget(this.pending.target, target)) {
        this.pending = { id: this.ports.newId(), session, target };
        this.interruption.prepare(session);
      }
      this.publish('waitingPermission', MESSAGES.waiting);
      throw new ControlError('permission_required', `请在角色头顶小窗授权 ${permission}，然后重试；不要循环轮询`);
    }
    if (this.userPaused) throw new ControlError('user_paused', '用户已接管；请在授权卡点击继续');
    if (this.interruption.isStopped) throw new ControlError('stopped', '用户已停止此任务');
    if (permission === 'control' && !this.inputMonitorAvailable) {
      throw new ControlError('input_monitor_unavailable', '用户接管监听未就绪，不执行操作；请重新打开App后再试');
    }
  }

  private async observe(session: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { target } = await this.resolve(obj(params.target) ?? params);
    this.require('observation', session, target);
    const text = params.include_text === true, image = params.include_image === true;
    if (text) this.require('text', session, target);
    if (image) this.require('image', session, target);
    this.publish('observing', '正在读取已授权窗口的有限控件摘要');
    const r = await this.call('control.observe', { pid: target.pid, window_id: target.windowId, include_text: text, include_image: image });
    await this.current(target);
    this.require('observation', session, target);
    if (image) this.require('image', session, target);
    const snapshotId = typeof r.snapshot_id === 'string' ? r.snapshot_id : '';
    if (snapshotId === '') throw new ControlError('native_error', '桌面工具未能完成');
    this.consent.snapshot(session, target, this.now(), snapshotId);
    const elements = observedElements(r.elements, text);
    this.snapshots = new Map([[snapshotId, { target, elements: new Set(elements.map((e) => e.element_id as string)) }]]);
    this.active = true;
    const result: Record<string, unknown> = { snapshot_id: snapshotId, target: targetJSON(target), elements, truncated: r.truncated === true,
      text_truncated: r.text_truncated === true, expires_in_s: 15 };
    const picture = obj(r.image);
    if (image && picture && typeof picture.data === 'string') result.image = { mime_type: 'image/png', data: picture.data };
    this.publish('ready', `已返回 ${elements.length} 个控件；只对这次观察执行操作`);
    return result;
  }

  private async valid(session: string, params: Record<string, unknown>, permission: ControlPermission) {
    const id = params.snapshot_id;
    const snap = typeof id === 'string' ? this.snapshots.get(id) : undefined;
    if (typeof id !== 'string' || snap === undefined) throw new ControlError('stale_snapshot', '请先取得新的desktop_observe结果');
    await this.current(snap.target);
    this.require(permission, session, snap.target);
    this.consent.validate(id, session, snap.target, permission, this.now());
    return { id, ...snap };
  }

  private async act(session: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { id, target, elements } = await this.valid(session, params, 'control');
    if (this.now() - this.lastActionAt < ACTION_GAP_SECONDS) throw new ControlError('action_cooldown', '操作间隔太短，请先检查结果');
    const action = params.action;
    if (typeof action !== 'string') throw new ControlError('invalid_action', '缺少动作类型');
    if (!this.actions.includes(action)) throw new ControlError('unsupported', `只支持${this.actions.join('/')}`);
    this.publish('executing', `正在执行 ${action}；你的输入可随时中止`);
    const text = action === 'set_value' || action === 'type';
    if (text) this.require('text', session, target);
    const elementId = params.element_id;
    const helperParams = actParams(id, params, target.frame, typeof elementId === 'string' && elements.has(elementId));
    if (this.interruption.isStopped) {
      throw action === 'click' || action === 'scroll' ? new ControlError('stopped', '操作已停止') : new ControlError('action_refused', '控件未接受动作；请观察结果，不要盲目重放');
    }
    this.consumeSnapshot(text);
    const acting = this.acting = new AbortController();
    const r = await this.call('control.act', helperParams, acting.signal).finally(() => { this.acting = null; });
    this.lastActionAt = this.now();
    const effect = r.effect === 'confirmed' ? 'confirmed' : 'unverifiable';
    // A desktop mutation invalidates every old target reference. Verify starts from a fresh observation.
    this.publish('verifying', effect === 'confirmed' ? '已读回确认文字；后续操作需新观察' : '动作已发送，效果尚未确认；请重新观察后验证');
    return { action_id: this.ports.newId(), effect, verified: effect === 'confirmed', requires_fresh_observation: true, target: targetJSON(target) };
  }

  private async verify(session: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { id, target, elements } = await this.valid(session, params, 'observation');
    this.publish('verifying', '正在读取控件以检查结果');
    const ref = params.element_id;
    if (typeof ref !== 'string' || !elements.has(ref)) throw new ControlError('element_required', '验证需要新观察中的element_id');
    const expectedValue = typeof params.expected_value === 'string' ? params.expected_value : null;
    const expectedTitle = typeof params.expected_title === 'string' ? params.expected_title : null;
    if (expectedValue === null && expectedTitle === null) return { effect: 'unknown', verified: false, reason: '需要明确预期值或标题' };
    this.require('text', session, target);
    const r = await this.call('control.read', { snapshot_id: id, element_id: ref });
    const ok = (expectedValue === null || r.value === expectedValue) && (expectedTitle === null || r.title === expectedTitle);
    await this.current(target);
    this.require('observation', session, target);
    this.publish(ok ? 'completed' : 'ready', ok ? '已读回确认预期结果' : '当前读数不符合预期；没有自动重放动作');
    return { effect: ok ? 'confirmed' : 'unsatisfied', verified: ok };
  }

  private consumeSnapshot(text: boolean): void {
    this.consent.consumeControl(text);
    this.consent.invalidateSnapshots();
    this.snapshots.clear();
  }

  private stopWith(message: string): Promise<void> {
    this.interrupt();
    return this.enqueue(() => {
      this.consent.revoke();
      this.pending = null;
      this.userPaused = false;
      this.snapshots.clear();
      this.active = false;
      this.publish('paused', message);
      this.notify();
    });
  }

  private revoke(permission: ControlPermission, challenge: Challenge): Promise<void> {
    // Interrupt any in-flight action before the narrower grant applies.
    const ticket = this.interrupt();
    return this.enqueue(() => {
      const c = this.consent;
      if (this.pending !== challenge || c.sessionId !== challenge.session || !sameTarget(c.target, challenge.target)) {
        return this.publish('waitingPermission', '授权目标已更新，请重新选择权限');
      }
      c.revokeOne(permission);
      this.snapshots.clear();
      this.active = false;
      if (!(this.userPaused || this.interruption.activate(ticket, challenge.session))) return this.publish('paused', '任务已停止');
      this.publish(this.userPaused ? 'paused' : 'ready', '权限已取消；其他勾选项保持不变。');
      this.notify();
    });
  }

  /** Stops at once, and cancels the act at the helper. */
  private interrupt(): number {
    this.acting?.abort();
    return this.interruption.interrupt();
  }

  /** The panel state of now, published with the challenge it shows. */
  private publish(phase: ComputerUsePhase, action: string, raise = true): void {
    this.shown = { phase, action };
    const c = this.consent, p = this.pending, now = this.now();
    const target = p?.target ?? c.target;
    const sameGrant = p === null || (p.session === c.sessionId && sameTarget(p.target, c.target));
    const granted = c.granted(now);
    const permissions: ComputerUsePanelState['permissions'] = {};
    for (const q of PERMISSIONS) {
      const allowed = sameGrant && !c.stopped && now < c.expiresAt && granted.has(q);
      const system = q === 'image' ? this.system.screen : this.system.ax;
      permissions[q] = allowed ? 'allowed' : system === false ? 'systemPermissionRequired' : 'off';
    }
    this.presented = p;
    this.update({
      phase, targetApp: target ? this.names.get(target.pid) ?? null : null, action,
      scopeChips: target ? [`窗口 ${target.windowId}`, `会话 ${(p?.session ?? c.sessionId ?? '').slice(-12)}`, '10分钟'] : [],
      permissions, pendingGrants: [], showsPermissionChoices: p !== null && this.ports.enabled(),
      canResume: this.userPaused && (p?.session ?? null) === c.sessionId && sameTarget(p?.target ?? null, c.target) && c.sessionId !== null
        && !c.stopped && now < c.expiresAt,
      challenge: p?.id ?? null,
    }, raise);
    this.scheduleExpiryRefresh();
  }

  private update(next: ComputerUsePanelState, raise = true): void {
    if (this.stopped) return;
    this.panel = displayState(next);
    this.events.send(computerUseState(this.panel));
    this.onPanel(this.panel, raise);
  }

  /** A grant that runs out by itself is shown so, not left 已允许. */
  private scheduleExpiryRefresh(): void {
    this.expiryRefresh += 1;
    this.cancelExpiry?.();
    this.cancelExpiry = null;
    const now = this.now(), at = this.consent.nextExpiry(now);
    if (at === null) return;
    const generation = this.expiryRefresh;
    this.cancelExpiry = this.ports.after(Math.max(0, at - now) * 1000, () => void this.enqueue(() => {
      if (generation !== this.expiryRefresh) return;
      this.publish(this.userPaused ? 'paused' : 'waitingPermission',
        this.now() < this.consent.expiresAt ? '本次操作授权已用完或已过期，需要重新允许' : '本次任务授权已过期', false);
    }));
  }

  private now(): number {
    return this.ports.now() / 1000;
  }

  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => {});
    return run;
  }

  private notify(): void {
    this.decision += 1;
    for (const wake of [...this.waiters]) wake();
  }

  /** True once a decision came after `after`, false at `deadline` (Unix ms). */
  private waitDecision(after: number, deadline: number): Promise<boolean> {
    if (this.decision !== after) return Promise.resolve(true);
    const left = deadline - this.ports.now();
    if (left <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        this.waiters.delete(wake);
        cancel();
        resolve(v);
      };
      const wake = () => done(true);
      this.waiters.add(wake);
      const cancel = this.ports.after(left, () => done(this.decision !== after));
    });
  }

  private async call(op: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const r = await this.ports.helper.request(op, params, signal);
    // The helper may have acted before the cancel reached it; a stopped request's success is not one.
    if (signal?.aborted) throw new ControlError('stopped', '操作已停止');
    if (r.ok) return r.result;
    this.ports.log(`computer control: ${op} failed code=${r.error.code}`);
    throw helperFailure(r.error.code);
  }

  private async systemPermissions(): Promise<{ ax: boolean; screen: boolean }> {
    const r = await this.ports.helper.request('permissions.status', {});
    // notApplicable: the platform has no such permission (Windows).
    const given = (state: unknown) => state === 'granted' || state === 'notApplicable';
    const system = { ax: r.ok && given(r.result.accessibility), screen: r.ok && given(r.result.screenRecording) };
    this.system = system;
    return system;
  }

  private async watchInput(): Promise<void> {
    const r = await this.ports.helper.request('input.watch', { enabled: true });
    this.inputMonitorAvailable = r.ok;
    if (!r.ok) this.ports.log(`computer control: input.watch failed code=${r.error.code}`);
  }

  private async listen(): Promise<void> {
    const { path, tokenFile } = this.ports.endpoint;
    const r = await this.ports.helper.request('control.listen', { endpoint: path, token_file: tokenFile });
    if (!r.ok) this.ports.log(`computer control: control.listen failed code=${r.error.code}`);
    await this.watchInput();
    await this.systemPermissions();
  }
}

/** Over the helper: the endpoint, the input monitor and the system permissions are asked for. */
export function startControl(ports: ControlPorts, platform: ShellPlatform = shellPlatform()): ControlHost {
  const host = new ControlHost(ports, platform);
  void host.start();
  return host;
}
