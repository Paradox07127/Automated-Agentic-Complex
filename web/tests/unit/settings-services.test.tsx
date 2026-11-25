import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { RuntimeService } from '../../src/bridge/runtimeSnapshot';
import type { ServiceId, ServiceRecord } from '../../src/bridge/services';
import type { WireDiagSlice } from '../../src/pages/settings/wire';
import { PERMISSIONS, WIRE_DIAG_CONNECTIONS, WIRE_TTS } from '../../src/mock/fixtures';
import { demoNative } from '../../src/mock/settings';
import { ApplyBar } from '../../src/pages/settings/ApplyBar';
import { SettingsCtx, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import type { Native } from '../../src/pages/settings/native';
import { useSettingsModel } from '../../src/pages/settings/model';
import { ServicesGroup, type ServicesGroupProps } from '../../src/pages/settings/groups/Services';
import { ServicesData } from '../../src/pages/settings/groups/ServicesData';
import { joinCommand, splitCommand } from '../../src/pages/settings/servicesDraft';
import type { Go } from '../../src/shell/nav';
import { pluginsOn, pluginsReset } from './plugins';

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

let native: Native;
let goPage: Mock<Go>;
let diag: WireDiagSlice | null;

function Harness({ children }: { children: ReactNode }) {
  const model = useSettingsModel({}, { native, runtime: null });
  const ctx: SettingsCtxValue = {
    model,
    ro: false,
    agentdOff: false,
    hl: null,
    demo: null,
    item: null,
    caps: window.agenticComplex!.capabilities,
    native,
    runtime: null,
    runtimeChecking: false,
    recheckRuntime: async () => null,
    models: null,
    diag: diagView(diag),
    blacklist: null,
    scopes: [],
    reload: () => {},
    perms: PERMISSIONS,
    recheckPerms: async () => 'denied',
    goRow: () => {},
    goPage,
  };
  return (
    <SettingsCtx.Provider value={ctx}>
      {children}
      <ApplyBar />
      {model.toast && <output data-testid="toast">{model.toast.message}</output>}
    </SettingsCtx.Provider>
  );
}

const OFF: ServiceRecord = { mode: 'off', url: '', ssh_host: '', start_script: '', command: [], cwd: '' };
const LLM = '自建模型接口（兼容 API）';

const MIXED: Record<ServiceId, ServiceRecord> = {
  tts: { ...OFF, mode: 'ssh', url: 'http://127.0.0.1:9880', ssh_host: 'gpu-box', start_script: '/srv/tts/ensure.sh' },
  motion: { ...OFF, mode: 'local', url: 'http://127.0.0.1:7860', command: ['python3', '-m', 'motion.serve', '--name', 'my model'], cwd: '/Users/me/motion' },
  llm: { ...OFF, mode: 'url', url: 'http://10.0.0.5:8000/v1' },
};
const MIXED_RT: Record<ServiceId, RuntimeService | null> = {
  tts: { mode: 'ssh', state: { kind: 'running' }, pid: 4321, detail: null },
  motion: { mode: 'local', state: { kind: 'failed', reason: '进程退出，代码 1' }, pid: null, detail: null },
  llm: { mode: 'url', state: null, pid: null, detail: null },
};
const NONE: Record<ServiceId, RuntimeService | null> = { tts: null, motion: null, llm: null };
const ALL_OFF: Record<ServiceId, ServiceRecord> = { tts: OFF, motion: OFF, llm: OFF };

function draw(records: Record<ServiceId, ServiceRecord>, runtimes: Record<ServiceId, RuntimeService | null>) {
  const props: ServicesGroupProps = { records, runtimes, onStart: vi.fn(), onStop: vi.fn(), onRestart: vi.fn(), onLogs: vi.fn(), disabled: false };
  render(
    <Harness>
      <ServicesGroup {...props} />
    </Harness>,
  );
  return props;
}

const card = (name: string) => screen.getByRole('region', { name });
const head = (name: string) => card(name).querySelector('header') as HTMLElement;
const lamp = (name: string) => head(name).querySelector('[data-stub="StatusLamp"]')?.textContent ?? null;
const seg = (name: string) => within(head(name)).getByRole('radiogroup', { name: `${name} 连接方式` });
const pick = (name: string, mode: string) => act(async () => void fireEvent.click(within(seg(name)).getByRole('radio', { name: mode })));
const picked = (name: string) => within(seg(name)).getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true')?.textContent;
const fields = () => screen.queryAllByRole('textbox').map((f) => f.getAttribute('aria-label'));
const type = (label: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value } });
const click = (el: Element) => act(async () => void fireEvent.click(el));
const apply = () => click(screen.getByRole('button', { name: '应用' }));
const toast = () => screen.queryByTestId('toast')?.textContent ?? null;

