// v3.8: the record browser, quick entry, the country combobox, ended events
// moving behind 活動管理, and the roster/nationality migration.
//
// The theme running through most of these is that reception should be able to
// do their job without ever standing next to a destructive control: browsing
// records is its own screen rather than a link into 表單管理, and ended events
// are not in the way of today's event.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-v38');
fs.mkdirSync(SHOT, { recursive: true });

const ROSTER_ZH = ['蘇秋菊', '黃柏儒', '陳誌翔', '鄭淑卿', '顏耀中', '黃世仰', '張詩穎', '張瑞育'];

(async () => {
  const server = await H.serve(8962);
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

  // ---- 1. rename + gear labels ----
  assert((await page.title()).startsWith('會談紀錄表'), '標題已更名：' + (await page.title()));
  assert((await page.locator('[data-gear-events]').innerText()).includes('活動管理'),
    '活動列表的齒輪標示「活動管理」');

  // ---- 2. default roster is the 8-person team ----
  const staff = (await H.readAll(page, 'events'))[0].staff;
  assert(JSON.stringify(staff.map(s => s.zh)) === JSON.stringify(ROSTER_ZH),
    '全新安裝的預設名冊為 8 人：' + staff.map(s => s.zh).join('、'));
  assert(staff[0].en === 'Charlene' && staff[7].en === 'Rick', '英文名對應正確');

  // ---- 3. ended events hide until 活動管理 is unlocked ----
  await H.unlockManage(page);
  await page.getByRole('button', { name: '結束活動' }).first().click();
  await page.waitForTimeout(300);
  // Ending an event is reversible, so its confirm is single-stage and the
  // action button repeats the verb rather than saying 確定.
  await page.locator('div[style*="position: fixed"]')
    .getByRole('button', { name: '結束活動' }).click();
  await page.waitForTimeout(700);
  assert((await page.locator('body').innerText()).includes('已結束'), '管理模式下看得到「已結束」區');
  await page.getByRole('button', { name: /管理中/ }).click();   // lock again
  await page.waitForTimeout(500);
  // The only event is ended, so with the section hidden the list is empty.
  // Asserting on cards rather than the string 已結束, which also appears in the
  // "活動已結束" toast still fading out.
  assert((await page.locator('[data-event-card]').count()) === 0,
    '鎖定後看不到任何已結束的活動卡片');
  assert(!(await page.locator('[data-ended-heading]').count()),
    '「已結束」標題整個不存在');
  await page.screenshot({ path: path.join(SHOT, '01_locked_no_ended.png'), fullPage: true });

  // Reopen it so the rest of the suite has a usable event.
  await H.unlockManage(page);
  await page.getByRole('button', { name: '重新啟用' }).first().click();
  await page.waitForTimeout(300);
  await page.locator('div[style*="position: fixed"]')
    .getByRole('button', { name: '重新啟用' }).click();
  await page.waitForTimeout(700);

  // ---- 4. event-home gear label + the three entries ----
  await H.lockManage(page);
  await page.locator('[data-ev-enter]').first().click();
  await page.waitForTimeout(600);
  assert((await page.locator('[data-gear-admin]').innerText()).includes('表單管理'),
    '活動內頁的齒輪標示「表單管理」');
  assert((await page.locator('[data-entry-quick]').count()) === 0,
    'v3.10 移除了「快速填單」按鈕，改由新／舊客戶決定是否含公司背景');
  assert((await page.locator('[data-open-browse]').count()) === 1, '出現客戶資料紀錄入口');

  // ---- 5. skipping Company Profile: 舊客戶 + 從客戶資料開始 ----
  // Was the v3.8 「快速填單」button; v3.10 reaches the same flow through the
  // 新／舊客戶 gate. The behaviour under test is unchanged: two steps, no
  // Company Profile, empty companyFields.
  await page.locator('[data-staff-picker] button').first().click();
  await page.waitForTimeout(150);
  const chips = page.locator('[data-date-picker] button');
  if (await chips.count()) await chips.first().click();
  else await page.locator('input[type="date"]').first().fill('2026-08-06');
  await page.waitForTimeout(250);

  await H.pickCustomerStatus(page, 'Existing');
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(600);
  let body = await page.locator('body').innerText();
  assert(body.includes('1 / 2'), '舊客戶第一步顯示 1 / 2：' + (body.match(/\d \/ \d/) || ['(無)'])[0]);

  await page.locator('input[placeholder^="Enter Name"]').first().fill('快速客戶');
  await page.locator('input[placeholder^="Enter Company"]').first().fill('快速公司');
  await page.locator('input[placeholder^="Enter Email"]').first().fill('quick@co.com');
  // Nationality is now a combobox; type and pick.
  const combo = page.locator('[data-combo] input').first();
  await combo.click();
  await combo.fill('德');
  await page.waitForTimeout(300);
  const matches = await page.locator('[data-combo-opt]').allInnerTexts();
  assert(matches.some(t => t.includes('Germany')), '國籍搜尋「德」找得到德國：' + matches.join(' | '));
  await page.locator('[data-combo-opt]').first().click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOT, '02_combo.png'), fullPage: true });

  // v3.11: once picked, the closed box names the country in both languages —
  // the option list is gone by then, so this is the only place the Chinese can
  // show. Focusing must hand back the bare stored value, or the blur matcher
  // would see "Germany 德國", find no option, and store that string verbatim.
  assert((await combo.inputValue()) === 'Germany 德國',
    '選定後輸入框中英並陳：' + (await combo.inputValue()));
  await combo.click();
  await page.waitForTimeout(200);
  assert((await combo.inputValue()) === 'Germany',
    '重新聚焦時回到可編輯的英文值：' + (await combo.inputValue()));
  await page.locator('input[placeholder^="Enter Name"]').first().click();  // blur
  await page.waitForTimeout(400);
  assert((await combo.inputValue()) === 'Germany 德國', '離開後又變回中英並陳');

  await page.locator('input[type="checkbox"]').last().check();
  await page.getByRole('button', { name: /Next 下一步/ }).click();
  await page.waitForTimeout(600);
  body = await page.locator('body').innerText();
  assert(body.includes('2 / 2'), '第二步顯示 2 / 2');
  assert(!body.includes('Company Profile') && !body.includes('公司背景'),
    '舊客戶完全沒有經過公司背景頁');
  await page.getByRole('button', { name: /Finish 完成/ }).click();
  await page.waitForTimeout(800);

  const quickRec = (await H.readAll(page, 'records'))[0];
  assert(quickRec.customerFields.name === '快速客戶', '舊客戶流程有寫入紀錄');
  assert(quickRec.staffFields.customer_status === 'Existing',
    '紀錄標記為舊客戶：' + quickRec.staffFields.customer_status);
  assert(Object.keys(quickRec.companyFields || {}).length === 0,
    '舊客戶的公司背景為空：' + JSON.stringify(quickRec.companyFields));
  assert(quickRec.customerFields.nationality === 'Germany',
    '國籍存的是英文國名：' + quickRec.customerFields.nationality);

  // ---- 6. the normal flow still has all three steps ----
  await page.getByRole('button', { name: /完成，返回|Done/ }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  await H.pickCustomerStatus(page);
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(500);
  body = await page.locator('body').innerText();
  assert(body.includes('1 / 3'), '一般填單仍是三步驟：' + (body.match(/\d \/ \d/) || ['(無)'])[0]);
  await page.locator('input[placeholder^="Enter Name"]').first().fill('一般客戶');
  await page.locator('input[placeholder^="Enter Company"]').first().fill('一般公司');
  await page.locator('input[placeholder^="Enter Email"]').first().fill('normal@co.com');
  const combo2 = page.locator('[data-combo] input').first();
  await combo2.click();
  await combo2.fill('Freedonia');           // not on the list
  // Deliberately no wait before submitting: typing a country and immediately
  // moving on must not lose the value. An earlier version only committed the
  // combobox on blur (deferred 150ms so option clicks could land), which made
  // exactly this sequence submit an empty required field.
  await page.locator('input[type="checkbox"]').last().check();
  await page.getByRole('button', { name: /Next 下一步/ }).click();
  await page.waitForTimeout(600);
  body = await page.locator('body').innerText();
  assert(body.includes('2 / 3'), '一般填單第二步是公司背景 2 / 3');

  const freeRec = (await H.readAll(page, 'records')).find(r => r.customerFields?.name === '一般客戶');
  assert(freeRec && freeRec.customerFields.nationality === 'Freedonia',
    '清單外的國名照樣存得下去：' + JSON.stringify(freeRec && freeRec.customerFields.nationality));

  await page.getByRole('button', { name: /Next 下一步/ }).click();   // company -> needs
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /Finish 完成/ }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /完成，返回|Done/ }).first().click().catch(() => {});
  await page.waitForTimeout(600);

  // ---- 7. the record browser ----
  assert((await page.locator('[data-browse-row]').count()) === 0, '未輸入 PIN 前看不到紀錄列表');
  await page.locator('[data-open-browse]').click();
  await page.waitForTimeout(400);
  await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('0000');
  await page.getByRole('button', { name: '登入' }).click();
  await page.waitForTimeout(600);

  assert((await page.locator('[data-browse-row]').count()) === 2, '瀏覽頁列出本活動 2 筆紀錄');
  const browseText = await page.locator('body').innerText();
  assert(!/刪除/.test(browseText), '瀏覽頁沒有任何刪除按鈕');
  assert(!/匯出/.test(browseText), '瀏覽頁沒有任何匯出按鈕');
  assert(!/清除全部/.test(browseText), '瀏覽頁沒有清除全部');
  await page.screenshot({ path: path.join(SHOT, '03_browse.png'), fullPage: true });

  // search
  await page.locator('[data-browse-search]').fill('快速');
  await page.waitForTimeout(300);
  assert((await page.locator('[data-browse-row]').count()) === 1, '搜尋「快速」只剩 1 筆');
  assert((await page.locator('[data-browse-count]').innerText()).includes('符合 1'), '筆數說明同步更新');
  await page.locator('[data-browse-search]').fill('不存在的公司');
  await page.waitForTimeout(300);
  assert((await page.locator('[data-browse-row]').count()) === 0, '查無結果時列表為空');
  await page.locator('[data-browse-search]').fill('');
  await page.waitForTimeout(300);

  // edit from the browser, and land back in the browser
  await page.locator('[data-browse-row] button').first().click();
  await page.waitForTimeout(600);
  assert((await page.locator('body').innerText()).includes('編輯資料'), '從瀏覽頁可以進入編輯');
  await page.locator('input[placeholder^="Enter Company"]').first().fill('改過的公司');
  await page.getByRole('button', { name: /Save 儲存/ }).click();
  await page.waitForTimeout(900);
  assert((await page.locator('[data-browse-row]').count()) === 2,
    '存檔後回到瀏覽頁（不是後台資料紀錄）');
  assert((await page.locator('body').innerText()).includes('改過的公司'), '編輯的內容已生效');

  assert(errors.length === 0, '無 console error：' + errors.join(' | '));
  await ctx.close();

  // ---- 8. migration: existing event gets the new roster and country field ----
  {
    const c2 = await browser.newContext({ viewport: { width: 1280, height: 950 } });
    const p2 = await c2.newPage();
    await p2.goto(BASE + '/seed');
    await H.wipeDB(p2);
    await p2.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('ExhibitionFormDB', 2);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        db.createObjectStore('config', { keyPath: 'key' });
        db.createObjectStore('records', { keyPath: 'id' });
        db.createObjectStore('fieldDefinitions', { keyPath: 'key' });
        db.createObjectStore('events', { keyPath: 'id' });
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['events', 'fieldDefinitions', 'records', 'config'], 'readwrite');
        tx.objectStore('events').put({ id: 'ev-old', name: '2026 美國展',
          startDate: '2026-08-05', endDate: '2026-08-06',
          staff: [{ en: 'Esme', zh: '陳佩昀' }, { en: 'Crystal', zh: '宋佳蓉' }],
          status: 'active', createdAt: '2026-08-01T00:00:00.000Z' });
        const fd = tx.objectStore('fieldDefinitions');
        fd.put({ key: 'ev-old::customerFields', value: [
          { id: 'name', nameEn: 'Name', nameZh: '姓名', type: 'text', required: true, isCore: true, order: 0, options: [] },
          { id: 'nationality', nameEn: 'Nationality', nameZh: '訪客國籍', type: 'text', required: true, isCore: true, order: 1, options: [] },
        ]});
        fd.put({ key: 'ev-old::needsFields', value: [] });
        fd.put({ key: 'ev-old::companyFields', value: [] });
        fd.put({ key: 'ev-old::staffFields', value: [] });
        tx.objectStore('records').put({ id: 'r-old', eventId: 'ev-old',
          timestamp: '2026-08-05T09:00:00.000Z', device: 'Tablet-1',
          customerFields: { name: '舊客戶', nationality: 'TW' },
          needsFields: {}, companyFields: {}, staffFields: {},
          gdprConsent: true, cardPhoto: null });
        tx.objectStore('config').put({ key: 'migratedTo35', value: true });
        tx.objectStore('config').put({ key: 'migratedTo36', value: true });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    }));

    await p2.goto(BASE + '/');
    await p2.waitForTimeout(1800);

    const ev = (await H.readAll(p2, 'events'))[0];
    assert(JSON.stringify(ev.staff.map(s => s.zh)) === JSON.stringify(ROSTER_ZH),
      '既有活動的名冊被換成新的 8 人：' + ev.staff.map(s => s.zh).join('、'));

    const custDefs = await H.readDefs(p2, 'customerFields');
    const nat = custDefs.find(f => f.id === 'nationality');
    assert(nat.type === 'select' && nat.searchable === true, '訪客國籍已升級為可搜尋選單');
    assert(nat.options.length === 60, `國家選項共 60 個：${nat.options.length}`);
    assert(nat.options.some(o => o.en === 'Taiwan' && o.zh === '台灣'), '清單含台灣');
    assert(nat.nameZh === '訪客國籍', '後台自訂的中文標籤保留');

    const rec = (await H.readAll(p2, 'records'))[0];
    assert(rec.customerFields.nationality === 'TW',
      '舊紀錄的自由文字國籍值原樣保留：' + rec.customerFields.nationality);
    await c2.close();
  }

  await browser.close();
  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nV3.8 PASSED');
  process.exit(fails ? 1 : 0);
})();
