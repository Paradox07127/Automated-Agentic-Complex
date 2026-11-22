import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HeaderSlotContext, BottomBarSlot } from '../../src/shell/headerSlot';
import { Fold, MoreLines, Sheet, Tabs } from '../../src/ui';
import { ExpandRow, GameTable } from '../../src/ui/game';

afterEach(cleanup);

const items = (n: number) => Array.from({ length: n }, (_, i) => <p key={i}>第 {i + 1} 条</p>);

describe('Fold', () => {
  beforeEach(() => {
    sessionStorage.clear();
    location.hash = '#/overview';
  });

  it('starts shut, opens with autoOpen, and opens again when autoOpen turns true', () => {
    const { rerender } = render(<Fold label="做完了" rows={6} summary="最近 11:02">{items(6)}</Fold>);
    const head = screen.getByRole('button', { name: /做完了/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('最近 11:02')).toBeTruthy();
    rerender(<Fold label="做完了" rows={6} summary="最近 11:02" autoOpen>{items(6)}</Fold>);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText('最近 11:02')).toBeNull();
    cleanup();
    render(<Fold label="出错的" rows={4} autoOpen>{items(4)}</Fold>);
    expect(screen.getByRole('button', { name: /出错的/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('shows three rows or fewer flat, without a toggle', () => {
    render(<Fold label="提醒" count={2} rows={2}>{items(2)}</Fold>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('第 2 条')).toBeTruthy();
    cleanup();
    render(<Fold variant="head" label="提醒" rows={3}>{items(3)}</Fold>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('heading', { name: '提醒' })).toBeTruthy();
    expect(screen.getByText('第 3 条')).toBeTruthy();
  });

  it('remembers its state per page and id in sessionStorage', () => {
    render(<Fold id="done" label="做完了" rows={6}>{items(6)}</Fold>);
    fireEvent.click(screen.getByRole('button', { name: /做完了/ }));
    expect(sessionStorage.getItem('ef.fold:/overview:done')).toBe('1');
    cleanup();
    render(<Fold id="done" label="做完了" rows={6}>{items(6)}</Fold>);
    expect(screen.getByRole('button', { name: /做完了/ }).getAttribute('aria-expanded')).toBe('true');
    cleanup();
    location.hash = '#/tasks';
    render(<Fold id="done" label="做完了" rows={6}>{items(6)}</Fold>);
    expect(screen.getByRole('button', { name: /做完了/ }).getAttribute('aria-expanded')).toBe('false');
    cleanup();
    render(<Fold id="shut" label="已关" rows={6} defaultOpen>{items(6)}</Fold>);
    fireEvent.click(screen.getByRole('button', { name: /已关/ }));
    cleanup();
    render(<Fold id="shut" label="已关" rows={6} defaultOpen>{items(6)}</Fold>);
    expect(screen.getByRole('button', { name: /已关/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on → and shuts on ←; Escape leaves it alone', () => {
    render(<Fold variant="head" label="前一天的观察日报" rows={8}>{items(8)}</Fold>);
    const head = screen.getByRole('button', { name: /前一天的观察日报/ });
    fireEvent.keyDown(head, { key: 'ArrowRight' });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('第 8 条')).toBeTruthy();
    fireEvent.keyDown(head, { key: 'Escape' });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(head, { key: 'ArrowLeft' });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('第 8 条')).toBeNull();
  });

  it('keeps its right-end action out of the toggle', () => {
    render(
      <Fold label="原始记录" rows={12} right={<button type="button">复制</button>}>
        {items(12)}
      </Fold>,
    );
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(screen.getByRole('button', { name: /原始记录/ }).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('ExpandRow', () => {
  it('toggles on Enter and Space, opens on →, shuts on ←, ignores Escape', () => {
    render(<ExpandRow body={<p>新增：周五整理周报</p>}>14:02 后台整理</ExpandRow>);
    const row = screen.getByRole('button', { name: /14:02/ });
    expect(row.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('新增：周五整理周报')).toBeTruthy();
    fireEvent.keyDown(row, { key: ' ' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(row, { key: 'Escape' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(row, { key: 'ArrowLeft' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });

  it('is a plain row without a body, and its end action does not toggle it', () => {
    const { container } = render(<ExpandRow end={<button type="button">生成记录 ›</button>}>14:10 进行中</ExpandRow>);
    expect(container.querySelector('[role="button"]')).toBeNull();
    cleanup();
    render(
      <ExpandRow body="详情" end={<button type="button">生成记录 ›</button>}>
        13:40 校验没通过
      </ExpandRow>,
    );
    fireEvent.click(screen.getByRole('button', { name: '生成记录 ›' }));
    expect(screen.getByRole('button', { name: /13:40/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the failed GameTable row by default and lays cells on the columns', () => {
    const { container } = render(
      <GameTable
        label="整理记录"
        columns={[
          { key: 'at', label: '时间', width: '56px' },
          { key: 'what', label: '写了什么', width: 'minmax(0, 1fr)' },
          { key: 'model', label: '模型', width: '80px', opt: true },
        ]}
        rows={[
          { id: 'a', cells: { at: '13:40', what: '缺少来源', model: 'm' }, tone: 'fail', defaultOpen: true, body: '整批没有写入' },
          { id: 'b', cells: { at: '13:12', what: '+3 新增', model: 'm' }, body: '新增 3 条' },
        ]}
        selected="b"
      />,
    );
    const table = screen.getByRole('group', { name: '整理记录' });
    expect(within(table).getByText('整批没有写入')).toBeTruthy();
    expect(within(table).queryByText('新增 3 条')).toBeNull();
    const rows = container.querySelectorAll('[data-stub="ExpandRow"]');
    expect(rows[0]?.getAttribute('data-tone')).toBe('fail');
    expect(rows[1]?.hasAttribute('data-selected')).toBe(true);
    expect(rows[0]?.querySelectorAll('[role="button"] > span')).toHaveLength(3);
  });
});

describe('Tabs variants', () => {
  const icon = <Tabs label="页签" keys={false} value="a" tabs={[{ id: 'a', label: '轮次', icon: 'history' }, { id: 'b', label: '日志', icon: 'file' }]} />;
  const avatar = <Tabs label="角色" keys={false} variant="avatar" value="a" tabs={[{ id: 'a', label: '示例乙', avatar: <i /> }, { id: 'b', label: '示例甲', avatar: <i /> }]} />;
  const steps = <Tabs label="步骤" keys={false} variant="steps" value="a" tabs={[{ id: 'a', label: '角色', icon: 'user', step: 'done' }, { id: 'b', label: '对话', icon: 'g-chat', step: 'mark' }]} />;

  /** The class names that size a cell and its selected block. */
  const shape = (el: ReactElementLike) => {
    const { container } = render(el);
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    const out = tabs.map((t) => ({ cell: t.className, icon: t.hasAttribute('data-icon'), block: t.querySelector('[data-g="slc"], [data-g="flash"]')?.className }));
    cleanup();
    return out;
  };

  it('draws icon, avatar and step tabs as the same cell with the same hanging block', () => {
    const a = shape(icon);
    expect(a.every((t) => t.icon && t.block)).toBe(true);
    expect(shape(avatar)).toEqual(a);
    expect(shape(steps)).toEqual(a);
  });

  it('reads the avatar tab by its own label and the step state as a diamond', () => {
    render(<Tabs label="角色" keys={false} variant="avatar" value="a" tabs={[{ id: 'a', label: '示例乙', ariaLabel: '示例乙，在桌面', avatar: <i /> }]} />);
    expect(screen.getByRole('tab', { name: '示例乙，在桌面' }).getAttribute('title')).toBe('示例乙');
    cleanup();
    render(steps);
    expect(screen.getByRole('img', { name: '完成' })).toBeTruthy();
    expect(screen.getByRole('img', { name: '要处理' })).toBeTruthy();
  });

  it('reports a right click on a tab', () => {
    let hit: string | null = null;
    render(<Tabs label="角色" keys={false} variant="avatar" value="a" onTabContextMenu={(id) => (hit = id)} tabs={[{ id: 'a', label: '示例乙', avatar: <i /> }, { id: 'b', label: '示例甲', avatar: <i /> }]} />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: '示例甲' }));
    expect(hit).toBe('b');
  });
});

type ReactElementLike = Parameters<typeof render>[0];

describe('MoreLines', () => {
  it('reads 全部 N 行 shut and 收起 open', () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return <MoreLines total={45} open={open} onToggle={() => setOpen(!open)} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: '全部 45 行' }));
    expect(screen.getByRole('button', { name: '收起' }).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('Sheet', () => {
  it('docks in place from dockFrom up: no dialog, shown without open', () => {
    const was = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q === '(min-width: 1200px)', media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      render(
        <Sheet open={false} title="详情" head="none" dockFrom={1200}>
          内容
        </Sheet>,
      );
      expect(screen.getByRole('complementary', { name: '详情' }).textContent).toBe('内容');
      expect(screen.queryByRole('dialog')).toBeNull();
      cleanup();
      render(
        <Sheet open title="任务" head="close" dockFrom={1600}>
          内容
        </Sheet>,
      );
      const dialog = screen.getByRole('dialog', { name: '任务' });
      expect(within(dialog).queryByRole('heading')).toBeNull();
      expect(within(dialog).getByRole('button', { name: '关闭' })).toBeTruthy();
    } finally {
      window.matchMedia = was;
    }
  });
});

describe('BottomBarSlot', () => {
  it('lays a page’s key hints, status and actions into the shell bar', () => {
    function Shell() {
      const [bottom, setBottom] = useState<HTMLDivElement | null>(null);
      return (
        <HeaderSlotContext.Provider value={{ setSub: () => {}, right: null, action: null, bottom }}>
          <BottomBarSlot lead={<span>⌘ 键位</span>} status="未应用 2 项" actions={<button type="button">应用</button>} />
          <div ref={setBottom} data-shell="bottom-bar" />
        </HeaderSlotContext.Provider>
      );
    }
    const { container } = render(<Shell />);
    const bar = container.querySelector('[data-shell="bottom-bar"]') as HTMLElement;
    expect(within(bar).getByRole('status').textContent).toBe('未应用 2 项');
    expect(within(bar).getByRole('button', { name: '应用' })).toBeTruthy();
    expect(within(bar).getByText('⌘ 键位')).toBeTruthy();
  });
});
