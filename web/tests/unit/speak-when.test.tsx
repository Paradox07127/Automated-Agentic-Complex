import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { PERMISSIONS } from '../../src/mock/fixtures';
import { demoNative } from '../../src/mock/settings';
import { SettingsCtx, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import { SpeakGroup } from '../../src/pages/settings/groups/Speak';
import { useSettingsModel } from '../../src/pages/settings/model';
import type { Native } from '../../src/pages/settings/native';

let native: Native;
let companion: boolean;
let request: MockInstance<AgenticComplexBridge['agentd']['request']>;

function Harness({ children, agentdOff = false }: { children: ReactNode; agentdOff?: boolean }) {
  const model = useSettingsModel({}, { native, runtime: null });
  const ctx: SettingsCtxValue = {
    model,
    ro: false,
    agentdOff,
    hl: null,
    demo: null,
    item: null,
    caps: window.agenticComplex!.capabilities,
    native,
    runtime: null,
    runtimeChecking: false,
    recheckRuntime: async () => null,
    models: null,
    diag: diagView(null),
    blacklist: null,
    scopes: [],
    reload: () => {},
    perms: PERMISSIONS,
    recheckPerms: async () => 'denied',
    goRow: () => {},
    goPage: () => {},
  };
  return (
    <SettingsCtx.Provider value={ctx}>
      {children}
      {model.toast && <output data-testid="toast">{model.toast.message}</output>}
    </SettingsCtx.Provider>
  );
}

/** Saved config.json values and agentd's companion_mode before the page opens. */
async function start(mute: boolean, speakUp: boolean, on: boolean, failCompanion = false, proactive = 'balanced') {
  native = { ...native, saved: { ...native.saved, mute, speakUp, proactive } };
  companion = on;
  const real = window.agenticComplex!.agentd.request.bind(window.agenticComplex!.agentd);
  request = vi.spyOn(window.agenticComplex!.agentd, 'request').mockImplementation(async (method, path, body) => {
    if (path !== '/proactive/settings') return real(method, path, body);
    if (method === 'PUT') {
      if (failCompanion) return { status: 503, body: { error: 'unavailable' } } as never;
      companion = (body as { companion_mode: boolean }).companion_mode;
    }
    return { status: 200, body: { companion_mode: companion, quiet_start: 22, quiet_end: 8 } } as never;
  });
  render(
    <Harness>
      <SpeakGroup />
    </Harness>,
  );
  const seg = screen.getByRole('radiogroup', { name: '她会不会主动找你' });
  // The companion read lands.
  await act(async () => {});
  return seg;
}

const click = (el: Element) => act(async () => void fireEvent.click(el));
const checked = (seg: HTMLElement) => within(seg).queryAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent);

