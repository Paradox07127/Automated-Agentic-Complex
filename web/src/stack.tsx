import { lazy, StrictMode, Suspense, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import './design/tokens.css';
import './design/base.css';
import { loadFakeBridge } from './bridge';
import { trackKeyboardFocus } from './design/keyboardFocus';
import { StackErrorBoundary } from './surfaces/stack/StackErrorBoundary';
import { applyInitialTheme } from './shell/useSystemTheme';

await loadFakeBridge();
applyInitialTheme();
trackKeyboardFocus();
const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

// Native loads each desktop panel with its own hash path: `#/bubble`, `#/chip`, `#/dock`, `#/cmd`, `#/console`,
// `#/computer`, `#/camera`, `#/resize`, `#/photo`, `#/title`. `#/hud`, and any other path, is the stack cards' page, which
// native no longer opens as a panel. Each panel loads only its own Root's chunk.
const path = window.location.hash.replace(/^#/, '').split('?')[0];
type RootModule = Promise<{ default: ComponentType }>;
const hud = (): RootModule => import('./surfaces/desktop/HudRoot').then((m) => ({ default: m.HudRoot }));
const ROOTS: Record<string, () => RootModule> = {
  '/bubble': () => import('./surfaces/desktop/BubbleRoot').then((m) => ({ default: m.BubbleRoot })),
  '/hud': hud,
  '/dock': () => import('./surfaces/desktop/DockRoot').then((m) => ({ default: m.DockRoot })),
  '/chip': () => import('./surfaces/desktop/ChipRoot').then((m) => ({ default: m.ChipRoot })),
  '/cmd': () => import('./surfaces/desktop/CmdRoot').then((m) => ({ default: m.CmdRoot })),
  '/console': () => import('./surfaces/desktop/ConsoleRoot').then((m) => ({ default: m.ConsoleRoot })),
  '/computer': () => import('./surfaces/desktop/ComputerUseRoot').then((m) => ({ default: m.ComputerUseRoot })),
  '/camera': () => import('./surfaces/desktop/CameraRoot').then((m) => ({ default: m.CameraRoot })),
  '/resize': () => import('./surfaces/desktop/ResizeRoot').then((m) => ({ default: m.ResizeRoot })),
  '/photo': () => import('./surfaces/desktop/PhotoRoot').then((m) => ({ default: m.PhotoRoot })),
  '/title': () => import('./surfaces/desktop/TitleRoot').then((m) => ({ default: m.TitleRoot })),
};
const Root = lazy(ROOTS[path ?? ''] ?? hud);

createRoot(root).render(
  <StrictMode>
    <StackErrorBoundary>
      {/* Nothing until the chunk arrives; native counts the page alive once its Root subscribes to the anchor. */}
      <Suspense fallback={null}>
        <Root />
      </Suspense>
    </StackErrorBoundary>
  </StrictMode>,
);
