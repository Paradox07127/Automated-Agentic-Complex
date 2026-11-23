// The character card's side of C3 rule 47: the pose slots from `actions[].pose`, one `set_pose` per
// `set`, and the user's lock per character in config.json `pose_lock`, sent again when the character's list arrives; the
// menu's pose items.
import type { ActionRow } from '../../common/c3.ts';
import type { CommandResult, LinkEvent, PoseState } from '../renderer/link.ts';
import { readObject, writeObject } from '../ops/settings.ts';

export interface PoseSlot {
  slot: string;
  /** The pose row's action id; null when the character has no row for this slot. */
  id: string | null;
  available: boolean;
  /** Why the slot cannot be chosen; null when it can. */
  reason: string | null;
}

export interface PosePorts {
  /** Sends `set_pose` for the avatar's character; `answer` runs once with its `ack`. False when not sent. */
  setPose(id: string | null, lock: boolean, answer: (r: CommandResult) => void): boolean;
  /** `pose_lock[character]`; null when there is none. */
  lock(character: string): string | null;
  /** Writes `pose_lock[character]`; null removes it. */
  setLock(character: string, id: string | null): void;
  /** Runs `fire` after `seconds`; returns its cancel. */
  schedule?(seconds: number, fire: () => void): () => void;
}

/** C3 rule 47 `actions[].pose`, in menu order. */
export const POSE_SLOTS = ['stand', 'akimbo', 'sit', 'floor', 'lie'] as const;
export const POSE_TITLES: Readonly<Record<string, string>> = { stand: '站', akimbo: '叉腰', sit: '坐', floor: '坐地', lie: '躺' };
const NO_ROW = '这个角色没有这个姿态的原作动作';
const REPLY_TIMEOUT = 2;
const FAILURES: Readonly<Record<string, string>> = { unsupported: '这个版本的角色不支持姿态', timeout: '角色没有回应', invalid: '角色没有这个姿态',
  busy: '角色正在做别的动作', disconnected: '和角色的连接断了' };

/** AvatarPoses.Failure: `reason` is `unsupported`, `timeout` or the `ack.error`. */
export class PoseFailure extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(FAILURES[reason] ?? '没能摆出这个姿态');
    this.reason = reason;
  }
}

const timer = (seconds: number, fire: () => void) => {
  const t = setTimeout(fire, seconds * 1000);
  return () => clearTimeout(t);
};

export class AvatarPoses {
  private readonly ports: PosePorts;
  /** The character of the last list; `set` sends for it and writes its lock. */
  character: string | null = null;
  slots: PoseSlot[] = [];
  /** From the last `pose_state`: the held row's id, null when she is automatic. */
  current: string | null = null;
  locked = false;

  constructor(ports: PosePorts) {
    this.ports = ports;
  }

  /** Rule 47 (a), (f): one slot per name from the list's pose rows; a stored lock on an available row is sent again. */
  listed(character: string, actions: ActionRow[]): PoseSlot[] {
    if (character !== this.character) {
      this.current = null;
      this.locked = false;
    }
    this.character = character;
    this.slots = POSE_SLOTS.map((slot) => {
      const row = actions.find((a) => a.pose === slot);
      return row ? { slot, id: row.id, available: row.missing === null, reason: row.missing } : { slot, id: null, available: false, reason: NO_ROW };
    });
    const id = this.ports.lock(character);
    if (id !== null && this.slots.some((s) => s.id === id && s.available)) this.ports.setPose(id, true, () => {});
    return this.slots;
  }

  /** Resolves once the avatar acks `ok`, then stores `id` as the character's lock when `lock` is true and clears it otherwise. */
  async set(id: string | null, lock: boolean): Promise<void> {
    const character = this.character;
    if (character === null) throw new PoseFailure('unsupported');
    await new Promise<void>((resolve, reject) => {
      let open = true, cancel = () => {};
      const answer = (r: CommandResult) => {
        if (!open) return;
        open = false;
        cancel();
        if (r.ok) resolve();
        else reject(new PoseFailure(r.reason));
      };
      if (!this.ports.setPose(id, lock, answer)) return answer({ ok: false, reason: 'unsupported' });
      if (open) cancel = (this.ports.schedule ?? timer)(REPLY_TIMEOUT, () => answer({ ok: false, reason: 'timeout' }));
    });
    this.ports.setLock(character, lock ? id : null);
  }

  /** Drops a state of a character other than the last list's. */
  state(s: PoseState): void {
    if (s.character !== this.character) return;
    this.current = s.id;
    this.locked = s.locked;
  }
}

/** The menu's pose items; null when no slot has a row, as the avatar then did not list `poses`. */
export function poseMenu(poses: AvatarPoses): { options: (PoseSlot & { title: string })[]; current: string | null; locked: boolean } | null {
  if (!poses.slots.some((s) => s.id !== null)) return null;
  return { options: poses.slots.map((s) => ({ ...s, title: POSE_TITLES[s.slot] ?? s.slot })), current: poses.current, locked: poses.locked };
}

/** The menu's pose actions; a failure is logged. */
export function poseMenuActions(poses: AvatarPoses, log: (line: string) => void): { setPose(id: string | null): void; togglePoseLock(): void } {
  const run = (id: string | null, lock: boolean) => {
    poses.set(id, lock).catch((e: unknown) => log(`set_pose id=${id ?? 'null'} lock=${lock} failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  return {
    // A held lock carries over to the next slot; 自动 releases it.
    setPose: (id) => run(id, id !== null && poses.locked),
    togglePoseLock: () => run(poses.current, !poses.locked),
  };
}

/** The poses over the host link with `pose_lock` in config.json;
 *  give the returned poses' `state` the link's onPoseState. */
export function linkPoses(o: {
  link: { on(listener: (e: LinkEvent) => void): () => void; sendSetPose(id: string | null, lock: boolean, onResult?: (r: CommandResult) => void): boolean };
  configPath: string;
  log(line: string): void;
}): AvatarPoses {
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const poses = new AvatarPoses({
    setPose: (id, lock, answer) => o.link.sendSetPose(id, lock, answer),
    lock: (character) => {
      let object: Record<string, unknown>;
      try {
        object = readObject(o.configPath);
      } catch (e) {
        o.log(`pose_lock: config.json unreadable: ${message(e)}`);
        return null;
      }
      const id = (object.pose_lock as Record<string, unknown> | undefined)?.[character];
      return typeof id === 'string' ? id : null;
    },
    setLock: (character, id) => {
      try {
        const object = readObject(o.configPath);
        const all = typeof object.pose_lock === 'object' && object.pose_lock !== null && !Array.isArray(object.pose_lock)
          ? { ...object.pose_lock as Record<string, unknown> } : {};
        if (id === null) delete all[character];
        else all[character] = id;
        writeObject(o.configPath, { ...object, pose_lock: all });
      } catch (e) {
        o.log(`pose_lock: config.json not written: ${message(e)}`);
      }
    },
  });
  o.link.on((e) => {
    if (e.kind !== 'message' || e.message.type !== 'actions' || e.message.error !== undefined) return;
    const { character, actions } = e.message;
    if (typeof character === 'string' && Array.isArray(actions)) poses.listed(character, actions as ActionRow[]);
  });
  return poses;
}
