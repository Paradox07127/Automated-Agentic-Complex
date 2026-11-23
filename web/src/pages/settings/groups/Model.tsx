import { useEffect, useState, type ReactNode } from 'react';
import { Btn, Select } from '../../../ui';
import { StatusLamp, Stepper } from '../../../ui/game';
import { failure, readCatalog, readServices, testModels } from '../api';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { COMPATIBLE_THINKING, isLoopback, keyOptions, listsOwnModels, modelCaps, modelTestText, SVC, thinkOptions, tokens, type Opt } from '../fields';
import { labelOf } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import type { ModelProvider, WireCatalog } from '../wire';
import { ApiKeyControl, keyNote } from './ApiKey';
import { ChatgptRow } from './ModelChatgpt';

const MODEL_DRAFTS = ['svc', 'piProvider', 'apiBase', 'chatModel', 'think', 'acct'];

/** A Pi catalog provider in the one 模型提供方 list. */
const PI = 'pi:';

/**
 * AI with Pi as the kernel: 用谁的账号 │ Pi, the provider (one list, Pi's catalog providers included) with its key or ChatGPT
 * account and the runtime's `provider` row, then 模型, Pi's default model and a connection test, with `routes` under it. A 兼容 API's
 * address and key are its card's in 服务.
 */
