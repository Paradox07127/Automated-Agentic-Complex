import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Btn, IconBtn, TextArea } from '../../src/ui';
import { OptionStack, StatusLamp, WatchKey, WhiteCapsule } from '../../src/ui/game';

// Shared parts' tiers and switches: a 32 px capsule, a 24 px icon button, a lamp whose words wrap, a small button
// without side padding, an off option row the caller may still take, a key's off mark and the desktop's text box.

afterEach(cleanup);

const ui = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/ui');
const read = (f: string) => readFileSync(resolve(ui, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations of every rule whose selector list contains `sel` exactly. */
function rules(css: string, sel: string): string {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1]!.split(',').some((s) => s.trim() === sel))
    .map((m) => m[2]!)
    .join('');
}

describe('WhiteCapsule lg', () => {
  it('marks the 32 px tier and draws it 32 high with a 26 px disc', () => {
    render(<WhiteCapsule label="桌面播放" icon="play" size="lg" />);
    expect(screen.getByRole('button', { name: '桌面播放' }).getAttribute('data-size')).toBe('lg');
    const css = read('game/WhiteCapsule.module.css');
    expect(rules(css, ".cap[data-size='lg']")).toMatch(/height:\s*32px/);
    expect(rules(css, ".cap[data-size='lg'] .ic")).toMatch(/width:\s*26px/);
  });
});

describe('IconBtn sm', () => {
  it('marks the 24 px tier and draws it 24 high, the close key a 24 px circle', () => {
    render(<IconBtn icon="more" label="更多" size="sm" />);
    expect(screen.getByRole('button', { name: '更多' }).getAttribute('data-size')).toBe('sm');
    const css = read('IconBtn.module.css');
    expect(rules(css, ".btn[data-size='sm']")).toMatch(/height:\s*24px/);
    expect(rules(css, ".btn[data-icon='close'][data-size='sm']")).toMatch(/width:\s*24px/);
  });
});

describe('StatusLamp wrap', () => {
  it('lets long words run onto more lines instead of cutting them', () => {
    const { container } = render(<StatusLamp state="failed" label="导入失败：文件里没有可用的动作轨道，换一个 VMD 再试" wrap />);
    expect(container.querySelector('[data-stub="StatusLamp"]')!.hasAttribute('data-wrap')).toBe(true);
    const css = read('game/StatusLamp.module.css');
    expect(rules(css, '.lamp[data-wrap]')).toMatch(/white-space:\s*normal/);
  });

  it('stays on one line by default', () => {
    const { container } = render(<StatusLamp state="ok" />);
    expect(container.querySelector('[data-stub="StatusLamp"]')!.hasAttribute('data-wrap')).toBe(false);
  });
});

describe('Btn dense', () => {
  it('drops the small button side padding', () => {
    render(
      <Btn variant="text" size="sm" dense label="前移">
        ◀
      </Btn>,
    );
    expect(screen.getByRole('button', { name: '前移' }).hasAttribute('data-dense')).toBe(true);
    expect(rules(read('BtnDense.module.css'), ".dense[data-size='sm']")).toMatch(/padding:\s*0\b/);
  });

  it('keeps the padding without it', () => {
    render(<Btn size="sm">确认</Btn>);
    expect(screen.getByRole('button', { name: '确认' }).hasAttribute('data-dense')).toBe(false);
  });
});

describe('OptionStack onPickOff', () => {
  const items = [
    { id: 'chat', label: '对话', icon: 'send' as const },
    { id: 'talk', label: '说话', icon: 'mic' as const, off: '没有麦克风权限' },
  ];

  it('hands a click on an off row to onPickOff, not onPick', () => {
    const onPick = vi.fn();
    const onPickOff = vi.fn();
    render(<OptionStack items={items} onPick={onPick} onPickOff={onPickOff} />);
    fireEvent.click(screen.getByRole('button', { name: '说话' }));
    expect(onPickOff).toHaveBeenCalledWith('talk');
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '对话' }));
    expect(onPick).toHaveBeenCalledWith('chat');
    expect(onPickOff).toHaveBeenCalledOnce();
  });

  it('ignores a click on an off row without it, and a press on it records nothing either way', () => {
    const onPick = vi.fn();
    const onPressStart = vi.fn();
    render(<OptionStack items={items} onPick={onPick} onPickOff={() => {}} onPressStart={onPressStart} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: '说话' }), { button: 0, pointerId: 1 });
    expect(onPressStart).not.toHaveBeenCalled();
    cleanup();
    render(<OptionStack items={items} onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: '说话' }));
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('WatchKey mark', () => {
  it('puts the mark beside the name and keeps the key enabled', () => {
    render(<WatchKey box={{ width: 72, height: 72 }} icon="clock" title="任务" mark={<i data-testid="mark" />} onClick={() => {}} />);
    const key = screen.getByRole('button', { name: '任务' });
    expect(key.hasAttribute('disabled')).toBe(false);
    expect(key.contains(screen.getByTestId('mark'))).toBe(true);
  });
});

describe('TextArea hud', () => {
  it('marks the desktop look and passes its keys and composition through', () => {
    const onKeyDown = vi.fn();
    const onCompositionStart = vi.fn();
    render(<TextArea hud label="对 她 说的话" value="" rows={1} onKeyDown={onKeyDown} onCompositionStart={onCompositionStart} />);
    const ta = screen.getByRole('textbox', { name: '对 她 说的话' });
    expect(ta.closest('[data-stub="TextArea"]')!.hasAttribute('data-hud')).toBe(true);
    fireEvent.keyDown(ta, { key: 'Enter' });
    fireEvent.compositionStart(ta);
    expect(onKeyDown).toHaveBeenCalledOnce();
    expect(onCompositionStart).toHaveBeenCalledOnce();
    expect(rules(read('Field.module.css'), '.field[data-hud] .box')).toMatch(/background:/);
  });
});

describe('HUD card looks', () => {
  it('give the secondary words the fixed HUD ink, not a colour that follows the theme', () => {
    const looks = read('../surfaces/stack/HudCardLooks.css');
    expect(rules(looks, '.card[data-look]')).toMatch(/--ef-text-2:\s*var\(--ef-hud-ink-2\)/);
    const tokens = JSON.parse(readFileSync(resolve(ui, '../design/tokens.json'), 'utf8')) as { hud: { base: Record<string, string> } };
    expect(tokens.hud.base['hud-ink-2']).toMatch(/^#/);
  });
});
