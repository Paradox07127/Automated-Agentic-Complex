import { useRef, useState, type CSSProperties } from 'react';
import type { OnboardingDestination, OnboardingStep } from '../../bridge';
import { navigate } from '../../shell/nav';
import { toast } from '../../shell/toast';
import { Btn, ErrBar, InfoTip, Tabs } from '../../ui';
import { ActionBar, MicroLabel, StatusLamp, YellowKey } from '../../ui/game';
import { SettingsCtx } from '../settings/ctx';
import { SettingsOverlays } from '../settings/SettingsOverlays';
import page from '../settings/Page.module.css';
import { Loading } from './Bits';
import { contourUrl } from './contour';
import { STEPS, STEP_IDS, pad2 } from './copy';
import { GuideCard } from './GuideCard';
import { MediaIn, Primary, useGuideMotion } from './guideMotion';
import { Frame, StepChar, StepChat, StepDone } from './Steps';
import { StepVoice } from './StepVoice';
import { stepMarks } from './marks';
import { GUIDE_PERMS, useGuideSettings, type GuideSettings } from './useGuideSettings';
import { useOnboarding, type Onboarding } from './useOnboarding';
import styles from './Page.module.css';

/** 首次设置: the native guide window opens main.html#/onboarding; every row saves the same value the settings page does. */
export function OnboardingPage() {
  const o = useOnboarding();
  const g = useGuideSettings();
  return (
    <SettingsCtx.Provider value={g.ctx}>
      <Guide o={o} g={g} />
      <SettingsOverlays />
    </SettingsCtx.Provider>
  );
}

let contour: string | undefined;

