// The import ops' pure rules for motions, MMD projects and outfits.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeFailure } from '../src/common/bridge.ts';
import { MotionFailureError } from '../src/common/character.ts';
import {
  BGM_EXTENSIONS, importedMotion, importedOutfit, mediaChanged, MMD_EXTENSIONS, mmdImportArgs, mmdMediaArgs, mmdPlanArg, mmdScanArgs,
  MOTION_EXTENSIONS, motionFiles, motionImportArgs, outfitFailure, outfitImportArgs, outfitRemoveArgs, pickerExtensions, scannedMmd,
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

const SCAN_LINE = {
  ok: true, title: '愛包ダンスホール', root: '/u/scan-1',
  bodies: [{ path: '/u/scan-1/a.vmd', name: 'a.vmd', label: 'HimeTanaka', model: '田中ヒメ ver1.20', duration_s: 223.33, place_frame: -19,
    has_morph: true }],
  faces: [{ path: '/u/scan-1/lip.vmd', name: 'lip.vmd', duration_s: 210, morphs: 5 }],
  cameras: [{ path: '/u/scan-1/cam.vmd', name: 'cam.vmd', duration_s: 223, place_frame: null }],
  audio: [{ path: '/u/scan-1/inst.wav', name: 'inst.wav' }],
  ignored: [{ name: 'Readme.txt', reason: 'not_motion' }],
  suggested: { body: 0, face: null, camera: 0, audio: 0, bgm_start_s: -0.633 },
};

test('motion_tool mmd-scan takes the first path as the source, the rest as extras, then the unpack folder', () => {
  assert.deepEqual(mmdScanArgs(['/m/pack', '/m/song.wav'], '/tmp/u/1'),
    ['mmd-scan', '--source', '/m/pack', '--extra', '/m/song.wav', '--unpack-to', '/tmp/u/1']);
  assert.deepEqual(mmdScanArgs(['/m/a.zip'], '/tmp/u/1'), ['mmd-scan', '--source', '/m/a.zip', '--unpack-to', '/tmp/u/1']);
});

test('motion_tool mmd-scan\'s result line in camelCase', () => {
  assert.deepEqual(scannedMmd(JSON.stringify(SCAN_LINE)), {
    title: '愛包ダンスホール', root: '/u/scan-1',
    bodies: [{ path: '/u/scan-1/a.vmd', name: 'a.vmd', label: 'HimeTanaka', model: '田中ヒメ ver1.20', durationS: 223.33, placeFrame: -19,
      hasMorph: true }],
    faces: [{ path: '/u/scan-1/lip.vmd', name: 'lip.vmd', durationS: 210, morphs: 5 }],
    cameras: [{ path: '/u/scan-1/cam.vmd', name: 'cam.vmd', durationS: 223, placeFrame: null }],
    audio: [{ path: '/u/scan-1/inst.wav', name: 'inst.wav' }],
    ignored: [{ name: 'Readme.txt', reason: 'not_motion' }],
    suggested: { body: 0, face: null, camera: 0, audio: 0, bgmStartS: -0.633 },
  });
});

test('an mmd-scan line that is not ok, lacks a list or has a field of the wrong type is internal', () => {
  const { faces: _, ...noFaces } = SCAN_LINE;
  for (const line of ['', 'done', JSON.stringify({ ...SCAN_LINE, ok: false }), JSON.stringify(noFaces),
    JSON.stringify({ ...SCAN_LINE, bodies: [{ ...SCAN_LINE.bodies[0], duration_s: '223' }] }),
    JSON.stringify({ ...SCAN_LINE, cameras: [{ ...SCAN_LINE.cameras[0], place_frame: 'x' }] }),
    JSON.stringify({ ...SCAN_LINE, suggested: { ...SCAN_LINE.suggested, body: null } })]) {
    assert.throws(() => scannedMmd(line), motionFailure('internal', `motion_tool printed no result: ${line}`));
  }
});

test('motion_tool import of a scanned body takes its face, camera, music and offset, its title, the song and the role', () => {
  assert.deepEqual(mmdImportArgs('/lib', 'si', { source: '/u/a.vmd', morph: '/u/lip.vmd', camera: '/u/cam.vmd', bgm: '/u/inst.wav',
    bgmStartS: -0.633, title: '愛包 · Hime', project: '愛包', role: 'Hime' }, '/host'),
  ['import', '--library', '/lib', '--character', 'si', '--source', '/u/a.vmd', '--morph', '/u/lip.vmd', '--camera', '/u/cam.vmd',
    '--bgm', '/u/inst.wav', '--bgm-start=-0.633', '--title=愛包 · Hime', '--project=愛包', '--role=Hime', '--validate-with', '/host']);
  // An offset without music says nothing.
  assert.deepEqual(mmdImportArgs('/lib', 'si', { source: '/u/a.vmd', morph: null, camera: null, bgm: null, bgmStartS: 2,
    title: '-x', project: '-p', role: '-r' }, '/host'),
  ['import', '--library', '/lib', '--character', 'si', '--source', '/u/a.vmd', '--title=-x', '--project=-p', '--role=-r',
    '--validate-with', '/host']);
});

test('motion_tool mmd-media takes the new music and offset, or --no-bgm', () => {
  assert.deepEqual(mmdMediaArgs('/lib', 'si', 'mmd_1', '/m/song.mp3', 1.5, '/host'),
    ['mmd-media', '--library', '/lib', '--character', 'si', '--action', 'mmd_1', '--bgm', '/m/song.mp3', '--bgm-start=1.5',
      '--validate-with', '/host']);
  assert.deepEqual(mmdMediaArgs('/lib', 'si', 'mmd_1', '/m/song.mp3', null, '/host'),
    ['mmd-media', '--library', '/lib', '--character', 'si', '--action', 'mmd_1', '--bgm', '/m/song.mp3', '--validate-with', '/host']);
  assert.deepEqual(mmdMediaArgs('/lib', 'si', 'mmd_1', null, 1.5, '/host'),
    ['mmd-media', '--library', '/lib', '--character', 'si', '--action', 'mmd_1', '--no-bgm', '--validate-with', '/host']);
});

test('motion_tool mmd-media\'s result line is the action, its id unchanged, with its new music', () => {
  assert.deepEqual(mediaChanged('{"ok": true, "character": "si", "version": "1.0.2", "action": {"id": "mmd_1", "title": "t", "duration_s": 3, "has_bgm": true}}'),
    { id: 'mmd_1', title: 't', durationS: 3, hasBgm: true, format: 'vmd', warnings: [] });
  const line = '{"ok": true, "action": {"id": "mmd_1", "title": "t", "duration_s": 3}}';
  assert.throws(() => mediaChanged(line), motionFailure('internal', `motion_tool printed no result: ${line}`));
});

test('mmd.importScan\'s plan: indices into the scan, 1–64-character titles, a finite offset; anything else is bad_args', () => {
  const scan = scannedMmd(JSON.stringify({ ...SCAN_LINE, bodies: [SCAN_LINE.bodies[0], { ...SCAN_LINE.bodies[0], name: 'b.vmd' }] }));
  const plan = { token: 't', items: [{ body: 1, title: ' 愛包 · B ' }], face: 0, camera: null, audio: 0, bgmStartS: -0.633, project: '愛包' };
  assert.deepEqual(mmdPlanArg(plan, scan), { ...plan, items: [{ body: 1, title: '愛包 · B' }] });
  const bad = bridgeFailure('bad_args', 'mmd.importScan');
  for (const p of [null, { ...plan, items: [] }, { ...plan, items: [{ body: 2, title: 'x' }] }, { ...plan, items: [{ body: 0, title: ' ' }] },
    { ...plan, items: [{ body: 0, title: 'x' }, { body: 0, title: 'y' }] }, { ...plan, face: 1 }, { ...plan, camera: -1 },
    { ...plan, audio: 0.5 }, { ...plan, bgmStartS: Number.NaN }, { ...plan, bgmStartS: '1' }, { ...plan, project: 3 }, { ...plan, token: 1 }]) {
    assert.throws(() => mmdPlanArg(p, scan), bad, JSON.stringify(p));
  }
});
