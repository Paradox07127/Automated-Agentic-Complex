// What the renderer link reports to agentd beside trace and receipts (forward.ts): an interrupted speech, the playback
// receipts, her behavior capabilities and whether she is shown, config.json's behavior switches and state switch each time agentd
// runs, and her character's motion settings from config.json; with the touch switches from config.json and her
// `motion.stroke` for the stack.
import { behaviorCapabilities, touchSettings } from '../../common/c3.ts';
import { storedSwitches } from '../../common/looks.ts';
import { loadOverrides, sentOverrides } from '../../common/motion-overrides.ts';
import { behaviorSwitches } from '../../common/settings.ts';
import type { LinkEvent, LinkOptions } from './link.ts';

export interface ReportPorts {
  /** agentd's client (AgentdClient.request); one that throws counts as status 0. */
  agentd: { request(method: string, path: string, json?: unknown): Promise<{ status: number; body?: Uint8Array }> };
  /** agentd is running. */
  agentdRunning(): boolean;
  /** config.json as saved now. */
  settings(): Record<string, unknown>;
  /** Her hover buttons are open (DesktopAssembly.dockShown); absent is false. */
  dockOpen?(): boolean;
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

/** HostLink's `onSpeechCancelled`, `onPlayback`, `onMotionStroke`, `touchSettings` and `onMotionSettings`; `linkEvent`
 *  for `HostLink.on`; `visibility` after each hide or show; `agentdReady` each time agentd starts running (visibility,
 *  behavior switches, state switch, capabilities and motion settings); `dockChanged` the behavior switches again. */
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

  // The character's action switches, motion overrides without notes as config.json has them now, put again in
  // each agentd run while they change; a 409 character_changed waits for agentd's switch to commit.
  let character: string | null = null;
  let motionDelivered: { run: number; key: string } | null = null;
  let motionTail: Promise<void> = Promise.resolve();
  const motionPrefs = (id: string) => {
    let raw: Record<string, unknown> = {};
    try {
      raw = o.settings();
    } catch { /* nothing stored for an unreadable file */ }
    const overrides = loadOverrides(raw, id);
    return { character_id: id, action_switches: storedSwitches(raw, id) ?? {},
      motion_overrides: overrides ? sentOverrides(overrides) : { chains: {}, pools: {}, blend_in: {} } };
  };
  const deliverMotion = () => {
    motionTail = motionTail.then(async () => {
      if (character === null) return;
      const body = motionPrefs(character), sentRun = run, sentKey = JSON.stringify(body);
      if (motionDelivered?.run === sentRun && motionDelivered.key === sentKey) return;
      let answer = { status: 0, reply: {} as Record<string, unknown> };
      for (let i = 0; i < 12; i++) {
        try {
          const r = await o.agentd.request('PUT', '/behavior/motion_prefs', body);
          answer = { status: r.status, reply: r.body ? JSON.parse(Buffer.from(r.body).toString('utf8')) : {} };
        } catch {
          answer = { status: 0, reply: {} };
        }
        if (answer.reply.error !== 'character_changed') break;
        await wait(250);
      }
      if (answer.status !== 200) return o.log(`motion_prefs ${body.character_id} status=${answer.status}`);
      motionDelivered = { run: sentRun, key: sentKey };
      const switches = (answer.reply.action_switches as { adjusted?: unknown[] } | undefined)?.adjusted ?? [];
      const overrides = (answer.reply.motion_overrides as { adjusted?: unknown[] } | undefined)?.adjusted ?? [];
      if (switches.length > 0 || overrides.length > 0) {
        o.log(`motion_prefs ${body.character_id} adjusted switches=${JSON.stringify(switches)} overrides=${JSON.stringify(overrides)}`);
      }
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
  const putSwitches = async (raw: Record<string, unknown>) => {
    const behavior = await status('PUT', '/behavior/switches', behaviorSwitches(raw, o.dockOpen?.() ?? false));
    if (behavior !== 200) o.log(`behavior switches put status=${behavior}`);
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
      onMotionSettings: (id: string) => {
        character = id;
        deliverMotion();
      },
    } satisfies Partial<LinkOptions>,
    linkEvent: (e: LinkEvent) => {
      if (e.kind !== 'message' || e.message.type !== 'actions') return;
      if (e.message.error === undefined && typeof e.message.character === 'string') {
        character = e.message.character;
        deliverMotion();
      }
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
        await putSwitches(raw);
        const affects = typeof raw.state_affects_behavior === 'boolean' ? raw.state_affects_behavior : true;
        const state = await status('PUT', '/character/state/switch', { affects_behavior: affects });
        if (state !== 200) o.log(`state switch put status=${state}`);
      });
      run += 1;
      deliver();
      deliverMotion();
    },
    /** Her hover buttons opened or closed; while agentd is not running its next agentdReady sends them. */
    dockChanged: () => {
      if (!o.agentdRunning()) return;
      visibilityTail = visibilityTail.then(async () => {
        let raw: Record<string, unknown> = {};
        try {
          raw = o.settings();
        } catch { /* agentd's defaults for an unreadable file */ }
        await putSwitches(raw);
      });
    },
  };
}
