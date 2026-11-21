// src/main/camera/shell.ts as index.ts wires it, over a real HostLink and a fake avatar on its socket: `camera_gesture`
// saves the camera to a temporary config.json, her list sends the stored pose lock again, `pose_state` reaches the poses and
// the sessions page asks for the close-up.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CAMERA_OFFERS, type ShellCamera, shellCamera } from '../src/main/camera/shell.ts';
import { HostLink } from '../src/main/renderer/link.ts';
import { FakeAvatar } from './fake-avatar.ts';

const UNIX_LINK = process.platform === 'win32' ? "the fake avatar connects to the link's Unix socket, macOS's C3 transport" : false;
const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));
async function until(seconds: number, ok: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await sleep(0.01);
  }
  return ok();
}

class FakeWindow extends EventEmitter {
  url = 'agentic://ui/main.html#/home';
  readonly webContents = Object.assign(new EventEmitter(), { getURL: () => this.url });
  isVisible() { return true; }
  isMinimized() { return false; }
}

test('shellCamera over HostLink: gesture saved and sent, pose lock sent again on her list, pose_state kept, close-up on the sessions page',
  { skip: UNIX_LINK }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cam-')), configPath = join(dir, 'config.json'), logs: string[] = [], restarts: string[] = [];
    writeFileSync(configPath, JSON.stringify({ render_camera_yaw: 0, render_camera_auto_closeup: 'session', pose_lock: { aster: 'pose_sit' } }));
    let camera: ShellCamera | null = null;
    const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
      fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: (l) => logs.push(l),
      onPoseState: (s) => camera?.poses.state(s), onCameraGesture: (g) => camera?.camera.gesture(g), offers: ['render_live', ...CAMERA_OFFERS] });
    camera = shellCamera({ link, configPath, avatarPid: () => 99,
      save: (values) => writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, 'utf8')), ...values })),
      restartAvatar: () => restarts.push('restart'), figure: () => link.avatarFrame, overlay: null, log: (l) => logs.push(l) });
    await link.start();
    const a = new FakeAvatar(link.path, true);
    try {
      a.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, character: 'aster',
        capabilities: ['ack', 'actions', 'poses', 'camera_gesture', 'render_live', 'camera_free'] });
      // The link counts as connected at her hello; its own hello reaches her a moment later.
      assert.ok(await until(2, () => link.connected && a.got.length > 0));
      for (const c of ['render_live', 'poses', 'camera_free', 'camera_gesture']) assert.ok((a.got[0]!.capabilities as string[]).includes(c), c);

      a.send({ type: 'camera_gesture', phase: 'began', dx: 0, dy: 0, zoom: 1 });
      a.send({ type: 'camera_gesture', phase: 'changed', dx: 10, dy: 0, zoom: 1.5 });
      a.send({ type: 'camera_gesture', phase: 'ended', dx: 0, dy: 0, zoom: 1 });
      assert.ok(await until(2, () => a.got.filter((m) => m.type === 'set_render').length >= 2), `${a.types()}`);
      const renders = a.got.filter((m) => m.type === 'set_render');
      assert.deepEqual(renders[0]!.camera, { yaw: 4, pitch: 0, zoom: 1.5, live: true });
      assert.equal(typeof renders[1]!.req, 'number');
      assert.deepEqual(renders[1]!.camera, { mode: 'show', yaw: 4, pitch: 0, zoom: 1.5, sway: false });
      const saved = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.deepEqual([saved.render_camera_yaw, saved.render_camera_pitch, saved.render_camera_zoom], [4, 0, 1.5]);

      a.send({ type: 'actions', character: 'aster', switches: {}, actions: [{ id: 'pose_sit', name: '坐', section: 'pose', duration: null,
        trigger: '', required_reason: null, missing: null, pose: 'sit' }] });
      assert.ok(await until(2, () => a.last('set_pose') !== undefined), `${a.types()}`);
      assert.deepEqual({ ...a.last('set_pose'), req: 0 }, { v: 1, type: 'set_pose', character: 'aster', id: 'pose_sit', lock: true, req: 0 });
      a.send({ type: 'pose_state', character: 'aster', id: 'pose_sit', locked: true });
      assert.ok(await until(2, () => camera!.poses.current === 'pose_sit' && camera!.poses.locked));

      const win = new FakeWindow();
      camera.mainWindow(win);
      win.url = 'agentic://ui/main.html#/overview?focus=running';
      win.webContents.emit('did-navigate-in-page');
      assert.ok(await until(3, () => a.got.some((m) => m.type === 'set_render' && (m.camera as { closeup?: boolean }).closeup === true)), `${a.types()}`);
      assert.deepEqual(restarts, []);
    } finally {
      camera.stop();
      a.socket.destroy();
      link.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
