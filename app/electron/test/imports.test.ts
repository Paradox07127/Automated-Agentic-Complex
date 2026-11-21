// The import ops' pure rules for motions and outfits.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeFailure } from '../src/common/bridge.ts';
import { MotionFailureError } from '../src/common/character.ts';
import {
  BGM_EXTENSIONS, importedMotion, importedOutfit, MMD_EXTENSIONS, MOTION_EXTENSIONS, motionFiles, motionImportArgs, outfitFailure,
  outfitImportArgs, outfitRemoveArgs, pickerExtensions,
} from '../src/common/imports.ts';

const motionFailure = (reason: string, detail: string) => (e: unknown) =>
  e instanceof MotionFailureError && e.failure.reason === reason && e.failure.detail === detail;
const bridgeFailure = (code: string, detail: string) => (e: unknown) => e instanceof BridgeFailure && e.code === code && e.detail === detail;

test('the motion panel offers the motion types, and ZIP only along with VMD', () => {
  assert.deepEqual(MOTION_EXTENSIONS, ['vmd', 'bvh', 'glb', 'gltf', 'vrma', 'fbx']);
  assert.deepEqual(MMD_EXTENSIONS, ['vmd']);
  assert.deepEqual(pickerExtensions(MOTION_EXTENSIONS), [...MOTION_EXTENSIONS, 'zip']);
  assert.deepEqual(pickerExtensions(MMD_EXTENSIONS), ['vmd', 'zip']);
  assert.deepEqual(pickerExtensions(['bvh']), ['bvh']);
});

test('the BGM panel offers the audio types motion_tool takes', () => {
  assert.deepEqual(BGM_EXTENSIONS, ['wav', 'mp3', 'm4a', 'aac', 'flac', 'aif', 'aiff']);
});

test('the source is the first ZIP, else the first file; the rest are extras', () => {
  assert.deepEqual(motionFiles(['/m/a.vmd', '/m/b.ZIP', '/m/c.vmd'], MOTION_EXTENSIONS),
    { source: '/m/b.ZIP', extras: ['/m/a.vmd', '/m/c.vmd'], asksBgm: false });
  assert.deepEqual(motionFiles(['/m/a.bvh', '/m/c.vmd'], MOTION_EXTENSIONS), { source: '/m/a.bvh', extras: ['/m/c.vmd'], asksBgm: false });
});

test('only one non-ZIP file asks for a BGM', () => {
  assert.equal(motionFiles(['/m/a.vmd'], MOTION_EXTENSIONS).asksBgm, true);
  assert.equal(motionFiles(['/m/a.zip'], MOTION_EXTENSIONS).asksBgm, false);
});

test('a file of a type the panel did not offer is unsupported_format with its name', () => {
  assert.throws(() => motionFiles(['/m/a.vmd', '/m/notes.txt'], MOTION_EXTENSIONS), motionFailure('unsupported_format', 'notes.txt'));
  assert.throws(() => motionFiles(['C:\\m\\walk.bvh'], MMD_EXTENSIONS), motionFailure('unsupported_format', 'walk.bvh'));
  assert.throws(() => motionFiles(['/m/noext'], MOTION_EXTENSIONS), motionFailure('unsupported_format', 'noext'));
  assert.throws(() => motionFiles(['/m/a.zip'], ['bvh']), motionFailure('unsupported_format', 'a.zip'));
});

test('motion_tool import takes the extras, then the BGM, then the host', () => {
  assert.deepEqual(motionImportArgs('/lib', 'si', '/m/a.vmd', ['/m/b.vmd', '/m/c.vmd'], '/m/s.mp3', '/host'),
    ['import', '--library', '/lib', '--character', 'si', '--source', '/m/a.vmd', '--extra', '/m/b.vmd', '--extra', '/m/c.vmd',
      '--bgm', '/m/s.mp3', '--validate-with', '/host']);
  assert.deepEqual(motionImportArgs('/lib', 'si', '/m/a.vmd', [], null, '/host'),
    ['import', '--library', '/lib', '--character', 'si', '--source', '/m/a.vmd', '--validate-with', '/host']);
});

