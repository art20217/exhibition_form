// The admin Records list shows only 時間／姓名／公司／接待人員 (plus # and 操作),
// while the export still carries every field.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-records');
fs.mkdirSync(SHOT, { recursive: true });


(async () => {
  const server = await H.serve(8947);
  const browser = await H.launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  // Seed two records with data spread across every group.
  await page.goto('http://localhost:8947/seed');
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
      const tx = db.transaction(['records'], 'readwrite');
      tx.objectStore('records').put({
        id: 'r1', timestamp: '2026-08-05T09:00:00.000Z', device: 'Tablet-ALPHA',
        customerFields: { name: '王小明', company: '宏昌實業', email: 'a@b.com', nationality: 'Germany', language: 'English' },
        needsFields: { inquiry_type: ['Request Quote'], product_interest: ['EVA Single Color'], potential: 'A', notes: '後續報價' },
        companyFields: { machines_used: ['Tien Kang'], industry: 'Footwear', revenue: 'US$10,000,000 以上' },
        staffFields: { greeter: 'Su Chiu-Chu', visit_date: '2026-08-05' },
        gdprConsent: true, cardPhoto: null,
      });
      tx.objectStore('records').put({
        id: 'r2', timestamp: '2026-08-06T09:00:00.000Z', device: 'Tablet-BETA',
        customerFields: { name: '李大華', company: '永盛國際貿易股份有限公司台中分公司營業處' },
        needsFields: {}, companyFields: {},
        staffFields: { greeter: '__other__', greeter__otherText: '臨時支援小陳' },
        gdprConsent: true, cardPhoto: null,
      });
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
  })));

  const openRecords = async () => {
    await page.goto('http://localhost:8947/');
    await page.waitForTimeout(1400);
    await H.enterEvent(page);
    await page.locator('button:has(svg circle)').first().click();
    await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('0000');
    await page.getByRole('button', { name: '登入' }).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: '資料紀錄' }).click();
    await page.waitForTimeout(600);
  };
  await openRecords();
  await page.screenshot({ path: path.join(SHOT, '01_records.png'), fullPage: true });

  // ---- 1. headers are exactly the agreed set ----
  const headers = (await page.locator('[data-records-table] th').allInnerTexts()).map(t => t.trim());
  assert(JSON.stringify(headers) === JSON.stringify(['#', '時間', '姓名', '公司', '接待人員', '操作']),
    '表頭恰為 #／時間／姓名／公司／接待人員／操作：' + headers.join(' | '));

  const tableText = await page.locator('[data-records-table]').innerText();
  for (const gone of ['訪客國籍', '感興趣產品', '使用機器', '成交機率', '洽談事由', '行業別', '營業額', '訪談日期', 'Tablet-ALPHA', 'Germany']) {
    assert(!tableText.includes(gone), `列表不再出現「${gone}」`);
  }

  // ---- 2. values are right, including the "Other" free text ----
  const rows = await page.locator('[data-records-table] tbody tr').evaluateAll(trs =>
    trs.map(tr => [...tr.querySelectorAll('td')].slice(0, 5).map(td => td.innerText.trim())));
  const byName = Object.fromEntries(rows.map(r => [r[2], r]));
  assert(byName['王小明'] && byName['王小明'][3] === '宏昌實業' && byName['王小明'][4] === 'Su Chiu-Chu',
    '王小明列的公司與接待人員正確：' + JSON.stringify(byName['王小明']));
  assert(byName['李大華'] && byName['李大華'][4] === 'Other: 臨時支援小陳',
    '接待人員選「其他」時顯示自訂姓名：' + JSON.stringify(byName['李大華']));

  // ---- 3. export still carries every field (ZIP is written STORE/uncompressed) ----
  const dl = page.waitForEvent('download', { timeout: 15000 });
  await page.getByRole('button', { name: '匯出資料' }).click();
  const zipPath = path.join(__dirname, 'export_cols.zip');
  await (await dl).saveAs(zipPath);
  const buf = fs.readFileSync(zipPath).toString('latin1');
  for (const col of ['Product of Interest', 'Nationality', 'Machines Used', 'Deal Probability', 'Device']) {
    assert(buf.includes(col), `匯出檔仍包含「${col}」欄`);
  }
  assert(buf.includes('Germany'), '匯出檔仍包含列表未顯示的欄位值');

  // ---- 4. heading follows an admin rename ----
  await page.getByRole('button', { name: '客戶資料欄位' }).click();
  await page.waitForTimeout(400);
  await page.locator('[data-field-row]', { hasText: '姓名' }).getByRole('button').first().click();
  await page.waitForTimeout(400);
  await page.locator('input[placeholder="例如 國家"]').fill('客戶姓名');
  await page.getByRole('button', { name: '儲存欄位' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '資料紀錄' }).click();
  await page.waitForTimeout(500);
  const renamed = (await page.locator('[data-records-table] th').allInnerTexts()).map(t => t.trim());
  assert(renamed[2] === '客戶姓名', '表頭跟隨後台改名：' + renamed.join(' | '));

  // ---- 4b. column widths are governed, not content-driven ----
  const colProbe = () => page.evaluate(() => {
    const table = document.querySelector('[data-records-table] table');
    const wrap = document.querySelector('[data-records-table]');
    const ths = [...table.querySelectorAll('th')];
    const timeCell = table.querySelector('tbody tr td:nth-child(2)');
    const longCell = [...table.querySelectorAll('tbody td')].find(td => td.innerText.includes('永盛國際貿易'));
    const cs = timeCell ? getComputedStyle(timeCell) : null;
    return {
      widths: ths.map(th => Math.round(th.getBoundingClientRect().width)),
      labels: ths.map(th => th.innerText.trim()),
      tableW: Math.round(table.getBoundingClientRect().width),
      wrapW: wrap.clientWidth,
      timeNoWrap: cs ? cs.whiteSpace === 'nowrap' : null,
      timeClipped: timeCell ? timeCell.scrollWidth > timeCell.clientWidth + 1 : null,
      longClipped: longCell ? longCell.scrollWidth > longCell.clientWidth + 1 : null,
      longText: longCell ? longCell.innerText.trim() : null,
      docOverflow: document.body.scrollWidth > window.innerWidth + 1,
    };
  });

  for (const w of [1280, 1024, 834]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(350);
    const p = await colProbe();
    assert(p.widths[0] === 56, `${w}px：# 欄固定 56px（實測 ${p.widths[0]}）`);
    assert(p.widths[p.widths.length - 1] === 132, `${w}px：操作欄固定 132px（實測 ${p.widths[p.widths.length - 1]}）`);
    const fieldCols = p.widths.slice(2, -1);
    assert(Math.max(...fieldCols) - Math.min(...fieldCols) <= 1,
      `${w}px：欄位欄彼此等寬（${fieldCols.join(' / ')}）`);
    assert(Math.abs(p.tableW - p.wrapW) <= 1, `${w}px：表格寬度等於容器`);
    assert(!p.docOverflow, `${w}px：無水平捲動`);
    assert(p.timeNoWrap === true && p.timeClipped === false,
      `${w}px：時間欄不折行且未溢出（nowrap=${p.timeNoWrap}, clipped=${p.timeClipped}）`);
    assert(p.longClipped === false && p.longText.includes('營業處'),
      `${w}px：超長公司名折行完整顯示、未被裁切`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOT, '03_widths.png'), fullPage: true });

  // ---- 5. mobile card summary carries the same three fields ----
  await page.setViewportSize({ width: 390, height: 850 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOT, '02_cards_390.png'), fullPage: true });
  const summary = await page.locator('[data-records-cards]').first().innerText();
  assert(summary.includes('客戶姓名：王小明') && summary.includes('公司：宏昌實業') && summary.includes('接待人員：'),
    '手機卡片摘要含三個欄位');
  for (const gone of ['訪客國籍', '感興趣產品', '使用機器']) {
    assert(!summary.includes(gone), `手機卡片不再出現「${gone}」`);
  }

  // ---- 4c. a missing field drops its column and the rest re-divide ----
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);
  const custDefs = await H.readDefs(page, 'customerFields');
  await H.writeDefs(page, 'customerFields', custDefs.filter(f => f.id !== 'company'));
  await openRecords();
  const after = await colProbe();
  assert(!after.labels.includes('公司'), '欄位定義缺少「公司」時該欄消失：' + after.labels.join(' | '));
  assert(after.widths[0] === 56 && after.widths[after.widths.length - 1] === 132,
    '欄位減少後 # 與操作仍維持固定寬');
  const rest = after.widths.slice(2, -1);
  assert(rest.length === 2 && Math.max(...rest) - Math.min(...rest) <= 1,
    '剩下的欄位欄自動重新等分：' + rest.join(' / '));

  if (errors.length) { console.error('CONSOLE ERRORS:'); errors.forEach(e => console.error('  ' + e)); fails++; }
  else console.log('ok: 無 console error');

  await browser.close(); server.close();
  console.log(fails ? `RECORDS COLUMNS FAILED (${fails})` : 'RECORDS COLUMNS PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
