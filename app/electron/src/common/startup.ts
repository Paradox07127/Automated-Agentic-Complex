// The window the app opens at launch: none on an ordinary launch, so starting at login shows nothing but her.

export type StartupWindow = { open: 'main'; route: string } | { open: 'onboarding' } | { open: 'none' };

/** `characters`: how many the loaded config.json names; `onboardingDone`: its `"onboarding_done": true`. */
export function startupWindow(s: { configError: boolean; characters: number; onboardingDone: boolean }): StartupWindow {
  if (s.configError) return { open: 'main', route: '/home' };
  if (!s.onboardingDone) return { open: 'onboarding' };
  // Without a character nothing shows on the desktop; the character page holds the import button.
  if (s.characters === 0) return { open: 'main', route: '/character' };
  return { open: 'none' };
}
