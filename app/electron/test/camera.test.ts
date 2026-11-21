// The camera, the poses and the menu's pose items (src/common/camera-*.ts, src/main/camera/); fake links,
// fake clocks and temporary config files only.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CameraCloseupPolicy, sessionsShown } from '../src/common/camera-closeup.ts';
import { cameraSettings, committed, gestured, liveRenderPayload, savedCamera } from '../src/common/camera-model.ts';
import type { ActionRow } from '../src/common/c3.ts';
import { CameraCloseupDriver, watchSessionsShown } from '../src/main/camera/closeup.ts';
import { AvatarCamera, type CameraPorts } from '../src/main/camera/gesture.ts';
import { AvatarPoses, linkPoses, poseMenu, poseMenuActions, type PosePorts } from '../src/main/camera/pose.ts';
import type { CommandResult, LinkEvent } from '../src/main/renderer/link.ts';

const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };

/** A clock in seconds whose timers fire on `advance`, at least 1 ms after they were set as Node's do. */
class Clock {
  t = 0;
  private timers: { at: number; fire: () => void; live: boolean }[] = [];
  now = () => this.t;
  schedule = (seconds: number, fire: () => void) => {
    const timer = { at: this.t + Math.max(seconds, 0.001), fire, live: true };
    this.timers.push(timer);
    return () => { timer.live = false; };
  };
  get pending(): number[] { return this.timers.filter((x) => x.live).map((x) => Math.round((x.at - this.t) * 1000) / 1000); }
  advance(seconds: number) {
    const end = this.t + seconds;
    for (;;) {
      const next = this.timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      this.t = next.at;
      next.fire();
    }
    this.t = end;
  }
}

test('CameraCloseupPolicy: on 0.8 s after the panel shows, off 3 s after it hides, again on a new link, nothing without the setting', () => {
  const p = new CameraCloseupPolicy();
  assert.equal(p.update('session', true, 7, true, 10), null);
  assert.equal(p.nextCheck(10), 10.8);
  assert.equal(p.update('session', true, 7, true, 10.79), null);
  assert.equal(p.update('session', true, 7, true, 10.8), true);
  // Not delivered: asked again.
  assert.equal(p.update('session', true, 7, true, 10.9), true);
  p.sent(true, 7);
  assert.equal(p.update('session', true, 7, true, 11), null);
  assert.equal(p.nextCheck(11), 12);
  // A new connection of the same process may still hold it: sent again.
  assert.equal(p.update('session', true, 8, true, 11.5), true);
  p.sent(true, 8);
  // A hide shorter than 3 s changes nothing.
  assert.equal(p.update('session', false, 8, true, 12), null);
  assert.equal(p.nextCheck(12), 13);
  assert.equal(p.update('session', true, 8, true, 14), null);
  assert.equal(p.update('session', false, 8, true, 15), null);
  assert.equal(p.nextCheck(17.5), 18);
  assert.equal(p.update('session', false, 8, true, 18), false);
  p.sent(false, 8);
  assert.equal(p.nextCheck(18), null);
  // Without a link or `camera_free` nothing goes out; the setting off ends a held one.
  const q = new CameraCloseupPolicy();
  q.update('session', true, null, true, 0);
  assert.equal(q.update('session', true, null, true, 1), null);
  assert.equal(q.update('session', true, 3, false, 1), null);
  assert.equal(q.update('off', true, 3, true, 1), null);
  assert.equal(q.update('session', true, 3, true, 1), true);
  q.sent(true, 3);
  assert.equal(q.update('off', true, 3, true, 2), false);
  assert.equal(q.update(undefined, true, 4, true, 2), false);
});

test('sessionsShown: the 今天 page on its running sessions or on a selection', () => {
  assert.equal(sessionsShown('/overview?focus=running'), true);
  assert.equal(sessionsShown('/overview?sel=s1&focus=task-s1'), true);
  assert.equal(sessionsShown('/overview?sel=s1&focus=task-s1&theme=light'), true);
  assert.equal(sessionsShown('/overview?focus=page'), false);
  assert.equal(sessionsShown('/overview'), false);
  assert.equal(sessionsShown('/overview?focus=timeline'), false);
  assert.equal(sessionsShown('/overviewx?focus=running'), false);
  assert.equal(sessionsShown('/chat'), false);
  assert.equal(sessionsShown(null), false);
});

