import { useEffect, useState, type ReactNode } from 'react';
import { getBridge } from '../../../bridge';
import { resetVoice } from '../../../bridge/agentd';
import type { VisualStateKey } from '../../../domain/states';
import { voiceSource, voiceState, voiceText, type Voice, type VoiceState } from '../../../domain/voiceState';
import { useCountdown } from '../../../features/approval/useCountdown';
import { failure, readMutes, saveMutes } from '../api';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import type { DiagView } from '../diag';
import { REPLY_LANGUAGE } from '../fields';
import { Btn, Pill, RadioDot, Switch } from '../../../ui';
import { GameSeg, PowerState, StatusLamp } from '../../../ui/game';
import { Dis } from '../kit';
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

export const VOICE_TONE: Record<VoiceState, VisualStateKey> = { ready: 'ok', unknown: 'idle', probing: 'waiting', cold: 'waiting', unreachable: 'broken', off: 'stopped' };

/** 说话: voice and its self-hosted service, when she speaks up, how things reach you. */
export function SpeakGroup() {
  const { model, ro: groupRo, agentdOff, diag, native, goRow, perms, recheckPerms } = useSettings();
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
  const down = voice?.state === 'unreachable';
  const levels = optionsOf(native?.rows.proactive).filter((o) => o.value !== SILENT_LEVEL);
  const notifyLevels = optionsOf(native?.rows.n_done);
  // agentd mutes live on a spoken「静音」; this row is config.json, which it reads at start.
  const muteNote = diag.muted == null || diag.muted === (model.value('mute') === true) ? null : diag.muted ? '重启后台服务后按这里的设置出声' : '后台现在仍会出声；重启后台服务后生效';
  const mute = model.value('mute');
  const toService = { label: '前往设置连接', onClick: () => goRow('svc_tts', 'services') };

  const voiceDesc = (
    <>
      {voice && <StatusLamp size="sm" state={VOICE_TONE[voice.state]} label={voiceText(voice.state, retryLeft)} />} <span>{down ? '这段时间只显示文字' : `${sourceLabel ? `${sourceLabel} │ ` : ''}自己部署的语音服务，app 只连接`}</span>
    </>
  );

  return (
    <>
      <SetSection title="声音">
        <SetRow
          id="mute"
          title={labelOf('mute')}
          desc={muteNote ?? '只显示文字时照样回答，只是不念'}
          descTone={muteNote ? 'attention' : undefined}
          info="把角色的回答和主动发言念出来，要下面的语音服务在线。"
          control={
            <>
              {diag.muted && <StatusLamp size="sm" state="waiting" label="后台现在静音" />}
              <GameSeg variant="setting"
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
        {diag.voiceNone ? (
          <PowerState state="unlinked" mode="block" title="语音服务" reason="后台启动时没有配置语音服务，台词只显示文字" action={toService}>
            <SetRow id="tts" title={labelOf('tts')} desc="台词只显示文字" control={null} />
          </PowerState>
        ) : (
          <Linked down={down} action={toService}>
            <SetRow
              id="tts"
              title={labelOf('tts')}
              desc={voiceDesc}
              descTone={down ? 'bad' : undefined}
              info="把台词合成语音。要你自己部署的语音服务，地址在「服务」里；app 不打包模型，只用你的服务。"
              control={
                (voice?.state === 'unreachable' || voice?.state === 'cold') && (
                  <Btn disabled={agentdOff} disabledReason="后台服务没有运行" onClick={reconnect}>
                    重新连接
                  </Btn>
                )
              }
            />
            <SetRow
              id="ttsJump"
              title="令牌和测试"
              desc="在「服务 › 语音服务」里"
              indent
              control={
                <Btn go onClick={() => goRow('ttsToken', 'services')}>
                  去服务
                </Btn>
              }
            />
          </Linked>
        )}
        <SetRow id="asr" title={labelOf('asr')} desc="按住说话时用" info="跟随系统：按系统的首选语言识别语音。实际说的语言和这里不一致时，识别会出错。" control={c.seg('asr')} />
        <SetRow
          id="replyLang"
          title={labelOf('replyLang')}
          info="跟随对话：你用什么语言说，角色就用什么语言回答。按内核设置：这里不指定，由内核自己的设置决定。"
          control={c.select('replyLang', REPLY_LANGUAGE)}
        />
      </SetSection>

      <SetSection title="主动交流">
        <SpeakWhenRow
          ps={ps}
          disabled={ro}
          asked={<SetRow id="proactive" title={labelOf('proactive')} indent control={<Dis>只在你问时开口，不会主动</Dis>} />}
        >
          <SetRow
            id="proactive"
            title={labelOf('proactive')}
            desc="主动发言和动作的频率"
            info="均衡：约每 3 分钟看一次你手头的事，同类话题 10 分钟内不重复。主动：约每 2 分钟看一次，同类话题 5 分钟后就能再提，自己走动也更多。"
            indent control={c.select('proactive', levels, ['active'])} />
          <QuietHoursRow ps={ps} disabled={ro} />
        </SpeakWhenRow>
        <MutedRow disabled={ro} />
      </SetSection>

      <SetSection title="通知方式">
        <Slab id="n_done" label="各类通知">
          <div className={styles.mx} role="table" aria-label="各类通知">
            <span role="row" className={styles.mxHead}>
              <span role="columnheader" />
              {notifyLevels.map((o) => (
                <span key={o.value} role="columnheader">
                  {o.label}
                </span>
              ))}
            </span>
            {NOTIFY.filter(([id]) => shown(id)).map(([id, label, note]) => (
              <span key={id} role="row" id={id === 'n_done' ? undefined : `set-${id}`} className={styles.mxRow} data-row={id}>
                <span role="rowheader" className={styles.mxK}>
                  {label}
                  <small>{note}</small>
                </span>
                {notifyLevels.map((o) => (
                  <span key={o.value} role="cell" className={styles.mxCell}>
                    <RadioDot label={`${label}：${o.label}`} checked={model.value(id) === o.value} disabled={groupRo} onSelect={() => model.set(id, o.value)} />
                  </span>
                ))}
              </span>
            ))}
          </div>
        </Slab>
        <SetRow
          id="sysnotify"
          title={labelOf('sysnotify')}
          desc="角色隐藏或前台全屏时生效"
          control={<Switch variant="setting" checked={model.value('sysnotify') === true} label={labelOf('sysnotify')} disabled={groupRo} onChange={(on) => void sysNotify(on)} />}
        />
        <SetRow
          id="testcard"
          title={labelOf('testcard')}
          desc="在角色旁显示一张通知卡，检查位置和声音"
          control={
            <>
              <Btn onClick={() => void testCard('test_approval_card', '测试审批卡')}>测试审批卡</Btn>
              <Btn onClick={() => void testCard('test_announcement', '测试播报')}>测试播报</Btn>
            </>
          }
        />
      </SetSection>
    </>
  );
  /** Turning it on asks for the notification grant once, which also lists the app in the system's notification settings. */
  async function sysNotify(on: boolean) {
    model.set('sysnotify', on);
    if (!on || perms.find((p) => p.kind === 'notifications')?.state !== 'notDetermined') return;
    await bridge.permissions.request('notifications');
    await recheckPerms('notifications');
  }
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

/** The voice rows; while the service is unreachable they stay, under a 未接入 strip that leads to its address in 服务. */
function Linked({ down, action, children }: { down: boolean; action: { label: string; onClick: () => void }; children: ReactNode }) {
  if (!down) return <>{children}</>;
  return (
    <PowerState state="unlinked" mode="block" title="语音服务" reason="连不上你部署的语音服务，这段时间台词只显示文字" action={action}>
      {children}
    </PowerState>
  );
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
  // The PUT is the whole list: read it again first, so a kind the bubble muted since stays muted.
  const restore = (kind: string, label: string) =>
    void readMutes().then((r) => saveMutes(r.muted.filter((k) => k !== kind))).then(
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
                <Pill size="lg">
                  {label}
                  {!disabled && <Btn variant="link" onClick={() => restore(kind, label)}>恢复</Btn>}
                </Pill>
              </span>
            );
          })
        )
      }
    />
  );
}
