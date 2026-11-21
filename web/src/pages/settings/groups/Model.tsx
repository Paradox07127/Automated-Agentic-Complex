import { useEffect, useState } from 'react';
import { Btn } from '../../../ui';
import { failure, readCatalog, saveModels, testModels } from '../api';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { COMPATIBLE_THINKING, isLoopback, keyOptions, listsOwnModels, modelCaps, modelTestText, SVC, thinkOptions, tokens } from '../fields';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import { Stepper } from '../Stepper';
import type { ModelProvider, WireCatalog } from '../wire';
import { ChatgptRow } from './ModelChatgpt';
import { HooksSection } from './ModelHooks';
import styles from '../groups.module.css';

const MODEL_DRAFTS = ['svc', 'apiBase', 'chatModel', 'think', 'acct'];

/** pi 账号与凭据: the credentials the bundled pi kernel uses, its default provider and model, coding-tool hooks; call counts only (no tokens or cost). */
export function ModelGroup() {
  const { model, ro, agentdOff, goPage, models, diag, runs, reload } = useSettings();
  const c = useControls();
  const [listed, setCatalog] = useState<WireCatalog | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [key, setKey] = useState('');
  const svc = String(model.value('svc') ?? models?.provider ?? 'chatgpt') as ModelProvider;
  const cfg = models?.backends[svc];
  const drafted = MODEL_DRAFTS.some((id) => id in model.draft);
  // The list and the rows written at once belong to the saved service.
  const svcDraft = 'svc' in model.draft;
  const catalog = svcDraft ? null : listed;
  const picked = catalog?.models.find((m) => m.id === String(model.value('chatModel') ?? ''));
  const levels = svc === 'compatible' ? (model.value('reasoning') === true ? COMPATIBLE_THINKING : null) : picked?.reasoning ? picked.thinking_levels : null;
  const piProviders = (catalog?.providers ?? []).filter((p) => !SVC.some((o) => o.value === p.id)).map((p) => ({ value: p.id, label: p.name }));
  const keySlot = svc !== 'pi_catalog' || !!cfg?.pi_provider;
  // Pi takes a compatible API on this machine without a key.
  const keyless = svc === 'compatible' && model.value('kernel') === 'pi' && isLoopback(String(model.value('apiBase') ?? ''));
  const noKey = keyless && model.value('acct') === 'local_no_auth';
  const fail = (what: string) => (e: unknown) => model.notify({ message: `${what}：${failure(e).text}`, severity: 'danger', persistent: true });

  /** The key goes straight to agentd for the provider on screen; it is never read back. */
  const saveKey = () => {
    if (key.trim().length < 8) return model.notify({ message: 'API Key 太短，没有保存', severity: 'warning' });
    void saveModels({ provider: svc, api_key: key.trim() }).then(() => {
      setKey('');
      reload('models');
      model.notify({ message: 'API Key 已保存', severity: 'success' });
    }, fail('没有保存 API Key'));
  };
  const removeKey = () =>
    model.ask({
      title: '移除 API Key？',
      danger: true,
      warning: '立即删除，不能撤销',
      note: '用这个 Key 的 pi 会停止工作，直到你重新填写。',
      confirmLabel: '移除',
      onConfirm: () =>
        saveModels({ provider: svc, clear_key: true }).then(() => {
          reload('models');
          model.notify({ message: '已移除 API Key' });
        }, fail('没能移除 API Key')),
    });
  const fetchCatalog = () =>
    void readCatalog().then((r) => {
      setCatalog(r);
      model.notify({ message: `已获取模型列表：${r.models.length} 个可用` });
    }, fail('没能获取模型列表'));
  // Pi's own catalog is offline and needs no key: read it as the page opens.
  const offline = !listsOwnModels(svc) && !svcDraft;
  useEffect(() => {
    setCatalog(null);
    if (!offline) return;
    let live = true;
    readCatalog().then(
      (r) => live && setCatalog(r),
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

  return (
    <>
      <div className={styles.usage}>
        <span>
          今日调用 <span className="num">{diag.calls ?? '—'}</span> │ 角色运行 <span className="num">{runs ? runs.length : '—'}</span>
        </span>
        <button type="button" className={styles.lnk} onClick={() => goPage({ page: 'diag', item: 'usage' })}>
          用量和费用 → 诊断
        </button>
      </div>

      <SetSection title="账号与凭据">
        <SetRow id="svc" title="模型服务" control={c.select('svc', SVC)} />
        {svc === 'pi_catalog' && <SetRow id="piProvider" title="服务提供方" control={c.select('piProvider', piProviders, [], svcDraft || !catalog, '服务提供方')} />}
        {svc !== 'chatgpt' && svc !== 'deepseek' && svc !== 'xai' && svc !== 'pi_catalog' && <SetRow id="apiBase" title="API 地址" control={c.text('apiBase', 'API 地址', 'https://…')} />}
        {svc !== 'chatgpt' && (
          <SetRow
            id="apikey"
            title="API Key"
            desc={noKey ? undefined : cfg?.has_key ? '已保存' : '还没有保存'}
            control={
              <>
                {keyless && c.seg('acct', keyOptions(model.value('acct')))}
                {!noKey && (
                  <>
                    <input className={styles.input} type="password" aria-label="API Key" placeholder={cfg?.has_key ? '输入新 Key 替换' : '粘贴 API Key'} value={key} disabled={ro || !keySlot} onChange={(e) => setKey(e.currentTarget.value)} />
                    <Btn size="sm" variant="ghost" disabled={ro || !key} onClick={saveKey}>
                      保存
                    </Btn>
                    {cfg?.has_key && (
                      <Btn size="sm" variant="danger" disabled={ro} onClick={removeKey}>
                        移除
                      </Btn>
                    )}
                  </>
                )}
              </>
            }
          />
        )}
        {svc === 'chatgpt' && <ChatgptRow />}
      </SetSection>

      <SetSection title="默认模型">
        <SetRow
          id="chatModel"
          title="模型"
          desc={picked ? modelCaps(picked) || undefined : undefined}
          control={
            <>
              {catalog?.models.length ? c.select('chatModel', catalog.models.map((m) => ({ value: m.id, label: m.name || m.id })), [], false, '默认模型') : c.text('chatModel', '默认模型', '模型 ID')}
              <Btn size="sm" variant="quiet" disabled={ro || 'svc' in model.draft} disabledReason="先应用模型服务的改动" onClick={fetchCatalog}>
                获取列表
              </Btn>
            </>
          }
        />
        {levels && <SetRow id="think" title="思考强度" control={c.select('think', thinkOptions(levels))} />}
        <SetRow
          id="mtest"
          title="测试连接"
          desc={test ? <span className={test.ok ? styles.ok : styles.att}>{test.text}</span> : undefined}
          control={
            <Btn size="sm" variant="ghost" loading={testing} disabled={ro || drafted} disabledReason="先应用下面的改动" onClick={() => void runTest()}>
              测试
            </Btn>
          }
        />
      </SetSection>

      {svc === 'compatible' && (
        <SetSection title="模型能力">
          {(
            [
              ['ctxWindow', '上下文长度', 16000, 2_000_000, 16000],
              ['maxOut', '最大输出', 1024, 32768, 1024],
            ] as const
          ).map(([id, title, min, max, step]) => (
            <SetRow
              key={id}
              id={id}
              title={title}
              control={
                <Stepper
                  label={title}
                  value={Number(model.value(id) ?? min)}
                  min={min}
                  max={max}
                  step={step}
                  format={tokens}
                  disabled={ro || agentdOff || svcDraft}
                  disabledReason="先应用模型服务的改动"
                  onChange={(n) => model.set(id, n)}
                />
              }
            />
          ))}
          <SetRow id="images" title="图像输入" control={c.toggle('images', '图像输入', svcDraft, '先应用模型服务的改动')} />
          <SetRow id="reasoning" title="思考" control={c.toggle('reasoning', '思考', svcDraft, '先应用模型服务的改动')} />
        </SetSection>
      )}

      <HooksSection />
    </>
  );
}
