// Pi rows of 角色内核 and pi 账号与凭据: xAI, the test result, the catalog button, the keyless compatible API, Pi's account rows and its readiness codes.
import { useMemo, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AgentdCallError } from '../../src/bridge/agentd';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import type { WireRuntimePublic } from '../../src/domain/wire';
import { PERMISSIONS } from '../../src/mock/fixtures';
import { demoNative } from '../../src/mock/settings';
import { ApplyBar } from '../../src/pages/settings/ApplyBar';
import { failure } from '../../src/pages/settings/api';
import { runtimeView, SettingsCtx, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import { modelTestText, RUNTIME_ERROR, SVC } from '../../src/pages/settings/fields';
import { KernelGroup } from '../../src/pages/settings/groups/Kernel';
import { ModelGroup } from '../../src/pages/settings/groups/Model';
import { useSettingsModel, type ModelInit } from '../../src/pages/settings/model';
import type { Native } from '../../src/pages/settings/native';
import type { WireModelSettings } from '../../src/pages/settings/wire';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so each group shows all its rows.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

type Loaded = { native: Native; runtime: WireRuntimePublic; models: WireModelSettings };

async function load(): Promise<Loaded> {
  const get = async <T,>(p: string) => (await window.agenticComplex!.agentd.request<T>('GET', p)).body as T;
  return { native: await demoNative(null), runtime: await get<WireRuntimePublic>('/character/runtime'), models: await get<WireModelSettings>('/model/settings') };
}

function Harness({ d, init = {}, goRow = () => {}, children }: { d: Loaded; init?: ModelInit; goRow?: (id: string) => void; children: ReactNode }) {
  const view = useMemo(() => diagView({}), []);
  const model = useSettingsModel(init, { native: d.native, runtime: d.runtime, models: d.models, pauses: view.pauses });
  const runtime = runtimeView(d.runtime);
  const ctx: SettingsCtxValue = {
    model,
    ro: false,
    agentdOff: false,
    hl: null,
    demo: null,
    item: null,
    caps: window.agenticComplex!.capabilities,
    native: d.native,
    runtime,
    runtimeChecking: false,
    recheckRuntime: async () => runtime,
    models: d.models,
    diag: view,
    blacklist: null,
    scopes: [],
    runs: [],
    reload: () => {},
    perms: PERMISSIONS,
    recheckPerms: async () => 'granted',
    goRow,
    goPage: () => {},
  };
  return <SettingsCtx.Provider value={ctx}>{children}</SettingsCtx.Provider>;
}

let d: Loaded;
let request: MockInstance<AgenticComplexBridge['agentd']['request']>;
beforeEach(async () => {
  localStorage.clear();
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
  d = await load();
  request = vi.spyOn(window.agenticComplex.agentd, 'request');
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

const click = (el: Element) => act(async () => void fireEvent.click(el));
const settle = () => act(async () => {});
const sent = (method: string, path: string) => request.mock.calls.find((c) => c[0] === method && c[1] === path)?.[2];
const row = (id: string) => document.querySelector(`[data-row="${id}"]`) as HTMLElement | null;
const options = async (select: string) => {
  await click(screen.getByRole('button', { name: select }));
  return within(screen.getByRole('listbox', { name: select })).getAllByRole('option').map((o) => o.textContent);
};
const pi = (over: Partial<WireRuntimePublic> = {}): Loaded => ({ ...d, runtime: { ...d.runtime, backend: 'pi', runtime_source: 'bundled', ...over } });
const compatible = (base_url: string): WireModelSettings => ({ ...d.models, provider: 'compatible', backends: { ...d.models.backends, compatible: { ...d.models.backends.compatible, base_url } } });

describe('Grok / xAI in pi 账号与凭据', () => {
  it('is a model service with its own key slot and no address row, like DeepSeek', async () => {
    expect(SVC.find((o) => o.value === 'xai')?.label).toBe('Grok / xAI');
    render(<Harness d={{ ...d, models: { ...d.models, provider: 'xai' } }}><ModelGroup /></Harness>);
    expect(row('apiBase')).toBeNull();
    fireEvent.change(row('apikey')!.querySelector('input[aria-label="API Key"]')!, { target: { value: 'xai-0123456789' } });
    await click(within(row('apikey')!).getByRole('button', { name: '保存' }));
    expect(sent('POST', '/model/settings')).toEqual({ provider: 'xai', api_key: 'xai-0123456789' });
  });
});

describe('测试连接 result', () => {
  it('names kernel, service, model, time, tokens and cost of a Pi test', () => {
    const r = { ok: true, kernel: 'pi', provider: 'anthropic', model: 'claude-haiku-5-5', elapsed_ms: 812, tokens: { input_tokens: 1000, output_tokens: 12, cache_read_input_tokens: 150, cache_creation_input_tokens: 30 }, cost_usd: 0.0012 };
    expect(modelTestText(r)).toBe('Pi │ Anthropic API │ claude-haiku-5-5 │ 812 ms │ 1192 tokens │ $0.0012');
    expect(modelTestText({ ...r, provider: 'xai', cost_usd: 0 })).toBe('Pi │ Grok / xAI │ claude-haiku-5-5 │ 812 ms │ 1192 tokens │ $0.0000');
  });

  it('leaves out the null fields of another kernel', async () => {
    render(<Harness d={d}><ModelGroup /></Harness>);
    await click(screen.getByRole('button', { name: '测试' }));
    expect(row('mtest')?.textContent).toContain('已连通 │ Codex │ claude-haiku-5-5 │ 812 ms');
    expect(row('mtest')?.textContent).not.toMatch(/tokens|\$/);
  });

  it('shows a failed test by the code text, not the generic sentence', async () => {
    render(<Harness d={d}><ModelGroup /></Harness>);
    await settle();
    request.mockRejectedValueOnce(new AgentdCallError(400, 'auth_expired', undefined, {}, 'x'));
    await click(screen.getByRole('button', { name: '测试' }));
    expect(row('mtest')?.textContent).toContain('没连通：登录已过期，请重新登录');
  });
});

describe('获取列表', () => {
  it('waits while the service choice is an unsaved draft', async () => {
    render(<Harness d={d} init={{ draft: { svc: 'openai' } }}><ModelGroup /></Harness>);
    const fetch = () => within(row('chatModel')!).getByRole('button', { name: '获取列表' });
    expect(fetch().getAttribute('aria-disabled')).toBe('true');
    await click(fetch());
    expect(sent('POST', '/model/catalog')).toBeUndefined();
    cleanup();
    render(<Harness d={d}><ModelGroup /></Harness>);
    expect(fetch().getAttribute('aria-disabled')).toBeNull();
  });
});

describe("Pi's model catalog", () => {
  const withModel = (model: string): Loaded => ({ ...d, models: { ...d.models, backends: { ...d.models.backends, anthropic: { ...d.models.backends.anthropic, model } } } });

  it("lists a Pi service's models from the catalog without a click, with the picked model's capabilities", async () => {
    render(<Harness d={d}><ModelGroup /></Harness>);
    await settle();
    expect(sent('POST', '/model/catalog')).toEqual({});
    expect(await options('默认模型')).toEqual(['Claude Haiku 5.5', 'Claude Sonnet 5', 'Claude Instant 2']);
    expect(row('chatModel')?.textContent).toContain('上下文 200k │ 最大输出 64k │ 图像输入 │ 思考 │ 有目录价格');
  });

  it("shows 思考强度 for a thinking model only, with that model's levels, and saves the pick", async () => {
    render(<Harness d={d}><ModelGroup /><ApplyBar /></Harness>);
    await settle();
    expect(await options('思考强度')).toEqual(['模型默认', '不思考', '最低', '低', '中', '高']);
    await click(screen.getByRole('option', { name: '高' }));
    await click(screen.getByRole('button', { name: '应用' }));
    expect(sent('POST', '/model/settings')).toEqual({ provider: 'anthropic', reasoning_effort: 'high' });
    cleanup();
    render(<Harness d={withModel('claude-sonnet-5')}><ModelGroup /></Harness>);
    await settle();
    expect(await options('思考强度')).toEqual(['模型默认', '不思考', '最低', '低', '中', '高', '很高', '最高']);
    cleanup();
    render(<Harness d={withModel('claude-instant-2')}><ModelGroup /></Harness>);
    await settle();
    expect(row('think')).toBeNull();
    expect(row('chatModel')?.textContent).toContain('上下文 100k │ 最大输出 4k │ 不计价');
  });

  it('leaves a compatible API and ChatGPT to their own list, fetched on a click', async () => {
    render(<Harness d={{ ...d, models: compatible('http://127.0.0.1:11434/v1') }}><ModelGroup /></Harness>);
    await settle();
    expect(sent('POST', '/model/catalog')).toBeUndefined();
    expect(row('think')).toBeNull();
  });
});

describe('the model of a compatible API', () => {
  const caps = (over: Partial<WireModelSettings['backends']['compatible']>): Loaded => {
    const m = compatible('http://127.0.0.1:11434/v1');
    return { ...d, models: { ...m, backends: { ...m.backends, compatible: { ...m.backends.compatible, ...over } } } };
  };

  it('has a 模型能力 group whose rows write the compatible connection', async () => {
    render(<Harness d={caps({})}><ModelGroup /></Harness>);
    expect(row('ctxWindow')!.querySelector('output')?.textContent).toBe('128k');
    await click(screen.getByRole('button', { name: '上下文长度 增加' }));
    expect(sent('POST', '/model/settings')).toEqual({ provider: 'compatible', context_window: 144000 });
    request.mockClear();
    await click(screen.getByRole('button', { name: '最大输出 增加' }));
    expect(sent('POST', '/model/settings')).toEqual({ provider: 'compatible', max_output_tokens: 5120 });
    request.mockClear();
    await click(screen.getByRole('switch', { name: '图像输入' }));
    expect(sent('POST', '/model/settings')).toEqual({ provider: 'compatible', supports_images: true });
    request.mockClear();
    await click(screen.getByRole('switch', { name: '思考' }));
    expect(sent('POST', '/model/settings')).toEqual({ provider: 'compatible', reasoning: true });
  });

  it("offers Pi's levels for a thinking model without a level map once 思考 is on", async () => {
    render(<Harness d={caps({ reasoning: false })}><ModelGroup /></Harness>);
    expect(row('think')).toBeNull();
    cleanup();
    render(<Harness d={caps({ reasoning: true })}><ModelGroup /></Harness>);
    expect(await options('思考强度')).toEqual(['模型默认', '不思考', '最低', '低', '中', '高']);
  });

  it('waits for the service choice before writing a capability', () => {
    render(<Harness d={caps({})} init={{ draft: { svc: 'compatible' } }}><ModelGroup /></Harness>);
    expect(screen.getByRole('switch', { name: '图像输入' }).getAttribute('aria-disabled')).toBe('true');
  });
});

describe('其他（Pi 目录）', () => {
  const other = (pi_provider: string, has_key = false): Loaded => ({
    ...d,
    models: { ...d.models, provider: 'pi_catalog', backends: { ...d.models.backends, pi_catalog: { ...d.models.backends.pi_catalog, pi_provider, has_key } } },
  });

  it("is a model service whose provider comes from Pi's catalog, less the services with their own entry", async () => {
    expect(SVC.find((o) => o.value === 'pi_catalog')?.label).toBe('其他（Pi 目录）');
    render(<Harness d={other('')}><ModelGroup /></Harness>);
    await settle();
    expect(row('apiBase')).toBeNull();
    expect(await options('服务提供方')).toEqual(['Groq', 'OpenRouter']);
    await click(screen.getByRole('option', { name: 'Groq' }));
    expect(sent('POST', '/model/settings')).toEqual({ provider: 'pi_catalog', pi_provider: 'groq' });
  });

  it("keeps the key in the chosen provider's slot, and has none to fill before a provider is chosen", async () => {
    render(<Harness d={other('')}><ModelGroup /></Harness>);
    expect((row('apikey')!.querySelector('input[aria-label="API Key"]') as HTMLInputElement).disabled).toBe(true);
    cleanup();
    render(<Harness d={other('groq')}><ModelGroup /></Harness>);
    fireEvent.change(row('apikey')!.querySelector('input[aria-label="API Key"]')!, { target: { value: 'gsk-0123456789' } });
    await click(within(row('apikey')!).getByRole('button', { name: '保存' }));
    expect(sent('POST', '/model/settings')).toEqual({ provider: 'pi_catalog', api_key: 'gsk-0123456789' });
  });
});

describe('compatible API on this machine', () => {
  it('offers API Key or no key, and no key writes Pi auth_source local_no_auth', async () => {
    render(<Harness d={{ ...pi(), models: compatible('http://127.0.0.1:11434/v1') }}><ModelGroup /><ApplyBar /></Harness>);
    const seg = within(row('apikey')!).getByRole('radiogroup');
    expect(within(seg).getAllByRole('radio').map((r) => r.textContent)).toEqual(['API Key', '无需密钥']);
    expect(within(seg).getByRole('radio', { name: 'API Key' }).getAttribute('aria-checked')).toBe('true');
    await click(within(seg).getByRole('radio', { name: '无需密钥' }));
    expect(row('apikey')!.querySelector('input[aria-label="API Key"]')).toBeNull();
    await click(screen.getByRole('button', { name: '应用' }));
    expect(sent('PUT', '/character/runtime')).toEqual({ auth_source: 'local_no_auth' });
  });

  it('keeps the plain key row on a remote address or off Pi', () => {
    render(<Harness d={{ ...pi(), models: compatible('https://llm.example.com/v1') }}><ModelGroup /></Harness>);
    expect(within(row('apikey')!).queryByRole('radiogroup')).toBeNull();
    cleanup();
    render(<Harness d={{ ...d, models: compatible('http://localhost:11434/v1') }}><ModelGroup /></Harness>);
    expect(within(row('apikey')!).queryByRole('radiogroup')).toBeNull();
  });
});

describe('Pi account rows', () => {
  it('offers only AI 账号 and 本机无需密钥 as the account source', async () => {
    render(<Harness d={pi()}><KernelGroup /></Harness>);
    expect(row('acct')?.textContent).toContain('AI 账号');
    expect(row('acct')?.textContent).not.toContain('内核自己的登录');
    expect(await options('账号来源')).toEqual(['AI 账号', '本机无需密钥']);
  });

  it('picks the provider from provider_profiles and the account source the profile needs', async () => {
    render(<Harness d={pi()}><KernelGroup /><ApplyBar /></Harness>);
    expect(row('provider')!.querySelector('input')).toBeNull();
    expect(await options('服务提供方')).toEqual(['AI 账号', 'Anthropic API', 'OpenAI API', 'Grok / xAI', 'DeepSeek', '兼容 API']);
    await click(screen.getByRole('option', { name: 'DeepSeek' }));
    await click(screen.getByRole('button', { name: '应用' }));
    expect(sent('PUT', '/character/runtime')).toEqual({ provider: 'deepseek', auth_source: 'api_key' });
  });
});

describe('Pi readiness codes', () => {
  it('has a sentence for each Pi code', () => {
    for (const code of ['select_model', 'credentials_missing', 'pi_model_unavailable', 'pi_runtime_unavailable', 'sdk_startup_timeout', 'pi_runner_error', 'pi_node_version_mismatch'])
      expect(RUNTIME_ERROR[code]?.label, code).toBeTruthy();
  });

  it('links select_model to the chat-model row', async () => {
    const goRow = vi.fn();
    render(<Harness d={pi({ ready: false, error: 'select_model' })} goRow={goRow}><KernelGroup /></Harness>);
    expect(screen.getByText('未就绪：还没有选模型')).toBeTruthy();
    await click(screen.getByRole('button', { name: '去选模型' }));
    expect(goRow).toHaveBeenCalledWith('chatModel');
  });

  it('failure() falls back to the code text before the generic sentence', () => {
    expect(failure(new AgentdCallError(400, 'rate_limited', undefined, {}, 'x')).text).toBe('请求过于频繁，请稍后重试');
    expect(failure(new AgentdCallError(400, 'some_new_code', undefined, {}, 'x')).text).toBe('后台没有接受这次修改');
  });
});

describe('a failed call with a kernel readiness code', () => {
  it('reads the kernel reason, not the generic text', () => {
    expect(failure(new AgentdCallError(502, 'pi_runner_error', undefined, { error: 'pi_runner_error' }, 'pi_runner_error')).text)
      .toBe('Pi 运行出错，请重新检测');
  });
});

describe("Pi's own section of 角色内核", () => {
  const flags = (catalog_priced: boolean) => ({ product_checkpoint: true, cost_limit_supported: true, catalog_priced, native_images: false, custom_tools: true });
  const tools = () => within(screen.getByRole('grid', { name: 'Pi 的工具' })).getAllByRole('row').slice(1).map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent));

  it('lists the tools Pi found with their shell, and the approval switch marks the ones that wait for a card', async () => {
    render(<Harness d={pi()}><KernelGroup /><ApplyBar /></Harness>);
    expect(tools()).toEqual([
      ['read', '可用', '无', '无'],
      ['bash', '可用', '/bin/bash', '要批准'],
      ['edit', '可用', '无', '要批准'],
      ['write', '可用', '无', '要批准'],
      ['ls', '可用', '无', '无'],
      ['grep', '本机没有 rg', '无', '无'],
      ['find', '本机没有 fd', '无', '无'],
    ]);
    await click(within(row('piApproval')!).getByRole('switch', { name: '工具审批' }));
    expect(tools().map((t) => t[3])).toEqual(['无', '无', '无', '无', '无', '无', '无']);
    await click(screen.getByRole('button', { name: '应用' }));
    expect(sent('PUT', '/character/runtime')).toEqual({ pi_tool_approval: false });
  });

  it("reads 未启动 before a Pi session started, and the kernel card shows the SDK version once one did", () => {
    render(<Harness d={pi({ pi_session: null })}><KernelGroup /></Harness>);
    expect(row('piTools')?.textContent).toContain('未启动');
    expect(row('kcur')?.textContent).not.toContain('1.4.0');
    cleanup();
    render(<Harness d={pi()}><KernelGroup /></Harness>);
    expect(row('kcur')?.textContent).toContain('Pi1.4.0');
  });

  it('keeps the cost cap editable unless a saved, ready Pi runs a model without a catalog price', () => {
    const more = () => within(row('maxCost')!).getByRole('button', { name: '单次费用上限 增加' });
    render(<Harness d={pi({ capability_flags: flags(true) })}><KernelGroup /></Harness>);
    expect(more().hasAttribute('disabled')).toBe(false);
    cleanup();
    render(<Harness d={pi({ capability_flags: flags(false) })}><KernelGroup /></Harness>);
    expect(more().hasAttribute('disabled')).toBe(true);
    expect(more().parentElement?.getAttribute('title')).toBe('这个模型没有目录价格');
    cleanup();
    // Picked but not applied: the flag still describes the saved Codex.
    render(<Harness d={d} init={{ draft: { kernel: 'pi' } }}><KernelGroup /></Harness>);
    expect(more().hasAttribute('disabled')).toBe(false);
  });
});
