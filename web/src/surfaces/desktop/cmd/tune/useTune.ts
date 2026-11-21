import { useCallback, useEffect, useRef, useState } from 'react';
import { getBridge, type ActionSpeed, type AvatarAction, type CharacterAppearance } from '../../../../bridge';
import { AgentdCallError } from '../../../../bridge/agentd';
import { PLAY_REFUSED } from '../../../../pages/character/labels';
import { readMotion, saveMotion, type MotionSource } from '../../../../pages/settings/api';
import { tuneDemo } from './demos';

/** The package's camera rows (section `touch`, MotionLibraryControls): played like any action, they turn her in place. */
export const CAMERAS = [
  { id: 'camera_left', label: '◀ 左', name: '左' },
  { id: 'camera_right', label: '右 ▶', name: '右' },
  { id: 'camera_back', label: '背面', name: '背面' },
  { id: 'camera_front', label: '正面', name: '正面' },
] as const;
const CAMERA_IDS: readonly string[] = CAMERAS.map((c) => c.id);

/** What the desktop play panel lists: every action except move motions and the camera rows. */
export const listedActions = (all: AvatarAction[]) => all.filter((a) => a.section !== 'move' && !CAMERA_IDS.includes(a.id));

/** Why an action cannot play; null when it can. */
export const lacking = (a: AvatarAction | undefined): string | null => (!a ? '当前角色包没有这个动作' : a.missing ? (a.missingReason ?? '缺少资源') : null);

const errText = (e: unknown, fallback: string) => {
  const err = e as { code?: string; message?: string } | null;
  return (err?.code && PLAY_REFUSED[err.code]) || err?.message || fallback;
};

const sourceErr = (e: unknown) =>
  e instanceof AgentdCallError && e.code === 'invalid_service_url' ? '地址要以 http:// 或 https:// 开头' : '没能保存动作来源';

/** Actions, size and appearance of the character on the desktop, read on open and after every switch. */
export function useTune(characterId: string | null) {
  const [actions, setActions] = useState<AvatarAction[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scale, setScaleState] = useState<number | null>(null);
  const [looks, setLooks] = useState<CharacterAppearance[]>([]);
  const [look, setLook] = useState<string | null>(null);
  const [en, setEn] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [speed, setSpeed] = useState<ActionSpeed>(1);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [camera, setCamera] = useState<string | null>(null);
  const [source, setSource] = useState<MotionSource | null>(null);
  const [sourceFailed, setSourceFailed] = useState(false);
  const generation = useRef(0);

  const load = useCallback(() => {
    const gen = ++generation.current;
    const bridge = getBridge();
    setLoadError(null);
    setStatus(null);
    void Promise.allSettled([bridge.avatar.actions(), bridge.avatar.state(), bridge.character.list(), readMotion()]).then(([a, s, l, m]) => {
      if (gen !== generation.current) return;
      if (a.status === 'fulfilled') {
        setActions(a.value);
        const listed = listedActions(a.value);
        setSelected((cur) => {
          if (listed.some((x) => x.id === cur)) return cur;
          if (tuneDemo().missing) return listed.find((x) => x.missing)?.id ?? '';
          return listed.find((x) => !x.missing)?.id ?? listed[0]?.id ?? '';
        });
      } else {
        setActions(null);
        setLoadError(errText(a.reason, '没能读取角色动作'));
      }
      if (s.status === 'fulfilled') {
        setScaleState(Math.round(s.value.scale * 100));
        setLook(s.value.appearanceId);
      }
      if (l.status === 'fulfilled') {
        const active = l.value.find((c) => c.active);
        setLooks(active?.appearances ?? []);
        setEn(active?.en ?? null);
      }
      if (m.status === 'fulfilled') setSource(m.value);
      setSourceFailed(m.status === 'rejected');
    });
  }, []);

  useEffect(() => {
    load();
  }, [load, characterId]);

  const play = (id: string, rate: ActionSpeed, after?: () => void) => {
    if (busy) return;
    const gen = generation.current;
    setBusy(true);
    setStatus('正在准备动作，等当前动作安全结束');
    getBridge()
      .avatar.playAction(id, rate)
      .then(
        () => {
          if (gen !== generation.current) return;
          setStatus('角色已开始响应');
          after?.();
        },
        (e: unknown) => gen === generation.current && setStatus(errText(e, '没能播放动作')),
      )
      .finally(() => gen === generation.current && setBusy(false));
  };

  const setScale = (percent: number) => {
    setScaleState(percent);
    getBridge()
      .avatar.setScale(percent / 100)
      .catch((e: unknown) => setStatus(errText(e, '没能改大小')));
  };

  const setAppearance = (id: string) => {
    const before = look;
    setLook(id);
    getBridge()
      .avatar.setAppearance(id)
      .catch((e: unknown) => {
        setLook(before);
        setStatus(errText(e, '没能换外观'));
      });
  };

  /** Resolves true once agentd took the source; a failure goes to the status line. */
  const saveSource = (body: Parameters<typeof saveMotion>[0]) =>
    saveMotion(body).then(
      (saved) => {
        setSource(saved);
        setStatus(null);
        return true;
      },
      (e: unknown) => {
        setStatus(sourceErr(e));
        return false;
      },
    );

  return {
    /** Latin name of the character on the desktop, for the eyebrow. */
    en,
    actions,
    loadError,
    reload: load,
    scale,
    setScale,
    looks,
    look,
    setAppearance,
    /** GET /motion/settings; null until read. */
    source,
    /** The last GET /motion/settings failed; source stays as it was. */
    sourceFailed,
    saveSource,
    selected,
    setSelected,
    speed,
    setSpeed,
    busy,
    status,
    camera,
    playCamera: (id: string) => play(id, 1, () => setCamera(id)),
    playSelected: () => selected && play(selected, speed),
  };
}
