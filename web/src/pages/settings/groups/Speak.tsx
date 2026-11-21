import { useEffect, useRef, useState } from 'react';
import { getBridge } from '../../../bridge';
import { AgentdCallError, resetVoice, saveVoiceToken, testVoice } from '../../../bridge/agentd';
import { CumulativeStep } from '../../../charts';
import { formatDuration, isoToMsOrNull, type Cooldown, type VisualStateKey } from '../../../domain';
import { voiceSource, voiceState, voiceText, type Voice, type VoiceState } from '../../../domain/voiceState';
import { useCountdown } from '../../../features/approval/useCountdown';
import { Btn, Menu, StatusTag, Toggle } from '../../../ui';
import { clock, failure, readMutes, saveMutes, setMeeting, setQuiet } from '../api';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { daySpan, type BlockedLine, type DayEvent, type DiagView } from '../diag';
import { REPLY_LANGUAGE } from '../fields';
import { optionsOf } from '../native';
import { useRowShown } from '../registry';
import { PauseReadout } from '../PauseReadout';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import { Slab } from '../Slab';
import { GateBlocked, MUTED_KIND } from './GateBlocked';
import { ContextSpeechRow, useProactiveSettings } from './SpeakCompanion';
import { SpeakWhenRow } from './SpeakWhen';
import styles from '../groups.module.css';