test('camera model: a gesture turns 0.4° a point and multiplies the zoom, clamped; 完成 rounds to 0.5° away from zero', () => {
  assert.deepEqual(gestured({ yaw: 10, pitch: 0, zoom: 1 }, 5, 10, 1.5), { yaw: 12, pitch: -4, zoom: 1.5 });
  assert.deepEqual(gestured({ yaw: 179, pitch: 19, zoom: 3 }, 100, -100, 2), { yaw: 180, pitch: 20, zoom: 4 });
  assert.deepEqual(gestured({ yaw: -179, pitch: -19, zoom: 1.2 }, -100, 100, 0.1), { yaw: -180, pitch: -20, zoom: 1 });
  assert.deepEqual(committed({ yaw: 12.26, pitch: -0.25, zoom: 1.37 }), { yaw: 12.5, pitch: -0.5, zoom: 1.37 });
  assert.deepEqual(committed({ yaw: 0.2, pitch: 7.74, zoom: 1 }), { yaw: 0, pitch: 7.5, zoom: 1 });
  assert.deepEqual(cameraSettings({ yaw: 12.5, pitch: -3, zoom: 1.37 }),
    { render_camera_yaw: 12.5, render_camera_pitch: -3, render_camera_zoom: 1.37 });
});

test('camera model: savedCamera and liveRenderPayload read config.json as AvatarRenderOptions does', () => {
  assert.deepEqual(savedCamera({}), { yaw: 0, pitch: 0, zoom: 1 });
  assert.deepEqual(savedCamera({ render_camera_yaw: -12.3, render_camera_pitch: 25, render_camera_zoom: 2.5 }), { yaw: -12.5, pitch: 0, zoom: 2.5 });
  // Only numbers and zooms in 1…4.
  assert.deepEqual(savedCamera({ render_camera_yaw: '30', render_camera_pitch: 'x', render_camera_zoom: 5 }), { yaw: 0, pitch: 0, zoom: 1 });
  assert.deepEqual(liveRenderPayload({}), {
    camera: { mode: 'show', yaw: 0, pitch: 0, zoom: 1, sway: false, track: 'stage', framing: 'full' },
    light: { yaw: 0, pitch: 0, strength: 1 }, outline: 'original', facing: 'auto', grounding: { mode: 'contact' },
    ambient: { mode: 'off', light_wrap: false }, filter: 'none', dof: { mode: 'off' } });
  assert.deepEqual(liveRenderPayload({ render_camera_mode: 'document', render_camera_yaw: 45, render_camera_pitch: -7.5, render_camera_zoom: 1.5,
    render_camera_sway: true, render_camera_track: 'off', stay_mode: 'bust', render_light_yaw: '15', render_light_pitch: '-10',
    render_light_strength: '1.25', render_outline: 'subtle', render_facing_mode: 'side', render_ground_shadow: 'off', render_ambient: 'screen',
    render_light_wrap: true, render_filter: 'sp_filter_3', render_dof: 'closeup' }), {
    camera: { mode: 'document', yaw: 45, pitch: -7.5, zoom: 1.5, sway: true, track: 'off', framing: 'bust' },
    light: { yaw: 15, pitch: -10, strength: 1.25 }, outline: 'subtle', facing: 'side', grounding: { mode: 'off' },
    ambient: { mode: 'screen', light_wrap: true }, filter: 'sp_filter_3', dof: { mode: 'closeup' } });
  assert.deepEqual(liveRenderPayload({ render_filter: 'filter_9', render_light_yaw: '20', render_outline: 3 }).filter, 'none');
});

/** A link for the closeup driver. */
function closeupLink(connected = true, capabilities = ['camera_free']) {
  const sent: boolean[] = [];
  return { connected, capabilities, deliver: true, sent, sendCloseup(on: boolean) { sent.push(on); return this.deliver; } };
}

