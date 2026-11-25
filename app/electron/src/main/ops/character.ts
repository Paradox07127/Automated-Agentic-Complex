// `character.*` and `mmd.*`: the roster with its art, switching, the imported motions, the playlist in
// config.json, package import, motion, MMD and outfit import, the shared MMD library's list and its bake into the current
// character. The previews are not here.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { BridgeFailure } from '../../common/bridge.ts';
import {
  type ArtKind, artReference, characterEntry, decodePlaylists, importedMotions, isPackagePath, mmdEntries, type MotionFailure,
  MotionFailureError, motionID, motionReply, motionTitle, playlistArg, resultLine, toolFailure,
} from '../../common/character.ts';
import { parseCatalogDocument } from '../../common/config.ts';
import { silentSource } from '../../common/feed.ts';
import { type ImportKind, type ImportProgress, ImportTracker } from '../../common/import-state.ts';
import { MMD_SYNC_IDLE, MmdSync, mmdSyncArgs, mmdSyncResult } from '../../common/mmd-sync.ts';
import {
  BGM_EXTENSIONS, firstMissingComponent, importedMotion, importedOutfit, mediaChanged, MMD_SCAN_EXTENSIONS, mmdImportArgs, mmdMediaArgs,
  mmdPlanArg, type MmdScan, mmdScanArgs, MOTION_EXTENSIONS, motionFiles, motionImportArgs, motionImportTitle, outfitFailure,
  outfitImportArgs, outfitRemoveArgs, pickerExtensions, scannedMmd,
} from '../../common/imports.ts';
import { PushSource } from '../../common/push.ts';
import { HOST, SCHEME } from '../../common/ui.ts';
import { saveLastAppearance } from '../placement/store.ts';
import { filesOrFolderProperties } from '../platform/index.ts';
import { lastAppearance } from '../renderer/looks.ts';
import type { Ops, OpsContext, ToolResult } from './context.ts';
import { watch } from './events.ts';
import { holdingMotions, reloadAvatar } from './holding.ts';
import { readObject, writeObject } from './settings.ts';

const NOT_LINKED = '角色还没连上';
const NO_LINK = '角色还没连上（配置出错）';
const NO_LIBRARY = '没有配置角色目录';
/** Said when the character a page meant is no longer the current one. */
const CHANGED = '角色刚换过，这次没有改';

/** The character a page names: a 1–64-byte id, else null. */
const characterArg = (v: unknown): string | null => motionID(v);

/** The open panels the imports ask with; the tests answer without one. */
export interface ImportPicker {
  /** The chosen files; empty when cancelled. */
  files(o: { title: string; message: string; extensions: string[]; multiple: boolean }): Promise<string[]>;
  /** The chosen folder; null when cancelled. */
  folder(o: { title: string; message: string }): Promise<string | null>;
  /** Files, folders or both where one panel takes both, else files or a folder as `folder` says; empty when cancelled. */
  filesOrFolder(o: { title: string; message: string; extensions: string[]; folder: boolean }): Promise<string[]>;
}

/** Electron's open panel, on the focused window when there is one. */
async function openPanel(title: string, message: string, properties: ('openFile' | 'openDirectory' | 'multiSelections')[],
  extensions?: string[]): Promise<string[]> {
  const { BrowserWindow, dialog } = await import('electron');
  const options = { title, message, properties, filters: extensions && [{ name: title, extensions }] };
  const window = BrowserWindow.getFocusedWindow();
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
}

export const electronPicker: ImportPicker = {
  files: (o) => openPanel(o.title, o.message, o.multiple ? ['openFile', 'multiSelections'] : ['openFile'], o.extensions),
  folder: async (o) => (await openPanel(o.title, o.message, ['openDirectory']))[0] ?? null,
  filesOrFolder: (o) => openPanel(o.title, o.message, filesOrFolderProperties(o.folder), o.extensions),
};

interface Imports { tracker: ImportTracker; events: PushSource }
const importsByContext = new WeakMap<OpsContext, Imports>();

