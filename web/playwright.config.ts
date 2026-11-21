import { defineConfig, devices } from '@playwright/test';

// Parallel worktrees each set EF_WEB_PORT; vite preview uses --strictPort.
const port = Number(process.env.EF_WEB_PORT ?? 4317);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  timeout: 120_000,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}/`,
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/main.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
