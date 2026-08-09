// Option-label corrections: a database carrying the old wrong 中文 labels gets
// them fixed on load, while a label the admin already retyped is left alone,
// and the stored `en` values (what records key off) are never touched.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-labels');
fs.mkdirSync(SHOT, { recursive: true });


(async () => {
  const server = await H.serve(8941);
  const browser = await H.launchBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1024, height: 900 }, acceptDownloads: true })).newPage();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  await page.goto('http://localhost:8941/seed');
  await page.evaluate(() => new Promise((res, rej) => {
    const d = indexedDB.deleteDatabase('ExhibitionFormDB');
    d.onerror = () => rej(d.error); d.onsuccess = d.onblocked = () => res();
  }).then(() => new Promise((res, rej) => {
    const req = indexedDB.open('ExhibitionFormDB', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      db.createObjectStore('config', { keyPath: 'key' });
      db.createObjectStore('records', { keyPath: 'id' });
      db.createObjectStore('fieldDefinitions', { keyPath: 'key' });
    };
    req.onerror = () => rej(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['fieldDefinitions', 'records', 'config'], 'readwrite');
      // Already past the v3.3 move, but still carrying the old labels.
      tx.objectStore('config').put({ key: 'migratedTo33', value: true });
      tx.objectStore('fieldDefinitions').put({ key: 'customerFields', value: [
        { id: 'name', nameEn: 'Name', nameZh: '姓名', type: 'text', required: true, isCore: true, order: 0, options: [] },
        { id: 'language', nameEn: 'Language', nameZh: '語言', type: 'radio-group', required: false, isCore: true, order: 1, allowOther: true, options: [
          { en: 'Mandarin', zh: '中文' },        // wrong -> 華語
          { en: 'English', zh: '英語' },
          { en: 'Hindi', zh: '印度語' },          // wrong -> 印地語
          { en: 'French', zh: '法文(後台自訂)' },  // admin already retyped -> must survive
        ]},
      ]});
      tx.objectStore('fieldDefinitions').put({ key: 'needsFields', value: [
        { id: 'inquiry_type', nameEn: 'Inquiry Type', nameZh: '洽談事由', type: 'checkbox-group', required: false, order: 0, options: [
          { en: 'Request Quote', zh: '索取報價' } ]},
      ]});
      tx.objectStore('fieldDefinitions').put({ key: 'companyFields', value: [
        { id: 'product_type', nameEn: 'Product Type', nameZh: '公司產品(鞋型)', type: 'checkbox-group', required: false, order: 0, options: [
          { en: 'Sandals', zh: '脫涼鞋' },        // wrong -> 拖涼鞋
          { en: 'Safety Shoes', zh: '安全鞋' } ]},
        { id: 'material_type', nameEn: 'Material', nameZh: '公司產品(材質)', type: 'checkbox-group', required: false, order: 1, options: [
          { en: 'Rubber', zh: 'Rubber' },        // -> 橡膠
          { en: 'EVA', zh: 'EVA' } ]},
      ]});
      tx.objectStore('fieldDefinitions').put({ key: 'staffFields', value: [
        { id: 'greeter', nameEn: 'Greeter', nameZh: '接待人員', type: 'radio-group', required: false, isCore: true, order: 0, options: [] },
      ]});
      // A record collected under the old labels — its stored `en` values must stay valid.
      tx.objectStore('records').put({
        id: 'old-1', timestamp: '2026-08-02T09:00:00.000Z', device: 'T1',
        customerFields: { name: '舊客戶', language: 'Mandarin' },
        needsFields: {}, companyFields: { product_type: ['Sandals'], material_type: ['Rubber'] },
        staffFields: {}, gdprConsent: true, cardPhoto: null,
      });
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
  })));

  await page.goto('http://localhost:8941/');
  await page.waitForTimeout(1400);
  await H.enterEvent(page);

  // Customer form shows the corrected language labels
  await H.pickCustomerStatus(page);
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOT, '01_language.png'), fullPage: true });
  // Chips now put English and 中文 on separate lines, so collapse whitespace
  // before matching the bilingual pair.
  const form = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  assert(form.includes('Mandarin 華語'), 'Mandarin 顯示為「華語」');
  assert(!form.includes('Mandarin 中文'), '舊的「Mandarin 中文」已消失');
  assert(form.includes('Hindi 印地語'), 'Hindi 顯示為「印地語」');
  assert(!form.includes('印度語'), '舊的「印度語」已消失');
  assert(form.includes('法文(後台自訂)'), '後台已自訂的標籤未被覆蓋');

  // Company form shows the corrected product/material labels
  await page.locator('input[placeholder^="Enter Name"]').fill('X');
  await page.locator('input[type="checkbox"]').last().check();
  await page.getByRole('button', { name: /Next 下一步/ }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOT, '02_company.png'), fullPage: true });
  const comp = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  assert(comp.includes('Sandals 拖涼鞋'), 'Sandals 顯示為「拖涼鞋」');
  assert(!comp.includes('脫涼鞋'), '舊的「脫涼鞋」已消失');
  assert(comp.includes('Rubber 橡膠'), 'Rubber 顯示為「橡膠」');

  // Stored `en` values untouched -> the old record still matches its options
  const stored = (await H.readDefs(page, 'customerFields'))
    .find(f => f.id === 'language').options.map(o => o.en);
  assert(JSON.stringify(stored) === JSON.stringify(['Mandarin','English','Hindi','French']),
    '選項的 en 值完全未變動（舊紀錄仍對得上）：' + stored.join(','));

  await page.goto('http://localhost:8941/');
  await page.waitForTimeout(1400);
  await H.enterEvent(page);
  await page.locator('button:has(svg circle)').first().click();
  await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('0000');
  await page.getByRole('button', { name: '登入' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '資料紀錄' }).click();
  await page.waitForTimeout(500);
  const rec = await page.locator('body').innerText();
  assert(rec.includes('舊客戶'), '舊紀錄仍列在資料紀錄');
  // 語言 is not one of the list columns, so its stored value is checked through
  // the export, which resolves every field via the same resolveFieldValue().
  const dl = page.waitForEvent('download', { timeout: 15000 });
  await page.getByRole('button', { name: '匯出資料' }).click();
  const zipPath = path.join(SHOT, 'export_labels.zip');
  await (await dl).saveAs(zipPath);
  const buf = fs.readFileSync(zipPath);
  const has = (str) => buf.includes(Buffer.from(str, 'utf8'));
  assert(has('Mandarin') && has('Sandals') && has('Rubber'),
    '舊紀錄的既有值仍正常帶出（選項 en 值未被改名影響）');

  console.log(fails ? `LABEL FIX FAILED (${fails})` : 'LABEL FIX PASSED');
  await browser.close(); server.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
