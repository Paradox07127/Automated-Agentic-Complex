import type {
  A11yState,
  AvatarDetails,
  AvatarState,
  AvatarStats,
  BridgeError,
  Capabilities,
  ComputerUseState,
  AgenticComplexBridge,
  GlassRect,
  MotionPlaylist,
  PermissionKind,
  PermissionState,
  ProcessState,
  RuntimeSnapshot,
  SettingId,
  SettingValue,
  StackPayload,
  StreamEvent,
  SupervisorTarget,
  Surface,
  Unsubscribe,
} from '../protocol';
import type { MockRoute } from '../../mock/types';
import { chatRoutes } from '../../mock/chat';
import { CAMERA_DEMO, COMPUTER_DEMO, RESIZE_DEMO } from './overlays';
import { mockRoutes } from '../../mock';
import { MOTIONS } from '../../mock/character';
import { CHARACTER_LAYERS, CHARACTER_LOOKS, CHARACTERS, NO_VOICE, NOW, PIPELINE, RENDER_STATS, SWITCH_REJECT } from '../../mock/fixtures';
import { demoNative, demoPlugins } from '../../mock/settings';
import { stackPush } from '../../mock/stack';
import { pinClock } from '../clock';
import { BRIDGE_OPS, SURFACE_CAPABILITIES, SURFACE_OPS, SYNC_OPS } from '../surfaces.generated';
import { createDispatcher } from './agentd';
import { createFakeDesktop } from './desktop';
import { exampleRoutes } from './endpoints';
import { feedScript, playOnce, replyScript, scriptedStream } from './feed';
import { fakeImports } from './imports';
import { fakeLogs } from './logs';
import { fakeHistory } from './processHistory';
import { fakeMotion, fakePreviewSequence, fakePreviewView, motionGroupRoutes, traceEventRoutes } from './motion';
import { createFakeOnboarding } from './onboarding';
import { fakeOutfit } from './outfit';
import { fakeServices } from './services';

pinClock(NOW);
// Page demo fillers: each file in ./demos sets up its page's demo data when the fake bridge loads.
import.meta.glob('./demos/*.ts', { eager: true });

export interface FakeBridgeOptions {
  surface: Surface;
  /** Freeze timers and streams (URL `still=1`). */
  still?: boolean;
  routes?: MockRoute[];
  capabilities?: Partial<Capabilities>;
}

/** The shell's capability bits for a surface; the fake host always has an avatar, and it loops actions. */
function nativeCapabilities(surface: Surface): Capabilities {
  const bits = SURFACE_CAPABILITIES[surface];
  return Object.fromEntries(Object.entries(bits).map(([key, bit]) => [key, typeof bit === 'string' || bit === true])) as unknown as Capabilities;
}

/** The shell's hook install steps with placeholder launch paths. */
const FAKE_HOOK_INSTALLER = "'/path/to/runtime/python/bin/python3' '/path/to/agentd/tools/install_hooks.py' --hook-script '/path/to/support/bin/agentic-complex-hook'";
const FAKE_HOOK_INSTALL_STEPS = [
  { label: '先看会改什么', command: `${FAKE_HOOK_INSTALLER} --dry-run`, terminal: true },
  { label: '确认改动后执行', command: FAKE_HOOK_INSTALLER, terminal: true },
];

/** The shell's stub for an op the surface may not send. */
function refused(op: string): (...args: unknown[]) => unknown {
  if (/\.(subscribe|on[A-Z]\w*)$/.test(op)) return () => none;
  if (SYNC_OPS.includes(op)) return () => {};
  return () => Promise.reject(Object.assign(new Error(`not_implemented: ${op}`), { code: 'not_implemented', detail: op }));
}

/** Replaces every op outside `SURFACE_OPS[surface]` with its `refused` stub. */
function gate(bridge: AgenticComplexBridge, surface: Surface): AgenticComplexBridge {
  const allowed = new Set(SURFACE_OPS[surface]);
  const gated: Record<string, unknown> = { ...bridge };
  for (const op of BRIDGE_OPS) {
    if (allowed.has(op)) continue;
    const path = op.split('.');
    let node = gated;
    for (const key of path.slice(0, -1)) node = node[key] = { ...(node[key] as object) } as Record<string, unknown>;
    node[path[path.length - 1] as string] = refused(op);
  }
  return gated as unknown as AgenticComplexBridge;
}

/** Query parameters after `#/path?` in the current URL. */
export function hashQuery(): URLSearchParams {
  const hash = globalThis.location?.hash ?? '';
  const i = hash.indexOf('?');
  return new URLSearchParams(i < 0 ? '' : hash.slice(i + 1));
}

/** What a desktop panel told native, as a window event so e2e specs can watch it. */
function sent(op: string, arg: unknown, glass?: GlassRect[]) {
  window.dispatchEvent(new CustomEvent('endfield-fake-op', { detail: glass ? { op, arg, glass } : { op, arg } }));
}

