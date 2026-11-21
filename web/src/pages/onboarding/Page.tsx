import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { getBridge, type CharacterEntry } from '../../bridge';
import { navigate, type NavTarget } from '../../shell/nav';
import { toast } from '../../shell/toast';
import { Btn, CharacterArt, ErrBar, Frosted, Icon } from '../../ui';
import { useOverlayFocus } from '../../ui/Dialog';
import { hostReason } from '../character/labels';
import { useAttended } from '../home/watchMotion';
import { Loading, MediaArrow } from './Bits';
import { Companion } from './Companion';
import { contourUrl } from './contour';
import { NO_CHARACTER_STEPS, STEPS, footHint, keyLabel, pad2, readyLead, type Perm, type ViewStep } from './copy';
import { MediaIn, Primary, useGuideMotion } from './guideMotion';
import { HooksStep } from './Hooks';
import { KernelBlock } from './Kernel';
import { PermsOutline, PermsStep } from './Perms';
import { Ready } from './Ready';
import { useOnboarding, type Onboarding } from './useOnboarding';
import { VoiceStep, type Profile } from './Voice';
import styles from './Page.module.css';

/** 首次引导：full-screen title screen over the shell, opened by the native guide window as main.html#/onboarding. */
export function OnboardingPage() {
  const o = useOnboarding();
  // The content area sits in the shell's stacking context, under the sidebar; the guide covers the whole window.
  return createPortal(<Guide o={o} />, document.body);
}

let contour: string | undefined;

function exit(message: string, to: NavTarget = { page: 'overview' }) {
  toast(message);
  navigate(to);
}

