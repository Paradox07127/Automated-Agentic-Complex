import { useState, type ReactNode } from 'react';
import { getBridge, type CharacterEntry, type OnboardingStep } from '../../bridge';
import { AgentdCallError, saveVoiceToken, testVoice } from '../../bridge/agentd';
import { hotkeyText } from '../../bridge/platformText';
import { voiceText, type VoiceState } from '../../domain/voiceState';
import { CharacterArt, ErrBar, Select } from '../../ui';
import { GameFrame, MicroLabel } from '../../ui/game';
import { failure, saveModels } from '../settings/api';
import { Band } from '../settings/Band';
import { useControls } from '../settings/controls';
import { SettingsCtx, useSettings } from '../settings/ctx';
import { SVC } from '../settings/fields';
import { capsOf } from '../settings/groups/Keys';
import { ChatgptRow } from '../settings/groups/ModelChatgpt';
import { Cap, Dis, Field, KeyCell, Lnk, Masked, Seg, St, type StTone } from '../settings/kit';
import type { PermRow } from '../settings/perms';
import { labelOf } from '../settings/registry';
import { SetRow } from '../settings/SetRow';
import { SetSection } from '../settings/SetSection';
import { Slab } from '../settings/Slab';
import band from '../settings/band.module.css';
import { STEPS, doneCopy, pad2 } from './copy';
import { GUIDE_PERMS, type GuideSettings } from './useGuideSettings';
import type { Desk, Onboarding } from './useOnboarding';
import card from './GuideCard.module.css';
import styles from './Steps.module.css';

/** The media frame of a step: its number and English at the top left. */
export function Frame({ n, children }: { n: OnboardingStep; children: ReactNode }) {
  return (
    <div className={styles.frame} data-g="frame">
      <GameFrame variant="media" micro={`${pad2(n)} / ${STEPS[n].en}`}>
        <div className={styles.media} data-g="media">
          {children}
        </div>
      </GameFrame>
    </div>
  );
}

/** A hue per character for the drawn head when her package has none. */
const hueOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 17);

/** Drawn head: a gradient, halftone dots and a silhouette; no game image. */
function DrawnHead({ id }: { id: string }) {
  const h = hueOf(id);
  return (
    <svg className={styles.drawn} viewBox="0 0 104 136" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id={`g-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={`hsl(${h} 30% 34%)`} />
          <stop offset="1" stopColor={`hsl(${h} 25% 14%)`} />
        </linearGradient>
        <pattern id={`ht-${id}`} width="4" height="4" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r=".7" fill="#fff" fillOpacity=".12" />
        </pattern>
      </defs>
      <rect width="104" height="136" fill={`url(#g-${id})`} />
      <rect width="104" height="136" fill={`url(#ht-${id})`} />
      <path d="M30 60c-6-26 10-40 22-40s30 10 24 40c4 14 2 30-4 40H34c-6-10-8-26-4-40z" fill={`hsl(${h} 35% 70%)`} fillOpacity=".55" />
      <ellipse cx="52" cy="58" rx="16" ry="19" fill={`hsl(${h} 20% 86%)`} fillOpacity=".85" />
      <path d="M14 136c2-24 18-38 38-38s36 14 38 38z" fill={`hsl(${h} 18% 80%)`} fillOpacity=".7" />
      <path d="M36 48c6-14 26-16 34-2-8-4-22-6-34 2z" fill={`hsl(${h} 35% 60%)`} />
    </svg>
  );
}

const DESK: Record<Desk, [StTone, string]> = {
  unread: ['off', '没读到桌面状态'],
  appearing: ['warn', '正在出现…'],
  here: ['ok', '在桌面上'],
  hidden: ['off', '隐藏着'],
};

/** 01 角色: the roster (a cell switches her), 导入 as the last cell, and whether she is on the desktop. */
export function StepChar({ o }: { o: Onboarding }) {
  const list = o.characters ?? [];
  const c = o.current;
  return (
    <Frame n={1}>
      <SetSection title="名册">
        {list.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.why}>还没有角色。导入一个角色包，她就会出现在桌面上。</span>
            <Cap onClick={o.importPackage}>导入角色包</Cap>
          </div>
        ) : (
          <div className={styles.roster} role="radiogroup" aria-label="角色名册">
            {list.map((r) => (
              <button key={r.id} type="button" role="radio" aria-checked={r.active} className={styles.rc} onClick={() => !r.active && o.pick(r.id)}>
                <span className={styles.art}>
                  <CharacterArt src={r.head} kind="head" w={104} h={136} fallback={<DrawnHead id={r.id} />} />
                  <span className={styles.en} aria-hidden="true">
                    <MicroLabel>{r.en}</MicroLabel>
                  </span>
                  {r.active && (
                    <span className={styles.chk} aria-hidden="true">
                      ✓
                    </span>
                  )}
                </span>
                <span className={styles.nm}>{r.name}</span>
              </button>
            ))}
            <button type="button" className={styles.rc} data-add="" onClick={o.importPackage}>
              <span className={styles.art}>
                <span className={styles.plus} aria-hidden="true">
                  +
                </span>
                <span className={styles.addTx}>导入角色包</span>
              </span>
              <span className={styles.nm}>导入</span>
            </button>
          </div>
        )}
      </SetSection>
      {c && (
        <SetRow
          id="onDesk"
          title={`${c.name} 在桌面上`}
          desc={c.voice ? '有声线：连上语音服务后能念出来' : '没有声线：只显示文字，不会出声'}
          control={<St tone={DESK[o.desk][0]}>{DESK[o.desk][1]}</St>}
        />
      )}
    </Frame>
  );
}

