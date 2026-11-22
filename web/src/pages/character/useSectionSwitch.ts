// Section switches of the character area (PhaseCharInfo.OnPageChange): the leaving section plays its out clip, the wait is
// max(200 ms, out), then the entering section plays its in clip; a new switch cancels the run. The rail and the stage stay.
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { gameClips, type GameClip } from '../../design/gameClips.generated';
import { animate, fxCalm } from '../../ui/fx/motion';

/** waitOutDuration's floor. */
const WAIT = 200;
/** charinfoprofile_in's block starts (top, right, content, left). */
const BLOCKS = [0, 83, 167, 333];
/** charinfo_talent_first_in starts its five rows 50 ms apart; later rows start with the fifth. */
const ROW = 50;
const ROWS_STAGGERED = 5;
const ROW_SEL = '[data-motion], [data-look], [data-layer], [data-imported-motion], [data-mmd], [id^="set-"]';

/** The tracks of `key` on the part itself, or with no key every track on its `[data-g]` nodes under the part. */
type Use = { clip: GameClip; key?: string };

interface PartSpec {
  sel: string;
  out: Use;
  in: Use;
  /** The in clip runs on the part's blocks, staggered, and its rows follow. */
  staggered?: boolean;
}

const c = gameClips;
/** What each section draws besides the stage and the rail, found under the operator view. */
const PARTS: readonly PartSpec[] = [
  // 总览: the head strip, heads and roster keys (charlistnode out; charlistnode_in, charinfo_in), the name block (gyroscoperoot
  // LeftNode out, charinfobasic_in), the yellow block (gyroscoperoot DetailNode out, charinfo_in).
  { sel: ':scope > [data-g="listSide"] > [role="group"]', out: { clip: c.charListOut, key: 'root' }, in: { clip: c.charListIn, key: 'root' } },
  { sel: ':scope > [data-g="listSide"] > [data-g="bottomMenu"]', out: { clip: c.charListOut, key: 'root' }, in: { clip: c.charInfoIn, key: 'bottomMenu' } },
  { sel: ':scope [data-stage][data-mode="overview"] > [data-g="info"]', out: { clip: c.charGyroOut, key: 'left' }, in: { clip: c.charBasicIn } },
  { sel: ':scope > [data-switch="brand"]', out: { clip: c.charGyroOut, key: 'detail' }, in: { clip: c.charInfoIn, key: 'detail' } },
  // Detail sections: the right panel (charinfoweapon_right), the bars under the stage (charlistnew).
  { sel: '[data-switch="panel"]', out: { clip: c.charRightOut, key: 'panel' }, in: { clip: c.charRightIn, key: 'panel' }, staggered: true },
  { sel: '[data-switch="band"]', out: { clip: c.charListNewOut, key: 'band' }, in: { clip: c.charListNewIn, key: 'band' } },
];

type Phase = 'idle' | 'out' | 'gap' | 'in';

interface Run {
  /** The section the page is on. */
  to: string;
  /** The section whose scene is drawn. */
  shown: string;
  phase: Phase;
  n: number;
  /** It cut a run that was drawing: the parts it finds mid-out come in from where they stand. */
  cut: boolean;
}

/** Calm, or no Web Animations (jsdom): nothing plays, so nothing waits. */
const instant = () => fxCalm() || typeof document.body.animate !== 'function';

const frames = (t: GameClip['tracks'][number]): Keyframe[] => t.keyframes.map((k) => ({ offset: k.offset, easing: k.easing, [t.property]: k.value }));

/** Plays `use` on el after `delay`; `from` replaces the first frame of el's own tracks (a run cut mid-way). */
function play(el: Element, use: Use, delay: number, fill: FillMode, from?: Record<string, string>): Animation[] {
  const runs: Animation[] = [];
  for (const t of use.clip.tracks) {
    const on = use.key != null ? (t.key === use.key ? [el] : []) : [...(el.matches(`[data-g="${t.key}"]`) ? [el] : []), ...el.querySelectorAll(`[data-g="${t.key}"]`)];
    for (const node of on) {
      const kf = frames(t);
      const now = node === el ? from?.[t.property] : undefined;
      if (now) kf[0] = { ...kf[0], [t.property]: now };
      const a = animate(node, kf, { duration: use.clip.duration, delay, fill });
      if (a) runs.push(a);
    }
  }
  return runs;
}

/** The parts of the drawn section under root. */
const found = (root: Element) => PARTS.flatMap((spec) => [...root.querySelectorAll(spec.sel)].map((el) => ({ el, spec })));

/** Rows of a staggered part that are in its box, in document order. */
function rows(el: Element): Element[] {
  const box = el.getBoundingClientRect();
  return [...el.querySelectorAll(ROW_SEL)].filter((r) => {
    const b = r.getBoundingClientRect();
    return b.height > 0 && b.bottom > box.top && b.top < box.bottom;
  });
}

