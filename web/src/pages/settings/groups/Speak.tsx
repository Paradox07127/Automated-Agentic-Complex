import { useEffect, useRef, useState } from 'react';
import { getBridge } from '../../../bridge';
import { AgentdCallError, resetVoice, saveVoiceToken, testVoice } from '../../../bridge/agentd';
import { hotkeyText } from '../../../bridge/platformText';
import { voiceSource, voiceState, voiceText, type Voice, type VoiceState } from '../../../domain/voiceState';
import { useCountdown } from '../../../features/approval/useCountdown';
import { failure, readMutes, saveMutes } from '../api';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import type { DiagView } from '../diag';
import { REPLY_LANGUAGE } from '../fields';
import { groupDesc } from '../groups';
import { Cap, Chip, Dis, Field, Lnk, Seg, St, type StTone } from '../kit';
import { optionsOf } from '../native';
import { labelOf, useRowShown } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import { Slab } from '../Slab';
import { MUTED_KIND } from './GateBlocked';
import { QuietHoursRow, useProactiveSettings } from './SpeakCompanion';
import { SILENT_LEVEL, SpeakWhenRow } from './SpeakWhen';
import styles from '../groups.module.css';

const NOTIFY: Array<[id: string, label: string, note: string]> = [
  ['n_done', '完成', '任务做完'],
  ['n_appr', '待批准', '只作用于审批卡'],
  ['n_err', '出错', '任务失败'],
  ['n_brief', '简短播报', '进度一句话'],
  ['n_remind', '提醒', '你设的提醒'],
];

const VOICE_TONE: Record<VoiceState, StTone> = { ready: 'ok', unknown: 'off', probing: 'warn', cold: 'warn', unreachable: 'bad', off: 'off' };

/** POST /voice/test `reason` → what the test row says. */
function voiceTestFailure(reason: string | null): string {
  const status = /^http_(\d+)$/.exec(reason ?? '')?.[1];
  if (reason === 'http_401') return '令牌不对';
  if (status) return `服务返回 ${status}`;
  const text: Record<string, string> = { invalid_url: '地址不可用：要以 http:// 或 https:// 开头', unreachable: '连不上', bad_stream: '返回的不是语音流', timeout: '超时' };
  return text[reason ?? ''] ?? '没有通过';
}

