import { useEffect, useState } from 'react';
import { getBridge, type ActionProgress, type ActionSpeed, type AvatarAction } from '../../bridge';
import type { Toast } from '../../features/character/feedback';
import { ADJUSTED, NO_REASON, PLAY_REFUSED, playRefusedSeverity, SECTIONS } from './labels';
import type { MotionGroup } from './MotionTable';
import type { StageStatus } from './Stage';

const ORDER = Object.keys(SECTIONS);
const SAVE_REFUSED: Record<string, string> = {
  wrong_character: '当前加载的角色不匹配',
  switching: '角色切换进行中',
  not_ready: '角色仍在加载中',
  not_implemented: '当前版本暂不支持',
  character_changed: '当前角色已切换',
};
const codeOf = (e: unknown) => (e as { code?: string } | null)?.code ?? '';
/** How long the stage says 桌面播放中 for a motion without a duration. */
const UNTIMED_MS = 3000;

/** Actions grouped by section in the host's order (unknown keys last), numbered across the table. */
export function groupMotions(actions: AvatarAction[]): MotionGroup[] {
  const keys = [...new Set(actions.map((a) => a.section ?? ''))].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  let n = 0;
  return keys.map((key) => ({
    key,
    name: SECTIONS[key]?.name ?? (key || '其他'),
    rows: actions.filter((a) => (a.section ?? '') === key).map((a) => ({ a, no: String(++n).padStart(2, '0') })),
  }));
}

/** Why the desktop cannot preview the motion now; null when it can. */
export function blockedReason(a: AvatarAction | undefined, offline: boolean, switching: boolean): string | null {
  if (offline) return '角色未运行';
  if (switching) return '切换中 │ 输入暂停';
  if (!a) return '没有选中动作';
  if (a.missing) return `${a.missingReason ?? '缺少资源'} │ 不支持预览`;
  if (a.playable === false) return '由行为触发 │ 不支持单独预览';
  return null;
}

/** The line under the stage beside 桌面预览: why it cannot play (a `warn`), else what holds it or what the desktop plays, else that BGM keeps it at 1×. */
export function deckLine(why: string | null, blocked: string | null, play: ReturnType<typeof useMotions>['play'], oneSpeed: boolean): StageStatus | null {
  if (why) return { text: why, tone: 'warn' };
  if (blocked) return { text: blocked };
  if (play?.loop) return { text: `循环中 │ ${play.label}` };
  if (play) return { text: `桌面播放中 │ ${play.label}${play.progress != null && play.durationS != null ? ` ${(play.progress * play.durationS).toFixed(1)} / ${play.durationS.toFixed(1)} s` : ''}` };
  return oneSpeed ? { text: '带背景音乐 │ 只能 1× 播放' } : null;
}

export interface Play {
  id: string;
  t0: number;
  speed: number;
  /** Plays until `stop`: no progress, no end of its own. */
  loop: boolean;
  /** The shell has reported it: its end is the report's, not the clock's. */
  reported?: boolean;
}

/** `character`'s switch drafts saved as one group, and the desktop preview with its progress, the shell's `reported` one when it
 *  sends one, else local; another character starts with none. */
