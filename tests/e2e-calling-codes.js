// v3.16: the phone country code is a searchable list of every E.164 code,
// not a hand-written 35.
//
// Issue #15 asked for exactly this, and for it to be done "比照辦理" with the
// v3.8 nationality combobox. The old list covered the markets the booth usually
// sees; a visitor from anywhere else had no right answer to pick, and the field
// silently recorded the wrong country's code.
//
// One deliberate difference from 國籍: this box does not accept free text. The
// value is prefixed onto the phone number itself, so "TW 0912…" would be
// indistinguishable from a real number for anyone reading the export later.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-calling-codes');
fs.mkdirSync(SHOT, { recursive: true });

(async () => {
  const app = await H.serve();
  const BASE = app.base;
  const browser = await H.launchBrowser();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  const ccInput = () => page.locator('[data-cc-input]');
  const ccOpts = () => page.locator('[data-cc-opt]');
  const search = async (q) => {
    await ccInput().click();
    await ccInput().fill(q);
    await page.waitForTimeout(300);
    return ccOpts().allInnerTexts();
  };

  // ---- 0. the inlined list still matches its generator ----
  // The list is generated and pasted in, so the only thing keeping the two in
  // step is this check. Without it the generator quietly becomes fiction.
  let genOk = true;
  try {
    execFileSync('node', [path.join(__dirname, '..', 'tools', 'make-calling-codes.js'), '--check'],
      { stdio: 'pipe' });
  } catch (e) { genOk = false; }
  assert(genOk, 'index.html 內嵌的 CALLING_CODES 與 tools/make-calling-codes.js 的輸出一致');

  await page.goto(BASE + '/seed');
  await H.wipeDB(page);
  await page.goto(BASE + '/');
  await page.waitForTimeout(1600);
  await H.enterEvent(page);
  await H.pickCustomerStatus(page);
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(600);

  // ---- 1. the list is complete, and the booth's markets lead it ----
  const list = await page.evaluate(() => window.__app.CALLING_CODES);
  assert(list.length > 200, `國碼清單是完整的 E.164（${list.length} 筆，舊版只有 35）`);
  assert(list[0].code === '+886' && list[0].iso === 'TW',
    '台灣排第一——展場在台灣，字母排序會把它埋在兩百筆之後');
  const isoSeen = new Set(list.map(c => c.iso));
  assert(isoSeen.size === list.length, '沒有重複的國家');
  for (const iso of ['DE', 'VN', 'AE', 'CI', 'NG', 'PE']) {
    assert(isoSeen.has(iso), `涵蓋 ${iso}`);
  }
  assert(list.every(c => /^\+\d+$/.test(c.code)), '每一筆都是合法的 +數字 國碼');
  assert(list.find(c => c.iso === 'DE').zh === '德國', '中文名稱來自 Intl.DisplayNames：德國');

  // ---- 2. it opens as a searchable list, not a 241-item scroll ----
  assert((await ccInput().inputValue()) === '+886 Taiwan 台灣',
    '收合時顯示國碼與中英名稱：' + await ccInput().inputValue());
  await ccInput().click();
  await page.waitForTimeout(300);
  assert((await page.locator('[data-cc-list]').count()) === 1, '點一下就展開清單');
  await page.screenshot({ path: path.join(SHOT, '01_open.png'), fullPage: true });

  // ---- 3. searchable three ways, like 國籍 ----
  let hits = await search('德國');
  assert(hits[0] === '+49 Germany 德國', '打中文找得到：' + hits[0]);
  hits = await search('Vietnam');
  assert(hits[0] === '+84 Vietnam 越南', '打英文找得到：' + hits[0]);
  hits = await search('49');
  assert(hits.some(h => h.startsWith('+49 ')), '打數字找得到：' + hits.slice(0, 3).join(' / '));
  hits = await search('+84');
  assert(hits[0] === '+84 Vietnam 越南', '帶加號也找得到：' + hits[0]);
  hits = await search('zzzz');
  assert(hits.length === 0 && (await page.locator('body').innerText()).includes('找不到相符的國碼'),
    '找不到時說清楚');

  // ---- 4. picking one commits it ----
  await search('德國');
  await ccOpts().first().click();
  await page.waitForTimeout(400);
  assert((await ccInput().inputValue()) === '+49 Germany 德國',
    '選了之後收合並顯示所選：' + await ccInput().inputValue());
  assert((await page.locator('[data-cc-list]').count()) === 0, '選完清單收起來');

  // ---- 5. gibberish reverts instead of poisoning the phone number ----
  await ccInput().click();
  await ccInput().fill('不是國碼');
  await page.locator('input[placeholder^="Enter Name"]').click();   // blur
  await page.waitForTimeout(400);
  assert((await ccInput().inputValue()) === '+49 Germany 德國',
    '輸入不存在的國碼會退回原值——這個值會接在電話號碼前面，亂填的字串事後分辨不出來：'
    + await ccInput().inputValue());

  // ---- 6. the chosen code really reaches the record ----
  await page.locator('input[type="tel"]').fill('30123456');
  await H.runFlow(page, { name: '施密特', company: '德國公司' });
  await page.getByRole('button', { name: /完成，返回|Done/ }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  const phone = await page.evaluate(() => {
    const r = window.__app.state.records[0];
    const f = window.__app.state.customerFields.find(x => x.type === 'tel');
    return r.customerFields[f.id];
  });
  assert(String(phone).startsWith('+49 '), '紀錄存的是選到的國碼：' + phone);

  // ---- 7. editing a record brings its own code back ----
  await H.openAdmin(page, '資料紀錄');
  await page.getByRole('button', { name: '編輯' }).first().click();
  await page.waitForTimeout(700);
  assert((await ccInput().inputValue()) === '+49 Germany 德國',
    '編輯既有紀錄時載回它自己的國碼：' + await ccInput().inputValue());
  await page.screenshot({ path: path.join(SHOT, '02_edit.png'), fullPage: true });

  assert(errors.length === 0, '無 console error：' + errors.join(' | '));
  await browser.close();
  app.close();
  console.log(fails ? `\nCALLING CODES FAILED (${fails})` : '\nCALLING CODES PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
