// Every floating window must survive a mis-tap on its backdrop and close only
// via its own control. Includes a regression guard for the lightbox ×, which
// used to work purely by bubbling to the (now removed) backdrop handler.
const http = require('http');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-modal');
fs.mkdirSync(SHOT, { recursive: true });

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url.startsWith('/seed')) { res.end('<!DOCTYPE html><title>seed</title>'); return; }
  fs.createReadStream(H.APP_HTML).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(8948, r));
  const browser = await H.launchBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  // Click the very corner of the viewport — unambiguously outside any panel.
  const tapBackdrop = async () => { await page.mouse.click(8, 8); await page.waitForTimeout(300); };

  await page.goto('http://localhost:8948/seed');
  await page.evaluate(() => new Promise((res, rej) => {
    const d = indexedDB.deleteDatabase('ExhibitionFormDB');
    d.onerror = () => rej(d.error); d.onsuccess = d.onblocked = () => res();
  }));

  // ---------- 1. PIN dialog ----------
  await page.goto('http://localhost:8948/');
  await page.waitForTimeout(1300);
  await H.enterEvent(page);
  await page.locator('button:has(svg circle)').first().click();
  await page.waitForTimeout(300);
  assert(await page.getByText('管理者登入').isVisible(), 'PIN 對話框已開啟');
  await tapBackdrop();
  assert(await page.getByText('管理者登入').isVisible(), 'PIN 對話框：點遮罩不會關閉');
  await page.screenshot({ path: path.join(SHOT, '01_pin_locked.png') });
  await page.getByRole('button', { name: '取消' }).click();
  await page.waitForTimeout(300);
  assert(!(await page.getByText('管理者登入').isVisible().catch(() => false)), 'PIN 對話框：「取消」可正常關閉');

  // Log in for the rest
  await page.locator('button:has(svg circle)').first().click();
  await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('0000');
  await page.getByRole('button', { name: '登入' }).click();
  await page.waitForTimeout(400);

  // ---------- 2. field editor (and its typed content must survive) ----------
  await page.getByRole('button', { name: '＋ 新增欄位' }).click();
  await page.waitForTimeout(350);
  await page.locator('input[placeholder="例如 Country"]').fill('MyDraftField');
  await tapBackdrop();
  assert(await page.getByText('新增欄位').first().isVisible(), '欄位編輯器：點遮罩不會關閉');
  assert((await page.locator('input[placeholder="例如 Country"]').inputValue()) === 'MyDraftField',
    '欄位編輯器：已填內容未因誤觸而遺失');
  await page.screenshot({ path: path.join(SHOT, '02_editor_locked.png') });
  await page.getByRole('button', { name: '取消' }).click();
  await page.waitForTimeout(300);
  assert(!(await page.locator('input[placeholder="例如 Country"]').isVisible().catch(() => false)),
    '欄位編輯器：「取消」可正常關閉');

  // ---------- 3. delete confirmation, both stages ----------
  // Core fields have no delete button, so use a tab that has deletable rows.
  await page.getByRole('button', { name: '客戶需求欄位' }).click();
  await page.waitForTimeout(400);
  const rowsBefore = await page.locator('[data-field-row]').count();
  await page.locator('[data-field-row]:has(button:text-is("×"))').last()
    .locator('button:text-is("×")').click();
  await page.waitForTimeout(300);
  assert(await page.getByText('刪除欄位？').isVisible(), '刪除確認第 1 層已開啟');
  await tapBackdrop();
  assert(await page.getByText('刪除欄位？').isVisible(), '刪除確認第 1 層：點遮罩不會關閉');
  await page.getByRole('button', { name: '繼續' }).click();
  await page.waitForTimeout(300);
  assert(await page.getByText('第 2 次確認').isVisible(), '已進入第 2 層');
  await tapBackdrop();
  assert(await page.getByText('第 2 次確認').isVisible(), '刪除確認第 2 層：點遮罩不會關閉');
  await page.screenshot({ path: path.join(SHOT, '03_confirm_locked.png') });
  await page.getByRole('button', { name: '取消' }).click();
  await page.waitForTimeout(300);
  assert(!(await page.getByText('第 2 次確認').isVisible().catch(() => false)), '刪除確認：「取消」可正常關閉');
  assert((await page.locator('[data-field-row]').count()) === rowsBefore, '全程未誤刪任何欄位');

  // ---------- 4. photo lightbox — the × must work on its own ----------
  await page.getByRole('button', { name: '← 返回表單' }).click();
  await page.waitForTimeout(400);
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(400);
  await page.locator('input[placeholder^="Enter Name"]').fill('照片測試');
  await page.locator('input[placeholder^="Enter Company"]').fill('測試公司');
  await page.locator('input[placeholder^="Enter Email"]').fill('p@t.com');
  await page.locator('label', { hasText: 'Nationality' }).locator('xpath=..').locator('input').first().fill('TW');
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'c.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForTimeout(600);
  await page.locator('input[type="checkbox"]').last().check();
  await page.getByRole('button', { name: /Next 下一步/ }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /Next 下一步/ }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /Finish 完成/ }).click();
  await page.waitForTimeout(400);
  // The card photo is captured on the customer form (v3.3) and the reception
  // fields come from the event page (v3.4), so the flow ends at the handoff.
  await page.getByRole('button', { name: /完成，返回/ }).click();
  await page.waitForTimeout(600);

  await page.locator('button:has(svg circle)').first().click();
  await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('0000');
  await page.getByRole('button', { name: '登入' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '資料紀錄' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '📷' }).first().click();
  await page.waitForTimeout(400);
  const lightbox = page.locator('img[src^="data:image"]').last();
  assert(await lightbox.isVisible(), '名片燈箱已開啟');
  await tapBackdrop();
  assert(await lightbox.isVisible(), '名片燈箱：點遮罩不會關閉');
  await page.screenshot({ path: path.join(SHOT, '04_lightbox_locked.png') });
  await page.getByRole('button', { name: '×' }).click();
  await page.waitForTimeout(400);
  assert(!(await lightbox.isVisible().catch(() => false)),
    '名片燈箱：× 仍可關閉（原本只靠冒泡到遮罩，遮罩鎖住後必須自帶處理器）');

  if (errors.length) { console.error('CONSOLE ERRORS:'); errors.forEach(e => console.error('  ' + e)); fails++; }
  else console.log('ok: 無 console error');

  await browser.close(); server.close();
  console.log(fails ? `MODAL LOCK FAILED (${fails})` : 'MODAL LOCK PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
