import { useState } from 'react';
import { getBridge, type BridgeError, type HotkeyCheck } from '../../../bridge';
import { hotkeyText, keyText } from '../../../bridge/platformText';
import { useSettings } from '../ctx';
import { Btn, Kbd } from '../../../ui';
import { KeyCell } from '../kit';
import { labelOf, useRowShown } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import { Slab } from '../Slab';
import styles from '../groups.module.css';

/** Rows in schema order; the combos themselves come from settings.read() and the schema defaults. */
const HOTKEYS: Array<{ id: string; desc?: string }> = [
  { id: 'hk_ptt', desc: '只有这一项能单用右 ⌥' },
  { id: 'hk_quick' },
  { id: 'hk_look' },
  { id: 'hk_hide' },
  { id: 'hk_pass' },
  { id: 'hk_wheel' },
  { id: 'hk_sel', desc: '没选中时读剪贴板；安全输入和不看的窗口不读' },
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

/** A combo as key caps: each modifier its own cap, the key after them one cap; Windows text splits on +. */
export function capsOf(text: string): string[] {
  if (text.includes('+')) return text.split('+').map((k) => k.trim()).filter(Boolean);
  const m = /^([⌃⌥⇧⌘]*)(.*)$/u.exec(text.replace(/\s+/g, ''));
  return [...Array.from(m?.[1] ?? ''), ...(m?.[2] ? [m[2]] : [])];
}

/** 按键: global keys recorded through the native bridge, checked, then saved; the main-window keys are fixed. */
export function KeysGroup() {
  const { model, ro, caps, native } = useSettings();
  const shown = useRowShown();
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
  const fixed: Array<[id: string, title: string, key: string]> = [
    ...PAGE_KEYS.map(([id, title, key]): [string, string, string] => [`hk_page_${id}`, title, key]),
    ['hk_cmdk', labelOf('hk_cmdk'), '⌘K'],
    ['hk_find', '搜索设置', '⌘F'],
  ];

  return (
    <>
      <SetSection title="全局快捷键" info="在任何应用里按都有效，不用先切到主窗口。轮盘、菜单和提示里显示的热键都取自这里。">
        {noHotkeys && <p className={styles.note}>这个平台不支持全局热键，只在主窗口内有效</p>}
        {HOTKEYS.map((h) => {
          const label = labelOf(h.id);
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
              title={label}
              desc={status ? hotkeyText(status) : clash ? `和${bridge.platform === 'windows' ? '系统' : ' macOS'}「切换输入法」冲突` : h.desc && hotkeyText(h.desc)}
              descTone={status || clash ? 'bad' : undefined}
              control={
                <>
                  <KeyCell keys={unset ? undefined : capsOf(hotkeyText(combo))} none={unset} warn={clash} recording={recording === h.id} />
                  {clash && (
                    <Btn disabled={ro || recording !== null} onClick={() => void use(h.id, label, INPUT_SWITCH_FIX)}>
                      改用 {hotkeyText(INPUT_SWITCH_FIX)}
                    </Btn>
                  )}
                  <Btn
                    loading={recording === h.id}
                    disabled={ro || noHotkeys || (recording !== null && recording !== h.id)}
                    disabledReason={recording ? '正在录制快捷键' : noHotkeys ? '这个平台不支持全局热键' : '设置当前不可写'}
                    onClick={() => void record(h.id, label)}
                  >
                    更改
                  </Btn>
                  {!unset && (
                    <Btn disabled={ro || recording !== null} onClick={() => model.set(h.id, '')}>
                      清除
                    </Btn>
                  )}
                </>
              }
            />
          );
        })}
      </SetSection>

      <SetSection title="主窗口里" right="固定，不能改">
        <Slab id="hk_main" variant="plate" label="主窗口里的快捷键">
          <div className={styles.fixedKeys}>
            {fixed
              .filter(([id]) => shown(id))
              .map(([id, title, key]) => (
                <span key={id} id={`set-${id}`} data-row={id}>
                  <Kbd variant="bar" items={[{ keys: capsOf(keyText(key)), label: title }]} />
                </span>
              ))}
            <Kbd variant="bar" items={[{ keys: ['Q', 'E'], label: '切换分组' }]} />
          </div>
        </Slab>
      </SetSection>
    </>
  );
}
