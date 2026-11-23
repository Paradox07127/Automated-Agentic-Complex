import { useEffect, useState } from 'react';
import { Btn, Select } from '../../../ui';
import { usePlugins } from '../../../shell/plugins';
import { failure, readCatalog, readServices, saveModels, testModels } from '../api';
import { Band } from '../Band';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { COMPATIBLE_THINKING, isLoopback, keyOptions, listsOwnModels, modelCaps, modelTestText, SVC, thinkOptions, tokens, type Opt } from '../fields';
import { groupDesc } from '../groups';
import { Field, Masked, St } from '../kit';
import { labelOf } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import { Stepper } from '../Stepper';
import type { ModelProvider, WireCatalog } from '../wire';
import { ChatgptRow } from './ModelChatgpt';

const MODEL_DRAFTS = ['svc', 'piProvider', 'apiBase', 'chatModel', 'think', 'acct'];

/** A Pi catalog provider in the one 模型服务 list. */
const PI = 'pi:';

/**
 * 账号: under the 和她对话 band, the service the bundled Pi kernel uses (one list, Pi's catalog providers included), its key or
 * ChatGPT account, the default model and a connection test; the band off folds them all into its one line.
 */
export function ModelGroup() {
  const { model, ro, agentdOff, models, reload } = useSettings();
  const c = useControls();
  const talks = usePlugins().light_ai;
  const [listed, setCatalog] = useState<WireCatalog | null>(null);
  const [providers, setProviders] = useState<Opt[]>([]);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
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

  /** The key goes straight to agentd for the provider on screen; it is never read back. */
  const saveKey = () => {
    if (key.trim().length < 8) return model.notify({ message: 'API Key 太短，没有保存', severity: 'warning' });
    void saveModels({ provider: svc, api_key: key.trim() }).then(() => {
      setKey('');
      setReplacing(false);
      reload('models');
      model.notify({ message: 'API Key 已保存', severity: 'success' });
    }, fail('没有保存 API Key'));
  };
  const removeKey = () =>
    model.ask({
      title: `移除 ${SVC.find((o) => o.value === svc)?.label ?? svc} 的 API Key？`,
      danger: true,
      warning: '立即删除，不能撤销',
      note: '用这个 Key 的 Pi 会停止工作，直到你重新填写。',
      confirmLabel: '移除',
      onConfirm: () =>
        saveModels({ provider: svc, clear_key: true }).then(() => {
          reload('models');
          model.notify({ message: '已移除 API Key' });
        }, fail('没能移除 API Key')),
    });
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
      <SetSection title="模型服务" info={groupDesc('model')}>
        <Band plugin="light_ai" fold="模型服务、账号、默认模型、测试连接">
          <SetRow
            id="svc"
            title={labelOf('svc')}
            desc="Pi 用它；Codex 和 Claude Code 用自己的登录"
            control={<Select label={labelOf('svc')} value={svcValue} options={svcOpts} disabled={ro || agentdOff} onChange={pickSvc} />}
          />
          {svc !== 'chatgpt' && svc !== 'deepseek' && svc !== 'xai' && svc !== 'pi_catalog' && svc !== 'compatible' && <SetRow id="apiBase" title={labelOf('apiBase')} control={c.text('apiBase', labelOf('apiBase'), 'https://…')} />}
          {svc !== 'chatgpt' && (
            <SetRow
              id="apikey"
              title={labelOf('apikey')}
              desc={noKey ? '这台电脑上的服务不用密钥' : cfg?.has_key ? '只送给后台，不回显' : '还没有保存'}
              descTone={!noKey && !cfg?.has_key ? 'attention' : undefined}
              control={
                <>
                  {keyless && c.seg('acct', keyOptions(model.value('acct')), false, 'API Key')}
                  {!noKey &&
                    (cfg?.has_key && !replacing ? (
                      <>
                        <Masked>已保存</Masked>
                        <Btn disabled={ro} onClick={() => setReplacing(true)}>
                          替换
                        </Btn>
                        <Btn variant="danger" disabled={ro} onClick={removeKey}>
                          移除
                        </Btn>
                      </>
                    ) : (
                      <>
                        <Field type="password" aria-label="API Key" placeholder={cfg?.has_key ? '输入新 Key 替换' : '粘贴 API Key'} value={key} disabled={ro || !keySlot} onChange={(e) => setKey(e.currentTarget.value)} />
                        <Btn disabled={ro || !key} onClick={saveKey}>
                          保存
                        </Btn>
                      </>
                    ))}
                </>
              }
            />
          )}
          {svc === 'chatgpt' && <ChatgptRow />}
        </Band>
      </SetSection>

      {talks && (
        <SetSection title="默认模型">
          <SetRow
            id="chatModel"
            title={labelOf('chatModel')}
            desc={picked ? modelCaps(picked) || undefined : undefined}
            control={
              <>
                {catalog?.models.length ? c.select('chatModel', catalog.models.map((m) => ({ value: m.id, label: m.name || m.id })), [], false, '默认模型') : c.text('chatModel', '默认模型', '模型 ID')}
                <Btn disabled={ro || svcDraft} disabledReason="先应用模型服务的改动" onClick={fetchCatalog}>
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
                    <Stepper label={labelOf(id)} value={Number(model.value(id) ?? min)} min={min} max={max} step={step} format={tokens} disabled={ro || agentdOff || svcDraft} disabledReason="先应用模型服务的改动" onChange={(n) => model.set(id, n)} />
                  }
                />
              ))}
              <SetRow id="images" title={labelOf('images')} indent control={c.toggle('images', labelOf('images'), svcDraft, '先应用模型服务的改动')} />
              <SetRow id="reasoning" title={labelOf('reasoning')} indent control={c.toggle('reasoning', labelOf('reasoning'), svcDraft, '先应用模型服务的改动')} />
            </>
          )}
          {levels && <SetRow id="think" title={labelOf('think')} control={c.select('think', thinkOptions(levels))} />}
          <SetRow
            id="mtest"
            title={labelOf('mtest')}
            desc={drafted ? '先应用上面的改动再测' : undefined}
            control={
              <>
                {test && <St tone={test.ok ? 'ok' : 'bad'}>{test.text}</St>}
                <Btn loading={testing} disabled={ro || drafted} disabledReason="先应用上面的改动" onClick={() => void runTest()}>
                  测试
                </Btn>
              </>
            }
          />
        </SetSection>
      )}
    </>
  );
}
