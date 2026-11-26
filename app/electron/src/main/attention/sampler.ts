// The attention sampler over the platform helper: each second while agentd runs, `attention.sample` (with
// `browser.front_tab`, `screens.list` and `ax.video_rect` as the reading needs them) becomes one `POST /user/coarse` and,
// with screen awareness on, one `POST /context/attention`; `presence.watch` edges pause the beats while the screen is locked
// or the system or display sleeps.
import {
  AttentionBeats, attentionPayload, type AttentionSample, AttentionSleepState, type BlacklistRules, browserAsks,
  browserState, CaptureTracker, coarseBeat, type CoarseContext, composeSample, decodeAttention, decodeRect, focusLine, frontAudioOut,
  gateLine, helperEdge, InputActivity, type HelperY, type PresenceEdge, PresenceEdges, type RawAttention, type Rect, Reflex,
  type ReflexState, sensedFields,
} from '../../common/attention.ts';
import type { HelperAnswer } from '../../common/push-to-talk.ts';

/** C6 `POST /user/coarse`'s answer: agentd's judgment of the user and her stage after the beat. */
export interface UserAnswer {
  presence: string;
  stage: string;
  /** user_now's `doing`: sharing, meeting, gaming, watching, reading, browsing or idle. */
  doing: string;
  absence: { id: string; since: number } | null;
  revision: number;
  typing: boolean;
}

/** What every consumer reads while there is no answer (agentd not up, or the last POST failed). */
export const NO_ANSWER: UserAnswer = Object.freeze({ presence: 'present', stage: 'normal', doing: 'idle', absence: null, revision: 0, typing: false });

/** The answer, or null when a field is missing or of another type. */
function decodeAnswer(v: unknown): UserAnswer | null {
  const obj = (x: unknown) => (typeof x === 'object' && x !== null ? x as Record<string, unknown> : null);
  const o = obj(v), a = obj(o?.absence);
  if (!o || typeof o.presence !== 'string' || typeof o.stage !== 'string' || typeof o.doing !== 'string' || typeof o.revision !== 'number'
    || typeof o.typing !== 'boolean') return null;
  if (o.absence === null) return { presence: o.presence, stage: o.stage, doing: o.doing, absence: null, revision: o.revision, typing: o.typing };
  if (!a || typeof a.id !== 'string' || typeof a.since !== 'number') return null;
  return { presence: o.presence, stage: o.stage, doing: o.doing, absence: { id: a.id, since: a.since }, revision: o.revision, typing: o.typing };
}

export interface AttentionPorts {
  helper: { request(op: string, params?: Record<string, unknown>): Promise<HelperAnswer> };
  /** `POST /context/attention`; the HTTP status, 0 when agentd could not be reached. */
  post(body: Record<string, unknown>): Promise<number>;
  /** `POST /user/coarse`; the HTTP status (0 when agentd could not be reached) and the JSON body. */
  postCoarse(body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  /** Read at each beat: screen awareness is on, so the sample reads titles, the browser tab and the audio apps, and goes to `post`. */
  aware(): boolean;
  /** `<agentd_state_dir>/blacklist.json`'s rules now. */
  blacklist(): BlacklistRules;
  /** Read at each beat: `sense_input_counts`, `redact_sensitive`. */
  sensing(): { input: boolean; redact: boolean };
  /** This shell's processes (main and helper), never reported. */
  ownPids(): readonly number[];
  /** Whether the push-to-talk key is held; null without push-to-talk. */
  userSpeaking?(): boolean | null;
  /** Clicks near her in the last 10 s; null leaves `near_clicks_10s` out. */
  nearClicks?(): number | null;
  /** Our own screen capture lights the capture indicator. */
  ownCaptureRecent?(): boolean;
  /** Unix milliseconds. */
  now(): number;
  /** Runs `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void;
  log(line: string): void;
  /** After each beat's sample. */
  onSample?(sample: AttentionSample): void;
  /** True when the screen locks or the display or system sleeps, false once unlocked and awake. */
  onSystemPaused?(paused: boolean): void;
  /** The reflex rect's C3 y (AppKit's when absent). */
  helperY?: HelperY;
}

export class AttentionSampler {
  private readonly ports: AttentionPorts;
  private readonly beats: AttentionBeats;
  private readonly edges = new PresenceEdges();
  private readonly sleepState = new AttentionSleepState();
  private inputActivity = new InputActivity();
  private readonly capture = new CaptureTracker();
  private readonly reflexes: Reflex;
  private pendingEdges: PresenceEdge[] = [];
  /** Kept until a coarse POST that carried the first one succeeded. */
  private coarseEdges: PresenceEdge[] = [];
  private polledLocked: boolean | null = null;
  private locked = false;
  private paused = false;
  private sending = false;
  private polling = false;
  private last: AttentionSample | null = null;
  private answer: UserAnswer | null = null;
  private reflexValue: ReflexState | null = null;
  private loggedGate: string | null = null;
  private loggedFocus: string | null = null;
  private loggedFailure: string | null = null;
  private loggedCoarse: number | null = null;
  /** `presence.watch` answered; after a restart the supervisor asks for it again. */
  private presenceWatched = false;

