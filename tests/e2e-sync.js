// v3.13: the foreground sync engine, driven against the reference server.
//
// Two browser contexts stand in for two tablets, because that is the thing
// actually being built — one tablet talking to a server proves almost nothing.
// What matters is that records collected on A show up on B, that an edit on B
// wins on A, and that a delete on A removes the row from B.
//
// The show's Wi-Fi drops constantly, so the failure cases carry as much weight
// as the happy path: a resend must not duplicate, an outage must not lose
// anything, and a bad token must not look like an outage.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-sync');
fs.mkdirSync(SHOT, { recursive: true });

(async () => {
  const app = await H.serve();
  const BASE = app.base;
  let sync = await H.startSyncServer();
  const browser = await H.launchBrowser();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  const errors = [];
  const openTablet = async (label) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${label} PAGEERROR: ` + e.message));
    page.on('console', m => {
      // Refused connections and 401s are what half this suite deliberately
      // provokes, and the browser logs every failed request whatever the page
      // does with it. Uncaught exceptions still come through `pageerror` above,
      // which is the signal that actually means something is broken.
      if (m.type() !== 'error') return;
      if (/Failed to load resource/.test(m.text())) return;
      errors.push(`${label}: ` + m.text());
    });
    await page.goto(BASE + '/seed');
    await H.wipeDB(page);
    // Boot once so initDB() creates the stores, then write the sync settings
    // and reload for loadAllData() to read them.
    await page.goto(BASE + '/');
    await page.waitForTimeout(1600);
    await H.configureSync(page, sync.base);
    await page.reload();
    await page.waitForTimeout(1600);
    return { ctx, page };
  };

  // Drives sync from the page and waits for it to settle, rather than sleeping
  // and hoping. Returns the status the bar ended up showing.
  const syncAndWait = async (page) => {
    await page.evaluate(() => window.__app.syncNow('test'));
    await page.waitForFunction(() => window.__app.state.syncStatus !== 'running', { timeout: 15000 })
      .catch(() => {});
    return page.evaluate(() => ({
      status: window.__app.state.syncStatus,
      error: window.__app.state.syncError,
      seq: window.__app.state.syncSeq,
    }));
  };

  const liveNames = (page) => page.evaluate(() =>
    window.__app.state.records.filter(r => !r.deletedAt).map(r => r.customerFields && r.customerFields.name).sort());

  const fillOne = async (page, name) => {
    await H.pickCustomerStatus(page);
    await page.locator('[data-entry-customer]').click();
    await page.waitForTimeout(500);
    await H.runFlow(page, { name });
    await page.getByRole('button', { name: /完成，返回|Done/ }).first().click().catch(() => {});
    await page.waitForTimeout(400);
  };

  // ---- A collects two records and pushes them ----
  const A = await openTablet('A');
  await H.enterEvent(A.page);
  await fillOne(A.page, '王小明');
  await fillOne(A.page, '李大華');

  let st = await syncAndWait(A.page);
  assert(st.status === 'idle', `A 同步成功（狀態 ${st.status} ${st.error}）`);
  let onServer = await H.serverRecords(sync);
  assert(onServer.length === 2, `伺服器收到 2 筆（實際 ${onServer.length}）`);
  assert(onServer.every(r => r.cardPhoto === undefined),
    '推送不含名片照片欄位——照片走獨立端點');
  assert(onServer.every(r => r.syncedAt === undefined),
    'syncedAt 是本機記帳，不上傳');

  // ---- resending is safe: the network cuts out after the write all the time ----
  await A.page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('ExhibitionFormDB');
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction('records', 'readwrite');
      const g = tx.objectStore('records').getAll();
      g.onsuccess = () => {
        for (const rec of g.result) tx.objectStore('records').put({ ...rec, syncedAt: undefined });
      };
      tx.oncomplete = () => { db.close(); res(); };
    };
  }));
  await A.page.reload();
  await A.page.waitForTimeout(1600);
  st = await syncAndWait(A.page);
  onServer = await H.serverRecords(sync);
  assert(onServer.length === 2,
    `重送同一批之後伺服器仍是 2 筆，沒有變成 4 筆（實際 ${onServer.length}）`);

  // ---- B starts empty and pulls A's work ----
  const B = await openTablet('B');
  st = await syncAndWait(B.page);
  assert(st.status === 'idle', `B 同步成功（狀態 ${st.status} ${st.error}）`);
  let names = await liveNames(B.page);
  assert(JSON.stringify(names) === JSON.stringify(['李大華', '王小明']),
    'B 拉到了 A 的兩筆紀錄：' + names.join('、'));
  assert(st.seq > 0, 'B 的游標已推進：' + st.seq);
  await B.page.screenshot({ path: path.join(SHOT, '01_b_pulled.png'), fullPage: true });

  // ---- B edits; A picks the change up (last-write-wins) ----
  const targetId = await B.page.evaluate(() =>
    window.__app.state.records.find(r => r.customerFields && r.customerFields.name === '王小明').id);
  await B.page.evaluate((id) => {
    const app = window.__app;
    const recs = app.state.records.map(r => r.id === id
      ? { ...r, customerFields: { ...r.customerFields, name: '王小明（B 改）' },
          updatedAt: new Date(Date.now() + 1000).toISOString() }
      : r);
    app.setState({ records: recs });
    return app.dbPut('records', recs.find(r => r.id === id));
  }, targetId);
  await syncAndWait(B.page);
  st = await syncAndWait(A.page);
  names = await liveNames(A.page);
  assert(names.includes('王小明（B 改）') && !names.includes('王小明'),
    'A 套用了 B 的修改（LWW）：' + names.join('、'));

  // ---- A deletes; the tombstone reaches B ----
  await A.page.evaluate((id) => window.__app.deleteRecord(id), targetId);
  await A.page.waitForTimeout(400);
  await syncAndWait(A.page);
  st = await syncAndWait(B.page);
  names = await liveNames(B.page);
  assert(JSON.stringify(names) === JSON.stringify(['李大華']),
    'B 上該筆已消失，墓碑有傳過去：' + names.join('、'));
  const bTomb = await B.page.evaluate((id) =>
    !!window.__app.state.records.find(r => r.id === id && r.deletedAt), targetId);
  assert(bTomb, 'B 收到的是墓碑，不是整筆消失——否則下次同步又會長回來');

  // ---- pulling is refused while a record is open ----
  // A remote copy landing on the record someone is typing into would discard
  // their work silently, so the engine pushes but does not pull mid-form.
  await B.page.evaluate(() => window.__app.setState({ screen: 'customerForm', editingRecordId: 'anything' }));
  const blocked = await B.page.evaluate(() => window.__app.pullAllowed());
  assert(blocked === false, '編輯中時 pullAllowed() 為 false');
  const seqBefore = await B.page.evaluate(() => window.__app.state.syncSeq);
  await A.page.evaluate(() => window.__app.setState({ screen: 'events' }));
  // Something new on the server that B would otherwise pull.
  await A.page.evaluate(() => window.__app.syncNow('test'));
  await B.page.evaluate(() => window.__app.syncNow('test'));
  await B.page.waitForTimeout(1200);
  const seqAfter = await B.page.evaluate(() => window.__app.state.syncSeq);
  assert(seqAfter === seqBefore, `編輯中同步不推進游標（${seqBefore} → ${seqAfter}）`);
  await B.page.evaluate(() => window.__app.setState({ screen: 'events', editingRecordId: null }));

  // ---- the server goes away: nothing is lost, and it says so ----
  await new Promise(r => sync.close(r));
  await B.page.evaluate(() => {
    const app = window.__app;
    const recs = app.state.records.map(r => ({ ...r, syncedAt: undefined }));
    app.setState({ records: recs });
  });
  st = await syncAndWait(B.page);
  assert(st.status === 'error' && st.error === '無法連線',
    `離線時顯示無法連線（實際 ${st.status} / ${st.error}）`);
  const stillThere = await liveNames(B.page);
  assert(JSON.stringify(stillThere) === JSON.stringify(['李大華']),
    '連不上時資料仍在，沒有被丟掉');
  const stillDirty = await B.page.evaluate(() => window.__app.dirtyRecords().length);
  assert(stillDirty > 0, `未送出的紀錄仍標記為待同步（${stillDirty} 筆）`);
  const bar = await B.page.locator('[data-sync-status]').innerText().catch(() => '(無)');
  assert(bar.includes('同步失敗'), '狀態列顯示失敗：' + bar);
  await B.page.screenshot({ path: path.join(SHOT, '02_offline.png'), fullPage: true });

  // ---- and it recovers once the server is back ----
  sync = await H.startSyncServer({ dataDir: sync.dataDir });
  // A fresh port, so point the tablet at it.
  await H.configureSync(B.page, sync.base);
  await B.page.reload();
  await B.page.waitForTimeout(1600);
  st = await syncAndWait(B.page);
  assert(st.status === 'idle', `伺服器回來後同步恢復（${st.status} ${st.error}）`);

  // ---- a wrong token must not look like an outage ----
  await H.configureSync(B.page, sync.base, 'wrong-token');
  await B.page.reload();
  await B.page.waitForTimeout(1600);
  st = await syncAndWait(B.page);
  assert(st.status === 'error' && st.error === '存取權杖錯誤',
    `權杖錯誤有自己的訊息（實際 ${st.error}）`);
  assert(st.error !== '無法連線',
    '權杖錯誤與離線的訊息不同——否則使用者會跑去檢查 Wi-Fi');

  assert(errors.length === 0, '無 console error：' + errors.join(' | '));
  await A.ctx.close(); await B.ctx.close();
  await browser.close();
  app.close();
  await new Promise(r => sync.close(r));
  fs.rmSync(sync.dataDir, { recursive: true, force: true });
  console.log(fails ? `\nSYNC FAILED (${fails})` : '\nSYNC PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
