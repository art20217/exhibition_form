// v3.15: events and their field definitions sync, so two tablets can finally
// share an exhibition.
//
// Until now the server held records tagged with an opaque `eventId` and nothing
// that explained it — no exhibition name, no Chinese labels, no field types, no
// names for admin-added fields. And on a second tablet those records landed in
// IndexedDB and appeared nowhere, because every reader filters by the currently
// open event and that event did not exist there.
//
// Definitions are owned by one device. That is not a permission system — it is
// the same kind of guard as the admin PIN — but it removes the need to merge
// definitions at all, which is the part that would have been genuinely hard: a
// nested structure where one person's new option quietly loses to another's.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-event-sync');
fs.mkdirSync(SHOT, { recursive: true });

(async () => {
  const app = await H.serve();
  const BASE = app.base;
  const sync = await H.startSyncServer();
  const browser = await H.launchBrowser();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  const errors = [];
  const openTablet = async (label) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${label} PAGEERROR: ` + e.message));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      if (/Failed to load resource/.test(m.text())) return;
      errors.push(`${label}: ` + m.text());
    });
    await page.goto(BASE + '/seed');
    await H.wipeDB(page);
    await page.goto(BASE + '/');
    await page.waitForTimeout(1600);
    await H.configureSync(page, sync.base);
    await page.reload();
    await page.waitForTimeout(1600);
    // A human label so the read-only banner on the other tablet can name it.
    await H.openSettings(page);
    await page.locator('input[type="text"]').first().fill('平板 ' + label);
    await page.getByRole('button', { name: '儲存設定' }).click();
    await page.waitForTimeout(500);
    await page.locator('[data-settings-back]').click();
    await page.waitForTimeout(400);
    await H.lockManage(page);
    return { ctx, page };
  };

  // Both tablets end up holding two events — each also syncs the one its own
  // fresh install seeded — so never reach for .first().
  const enterNamed = async (page, name = '2026 秋季展') => {
    await page.locator('[data-event-card]', { hasText: name }).locator('[data-ev-enter]').click();
    await page.waitForTimeout(600);
  };

  const syncAndWait = async (page) => {
    await page.evaluate(() => window.__app.syncNow('test'));
    await page.waitForFunction(() => window.__app.state.syncStatus !== 'running', { timeout: 20000 })
      .catch(() => {});
    return page.evaluate(() => ({
      status: window.__app.state.syncStatus, error: window.__app.state.syncError,
      eventSeq: window.__app.state.syncEventSeq,
    }));
  };

  // ---- A sets up an exhibition, adds a field of its own, collects a record ----
  const A = await openTablet('A');
  await H.unlockManage(A.page);
  await A.page.locator('[data-ev-edit]').first().click();
  await A.page.waitForTimeout(400);
  await A.page.locator('input[placeholder="例如 2026 美國展"]').fill('2026 秋季展');
  await A.page.getByRole('button', { name: '儲存活動' }).click();
  await A.page.waitForTimeout(600);
  await H.lockManage(A.page);

  await H.enterEvent(A.page);
  await H.openAdmin(A.page, '客戶資料欄位');
  await A.page.locator('[data-add-field]').click();
  await A.page.waitForTimeout(400);
  await A.page.locator('input[placeholder="例如 Country"]').fill('Booth Number');
  await A.page.locator('input[placeholder="例如 國家"]').fill('攤位編號');
  await A.page.getByRole('button', { name: '儲存欄位' }).click();
  await A.page.waitForTimeout(600);
  await A.page.getByRole('button', { name: '← 返回表單' }).click();
  await A.page.waitForTimeout(500);

  await H.pickCustomerStatus(A.page);
  await A.page.locator('[data-entry-customer]').click();
  await A.page.waitForTimeout(500);
  await H.runFlow(A.page, { name: '王小明', company: '宏昌實業' });
  await A.page.getByRole('button', { name: /完成，返回|Done/ }).first().click().catch(() => {});
  await A.page.waitForTimeout(500);
  await A.page.getByRole('button', { name: '← 活動列表' }).click();
  await A.page.waitForTimeout(600);

  let st = await syncAndWait(A.page);
  assert(st.status === 'idle', `A 同步成功（${st.status} ${st.error}）`);

  // ---- 1. the server now holds something interpretable ----
  const res = await fetch(sync.base.replace(/\/v1$/, '') + '/debug/all',
    { headers: { Authorization: 'Bearer test-token' } });
  const dump = await res.json();
  assert(dump.events.length === 1, `伺服器收到 1 場活動（實際 ${dump.events.length}）`);
  const srvEvent = dump.events[0];
  assert(srvEvent.name === '2026 秋季展', '活動名稱送到了：' + srvEvent.name);
  assert(Array.isArray(srvEvent.staff) && srvEvent.staff.length === 8, '接待人員名冊也送到了');
  const custDefs = srvEvent.fieldDefs && srvEvent.fieldDefs.customerFields;
  assert(Array.isArray(custDefs), '欄位定義快照隨活動送達');
  assert(custDefs.some(f => f.nameZh === '攤位編號'),
    '自訂欄位的中文標籤在伺服器上讀得到——先前只有一串 id');
  assert(custDefs.some(f => f.nameZh === '訪客國籍' && Array.isArray(f.options) && f.options.length > 0),
    '選項清單也在，伺服器才還原得出人類可讀的表格');
  assert(dump.records.length === 1 && dump.records[0].eventId === srvEvent.id,
    '紀錄與活動對得起來');

  // ---- 2. B pulls, and actually SEES A's record ----
  // This is the thing v3.13 and v3.14 could not do.
  const B = await openTablet('B');
  st = await syncAndWait(B.page);
  assert(st.status === 'idle', `B 同步成功（${st.status} ${st.error}）`);
  await B.page.reload();
  await B.page.waitForTimeout(1600);
  let body = await B.page.locator('body').innerText();
  assert(body.includes('2026 秋季展'), 'B 的活動列表出現 A 建立的活動：' + body.split('\n').slice(0, 6).join(' | '));
  await B.page.screenshot({ path: path.join(SHOT, '01_b_event_list.png'), fullPage: true });

  await enterNamed(B.page);
  await H.openAdmin(B.page, '資料紀錄');
  body = await B.page.locator('body').innerText();
  assert(body.includes('王小明'), 'B 在該活動底下看得到 A 收的紀錄——跨平板互看成立');
  await B.page.screenshot({ path: path.join(SHOT, '02_b_sees_record.png'), fullPage: true });

  // ---- 3. …but B may not touch the field definitions ----
  await B.page.getByRole('button', { name: '客戶資料欄位' }).click();
  await B.page.waitForTimeout(400);
  body = await B.page.locator('body').innerText();
  assert(body.includes('攤位編號'), 'B 也收到了 A 的自訂欄位');
  assert((await B.page.locator('[data-fields-readonly]').count()) === 1, 'B 看到唯讀說明');
  assert(body.includes('平板 A'), '說明指出是由哪一台管理：' + (body.match(/由「[^」]*」管理/) || ['(找不到)'])[0]);
  assert((await B.page.locator('[data-add-field]').count()) === 0, 'B 沒有「新增欄位」');
  assert((await B.page.locator('[data-drag-handle]').count()) === 0, 'B 沒有拖曳把手');
  const bRowButtons = await B.page.locator('[data-field-row] button').count();
  assert(bRowButtons === 0, `B 的欄位列沒有編輯／刪除鈕（實際 ${bRowButtons}）`);
  await B.page.screenshot({ path: path.join(SHOT, '03_b_readonly.png'), fullPage: true });

  // A, being the owner, still can. (A is on the event list at this point, so
  // it has to walk back into the event before the admin panel means anything.)
  await enterNamed(A.page);
  await H.openAdmin(A.page, '客戶資料欄位');
  assert((await A.page.locator('[data-add-field]').count()) === 1, '擁有者 A 仍可編輯欄位');
  assert((await A.page.locator('[data-fields-readonly]').count()) === 0, 'A 沒有唯讀提示');

  // ---- 4. the server refuses definitions from a non-owner ----
  // Checked at the endpoint rather than through the UI: the UI already hides the
  // controls, so this is the guard behind them.
  //
  // Deliberately on a throwaway event of its own, not on 2026 秋季展. Pushing a
  // forgery at the shared event would leave the server's copy stamped by this
  // test rather than by the tablets, and every later assertion here is about
  // what the tablets do to that row — the probe would be sitting in its own
  // experiment. It is tombstoned at the end so it never reaches the UI.
  const postEvents = (deviceId, events) => fetch(sync.base + '/events', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, events }),
  }).then(r => r.json());

  const decoy = {
    id: 'forgery-probe-event', name: '偽造測試用活動',
    startDate: '2030-01-01', endDate: '2030-01-02', status: 'active',
    ownerDeviceId: 'owner-device-x', ownerDeviceName: '別台平板',
    createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
    staff: [], fieldDefs: { customerFields: [{ id: 'real', nameZh: '原始欄位' }] },
  };
  await postEvents('owner-device-x', [decoy]);
  const forgeRes = await postEvents('some-other-device', [{
    ...decoy, updatedAt: '2030-01-02T00:00:00.000Z',
    fieldDefs: { customerFields: [{ id: 'forged', nameZh: '偽造' }] },
  }]);
  assert(forgeRes.results[0].fieldDefsRejected === true,
    '伺服器明說欄位定義被退回，而不是整批失敗——同一批的其他變更仍應生效');
  let after = await (await fetch(sync.base.replace(/\/v1$/, '') + '/debug/all',
    { headers: { Authorization: 'Bearer test-token' } })).json();
  let probe = after.events.find(e => e.id === decoy.id);
  assert(JSON.stringify(probe.fieldDefs).includes('原始欄位')
    && !JSON.stringify(probe.fieldDefs).includes('偽造'),
    '非擁有者送來的欄位定義沒有換掉原本的');
  assert(probe.updatedAt === '2030-01-02T00:00:00.000Z',
    '活動本身仍然收下了（被退的只有欄位定義）');
  // And the shared event is untouched by any of this.
  after = await (await fetch(sync.base.replace(/\/v1$/, '') + '/debug/all',
    { headers: { Authorization: 'Bearer test-token' } })).json();
  assert(JSON.stringify(after.events.find(e => e.id === srvEvent.id).fieldDefs)
    .includes('攤位編號'), '2026 秋季展的欄位定義毫髮無傷');
  await postEvents('owner-device-x', [{ ...decoy,
    updatedAt: '2030-01-03T00:00:00.000Z', deletedAt: '2030-01-03T00:00:00.000Z' }]);

  // ---- 5. B takes over, and A stands down ----
  // Park A back on the event list so its later sync is a clean pull.
  await A.page.getByRole('button', { name: '← 返回表單' }).click();
  await A.page.waitForTimeout(400);
  await A.page.getByRole('button', { name: '← 活動列表' }).click();
  await A.page.waitForTimeout(600);

  await B.page.getByRole('button', { name: '← 返回表單' }).click();
  await B.page.waitForTimeout(400);
  await B.page.getByRole('button', { name: '← 活動列表' }).click();
  await B.page.waitForTimeout(600);
  await H.unlockManage(B.page);
  assert((await B.page.locator('[data-ev-takeover]').count()) === 1, 'B 看得到「接管欄位設定」');
  await B.page.locator('[data-ev-takeover]').click();
  await B.page.waitForTimeout(400);
  body = await B.page.locator('body').innerText();
  assert(body.includes('平板 A'), '接管確認訊息指出原擁有者');
  assert(!body.includes('第 2 次確認'), '接管是可復原的動作，只需一層確認');
  await B.page.locator('div[style*="position: fixed"]').getByRole('button', { name: '接管' }).click();
  await B.page.waitForTimeout(700);
  await syncAndWait(B.page);

  await syncAndWait(A.page);
  await enterNamed(A.page);
  await H.openAdmin(A.page, '客戶資料欄位');
  assert((await A.page.locator('[data-fields-readonly]').count()) === 1,
    'A 同步之後變成唯讀——接管已傳播');
  assert((await A.page.locator('[data-add-field]').count()) === 0, 'A 不再能新增欄位');

  // ---- 6. the new owner's definitions win ----
  // B unlocked manage mode to take over, and v3.11 cards are inert there.
  await H.lockManage(B.page);
  await enterNamed(B.page);
  await H.openAdmin(B.page, '客戶資料欄位');
  await B.page.locator('[data-add-field]').click();
  await B.page.waitForTimeout(400);
  await B.page.locator('input[placeholder="例如 Country"]').fill('Lead Source');
  await B.page.locator('input[placeholder="例如 國家"]').fill('來源管道');
  await B.page.getByRole('button', { name: '儲存欄位' }).click();
  await B.page.waitForTimeout(600);
  await B.page.getByRole('button', { name: '← 返回表單' }).click();
  await B.page.waitForTimeout(400);
  await B.page.getByRole('button', { name: '← 活動列表' }).click();
  await B.page.waitForTimeout(600);
  await syncAndWait(B.page);

  await A.page.getByRole('button', { name: '← 返回表單' }).click();
  await A.page.waitForTimeout(400);
  await A.page.getByRole('button', { name: '← 活動列表' }).click();
  await A.page.waitForTimeout(600);
  await syncAndWait(A.page);
  const aDefs = await A.page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('ExhibitionFormDB');
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction(['events', 'fieldDefinitions'], 'readonly');
      const ge = tx.objectStore('events').getAll();
      ge.onsuccess = () => {
        const ev = ge.result.find(e => e.name === '2026 秋季展');
        const gd = tx.objectStore('fieldDefinitions').get(ev.id + '::customerFields');
        gd.onsuccess = () => { db.close(); res(gd.result.value.map(f => f.nameZh)); };
      };
    };
  }));
  assert(aDefs.includes('來源管道'),
    'A 收到新擁有者加的欄位：' + aDefs.join('、'));

  // ---- 7. deleting the event propagates, and stays deleted ----
  await H.unlockManage(B.page);
  await B.page.locator('[data-event-card]', { hasText: '2026 秋季展' })
    .locator('[data-ev-delete]').click();
  await B.page.waitForTimeout(400);
  await B.page.locator('input[placeholder="請輸入 DELETE"]').fill('DELETE');
  await B.page.getByRole('button', { name: '繼續' }).click();
  await B.page.waitForTimeout(300);
  await B.page.getByRole('button', { name: '確定刪除' }).click();
  await B.page.waitForTimeout(800);
  await syncAndWait(B.page);

  await syncAndWait(A.page);
  await A.page.reload();
  await A.page.waitForTimeout(1600);
  assert(!(await A.page.locator('body').innerText()).includes('2026 秋季展'),
    'A 同步後該活動消失');
  // The tombstone is what stops the next pull from resurrecting it.
  st = await syncAndWait(A.page);
  await A.page.reload();
  await A.page.waitForTimeout(1600);
  assert(!(await A.page.locator('body').innerText()).includes('2026 秋季展'),
    '再同步一次也沒有長回來（墓碑生效）');

  assert(errors.length === 0, '無 console error：' + errors.join(' | '));
  await A.ctx.close(); await B.ctx.close();
  await browser.close();
  app.close();
  await new Promise(r => sync.close(r));
  fs.rmSync(sync.dataDir, { recursive: true, force: true });
  console.log(fails ? `\nEVENT SYNC FAILED (${fails})` : '\nEVENT SYNC PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
