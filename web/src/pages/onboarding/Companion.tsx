import { useEffect, useState } from 'react';
import { get, put } from '../../bridge/agentd';
import { SRow, Toggle } from '../../ui';

type Settings = { companion_mode: boolean };

/** Step 2's 陪伴模式 row over `GET/PUT /proactive/settings`; only the user's click writes. */
export function Companion() {
  const [on, setOn] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    get<Settings>('/proactive/settings').then(
      (r) => live && setOn(r.companion_mode),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  const toggle = (next: boolean) => {
    setNote(null);
    void put<Settings>('/proactive/settings', { companion_mode: next }).then(
      (r) => setOn(r.companion_mode),
      (e: Error) => setNote(`没能${next ? '开启' : '关闭'}陪伴模式：${e.message}`),
    );
  };

  return (
    <SRow
      id="companion_mode"
      title="让她偶尔主动搭话（陪伴模式）"
      desc={note ?? '你离开后回来时，她会主动说一句；可在 设置 › 说话与通知 中修改'}
      control={<Toggle on={on} label="让她偶尔主动搭话（陪伴模式）" size="sm" onChange={toggle} />}
    />
  );
}
