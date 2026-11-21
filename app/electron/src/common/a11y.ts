// `window.onA11y`: the system's display options for the desktop pages.
import { PushSource } from './push.ts';

export interface A11yOptions { reduceMotion: boolean; reduceTransparency: boolean; increaseContrast: boolean }

/** protocol.ts `A11yState` now and on each `onChange`; `glass` is always false, as no native glass is laid under the cards. */
export function a11ySource(read: () => A11yOptions, onChange: (changed: () => void) => void): PushSource {
  const source = new PushSource('a11y');
  const send = () => source.send({ ...read(), glass: false });
  send();
  onChange(send);
  return source;
}
