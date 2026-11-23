import { useState } from 'react';
import { AgentdCallError, saveVoiceToken, testVoice } from '../../../bridge/agentd';
import { Btn, Field } from '../../../ui';
import { StatusLamp } from '../../../ui/game';
import { failure } from '../api';
import { useSettings } from '../ctx';
import { SetRow } from '../SetRow';

/** POST /voice/test `reason` → what the test row says. */
function voiceTestFailure(reason: string | null): string {
  const status = /^http_(\d+)$/.exec(reason ?? '')?.[1];
  if (reason === 'http_401') return '令牌不对';
  if (status) return `服务返回 ${status}`;
  const text: Record<string, string> = { invalid_url: '地址不可用：要以 http:// 或 https:// 开头', unreachable: '连不上', bad_stream: '返回的不是语音流', timeout: '超时' };
  return text[reason ?? ''] ?? '没有通过';
}

/** The voice service card's token and test: the token goes to agentd and is never read back; the test may try the one on screen. */
export function TtsSecretRows() {
  const { model, agentdOff, diag, reload } = useSettings();
  const [token, setToken] = useState('');
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const saveToken = () =>
    void saveVoiceToken(token.trim()).then(
      () => {
        setToken('');
        reload('diag');
        model.notify({ message: '令牌已保存', severity: 'success' });
      },
      (e) => model.notify({ message: `没能保存令牌：${failure(e).text}`, severity: 'danger', persistent: true }),
    );
  const runTest = async () => {
    setTesting(true);
    const t = token.trim();
    try {
      const r = await testVoice(t ? { token: t } : {});
      setTest({ ok: r.ok, text: r.ok ? `通过 │ 首声 ${r.first_audio_ms} ms` : voiceTestFailure(r.reason) });
    } catch (e) {
      setTest({ ok: false, text: e instanceof AgentdCallError && e.code === 'no_tts' ? '语音没有启用' : failure(e).text });
    }
    setTesting(false);
  };

  return (
    <>
      <SetRow
        id="ttsToken"
        title="令牌"
        desc={diag.voiceTokenSet ? '令牌已保存' : '令牌不回显'}
        info="令牌只送给后台，不回显；在这张卡上换语音服务地址会删掉旧令牌。"
        control={
          <>
            <Field type="password" label="令牌" placeholder="粘贴令牌" value={token} disabled={agentdOff} onChange={setToken} />
            <Btn disabled={agentdOff || !token.trim()} onClick={saveToken}>
              保存
            </Btn>
          </>
        }
      />
      <SetRow
        id="ttsTest"
        title="测试连接"
        control={
          <>
            {test && <StatusLamp size="sm" state={test.ok ? 'ok' : 'broken'} label={test.text} />}
            <Btn loading={testing} disabled={agentdOff} disabledReason="后台服务没有运行" onClick={() => void runTest()}>
              测试
            </Btn>
          </>
        }
      />
    </>
  );
}
