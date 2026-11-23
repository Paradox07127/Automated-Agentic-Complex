import { hotkeyText } from '../../../bridge/platformText';
import { Btn } from '../../../ui';
import type { CharTab } from '../../character/sections';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { labelOf } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';

/** 角色 › 设定's display sections: each opens that tab at the section's first row. */
const GO_ROWS: Array<{ id: string; title: string; desc: string; tab: CharTab; row: string }> = [
  { id: 'disp_render', title: '画面', desc: '主光方向和强度、角色边界、脚下阴影、景深、环境光', tab: 'render', row: 'rnd.lightYaw' },
  { id: 'disp_camera', title: '镜头', desc: '原作镜头预设、朝向、缩放、呼吸晃动、对话近景', tab: 'render', row: 'rnd.cam' },
  { id: 'disp_perf', title: '性能', desc: '帧率上限，空闲时和用电池时自动降帧', tab: 'render', row: 'rnd.fps' },
  { id: 'disp_scene', title: '场景', desc: '角色身后的舞台盒或展示台，背景视差', tab: 'scene', row: 'scn.mode' },
];

/** 显示: where the character's picture is tuned (角色 › 设定, one go key per section), then how the character shows on the desktop. */
export function DisplayGroup() {
  const { goPage } = useSettings();
  const c = useControls();
  return (
    <>
      <SetSection title="角色设定">
        {GO_ROWS.map((s) => (
          <SetRow
            key={s.id}
            id={s.id}
            title={s.title}
            desc={s.desc}
            control={
              <Btn size="sm" go onClick={() => goPage({ page: 'character', tab: s.tab, row: s.row })}>
                前往
              </Btn>
            }
          />
        ))}
      </SetSection>

      <SetSection title="桌面上">
        <SetRow id="capHide" title={labelOf('capHide')} desc={hotkeyText('开始录屏或共享屏幕时隐藏一次，按 ⌃⌥H 显示')} control={c.toggle('capHide', labelOf('capHide'))} />
        <SetRow id="switchTitle" title={labelOf('switchTitle')} desc="切换后在角色所在屏幕正中显示新角色的名字" control={c.toggle('switchTitle')} />
      </SetSection>
    </>
  );
}
