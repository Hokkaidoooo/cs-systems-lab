import { test, expect } from '@playwright/test';

test('真实预设、同步策略回放和 FIFO 分类', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '直接映射冲突', exact: true }).click();
  await expect(page.locator('#cache-hit-detail')).toHaveText('0 / 8 次访问命中');
  await page.getByRole('button', { name: '4 路组相联', exact: true }).click();
  await expect(page.locator('#cache-hit-detail')).toHaveText('5 / 8 次访问命中');
  await page.locator('#cache-compare-preset').click();
  await expect(page.locator('#cache-comparison-summary')).toContainText('第 6 次访问，LRU 替换块 1，FIFO 替换块 0');
  await page.locator('#cache-prev').click();
  await expect(page.locator('#compare-LRU-result')).toHaveText('第 6 次 · 未命中 · 替换块 1');
  await expect(page.locator('#compare-FIFO-result')).toHaveText('第 6 次 · 未命中 · 替换块 0');
  await page.selectOption('#cache-policy', 'FIFO');
  await page.getByRole('button', { name: '运行缓存实验' }).click();
  await expect(page.locator('#cache-classification-tag')).toHaveText('FIFO');
  await expect(page.locator('#cache-classification .classification-bar')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: 'test-results/cache-comparison.png', fullPage: true });
});

test('分页、Reno 预设与键盘错误焦点', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tab-cache').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tab-paging')).toBeFocused();
  await expect(page.locator('#panel-paging')).toBeVisible();
  await page.getByRole('button', { name: '相邻的两个 4 KiB 页' }).click();
  await expect(page.locator('#paging-table-detail')).toHaveText('4 张 4 KiB 页表页');
  await page.getByRole('button', { name: '跨 512 GiB 的两个页' }).click();
  await expect(page.locator('#paging-table-detail')).toHaveText('7 张 4 KiB 页表页');
  await page.locator('#tab-reno').click();
  await page.getByRole('button', { name: '两种丢包对照' }).click();
  await expect(page.locator('#reno-trace tr').nth(9)).toContainText('三次重复 ACK');
  await expect(page.locator('#reno-trace tr').nth(19)).toContainText('超时');
  await page.locator('#reno-rounds').fill('0');
  await page.locator('#reno-rounds').press('Enter');
  await expect(page.locator('#reno-error')).toBeFocused();
  await expect(page.locator('#reno-error')).toContainText('不能小于');
});

test('三类参数刷新恢复，非法版本和模型参数显式失败', async ({ page }) => {
  await page.goto('/');
  await page.locator('#cache-compare-preset').click();
  await page.locator('#tab-paging').click();
  await page.locator('#paging-addresses').fill('0xffff800000000001, 0xffff800000001001');
  await page.locator('#tab-reno').click();
  await page.locator('#reno-rounds').fill('32');
  await page.locator('#share-button').click();
  const link = await page.locator('#share-url').inputValue();
  await page.goto(link);
  await expect(page.locator('#tab-reno')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#reno-rounds')).toHaveValue('32');
  await page.locator('#tab-cache').click();
  await expect(page.locator('#cache-hit-detail')).toHaveText('2 / 7 次访问命中');
  await page.locator('#tab-paging').click();
  await expect(page.locator('#paging-addresses')).toHaveValue('0xffff800000000001, 0xffff800000001001');
  await expect(page.locator('#paging-table-detail')).toHaveText('4 张 4 KiB 页表页');
  const url = new URL(link);
  const snapshot = JSON.parse(url.searchParams.get('experiment'));
  snapshot.fields['cache-size'] = '3';
  url.searchParams.set('experiment', JSON.stringify(snapshot));
  await page.goto(url.href);
  await expect(page.locator('#share-error')).toBeFocused();
  await expect(page.locator('#cache-error')).toContainText('2 的整数次幂');
  await expect(page.locator('#cache-results')).toBeHidden();
  snapshot.fields['cache-size'] = '64';
  snapshot.fields['cache-policy'] = 'unknown';
  url.searchParams.set('experiment', JSON.stringify(snapshot));
  await page.goto(url.href);
  await expect(page.locator('#cache-error')).toContainText('policy 只能是 LRU 或 FIFO');
  snapshot.version = 999;
  url.searchParams.set('experiment', JSON.stringify(snapshot));
  await page.goto(url.href);
  await expect(page.locator('#share-error')).toContainText('版本不受支持');
});

test('移动视口各实验没有页面级溢出且控件可操作', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  for (const name of ['cache', 'paging', 'reno']) {
    await page.locator(`#tab-${name}`).click();
    await page.locator(`#${name}-form button[type=submit]`).click();
    await expect(page.locator(`#${name}-results`)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: 'test-results/mobile-reno.png', fullPage: true });
});

test('文档链接打开实际排版后的模型说明', async ({ page }) => {
  await page.goto('/');
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('link', { name: '理解缓存模型' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await expect(popup).toHaveURL(/github\.com\/Hokkaidoooo\/cs-systems-lab\/blob\/main\/docs\/models\.md#cache/);
  await expect(popup.locator('article.markdown-body')).toContainText('Cache', { timeout: 30000 });
});