  constructor(ports: AttentionPorts) {
    this.ports = ports;
    this.reflexes = new Reflex(ports.helperY);
    this.beats = new AttentionBeats(() => this.tick(), () => { void this.pollLock(); }, ports.every);
  }

  /** The last beat's sample. */
  get lastSample(): AttentionSample | null {
    return this.last;
  }

  /** agentd's last `/user/coarse` answer; NO_ANSWER before the first, after a failed POST and while agentd is down. */
  get user(): UserAnswer {
    return this.answer ?? NO_ANSWER;
  }

  /** The front window covers a whole display. */
  get frontFullscreen(): boolean {
    return this.last?.fullscreen === true;
  }

  /** The front app's video or game rect in C3 global points, set at each beat. */
  get reflex(): ReflexState | null {
    return this.reflexValue;
  }

  /** Locked or asleep. */
  get systemPaused(): boolean {
    return this.paused;
  }

  /** The helper said hello (true) or went (false). Its counters and sleep state go with it. */
  helper(running: boolean): void {
    if (!running) return;
    // A new helper counts input from zero; the deltas start over.
    this.inputActivity = new InputActivity();
    // A helper that says hello runs on an awake machine; a wake sent while none was running is lost. The lock has its poll.
    const edge = this.sleepState.update({ system: false, display: false });
    if (edge !== null) this.presence(edge);
    if (this.presenceWatched) return;
    void this.ports.helper.request('presence.watch', { enabled: true }).then((r) => {
      if (r.ok) this.presenceWatched = true;
      else this.ports.log(`ATTENTION presence.watch failed code=${r.error.code}`);
    });
  }

  /** Beats while agentd runs. */
  agentd(running: boolean): void {
    if (running) {
      this.beats.start();
    } else {
      this.beats.stop();
      this.pendingEdges = [];
      this.coarseEdges = [];
      this.polledLocked = null;
      this.answer = null;
    }
  }

  /** A helper event; only `presence.edge` is read. */
  event(name: string, data: Record<string, unknown>): void {
    if (name !== 'presence.edge') return;
    const change = helperEdge(data.edge);
    if (change === null) return;
    if ('lock' in change) {
      this.presence(change.lock ? 'lock' : 'unlock');
      return;
    }
    const edge = this.sleepState.update(change);
    if (edge !== null) this.presence(edge);
  }

  /** A beat for the edge now, or as soon as the beat in flight returns; dropped while not sending. The edge that pauses
   *  the beats still goes out. */
  private presence(edge: PresenceEdge): void {
    const observed = this.beats.running ? this.edges.observe(edge, this.ports.now() / 1000) : null;
    if (observed !== null) {
      this.pendingEdges.push(observed);
      this.coarseEdges.push(observed);
    }
    this.pauseRendering(edge);
    if (observed !== null) this.tick();
  }

  /** Runs whether or not beats are being sent. */
  private pauseRendering(edge: PresenceEdge): void {
    if (edge === 'lock' || edge === 'unlock') this.locked = edge === 'lock';
    const paused = this.locked || this.sleepState.asleep;
    if (paused === this.paused) return;
    this.paused = paused;
    this.ports.onSystemPaused?.(paused);
    this.beats.setPaused(paused);
  }

  /** The beats' poll while paused: the helper has no lock-only op, so only `locked` of a sample without titles,
   *  input or audio is read. */
  private async pollLock(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const reply = await this.ports.helper.request('attention.sample', {});
      if (!reply.ok) return;
      const locked = reply.result.locked === true;
      const was = this.polledLocked;
      this.polledLocked = locked;
      if (was !== null && was !== locked) this.presence(locked ? 'lock' : 'unlock');
    } finally {
      this.polling = false;
    }
  }

  private tick(): void {
    // Set before sampling: ending a pause from inside this beat must not start a second one.
    if (this.sending) return;
    this.sending = true;
    void this.beat();
  }

