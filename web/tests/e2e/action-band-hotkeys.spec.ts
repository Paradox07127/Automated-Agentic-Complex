import { expect, test, type Page } from '@playwright/test';
import { saveShot } from './shots.ts';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const THEMES = ['dark', 'light'] as const;
const suffix = (theme: (typeof THEMES)[number]) => `still=1${theme === 'light' ? '&theme=light' : ''}`;
const shot = (page: Page, name: string, theme: string) => saveShot(page, { path: `.shots/${test.info().project.name}/action-band-hotkeys-${name}-${theme}.png` });

for (const theme of THEMES) {
  test(`${theme}: the overview action band names the saved hotkeys`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`main.html#/overview?${suffix(theme)}`);
    const band = page.getByRole('toolbar', { name: '常用操作' });
    await expect(band.getByRole('button', { name: /^快速输入/ })).toContainText('⌃Space');
    await expect(band).not.toContainText('⌃⌥Space');
    await shot(page, 'overview-menu', theme);
    expect(errors).toEqual([]);
  });

  test(`${theme}: 附加窗口 is off while screenshot sharing is off`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`main.html#/chat?${suffix(theme)}`);
    const look = page.getByRole('button', { name: '附加窗口' });
    await expect(look).toHaveAttribute('aria-disabled', 'true');
    await expect(look).toHaveAttribute('title', /附加截图/);
    await expect(page.getByRole('button', { name: '本轮不记录' })).toBeVisible();
    await shot(page, 'composer-look-off', theme);
    expect(errors).toEqual([]);
  });
}
