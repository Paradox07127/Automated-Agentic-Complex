import { expect, test, type Locator, type Page } from '@playwright/test';

// Every shared control shows hover and press in the main window; secondary / ghost hover is a visible step.

const NO_TRANSITIONS = '*, *::before, *::after { transition: none !important; animation: none !important; }';

const go = async (page: Page, url: string) => {
  await page.goto('about:blank');
  await page.goto(url);
  await page.addStyleTag({ content: NO_TRANSITIONS });
};
const demo = async (page: Page, c: string, d: string, theme = 'dark') => {
  await go(page, `tests/fixtures/catalog/index.html#?c=${c}&d=${d}&still=1&theme=${theme}`);
  await expect(page.locator(`[data-demo="${c}-${d}"]`)).toBeVisible();
  return page.locator(`[data-demo="${c}-${d}"]`);
};

/** Painted look of a control and its direct children. */
const look = (el: Locator) =>
  el.evaluate((node) =>
    JSON.stringify(
      [node, ...node.children].map((n) => {
        const s = getComputedStyle(n);
        return [s.backgroundColor, s.boxShadow, s.borderColor, s.color, s.textDecorationThickness, s.textDecorationStyle, s.outlineStyle];
      }),
    ),
  );

/** Rest, hover and press looks; the mouse is released afterwards. */
async function states(page: Page, el: Locator) {
  await page.mouse.move(0, 0);
  const rest = await look(el);
  await el.hover();
  const hover = await look(el);
  await page.mouse.down();
  const press = await look(el);
  await page.mouse.up();
  await page.mouse.move(0, 0);
  return { rest, hover, press };
}

async function expectHoverAndPress(page: Page, el: Locator) {
  const s = await states(page, el);
  expect(s.hover, 'hover').not.toBe(s.rest);
  expect(s.press, 'press').not.toBe(s.hover);
}

for (const theme of ['dark', 'light'] as const) {
  test(`Btn ${theme}: secondary and ghost hover fades the hover wash in and press shades it`, async ({ page }) => {
    for (const d of ['secondary', 'ghost']) {
      const root = await demo(page, 'Btn', d, theme);
      const btn = root.locator('button').first();
      const wash = () => btn.evaluate((n) => `${getComputedStyle(n, '::after').opacity} ${getComputedStyle(n, '::after').backgroundColor}`);
      await page.mouse.move(0, 0);
      const rest = await wash();
      expect(rest.startsWith('0 ')).toBe(true);
      await btn.hover();
      await expect.poll(wash).not.toBe(rest);
      const hover = await wash();
      expect(hover.startsWith('1 ')).toBe(true);
      await page.mouse.down();
      await expect.poll(wash).not.toBe(hover);
      await page.mouse.up();
      await page.mouse.move(0, 0);
    }
  });

  test(`Toggle ${theme}: checked and unchecked small toggles react to hover and press`, async ({ page }) => {
    for (const d of ['on-sm', 'off-sm', 'on']) {
      const root = await demo(page, 'Toggle', d, theme);
      await expectHoverAndPress(page, root.getByRole('switch'));
    }
  });

  test(`Switch ${theme}: hover and press on both states`, async ({ page }) => {
    for (const d of ['on', 'off']) {
      const root = await demo(page, 'Switch', d, theme);
      await expectHoverAndPress(page, root.getByRole('switch'));
    }
  });
}

test('Tabs: an unselected tab gets a hover background and a press state', async ({ page }) => {
  const root = await demo(page, 'Tabs', 'tasks');
  const tab = root.getByRole('tab', { name: '全部任务' });
  const s = await states(page, tab);
  const bg = (x: string) => (JSON.parse(x) as string[][])[0]![0];
  expect(bg(s.hover)).not.toBe(bg(s.rest));
  expect(s.press).not.toBe(s.hover);
});

test('Seg: an unselected option reacts to press', async ({ page }) => {
  const root = await demo(page, 'Seg', 'source');
  await expectHoverAndPress(page, root.getByRole('radio', { name: '角色' }));
});

test('Menu: the trigger and an item react to press', async ({ page }) => {
  const closed = await demo(page, 'Menu', 'closed');
  await expectHoverAndPress(page, closed.getByRole('button', { name: '管理' }));
  const open = await demo(page, 'Menu', 'open');
  await expectHoverAndPress(page, open.getByRole('menuitem').first());
});

test('CommandBar: 回主页 reacts to press', async ({ page }) => {
  await go(page, 'main.html#/overview?still=1');
  const nav = page.getByRole('navigation', { name: '主导航' });
  await expectHoverAndPress(page, nav.getByRole('button', { name: '回主页' }));
});

test('approval card links: hover, press, focus ring, and a disabled link that still reads as a link', async ({ page }) => {
  await go(page, 'main.html#/overview?plugins=daily_brief&still=1');
  const card = page.locator('[data-stub="ApprovalCard"]').first();
  // The brief folds the card's directory and links into 详情.
  await card.getByRole('button', { name: /^详情/ }).click();
  const session = card.getByRole('button', { name: '会话 ↗' });
  await expect(session).toBeVisible();
  await expectHoverAndPress(page, session);
  const rest = await look(session);
  await session.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(session).toBeFocused();
  expect(await look(session)).not.toBe(rest);
  const timeline = card.getByRole('button', { name: '时间线 ↗' });
  await expect(timeline).toHaveAttribute('aria-disabled', 'true');
  expect(await timeline.evaluate((n) => getComputedStyle(n).textDecorationLine)).toContain('underline');
});

test('approval card: the source line has no raw session id and keeps it in the tooltip', async ({ page }) => {
  await go(page, 'main.html#/overview?plugins=daily_brief&still=1');
  const line = page.locator('[data-stub="ApprovalCard"] p > span[title]').first();
  await expect(line).not.toHaveText(/claude:|own:/);
  await expect(line).toHaveAttribute('title', /claude:|own:/);
});

test('settings AI: the model provider dropdown fills the 330 control column and its chosen label is on the trigger title', async ({ page }) => {
  await go(page, 'main.html#/settings?group=kernel&demo=pi&still=1');
  const trigger = page.locator('[data-stub="Select"] > button[aria-label="模型提供方"]');
  const label = 'Anthropic API';
  await expect(trigger.locator('span').first()).toHaveText(label);
  await expect(trigger).toHaveAttribute('title', label);
  expect((await trigger.boundingBox())!.width).toBe(330);
});