/** One 模型服务 list without Pi's catalog: the guide connects one account; the rest stays on the settings page. */
const GUIDE_SVC = SVC.filter((o) => o.value !== 'pi_catalog');

/** The service's account row: ChatGPT sign-in, or an API key kept by agentd and never read back. */
function AccountRows() {
  const { model, ro, models, reload } = useSettings();
  const c = useControls();
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const svc = String(model.value('svc') ?? models?.provider ?? 'chatgpt');
  const cfg = models?.backends[svc as keyof NonNullable<typeof models>['backends']];
  const saveKey = () => {
    if (key.trim().length < 8) return model.notify({ message: 'API Key 太短，没有保存', severity: 'warning' });
    void saveModels({ provider: svc, api_key: key.trim() }).then(
      () => {
        setKey('');
        setReplacing(false);
        reload('models');
        model.notify({ message: 'API Key 已保存', severity: 'success' });
      },
      (e: unknown) => model.notify({ message: `没有保存 API Key：${failure(e).text}`, severity: 'danger', persistent: true }),
    );
  };
  return (
    <>
      <SetRow
        id="svc"
        title={labelOf('svc')}
        desc="Pi 用它；Codex 和 Claude Code 用自己的登录"
        control={<Select label={labelOf('svc')} value={svc} options={GUIDE_SVC} disabled={ro} onChange={(v) => model.set('svc', v)} />}
      />
      {(svc === 'anthropic' || svc === 'openai' || svc === 'compatible') && <SetRow id="apiBase" title={labelOf('apiBase')} control={c.text('apiBase', labelOf('apiBase'), 'https://…', ro)} />}
      {svc === 'chatgpt' ? (
        <ChatgptRow />
      ) : (
        <SetRow
          id="apikey"
          title={labelOf('apikey')}
          desc={cfg?.has_key ? `只送给后台，存进${getBridge().platform === 'windows' ? '系统凭据（DPAPI）' : '钥匙串'}，不回显` : '还没有保存'}
          descTone={cfg?.has_key ? undefined : 'attention'}
          control={
            cfg?.has_key && !replacing ? (
              <>
                <Masked>已保存</Masked>
                <Cap disabled={ro} onClick={() => setReplacing(true)}>
                  替换
                </Cap>
              </>
            ) : (
              <>
                <Field type="password" aria-label="API Key" placeholder={cfg?.has_key ? '输入新 Key 替换' : '粘贴 API Key'} value={key} disabled={ro} onChange={(e) => setKey(e.currentTarget.value)} />
                <Cap disabled={ro || !key} onClick={saveKey}>
                  保存
                </Cap>
              </>
            )
          }
        />
      )}
    </>
  );
}