export function PiSections({ provider, routes }: { provider?: ReactNode; routes?: ReactNode }) {
  const { model, ro, agentdOff, models, goRow } = useSettings();
  const c = useControls();
  const [listed, setCatalog] = useState<WireCatalog | null>(null);
  const [providers, setProviders] = useState<Opt[]>([]);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  // The compatible service's address is the shell's `services.llm`.
  const [llmUrl, setLlmUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    readServices().then(
      (s) => live && setLlmUrl(s.llm.url),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  const svc = String(model.value('svc') ?? models?.provider ?? 'chatgpt') as ModelProvider;
  const cfg = models?.backends[svc];
  const drafted = MODEL_DRAFTS.some((id) => id in model.draft);
  // The list and the rows written at once belong to the saved service.
  const svcDraft = 'svc' in model.draft || 'piProvider' in model.draft;
  const catalog = svcDraft ? null : listed;
  const picked = catalog?.models.find((m) => m.id === String(model.value('chatModel') ?? ''));
  const levels = svc === 'compatible' ? (model.value('reasoning') === true ? COMPATIBLE_THINKING : null) : picked?.reasoning ? picked.thinking_levels : null;
  const piProvider = String(model.value('piProvider') ?? '');
  const keySlot = svc !== 'pi_catalog' || !!piProvider;
  // Pi takes a compatible API on this machine without a key.
  const keyless = svc === 'compatible' && model.value('kernel') === 'pi' && llmUrl !== null && isLoopback(llmUrl);
  const noKey = keyless && model.value('acct') === 'local_no_auth';
  const fail = (what: string) => (e: unknown) => model.notify({ message: `${what}：${failure(e).text}`, severity: 'danger', persistent: true });

  const took = (r: WireCatalog) => {
    setCatalog(r);
    if (r.providers?.length) setProviders(r.providers.filter((p) => !SVC.some((o) => o.value === p.id)).map((p) => ({ value: p.id, label: p.name })));
  };
  const fetchCatalog = () =>
    void readCatalog().then((r) => {
      took(r);
      model.notify({ message: `已获取模型列表：${r.models.length} 个可用` });
    }, fail('没能获取模型列表'));
  // Pi's own catalog is offline and needs no key: read it as the page opens.
  const offline = !listsOwnModels(svc) && !svcDraft;
  useEffect(() => {
    setCatalog(null);
    if (!offline) return;
    let live = true;
    readCatalog().then(
      (r) => live && took(r),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [offline, svc, cfg?.pi_provider]);
  const runTest = async () => {
    setTesting(true);
    try {
      const r = await testModels();
      setTest({ ok: r.ok, text: `已连通 │ ${modelTestText(r)}` });
    } catch (e) {
      setTest({ ok: false, text: `没连通：${failure(e).text}` });
    }
    setTesting(false);
  };

  // One list: the services, then Pi's catalog providers by name; the bare 其他（Pi 目录） stays while the catalog is unread.
  const known = providers.some((p) => p.value === piProvider);
  const svcOpts: Opt[] = [
    ...SVC.filter((o) => o.value !== 'pi_catalog' || providers.length === 0),
    ...providers.map((p) => ({ value: PI + p.value, label: `${p.label}（Pi 目录）` })),
    ...(svc === 'pi_catalog' && piProvider && !known ? [{ value: PI + piProvider, label: `${piProvider}（Pi 目录）` }] : []),
  ];
  const svcValue = svc === 'pi_catalog' && piProvider ? PI + piProvider : svc;
  const pickSvc = (v: string) => {
    if (v.startsWith(PI)) {
      model.set('svc', 'pi_catalog');
      model.set('piProvider', v.slice(PI.length));
    } else model.set('svc', v);
  };

  return (
    <>
      <SetSection title="用谁的账号 │ Pi">
        <SetRow id="svc" title={labelOf('svc')} control={<Select label={labelOf('svc')} value={svcValue} options={svcOpts} disabled={ro || agentdOff} onChange={pickSvc} />} />
        {svc !== 'chatgpt' && svc !== 'deepseek' && svc !== 'xai' && svc !== 'pi_catalog' && svc !== 'compatible' && <SetRow id="apiBase" title={labelOf('apiBase')} control={c.text('apiBase', labelOf('apiBase'), 'https://…')} />}
        {svc === 'compatible' ? (
          <SetRow
            id="apikey"
            title={labelOf('apikey')}
            desc={noKey ? '这台电脑上的服务不用密钥' : cfg?.has_key ? '已保存在「服务 › 自建模型接口」里' : '地址和 Key 在「服务 › 自建模型接口」里填'}
            descTone={!noKey && !cfg?.has_key ? 'attention' : undefined}
            control={
              <>
                {keyless && c.seg('acct', keyOptions(model.value('acct')), false, 'API Key')}
                <Btn go onClick={() => goRow('svc_llm', 'services')}>
                  去服务
                </Btn>
              </>
            }
          />
        ) : (
          svc !== 'chatgpt' && (
            <SetRow
              id="apikey"
              title={labelOf('apikey')}
              desc={keyNote(cfg?.has_key === true)}
              descTone={!cfg?.has_key ? 'attention' : undefined}
              control={<ApiKeyControl key={svc} provider={svc} disabled={!keySlot} />}
            />
          )
        )}
        {svc === 'chatgpt' && <ChatgptRow />}
        {provider}
      </SetSection>

      <SetSection title="模型">
        <SetRow
          id="chatModel"
          title={labelOf('chatModel')}
          desc={picked ? modelCaps(picked) || undefined : undefined}
          control={
            <>
              {catalog?.models.length ? c.select('chatModel', catalog.models.map((m) => ({ value: m.id, label: m.name || m.id })), [], false, '默认模型') : c.text('chatModel', '默认模型', '模型 ID')}
              <Btn disabled={ro || svcDraft} disabledReason="先应用模型提供方的改动" onClick={fetchCatalog}>
                刷新列表
              </Btn>
            </>
          }
        />
        {svc === 'compatible' && (
          <>
            {(
              [
                ['ctxWindow', 16000, 2_000_000, 16000],
                ['maxOut', 1024, 32768, 1024],
              ] as const
            ).map(([id, min, max, step]) => (
              <SetRow
                key={id}
                id={id}
                title={labelOf(id)}
                indent
                control={
                  <Stepper label={labelOf(id)} value={Number(model.value(id) ?? min)} min={min} max={max} step={step} format={tokens} solid disabled={ro || agentdOff || svcDraft} disabledReason="先应用模型提供方的改动" onChange={(n) => model.set(id, n)} />
                }
              />
            ))}
            <SetRow id="images" title={labelOf('images')} indent control={c.toggle('images', labelOf('images'), svcDraft, '先应用模型提供方的改动')} />
            <SetRow id="reasoning" title={labelOf('reasoning')} indent control={c.toggle('reasoning', labelOf('reasoning'), svcDraft, '先应用模型提供方的改动')} />
          </>
        )}
        {levels && <SetRow id="think" title={labelOf('think')} control={c.select('think', thinkOptions(levels))} />}
        <SetRow
          id="mtest"
          title={labelOf('mtest')}
          desc={drafted ? '先应用上面的改动再测' : undefined}
          control={
            <>
              {test && <StatusLamp size="sm" state={test.ok ? 'ok' : 'broken'} label={test.text} />}
              <Btn loading={testing} disabled={ro || drafted} disabledReason="先应用上面的改动" onClick={() => void runTest()}>
                测试
              </Btn>
            </>
          }
        />
        {routes}
      </SetSection>
    </>
  );
}
