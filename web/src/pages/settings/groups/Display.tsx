import { getBridge } from '../../../bridge';
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
  { id: 'disp_render', title: '画面', desc: '主光源角度与强度、角色描边、地面阴影、景深、环境光照', tab: 'render', row: 'rnd.lightYaw' },
  { id: 'disp_camera', title: '镜头', desc: '镜头预设、旋转角度、缩放比例、呼吸微动、自动近景', tab: 'render', row: 'rnd.cam' },
  { id: 'disp_perf', title: '性能', desc: '帧率上限、空闲降帧与电池供电降帧策略', tab: 'render', row: 'rnd.fps' },
  { id: 'disp_scene', title: '场景', desc: '角色背景的舞台盒与展示台模式、背景视差', tab: 'scene', row: 'scn.mode' },
];

/** 显示: how the app's own windows look (外观), where the character's picture is tuned (角色 › 设定, one go key per section),
 *  then how the character shows on the desktop. */
export function DisplayGroup() {
  const { goPage, model, native } = useSettings();
  const c = useControls();
  const windows = getBridge().platform === 'windows';
  // The shell's reason when this system draws no window glass: the row then offers 不透明 only.
  const noGlass = native?.statuses.winBg;
  const opaque = optionsOf(native?.rows.winBg).filter((o) => o.value === 'opaque');
  const glass = model.value('winBg') === 'glass';
  const hkHide = String(model.value('hk_hide') ?? native?.rows.hk_hide?.default ?? '');
  const capHideDesc = windows
    ? '启用渲染器屏幕采集保护（本机仍可见，截屏与屏幕共享中隐藏）；修改后需重启角色渲染进程生效'
    : `检测到屏幕录制或共享时自动隐藏一次${hkHide ? `，按 ${hotkeyText(hkHide)} 重新显示` : ''}`;
  return (
    <>
      <SetSection title="外观">
        <SetRow id="appTheme" title={labelOf('appTheme')} desc="选择「跟随系统」时将自动匹配系统浅色/深色模式" info="统一作用于主窗口、桌面气泡与面板、菜单及系统对话框。" control={c.seg('appTheme')} />
        <SetRow
          id="winBg"
          title={labelOf('winBg')}
          desc={noGlass ?? '磨砂模式可透出窗口下方桌面背景，不透明模式使用纯色背景'}
          info={windows
            ? '系统关闭「透明效果」或开启「高对比度」时将按不透明显示。对话框、菜单与卡片始终为实色底，不影响文字可读性。'
            : '系统开启「降低透明度」时将按不透明显示。对话框、菜单与卡片始终为实色底，不影响文字可读性。'}
          disabled={noGlass != null}
          disabledReason={noGlass}
          control={c.seg('winBg', noGlass != null ? opaque : undefined, noGlass != null)}
        />
        <SetRow
          id="glassAlpha"
          title={labelOf('glassAlpha')}
          desc="强度越高，底色遮盖程度越高，文字对比度越清晰"
          info="轻度、适中、较强分别对应 35 %、55 %、75 % 的窗口底色遮盖强度；面板与卡片背景不受此项影响。"
          disabled={!glass}
          disabledReason="窗口背景为不透明模式时不生效"
          control={c.seg('glassAlpha', undefined, !glass)}
        />
        <SetRow
          id="reduceMotion"
          title={labelOf('reduceMotion')}
          desc="开启后将关闭切页、展开及按键反馈等过渡动画"
          info={windows
            ? '「跟随系统」将读取系统的「动画效果」设置；选择「开启」时将强制停用动效。此设置仅作用于主窗口。'
            : '「跟随系统」将读取系统的「减弱动态效果」设置；选择「开启」时将强制停用动效。此设置仅作用于主窗口。'}
          control={c.seg('reduceMotion')}
        />
        <SetRow id="uiZoom" title={labelOf('uiZoom')} desc="等比例缩放主窗口内的文字与控件尺寸" info="仅作用于主窗口；桌面上的角色、气泡与浮窗保持原有尺寸。" control={c.seg('uiZoom')} />
      </SetSection>

      <SetSection title="角色画面与性能">
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

      <SetSection title="桌面显示">
        <SetRow id="capHide" title={labelOf('capHide')} desc={capHideDesc} control={c.toggle('capHide', labelOf('capHide'))} />
        <SetRow id="switchTitle" title={labelOf('switchTitle')} desc="切换角色时在所在屏幕中央短暂展示角色名称标题" control={c.toggle('switchTitle')} />
      </SetSection>
    </>
  );
}
