import { describe, expect, it } from 'vitest';
import { kernelBreak, kernelNodes } from '../../src/features/kernel';
import { fromRuntimePublic } from '../../src/domain';
import { pick, RUNTIMES, SETTING_GROUPS, WIRE_RUNTIME } from '../../src/mock/fixtures';
import { DEMO_SCHEMA } from '../../src/mock/settings';
import { ARCHIVE, KERNEL_LABEL, RUNTIME_ERROR, runtimeBody } from '../../src/pages/settings/fields';
import { deleteConfirm } from '../../src/pages/settings/model';
import { GROUP_IDS, REGISTRY, searchSettings } from '../../src/pages/settings/registry';

const destructive = DEMO_SCHEMA.filter((r) => r.destructive).map((r) => r.id);

describe('settings: deleting switches', () => {
  it('confirms only the rows the schema marks destructive; observation keeps its records', () => {
    expect(destructive).toEqual(['wintext', 'web', 'typing', 'agent_sessions']);
    expect(DEMO_SCHEMA.find((r) => r.id === 'observe')?.destructive).toBeUndefined();
  });

  it('uses one wording for every「关闭并删除」', () => {
    for (const id of destructive) {
      const c = deleteConfirm(id, () => {});
      expect(c.danger).toBe(true);
      expect(c.confirmLabel).toBe('关闭并删除');
      expect(c.title).toMatch(/^关闭「.+」并删除已收集的内容？$/);
    }
  });
});

describe('settings: registry and search', () => {
  it('covers all nine groups and every deleting switch; restart marks come from the schema, not the registry', () => {
    expect(SETTING_GROUPS.flatMap((c) => c.items.map((i) => i.id))).toEqual(GROUP_IDS);
    for (const g of GROUP_IDS) expect(REGISTRY.some((r) => r.group === g), g).toBe(true);
    for (const id of destructive) expect(REGISTRY.find((r) => r.id === id)?.deletesData, id).toBe(true);
    expect(REGISTRY.find((r) => r.id === 'observe')?.deletesData).toBe(false);
    expect(REGISTRY.filter((r) => r.effect === 'restartBackend')).toEqual([]);
    expect(DEMO_SCHEMA.filter((r) => r.restart === 'backend').map((r) => r.id)).toEqual(
      expect.arrayContaining(['mute', 'tts', 'observe', 'wintext', 'web', 'typing', 'mask', 'k_cu']),
    );
    expect(REGISTRY.find((r) => r.id === 'hk_focus')).toBeUndefined();
  });

  it('has the history-archive row, defaulting to keep everything', () => {
    expect(REGISTRY.find((r) => r.id === 'archive')?.group).toBe('data');
    expect(WIRE_RUNTIME.history_retention).toBe('keep');
    expect(ARCHIVE.find((o) => o.value === 'keep')?.label).toBe('不清理');
  });

  it('finds rows by label, section or keyword', () => {
    const ids = searchSettings('截图').map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['shot', 'hk_look', 'screenRecording']));
    expect(searchSettings('WORKSPACE').map((r) => r.id)).toContain('workspace');
    expect(searchSettings('  ')).toEqual([]);
  });
});

