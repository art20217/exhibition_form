// v3.4 multi-event shell: the event list, the per-event fill-in gate, and the
// isolation between one event's fields/records and another's.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-events');
fs.mkdirSync(SHOT, { recursive: true });
const BASE = 'http://localhost:8952';

(async () => {
  const server = await H.serve(8952);
  const browser = await H.launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  await page.goto(BASE + '/seed');
  await H.wipeDB(page);
  await page.goto(BASE + '/');
  await page.waitForTimeout(1600);

  // ---- 1. a fresh install still lands on a usable event ----
  assert((await page.locator('[data-event-card]').count()) === 1, '全新安裝自動建立一個活動（不會被 PIN 鎖在門外）');
  const seededStaff = (await H.readAll(page, 'events'))[0].staff;
  assert(JSON.stringify(seededStaff) === JSON.stringify(
    [{ en: 'Charlene', zh: '蘇秋菊' }, { en: 'Will', zh: '黃柏儒' },
     { en: 'Steve', zh: '陳誌翔' }, { en: 'Nadia', zh: '鄭淑卿' },
     { en: 'Eric', zh: '顏耀中' }, { en: 'Alen', zh: '黃世仰' },
     { en: 'Wing', zh: '張詩穎' }, { en: 'Rick', zh: '張瑞育' }]),
    '全新安裝的預設名冊為實際團隊 8 人：' + JSON.stringify(seededStaff.map(s => s.zh)));

  // ---- 2. management controls are PIN-gated ----
  assert((await page.locator('[data-add-event]').count()) === 0, '未解鎖時沒有「＋ 新增活動」');
  assert(!(await page.getByRole('button', { name: '刪除' }).first().isVisible().catch(() => false)),
    '未解鎖時卡片沒有刪除鈕');
  await H.unlockManage(page);
  await page.screenshot({ path: path.join(SHOT, '01_manage.png'), fullPage: true });
  assert((await page.locator('[data-add-event]').count()) === 1, '輸入 PIN 後出現「＋ 新增活動」');
  assert(await page.getByRole('button', { name: '結束活動' }).first().isVisible(), '解鎖後出現「結束活動」');

  // ---- 3. rename the seeded event and give it a two-day range + 2 staff ----
  await page.getByRole('button', { name: '編輯' }).first().click();
  await page.waitForTimeout(400);
  await page.locator('input[placeholder="例如 2026 美國展"]').fill('2026 美國展');
  const dateInputs = page.locator('input[type="date"]');
  await dateInputs.nth(0).fill('2026-08-05');
  await dateInputs.nth(1).fill('2026-08-06');
  // The default roster is two names. Add a third here and drop it again below,
  // so the card's count is exercised in both directions and two names are left
  // for the multi-select gate further down.
  await page.getByRole('button', { name: '＋ 新增人員' }).click();
  await page.waitForTimeout(150);
  const addedRow = page.locator('[data-staff-row]').last();
  await addedRow.locator('input').nth(0).fill('Lin Ta-Wei');
  await addedRow.locator('input').nth(1).fill('林大維');
  await page.getByRole('button', { name: '儲存活動' }).click();
  await page.waitForTimeout(600);
  const listText = await page.locator('body').innerText();
  assert(listText.includes('2026 美國展') && listText.includes('2026-08-05 → 2026-08-06'),
    '活動改名與日期區間已生效：' + listText.split('\n').slice(0, 8).join(' | '));
  assert(listText.includes('9 位接待人員'), '新增人員後卡片數字同步（8 + 1）');

  await page.getByRole('button', { name: '編輯' }).first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-staff-row]').last().locator('button').click();
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: '儲存活動' }).click();
  await page.waitForTimeout(600);
  assert((await page.locator('body').innerText()).includes('8 位接待人員'), '接待人員刪減後卡片數字同步（回到 8）');

  // ---- 4. the fill-in gate ----
  await page.locator('[data-event-card] button').first().click();
  await page.waitForTimeout(600);
  const entryDisabled = () => page.evaluate(() => ({
    cust: document.querySelector('[data-entry-customer]').disabled,
    needs: document.querySelector('[data-entry-needs]').disabled,
    hint: document.querySelector('[data-entry-hint]')?.innerText.trim() || '',
  }));
  // Today only pre-selects a date when it falls inside the event's range, which
  // depends on the day the suite happens to run. Normalize to an empty
  // selection either way before testing the gate.
  const clearSession = async () => {
    await page.locator('[data-staff-picker] button').first().click();
    await page.waitForTimeout(250);
    const reset = page.getByRole('button', { name: '重新選擇' });
    if (await reset.count()) { await reset.click(); }
    else { await page.locator('[data-staff-picker] button').first().click(); }  // untoggle
    await page.waitForTimeout(300);
  };
  await clearSession();
  let g = await entryDisabled();
  assert(g.cust && g.needs && g.hint.includes('請先選擇'), '未選人員與日期時兩個入口停用');

  await page.locator('[data-staff-picker] button').first().click();
  await page.waitForTimeout(250);
  g = await entryDisabled();
  assert(g.cust && g.needs, '只選了人員、還沒選日期時仍停用');

  await page.locator('[data-date-picker] button').nth(1).click();   // 08/06
  await page.waitForTimeout(250);
  g = await entryDisabled();
  assert(!g.cust && !g.needs && g.hint === '', '人員與日期都選好後兩個入口才開放');

  // …and the reverse order: date without a name is equally blocked.
  await page.getByRole('button', { name: '重新選擇' }).click();
  await page.waitForTimeout(250);
  await page.locator('[data-date-picker] button').nth(1).click();
  await page.waitForTimeout(250);
  await page.waitForTimeout(250);
  g = await entryDisabled();
  assert(g.cust && g.needs, '只選了日期、還沒選人員時仍停用');
  await page.locator('[data-staff-picker] button').first().click();
  await page.waitForTimeout(250);

  // ---- 5. multi-select: add a second name, then run the flow ----
  await page.locator('[data-staff-picker] button').nth(1).click();
  await page.waitForTimeout(250);
  const banner = await page.locator('[data-session-banner]').innerText();
  assert(banner.includes('填單人員') && banner.includes('、') && banner.includes('2026-08-06'),
    '橫幅顯示複選的兩位人員與日期：' + banner.replace(/\n/g, ' '));
  await page.screenshot({ path: path.join(SHOT, '02_gate_open.png'), fullPage: true });

  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(600);
  await H.runFlow(page, { name: '王小明', company: '宏昌實業' });
  const handoffText = await page.locator('body').innerText();
  assert(handoffText.includes('完成，返回') && !handoffText.includes('Staff 工作人員'),
    '業務備註欄位已全數由活動供應，交接畫面只剩「完成，返回」');

  let recs = await H.readAll(page, 'records');
  assert(recs.length === 1, '產生一筆紀錄');
  const r0 = recs[0];
  assert(Array.isArray(r0.staffFields.greeter) && r0.staffFields.greeter.length === 2,
    '接待人員以陣列存入兩位：' + JSON.stringify(r0.staffFields.greeter));
  assert(r0.staffFields.visit_date === '2026-08-06', '填單日期帶入紀錄：' + r0.staffFields.visit_date);
  assert(!!r0.eventId, '紀錄帶有 eventId');

  // ---- 6. the selection survives the round trip ----
  await page.getByRole('button', { name: /完成，返回/ }).click();
  await page.waitForTimeout(600);
  const banner2 = await page.locator('[data-session-banner]').innerText();
  assert(banner2.includes('2026-08-06') && banner2.includes('、'), '填完回到活動頁，人員與日期仍保留');
  g = await entryDisabled();
  assert(!g.cust, '保留的選擇讓入口維持開放，下一位客戶可直接開始');
  await page.getByRole('button', { name: '重新選擇' }).click();
  await page.waitForTimeout(300);
  g = await entryDisabled();
  assert(g.cust && g.needs, '「重新選擇」清空後入口重新停用');

  // ---- 7. the back office is scoped to this event ----
  await H.openAdmin(page, '資料紀錄');
  const adminText = await page.locator('body').innerText();
  assert(adminText.includes('2026 美國展'), '後台表頭顯示目前活動名稱');
  assert(adminText.includes('資料紀錄（1 筆）'), '資料紀錄顯示本活動 1 筆');
  const row = await page.locator('[data-records-table] tbody tr').first().innerText();
  assert(row.includes('王小明') && row.includes(','), '接待人員欄顯示複選的兩位：' + row.replace(/\n/g, ' | '));

  // v3.5: reception is configured on the event, so the 業務備註欄位 tab is gone.
  const tabLabels = await page.locator('[data-admin-tabs] button').allInnerTexts();
  assert(JSON.stringify(tabLabels.map(t => t.trim())) === JSON.stringify(
    ['客戶資料欄位', '客戶需求欄位', '公司背景欄位', '資料紀錄', '系統設定']),
    '後台恰為五個頁籤，不再有「業務備註欄位」：' + tabLabels.join(' | '));
  await page.screenshot({ path: path.join(SHOT, '03_tabs.png'), fullPage: true });

  // ---- 8. a second event copied from the first, then proven independent ----
  await page.getByRole('button', { name: '← 返回表單' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '← 活動列表' }).click();
  await page.waitForTimeout(500);
  await H.unlockManage(page);
  await page.locator('[data-add-event]').click();
  await page.waitForTimeout(400);
  await page.locator('input[placeholder="例如 2026 美國展"]').fill('2027 德國展');
  const d2 = page.locator('input[type="date"]');
  await d2.nth(0).fill('2027-03-01');
  await d2.nth(1).fill('2027-03-02');
  await page.locator('select').last().selectOption({ label: '複製自：2026 美國展' });
  await page.getByRole('button', { name: '儲存活動' }).click();
  await page.waitForTimeout(700);
  assert((await page.locator('[data-event-card]').count()) === 2, '第二個活動已建立');

  const defsFor = async (name) => page.evaluate((n) => new Promise((res) => {
    const r = indexedDB.open('ExhibitionFormDB');
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction(['events', 'fieldDefinitions'], 'readonly');
      const ge = tx.objectStore('events').getAll();
      ge.onsuccess = () => {
        const ev = ge.result.find(e => e.name === n);
        const gd = tx.objectStore('fieldDefinitions').get(ev.id + '::customerFields');
        gd.onsuccess = () => { db.close(); res({ id: ev.id, fields: gd.result.value.map(f => f.nameZh) }); };
      };
    };
  }), name);
  const a = await defsFor('2026 美國展'), b = await defsFor('2027 德國展');
  assert(JSON.stringify(a.fields) === JSON.stringify(b.fields), '複製而來的欄位與來源一致');

  // Rename a field in the new event and prove the source event is untouched.
  await page.locator('[data-event-card]', { hasText: '2027 德國展' }).locator('button').first().click();
  await page.waitForTimeout(600);
  await H.openAdmin(page, '客戶資料欄位');
  await page.locator('[data-field-row]', { hasText: '姓名' }).getByRole('button').first().click();
  await page.waitForTimeout(400);
  await page.locator('input[placeholder="例如 國家"]').fill('德文姓名');
  await page.getByRole('button', { name: '儲存欄位' }).click();
  await page.waitForTimeout(600);
  const a2 = await defsFor('2026 美國展'), b2 = await defsFor('2027 德國展');
  assert(b2.fields.includes('德文姓名') && !a2.fields.includes('德文姓名'),
    '改 B 活動的欄位不影響 A 活動：A=' + a2.fields.slice(0,2) + ' B=' + b2.fields.slice(0,2));

  // ---- 9. records stay in their own event ----
  await page.getByRole('button', { name: '← 返回表單' }).click();
  await page.waitForTimeout(500);
  await page.locator('[data-staff-picker] button').first().click();
  await page.locator('[data-date-picker] button').first().click();
  await page.waitForTimeout(300);
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(600);
  await H.runFlow(page, { name: 'Hans Müller', company: 'Bayer GmbH' });
  await page.getByRole('button', { name: /完成，返回/ }).click();
  await page.waitForTimeout(500);
  await H.openAdmin(page, '資料紀錄');
  const bText = await page.locator('body').innerText();
  assert(bText.includes('資料紀錄（1 筆）') && bText.includes('Hans Müller') && !bText.includes('王小明'),
    'B 活動的後台只看到自己的紀錄');

  // ---- 10. export is scoped to the open event ----
  // Headless Chromium reports blob downloads as "download" regardless of the
  // anchor's `download` attribute, so read the attribute the app actually set.
  await page.evaluate(() => {
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.__dl = this.download; return orig.call(this); };
  });
  const dl = page.waitForEvent('download', { timeout: 15000 });
  await page.getByRole('button', { name: '匯出資料' }).click();
  const zipPath = path.join(SHOT, 'export_b.zip');
  await (await dl).saveAs(zipPath);
  const dlName = await page.evaluate(() => window.__dl);
  assert(/^export_2027_德國展_\d{8}_\d{6}\.zip$/.test(dlName), '匯出檔名帶活動名稱：' + dlName);
  const buf = fs.readFileSync(zipPath);
  const has = (s) => buf.includes(Buffer.from(s, 'utf8'));
  assert(has('Hans Müller') && !has('王小明'), '匯出只含本活動的紀錄');
  assert(has('2027 德國展'), '匯出多了 Event 欄，帶出活動名稱');

  // ---- 11. ending an event closes the forms but not the back office ----
  await page.getByRole('button', { name: '← 返回表單' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '← 活動列表' }).click();
  await page.waitForTimeout(500);
  await H.unlockManage(page);
  await page.locator('[data-event-card]', { hasText: '2027 德國展' })
    .getByRole('button', { name: '結束活動' }).click();
  await page.waitForTimeout(300);
  assert(!(await page.getByText('第 2 次確認').isVisible().catch(() => false)),
    '結束活動是可復原的動作，只需一層確認');
  await page.locator('div[style*="position: fixed"]').getByRole('button', { name: '結束活動' }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOT, '04_ended.png'), fullPage: true });
  const afterEnd = await page.locator('body').innerText();
  assert(afterEnd.includes('已結束'), '活動移到「已結束」區');

  await page.locator('[data-event-card]', { hasText: '2027 德國展' }).locator('button').first().click();
  await page.waitForTimeout(600);
  await page.locator('[data-staff-picker] button').first().click();
  await page.locator('[data-date-picker] button').first().click();
  await page.waitForTimeout(300);
  g = await entryDisabled();
  assert(g.cust && g.needs && g.hint.includes('已結束'),
    '已結束的活動即使選了人員與日期也無法進入表單：' + g.hint);
  await H.openAdmin(page, '資料紀錄');
  assert((await page.locator('body').innerText()).includes('Hans Müller'), '已結束的活動仍可查看資料');

  // ---- 12. deleting an event takes its records and definitions with it ----
  await page.getByRole('button', { name: '← 返回表單' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '← 活動列表' }).click();
  await page.waitForTimeout(500);
  await H.unlockManage(page);
  await page.locator('[data-event-card]', { hasText: '2027 德國展' })
    .getByRole('button', { name: '刪除' }).click();
  await page.waitForTimeout(300);
  assert(await page.getByText('刪除這個活動？').isVisible(), '刪除活動先跳第 1 層確認');
  await page.locator('input[placeholder="請輸入 DELETE"]').fill('DELETE');
  await page.getByRole('button', { name: '繼續' }).click();
  await page.waitForTimeout(300);
  assert(await page.getByText('第 2 次確認').isVisible(), '刪除活動需要第 2 層確認');
  await page.getByRole('button', { name: '確定刪除' }).click();
  await page.waitForTimeout(800);
  assert((await page.locator('[data-event-card]').count()) === 1, '活動已刪除，只剩一個');
  const leftRecs = await H.readAll(page, 'records');
  assert(leftRecs.length === 1 && leftRecs[0].customerFields.name === '王小明',
    '被刪活動的紀錄一併消失，其他活動的紀錄完好：' + leftRecs.map(r => r.customerFields.name));
  const leftDefs = await H.readAll(page, 'fieldDefinitions');
  assert(leftDefs.length === 4 && !leftDefs.some(d => d.key.startsWith(b.id)),
    '被刪活動的欄位定義一併消失：' + leftDefs.map(d => d.key.split('::')[1]).join(','));

  if (errors.length) { console.error('CONSOLE ERRORS:'); errors.forEach(e => console.error('  ' + e)); fails++; }
  else console.log('ok: 無 console error');

  await browser.close(); server.close();
  console.log(fails ? `EVENTS FAILED (${fails})` : 'EVENTS PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
