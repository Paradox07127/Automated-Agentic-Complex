import type { Locator, Page } from '@playwright/test';

/** Writes the screenshot only under EF_SHOTS=1: nothing compares these files, they are for looking at by hand. */
export async function saveShot(target: Page | Locator, options: { path: string; omitBackground?: boolean }): Promise<void> {
  if (process.env.EF_SHOTS === '1') await target.screenshot(options);
}
