// `desktop.onState`'s `screens`.

/** Each display as `{id, name, current}`; `current` is the screen id she stands on (current-screen.ts), null for none. */
export function desktopScreens(current: string | null, displays: readonly { id: number; label: string }[]):
  { id: string; name: string; current: boolean }[] {
  return displays.map((d) => ({ id: String(d.id), name: d.label, current: String(d.id) === current }));
}
