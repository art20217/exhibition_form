// v3.12: the record shape sync needs, and nothing else — no network code yet.
//
// Three additions: `updatedAt` (which copy is newer), `deletedAt` (removed here
// vs. not received there yet), and a `deviceId` separate from the human-typed
// device label.
//
// The dangerous half is the soft delete. Deletes used to remove the row; now
// they mark it, and every reader has to filter. The failure this suite exists
// to catch is a deleted record reappearing — especially in the export, where
// nobody would notice until the spreadsheet reached a colleague.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-sync-model');
fs.mkdirSync(SHOT, { recursive: true });

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

(async () => {
  const server = await H.serve();
  const BASE = server.base;
  const browser = await H.launchBrowser();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  const raw = () => H.readAll(page, 'records');
  const config = (key) => page.evaluate((k) => new Promise((res) => {
    const r = indexedDB.open('ExhibitionFormDB');
    r.onsuccess = () => {
      const db = r.result;
      const g = db.transaction('config', 'readonly').objectStore('config').get(k);
      g.onsuccess = () => { db.close(); res(g.result ? g.result.value : null); };
    };
  }), key);

  const fillOne = async (name) => {
    await H.pickCustomerStatus(page);
    await page.locator('[data-entry-customer]').click();
    await page.waitForTimeout(500);
    await H.runFlow(page, { name });
    await page.getByRole('button', { name: /完成，返回|Done/ }).first().click().catch(() => {});
    await page.waitForTimeout(500);
  };

  await page.goto(BASE + '/seed');
  await H.wipeDB(page);
  await page.goto(BASE + '/');
  await page.waitForTimeout(1600);
  await H.enterEvent(page);
  await fillOne('王小明');
  await fillOne('李大華');

  // ---- 1. a new record carries the sync fields ----
  let recs = await raw();
  const first = recs.find(r => r.customerFields?.name === '王小明');
  assert(ISO.test(first.updatedAt), 'updatedAt 是 ISO 時間：' + first.updatedAt);
  // The flow writes the record once per step (customer / company / needs), so a
  // finished record has legitimately been updated after it was created. The
  // invariant is only that it never predates creation.
  assert(new Date(first.updatedAt) >= new Date(first.timestamp),
    `updatedAt 不早於建立時間（${first.timestamp} → ${first.updatedAt}）`);
  assert(first.deletedAt === null, '新建時 deletedAt 為 null');

  // ---- 2. deviceId is stable, and is not the human label ----
  const devId = await config('deviceId');
  const devName = await config('deviceName');
  assert(devId && devId.length >= 16, 'deviceId 已產生：' + devId);
  assert(devId !== devName, 'deviceId 與人工命名的 deviceName 不同');
  assert(first.deviceId === devId, '紀錄帶上 deviceId');
  await page.reload();
  await page.waitForTimeout(1600);
  assert((await config('deviceId')) === devId, '重新載入後 deviceId 不變');

  // Renaming the device must not disturb the sync identity — the label is
  // free text and two tablets can easily end up with the same one.
  await H.openSettings(page);
  const nameBox = page.locator('input[type="text"]').first();
  await nameBox.fill('展場平板 A');
  await page.getByRole('button', { name: /儲存設定/ }).first().click();
  await page.waitForTimeout(600);
  assert((await config('deviceId')) === devId, '改裝置名稱不影響 deviceId');
  await page.getByRole('button', { name: '← 活動列表' }).click();
  await page.waitForTimeout(500);
  await H.lockManage(page);
  await H.enterEvent(page);

  // ---- 3. editing moves updatedAt but not timestamp ----
  // Settings is its own screen since v3.15, so getting here needs the admin
  // panel opened explicitly rather than a tab switch.
  await H.openAdmin(page, '資料紀錄');
  // Rows sort newest-first, so .first() would be the other record — target the
  // row by its name.
  await page.locator('tr', { hasText: '王小明' }).getByRole('button', { name: '編輯' }).click();
  await page.waitForTimeout(700);
  await page.locator('input[placeholder^="Enter Name"]').first().fill('王小明（改）');
  await page.getByRole('button', { name: /Save 儲存/ }).click();
  await page.waitForTimeout(900);

  recs = await raw();
  const edited = recs.find(r => r.id === first.id);
  assert(edited.customerFields.name === '王小明（改）', '編輯已存檔');
  assert(edited.timestamp === first.timestamp, '建立時間沒有被動到');
  assert(new Date(edited.updatedAt) > new Date(first.updatedAt),
    `updatedAt 往前走了（${first.updatedAt} → ${edited.updatedAt}）`);

  // ---- 4. delete leaves a tombstone that no reader shows ----
  await page.locator('tr', { hasText: '王小明（改）' }).getByRole('button', { name: '刪除' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '繼續' }).click();
  await page.waitForTimeout(300);
  await page.locator('div[style*="position: fixed"]').getByRole('button', { name: /確定刪除/ }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOT, '01_after_delete.png'), fullPage: true });

  recs = await raw();
  assert(recs.length === 2, `資料庫仍有 2 列（墓碑沒有被真的刪掉）：${recs.length}`);
  const tomb = recs.find(r => r.deletedAt);
  assert(tomb, '有一列被標記為已刪除');
  assert(ISO.test(tomb.deletedAt) && tomb.updatedAt === tomb.deletedAt,
    '墓碑的 deletedAt 與 updatedAt 同步更新');
  assert(!tomb.customerFields && !tomb.cardPhoto,
    '墓碑不再保留訪客欄位與名片照：' + JSON.stringify(Object.keys(tomb)));
  assert(tomb.id && tomb.eventId && tomb.timestamp,
    '墓碑保留同步需要的識別欄位');

  let body = await page.locator('body').innerText();
  assert(!body.includes('王小明'), '後台資料紀錄看不到已刪除的紀錄');
  assert(body.includes('李大華'), '其他紀錄不受影響');
  // Counted, not just name-matched. A tombstone keeps no customer fields, so a
  // leaked one renders as a *blank* row — searching for the name would never
  // see it, and the count is the only thing that does.
  assert(body.includes('資料紀錄（1 筆）'),
    '後台筆數為 1，沒有多出一列空白的墓碑：' + (body.match(/資料紀錄（\d+ 筆）/) || ['(找不到)'])[0]);

  // ---- 5. …including the export, which is where it would hurt ----
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: '匯出資料' }).click();
  const zipPath = path.join(SHOT, 'export_tomb.zip');
  await (await dl).saveAs(zipPath);
  const buf = fs.readFileSync(zipPath);
  const has = (s) => buf.includes(Buffer.from(s, 'utf8'));
  assert(!has('王小明'), '匯出的 xlsx 不含已刪除的紀錄');
  assert(has('李大華'), '匯出仍含未刪除的紀錄');
  // Same trap as the admin count above: a leaked tombstone carries no name, so
  // the check above would not see it — it would be an *empty* row. Row 1 is the
  // header and row 2 is the surviving record, so a row 3 means a leak.
  //
  // Scoped to the first worksheet on purpose. The workbook also carries a
  // "Field Definitions" sheet with dozens of rows, so probing the whole ZIP for
  // `<row r="3">` matches that instead and can never fail. Everything is
  // written STORE, so slicing the raw bytes reaches the sheet XML directly.
  const xml = buf.toString('latin1');
  const sheet1 = xml.slice(xml.indexOf('<worksheet'), xml.indexOf('</worksheet>') + 12);
  assert(sheet1.includes('<row r="2">'), '匯出的 Records 工作表確實有一列資料（否則下一條會空過）');
  assert(!sheet1.includes('<row r="3">'),
    '匯出的 Records 工作表沒有第 3 列（墓碑沒有變成一列空白）');

  // ---- 6. counts and the reception browser agree ----
  await page.getByRole('button', { name: '← 返回表單' }).click();
  await page.waitForTimeout(500);
  await page.locator('[data-open-browse]').click();
  await page.waitForTimeout(400);
  await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('0000');
  await page.getByRole('button', { name: '登入' }).click();
  await page.waitForTimeout(700);
  assert((await page.locator('[data-browse-row]').count()) === 1,
    '瀏覽頁只剩 1 筆');
  await page.getByRole('button', { name: '← 返回' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '← 活動列表' }).click();
  await page.waitForTimeout(600);
  const card = await page.locator('[data-event-card]').first().innerText();
  assert(card.includes('1 筆紀錄'), '活動卡片的筆數不含墓碑：' + card.replace(/\n/g, ' / '));

  // ---- 7. 清除全部 also tombstones, and stays scoped to its event ----
  await page.locator('[data-ev-enter]').first().click();
  await page.waitForTimeout(600);
  await H.openAdmin(page, '資料紀錄');
  await page.getByRole('button', { name: '清除全部' }).click();
  await page.waitForTimeout(300);
  await page.locator('input[placeholder="請輸入 DELETE"]').fill('DELETE');
  await page.getByRole('button', { name: '繼續' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /確定/ }).last().click();
  await page.waitForTimeout(800);
  recs = await raw();
  assert(recs.length === 2 && recs.every(r => r.deletedAt),
    `清除全部同樣留下墓碑（${recs.length} 列，全部已標記）`);

  assert(errors.length === 0, '無 console error：' + errors.join(' | '));
  await ctx.close();

  // ---- 8. migration: a v3.11-shaped database gains updatedAt ----
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
        fd.put({ key: 'ev-old::staffFields', value: [
          { id: 'greeter', nameEn: 'Greeter', nameZh: '接待人員', type: 'checkbox-group', source: 'event', required: false, isCore: true, order: 0, allowOther: false, options: [] },
        ]});
        // Pre-v3.12: no updatedAt, no deletedAt, no deviceId.
        tx.objectStore('records').put({ id: 'r-old', eventId: 'ev-old',
          timestamp: '2026-08-05T09:00:00.000Z', device: 'Tablet-1',
          customerFields: { name: '舊紀錄' }, needsFields: {}, companyFields: {},
          staffFields: { greeter: ['Charlene'], visit_date: '2026-08-05' },
          gdprConsent: true, cardPhoto: null });
        for (const k of ['migratedTo35', 'migratedTo36', 'migratedTo38', 'migratedTo310']) {
          tx.objectStore('config').put({ key: k, value: true });
        }
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    }));

    await p2.goto(BASE + '/');
    await p2.waitForTimeout(1800);

    const old = (await H.readAll(p2, 'records'))[0];
    assert(old.updatedAt === '2026-08-05T09:00:00.000Z',
      'updatedAt 補成建立時間，不捏造更晚的時間：' + old.updatedAt);
    assert(old.customerFields.name === '舊紀錄' && old.staffFields.greeter[0] === 'Charlene',
      '既有值完好');
    assert(!old.deletedAt, '既有紀錄沒有被誤標為已刪除');
    const id2 = await p2.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('ExhibitionFormDB');
      r.onsuccess = () => {
        const db = r.result;
        const g = db.transaction('config', 'readonly').objectStore('config').get('deviceId');
        g.onsuccess = () => { db.close(); res(g.result ? g.result.value : null); };
      };
    }));
    assert(id2 && id2.length >= 16, '既有安裝也產生了 deviceId：' + id2);
    await c2.close();
  }

  await browser.close();
  server.close();
  console.log(fails ? `\nSYNC MODEL FAILED (${fails})` : '\nSYNC MODEL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