test('CameraCloseupDriver: the session panel asks for the close-up after 0.8 s and ends it 3 s after it hides; again on a new avatar process', () => {
  const clock = new Clock(), link = closeupLink();
  let setting: unknown = 'session', pid = 501;
  const driver = new CameraCloseupDriver({ setting: () => setting, link, avatarPid: () => pid, now: clock.now, schedule: clock.schedule });
  driver.panel(true);
  assert.deepEqual(clock.pending, [0.8]);
  clock.advance(0.79);
  assert.deepEqual(link.sent, []);
  clock.advance(0.02);
  assert.deepEqual(link.sent, [true]);
  // Polls each second while it is held.
  assert.deepEqual(clock.pending, [0.99]);
  pid = 502;
  clock.advance(1);
  assert.deepEqual(link.sent, [true, true]);
  driver.panel(false);
  clock.advance(2.95);
  assert.deepEqual(link.sent, [true, true]);
  clock.advance(0.1);
  assert.deepEqual(link.sent, [true, true, false]);
  assert.deepEqual(clock.pending, []);
  // Setting off: nothing.
  setting = 'off';
  driver.panel(true);
  clock.advance(5);
  assert.deepEqual(link.sent, [true, true, false]);
  driver.stop();
  assert.deepEqual(clock.pending, []);
});

test('CameraCloseupDriver: without camera_free, a connection or a delivered line nothing is taken as sent', () => {
  const clock = new Clock();
  for (const link of [closeupLink(true, []), closeupLink(false)]) {
    const driver = new CameraCloseupDriver({ setting: () => 'session', link, avatarPid: () => 9, now: clock.now, schedule: clock.schedule });
    driver.panel(true);
    clock.advance(3);
    assert.deepEqual(link.sent, []);
    driver.stop();
  }
  const link = closeupLink();
  link.deliver = false;
  const driver = new CameraCloseupDriver({ setting: () => 'session', link, avatarPid: () => null, now: clock.now, schedule: clock.schedule });
  driver.panel(true);
  clock.advance(2.85);
  // Asked at 0.8 s and at each poll after it, since none was delivered.
  assert.deepEqual(link.sent, [true, true, true]);
  driver.stop();
});

/** A BrowserWindow with a hash route. */
class FakeWindow extends EventEmitter {
  visible = false;
  minimized = false;
  url = 'agentic://ui/main.html#/home';
  readonly webContents = Object.assign(new EventEmitter(), { getURL: () => this.url });
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
}

test('watchSessionsShown: the shown main window on the sessions route', () => {
  const win = new FakeWindow(), seen: boolean[] = [];
  watchSessionsShown(win, (shown) => seen.push(shown));
  win.visible = true;
  win.emit('show');
  assert.deepEqual(seen, []);
  win.url = 'agentic://ui/main.html#/overview?focus=running';
  win.webContents.emit('did-navigate-in-page');
  assert.deepEqual(seen, [true]);
  win.webContents.emit('did-navigate-in-page');
  win.minimized = true;
  win.emit('minimize');
  win.minimized = false;
  win.emit('restore');
  win.visible = false;
  win.emit('hide');
  win.visible = true;
  win.emit('show');
  win.emit('closed');
  assert.deepEqual(seen, [true, false, true, false, true, false]);
});

/** Ports for AvatarCamera over a config object; `file` null makes it unreadable. */
function cameraSetup(o: { capabilities?: string[]; overlayOpen?: boolean; ack?: CommandResult | null; sent?: boolean; figure?: boolean;
  closeupZoom?: unknown } = {}) {
  const calls: string[] = [];
  const state = { file: { render_camera_yaw: 10, render_camera_pitch: 0, render_camera_zoom: 1, render_outline: 'subtle' } as Record<string, unknown> | null,
    overlayOpen: o.overlayOpen ?? false };
  const renders: Record<string, unknown>[] = [];
  const begun: unknown[] = [];
  const read = () => {
    if (state.file === null) throw new Error('config.json is not an object');
    return state.file;
  };
  const ports: CameraPorts = {
    link: {
      capabilities: o.capabilities ?? ['render_live', 'camera_free'],
      lastPipeline: { v: 1, type: 'pipeline', render: { camera: { closeup_zoom: o.closeupZoom ?? 2.2 } } },
      sendCameraLive: (yaw, pitch, zoom) => { calls.push(`live ${yaw} ${pitch} ${zoom}`); return true; },
      sendSetRender: (payload, onResult) => {
        renders.push(payload);
        calls.push('set_render');
        if (o.ack !== undefined && o.ack !== null) onResult?.(o.ack);
        return o.sent ?? true;
      },
    },
    settings: () => state.file ?? {},
    load: read,
    save: (values) => {
      calls.push(`save ${JSON.stringify(values)}`);
      state.file = { ...read(), ...values };
    },
    settingsChanged: (keys) => calls.push(`changed ${keys.join(',')}`),
    restartAvatar: () => calls.push('restart'),
    figure: () => (o.figure === false ? null : { x: 100, y: 50, w: 200, h: 400 }),
    overlay: { get open() { return state.overlayOpen; }, begin: (visual, value, closeupZoom) => { begun.push({ visual, value, closeupZoom }); } },
    log: (line) => calls.push(`log ${line}`),
  };
  return { camera: new AvatarCamera(ports), calls, state, renders, begun };
}

