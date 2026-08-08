// v3.5 option additions: new defaults for Inquiry Type / Company Type, plus the
// one-shot pass that tops up every event that already exists — without
// duplicating, overwriting a retyped label, or resurrecting a deleted option.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-options35');
fs.mkdirSync(SHOT, { recursive: true });
const BASE = 'http://localhost:8956';

// Seeds a v3.4-shaped database: an events store, per-event definition keys, and
// option lists from before the v3.5 additions.
const seedV34 = (page, events) => page.evaluate((evs) => new Promise((res, rej) => {
  const d = indexedDB.deleteDatabase('ExhibitionFormDB');
  d.onerror = () => rej(d.error);
  d.onsuccess = d.onblocked = () => {
    const req = indexedDB.open('ExhibitionFormDB', 2);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      db.createObjectStore('config', { keyPath: 'key' });
      db.createObjectStore('records', { keyPath: 'id' });
      db.createObjectStore('fieldDefinitions', { keyPath: 'key' });
      db.createObjectStore('events', { keyPath: 'id' });
    };
    req.onerror = () => rej(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['config', 'fieldDefinitions', 'events'], 'readwrite');
      for (const k of ['migratedTo33', 'migratedTo34']) tx.objectStore('config').put({ key: k, value: true });
      tx.objectStore('config').put({ key: 'pin', value: '0000' });
      for (const ev of evs) {
        tx.objectStore('events').put(ev.event);
        for (const [group, value] of Object.entries(ev.defs)) {
          tx.objectStore('fieldDefinitions').put({ key: ev.event.id + '::' + group, value });
        }
      }
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
  };
}), events);

const staffDefs = [
  { id: 'greeter', nameEn: 'Greeter', nameZh: '接待人員', type: 'checkbox-group', source: 'event',
    required: false, isCore: true, order: 0, allowOther: false, options: [] },
  { id: 'visit_date', nameEn: 'Visit Date', nameZh: '訪談日期', type: 'date', source: 'event',
    required: false, isCore: true, order: 1, allowOther: false, options: [] },
];
const custDefs = [
  { id: 'name', nameEn: 'Name', nameZh: '姓名', type: 'text', required: true, isCore: true, order: 0, options: [] },
  { id: 'company', nameEn: 'Company', nameZh: '公司', type: 'text', required: true, isCore: true, order: 1, options: [] },
];
const mkEvent = (id, name) => ({ id, name, startDate: '2026-08-01', endDate: '2026-12-31',
  staff: [{ en: 'Su Chiu-Chu', zh: '蘇秋菊' }], status: 'active', createdAt: '2026-08-01T00:00:00.000Z' });

