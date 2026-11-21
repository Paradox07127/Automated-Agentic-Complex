import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBridge, type AvatarState } from '../bridge';
import { useRuntimePublic } from '../data/runtime';

/** Status light at the sidebar foot and on the role card. */
export type Lamp = 'ok' | 'warn' | 'bad' | 'off';

export interface StatusLight {
  label: string;
  lamp: Lamp;
  state: string;
}

export interface ShellStatus {
  role: { id?: string | undefined; name: string; head?: string | undefined; lamp: Lamp; state: string };
  /** 后台, 内核, 角色; the shell has no voice state to read, so 语音 is left out. */
  lights: StatusLight[];
}

const POLL_MS = 15_000;

/** `avatar.state()` once, then the host's pushes; a push that arrives first wins. */
function useAvatar(): { state: AvatarState | null; failed: boolean } {
  const [state, setState] = useState<AvatarState | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const avatar = getBridge().avatar;
    let pushed = false;
    avatar
      .state()
      .then((s) => !pushed && setState(s))
      .catch(() => !pushed && setFailed(true));
    const off = avatar.onState((s) => {
      pushed = true;
      setFailed(false);
      setState(s);
    });
    return () => {
      pushed = true;
      off();
    };
  }, []);
  return { state, failed };
}

function avatarLight(state: AvatarState | null, failed: boolean): Omit<StatusLight, 'label'> {
  if (failed) return { lamp: 'off', state: '未连接' };
  if (!state) return { lamp: 'off', state: '读取中' };
  if (!state.running) return { lamp: 'bad', state: '未运行' };
  if (state.speaking) return { lamp: 'ok', state: '说话中' };
  if (!state.visible) return { lamp: 'off', state: '已隐藏' };
  return { lamp: 'ok', state: '在桌面' };
}

/** Reads behind the sidebar's role card and connection lights: agentd.connection(), avatar.state(), GET /character/runtime. */
export function useShellStatus(): ShellStatus {
  const conn = useQuery({ queryKey: ['agentd', 'connection'], queryFn: () => getBridge().agentd.connection(), refetchInterval: POLL_MS, retry: false });
  const runtime = useRuntimePublic();
  const roster = useQuery({ queryKey: ['shell', 'characters'], queryFn: () => getBridge().character.list(), retry: false, staleTime: Number.POSITIVE_INFINITY });
  const avatar = useAvatar();

  const agentd: Omit<StatusLight, 'label'> =
    conn.data === 'connected'
      ? { lamp: 'ok', state: '已连接' }
      : conn.data === 'unauthorized'
        ? { lamp: 'warn', state: '未授权' }
        : conn.data === 'offline'
          ? { lamp: 'bad', state: '已断开' }
          : { lamp: 'off', state: conn.isError ? '读取失败' : '读取中' };
  const kernel: Omit<StatusLight, 'label'> = runtime.data
    ? runtime.data.ready
      ? { lamp: 'ok', state: '已就绪' }
      : { lamp: 'warn', state: '未就绪' }
    : { lamp: 'off', state: runtime.isError ? '读取失败' : '读取中' };
  const role = avatarLight(avatar.state, avatar.failed);
  const id = avatar.state?.characterId;
  const active = (id ? roster.data?.find((c) => c.id === id) : undefined) ?? roster.data?.find((c) => c.active);

  return {
    role: { id: active?.id, name: active?.name ?? '角色', head: active?.head, ...role },
    lights: [
      { label: '后台', ...agentd },
      { label: '内核', ...kernel },
      { label: '角色', ...role },
    ],
  };
}
