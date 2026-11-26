// The screen context and selection capture over the platform helper: while agentd
// runs, the front window's AX text goes to `POST /context/text` on its own triggers, and the feed's `request`s are answered
// with a window's text, OCR text or screenshot (`/context/text`, `/context/image`). Logs metadata only, never window text,
// titles or URLs.
import { type AttentionSample, type BlacklistRules, decodeAttention } from '../../common/attention.ts';
import { type CaptureWindow, captureBlockReason } from '../../common/capture-rules.ts';
import type { HelperAnswer } from '../../common/push-to-talk.ts';
import {
  type AgentdReply, allowsAutomaticText, allowsOCR, allowsRequest, axObservation, type CaptureFailure,
  captureFailure, captureTargetChange, CaptureTriggers, ContextConsent, type ContextPolicy, type ContextResult, contextImageBody,
  contextTextBodies, decideSelection, decodeWindows, type FeedRequest, feedRequest, firstClipItem, frontWindow, imageFailureBody,
  imageResult, type LookResult, lookResult, lookTitle, namedWindow, type Observation, ocrObservation, OwnCapture,
  resultText, scalarCount, SELECTION_LIMIT, selectionBlockReason, type SelectionDecision, textResult, windowNow, windowReadPlan,
} from '../../common/screen-context.ts';
import type { UserAnswer } from '../attention/sampler.ts';

export interface ContextPorts {
  helper: { request(op: string, params?: Record<string, unknown>): Promise<HelperAnswer> };
  /** A POST to agentd; status 0 when agentd could not be reached. */
  post(path: string, body: Record<string, unknown>): Promise<AgentdReply>;
  /** `<agentd_state_dir>/blacklist.json`'s rules now. */
  blacklist(): BlacklistRules;
  /** Read at each tick, request and send: config.json's screen context settings (`contextPolicy`). */
  policy(): ContextPolicy;
  /** AttentionSampler.user: whether the user is away, and when an absence ends, for the automatic reads. */
  user(): UserAnswer;
  /** This shell's processes (main and helper), never read. */
  ownPids(): readonly number[];
  /** A fresh snapshot id for an OCR read. */
  newId(): string;
  /** Unix milliseconds. */
  now(): number;
  /** Runs `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void;
  /** Runs `fn` once after `ms` unless the returned function is called first. */
  after(ms: number, fn: () => void): () => void;
  log(line: string): void;
}

const TICK_MS = 1000;
/** How long a read waits for the attention beat that says which window is in front after it. */
const SAMPLE_WAIT_MS = 2500;
/** ContextCapturer.observe's notifications, under the helper's names. */
const NOTIFICATIONS = ['value', 'title', 'focus'];
const WATCH_ID = 'context';

export class ContextCapturer {
  private readonly ports: ContextPorts;
  private readonly consent: ContextConsent;
  private readonly own = new OwnCapture();
  private triggers = new CaptureTriggers();
  /** The last accepted signature per window, for automatic reads. */
  private lastSent = new Map<number, string>();
  private cancelTick: (() => void) | null = null;
  private sample: AttentionSample | null = null;
  private waiters: ((s: AttentionSample | null) => void)[] = [];
  private reading = false;
  /** A focused-element read is in flight; a slow helper would otherwise queue one per tick. */
  private sampling = false;
  private sending: Promise<void> = Promise.resolve();
  /** The pid the `context` watch is on. */
  private observedPid: number | null = null;
  /** An unfinished `ax.window_text` walk, continued by the next automatic or front-window read of the same app and level. */
  private walk: { pid: number; level: string; cursor: string } | null = null;

  constructor(ports: ContextPorts) {
    this.ports = ports;
    this.consent = new ContextConsent(ports.policy());
  }

  private get running(): boolean {
    return this.cancelTick !== null;
  }

  private get policy(): ContextPolicy {
    return this.consent.policy;
  }

  /** Each AttentionSampler sample (`onSample`). */
  update(sample: AttentionSample): void {
    this.sample = sample;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(sample);
  }

  /** agentd is up. A restarted agentd has forgotten every window's text, so the dedup and trigger
   *  state start over. */
  start(): void {
    if (this.running) return;
    this.consent.invalidate();
    this.triggers = new CaptureTriggers();
    this.lastSent = new Map();
    this.cancelTick = this.ports.every(TICK_MS, () => this.tick());
  }

  /** Reads in flight are dropped and the watch stops. */
  stop(): void {
    this.consent.invalidate();
    this.cancelTick?.();
    this.cancelTick = null;
    void this.observe(null);
  }

