// An avatar on the far end of the host link (src/main/renderer/link.ts), for link-messages.test.ts and renderer.test.ts:
// reads the Companion's lines, writes its own.
import { connect, type Socket } from 'node:net';
import { type C3Message, decodeLine } from '../src/common/c3.ts';

export class FakeAvatar {
  readonly got: C3Message[] = [];
  /** Each line as it came, without its newline. */
  readonly raw: string[] = [];
  private buffer = '';
  readonly socket: Socket;
  /** Answers `get_actions` and `play_action` and acks every line with a `req`. */
  replies: boolean;
  constructor(path: string, replies = false) {
    this.replies = replies;
    this.socket = connect(path);
    // The link closes a replaced or misbehaving connection.
    this.socket.on('error', () => {});
    this.socket.on('data', (d) => {
      this.buffer += d.toString();
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this.raw.push(line);
        const m = decodeLine(line);
        if (m) this.onMessage(m);
      }
    });
  }
  private onMessage(m: C3Message): void {
    this.got.push(m);
    if (!this.replies) return;
    if (m.type === 'get_actions') {
      this.send({ type: 'actions', character: 'aster', switches: { wave: true, walk: true },
        actions: [{ id: 'wave', name: '挥手', section: 'react', duration: 2, trigger: '点击', required_reason: null, missing: null },
          { id: 'walk', name: '走', section: 'move', duration: null, trigger: '自动', required_reason: '移动', missing: null,
            default_enabled: false, media: { bgm: false, face: true, camera: false } }] });
    }
    if (m.type === 'play_action') {
      this.send(m.id === 'wave' ? { type: 'action_played', play_id: m.play_id, id: m.id, phase: 'started', reason: null }
        : { type: 'action_played', play_id: m.play_id, id: m.id, phase: 'rejected', reason: 'not_playable' });
    }
    if (typeof m.req === 'number') this.send({ type: 'ack', req: m.req, ok: true });
  }
  send(m: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify({ ...m, v: 1 })}\n`);
  }
  last(type: string): C3Message | undefined { return this.got.filter((m) => m.type === type).at(-1); }
  types(): string[] { return this.got.map((m) => m.type); }
}
