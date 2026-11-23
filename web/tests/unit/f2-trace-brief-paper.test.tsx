// Row hands its click to the page with the modifier keys and takes a hover tip; decision papers wear the shared tape;
// the run record marks results with StatusLamp; the brief's star is the star icon.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { DetailTab } from '../../src/pages/overview/DetailTab';
import { ITEM_ORDER, type BriefDay } from '../../src/pages/overview/briefDay';
import { DiagPage } from '../../src/pages/diag/Page';
import { Btn } from '../../src/ui/Btn';
import { Row } from '../../src/ui/Row';
import { pluginsOn, pluginsReset } from './plugins';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const read = (f: string) => readFileSync(resolve(src, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

beforeEach(() => pluginsOn());
afterEach(() => {
  pluginsReset();
  cleanup();
  localStorage.clear();
});

function mount(search: string) {
  const root = createRootRoute({ component: DiagPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${/tab=/.test(search) ? '' : '&tab=turns'}${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('Row click event and tip', () => {
  it('hands the click event to onClick, so the page can read ⌥', () => {
    const onClick = vi.fn();
    render(<Row title="后台服务" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'), { altKey: true });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0]![0].altKey).toBe(true);
  });

  it('hands the key event on Enter', () => {
    const onClick = vi.fn();
    render(<Row title="后台服务" onClick={onClick} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter', altKey: true });
    expect(onClick.mock.calls[0]![0].altKey).toBe(true);
  });

  it('shows tip on hover, and the disabled reason over it when disabled', () => {
    const { rerender } = render(<Row title="后台服务" tip="agentd.log" />);
    expect(screen.getByRole('button').getAttribute('title')).toBe('agentd.log');
    rerender(<Row title="后台服务" tip="agentd.log" disabled disabledReason="读不到" />);
    expect(screen.getByRole('button').getAttribute('title')).toBe('读不到');
  });
});

describe('运行记录 logs: ⌥ on a source row', () => {
  it('⌥ click shows only that source; the row tip names its file', async () => {
    mount('&tab=logs');
    const log = await screen.findByRole('log', { name: '日志行' });
    await waitFor(() => expect(log.textContent).toContain('ritual settle failed'));
    const rail = screen.getByRole('complementary', { name: '来源' });
    const rows = within(rail).getAllByRole('button').filter((b) => b.getAttribute('data-stub') === 'Row');
    const agentd = rows.find((r) => r.textContent?.includes('后台服务'))!;
    expect(agentd.getAttribute('title')).toMatch(/\.log|agentd/);
    expect(agentd.getAttribute('title')).toContain('⌥');
    fireEvent.click(agentd, { altKey: true });
    await waitFor(() => expect([...log.querySelectorAll('[data-key]')].every((l) => l.getAttribute('data-key')!.startsWith('agentd:'))).toBe(true));
    expect(rows.filter((r) => r.getAttribute('aria-pressed') === 'true')).toEqual([agentd]);
  });
});

describe('运行记录 result marks', () => {
  it('the turn detail and its steps mark results with StatusLamp, no page-drawn shapes', async () => {
    mount('&demo=full&turn=tr7');
    const detail = await screen.findByRole('region', { name: '这一轮' });
    await within(detail).findByRole('region', { name: '经过' });
    expect(detail.querySelector('[data-stub="StatusLamp"]')).not.toBeNull();
    expect(detail.querySelector('svg[data-shape]')).toBeNull();
  });

  it('no file draws ShapeMark any more', () => {
    for (const f of ['pages/trace/TurnDetail.tsx', 'pages/trace/StepRows.tsx', 'pages/trace/LaneView.tsx', 'pages/trace/Glyphs.tsx']) expect(read(f), f).not.toContain('ShapeMark');
  });

  it('the narrow drawer is 640 wide', () => {
    expect(read('pages/trace/Page.tsx')).toMatch(/<Sheet[^>]*width=\{640\}/);
  });
});

describe('decision paper tape', () => {
  it('Paper wears the shared tape, red at priority 0, and no left priority bar', () => {
    const css = read('ui/Paper.module.css');
    expect(css).toMatch(/composes:\s*tape from '\.\/Tape\.module\.css'/);
    expect(css).not.toMatch(/::after/);
    expect(css).toMatch(/\[data-priority='0'\][^{]*\{[^}]*--tape-hi:\s*var\(--ef-danger-vivid\)/);
  });

  it('the desktop confirm card composes the same tape and has no ink literal of its own', () => {
    const css = read('surfaces/desktop/bubble/ConfirmCard.module.css');
    expect(css).toMatch(/composes:\s*tape from '\.\.\/\.\.\/\.\.\/ui\/Tape\.module\.css'/);
    expect(css).not.toContain('#161616');
  });

  it('the unused tape cyan and magenta are gone from tokens and the stack frame', () => {
    for (const f of ['design/tokens.css', 'design/tokens.json', 'surfaces/stack/CardFrame.module.css']) expect(read(f), f).not.toMatch(/tape-[cm]\b/);
  });
});

describe('Btn link', () => {
  it('is one size: the 24 px small box', () => {
    render(<Btn variant="link">恢复默认排除</Btn>);
    expect(screen.getByRole('button').getAttribute('data-size')).toBe('sm');
    expect(read('ui/Btn.module.css')).not.toMatch(/\.link\s*\{[^}]*height:\s*auto/);
  });
});

describe('每日简报 明细 star', () => {
  it('is the star icon, yellow when on', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    const day = (await bridge.agentd.request<BriefDay>('GET', '/brief/day?date=2026-11-20')).body!;
    render(<DetailTab day={day} pins={ITEM_ORDER.slice(0, 2)} onPins={() => {}} go={() => {}} />);
    const on = screen.getAllByRole('button', { name: /^从总览拿掉：/ })[0]!;
    expect(on.querySelector('[data-icon="star"]')).not.toBeNull();
    expect(read('pages/overview/DetailTab.module.css')).toMatch(/\.star[^{]*\[aria-pressed='true'\][^{]*\{[^}]*--plate:\s*var\(--ef-accent\)/);
  });
});