/** Next 07:00 local after `now` (the old QuietSpan「到明早」). */
export function tomorrowMorning(now: number): number {
  const d = new Date(now);
  d.setHours(7, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** The old QuietSpan choices; agentd caps a quiet window at 1440 minutes. */
const QUIET: Array<[string, (now: number) => number]> = [
  ['30 分钟', (now) => now + 30 * 60_000],
  ['1 小时', (now) => now + 60 * 60_000],
  ['到明早', tomorrowMorning],
];

const NOTIFY: Array<[string, string, string?]> = [
  ['n_done', '完成'],
  ['n_appr', '待批准', '只作用于审批卡'],
  ['n_err', '出错'],
  ['n_brief', '简短播报'],
  ['n_remind', '提醒'],
];

const VOICE_TAG: Record<VoiceState, VisualStateKey> = { ready: 'ok', unknown: 'idle', probing: 'running', cold: 'warning', unreachable: 'broken', off: 'broken' };

/** POST /voice/test `reason` → what the test row says. */
function voiceTestFailure(reason: string | null): string {
  const status = /^http_(\d+)$/.exec(reason ?? '')?.[1];
  if (reason === 'http_401') return '令牌不对';
  if (status) return `服务返回 ${status}`;
  const text: Record<string, string> = { invalid_url: '地址不可用：要以 http:// 或 https:// 开头', unreachable: '连不上', bad_stream: '返回的不是语音流', timeout: '超时' };
  return text[reason ?? ''] ?? '没有通过';
}

/** 说话与通知: voice, proactivity with today's gate, do-not-disturb, notification routing. */
export function SpeakGroup() {
  const { model, ro: groupRo, agentdOff, diag, gateEvents, gateBlocked, native, hl } = useSettings();
  const shown = useRowShown();
  // The do-not-disturb rows write to agentd.
  const ro = groupRo || agentdOff;
  const c = useControls();
  const bridge = getBridge();
  const quietLevel = model.value('proactive') === 'quiet';
  const ps = useProactiveSettings();

  const startQuiet = (label: string, until: (now: number) => number) =>
    void setQuiet(until(clock())).then(
      (r) => {
        model.setPause('quiet', isoToMsOrNull(r.quiet_until));
        model.notify({ message: `免打扰已开始 │ ${label}` });
      },
      (e) => model.notify({ message: `没能开始免打扰：${failure(e).text}`, severity: 'danger', persistent: true }),
    );
  const endQuiet = () =>
    void setQuiet(null).then(
      () => model.setPause('quiet', null),
      (e) => model.notify({ message: `没能结束免打扰：${failure(e).text}`, severity: 'danger', persistent: true }),
    );
  const meeting = (on: boolean) =>
    void setMeeting(on).then(
      (r) => model.setMeeting(r.meeting),
      (e) => model.notify({ message: `没能${on ? '开始' : '结束'}开会模式：${failure(e).text}`, severity: 'danger', persistent: true }),
    );
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
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const saveToken = () =>
    void saveVoiceToken(token.trim()).then(
      () => {
        savedToken.current = token.trim();
        setToken('');
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
  const ttsOpts = optionsOf(native?.rows.tts).map((o) => (o.value === 'local' ? { ...o, label: '关闭（无语音）' } : o));
  const quietUntil = model.pauses.quiet;
  // agentd mutes live on a spoken「静音」; this row is config.json, which it reads at start.
  const muteNote = diag.muted == null || diag.muted === (model.value('mute') === true) ? null : diag.muted ? '重启后台服务后按这里的设置出声' : '后台现在仍会出声；重启后台服务后生效';

  return (
    <>
      <SetSection title="声音">
        <SetRow
          id="mute"
          title="静音"
          desc={muteNote ?? '只显示文字，不出声。菜单栏和角色菜单中也可切换'}
          descTone={muteNote ? 'attention' : undefined}
          control={
            <>
              {diag.muted && <StatusTag state="todo" label="后台现在静音" />}
              {c.toggle('mute', '静音')}
            </>
          }
        />
        {diag.voiceNone && !local ? (
          <SetRow id="tts" title="语音不可用" desc="台词只显示文字" control={null} />
        ) : (
          <SetRow
            id="tts"
            title="语音合成来源"
            desc={local ? '不发声，只显示文字' : down ? '没有连上语音服务，只显示文字' : '角色隐藏时，主动发言只显示文字'}
            descTone={down ? 'attention' : undefined}
            control={
              <>
                {sourceLabel && <span className={styles.t3}>{sourceLabel}</span>}
                {voice && <StatusTag state={VOICE_TAG[voice.state]} label={voiceText(voice.state, retryLeft)} />}
                {(voice?.state === 'unreachable' || voice?.state === 'cold') && (
                  <Btn size="sm" variant="ghost" disabled={agentdOff} onClick={reconnect}>
                    重新连接
                  </Btn>
                )}
                {c.seg('tts', ttsOpts)}
              </>
            }
          />
        )}
        {remote && shown('ttsUrl') && (
          <>
            <details className={styles.kernBody} open={['ttsUrl', 'ttsTunnelHost', 'ttsEnsureScript'].some((id) => id === hl)}>
              <summary>高级连接</summary>
              {([['ttsUrl', '服务地址', 'http 或 https 地址；不填时只出文字', 'http://主机:端口'], ['ttsTunnelHost', 'SSH 转发主机', '留空就不建隧道', 'ssh 主机名（可留空）'], ['ttsEnsureScript', '按需启动脚本', '留空就不按需启动', '远程主机上的绝对路径（可留空）']] as const).map(([id, title, desc, hint]) => <SetRow key={id} id={id} title={title} desc={desc} indent control={c.text(id, title, hint)} />)}
            </details>
            <SetRow
              id="ttsToken"
              title="令牌"
              indent
              control={
                <>
                  <input className={styles.input} type="password" aria-label="令牌" placeholder="粘贴令牌" value={token} disabled={agentdOff} onChange={(e) => setToken(e.currentTarget.value)} />
                  <Btn size="sm" variant="ghost" disabled={agentdOff || !token.trim()} onClick={saveToken}>
                    保存
                  </Btn>
                </>
              }
            />
            <SetRow
              id="ttsTest"
              title="测试连接"
              desc={test ? <span className={test.ok ? styles.ok : styles.att}>{test.text}</span> : undefined}
              indent
              control={
                <Btn size="sm" variant="ghost" loading={testing} disabled={agentdOff} onClick={() => void runTest()}>
                  测试连接
                </Btn>
              }
            />
          </>
        )}
        <SetRow id="asr" title="识别语言" control={c.seg('asr')} />
        <SetRow id="replyLang" title="回复语言" control={c.seg('replyLang', REPLY_LANGUAGE)} />
      </SetSection>

      <SetSection title="主动程度">
        {diag.gate && <GatePlate gate={diag.gate} events={gateEvents ?? null} blocked={gateBlocked ?? []} cooldowns={diag.cooldowns} />}
        <SpeakWhenRow ps={ps} disabled={ro} />
        <SetRow id="proactive" title="主动程度" desc="主动发言和动作的频率" control={c.select('proactive', undefined, ['active'])} />
        <SetRow
          id="speakUp"
          title="主动发言"
          desc={quietLevel ? '主动程度为「安静」时不主动发言' : '有值得提示的事项时主动发言'}
          disabled={quietLevel}
          disabledReason="主动程度为「安静」"
          control={c.toggle('speakUp', '主动发言', quietLevel, '主动程度为「安静」')}
        />
        {(quietLevel || model.value('speakUp') === false) && <p className={styles.cap}>想法需要打开「主动发言」</p>}
        <ContextSpeechRow ps={ps} disabled={ro} />
        <SetRow id="rest" title="休息提醒" desc="连续使用到设定时长后提醒休息" control={c.select('rest')} />
        {native?.rows.water && (
          <SetRow id="water" title="喝水提醒" desc="连续使用到设定时长后，在停顿时提醒喝水" control={c.select('water')} />
        )}
        <MutedRow disabled={ro} />
      </SetSection>

      <SetSection title="免打扰">
        <SetRow
          id="dnd_quiet"
          title="免打扰 │ 安静"
          desc="开会并暂停观察；提醒只出卡片、不出声，朝向决策关闭"
          control={
            quietUntil ? (
              <PauseReadout kind="免打扰" until={quietUntil} note="提醒只出卡片、不出声" disabled={ro} onResume={endQuiet} />
            ) : (
              <Menu label="开始" align="right" items={QUIET.map(([label, until]) => ({ kind: 'item' as const, label, disabled: ro, onSelect: () => startQuiet(label, until) }))} />
            )
          }
        />
        <SetRow
          id="dnd_meet"
          title="免打扰 │ 会议"
          desc="共享屏幕时使用，提醒照常"
          control={
            diag.pauses == null ? (
              <span className={styles.t3} title="开会模式：还没读到后台的状态">
                未读到
              </span>
            ) : (
              <Toggle on={model.pauses.meeting} label="开会模式" size="sm" disabled={ro} onChange={meeting} />
            )
          }
        />
        <SetRow id="capHide" title="录屏时隐藏角色" desc="开始录屏或共享屏幕时隐藏一次，按 ⌃⌥H 显示" control={c.toggle('capHide', '录屏时隐藏角色')} />
      </SetSection>

      <SetSection title="通知方式">
        {NOTIFY.map(([id, label, desc]) => (
          <SetRow key={id} id={id} title={label} desc={desc} control={c.seg(id)} />
        ))}
        <SetRow id="sysnotify" title="改用 macOS 通知" desc="角色隐藏或前台全屏时生效" control={c.toggle('sysnotify', '改用 macOS 通知')} />
        <SetRow
          id="testcard"
          title="发送测试卡"
          desc="在角色旁显示一张通知卡，检查位置和声音"
          control={
            <>
              <Btn size="sm" variant="ghost" onClick={() => void testCard('test_approval_card', '测试审批卡')}>
                测试审批卡
              </Btn>
              <Btn size="sm" variant="ghost" onClick={() => void testCard('test_announcement', '测试播报')}>
                测试播报
              </Btn>
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

/** Proactive kinds turned off with the bubble's 关闭此类 (GET /proactive/mutes), each with 恢复. */
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
  const how = '在气泡的「更多操作」里点「关闭此类」可以关掉一类';
  return (
    <SetRow
      id="mutes"
      title="已关掉的主动发言"
      desc={muted != null && muted.length === 0 ? `没有关掉的类别。${how}` : how}
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
                <span>{label}</span>
                <Btn size="sm" variant="ghost" disabled={disabled} disabledReason="后台不可写" onClick={() => restore(kind, label)}>
                  恢复
                </Btn>
              </span>
            );
          })
        )
      }
    />
  );
}

/** 今日发言闸门: today's proactive lines as a cumulative step up to the daily limit, blocked ones as ✕, and the cooldowns. */
function GatePlate({ gate, events, blocked, cooldowns }: { gate: NonNullable<DiagView['gate']>; events: DayEvent[] | null; blocked: BlockedLine[]; cooldowns: Cooldown[] }) {
  const now = clock();
  const ev = events ?? [];
  const [t0, t1] = daySpan(ev, now);
  return (
    <Slab id="gate" variant="plate" title="今日发言闸门" right="主动发言累计达到上限后停止；已拦截的标 ✕">
      <div className={styles.gate}>
        <CumulativeStep events={ev} t0={t0} t1={t1} now={now} limit={gate.daily_limit} h={112} label="今日主动发言" unit="次" st={events == null ? 'error' : 'ok'} empty="今天还没有主动发言" />
        <div className={styles.cooldowns} role="list" aria-label="冷却">
          {cooldowns.length === 0 && (
            <span role="listitem" className={styles.coolItem}>
              <span className={styles.t3}>冷却</span>
              <span>✓ 均已就绪</span>
            </span>
          )}
          {cooldowns.map((cd) => (
            <span key={cd.key} role="listitem" className={styles.coolItem}>
              <span className={styles.t3}>{cd.label}</span>
              <span>
                冷却 <span className="num">{formatDuration(cd.left_s * 1000)}</span>
              </span>
            </span>
          ))}
        </div>
      </div>
      <GateBlocked lines={blocked} />
    </Slab>
  );
}
