// v3.10: the event page asks 新客戶 / 舊客戶 before the two entries, and the
// entries now only choose which form comes first.
//
// v3.8 had three sibling buttons — 客戶資料 / 客戶需求 / 快速填單 — which mixed
// two independent questions: whether Company Profile is needed at all, and
// which form to start from. 快速填單 was really just one of the four
// combinations, so it looked like a third alternative. Splitting the two axes
// makes all four reachable and drops the confusing name.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-entry');
fs.mkdirSync(SHOT, { recursive: true });

(async () => {
  const server = await H.serve(8964);
  const BASE = server.base;
  const browser = await H.launchBrowser();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE + '/seed');
  await H.wipeDB(page);
  await page.goto(BASE + '/');
  await page.waitForTimeout(1600);
  await page.locator('[data-event-card] button').first().click();
  await page.waitForTimeout(600);

  // ---- 1. the confusing wording is gone, the new choice is present ----
  let body = await page.locator('body').innerText();
  assert(!body.includes('快速填單') && !body.includes('Quick Entry'), '沒有「快速填單」字樣');
  assert(!body.includes('不含公司背景'), '沒有「不含公司背景」的描述');
  assert(body.includes('從客戶資料開始') && body.includes('從客戶需求開始'), '兩個入口已更名');
  assert(body.includes('客戶公司背景') && body.includes('新客戶') && body.includes('舊客戶'),
    '出現新／舊客戶選擇');
  assert(body.includes('新客戶需填寫公司背景，舊客戶略過'), '有說明這個選擇會改變什麼');
  await page.screenshot({ path: path.join(SHOT, '01_home.png'), fullPage: true });

  // ---- 2. the new gate really gates ----
  const gate = () => page.evaluate(() => ({
    cust: document.querySelector('[data-entry-customer]').disabled,
    needs: document.querySelector('[data-entry-needs]').disabled,
    hint: document.querySelector('[data-entry-hint]')?.innerText.trim() || '',
  }));
  await page.locator('[data-staff-picker] button').first().click();
  await page.waitForTimeout(150);
  const chips = page.locator('[data-date-picker] button');
  if (await chips.count()) await chips.first().click();
  else await page.locator('input[type="date"]').first().fill('2026-08-06');
  await page.waitForTimeout(250);
  let g = await gate();
  assert(g.cust && g.needs, '人員與日期都選了，但沒選新舊客戶時入口仍停用');
  assert(g.hint.includes('新舊客戶'), '提示文字提到新舊客戶：' + g.hint);

  // ---- 3. all four combinations ----
  // [status, entry, expected first step label, whether Company Profile appears]
  const CASES = [
    ['New',      'customer', '1 / 3', true,  '新客戶＋從客戶資料開始'],
    ['New',      'needs',    '1 / 3', true,  '新客戶＋從客戶需求開始'],
    ['Existing', 'customer', '1 / 2', false, '舊客戶＋從客戶資料開始'],
    ['Existing', 'needs',    '1 / 2', false, '舊客戶＋從客戶需求開始'],
  ];

  const fillCustomer = async (name) => {
    await page.locator('input[placeholder^="Enter Name"]').first().fill(name);
    await page.locator('input[placeholder^="Enter Company"]').first().fill('測試公司');
    await page.locator('input[placeholder^="Enter Email"]').first().fill('a@b.com');
    const combo = page.locator('[data-combo] input').first();
    await combo.click();
    await combo.fill('Taiwan');
    await page.locator('input[type="checkbox"]').last().check();
  };

  for (const [status, entry, firstLabel, wantsCompany, label] of CASES) {
    await H.pickCustomerStatus(page, status);
    await page.locator(`[data-entry-${entry}]`).click();
    await page.waitForTimeout(600);

    body = await page.locator('body').innerText();
    assert(body.includes(firstLabel), `${label}：第一步為 ${firstLabel}（實際 ${(body.match(/\d \/ \d/) || ['無'])[0]}）`);

    // Walk the flow to the end, noting whether Company Profile ever shows up.
    let sawCompany = false;
    for (let step = 0; step < 3; step++) {
      body = await page.locator('body').innerText();
      if (body.includes('Company Profile')) sawCompany = true;
      if (body.includes('Customer Info') && (await page.locator('input[placeholder^="Enter Name"]').count())) {
        await fillCustomer(label);
      }
      const finish = page.getByRole('button', { name: /Finish 完成/ });
      if (await finish.count()) { await finish.click(); await page.waitForTimeout(800); break; }
      await page.getByRole('button', { name: /Next 下一步/ }).click();
      await page.waitForTimeout(600);
    }

    assert(sawCompany === wantsCompany,
      `${label}：${wantsCompany ? '有' : '完全沒有'}經過公司背景頁（實際 ${sawCompany ? '有' : '沒有'}）`);

    const rec = (await H.readAll(page, 'records')).find(r => r.customerFields?.name === label);
    assert(rec, `${label}：紀錄已建立`);
    assert(rec && rec.staffFields.customer_status === status,
      `${label}：紀錄的新舊客戶為 ${status}（實際 ${rec && rec.staffFields.customer_status}）`);
    if (!wantsCompany) {
      assert(Object.keys(rec.companyFields || {}).length === 0,
        `${label}：公司背景為空`);
    }

    await page.getByRole('button', { name: /完成，返回|Done/ }).first().click();
    await page.waitForTimeout(600);

    // ---- 4. the choice resets after each record; staff and date do not ----
    g = await gate();
    assert(g.cust && g.needs, `${label} 之後：新舊客戶已重置，入口重新停用`);
    const banner = await page.locator('[data-session-banner]').innerText();
    assert(banner.includes('填單人員') && banner.includes('填單日期'),
      `${label} 之後：人員與日期仍保留，不必重選`);
  }
  await page.screenshot({ path: path.join(SHOT, '02_after_all.png'), fullPage: true });

  // ---- 5. the export carries the new column ----
  await H.pickCustomerStatus(page, 'New');
  await H.openAdmin(page, '資料紀錄');
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: '匯出資料' }).click();
  const zipPath = path.join(SHOT, 'export_entry.zip');
  await (await dl).saveAs(zipPath);
  const buf = fs.readFileSync(zipPath);
  const has = (str) => buf.includes(Buffer.from(str, 'utf8'));
  assert(has('Customer Status'), '匯出含 Customer Status 欄');
  assert(has('Existing'), '匯出帶出舊客戶的值');

  assert(errors.length === 0, '無 console error：' + errors.join(' | '));
  await ctx.close();

  // ---- 6. migration: an event created before v3.10 gains the field ----
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
          staff: [{ en: 'Charlene', zh: '蘇秋菊' }],
          status: 'active', createdAt: '2026-08-01T00:00:00.000Z' });
        const fd = tx.objectStore('fieldDefinitions');
        fd.put({ key: 'ev-old::customerFields', value: [
          { id: 'name', nameEn: 'Name', nameZh: '姓名', type: 'text', required: true, isCore: true, order: 0, options: [] },
        ]});
        fd.put({ key: 'ev-old::needsFields', value: [] });
        fd.put({ key: 'ev-old::companyFields', value: [] });
        // Pre-v3.10 staffFields: greeter + visit_date, no customer_status.
        fd.put({ key: 'ev-old::staffFields', value: [
          { id: 'greeter', nameEn: 'Greeter', nameZh: '接待人員', type: 'checkbox-group', source: 'event', required: false, isCore: true, order: 0, allowOther: false, options: [] },
          { id: 'visit_date', nameEn: 'Visit Date', nameZh: '訪談日期', type: 'date', source: 'event', required: false, isCore: true, order: 1, allowOther: false, options: [] },
        ]});
        tx.objectStore('records').put({ id: 'r-old', eventId: 'ev-old',
          timestamp: '2026-08-05T09:00:00.000Z', device: 'Tablet-1',
          customerFields: { name: '舊客戶紀錄' }, needsFields: {}, companyFields: {},
          staffFields: { greeter: ['Charlene'], visit_date: '2026-08-05' },
          gdprConsent: true, cardPhoto: null });
        for (const k of ['migratedTo35', 'migratedTo36', 'migratedTo38']) {
          tx.objectStore('config').put({ key: k, value: true });
        }
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    }));

    await p2.goto(BASE + '/');
    await p2.waitForTimeout(1800);

    const defs = await H.readDefs(p2, 'staffFields');
    const cs = defs.find(f => f.id === 'customer_status');
    assert(cs, '既有活動補上了 customer_status 欄位定義');
    assert(cs && cs.source === 'event', '補上的欄位標記為由活動設定，後台不可編輯');
    const ids = defs.map(f => f.id);
    assert(JSON.stringify(ids) === JSON.stringify(['greeter', 'visit_date', 'customer_status']),
      '插在訪談日期之後，接待資訊三個欄位維持相鄰：' + ids.join(','));

    const rec = (await H.readAll(p2, 'records'))[0];
    assert(rec.customerFields.name === '舊客戶紀錄' && rec.staffFields.greeter[0] === 'Charlene',
      '既有紀錄完好');
    assert(rec.staffFields.customer_status === undefined,
      '既有紀錄沒有被塞入捏造的值（當時並沒有問過）');
    await c2.close();
  }

  await browser.close();
  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nENTRY MODES PASSED');
  process.exit(fails ? 1 : 0);
})();