beforeEach(async () => {
  localStorage.clear();
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
  native = await demoNative(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

describe('她会不会主动找你', () => {
  // Staying silent altogether is 出声 off plus 只在我问时, so there is no third choice for it.
  it('offers the two choices before the 多主动 row', async () => {
    const seg = await start(false, true, true);
    expect(within(seg).getAllByRole('radio').map((r) => r.textContent)).toEqual(['只在我问时', '主动']);
    const row = seg.closest('[data-row="speakWhen"]');
    const level = document.querySelector('[data-row="proactive"]');
    expect(row && level && row.compareDocumentPosition(level) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('只在我问时 writes 主动发言 off and 主动提示 off, and leaves 出声 alone', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    const seg = await start(true, true, true);
    await click(within(seg).getByRole('radio', { name: '只在我问时' }));
    expect(save).toHaveBeenCalledWith({ speakUp: false });
    expect(save).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('PUT', '/proactive/settings', { companion_mode: false });
    expect(checked(seg)).toEqual(['只在我问时']);
  });

  it('主动 writes 主动发言 on and 主动提示 on, and leaves 出声 alone', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    const seg = await start(true, false, false);
    await click(within(seg).getByRole('radio', { name: '主动' }));
    expect(save).toHaveBeenCalledWith({ speakUp: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('PUT', '/proactive/settings', { companion_mode: true });
    expect(checked(seg)).toEqual(['主动']);
  });

  it('主动发言 on and 主动提示 on read as 主动, whatever 出声 says', async () => {
    expect(checked(await start(false, true, true))).toEqual(['主动']);
    cleanup();
    expect(checked(await start(true, true, true))).toEqual(['主动']);
  });

  it('a mix that is neither choice leaves nothing chosen', async () => {
    const seg = await start(false, true, false);
    expect(checked(seg)).toEqual([]);
  });

  it('has no separate 主动发言 or 主动提示 switch; the choice is the only control over them', async () => {
    await start(false, false, false);
    expect(screen.queryByRole('switch', { name: '主动提示' })).toBeNull();
    expect(screen.queryByRole('switch', { name: '主动发言' })).toBeNull();
    expect(screen.queryByText('想法需要打开「主动发言」')).toBeNull();
    expect(document.querySelector('[data-row="speakWhen"]')?.textContent).toContain('任务结果和你设的提醒照常送达');
  });

  it('a failed 主动提示 write is reported by name; the config.json writes stay', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    const seg = await start(true, false, false, true);
    await click(within(seg).getByRole('radio', { name: '主动' }));
    expect(save).toHaveBeenCalledWith({ speakUp: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('toast').textContent).toContain('主动提示');
    // 主动发言 stays written while 主动提示 is still off: a mix that reads as neither.
    expect(checked(seg)).toEqual([]);
  });

  it('is read-only while agentd is down', async () => {
    companion = false;
    render(
      <Harness agentdOff>
        <SpeakGroup />
      </Harness>,
    );
    const seg = screen.getByRole('radiogroup', { name: '她会不会主动找你' });
    expect(within(seg).getAllByRole('radio').every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
  });
});

const dependent = () => ['proactive', 'quiet_hours'].filter((id) => document.querySelector(`[data-row="${id}"]`));
/** 多主动 with its control swapped for the dependency plate. */
const locked = () => document.querySelector('[data-row="proactive"] [role="note"]')?.textContent ?? null;

describe('主动 and the rows under it', () => {
  it('shows 多主动 and 免打扰时段 while 主动 is chosen; under 只在我问时 多主动 is a plate saying why', async () => {
    const seg = await start(false, true, true);
    expect(dependent()).toEqual(['proactive', 'quiet_hours']);
    expect(locked()).toBeNull();
    await click(within(seg).getByRole('radio', { name: '只在我问时' }));
    expect(dependent()).toEqual(['proactive']);
    expect(locked()).toBe('只在你问时她不会主动');
    await click(within(seg).getByRole('radio', { name: '主动' }));
    expect(dependent()).toEqual(['proactive', 'quiet_hours']);
    expect(locked()).toBeNull();
  });

  it('locks them while nothing is chosen', async () => {
    await start(false, true, false);
    expect(dependent()).toEqual(['proactive']);
    expect(locked()).toBe('只在你问时她不会主动');
  });

  it('多主动 offers only levels that keep her speaking and writes `proactive`', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    await start(false, true, true);
    await click(screen.getByRole('button', { name: '多主动' }));
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['均衡（默认）', '主动▲有风险']);
    await click(options[1]!);
    expect(save).toHaveBeenCalledWith({ proactive: 'active' });
  });

  it('免打扰时段 writes quiet_start and quiet_end to /proactive/settings', async () => {
    await start(false, true, true);
    const from = screen.getByRole('button', { name: '免打扰时段开始' });
    expect(from.textContent).toContain('22:00');
    await click(from);
    await click(within(screen.getByRole('listbox', { name: '免打扰时段开始' })).getByRole('option', { name: '23:00' }));
    expect(request).toHaveBeenCalledWith('PUT', '/proactive/settings', { quiet_start: 23 });
    const to = screen.getByRole('button', { name: '免打扰时段结束' });
    expect(to.textContent).toContain('08:00');
    await click(to);
    await click(within(screen.getByRole('listbox', { name: '免打扰时段结束' })).getByRole('option', { name: '07:00' }));
    expect(request).toHaveBeenCalledWith('PUT', '/proactive/settings', { quiet_end: 7 });
  });

  it('a level that keeps her from speaking does not read as 主动; choosing 主动 sets it back to 均衡', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    const seg = await start(false, true, true, false, 'quiet');
    expect(checked(seg)).toEqual([]);
    expect(locked()).toBe('只在你问时她不会主动');
    await click(within(seg).getByRole('radio', { name: '主动' }));
    expect(save).toHaveBeenCalledWith({ proactive: 'balanced' });
    expect(request).not.toHaveBeenCalledWith('PUT', '/proactive/settings', expect.anything());
    expect(checked(seg)).toEqual(['主动']);
    expect(dependent()).toEqual(['proactive', 'quiet_hours']);
  });
});

describe('说话 wording', () => {
  it('never says 安静, the do-not-disturb hours are 免打扰', async () => {
    await start(false, true, true);
    await click(screen.getByRole('button', { name: '多主动' }));
    const attrs = [...document.querySelectorAll('[title], [aria-label]')].flatMap((el) => [el.getAttribute('title') ?? '', el.getAttribute('aria-label') ?? '']);
    expect([document.body.textContent, ...attrs].filter((s) => s?.includes('安静'))).toEqual([]);
    expect(document.querySelector('[data-row="quiet_hours"]')?.textContent).toContain('免打扰时段');
  });
});
