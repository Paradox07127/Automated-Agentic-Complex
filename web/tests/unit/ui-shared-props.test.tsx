// The shared components' added props; without them each component renders as before (the other suites cover that).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../../src/features/approval/ApprovalCard';
import { APPROVALS, pick } from '../../src/mock/fixtures';
import { A1 } from '../../src/mock/fixtures/ids';
import { ErrBar } from '../../src/ui/ErrBar';
import { FilterChips } from '../../src/ui/FilterChips';
import { Icon, type IconName } from '../../src/ui/Icon';
import { ICON_PATHS } from '../../src/ui/iconPaths';
import { Menu, type MenuItem } from '../../src/ui/Menu';
import { SearchField } from '../../src/ui/SearchField';
import { Sheet } from '../../src/ui/Sheet';

const css = (name: string) => readFileSync(resolve(__dirname, '../../src/ui', name), 'utf8');
/** The declarations of the first rule whose selector list is exactly `sel`. */
const rule = (text: string, sel: string) => {
  const at = text.indexOf(`\n${sel} {`);
  return at < 0 ? '' : text.slice(at, text.indexOf('}', at));
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.keys;
});

describe('Sheet', () => {
  it('names its close key with closeLabel, and 关闭 without it', () => {
    const { rerender } = render(<Sheet open title="详情" />);
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy();
    rerender(<Sheet open title="详情" closeLabel="收起详情" />);
    expect(screen.getByRole('button', { name: '收起详情' }).getAttribute('title')).toBe('收起详情');
  });

  it('takes a node as title and still names the drawer by it, docked or not, with any head', () => {
    const title = (
      <>
        生成记录 <b>12</b>
      </>
    );
    const { rerender } = render(<Sheet open title={title} />);
    expect(screen.getByRole('dialog', { name: '生成记录 12' }).querySelector('h2 b')?.textContent).toBe('12');
    rerender(<Sheet open title={title} head="close" />);
    expect(screen.getByRole('dialog', { name: '生成记录 12' })).toBeTruthy();
    cleanup();
    render(<Sheet open={false} title={title} head="none" dockFrom={0} />);
    expect(screen.getByRole('complementary', { name: '生成记录 12' })).toBeTruthy();
  });

  it('fades the docked column in with the motion tokens, and not under either reduced-motion switch', () => {
    const text = css('Sheet.module.css');
    expect(rule(text, '.dock')).toMatch(/animation: fade var\(--ef-dur-[a-z-]+\) var\(--ef-ease-[a-z-]+\)/);
    const media = text.slice(text.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(media.slice(0, media.indexOf('animation: none'))).toContain('.dock');
    expect(text).toContain(':global([data-reduce-motion]) .dock');
    expect(text).toContain(':global(.still) .dock');
  });
});

describe('SearchField', () => {
  it('submits the text on Enter, but not while an input method is composing', () => {
    const onSubmit = vi.fn();
    render(<SearchField value="周报" label="搜索记忆" onSubmit={onSubmit} />);
    const box = screen.getByRole('textbox', { name: '搜索记忆' });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('周报');
  });

  it('focuses the box on its shortcut, and only on that chord', () => {
    const ref = { current: null as HTMLInputElement | null };
    render(<SearchField value="" label="搜索记忆" shortcut="⌘F" inputRef={ref} />);
    const box = screen.getByRole('textbox', { name: '搜索记忆' });
    expect(ref.current).toBe(box);
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(document.activeElement).not.toBe(box);
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(box);
  });

  it('reads Ctrl+F as the Control chord', () => {
    render(<SearchField value="" label="搜索" shortcut="Ctrl+F" />);
    const box = screen.getByRole('textbox', { name: '搜索' });
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(document.activeElement).not.toBe(box);
    const e = fireEvent.keyDown(window, { key: 'F', ctrlKey: true });
    expect(document.activeElement).toBe(box);
    expect(e).toBe(false);
  });

  it('shows the keycap with the shared Kbd, hidden until ⌘ or Ctrl is held', () => {
    const { container, rerender } = render(<SearchField value="" label="搜索" />);
    expect(container.querySelector('[data-stub="Kbd"]')).toBeNull();
    rerender(<SearchField value="" label="搜索" shortcut="⌘F" />);
    const cap = container.querySelector('[data-stub="Kbd"]');
    expect(cap?.textContent).toBe('⌘F');
    expect(cap?.closest('[aria-hidden="true"]')).toBeTruthy();
    expect(css('SearchField.module.css')).toMatch(/:global\(html:not\(\[data-keys\]\)\) \.keys \{\s*display: none;/);
  });
});

describe('Menu', () => {
  it('hands onSelect the modifier keys held at the press', () => {
    const onSelect = vi.fn();
    render(<Menu label="管理" items={[{ kind: 'item', label: '复制', onSelect }]} />);
    fireEvent.click(screen.getByRole('button', { name: /管理/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '复制' }), { altKey: true });
    expect(onSelect).toHaveBeenCalledWith({ altKey: true, shiftKey: false, metaKey: false, ctrlKey: false });
  });

  it('closes after a radio pick and stays open after a checkbox toggle', () => {
    const pick = vi.fn();
    const items: MenuItem[] = [
      { kind: 'item', label: '按时间', radio: true, checked: true, onSelect: pick },
      { kind: 'item', label: '按名称', radio: true, checked: false, onSelect: pick },
      { kind: 'sep' },
      { kind: 'item', label: '显示已归档', checked: false, onSelect: pick },
    ];
    render(<Menu label="排序" items={items} />);
    const trigger = screen.getByRole('button', { name: /排序/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '显示已归档' }));
    expect(screen.getByRole('menu')).toBeTruthy();
    const byName = screen.getByRole('menuitemradio', { name: '按名称' });
    expect(byName.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(byName);
    expect(pick).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('renders the trigger with the shared Btn (text) and IconBtn (icon), keeping the menu button semantics', () => {
    const { container, rerender } = render(<Menu label="管理" items={[{ kind: 'item', label: '重命名' }]} />);
    let trigger = screen.getByRole('button', { name: /管理/ });
    expect(trigger.dataset.stub).toBe('Btn');
    expect(trigger.dataset.variant).toBe('ghost');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(screen.getByRole('menu').id);
    rerender(<Menu label="更多操作" icon="more" items={[{ kind: 'item', label: '复制路径' }]} />);
    trigger = screen.getByRole('button', { name: '更多操作' });
    expect(trigger.dataset.stub).toBe('IconBtn');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });

  it('marks a narrowed trigger for sight and for screen readers', () => {
    const { container, rerender } = render(<Menu label="筛选" items={[{ kind: 'item', label: '全部' }]} />);
    expect(container.querySelector('[data-narrowed]')).toBeNull();
    expect(screen.getByRole('button', { name: /筛选/ }).textContent).not.toContain('已收窄');
    rerender(<Menu label="筛选" narrowed items={[{ kind: 'item', label: '全部' }]} />);
    expect(container.querySelector('[data-stub="Menu"]')?.hasAttribute('data-narrowed')).toBe(true);
    expect(screen.getByRole('button', { name: /筛选.*已收窄/ })).toBeTruthy();
    rerender(<Menu label="筛选" icon="tune" narrowed items={[{ kind: 'item', label: '全部' }]} />);
    expect(screen.getByRole('button', { name: '筛选（已收窄）' })).toBeTruthy();
    expect(css('Menu.module.css')).toMatch(/\.wrap\[data-narrowed\]::after \{[^}]*var\(--ef-accent\)/);
  });
});

describe('FilterChips', () => {
  it('is 24 high, one of the two control heights', () => {
    render(<FilterChips label="筛选" options={[{ value: 'a', label: '全部' }]} value={['a']} />);
    expect(rule(css('FilterChips.module.css'), '.chip')).toContain('height: var(--ef-h-sm);');
  });
});

describe('Icon', () => {
  const DIAG: IconName[] = ['d-overview', 'd-proc', 'd-render', 'd-flow', 'd-state'];

  it('has a glyph of its own for each diagnostics tab', () => {
    const now = ['grid', 'data', 'g-window', 'hub', 'tune'].map((n) => ICON_PATHS[n as IconName]);
    for (const name of DIAG) {
      const d = ICON_PATHS[name];
      expect(d).toMatch(/^M[\d.\s,zZMmHhVvLlAaCc-]+$/);
      expect(now).not.toContain(d);
      const { container } = render(<Icon name={name} size={20} />);
      expect(container.querySelector('svg')?.getAttribute('data-icon')).toBe(name);
      cleanup();
    }
    expect(new Set(DIAG.map((n) => ICON_PATHS[n])).size).toBe(DIAG.length);
  });
});

describe('ErrBar', () => {
  it('puts a detail line under the reason and actions at the right end', () => {
    const { container } = render(<ErrBar message="步骤接口不可用" detail="agentd 返回 502，已重试 3 次" actions={<button type="button">查看日志</button>} />);
    const bar = screen.getByRole('alert');
    expect(bar.textContent).toContain('步骤接口不可用');
    const detail = container.querySelector('[data-part="detail"]');
    expect(detail?.textContent).toBe('agentd 返回 502，已重试 3 次');
    const actions = container.querySelector('[data-part="actions"]');
    expect(actions?.contains(screen.getByRole('button', { name: '查看日志' }))).toBe(true);
    expect(bar.lastElementChild).toBe(actions);
  });

  it('draws neither part when not given', () => {
    const { container } = render(<ErrBar message="读取记忆失败" />);
    expect(container.querySelector('[data-part]')).toBeNull();
  });
});

describe('ApprovalCard details', () => {
  const danger = pick(APPROVALS, A1);

  it('keeps the rule, folder and links in the card by default', () => {
    render(<ApprovalCard approval={danger} />);
    expect(screen.queryByRole('button', { name: /详情/ })).toBeNull();
    expect(screen.getByText(/命中危险规则/)).toBeTruthy();
    expect(screen.getByText('~/Endfield/app')).toBeTruthy();
  });

  it('folds them under 详情 with their count when details is fold', () => {
    render(<ApprovalCard approval={danger} details="fold" />);
    const head = screen.getByRole('button', { name: /详情/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.textContent).toContain('4');
    expect(screen.queryByText(/命中危险规则/)).toBeNull();
    expect(screen.queryByRole('button', { name: /会话 ↗/ })).toBeNull();
    fireEvent.click(head);
    expect(screen.getByText(/命中危险规则/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /时间线 ↗/ })).toBeTruthy();
  });
});
