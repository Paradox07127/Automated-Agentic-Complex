import { hotkeyText } from '../../../bridge/platformText';
import { Btn } from '../../../ui';
import type { CharTab } from '../../character/sections';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { optionsOf } from '../native';
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

/** 显示: how the app's own windows look (外观), where the character's picture is tuned (角色 › 设定, one go key per section),
 *  then how the character shows on the desktop. */
export function DisplayGroup() {
  const { goPage, model, native } = useSettings();
  const c = useControls();
  // The shell's reason when this system draws no window glass: the row then offers 不透明 only.
  const noGlass = native?.statuses.winBg;
  const opaque = optionsOf(native?.rows.winBg).filter((o) => o.value === 'opaque');
  const glass = model.value('winBg') === 'glass';
  return (
    <>
      <SetSection title="外观">
        <SetRow id="appTheme" title={labelOf('appTheme')} desc="跟随系统时随系统的浅色、深色一起换" info="主窗口、桌面上的气泡和面板、菜单和系统对话框一起换。" control={c.seg('appTheme')} />
        <SetRow
          id="winBg"
          title={labelOf('winBg')}
          desc={noGlass ?? '磨砂时透出窗口后面的桌面，不透明是实色底'}
          info="系统开着「降低透明度」时按不透明显示。对话框、菜单和卡片始终是实色底，上面的文字不受影响。"
          disabled={noGlass != null}
          disabledReason={noGlass}
          control={c.seg('winBg', noGlass != null ? opaque : undefined, noGlass != null)}
        />
        <SetRow
          id="glassAlpha"
          title={labelOf('glassAlpha')}
          desc="越重，底色盖住的越多，文字越清楚"
          info="轻、中、重分别让主窗口的底色盖住磨砂的 35 %、55 %、75 %；面板和卡片的底不变。"
          disabled={!glass}
          disabledReason="窗口背景是不透明时不起作用"
          control={c.seg('glassAlpha', undefined, !glass)}
        />
        <SetRow id="reduceMotion" title={labelOf('reduceMotion')} desc="开着时切页、展开和按键反馈都不做动画" info="跟随系统时看系统的「减弱动态效果」；开着时不管系统怎么设都不做动画。只管主窗口。" control={c.seg('reduceMotion')} />
        <SetRow id="uiZoom" title={labelOf('uiZoom')} desc="主窗口里的文字和控件一起放大或缩小" info="只改主窗口；桌面上的角色、气泡和面板保持原来的大小。" control={c.seg('uiZoom')} />
      </SetSection>

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
