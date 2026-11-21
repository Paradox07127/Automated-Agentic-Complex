// Her look: what the renderer reports goes into state.json and config.json,
// a remembered look that differs at hello is sent once, and the bridge ops wait for the renderer's reply. Platform-free.
import {
  type ModReceipt, type ModValues, storedModSettings, storedSwitches, type SwitchReply, withModSettings, withSwitches, modArgument,
} from '../../common/looks.ts';
import { agentdSwitchPorts, type SwitchPorts } from '../../common/switch.ts';
import { readObject, writeObject } from '../ops/settings.ts';
import { readState, saveHiddenLayers, saveLastAppearance, saveLastCharacter } from '../placement/store.ts';
import { ActionFailure, type HostLink, type LinkEvent, type Remembered } from './link.ts';

type LooksLink = Pick<HostLink, 'on' | 'currentCharacter' | 'currentAppearance' | 'appearances' | 'layers' | 'hiddenLayers'
  | 'appearanceSwitching' | 'layersSwitching' | 'sendSetAppearance' | 'sendSetLayers' | 'saveSwitches' | 'setModSettings'>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const failed = (text: string) => new ActionFailure('failed', text);

/** config.json as an object; `{}` when it does not read as one. */
function readConfig(path: string): Record<string, unknown> {
  try {
    return readObject(path);
  } catch {
    return {};
  }
}

export function lastAppearance(supportDir: string, character: string): string | null {
  const per = readState(supportDir).last_appearance;
  const id = isObject(per) ? per[character] : undefined;
  return typeof id === 'string' ? id : null;
}

/** Null when none is remembered (all shown). */
function hiddenLayers(supportDir: string, character: string): string[] | null {
  const per = readState(supportDir).hidden_layers;
  const hidden = isObject(per) ? per[character] : undefined;
  return Array.isArray(hidden) && hidden.every((h) => typeof h === 'string') ? hidden : null;
}

/** What the host link sends of a character's remembered look, read at each use. */
export function rememberedLooks(supportDir: string, configPath: string): Remembered {
  return {
    hiddenLayers: (character) => hiddenLayers(supportDir, character),
    modSettings: (character) => storedModSettings(readConfig(configPath), character),
    switches: (character) => storedSwitches(readConfig(configPath), character),
  };
}

/** The character switch's ports over the host link, the support dir and agentd's HTTP API. */
export function linkSwitchPorts(o: {
  link: Pick<HostLink, 'sendSetCharacter'>; supportDir: string;
  agentd: ((method: string, path: string, json?: unknown) => Promise<{ status: number; body: Uint8Array }>) | null;
  agentdRunning(): boolean; restartAvatar(id: string): void; renderable(id: string): boolean; log(line: string): void;
}): SwitchPorts {
  const agentd = agentdSwitchPorts(o.agentd ?? (async () => { throw new Error('agentd 没有配置'); }));
  return {
    ...agentd, agentdRunning: o.agentdRunning, restartAvatar: o.restartAvatar, renderable: o.renderable,
    setCharacter: (id) => o.link.sendSetCharacter(id, lastAppearance(o.supportDir, id)),
    persist: (id) => saveLastCharacter(o.supportDir, id),
    log: (line) => o.log(`AVATAR ${line}`),
  };
}

export interface LooksOptions {
  link: LooksLink;
  supportDir: string;
  configPath: string;
  log(line: string): void;
}

export class AvatarLooks {
  private readonly o: LooksOptions;
  private unsubscribe: (() => void) | null = null;

  constructor(options: LooksOptions) {
    this.o = options;
  }