function Guide({ o, g }: { o: Onboarding; g: GuideSettings }) {
  const { s, run } = o;
  const step: OnboardingStep = s?.step ?? 1;
  const root = useRef<HTMLDivElement>(null);
  const media = useRef<HTMLDivElement>(null);
  const out = useGuideMotion(root);
  const roster = o.characters?.length ?? 0;
  const missing = g.ctx.perms.filter((p) => GUIDE_PERMS.includes(p.kind) && (p.state === 'denied' || p.state === 'notDetermined'));
  const chatReady = !g.talks || g.test.state === 'ok';
  const marks = s ? stepMarks(s, { chat: !chatReady, voice: g.talks && missing.length > 0 }) : null;
  const canNext = step === 1 ? roster > 0 : step === 2 ? chatReady : step === 3;
  const live = !!s && !s.done;

  // The panel opens once the state is read; later page turns replay its entrance faster.
  const at = s ? step : 0;
  const [shown, setShown] = useState({ at, turned: false });
  if (shown.at !== at) setShown({ at, turned: shown.at !== 0 });

  /** The guide closes itself in the shell; the browser preview goes on to 主页. */
  const leave = () =>
    void out.play().then(() => {
      if (window.agenticComplex) return;
      toast('首次设置已完成');
      navigate({ page: 'home' });
    });
  const advance = (skip = false) => void run('advance', (ops) => ops.advance(skip ? { skip: true } : undefined));
  const back = () => void run('back', (ops) => ops.back());
  const goto = (n: OnboardingStep) => void run('goto', (ops) => ops.goto(n));
  const complete = (destination?: OnboardingDestination) =>
    void run('complete', (ops) => ops.complete(destination ? { destination } : undefined)).then((r) => r?.done && leave());
  const askSkip = () =>
    g.ctx.model.ask({
      title: '跳过首次设置？',
      list: [`已经选的会保留：${o.current?.name ?? '—'}、对话${g.talks ? '开着' : '关着'}`, '还没设的用默认：账号没连、只显示文字、按住说话没开'],
      note: '这些都在设置里，随时可以改；「设置 › 关于 › 重新运行首次设置」可以再走一遍。',
      cancelLabel: '继续设置',
      confirmLabel: '跳过',
      onConfirm: async () => {
        const r = await run('skip', (ops) => ops.skip());
        if (r?.done) leave();
      },
    });
  // A step cell or E onto the next step passes this one, as 下一步 does; any other cell only jumps.
  const onTab = (id: string) => {
    const n = Number(id) as OnboardingStep;
    if (!live || n === step) return;
    if (n === step + 1 && canNext) advance();
    else goto(n);
  };

  const C = STEPS[step];
  let body;
  if (!s)
    body = (
      <section className={styles.step}>
        <GuideCard n={0} title="首次设置" />
        <Frame n={1}>{o.loadError ? <ErrBar message={o.loadError} onRetry={o.reload} /> : <Loading tip="正在读取首次设置…" />}</Frame>
      </section>
    );
  else if (step === 4) body = <StepDone o={o} g={g} missing={missing} goto={goto} />;
  else
    body = (
      <section className={styles.step}>
        <GuideCard n={step} en={C.en} title={C.title} lead={C.lead} tag={step === 1 && roster > 0 ? 'must' : 'skip'} />
        {step === 1 ? <StepChar o={o} /> : step === 2 ? <StepChat g={g} /> : <StepVoice g={g} her={o.current} />}
      </section>
    );

  const next = (reason: string) => (
    <Primary>
      <YellowKey label="下一步" micro="Next" icon="chev" busy={o.busy === 'advance'} disabled={!canNext} disabledReason={reason} onClick={() => advance()} />
    </Primary>
  );
  let right = null;
  if (live && step === 1) right = roster > 0 ? next('') : <>
      <Btn onClick={() => advance(true)}>先不导入</Btn>
      {next('先导入一个角色包，或点「先不导入」')}
    </>;
  if (live && step === 2)
    right = chatReady ? next('') : <>
      <Btn onClick={() => advance(true)}>稍后再连</Btn>
      {next('先连上账号并测试通过，或点「稍后再连」')}
    </>;
  if (live && step === 3) right = next('');
  if (live && step === 4) {
    const talk = g.talks && g.test.state === 'ok';
    right = (
      <>
        <Btn go disabled={o.busy !== null} onClick={() => complete('home')}>
          打开主窗口
        </Btn>
        <Primary>
          <YellowKey label={talk ? '和她聊几句' : '完成'} micro={talk ? 'Talk' : 'Done'} icon={talk ? 'g-chat' : 'check'} busy={o.busy === 'complete'} onClick={() => complete(talk ? 'talk' : undefined)} />
        </Primary>
      </>
    );
  }
  const error = o.opError ?? s?.completionError ?? null;
  const lamp = g.restarting ? (['running', '正在重启后台'] as const) : g.agentdOff ? (['broken', '后台没有运行'] as const) : (['ok', '后台'] as const);

  return (
    <div ref={root} className={styles.root} data-page="onboarding" data-step={s ? step : undefined} role="region" aria-label={`首次设置 │ ${s && step === 4 ? '完成' : C.title}`}>
      <div className={page.page}>
        <div className={page.wall} data-g="blur" data-theme="dark" aria-hidden="true" />
        <div className={styles.win}>
          <header className={styles.cmd} data-theme="dark">
            <span className={styles.brand}>
              <b>首次设置</b>
              <MicroLabel>Setup / Agentic Complex</MicroLabel>
            </span>
            <nav className={styles.plate} aria-label="首次设置的步骤">
              {marks && (
                <Tabs
                  variant="steps"
                  label="首次设置的步骤"
                  value={String(step)}
                  onChange={onTab}
                  tabs={STEP_IDS.map((n) => ({ id: String(n), label: STEPS[n].label, icon: STEPS[n].icon, step: marks[n], ariaLabel: `${pad2(n)} ${STEPS[n].label}` }))}
                />
              )}
            </nav>
            <span className={styles.rt}>
              <span className={styles.lamp} title="后台服务">
                <StatusLamp state={lamp[0]} label={lamp[1]} onDark />
              </span>
              <Btn disabled={!live} onClick={askSkip}>
                跳过引导
              </Btn>
            </span>
          </header>
          <i className={styles.tri} aria-hidden="true" />
          <div className={styles.stage} style={{ '--guide-contour': (contour ??= contourUrl(900, 700, 3.4)) } as CSSProperties}>
            <div key={at} ref={media} className={styles.view}>
              <MediaIn root={media} turned={shown.turned} />
              {body}
            </div>
          </div>
          <ActionBar
            label="首次设置操作"
            micro="Setup"
            left={
              <>
                {live && step > 1 && (
                  <Btn label="上一步" disabled={o.busy !== null} onClick={back}>
                    ‹ 上一步
                  </Btn>
                )}
                {error && (
                  <>
                    <span className={styles.hint} data-g="hint" data-tone="bad" role="alert">
                      {error}
                    </span>
                    {/* The line is cut short in a narrow bar; the ⓘ holds all of it. */}
                    <InfoTip>{error}</InfoTip>
                  </>
                )}
              </>
            }
            right={right}
          />
        </div>
      </div>
    </div>
  );
}