test('AvatarCamera.gesture: starts at the saved camera, sends live values, saves the rounded camera at ended and sends it with req', () => {
  const s = cameraSetup({ ack: { ok: true } });
  s.camera.gesture({ phase: 'began', dx: 0, dy: 0, zoom: 1 });
  assert.deepEqual(s.calls, []);
  s.camera.gesture({ phase: 'changed', dx: 3, dy: -1, zoom: 1.1 });
  s.camera.gesture({ phase: 'changed', dx: 3, dy: 0, zoom: 1 });
  s.camera.gesture({ phase: 'ended', dx: 0.1, dy: 0, zoom: 1 });
  assert.equal(s.calls[0], `live ${10 + 3 * 0.4} ${0 + 0.4} ${1 * 1.1}`);
  assert.equal(s.calls[1], `live ${10 + 3 * 0.4 + 3 * 0.4} ${0 + 0.4} ${1 * 1.1}`);
  assert.deepEqual(s.calls.slice(2), [
    'save {"render_camera_yaw":12.5,"render_camera_pitch":0.5,"render_camera_zoom":1.1}',
    'changed render_camera_pitch,render_camera_yaw,render_camera_zoom', 'set_render']);
  assert.deepEqual(s.renders[0]!.camera, { mode: 'show', yaw: 12.5, pitch: 0.5, zoom: 1.1, sway: false, track: 'stage', framing: 'full' });
  assert.equal(s.renders[0]!.outline, 'subtle');
  // A gesture that changes nothing saves nothing but still sends the saved camera.
  s.calls.length = 0;
  s.camera.gesture({ phase: 'began', dx: 0, dy: 0, zoom: 1 });
  s.camera.gesture({ phase: 'ended', dx: 0, dy: 0, zoom: 1 });
  assert.deepEqual(s.calls, ['set_render']);
});

test('AvatarCamera.gesture: ignored while camera mode is open; a failed or unsent set_render restarts her; an unreadable file saves nothing', () => {
  const open = cameraSetup({ overlayOpen: true });
  open.camera.gesture({ phase: 'began', dx: 5, dy: 0, zoom: 1 });
  open.camera.gesture({ phase: 'ended', dx: 5, dy: 0, zoom: 1 });
  assert.deepEqual(open.calls, []);
  const failed = cameraSetup({ ack: { ok: false, reason: 'timeout' } });
  failed.camera.gesture({ phase: 'ended', dx: 5, dy: 0, zoom: 1 });
  assert.deepEqual(failed.calls.slice(-3), ['set_render', 'log camera render live fallback keys=render_camera_yaw why=timeout', 'restart']);
  const unsent = cameraSetup({ sent: false });
  unsent.camera.gesture({ phase: 'ended', dx: 0, dy: 0, zoom: 1 });
  assert.deepEqual(unsent.calls, ['set_render', 'log camera render live fallback keys= why=not_sent', 'restart']);
  const broken = cameraSetup();
  broken.state.file = null;
  broken.camera.commit({ yaw: 5, pitch: 0, zoom: 1 });
  assert.deepEqual(broken.calls, ['log camera: config.json unreadable, not saved']);
});

