// 按住说话 over the platform helper: the helper registers the hot key and
// sends ptt.down and ptt.up, this barges in, reads the microphone grant, records with mic.start and mic.stop, keeps the
// recording hint and hands the transcript to agentd's POST /say.
import { type HeaderRequest, postSay } from './desktop-say.ts';
import { canonicalHotkey } from './settings.ts';
import { markNow, type TurnMarks } from './turn-marks.ts';

/** A helper reply as `HelperSupervisor.request` gives it. */
export type HelperAnswer = { ok: true; result: Record<string, unknown> } | { ok: false; error: { code: string } };

/** `elapsed` in seconds, `levels` 0–1, newest last. */
export type VoiceHint =
  | { kind: 'listening'; levels: number[]; elapsed: number; text: string }
  | { kind: 'downloading'; fraction: number; receivedMB: number; totalMB: number }
  | { kind: 'sent'; text: string; elapsed: number }
  | { kind: 'discarded'; reason: string; elapsed: number }
  | { kind: 'micDenied' };

/** The guide's voice step's readout of the last try (`voice.onTrial`); `levels` are bar heights in pt, 0–20. */
export interface VoiceTrial { levels: number[]; elapsed: string; transcript: string }

/** The recording hint's reasons. */
export const HINT = {
  tooShort: '按住时长不足 0.3 秒',
  nothingHeard: '未识别到有效语音内容',
  notSent: '消息未发送',
  micAllowed: '麦克风已授权，可重新按住语音输入',
  recognitionFailed: '语音识别出错，消息未发送',
  notStarted: '语音输入未能启动',
};

/** C12 `mic.start` errors in words; `permission_denied` shows the denied card instead. */
const START_FAILED: Record<string, string> = {
  mic_busy: '麦克风被其他应用占用', no_audio_device: '没有可用的麦克风', locale_unsupported: '当前语言不支持语音识别',
  asr_unavailable: '语音识别不可用',
};

/** Right Option alone counts as push-to-talk once held this long. */
const PRESS_WINDOW_MS = 150;
/** How long the sent or discarded hint stays. */
const RESULT_LINGER_MS = 1500;
/** A shorter hold is discarded as too short. */
const MIN_HOLD_MS = 300;
/** The hint's bars. */
const HINT_BARS = 12;
/** The trial readout's bars and their height. */
const TRIAL_BARS = 40;
const TRIAL_BAR_HEIGHT = 20;

/** The ops push-to-talk calls on the hot key and the microphone; a helper whose `hello.ops` lacks one has no push-to-talk. */
const NEEDED_OPS = ['ptt.register', 'ptt.unregister', 'mic.start', 'mic.stop'];

export interface PushToTalkPorts {
  /** `hello` is the running helper's last hello answer, null while none runs. */
  helper: { request(op: string, params?: Record<string, unknown>): Promise<HelperAnswer>; readonly hello: Record<string, unknown> | null };
  /** agentd's API; throws when agentd cannot be reached. */
  agentd: HeaderRequest;
  /** The T1 marks of the line `/say` took. */
  marks?: TurnMarks;
  /** C3 `stop_speech` with reason `barge_in`. */
  stopSpeech(turnGeneration?: number): void;
  /** Every change of the recording hint; null is none shown. */
  onHint(hint: VoiceHint | null): void;
  /** With every change of the hint, the try's readout for the guide's voice step. */
  onTrial?(trial: VoiceTrial): void;
  /** Read on every press: a locale identifier such as zh-CN. */
  locale(): string;
  /** Unix milliseconds. */
  now(): number;
  /** Runs `fn` after `ms`; the returned function cancels it. */
  after(ms: number, fn: () => void): () => void;
  log(line: string): void;
}

const isChinese = (c: number) => (c >= 0x3000 && c <= 0x303f) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff)
  || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x20000 && c <= 0x2ffff);

/** Whitespace collapsed, none between Chinese characters (full-width punctuation
 *  included), trimmed and cut to the 2000 code points `POST /say` takes. */