export function useMotions(o: { character: string; actions: AvatarAction[]; toast: Toast; seed?: Record<string, boolean>; playing?: string | null;
  reported?: ActionProgress | null }) {
  const [draft, setChanged] = useState<Record<string, boolean>>(() => o.seed ?? {});
  // What the last save answered, over `actions` until they are read again.
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [savedOver, setSavedOver] = useState(o.actions);
  if (savedOver !== o.actions && Object.keys(saved).length > 0) setSaved({});
  // A draft switch of an action she no longer has is neither shown nor sent.
  const changed = Object.fromEntries(Object.entries(draft).filter(([id]) => o.actions.some((a) => a.id === id)));
  const [play, setPlay] = useState<Play | null>(() => (o.playing ? { id: o.playing, t0: Date.now(), speed: 1, loop: false } : null));
  const [owner, setOwner] = useState(o.character);
  if (owner !== o.character) {
    setOwner(o.character);
    setChanged({});
    setSaved({});
    // The switch restarted the avatar, which ended what she played.
    setPlay(null);
  }
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [, tick] = useState(0);
  const base = (a: AvatarAction) => saved[a.id] ?? a.enabled;
  const value = (a: AvatarAction) => changed[a.id] ?? base(a);
  const reported = play && o.reported?.id === play.id ? o.reported : null;
  if (play && reported && !play.reported) setPlay({ ...play, reported: true });
  if (play?.reported && !reported) setPlay(null);
  const playing = play ? o.actions.find((a) => a.id === play.id) : undefined;
  const dur = play && !play.loop && playing?.durationS != null ? (playing.durationS * 1000) / play.speed : null;
  const progress = reported ? reported.tS / reported.durationS : play && dur != null ? Math.min(1, (Date.now() - play.t0) / dur) : null;

  useEffect(() => {
    if (!play || play.loop || play.reported || o.playing) return;
    if (dur == null) {
      const t = window.setTimeout(() => setPlay(null), UNTIMED_MS);
      return () => window.clearTimeout(t);
    }
    if (progress != null && progress >= 1) { setPlay(null); return; }
    const t = window.setInterval(() => tick((x) => x + 1), 100);
    return () => window.clearInterval(t);
  }, [play, dur, progress, o.playing]);

  const toggle = (a: AvatarAction, on: boolean) =>
    setChanged((c) => {
      const next = { ...c };
      if (on === base(a)) delete next[a.id];
      else next[a.id] = on;
      return next;
    });

  const save = () => {
    const sent = changed;
    const n = Object.keys(sent).length;
    setSaving(true);
    getBridge()
      .avatar.setActionSwitches(o.character, sent)
      .then(
        (r) => {
          if (r.error) return o.toast(`保存失败：${SAVE_REFUSED[r.error] ?? NO_REASON}`, { severity: 'danger' });
          // The host's table is the truth: it may keep required, missing or last-in-section actions on.
          setSaved((x) => ({ ...x, ...r.switches }));
          setSavedOver(o.actions);
          // A switch changed again while the save was out stays a change.
          setChanged((c) => Object.fromEntries(Object.entries(c).filter(([id, v]) => sent[id] !== v)));
          const back = r.adjusted.map((a) => `${o.actions.find((m) => m.id === a.id)?.label ?? a.id}（${ADJUSTED[a.reason] ?? NO_REASON}）`);
          o.toast(back.length ? `动作开关已保存 │ 以下项目已自动恢复：${back.join('、')}` : `动作开关已保存 │ ${n} 项`);
        },
        (e: unknown) => o.toast(`保存失败：${SAVE_REFUSED[codeOf(e)] ?? '角色渲染进程无响应'}`, { severity: 'danger' }),
      )
      .finally(() => setSaving(false));
  };

  const preview = async (a: AvatarAction, speed: ActionSpeed, loop = false) => {
    if (previewing) return;
    setPreviewing(true);
    try {
      const avatar = getBridge().avatar;
      if (!(await avatar.state()).visible) {
        await avatar.setVisible(true);
        if (!(await avatar.state()).visible) {
          o.toast('播放失败：角色仍处于隐藏状态，请先通过角色菜单显示角色', { severity: 'danger' });
          return;
        }
      }
      if (loop) await avatar.playAction(a.id, speed, { loop: true });
      else await avatar.playAction(a.id, speed);
      setPlay({ id: a.id, t0: Date.now(), speed, loop });
    } catch (e) {
      o.toast(PLAY_REFUSED[codeOf(e)] ?? '播放失败：角色渲染进程未确认播放，请检查角色是否已显示且连接正常', { severity: playRefusedSeverity(codeOf(e)) });
    } finally { setPreviewing(false); }
  };

  const stop = () =>
    getBridge()
      .avatar.stopAction()
      .then(
        () => setPlay(null),
        (e: unknown) => o.toast(`停止失败：${codeOf(e) === 'not_implemented' ? '当前版本暂不支持' : '角色渲染进程无响应'}`, { severity: 'danger' }),
      );

  return {
    value,
    changed,
    toggle,
    undo: () => setChanged({}),
    save,
    saving,
    preview,
    previewing,
    stop,
    play: play && playing ? { label: playing.label, speed: play.speed, progress: o.playing ? 0.42 : progress, id: playing.id, loop: play.loop, durationS: playing.durationS ?? null } : null,
  };
}
