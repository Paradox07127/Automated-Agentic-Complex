import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import './design/tokens.css';
import './design/base.css';
import { getBridge, loadFakeBridge } from './bridge';
import { refetchFailedWhenAgentdUp } from './data/agentdUp';
import { trackKeyboardFocus } from './design/keyboardFocus';
import { pageRoutes } from './shell/registry';
import { RootErrorBoundary } from './shell/ErrorPage';
import { createAppRouter } from './shell/router';
import { applyInitialTheme } from './shell/useSystemTheme';

declare global {
  interface Window {
    /** Read-only route manifest for the screenshot smoke test. */
    __EF_ROUTES__?: ReadonlyArray<{ id: string; path: string; demos: ReadonlyArray<{ name: string; params: Record<string, string> }> }>;
  }
}

window.__EF_ROUTES__ = Object.freeze(pageRoutes.map(({ id, path, demos }) => ({ id, path, demos })));

await loadFakeBridge();
const router = createAppRouter();
const queryClient = new QueryClient();
refetchFailedWhenAgentdUp(queryClient, (cb) => getBridge().app.onRuntime(cb));
applyInitialTheme();
trackKeyboardFocus();
const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
