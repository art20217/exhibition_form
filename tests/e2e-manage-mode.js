// v3.11: the event list stops being a hidden entrance while it is unlocked.
//
// Manage mode offers 編輯 / 查看紀錄 / 結束 / 刪除, but the card itself used to
// stay tappable and would open the form — an unlabelled way into filling in
// data from a screen meant for administering events.
//
// Making the card inert has one consequence worth guarding: ended events are
// listed *only* in manage mode, so 查看紀錄 becomes the sole route to them. It
// goes to 表單管理's records tab rather than the reception browser because that
// is the tab carrying 匯出 — which is what 結束活動 promises stays available.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-manage');
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

  const count = (sel) => page.locator(sel).count();

  await page.goto(BASE + '/seed');
  await H.wipeDB(page);
  await page.goto(BASE + '/');
  await page.waitForTimeout(1600);

  // ---- 1. locked: the card is the way in, and nothing else is offered ----
  assert((await count('[data-ev-enter]')) === 1, '鎖定時卡片本身可點');
  assert((await count('[data-ev-static]')) === 0, '鎖定時沒有靜態卡片');
  for (const sel of ['[data-ev-edit]', '[data-ev-records]', '[data-ev-status]', '[data-ev-delete]']) {
    assert((await count(sel)) === 0, `鎖定時沒有 ${sel}`);
  }

  // Leave a record behind so 查看紀錄 has something to show later.
  await H.enterEvent(page);
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(600);
  await H.runFlow(page, { name: '王小明' });
  await page.getByRole('button', { name: /完成，返回|Done/ }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '← 活動列表' }).click();
  await page.waitForTimeout(600);

  // ---- 2. unlocked: the card goes inert and four actions appear ----
  await H.unlockManage(page);
  assert((await count('[data-ev-enter]')) === 0, '管理模式下卡片不再是入口');
  assert((await count('[data-ev-static]')) === 1, '卡片內容改為靜態顯示');
  for (const sel of ['[data-ev-edit]', '[data-ev-records]', '[data-ev-status]', '[data-ev-delete]']) {
    assert((await count(sel)) === 1, `管理模式下有 ${sel}`);
  }
  // The card still reads the same — going inert must not cost the information.
  const cardText = await page.locator('[data-ev-static]').innerText();
  assert(cardText.includes('筆紀錄') && cardText.includes('位接待人員'),
    '靜態卡片仍顯示日期與筆數：' + cardText.replace(/\n/g, ' / '));
  await page.screenshot({ path: path.join(SHOT, '01_manage.png'), fullPage: true });

  // Nothing in the card is clickable into the form.
  const clickable = await page.locator('[data-ev-static]').evaluate(el =>
    el.closest('button') !== null || el.querySelector('button') !== null);
  assert(!clickable, '靜態卡片內外都沒有按鈕，點不進表單');

  // ---- 3. 查看紀錄 lands on the records tab, export included ----
  await page.locator('[data-ev-records]').click();
  await page.waitForTimeout(800);
  let body = await page.locator('body').innerText();
  assert(body.includes('王小明'), '「查看紀錄」看得到這個活動的紀錄');
  assert((await page.getByRole('button', { name: '匯出資料' }).count()) === 1,
    '落在有「匯出資料」的頁籤上');
  await page.screenshot({ path: path.join(SHOT, '02_records.png'), fullPage: true });

  // ---- 4. and the way back keeps manage mode ----
  await page.getByRole('button', { name: '← 返回表單' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '← 活動列表' }).click();
  await page.waitForTimeout(600);
  assert((await count('[data-ev-records]')) === 1,
    '從「查看紀錄」返回列表後仍在管理模式');

  // Entering an event normally must NOT keep manage mode on the way back —
  // otherwise the list would silently stay unlocked after ordinary use.
  await H.lockManage(page);
  await page.locator('[data-ev-enter]').first().click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '← 活動列表' }).click();
  await page.waitForTimeout(600);
  assert((await count('[data-ev-enter]')) === 1 && (await count('[data-ev-records]')) === 0,
    '一般進出活動後列表回到鎖定狀態');

  // ---- 5. an ended event stays reachable, which is the whole point ----
  await H.unlockManage(page);
  await page.locator('[data-ev-status]').click();
  await page.waitForTimeout(300);
  await page.locator('div[style*="position: fixed"]')
    .getByRole('button', { name: '結束活動' }).click();
  await page.waitForTimeout(700);
  assert((await count('[data-ended-heading]')) === 1, '活動移到「已結束」區');
  assert((await count('[data-ev-records]')) === 1, '已結束的活動也有「查看紀錄」');
  assert((await count('[data-ev-enter]')) === 0, '已結束的活動卡片同樣不可點');

  await page.locator('[data-ev-records]').click();
  await page.waitForTimeout(800);
  body = await page.locator('body').innerText();
  assert(body.includes('王小明'), '已結束的活動仍讀得到紀錄');
  assert((await page.getByRole('button', { name: '匯出資料' }).count()) === 1,
    '已結束的活動仍匯得出來——這正是「結束活動」對話框承諾的');
  await page.screenshot({ path: path.join(SHOT, '03_ended_records.png'), fullPage: true });

  await page.getByRole('button', { name: '← 返回表單' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '← 活動列表' }).click();
  await page.waitForTimeout(600);
  assert((await count('[data-ev-records]')) === 1,
    '返回後已結束的活動沒有消失（管理模式被還原）');

  assert(errors.length === 0, '無 console error：' + errors.join(' | '));
  await browser.close();
  server.close();
  console.log(fails ? `\nMANAGE MODE FAILED (${fails})` : '\nMANAGE MODE PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
