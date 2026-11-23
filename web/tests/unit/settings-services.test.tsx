import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { RuntimeService } from '../../src/bridge/runtimeSnapshot';
import type { ServiceId, ServiceRecord } from '../../src/bridge/services';
import { PERMISSIONS } from '../../src/mock/fixtures';
import { demoNative } from '../../src/mock/settings';
import { SettingsCtx, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import type { Native } from '../../src/pages/settings/native';
import { useSettingsModel } from '../../src/pages/settings/model';
import { joinCommand, ServicesGroup, splitCommand, type ServicesGroupProps } from '../../src/pages/settings/groups/Services';
import { ServicesData } from '../../src/pages/settings/groups/ServicesData';
import type { Go } from '../../src/shell/nav';

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

let native: Native;
let goPage: Mock<Go>;

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
    diag: diagView(null),
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
      {model.toast && <output data-testid="toast">{model.toast.message}</output>}
    </SettingsCtx.Provider>
  );
}

const OFF: ServiceRecord = { mode: 'off', url: '', ssh_host: '', start_script: '', command: [], cwd: '' };

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

function draw(records: Record<ServiceId, ServiceRecord>, runtimes: Record<ServiceId, RuntimeService | null>) {
  const props: ServicesGroupProps = { records, runtimes, onSave: vi.fn(), onStart: vi.fn(), onStop: vi.fn(), onRestart: vi.fn(), onLogs: vi.fn(), disabled: false };
  render(
    <Harness>
      <ServicesGroup {...props} />
    </Harness>,
  );
  return props;
}

const row = (name: string) => screen.getByRole('group', { name });
const unfold = (name: string) => fireEvent.click(screen.getByRole('button', { name: `${name} 接法` }));
const pick = (name: string, mode: string) => fireEvent.click(within(screen.getByRole('radiogroup', { name: `${name} 接法` })).getByRole('radio', { name: mode }));
const fields = () => screen.queryAllByRole('textbox').map((f) => f.getAttribute('aria-label'));