/** One per ops context, shared by `characterOps` and `mmdOps`. */
function imports(ctx: OpsContext): Imports {
  let found = importsByContext.get(ctx);
  if (found === undefined) {
    const events = new PushSource('import');
    found = { tracker: new ImportTracker((state) => events.send(state)), events };
    importsByContext.set(ctx, found);
  }
  return found;
}

/** The `缺 … 组件` detail the import panels are not opened with; null for none. */
function missingComponent(ctx: OpsContext): string | null {
  const id = firstMissingComponent(readObject(ctx.config.path).missing_components);
  return id === null ? null : `缺 ${id} 组件`;
}

/** A thrown failure as motion_tool's `{reason, detail}`. */
function motionFailure(e: unknown): MotionFailure {
  if (e instanceof MotionFailureError) return e.failure;
  if (e instanceof BridgeFailure) return { reason: e.code, detail: e.detail };
  return { reason: 'internal', detail: e instanceof Error ? e.message : String(e) };
}

/** The panels and motion_tool import on the current character while
 *  the switch is held, then the renderer restarts. `noLibrary` is the detail without a
 *  library. */
async function importMotion(ctx: OpsContext, picker: ImportPicker, kind: ImportKind, motion: string[], message: string,
  noLibrary: string): Promise<unknown> {
  try {
    const catalog = ctx.library?.catalog, link = ctx.avatar, sw = ctx.switcher;
    if (!catalog) throw new MotionFailureError({ reason: 'internal', detail: noLibrary });
    if (!link || !sw) throw new MotionFailureError({ reason: 'internal', detail: NO_LINK });
    return await holdingMotions(link, sw, async (character) => {
      ctx.mmdSync?.sync.checkIdle();
      const missing = missingComponent(ctx);
      if (missing !== null) throw new MotionFailureError({ reason: 'internal', detail: missing });
      const paths = await picker.files({ title: '导入动作', message, extensions: pickerExtensions(motion), multiple: true });
      if (paths.length === 0) return { ok: false, reason: 'cancelled' };
      const files = motionFiles(paths, motion);
      // Cancelling the BGM panel imports without BGM.
      const bgm = files.asksBgm ? (await picker.files({ title: '选择背景音乐', message: '可选：和动作一起播放的音频；取消则不带背景音乐导入',
        extensions: BGM_EXTENSIONS, multiple: false }))[0] ?? null : null;
      const action = await imports(ctx).tracker.run(kind, motionImportTitle(files.source), async (progress) => {
        const host = validationHost(ctx, (detail) => new MotionFailureError({ reason: 'validate_failed', detail }));
        const { last, status, stderr } = await ctx.library!.runTool('motion_tool.py',
          motionImportArgs(dirname(catalog), character, files.source, files.extras, bgm, host), progress);
        if (status !== 0) throw new MotionFailureError(toolFailure(stderr));
        return importedMotion(last);
      }, () => reloadAvatar(ctx, link));
      return { ok: true, action };
    });
  } catch (e) {
    return motionReply(motionFailure(e), false);
  }
}

/** The validation host, its failure made by `failed`. */
function validationHost(ctx: OpsContext, failed: (detail: string) => Error): string {
  try {
    return ctx.library!.validationHost();
  } catch (e) {
    throw failed(e instanceof Error ? e.message : String(e));
  }
}

/** `importOutfit` and `removeOutfit`: `body` on the current character while the switch is held; every failure is a BridgeFailure
 *  with outfit_tool's reason. With `expected`, `character_changed` when another character is current. */
async function onOutfit<T>(ctx: OpsContext, expected: string | null,
  body: (library: string, character: string, link: NonNullable<OpsContext['avatar']>) => Promise<T>): Promise<T> {
  try {
    const catalog = ctx.library?.catalog, link = ctx.avatar, sw = ctx.switcher;
    if (!catalog) throw new BridgeFailure('internal', NO_LIBRARY);
    if (!link || !sw) throw new BridgeFailure('internal', NO_LINK);
    return await holdingMotions(link, sw, (character) => {
      if (expected !== null && character !== expected) throw new BridgeFailure('character_changed', CHANGED);
      return body(dirname(catalog), character, link);
    });
  } catch (e) {
    if (e instanceof BridgeFailure) throw e;
    throw new BridgeFailure('internal', e instanceof Error ? e.message : String(e));
  }
}

