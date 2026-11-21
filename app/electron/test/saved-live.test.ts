// What a settings save sends the running renderer (src/main/renderer/saved.ts): the touch
// settings and the live render settings, against a fake link.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommandResult } from '../src/main/renderer/link.ts';
import { liveSaved } from '../src/main/renderer/saved.ts';

function setup(f: { sent?: boolean; link?: boolean } = {}) {
  const renders: Record<string, unknown>[] = [], results: ((r: CommandResult) => void)[] = [], log: string[] = [];
  let touches = 0, restarts = 0;
  const link = {
    sendSetRender: (payload: Record<string, unknown>, onResult?: (r: CommandResult) => void) => {
      renders.push(payload);
      results.push(onResult!);
      return f.sent ?? true;
    },
    touchSettingsChanged: () => { touches += 1; return true; },
  };
  const saved = liveSaved({ link: f.link === false ? null : link, settings: () => ({ render_outline: 'subtle', stay_mode: 'bust' }),
    restartAvatar: () => { restarts += 1; }, log: (line) => log.push(line) });
  return { saved, renders, results, log, touches: () => touches, restarts: () => restarts };
}

test('a save of the touch switches sends them to the renderer again (touchSettingsSaved)', () => {
  const s = setup();
  s.saved.touch();
  assert.equal(s.touches(), 1);
  setup({ link: false }).saved.touch();
});

test('live render settings go as one set_render of the saved values; a failed or unsent one restarts her (renderLiveSaved)', () => {
  const s = setup();
  s.saved.renderLive(['render_outline', 'stay_mode']);
  assert.equal(s.renders.length, 1);
  assert.equal(s.renders[0]!.outline, 'subtle');
  assert.equal((s.renders[0]!.camera as { framing: string }).framing, 'bust');
  s.results[0]!({ ok: true });
  assert.deepEqual([s.restarts(), s.log], [0, []]);
  s.results[0]!({ ok: false, reason: 'timeout' });
  assert.deepEqual([s.restarts(), s.log], [1, ['render live fallback keys=render_outline,stay_mode why=timeout']]);
  const unsent = setup({ sent: false });
  unsent.saved.renderLive(['render_dof']);
  assert.deepEqual([unsent.restarts(), unsent.log], [1, ['render live fallback keys=render_dof why=not_sent']]);
  const none = setup({ link: false });
  none.saved.renderLive(['render_filter']);
  assert.deepEqual([none.restarts(), none.log], [1, ['render live fallback keys=render_filter why=not_sent']]);
});