test('motion_tool import\'s result line is the action; format defaults to vmd and warnings to none', () => {
  assert.deepEqual(importedMotion('{"ok": true, "action": {"id": "a", "title": "t", "duration_s": 3, "has_bgm": false}}'),
    { id: 'a', title: 't', durationS: 3, hasBgm: false, format: 'vmd', warnings: [] });
  assert.deepEqual(importedMotion('{"ok": true, "action": {"id": "a", "title": "t", "duration_s": 1.5, "has_bgm": true}, "format": "bvh", "warnings": ["w"]}'),
    { id: 'a', title: 't', durationS: 1.5, hasBgm: true, format: 'bvh', warnings: ['w'] });
});

test('a motion result line that is not ok or lacks an action field is internal', () => {
  for (const line of ['', 'done', '{"ok": false, "action": {"id": "a", "title": "t", "duration_s": 3, "has_bgm": false}}',
    '{"ok": true, "action": {"id": "a", "title": "t", "duration_s": "3", "has_bgm": false}}',
    '{"ok": true, "action": {"id": "a", "title": "t", "duration_s": 3, "has_bgm": false}, "warnings": [1]}']) {
    assert.throws(() => importedMotion(line), motionFailure('internal', `motion_tool printed no result: ${line}`));
  }
});

test('outfit_tool import and remove take the library, character, source or appearance, and host', () => {
  assert.deepEqual(outfitImportArgs('/lib', 'si', '/mods/Red', '/host'),
    ['import', '--library', '/lib', '--character', 'si', '--source', '/mods/Red', '--validate-with', '/host']);
  assert.deepEqual(outfitRemoveArgs('/lib', 'si', 'mod_1', '/host'),
    ['remove', '--library', '/lib', '--character', 'si', '--appearance', 'mod_1', '--validate-with', '/host']);
});

test('outfit_tool import\'s result line is the appearance and its warnings', () => {
  assert.deepEqual(importedOutfit('{"ok": true, "appearance": {"id": "mod_1", "name": "Red"}, "warnings": ["texture_unbound:a.dds"]}'),
    { id: 'mod_1', name: 'Red', warnings: ['texture_unbound:a.dds'] });
  assert.deepEqual(importedOutfit('{"ok": true, "appearance": {"id": "mod_1", "name": "Red"}}'), { id: 'mod_1', name: 'Red', warnings: [] });
  for (const line of ['', '{"ok": false, "appearance": {"id": "mod_1", "name": "Red"}}', '{"ok": true, "appearance": {"id": "mod_1"}}']) {
    assert.throws(() => importedOutfit(line), bridgeFailure('internal', `outfit_tool printed no result: ${line}`));
  }
});

test('outfit_tool\'s failure line passes any reason on; plain text is internal with the stderr\'s end', () => {
  const f = outfitFailure('log\n{"reason": "new_code", "detail": "d"}\n', null);
  assert.deepEqual([f.code, f.detail], ['new_code', 'd']);
  const n = outfitFailure('{"reason": "busy"}', null);
  assert.deepEqual([n.code, n.detail], ['busy', '']);
  const t = outfitFailure(`${'x'.repeat(2100)}\n  crash  \n`, null);
  assert.deepEqual([t.code, t.detail], ['internal', `${'x'.repeat(2100)}\n  crash  \n`.slice(-2000).trim()]);
});

test('an outfit import failure names the mod folder before its detail', () => {
  const f = outfitFailure('{"reason": "unsafe_path", "detail": "unsafe_path:../x"}', 'Red Coat');
  assert.deepEqual([f.code, f.detail], ['unsafe_path', 'Red Coat: unsafe_path:../x']);
});