/** agentd's character (`GET /state`); while agentd does not answer, the switch's current one. Null for none. */
async function currentCharacter(ctx: OpsContext): Promise<string | null> {
  try {
    const reply = await ctx.agentd?.request('GET', '/state');
    if (reply?.status === 200) {
      const character = (JSON.parse(reply.body.toString('utf8')) as Record<string, unknown>).character;
      if (typeof character === 'string' || character === null) return character;
    }
  } catch { /* falls back */ }
  return ctx.switcher?.current ?? null;
}

/** The directory of the library's `current.json`, which the tools take as `--library`. */
function libraryDir(ctx: OpsContext): string {
  if (!ctx.library?.catalog) throw new MotionFailureError({ reason: 'internal', detail: '没有配置角色目录' });
  return dirname(ctx.library.catalog);
}

/** The current character's appearances and the layers of the one she wears, as the renderer
 *  reported them, an imported appearance with the warnings of its import report in the package at `pkg`; nothing while it
 *  shows another character. */
function looksOf(ctx: OpsContext, id: string, pkg: string): Record<string, unknown> {
  const avatar = ctx.avatar;
  if (!avatar || avatar.currentCharacter !== id) return {};
  const worn = avatar.currentAppearance;
  const layers = avatar.layers.filter((l) => l.appearances === undefined || (worn !== null && l.appearances.includes(worn)))
    .map((l) => ({ id: l.id, name: l.name, visible: !avatar.hiddenLayers.includes(l.id) }));
  const appearances = avatar.appearances.map((a) => ({ id: a.id, name: a.name, desc: a.desc ?? '', ...(a.kind !== undefined ? { kind: a.kind } : {}),
    ...(a.kind === 'imported' ? { warnings: importWarnings(pkg, a.id) } : {}) }));
  return { appearances, ...(layers.length > 0 ? { layers } : {}) };
}

/** `warnings` of import_outfit's report on appearance `id` in the package at `pkg`; throws when it cannot be read. */
function importWarnings(pkg: string, id: string): string[] {
  const warnings = (JSON.parse(readFileSync(contained(pkg, `provenance/outfit-${id}.json`), 'utf8')) as Record<string, unknown>).warnings;
  if (!Array.isArray(warnings) || !warnings.every((w) => typeof w === 'string')) throw new Error(`bad_outfit_report: ${id}`);
  return warnings;
}

/** CharacterPackage.contained: `file` under `root` with no symbolic link on the way; throws otherwise. */
function contained(root: string, file: string): string {
  if (!isPackagePath(file)) throw new Error('escaping_or_executable_path');
  let path = root;
  for (const part of file.split('/')) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) throw new Error('runtime_symlink');
  }
  return path;
}

/** The package file behind `characters/<id>/<kind>.png` as CharacterPackage.resolve finds it
 *  (a listed reference, inside the package with no symbolic link on the way, of its size and sha256); null for an unknown id
 *  or a missing or refused file. */
export function characterArt(catalog: string, id: string, kind: ArtKind): string | null {
  try {
    const entry = parseCatalogDocument(readFileSync(catalog, 'utf8')).entries.find((e) => e.id === id);
    if (entry === undefined) return null;
    const definition = contained(realpathSync(dirname(catalog)), entry.definition);
    const ref = artReference(readFileSync(definition, 'utf8'), kind);
    if (ref === null) return null;
    const file = contained(dirname(definition), ref.file);
    const bytes = readFileSync(file);
    return bytes.length === ref.byteCount && createHash('sha256').update(bytes).digest('hex') === ref.sha256 ? file : null;
  } catch {
    return null;
  }
}

