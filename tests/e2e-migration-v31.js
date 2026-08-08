// The oldest migration branch still in the chain: a pre-v3.1 database where
// `potential` is the 1–5 star rating and `product_interest` has no options yet.
// Both branches re-seed themselves from the built-in catalog — which lives in
// getDefaultNeedsFields() now that the fields no longer sit on the staff page.
// When they looked the catalog up in getDefaultStaffFields() instead, the find()
// returned undefined and reading .options threw, so this DB could not open at
// all. Anything that reaches the event list proves the lookup resolves.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-mig-v31');
fs.mkdirSync(SHOT, { recursive: true });
const BASE = 'http://localhost:8958';

(async () => {
  const server = await H.serve(8958);
  const browser = await H.launchBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1024, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  await page.goto(BASE + '/seed');
  await H.wipeDB(page);
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('ExhibitionFormDB', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      db.createObjectStore('config', { keyPath: 'key' });
      db.createObjectStore('records', { keyPath: 'id' });
      db.createObjectStore('fieldDefinitions', { keyPath: 'key' });
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['fieldDefinitions', 'records'], 'readwrite');
      tx.objectStore('fieldDefinitions').put({ key: 'customerFields', value: [
        { id: 'name', nameEn: 'Name', nameZh: '姓名', type: 'text', required: true, isCore: true, order: 0, options: [] },
        { id: 'company', nameEn: 'Company', nameZh: '公司', type: 'text', required: true, isCore: true, order: 1, options: [] },
        { id: 'email', nameEn: 'Email', nameZh: '電子信箱', type: 'email', required: true, isCore: true, order: 2, options: [] },
      ]});
      // Pre-v3.1: no companyFields group at all, and the two fields below are in
      // exactly the shape that triggers the re-seed branches.
      tx.objectStore('fieldDefinitions').put({ key: 'staffFields', value: [
        { id: 'greeter', nameEn: 'Greeter', nameZh: '接待人員', type: 'radio-group', required: false, isCore: true, order: 0, allowOther: false, options: [
          { en: 'Old Person', zh: '舊人員' } ]},
        { id: 'visit_date', nameEn: 'Visit Date', nameZh: '訪談日期', type: 'radio-group', required: false, isCore: true, order: 1, options: [
          { en: '08/06', zh: '08/06' } ]},
        { id: 'potential', nameEn: 'Potential', nameZh: '潛力評級', type: 'rating', required: false, order: 2, options: [] },
        { id: 'product_interest', nameEn: 'Product of Interest', nameZh: '感興趣產品', type: 'checkbox-group', required: false, order: 3, options: [] },
      ]});
      tx.objectStore('records').put({
        id: 'v30-rec-1', timestamp: '2026-08-01T09:00:00.000Z', device: 'Tablet-OLD',
        customerFields: { name: '舊客戶', company: '舊公司', email: 'old@co.com' },
        staffFields: { greeter: 'Old Person', visit_date: '08/06', potential: 4 },
        gdprConsent: true, cardPhoto: null,
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));

  await page.goto(BASE + '/');
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(SHOT, '01_event_list.png'), fullPage: true });

  // 1. the migration ran to completion instead of throwing partway through
  assert(errors.length === 0, '載入沒有 JS 例外：' + errors.join(' | '));
  assert((await page.locator('[data-event-card]').count()) === 1,
    'pre-v3.1 資料庫仍能開啟並收編為一個活動');

  // 2. both re-seed branches took their options from the needs catalog
  const needs = await H.readDefs(page, 'needsFields');
  const pot = needs.find(f => f.id === 'potential');
  const prod = needs.find(f => f.id === 'product_interest');
  assert(pot && pot.type === 'radio-group' && pot.options.some(o => o.zh === '100%'),
    '星等評分已換成 7 級成交機率：' + JSON.stringify(pot && pot.options));
  assert(prod && prod.options.some(o => o.group === 'Gentrex Series'),
    '空的感興趣產品已補上機型目錄：' + (prod ? prod.options.length : 'null') + ' 個選項');

  // 3. the old record survives and still resolves through the moved definitions
  const recs = await H.readAll(page, 'records');
  assert(recs.length === 1 && recs[0].customerFields.name === '舊客戶', '舊紀錄保留');

  await browser.close();
  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();