test('AvatarCamera: camera mode begins on her figure at the saved camera with the host close-up zoom; its live, cancel and commit go out', () => {
  const s = cameraSetup({ ack: { ok: true } });
  assert.equal(s.camera.begin(), true);
  assert.deepEqual(s.begun, [{ visual: { x: 100, y: 50, w: 200, h: 400 }, value: { yaw: 10, pitch: 0, zoom: 1 }, closeupZoom: 2.2 }]);
  s.camera.live({ yaw: 20, pitch: 1, zoom: 2 });
  s.camera.cancelled();
  s.camera.commit({ yaw: 20, pitch: 1, zoom: 2 });
  assert.deepEqual(s.calls, ['live 20 1 2', 'set_render',
    'save {"render_camera_yaw":20,"render_camera_pitch":1,"render_camera_zoom":2}',
    'changed render_camera_pitch,render_camera_yaw,render_camera_zoom', 'set_render']);
  assert.deepEqual(s.renders[0]!.camera, { mode: 'show', yaw: 10, pitch: 0, zoom: 1, sway: false, track: 'stage', framing: 'full' });
  assert.equal(cameraSetup({ capabilities: ['render_live'] }).camera.begin(), false);
  assert.equal(cameraSetup({ figure: false }).camera.begin(), false);
  const far = cameraSetup({ closeupZoom: 9 });
  far.camera.begin();
  assert.deepEqual((far.begun[0] as { closeupZoom: unknown }).closeupZoom, null);
});

const row = (id: string, pose: string | undefined, missing: string | null = null): ActionRow =>
  ({ id, name: id, section: 'pose', duration: null, trigger: '', required_reason: null, missing, ...(pose === undefined ? {} : { pose }) });

/** Ports for AvatarPoses; `answer` decides each set_pose's ack, null for none. */
function poseSetup(answer: CommandResult | null = { ok: true }, sent = true) {
  const clock = new Clock(), calls: string[] = [], locks = new Map<string, string>();
  const ports: PosePorts = {
    setPose: (id, lock, done) => {
      calls.push(`set_pose ${id} ${lock}`);
      if (sent && answer !== null) done(answer);
      return sent;
    },
    lock: (character) => locks.get(character) ?? null,
    setLock: (character, id) => {
      calls.push(`lock ${character}=${id}`);
      if (id === null) locks.delete(character);
      else locks.set(character, id);
    },
    schedule: clock.schedule,
  };
  return { poses: new AvatarPoses(ports), calls, locks, clock };
}

test('AvatarPoses.listed: a slot per pose name from the list; a stored lock on an available row goes out again', () => {
  const s = poseSetup();
  s.locks.set('aster', 'pose_sit');
  const slots = s.poses.listed('aster', [row('wave', undefined), row('pose_stand', 'stand'), row('pose_sit', 'sit'), row('pose_lie', 'lie', '缺资源')]);
  assert.deepEqual(slots, [
    { slot: 'stand', id: 'pose_stand', available: true, reason: null },
    { slot: 'akimbo', id: null, available: false, reason: '这个角色没有这个姿态的原作动作' },
    { slot: 'sit', id: 'pose_sit', available: true, reason: null },
    { slot: 'floor', id: null, available: false, reason: '这个角色没有这个姿态的原作动作' },
    { slot: 'lie', id: 'pose_lie', available: false, reason: '缺资源' }]);
  assert.deepEqual(s.calls, ['set_pose pose_sit true']);
  s.locks.set('aster', 'pose_lie');
  s.poses.listed('aster', [row('pose_lie', 'lie', '缺资源')]);
  assert.deepEqual(s.calls, ['set_pose pose_sit true']);
  // pose_state of another character is dropped; a new character's list forgets the last state.
  s.poses.state({ character: 'aster', id: 'pose_sit', locked: true });
  s.poses.state({ character: 'cedar', id: 'x', locked: false });
  assert.deepEqual([s.poses.current, s.poses.locked], ['pose_sit', true]);
  s.poses.listed('cedar', []);
  assert.deepEqual([s.poses.character, s.poses.current, s.poses.locked], ['cedar', null, false]);
});

