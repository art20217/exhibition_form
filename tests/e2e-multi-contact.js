// v3.16: 增加聯絡人 — one company, several people, one pass through the form.
//
// A firm regularly sends two or three people to the booth. Until now each of
// them meant filling the whole form again, including the ten company-background
// fields, while they stood there waiting. The customer page now loops: the
// contact in hand is written, the page comes back blank, and every answer given
// after the loop lands on all of them.
//
// The records stay completely independent — nothing links them, nothing in the
// admin list says they arrived together. That was the explicit requirement:
// downstream they are simply two leads.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-multi-contact');
fs.mkdirSync(SHOT, { recursive: true });

// 1×1 JPEG, as in e2e-card-photos. It has to actually decode: the capture path
// runs through canvas, which cannot draw bytes that do not parse.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

(async () => {
  const app = await H.serve();
  const BASE = app.base;
  const browser = await H.launchBrowser();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  const nameBox = () => page.locator('input[placeholder^="Enter Name"]');
  const companyBox = () => page.locator('input[placeholder^="Enter Email"]').locator('xpath=../..')
    .locator('input[placeholder^="Enter Company"]');

  // The customer page in isolation: fill it, tick consent, but do not submit.
  const fillCustomer = async ({ name, company, email }) => {
    const fillIf = async (loc, v) => { if (v != null && await loc.count()) await loc.first().fill(v); };
    await fillIf(page.locator('input[placeholder^="Enter Name"]'), name);
    await fillIf(page.locator('input[placeholder^="Enter Company"]'), company);
    await fillIf(page.locator('input[placeholder^="Enter Email"]'), email);
    await fillIf(page.locator('label', { hasText: 'Nationality' }).locator('xpath=..').locator('input'), 'TW');
    await page.locator('input[type="checkbox"]').last().check();
  };

  // 行業別 is a radio-group; clicking the option is the only way its value gets
  // set (fill() on the container does nothing and throws nowhere).
  const pickCompanyIndustry = async () => {
    await page.getByRole('button', { name: /機械設備類/ }).first().click();
    await page.waitForTimeout(200);
  };

  const records = () => page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('ExhibitionFormDB');
    r.onsuccess = () => {
      const db = r.result;
      const g = db.transaction('records', 'readonly').objectStore('records').getAll();
      g.onsuccess = () => { db.close(); res(g.result); };
    };
  }));

  await page.goto(BASE + '/seed');
  await H.wipeDB(page);
  await page.goto(BASE + '/');
  await page.waitForTimeout(1600);

  // ---- 1. first contact, then loop ----
  await H.enterEvent(page);
  await H.pickCustomerStatus(page);
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(600);
  assert((await page.locator('[data-add-contact]').count()) === 1, '客戶資料頁有「增加聯絡人」');
  assert((await page.locator('[data-contact-chip]').count()) === 0, '還沒新增時沒有計數標籤');

  await fillCustomer({ name: '王大明', company: '宏昌實業', email: 'first@example.com' });
  await page.screenshot({ path: path.join(SHOT, '01_first_contact.png'), fullPage: true });
  await page.locator('[data-add-contact]').click();
  await page.waitForTimeout(700);

  // ---- 2. the page comes back with the company and nothing else ----
  assert((await companyBox().inputValue()) === '宏昌實業',
    '公司留著——同一家公司，重打一次正是這個功能要消滅的浪費');
  assert((await nameBox().inputValue()) === '', '姓名清空了');
  assert((await page.locator('input[placeholder^="Enter Email"]').inputValue()) === '',
    '電子信箱清空了——沿用上一位的信箱是事後看不出來的錯');
  assert(!(await page.locator('input[type="checkbox"]').last().isChecked()),
    '同意條款回到未勾：那份條文是給下一個人看的');
  assert((await page.locator('[data-contact-chip]').innerText()).includes('已新增 1 位'),
    '頁首顯示已新增幾位：' + await page.locator('[data-contact-chip]').innerText());
  await page.screenshot({ path: path.join(SHOT, '02_looped.png'), fullPage: true });

  let rows = await records();
  assert(rows.length === 1, `第一位已經是一筆獨立紀錄（實際 ${rows.length}）`);

  // ---- 3. second contact, then the shared pages ----
  await fillCustomer({ name: '李小華', email: 'second@example.com' });
  await page.getByRole('button', { name: /Next 下一步/ }).click();   // -> company
  await page.waitForTimeout(500);
  // Both shared groups must end up carrying a real value. Two empty objects
  // compare equal, so a group left blank would make its "both records agree"
  // assertion true no matter what the code does.
  await pickCompanyIndustry();
  await page.getByRole('button', { name: /Next 下一步/ }).click();   // -> needs
  await page.waitForTimeout(500);
  const notesBox = page.locator('textarea');
  if (await notesBox.count()) await notesBox.first().fill('兩位一起來的');
  await page.getByRole('button', { name: /Finish 完成/ }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOT, '03_handoff.png'), fullPage: true });
  assert((await page.locator('[data-handoff-count]').innerText()).includes('2 筆'),
    '完成頁告訴接待人員建立了幾筆：' + await page.locator('[data-handoff-count]').innerText());

  // v3.16.2: the 完成，返回 button used to be deliberately faded so a visitor
  // would not tap it. That is no longer wanted — same place, same words, but
  // the app's ordinary secondary colours.
  const doneBtn = await page.locator('[data-handoff-done]').evaluate(el => {
    const c = getComputedStyle(el);
    return { color: c.color, bg: c.backgroundColor };
  });
  assert(doneBtn.color === 'rgb(0, 85, 184)',
    '完成鈕是正常的藍字，不再是淡化的灰：' + doneBtn.color);
  assert(doneBtn.bg === 'rgb(255, 255, 255)',
    '底色是白的，不再是透明：' + doneBtn.bg);

  // ---- 4. two records, shared answers on both, personal answers separate ----
  rows = (await records()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  assert(rows.length === 2, `後台是兩筆獨立紀錄（實際 ${rows.length}）`);
  const [a, b] = rows;
  assert(a.customerFields.name === '王大明' && b.customerFields.name === '李小華',
    '兩筆各自的姓名：' + rows.map(r => r.customerFields.name).join(' / '));
  assert(a.customerFields.company === b.customerFields.company,
    '公司相同（第二位是帶過去的）');
  assert(a.customerFields.email !== b.customerFields.email,
    '電子信箱各自不同');
  assert(JSON.stringify(a.needsFields) === JSON.stringify(b.needsFields),
    '客戶需求兩筆一致——只答了一次');
  assert(JSON.stringify(a.companyFields) === JSON.stringify(b.companyFields),
    '公司背景兩筆一致');
  assert(JSON.stringify(a.staffFields) === JSON.stringify(b.staffFields),
    '接待人員／日期／新舊客戶兩筆一致');
  assert(Object.keys(a.needsFields).length > 0 && Object.keys(a.companyFields).length > 0,
    '兩組共同答案都真的有值，不是兩個空物件相等（那樣上面兩條永遠會過）：'
    + JSON.stringify(a.companyFields));

  // ---- 5. …and nothing ties them together ----
  const linkKeys = Object.keys(a).filter(k => /group|contact|sibling|parent|party/i.test(k));
  assert(linkKeys.length === 0, '紀錄上沒有任何關聯欄位：' + (linkKeys.join(', ') || '（無）'));
  assert(a.id !== b.id, '各自的 id');

  // ---- 6. the reverse flow: customer page is the LAST step ----
  // The one that is easy to get wrong — the shared answers exist *before* the
  // second contact is created, so they have to be carried forward rather than
  // pushed back.
  await page.getByRole('button', { name: /完成，返回|Done/ }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  await H.pickCustomerStatus(page);
  await page.locator('[data-entry-needs]').click();
  await page.waitForTimeout(600);
  if (await notesBox.count()) await notesBox.first().fill('從需求開始的一組');
  await page.getByRole('button', { name: /Next 下一步/ }).click();   // -> company
  await page.waitForTimeout(500);
  await pickCompanyIndustry();
  await page.getByRole('button', { name: /Next 下一步/ }).click();   // -> customer (last)
  await page.waitForTimeout(500);
  await fillCustomer({ name: '張三', company: '第二組公司', email: 'third@example.com' });
  await page.locator('[data-add-contact]').click();
  await page.waitForTimeout(700);
  await fillCustomer({ name: '李四', email: 'fourth@example.com' });
  await page.getByRole('button', { name: /Finish 完成/ }).click();
  await page.waitForTimeout(800);

  rows = (await records()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  assert(rows.length === 4, `第二組又是兩筆（總共 ${rows.length}）`);
  const [c, d] = rows.slice(2);
  assert(c.customerFields.name === '張三' && d.customerFields.name === '李四',
    '反向流程的兩位都寫進去了：' + rows.slice(2).map(r => r.customerFields.name).join(' / '));
  assert(Object.keys(d.needsFields).length > 0 && Object.keys(d.companyFields).length > 0,
    '客戶資料是最後一步時，後加的那位仍帶著先前答過的需求與公司背景——共同答案要往前帶：'
    + JSON.stringify(d.companyFields));
  assert(JSON.stringify(c.needsFields) === JSON.stringify(d.needsFields),
    '反向流程兩筆的需求一致');
  assert(JSON.stringify(c.companyFields) === JSON.stringify(d.companyFields),
    '反向流程兩筆的公司背景一致');

  // ---- 7. editing one record is not a flow ----
  await page.getByRole('button', { name: /完成，返回|Done/ }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  await H.openAdmin(page, '資料紀錄');
  await page.getByRole('button', { name: '編輯' }).first().click();
  await page.waitForTimeout(700);
  assert((await page.locator('[data-add-contact]').count()) === 0,
    '編輯既有紀錄時沒有「增加聯絡人」——編輯是修一筆，不是開一個流程');
  await page.screenshot({ path: path.join(SHOT, '04_edit_no_button.png'), fullPage: true });

  // ---- 8. v3.16.3: taking the 增加聯絡人 back ----
  //
  // Reported from the booth. Press 增加聯絡人, change your mind, and there was
  // no way out: 下一步 will not move with the required fields blank, and 返回
  // left the flow altogether (客戶資料 is step 1 here, so onCustomerBack went
  // home and flowResetPatch dropped the siblings). The first contact was
  // already written but had never reached the needs or company pages, so it sat
  // in the admin list half-filled and had to be completed by hand afterwards.
  await page.goto(BASE + '/');
  await page.waitForTimeout(1500);
  await H.enterEvent(page);
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(600);
  const before = (await records()).length;

  assert((await page.locator('[data-cancel-contact]').count()) === 0,
    '第一位聯絡人時沒有取消鈕——沒有東西可以取消');

  await fillCustomer({ name: '取消測試', company: '退路實業', email: 'cancel@example.com' });
  const phoneBox = page.locator('input[placeholder^="Enter Phone"]');
  if (await phoneBox.count()) await phoneBox.first().fill('912345678');
  await page.locator('[data-add-card-photo] input[type="file"]')
    .setInputFiles({ name: 'front.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG });
  await page.waitForTimeout(600);
  const photosBefore = await page.evaluate(() => window.__app.state.cardPhotos.length);
  assert(photosBefore === 1, '第一位帶了一張名片（實際 ' + photosBefore + '）');

  await page.locator('[data-add-contact]').click();
  await page.waitForTimeout(700);
  assert((await page.locator('[data-cancel-contact]').count()) === 1,
    '加了第二位之後才出現取消鈕');

  // The placement, asserted as a layout invariant rather than left to review.
  // 下一步／完成 is the bottom-most, filled, full-width button on this page and
  // on every page before it; that slot is reached by habit, not by reading. A
  // cancel placed there — or anywhere below it — would also shift 下一步
  // between the first contact's page and the second's.
  const stack = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
      .filter(b => /取消，返回上一位|增加聯絡人|Next 下一步|Finish 完成/.test(b.innerText))
      .map(b => ({ text: b.innerText.trim(), top: Math.round(b.getBoundingClientRect().top) }));
    return btns.sort((a, b) => a.top - b.top).map(b => b.text);
  });
  assert(/Next 下一步|Finish 完成/.test(stack[stack.length - 1]),
    '「下一步／完成」仍是按鈕堆最底下那顆：' + stack.join(' → '));
  assert(stack[0].includes('取消'), '取消鈕在最上面，離拇指預設的位置最遠：' + stack.join(' → '));

  await page.screenshot({ path: path.join(SHOT, '05_cancel_button.png'), fullPage: true });
  await page.locator('[data-cancel-contact]').click();
  await page.waitForTimeout(700);

  // Back to the moment before the button was pressed: same page, first
  // contact's data in the form, counter gone.
  assert((await nameBox().inputValue()) === '取消測試',
    '取消後表單回到第一位的資料：' + await nameBox().inputValue());
  assert((await page.locator('[data-contact-chip]').count()) === 0,
    '「已新增 N 位」標籤消失了');
  assert((await page.locator('[data-cancel-contact]').count()) === 0,
    '沒有東西可以再取消了');
  const restored = await page.evaluate(() => ({
    photos: window.__app.state.cardPhotos.length,
    cc: window.__app.state.selectedCountryCode,
    siblings: window.__app.state.flowSiblingIds.length,
  }));
  // Submitting assigns cardPhotos wholesale from state, so a record pulled back
  // without its photos loses the card on the next 下一步 — silently, and only
  // visible days later in the export.
  assert(restored.photos === 1, '第一位的名片照片跟著回到表單（實際 ' + restored.photos + ' 張）');
  assert(restored.siblings === 0, 'flowSiblingIds 已經空了');
  assert(restored.cc === '+886', '國碼欄位回到 +886：' + restored.cc);
  const phoneVal = await phoneBox.count() ? await phoneBox.first().inputValue() : '';
  assert(phoneVal === '912345678', '號碼欄位是拆過國碼的號碼，不是整串：' + phoneVal);

  // The point of the whole fix: finish normally and get one complete record.
  await page.getByRole('button', { name: /Next 下一步/ }).click();   // -> company
  await page.waitForTimeout(500);
  await pickCompanyIndustry();
  await page.getByRole('button', { name: /Next 下一步/ }).click();   // -> needs
  await page.waitForTimeout(500);
  if (await notesBox.count()) await notesBox.first().fill('改成只有一位');
  await page.getByRole('button', { name: /Finish 完成/ }).click();
  await page.waitForTimeout(800);

  rows = await records();
  const made = rows.filter(r => r.customerFields.name === '取消測試');
  assert(rows.length === before + 1 && made.length === 1,
    `取消之後只留下一筆（總數 ${before} → ${rows.length}，同名 ${made.length} 筆）`);
  const only = made[0];
  assert(Object.keys(only.needsFields).length > 0 && Object.keys(only.companyFields).length > 0,
    '而且那一筆是完整的——需求與公司背景都答在它身上，這正是舊行為做不到的：'
    + JSON.stringify(only.companyFields));
  assert((only.cardPhotos || []).length === 1,
    '名片照片還在（實際 ' + (only.cardPhotos || []).length + ' 張）');
  const phoneStored = only.customerFields.phone || '';
  assert(!/\+886.*\+886/.test(phoneStored) && (!phoneStored || phoneStored === '+886 912345678'),
    '電話沒有被加上第二個國碼：' + phoneStored);

  // ---- 8b. the header 返回 does the same thing while a contact is parked ----
  // This is the button the person at the booth actually pressed, so fixing only
  // the new one would leave the trap in place.
  await page.getByRole('button', { name: /完成，返回|Done/ }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  await H.pickCustomerStatus(page);
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(600);
  await fillCustomer({ name: '返回測試', company: '返回實業', email: 'back@example.com' });
  await page.locator('[data-add-contact]').click();
  await page.waitForTimeout(700);
  const backLabel = await page.locator('[data-page-header] button').last().innerText();
  assert(backLabel.includes('返回上一位'), '有聯絡人停放時頁首按鈕改口說「返回上一位」：' + backLabel);
  await page.locator('[data-page-header] button').last().click();
  await page.waitForTimeout(700);
  assert((await nameBox().inputValue()) === '返回測試',
    '頁首「返回」也回到上一位，而不是離開流程：' + await nameBox().inputValue());
  // …and once nothing is parked it leaves the flow exactly as before.
  await page.locator('[data-page-header] button').last().click();
  await page.waitForTimeout(700);
  assert((await page.locator('[data-entry-customer]').count()) === 1
    || (await page.locator('[data-ev-enter]').count()) > 0,
    '沒有停放的聯絡人時，「返回」維持原本離開流程的行為');

  assert(errors.length === 0, '無 console error：' + errors.join(' | '));
  await browser.close();
  app.close();
  console.log(fails ? `\nMULTI CONTACT FAILED (${fails})` : '\nMULTI CONTACT PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
