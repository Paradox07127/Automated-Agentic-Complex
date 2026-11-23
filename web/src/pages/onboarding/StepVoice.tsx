import { useState } from 'react';
import { getBridge, type CharacterEntry } from '../../bridge';
import { AgentdCallError, saveVoiceToken, testVoice } from '../../bridge/agentd';
import { hotkeyText } from '../../bridge/platformText';
import { voiceText, type VoiceState } from '../../domain/voiceState';
import { failure } from '../settings/api';
import { useControls } from '../settings/controls';
import { useSettings } from '../settings/ctx';
import { capsOf } from '../settings/groups/Keys';
import { Cap, Dis, Field, KeyCell, Seg, St, type StTone } from '../settings/kit';
import type { PermRow } from '../settings/perms';
import { labelOf } from '../settings/registry';
import { SetRow } from '../settings/SetRow';
import { SetSection } from '../settings/SetSection';
import band from '../settings/band.module.css';
import { GUIDE_PERMS, type GuideSettings } from './useGuideSettings';
import { Frame } from './Steps';

const VOICE_TONE: Record<VoiceState, StTone> = { ready: 'ok', unknown: 'off', probing: 'warn', cold: 'warn', unreachable: 'bad', off: 'off' };

/** POST /voice/test `reason` → what the test row says. */
function voiceTestFailure(reason: string | null): string {
  const status = /^http_(\d+)$/.exec(reason ?? '')?.[1];
  if (reason === 'http_401') return '令牌不对';
  if (status) return `服务返回 ${status}`;
  const text: Record<string, string> = { invalid_url: '地址不可用：要以 http:// 或 https:// 开头', unreachable: '连不上', bad_stream: '返回的不是语音流', timeout: '超时' };
  return text[reason ?? ''] ?? '没有通过';
}

/** 她的声音: 出声 and the self-hosted service with its address, token and test; a character without a voice says so instead. */
function HerVoice({ her }: { her: CharacterEntry | null }) {
  const { model, agentdOff, diag } = useSettings();
  const c = useControls();
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState('');
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  if (her && !her.voice)
    return <SetRow id="tts" title="她念出回答" desc="没有声线的角色不出声，也不换成系统朗读" control={<Dis>{`${her.name}没有声线，只显示文字`}</Dis>} />;
  const remote = model.value('tts') === 'remote';
  const voice = diag.voice;
  const saveToken = () =>
    void saveVoiceToken(token.trim()).then(
      () => {
        setSaved(token.trim());
        setToken('');
        model.notify({ message: '令牌已保存', severity: 'success' });
      },
      (e: unknown) => model.notify({ message: `没能保存令牌：${failure(e).text}`, severity: 'danger', persistent: true }),
    );
  const runTest = async () => {
    setTesting(true);
    const t = token.trim() || saved;
    const url = String(model.value('ttsUrl') ?? '').trim();
    try {
      const r = await testVoice({ ...(url ? { url } : {}), ...(t ? { token: t } : {}) });
      setTest({ ok: r.ok, text: r.ok ? `通过 │ 首声 ${r.first_audio_ms} ms` : voiceTestFailure(r.reason) });
    } catch (e) {
      setTest({ ok: false, text: e instanceof AgentdCallError && e.code === 'no_tts' ? '语音没有启用' : failure(e).text });
    }
    setTesting(false);
  };
  const mute = model.value('mute');
  return (
    <>
      <SetRow
        id="mute"
        title={labelOf('mute')}
        desc="只显示文字时照样回答，只是不念"
        control={
          <Seg
            label={labelOf('mute')}
            value={typeof mute === 'boolean' ? String(mute) : ''}
            options={[
              { value: 'false', label: '念出来' },
              { value: 'true', label: '只显示文字' },
            ]}
            onChange={(v) => model.set('mute', v === 'true')}
          />
        }
      />
      <SetRow
        id="tts"
        title={labelOf('tts')}
        desc={
          remote ? (
            <>
              {voice && <St tone={VOICE_TONE[voice.state]}>{voiceText(voice.state, null)}</St>} <span>自己部署的语音服务，app 只连接</span>
            </>
          ) : (
            '不发声，只显示文字'
          )
        }
        info="把台词合成语音。要你自己部署的语音服务地址和令牌；app 不打包模型，只用你的服务。"
        control={
          <Seg
            label={labelOf('tts')}
            value={String(model.value('tts') ?? '')}
            options={[
              { value: 'remote', label: '外部服务' },
              { value: 'local', label: '关闭' },
            ]}
            onChange={(v) => model.set('tts', v)}
          />
        }
      />
      {remote && (
        <>
          <SetRow id="ttsUrl" title={labelOf('ttsUrl')} indent control={c.text('ttsUrl', labelOf('ttsUrl'), 'http://主机:端口')} />
          <SetRow
            id="ttsToken"
            title="令牌"
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
        </>
      )}
    </>
  );
}

const PERM_STATE: Record<PermRow['state'], [StTone, string]> = {
  granted: ['ok', '已允许'],
  denied: ['bad', '没允许'],
  notDetermined: ['warn', '还没问过'],
  unsupported: ['off', '这个平台没有'],
  loading: ['off', '读取中'],
  unread: ['off', '未读到'],
};