describe('settings › 服务 cards', () => {
  beforeEach(async () => {
    window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
    native = await demoNative(null);
    goPage = vi.fn<Go>();
    diag = null;
  });

  it('show each service\'s name, who uses it, its 接法 and its lamp on the head, with nothing to open', () => {
    draw(MIXED, MIXED_RT);
    const who: Array<[string, string, string]> = [['语音服务', '用于语音播报', 'SSH'], ['动作服务', '用于生成角色动作', '本机'], [LLM, 'Pi 选择「兼容 API」时使用', '地址']];
    for (const [name, use, mode] of who) {
      expect(head(name).textContent).toContain(use);
      expect(picked(name)).toBe(mode);
      expect(screen.queryByRole('button', { name: `${name} 接法` })).toBeNull();
    }
    expect(lamp('语音服务')).toBe('运行中');
    expect(lamp('动作服务')).toBe('启动失败');
    expect(card('动作服务').textContent).toContain('进程退出，代码 1');
    expect(fields()).toEqual(['语音服务 地址', '语音服务 SSH 主机', '语音服务 启动脚本', '动作服务 地址', '动作服务 命令', '动作服务 工作目录', `${LLM} 地址`]);
  });

  it('light a voice service on 地址 by whether it answers, and an off one as 没开', () => {
    diag = { connections: { ...WIRE_DIAG_CONNECTIONS, tts: WIRE_TTS.ready } } as WireDiagSlice;
    draw({ ...ALL_OFF, tts: { ...OFF, mode: 'url', url: 'http://10.0.0.5:9880' } }, NONE);
    expect(lamp('语音服务')).toBe('在线');
    expect(lamp('动作服务')).toBe('未启用');
    cleanup();
    diag = { connections: { ...WIRE_DIAG_CONNECTIONS, tts: WIRE_TTS.unreachable } } as WireDiagSlice;
    draw({ ...ALL_OFF, tts: { ...OFF, mode: 'url', url: 'http://10.0.0.5:9880' } }, NONE);
    expect(lamp('语音服务')).toBe('远端不通');
  });

  it('give start, stop, restart and logs a name and a tooltip, only where the shell runs the service', () => {
    const p = draw(MIXED, MIXED_RT);
    const tts = head('语音服务');
    expect(within(tts).queryByRole('button', { name: '启动语音服务' })).toBeNull();
    for (const name of ['停止语音服务', '重启语音服务', '语音服务日志']) {
      const b = within(tts).getByRole('button', { name });
      expect(b.getAttribute('title')).toBe(name);
      fireEvent.click(b);
    }
    expect([p.onStop, p.onRestart, p.onLogs].map((f) => (f as Mock).mock.calls)).toEqual([[['tts']], [['tts']], [['tts']]]);
    fireEvent.click(within(head('动作服务')).getByRole('button', { name: '启动动作服务' }));
    expect(p.onStart).toHaveBeenCalledWith('motion');
    expect(within(head(LLM)).queryAllByRole('button')).toHaveLength(0);
  });

  it('show only the picked 接法\'s fields', async () => {
    draw(ALL_OFF, NONE);
    expect(fields()).toEqual([]);
    await pick('语音服务', '地址');
    expect(fields()).toEqual(['语音服务 地址']);
    await pick('语音服务', 'SSH');
    expect(fields()).toEqual(['语音服务 地址', '语音服务 SSH 主机', '语音服务 启动脚本']);
    await pick('语音服务', '本机');
    expect(fields()).toEqual(['语音服务 地址', '语音服务 命令', '语音服务 工作目录']);
    await pick('语音服务', '关闭');
    expect(fields()).toEqual([]);
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });

  it('show a change as one draft on the head and in the bottom bar, and apply it whole there; no 保存 of their own', async () => {
    const save = vi.spyOn(window.agenticComplex!.services, 'save');
    draw(MIXED, MIXED_RT);
    await pick('动作服务', '关闭');
    expect(picked('动作服务')).toBe('关闭');
    expect(head('动作服务').textContent).toContain('未应用 │ 当前：本机');
    // The lamp still says what runs: the saved record.
    expect(lamp('动作服务')).toBe('启动失败');
    expect(screen.getByRole('region', { name: '未应用的改动' }).textContent).toContain('未应用 1 项');
    // The only 保存 left are the secrets', which go to agentd at once; the motion card on 关 shows none.
    expect(screen.getAllByRole('button', { name: '保存' }).map((b) => b.closest('[data-row]')?.getAttribute('data-row'))).toEqual(['ttsToken', 'svc_llm_key']);
    await pick('动作服务', '本机');
    expect(head('动作服务').textContent).not.toContain('未应用');
    await pick(LLM, '关闭');
    await apply();
    expect(save).toHaveBeenCalledWith('llm', OFF_URL(MIXED.llm));
  });

  it('send the command split on whitespace but not inside quotes, and show argv the same way', async () => {
    const save = vi.spyOn(window.agenticComplex!.services, 'save');
    draw(MIXED, MIXED_RT);
    const cmd = screen.getByRole('textbox', { name: '动作服务 命令' }) as HTMLInputElement;
    expect(cmd.value).toBe('python3 -m motion.serve --name "my model"');
    type('动作服务 命令', `  ./run.sh   --dir "/a b/c"  'say "hi"' "" `);
    await apply();
    expect(save).toHaveBeenCalledWith('motion', { ...MIXED.motion, command: ['./run.sh', '--dir', '/a b/c', 'say "hi"', ''] });
  });

  it('keep an ssh address that is not loopback with a port from being applied', async () => {
    const save = vi.spyOn(window.agenticComplex!.services, 'save');
    draw(MIXED, MIXED_RT);
    type('语音服务 地址', 'http://gpu-box:9880');
    expect(screen.getByRole('textbox', { name: '语音服务 地址' }).getAttribute('aria-invalid')).toBe('true');
    expect(within(card('语音服务')).getByRole('group', { name: '地址' }).textContent).toContain('本地或 SSH 模式须填写回环地址与端口号');
    await apply();
    expect(save).not.toHaveBeenCalled();
    expect(toast()).toBe('未能保存语音服务：本地或 SSH 模式须填写回环地址与端口号');
    expect(head('语音服务').textContent).toContain('未应用');
  });

  it('send the address, host, script and directory without the blanks around them', async () => {
    const save = vi.spyOn(window.agenticComplex!.services, 'save');
    draw(ALL_OFF, NONE);
    await pick('语音服务', 'SSH');
    type('语音服务 地址', ' http://127.0.0.1:9880\n');
    type('语音服务 SSH 主机', '  gpu-box ');
    type('语音服务 启动脚本', ' /srv/tts/ensure.sh ');
    await apply();
    expect(save).toHaveBeenLastCalledWith('tts', { ...OFF, mode: 'ssh', url: 'http://127.0.0.1:9880', ssh_host: 'gpu-box', start_script: '/srv/tts/ensure.sh' });
  });

  it('refuse an address with user information, a query or a fragment, as the shell and agentd do', async () => {
    draw(ALL_OFF, NONE);
    await pick('语音服务', '地址');
    const url = screen.getByRole('textbox', { name: '语音服务 地址' });
    for (const value of ['http://me:pw@gpu-box:9880', 'http://me@gpu-box:9880', 'http://gpu-box:9880/?a=1', 'http://gpu-box:9880/#x']) {
      fireEvent.change(url, { target: { value } });
      expect(url.getAttribute('aria-invalid'), value).toBe('true');
      expect(within(card('语音服务')).getByRole('group', { name: '地址' }).textContent, value).toContain('不得包含用户名、密码、查询参数或片段标识符');
    }
  });

  it('hold each card\'s token or key and its test while the card has a draft, so a secret is never saved or tried for the address that runs', async () => {
    pluginsOn();
    onTestFinished(() => pluginsReset());
    const request = vi.spyOn(window.agenticComplex!.agentd, 'request');
    draw(MIXED, MIXED_RT);
    await act(async () => {});
    const off = (name: string, rowId: string, button: string) => within(within(card(name)).getByRole('group', { name: rowId })).getByRole('button', { name: button }).getAttribute('aria-disabled');
    fireEvent.change(within(card('语音服务')).getByLabelText('令牌', { selector: 'input' }), { target: { value: 'b-token' } });
    fireEvent.change(within(card('动作服务')).getByLabelText('动作服务令牌', { selector: 'input' }), { target: { value: 'm-token' } });
    fireEvent.change(within(card(LLM)).getByLabelText('自建模型接口 API Key', { selector: 'input' }), { target: { value: 'llm-0123456789' } });
    expect([off('语音服务', '令牌', '保存'), off('语音服务', '测试连接', '测试'), off('动作服务', '令牌', '保存'), off(LLM, 'API Key', '保存')]).toEqual([null, null, null, null]);
    type('语音服务 地址', 'http://127.0.0.1:9881');
    type('动作服务 工作目录', '/Users/me/motion2');
    type(`${LLM} 地址`, 'http://10.0.0.6:8000/v1');
    expect([off('语音服务', '令牌', '保存'), off('语音服务', '测试连接', '测试'), off('动作服务', '令牌', '保存'), off(LLM, 'API Key', '保存')]).toEqual(['true', 'true', 'true', 'true']);
    request.mockClear();
    for (const [name, rowId, button] of [['语音服务', '令牌', '保存'], ['语音服务', '测试连接', '测试'], ['动作服务', '令牌', '保存'], [LLM, 'API Key', '保存']] as const)
      await click(within(within(card(name)).getByRole('group', { name: rowId })).getByRole('button', { name: button }));
    expect(request.mock.calls.filter((c) => c[0] !== 'GET')).toEqual([]);
  });

  it('joinCommand undoes splitCommand', () => {
    const argv = ['a', 'b c', '', `it's`, 'x"y'];
    expect(splitCommand(joinCommand(argv))).toEqual(argv);
    for (const both of [['run', `a'b"c`, 'x'], [`'"`, `"' `, ` a "b" 'c' `, '', `''`, `""`]]) expect(splitCommand(joinCommand(both)), joinCommand(both)).toEqual(both);
  });
});

