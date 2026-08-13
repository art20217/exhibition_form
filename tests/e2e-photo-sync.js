// v3.14: business card photos reach the server. v3.16: several per record.
//
// Photos are the one payload that makes the venue's unreliable Wi-Fi bite —
// 200–500KB each against records measured in kilobytes. So the interesting
// assertions are not "it uploads" but "it does not upload again when it
// doesn't have to", and "a deleted record takes its photo with it".
//
// The image is pushed through the real `input[type=file]` → compressImage()
// path, so it has to be a genuinely decodable JPEG: canvas cannot draw bytes
// that do not parse, and a stub would silently produce an empty photo.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-photo-sync');
fs.mkdirSync(SHOT, { recursive: true });

// A 1×1 JPEG. Real enough for the browser to decode and re-encode.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

(async () => {
  const app = await H.serve();
  const BASE = app.base;
  let sync = await H.startSyncServer();
  const browser = await H.launchBrowser();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;   // offline is tested on purpose
    errors.push(m.text());
  });

  // Photos are filed under their own id as of v3.16, not the record's — so a
  // record with two cards has two files, and removing one cannot renumber the
  // other.
  const photoPath = (id) => path.join(sync.dataDir, 'photos', id + '.jpg');
  const photoIds = (recId) => page.evaluate((id) =>
    (window.__app.state.records.find(r => r.id === id).cardPhotos || []).map(p => p.id), recId);
  const syncAndWait = async () => {
    await page.evaluate(() => window.__app.syncNow('test'));
    await page.waitForFunction(() => window.__app.state.syncStatus !== 'running', { timeout: 20000 })
      .catch(() => {});
    return page.evaluate(() => ({
      status: window.__app.state.syncStatus,
      error: window.__app.state.syncError,
      photos: window.__app.pendingPhotos().length,
    }));
  };

  await page.goto(BASE + '/seed');
  await H.wipeDB(page);
  await page.goto(BASE + '/');
  await page.waitForTimeout(1600);
  await H.configureSync(page, sync.base);
  await page.reload();
  await page.waitForTimeout(1600);

  // ---- fill one record, with a photo ----
  await H.enterEvent(page);
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(500);
  // The card lives at the foot of the customer form, so attach it first and let
  // runFlow fill the rest — nationality is required and blocks submission.
  await page.locator('input[type="file"]').first()
    .setInputFiles({ name: 'card.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG });
  await page.waitForTimeout(600);
  await H.runFlow(page, { name: '王小明', company: '宏昌實業' });
  await page.getByRole('button', { name: /完成，返回|Done/ }).first().click().catch(() => {});
  await page.waitForTimeout(500);

  const recId = await page.evaluate(() => window.__app.state.records[0].id);
  const hasLocalPhoto = await page.evaluate(() =>
    ((window.__app.state.records[0].cardPhotos || [])[0]?.dataUrl || '').startsWith('data:image/jpeg'));
  assert(hasLocalPhoto, '名片照已存進紀錄（走過真正的壓縮流程）');
  const [photoId] = await photoIds(recId);

  // ---- 1. it reaches the server as a real JPEG ----
  let st = await syncAndWait();
  assert(st.status === 'idle', `同步成功（${st.status} ${st.error}）`);
  assert(fs.existsSync(photoPath(photoId)), '伺服器上出現 photos/<照片 id>.jpg');
  const bytes = fs.readFileSync(photoPath(photoId));
  assert(bytes.length > 0 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF,
    `檔案是真的 JPEG（${bytes.length} bytes，magic ${bytes.slice(0, 3).toString('hex')}）`);
  assert(st.photos === 0, '上傳後待上傳張數歸零');

  const onServer = await H.serverRecords(sync);
  assert(onServer.length === 1 && onServer[0].cardPhotos === undefined,
    '紀錄本身仍不帶 cardPhotos——照片走獨立端點');
  assert(onServer[0].photoSyncedDigests === undefined,
    'photoSyncedDigests 是本機記帳，不上傳');
  assert(Array.isArray(onServer[0].photoIds) && onServer[0].photoIds[0] === photoId,
    '但 photoIds 有送——伺服器靠它知道該留哪幾張');

  // ---- 2. syncing again does not re-upload ----
  const mtime1 = fs.statSync(photoPath(photoId)).mtimeMs;
  await new Promise(r => setTimeout(r, 1100));       // coarse mtime resolution
  await syncAndWait();
  assert(fs.statSync(photoPath(photoId)).mtimeMs === mtime1,
    '再次同步沒有重傳（mtime 未變）');

  // ---- 3. …and neither does a text-only edit ----
  // This is the whole reason the digest exists. Keying off updatedAt would
  // resend the image every time somebody fixes a typo.
  await page.evaluate((id) => {
    const app = window.__app;
    const recs = app.state.records.map(r => r.id === id
      ? { ...r, customerFields: { ...r.customerFields, name: '王大明' },
          updatedAt: app.nextUpdatedAt(r.updatedAt) }
      : r);
    app.setState({ records: recs });
    return app.dbPut('records', recs.find(r => r.id === id));
  }, recId);
  await new Promise(r => setTimeout(r, 1100));
  st = await syncAndWait();
  const server2 = await H.serverRecords(sync);
  assert(server2[0].customerFields.name === '王大明', '文字修改有送到伺服器');
  assert(fs.statSync(photoPath(photoId)).mtimeMs === mtime1,
    '只改文字時照片沒有重傳——內容摘要就是為了這件事');

  // ---- 4. replacing the photo does re-upload ----
  await page.evaluate((id) => {
    const app = window.__app;
    // A different image: same encoding, different bytes, so the digest moves.
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 8;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#c0ffee'; ctx.fillRect(0, 0, 8, 8);
    const url = canvas.toDataURL('image/jpeg', 0.8);
    const recs = app.state.records.map(r => r.id === id
      ? { ...r, cardPhotos: r.cardPhotos.map((p, i) => i === 0 ? { ...p, dataUrl: url } : p),
          updatedAt: app.nextUpdatedAt(r.updatedAt) } : r);
    app.setState({ records: recs });
    return app.dbPut('records', recs.find(r => r.id === id));
  }, recId);
  await new Promise(r => setTimeout(r, 1100));
  await syncAndWait();
  const bytes2 = fs.readFileSync(photoPath(photoId));
  assert(bytes2.length !== bytes.length || !bytes2.equals(bytes),
    `換照片後伺服器上的檔案跟著換（${bytes.length} → ${bytes2.length} bytes）`);

  // ---- 5. a record the server has not accepted keeps its photo at home ----
  const wouldUpload = await page.evaluate(() =>
    window.__app.photoPendingFor({ id: 'x', syncedAt: null },
      { id: 'p1', dataUrl: 'data:image/jpeg;base64,AAA' }));
  assert(wouldUpload === false, '尚未同步的紀錄不會先傳照片——否則伺服器收到孤兒圖檔');

  // ---- 6. deleting the record deletes the photo on the server ----
  // Same reason the client strips the photo when it tombstones: a deleted
  // record has no business still holding a visitor's business card.
  await page.evaluate((id) => window.__app.deleteRecord(id), recId);
  await page.waitForTimeout(400);
  st = await syncAndWait();
  assert(!fs.existsSync(photoPath(photoId)),
    '刪除紀錄後伺服器上的照片一併消失');
  await page.screenshot({ path: path.join(SHOT, '01_after_delete.png'), fullPage: true });

  // ---- 7. offline: the record is safe, the photo waits ----
  await new Promise(r => sync.close(r));
  // Still on the event page: staff and date persist, but 新／舊客戶 resets after
  // every record, so the entries are shut until it is answered again.
  await H.pickCustomerStatus(page);
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(500);
  await page.locator('input[type="file"]').first()
    .setInputFiles({ name: 'card2.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG });
  await page.waitForTimeout(600);
  await H.runFlow(page, { name: '離線客戶', company: '離線公司' });
  await page.getByRole('button', { name: /完成，返回|Done/ }).first().click().catch(() => {});
  await page.waitForTimeout(500);

  st = await syncAndWait();
  assert(st.status === 'error' && st.error === '無法連線', `離線時顯示無法連線（${st.error}）`);
  const offlineId = await page.evaluate(() =>
    window.__app.state.records.find(r => r.customerFields?.name === '離線客戶').id);
  const keptPhoto = await page.evaluate((id) =>
    (window.__app.state.records.find(r => r.id === id).cardPhotos || []).length > 0, offlineId);
  assert(keptPhoto, '連不上時照片仍在平板上，沒有被丟掉');

  // ---- …and completes once the server is back ----
  sync = await H.startSyncServer({ dataDir: sync.dataDir });
  await H.configureSync(page, sync.base);
  await page.reload();
  await page.waitForTimeout(1600);
  st = await syncAndWait();
  assert(st.status === 'idle', `伺服器回來後恢復（${st.status} ${st.error}）`);
  const [offlinePhotoId] = await photoIds(offlineId);
  assert(fs.existsSync(photoPath(offlinePhotoId)), '離線期間拍的照片補傳成功');
  assert(st.photos === 0, `待上傳張數歸零（實際 ${st.photos}）`);

  assert(errors.length === 0, '無 console error：' + errors.join(' | '));
  await ctx.close();
  await browser.close();
  app.close();
  await new Promise(r => sync.close(r));
  fs.rmSync(sync.dataDir, { recursive: true, force: true });
  console.log(fails ? `\nPHOTO SYNC FAILED (${fails})` : '\nPHOTO SYNC PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
