import { useEffect, useState } from 'react';
import { Btn, Field } from '../../../ui';
import { StatusLamp } from '../../../ui/game';
import { failure, readMotion, saveMotion, testModels, type MotionSource } from '../api';
import { useSettings } from '../ctx';
import { modelTestText } from '../fields';
import { Masked } from '../kit';
import { SetRow } from '../SetRow';
import { ApiKeyControl, keyNote } from './ApiKey';

/** The motion service card's token (GET/PUT /motion/settings), sent once and never read back. */
export function MotionTokenRow() {
  const { model, agentdOff } = useSettings();
  const [src, setSrc] = useState<MotionSource | null>(null);
  const [token, setToken] = useState('');
  useEffect(() => {
    let live = true;
    readMotion().then(
      (r) => live && setSrc(r),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [agentdOff]);
  const save = (body: { token: string }, done: string, what: string) =>
    src &&
    void saveMotion({ backend: src.backend, ...body }).then(
      (r) => {
        setSrc(r);
        setToken('');
        model.notify({ message: done, severity: 'success' });
      },
      (e) => model.notify({ message: `${what}：${failure(e).text}`, severity: 'danger', persistent: true }),
    );
  const off = agentdOff || src == null;
  return (
    <SetRow
      id="motionToken"
      title="令牌"
      desc={src == null ? '还没读到后台的设置' : '令牌只送给后台，不回显；换地址后要重新保存'}
      control={
        <>
          {src?.token_set && !token ? <Masked>已保存</Masked> : <Field type="password" label="动作服务令牌" placeholder="粘贴令牌" value={token} disabled={off} onChange={setToken} />}
          {src?.token_set && !token ? (
            <Btn disabled={off} onClick={() => save({ token: '' }, '已删除动作服务令牌', '没能删除令牌')}>
              移除
            </Btn>
          ) : (
            <Btn disabled={off || !token.trim()} onClick={() => save({ token: token.trim() }, '令牌已保存', '没能保存令牌')}>
              保存
            </Btn>
          )}
        </>
      }
    />
  );
}

/** The compatible API card's key (agentd's `compatible` connection) and a test, which runs Pi's own connection: only while Pi uses it. */
export function LlmSecretRows({ pending }: { pending: boolean }) {
  const { model, ro, agentdOff, models } = useSettings();
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const inUse = model.vals.kernel === 'pi' && models?.provider === 'compatible';
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
      <SetRow
        id="svc_llm_key"
        title="API Key"
        desc={keyNote(models?.backends.compatible?.has_key === true)}
        control={<ApiKeyControl provider="compatible" label="自建模型接口 API Key" />}
      />
      <SetRow
        id="svc_llm_test"
        title="测试连接"
        desc={inUse ? (pending ? '先应用上面的改动再测' : undefined) : '要 AI 的内核是 Pi、模型提供方选「兼容 API」才能测'}
        control={
          <>
            {test && <StatusLamp size="sm" state={test.ok ? 'ok' : 'broken'} label={test.text} />}
            <Btn loading={testing} disabled={ro || agentdOff || !inUse || pending} disabledReason={inUse ? '先应用上面的改动' : 'Pi 没在用这个接口'} onClick={() => void runTest()}>
              测试
            </Btn>
          </>
        }
      />
    </>
  );
}