const OFF_URL = (r: ServiceRecord): ServiceRecord => ({ ...r, mode: 'off' });

describe('settings › 服务 wired to services.* and app.runtime', () => {
  beforeEach(async () => {
    window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
    native = await demoNative(null);
    goPage = vi.fn<Go>();
    diag = null;
  });

  const bridge = () => window.agenticComplex!;
  const mount = async () => {
    render(
      <Harness>
        <ServicesData />
      </Harness>,
    );
    await screen.findByRole('region', { name: LLM });
  };
  const applyLlmUrl = async (url: string) => {
    await pick(LLM, '地址');
    type(`${LLM} 地址`, url);
    await apply();
  };

  it('applies through services.save and shows the record read back as saved', async () => {
    const save = vi.spyOn(bridge().services, 'save');
    await mount();
    await applyLlmUrl('https://llm.example:8000/v1');
    expect(save).toHaveBeenCalledWith('llm', { mode: 'url', url: 'https://llm.example:8000/v1', ssh_host: '', start_script: '', command: [], cwd: '' });
    expect(toast()).toBe('已应用 1 项');
    expect(picked(LLM)).toBe('地址');
    expect(head(LLM).textContent).not.toContain('未应用');
    expect((screen.getByRole('textbox', { name: `${LLM} 地址` }) as HTMLInputElement).value).toBe('https://llm.example:8000/v1');
  });

  it('reads the state again after applying: a service now run over ssh shows 运行中', async () => {
    await mount();
    await pick('语音服务', 'SSH');
    type('语音服务 地址', 'http://127.0.0.1:9880');
    type('语音服务 SSH 主机', 'gpu-box');
    await apply();
    await vi.waitFor(() => expect(lamp('语音服务')).toBe('运行中'));
  });

  it('invalid_record: says the shell\'s message, marks that field and keeps the draft', async () => {
    const message = '服务 llm 的地址要用 https://（本机可用 http）';
    vi.spyOn(bridge().services, 'save').mockResolvedValue({ ok: false, error: 'invalid_record', field: 'url', message });
    await mount();
    await applyLlmUrl('http://10.0.0.5:8000/v1');
    expect(toast()).toBe(`未能保存${LLM}：${message}`);
    expect(screen.getByRole('textbox', { name: `${LLM} 地址` }).getAttribute('aria-invalid')).toBe('true');
    expect(within(card(LLM)).getByRole('group', { name: '地址' }).textContent).toContain(message);
    expect(head(LLM).textContent).toContain('未应用');
  });

  it('a declined save says nothing and keeps the draft; the other refusals each say a fixed reason', async () => {
    const save = vi.spyOn(bridge().services, 'save').mockResolvedValue({ ok: false, error: 'declined' });
    await mount();
    await applyLlmUrl('https://llm.example/v1');
    expect(toast()).toBeNull();
    save.mockResolvedValue({ ok: false, error: 'write_failed', message: 'EACCES' });
    await apply();
    expect(toast()).toBe(`未能保存${LLM}：写入配置文件失败`);
  });

  it('ttsTokenCleared: names the voice card, where the token is saved again', async () => {
    vi.spyOn(bridge().services, 'save').mockResolvedValue({ ok: true, ttsTokenCleared: true });
    await mount();
    await pick('语音服务', '地址');
    type('语音服务 地址', 'http://10.0.0.5:9880');
    await apply();
    expect(toast()).toBe('语音服务地址已更改，原有令牌已清除，请在「设置 › 服务 › 语音服务」中重新保存令牌');
  });

  it('start, stop and restart call their op; a failure says why with the script\'s line; logs open the services source', async () => {
    await bridge().services.save('tts', { mode: 'ssh', url: 'http://127.0.0.1:9880', ssh_host: 'gpu-box', start_script: '', command: [], cwd: '' });
    await bridge().services.save('motion', { mode: 'local', url: 'http://127.0.0.1:7860', ssh_host: '', start_script: '', command: ['run'], cwd: '' });
    const runtime = bridge().app.runtime.bind(bridge().app);
    vi.spyOn(bridge().app, 'runtime').mockImplementation(async () => {
      const r = await runtime();
      return { ...r, services: { ...r.services, motion: { mode: 'local', state: { kind: 'failed', reason: '进程退出，代码 1' }, pid: null, detail: null } } };
    });
    const ops = bridge().services;
    const stop = vi.spyOn(ops, 'stop').mockResolvedValue({ ok: false, error: 'stop_failed', line: 'ssh: connect to host gpu-box port 22: Connection refused' });
    const restart = vi.spyOn(ops, 'restart');
    const start = vi.spyOn(ops, 'start');
    await mount();
    await vi.waitFor(() => expect(lamp('语音服务')).toBe('运行中'));
    const tts = head('语音服务');
    await click(within(tts).getByRole('button', { name: '停止语音服务' }));
    expect(stop).toHaveBeenCalledWith('tts');
    expect(toast()).toBe('未能停止语音服务 │ ssh: connect to host gpu-box port 22: Connection refused');
    await click(within(tts).getByRole('button', { name: '重启语音服务' }));
    expect(restart).toHaveBeenCalledWith('tts');
    expect(toast()).toBe('已重启语音服务');
    await click(within(head('动作服务')).getByRole('button', { name: '启动动作服务' }));
    expect(start).toHaveBeenCalledWith('motion');
    await click(within(tts).getByRole('button', { name: '语音服务日志' }));
    expect(goPage).toHaveBeenCalledWith({ page: 'diag', tab: 'logs', src: 'services' });
  });
});