export interface ShellMmdSyncOptions {
  /** config.json `character_catalog`. */
  catalog: string;
  /** agentd's tool with its progress lines; `signal` asks it to stop. */
  runTool(script: string, args: string[], progress: (p: ImportProgress) => void, signal: AbortSignal): Promise<ToolResult>;
  /** The Metal host the tools validate with; throws the reason when there is none. */
  validationHost(): string;
  reload(): Promise<void>;
  /** The switch's current character. */
  current(): string | null;
  log(line: string): void;
}

/** The sync index.ts follows the switch's current character with, and the source of `mmd.onSync` (a `sync` stream that
 *  replays the last state). */
export function shellMmdSync(o: ShellMmdSyncOptions): { sync: MmdSync; events: PushSource } {
  const events = new PushSource('sync');
  const sync = new MmdSync({
    run: async (character, progress, signal) => {
      const { last, status, stderr } = await o.runTool('motion_tool.py',
        mmdSyncArgs(dirname(o.catalog), character, o.validationHost()), progress, signal);
      if (status === 0) return mmdSyncResult(last);
      // The next sync needs the library lock a stopped tool holds until it has exited.
      if (signal.aborted) return null;
      throw new MotionFailureError(toolFailure(stderr));
    },
    reload: o.reload, current: o.current, send: (state) => events.send(state), log: o.log,
  });
  return { sync, events };
}