  start(): void {
    this.unsubscribe ??= this.o.link.on((e) => this.event(e));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private event(e: LinkEvent): void {
    const { link, supportDir } = this.o;
    if (e.kind === 'modSettings') return this.record(e.receipt);
    if (e.kind === 'appearance') {
      const a = e.event;
      if (a.kind === 'list') {
        // An imported appearance deleted from her package takes its mod settings with it.
        if (a.options.length > 0) this.prune(a.character, a.options.map((x) => x.id));
        const remembered = lastAppearance(supportDir, a.character);
        if (a.atHello && remembered !== null && remembered !== a.current && a.options.some((x) => x.id === remembered)) {
          this.o.log(`AVATAR hello appearance=${a.current ?? '-'} differs from remembered ${remembered}`);
          link.sendSetAppearance(remembered);
        } else if (a.current !== null) {
          saveLastAppearance(supportDir, a.character, a.current);
        }
      } else if (a.kind === 'changed' && link.currentCharacter !== null) {
        saveLastAppearance(supportDir, link.currentCharacter, a.id);
      } else if (a.kind === 'failed') {
        this.o.log(`AVATAR appearance switch to ${a.id} failed: ${a.reason}`);
      }
      return;
    }
    if (e.kind !== 'layers') return;
    const l = e.event;
    if (l.kind === 'list') {
      if (l.layers.length === 0) return;
      const saved = hiddenLayers(supportDir, l.character);
      if (saved !== null) {
        const remembered = l.layers.map((x) => x.id).filter((id) => saved.includes(id));
        if (remembered.length !== l.hidden.length || !remembered.every((id) => l.hidden.includes(id))) {
          this.o.log(`AVATAR layers hidden=${l.hidden.join(',')} differ from remembered ${remembered.join(',')}`);
          link.sendSetLayers(remembered);
          return;
        }
      }
      saveHiddenLayers(supportDir, l.character, l.hidden);
    } else if (l.kind === 'changed' && link.currentCharacter !== null) {
      saveHiddenLayers(supportDir, link.currentCharacter, l.hidden);
    } else if (l.kind === 'failed') {
      this.o.log(`AVATAR layers change to hidden=${l.hidden.join(',')} failed: ${l.reason}`);
    }
  }

  /** Resolves with her reply to the `set_appearance` / `set_layers` just sent: `ok`, or the failure's reason. */
  private reply(kind: 'appearance' | 'layers', matches: (e: LinkEvent) => 'ok' | string | null): Promise<string> {
    return new Promise((resolve) => {
      const off = this.o.link.on((e) => {
        const r = e.kind === 'lost' ? 'connection_lost' : e.kind === kind ? matches(e) : null;
        if (r === null) return;
        off();
        resolve(r);
      });
    });
  }

  /** setAppearanceAndWait: returns once the current character wears `id`; throws when she does not. */
  async setAppearance(id: string): Promise<void> {
    const link = this.o.link, character = link.currentCharacter;
    if (character === null || !link.appearances.some((a) => a.id === id)) throw failed('角色没有这个外观');
    if (link.currentAppearance === id) return;
    if (link.appearanceSwitching || !link.sendSetAppearance(id)) throw failed('角色没有连上，或者正在换外观');
    const reason = await this.reply('appearance', (e) => (e.kind === 'appearance' && e.event.kind !== 'list' && e.event.id === id
      ? (e.event.kind === 'changed' ? 'ok' : e.event.reason) : null));
    if (link.currentCharacter !== character || link.currentAppearance !== id) throw failed(`外观没有换成：${reason === 'ok' ? 'load_failed' : reason}`);
  }

  /** setLayersAndWait: returns once she reports `hidden`; a failure leaves the old set. */
  async setLayers(hidden: string[]): Promise<void> {
    const link = this.o.link, character = link.currentCharacter, ids = link.layers.map((l) => l.id);
    if (character === null || ids.length === 0) throw failed('这个角色没有可以隐藏的层');
    if (!hidden.every((h) => ids.includes(h))) throw failed('这个角色没有这一层');
    const same = (a: string[]) => new Set(a).size === new Set(hidden).size && a.every((h) => hidden.includes(h));
    if (same(link.hiddenLayers)) return;
    if (link.layersSwitching || !link.sendSetLayers(hidden)) throw failed('角色没有连上，或者正在换服装分层');
    const reason = await this.reply('layers', (e) => (e.kind === 'layers' && e.event.kind !== 'list'
      ? (e.event.kind === 'changed' ? 'ok' : e.event.reason) : null));
    if (link.currentCharacter !== character || !same(link.hiddenLayers)) throw failed(`服装分层没有换成：${reason === 'ok' ? 'load_failed' : reason}`);
  }

  /** Stores the user's table, then sends it; the store stays when this throws. */
  saveSwitches(character: string, switches: Record<string, boolean>): Promise<SwitchReply> {
    writeObject(this.o.configPath, withSwitches(readConfig(this.o.configPath), character, switches));
    return this.o.link.saveSwitches(character, switches);
  }

  modSettings(character: string): Record<string, ModValues> {
    return storedModSettings(readConfig(this.o.configPath), character);
  }

  /** Sends one appearance's whole set and stores what she reports drawing. */
  async saveModSettings(character: string, appearance: string, values: ModValues): Promise<ModReceipt> {
    const receipt = await this.o.link.setModSettings(character, appearance, values);
    this.record(receipt);
    return receipt;
  }

  /** Unless the character's set would no longer fit one line. */
  private record(receipt: ModReceipt): void {
    const all = { ...this.modSettings(receipt.character), [receipt.appearance]: receipt.values };
    if (modArgument(all) === null) return;
    writeObject(this.o.configPath, withModSettings(readConfig(this.o.configPath), receipt.character, all));
  }

  private prune(character: string, keeping: string[]): void {
    const stored = this.modSettings(character);
    const kept = Object.fromEntries(Object.entries(stored).filter(([a]) => keeping.includes(a)));
    if (Object.keys(kept).length !== Object.keys(stored).length) {
      writeObject(this.o.configPath, withModSettings(readConfig(this.o.configPath), character, kept));
    }
  }
}