/** 02 对话: 和她对话, then the service, its account and the test, read-only while agentd is down or restarting. */
export function StepChat({ g }: { g: GuideSettings }) {
  const { ctx, restarting, agentdOff, connected, test, runTest } = g;
  const ro = agentdOff || restarting;
  const testTone: StTone = test.state === 'ok' ? 'ok' : test.state === 'bad' ? 'bad' : test.state === 'testing' ? 'warn' : 'off';
  const testText = test.state === 'testing' ? '连接中…' : test.state === 'idle' ? '没连上' : test.text;
  return (
    <Frame n={2}>
      {agentdOff && !restarting && (
        <ErrBar
          message="后台服务没有运行，账号这一块暂时只读"
          extra={<Cap onClick={g.retryAgentd}>重新连接</Cap>}
        />
      )}
      {restarting && <ErrBar tone="warning" message="正在重启后台… 回来后账号这一块就能用" />}
      <Band plugin="light_ai" fold="模型服务、账号">
        <SettingsCtx.Provider value={{ ...ctx, ro, roReason: restarting ? '正在重启后台' : '后台服务没有运行' }}>
          <AccountRows />
          <SetRow
            id="mtest"
            title={labelOf('mtest')}
            indent
            desc={test.state === 'ok' ? '她现在能和你对话了' : connected ? '发一句话给模型，看能不能回' : '先连上账号再测'}
            descTone={test.state === 'ok' ? 'ok' : undefined}
            control={
              <>
                <St tone={testTone}>{testText}</St>
                <Cap loading={test.state === 'testing'} disabled={ro || !connected} disabledReason="先连上账号" onClick={runTest}>
                  测试
                </Cap>
              </>
            }
          />
        </SettingsCtx.Provider>
      </Band>
    </Frame>
  );
}

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
function DrawnFigure({ id }: { id: string }) {
  const h = hueOf(id);
  return (
    <svg className={styles.drawn} viewBox="0 0 220 300" aria-hidden="true">
      <defs>
        <pattern id="fht" width="4" height="4" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r=".8" fill="currentColor" fillOpacity=".18" />
        </pattern>
      </defs>
      <path d="M70 100c-10-50 20-80 40-80s52 22 42 80c8 30 4 70-8 96H78c-12-26-16-66-8-96z" fill={`hsl(${h} 30% 55%)`} fillOpacity=".5" />
      <ellipse cx="110" cy="96" rx="30" ry="36" fill={`hsl(${h} 15% 85%)`} fillOpacity=".8" />
      <path d="M30 300c4-70 36-110 80-110s76 40 80 110z" fill={`hsl(${h} 15% 78%)`} fillOpacity=".55" />
      <path d="M30 300c4-70 36-110 80-110s76 40 80 110z" fill="url(#fht)" />
      <path d="M78 80c10-26 52-30 66-4-16-8-44-12-66 4z" fill={`hsl(${h} 35% 50%)`} />
    </svg>
  );
}

function Mouse({ side }: { side: 'left' | 'right' }) {
  return (
    <svg className={styles.mouse} viewBox="0 0 20 24" aria-hidden="true">
      <rect x="2" y="1" width="16" height="22" rx="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 10h16M10 1v9" stroke="currentColor" strokeWidth="1.5" />
      <path d={side === 'left' ? 'M3 9V8a7 7 0 0 1 7-7v9z' : 'M17 9V8a7 7 0 0 0-7-7v9z'} className={styles.btnFill} />
    </svg>
  );
}