export function characterOps(ctx: OpsContext, picker: ImportPicker = electronPicker): Ops {
  /** One motion_tool run on the current character at a time. */
  let held = false;

  async function tool(args: string[]): Promise<Record<string, unknown>> {
    const { last, status, stderr } = await ctx.library!.runTool('motion_tool.py', args);
    if (status !== 0) throw new MotionFailureError(toolFailure(stderr));
    return resultLine(last);
  }

  function host(): string {
    try {
      return ctx.library!.validationHost();
    } catch (e) {
      throw new MotionFailureError({ reason: 'validate_failed', detail: e instanceof Error ? e.message : String(e) });
    }
  }

  /** `body` on `expected`, as `{ok: true, ...}` or motion_tool's `{ok: false, reason, detail}`; `character_changed` when
   *  another character is current. An edit holds the switch; a read (`edits` false) holds nothing, so a switch need not wait. */
  async function onCurrent(expected: string, edits: boolean, body: (library: string, character: string) => Promise<Record<string, unknown>>):
    Promise<unknown> {
    try {
      const library = libraryDir(ctx);
      const sw = ctx.switcher;
      const current = async () => {
        const character = await currentCharacter(ctx);
        if (character === null) throw new MotionFailureError({ reason: 'internal', detail: NOT_LINKED });
        if (character !== expected) throw new MotionFailureError({ reason: 'character_changed', detail: CHANGED });
        return motionReply(await body(library, character), true);
      };
      if (!edits) return await current();
      if (held || sw?.busy || sw?.held) throw new MotionFailureError({ reason: 'busy', detail: '角色正在切换，或另一个导入还没完成' });
      held = true;
      if (sw) sw.held = true;
      try {
        // Read while held, so no switch can start between the read and the tool.
        return await current();
      } finally {
        held = false;
        if (sw) sw.held = false;
      }
    } catch (e) {
      const failure: MotionFailure = e instanceof MotionFailureError ? e.failure
        : { reason: 'internal', detail: e instanceof Error ? e.message : String(e) };
      return motionReply(failure, false);
    }
  }

  /** The current character; `character_changed` when it is not `expected` (null: any). */
  async function playlistCharacter(expected: string): Promise<string> {
    const character = await currentCharacter(ctx);
    if (character === null) throw new BridgeFailure('failed', NOT_LINKED);
    if (character !== expected) throw new BridgeFailure('character_changed', CHANGED);
    return character;
  }

  return {
    'character.list': async () => {
      const catalog = ctx.library?.catalog;
      if (!catalog) throw new BridgeFailure('failed', '没有配置角色目录');
      const current = await currentCharacter(ctx);
      try {
        const doc = parseCatalogDocument(readFileSync(catalog, 'utf8'));
        const root = resolve(dirname(catalog));
        return doc.entries.map((entry) => {
          const file = resolve(root, entry.definition);
          if (!file.startsWith(root + sep) || !existsSync(file)) throw new Error('missing_or_escaping_file');
          const active = entry.id === current;
          // A missing head, portrait or background is left out.
          const art = Object.fromEntries((['head', 'portrait', 'background'] as const).filter((kind) => characterArt(catalog, entry.id, kind) !== null)
            .map((kind) => [kind, `${SCHEME}://${HOST}/characters/${entry.id}/${kind}.png`]));
          const listed = { ...characterEntry(readFileSync(file, 'utf8'), entry.id, active), ...art };
          return active ? { ...listed, ...looksOf(ctx, entry.id, dirname(file)) } : listed;
        });
      } catch (e) {
        throw new BridgeFailure('failed', e instanceof Error ? e.message : String(e));
      }
    },
    /** A package or a folder with character.json, installed with character_tool; agentd started on an empty library has no
     *  mouth, persona or state to switch, so it starts again on the new one. */
    'character.switchTo': async ([id]) => {
      if (typeof id !== 'string' || id === '') throw new BridgeFailure('invalid_args', 'character id');
      if (!ctx.switcher) throw new BridgeFailure('unavailable', NOT_LINKED);
      const outcome = await ctx.switcher.switchOutcome(id);
      switch (outcome.kind) {
        case 'switched': return { ok: true };
        case 'failed': return { ok: false, stage: outcome.stage, reason: outcome.reason };
        case 'superseded': return { ok: false, stage: 'prepare', reason: 'superseded' };
        case 'noAvatar': throw new BridgeFailure('unavailable', NOT_LINKED);
      }
    },
    'character.importPackage': async () => {
      const catalog = ctx.library?.catalog;
      if (!catalog) return { ok: false, reason: '没有配置角色目录' };
      // The install's failure.
      const missing = missingComponent(ctx);
      if (missing !== null) return { ok: false, reason: `角色包导入失败：${missing}` };
      const source = await ctx.dialog.pickPackage();
      if (source === null) return { ok: false, reason: 'cancelled' };
      let reply;
      try {
        reply = await ctx.library!.runTool('character_tool.py',
          ['install', source, '--library', dirname(catalog), '--validate-with', ctx.library!.validationHost()]);
      } catch (e) {
        return { ok: false, reason: `角色包导入失败：${e instanceof Error ? e.message : String(e)}` };
      }
      if (reply.status !== 0) return { ok: false, reason: `角色包导入失败：${reply.stderr}` };
      ctx.library!.rosterChanged();
      // A renderer stopped for want of a character starts on the new roster.
      if (await currentCharacter(ctx) === null && ctx.supervisor) {
        ctx.log('first character imported: restarting children');
        ctx.supervisor.restart();
        ctx.supervisor.restartAvatar?.();
      }
      return { ok: true };
    },
    'character.importMotion': () => importMotion(ctx, picker, 'motion', MOTION_EXTENSIONS,
      '选择 VMD、BVH、glTF/GLB、VRMA 或 FBX 动作文件，或装着 VMD 的 ZIP；可多选', NO_LIBRARY),
    'character.importOutfit': () => onOutfit(ctx, null, async (library, character, link) => {
      const missing = missingComponent(ctx);
      if (missing !== null) throw new BridgeFailure('internal', missing);
      const source = await picker.folder({ title: '导入外观（EFMI mod）', message: '选择包含 mod.ini 的 mod 目录；只导入到本机' });
      if (source === null) throw new BridgeFailure('cancelled', 'character.importOutfit');
      const outfit = await imports(ctx).tracker.run('outfit', basename(source), async (progress) => {
        const host = validationHost(ctx, (detail) => new BridgeFailure('validate_failed', detail));
        const { last, status, stderr } = await ctx.library!.runTool('outfit_tool.py', outfitImportArgs(library, character, source, host),
          progress);
        if (status !== 0) throw outfitFailure(stderr, basename(source));
        return importedOutfit(last);
      }, () => reloadAvatar(ctx, link));
      return { ok: true, appearance: { id: outfit.id, name: outfit.name }, warnings: outfit.warnings };
    }),
    'character.removeOutfit': ([of, id]) => {
      // C3 appearance ids are 1–64 bytes, as action ids are.
      const expected = characterArg(of), appearance = motionID(id);
      if (expected === null || appearance === null) throw new BridgeFailure('bad_args', 'character.removeOutfit');
      return onOutfit(ctx, expected, async (library, character, link) => {
        const host = validationHost(ctx, (detail) => new BridgeFailure('validate_failed', detail));
        const { status, stderr } = await ctx.library!.runTool('outfit_tool.py', outfitRemoveArgs(library, character, appearance, host));
        if (status !== 0) throw outfitFailure(stderr, null);
        // C3: the first appearance of her list is her default.
        const supportDir = ctx.config.supportDir, original = link.appearances[0]?.id;
        if (supportDir !== null && original !== undefined && lastAppearance(supportDir, character) === appearance) {
          saveLastAppearance(supportDir, character, original);
        }
        await reloadAvatar(ctx, link);
        return { ok: true, appearance: { id: appearance } };
      });
    },
    'character.listImportedMotions': ([of]) => {
      const expected = characterArg(of);
      if (expected === null) throw new BridgeFailure('bad_args', 'character.listImportedMotions');
      return onCurrent(expected, false, async (library, character) => ({
        motions: importedMotions(await tool(['list', '--library', library, '--character', character])),
      }));
    },
    'character.renameMotion': ([of, id, title]) => {
      const expected = characterArg(of), action = motionID(id), name = motionTitle(title);
      if (expected === null || action === null || name === null) throw new BridgeFailure('bad_args', 'character.renameMotion');
      return onCurrent(expected, true, async (library, character) => {
        ctx.mmdSync?.sync.checkIdle();
        const line = await tool(['rename', '--library', library, '--character', character, '--action', action, `--title=${name}`,
          '--validate-with', host()]);
        if (typeof line.title !== 'string') throw new MotionFailureError({ reason: 'internal', detail: `motion_tool printed no result: ${JSON.stringify(line)}` });
        if (ctx.avatar) await reloadAvatar(ctx, ctx.avatar);
        return { id: action, title: line.title };
      });
    },
    'character.removeMotion': ([of, id]) => {
      const expected = characterArg(of), action = motionID(id);
      if (expected === null || action === null) throw new BridgeFailure('bad_args', 'character.removeMotion');
      return onCurrent(expected, true, async (library, character) => {
        ctx.mmdSync?.sync.checkIdle();
        await tool(['remove', '--library', library, '--character', character, '--action', action, '--validate-with', host()]);
        // So the stored switch table does not keep ids past C3's 128-entry cap.
        const config = readObject(ctx.config.path);
        const all = config.action_switches;
        const table = typeof all === 'object' && all !== null ? (all as Record<string, unknown>)[character] : undefined;
        if (typeof table === 'object' && table !== null && action in table) {
          delete (table as Record<string, unknown>)[action];
          writeObject(ctx.config.path, config);
        }
        if (ctx.avatar) await reloadAvatar(ctx, ctx.avatar);
        return { id: action };
      });
    },
    'character.importState': () => imports(ctx).tracker.state,
    'character.onImport': watch('character.onImport', imports(ctx).events),
    'character.getPlaylist': async ([of]) => {
      const expected = characterArg(of);
      if (expected === null) throw new BridgeFailure('invalid_args', 'character id');
      const character = await playlistCharacter(expected);
      const list = decodePlaylists(readObject(ctx.config.path).motion_playlists)[character] ?? { items: [], loop: 'off', speed: 1 };
      return { items: list.items, loop: list.loop, speed: list.speed };
    },
    'character.setPlaylist': async ([of, value]) => {
      const expected = characterArg(of);
      if (expected === null) throw new BridgeFailure('invalid_args', 'character id');
      const list = playlistArg(value);
      const character = await playlistCharacter(expected);
      const config = readObject(ctx.config.path);
      const table = decodePlaylists(config.motion_playlists);
      table[character] = list;
      config.motion_playlists = table;
      writeObject(ctx.config.path, config);
      return { ok: true };
    },
  };
}