describe('settings › 服务', () => {
  beforeEach(async () => {
    window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
    native = await demoNative(null);
    goPage = vi.fn<Go>();
  });

  it('all off: each fold says 关 and no row has start, stop or logs', () => {
    draw({ tts: OFF, motion: OFF, llm: OFF }, { tts: null, motion: null, llm: null });
    for (const name of ['语音服务', '动作服务', '模型服务']) {
      expect(screen.getByRole('button', { name: `${name} 接法` }).textContent).toBe('关');
      expect(within(row(name)).queryAllByRole('button')).toHaveLength(0);
    }
  });

  it('each mode shows only its own fields', () => {
    draw({ tts: OFF, motion: OFF, llm: OFF }, { tts: null, motion: null, llm: null });
    unfold('语音服务');
    expect(fields()).toEqual([]);
    pick('语音服务', '地址');
    expect(fields()).toEqual(['语音服务 地址']);
    pick('语音服务', 'SSH');
    expect(fields()).toEqual(['语音服务 地址', '语音服务 SSH 主机', '语音服务 启动脚本']);
    pick('语音服务', '本机');
    expect(fields()).toEqual(['语音服务 地址', '语音服务 命令', '语音服务 工作目录']);
    pick('语音服务', '关');
    expect(fields()).toEqual([]);
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });

  it('saves the whole record: an address after a switch to 地址', () => {
    const p = draw({ tts: OFF, motion: OFF, llm: OFF }, { tts: null, motion: null, llm: null });
    unfold('模型服务');
    pick('模型服务', '地址');
    fireEvent.change(screen.getByRole('textbox', { name: '模型服务 地址' }), { target: { value: 'http://10.0.0.5:8000/v1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(p.onSave).toHaveBeenCalledWith('llm', { ...OFF, mode: 'url', url: 'http://10.0.0.5:8000/v1' });
  });

  it('ssh running, local failed with its reason, url with no start or stop', () => {
    const p = draw(MIXED, MIXED_RT);
    const tts = row('语音服务');
    expect(within(tts).getByText('运行中')).toBeTruthy();
    expect(within(tts).queryByRole('button', { name: '启动语音服务' })).toBeNull();
    fireEvent.click(within(tts).getByRole('button', { name: '停止语音服务' }));
    fireEvent.click(within(tts).getByRole('button', { name: '重启语音服务' }));
    fireEvent.click(within(tts).getByRole('button', { name: '语音服务日志' }));
    expect([p.onStop, p.onRestart, p.onLogs].map((f) => (f as ReturnType<typeof vi.fn>).mock.calls)).toEqual([[['tts']], [['tts']], [['tts']]]);
    expect(screen.getByText('gpu-box', { exact: false }).textContent).toBe('http://127.0.0.1:9880 │ gpu-box │ pid 4321');

    const motion = row('动作服务');
    expect(within(motion).getByText('失败')).toBeTruthy();
    expect(within(motion).getByText('进程退出，代码 1')).toBeTruthy();
    expect(within(motion).queryByRole('button', { name: '停止动作服务' })).toBeNull();
    fireEvent.click(within(motion).getByRole('button', { name: '启动动作服务' }));
    expect(p.onStart).toHaveBeenCalledWith('motion');

    expect(within(row('模型服务')).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '模型服务 接法' }).textContent).toBe('地址http://10.0.0.5:8000/v1');
  });

  it('the command field splits on whitespace but not inside quotes, and shows argv the same way', () => {
    const p = draw(MIXED, MIXED_RT);
    unfold('动作服务');
    const cmd = screen.getByRole('textbox', { name: '动作服务 命令' }) as HTMLInputElement;
    expect(cmd.value).toBe('python3 -m motion.serve --name "my model"');
    fireEvent.change(cmd, { target: { value: `  ./run.sh   --dir "/a b/c"  'say "hi"' "" ` } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(p.onSave).toHaveBeenCalledWith('motion', { ...MIXED.motion, command: ['./run.sh', '--dir', '/a b/c', 'say "hi"', ''] });
  });

  it('ssh with an address that is not loopback with a port cannot be saved', () => {
    const p = draw(MIXED, MIXED_RT);
    unfold('语音服务');
    const url = screen.getByRole('textbox', { name: '语音服务 地址' });
    fireEvent.change(url, { target: { value: 'http://gpu-box:9880' } });
    expect(url.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('group', { name: '地址' }).textContent).toContain('要填回环地址和端口');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(p.onSave).not.toHaveBeenCalled();
  });

  it('saves the address, host, script and directory without the blanks around them', () => {
    const p = draw({ tts: OFF, motion: OFF, llm: OFF }, { tts: null, motion: null, llm: null });
    unfold('语音服务');
    pick('语音服务', 'SSH');
    const type = (name: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name: `语音服务 ${name}` }), { target: { value } });
    type('地址', ' http://127.0.0.1:9880\n');
    type('SSH 主机', '  gpu-box ');
    type('启动脚本', ' /srv/tts/ensure.sh ');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(p.onSave).toHaveBeenLastCalledWith('tts', { ...OFF, mode: 'ssh', url: 'http://127.0.0.1:9880', ssh_host: 'gpu-box', start_script: '/srv/tts/ensure.sh' });
    pick('语音服务', '本机');
    type('命令', 'serve');
    type('工作目录', ' /srv/tts ');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(p.onSave).toHaveBeenLastCalledWith('tts', { ...OFF, mode: 'local', url: 'http://127.0.0.1:9880', ssh_host: 'gpu-box',
      start_script: '/srv/tts/ensure.sh', command: ['serve'], cwd: '/srv/tts' });
  });

  it('an address with user information, a query or a fragment cannot be saved, as the shell and agentd refuse it', () => {
    const p = draw({ tts: OFF, motion: OFF, llm: OFF }, { tts: null, motion: null, llm: null });
    unfold('语音服务');
    pick('语音服务', '地址');
    const url = screen.getByRole('textbox', { name: '语音服务 地址' });
    for (const value of ['http://me:pw@gpu-box:9880', 'http://me@gpu-box:9880', 'http://gpu-box:9880/?a=1', 'http://gpu-box:9880/#x']) {
      fireEvent.change(url, { target: { value } });
      expect(url.getAttribute('aria-invalid'), value).toBe('true');
      expect(screen.getByRole('group', { name: '地址' }).textContent, value).toContain('不能带用户名、密码、查询串或片段');
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    }
    expect(p.onSave).not.toHaveBeenCalled();
  });

  it('joinCommand undoes splitCommand', () => {
    const argv = ['a', 'b c', '', `it's`, 'x"y'];
    expect(splitCommand(joinCommand(argv))).toEqual(argv);
  });
});

describe('settings › 服务 wired to services.* and app.runtime', () => {
  beforeEach(async () => {
    window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
    native = await demoNative(null);
    goPage = vi.fn<Go>();
  });

  const bridge = () => window.agenticComplex!;
  const click = (el: Element) => act(async () => void fireEvent.click(el));
  const toast = () => screen.queryByTestId('toast')?.textContent ?? null;
  const mount = async () => {
    render(
      <Harness>
        <ServicesData />
      </Harness>,
    );
    await screen.findByRole('button', { name: '模型服务 接法' });
  };
  const saveLlmUrl = async (url: string) => {
    unfold('模型服务');
    pick('模型服务', '地址');
    fireEvent.change(screen.getByRole('textbox', { name: '模型服务 地址' }), { target: { value: url } });
    await click(screen.getByRole('button', { name: '保存' }));
  };

  it('saves through services.save and shows the record read back', async () => {
    const save = vi.spyOn(bridge().services, 'save');
    await mount();
    await saveLlmUrl('https://llm.example:8000/v1');
    expect(save).toHaveBeenCalledWith('llm', { mode: 'url', url: 'https://llm.example:8000/v1', ssh_host: '', start_script: '', command: [], cwd: '' });
    expect(toast()).toBe('已保存模型服务');
    expect((await screen.findByRole('button', { name: '模型服务 接法' })).textContent).toBe('地址https://llm.example:8000/v1');
  });

  it('reads the state again after a save: a service now run over ssh shows 运行中', async () => {
    await mount();
    unfold('语音服务');
    pick('语音服务', 'SSH');
    fireEvent.change(screen.getByRole('textbox', { name: '语音服务 地址' }), { target: { value: 'http://127.0.0.1:9880' } });
    fireEvent.change(screen.getByRole('textbox', { name: '语音服务 SSH 主机' }), { target: { value: 'gpu-box' } });
    await click(screen.getByRole('button', { name: '保存' }));
    expect(await within(row('语音服务')).findByText('运行中')).toBeTruthy();
  });

  it('invalid_record: says the shell\'s message and marks that field', async () => {
    const message = '服务 llm 的地址要用 https://（本机可用 http）';
    vi.spyOn(bridge().services, 'save').mockResolvedValue({ ok: false, error: 'invalid_record', field: 'url', message });
    await mount();
    await saveLlmUrl('http://10.0.0.5:8000/v1');
    expect(toast()).toBe(`没有保存模型服务：${message}`);
    expect(screen.getByRole('textbox', { name: '模型服务 地址' }).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('group', { name: '地址' }).textContent).toContain(message);
  });

  it('a declined save says nothing; the other refusals each say a fixed reason', async () => {
    const save = vi.spyOn(bridge().services, 'save').mockResolvedValue({ ok: false, error: 'declined' });
    await mount();
    await saveLlmUrl('https://llm.example/v1');
    expect(toast()).toBeNull();
    save.mockResolvedValue({ ok: false, error: 'write_failed', message: 'EACCES' });
    await click(screen.getByRole('button', { name: '保存' }));
    expect(toast()).toBe('没有保存模型服务：配置文件写不进去');
  });

  it('ttsTokenCleared: asks for the token again in 声音', async () => {
    vi.spyOn(bridge().services, 'save').mockResolvedValue({ ok: true, ttsTokenCleared: true });
    await mount();
    unfold('语音服务');
    pick('语音服务', '地址');
    await click(screen.getByRole('button', { name: '保存' }));
    expect(toast()).toBe('语音服务地址换了，旧令牌已删除，请在声音组重新保存令牌');
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
    const tts = row('语音服务');
    await within(tts).findByText('运行中');
    await click(within(tts).getByRole('button', { name: '停止语音服务' }));
    expect(stop).toHaveBeenCalledWith('tts');
    expect(toast()).toBe('没能停止语音服务 │ ssh: connect to host gpu-box port 22: Connection refused');
    await click(within(tts).getByRole('button', { name: '重启语音服务' }));
    expect(restart).toHaveBeenCalledWith('tts');
    expect(toast()).toBe('已重启语音服务');
    await click(within(row('动作服务')).getByRole('button', { name: '启动动作服务' }));
    expect(start).toHaveBeenCalledWith('motion');
    await click(within(tts).getByRole('button', { name: '语音服务日志' }));
    expect(goPage).toHaveBeenCalledWith({ page: 'trace', tab: 'logs', src: 'services' });
  });
});
