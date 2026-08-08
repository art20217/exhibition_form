// v3.2 -> v3.3 migration: seeds a v3.2-shaped DB (all five fields still on the
// staff page, `potential` still labelled 潛力評級, admin-customized options, and
// an old record whose values live in record.staffFields) and verifies the
// fields move to their new groups without clobbering customizations, that old
// values still resolve through the read fallbacks, and that the one-shot flag
// keeps a second load from re-running the move.
const http = require('http');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT_DIR = path.join(__dirname, 'shots-mig-v33');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url.startsWith('/seed')) { res.end('<!DOCTYPE html><title>seed</title>'); return; }
  fs.createReadStream(H.APP_HTML).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(8938, r));
  const browser = await H.launchBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1024, height: 900 }, acceptDownloads: true })).newPage();
  let fails = 0;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); fails++; } else console.log('ok: ' + msg); };

  await page.goto('http://localhost:8938/seed');
  await page.evaluate(() => new Promise((resolve, reject) => {
    const del = indexedDB.deleteDatabase('ExhibitionFormDB');
    del.onerror = () => reject(del.error);
    del.onsuccess = del.onblocked = () => resolve();
  }).then(() => new Promise((resolve, reject) => {
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
      tx.objectStore('fieldDefinitions').put({ key: 'needsFields', value: [
        { id: 'inquiry_type', nameEn: 'Inquiry Type', nameZh: '洽談事由', type: 'checkbox-group', required: false, isCore: true, order: 0, options: [
          { en: 'Request Quote', zh: '索取報價' } ] },
      ]});
      tx.objectStore('fieldDefinitions').put({ key: 'companyFields', value: [
        { id: 'industry', nameEn: 'Industry', nameZh: '行業別', type: 'radio-group', required: false, order: 0, allowOther: true, options: [
          { en: 'Footwear', zh: '鞋類' } ] },
      ]});
      // v3.2 staff fields: everything still here, with admin customizations we
      // must carry over verbatim — a renamed Notes label, an extra greeter
      // name, and a trimmed/customized Product of Interest list.
      tx.objectStore('fieldDefinitions').put({ key: 'staffFields', value: [
        { id: 'greeter', nameEn: 'Greeter', nameZh: '接待人員', type: 'radio-group', required: false, isCore: true, order: 0, allowOther: true, options: [
          { en: 'Su Chiu-Chu', zh: '蘇秋菊' }, { en: 'Admin Added Person', zh: '後台自訂人員' } ]},
        { id: 'visit_date', nameEn: 'Visit Date', nameZh: '訪談日期', type: 'date', required: false, isCore: true, order: 1, allowOther: false, options: [] },
        { id: 'nationality', nameEn: 'Nationality', nameZh: '訪客國籍(自訂標籤)', type: 'text', required: true, isCore: true, order: 2, options: [] },
        { id: 'language', nameEn: 'Language', nameZh: '語言', type: 'radio-group', required: false, isCore: true, order: 3, allowOther: true, options: [
          { en: 'Mandarin', zh: '中文' }, { en: 'Klingon', zh: '自訂語言' } ]},
        { id: 'potential', nameEn: 'Potential', nameZh: '潛力評級', type: 'radio-group', required: false, order: 4, options: [
          { en: 'A', zh: '100%' }, { en: 'B', zh: '80%以上' } ]},
        { id: 'product_interest', nameEn: 'Product of Interest', nameZh: '感興趣產品', type: 'checkbox-group', required: false, order: 5, allowOther: true, options: [
          { en: 'CustomMachine', zh: '後台自訂機型', group: 'Custom 自訂系列' } ]},
        { id: 'notes', nameEn: 'Notes', nameZh: '業務員自訂備註標籤', type: 'textarea', required: false, order: 6, options: [] },
      ]});
      // v3.2 record: the moved fields' values all sit in staffFields.
      tx.objectStore('records').put({
        id: 'v32-rec-1', timestamp: '2026-08-01T09:00:00.000Z', device: 'Tablet-OLD',
        customerFields: { name: '舊客戶', company: '舊公司', email: 'old@co.com' },
        needsFields: { inquiry_type: ['Request Quote'] },
        companyFields: { industry: 'Footwear' },
        staffFields: {
          greeter: 'Su Chiu-Chu', visit_date: '2026-08-01',
          nationality: 'Germany', language: 'Mandarin',
          potential: 'A', product_interest: ['CustomMachine', '__other__'],
          product_interest__otherText: '舊的其他機型', notes: '舊的業務備註',
        },
        gdprConsent: true, cardPhoto: null,
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  })));

  await page.goto('http://localhost:8938/');
  await page.waitForTimeout(1400);
  await H.enterEvent(page);

  await page.locator('button:has(svg circle)').first().click();
  await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('0000');
  await page.getByRole('button', { name: '登入' }).click();
  await page.waitForTimeout(400);

  const rowsText = async () => (await page.locator('[data-field-row]').allInnerTexts()).join('\n');

  // --- customer fields gained nationality + language, customizations intact ---
  await page.getByRole('button', { name: '客戶資料欄位' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOT_DIR, 'customer-fields.png'), fullPage: true });
  let t = await rowsText();
  assert(t.includes('訪客國籍(自訂標籤)'), '訪客國籍已移入客戶資料欄位，且保留後台自訂標籤');
  assert(t.includes('語言'), '語言已移入客戶資料欄位');

  // --- needs fields gained the three evaluation fields, in order ---
  await page.getByRole('button', { name: '客戶需求欄位' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOT_DIR, 'needs-fields.png'), fullPage: true });
  const order = (await page.locator('[data-field-row]').allInnerTexts()).map(x => x.split('\n')[0]);
  assert(order[0].includes('洽談事由'), '需求欄位第 1 個仍是洽談事由');
  assert(order[1].includes('感興趣產品'), '需求欄位第 2 個是感興趣產品');
  assert(order[2].includes('成交機率'), '需求欄位第 3 個是成交機率（已更名）');
  assert(order[3].includes('業務員自訂備註標籤'), '需求欄位第 4 個是備註，且保留後台自訂標籤');
  t = await rowsText();
  assert(t.includes('後台自訂機型'), '感興趣產品的後台自訂選項未被覆蓋');
  assert(!t.includes('潛力評級'), '潛力評級標籤已不存在');

  // --- staff page trimmed to the two reception fields ---
  // v3.5 removed the 業務備註欄位 tab (reception is configured on the event), so
  // the v3.3 migration's outcome is checked against the stored definitions.
  const staffDefs = await H.readDefs(page, 'staffFields');
  assert(staffDefs.length === 2, `業務備註欄位只剩 2 個（實際 ${staffDefs.length}）`);
  t = staffDefs.map(f => f.nameZh + ' ' + f.nameEn).join('\n');
  assert(t.includes('接待人員') && t.includes('訪談日期'), '業務欄位保留接待人員與訪談日期');

  // --- old record's values still resolve through the staffFields fallback ---
  await page.getByRole('button', { name: '資料紀錄' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOT_DIR, 'records.png'), fullPage: true });
  const rec = await page.locator('body').innerText();
  assert(rec.includes('舊客戶'), '舊紀錄仍在列表');
  // The list now shows only 時間/姓名/公司/接待人員, so the read-path fallbacks are
  // checked through the export instead: it walks every field via the same
  // resolveFieldValue(), and the ZIP is written STORE (uncompressed), so the
  // sheet XML can be matched directly in the raw bytes.
  const dl = page.waitForEvent('download', { timeout: 15000 });
  await page.getByRole('button', { name: '匯出資料' }).click();
  const zipPath = path.join(SHOT_DIR, 'export_mig.zip');
  await (await dl).saveAs(zipPath);
  const buf = fs.readFileSync(zipPath);
  // Match raw UTF-8 bytes — the sheet XML is UTF-8 and the entries are stored
  // uncompressed, so a latin1 decode would never match the Chinese values.
  const has = (str) => buf.includes(Buffer.from(str, 'utf8'));
  assert(has('Germany'), '舊紀錄的國籍值（原存於 staffFields）仍可讀出');
  assert(has('CustomMachine'), '舊紀錄的感興趣產品值仍可讀出');
  assert(has('Other: 舊的其他機型'), '舊紀錄的「其他」自由文字仍能解析');
  assert(has('舊的業務備註'), '舊紀錄的備註值仍可讀出');
  assert(has('2026-08-01'), '舊紀錄的訪談日期仍可讀出');

  // --- reload: the one-shot flag must stop the move from running twice ---
  await page.goto('http://localhost:8938/');
  await page.waitForTimeout(1400);
  await H.enterEvent(page);
  await page.locator('button:has(svg circle)').first().click();
  await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('0000');
  await page.getByRole('button', { name: '登入' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '客戶需求欄位' }).click();
  await page.waitForTimeout(300);
  const order2 = (await page.locator('[data-field-row]').allInnerTexts()).map(x => x.split('\n')[0]);
  assert(order2.length === 4, `重新載入後需求欄位仍是 4 個、沒有重複搬移（實際 ${order2.length}）`);
  assert((await H.readDefs(page, 'staffFields')).length === 2, '重新載入後業務備註欄位仍是 2 個');

  console.log(fails ? `MIGRATION FAILED (${fails})` : 'MIGRATION PASSED');
  await browser.close();
  server.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
