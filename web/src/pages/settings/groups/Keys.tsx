import { useState } from 'react';
import { getBridge, type BridgeError, type HotkeyCheck } from '../../../bridge';
import { hotkeyText, keyText } from '../../../bridge/platformText';
import { Btn, Kbd } from '../../../ui';
import { useSettings } from '../ctx';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import styles from '../groups.module.css';

/** Rows in schema order; the combos themselves come from settings.read() and the schema defaults. */
const HOTKEYS: Array<{ id: string; label: string; desc?: string }> = [
  { id: 'hk_ptt', label: '按住说话', desc: '只有这一项可以单用右 ⌥' },
  { id: 'hk_quick', label: '快速输入' },
  { id: 'hk_look', label: '屏幕识读' },
  { id: 'hk_hide', label: '显示 / 隐藏角色' },
  { id: 'hk_pass', label: '临时全部点穿' },
  { id: 'hk_wheel', label: '快捷轮盘' },
  { id: 'hk_sel', label: '读取选中文字', desc: '没选中时读剪贴板，带进快速输入；安全输入和黑名单窗口不读' },
];

/** ⌃Space also switches the input method on macOS and in Windows' Chinese input methods; the shell cannot tell, so the row says so. */
const INPUT_SWITCH = '⌃Space';
const INPUT_SWITCH_FIX = '⌃⌥Space';

/**
 * Main-window page keys in sidebar order, the same as each page's route.ts hotkey and the native menu (a test keeps them equal).
 * Not read from shell/registry: that module imports this page, so the import would be circular.
 */
export const PAGE_KEYS: Array<[id: string, title: string, key: string]> = [
  ['home', '主页', '⌘0'],
  ['overview', '每日简报', '⌘1'],
  ['chat', '对话', '⌘2'],
  ['memory', '记忆', '⌘3'],
  ['character', '角色', '⌘4'],
  ['settings', '设置', '⌘,'],
];

/** 快捷键: global keys recorded through the native bridge, checked, then saved; the main-window keys are fixed. */
export function KeysGroup() {
  const { model, ro, caps, native } = useSettings();
  const bridge = getBridge();
  const [recording, setRecording] = useState<string | null>(null);

  const check = async (id: string, combo: string): Promise<HotkeyCheck | null> => {
    try {
      return await bridge.settings.validateHotkey(id, combo);
    } catch (error) {
      const code = (error as BridgeError | null)?.code;
      const message = code === 'invalid_hotkey'
        ? `${hotkeyText(combo)} 不能用作热键：${hotkeyText('要带 ⌃、⌥ 或 ⌘')}，或者用 F1–F12`
        : '无法检查快捷键，请确认设置可以读取后重试';
      model.notify({ message, severity: 'warning', persistent: true });
      return null;
    }
  };
  const use = async (id: string, label: string, combo: string) => {
    const r = await check(id, combo);
    if (!r) return;
    if (!r.ok) return model.notify({ message: `${hotkeyText(combo)} 已被「${r.conflictWith}」占用，「${label}」保持不变`, severity: 'warning', persistent: true });
    model.set(id, combo);
  };
  const record = async (id: string, label: string) => {
    setRecording(id);
    try {
      const combo = await bridge.settings.recordHotkey(id);
      if (!combo) return model.notify({ message: `没有录到新的按键，「${label}」保持不变` });
      await use(id, label, combo);
    } catch {
      model.notify({ message: `无法录制「${label}」的快捷键，请重试`, severity: 'warning', persistent: true });
    } finally {
      setRecording(null);
    }
  };
  const noHotkeys = !caps.hotkeys;

  return (
    <>
      <SetSection title="全局快捷键">
        {noHotkeys && <p className={styles.note}>这个平台不支持全局热键，只在主窗口内有效</p>}
        {HOTKEYS.map((h) => {
          const saved = model.value(h.id);
          const combo = typeof saved === 'string' ? saved : String(native?.rows[h.id]?.default ?? '—');
          const status = native?.statuses[h.id];
          const clash = combo === INPUT_SWITCH;
          // "" is no hot key: the shell registers nothing for it.
          const unset = combo === '';
          return (
            <SetRow
              key={h.id}
              id={h.id}
              title={h.label}
              desc={status ? hotkeyText(status) : (clash ? `与${bridge.platform === 'windows' ? '系统' : ' macOS'}「切换输入法」冲突，建议改为 ${hotkeyText(INPUT_SWITCH_FIX)}` : h.desc && hotkeyText(h.desc))}
              descTone={status || clash ? 'attention' : undefined}
              control={
                <>
                  {unset ? <span className={styles.t3}>未设置</span> : <Kbd size="lg">{hotkeyText(combo)}</Kbd>}
                  <Btn size="sm" variant="ghost" loading={recording === h.id} disabled={ro || noHotkeys || (recording !== null && recording !== h.id)}
                    disabledReason={recording ? '正在录制快捷键' : noHotkeys ? '这个平台不支持全局热键' : '设置当前不可写'} onClick={() => void record(h.id, h.label)}>
                    {recording === h.id ? <span role="status">按下新快捷键，Esc 取消</span> : '更改'}
                  </Btn>
                  {!unset && (
                    <Btn size="sm" variant="quiet" disabled={ro || recording !== null} onClick={() => model.set(h.id, '')}>
                      清除
                    </Btn>
                  )}
                  {clash && (
                    <Btn size="sm" variant="quiet" disabled={ro || recording !== null} onClick={() => void use(h.id, h.label, INPUT_SWITCH_FIX)}>
                      改用 {hotkeyText(INPUT_SWITCH_FIX)}
                    </Btn>
                  )}
                </>
              }
            />
          );
        })}
        <p className={styles.note}>快捷轮盘、菜单和提示中的热键标注均取自此处。</p>
      </SetSection>

      <SetSection title="主窗口内">
        {PAGE_KEYS.map(([id, title, key]) => (
          <SetRow key={id} id={`hk_page_${id}`} title={`切换到「${title}」`} control={<Kbd size="lg">{keyText(key)}</Kbd>} />
        ))}
        <SetRow id="hk_cmdk" title="命令面板" desc={keyText('固定为 ⌘K')} control={<Kbd size="lg">{keyText('⌘K')}</Kbd>} />
        <SetRow id="hk_find" title="搜索设置" desc="设置页内有效" control={<Kbd size="lg">{keyText('⌘F')}</Kbd>} />
      </SetSection>
    </>
  );
}
