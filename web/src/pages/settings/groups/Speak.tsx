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
import { Btn, Pill, RadioDot, RadioDotGroup, Switch } from '../../../ui';
import { GameSeg, PowerState, StatusLamp } from '../../../ui/game';
import { Dis } from '../kit';
import { optionsOf } from '../native';
import { labelOf, useRowShown } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import { Slab } from '../Slab';
import { QuietHoursRow, useProactiveSettings } from './SpeakCompanion';
import { SILENT_LEVEL, SpeakWhenRow } from './SpeakWhen';
import styles from '../groups.module.css';

const NOTIFY: Array<[id: string, label: string, note: string]> = [
  ['n_done', '完成', '任务已完成'],
  ['n_appr', '待批准', '仅作用于审批卡'],
  ['n_err', '出错', '任务执行出错'],
  ['n_brief', '简短播报', '进度摘要播报'],
  ['n_remind', '提醒', '已设定的提醒事项'],
];

/** The proactive kinds agentd may mute (proactive.py `MUTABLE`). */
const MUTED_KIND: Record<string, string> = {
  comment: '长时间注视同一窗口时发起提醒',
  back: '返回电脑时汇报期间摘要',
  break: '休息提醒',
  water: '饮水提醒',
  stuck: '检测到操作受阻时主动询问',
  thought: '关联思考提示',
  session: '会话异常时通知',
  task: '任务中止时通知',
  repeat: '检测到重复操作时建议创建定时任务',
};

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
        model.notify({ message: `重新连接语音服务失败：${failure(e).text}`, severity: 'danger', persistent: true });
      },
    );
  };
  const down = voice?.state === 'unreachable';
  const levels = optionsOf(native?.rows.proactive).filter((o) => o.value !== SILENT_LEVEL);
  const notifyLevels = optionsOf(native?.rows.n_done);
  // agentd updates mute live when saved; diag.muted reflects runtime temporary mute vs saved setting.
  const muteNote = diag.muted == null || diag.muted === (model.value('mute') === true) ? null : '当前运行时静音状态与此处配置不一致，切换上方开关即可即时同步';
  const mute = model.value('mute');
  const toService = { label: '前往配置', onClick: () => goRow('svc_tts', 'services') };

  const voiceDesc = (
    <>
      {voice && <StatusLamp size="sm" state={VOICE_TONE[voice.state]} label={voiceText(voice.state, retryLeft)} />} <span>{down ? '当前仅使用文字回复' : `${sourceLabel ? `${sourceLabel} │ ` : ''}需自行部署外部语音服务，本应用仅连接使用`}</span>
    </>
  );

  return (
    <>
      <SetSection title="语音与播报">
        <SetRow
          id="mute"
          title={labelOf('mute')}
          desc={muteNote ?? '仅文字模式下仍正常生成回复，不播放语音'}
          descTone={muteNote ? 'attention' : undefined}
          info="使用语音播放角色回复与主动发言，需确保下方外部语音服务处于在线状态。"
          control={
            <>
              {diag.muted && <StatusLamp size="sm" state="waiting" label="当前已静音" />}
              <GameSeg variant="setting"
                label={labelOf('mute')}
                value={typeof mute === 'boolean' ? String(mute) : ''}
                options={[
                  { value: 'false', label: '开启' },
                  { value: 'true', label: '仅文字' },
                ]}
                disabled={groupRo}
                onChange={(v) => model.set('mute', v === 'true')}
              />
            </>
          }
        />
        {diag.voiceNone ? (
          <PowerState state="unlinked" mode="block" title="语音服务" reason="后台启动时未配置语音服务，回复仅以文字呈现" action={toService}>
            <SetRow id="tts" title={labelOf('tts')} desc="当前仅文字回复" control={null} />
          </PowerState>
        ) : (
          <Linked down={down} action={toService}>
            <SetRow
              id="tts"
              title={labelOf('tts')}
              desc={voiceDesc}
              descTone={down ? 'bad' : undefined}
              info="用于将文本合成为语音。需自行部署外部语音服务并在「服务」中配置地址；本应用不内置语音合成模型。"
              control={
                (voice?.state === 'unreachable' || voice?.state === 'cold') && (
                  <Btn disabled={agentdOff} disabledReason="后台服务未运行" onClick={reconnect}>
                    重新连接
                  </Btn>
                )
              }
            />
            <SetRow
              id="ttsJump"
              title="令牌与连接测试"
              desc="位于「设置 › 服务 › 语音服务」"
              indent
              control={
                <Btn go onClick={() => goRow('ttsToken', 'services')}>
                  前往服务
                </Btn>
              }
            />
          </Linked>
        )}
        <SetRow id="asr" title={labelOf('asr')} desc="按住语音输入时使用的识别语言" info="跟随系统：使用操作系统首选语言进行识别。若实际语音语种与所选语言不符，可能导致识别错误。" control={c.seg('asr')} />
        <SetRow
          id="replyLang"
          title={labelOf('replyLang')}
          info="跟随对话：根据用户输入语言自动匹配回复语言；按内核设置：交由执行内核自身配置决定。"
          control={c.select('replyLang', REPLY_LANGUAGE)}
        />
      </SetSection>

      <SetSection title="主动交互">
        <SpeakWhenRow
          ps={ps}
          disabled={ro}
          asked={<SetRow id="proactive" title={labelOf('proactive')} indent control={<Dis>仅在用户主动发起对话时响应</Dis>} />}
        >
          <SetRow
            id="proactive"
            title={labelOf('proactive')}
            desc="主动发言与桌面行为的触发频率"
            info="均衡：约每 3 分钟检查一次上下文，同类话题 10 分钟内不重复触发。高频：约每 2 分钟检查一次，同类话题冷却时间缩短至 5 分钟，主动动作更频繁。"
            indent control={c.select('proactive', levels, ['active'])} />
          <QuietHoursRow ps={ps} disabled={ro} />
        </SpeakWhenRow>
        <MutedRow disabled={ro} />
      </SetSection>

      <SetSection title="通知送达">
        <Slab id="n_done" label="各类通知">
          {/* One radio group per kind; each dot's name carries its column's level, so the head is not read out. */}
          <div className={styles.mx} role="group" aria-label="各类通知">
            <span className={styles.mxHead} aria-hidden="true">
              <span />
              {notifyLevels.map((o) => (
                <span key={o.value}>{o.label}</span>
              ))}
            </span>
            {NOTIFY.filter(([id]) => shown(id)).map(([id, label, note]) => {
              const value = model.value(id);
              const known = notifyLevels.some((o) => o.value === value);
              return (
                <RadioDotGroup key={id} label={label} id={id === 'n_done' ? undefined : `set-${id}`} className={styles.mxRow} data-row={id}>
                  <span className={styles.mxK}>
                    {label}
                    <small>{note}</small>
                  </span>
                  {notifyLevels.map((o, i) => (
                    <span key={o.value} className={styles.mxCell}>
                      <RadioDot
                        label={`${label}：${o.label}`}
                        checked={value === o.value}
                        tabStop={known ? value === o.value : i === 0}
                        disabled={groupRo}
                        onSelect={() => model.set(id, o.value)}
                      />
                    </span>
                  ))}
                </RadioDotGroup>
              );
            })}
          </div>
        </Slab>
        <SetRow
          id="sysnotify"
          title={labelOf('sysnotify')}
          desc="角色隐藏或前台应用全屏时改为通过系统通知中心送达"
          control={<Switch variant="setting" checked={model.value('sysnotify') === true} label={labelOf('sysnotify')} disabled={groupRo} onChange={(on) => void sysNotify(on)} />}
        />
        <SetRow
          id="testcard"
          title={labelOf('testcard')}
          desc="在桌面角色旁展示测试卡片，以校验位置与提示音效果"
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
      model.notify({ message: `${what}已显示在桌面角色旁` });
    } catch (e) {
      const detail = (e as { detail?: string } | null)?.detail;
      model.notify({ message: detail || `无法显示${what}，请先确保角色已在桌面显示`, severity: 'warning' });
    }
  }
}

/** The voice rows; while the service is unreachable they stay, under a 未接入 strip that leads to its address in 服务. */
function Linked({ down, action, children }: { down: boolean; action: { label: string; onClick: () => void }; children: ReactNode }) {
  if (!down) return <>{children}</>;
  return (
    <PowerState state="unlinked" mode="block" title="语音服务" reason="无法连接外部语音服务，当前仅使用文字回复" action={action}>
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
      (e) => model.notify({ message: `未能恢复「${label}」：${failure(e).text}`, severity: 'danger', persistent: true }),
    );
  if (muted?.length === 0) return null;
  return (
    <SetRow
      id="mutes"
      title={labelOf('mutes')}
      desc="可通过气泡「更多操作」中的「关闭此类」添加"
      wrap
      control={
        muted == null ? (
          <span className={styles.t3} title="已关闭的主动交互类别：尚未读取到后台服务状态">
            未读取
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
