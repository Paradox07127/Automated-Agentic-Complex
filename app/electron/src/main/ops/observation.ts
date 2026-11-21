// The observation state: agentd's
// `GET /state` `observation`, read when agentd is ready and after each quiet change, for `desktop.onState`'s `quietUntil`.
// The settings page sets pause, meeting and the blacklist itself through `agentd.request`.
import { BridgeFailure } from '../../common/bridge.ts';
import { activeQuietUntil, observationState, type ObservationState, parseWall } from '../../common/desktop-action.ts';

export interface ObservationPorts {
  /** agentd's reply, the body as text; throws when agentd cannot be reached. */
  request(method: string, path: string, json?: unknown): Promise<{ status: number; body: string }>;
  /** Epoch milliseconds. */
  now(): number;
}

const parse = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

export class ObservationControl {
  readonly state: ObservationState = { pausedUntil: null, meeting: false, off: false, quietUntil: null };
  private readonly ports: ObservationPorts;

  constructor(ports: ObservationPorts) {
    this.ports = ports;
  }

  /** `desktop.onState`'s `quietUntil`. */
  quietUntil(): number | null {
    return activeQuietUntil(this.state, this.ports.now());
  }

  /** Leaves the state as it was when agentd does not answer. */
  async load(): Promise<void> {
    let reply: { status: number; body: string };
    try {
      reply = await this.ports.request('GET', '/state');
    } catch {
      return;
    }
    const s = reply.status === 200 ? observationState(parse(reply.body)) : null;
    if (s) Object.assign(this.state, s);
  }

  /** `until` in epoch seconds, null to end quiet. agentd changes meeting and pause
   *  with it, so `/state` is read again. */
  async setQuiet(until: number | null): Promise<void> {
    const reply = await this.ports.request('PUT', '/observation/quiet', { until });
    if (reply.status < 200 || reply.status >= 300) throw new BridgeFailure('failed', `HTTP ${reply.status}`);
    const o = parse(reply.body);
    if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new BridgeFailure('failed', '后台的回包不是对象');
    this.state.quietUntil = parseWall((o as Record<string, unknown>).quiet_until);
    await this.load();
  }
}