/**
 * The section sequencer. `key` and `scene` are the section the page is on and what it draws; it returns the scene to draw
 * now (the leaving one until its out clip and the wait are over) and whether its parts are drawn (not during the wait).
 * The in clip's length goes to `--switch-in` on root, for the stage's own easing.
 */
export function useSectionSwitch<S>(key: string, scene: S, root: RefObject<HTMLElement | null>): { scene: S; parts: boolean } {
  const [run, setRun] = useState<Run>({ to: key, shown: key, phase: 'idle', n: 0, cut: false });
  const kept = useRef(scene);
  const outs = useRef(new Map<Element, Animation[]>());
  const ins = useRef(new Set<Element>());
  if (key !== run.to) {
    const n = run.n + 1;
    if (instant()) setRun({ to: key, shown: key, phase: 'idle', n, cut: false });
    else if (run.phase === 'idle') setRun({ to: key, shown: run.shown, phase: 'out', n, cut: false });
    else setRun({ to: key, shown: key, phase: 'in', n, cut: run.phase !== 'gap' });
  }
  const current = run.shown === run.to;
  // Out and the wait are one step: its timers live until the in clip or a new switch.
  const waiting = run.phase === 'out' || run.phase === 'gap';
  const entering = run.phase === 'in';

  useLayoutEffect(() => {
    if (current) kept.current = scene;
  });

  // What stayed of the leaving section (a node both draw, the stage's name column that is now its status slot) goes back to
  // rest: live, its out clip gone.
  const rest = () => {
    for (const [part, a] of outs.current) {
      part.toggleAttribute('inert', false);
      for (const x of a) x.cancel();
    }
    outs.current.clear();
  };

  // A switch that went to idle at once (reduced motion turned on mid-way) plays no in clip.
  useLayoutEffect(() => {
    if (run.phase === 'idle') rest();
  }, [run.n, run.phase]);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !waiting) return;
    let out = 0;
    for (const { el: part, spec } of found(el)) {
      part.toggleAttribute('inert', true);
      outs.current.set(part, play(part, spec.out, 0, 'forwards'));
      out = Math.max(out, spec.out.clip.duration);
    }
    const n = run.n;
    const gone = setTimeout(() => setRun((r) => (r.n === n ? { ...r, phase: 'gap' } : r)), out);
    const next = setTimeout(() => setRun((r) => (r.n === n ? { ...r, shown: r.to, phase: 'in' } : r)), Math.max(WAIT, out));
    return () => {
      clearTimeout(gone);
      clearTimeout(next);
    };
  }, [run.n, waiting, root]);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !entering) return;
    const parts = found(el);
    // Set before anything reads layout, so the stage's transition starting in this frame takes it.
    const longest = Math.max(0, ...parts.map((p) => p.spec.in.clip.duration));
    if (longest) el.style.setProperty('--switch-in', `${Math.round(longest)}ms`);
    const runs: Animation[] = [];
    for (const { el: part, spec } of parts) {
      part.toggleAttribute('inert', false);
      const cut = run.cut ? outs.current.get(part) : undefined;
      let mine: Animation[];
      if (cut) {
        // Cut mid-out: the in clip starts where the out clip stands.
        const s = getComputedStyle(part);
        const from = { opacity: s.opacity, translate: s.translate };
        for (const a of cut) a.cancel();
        mine = play(part, spec.in, 0, 'backwards', from);
      } else if (ins.current.has(part)) {
        // Cut mid-in on a node both sections draw: it is already coming in.
        continue;
      } else if (spec.staggered) {
        mine = [...part.children].flatMap((b, i) => play(b, spec.in, BLOCKS[Math.min(i, BLOCKS.length - 1)]!, 'backwards'));
        rows(part).forEach((r, i) => mine.push(...play(r, { clip: c.charRowIn, key: 'row' }, ROW * Math.min(i, ROWS_STAGGERED - 1), 'backwards')));
      } else mine = play(part, spec.in, 0, 'backwards');
      ins.current.add(part);
      void Promise.all(mine.map((a) => a.finished.then(() => a.cancel(), () => undefined))).then(() => ins.current.delete(part));
      runs.push(...mine);
    }
    rest();
    const n = run.n;
    let live = true;
    void Promise.all(runs.map((a) => a.finished.catch(() => undefined))).then(() => live && setRun((r) => (r.n === n ? { ...r, phase: 'idle' } : r)));
    return () => {
      live = false;
    };
  }, [run.n, entering, run.cut, root]);

  return { scene: current ? scene : kept.current, parts: run.phase !== 'gap' };
}