export function normalizeTranscript(s: string): string {
  const collapsed: string[] = [];
  for (const c of s) {
    if (/\p{White_Space}/u.test(c)) {
      if (collapsed.at(-1) !== ' ') collapsed.push(' ');
    } else collapsed.push(c);
  }
  const out = collapsed.filter((c, i) => !(c === ' ' && i > 0 && i + 1 < collapsed.length
    && isChinese(collapsed[i - 1]!.codePointAt(0)!) && isChinese(collapsed[i + 1]!.codePointAt(0)!)));
  return [...out.join('').trim()].slice(0, 2000).join('').trim();
}

/** `auto` maps the first Chinese or English entry of `preferred` to zh-CN or en-US, else zh-CN. */
export function speechLocale(setting: string, preferred: readonly string[]): string {
  if (setting !== 'auto') return setting;
  for (const id of preferred) {
    const language = id.split(/[-_]/)[0];
    if (language === 'zh') return 'zh-CN';
    if (language === 'en') return 'en-US';
  }
  return 'zh-CN';
}

/** ErrorText.recovery with `short`. */
function shortRecovery(code: string, runtime: string | null): string | null {
  if (code === 'native_login_required' && runtime === 'codex') return '执行内核未登录：请在终端运行 codex login';
  if (code === 'native_login_required' && runtime === 'claude') return '执行内核未登录：请在终端运行 claude auth login';
  if (code === 'local_runtime_missing' || code === 'bundled_runtime_missing') return '未检测到 Codex CLI 或 ACP 智能体';
  if (code === 'runtime_protocol_unavailable' || code === 'runtime_version_not_verified') return '执行内核协议不可用，请更新 CLI 后重新检测';
  return null;
}

const REJECTED: Record<string, string> = {
  no_reminder_time: '未识别到提醒时间，请重新说明',
  no_commitments: '当前暂不支持创建提醒',
  switching: '正在切换角色，消息未发送',
  no_llm: '对话功能未启用，消息未发送',
  invalid_text: '输入内容过长，消息未发送',
  no_pending_approval: '当前没有待批准的请求',
  ambiguous_approval: '存在多项待批准请求，请在对应卡片上操作',
  no_task: '当前没有运行中的任务',
  ambiguous_task: '存在多个运行中的任务，请前往每日简报或任务页停止',
  shutting_down: '后台服务正在退出，消息未发送',
  resetting: '正在清除本地数据，消息未发送',
};

/** What a `/say` refusal shows; `runtime` is the role runtime a 503 names. */
export function rejectedHint(error: string, runtime: string | null): string {
  return shortRecovery(error, runtime) ?? REJECTED[error] ?? HINT.notSent;
}

/** Protocol.ts `PushToTalkState` of a hint; null for a download, which has no phase. */
export function pushToTalkState(hint: VoiceHint | null): { phase: string; partial?: string; error?: string } | null {
  if (hint === null) return { phase: 'idle' };
  switch (hint.kind) {
    case 'downloading': return null;
    case 'listening': return { phase: 'listening', partial: hint.text };
    case 'sent': return { phase: 'sent', partial: hint.text };
    case 'discarded': return { phase: 'error', error: hint.reason };
    case 'micDenied': return { phase: 'error', error: 'mic_denied' };
  }
}

/** A bar's height as a share of the full height: a log scale over the 50 dB above −50 dBFS. */
const bar = (rms: number) => (rms > 0 ? Math.min(Math.max((20 * Math.log10(rms) + 50) / 50, 0), 1) : 0);

/** Push-to-talk events folded into the hint and the trial readout. Times are Unix ms. */
class HintTracker {
  state: VoiceHint | null = null;
  private levels: number[] = [];
  private pressedAt = 0;
  private lastAt = 0;
  private text = '';

  /** A new try starts. */
  press(at: number): void {
    this.levels = [];
    this.pressedAt = this.lastAt = at;
    this.text = '';
    this.listening();
  }

  micDenied(): void { this.state = { kind: 'micDenied' }; }

  downloading(fraction: number, receivedMB: number, totalMB: number): void {
    this.state = { kind: 'downloading', fraction, receivedMB, totalMB };
  }

  recording(at: number): void {
    this.lastAt = at;
    this.listening();
  }