test('AvatarPoses.set: stores the lock once the avatar acks ok; refusals, no reply and no character throw their error texts', async () => {
  const s = poseSetup();
  await assert.rejects(s.poses.set('pose_sit', true), { message: '这个版本的角色不支持姿态' });
  s.poses.listed('aster', [row('pose_sit', 'sit')]);
  await s.poses.set('pose_sit', true);
  await s.poses.set(null, false);
  assert.deepEqual(s.calls, ['set_pose pose_sit true', 'lock aster=pose_sit', 'set_pose null false', 'lock aster=null']);
  for (const [reason, text] of [['invalid', '角色没有这个姿态'], ['busy', '她正在做别的动作'], ['disconnected', '和角色的连接断了'],
    ['unsupported', '这个版本的角色不支持姿态'], ['timeout', '角色没有回应'], ['odd', '没能摆出这个姿态']]) {
    const f = poseSetup({ ok: false, reason: reason! });
    f.poses.listed('aster', []);
    await assert.rejects(f.poses.set('pose_sit', true), { message: text });
    assert.deepEqual(f.calls, ['set_pose pose_sit true']);
  }
  const unsent = poseSetup({ ok: true }, false);
  unsent.poses.listed('aster', []);
  await assert.rejects(unsent.poses.set('pose_sit', false), { message: '这个版本的角色不支持姿态' });
  const silent = poseSetup(null);
  silent.poses.listed('aster', []);
  const waiting = silent.poses.set('pose_sit', false);
  assert.deepEqual(silent.clock.pending, [2]);
  silent.clock.advance(2);
  await assert.rejects(waiting, { message: '角色没有回应' });
});

test('pose menu: the slots with their titles only when one has a row; 自动 releases the lock, a held lock carries over, 锁定 toggles it', async () => {
  const s = poseSetup(), logs: string[] = [];
  assert.equal(poseMenu(s.poses), null);
  s.poses.listed('aster', [row('pose_stand', 'stand'), row('pose_sit', 'sit')]);
  s.poses.state({ character: 'aster', id: 'pose_stand', locked: true });
  const menu = poseMenu(s.poses)!;
  assert.deepEqual(menu.options.map((o) => `${o.slot}:${o.title}:${o.id}`),
    ['stand:站:pose_stand', 'akimbo:叉腰:null', 'sit:坐:pose_sit', 'floor:坐地:null', 'lie:躺:null']);
  assert.deepEqual([menu.current, menu.locked], ['pose_stand', true]);
  const actions = poseMenuActions(s.poses, (line) => logs.push(line));
  actions.setPose('pose_sit');
  await settle();
  actions.setPose(null);
  await settle();
  actions.togglePoseLock();
  await settle();
  assert.deepEqual(s.calls.filter((c) => c.startsWith('set_pose')), ['set_pose pose_sit true', 'set_pose null false', 'set_pose pose_stand false']);
  const f = poseSetup({ ok: false, reason: 'busy' });
  f.poses.listed('aster', []);
  poseMenuActions(f.poses, (line) => logs.push(line)).setPose('pose_sit');
  await settle();
  assert.deepEqual(logs, ['set_pose id=pose_sit lock=false failed: 她正在做别的动作']);
});

test('linkPoses: her lists reach AvatarPoses, the lock is read from and written to config.json pose_lock, other keys kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pose-')), path = join(dir, 'config.json');
  try {
    writeFileSync(path, JSON.stringify({ render_fps: '60', pose_lock: { cedar: 'pose_lie', aster: 'pose_sit' } }));
    const listeners: ((e: LinkEvent) => void)[] = [], sent: string[] = [], logs: string[] = [];
    const link = {
      on: (l: (e: LinkEvent) => void) => { listeners.push(l); return () => {}; },
      sendSetPose: (id: string | null, lock: boolean, onResult?: (r: CommandResult) => void) => {
        sent.push(`${id} ${lock}`);
        onResult?.({ ok: true });
        return true;
      },
    };
    const poses = linkPoses({ link, configPath: path, log: (line) => logs.push(line) });
    const actions = { v: 1 as const, type: 'actions', character: 'aster', switches: {}, actions: [row('pose_sit', 'sit')] };
    for (const l of listeners) l({ kind: 'message', message: { ...actions, error: 'not_ready' } });
    assert.equal(poses.character, null);
    for (const l of listeners) l({ kind: 'message', message: actions });
    assert.deepEqual(sent, ['pose_sit true']);
    await poses.set(null, false);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { pose_lock: { cedar: 'pose_lie' }, render_fps: '60' });
    await poses.set('pose_sit', true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).pose_lock, { cedar: 'pose_lie', aster: 'pose_sit' });
    // An unreadable file: no lock and nothing written over it.
    writeFileSync(path, '[1]');
    for (const l of listeners) l({ kind: 'message', message: actions });
    await poses.set('pose_sit', true);
    assert.equal(readFileSync(path, 'utf8'), '[1]');
    assert.deepEqual(logs, ['pose_lock: config.json unreadable: config.json is not an object',
      'pose_lock: config.json not written: config.json is not an object']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
