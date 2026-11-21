import { useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { getBridge, type CharacterEntry, type OnboardingCompanion } from '../../bridge';
import { navigate, type NavTarget } from '../../shell/nav';
import { toast } from '../../shell/toast';
import { Btn, CharacterArt, ErrBar, Frosted, Icon } from '../../ui';
import { useOverlayFocus } from '../../ui/Dialog';
import { hostReason } from '../character/labels';
import { useAttended } from '../home/watchMotion';
import { Loading } from './Bits';
import { contourUrl } from './contour';
import { COMPANIONS, NO_CHARACTER_STEPS, STEPS, footHint, pad2, type ViewStep } from './copy';
import { MediaIn, Primary, useGuideMotion } from './guideMotion';
import { Ready } from './Ready';
import { useOnboarding, type Onboarding } from './useOnboarding';
import styles from './Page.module.css';

/** 首次引导：full-screen title screen over the shell, opened by the native guide window as main.html#/onboarding. */
export function OnboardingPage() {
  const o = useOnboarding();
  // The content area sits in the shell's stacking context, under the sidebar; the guide covers the whole window.
  return createPortal(<Guide o={o} />, document.body);
}

let contour: string | undefined;

/** Where the page goes once the guide is done (the browser preview); the native window closes and opens the main window itself. */
const LANDING: Record<OnboardingCompanion | 'plugins', NavTarget> = {
  pet: { page: 'character' },
  chat: { page: 'settings', group: 'model' },
  plugins: { page: 'settings', group: 'plugins' },
};

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

/** Step 2: 只陪伴 or 陪伴加对话, a name and one line each. */
function CompanionChoice({ value, onChange }: { value: OnboardingCompanion | null; onChange: (c: OnboardingCompanion) => void }) {
  return (
    <div className={styles.choices} role="radiogroup" aria-label={STEPS[2].title}>
      {COMPANIONS.map((c) => (
        <button key={c.id} type="button" role="radio" aria-checked={value === c.id} className={styles.choice} data-companion={c.id} onClick={() => onChange(c.id)}>
          <b className={styles.choiceName}>{c.name}</b>
          <span className={styles.choiceLine}>{c.line}</span>
        </button>
      ))}
    </div>
  );
}

function Guide({ o }: { o: Onboarding }) {
  const { s, run } = o;
  const step: ViewStep = s?.step ?? 1;
  const noCharacters = o.characters?.length === 0;
  const C = noCharacters ? { ...STEPS[step], ...NO_CHARACTER_STEPS[step] } : STEPS[step];
  const [companion, setCompanion] = useState<OnboardingCompanion | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trapFocus = useOverlayFocus(panel, undefined);
  const out = useGuideMotion(panel);
  const attended = useAttended();
  const media = useRef<HTMLDivElement>(null);

  const back = () => void run('back', (ops) => ops.back());
  const next = () => void run('advance', (ops) => ops.advance());
  const complete = (destination?: 'plugins') => {
    if (!companion) return;
    void run('complete', (ops) => ops.complete(destination ? { companion, destination } : { companion })).then((r) => {
      if (!r || r.completionError) return;
      void out.play().then(() => {
        toast('首次设置已完成');
        navigate(LANDING[destination ?? companion]);
      });
    });
  };

  // The media panel opens once the state is read; later page turns replay its entrance faster.
  const at = s ? step : 0;
  const [shown, setShown] = useState({ at, turned: false });
  if (shown.at !== at) setShown({ at, turned: shown.at !== 0 });
  const hint = footHint(step, o.opError ?? (step === 3 ? s?.completionError : null) ?? null);
  const unchosen = step === 2 && companion === null;

  let body = null;
  if (!s) body = o.loadError ? <ErrBar message={o.loadError} onRetry={o.reload} /> : <Loading tip="正在读取首次设置…" />;
  else if (step === 1) body = <ImportRoster characters={o.characters ?? []} current={o.characterId} onImported={o.readCharacters} />;
  else if (step === 2) body = <CompanionChoice value={companion} onChange={setCompanion} />;

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
          Agentic Complex
        </b>
        <span className={styles.sp} />
        <span className={styles.cap}>首次设置</span>
      </header>
      {step === 3 && s ? (
        <Ready id={o.characterId} name={s.characterName} title={C.title} lead={C.lead} busy={o.busy === 'complete'} onPlugins={() => complete('plugins')} />
      ) : (
        <div key={at} ref={media} className={styles.main}>
          <MediaIn root={media} turned={shown.turned} />
          <div className={`${styles.frame} media-frame`} data-g="frame">
            <span className={styles.bar} data-side="left" data-g="sideL" aria-hidden="true" />
            <span className={styles.bar} data-side="right" data-g="sideR" aria-hidden="true" />
            <span className={styles.tick} data-side="left" data-g="sideLTick" aria-hidden="true" />
            <span className={styles.tick} data-side="right" data-g="sideRTick" aria-hidden="true" />
            <span className={`${styles.pic02} media-ticks`} data-g="ticks" aria-hidden="true" />
            <div className={`${styles.media} media-edge`} data-g="media">{body}</div>
          </div>
          <span className={styles.index} data-g="index" aria-label={`第 ${step} 步，共 3 步`}>
            {pad2(step)}/03
          </span>
          <div className={styles.text} data-g="text">
            <h1 className={styles.h1} data-g="title">{C.title}</h1>
            <span className={styles.rule} data-g="rule" aria-hidden="true">
              <i className={`${styles.pic05} rule-cap`} data-g="ruleLine" />
              <i className={`${styles.pic03} rule-dashes`} data-g="ruleLine2" />
            </span>
            <p className={styles.lead}>{C.lead}</p>
          </div>
        </div>
      )}
      <footer className={styles.foot}>
        {step > 1 && s && (
          <Btn variant="text" disabled={o.busy !== null} onClick={back}>
            上一步
          </Btn>
        )}
        <span className={styles.hint} data-g="hint" data-danger={hint.danger || undefined} role={hint.danger ? 'alert' : undefined} title={hint.text}>
          {hint.text}
        </span>
        <span className={styles.sp} />
        {s && (
          <Primary>
            {step < 3 ? (
              <Btn variant="primary" disabled={!s.canAdvance || unchosen} disabledReason={unchosen ? '先选一种陪伴方式' : '这一步现在不能继续'}
                loading={o.busy === 'advance'} onClick={next}>
                {C.next}
              </Btn>
            ) : (
              <Btn variant="primary" disabled={companion === null || s.done} disabledReason="回到上一步选一种陪伴方式" loading={o.busy === 'complete'}
                onClick={() => complete()}>
                {C.next}
              </Btn>
            )}
          </Primary>
        )}
      </footer>
    </div>
  );
}
