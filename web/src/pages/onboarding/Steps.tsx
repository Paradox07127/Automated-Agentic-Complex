import { useState, type ReactNode } from 'react';
import { getBridge, type OnboardingStep } from '../../bridge';
import { hotkeyText } from '../../bridge/platformText';
import type { VisualStateKey } from '../../domain/states';
import { Btn, CharacterArt, ErrBar, Field, Select } from '../../ui';
import { GameFrame, MicroLabel, StatusLamp } from '../../ui/game';
import { failure, saveModels } from '../settings/api';
import { Band } from '../settings/Band';
import { useControls } from '../settings/controls';
import { SettingsCtx, useSettings } from '../settings/ctx';
import { SVC } from '../settings/fields';
import { capsOf } from '../settings/groups/Keys';
import { ChatgptRow } from '../settings/groups/ModelChatgpt';
import { KeyCell, Masked } from '../settings/kit';
import type { PermRow } from '../settings/perms';
import { labelOf } from '../settings/registry';
import { SetRow } from '../settings/SetRow';
import { SetSection } from '../settings/SetSection';
import { Slab } from '../settings/Slab';
import { STEPS, doneCopy, pad2 } from './copy';
import { type GuideSettings } from './useGuideSettings';
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

const DESK: Record<Desk, [VisualStateKey, string]> = {
  unread: ['idle', '没读到桌面状态'],
  appearing: ['waiting', '正在出现…'],
  here: ['ok', '在桌面上'],
  hidden: ['stopped', '隐藏着'],
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
            <Btn onClick={o.importPackage}>导入角色包</Btn>
          </div>
        ) : (
          <div className={styles.roster} role="radiogroup" aria-label="角色名册">
            {list.map((r) => (
              <button key={r.id} type="button" role="radio" aria-checked={r.active} className={styles.rc} onClick={() => !r.active && o.pick(r.id)}>
                <span className={styles.art}>
                  <CharacterArt src={r.head} kind="head" w={104} h={136} fallback={<DrawnHead id={r.id} />} />
                  <span className={styles.en} data-theme="dark" aria-hidden="true">
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
          control={<StatusLamp size="sm" state={DESK[o.desk][0]} label={DESK[o.desk][1]} />}
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
      {(svc === 'anthropic' || svc === 'openai') && <SetRow id="apiBase" title={labelOf('apiBase')} control={c.text('apiBase', labelOf('apiBase'), 'https://…', ro)} />}
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
                <Btn disabled={ro} onClick={() => setReplacing(true)}>
                  替换
                </Btn>
              </>
            ) : (
              <>
                <Field type="password" label="API Key" placeholder={cfg?.has_key ? '输入新 Key 替换' : '粘贴 API Key'} value={key} disabled={ro} onChange={setKey} />
                <Btn disabled={ro || !key} onClick={saveKey}>
                  保存
                </Btn>
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
  const testTone: VisualStateKey = test.state === 'ok' ? 'ok' : test.state === 'bad' ? 'broken' : test.state === 'testing' ? 'waiting' : 'idle';
  const testText = test.state === 'testing' ? '连接中…' : test.state === 'idle' ? '没连上' : test.text;
  return (
    <Frame n={2}>
      {agentdOff && !restarting && (
        <ErrBar
          message="后台服务没有运行，账号这一块暂时只读"
          extra={<Btn onClick={g.retryAgentd}>重新连接</Btn>}
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
                <StatusLamp size="sm" state={testTone} label={testText} />
                <Btn loading={test.state === 'testing'} disabled={ro || !connected} disabledReason="先连上账号" onClick={runTest}>
                  测试
                </Btn>
              </>
            }
          />
        </SettingsCtx.Provider>
      </Band>
    </Frame>
  );
}

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
    ['角色', her ? <StatusLamp size="sm" state="ok" label={`${her.name} 在桌面上`} /> : <StatusLamp size="sm" state="idle" label="还没有角色" />, !her && <Btn variant="link" onClick={() => goto(1)}>导入</Btn>],
    [
      '对话',
      !g.talks ? <StatusLamp size="sm" state="stopped" label="关着，只陪伴" /> : ready ? <StatusLamp size="sm" state="ok" label={`已连上 │ ${g.service ?? ''}`} /> : <StatusLamp size="sm" state="waiting" label="没连上账号" />,
      g.talks && !ready && <Btn variant="link" onClick={() => goto(2)}>去连</Btn>,
    ],
    [
      '她的声音',
      her && !her.voice ? <StatusLamp size="sm" state="idle" label="没有声线，只显示文字" /> : g.talks && g.ctx.diag.voice != null && !g.ctx.diag.voiceNone ? <StatusLamp size="sm" state="ok" label="外部服务" /> : <StatusLamp size="sm" state="idle" label="只显示文字" />,
      null,
    ],
    [
      '按住说话',
      !g.talks ? <StatusLamp size="sm" state="stopped" label="对话关着" /> : missing.length ? <StatusLamp size="sm" state="waiting" label={`${missing.map((p) => p.label).join('、')}没开`} /> : <StatusLamp size="sm" state="ok" label="可以用" />,
      g.talks && missing.length > 0 && <Btn variant="link" onClick={() => goto(3)}>去开</Btn>,
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
          {her ? <StatusLamp size="sm" state={DESK[o.desk][0]} label={DESK[o.desk][1]} /> : <StatusLamp size="sm" state="idle" label="桌面上还没有角色" />}
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

