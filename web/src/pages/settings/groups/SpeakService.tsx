import { useEffect, useRef, useState } from 'react';
import { AgentdCallError, saveVoiceToken, testVoice } from '../../../bridge/agentd';
import { Btn, Fold } from '../../../ui';
import { ExpandRow } from '../../../ui/game';
import { failure } from '../api';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { Field, St } from '../kit';
import { labelOf, useRowShown } from '../registry';
import { SetRow } from '../SetRow';
import styles from '../groups.module.css';

/** POST /voice/test `reason` → what the test row says. */
function voiceTestFailure(reason: string | null): string {
  const status = /^http_(\d+)$/.exec(reason ?? '')?.[1];
  if (reason === 'http_401') return '令牌不对';
  if (status) return `服务返回 ${status}`;
  const text: Record<string, string> = { invalid_url: '地址不可用：要以 http:// 或 https:// 开头', unreachable: '连不上', bad_stream: '返回的不是语音流', timeout: '超时' };
  return text[reason ?? ''] ?? '没有通过';
}

const ADVANCED = [
  ['ttsTunnelHost', '留空就不建隧道', 'ssh 主机名（可留空）'],
  ['ttsEnsureScript', '留空就不按需启动', '远程主机上的绝对路径（可留空）'],
] as const;
const ROWS: ReadonlySet<string> = new Set(['ttsUrl', 'ttsToken', 'ttsTest', ...ADVANCED.map(([id]) => id)]);

/**
 * The external voice service under 语音服务: one expandable row with its address and token as the summary, holding the address,
 * token and test rows and the developer rows folded in 高级. Shut while the service answers; open while it is down, has no address,
 * lost its token, or a search lands on one of its rows. Mounted while the source is local too, so a saved token outlives a flip.
 */
export function VoiceService({ remote, down }: { remote: boolean; down: boolean }) {
  const { model, agentdOff, item, hl } = useSettings();
  const c = useControls();
  const shown = useRowShown();
  // The token is sent to agentd and never read back.
  const [token, setToken] = useState('');
  // agentd sends its stored token only to the address it runs with; a test of a new address needs the token from here.
  const savedToken = useRef('');
  // A save of 服务地址 for another service deleted the stored token: none is set until one is saved again.
  const [tokenCleared, setTokenCleared] = useState(false);
  useEffect(() => {
    if (model.ttsTokenClears === 0) return;
    savedToken.current = '';
    setTokenCleared(true);
  }, [model.ttsTokenClears]);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const saved = model.value('ttsUrl');
  const url = String(saved ?? '').trim();
  const linked = [item, hl].some((x) => x != null && ROWS.has(x));
  // An address still unread is not a missing one.
  const needs = down || (saved != null && !url) || tokenCleared || linked;
  const [open, setOpen] = useState(needs);
  const [wasNeeds, setWasNeeds] = useState(needs);
  if (wasNeeds !== needs) {
    setWasNeeds(needs);
    if (needs) setOpen(true);
  }
  if (!remote) return null;

  const saveToken = () =>
    void saveVoiceToken(token.trim()).then(
      () => {
        savedToken.current = token.trim();
        setToken('');
        setTokenCleared(false);
        model.notify({ message: '令牌已保存', severity: 'success' });
      },
      (e) => model.notify({ message: `没能保存令牌：${failure(e).text}`, severity: 'danger', persistent: true }),
    );
  const runTest = async () => {
    setTesting(true);
    const t = token.trim() || savedToken.current;
    try {
      const r = await testVoice({ ...(url ? { url } : {}), ...(t ? { token: t } : {}) });
      setTest({ ok: r.ok, text: r.ok ? `通过 │ 首声 ${r.first_audio_ms} ms` : voiceTestFailure(r.reason) });
    } catch (e) {
      setTest({ ok: false, text: e instanceof AgentdCallError && e.code === 'no_tts' ? '语音没有启用' : failure(e).text });
    }
    setTesting(false);
  };
  const tokenNote = tokenCleared ? '令牌未设置' : savedToken.current ? '令牌已保存' : '令牌不回显';
  const advanced = ADVANCED.filter(([id]) => shown(id));

  const body = (
    <>
      <SetRow id="ttsUrl" title={labelOf('ttsUrl')} control={c.text('ttsUrl', labelOf('ttsUrl'), 'http://主机:端口')} />
      <SetRow
        id="ttsToken"
        title="令牌"
        desc={tokenCleared ? '未设置：服务地址换了，旧服务的令牌已删除' : undefined}
        descTone={tokenCleared ? 'attention' : undefined}
        info="令牌只送给后台，不回显；换服务地址会删掉旧令牌。"
        control={
          <>
            <Field type="password" aria-label="令牌" placeholder="粘贴令牌" value={token} disabled={agentdOff} onChange={(e) => setToken(e.currentTarget.value)} />
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
            {test && <St tone={test.ok ? 'ok' : 'bad'}>{test.text}</St>}
            <Btn loading={testing} disabled={agentdOff} disabledReason="后台服务没有运行" onClick={() => void runTest()}>
              测试
            </Btn>
          </>
        }
      />
      {advanced.length > 0 && (
        <Fold id="speak.tts.advanced" label="高级" count={advanced.length} summary="SSH 转发、按需启动" autoOpen={[item, hl].some((x) => advanced.some(([id]) => id === x))}>
          {advanced.map(([id, desc, hint]) => (
            <SetRow key={id} id={id} title={labelOf(id)} desc={desc} control={c.text(id, labelOf(id), hint)} />
          ))}
        </Fold>
      )}
    </>
  );
  return (
    <div className={styles.sub}>
      <ExpandRow open={open} onToggle={setOpen} tone={down ? 'fail' : undefined} body={body}>
        <span>服务地址、令牌和测试</span>
        <span className={styles.t3}>{[url || '还没填地址', tokenNote, test?.text].filter(Boolean).join(' │ ')}</span>
      </ExpandRow>
    </div>
  );
}
