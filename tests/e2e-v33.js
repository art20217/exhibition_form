// v3.3 end-to-end: admin fully in Chinese, two-stage confirmation on every
// delete, fields moved off the staff page, and business card capture on the
// customer form (including the "editing must not wipe the photo" regression).
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT_DIR = path.join(__dirname, 'shots-v33');
fs.mkdirSync(SHOT_DIR, { recursive: true });
let shotN = 0;
async function shot(page, name) {
  shotN++;
  await page.screenshot({ path: path.join(SHOT_DIR, `${String(shotN).padStart(2,'0')}_${name}.png`), fullPage: true });
}

// 1x1 red PNG, enough to exercise the compress-and-store path.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');


const fieldBlock = (page, labelText) => page.locator('label', { hasText: labelText }).locator('xpath=..');

(async () => {
  const server = await H.serve(8937);
  const browser = await H.launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 900 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  const externalRequests = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (!url.startsWith('http://localhost:8937')) { externalRequests.push(url); return route.abort(); }
    return route.continue();
  });

  let fails = 0;
  const assert = async (cond, msg) => {
    if (!cond) { console.error('FAIL: ' + msg); fails++; await shot(page, 'FAIL_' + msg.replace(/[^a-z0-9]+/gi,'_').slice(0,40)); }
    else console.log('ok: ' + msg);
  };
  const openAdmin = async () => {
    await page.locator('button:has(svg circle)').first().click();
    await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('0000');
    await page.getByRole('button', { name: '登入' }).click();
    await page.waitForTimeout(400);
  };

  await page.goto('http://localhost:8937/');
  await page.waitForTimeout(1200);
  await H.enterEvent(page);

  // ===== 3. + 4. field relocation, walking the full flow =====
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(400);
  await shot(page, 'customer-form');
  await assert(await fieldBlock(page, 'Nationality').isVisible(), '訪客國籍已移到客戶資料頁');
  await assert(await fieldBlock(page, 'Language').isVisible(), '語言已移到客戶資料頁');

  await page.locator('input[placeholder^="Enter Name"]').fill('王小明');
  await page.locator('input[placeholder^="Enter Company"]').fill('宏昌實業');
  await page.locator('input[placeholder^="Enter Email"]').fill('ming@hongchang.com');
  await fieldBlock(page, 'Nationality').locator('input').fill('Japan');
  await fieldBlock(page, 'Language').getByText('English').click();

  // ===== 5. business card capture now lives on the customer form footer =====
  const cardInput = page.locator('input[type="file"]').first();
  await assert(await cardInput.count() > 0, '名片拍攝已出現在客戶資料頁');
  await cardInput.setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForTimeout(600);
  await assert(await page.getByRole('button', { name: /Remove 移除/ }).isVisible(), '名片上傳後顯示預覽與移除鈕');
  await shot(page, 'customer-form-with-card');

  await page.locator('input[type="checkbox"]').last().check(); // GDPR
  await page.getByRole('button', { name: /Next 下一步/ }).click();
  await page.waitForTimeout(400);
  await assert(await page.getByText('2 / 3').isVisible(), '公司背景資料仍為第 2 步');
  await page.getByRole('button', { name: /Next 下一步/ }).click();
  await page.waitForTimeout(400);

  await shot(page, 'needs-form');
  const needsLabels = (await page.locator('label').allTextContents()).map(t => t.trim());
  const idx = (s) => needsLabels.findIndex(t => t.includes(s));
  await assert(idx('Inquiry Type') >= 0 && idx('Product of Interest') > idx('Inquiry Type')
    && idx('Deal Probability') > idx('Product of Interest') && idx('Notes') > idx('Deal Probability'),
    '需求頁欄位順序為 洽談事由→感興趣產品→成交機率→備註');
  const needsText = await page.locator('body').innerText();
  await assert(needsText.includes('成交機率') && !needsText.includes('潛力評級'), '潛力評級已更名為成交機率');

  await page.getByText('Request Quote 索取報價').click();
  await fieldBlock(page, 'Product of Interest').getByText('EVA Single Color').click();
  await fieldBlock(page, 'Deal Probability').getByRole('button', { name: /^A / }).click();
  await fieldBlock(page, 'Notes').locator('textarea').fill('展場洽談，後續報價。');
  await page.getByRole('button', { name: /Finish 完成/ }).click();
  await page.waitForTimeout(400);

  // v3.4: the two reception fields are answered on the event page, so with the
  // default field set nothing is left for the staff page and the handoff screen
  // ends the flow outright.
  await shot(page, 'handoff');
  const handoffText = await page.locator('body').innerText();
  await assert(!handoffText.includes('Staff 工作人員') && handoffText.includes('完成，返回'),
    '預設欄位下業務備註頁不再出現，交接畫面直接結束');
  const saved = (await H.readAll(page, 'records'))[0];
  await assert(Array.isArray(saved.staffFields.greeter) && saved.staffFields.greeter.length === 1
    && !!saved.staffFields.visit_date,
    '接待人員與訪談日期由活動頁自動帶入：' + JSON.stringify(saved.staffFields));
  await page.getByRole('button', { name: /完成，返回/ }).click();
  await page.waitForTimeout(600);

  // ===== 1. admin fully Chinese =====
  await openAdmin();
  await shot(page, 'admin-customer-fields');
  let adminText = await page.locator('body').innerText();
  for (const en of ['Admin Panel', 'Exit to Form', 'Add Field', 'required', 'core', 'Options:']) {
    await assert(!adminText.includes(en), `後台無英文殘留：${en}`);
  }
  await assert(adminText.includes('後台管理') && adminText.includes('＋ 新增欄位'), '後台顯示中文介面');
  for (const tab of ['客戶資料欄位', '客戶需求欄位', '公司背景欄位', '資料紀錄', '系統設定']) {
    await assert(adminText.includes(tab), `頁籤中文化：${tab}`);
  }

  await page.getByRole('button', { name: '系統設定' }).click();
  await page.waitForTimeout(300);
  await shot(page, 'admin-settings');
  adminText = await page.locator('body').innerText();
  for (const en of ['Device Name', 'Admin PIN', 'Save Settings', 'GDPR Consent (English)']) {
    await assert(!adminText.includes(en), `設定頁無英文殘留：${en}`);
  }
  await assert(adminText.includes('裝置名稱') && adminText.includes('儲存設定'), '設定頁中文化');

  await page.getByRole('button', { name: '客戶資料欄位' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '＋ 新增欄位' }).click();
  await page.waitForTimeout(300);
  await shot(page, 'admin-field-editor');
  adminText = await page.locator('body').innerText();
  for (const en of ['Field Name', 'Required field', 'Save Field', 'Add Option']) {
    await assert(!adminText.includes(en), `欄位編輯器無英文殘留：${en}`);
  }
  await assert(adminText.includes('新增欄位') && adminText.includes('儲存欄位'), '欄位編輯器中文化');
  await assert((await page.locator('option', { hasText: '單選按鈕組' }).count()) === 1, '類型下拉已中文化');
  await page.getByRole('button', { name: '取消' }).click();
  await page.waitForTimeout(200);

  // ===== 2. two-stage confirmation =====
  // (a) field delete
  await page.getByRole('button', { name: '客戶需求欄位' }).click();
  await page.waitForTimeout(300);
  const rowCountBefore = await page.locator('[data-field-row]').count();
  await page.locator('[data-field-row]', { hasText: '備註' }).locator('button').last().click();
  await page.waitForTimeout(300);
  await shot(page, 'confirm-stage1');
  await assert(await page.getByText('刪除欄位？').isVisible(), '欄位刪除跳出第 1 層確認');
  await assert((await page.locator('[data-field-row]').count()) === rowCountBefore, '第 1 層時尚未刪除');
  await page.getByRole('button', { name: '繼續' }).click();
  await page.waitForTimeout(300);
  await shot(page, 'confirm-stage2');
  await assert(await page.getByText('第 2 次確認').isVisible(), '出現第 2 層確認');
  await assert(await page.getByText('此動作無法復原').isVisible(), '第 2 層顯示無法復原警告');
  await page.getByRole('button', { name: '取消' }).click();
  await page.waitForTimeout(300);
  await assert((await page.locator('[data-field-row]').count()) === rowCountBefore, '第 2 層取消後資料仍在');
  // now go all the way through
  await page.locator('[data-field-row]', { hasText: '備註' }).locator('button').last().click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '繼續' }).click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '確定刪除' }).click();
  await page.waitForTimeout(400);
  await assert((await page.locator('[data-field-row]').count()) === rowCountBefore - 1, '完成兩層確認後欄位才真正刪除');

  // (b) clear all — type-to-confirm gates stage 1, then a second confirmation
  await page.getByRole('button', { name: '資料紀錄' }).click();
  await page.waitForTimeout(400);
  await shot(page, 'admin-records');
  adminText = await page.locator('body').innerText();
  await assert(!adminText.includes('Clear All') && !adminText.includes('Actions') && !adminText.includes('Export Data'),
    '紀錄頁無英文殘留');
  await assert(adminText.includes('王小明'), '紀錄已建立');
  await assert(adminText.includes('已蒐集 1 筆紀錄，其中 1 筆含名片照片'), '統計列中文化且名片已存檔');

  await page.getByRole('button', { name: '清除全部' }).click();
  await page.waitForTimeout(300);
  await shot(page, 'confirm-clear-typebox');
  await assert(await page.getByPlaceholder('請輸入 DELETE').isVisible(), '清除全部需輸入 DELETE');
  const nextBtn = page.getByRole('button', { name: '繼續' });
  await assert(await nextBtn.isDisabled(), '未輸入 DELETE 時「繼續」為停用狀態，無法進入第 2 層');
  await page.getByPlaceholder('請輸入 DELETE').fill('DELETE');
  await nextBtn.click();
  await page.waitForTimeout(250);
  await assert(await page.getByText('第 2 次確認').isVisible(), '輸入 DELETE 後進入第 2 層');
  await page.getByRole('button', { name: '取消' }).click();
  await page.waitForTimeout(300);
  await assert((await page.locator('body').innerText()).includes('王小明'), '清除全部取消後紀錄仍在');

  // (c) single record delete
  await page.getByRole('button', { name: '刪除' }).first().click();
  await page.waitForTimeout(300);
  await assert(await page.getByText('刪除這筆紀錄？').isVisible(), '單筆紀錄刪除跳出第 1 層確認');
  await page.getByRole('button', { name: '繼續' }).click();
  await page.waitForTimeout(250);
  await assert(await page.getByText('第 2 次確認').isVisible(), '單筆紀錄刪除有第 2 層確認');
  await page.getByRole('button', { name: '取消' }).click();
  await page.waitForTimeout(300);
  await assert((await page.locator('body').innerText()).includes('王小明'), '取消後紀錄仍在');

  // ===== 5b. regression: editing a record must not wipe the saved card photo =====
  await page.getByRole('button', { name: '編輯' }).first().click();
  await page.waitForTimeout(500);
  await shot(page, 'edit-record-card-preserved');
  await assert(await page.getByRole('button', { name: /Remove 移除/ }).isVisible(),
    '編輯紀錄時已載入既有名片照片預覽');
  await assert((await fieldBlock(page, 'Nationality').locator('input').inputValue()) === 'Japan',
    '編輯時載入客戶資料頁的國籍值');
  await page.getByRole('button', { name: /Save 儲存/ }).click();
  await page.waitForTimeout(600);
  const afterEdit = await page.locator('body').innerText();
  await assert(afterEdit.includes('已蒐集 1 筆紀錄，其中 1 筆含名片照片'),
    '編輯後再送出，名片照片沒有被洗掉');

  // (d) remove-photo also confirms twice
  await page.getByRole('button', { name: '編輯' }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /Remove 移除/ }).click();
  await page.waitForTimeout(300);
  await assert(await page.getByText('移除名片照片？').isVisible(), '移除名片跳出第 1 層確認');
  await page.getByRole('button', { name: '繼續' }).click();
  await page.waitForTimeout(250);
  await assert(await page.getByText('第 2 次確認').isVisible(), '移除名片有第 2 層確認');
  await page.getByRole('button', { name: '確定刪除' }).click();
  await page.waitForTimeout(400);
  await assert(!(await page.getByRole('button', { name: /Remove 移除/ }).isVisible().catch(() => false)),
    '兩層確認後名片照片才被移除');

  if (errors.length) { console.error('CONSOLE ERRORS:'); errors.forEach(e => console.error('  ' + e)); fails++; }
  else console.log('ok: 無 console error');
  await assert(externalRequests.length === 0, '完全離線（無對外請求）：' + externalRequests.join(', '));

  await browser.close();
  server.close();
  console.log(fails ? `V3.3 E2E FAILED (${fails})` : 'V3.3 E2E PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
