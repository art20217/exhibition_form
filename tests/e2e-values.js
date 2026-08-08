// Option value renames (brand names / revenue bands / wording): definitions and
// already-collected record values must move together, so an old answer still
// matches its option instead of being orphaned.
const http = require('http');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-values');
fs.mkdirSync(SHOT, { recursive: true });

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url.startsWith('/seed')) { res.end('<!DOCTYPE html><title>seed</title>'); return; }
  fs.createReadStream(H.APP_HTML).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(8942, r));
  const browser = await H.launchBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1024, height: 900 }, acceptDownloads: true })).newPage();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  await page.goto('http://localhost:8942/seed');
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
      tx.objectStore('config').put({ key: 'migratedTo33', value: true });
      tx.objectStore('fieldDefinitions').put({ key: 'customerFields', value: [
        { id: 'name', nameEn: 'Name', nameZh: '姓名', type: 'text', required: true, isCore: true, order: 0, options: [] },
      ]});
      tx.objectStore('fieldDefinitions').put({ key: 'needsFields', value: [
        { id: 'inquiry_type', nameEn: 'Inquiry Type', nameZh: '洽談事由', type: 'checkbox-group', required: false, order: 0, options: [
          { en: 'Request Quote', zh: '索取報價' } ]},
      ]});
      tx.objectStore('fieldDefinitions').put({ key: 'companyFields', value: [
        { id: 'machines_used', nameEn: 'Machines Used', nameZh: '使用機器', type: 'checkbox-group', required: false, order: 0,
          allowOther: true, perGroupOther: true, emptyGroups: ['Local 本土'], options: [
          { en: 'Tiangang', zh: '天崗', group: 'Taiwan 台灣' },
          { en: 'Jugang', zh: '鉅鋼', group: 'Taiwan 台灣' },
          { en: 'Zhongtian', zh: '中天', group: 'Taiwan 台灣' },
          { en: 'Shichuang', zh: '世創', group: 'China 大陸' },
          { en: 'MyOwnBrand', zh: '後台自訂', group: 'Taiwan 台灣' } ]},
        { id: 'revenue', nameEn: 'Revenue', nameZh: '營業額', type: 'radio-group', required: false, order: 1, allowOther: false, options: [
          { en: 'Under US$5,000,000', zh: 'US$5,000,000以下' },
          { en: 'US$5,000,000–10,000,000', zh: 'US$5,000,000-10,000,000' },
          { en: 'US$100,000,001 and above', zh: 'US$100,000,001以上' } ]},
        { id: 'company_type', nameEn: 'Company Type', nameZh: '公司型態', type: 'radio-group', required: false, order: 2, options: [
          { en: 'Material Supplier', zh: '鞋材商' }, { en: 'Brand', zh: '品牌' } ]},
        { id: 'ownership_type', nameEn: 'Ownership', nameZh: '股份型態', type: 'radio-group', required: false, order: 3, options: [
          { en: 'Public Company', zh: '上市公司' }, { en: 'Private Company', zh: '私人公司' } ]},
      ]});
      tx.objectStore('fieldDefinitions').put({ key: 'staffFields', value: [
        { id: 'greeter', nameEn: 'Greeter', nameZh: '接待人員', type: 'radio-group', required: false, isCore: true, order: 0, options: [] },
      ]});
      // Record collected under the OLD values.
      tx.objectStore('records').put({
        id: 'old-1', timestamp: '2026-08-03T09:00:00.000Z', device: 'T1',
        customerFields: { name: '舊客戶' }, needsFields: {},
        companyFields: {
          machines_used: ['Tiangang', 'Shichuang', 'MyOwnBrand', '__other__:Taiwan 台灣'],
          machines_used__otherText__Taiwan台灣: 'x',
          revenue: 'US$100,000,001 and above',
          company_type: 'Material Supplier',
          ownership_type: 'Public Company',
        },
        staffFields: {}, gdprConsent: true, cardPhoto: null,
      });
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
  })));

  await page.goto('http://localhost:8942/');
  await page.waitForTimeout(1500);
  await H.enterEvent(page);

  // Definitions renamed, admin's own option untouched
  const opts = Object.fromEntries((await H.readDefs(page, 'companyFields'))
    .map(f => [f.id, f.options.map(o => o.en)]));
  assert(JSON.stringify(opts.machines_used) === JSON.stringify(
    ['Tien Kang','King Steel','Chung Tien / CTM','Strong','MyOwnBrand']),
    '機器品牌改為正式名稱、後台自訂項保留：' + opts.machines_used.join(' | '));
  assert(JSON.stringify(opts.revenue) === JSON.stringify(
    ['US$5,000,000 以下','US$5,000,000 - 10,000,000','US$10,000,000 以上']),
    '營業額三段連續、無重複字串：' + opts.revenue.join(' | '));
  assert(opts.company_type[0] === 'Shoe Material Supplier', 'Material Supplier → Shoe Material Supplier');
  assert(opts.ownership_type[0] === 'Listed Company', 'Public Company → Listed Company');

  // Collected values rewritten in step
  const rec = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('ExhibitionFormDB');
    r.onsuccess = () => {
      const db = r.result;
      const g = db.transaction('records', 'readonly').objectStore('records').get('old-1');
      g.onsuccess = () => { db.close(); res(g.result.companyFields); };
    };
  }));
  assert(JSON.stringify(rec.machines_used) === JSON.stringify(
    ['Tien Kang','Strong','MyOwnBrand','__other__:Taiwan 台灣']),
    '舊紀錄的機器選項值同步改名，其他標記不受影響：' + rec.machines_used.join(' | '));
  assert(rec.revenue === 'US$10,000,000 以上', '舊紀錄的營業額值同步改名');
  assert(rec.company_type === 'Shoe Material Supplier', '舊紀錄的公司型態值同步改名');
  assert(rec.ownership_type === 'Listed Company', '舊紀錄的股份型態值同步改名');

  // The renamed answers still light up their chips when the record is edited
  await page.locator('button:has(svg circle)').first().click();
  await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('0000');
  await page.getByRole('button', { name: '登入' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '資料紀錄' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOT, '01_records.png'), fullPage: true });
  // 使用機器/營業額 are not list columns, so the renamed values are verified via
  // the export (same resolveFieldValue path) plus the edit screen below.
  const dl = page.waitForEvent('download', { timeout: 15000 });
  await page.getByRole('button', { name: '匯出資料' }).click();
  const zipPath = path.join(SHOT, 'export_values.zip');
  await (await dl).saveAs(zipPath);
  const buf = fs.readFileSync(zipPath);
  const has = (str) => buf.includes(Buffer.from(str, 'utf8'));
  assert(has('Tien Kang') && has('US$10,000,000 以上'), '匯出帶出的是改名後的新值');
  assert(!has('Tiangang') && !has('US$100,000,001 and above'), '匯出不再出現舊值');

  // Editing renders customer + needs + company as one combined form.
  await page.getByRole('button', { name: '編輯' }).first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOT, '02_edit-company.png'), fullPage: true });
  const checked = await page.locator('label, button').evaluateAll(els => els
    .filter(el => getComputedStyle(el).borderColor === 'rgb(0, 85, 184)')
    .map(el => el.innerText.trim()));
  assert(checked.some(t => t.startsWith('Tien Kang')), '編輯時「Tien Kang 天崗」仍是勾選狀態');
  assert(checked.some(t => t.includes('US$10,000,000 以上')), '編輯時營業額仍是選取狀態');
  assert(checked.some(t => t.startsWith('Shoe Material Supplier')), '編輯時公司型態仍是選取狀態');

  // Revenue chips must read exactly the three bands — no doubled label.
  const revChips = await page.locator('label', { hasText: 'Revenue' }).locator('xpath=..')
    .locator('button').allInnerTexts();
  const revClean = revChips.map(t => t.replace(/\s+/g, ' ').trim());
  assert(JSON.stringify(revClean) === JSON.stringify(
    ['US$5,000,000 以下', 'US$5,000,000 - 10,000,000', 'US$10,000,000 以上']),
    '營業額三個選項各只顯示一次標籤：' + JSON.stringify(revClean));

  // Second load is a no-op
  await page.goto('http://localhost:8942/');
  await page.waitForTimeout(1500);
  await H.enterEvent(page);
  const again = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('ExhibitionFormDB');
    r.onsuccess = () => {
      const db = r.result;
      const g = db.transaction('records', 'readonly').objectStore('records').get('old-1');
      g.onsuccess = () => { db.close(); res(g.result.companyFields.machines_used); };
    };
  }));
  assert(JSON.stringify(again) === JSON.stringify(['Tien Kang','Strong','MyOwnBrand','__other__:Taiwan 台灣']),
    '重新載入不會重複改名');

  console.log(fails ? `VALUE RENAME FAILED (${fails})` : 'VALUE RENAME PASSED');
  await browser.close(); server.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
