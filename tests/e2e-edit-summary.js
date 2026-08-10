// v3.9: editing a record shows option fields collapsed to their chosen values,
// with a per-field 編輯 button opening a modal.
//
// Why: editing puts customer + needs + company on one page — with the built-in
// fields that is ~130 option buttons, so correcting a phone number meant
// scrolling past every machine brand. The customer-facing fill-in flow is
// untouched and this suite guards that too: collapsing the *entry* forms would
// be a regression, not a feature.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-edit');
fs.mkdirSync(SHOT, { recursive: true });

// Options that exist in the defaults but will not be picked, so their presence
// on screen proves the full list is rendered.
const UNPICKED = ['Sample Required', 'Become a Distributor'];

(async () => {
  const server = await H.serve(8963);
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
  await H.enterEvent(page);

  // ---- 1. the fill-in flow still shows every option ----
  await H.pickCustomerStatus(page);
  await page.locator('[data-entry-needs]').click();
  await page.waitForTimeout(600);
  let body = await page.locator('body').innerText();
  for (const opt of UNPICKED) {
    assert(body.includes(opt), `填單流程仍攤開所有選項（找得到未選的「${opt}」）`);
  }
  assert((await page.locator('[data-summary-row]').count()) === 0, '填單流程沒有摘要列');
  assert((await page.locator('[data-edit-field]').count()) === 0, '填單流程沒有欄位編輯鈕');

  // Fill a record: pick one inquiry type, leave the rest unpicked.
  // checkbox-group options are <label> wrappers, not buttons.
  await page.locator('[data-cb-wrap] label').filter({ hasText: 'Request Quote' }).first().click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: /Next 下一步/ }).click();   // -> company
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /Next 下一步/ }).click();   // -> customer
  await page.waitForTimeout(500);
  await page.locator('input[placeholder^="Enter Name"]').first().fill('王小明');
  await page.locator('input[placeholder^="Enter Company"]').first().fill('宏昌實業');
  await page.locator('input[placeholder^="Enter Email"]').first().fill('a@b.com');
  const combo = page.locator('[data-combo] input').first();
  await combo.click();
  await combo.fill('Taiwan');
  await page.waitForTimeout(200);
  await page.locator('input[type="checkbox"]').last().check();
  await page.getByRole('button', { name: /Finish 完成/ }).click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: /完成，返回|Done/ }).first().click().catch(() => {});
  await page.waitForTimeout(600);

  // ---- 2. edit mode collapses option fields ----
  await page.locator('[data-open-browse]').click();
  await page.waitForTimeout(400);
  await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('0000');
  await page.getByRole('button', { name: '登入' }).click();
  await page.waitForTimeout(600);
  await page.locator('[data-browse-row] button').first().click();
  await page.waitForTimeout(700);

  body = await page.locator('body').innerText();
  assert(body.includes('編輯資料'), '已進入編輯模式');
  for (const opt of UNPICKED) {
    assert(!body.includes(opt), `編輯模式看不到未選中的選項「${opt}」`);
  }
  assert(body.includes('Request Quote') || body.includes('索取報價'),
    '已選中的值仍然顯示');
  await page.screenshot({ path: path.join(SHOT, '01_edit_summary.png'), fullPage: true });

  const rows = await page.locator('[data-summary-row]').count();
  const btns = await page.locator('[data-edit-field]').count();
  assert(rows > 0 && rows === btns, `每個摘要列都有自己的編輯鈕（${rows} 列 / ${btns} 鈕）`);

  // Text fields stay inline — no modal needed for a typo.
  const nameBox = page.locator('input[placeholder^="Enter Name"]').first();
  assert(await nameBox.isVisible(), '文字欄位仍可直接在頁面上編輯');
  await nameBox.fill('王大明');
  await page.waitForTimeout(150);

  // Empty option fields are still listed, so quick-entry blanks can be filled.
  assert((await page.locator('[data-summary-empty]').count()) > 0,
    '未填的選項欄位顯示「未填」而不是消失');

  // v3.11: 訪談日期 comes from the event page and had no correction path at
  // all — a record dated wrong stayed wrong. Edit mode is the one place it can
  // be changed; the other two event-supplied fields stay read-only.
  const dateBox = page.locator('[data-edit-visit-date]');
  assert((await dateBox.count()) === 1, '編輯模式出現訪談日期欄位');
  const wasDate = await dateBox.inputValue();
  assert(/^\d{4}-\d{2}-\d{2}$/.test(wasDate), '帶出紀錄原本的訪談日期：' + wasDate);
  await dateBox.fill('2026-09-23');
  await page.waitForTimeout(150);
  body = await page.locator('body').innerText();
  assert(!body.includes('新舊客戶') && !body.includes('接待人員'),
    '接待人員與新舊客戶沒有跟著變成可編輯');

  // v3.11: the searchable select is the only field whose option list is hidden
  // once closed, so its summary is where the Chinese name has to appear.
  const natRow = page.locator('[data-summary-row]').filter({ hasText: 'Taiwan' }).first();
  const natText = await natRow.locator('[data-summary-value]').innerText();
  assert(natText.includes('Taiwan') && natText.includes('台灣'),
    '國籍摘要中英並陳：' + natText);

  // ---- 3. the modal edits exactly one field ----
  const inquiryRow = page.locator('[data-summary-row]')
    .filter({ hasText: 'Request Quote' }).first();
  await inquiryRow.locator('[data-edit-field]').click();
  await page.waitForTimeout(500);
  assert((await page.locator('[data-value-editor]').count()) === 1, '彈窗已開啟');
  const modal = await page.locator('[data-value-editor]').innerText();
  assert(modal.includes('Sample Required'), '彈窗內攤開該欄位的完整選項');
  assert(!modal.includes('宏昌實業') && !modal.includes('Nationality'),
    '彈窗只含這一個欄位，沒有把整組欄位帶進來：' + modal.split('\n').slice(0, 6).join(' | '));
  await page.screenshot({ path: path.join(SHOT, '02_modal.png'), fullPage: true });

  // ---- 4. 取消 really reverts ----
  await page.locator('[data-value-editor] [data-cb-wrap] label')
    .filter({ hasText: 'Sample Required' }).first().click();
  await page.waitForTimeout(200);
  await page.locator('[data-ve-cancel]').click();
  await page.waitForTimeout(400);
  assert((await page.locator('[data-value-editor]').count()) === 0, '取消後彈窗關閉');
  body = await page.locator('body').innerText();
  assert(!body.includes('Sample Required'), '取消還原了剛才的改動');

  // ---- 5. 完成 keeps the change and the summary follows ----
  await inquiryRow.locator('[data-edit-field]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-value-editor] [data-cb-wrap] label')
    .filter({ hasText: 'Sample Required' }).first().click();
  await page.waitForTimeout(200);
  await page.locator('[data-ve-done]').click();
  await page.waitForTimeout(400);
  const summaryText = await page.locator('[data-summary-row]')
    .filter({ hasText: 'Request Quote' }).first().locator('[data-summary-value]').innerText();
  assert(summaryText.includes('Request Quote') && summaryText.includes('Sample Required'),
    '摘要列同步顯示兩個選項：' + summaryText);

  // ---- 6. saving writes everything, and lands back in the browser ----
  await page.getByRole('button', { name: /Save 儲存/ }).click();
  await page.waitForTimeout(900);
  assert((await page.locator('[data-browse-row]').count()) === 1, '存檔後回到瀏覽頁');

  const rec = (await H.readAll(page, 'records'))[0];
  assert(rec.customerFields.name === '王大明', '行內改的文字有存到：' + rec.customerFields.name);
  assert(Array.isArray(rec.needsFields.inquiry_type)
    && rec.needsFields.inquiry_type.includes('Request Quote')
    && rec.needsFields.inquiry_type.includes('Sample Required'),
    '彈窗改的選項有存到：' + JSON.stringify(rec.needsFields.inquiry_type));
  assert(rec.customerFields.nationality === 'Taiwan',
    '沒有被編輯的欄位維持原值，且儲存的仍是英文值：' + rec.customerFields.nationality);
  assert(rec.staffFields.visit_date === '2026-09-23',
    '改過的訪談日期有存到：' + rec.staffFields.visit_date);
  assert(Array.isArray(rec.staffFields.greeter) && rec.staffFields.greeter.length > 0
    && rec.staffFields.customer_status === 'New',
    '同組的接待人員與新舊客戶沒有被順手清掉：' + JSON.stringify(rec.staffFields));

  assert(errors.length === 0, '無 console error：' + errors.join(' | '));

  await ctx.close();
  await browser.close();
  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nEDIT SUMMARY PASSED');
  process.exit(fails ? 1 : 0);
})();
