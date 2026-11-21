// The character switch (C3 rules 14 and 26): agentd's prepare, one `set_character`,
// agentd's commit; one transaction at a time, only the user's last choice kept, and agentd brought back onto the current
// character once it is up. `switchOutcome` is `character.switchTo`'s answer.
import type { CharacterView } from './runtime.ts';

/** HostLink's CharacterEvent: a hello's character, the reply to an open `set_character`, or one after its timeout. */
export type CharacterEvent =
  | { kind: 'current'; id: string }
  | { kind: 'changed'; id: string }
  | { kind: 'lateChanged'; id: string }
  | { kind: 'failed'; id: string; reason: string };

type Refused = { kind: 'rejected'; status: number; reason: string } | { kind: 'failed'; reason: string };
export type PrepareResult = { kind: 'prepared'; switchId: string } | Refused;
export type CommitResult = { kind: 'committed' } | Refused;
export type AbortResult = { kind: 'aborted' } | { kind: 'alreadyCommitted' } | Refused;
export type SetResult = { kind: 'changed'; changed: boolean } | Refused;

export interface SwitchPorts {
  agentdRunning(): boolean;
  prepare(id: string): Promise<PrepareResult>;
  commit(switchId: string): Promise<CommitResult>;
  abort(switchId: string): Promise<AbortResult>;
  /** The old `POST /character`: for an agentd without the prepare route, and to bring agentd onto `current`. */
  setAgentdCharacter(id: string): Promise<SetResult>;
  /** agentd's `GET /state`: its `character`, null without one (an empty library); null itself when the read fails. */
  readAgentd(): Promise<{ character: string | null } | null>;
  /** Sends `set_character`; false without a handshaken avatar. */
  setCharacter(id: string): boolean;
  /** Restarts the renderer as the remembered last character. */
  restartAvatar(id: string): void;
  /** Remembers the last character (rule 14), which the next renderer and agentd launch with. */
  persist(id: string): void;
  /** False for a text-only character: no renderer runs for it. */
  renderable(id: string): boolean;
  log(line: string): void;
}

export interface SwitchFailure { target: string; stage: 'prepare' | 'avatar' | 'commit'; reason: string }
export type SwitchOutcome = { kind: 'switched' } | { kind: 'failed'; stage: string; reason: string } | { kind: 'superseded' } | { kind: 'noAvatar' };

type Reply = { kind: 'changed'; id: string } | { kind: 'failed'; id: string; reason: string };

const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));