  /** The helper said hello (true) or went (false); a new helper has no watches and no walks. */
  helper(_running: boolean): void {
    this.observedPid = null;
    this.walk = null;
  }

  /** A helper event; only the `context` watch's `ax.notification` is read. */
  event(name: string, data: Record<string, unknown>): void {
    if (name !== 'ax.notification' || data.watch_id !== WATCH_ID || this.observedPid === null || data.pid !== this.observedPid) return;
    this.triggers.axNotified(this.seconds());
  }

  /** Every `/feed` event; `request`s are handled only between `start()` and `stop()`. */
  feed(e: { event: string; data: string }): void {
    if (!this.running) return;
    const request = feedRequest(e);
    if (request) void this.handle(request);
  }

  /** For the attention sampler's `ownCaptureRecent`: a screenshot or OCR of ours is running or just ended. */
  ownCaptureRecent(): boolean {
    return this.own.recent(this.ports.now());
  }

  /** ContextCapturer.lookNow: asks agentd to look at the front window; the front window's title when it was asked. */
  async look(): Promise<{ title: string | null; result: LookResult }> {
    const title = lookTitle(this.sample);
    const result = lookResult(await this.ports.post('/look', {}));
    this.ports.log(`LOOK result=${resultText(result)}`);
    return { title, result };
  }

  /** For `hotkey_selection`: the front app's selected text, else the clipboard's, after the secure
   *  input, blacklist and incognito checks of the window in front now, made again after the selection read; and the front
   *  app's name. */
  async readSelection(): Promise<{ decision: SelectionDecision; app: string | null }> {
    const { secureInput, front } = await this.frontNow();
    const pid = front?.window.pid ?? null;
    const decision = await decideSelection(secureInput,
      secureInput ? null : selectionBlockReason(front, this.ports.blacklist(), this.ports.ownPids()),
      async () => {
        if (pid === null) return null;
        const r = await this.ports.helper.request('ax.selected_text', { pid });
        return r.ok && typeof r.result.text === 'string' ? r.result.text : null;
      },
      async () => {
        const again = await this.frontNow();
        if (again.secureInput) return 'secure_input';
        if (again.front?.window.windowId !== front?.window.windowId || again.front?.window.pid !== pid) return 'no_window';
        return selectionBlockReason(again.front, this.ports.blacklist(), this.ports.ownPids());
      },
      async () => {
        const r = await this.ports.helper.request('clipboard.read', { first_only: true });
        return r.ok ? firstClipItem(r.result) : null;
      },
      SELECTION_LIMIT);
    switch (decision.kind) {
      case 'read':
        this.ports.log(`SELECTION read source=${decision.read.source} chars=${scalarCount(decision.read.text)} truncated=${decision.read.truncated}`);
        break;
      case 'refused':
        this.ports.log(`SELECTION refused ${decision.message}`);
        break;
      case 'empty':
        this.ports.log('SELECTION empty');
        break;
    }
    return { decision, app: front?.window.app ?? null };
  }

  private seconds(): number {
    return this.ports.now() / 1000;
  }

  /** Local consent narrows on save even while agentd is still waiting for a restart. */
  private refreshPolicy(): void {
    if (!this.consent.configure(this.ports.policy())) return;
    this.triggers = new CaptureTriggers();
    this.lastSent = new Map();
  }

  /** Moves the `context` watch to `pid`'s app; null stops it. */
  private async observe(pid: number | null): Promise<void> {
    if (pid === this.observedPid) return;
    this.observedPid = pid;
    const r = await this.ports.helper.request('ax.watch', { watch_id: WATCH_ID, pid, notifications: pid === null ? [] : NOTIFICATIONS });
    if (!r.ok && pid !== null) this.ports.log(`CAPTURE ax.watch failed pid=${pid} code=${r.error.code}`);
  }

  /** The window in front now by the helper's `attention.sample`, with the browser state of the attention beat that shows
   *  the same window (the last one, else the next); null when no beat does. A helper that does not answer counts as
   *  secure input. */
  private async frontNow(): Promise<{ secureInput: boolean; front: CaptureWindow | null }> {
    const r = await this.ports.helper.request('attention.sample', {});
    if (!r.ok) return { secureInput: true, front: null };
    const raw = decodeAttention(r.result);
    if (raw.secureInput) return { secureInput: true, front: null };
    const pid = raw.front?.pid ?? null, windowId = raw.front?.window?.windowId ?? null;
    const shows = (s: AttentionSample | null) => s !== null && (s.front?.pid ?? null) === pid && (s.front?.windowId ?? null) === windowId;
    const s = shows(this.sample) ? this.sample : await this.nextSample();
    return { secureInput: false, front: s !== null && shows(s) ? frontWindow({ ...s, secureInput: false }) : null };
  }

