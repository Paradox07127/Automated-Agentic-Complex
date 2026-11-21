// C6 replies the main process decodes, C9's ui-runtime.json, and the `GET /feed` event-stream parser.

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `<state-dir>/ui-runtime.json` (C9 「发现文件」); unknown keys are ignored. */
export interface Runtime {
  baseUrl: string;
  uiToken: string;
}

export function decodeRuntime(v: unknown): Runtime {
  if (!isObject(v) || typeof v.base_url !== 'string' || typeof v.ui_token !== 'string') {
    throw new Error('ui-runtime.json: expected base_url and ui_token strings');
  }
  return { baseUrl: v.base_url, uiToken: v.ui_token };
}

/** The part of `GET /state` the main process reads. */
export interface AgentdState {
  /** null when agentd runs without a character (an empty library), or from an agentd that leaves it out. */
  character: string | null;
  /** The character a switch in progress goes to; null when none is. */
  switchingTo: string | null;
}

export function decodeState(v: unknown): AgentdState {
  if (!isObject(v)) throw new Error('/state: expected an object');
  const character = v.character ?? null;
  if (character !== null && typeof character !== 'string') throw new Error('/state: character is not a string');
  const switching = isObject(v.switching) && typeof v.switching.to === 'string' ? v.switching.to : null;
  return { character, switchingTo: switching };
}

export interface SSEEvent {
  event: string;
  id?: string;
  data: string;
}

/** Line-at-a-time event-stream parser (WHATWG server-sent events). Lines come without their terminator. */
export class SSEParser {
  private event = '';
  private data: string[] = [];
  // Per the spec the last event id carries over to later events that have no `id:` line.
  private lastId: string | undefined;

  feed(line: string): SSEEvent | undefined {
    if (line === '') {
      const data = this.data, event = this.event;
      this.event = '';
      this.data = [];
      if (data.length === 0) return undefined;
      const e: SSEEvent = { event: event === '' ? 'message' : event, data: data.join('\n') };
      if (this.lastId !== undefined) e.id = this.lastId;
      return e;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id' && !value.includes('\0')) this.lastId = value;
    return undefined;
  }
}

/** `<stream_epoch>-<latest_seq>` from a `/feed` `stream` event on a connection that sent no cursor, or from a `reset`;
 *  undefined for other events. agentd sends neither with an `id`, and replays nothing before that seq. */
export function feedStreamEdge(e: SSEEvent, cursorSent: boolean): string | undefined {
  if (!(e.event === 'reset' || (e.event === 'stream' && !cursorSent))) return undefined;
  let o: unknown;
  try {
    o = JSON.parse(e.data);
  } catch {
    return undefined;
  }
  if (!isObject(o) || typeof o.stream_epoch !== 'string' || typeof o.latest_seq !== 'number' || !Number.isInteger(o.latest_seq)) {
    return undefined;
  }
  return `${o.stream_epoch}-${o.latest_seq}`;
}
