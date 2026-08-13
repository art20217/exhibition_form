// v3.16: a record holds several business card photos, not one.
//
// Cards have a back, and the back regularly carries the product line, the
// address, or a second number. This app does no OCR, so the image *is* the
// data — a side that cannot be photographed is a side that simply never gets
// collected.
//
// Photos are addressed by their own id rather than by position. That is the
// assertion worth caring about here: removing the first of three must not
// renumber the other two, on the tablet or on the server.
//
// The images go through the real input[type=file] → compressImage() path, so
// they have to be genuinely decodable JPEGs: canvas cannot draw bytes that do
// not parse, and a stub would silently store an empty photo while the suite
// stayed green.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-card-photos');
fs.mkdirSync(SHOT, { recursive: true });

// 1×1 JPEG, as in e2e-photo-sync.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

(async () => {
  const app = await H.serve();
  const BASE = app.base;
  const sync = await H.startSyncServer();
  const browser = await H.launchBrowser();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  const photoPath = (id) => path.join(sync.dataDir, 'photos', id + '.jpg');
  const photoBlocks = () => page.locator('[data-card-photo]');
  // A distinguishable image per capture, so "the right one was removed" is
  // answerable at all — four copies of the same bytes would prove nothing.
  const capture = async (label) => {
    await page.locator('[data-add-card-photo] input[type="file"]')
      .setInputFiles({ name: label + '.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG });
    await page.waitForTimeout(500);
  };
  const currentPhotos = () => page.evaluate(() =>
    window.__app.state.cardPhotos.map(p => ({ id: p.id, len: p.dataUrl.length })));
  const syncAndWait = async () => {
    await page.evaluate(() => window.__app.syncNow('test'));
    await page.waitForFunction(() => window.__app.state.syncStatus !== 'running', { timeout: 20000 })
      .catch(() => {});
    return page.evaluate(() => ({ status: window.__app.state.syncStatus, error: window.__app.state.syncError }));
  };

  await page.goto(BASE + '/seed');
  await H.wipeDB(page);
  await page.goto(BASE + '/');
  await page.waitForTimeout(1600);
  await H.configureSync(page, sync.base);
  await page.reload();
  await page.waitForTimeout(1600);

  await H.enterEvent(page);
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(500);

  // ---- 0. the inputs must not carry `capture` ----
  // Static, because the effect is invisible to everything here: `capture` means
  // "camera only" on iOS — Safari stops offering 照片圖庫 entirely — while
  // desktop browsers ignore it and `setInputFiles` bypasses it completely. So a
  // behavioural assertion is impossible and this is the only guard there is.
  // A card photographed earlier or sent over by a colleague could not be
  // attached at all until it was removed (issue #24).
  const source = fs.readFileSync(H.APP_HTML, 'utf8');
  assert(!/capture\s*=/.test(source),
    '名片的檔案輸入沒有 capture 屬性——加上去，事先拍好的名片就完全收不進來');

  // ---- 1. two photos, both kept ----
  assert((await photoBlocks().count()) === 0, '一開始沒有任何名片照片');
  await capture('front');
  await capture('back');
  assert((await photoBlocks().count()) === 2, `拍兩張就有兩個預覽框（實際 ${await photoBlocks().count()}）`);
  let body = await page.locator('body').innerText();
  assert(body.includes('名片照片 1') && body.includes('名片照片 2'), '兩張各自編號');
  await page.screenshot({ path: path.join(SHOT, '01_two_photos.png'), fullPage: true });

  // ---- 2. the cap is real ----
  await capture('third');
  await capture('fourth');
  assert((await photoBlocks().count()) === 4, '拍到四張');
  assert((await page.locator('[data-add-card-photo]').count()) === 0,
    '達到上限後「加拍一張」消失');

  // ---- 3. removing one leaves the others alone ----
  const before = await currentPhotos();
  await photoBlocks().first().locator('[data-card-photo-remove]').click();
  await page.waitForTimeout(300);
  // Two stages, as for every other delete: the original card left in someone's
  // pocket, so a mis-tap here is not recoverable.
  assert(await page.getByText('移除名片照片？').isVisible(), '移除名片跳出第 1 層確認');
  assert((await page.locator('body').innerText()).includes('第 1 張'),
    '確認訊息說明是哪一張');
  await page.getByRole('button', { name: '繼續' }).click();
  await page.waitForTimeout(250);
  assert(await page.getByText('第 2 次確認').isVisible(), '移除名片有第 2 層確認');
  await page.getByRole('button', { name: '確定刪除' }).click();
  await page.waitForTimeout(400);
  const after = await currentPhotos();
  assert(after.length === 3, `移除一張剩三張（實際 ${after.length}）`);
  assert(JSON.stringify(after.map(p => p.id)) === JSON.stringify(before.slice(1).map(p => p.id)),
    '剩下的三張還是原本那三張，id 沒有跟著位移——這正是不用索引定位的理由');
  assert((await page.locator('[data-add-card-photo]').count()) === 1,
    '低於上限後又能加拍');

  // ---- 4. they survive the round trip into a record ----
  await H.runFlow(page, { name: '王小明', company: '宏昌實業' });
  await page.getByRole('button', { name: /完成，返回|Done/ }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  const rec = await page.evaluate(() => {
    const r = window.__app.state.records[0];
    return { id: r.id, photos: (r.cardPhotos || []).map(p => p.id), hasData: (r.cardPhotos || []).every(p => p.dataUrl.startsWith('data:image/jpeg')) };
  });
  assert(rec.photos.length === 3, `紀錄帶著三張（實際 ${rec.photos.length}）`);
  assert(rec.hasData, '三張都是真的走過壓縮流程的 JPEG');
  assert(JSON.stringify(rec.photos) === JSON.stringify(after.map(p => p.id)),
    '存進紀錄的就是畫面上那三張');

  // ---- 5. the admin list says how many ----
  await H.openAdmin(page, '資料紀錄');
  body = await page.locator('body').innerText();
  assert(body.includes('1 筆含名片照片'), '統計仍以「筆」計：' + (body.match(/已蒐集[^\n]*/) || [''])[0]);
  const badge = await page.locator('[data-view-photo]').first().innerText();
  assert(badge.includes('×3'), '按鈕標出張數：' + badge);
  await page.locator('[data-view-photo]').first().click();
  await page.waitForTimeout(400);
  assert((await page.locator('img[src^="data:image/jpeg"]').count()) >= 3,
    '燈箱一次顯示全部三張——只顯示第一張等於把名片背面藏起來');
  await page.screenshot({ path: path.join(SHOT, '02_lightbox.png'), fullPage: true });
  await page.locator('button', { hasText: '×' }).last().click().catch(() => {});
  await page.waitForTimeout(300);

  // ---- 6. export names them _1 _2 _3 ----
  const zipNames = await page.evaluate(async () => {
    const app = window.__app;
    const captured = [];
    const orig = window.ExportLib.downloadZip || null;
    // Intercept whatever the export hands to the browser, so nothing is written
    // to disk and the assertion sees the real file list.
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => { captured.push(blob); return 'blob:stub'; };
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    await app.exportData();
    URL.createObjectURL = realCreate;
    HTMLAnchorElement.prototype.click = realClick;
    if (!captured.length) return null;
    const buf = new Uint8Array(await captured[0].arrayBuffer());
    // Central-directory file names are enough; no need to inflate anything.
    const text = new TextDecoder('latin1').decode(buf);
    return (text.match(/cards\/[^\x00-\x1f"]{0,80}?\.jpg/g) || []);
  });
  // Each name appears twice in the archive — local file header and central
  // directory — so count distinct names, not matches.
  const uniqueNames = [...new Set(zipNames || [])].sort();
  assert(uniqueNames.length === 3, `匯出的 ZIP 有三個名片檔（實際 ${uniqueNames.length}）`);
  assert(uniqueNames.every(n => /_[123]\.jpg$/.test(n)),
    '檔名一律帶編號，即使只有一張也是 _1——下游不必處理兩種命名');
  assert(uniqueNames.every((n, i) => n.endsWith(`_${i + 1}.jpg`)),
    '編號連續且對應張數順序：' + uniqueNames.map(n => n.slice(-7)).join(' '));

  // ---- 7. the server keeps exactly the photos the record still lists ----
  await page.getByRole('button', { name: '← 返回表單' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '← 活動列表' }).click();
  await page.waitForTimeout(600);
  let st = await syncAndWait();
  assert(st.status === 'idle', `同步成功（${st.status} ${st.error}）`);
  const present = rec.photos.filter(id => fs.existsSync(photoPath(id)));
  assert(present.length === 3, `三張都上傳了（實際 ${present.length}）`);

  // Remove the middle one and sync again. Nothing calls a delete endpoint —
  // the record simply stops listing it, and the server prunes.
  const dropped = rec.photos[1];
  await page.evaluate(([recId, dropId]) => {
    const app = window.__app;
    const recs = app.state.records.map(r => r.id === recId
      ? { ...r, cardPhotos: r.cardPhotos.filter(p => p.id !== dropId),
          updatedAt: app.nextUpdatedAt(r.updatedAt) } : r);
    app.setState({ records: recs });
    return app.dbPut('records', recs.find(r => r.id === recId));
  }, [rec.id, dropped]);
  await page.waitForTimeout(300);
  st = await syncAndWait();
  assert(!fs.existsSync(photoPath(dropped)),
    '在平板上移除的那張，伺服器上也不見了');
  assert(fs.existsSync(photoPath(rec.photos[0])) && fs.existsSync(photoPath(rec.photos[2])),
    '另外兩張安然無恙——刪除認的是照片 id，不是位置');

  assert(errors.length === 0, '無 console error：' + errors.join(' | '));
  await ctx.close();
  await browser.close();
  app.close();
  await new Promise(r => sync.close(r));
  fs.rmSync(sync.dataDir, { recursive: true, force: true });
  console.log(fails ? `\nCARD PHOTOS FAILED (${fails})` : '\nCARD PHOTOS PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