  /** IsSecureEventInputEnabled through `attention.sample`; a helper that does not answer counts as secure input. */
  private async secureInputNow(): Promise<boolean> {
    const r = await this.ports.helper.request('attention.sample', {});
    return !r.ok || r.result.secure_input === true;
  }

  /** AXIsProcessTrusted: `permissions.status`'s accessibility (Windows has none to grant). */
  private async axTrusted(): Promise<boolean> {
    const r = await this.ports.helper.request('permissions.status', {});
    return r.ok && (r.result.accessibility === 'granted' || r.result.accessibility === 'notApplicable');
  }

  /** The system-wide focused element's key; `trusted` is false only when the helper lacks the Accessibility permission. */
  private async focusedKey(): Promise<{ trusted: boolean; key: string | null }> {
    const r = await this.ports.helper.request('ax.focused', {});
    if (!r.ok) return { trusted: r.error.code !== 'permission_denied', key: null };
    const focus = r.result.focus;
    const key = typeof focus === 'object' && focus !== null ? (focus as Record<string, unknown>).element_key : null;
    return { trusted: true, key: typeof key === 'string' ? key : null };
  }

  /** ContextCapturer.captureWindowNow over `windows.list`. */
  private async windowNow(windowId: number): Promise<ReturnType<typeof windowNow>> {
    const list = await this.ports.helper.request('windows.list', { include_titles: true });
    if (!list.ok) return null;
    const secureInput = await this.secureInputNow();
    return windowNow(decodeWindows(list.result), windowId, this.sample, secureInput);
  }

  /** The next attention beat; null when none comes in time (locked, asleep or the sampler stopped). */
  private nextSample(): Promise<AttentionSample | null> {
    return new Promise((resolve) => {
      let done = false;
      let cancel = () => {};
      const finish = (s: AttentionSample | null) => {
        if (done) return;
        done = true;
        cancel();
        resolve(s);
      };
      cancel = this.ports.after(SAMPLE_WAIT_MS, () => finish(null));
      this.waiters.push(finish);
    });
  }

  /** ContextCapturer.frontAfterRead: AX reads whichever window the app has focused when the read runs, so the text is sent
   *  only if `window` is still the front window and still allowed at the next beat; returns the window as it is then. */
  private async frontAfterRead(window: CaptureWindow, id: string): Promise<CaptureWindow | null> {
    const generation = this.consent.generation;
    const s = await this.nextSample();
    // The wait is this shell's own: a stop or a consent change during it drops the text.
    if (!s || s.locked || s.asleep || generation !== this.consent.generation) return null;
    const now = frontWindow(s);
    if (captureTargetChange(window, now, this.ports.blacklist(), this.ports.ownPids()) !== null) {
      this.ports.log(`CAPTURE text_dropped id=${id} window=${window.window.windowId ?? 0} reason=window_changed`);
      return null;
    }
    return now;
  }

  /** Sends start one after another, never two at once; a send queued under an older consent is dropped. */
  private serially(body: () => Promise<void>): void {
    const generation = this.consent.generation;
    this.sending = this.sending.then(async () => {
      this.refreshPolicy();
      if (this.consent.generation !== generation) return;
      await body();
    });
  }

  private tick(): void {
    this.refreshPolicy();
    const p = this.policy, sample = this.sample, front = sample?.front ?? null;
    if (!p.allowText || p.level === 'status' || !sample || sample.locked || sample.asleep || !front || front.windowId === null) {
      void this.observe(null);
      return;
    }
    const windowId = front.windowId;
    const window: CaptureWindow = { window: front, incognito: sample.frontIncognito, secureInput: sample.secureInput };
    void this.observe(captureBlockReason(window, this.ports.blacklist(), this.ports.ownPids()) === null ? front.pid : null);
    if (this.sampling) return;
    this.sampling = true;
    void this.automatic(sample, window, windowId);
  }