/** 完成: her on the desk, one line per step with a link back to what is not done, and the three ways to call her. */
export function StepDone({ o, g, missing, goto }: { o: Onboarding; g: GuideSettings; missing: PermRow[]; goto: (n: OnboardingStep) => void }) {
  const { model } = g.ctx;
  const her = o.current;
  const ready = g.talks && g.test.state === 'ok';
  const copy = doneCopy(her?.name ?? null, ready);
  const quick = o.hotkeys.hk_quick ?? String(model.value('hk_quick') ?? '');
  const lines: Array<[string, ReactNode, ReactNode]> = [
    ['角色', her ? <St tone="ok">{`${her.name} 在桌面上`}</St> : <St tone="off">还没有角色</St>, !her && <Lnk onClick={() => goto(1)}>导入</Lnk>],
    [
      '对话',
      !g.talks ? <St tone="off">关着，只陪伴</St> : ready ? <St tone="ok">{`已连上 │ ${g.service ?? ''}`}</St> : <St tone="warn">没连上账号</St>,
      g.talks && !ready && <Lnk onClick={() => goto(2)}>去连</Lnk>,
    ],
    [
      '她的声音',
      her && !her.voice ? <St tone="off">没有声线，只显示文字</St> : g.talks && model.value('tts') === 'remote' ? <St tone="ok">外部服务</St> : <St tone="off">只显示文字</St>,
      null,
    ],
    [
      '按住说话',
      !g.talks ? <St tone="off">对话关着</St> : missing.length ? <St tone="warn">{`${missing.map((p) => p.label).join('、')}没开`}</St> : <St tone="ok">可以用</St>,
      g.talks && missing.length > 0 && <Lnk onClick={() => goto(3)}>去开</Lnk>,
    ],
  ];
  return (
    <div className={styles.done}>
      <div className={styles.desk} data-g="frame" aria-hidden="true">
        <span className={styles.wm}>{her?.name}</span>
        {her && (
          <span className={styles.fig}>
            {her.portrait ? <CharacterArt src={her.portrait} kind="portrait" w={220} h={300} fallback={<DrawnFigure id={her.id} />} /> : <DrawnFigure id={her.id} />}
          </span>
        )}
        <span className={styles.line} />
        <span className={styles.here}>
          {her ? <St tone={DESK[o.desk][0]}>{DESK[o.desk][1]}</St> : <St tone="off">桌面上还没有角色</St>}
          <MicroLabel>Desk / Live</MicroLabel>
        </span>
      </div>
      <div className={styles.side} data-g="text">
        <span className={styles.mi}>
          <MicroLabel>Setup Complete 03 / 03</MicroLabel>
        </span>
        <h1 className={card.h1} data-g="title">
          {copy.title}
        </h1>
        <span className={card.rule} data-g="rule" aria-hidden="true">
          <i />
          <b />
        </span>
        <p className={styles.lead}>{copy.lead}</p>
        <Slab id="result" variant="plate" title="设置结果" right={<MicroLabel>Result</MicroLabel>}>
          <div className={styles.kv}>
            {lines.map(([k, v, l]) => (
              <div key={k} className={styles.kvRow}>
                <span className={styles.k}>{k}</span>
                <span>{v}</span>
                <span>{l}</span>
              </div>
            ))}
          </div>
        </Slab>
        <Slab id="calls" variant="plate" title="怎么叫她">
          <div className={styles.calls}>
            <div className={styles.call}>
              <span className={styles.how}>
                <Mouse side="left" />
                点她
              </span>
              <b>互动、摸头</b>
            </div>
            <div className={styles.call}>
              <span className={styles.how}>
                <Mouse side="right" />
                右键她
              </span>
              <b>快捷轮盘</b>
            </div>
            <div className={styles.call}>
              <KeyCell keys={quick ? capsOf(hotkeyText(quick)) : undefined} none={quick === ''} />
              <b>{g.talks ? '和她聊天' : '快速输入'}</b>
            </div>
          </div>
        </Slab>
      </div>
    </div>
  );
}

