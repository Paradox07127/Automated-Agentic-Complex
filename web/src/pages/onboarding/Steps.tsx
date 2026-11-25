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
  unread: ['idle', '未读取桌面状态'],
  appearing: ['waiting', '正在加载…'],
  here: ['ok', '已在桌面运行'],
  hidden: ['stopped', '已隐藏'],
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
            <span className={styles.why}>还没有角色。导入一个角色包，角色就会出现在桌面上。</span>
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
          title={`已选择 ${c.name}`}
          desc={c.voice ? '包含角色声线：连接语音服务后可进行语音播报' : '无配套声线：将以文字形式回复'}
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
  const svc = String(model.value('svc') ?? models?.provider ?? 'chatgpt');
  // A typed key belongs to the service it was typed for: picking another one starts empty.
  const [typed, setTyped] = useState({ svc, key: '', replacing: false });
  const mine = typed.svc === svc ? typed : { svc, key: '', replacing: false };
  const { key, replacing } = mine;
  const setKey = (k: string) => setTyped({ ...mine, key: k });
  const setReplacing = (r: boolean) => setTyped({ ...mine, replacing: r });
  const cfg = models?.backends[svc as keyof NonNullable<typeof models>['backends']];
  const saveKey = () => {
    if (key.trim().length < 8) return model.notify({ message: 'API Key 太短，没有保存', severity: 'warning' });
    void saveModels({ provider: svc, api_key: key.trim() }).then(
      () => {
        setTyped((t) => (t.svc === svc ? { svc, key: '', replacing: false } : t));
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
        desc="适用于 Pi 内核；Codex 与 Claude Code 使用各自的账号登录"
        control={<Select label={labelOf('svc')} value={svc} options={GUIDE_SVC} disabled={ro} onChange={(v) => model.set('svc', v)} />}
      />
      {(svc === 'anthropic' || svc === 'openai') && <SetRow id="apiBase" title={labelOf('apiBase')} control={c.text('apiBase', labelOf('apiBase'), 'https://…', ro)} />}
      {svc === 'chatgpt' ? (
        <ChatgptRow />
      ) : (
        <SetRow
          id="apikey"
          title={labelOf('apikey')}
          desc={cfg?.has_key ? `仅传至后台服务并加密存入${getBridge().platform === 'windows' ? '系统凭据存储' : '系统钥匙串'}，不回显` : '尚未保存'}
          descTone={cfg?.has_key ? undefined : 'attention'}
          control={
            cfg?.has_key && !replacing ? (
              <>
                <Masked>已保存</Masked>
                <Btn disabled={ro} onClick={() => setReplacing(true)}>
                  更换
                </Btn>
              </>
            ) : (
              <>
                <Field type="password" label="API Key" placeholder={cfg?.has_key ? '输入新 Key 以更换' : '粘贴 API Key'} value={key} disabled={ro} onChange={setKey} />
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
  const testText = test.state === 'testing' ? '连接测试中…' : test.state === 'idle' ? '未连接' : test.text;
  return (
    <Frame n={2}>
      {agentdOff && !restarting && (
        <ErrBar
          message="后台服务未运行，账号配置暂为只读"
          extra={<Btn onClick={g.retryAgentd}>重新连接</Btn>}
        />
      )}
      {restarting && <ErrBar tone="warning" message="正在重启后台服务，就绪后可恢复编辑账号配置" />}
      <Band plugin="light_ai" fold="模型提供方、账号、测试连接">
        <SettingsCtx.Provider value={{ ...ctx, ro, roReason: restarting ? '正在重启后台服务' : '后台服务未运行' }}>
          <AccountRows />
          <SetRow
            id="mtest"
            title={labelOf('mtest')}
            indent
            desc={test.state === 'ok' ? '模型连接正常，可正常对话' : connected ? '发送一条测试请求以验证模型连通性' : '请先连接账号后再测试'}
            descTone={test.state === 'ok' ? 'ok' : undefined}
            control={
              <>
                <StatusLamp size="sm" state={testTone} label={testText} />
                <Btn loading={test.state === 'testing'} disabled={ro || !connected} disabledReason="请先连接账号" onClick={runTest}>
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
    ['角色', her ? <StatusLamp size="sm" state={DESK[o.desk][0]} label={o.desk === 'here' ? `${her.name} 已在桌面运行` : `${her.name} │ ${DESK[o.desk][1]}`} /> : <StatusLamp size="sm" state="idle" label="未选择角色" />, !her && <Btn variant="link" onClick={() => goto(1)}>导入</Btn>],
    [
      '对话',
      !g.talks ? <StatusLamp size="sm" state="stopped" label="未启用（仅桌面陪伴）" /> : ready ? <StatusLamp size="sm" state="ok" label={`已连接 │ ${g.service ?? ''}`} /> : <StatusLamp size="sm" state="waiting" label="未连接账号" />,
      g.talks && !ready && <Btn variant="link" onClick={() => goto(2)}>前往配置</Btn>,
    ],
    [
      '语音播报',
      her && !her.voice ? <StatusLamp size="sm" state="idle" label="无配套声线（仅文字）" /> : g.talks && g.ctx.diag.voice != null && !g.ctx.diag.voiceNone && g.ctx.diag.voice?.state === 'ready' ? <StatusLamp size="sm" state="ok" label="外部语音服务已连接" /> : <StatusLamp size="sm" state="idle" label="仅文字回复" />,
      null,
    ],
    [
      '按住语音输入',
      !g.talks ? <StatusLamp size="sm" state="stopped" label="对话未启用" /> : missing.length ? <StatusLamp size="sm" state="waiting" label={`缺少${missing.map((p) => p.label).join('、')}权限`} /> : <StatusLamp size="sm" state="ok" label="已就绪" />,
      g.talks && missing.length > 0 && <Btn variant="link" onClick={() => goto(3)}>前往授权</Btn>,
    ],
  ];
  return (
    <div className={styles.done}>
      <div className={styles.desk} data-g="frame" aria-hidden="true">
        <span className={styles.wm}>{her?.name}</span>
        {her && (
          <span className={styles.fig}>
            <CharacterArt src={her.head} kind="head" w={220} h={300} fallback={<DrawnHead id={her.id} />} />
          </span>
        )}
        <span className={styles.line} />
        <span className={styles.here}>
          {her ? <StatusLamp size="sm" state={DESK[o.desk][0]} label={DESK[o.desk][1]} /> : <StatusLamp size="sm" state="idle" label="当前桌面未加载角色" />}
          <MicroLabel>Desk / Live</MicroLabel>
        </span>
      </div>
      <div className={styles.side} data-g="text">
        <span className={styles.mi}>
          <MicroLabel>Setup Complete 04 / 04</MicroLabel>
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
        <Slab id="calls" variant="plate" title={`与${her?.name ?? '角色'}交互方式`}>
          <div className={styles.calls}>
            <div className={styles.call}>
              <span className={styles.how}>
                <Mouse side="left" />
                左键点击角色
              </span>
              <b>互动与触碰反馈</b>
            </div>
            <div className={styles.call}>
              <span className={styles.how}>
                <Mouse side="right" />
                右键点击角色
              </span>
              <b>快捷轮盘</b>
            </div>
            <div className={styles.call}>
              <KeyCell keys={quick ? capsOf(hotkeyText(quick)) : undefined} none={quick === ''} />
              <b>{g.talks ? '打开对话' : '快速输入'}</b>
            </div>
          </div>
        </Slab>
      </div>
    </div>
  );
}