  /** One tick's automatic read of the front window `windowId`, when the triggers fire. */
  private async automatic(sample: AttentionSample, window: CaptureWindow, windowId: number): Promise<void> {
    const generation = this.consent.generation, level = this.policy.level;
    const focused = await this.focusedKey();
    this.sampling = false;
    const current = this.sample;
    if (generation !== this.consent.generation || !allowsAutomaticText(this.policy, focused.trusted) || !current || current.locked
      || current.asleep || current.front?.windowId !== windowId) return;
    const front = window.window;
    const fire = this.triggers.update(this.seconds(), windowId, front.bundleId ?? front.app, focused.key ?? sample.focusRole,
      this.ports.user());
    if (!fire || this.reading || front.pid === null) return;
    if (captureBlockReason(window, this.ports.blacklist(), this.ports.ownPids()) !== null) return;
    this.reading = true;
    try {
      const observation = await this.axText(front.pid, level);
      if (generation !== this.consent.generation || !allowsAutomaticText(this.policy, true) || !observation) return;
      const now = await this.frontAfterRead(window, '-');
      if (!now) return;
      this.serially(async () => {
        if (generation !== this.consent.generation || !allowsAutomaticText(this.policy, true)) return;
        const target = await this.frontAfterRead(now, '-');
        if (!target) return;
        const result = await this.sendText(target, observation.text, 'ax', null, observation);
        if (result?.kind === 'accepted') this.triggers.contentChanged();
        this.ports.log(`CAPTURE text window=${windowId} source=ax chars=${scalarCount(observation.text)} result=${resultText(result)}`);
      });
    } finally {
      this.reading = false;
    }
  }

  /** The app's focused window at `level`, continuing an unfinished walk of the same app and level; null for our own
   *  processes, a refused read or no focused window. */
  private async axText(pid: number, level: string): Promise<Observation | null> {
    if (this.ports.ownPids().includes(pid)) return null;
    const params: Record<string, unknown> = { pid, level };
    if (this.walk && this.walk.pid === pid && this.walk.level === level) params.cursor = this.walk.cursor;
    const redact = this.policy.redact;
    const r = await this.ports.helper.request('ax.window_text', params);
    this.walk = null;
    if (!r.ok) return null;
    const read = axObservation(r.result, redact);
    if (!read.matched) return null;
    const cursor = read.observation.coverage.nextCursor;
    if (cursor !== null) this.walk = { pid, level, cursor };
    return read.observation;
  }

  /** The window whose CG bounds are `bounds` at `level`; `matched` is false when the helper found no single such window. */
  private async axWindowText(pid: number, bounds: unknown, level: string, redact: boolean): Promise<{ matched: boolean; observation: Observation | null }> {
    if (this.ports.ownPids().includes(pid)) return { matched: false, observation: null };
    const r = await this.ports.helper.request('ax.window_text', { pid, level, window_bounds: bounds });
    if (!r.ok) return { matched: false, observation: null };
    const read = axObservation(r.result, redact);
    return read.matched ? read : { matched: false, observation: null };
  }

  /** A capture of ours (screenshot or OCR) lights the capture indicator, which the attention sampler must not count. */
  private async capture(op: string, params: Record<string, unknown>): Promise<HelperAnswer> {
    this.own.note(1, this.ports.now());
    try {
      return await this.ports.helper.request(op, params);
    } finally {
      this.own.note(-1, this.ports.now());
    }
  }

  private async handle(request: FeedRequest): Promise<void> {
    this.refreshPolicy();
    const log = this.ports.log, id = request.requestId;
    // The image path never required the front window, so only a look_window text request takes its own branch.
    if (request.reason === 'look_window' && request.mode === 'text') return this.readWindowText(request);
    if (!allowsRequest(this.policy, request.mode)) {
      log(`CAPTURE request_blocked id=${id} reason=local_policy`);
      if (request.mode === 'image') this.reportFailure(request, namedWindow(request.windowId), 'permission_denied');
      return;
    }
    if (this.reading) return log(`CAPTURE request_dropped id=${id} reason=read_busy`);
    const found = await this.windowNow(request.windowId);
    if (!found) {
      log(`CAPTURE request_dropped id=${id} reason=no_window`);
      if (request.mode === 'image') this.reportFailure(request, namedWindow(request.windowId), 'window_gone');
      return;
    }
    const window = found.window, pid = found.window.window.pid!;
    const isFront = this.sample?.front?.windowId === request.windowId;
    const reason = captureBlockReason(window, this.ports.blacklist(), this.ports.ownPids());
    if (reason !== null) {
      log(`CAPTURE request_blocked id=${id} reason=${reason}`);
      if (request.mode === 'image') this.reportFailure(request, window, 'permission_denied');
      return;
    }
    switch (request.mode) {
      case 'text':
        // AX reads the app's focused window, which is the requested one only when it is the front window.
        if (!isFront || !(await this.axTrusted())) {
          if (allowsOCR(this.policy)) return this.answerWithOCR(request, window);
          return log(`CAPTURE request_blocked id=${id} reason=ax_unavailable`);
        }
        return this.answerWithText(request, window, pid);
      case 'ocr':
        return this.answerWithOCR(request, window);
      case 'image':
        return this.answerWithImage(request, window);
      default:
        log(`CAPTURE request_dropped id=${id} reason=unknown_mode`);
    }
  }

