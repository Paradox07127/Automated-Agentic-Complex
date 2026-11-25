import { useState } from 'react';
import { Btn, Field } from '../../../ui';
import { failure, saveModels } from '../api';
import { useSettings } from '../ctx';
import { SVC } from '../fields';
import { Masked } from '../kit';
import type { ModelProvider } from '../wire';

/** Whether a provider's key is saved, as the key row's description says it. */
export const keyNote = (saved: boolean) => (saved ? '密钥仅保存于后台服务，不予回显' : '尚未保存');

/**
 * One provider's API key: 已保存 with 替换 and 移除, or a field with 保存. The key goes straight to agentd's model settings for the
 * slot this row shows (for Pi's catalog, the saved catalog provider), never switches the provider in use, and is never read back.
 */
export function ApiKeyControl({ provider, label = 'API Key', disabled, pending }: { provider: ModelProvider; label?: string; disabled?: boolean; pending?: boolean }) {
  const { model, ro, models, reload } = useSettings();
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const saved = models?.backends[provider]?.has_key === true;
  const catalogProvider = models?.backends.pi_catalog?.pi_provider ?? '';
  const slot = provider === 'pi_catalog' ? { provider, pi_provider: catalogProvider } : { provider };
  // The row shows the saved slot and address: a drafted catalog provider or address (`pending`: the card's own) waits for 应用.
  const drafted = pending === true || (provider === 'pi_catalog' && 'piProvider' in model.draft) || (provider === String(model.value('svc') ?? models?.provider) && 'apiBase' in model.draft);
  const fail = (what: string) => (e: unknown) => model.notify({ message: `${what}：${failure(e).text}`, severity: 'danger', persistent: true });

  const save = () => {
    if (key.trim().length < 8) return model.notify({ message: 'API Key 长度过短，未保存', severity: 'warning' });
    void saveModels({ ...slot, api_key: key.trim() }).then(() => {
      setKey('');
      setReplacing(false);
      reload('models');
      model.notify({ message: 'API Key 已保存', severity: 'success' });
    }, fail('未能保存 API Key'));
  };
  const remove = () =>
    model.ask({
      title: `确认移除 ${(provider === 'pi_catalog' && catalogProvider) || (SVC.find((o) => o.value === provider)?.label ?? provider)} 的 API Key？`,
      danger: true,
      warning: '此操作将立即删除密钥且不可撤销',
      note: '使用该密钥的执行内核将停止工作，直至重新配置。',
      confirmLabel: '移除',
      onConfirm: () =>
        saveModels({ ...slot, clear_key: true }).then(() => {
          reload('models');
          model.notify({ message: '已移除 API Key' });
        }, fail('未能移除 API Key')),
    });

  return saved && !replacing ? (
    <>
      <Masked>已保存</Masked>
      <Btn disabled={ro || drafted} disabledReason="请先点击底部「应用」保存上方更改" onClick={() => setReplacing(true)}>
        替换
      </Btn>
      <Btn variant="danger" disabled={ro || drafted} disabledReason="请先点击底部「应用」保存上方更改" onClick={remove}>
        移除
      </Btn>
    </>
  ) : (
    <>
      <Field type="password" label={label} placeholder={saved ? '输入新 Key 以替换' : '粘贴 API Key'} value={key} disabled={ro || disabled || drafted} onChange={setKey} />
      <Btn disabled={ro || !key || drafted} disabledReason={drafted ? '请先点击底部「应用」保存上方更改' : undefined} onClick={save}>
        保存
      </Btn>
    </>
  );
}