const done = async (): Promise<void> => {};
const none: Unsubscribe = () => {};

/** The host's render stats over the fixture minute; it sends none for the suspended seconds. */
const FAKE_STATS: AvatarStats[] = RENDER_STATS.flatMap((s) => {
  if (s.fps == null) return [];
  const stats: AvatarStats = { at: s.at, fps: s.fps, frameMs: Math.round((1000 / s.fps) * 10) / 10, cpuPercent: 18 };
  if (s.p95_ms != null) stats.frameMsP95 = s.p95_ms;
  if (s.gpu_ms != null) stats.gpuMs = s.gpu_ms;
  return [stats];
});

function fakeDetails(suspended: boolean): AvatarDetails {
  return {
    renderer: 'metal',
    build: '3f9c2a71d0b4e8c5a6f1',
    pipeline: {
      character: 'voice_a',
      appearance: 'default',
      fallbackRequested: null,
      ssaa: 2,
      shadowResolution: 2048,
      outline: 'on',
      displayResolution: false,
      unsupported: [],
      fpsRequested: PIPELINE.fps_target,
      fpsTarget: PIPELINE.fps_target,
      suspended: suspended ? 'screen_sleep' : null,
      gpuAllocatedMB: PIPELINE.gpu_allocated_mb,
      framesSubmitted: 318_442,
      clip: 'idle_breathe',
      error: null,
    },
    placement: { x: 1520, y: 84, scale: 1 }, photo: true, capture: true, filters: true,
  };
}

function runtimeSnapshot(
  processes: Record<SupervisorTarget, ProcessState>,
  avatar: AvatarState,
  character: string,
  services: RuntimeSnapshot['services'],
): RuntimeSnapshot {
  const process = (p: ProcessState | null) => ({
    state: p ? 'running' as const : 'stopped' as const, pid: p?.pid ?? null, backoff: null, reason: null, stage: null,
  });
  return {
    revision: 1,
    phase: 'interactive',
    config_error: null,
    processes: { agentd: process(processes.agentd), avatar: process(processes.avatar) },
    character: { current: character, shown: character, agentd: character, pending: null, switching: false, failure: null },
    visibility: { hidden: !avatar.visible, reason: null, fullscreen_hidden: false, click_through_all: avatar.clickThroughAll },
    tts: { provider: 'none', state: 'off', reason: 'not_configured', retry_after_s: null, muted: false },
    services, voice_input: 'off',
    degraded: [],
  };
}

function readA11y(): A11yState {
  const q = (m: string) => window.matchMedia(m).matches;
  return {
    reduceMotion: q('(prefers-reduced-motion: reduce)'),
    reduceTransparency: q('(prefers-reduced-transparency: reduce)'),
    increaseContrast: q('(prefers-contrast: more)'),
    // A browser has no native glass behind the page.
    glass: false,
  };
}

