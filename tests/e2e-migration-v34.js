// v3.4 migration: a database that predates events gets adopted into a default
// event without losing anything, and the historical v2→v3.3 chain still runs
// underneath it.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-mig34');
fs.mkdirSync(SHOT, { recursive: true });
const BASE = 'http://localhost:8953';

// Seeds a database at DB version 1 (no `events` store), the shape every
// pre-v3.4 install has on disk.
const seedV1 = (page, build) => page.evaluate((b) => new Promise((res, rej) => {
  const d = indexedDB.deleteDatabase('ExhibitionFormDB');
  d.onerror = () => rej(d.error);
  d.onsuccess = d.onblocked = () => {
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
      const tx = db.transaction(['config', 'records', 'fieldDefinitions'], 'readwrite');
      for (const c of b.config) tx.objectStore('config').put(c);
      for (const r of b.records) tx.objectStore('records').put(r);
      for (const f of b.defs) tx.objectStore('fieldDefinitions').put(f);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
  };
}), build);

(async () => {
  const server = await H.serve(8953);
  const browser = await H.launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  // ================= A. a v3.3-shaped database =================
  await page.goto(BASE + '/seed');
  await seedV1(page, {
    config: [{ key: 'migratedTo33', value: true }, { key: 'migratedTo34', value: true }, { key: 'pin', value: '0000' }],
    defs: [
      { key: 'customerFields', value: [
        { id: 'name', nameEn: 'Name', nameZh: '姓名', type: 'text', required: true, isCore: true, order: 0, options: [] },
        { id: 'company', nameEn: 'Company', nameZh: '公司', type: 'text', required: true, isCore: true, order: 1, options: [] },
      ]},
      { key: 'needsFields', value: [
        { id: 'inquiry_type', nameEn: 'Inquiry Type', nameZh: '洽談事由', type: 'checkbox-group', required: false, order: 0,
          options: [{ en: 'Request Quote', zh: '索取報價' }] },
      ]},
      { key: 'companyFields', value: [
        { id: 'industry', nameEn: 'Industry', nameZh: '行業別', type: 'radio-group', required: false, order: 0,
          options: [{ en: 'Footwear', zh: '鞋類' }] },
      ]},
      { key: 'staffFields', value: [
        // An admin-customized roster: the migration must adopt exactly this,
        // not the built-in three names.
        { id: 'greeter', nameEn: 'Greeter', nameZh: '接待人員', type: 'radio-group', required: false, isCore: true, order: 0,
          allowOther: true, options: [
            { en: 'Su Chiu-Chu', zh: '蘇秋菊' }, { en: 'Lin Ta-Wei', zh: '林大維' },
            { en: 'Wang Hsiao-Fen', zh: '王小芬' }, { en: 'Chen Yi', zh: '陳毅' } ]},
        { id: 'visit_date', nameEn: 'Visit Date', nameZh: '訪談日期', type: 'date', required: false, isCore: true, order: 1, options: [] },
        // A genuinely staff-only field: this one must stay editable and keep
        // the staff page alive.
        { id: 'followup', nameEn: 'Follow-up', nameZh: '後續追蹤', type: 'textarea', required: false, order: 2, options: [] },
      ]},
    ],
    records: [
      { id: 'r1', timestamp: '2026-08-05T09:00:00.000Z', device: 'T1',
        customerFields: { name: '王小明', company: '宏昌實業' }, needsFields: { inquiry_type: ['Request Quote'] },
        companyFields: { industry: 'Footwear' },
        // Pre-v3.4 records stored a single greeter as a plain string.
        staffFields: { greeter: 'Su Chiu-Chu', visit_date: '2026-08-05', followup: '下週回電' },
        gdprConsent: true, cardPhoto: null },
      { id: 'r2', timestamp: '2026-08-07T09:00:00.000Z', device: 'T1',
        customerFields: { name: '李大華', company: '永盛國際' }, needsFields: {}, companyFields: {},
        staffFields: { greeter: '__other__', greeter__otherText: '臨時支援小陳' },
        gdprConsent: true, cardPhoto: null },
    ],
  });

  await page.goto(BASE + '/');
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(SHOT, '01_after_migration.png'), fullPage: true });

  const events = await H.readAll(page, 'events');
  assert(events.length === 1, '既有資料庫遷移後恰有一個活動');
  const ev = events[0];
  assert(ev.name === '2026 美國展', '預設活動命名為「2026 美國展」：' + ev.name);
  assert(ev.startDate === '2026-08-05' && ev.endDate === '2026-08-07',
    `日期區間涵蓋既有紀錄：${ev.startDate} → ${ev.endDate}`);
  assert(ev.status === 'active', '預設活動為使用中');
  // seedFirstEvent() still derives the roster from the old greeter options
  // (custom names included), but v3.6 runs immediately afterwards in the same
  // load and overwrites every event's roster unconditionally — so for a DB
  // arriving from pre-v3.4 the derived list never survives to be observed.
  // Asserting the real end state rather than the intermediate one.
  assert(JSON.stringify(ev.staff.map(s => s.zh)) === JSON.stringify(['陳佩昀', '宋佳蓉']),
    'v3.6 覆蓋後名單為新的預設兩位：' + ev.staff.map(s => s.zh).join('、'));

  const defs = await H.readAll(page, 'fieldDefinitions');
  const keys = defs.map(d => d.key).sort();
  assert(keys.every(k => k.startsWith(ev.id + '::')),
    '欄位定義全部搬到帶活動前綴的 key：' + keys.map(k => k.split('::')[1]).join(','));
  assert(keys.length === 4, '舊的無前綴 key 已刪除，只剩四組');

  const staffDefs = defs.find(d => d.key.endsWith('staffFields')).value;
  const greeterDef = staffDefs.find(f => f.id === 'greeter');
  assert(greeterDef.type === 'checkbox-group' && greeterDef.source === 'event' && greeterDef.options.length === 0,
    '接待人員改為複選、標記由活動供應、選項清空：' + JSON.stringify({ t: greeterDef.type, s: greeterDef.source, n: greeterDef.options.length }));
  assert(staffDefs.find(f => f.id === 'visit_date').source === 'event', '訪談日期同樣標記由活動供應');
  assert(!staffDefs.find(f => f.id === 'followup').source, '真正屬於業務的欄位不受影響');

  const recs = await H.readAll(page, 'records');
  assert(recs.length === 2 && recs.every(r => r.eventId === ev.id), '每筆既有紀錄都補上 eventId');
  assert(recs.find(r => r.id === 'r1').staffFields.greeter === 'Su Chiu-Chu',
    '舊紀錄的字串型 greeter 原樣保留（不強制轉陣列）');

  // ---- the old string value still displays and exports correctly ----
  await H.enterEvent(page);
  await H.openAdmin(page, '資料紀錄');
  const table = await page.locator('[data-records-table]').innerText();
  assert(table.includes('Su Chiu-Chu'), '字串型 greeter 在列表正常顯示');
  assert(table.includes('Other: 臨時支援小陳'), '舊的「其他」自訂姓名仍解析得出：' + table.replace(/\n/g, ' | ').slice(0, 200));
  assert((await page.locator('body').innerText()).includes('資料紀錄（2 筆）'), '兩筆紀錄都歸在這個活動下');

  const dl = page.waitForEvent('download', { timeout: 15000 });
  await page.getByRole('button', { name: '匯出資料' }).click();
  const zipPath = path.join(SHOT, 'export_mig.zip');
  await (await dl).saveAs(zipPath);
  const buf = fs.readFileSync(zipPath);
  const has = (s) => buf.includes(Buffer.from(s, 'utf8'));
  assert(has('王小明') && has('李大華') && has('Su Chiu-Chu') && has('下週追蹤') === false && has('下週回電'),
    '匯出帶出所有既有值');
  assert(has('2026 美國展') && has('Event'), '匯出含新的 Event 欄');

  // ---- the flow now always ends at the handoff ----
  // Leaving the back office returns to the event page with the selection made
  // by enterEvent() still in place, so the entries are already open.
  await page.getByRole('button', { name: '← 返回表單' }).click();
  await page.waitForTimeout(600);
  assert(!(await page.locator('[data-entry-customer]').isDisabled()),
    '從後台返回活動頁時，先前選好的填單人員與日期仍在');
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(500);
  await H.runFlow(page, { name: '新客戶', company: '新公司' });
  // v3.5 removed the staff page outright, so the flow always ends at the
  // handoff — even for a database that carries a custom staff field.
  const handoff = await page.locator('body').innerText();
  assert(!handoff.includes('Staff 工作人員') && handoff.includes('完成，返回'),
    '交接畫面固定結束於「完成，返回」，不再有業務入口');
  await page.screenshot({ path: path.join(SHOT, '02_handoff.png'), fullPage: true });
  await page.getByRole('button', { name: /完成，返回/ }).click();
  await page.waitForTimeout(700);
  const after = await H.readAll(page, 'records');
  const fresh = after.find(r => r.customerFields.name === '新客戶');
  assert(Array.isArray(fresh.staffFields.greeter) && fresh.staffFields.greeter.length === 1
    && !!fresh.staffFields.visit_date,
    '活動帶入的接待人員／日期完整寫入：' + JSON.stringify(fresh.staffFields));
  const custom = (await H.readDefs(page, 'staffFields')).find(f => f.id === 'followup');
  assert(!!custom, '既有的自訂業務欄位定義仍保留（舊值照常匯出）');

  // ---- second load is a no-op ----
  await page.goto(BASE + '/');
  await page.waitForTimeout(1800);
  const again = await H.readAll(page, 'events');
  assert(again.length === 1 && again[0].id === ev.id, '重新載入不會再建立一個活動');

  // ================= B. a raw v2 database =================
  // Proves the historical chain (needs split out of customer, Company Profile
  // added, v3.3 regrouping, label/value fixes) still runs under the new one.
  await page.goto(BASE + '/seed');
  await seedV1(page, {
    config: [],
    defs: [
      { key: 'customerFields', value: [
        { id: 'name', nameEn: 'Name', nameZh: '姓名', type: 'text', required: true, isCore: true, order: 0, options: [] },
        { id: 'inquiry_type', nameEn: 'Inquiry Type', nameZh: '洽談事由', type: 'checkbox-group', required: false, order: 1,
          options: [{ en: 'Request Quote', zh: '索取報價' }] },
      ]},
    ],
    records: [
      { id: 'v2a', timestamp: '2026-08-04T09:00:00.000Z', device: 'T0',
        customerFields: { name: '老客戶', inquiry_type: ['Request Quote'] },
        gdprConsent: true, cardPhoto: null },
    ],
  });
  await page.goto(BASE + '/');
  await page.waitForTimeout(2000);
  const v2events = await H.readAll(page, 'events');
  assert(v2events.length === 1, 'v2 資料庫也收編進一個活動');
  const v2defs = await H.readAll(page, 'fieldDefinitions');
  const byGroup = Object.fromEntries(v2defs.map(d => [d.key.split('::')[1], d.value]));
  assert(!byGroup.customerFields.some(f => f.id === 'inquiry_type')
    && byGroup.needsFields.some(f => f.id === 'inquiry_type'),
    'v2→v3 拆分仍有效：洽談事由移到客戶需求');
  assert(byGroup.companyFields.some(f => f.id === 'machines_used'), 'v3.1 的公司背景欄位仍會建立');
  assert(byGroup.customerFields.some(f => f.id === 'language'), 'v3.3 的語言欄位仍會落到客戶資料');
  const lang = byGroup.customerFields.find(f => f.id === 'language');
  assert(lang.options.find(o => o.en === 'Mandarin').zh === '華語', '語言標籤修正仍有效（Mandarin → 華語）');
  const rev = byGroup.companyFields.find(f => f.id === 'revenue');
  assert(rev.options[2].en === 'US$10,000,000 以上', '營業額值修正仍有效');
  assert(byGroup.staffFields.find(f => f.id === 'greeter').source === 'event',
    'v2 一路遷移後接待人員同樣由活動供應');
  const v2recs = await H.readAll(page, 'records');
  assert(v2recs.length === 1 && v2recs[0].eventId === v2events[0].id, 'v2 的紀錄也補上 eventId');
  await page.screenshot({ path: path.join(SHOT, '03_v2_chain.png'), fullPage: true });

  if (errors.length) { console.error('CONSOLE ERRORS:'); errors.forEach(e => console.error('  ' + e)); fails++; }
  else console.log('ok: 無 console error');

  await browser.close(); server.close();
  console.log(fails ? `MIGRATION v3.4 FAILED (${fails})` : 'MIGRATION v3.4 PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