/** 说话: voice and its self-hosted service, when she speaks up, how things reach you. */
export function SpeakGroup() {
  const { model, ro: groupRo, agentdOff, diag, native } = useSettings();
  const shown = useRowShown();
  // The proactive rows write to agentd.
  const ro = groupRo || agentdOff;
  const c = useControls();
  const bridge = getBridge();
  const ps = useProactiveSettings();

  // A reset's state holds until the next /diag/state read replaces diag.voice.
  const [reset, setReset] = useState<{ from: Voice | null; voice: Voice; source: DiagView['voiceSource'] } | null>(null);
  const resetLive = reset && reset.from === diag.voice;
  const voice = resetLive ? reset.voice : diag.voice;
  const source = resetLive ? reset.source : diag.voiceSource;
  const sourceLabel = source && voiceSource(source.provider);
  const retryLeft = useCountdown(voice?.retryAfterS ?? null);
  const reconnect = () => {
    const from = diag.voice;
    setReset({ from, voice: { state: 'probing', retryAfterS: null }, source: diag.voiceSource });
    void resetVoice().then(
      (r) => setReset({ from, voice: voiceState(r.tts), source: r.tts }),
      (e) => {
        setReset(null);
        model.notify({ message: `没能重新连接语音：${failure(e).text}`, severity: 'danger', persistent: true });
      },
    );
  };
  const local = model.value('tts') === 'local';
  const remote = model.value('tts') === 'remote';
  const down = !local && voice?.state === 'unreachable';
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
    const url = String(model.value('ttsUrl') ?? '').trim();
    try {
      const r = await testVoice({ ...(url ? { url } : {}), ...(t ? { token: t } : {}) });
      setTest({ ok: r.ok, text: r.ok ? `通过 │ 首声 ${r.first_audio_ms} ms` : voiceTestFailure(r.reason) });
    } catch (e) {
      setTest({ ok: false, text: e instanceof AgentdCallError && e.code === 'no_tts' ? '语音没有启用' : failure(e).text });
    }
    setTesting(false);
  };
  const ttsOpts = optionsOf(native?.rows.tts).map((o) => ({ ...o, label: o.value === 'local' ? '关闭' : o.value === 'remote' ? '外部服务' : o.label }));
  const levels = optionsOf(native?.rows.proactive).filter((o) => o.value !== SILENT_LEVEL);
  // agentd mutes live on a spoken「静音」; this row is config.json, which it reads at start.
  const muteNote = diag.muted == null || diag.muted === (model.value('mute') === true) ? null : diag.muted ? '重启后台服务后按这里的设置出声' : '后台现在仍会出声；重启后台服务后生效';
  const mute = model.value('mute');

  const voiceDesc = local ? (
    '不发声，只显示文字'
  ) : (
    <>
      {voice && <St tone={VOICE_TONE[voice.state]}>{voiceText(voice.state, retryLeft)}</St>} <span>{down ? '这段时间只显示文字' : `${sourceLabel ? `${sourceLabel} │ ` : ''}自己部署的语音服务，app 只连接`}</span>
    </>
  );

  return (
    <>
      <SetSection title="声音" info={groupDesc('speak')}>
        <SetRow
          id="mute"
          title={labelOf('mute')}
          desc={muteNote ?? '只显示文字时照样回答，只是不念'}
          descTone={muteNote ? 'attention' : undefined}
          info="把她的回答和主动发言念出来，要下面的语音服务在线。"
          control={
            <>
              {diag.muted && <St tone="warn">后台现在静音</St>}
              <Seg
                label={labelOf('mute')}
                value={typeof mute === 'boolean' ? String(mute) : ''}
                options={[
                  { value: 'false', label: '念出来' },
                  { value: 'true', label: '只显示文字' },
                ]}
                disabled={groupRo}
                onChange={(v) => model.set('mute', v === 'true')}
              />
            </>
          }
        />
        {diag.voiceNone && !local ? (
          <SetRow id="tts" title="语音不可用" desc="台词只显示文字" control={null} />
        ) : (
          <SetRow
            id="tts"
            title={labelOf('tts')}
            desc={voiceDesc}
            descTone={down ? 'bad' : undefined}
            info="把台词合成语音。要你自己部署的语音服务地址和令牌；app 不打包模型，只用你的服务。"
            control={
              <>
                {(voice?.state === 'unreachable' || voice?.state === 'cold') && (
                  <Cap disabled={agentdOff} disabledReason="后台服务没有运行" onClick={reconnect}>
                    重新连接
                  </Cap>
                )}
                <Seg label={labelOf('tts')} value={String(model.value('tts') ?? '')} options={ttsOpts} disabled={groupRo} onChange={(v) => model.set('tts', v)} />
              </>
            }
          />
        )}
        {remote && (
          <>
            <SetRow id="ttsUrl" title={labelOf('ttsUrl')} indent control={c.text('ttsUrl', labelOf('ttsUrl'), 'http://主机:端口')} />
            <SetRow
              id="ttsToken"
              title="令牌"
              desc={tokenCleared ? '未设置：服务地址换了，旧服务的令牌已删除' : undefined}
              descTone={tokenCleared ? 'attention' : undefined}
              info="令牌只送给后台，不回显；换服务地址会删掉旧令牌。"
              indent
              control={
                <>
                  <Field type="password" aria-label="令牌" placeholder="粘贴令牌" value={token} disabled={agentdOff} onChange={(e) => setToken(e.currentTarget.value)} />
                  <Cap disabled={agentdOff || !token.trim()} onClick={saveToken}>
                    保存
                  </Cap>
                </>
              }
            />
            <SetRow
              id="ttsTest"
              title="测试连接"
              indent
              control={
                <>
                  {test && <St tone={test.ok ? 'ok' : 'bad'}>{test.text}</St>}
                  <Cap loading={testing} disabled={agentdOff} disabledReason="后台服务没有运行" onClick={() => void runTest()}>
                    测试
                  </Cap>
                </>
              }
            />
            {([['ttsTunnelHost', '留空就不建隧道', 'ssh 主机名（可留空）'], ['ttsEnsureScript', '留空就不按需启动', '远程主机上的绝对路径（可留空）']] as const).map(([id, desc, hint]) => (
              <SetRow key={id} id={id} title={labelOf(id)} desc={desc} indent control={c.text(id, labelOf(id), hint)} />
            ))}
          </>
        )}
        <SetRow id="asr" title={labelOf('asr')} desc="按住说话时用" control={c.seg('asr')} />
        <SetRow id="replyLang" title={labelOf('replyLang')} control={c.select('replyLang', REPLY_LANGUAGE)} />
      </SetSection>

      <SetSection title="主动开口">
        <SpeakWhenRow
          ps={ps}
          disabled={ro}
          asked={<SetRow id="proactive" title={labelOf('proactive')} indent control={<Dis>只在你问时她不会主动</Dis>} />}
        >
          <SetRow id="proactive" title={labelOf('proactive')} desc="主动发言和动作的频率" indent control={c.select('proactive', levels, ['active'])} />
          <QuietHoursRow ps={ps} disabled={ro} />
        </SpeakWhenRow>
        <MutedRow disabled={ro} />
        <SetRow id="rest" title={labelOf('rest')} desc="连续用电脑到这个时长后提醒" control={c.select('rest')} />
        {native?.rows.water && <SetRow id="water" title={labelOf('water')} desc="在你停顿时提醒" control={c.select('water')} />}
      </SetSection>

      <SetSection title="事情怎么告诉你">
        <Slab id="n_done" label="提醒方式">
          <div className={styles.mx} role="table" aria-label="提醒方式">
            <span role="row" className={styles.mxHead}>
              <span role="columnheader" />
              {['出声', '只出卡', '不提示'].map((h) => (
                <span key={h} role="columnheader">
                  {h}
                </span>
              ))}
            </span>
            {NOTIFY.filter(([id]) => shown(id)).map(([id, label, note]) => (
              <span key={id} role="row" id={id === 'n_done' ? undefined : `set-${id}`} className={styles.mxRow} data-row={id}>
                <span role="rowheader" className={styles.mxK}>
                  {label}
                  <small>{note}</small>
                </span>
                <span role="cell" className={styles.mxSeg}>
                  {c.seg(id, undefined, false, label)}
                </span>
              </span>
            ))}
          </div>
        </Slab>
        <SetRow id="sysnotify" title={labelOf('sysnotify')} desc="角色隐藏或前台全屏时生效" control={c.toggle('sysnotify')} />
        <SetRow id="capHide" title={labelOf('capHide')} desc={hotkeyText('开始录屏或共享屏幕时隐藏一次，按 ⌃⌥H 显示')} control={c.toggle('capHide', labelOf('capHide'))} />
        <SetRow
          id="testcard"
          title={labelOf('testcard')}
          desc="在角色旁显示一张通知卡，检查位置和声音"
          control={
            <>
              <Cap onClick={() => void testCard('test_approval_card', '测试审批卡')}>测试审批卡</Cap>
              <Cap onClick={() => void testCard('test_announcement', '测试播报')}>测试播报</Cap>
            </>
          }
        />
      </SetSection>
    </>
  );
  async function testCard(action: 'test_approval_card' | 'test_announcement', what: string) {
    try {
      await bridge.app.action(action);
      model.notify({ message: `${what}已显示，看看角色身边` });
    } catch (e) {
      const detail = (e as { detail?: string } | null)?.detail;
      model.notify({ message: detail || `没有显示${what}，请先显示角色`, severity: 'warning' });
    }
  }
}

