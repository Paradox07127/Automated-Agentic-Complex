import { useEffect, useState } from 'react';
import { getBridge, type ActionSpeed, type AvatarAction } from '../../bridge';
import type { Toast } from './feedback';
import { ADJUSTED, NO_REASON, PLAY_REFUSED, playRefusedSeverity, SECTIONS } from './labels';
import type { MotionGroup } from './MotionTable';

const ORDER = Object.keys(SECTIONS);
const SAVE_REFUSED: Record<string, string> = {
  wrong_character: '桌面上不是这个角色',
  switching: '角色正在切换',
  not_ready: '角色还在加载',
  not_implemented: '这个版本还不支持',
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

export interface Play {
  id: string;
  t0: number;
  speed: number;
  /** Plays until `stop`: no progress, no end of its own. */
  loop: boolean;
}

/** Switch drafts saved as one group, and the desktop preview with its local progress. */
export function useMotions(o: { actions: AvatarAction[]; toast: Toast; seed?: Record<string, boolean>; playing?: string | null }) {
  const [changed, setChanged] = useState<Record<string, boolean>>(() => o.seed ?? {});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [play, setPlay] = useState<Play | null>(() => (o.playing ? { id: o.playing, t0: Date.now(), speed: 1, loop: false } : null));
  const [, tick] = useState(0);
  const base = (a: AvatarAction) => saved[a.id] ?? a.enabled;
  const value = (a: AvatarAction) => changed[a.id] ?? base(a);
  const playing = play ? o.actions.find((a) => a.id === play.id) : undefined;
  const dur = play && !play.loop && playing?.durationS != null ? (playing.durationS * 1000) / play.speed : null;
  const progress = play && dur != null ? Math.min(1, (Date.now() - play.t0) / dur) : null;

  useEffect(() => {
    if (!play || play.loop || o.playing) return;
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
    const n = Object.keys(changed).length;
    setSaving(true);
    getBridge()
      .avatar.setActionSwitches(changed)
      .then(
        (r) => {
          if (r.error) return o.toast(`没有保存：${SAVE_REFUSED[r.error] ?? NO_REASON}`, { severity: 'danger' });
          // The host's table is the truth: it may keep required, missing or last-in-section actions on.
          setSaved((x) => ({ ...x, ...r.switches }));
          setChanged({});
          const back = r.adjusted.map((a) => `${o.actions.find((m) => m.id === a.id)?.label ?? a.id}（${ADJUSTED[a.reason] ?? NO_REASON}）`);
          o.toast(back.length ? `动作开关已保存 │ 角色改回了 ${back.join('、')}` : `动作开关已保存 │ ${n} 项`);
        },
        (e: unknown) => o.toast(`没有保存：${SAVE_REFUSED[codeOf(e)] ?? '桌面角色没有回应'}`, { severity: 'danger' }),
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
          o.toast('没有播放：角色仍然隐藏，请先通过角色菜单显示角色', { severity: 'danger' });
          return;
        }
      }
      if (loop) await avatar.playAction(a.id, speed, { loop: true });
      else await avatar.playAction(a.id, speed);
      setPlay({ id: a.id, t0: Date.now(), speed, loop });
    } catch (e) {
      o.toast(PLAY_REFUSED[codeOf(e)] ?? '没有播放：桌面角色未确认播放，请检查角色是否显示、是否连上', { severity: playRefusedSeverity(codeOf(e)) });
    } finally { setPreviewing(false); }
  };

  const stop = () =>
    getBridge()
      .avatar.stopAction()
      .then(
        () => setPlay(null),
        (e: unknown) => o.toast(`没有停止：${codeOf(e) === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' }),
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
    play: play && playing ? { label: playing.label, speed: play.speed, progress: o.playing ? 0.42 : progress, id: playing.id, loop: play.loop } : null,
  };
}
