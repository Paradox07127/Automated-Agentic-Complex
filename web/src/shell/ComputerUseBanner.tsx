import { useEffect, useState } from 'react';
import { getBridge, type ComputerUseScope, type ComputerUseState } from '../bridge';
import { Banner, Btn } from '../ui';
import { toast } from './toast';

/** The native computer-use panel's scope titles. */
const SCOPE: Record<ComputerUseScope, string> = { observation: '观察控件', text: '读取文字', image: '查看截图', control: '执行操作' };

/** `demo=computer-use`: a session acting with two scopes, for screenshots. */
export const COMPUTER_USE_DEMO: ComputerUseState = { granted: ['observation', 'control'], active: true };

/** 操作电脑：只在角色观察或操作时出现在顶栏，可以当场停止；授权仍在桌面上的面板里给。`demo` replaces the bridge's state. */
export function ComputerUseBanner({ demo }: { demo?: ComputerUseState }) {
  const [live, setState] = useState<ComputerUseState | null>(null);
  const state = demo ?? live;
  useEffect(() => {
    const cu = getBridge().computerUse;
    let pushed = false;
    cu.state()
      .then((s) => !pushed && setState(s))
      .catch(() => {});
    const off = cu.onState((s) => {
      pushed = true;
      setState(s);
    });
    return () => {
      pushed = true;
      off();
    };
  }, []);
  if (!state?.active) return null;
  const granted = state.granted.map((s) => SCOPE[s]).join('、');
  const stop = () => void getBridge().computerUse.stop().catch(() => toast('未能停止：应用无响应', { severity: 'danger' }));
  return (
    <Banner
      severity="warning"
      title="电脑操作进行中"
      {...(granted ? { desc: `已允许：${granted}` } : {})}
      actions={
        <Btn variant="secondary" onClick={stop}>
          停止
        </Btn>
      }
    />
  );
}