(async () => {
  const server = await H.serve(8956);
  const browser = await H.launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  // ================= A. a fresh install carries the new defaults =================
  await page.goto(BASE + '/seed');
  await H.wipeDB(page);
  await page.goto(BASE + '/');
  await page.waitForTimeout(1600);
  await H.enterEvent(page);

  await page.locator('[data-entry-needs]').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOT, '01_needs.png'), fullPage: true });
  const needsText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  for (const [en, zh] of [['Machine Information', '機器瞭解'],
                          ['Market / Industry News', '分享市場或同業訊息'],
                          ['Greeting / Casual Chat', '打招呼聊天']]) {
    assert(needsText.includes(en + ' ' + zh), `洽談事由新增「${zh}」：${en}`);
  }
  assert(needsText.includes('Other 其他'), '洽談事由出現可填寫的「Other 其他」');

  // The Other chip opens a free-text box, and the text reaches the export.
  const inquiry = page.locator('label', { hasText: 'Inquiry Type' }).locator('xpath=..');
  await inquiry.getByText('Other', { exact: false }).last().click();
  await page.waitForTimeout(300);
  const otherBox = inquiry.locator('input[placeholder="Please specify 請填寫"]');
  assert(await otherBox.count() > 0, '勾選「其他」後出現「請填寫」文字框');
  await otherBox.fill('工廠參訪邀約');
  await page.getByText('Machine Information', { exact: false }).first().click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: /Next 下一步/ }).click();
  await page.waitForTimeout(500);

  // Company Profile is step 2 — check the new company_type option here.
  const compText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  assert(compText.includes('OEM Factory 代工廠'), '公司型態新增「代工廠」');
  await page.screenshot({ path: path.join(SHOT, '02_company.png'), fullPage: true });
  await page.getByRole('button', { name: /Next 下一步/ }).click();
  await page.waitForTimeout(500);
  // Needs-first flow, so the customer form is step 3 and ends with Finish.
  await page.locator('input[placeholder^="Enter Name"]').fill('王小明');
  await page.locator('input[placeholder^="Enter Company"]').fill('宏昌實業');
  await page.locator('input[placeholder^="Enter Email"]').fill('a@b.com');
  await page.locator('label', { hasText: 'Nationality' }).locator('xpath=..').locator('input').first().fill('TW');
  await page.locator('input[type="checkbox"]').last().check();
  await page.getByRole('button', { name: /Finish 完成/ }).click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: /完成，返回/ }).click();
  await page.waitForTimeout(500);

  await H.openAdmin(page, '資料紀錄');
  const dl = page.waitForEvent('download', { timeout: 15000 });
  await page.getByRole('button', { name: '匯出資料' }).click();
  await (await dl).saveAs(path.join(SHOT, 'export.zip'));
  const buf = fs.readFileSync(path.join(SHOT, 'export.zip'));
  const has = (s) => buf.includes(Buffer.from(s, 'utf8'));
  assert(has('Machine Information'), '匯出帶出新選項的 en 值');
  assert(has('Other: 工廠參訪邀約'), '「其他」的自填內容以 Other: 形式進入匯出');

  // ================= B. existing events get topped up =================
  await page.goto(BASE + '/seed');
  await seedV34(page, [
    {
      // Untouched pre-v3.5 lists.
      event: mkEvent('ev-a', '活動 A'),
      defs: {
        customerFields: custDefs,
        needsFields: [{ id: 'inquiry_type', nameEn: 'Inquiry Type', nameZh: '洽談事由', type: 'checkbox-group',
          required: false, isCore: true, order: 0, allowOther: false, options: [
            { en: 'Request Quote', zh: '索取報價' }, { en: 'Sample Required', zh: '樣品需求' },
            { en: 'Customization / OEM', zh: '客製化需求' }, { en: 'Become a Distributor', zh: '尋求代理' } ]}],
        companyFields: [{ id: 'company_type', nameEn: 'Company Type', nameZh: '公司型態', type: 'radio-group',
          required: false, order: 0, allowOther: true, options: [
            { en: 'Brand', zh: '品牌' }, { en: 'Shoe Factory', zh: '鞋廠' } ]}],
        staffFields: staffDefs,
      },
    },
    {
      // Admin-customized: one label retyped, one default option deleted, and
      // one of the v3.5 additions already added by hand.
      event: mkEvent('ev-b', '活動 B'),
      defs: {
        customerFields: custDefs,
        needsFields: [{ id: 'inquiry_type', nameEn: 'Inquiry Type', nameZh: '洽談事由', type: 'checkbox-group',
          required: false, isCore: true, order: 0, allowOther: false, options: [
            { en: 'Request Quote', zh: '報價需求(自訂)' },
            { en: 'Machine Information', zh: '機器介紹(自訂)' } ]}],
        companyFields: [{ id: 'company_type', nameEn: 'Company Type', nameZh: '公司型態', type: 'radio-group',
          required: false, order: 0, allowOther: true, options: [{ en: 'Brand', zh: '品牌' }] }],
        staffFields: staffDefs,
      },
    },
  ]);
  await page.goto(BASE + '/');
  await page.waitForTimeout(1800);

  const defsOf = (evId, group) => page.evaluate(([id, g]) => new Promise((res) => {
    const r = indexedDB.open('ExhibitionFormDB');
    r.onsuccess = () => {
      const db = r.result;
      const q = db.transaction('fieldDefinitions', 'readonly').objectStore('fieldDefinitions').get(id + '::' + g);
      q.onsuccess = () => { db.close(); res(q.result.value); };
    };
  }), [evId, group]);

  const aInq = (await defsOf('ev-a', 'needsFields')).find(f => f.id === 'inquiry_type');
  assert(JSON.stringify(aInq.options.map(o => o.en)) === JSON.stringify([
    'Request Quote', 'Sample Required', 'Customization / OEM', 'Become a Distributor',
    'Machine Information', 'Market / Industry News', 'Greeting / Casual Chat']),
    '活動 A：三個新選項附加在既有選項之後：' + aInq.options.map(o => o.en).join(' | '));
  assert(aInq.allowOther === true, '活動 A：洽談事由已開啟「其他」');
  const aComp = (await defsOf('ev-a', 'companyFields')).find(f => f.id === 'company_type');
  assert(aComp.options.some(o => o.en === 'OEM Factory' && o.zh === '代工廠'), '活動 A：公司型態補上代工廠');

  const bInq = (await defsOf('ev-b', 'needsFields')).find(f => f.id === 'inquiry_type');
  const bEn = bInq.options.map(o => o.en);
  assert(JSON.stringify(bEn) === JSON.stringify([
    'Request Quote', 'Machine Information', 'Market / Industry News', 'Greeting / Casual Chat']),
    '活動 B：只補缺的兩個，已手動加過的不重複：' + bEn.join(' | '));
  assert(!bEn.includes('Sample Required') && !bEn.includes('Become a Distributor'),
    '活動 B：管理者刪掉的預設選項沒有被加回來');
  assert(bInq.options.find(o => o.en === 'Request Quote').zh === '報價需求(自訂)'
    && bInq.options.find(o => o.en === 'Machine Information').zh === '機器介紹(自訂)',
    '活動 B：後台改過的中文標籤未被覆蓋');
  const bComp = (await defsOf('ev-b', 'companyFields')).find(f => f.id === 'company_type');
  assert(bComp.options.some(o => o.en === 'OEM Factory'), '活動 B（第二個活動）同樣補到');

  // ---- reloading is a no-op ----
  await page.goto(BASE + '/');
  await page.waitForTimeout(1800);
  const again = (await defsOf('ev-b', 'needsFields')).find(f => f.id === 'inquiry_type');
  assert(JSON.stringify(again.options.map(o => o.en)) === JSON.stringify(bEn),
    '重新載入不會重複附加，也不會把刪掉的加回來');

  // ---- the topped-up list actually renders on the form ----
  await page.locator('[data-event-card]', { hasText: '活動 A' }).locator('button').first().click();
  await page.waitForTimeout(600);
  await page.locator('[data-staff-picker] button').first().click();
  const dchips = page.locator('[data-date-picker] button');
  if (await dchips.count()) await dchips.first().click();
  else await page.locator('input[type="date"]').first().fill('2026-08-10');
  await page.waitForTimeout(300);
  await page.locator('[data-entry-needs]').click();
  await page.waitForTimeout(600);
  const aForm = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  assert(aForm.includes('Greeting / Casual Chat 打招呼聊天') && aForm.includes('Other 其他'),
    '既有活動補上的選項與「其他」都渲染在表單上');
  await page.screenshot({ path: path.join(SHOT, '03_migrated_form.png'), fullPage: true });

  if (errors.length) { console.error('CONSOLE ERRORS:'); errors.forEach(e => console.error('  ' + e)); fails++; }
  else console.log('ok: 無 console error');

  await browser.close(); server.close();
  console.log(fails ? `OPTIONS v3.5 FAILED (${fails})` : 'OPTIONS v3.5 PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
