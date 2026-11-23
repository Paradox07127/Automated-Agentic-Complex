import { useState } from 'react';
import { Btn, Field } from '../../../ui';
import { failure, saveModels } from '../api';
import { useSettings } from '../ctx';
import { SVC } from '../fields';
import { Masked } from '../kit';
import type { ModelProvider } from '../wire';

/** Whether a provider's key is saved, as the key row's description says it. */
export const keyNote = (saved: boolean) => (saved ? '只送给后台，不回显' : '还没有保存');

/**
 * One provider's API key: 已保存 with 替换 and 移除, or a field with 保存. The key goes straight to agentd's model settings for that
 * provider and is never read back.
 */
export function ApiKeyControl({ provider, label = 'API Key', disabled }: { provider: ModelProvider; label?: string; disabled?: boolean }) {
  const { model, ro, models, reload } = useSettings();
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const saved = models?.backends[provider]?.has_key === true;
  const fail = (what: string) => (e: unknown) => model.notify({ message: `${what}：${failure(e).text}`, severity: 'danger', persistent: true });

  const save = () => {
    if (key.trim().length < 8) return model.notify({ message: 'API Key 太短，没有保存', severity: 'warning' });
    void saveModels({ provider, api_key: key.trim() }).then(() => {
      setKey('');
      setReplacing(false);
      reload('models');
      model.notify({ message: 'API Key 已保存', severity: 'success' });
    }, fail('没有保存 API Key'));
  };
  const remove = () =>
    model.ask({
      title: `移除 ${SVC.find((o) => o.value === provider)?.label ?? provider} 的 API Key？`,
      danger: true,
      warning: '立即删除，不能撤销',
      note: '用这个 Key 的内核会停止工作，直到你重新填写。',
      confirmLabel: '移除',
      onConfirm: () =>
        saveModels({ provider, clear_key: true }).then(() => {
          reload('models');
          model.notify({ message: '已移除 API Key' });
        }, fail('没能移除 API Key')),
    });

  return saved && !replacing ? (
    <>
      <Masked>已保存</Masked>
      <Btn disabled={ro} onClick={() => setReplacing(true)}>
        替换
      </Btn>
      <Btn variant="danger" disabled={ro} onClick={remove}>
        移除
      </Btn>
    </>
  ) : (
    <>
      <Field type="password" label={label} placeholder={saved ? '输入新 Key 替换' : '粘贴 API Key'} value={key} disabled={ro || disabled} onChange={setKey} />
      <Btn disabled={ro || !key} onClick={save}>
        保存
      </Btn>
    </>
  );
}
