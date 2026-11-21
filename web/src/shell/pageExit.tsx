import { Component, type ReactNode, type RefObject } from 'react';
import { gameClips, type GameClip } from '../design/gameClips.generated';
import { fxCalm, playOnce } from '../ui/fx/motion';
import { runsEnd, startClip } from '../ui/ToggleClip';

/** The out clip each page plays on its leaving copy. */
const OUT: Partial<Record<string, GameClip>> = {
  home: gameClips.watchOut,
  overview: gameClips.missionOut,
  chat: gameClips.snsFriendOut,
  settings: gameClips.settingOut,
  character: gameClips.charInfoOut,
  memory: gameClips.prtsOut,
};

/** Pages without a clip, or whose clip finds none of its nodes, fade with missionOut's timing. */
const FADE = gameClips.missionOut;

export interface PageExitProps {
  /** Route id of the location; a change of search params alone keeps it. */
  id: string;
  /** The scrolling `.content` box the pages render into. */
  host: RefObject<HTMLElement | null>;
  children: ReactNode;
}

interface Copy {
  id: string;
  box: HTMLElement;
  ghost: HTMLElement;
}

/**
 * When the route id changes, the page that leaves stays on screen as an inert copy while its out clip plays.
 * The copy is taken before React commits the change: the leaving page already re-renders with the next location's
 * search params while the next page's beforeLoad settles.
 */
export class PageExit extends Component<PageExitProps> {
  override getSnapshotBeforeUpdate(prev: Readonly<PageExitProps>): Copy | null {
    const box = this.props.host.current;
    if (prev.id === this.props.id || !box || fxCalm()) return null;
    return copy(prev.id, box);
  }

  override componentDidUpdate(_prev: Readonly<PageExitProps>, _state: unknown, snapshot: Copy | null) {
    if (snapshot) leave(snapshot);
  }

  override render() {
    return this.props.children;
  }
}

function copy(id: string, box: HTMLElement): Copy | null {
  const nodes = [...box.children].filter((n) => !n.hasAttribute('data-page-exit'));
  if (nodes.length === 0) return null;
  const ghost = document.createElement('div');
  ghost.setAttribute('data-page-exit', id);
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  // The scroll box is not positioned, so the copy is placed in its offsetParent and does not scroll with the next page;
  // it stays inside the box in the tree so the pages' @container page queries still match.
  ghost.style.cssText = `position:absolute;top:${box.offsetTop}px;left:${box.offsetLeft}px;width:${box.clientWidth}px;height:${box.clientHeight}px;overflow:hidden;pointer-events:none;z-index:calc(var(--ef-z-sticky) + 1)`;
  // Stands in for the scroll box: page heights in % resolve against it, and its old offset stays in view.
  const page = document.createElement('div');
  page.style.cssText = `display:flow-root;height:100%;translate:0 ${-box.scrollTop}px`;
  for (const n of nodes) page.appendChild(n.cloneNode(true));
  for (const n of page.querySelectorAll('[id]')) n.removeAttribute('id');
  ghost.appendChild(page);
  return { id, box, ghost };
}

function leave({ id, box, ghost }: Copy) {
  box.appendChild(ghost);
  const clip = OUT[id];
  const runs = clip ? startClip(clip, ghost) : [];
  if (runs.length === 0) {
    const ease = FADE.tracks.find((t) => t.property === 'opacity')?.keyframes[0]?.easing;
    const a = playOnce(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: FADE.duration, easing: ease ?? 'linear' });
    if (a) runs.push(a);
  }
  void runsEnd(runs).then(() => ghost.remove());
}