/** 你的声音: 按住说话's key and the permissions it needs, asked here only. */
function YourVoice() {
  const { model, caps, perms, recheckPerms, ro } = useSettings();
  const bridge = getBridge();
  const [recording, setRecording] = useState(false);
  const label = labelOf('hk_ptt');
  const combo = String(model.value('hk_ptt') ?? '');
  const record = async () => {
    setRecording(true);
    try {
      const next = await bridge.settings.recordHotkey('hk_ptt');
      if (!next) return model.notify({ message: `没有录到新的按键，「${label}」保持不变` });
      const r = await bridge.settings.validateHotkey('hk_ptt', next);
      if (!r.ok) return model.notify({ message: `${hotkeyText(next)} 已被「${r.conflictWith}」占用，「${label}」保持不变`, severity: 'warning', persistent: true });
      model.set('hk_ptt', next);
    } catch {
      model.notify({ message: `无法录制「${label}」的快捷键，请重试`, severity: 'warning', persistent: true });
    } finally {
      setRecording(false);
    }
  };
  const openSettings = async (p: PermRow) => {
    try {
      await bridge.permissions.openSettings(p.kind);
      model.notify({ message: `已打开系统设置 › ${p.label} │ 允许后回到这里，会自动重新检测`, persistent: true });
    } catch {
      model.notify({ message: `没能打开系统设置。请手动检查「${p.label}」。`, severity: 'danger', persistent: true });
    }
  };
  const recheck = async (p: PermRow) => {
    const s = await recheckPerms(p.kind);
    if (s === 'granted') model.notify({ message: `${p.label}：已允许，${p.features.join('、')}可以用了`, severity: 'success' });
    else model.notify({ message: `${p.label}：${s ? `仍${PERM_STATE[s][1]}` : '没读到权限状态'}`, severity: 'warning', persistent: true });
  };
  const ask = async (p: PermRow) => {
    let s;
    try {
      s = await bridge.permissions.request(p.kind);
    } catch {
      return model.notify({ message: `${p.label}：这个外壳还不能弹出系统询问，请去系统设置里打开`, severity: 'warning', persistent: true });
    }
    await recheckPerms(p.kind);
    if (s === 'granted') model.notify({ message: `${p.label}：已允许，${p.features.join('、')}可以用了`, severity: 'success' });
    else model.notify({ message: `${p.label}：没有允许，可以去系统设置里打开`, severity: 'warning', persistent: true });
  };
  return (
    <>
      <SetRow
        id="hk_ptt"
        title={label}
        desc={`只有这一项能单用${hotkeyText('右⌥')}`}
        control={
          <>
            <KeyCell keys={combo ? capsOf(hotkeyText(combo)) : undefined} none={combo === ''} recording={recording} />
            <Cap loading={recording} disabled={ro || !caps.hotkeys} disabledReason="这个平台不支持全局热键" onClick={() => void record()}>
              更改
            </Cap>
          </>
        }
      />
      {perms
        .filter((p) => GUIDE_PERMS.includes(p.kind) && p.state !== 'unsupported')
        .map((p) => {
          const [tone, text] = PERM_STATE[p.state];
          const known = p.state !== 'loading' && p.state !== 'unread';
          return (
            <SetRow
              key={p.kind}
              id={p.kind}
              title={p.label}
              indent
              desc={p.state === 'denied' ? `没允许：${p.features.join('、')}用不了，其余照常` : `用于 ${p.features.join('、')}`}
              descTone={p.state === 'denied' ? 'bad' : undefined}
              info={p.purpose}
              control={
                <>
                  <St tone={tone}>{text}</St>
                  {p.state === 'notDetermined' && <Cap onClick={() => void ask(p)}>允许</Cap>}
                  {known && p.state !== 'granted' && (
                    <Cap go disabled={!caps.systemSettings} disabledReason="这个平台不能从这里打开系统设置，请手动打开系统的隐私设置" onClick={() => void openSettings(p)}>
                      去系统设置
                    </Cap>
                  )}
                  {p.state !== 'granted' && p.state !== 'loading' && <Cap onClick={() => void recheck(p)}>重新检测</Cap>}
                </>
              }
            />
          );
        })}
    </>
  );
}

/** 03 声音: her voice and yours; the whole step folds while 和她对话 is off. */
export function StepVoice({ g, her }: { g: GuideSettings; her: CharacterEntry | null }) {
  const windows = getBridge().platform === 'windows';
  return (
    <Frame n={3}>
      {g.talks ? (
        <>
          <SetSection title="她的声音">
            <HerVoice her={her} />
          </SetSection>
          <SetSection title="你的声音" right={windows ? '这个系统只有麦克风一项权限' : undefined}>
            <YourVoice />
          </SetSection>
        </>
      ) : (
        <SetSection title="她的声音">
          <div className={band.fold}>对话关着 │ 打开后可以设：她念出回答、按住说话</div>
        </SetSection>
      )}
    </Frame>
  );
}

/** Drawn figure for the desk when her package has no portrait. */
