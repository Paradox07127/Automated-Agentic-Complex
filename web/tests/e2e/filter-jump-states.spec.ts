import { expect, test, type Locator } from '@playwright/test';

// Hover and press: the 角色 filter chip and the section jump buttons change their look under the mouse and while pressed.

const look = (l: Locator) =>
  l.evaluate((e) => {
    const s = getComputedStyle(e);
    return `${s.backgroundColor} | ${s.backgroundImage} | ${s.boxShadow} | ${s.color}`;
  });

for (const theme of ['dark', 'light'] as const) {
  test(`${theme}: 仅显示缺资源 and the jump buttons react to hover and press`, async ({ page }) => {
    await page.goto(`main.html#/character?still=1&pane=motion&theme=${theme}`);
    for (const target of [page.getByRole('button', { name: /仅显示缺资源/ }), page.getByRole('button', { name: '跳转到 互动' })]) {
      await page.mouse.move(0, 0);
      const rest = await look(target);
      await target.hover();
      const hover = await look(target);
      expect(hover, 'hover').not.toBe(rest);
      await page.mouse.down();
      const press = await look(target);
      await page.mouse.up();
      expect(press, 'press').not.toBe(hover);
    }
  });
}
