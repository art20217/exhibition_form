// Guards the template's binding surface.
//
// v3.16.5 split renderVals() (579 lines) into renderCtx() plus fifteen
// section methods, whose results are spread back into one flat object. That
// split has exactly one silent failure mode: a section stops returning a key.
// The template then binds `undefined` — no exception, no console error, just a
// button with no label or a list that never renders. Nothing else in the suite
// would catch it.
//
// So: walk every screen, snapshot the key set and each value's coarse type,
// and compare against the checked-in fixture. Adding a binding is fine and
// expected — update render-vals.json in the same commit, deliberately. Losing
// one is what this is here to stop.
//
// Types only, never values: values legitimately differ run to run (timestamps,
// generated ids), while a key flipping from 'function' to 'undefined' is
// always a bug.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const FIXTURE = path.join(__dirname, 'render-vals.json');

const shape = () => {
  const v = window.__app.renderVals() || {};
  const out = {};
  for (const k of Object.keys(v).sort()) {
    const x = v[k];
    out[k] = Array.isArray(x) ? 'array' : (x === null ? 'null' : typeof x);
  }
  return out;
};

(async () => {
  const server = await H.serve(8961);
  const base = 'http://localhost:8961';
  const browser = await H.launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  const snap = {};
  const grab = async (name) => {
    const cur = await page.evaluate(() => window.__app.state.screen);
    snap[name] = await page.evaluate(shape);
    return cur;
  };

  // ---- every screen the app can be on ----
  await page.goto(base + '/');
  await page.waitForTimeout(1500);
  await grab('events');

  await H.unlockManage(page);
  await page.waitForTimeout(300);
  await grab('events.manage');
  await H.openSettings(page);
  await grab('settings');

  await page.goto(base + '/');
  await page.waitForTimeout(1500);
  await page.locator('[data-ev-enter]').first().click();
  await page.waitForTimeout(500);
  await grab('eventHome');

  await page.locator('[data-staff-picker] button').nth(0).click();
  await page.waitForTimeout(150);
  const chips = page.locator('[data-date-picker] button');
  if (await chips.count()) await chips.first().click();
  else await page.locator('input[type="date"]').first().fill('2026-08-06');
  await page.waitForTimeout(150);
  await H.pickCustomerStatus(page, 'New');
  await grab('eventHome.ready');

  // The three-form flow. Picking the session leaves you on eventHome; the
  // entry point is a separate choice, which is what sets firstChoice.
  await page.getByRole('button', { name: /從客戶資料開始/ }).click();
  await page.waitForTimeout(500);
  await grab('customerForm');

  const fillIf = async (loc, v) => { if (await loc.count()) await loc.first().fill(v); };
  await fillIf(page.locator('input[placeholder^="Enter Name"]'), '繫結測試');
  await fillIf(page.locator('input[placeholder^="Enter Company"]'), '測試公司');
  await fillIf(page.locator('input[placeholder^="Enter Email"]'), 'a@b.com');
  await fillIf(page.locator('label', { hasText: 'Nationality' }).locator('xpath=..').locator('input'), 'TW');
  await page.locator('input[type="checkbox"]').last().check();

  const step = async (name, label) => {
    await page.getByRole('button', { name: label }).click();
    await page.waitForTimeout(500);
    const cur = await grab(name);
    assert(cur === name, `走到 ${name}（實際 ${cur}）`);
  };
  await step('companyForm', /Next 下一步/);
  await step('needsForm', /Next 下一步/);
  await step('handoff', /Finish 完成/);

  // Back office, every tab.
  await page.goto(base + '/');
  await page.waitForTimeout(1500);
  await H.enterEvent(page);
  await H.openAdmin(page);
  await page.waitForTimeout(300);
  await grab('admin.customer');
  for (const [tab, key] of [['客戶需求', 'needs'], ['公司背景', 'company'], ['資料紀錄', 'records']]) {
    const btn = page.getByRole('button', { name: tab });
    if (await btn.count()) { await btn.first().click(); await page.waitForTimeout(500); await grab('admin.' + key); }
  }

  // Record browser (PIN-gated from the event page).
  await page.goto(base + '/');
  await page.waitForTimeout(1500);
  await H.enterEvent(page);
  await page.waitForTimeout(200);
  await page.locator('[data-open-browse]').click();
  await page.waitForTimeout(300);
  await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('0000');
  await page.getByRole('button', { name: '登入' }).click();
  await page.waitForTimeout(500);
  await grab('browse');

  // Event editor modal — its bindings only take non-empty values while open.
  await page.goto(base + '/');
  await page.waitForTimeout(1500);
  await H.unlockManage(page);
  await page.waitForTimeout(300);
  const addEv = page.getByRole('button', { name: /新增活動/ });
  if (await addEv.count()) { await addEv.first().click(); await page.waitForTimeout(400); await grab('eventEditor'); }

  // ---- compare against the fixture ----
  if (process.env.UPDATE_RENDER_VALS) {
    fs.writeFileSync(FIXTURE, JSON.stringify(snap, null, 2) + '\n');
    console.log('已更新 ' + path.basename(FIXTURE));
  }
  const want = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

  assert(Object.keys(snap).sort().join() === Object.keys(want).sort().join(),
    `畫面清單一致（${Object.keys(snap).length} 個）`);

  let missing = 0, added = 0, retyped = 0;
  for (const screen of Object.keys(want)) {
    const a = snap[screen] || {};
    const b = want[screen];
    for (const k of Object.keys(b)) {
      if (!(k in a)) { console.error(`  ${screen}: 少了繫結 ${k}`); missing++; }
      else if (a[k] !== b[k]) { console.error(`  ${screen}: ${k} 型別 ${b[k]} → ${a[k]}`); retyped++; }
    }
    for (const k of Object.keys(a)) if (!(k in b)) { console.error(`  ${screen}: 多了繫結 ${k}`); added++; }
  }
  assert(missing === 0, '沒有繫結消失');
  assert(retyped === 0, '沒有繫結變更型別');
  // Additions are not a failure in themselves, but they must be deliberate:
  // re-run with UPDATE_RENDER_VALS=1 and commit the fixture alongside.
  assert(added === 0, '沒有未記錄的新繫結（新增請以 UPDATE_RENDER_VALS=1 更新 fixture）');

  // The runtime swallows a throwing renderVals() into renderErr rather than
  // letting it reach the console, so an exception would not show up above.
  const stuck = await page.evaluate(() => document.body.innerText.includes('renderVals()'));
  assert(!stuck, '沒有 renderVals() 執行錯誤');

  assert(errors.length === 0, 'console 無錯誤' + (errors.length ? '：' + errors[0] : ''));

  console.log(fails ? `\nRENDER-VALS FAILED (${fails})` : '\nRENDER-VALS PASSED');
  await browser.close();
  server.close();
  process.exit(fails ? 1 : 0);
})();