/** Step 1: the installed characters (shown only; the guide cannot switch) and 导入 as the last cell. */
function ImportRoster({ characters, current, onImported }: { characters: CharacterEntry[]; current: string | null; onImported: () => void }) {
  const importPackage = () =>
    void getBridge()
      .character.importPackage()
      .then(
        (r) => {
          if (r.ok) {
            toast('已导入角色');
            onImported();
          } else if (r.reason === 'cancelled') toast('已取消导入');
          else toast(`导入没有完成：${hostReason(r.reason)}`, { severity: 'danger', persistent: true });
        },
        (e: unknown) =>
          toast(`导入没有完成：${(e as { code?: string } | null)?.code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' }),
      );
  return (
    <section className={styles.welcomeRole} aria-label="角色">
      <ul className={styles.roster} aria-label="角色名册">
        {characters.map((c) => (
          <li key={c.id} className={styles.rc} aria-current={c.id === current ? 'true' : undefined}>
            <span className={styles.rcArt} aria-hidden="true">
              <CharacterArt src={c.head} kind="head" w={60} h={83} fallback={null} />
            </span>
            <span className={styles.rcName}>{c.name}</span>
          </li>
        ))}
      </ul>
      <button type="button" className={`${styles.rc} ${styles.add}`} onClick={importPackage}>
        <Icon name="plus" size={14} />
        <span className={styles.rcName}>导入</span>
      </button>
    </section>
  );
}

function Guide({ o }: { o: Onboarding }) {
  const { s, run } = o;
  const step: ViewStep = o.ready ? 4 : (s?.step ?? 1);
  const noCharacters = o.characters?.length === 0;
  const C = noCharacters ? { ...STEPS[step], ...NO_CHARACTER_STEPS[step] } : STEPS[step];
  const perms = s?.permissions ?? [];
  const hooks = s?.hooks ?? [];
  const granted = perms.filter((p) => p.state === 'granted').length;
  const hooked = hooks.filter((h) => h.connected).length;
  const keycap = keyLabel(s?.talkKey ?? 'right_option');
  const [profile, setProfile] = useState<Profile>({ callName: '', birthday: '' });
  const [showPermissions, setShowPermissions] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trapFocus = useOverlayFocus(panel, undefined);
  const out = useGuideMotion(panel);
  const leave = (message: string, to?: NavTarget) => void out.play().then(() => exit(message, to));
  const attended = useAttended();
  const media = useRef<HTMLDivElement>(null);
  const savedName = s?.callName;
  const savedDay = s?.birthday;
  useEffect(() => {
    if (savedName !== undefined && savedDay !== undefined) setProfile({ callName: savedName, birthday: savedDay });
  }, [savedName, savedDay]);
  const name = profile.callName.trim();

  const open = (p: Perm) => void run('permission', (ops) => ops.openSettings(p.kind));
  const backTo = (n: number) => {
    const times = (o.ready ? 3 : step) - n;
    o.setReady(false);
    if (times > 0)
      void run('back', async (ops) => {
        let r = await ops.back();
        for (let i = 1; i < times; i += 1) r = await ops.back();
        return r;
      });
  };
  const next = () => {
    if (step === 1) void run('advance', (ops) => ops.advance());
    else if (step === 2) void run('advance', (ops) => ops.advance({ callName: profile.callName, birthday: profile.birthday }));
    else if (step === 3) o.setReady(true);
  };
  const skip = () => {
    if (step === 1) void run('skip', (ops) => ops.skip()).then((r) => r && leave('可在 设置 › 启动与关于 重新运行首次设置'));
    else if (step === 2) void run('skip', (ops) => ops.skip());
    else if (step === 3) o.setReady(true);
  };
  const complete = (destination: 'home' | 'chat' | 'privacy' | 'model', to: NavTarget) =>
    void run('complete', (ops) => ops.complete(destination)).then((r) => r && !r.completionError && leave('首次设置已完成', to));

  const tally = s
    ? [(showPermissions || step > 1) && `${granted}/${perms.length} 已允许`, step >= 2 && name && `称呼 ${name}`, step >= 3 && `${hooked}/${hooks.length} 已接入`].filter((t): t is string => !!t)
    : [];
  // The media panel opens once the state is read; later page turns replay its entrance faster.
  const at = s ? step : 0;
  const [shown, setShown] = useState({ at, turned: false });
  if (shown.at !== at) setShown({ at, turned: shown.at !== 0 });
  const saved = step === 2 ? s?.saveError : step === 4 ? s?.completionError : null;
  const hint = footHint(step, perms, o.opError ?? saved ?? null);
  const welcome = step === 1 && s;
  const actions = s && step < 4 && (
    <>
      <Btn variant="secondary" disabled={!s.canSkip} disabledReason="这一步现在不能跳过" loading={o.busy === 'skip'} onClick={skip}>
        {C.skip}
      </Btn>
      <Primary>
        <Btn variant="primary" disabled={!s.canAdvance} disabledReason="完成这一步的必需项后才能继续" loading={o.busy === 'advance'} onClick={next}>
          {C.next}
        </Btn>
      </Primary>
    </>
  );

  let body = null;
  if (!s)
    body = o.loadError ? (
      <>
        <ErrBar message={o.loadError} onRetry={o.reload} />
        <PermsOutline />
      </>
    ) : (
      <Loading tip="正在读取权限和接入状态…" />
    );
  else if (step === 1) body = (
    showPermissions ? <PermsStep perms={perms} onOpen={open} /> : (
      <ImportRoster characters={o.characters ?? []} current={o.characterId} onImported={o.readCharacters} />
    )
  );
  else if (step === 2)
    body = (
      <>
        <VoiceStep mic={perms.find((p) => p.kind === 'microphone')} trial={o.trial ?? s.trial} keycap={keycap} profile={profile} onProfile={setProfile} onOpen={open}
          onRequest={() => void run('permission', (ops) => ops.requestPermission('microphone'))} />
        <Companion />
      </>
    );
  else if (step === 3)
    body = (
      <>
        <KernelBlock onUseApiKey={() => complete('model', { page: 'settings', group: 'model' })} />
        <HooksStep hooks={hooks} checkedAt={s.hooksCheckedAt} rechecking={o.busy === 'recheck'} onRecheck={() => void run('recheck', (ops) => ops.state())} />
      </>
    );

  return (
    <div
      className={styles.onb}
      style={{ '--onb-contour': (contour ??= contourUrl(480, 240, 3.4)) } as CSSProperties}
      data-step={step}
      data-attended={attended || undefined}
      ref={panel} tabIndex={-1} onKeyDown={trapFocus}
      role="dialog" aria-modal="true" aria-label={`首次设置 │ ${C.title}`} data-page="onboarding">
      <span className={styles.ctr} aria-hidden="true" />
      <span className={styles.blur} data-g="blur" aria-hidden="true">
        <Frosted blur={12} tint={0.5} />
      </span>
      <span className={`${styles.ramp} popup_media2_5`} data-g="ramp" aria-hidden="true" />
      <header className={styles.top}>
        <b className={styles.mark} aria-hidden="true">
          ENDFIELD
        </b>
        <span className={styles.sp} />
        <span className={styles.cap}>首次设置</span>
        {tally.length > 0 && (
          <ul className={styles.tally} aria-label="设置进度">
            {tally.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        )}
      </header>
      {step === 4 && s ? (
        <Ready id={o.characterId} name={s.characterName} title={C.title} lead={noCharacters ? C.lead : readyLead(keycap)} perm={`${granted} / ${perms.length}`} callName={name} hooks={`${hooked} / ${hooks.length}`} busy={o.busy === 'complete'} onOpen={() => complete('chat', { page: 'chat' })} onPrivacy={() => complete('privacy', { page: 'settings', group: 'privacy', item: 'wintext' })} />
      ) : (
        <div key={at} ref={media} className={styles.main} data-welcome={welcome ? '' : undefined} data-permissions={welcome && showPermissions ? '' : undefined}>
          <MediaIn root={media} turned={shown.turned} />
          <div className={styles.stage}>
            <MediaArrow side="left" label="上一页" edge={step === 1} disabled={step === 1 || !s} onClick={() => backTo(step - 1)} />
            <div className={`${styles.frame} media-frame`} data-g="frame">
              <span className={styles.bar} data-side="left" data-g="sideL" aria-hidden="true" />
              <span className={styles.bar} data-side="right" data-g="sideR" aria-hidden="true" />
              <span className={styles.tick} data-side="left" data-g="sideLTick" aria-hidden="true" />
              <span className={styles.tick} data-side="right" data-g="sideRTick" aria-hidden="true" />
              <span className={`${styles.pic02} media-ticks`} data-g="ticks" aria-hidden="true" />
              <div className={`${styles.media} media-edge`} data-g="media">{body}</div>
            </div>
            <MediaArrow side="right" label="下一页" disabled={!s?.canAdvance} onClick={next} />
          </div>
          <span className={styles.index} data-g="index" aria-label={`第 ${step} 步，共 4 步`}>
            {pad2(step)}/04
          </span>
          <div className={styles.text} data-g="text">
            <h1 className={styles.h1} data-g="title">{C.title}</h1>
            <span className={styles.rule} data-g="rule" aria-hidden="true">
              <i className={`${styles.pic05} rule-cap`} data-g="ruleLine" />
              <i className={`${styles.pic03} rule-dashes`} data-g="ruleLine2" />
            </span>
            <p className={styles.lead}>{C.lead}</p>
          </div>
          {welcome && (
            <button type="button" className={styles.permissionsLink} aria-expanded={showPermissions} onClick={() => setShowPermissions(!showPermissions)}>
              {showPermissions ? '收起权限说明' : '查看可选权限'}
            </button>
          )}
        </div>
      )}
      <footer className={styles.foot}>
        {step > 1 && s && (
          <Btn variant="text" onClick={() => backTo(step - 1)}>
            上一步
          </Btn>
        )}
        <span className={styles.hint} data-g="hint" data-danger={hint.danger || undefined} role={hint.danger ? 'alert' : undefined} title={hint.text}>
          {hint.text}
        </span>
        <span className={styles.sp} />
        {!s && o.loadError && (
          <Btn variant="secondary" loading={o.busy === 'skip'} onClick={skip}>
            {C.skip}
          </Btn>
        )}
        {actions}
      </footer>
    </div>
  );
}