  level(rms: number, at: number): void {
    this.levels = [...this.levels, rms].slice(-TRIAL_BARS);
    this.lastAt = at;
    if (this.state?.kind === 'listening') this.listening();
  }

  /** `speech.partial` carries the settled text and the words still changing together. */
  transcript(text: string, at: number): void {
    this.text = text;
    this.lastAt = at;
    if (this.state?.kind === 'listening') this.listening();
  }

  sent(text: string, releasedAt: number): void { this.state = { kind: 'sent', text, elapsed: (releasedAt - this.pressedAt) / 1000 }; }

  discarded(reason: string, releasedAt: number): void {
    this.state = { kind: 'discarded', reason, elapsed: (releasedAt - this.pressedAt) / 1000 };
  }

  dismiss(): void { this.state = null; }

  get trial(): VoiceTrial {
    const s = Math.max(0, Math.trunc((this.lastAt - this.pressedAt) / 1000)), two = (n: number) => String(n).padStart(2, '0');
    return { levels: this.levels.map((rms) => bar(rms) * TRIAL_BAR_HEIGHT), elapsed: `${two(Math.floor(s / 60))}:${two(s % 60)}`,
      transcript: this.text };
  }

  private listening(): void {
    this.state = { kind: 'listening', levels: this.levels.slice(-HINT_BARS).map(bar), elapsed: (this.lastAt - this.pressedAt) / 1000,
      text: this.text };
  }
}

/** `typing` is a hold that turned out to be Option typing. */
type Phase = 'idle' | 'confirming' | 'typing' | 'starting' | 'recording' | 'stopping';