/** Proactive kinds turned off with the bubble's 关闭此类 (GET /proactive/mutes), each a chip with 恢复; absent while none is. */
function MutedRow({ disabled }: { disabled: boolean }) {
  const { model } = useSettings();
  const [muted, setMuted] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    readMutes().then(
      (r) => live && setMuted(r.muted),
      () => {}, // stays 未读到
    );
    return () => {
      live = false;
    };
  }, []);
  const restore = (kind: string, label: string) =>
    void saveMutes((muted ?? []).filter((k) => k !== kind)).then(
      (r) => setMuted(r.muted),
      (e) => model.notify({ message: `没能恢复「${label}」：${failure(e).text}`, severity: 'danger', persistent: true }),
    );
  if (muted?.length === 0) return null;
  return (
    <SetRow
      id="mutes"
      title={labelOf('mutes')}
      desc="在气泡「更多操作」里点「关闭此类」加进来"
      wrap
      control={
        muted == null ? (
          <span className={styles.t3} title="已关掉的主动发言：还没读到后台的状态">
            未读到
          </span>
        ) : (
          muted.map((kind) => {
            const label = MUTED_KIND[kind] ?? kind;
            return (
              <span key={kind} role="group" aria-label={label}>
                <Chip>
                  {label}
                  {!disabled && <Lnk onClick={() => restore(kind, label)}>恢复</Lnk>}
                </Chip>
              </span>
            );
          })
        )
      }
    />
  );
}