  private async answerWithText(request: FeedRequest, window: CaptureWindow, pid: number): Promise<void> {
    if (this.reading) return this.ports.log(`CAPTURE request_dropped id=${request.requestId} reason=read_busy`);
    this.reading = true;
    const generation = this.consent.generation, level = this.policy.level;
    try {
      const observation = await this.axText(pid, level);
      if (generation !== this.consent.generation || !allowsAutomaticText(this.policy, true)) return;
      if (!observation) {
        // A failed AX read never silently broadens the requested content scope.
        this.ports.log(`CAPTURE request_blocked id=${request.requestId} reason=ax_empty`);
        return;
      }
      const now = await this.frontAfterRead(window, request.requestId);
      if (!now) return;
      this.serially(async () => {
        if (!allowsAutomaticText(this.policy, true)) return;
        const target = await this.frontAfterRead(now, request.requestId);
        if (!target) return;
        this.logRequest(request, await this.sendText(target, observation.text, 'ax', request.requestId, observation));
      });
    } finally {
      this.reading = false;
    }
  }

  private async answerWithImage(request: FeedRequest, window: CaptureWindow): Promise<void> {
    if (this.reading) return this.ports.log(`CAPTURE request_dropped id=${request.requestId} reason=read_busy`);
    this.reading = true;
    const generation = this.consent.generation, id = request.requestId;
    try {
      const shot = await this.capture('capture.window', { window_id: request.windowId, format: 'jpeg', max_long_side: 1280 });
      if (!shot.ok) {
        this.ports.log(`CAPTURE request_failed id=${id} mode=image error=${shot.error.code}`);
        this.reportFailure(request, window, captureFailure(shot.error.code));
        return;
      }
      if (generation !== this.consent.generation || !this.policy.allowImages) return;
      const image = shot.result.image as Record<string, unknown> | undefined;
      const jpeg = image?.format === 'jpeg' && typeof image.data === 'string' ? image.data : null;
      if (jpeg === null) {
        this.ports.log(`CAPTURE request_failed id=${id} mode=image error=jpeg_encode`);
        this.reportFailure(request, window, 'capture_failed');
        return;
      }
      const change = captureTargetChange(window, (await this.windowNow(request.windowId))?.window ?? null, this.ports.blacklist(),
        this.ports.ownPids());
      if (change !== null) {
        this.ports.log(`CAPTURE image_dropped id=${id} reason=${change}`);
        this.reportFailure(request, window, change);
        return;
      }
      this.serially(async () => {
        if (!this.policy.allowImages) return;
        const now = (await this.windowNow(request.windowId))?.window ?? null;
        if (captureTargetChange(window, now, this.ports.blacklist(), this.ports.ownPids()) !== null) return;
        const body = contextImageBody(window, id, jpeg, this.ports.blacklist(), this.ports.ownPids());
        this.logRequest(request, body === null ? null : imageResult(await this.ports.post('/context/image', body), 202));
      });
    } finally {
      this.reading = false;
    }
  }

  private async answerWithOCR(request: FeedRequest, window: CaptureWindow): Promise<void> {
    if (!allowsOCR(this.policy) || this.reading) return;
    this.reading = true;
    const generation = this.consent.generation, id = request.requestId;
    try {
      const r = await this.capture('ocr.recognize', { window_id: request.windowId });
      if (!r.ok) {
        this.ports.log(`CAPTURE request_failed id=${id} mode=${request.mode} error=${r.error.code}`);
        return;
      }
      if (generation !== this.consent.generation || !allowsOCR(this.policy)) return;
      const observation = ocrObservation(r.result, this.ports.newId(), this.policy.redact);
      // /context/text has no failure report, so a changed target only drops the text.
      const change = captureTargetChange(window, (await this.windowNow(request.windowId))?.window ?? null, this.ports.blacklist(),
        this.ports.ownPids());
      if (change !== null) {
        this.ports.log(`CAPTURE text_dropped id=${id} reason=${change}`);
        return;
      }
      this.serially(async () => {
        if (!allowsOCR(this.policy)) return;
        const now = (await this.windowNow(request.windowId))?.window ?? null;
        if (captureTargetChange(window, now, this.ports.blacklist(), this.ports.ownPids()) !== null) return;
        this.logRequest(request, await this.sendText(window, observation.text, 'ocr', id, observation));
      });
    } finally {
      this.reading = false;
    }
  }