export function createFakeBridge(opts: FakeBridgeOptions): AgenticComplexBridge {
  const still = opts.still ?? hashQuery().get('still') === '1';
  const listeners = new Set<(e: StreamEvent) => void>();
  const chat = chatRoutes({
    present: () => character,
    said: (line) => playOnce(replyScript(line), still, (e) => listeners.forEach((l) => l(e))),
  });
  const request = createDispatcher([...exampleRoutes, ...mockRoutes, ...chat, ...motionGroupRoutes(() => character), ...traceEventRoutes, ...(opts.routes ?? [])], () => character);
  const avatar: AvatarState = {
    running: true, visible: true, scale: 1, clickThroughAll: false, speaking: false,
    characterId: 'voice_a', appearanceId: 'default',
  };
  // Kept beside `avatar`: `avatar.state()` returns AvatarState, which has no such field.
  let keepClearOfMain = false;
  const computerUse: ComputerUseState = { granted: ['observation'], active: false };
  const processes: Record<SupervisorTarget, ProcessState> = {
    agentd: { state: 'running', pid: 4242, backoff: null, cpuPercent: 3.4, memoryMB: 168, history: fakeHistory(3.4, 168) },
    avatar: { state: 'running', pid: 4343, backoff: null, cpuPercent: 21.6, memoryMB: 1210, history: fakeHistory(21.6, 1210) },
  };
  const desktop = createFakeDesktop(hashQuery, processes, () => computerUse.active);
  let character = CHARACTERS.find((c) => c.active)?.id ?? '';
  const imports = fakeImports(() => character);
  const outfit = fakeOutfit(() => character, avatar, () => hashQuery().get('demo'));
  // One list for every character, where native keeps one per character in `motion_playlists`.
  let playlist: MotionPlaylist = { items: [], loop: 'off', speed: 1 };
  let playing: number | null = null;
  // The hidden outfit layers last set by `avatar.setLayers`.
  let hiddenLayers: string[] = [];
  const saved: Record<SettingId, SettingValue> = {};
  const services = fakeServices();
  // The plug-ins of the URL the app opened on stay on while it navigates.
  const plugins = demoPlugins(hashQuery().get('plugins'));
  const permissions: Record<PermissionKind, PermissionState> = {
    accessibility: 'granted', screenRecording: 'granted', microphone: 'granted',
    automation: 'denied', inputMonitoring: 'notDetermined', notifications: 'granted',
  };

  return gate({
    surface: opts.surface,
    platform: 'mac',
    capabilities: { ...nativeCapabilities(opts.surface), ...opts.capabilities },
    app: {
      // `source=dev`: the app runs a dirty dev deployment.
      info: async () => ({
        version: '0.0.0-fake', buildGit: 'fake', os: 'macOS 26.1.0', loadAverage: 1.42, cores: 10,
        ...(hashQuery().get('source') === 'dev'
          ? { source: 'dev', devCommit: '09c8967d0a1b2c3d4e5f60718293a4b5c6d7e8f9', devDirty: true, devUiHash: 'f'.repeat(64), devAgentdHash: 'a'.repeat(64) }
          : { source: 'bundle', devCommit: '', devDirty: false, devUiHash: '', devAgentdHash: '' }),
        hookInstallSteps: FAKE_HOOK_INSTALL_STEPS.map((s) => ({ ...s })),
      }),
      action: done,
      look: async () => ({ requestId: 'fake-look' }),
      openQuickInput: done,
      runtime: async () => runtimeSnapshot(processes, avatar, character, services.runtime()),
      onRuntime: () => none,
    },
    agentd: {
      request: (method, path, body) => request(method, path, body),
      // `demo=disconnected` or `agentdoff`: agentd is gone while the bridge still serves the last data it read.
      connection: async () => (['disconnected', 'agentdoff'].includes(hashQuery().get('demo') ?? '') ? 'offline' : 'connected'),
    },
    feed: {
      subscribe: (onEvent) => {
        listeners.add(onEvent);
        const stop = scriptedStream(feedScript, still, onEvent);
        return () => {
          listeners.delete(onEvent);
          stop();
        };
      },
    },
    diag: {
      subscribe: () => none,
    },
    supervisor: {
      state: async () => ({ ...processes }),
      restart: done,
    },
    settings: {
      // The demo copy of the native schema; `demo=configerr` rejects like an unreadable config.json, `demo=pending` reads web off, `plugins=` turns plug-ins on.
      schema: async () => Object.values((await demoNative(hashQuery().get('demo'))).rows),
      read: async () => ({ saved: { ...(await demoNative(hashQuery().get('demo'))).saved, ...plugins, ...demoPlugins(hashQuery().get('plugins')), ...saved }, statuses: {} }),
      save: async (changes) => (Object.assign(saved, changes), { restart: 'none', notApplied: [] }),
      confirmDestructive: async () => true,
      previewDestructive: async () => ({
        total: 188,
        counts: { task_understanding: 12, browser_text: 96, typed_values: 0, episodes: 71, facts: 9 },
      }),
      validateHotkey: async () => ({ ok: true }),
      recordHotkey: async () => null,
      wipeLocalData: done,
      onChange: () => none,
    },
    services: services.ops,
    permissions: {
      status: async () => ({ ...permissions }),
      request: async (kind) => permissions[kind],
      openSettings: done,
    },
    onboarding: createFakeOnboarding(opts.surface),
    avatar: {
      state: async () => ({ ...avatar }),
      // `demo=suspended`: rendering is paused, so the host reports why and sends no stats.
      details: async () => fakeDetails(hashQuery().get('demo') === 'suspended'),
      setVisible: async (v) => void (avatar.visible = v),
      setScale: async (s) => void (avatar.scale = s),
      keepClearOfMain: async (on) => void (keepClearOfMain = on),
      resetPosition: done,
      toggleClickThroughAll: async () => void (avatar.clickThroughAll = !avatar.clickThroughAll),
      stopSpeech: async () => void (avatar.speaking = false),
      actions: async () => [...MOTIONS.map((a) => ({ ...a })), ...imports.actions()],
      playAction: done, stopAction: done, ...fakeMotion(() => character),
      setActionSwitches: async (switches) => ({ switches, adjusted: [] }),
      setAppearance: async (id) => void (avatar.appearanceId = id),
      setLayers: async (hidden) => void (hiddenLayers = [...hidden]),
      playPlaylist: async (o) => {
        const start = o?.start ?? 0;
        if (playlist.items[start] === undefined) return { ok: false, reason: 'empty' };
        playing = start;
        return { ok: true };
      },
      stopPlaylist: async () => {
        playing = null;
        return { ok: true };
      },
      playlistState: async () => ({ playing: playing !== null, index: playing, id: playing === null ? null : playlist.items[playing] ?? null }),
      presentation: { get: async () => null, set: done },
      photo: { set: done }, capture: async () => ({ file: `Agentic Complex-${character}-20261116-120000.png` }),
      // A browser has no live preview: the stage keeps its art.
      preview: { show: async () => false, hide: done, sequence: fakePreviewSequence, onProgress: () => none, view: fakePreviewView() },
      onState: () => none,
      onStats: (cb) => {
        if (hashQuery().get('demo') === 'suspended') return none;
        let live = true;
        queueMicrotask(() => FAKE_STATS.forEach((s) => live && cb({ ...s })));
        return () => void (live = false);
      },
    },
    character: {
      list: async () => CHARACTERS.map((c) => ({
        ...c, active: c.id === character, voice: !NO_VOICE.has(c.id), appearances: [...(CHARACTER_LOOKS[c.id] ?? []), ...outfit.looks(c.id)],
        ...(c.id === character ? { layers: CHARACTER_LAYERS.map((l) => ({ ...l, visible: !hiddenLayers.includes(l.id) })) } : {}),
      })),
      switchTo: async (id) => {
        if (id === SWITCH_REJECT.id) return { ok: false, stage: SWITCH_REJECT.stage, reason: SWITCH_REJECT.reason };
        character = id;
        avatar.characterId = id;
        // Native keeps the hidden layers per character.
        hiddenLayers = [];
        imports.switched(id);
        return { ok: true };
      },
      importPackage: async () => ({ ok: false, reason: 'fake bridge' }),
      ...imports.motions,
      ...outfit.ops,
      importOutfit: () => imports.progressed('outfit', 'SummerMod', 400, outfit.ops.importOutfit),
      getPlaylist: async () => ({ ...playlist, items: [...playlist.items] }),
      setPlaylist: async (p) => {
        playlist = { ...p, items: [...p.items] };
        return { ok: true };
      },
    },
    mmd: imports.mmd,
    voice: { onPushToTalk: () => none },
    files: {
      pickFile: async () => null,
      pickFolder: async () => null,
      saveAgentdExport: async () => false,
    },
    open: { url: done, artifact: done, revealInFinder: done, jumpToSession: done, runFeedCommand: done, runInTerminal: done },
    clipboard: { writeText: done },
    logs: fakeLogs(still),
    computerUse: {
      state: async () => ({ ...computerUse, granted: [...computerUse.granted] }),
      grant: async (scopes) => void (computerUse.granted = [...new Set([...computerUse.granted, ...scopes])]),
      revoke: async (scopes) => void (computerUse.granted = computerUse.granted.filter((s) => !scopes.includes(s))),
      stop: async () => void (computerUse.active = false),
      onState: () => none,
      resume: done,
      dismiss: done,
      onPanel: (cb) => (cb(COMPUTER_DEMO), none),
    },
    camera: { onState: (cb) => (cb(CAMERA_DEMO), none), drag: done, endDrag: done, scroll: done, magnify: done, act: done },
    resize: { onState: (cb) => (cb(RESIZE_DEMO), none), drag: done, endDrag: done, act: done },
    window: {
      contentRect: async () => ({ width: window.innerWidth, height: window.innerHeight }),
      setInteractiveRegions: (r, glass) => sent('window.setInteractiveRegions', r, glass),
      setContentSize: (s) => sent('window.setContentSize', s),
      releaseKey: () => {},
      logInfo: () => {},
      close: () => {},
      requestKey: () => {},
      // The stack has no main window beside it in a browser, so it navigates to main.html instead.
      openMain: (route) => (opts.surface === 'stack' ? window.location.assign(`main.html#${route}`) : void (window.location.hash = route)),
      onRoute: () => none,
      onVisibility: () => none,
      onPointer: () => none,
      onAnchorState: () => none,
      onA11y: (cb) => {
        const queries = ['(prefers-reduced-motion: reduce)', '(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)'];
        const lists = queries.map((m) => window.matchMedia(m));
        const fire = () => cb(readA11y());
        lists.forEach((l) => l.addEventListener('change', fire));
        fire();
        return () => lists.forEach((l) => l.removeEventListener('change', fire));
      },
      onAnchor: desktop.onAnchor,
    },
    stack: {
      onCards: (cb, onError) => {
        let live = true;
        void Promise.resolve(stackPush(hashQuery())).then((body) => {
          if (!live) return;
          // Native pushes `{error}` on the same channel when its card source stops; the shim routes it to onError.
          if ('error' in body) onError?.(body.error);
          else cb(body);
        });
        return () => void (live = false);
      },
      decide: done,
      collapse: done,
    },
    desktop: desktop.desktop,
  }, opts.surface);
}