/** The ports that go to agentd. */
export function agentdSwitchPorts(request: (method: string, path: string, json?: unknown) => Promise<{ status: number; body: Uint8Array }>):
  Pick<SwitchPorts, 'prepare' | 'commit' | 'abort' | 'setAgentdCharacter' | 'readAgentd'> {
  const post = async (path: string, json: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> => {
    const reply = await request('POST', path, json);
    let body: unknown = null;
    try {
      body = JSON.parse(new TextDecoder().decode(reply.body));
    } catch { /* no JSON body */ }
    return { status: reply.status, body: typeof body === 'object' && body !== null ? body as Record<string, unknown> : null };
  };
  const error = (body: Record<string, unknown> | null) => (typeof body?.error === 'string' ? body.error : '');
  const failed = (e: unknown) => ({ kind: 'failed' as const, reason: e instanceof Error ? e.message : String(e) });
  return {
    prepare: async (id) => {
      try {
        const { status, body } = await post('/character/prepare', { id });
        if (status === 200 && typeof body?.switch_id === 'string') return { kind: 'prepared', switchId: body.switch_id };
        return { kind: 'rejected', status, reason: error(body) };
      } catch (e) { return failed(e); }
    },
    commit: async (switchId) => {
      try {
        const { status, body } = await post('/character/commit', { switch_id: switchId });
        return status === 200 ? { kind: 'committed' } : { kind: 'rejected', status, reason: error(body) };
      } catch (e) { return failed(e); }
    },
    abort: async (switchId) => {
      try {
        const { status, body } = await post('/character/abort', { switch_id: switchId });
        if (status === 200) return { kind: 'aborted' };
        return status === 409 && error(body) === 'committed' ? { kind: 'alreadyCommitted' } : { kind: 'rejected', status, reason: error(body) };
      } catch (e) { return failed(e); }
    },
    setAgentdCharacter: async (id) => {
      try {
        const { status, body } = await post('/character', { id });
        if (status === 200 && typeof body?.changed === 'boolean') return { kind: 'changed', changed: body.changed };
        return { kind: 'rejected', status, reason: error(body) };
      } catch (e) { return failed(e); }
    },
    readAgentd: async () => {
      try {
        const reply = await request('GET', '/state');
        if (reply.status !== 200) return null;
        const character = (JSON.parse(new TextDecoder().decode(reply.body)) as Record<string, unknown>).character;
        if (character === null) return { character: null };
        return typeof character === 'string' ? { character } : null;
      } catch {
        return null;
      }
    },
  };
}

const text = (r: { kind: string; reason?: string; status?: number }) => `${r.kind}${r.status !== undefined ? ` ${r.status}` : ''}${r.reason !== undefined ? ` ${r.reason}` : ''}`;

export class CharacterSwitch {
  /** Seconds a renderer started for a switch from a text-only character has to say hello. */
  helloTimeout = 60;
  /** GET /state fails until agentd writes ui-runtime.json; tried every 0.5 s for 10 s. */
  readRetry = 0.5;
  readAttempts = 20;
  /** While true `select` drops the choice: a motion import is rewriting the current character's package. */
  held = false;
  /** The renderer takes no `set_character` (efw, C3 附录「Windows」): every switch restarts it as the new character. */
  restartOnly = false;
  /** Told `view` at every set of current, failure, busy, shown, pending and agentd. */
  onChange: (view: CharacterView) => void = () => {};
  private readonly ports: SwitchPorts;
  private readonly values: CharacterView = { current: null, shown: null, agentd: null, pending: null, switching: false, failure: null };
  private waiter: { id: string; resolve(r: Reply): void } | null = null;
  private helloWaiter: { resolve(id: string | null): void; timer: ReturnType<typeof setTimeout> } | null = null;
  private idle: (() => void)[] = [];

  constructor(ports: SwitchPorts) {
    this.ports = ports;
  }

  /** The character agentd and the shell agree on; null before the avatar's first hello. */
  get current(): string | null { return this._current; }
  get failure(): SwitchFailure | null { return this._failure; }
  get busy(): boolean { return this._busy; }
  /** The user's last choice made while busy (rule 26). */
  get pending(): string | null { return this.values.pending; }
  private set pending(id: string | null) { this.change({ pending: id }); }
  /** The last character agentd confirmed; null while unknown (not reported yet, or the last POST failed). */
  get agentd(): string | null { return this.values.agentd; }
  private set agentd(id: string | null) { this.change({ agentd: id }); }
  get view(): CharacterView { return { ...this.values }; }

  private get _current(): string | null { return this.values.current; }
  private set _current(id: string | null) { this.change({ current: id }); }
  private get _failure(): SwitchFailure | null { return this.values.failure; }
  private set _failure(failure: SwitchFailure | null) { this.change({ failure }); }
  private get _busy(): boolean { return this.values.switching; }
  private set _busy(busy: boolean) { this.change({ switching: busy }); }
  /** The character the avatar shows, from its last hello or reply. */
  private get shown(): string | null { return this.values.shown; }
  private set shown(id: string | null) { this.change({ shown: id }); }

  /** Told on every set, changed or not. */
  private change(set: Partial<CharacterView>): void {
    Object.assign(this.values, set);
    this.onChange(this.view);
  }

  /** The user picked `id`. */
  select(id: string): void {
    if (this._current === null) return this.ports.log(`character switch to ${id} ignored: no avatar hello yet`);
    if (this.held) return this.ports.log(`character switch to ${id} ignored: a motion import is running`);
    this.pending = id;
    this.next();
  }

  /** `character.switchTo`: waits for the transaction; what became of `id`. */
  async switchOutcome(id: string): Promise<SwitchOutcome> {
    if (this._current === null) return { kind: 'noAvatar' };
    if (this.held) return { kind: 'failed', stage: 'prepare', reason: '正在导入动作，导入完再切换' };
    this.select(id);
    if (this._busy) await new Promise<void>((r) => this.idle.push(r));
    if (this._current === id) return { kind: 'switched' };
    const failure = this._failure?.target === id ? this._failure : null;
    return failure ? { kind: 'failed', stage: failure.stage, reason: failure.reason } : { kind: 'superseded' };
  }

  /** agentd is ready: reads its character, again every `readRetry` while the read fails. */
  async agentdReady(): Promise<void> {
    for (let attempt = 1; attempt <= this.readAttempts; attempt++) {
      const read = await this.ports.readAgentd();
      if (read !== null) return this.agentdReported(read.character);
      if (attempt < this.readAttempts) await sleep(this.readRetry);
    }
    this.ports.log('agentd character unknown: GET /state failed for 10 s');
  }

  /** agentd speaks as `id` (null: unknown); a switch made while it was down only changed the picture. */
  agentdReported(id: string | null): void {
    this.agentd = id;
    if (this._current === null && id !== null && !this.ports.renderable(id)) this._current = id;
    this.next();
  }

  /** Every character event of the host link. */
  avatar(event: CharacterEvent): void {
    switch (event.kind) {
      case 'current':
        // Rule 14: the avatar's hello is the current character.
        this.shown = event.id;
        if (!this._busy) this._current = event.id;
        this.heard(event.id);
        this.next();
        break;
      case 'changed':
      case 'failed': {
        const w = this.waiter;
        if (w === null || w.id !== event.id) return;
        this.waiter = null;
        w.resolve(event);
        break;
      }
      case 'lateChanged':
        this.shown = event.id;
        this.next();
        break;
    }
  }

  /** Starts the kept choice, or puts the picture back on `current` when the avatar shows another character. */
  private next(): void {
    const current = this._current;
    if (this._busy || current === null) return;
    if (this.pending !== null) {
      const target = this.pending;
      this.pending = null;
      if (target !== current) return this.begin(() => this.run(current, target));
    }
    if (this.shown !== null && this.shown !== current && this.ports.renderable(current)) return this.begin(() => this.restore(current));
    if (this.ports.agentdRunning() && this.agentd !== null && this.agentd !== current) this.begin(() => this.setAgentd(current));
  }

  private begin(body: () => Promise<void>): void {
    this._busy = true;
    void (async () => {
      try {
        await body();
      } finally {
        this._busy = false;
        this.next();
        if (!this._busy) for (const resolve of this.idle.splice(0)) resolve();
      }
    })();
  }

  /** Prepare, avatar switch, commit; abort or restore on failure. */
  private async run(o: string, x: string): Promise<void> {
    let switchId: string | null = null;
    this._failure = null;
    if (this.ports.agentdRunning()) {
      const prepared = await this.ports.prepare(x);
      if (prepared.kind === 'prepared') switchId = prepared.switchId;
      else {
        this._failure = { target: x, stage: 'prepare', reason: prepared.reason };
        return this.ports.log(`character prepare ${x}: ${text(prepared)}`);
      }
    }
    if (this.restartOnly || !this.ports.renderable(o) || !this.ports.renderable(x)) return this.relaunch(o, x, switchId);
    const reply = await this.show(x);
    if (reply.kind !== 'changed') {
      this.ports.log(`character switch ${o} -> ${x} failed on the avatar: ${reply.reason}`);
      this._failure = { target: x, stage: 'avatar', reason: reply.reason };
      if (switchId !== null) this.ports.log(`character abort ${switchId}: ${text(await this.ports.abort(switchId))}`);
      return;
    }
    if (switchId !== null) {
      const refused = await this.commit(switchId);
      if (refused !== null) {
        // Abort before the picture goes back: 409 `committed` means agentd already speaks as X, so X stays.
        const aborted = await this.ports.abort(switchId);
        this.ports.log(`character abort ${switchId}: ${text(aborted)}`);
        if (aborted.kind !== 'alreadyCommitted') {
          this._failure = { target: x, stage: 'commit', reason: refused };
          return this.restore(o);
        }
      }
      this.agentd = x;
    }
    this._current = x;
    this.ports.persist(x);
  }

  /** The switch when O or X is text-only, or with `restartOnly`: the renderer restarts as X, and its hello stands for the reply. */
  private async relaunch(o: string, x: string, switchId: string | null): Promise<void> {
    const avatar = this.ports.renderable(o) || this.ports.renderable(x);
    this.ports.persist(x);
    if (this.ports.renderable(x)) {
      const hello = await this.launch(x);
      if (hello !== x) {
        const reason = hello === null ? 'timeout' : 'wrong_character';
        this.ports.log(`character switch ${o} -> ${x} failed on the avatar: ${reason} hello=${hello ?? 'none'}`);
        this._failure = { target: x, stage: 'avatar', reason };
        if (switchId !== null) this.ports.log(`character abort ${switchId}: ${text(await this.ports.abort(switchId))}`);
        this.ports.persist(o);
        this.shown = o;
        return this.ports.restartAvatar(o);
      }
    } else if (avatar) {
      this.ports.restartAvatar(x);
    }
    if (switchId !== null) {
      const refused = await this.commit(switchId);
      if (refused !== null) {
        const aborted = await this.ports.abort(switchId);
        this.ports.log(`character abort ${switchId}: ${text(aborted)}`);
        if (aborted.kind !== 'alreadyCommitted') {
          this._failure = { target: x, stage: 'commit', reason: refused };
          this.ports.persist(o);
          if (avatar) {
            this.shown = o;
            this.ports.restartAvatar(o);
          }
          return;
        }
      }
      this.agentd = x;
    }
    this._current = x;
  }

  /** Restarts the renderer as `id` and waits for its hello; null when none comes within `helloTimeout`. */
  private launch(id: string): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.heard(null), this.helloTimeout * 1000);
      this.helloWaiter = { resolve, timer };
      this.ports.restartAvatar(id);
    });
  }

  private heard(id: string | null): void {
    const w = this.helloWaiter;
    if (w === null) return;
    this.helloWaiter = null;
    clearTimeout(w.timer);
    w.resolve(id);
  }

  /** The old `POST /character`; a refusal leaves agentd's character unknown. */
  private async setAgentd(id: string): Promise<void> {
    const result = await this.ports.setAgentdCharacter(id);
    this.ports.log(`agentd character=${id} ${text(result)}`);
    this.agentd = result.kind === 'changed' ? id : null;
  }

  /** Step 5, tried once more with the same switch id; null when committed, else the last refusal's reason. */
  private async commit(switchId: string): Promise<string | null> {
    let reason = '';
    for (let i = 0; i < 2; i++) {
      const result = await this.ports.commit(switchId);
      if (result.kind === 'committed') return null;
      reason = result.reason;
      this.ports.log(`character commit ${switchId}: ${text(result)}`);
    }
    return reason;
  }

  /** Puts the picture on `o`; restarts the renderer as `o` when that fails too, or at once with `restartOnly`. */
  private async restore(o: string): Promise<void> {
    if (!this.restartOnly) {
      const reply = await this.show(o);
      if (reply.kind === 'changed') return;
      this.ports.log(`character restore to ${o} failed: ${reply.reason}; restarting the avatar`);
    }
    this.ports.persist(o);
    this.ports.restartAvatar(o);
    this.shown = o;
  }

  /** Sends `set_character` and waits for the link's answer (reply, rule 14's timeout or a lost connection). */
  private async show(id: string): Promise<Reply> {
    if (!this.ports.setCharacter(id)) return { kind: 'failed', id, reason: 'not_connected' };
    const reply = await new Promise<Reply>((resolve) => { this.waiter = { id, resolve }; });
    if (reply.kind === 'changed') this.shown = id;
    return reply;
  }
}