const SCAN_GONE: MotionFailure = { reason: 'scan_gone', detail: '识别结果已失效，请重新导入' };

/** `mmd.scan` unpacks into a fresh folder under `scanRoot`; the one scan waiting for its import keeps its folder until a new
 *  scan, its import or `mmd.dropScan`. */
export function mmdOps(ctx: OpsContext, picker: ImportPicker = electronPicker, scanRoot = join(tmpdir(), 'agentic-complex-mmd-scan')): Ops {
  let pending: { token: string; dir: string; scan: MmdScan } | null = null;
  const drop = () => {
    if (pending !== null) rmSync(pending.dir, { recursive: true, force: true });
    pending = null;
  };

  /** `body` on the current character while the switch is held, the sync idle and her components there. */
  async function onMmd<T>(body: (link: NonNullable<OpsContext['avatar']>, library: string, character: string) => Promise<T>): Promise<T> {
    const catalog = ctx.library?.catalog, link = ctx.avatar, sw = ctx.switcher;
    if (!catalog) throw new MotionFailureError({ reason: 'internal', detail: NO_LIBRARY });
    if (!link || !sw) throw new MotionFailureError({ reason: 'internal', detail: NO_LINK });
    ctx.mmdSync?.sync.checkIdle();
    return await holdingMotions(link, sw, async (character) => {
      ctx.mmdSync?.sync.checkIdle();
      const missing = missingComponent(ctx);
      if (missing !== null) throw new MotionFailureError({ reason: 'internal', detail: missing });
      return body(link, dirname(catalog), character);
    });
  }

  return {
    'mmd.list': async () => {
      try {
        const library = libraryDir(ctx);
        const { last, status, stderr } = await ctx.library!.runTool('motion_tool.py', ['mmd-list', '--library', library]);
        if (status !== 0) throw new MotionFailureError(toolFailure(stderr));
        return motionReply({ entries: mmdEntries(resultLine(last)) }, true);
      } catch (e) {
        return motionReply(e instanceof MotionFailureError ? e.failure
          : { reason: 'internal', detail: e instanceof Error ? e.message : String(e) }, false);
      }
    },
    'mmd.scan': async ([options]) => {
      if (typeof options !== 'object' || options === null || typeof (options as { folder?: unknown }).folder !== 'boolean') {
        throw new BridgeFailure('bad_args', 'mmd.scan');
      }
      try {
        const library = ctx.library;
        if (!library) throw new MotionFailureError({ reason: 'internal', detail: NO_LIBRARY });
        const missing = missingComponent(ctx);
        if (missing !== null) throw new MotionFailureError({ reason: 'internal', detail: missing });
        drop();
        const paths = await picker.filesOrFolder({ title: '导入 MMD', message: '选择 MMD 工程的文件夹、ZIP，或 VMD 和音频文件；可多选',
          extensions: MMD_SCAN_EXTENSIONS, folder: (options as { folder: boolean }).folder });
        if (paths.length === 0) return { ok: false, reason: 'cancelled' };
        const token = randomUUID(), dir = join(scanRoot, token);
        mkdirSync(scanRoot, { recursive: true });
        try {
          const { last, status, stderr } = await library.runTool('motion_tool.py', mmdScanArgs(paths, dir));
          if (status !== 0) throw new MotionFailureError(toolFailure(stderr));
          const scan = scannedMmd(last);
          drop();
          pending = { token, dir, scan };
          return { ok: true, token, scan };
        } catch (e) {
          rmSync(dir, { recursive: true, force: true });
          throw e;
        }
      } catch (e) {
        return motionReply(motionFailure(e), false);
      }
    },
    'mmd.dropScan': ([token]) => {
      if (pending?.token === token) drop();
      return undefined;
    },
    /** Each item in turn; the first failure stops the rest and comes back with the actions already imported. */
    'mmd.importScan': async ([value]) => {
      const done: unknown[] = [];
      const failed = (e: unknown) => ({ ...motionReply(motionFailure(e), false), actions: done });
      let scan: MmdScan;
      try {
        ctx.mmdSync?.sync.checkIdle();
        const token = typeof value === 'object' && value !== null ? (value as { token?: unknown }).token : undefined;
        if (pending === null || token !== pending.token) throw new MotionFailureError(SCAN_GONE);
        scan = pending.scan;
      } catch (e) {
        return failed(e);
      }
      const plan = mmdPlanArg(value, scan);
      try {
        await onMmd(async (link, library, character) => {
          // From here the scan's folder is this import's; a new scan does not delete it.
          const taken = pending!;
          pending = null;
          try {
            for (const [i, item] of plan.items.entries()) {
              const body = scan.bodies[item.body]!;
              const path = <T extends { path: string }>(list: T[], index: number | null) => (index === null ? null : list[index]!.path);
              const reload = i === plan.items.length - 1 ? () => reloadAvatar(ctx, link) : async () => {};
              done.push(await imports(ctx).tracker.run('mmd', item.title, async (progress) => {
                const host = validationHost(ctx, (detail) => new MotionFailureError({ reason: 'validate_failed', detail }));
                const { last, status, stderr } = await ctx.library!.runTool('motion_tool.py', mmdImportArgs(library, character, {
                  source: body.path, morph: path(scan.faces, plan.face), camera: path(scan.cameras, plan.camera),
                  bgm: path(scan.audio, plan.audio), bgmStartS: plan.bgmStartS, title: item.title, project: plan.project, role: body.label,
                }, host), progress);
                if (status !== 0) throw new MotionFailureError(toolFailure(stderr));
                return importedMotion(last);
              }, reload));
            }
          } catch (e) {
            // The ones already published restart her.
            if (done.length > 0) await reloadAvatar(ctx, link);
            throw e;
          } finally {
            rmSync(taken.dir, { recursive: true, force: true });
          }
        });
        return { ok: true, actions: done };
      } catch (e) {
        return failed(e);
      }
    },
    'mmd.setMedia': async ([id, media]) => {
      const action = motionID(id);
      const m = typeof media === 'object' && media !== null ? media as { bgm?: unknown; bgmStartS?: unknown } : {};
      if (action === null || (m.bgm !== 'pick' && m.bgm !== 'none')
        || !(m.bgmStartS === null || (typeof m.bgmStartS === 'number' && Number.isFinite(m.bgmStartS)))) {
        throw new BridgeFailure('bad_args', 'mmd.setMedia');
      }
      const bgmStartS = m.bgmStartS as number | null;
      try {
        return await onMmd(async (link, library, character) => {
          const bgm = m.bgm === 'pick'
            ? (await picker.files({ title: '选择音源', message: '和这支舞一起播放的音频', extensions: BGM_EXTENSIONS, multiple: false }))[0] ?? null
            : null;
          if (m.bgm === 'pick' && bgm === null) return { ok: false, reason: 'cancelled' };
          const changed = await imports(ctx).tracker.run('mmd', bgm === null ? '' : motionImportTitle(bgm), async (progress) => {
            const host = validationHost(ctx, (detail) => new MotionFailureError({ reason: 'validate_failed', detail }));
            const { last, status, stderr } = await ctx.library!.runTool('motion_tool.py',
              mmdMediaArgs(library, character, action, bgm, bgmStartS, host), progress);
            if (status !== 0) throw new MotionFailureError(toolFailure(stderr));
            return mediaChanged(last);
          }, () => reloadAvatar(ctx, link));
          return { ok: true, ...changed };
        });
      } catch (e) {
        return motionReply(motionFailure(e), false);
      }
    },
    'mmd.syncState': () => ctx.mmdSync?.sync.state ?? MMD_SYNC_IDLE,
    'mmd.onSync': watch('mmd.onSync', ctx.mmdSync?.events ?? silentSource),
  };
}
