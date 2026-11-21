// `character.list`'s head and portrait and the scheme's `characters/<id>/<kind>.png`, over a library in a temporary directory.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CSP } from '../src/common/ui.ts';
import { characterArt, characterOps } from '../src/main/ops/character.ts';
import type { OpsContext } from '../src/main/ops/context.ts';
import { type ArtImage, uiServer } from '../src/main/ui-scheme.ts';

const SYMLINKS = process.platform === 'win32' ? 'symbolic links need a privilege on Windows' : false;

const tmp = mkdtempSync(join(tmpdir(), 'art-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const library = join(tmp, 'library');
const catalog = join(library, 'current.json');
writeFileSync(join(tmp, 'secret.png'), 'secret');

const ref = (file: string, bytes: string) => ({ file, sha256: createHash('sha256').update(bytes).digest('hex'), byte_count: Buffer.byteLength(bytes) });

/** A package `id` whose `components.ui` is `ui`, its references listed in the inventory unless `inventory` is false; `files` are
 *  written under it. */
function pack(id: string, files: Record<string, string>, ui: (r: Record<string, ReturnType<typeof ref>>) => Record<string, unknown>,
  inventory = true) {
  const refs: Record<string, ReturnType<typeof ref>> = {};
  for (const [file, bytes] of Object.entries(files)) {
    mkdirSync(join(library, id, file, '..'), { recursive: true });
    writeFileSync(join(library, id, file), bytes);
    refs[file] = ref(file, bytes);
  }
  mkdirSync(join(library, id), { recursive: true });
  const components = { ui: ui(refs) };
  writeFileSync(join(library, id, 'character.json'), JSON.stringify({ id, display: { name: { 'zh-Hans': id } }, components,
    inventory: inventory ? Object.values(components.ui) : [] }));
}

pack('si', { 'ui/head.png': 'head', 'ui/portrait.png': 'portrait' }, (r) => ({ head: r['ui/head.png'], portrait: r['ui/portrait.png'] }));
pack('cedar', { 'ui/head.png': 'head' }, (r) => ({ head: { ...r['ui/head.png'], sha256: '0'.repeat(64) } }));
pack('voice_a', { 'ui/head.png': 'head' }, (r) => ({ head: r['ui/head.png'] }), false);
pack('ember', {}, () => ({ head: ref('../../secret.png', 'secret'), portrait: ref('/etc/hosts', 'x') }));
pack('wulfgard', { 'ui/head.py': 'head' }, (r) => ({ head: r['ui/head.py'] }));
pack('yvonne', { 'ui/head.png': 'head' }, (r) => ({ head: r['ui/head.png'] }));
rmSync(join(library, 'yvonne', 'ui', 'head.png'));
writeFileSync(catalog, JSON.stringify({ schema: 'endfield-character-library/v1', characters: ['si', 'cedar', 'voice_a', 'ember', 'wulfgard',
  'yvonne'].map((id) => ({ id, definition: { file: `${id}/character.json` } })) }));

test('the art file is the package\'s ui reference when it is listed, inside the package and of its size and sha256', () => {
  // The library's directory with its symbolic links resolved.
  const real = realpathSync(library);
  assert.equal(characterArt(catalog, 'si', 'head'), join(real, 'si', 'ui', 'head.png'));
  assert.equal(characterArt(catalog, 'si', 'portrait'), join(real, 'si', 'ui', 'portrait.png'));
  assert.equal(characterArt(catalog, 'cedar', 'head'), null, 'sha256 mismatch');
  assert.equal(characterArt(catalog, 'cedar', 'portrait'), null, 'no portrait');
  assert.equal(characterArt(catalog, 'voice_a', 'head'), null, 'not in the inventory');
  assert.equal(characterArt(catalog, 'ember', 'head'), null, 'leaves the package');
  assert.equal(characterArt(catalog, 'ember', 'portrait'), null, 'absolute');
  assert.equal(characterArt(catalog, 'wulfgard', 'head'), null, 'executable suffix');
  assert.equal(characterArt(catalog, 'yvonne', 'head'), null, 'missing file');
  assert.equal(characterArt(catalog, 'nobody', 'head'), null, 'unknown id');
  assert.equal(characterArt(join(tmp, 'no-library.json'), 'si', 'head'), null);
});

test('a symbolic link in the package, or a package reached through one, leaves no art to read', { skip: SYMLINKS }, () => {
  pack('lifeng', {}, () => ({ head: ref('ui/head.png', 'secret') }));
  mkdirSync(join(library, 'lifeng', 'ui'), { recursive: true });
  symlinkSync(join(tmp, 'secret.png'), join(library, 'lifeng', 'ui', 'head.png'));
  const linked = join(tmp, 'linked-library');
  mkdirSync(linked);
  symlinkSync(join(library, 'si'), join(linked, 'si'));
  const linkedCatalog = join(linked, 'current.json');
  writeFileSync(linkedCatalog, JSON.stringify({ schema: 'endfield-character-library/v1', characters: [{ id: 'si', definition: { file: 'si/character.json' } }] }));
  const lifengCatalog = join(tmp, 'lifeng.json');
  writeFileSync(lifengCatalog, JSON.stringify({ schema: 'endfield-character-library/v1',
    characters: [{ id: 'lifeng', definition: { file: 'library/lifeng/character.json' } }] }));
  assert.equal(characterArt(lifengCatalog, 'lifeng', 'head'), null, 'a linked art file');
  assert.equal(characterArt(linkedCatalog, 'si', 'head'), null, 'a linked package');
});

test('character.list gives head and portrait URLs only for the art there is', async () => {
  const ctx = { library: { catalog, launched: 'si' }, agentd: null, avatar: null, log: () => {} } as unknown as OpsContext;
  const listed = await characterOps(ctx)['character.list']!([], null as never) as Record<string, unknown>[];
  assert.deepEqual(listed.map((e) => [e.id, e.head ?? null, e.portrait ?? null]), [
    ['si', 'agentic-complex-ui://app/characters/si/head.png', 'agentic-complex-ui://app/characters/si/portrait.png'],
    ['cedar', null, null], ['voice_a', null, null], ['ember', null, null], ['wulfgard', null, null], ['yvonne', null, null],
  ]);
  assert.equal('head' in listed[1]!, false, 'absent, as Swift leaves a nil key out');
});

test('the scheme serves the head as it is and the portrait at most 1024 pixels on its longest side, once per character', () => {
  const root = join(tmp, 'dist');
  mkdirSync(root, { recursive: true });
  const images: string[] = [];
  const image = (file: string): ArtImage => {
    images.push(file);
    return {
      isEmpty: () => false, getSize: () => ({ width: 2048, height: 3072 }), toPNG: () => Buffer.from('full'),
      resize: (o) => ({ toPNG: () => Buffer.from(`${o.width}x${o.height} ${o.quality}`) }),
    };
  };
  const serve = uiServer(root, null, { file: (id, kind) => characterArt(catalog, id, kind), image });
  const head = serve('agentic-complex-ui://app/characters/si/head.png');
  assert.equal(head.status, 200);
  assert.equal(head.headers['Content-Type'], 'image/png');
  assert.equal(head.headers['Content-Security-Policy'], CSP);
  assert.equal(head.headers['Content-Length'], '4');
  assert.equal(head.body.toString(), 'head');
  assert.equal(serve('agentic-complex-ui://app/characters/si/portrait.png').body.toString(), '683x1024 best');
  assert.equal(serve('agentic-complex-ui://app/characters/si/portrait.png').status, 200);
  assert.deepEqual(images, [join(realpathSync(library), 'si', 'ui', 'portrait.png')], 'the downscaled portrait is kept');
  for (const url of [
    'agentic-complex-ui://app/characters/cedar/head.png',
    'agentic-complex-ui://app/characters/ember/head.png',
    'agentic-complex-ui://app/characters/si/head.jpg',
    'agentic-complex-ui://app/characters/si/face.png',
    'agentic-complex-ui://app/characters/si/ui/head.png',
    'agentic-complex-ui://app/characters/..%2Fsecret/head.png',
    'agentic-complex-ui://app/characters/%2E%2E/head.png',
    'agentic-complex-ui://other/characters/si/head.png',
  ]) {
    const r = serve(url);
    assert.equal(r.status, 404, url);
    assert.equal(r.body.length, 0, url);
    assert.equal(r.headers['Content-Security-Policy'], CSP, url);
  }
  const small = uiServer(root, null, { file: (id, kind) => characterArt(catalog, id, kind),
    image: () => ({ isEmpty: () => false, getSize: () => ({ width: 300, height: 200 }), toPNG: () => Buffer.from('small'),
      resize: () => { throw new Error('not resized'); } }) });
  assert.equal(small('agentic-complex-ui://app/characters/si/portrait.png').body.toString(), 'small');
  const broken = uiServer(root, null, { file: (id, kind) => characterArt(catalog, id, kind),
    image: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0), resize: () => { throw new Error('empty'); } }) });
  assert.equal(broken('agentic-complex-ui://app/characters/si/portrait.png').status, 404, 'an unreadable image');
});