describe('KernelChain', () => {
  it('accepts a protocol-capable future CLI without a historical version audit', () => {
    const r = { ...pick(RUNTIMES, 'codex'), version: '999.0.0', boundary_verified: null };
    expect(kernelBreak(r)).toBe(-1);
    expect(kernelNodes(r).map((n) => n.state)).toEqual(['done', 'done', 'done']);
    expect(kernelBreak({ ...r, entry_supported: false })).toBe(1);
  });

  it('keeps an unaudited native app CLI ahead of the bundled discovery row', () => {
    const local = { ...WIRE_RUNTIME.installed_runtimes[0]!, backend: 'codex' as const, runtime_source: 'app_cli' as const,
      path: '/native/current/codex', version: '999.0.0', entry_supported: true, boundary_verified: null, authenticated: true };
    const state = fromRuntimePublic({ ...WIRE_RUNTIME, backend: 'codex', ready: true, error: null, selected_runtime: null,
      installed_runtimes: [{ ...local, runtime_source: 'bundled', path: '/bundled/codex' }, local] });
    const runtime = state.runtimes.find((r) => r.id === 'codex')!;
    expect(runtime.path).toBe(local.path);
    expect(runtime.runtime_source).toBe('local');
    expect(runtime.boundary_verified).toBeNull();
    expect(kernelBreak(runtime)).toBe(-1);
  });

  it('uses Pi SDK availability rather than requiring a native CLI path', () => {
    const wire = { ...WIRE_RUNTIME, available_backends: WIRE_RUNTIME.available_backends.map((b) =>
      b.id === 'pi' ? { ...b, available: true, reason: null } : b) };
    const runtime = fromRuntimePublic(wire).runtimes.find((r) => r.id === 'pi')!;
    expect(runtime.path).toBeNull();
    expect(kernelBreak(runtime)).toBe(-1);
    expect(kernelNodes(runtime)[0]?.sub).toBe('随应用的 SDK');
  });

  it('does not ask for native CLI login when the saved runtime uses an API key', () => {
    const installed = { ...WIRE_RUNTIME.installed_runtimes[0]!, backend: 'codex' as const,
      entry_supported: true, boundary_verified: null, authenticated: false };
    const runtime = fromRuntimePublic({ ...WIRE_RUNTIME, backend: 'codex', auth_source: 'api_key',
      ready: true, error: null, selected_runtime: installed }).runtimes.find((r) => r.id === 'codex')!;
    expect(runtime.authenticated).toBeNull();
    expect(kernelBreak(runtime)).toBe(-1);
  });

  it('stops at the first missing step and marks the rest unreachable', () => {
    const out = { ...pick(RUNTIMES, 'codex'), authenticated: false };
    expect(kernelBreak(out)).toBe(2);
    expect(kernelNodes(out).map((n) => n.state)).toEqual(['done', 'done', 'broken']);
    const pi = { ...pick(RUNTIMES, 'pi'), available: false };
    expect(kernelNodes(pi).map((n) => n.state)).toEqual(['broken', 'unreachable', 'unreachable']);
    expect(kernelBreak(pick(RUNTIMES, 'pi'))).toBe(-1);
  });
});

describe('runtimeBody kernel switch', () => {
  it('gives a newly picked kernel its own runtime source', () => {
    const pi = { ...WIRE_RUNTIME, backend: 'pi' as const, runtime_source: 'bundled' as const };
    expect(runtimeBody(pi, { kernel: 'codex' })).toMatchObject({ backend: 'codex', runtime_source: 'local' });
    expect(runtimeBody(WIRE_RUNTIME, { kernel: 'pi' })).toMatchObject({ backend: 'pi', runtime_source: 'bundled' });
    expect(runtimeBody(pi, { kernel: 'pi', runsrc: 'local' })).toEqual({ runtime_source: 'local' });
  });

  it('gives an ACP agent the local source, its own login and no provider', () => {
    const pi = { ...WIRE_RUNTIME, backend: 'pi' as const, runtime_source: 'bundled' as const, auth_source: 'api_key' as const, provider: 'anthropic' };
    expect(runtimeBody(pi, { kernel: 'acp', acpAgent: 'claude-acp', acpLauncher: 'npx' })).toEqual({
      backend: 'acp',
      runtime_source: 'local',
      auth_source: 'existing_login',
      provider: '',
      acp_agent: 'claude-acp',
      acp_launcher: 'npx',
    });
    expect(runtimeBody(pi, { kernel: 'acp', acpAgent: 'claude-acp', acct: 'product_login' })).toMatchObject({ auth_source: 'product_login' });
  });

  it('gives Claude Code the local source, its own login and no provider', () => {
    const pi = { ...WIRE_RUNTIME, backend: 'pi' as const, runtime_source: 'bundled' as const, auth_source: 'api_key' as const, provider: 'deepseek' };
    expect(runtimeBody(pi, { kernel: 'claude' })).toEqual({ backend: 'claude', runtime_source: 'local', auth_source: 'existing_login', provider: '' });
    expect(KERNEL_LABEL.claude).toBe('Claude Code');
  });
});

describe('RUNTIME_ERROR ACP and Pi connection codes', () => {
  it('reads each new code as a sentence with a row to fix it, and drops the retired Pi login code', () => {
    expect(RUNTIME_ERROR.acp_agent_missing?.fix?.row).toBe('acpAgent');
    expect(RUNTIME_ERROR.acp_auth_required?.label).toBeTruthy();
    expect(RUNTIME_ERROR.pi_connection_missing?.fix?.row).toBe('svc');
    expect(RUNTIME_ERROR.pi_login_required).toBeUndefined();
  });
});