  /** Reads the window agentd named at the level the policy allows for it, and reports every refusal so agentd can ask
   *  for an image. */
  private async readWindowText(request: FeedRequest): Promise<void> {
    const id = request.requestId, rules = this.ports.blacklist(), ownPids = this.ports.ownPids();
    const found = await this.windowNow(request.windowId);
    const window = found?.window ?? namedWindow(request.windowId);
    const plan = windowReadPlan(found !== null, this.policy, this.sample?.front?.windowId === request.windowId,
      found ? captureBlockReason(found.window, rules, ownPids) : null, await this.axTrusted());
    if (typeof plan === 'string' || !found) {
      const failure = typeof plan === 'string' ? plan : 'window_gone';
      this.ports.log(`CAPTURE request_blocked id=${id} reason=${failure}`);
      return this.reportFailure(request, window, failure);
    }
    const generation = this.consent.generation;
    const read = await this.axWindowText(found.window.window.pid!, found.bounds, plan.level, this.policy.redact);
    let refusal: CaptureFailure | null;
    if (!read.matched) refusal = 'ax_unavailable';
    else if (read.observation === null || read.observation.text.trim() === '') refusal = 'ax_empty';
    else if (generation !== this.consent.generation || !allowsRequest(this.policy, 'text')) refusal = 'permission_denied';
    else refusal = captureTargetChange(window, (await this.windowNow(request.windowId))?.window ?? null, this.ports.blacklist(), this.ports.ownPids());
    const observation = read.observation;
    if (observation === null || refusal !== null) {
      const failure = refusal ?? 'ax_empty';
      this.ports.log(`CAPTURE request_blocked id=${id} reason=${failure}`);
      return this.reportFailure(request, window, failure);
    }
    this.serially(async () => {
      const change = allowsRequest(this.policy, 'text')
        ? captureTargetChange(window, (await this.windowNow(request.windowId))?.window ?? null, this.ports.blacklist(), this.ports.ownPids())
        : 'permission_denied';
      if (change !== null) {
        this.ports.log(`CAPTURE request_blocked id=${id} reason=${change}`);
        return this.reportFailure(request, window, change);
      }
      this.logRequest(request, await this.sendText(window, observation.text, 'ax', id, observation));
    });
  }

  /** agentd reads a text or image request's failure from `/context/image`. */
  private reportFailure(request: FeedRequest, window: CaptureWindow, failure: CaptureFailure): void {
    this.serially(async () => {
      const body = imageFailureBody(window, request.requestId, failure);
      const result = body === null ? null : imageResult(await this.ports.post('/context/image', body), 200);
      this.ports.log(`CAPTURE request_failed_reported id=${request.requestId} error=${failure} result=${resultText(result)}`);
    });
  }

  /** Without a request id, text equal to the window's last accepted text is not sent again. */
  private async sendText(w: CaptureWindow, text: string, source: 'ax' | 'ocr', requestId: string | null,
    observation: Observation): Promise<ContextResult | null> {
    const built = contextTextBodies(w, text, source, requestId, observation, this.policy.redact, this.ports.blacklist(), this.ports.ownPids());
    const windowId = w.window.windowId;
    if (built === null || windowId === null) return null;
    if (requestId === null && this.lastSent.get(windowId) === built.signature) return null;
    let result: ContextResult = { kind: 'accepted' };
    for (const body of built.bodies) {
      result = textResult(await this.ports.post('/context/text', body));
      if (result.kind !== 'accepted') break;
    }
    if (result.kind === 'accepted') this.lastSent.set(windowId, built.signature);
    return result;
  }

  private logRequest(request: FeedRequest, result: ContextResult | null): void {
    this.ports.log(`CAPTURE request id=${request.requestId} mode=${request.mode} result=${resultText(result)}`);
  }
}

/** The capturer, idle until `start()`. */
export function startContext(ports: ContextPorts): ContextCapturer {
  return new ContextCapturer(ports);
}