const object = (text: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

export class PushToTalk {
  /** The name the helper refused (another program holds it, or no grant for right Option); null otherwise. */
  failedHotkey: string | null = null;
  private readonly ports: PushToTalkPorts;
  /** The hot key's config.json name; null is push-to-talk off. */
  private name: string | null;
  private agentdRunning = false;
  /** A helper runs and its `hello.ops` holds every op of NEEDED_OPS. */
  private helperCapable = false;
  /** Bumped when the helper goes, which drops its registration. */
  private helperEpoch = 0;
  /** The name the helper has registered now. */
  private registered: string | null = null;
  private registering: Promise<void> = Promise.resolve();
  /** The helper's last `microphone` grant. */
  private mic: unknown = null;
  private phase: Phase = 'idle';
  private pressedAt = 0;
  /** When the press passed its window and barged in. */
  private startedAt = 0;
  /** Set once the key is let go after the press. */
  private releasedAt: number | null = null;
  /** `ptt.typed` came while right Option recorded or started to. */
  private typedWhileHeld = false;
  /** The helper reported a speech.download for this session. */
  private downloaded = false;
  private _held = false;
  private session: string | null = null;
  private sessions = 0;
  private cancelConfirm: (() => void) | null = null;
  private cancelDismissal: (() => void) | null = null;
  private readonly hint = new HintTracker();

  /** `name`: config.json `voice_hotkey` at launch. */
  constructor(name: string, ports: PushToTalkPorts) {
    this.ports = ports;
    this.name = canonicalHotkey(name) === null ? null : name;
    if (this.name === null) ports.log(`VOICE bad_hotkey ${name}`);
  }

  /** `desktop.onState`'s `pips.voice`. */
  get voice(): 'off' | 'on' | 'denied' {
    if (this.name === null || !this.helperCapable) return 'off';
    return this.mic === 'denied' ? 'denied' : 'on';
  }

  /** The key is down, from `ptt.down` until it is let go or can no longer be. */
  get held(): boolean { return this._held; }

  /** The helper said hello (true) or went (false); its registration goes with it. */
  helper(running: boolean): void {
    const ops = this.ports.helper.hello?.ops;
    this.helperCapable = running && Array.isArray(ops) && NEEDED_OPS.every((op) => ops.includes(op));
    if (!running) {
      this.helperEpoch += 1;
      if (this.registered !== null) {
        this.registered = null;
        // Neither the release nor the recording outlives the helper.
        this.released();
      }
    }
    this.sync();
  }

  /** Push-to-talk is on while agentd runs. */
  agentd(running: boolean): void {
    this.agentdRunning = running;
    this.sync();
  }

  /** Empty turns push-to-talk off; a name that is no hot key keeps the current one. */
  hotkeySaved(name: string): void {
    if (name === '') {
      this.name = null;
      this.ports.log('VOICE hotkey cleared');
    } else if (canonicalHotkey(name) === null) {
      return this.ports.log(`VOICE bad_hotkey ${name}`);
    } else {
      this.name = name;
      this.failedHotkey = null;
      this.ports.log(`VOICE hotkey_updated ${name}`);
    }
    this.sync();
  }

  /** 说话 on her hover buttons: `start` is a press of the key that records at once (no wait for Option typing), `stop` its
   *  release. Nothing while agentd is not running or the helper cannot record. */
  talk(phase: 'start' | 'stop'): void {
    if (phase === 'stop') return this.released();
    if (!this.agentdRunning || !this.helperCapable) return this.ports.log('VOICE talk unavailable');
    if (this.phase !== 'idle') return this.pressed();
    this._held = true;
    this.phase = 'confirming';
    this.pressedAt = this.ports.now();
    this.releasedAt = null;
    this.typedWhileHeld = false;
    void this.begin();
  }

  /** A helper event. */
  event(name: string, data: Record<string, unknown>): void {
    if (name === 'ptt.down') return this.pressed();
    if (name === 'ptt.up') return this.released();
    if (name === 'ptt.typed') return this.typed();
    if (data.session !== this.session || this.session === null) return;
    const now = this.ports.now();
    if (name === 'mic.level' && typeof data.rms === 'number') this.emit((h) => h.level(data.rms as number, now));
    else if (name === 'speech.partial' && typeof data.text === 'string') this.emit((h) => h.transcript(data.text as string, now));
    else if (name === 'speech.download' && typeof data.fraction === 'number' && typeof data.completed === 'number'
      && typeof data.total === 'number') {
      if (!this.downloaded) this.ports.log('VOICE asset_download');
      this.downloaded = true;
      // Read as bytes: the system's progress does not name its unit.
      this.emit((h) => h.downloading(data.fraction as number, data.completed as number / 1e6, data.total as number / 1e6));
    }
  }

  private sync(): void {
    this.registering = this.registering.then(() => this.register());
  }

  /** The helper holds the wanted name, or none. */
  private async register(): Promise<void> {
    const wanted = this.name !== null && this.agentdRunning && this.helperCapable ? this.name : null;
    if (this.registered !== null && this.registered !== wanted) {
      this.registered = null;
      // The release event can no longer arrive.
      this.released();
      await this.ports.helper.request('ptt.unregister');
    }
    if (wanted === null || this.registered === wanted) return;
    const epoch = this.helperEpoch;
    const reply = await this.ports.helper.request('ptt.register', { combo: wanted });
    if (epoch !== this.helperEpoch) return;
    if (!reply.ok) {
      this.failedHotkey = wanted;
      return this.ports.log(`VOICE hotkey_failed ${wanted} code=${reply.error.code}`);
    }
    this.registered = wanted;
    this.failedHotkey = null;
    const grants = await this.ports.helper.request('permissions.status');
    if (grants.ok) this.mic = grants.result.microphone;
  }

  private pressed(): void {
    this._held = true;
    if (this.phase !== 'idle') {
      // The key is held again, so the earlier release no longer counts.
      if (this.phase === 'starting') {
        this.releasedAt = null;
        this.typedWhileHeld = false;
      }
      return;
    }
    this.phase = 'confirming';
    this.pressedAt = this.ports.now();
    this.releasedAt = null;
    this.typedWhileHeld = false;
    this.confirm();
  }

  /** A key typed while right Option is held means Option typing,
   *  which the helper reports as `ptt.typed`. */
  private typed(): void {
    if (this.name === null || canonicalHotkey(this.name) !== 'right_option') return;
    if (this.phase === 'confirming') {
      this.phase = 'typing';
      this.cancelConfirm?.();
      this.cancelConfirm = null;
    } else if (this.phase === 'starting' || this.phase === 'recording') this.typedWhileHeld = true;
  }

  /** A key of its own starts at once, right Option alone once held for the window. */
  private confirm(): void {
    const held = this.ports.now() - this.pressedAt;
    if (this.name !== null && canonicalHotkey(this.name) === 'right_option' && held < PRESS_WINDOW_MS) {
      this.cancelConfirm = this.ports.after(PRESS_WINDOW_MS - held, () => {
        this.cancelConfirm = null;
        if (this.phase === 'confirming') this.confirm();
      });
      return;
    }
    void this.begin();
  }

  /** A barge-in, then by the microphone grant. */
  private async begin(): Promise<void> {
    this.startedAt = this.ports.now();
    this.phase = 'starting';
    this.bargeIn();
    const grants = await this.ports.helper.request('permissions.status');
    if (!grants.ok) return this.failed('permissions.status', grants.error.code);
    this.mic = grants.result.microphone;
    // Only notDetermined is a speech grant not asked for yet.
    if (this.mic === 'granted') return grants.result.speech === 'notDetermined' ? this.requestSpeechAccess() : this.record();
    if (this.mic === 'notDetermined') return this.requestAccess();
    this.micDenied();
  }

  private bargeIn(): void {
    // After synthesis ends agentd has nothing left to cancel while the avatar still plays its buffer.
    this.ports.stopSpeech();
    void (async () => {
      let status = 0, generation: unknown;
      try {
        const reply = await this.ports.agentd('POST', '/turn/cancel', { reason: 'barge_in' }, {});
        status = reply.status;
        generation = object(reply.body)?.generation;
      } catch { /* status 0 */ }
      if (status !== 202) this.ports.log(`VOICE barge_in status=${status}`);
      // The avatar also drops queued speech older than the new generation.
      if (status === 202 && Number.isInteger(generation)) this.ports.stopSpeech(generation as number);
    })();
  }

  /** The press that asked records nothing. */
  private async requestAccess(): Promise<void> {
    this.phase = 'idle';
    const reply = await this.ports.helper.request('permissions.request', { kind: 'microphone' });
    if (!reply.ok) return this.failed('permissions.request', reply.error.code);
    this.mic = reply.result.state;
    if (this.mic === 'granted') this.retryHint();
    else this.micDenied();
    // The key was let go while the prompt was up, so no release dismisses this hint.
    this.dismissLater();
  }

  /** The microphone request with the microphone allowed asks for speech only;
   *  either answer lets the next press record. */
  private async requestSpeechAccess(): Promise<void> {
    this.phase = 'idle';
    const reply = await this.ports.helper.request('permissions.request', { kind: 'microphone' });
    if (!reply.ok) return this.failed('permissions.request', reply.error.code);
    this.retryHint();
    this.dismissLater();
  }

  /** The retry hint. */
  private retryHint(): void {
    this.cancelDismissal?.();
    this.emit((h) => {
      h.press(this.pressedAt);
      h.discarded(HINT.micAllowed, this.pressedAt);
    });
  }

  private micDenied(): void {
    this.phase = 'idle';
    this.ports.log('VOICE mic_denied');
    this.cancelDismissal?.();
    this.emit((h) => h.micDenied());
    // The key was let go while the grant was read, so no release dismisses this hint.
    if (this.releasedAt !== null) this.dismissLater();
  }

  private async record(): Promise<void> {
    this.phase = 'starting';
    this.cancelDismissal?.();
    this.emit((h) => h.press(this.pressedAt));
    const session = `ptt-${++this.sessions}`;
    this.session = session;
    this.downloaded = false;
    const reply = await this.ports.helper.request('mic.start', { session, locale: this.ports.locale(), level_events: true });
    if (!reply.ok) {
      this.session = null;
      return this.failed('mic.start', reply.error.code);
    }
    if (this.downloaded && this.releasedAt !== null) {
      // Let go during the download, so nothing was meant to be recorded.
      this.phase = 'stopping';
      await this.ports.helper.request('mic.stop', { session, discard: true });
      this.session = null;
      this.phase = 'idle';
      return this.emit((h) => h.dismiss());
    }
    this.phase = 'recording';
    this.emit((h) => h.recording(this.ports.now()));
    if (this.releasedAt !== null) await this.stop();
  }

  private released(): void {
    this._held = false;
    switch (this.phase) {
      case 'confirming': {
        this.phase = 'idle';
        this.cancelConfirm?.();
        this.cancelConfirm = null;
        // A tap still stops her, as a press did before the window.
        this.bargeIn();
        const releasedAt = this.ports.now();
        this.cancelDismissal?.();
        this.emit((h) => {
          h.press(this.pressedAt);
          h.discarded(HINT.tooShort, releasedAt);
        });
        return this.dismissLater();
      }
      case 'typing':
        this.phase = 'idle';
        return;
      case 'starting':
        this.releasedAt ??= this.ports.now();
        return;
      case 'recording':
        this.releasedAt = this.ports.now();
        void this.stop();
        return;
      case 'idle':
        if (this.hint.state?.kind === 'micDenied') this.dismissLater();
        return;
      case 'stopping':
        return;
    }
  }

  private async stop(): Promise<void> {
    this.phase = 'stopping';
    const reply = await this.ports.helper.request('mic.stop', { session: this.session });
    if (!reply.ok) this.ports.log(`VOICE failed mic.stop ${reply.error.code}`);
    const text = normalizeTranscript(reply.ok && typeof reply.result.text === 'string' ? reply.result.text : '');
    const finalAt = this.ports.now(), releasedAt = this.releasedAt ?? this.pressedAt, held = releasedAt - this.pressedAt;
    this.session = null;
    this.phase = 'idle';
    if (held < MIN_HOLD_MS || text === '' || this.typedWhileHeld) {
      this.ports.log('VOICE discarded');
      // Typing with the key held was no try at speaking, so the hint goes at once.
      if (this.typedWhileHeld) return this.emit((h) => h.dismiss());
      this.emit((h) => h.discarded(held < MIN_HOLD_MS ? HINT.tooShort : !reply.ok ? HINT.recognitionFailed : HINT.nothingHeard, releasedAt));
      return this.dismissLater();
    }
    const pressedAt = this.pressedAt;
    const submitted = markNow();
    const { status, body } = await postSay(this.ports.agentd, { text, source: 'voice',
      voice_timing: { pressed_ms: Math.round(this.startedAt), released_ms: Math.round(releasedAt), final_ms: Math.round(finalAt) } });
    this.ports.marks?.acceptedBody(status, body, submitted);
    const sent = (status === 202 && typeof body?.line_id === 'string') || ((status === 200 || status === 202) && typeof body?.command === 'string');
    this.ports.log(`VOICE say chars=${[...text].length} status=${status}`);
    // A new press during the request owns the hint now.
    if (this.pressedAt !== pressedAt) return;
    if (sent) this.emit((h) => h.sent(text, releasedAt));
    else if (status === 0) this.emit((h) => h.discarded(HINT.notSent, releasedAt));
    else {
      const error = typeof body?.error === 'string' ? body.error : '', runtime = typeof body?.runtime === 'string' ? body.runtime : null;
      this.emit((h) => h.discarded(rejectedHint(error, runtime), releasedAt));
    }
    this.dismissLater();
  }

  /** `op` failed before recording: `permission_denied` is the denied card, any other code a reason for `RESULT_LINGER_MS`. */
  private failed(op: string, code: string): void {
    this.ports.log(`VOICE failed ${op} ${code}`);
    if (code === 'permission_denied') return this.micDenied();
    this.phase = 'idle';
    this.cancelDismissal?.();
    this.emit((h) => {
      h.press(this.pressedAt);
      h.discarded(START_FAILED[code] ?? HINT.notStarted, this.ports.now());
    });
    this.dismissLater();
  }

  private emit(change: (h: HintTracker) => void): void {
    change(this.hint);
    this.ports.onHint(this.hint.state);
    this.ports.onTrial?.(this.hint.trial);
  }

  private dismissLater(): void {
    this.cancelDismissal?.();
    this.cancelDismissal = this.ports.after(RESULT_LINGER_MS, () => {
      this.cancelDismissal = null;
      this.emit((h) => h.dismiss());
    });
  }
}