  private async beat(): Promise<void> {
    let posted = false;
    let coarseSent = false;
    try {
      const aware = this.ports.aware();
      const sampled = await this.sample(aware);
      if (sampled === null) return;
      const { sample: current, raw, coarse, mainHeight, videoRect } = sampled;
      if (this.polledLocked !== null && this.polledLocked !== current.locked) {
        const edge = current.locked ? 'lock' : 'unlock';
        this.pauseRendering(edge);
        const observed = this.edges.observe(edge, current.ts);
        if (observed !== null) {
          this.pendingEdges.push(observed);
          this.coarseEdges.push(observed);
        }
      }
      this.polledLocked = current.locked;
      current.edge = this.pendingEdges.shift() ?? null;
      coarse.edge = this.coarseEdges[0] ?? null;
      this.last = current;
      this.reflexValue = this.reflexes.update(current, mainHeight, videoRect);
      this.ports.onSample?.(current);
      if (aware) {
        const gate = gateLine(current);
        if (gate !== this.loggedGate) {
          this.loggedGate = gate;
          this.ports.log(gate);
        }
        const focus = focusLine(current);
        if (focus !== this.loggedFocus) {
          this.loggedFocus = focus;
          this.ports.log(focus);
        }
      }
      const coarseBody = coarseBeat(raw, coarse, sampled.sensing);
      const body = aware ? attentionPayload(current, this.ports.blacklist(), this.ports.ownPids(), this.ports.sensing().redact) : null;
      posted = true;
      const [{ status, body: answer }] = await Promise.all([this.ports.postCoarse(coarseBody), body && this.ports.post(body)]);
      const ok = status >= 200 && status < 300;
      this.answer = ok ? decodeAnswer(answer) : null;
      if (ok) {
        if (coarse.edge !== null) this.coarseEdges.shift();
        coarseSent = true;
        this.loggedCoarse = null;
      } else {
        if (status !== this.loggedCoarse) this.ports.log(`ATTENTION coarse failed code=${status}`);
        this.loggedCoarse = status;
      }
    } finally {
      this.sending = false;
      // A failed coarse POST keeps its edge for the next beat rather than retrying at once.
      if (posted && (this.pendingEdges.length > 0 || (coarseSent && this.coarseEdges.length > 0))) this.tick();
    }
  }

  /** AttentionSampler.sample over the helper; null when the helper did not answer `attention.sample`. Without screen
   *  awareness no title, browser tab or audio app is read. */
  private async sample(aware: boolean): Promise<{ sample: AttentionSample; raw: RawAttention; coarse: CoarseContext;
    sensing: { input: boolean }; mainHeight: number | null; videoRect: Rect | null } | null> {
    const sensing = this.ports.sensing();
    const reply = await this.ports.helper.request('attention.sample',
      { include_titles: aware, include_input: sensing.input, include_audio: true });
    if (!reply.ok) {
      if (reply.error.code !== this.loggedFailure) this.ports.log(`ATTENTION sample failed code=${reply.error.code}`);
      this.loggedFailure = reply.error.code;
      return null;
    }
    this.loggedFailure = null;
    const raw = decodeAttention(reply.result);
    const front = raw.front;
    const bundleId = front?.appId ?? null;
    const [tab, screens] = await Promise.all([
      aware && browserAsks(bundleId) ? this.ports.helper.request('browser.front_tab', { app_id: bundleId }) : Promise.resolve(null),
      front?.window ? this.ports.helper.request('screens.list') : Promise.resolve(null),
    ]);
    const frames = screens?.ok && Array.isArray(screens.result.screens) ? screens.result.screens as Record<string, unknown>[] : [];
    const displays = frames.map((s) => decodeRect(s?.frame)).filter((r): r is Rect => r !== null);
    const main = frames.find((s) => s?.primary === true);
    const mainHeight = decodeRect(main?.frame)?.height ?? null;
    const ownPids = this.ports.ownPids();
    const frontOut = raw.audioClients && frontAudioOut(raw.audioClients, front?.pid ?? null);
    const sensed = sensedFields(sensing.input, frontOut, () => {
      if (raw.inputCounters === null || raw.inputIdles === null) return null;
      const input = this.inputActivity.record(raw.ts, raw.inputCounters, bundleId, raw.inputIdles);
      input.nearClicks10s = this.ports.nearClicks?.() ?? null;
      return input;
    });
    const screenCaptured = this.capture.update(raw.ts, raw.captureIndicator, raw.micActive, raw.cameraActive,
      this.ports.ownCaptureRecent?.() ?? false);
    const userSpeaking = this.ports.userSpeaking?.() ?? null;
    const asleep = this.sleepState.asleep;
    const sample = composeSample(raw, {
      browser: browserState(bundleId, tab), displays, asleep, userSpeaking, sensed, screenCaptured,
    });
    const coarse: CoarseContext = { displays, asleep, edge: null, userSpeaking, screenCaptured, ownPids, input: sensed.input };
    let videoRect: Rect | null = null;
    if (sample.frontVideo === true && front) {
      const video = await this.ports.helper.request('ax.video_rect', { pid: front.pid });
      videoRect = video.ok ? decodeRect(video.result.rect) : null;
    }
    return { sample, raw, coarse, sensing, mainHeight, videoRect };
  }
}

/** The sampler, idle until `helper(true)` and `agentd(true)`. */
export function startAttention(ports: AttentionPorts): AttentionSampler {
  return new AttentionSampler(ports);
}
