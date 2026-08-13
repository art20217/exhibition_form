// v3.16 migration: the single `cardPhoto` string becomes a list.
//
// The interesting part is the id the migrated photo gets. Photos are filed on
// the server under their photo id, and until v3.16 that id *was* the record id.
// Reusing it here keeps the stored digest matching, so nothing already uploaded
// is sent again. Minting a fresh uuid would look tidier and would re-upload
// every business card on a tablet's next sync, over exhibition Wi-Fi — which is
// the one thing the photo work has been avoiding since v3.14.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-mig316');
fs.mkdirSync(SHOT, { recursive: true });

const TINY_JPEG_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJ'
  + 'CQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA'
  + '/8QAFAABAAAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/ACqf/9k=';

// A v3.15-shaped database: DB version 2 (events store present), records holding
// one `cardPhoto` string and a `photoSyncedDigest`.
const seedV315 = (page, build) => page.evaluate((b) => new Promise((res, rej) => {
  const d = indexedDB.deleteDatabase('ExhibitionFormDB');
  d.onerror = () => rej(d.error);
  d.onsuccess = d.onblocked = () => {
    const req = indexedDB.open('ExhibitionFormDB', 2);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('config')) db.createObjectStore('config', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('fieldDefinitions')) db.createObjectStore('fieldDefinitions', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id' });
    };
    req.onerror = () => rej(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['config', 'records', 'events', 'fieldDefinitions'], 'readwrite');
      for (const c of b.config) tx.objectStore('config').put(c);
      for (const r of b.records) tx.objectStore('records').put(r);
      for (const e2 of b.events) tx.objectStore('events').put(e2);
      for (const f of b.defs) tx.objectStore('fieldDefinitions').put(f);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
  };
}), build);

