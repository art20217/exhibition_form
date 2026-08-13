// v3.15: 系統設定 moved out of 表單管理 and onto its own screen.
//
// The page was always device-wide — its own banner says 此頁設定適用於所有活動 —
// but it lived behind the per-event gear, so changing a device name meant first
// walking into some arbitrary exhibition. Nothing about the settings changed;
// only the door.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-settings-move');
fs.mkdirSync(SHOT, { recursive: true });

(async () => {
  const server = await H.serve();
  const BASE = server.base;
  const browser = await H.launchBrowser();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE + '/seed');
  await H.wipeDB(page);
  await page.goto(BASE + '/');
  await page.waitForTimeout(1600);

  // ---- 1. locked event list offers nothing ----
  assert((await page.locator('[data-open-settings]').count()) === 0,
    '未解鎖時活動列表沒有「系統設定」');

  // ---- 2. it is behind the same PIN as the rest of manage mode ----
  await H.unlockManage(page);
  assert((await page.locator('[data-open-settings]').count()) === 1,
    '解鎖後活動列表出現「系統設定」');
  await page.locator('[data-open-settings]').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOT, '01_settings.png'), fullPage: true });

  let body = await page.locator('body').innerText();
  for (const label of ['裝置名稱', '管理者 PIN 碼', '同步伺服器', '儲存設定']) {
    assert(body.includes(label), `設定頁仍有「${label}」`);
  }
  assert(body.includes('此頁設定適用於所有活動'),
    '仍標明是全域設定——這正是它不該待在單一活動底下的理由');
  // The admin panel's Chinese-only guarantee travelled with the markup.
  for (const en of ['Device Name', 'Admin PIN', 'Save Settings', 'GDPR Consent (English)']) {
    assert(!body.includes(en), `設定頁無英文殘留：${en}`);
  }

  // ---- 3. …and it is no longer reachable through 表單管理 ----
  await page.locator('[data-settings-back]').click();
  await page.waitForTimeout(500);
  assert((await page.locator('[data-open-settings]').count()) === 1,
    '返回後仍在管理模式');
  await H.lockManage(page);
  await H.enterEvent(page);
  await H.openAdmin(page);
  const tabs = (await page.locator('[data-admin-tabs] button').allInnerTexts()).map(t => t.trim());
  assert(JSON.stringify(tabs) === JSON.stringify(
    ['客戶資料欄位', '客戶需求欄位', '公司背景欄位', '資料紀錄']),
    '表單管理只剩四個頁籤，全都是活動範圍的：' + tabs.join(' | '));
  assert(!(await page.locator('body').innerText()).includes('裝置名稱'),
    '表單管理裡看不到裝置設定');

  // ---- 4. the values really are global ----
  // Saved from one event, visible from another — that is what "device-wide"
  // has to mean, and it is the reason the screen was moved rather than copied.
  await page.getByRole('button', { name: '← 返回表單' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '← 活動列表' }).click();
  await page.waitForTimeout(600);
  await H.openSettings(page);
  await page.locator('input[type="text"]').first().fill('展場平板 B');
  await page.getByRole('button', { name: '儲存設定' }).click();
  await page.waitForTimeout(600);
  await page.locator('[data-settings-back]').click();
  await page.waitForTimeout(500);

  // Add a second event and confirm the same value shows from there too.
  await page.locator('[data-add-event]').click();
  await page.waitForTimeout(400);
  await page.locator('input[placeholder="例如 2026 美國展"]').fill('第二場');
  const d = page.locator('input[type="date"]');
  await d.nth(0).fill('2027-03-01');
  await d.nth(1).fill('2027-03-02');
  await page.getByRole('button', { name: '儲存活動' }).click();
  await page.waitForTimeout(700);
  await H.openSettings(page);
  body = await page.locator('body').innerText();
  assert((await page.locator('input[type="text"]').first().inputValue()) === '展場平板 B',
    '新增活動之後，設定值仍是同一份（全域）');

  assert(errors.length === 0, '無 console error：' + errors.join(' | '));
  await browser.close();
  server.close();
  console.log(fails ? `\nSETTINGS MOVE FAILED (${fails})` : '\nSETTINGS MOVE PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
