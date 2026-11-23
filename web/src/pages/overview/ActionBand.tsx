import { keyText } from '../../bridge/platformText';
import { useHotkeyLabels } from '../../domain/hotkeys';
import { look, openQuickInput, useDesktopOff } from '../../shell/desktopOps';
import { usePlugins } from '../../shell/plugins';
import { offReason } from '../../shell/registry';
import { Btn } from '../../ui';
import { useInfoIn } from './MissionFx';
import type { Go } from './nav';
import styles from './Page.module.css';

/** The shell opens the command palette on ⌘K; the button sends the same key. */
const openPalette = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));

/** 常用操作，放在外壳的深色底部操作条里：快速输入、屏幕识读（屏幕识读插件关着时禁用，带已关闭原因）、命令面板。 */
export function ActionBand({ go }: { go: Go }) {
  const off = useDesktopOff();
  const keys = useHotkeyLabels();
  const plugins = usePlugins();
  const ref = useInfoIn<HTMLDivElement>();
  return (
    <div ref={ref} className={styles.act} role="toolbar" aria-label="常用操作" data-g="actions">
      <Btn variant="ghost" kbd={keys.hk_quick} disabled={!!off.quickInput} disabledReason={off.quickInput} onClick={() => void openQuickInput()}>
        快速输入
      </Btn>
      <Btn variant="ghost" icon="look" kbd={keys.hk_look} disabled={!plugins.screen_reading || !!off.look} disabledReason={plugins.screen_reading ? off.look : offReason('screen_reading')} onClick={() => void look()}>
        屏幕识读
      </Btn>
      <Btn variant="ghost" kbd={keyText('⌘K')} onClick={openPalette}>
        命令面板
      </Btn>
    </div>
  );
}