(async () => {
  const app = await H.serve();
  const BASE = app.base;
  const sync = await H.startSyncServer();
  const browser = await H.launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  const EV = 'event-1';
  const WITH_PHOTO = 'rec-with-photo';
  const NO_PHOTO = 'rec-no-photo';
  const TOMBSTONE = 'rec-tombstone';

  await page.goto(BASE + '/seed');
  await seedV315(page, {
    config: [
      { key: 'pin', value: '0000' },
      { key: 'deviceId', value: 'device-a' },
      // Every earlier migration already run, so only v3.16's runs here.
      ...['migratedTo33', 'migratedTo34', 'migratedTo35', 'migratedTo36', 'migratedTo38',
          'migratedTo310', 'migratedTo312', 'migratedTo315'].map(key => ({ key, value: true })),
    ],
    events: [{ id: EV, name: '2026 舊資料展', startDate: '2026-01-01', endDate: '2026-01-02',
      status: 'active', staff: ['王大明'], createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: null, ownerDeviceId: 'device-a' }],
    defs: [
      { key: EV + '::customerFields', value: [
        { id: 'name', nameEn: 'Name', nameZh: '姓名', type: 'text', required: true, isCore: true, order: 0, options: [] },
      ]},
      { key: EV + '::needsFields', value: [] },
      { key: EV + '::companyFields', value: [] },
      { key: EV + '::staffFields', value: [] },
    ],
    records: [
      { id: WITH_PHOTO, eventId: EV, deviceId: 'device-a', timestamp: '2026-01-01T01:00:00.000Z',
        updatedAt: '2026-01-01T01:00:00.000Z', deletedAt: null,
        customerFields: { name: '有照片' }, needsFields: {}, companyFields: {}, staffFields: {},
        gdprConsent: true, cardPhoto: TINY_JPEG_URL,
        syncedAt: '2026-01-01T02:00:00.000Z', photoSyncedDigest: '__ALREADY_UPLOADED__' },
      { id: NO_PHOTO, eventId: EV, deviceId: 'device-a', timestamp: '2026-01-01T01:05:00.000Z',
        updatedAt: '2026-01-01T01:05:00.000Z', deletedAt: null,
        customerFields: { name: '沒照片' }, needsFields: {}, companyFields: {}, staffFields: {},
        gdprConsent: true, cardPhoto: null },
      { id: TOMBSTONE, eventId: EV, deviceId: 'device-a', timestamp: '2026-01-01T01:10:00.000Z',
        updatedAt: '2026-01-01T01:20:00.000Z', deletedAt: '2026-01-01T01:20:00.000Z' },
    ],
  });

  // The digest has to be the one the app itself would compute, so compute it
  // with the app's own function rather than hard-coding a hash.
  await page.goto(BASE + '/');
  await page.waitForTimeout(1800);

  const rows = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('ExhibitionFormDB');
    r.onsuccess = () => {
      const db = r.result;
      const g = db.transaction('records', 'readonly').objectStore('records').getAll();
      g.onsuccess = () => { db.close(); res(g.result); };
    };
  }));
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));

  // ---- 1. the photo moves into the list, keeping the record's id ----
  const withPhoto = byId[WITH_PHOTO];
  assert(Array.isArray(withPhoto.cardPhotos) && withPhoto.cardPhotos.length === 1,
    `舊的單張照片變成一張的清單（實際 ${JSON.stringify((withPhoto.cardPhotos || []).length)}）`);
  assert(withPhoto.cardPhotos[0].id === WITH_PHOTO,
    '照片 id 沿用紀錄 id——伺服器上那個檔名本來就是它，換 id 等於整批重傳');
  assert(withPhoto.cardPhotos[0].dataUrl === TINY_JPEG_URL, '影像本身原封不動');
  assert(!('cardPhoto' in withPhoto), '舊欄位已移除，不留兩份真相');

  // ---- 2. a record with no photo gets an empty list, not undefined ----
  assert(Array.isArray(byId[NO_PHOTO].cardPhotos) && byId[NO_PHOTO].cardPhotos.length === 0,
    '沒有照片的紀錄拿到空陣列');

  // ---- 3. tombstones stay bare ----
  assert(!byId[TOMBSTONE].cardPhoto && (byId[TOMBSTONE].cardPhotos || []).length === 0,
    '墓碑沒有被塞進照片欄位');
  assert(byId[TOMBSTONE].deletedAt === '2026-01-01T01:20:00.000Z', '墓碑的刪除時間沒被動到');

  // ---- 4. the upload bookkeeping comes with it, under the same key ----
  assert(withPhoto.photoSyncedDigests
    && withPhoto.photoSyncedDigests[WITH_PHOTO] === '__ALREADY_UPLOADED__',
    '舊的 photoSyncedDigest 搬進以照片 id 為鍵的 map：'
    + JSON.stringify(withPhoto.photoSyncedDigests));
  assert(!('photoSyncedDigest' in withPhoto), '舊的單一 digest 欄位已移除');

  // ---- 5. …so nothing is queued for re-upload ----
  // The whole point of reusing the record id. Write the digest this image
  // actually hashes to — the state a tablet that already uploaded it is in —
  // and the queue must come out empty. Minting a fresh photo id instead would
  // leave the stored digest filed under a key nothing looks up, and every card
  // on the tablet would fly again.
  await page.evaluate(async ([id, url]) => {
    const app = window.__app;
    const digest = app.photoDigest(url);
    const recs = app.state.records.map(r => r.id === id
      ? { ...r, photoSyncedDigests: { [id]: digest } } : r);
    app.setState({ records: recs });
    await app.dbPut('records', recs.find(r => r.id === id));
  }, [WITH_PHOTO, TINY_JPEG_URL]);
  await page.waitForTimeout(300);
  const queued = await page.evaluate(() => window.__app.pendingPhotos().map(x => x.photo.id));
  assert(queued.length === 0,
    '待傳佇列是空的——遷移不會讓每台平板重傳一次全部名片：' + JSON.stringify(queued));

  // ---- 6. and the app still works on top of it ----
  await page.screenshot({ path: path.join(SHOT, '01_after_migration.png'), fullPage: true });
  const body = await page.locator('body').innerText();
  assert(body.includes('2026 舊資料展'), '遷移後 app 正常開起來');
  const flag = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('ExhibitionFormDB');
    r.onsuccess = () => {
      const db = r.result;
      const g = db.transaction('config', 'readonly').objectStore('config').get('migratedTo316');
      g.onsuccess = () => { db.close(); res(g.result && g.result.value); };
    };
  }));
  assert(flag === true, '遷移旗標寫下了，不會每次開啟都重跑');

  assert(errors.length === 0, '無 console error：' + errors.join(' | '));
  await ctx.close();
  await browser.close();
  app.close();
  await new Promise(r => sync.close(r));
  fs.rmSync(sync.dataDir, { recursive: true, force: true });
  console.log(fails ? `\nMIGRATION v3.16 FAILED (${fails})` : '\nMIGRATION v3.16 PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
