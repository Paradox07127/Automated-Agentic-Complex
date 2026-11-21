// What the renderer link reports to agentd beside trace and receipts (forward.ts): an interrupted speech, the playback
// receipts, her behavior capabilities and whether she is shown, and config.json's behavior switches and state switch each time agentd
// runs; with the touch switches from config.json and her `motion.stroke` for the stack.
import { behaviorCapabilities, touchSettings } from '../../common/c3.ts';
import { behaviorSwitches } from '../../common/settings.ts';
import type { LinkEvent, LinkOptions } from './link.ts';

export interface ReportPorts {
  /** agentd's client (AgentdClient.request); one that throws counts as status 0. */
  agentd: { request(method: string, path: string, json?: unknown): Promise<{ status: number }> };
  /** agentd is running. */
  agentdRunning(): boolean;
  /** config.json as saved now. */
  settings(): Record<string, unknown>;
  /** The hostlink log, `HOSTLINK ` in front. */
  log(line: string): void;
  /** The companion log. */
  companionLog(line: string): void;
  /** WebStack.stroke: her snap for the stack panel ended a stroke. */
  stroke(token: string): void;
  /** AgentdClient.putBehaviorCapabilities' pause before it tries a 409 again; tests skip it. */
  wait?(ms: number): Promise<void>;
}

type Capabilities = Record<string, string | null>;

/** HostLink's `onSpeechCancelled`, `onPlayback`, `onMotionStroke` and `touchSettings`; `linkEvent` for `HostLink.on`;
 *  `visibility` after each hide or show; `agentdReady` each time agentd starts running (visibility, behavior switches,
 *  state switch and capabilities). */
export function rendererReports(o: ReportPorts) {
  const status = async (method: string, path: string, json: unknown) => {
    try {
      return (await o.agentd.request(method, path, json)).status;
    } catch {
      return 0;
    }
  };
  const wait = o.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // The latest table, put again in each agentd run until one answers 2xx.
  let latest: { character: string; capabilities: Capabilities } | null = null;
  let run = 0;
  let delivered: { run: number; key: string } | null = null;
  let capabilityTail: Promise<void> = Promise.resolve();
  const key = (l: { character: string; capabilities: Capabilities }) =>
    JSON.stringify([l.character, Object.entries(l.capabilities).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
  const deliver = () => {
    capabilityTail = capabilityTail.then(async () => {
      if (latest === null) return;
      const sent = latest, sentRun = run;
      if (delivered?.run === sentRun && delivered.key === key(sent)) return;
      let answer = 409;
      for (let i = 0; i < 12 && answer === 409; i++) {
        answer = await status('PUT', '/behavior/capabilities', { character_id: sent.character, capabilities: sent.capabilities });
        if (answer === 409) await wait(250);
      }
      if (answer >= 200 && answer < 300) delivered = { run: sentRun, key: key(sent) };
    });
  };

  // Each put waits for the one before it.
  let shown = { visible: true, reason: null as string | null };
  let visibilityTail: Promise<void> = Promise.resolve();
  const putVisibility = () => {
    if (!o.agentdRunning()) return;
    const { visible, reason } = shown;
    visibilityTail = visibilityTail.then(async () => {
      const answer = await status('PUT', '/avatar/visibility', { visible, reason });
      if (answer !== 200) o.companionLog(`avatar visibility put visible=${visible} status=${answer}`);
    });
  };

  return {
    options: {
      onSpeechCancelled: (speechId: string, reason: string) => {
        void status('POST', '/speech/cancel', { reason, speech_id: speechId })
          .then((answer) => o.log(`speech_cancel id=${speechId} reason=${reason} status=${answer}`));
      },
      onPlayback: (body: Record<string, unknown>) => {
        void status('POST', '/speech/playback', body).then((answer) => {
          if (answer !== 200) o.log(`playback forward speech_id=${String(body.speech_id ?? '')} status=${answer}`);
        });
      },
      onMotionStroke: (token: string) => o.stroke(token),
      touchSettings: () => touchSettings(o.settings()),
    } satisfies Partial<LinkOptions>,
    linkEvent: (e: LinkEvent) => {
      if (e.kind !== 'message' || e.message.type !== 'actions') return;
      const capabilities = behaviorCapabilities(e.message);
      if (capabilities === null) return;
      latest = { character: e.message.character as string, capabilities };
      deliver();
    },
    visibility: (hidden: boolean, reason: string) => {
      shown = { visible: !hidden, reason };
      putVisibility();
    },
    agentdReady: () => {
      putVisibility();
      // agentd keeps both in memory only.
      visibilityTail = visibilityTail.then(async () => {
        let raw: Record<string, unknown> = {};
        try {
          raw = o.settings();
        } catch { /* agentd's defaults for an unreadable file */ }
        const behavior = await status('PUT', '/behavior/switches', behaviorSwitches(raw));
        if (behavior !== 200) o.log(`behavior switches put status=${behavior}`);
        const affects = typeof raw.state_affects_behavior === 'boolean' ? raw.state_affects_behavior : true;
        const state = await status('PUT', '/character/state/switch', { affects_behavior: affects });
        if (state !== 200) o.log(`state switch put status=${state}`);
      });
      run += 1;
      deliver();
    },
  };
}
