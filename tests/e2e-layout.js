// Option chips: English and 中文 on their own lines, and a grid that adapts its
// column count to the available width instead of a hard-coded chip width.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-layout');
fs.mkdirSync(SHOT, { recursive: true });


const HAN = /[㐀-鿿]/;

(async () => {
  const server = await H.serve(8943);
  const browser = await H.launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  // Seed one extra-short and one extra-long option to prove the rule generalises
  // beyond the options that happen to exist today.
  await page.goto('http://localhost:8943/seed');
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
      const tx = db.transaction(['fieldDefinitions', 'config'], 'readwrite');
      tx.objectStore('config').put({ key: 'migratedTo33', value: true });
      tx.objectStore('config').put({ key: 'migratedTo34', value: true });
      tx.objectStore('fieldDefinitions').put({ key: 'customerFields', value: [
        { id: 'name', nameEn: 'Name', nameZh: '姓名', type: 'text', required: true, isCore: true, order: 0, options: [] },
      ]});
      tx.objectStore('fieldDefinitions').put({ key: 'needsFields', value: [
        { id: 'probe', nameEn: 'Probe', nameZh: '測試欄位', type: 'checkbox-group', required: false, order: 0, options: [
          { en: 'A', zh: '甲' },
          { en: 'Athletic Shoes (Injection)', zh: '運動鞋(射出)' },
          { en: 'EVA', zh: 'EVA' },
          { en: 'Very Long Option Name That Should Take Its Own Entire Row Because It Cannot Fit',
            zh: '這是一個非常長的選項說明文字，長到必須自己獨佔一整列才有辦法閱讀，否則會被擠成細長條' },
        ]},
      ]});
      tx.objectStore('fieldDefinitions').put({ key: 'companyFields', value: [] });
      tx.objectStore('fieldDefinitions').put({ key: 'staffFields', value: [
        { id: 'greeter', nameEn: 'Greeter', nameZh: '接待人員', type: 'radio-group', required: false, isCore: true, order: 0, options: [] },
      ]});
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
  })));

  const gotoNeeds = async () => {
    await page.goto('http://localhost:8943/');
    await page.waitForTimeout(1200);
    await H.enterEvent(page);
    await page.locator('[data-entry-needs]').click();
    await page.waitForTimeout(500);
  };
  await gotoNeeds();

  // --- 1. two real lines, languages never mixed on one line ---
  // dc-runtime wraps every {{ }} in its own <span class="sc-interp">, so take the
  // stack container's direct children rather than a descendant selector.
  const lines = await page.locator('[data-cb-wrap] > label').evaluateAll(els => els.map(el => {
    const stack = el.querySelector(':scope > span');
    const spans = stack ? [...stack.children] : [];
    if (spans.length < 2) return null;
    const [a, b] = spans.map(s => s.getBoundingClientRect());
    return { en: spans[0].textContent, zh: spans[1].textContent, enBottom: a.bottom, zhTop: b.top };
  }));
  const stacked = lines.filter(Boolean);
  assert(stacked.length >= 3, `有多個雙語選項可檢查（${stacked.length}）`);
  assert(stacked.every(l => l.zhTop >= l.enBottom - 0.5), '中文行一律排在英文行下方，不會同行');
  assert(stacked.every(l => !HAN.test(l.en)), '英文行不含中文字');
  assert(stacked.every(l => HAN.test(l.zh)), '中文行確實是中文');
  await page.screenshot({ path: path.join(SHOT, '01_1280.png'), fullPage: true });

  // --- 2/3/4. responsive columns, equal widths, long option owns a row ---
  const probe = async () => page.locator('[data-cb-wrap]').first().evaluate(wrap => {
    const items = [...wrap.children].filter(el => el.tagName === 'LABEL');
    const rows = new Map();
    for (const el of items) {
      const r = el.getBoundingClientRect();
      const key = Math.round(r.top);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push({ text: el.innerText.replace(/\s+/g, ' ').trim(), w: Math.round(r.width) });
    }
    const wrapW = Math.round(wrap.getBoundingClientRect().width);
    return {
      wrapW,
      rows: [...rows.values()],
      cols: Math.max(...[...rows.values()].map(r => r.length)),
      overflow: document.body.scrollWidth > window.innerWidth + 1,
    };
  });

  const seen = [];
  for (const [w, h, name] of [[1280, 900, '1280'], [834, 1000, '834'], [390, 850, '390']]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(350);
    const r = await probe();
    seen.push({ w, cols: r.cols, wrapW: r.wrapW });
    await page.screenshot({ path: path.join(SHOT, `02_${name}.png`), fullPage: true });

    const multi = r.rows.filter(row => row.length > 1);
    assert(multi.every(row => new Set(row.map(c => c.w)).size === 1),
      `${w}px：同一列的選項卡等寬`);
    const longRow = r.rows.find(row => row.some(c => c.text.startsWith('Very Long Option')));
    assert(longRow && longRow.length === 1 && Math.abs(longRow[0].w - r.wrapW) <= 2,
      `${w}px：超長選項獨佔整列（寬度 ${longRow && longRow[0].w} / 容器 ${r.wrapW}）`);
    assert(!r.overflow, `${w}px：沒有水平捲動`);
  }
  // The form body is capped at max-width 640px, so 1280 and 834 legitimately
  // share a container width — what must track is columns vs *container* width.
  const desc = seen.map(x => `${x.w}px(容器${x.wrapW})→${x.cols}欄`).join('、');
  assert(seen.every((x, i) => i === 0 || (x.wrapW <= seen[i-1].wrapW && x.cols <= seen[i-1].cols)),
    `欄數隨容器寬度單調遞減：${desc}`);
  assert(seen[0].wrapW === seen[1].wrapW && seen[0].cols === seen[1].cols,
    '容器寬度相同時欄數一致（表單本文上限 640px）');
  assert(seen[2].wrapW < seen[0].wrapW && seen[2].cols < seen[0].cols,
    `容器變窄時欄數確實減少：${desc}`);
  // Column count is purely the grid's doing: floor((W + gap) / (minCol + gap)).
  assert(seen.every(x => x.cols === Math.max(1, Math.floor((x.wrapW + 10) / (200 + 10)))),
    `欄數符合 grid auto-fill 推算：${desc}`);
  assert(seen[2].cols === 1, '390px 時為單欄');

  // --- 5. short option is a normal cell, same width as its neighbours ---
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(350);
  const r = await probe();
  const shortCell = r.rows.flat().find(c => c.text === 'A 甲');
  const normalCell = r.rows.flat().find(c => c.text.startsWith('Athletic Shoes'));
  assert(shortCell && normalCell && shortCell.w === normalCell.w,
    `極短選項與一般選項等寬（${shortCell && shortCell.w} vs ${normalCell && normalCell.w}）`);

  // --- 6. group headings ---
  await page.goto('http://localhost:8943/seed');
  await page.evaluate(() => new Promise((res) => {
    const d = indexedDB.deleteDatabase('ExhibitionFormDB');
    d.onsuccess = d.onblocked = () => res();
  }));
  await gotoNeeds();
  const txt = await page.locator('body').innerText();
  assert(!/Series\s+系列/.test(txt), '不再出現「Series 系列」相鄰重複');
  assert(txt.includes('GENTREX SERIES') || txt.includes('Gentrex Series'), 'Gentrex Series 標題正常');
  assert(/RUBBER SERIES 橡膠系列|Rubber Series 橡膠系列/.test(txt), 'Rubber Series 橡膠系列 維持雙語');
  await page.screenshot({ path: path.join(SHOT, '03_groups.png'), fullPage: true });

  if (errors.length) { console.error('CONSOLE ERRORS:'); errors.forEach(e => console.error('  ' + e)); fails++; }
  else console.log('ok: 無 console error');

  await browser.close(); server.close();
  console.log(fails ? `LAYOUT FAILED (${fails})` : 'LAYOUT PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
