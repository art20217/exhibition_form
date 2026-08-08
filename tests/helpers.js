// Shared navigation for the v3.4 multi-event shell. Every suite now has to walk
// 活動首頁 → 活動內頁 → pick staff + date before a form will open.
//
// This module is also the only place that knows where the app lives and how to
// start a browser, so the suites run unchanged both here and in CI.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-core');

// The app under test, resolved from this file rather than an absolute path.
const APP_HTML = path.join(__dirname, '..', 'index.html');

// CI installs Chromium into Playwright's own cache and lets it resolve the
// path; this container ships one at a fixed location instead. PW_CHROMIUM
// overrides both.
const PINNED = '/opt/pw-browsers/chromium';
function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  return fs.existsSync(PINNED) ? PINNED : undefined;
}

function launchBrowser(opts = {}) {
  return chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'], ...opts });
}

// Serves the app. `/seed` returns a blank page on the same origin, so a suite
// can open IndexedDB and plant fixtures before the app ever boots.
// Port 0 asks the OS for a free one — suites used to hardcode ports and had
// started colliding with each other.
function serve(port = 0) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url.startsWith('/seed')) { res.end('<!DOCTYPE html><title>seed</title>'); return; }
    fs.createReadStream(APP_HTML).pipe(res);
  });
  return new Promise(r => server.listen(port, () => {
    server.base = 'http://localhost:' + server.address().port;
    r(server);
  }));
}

const wipeDB = (page) => page.evaluate(() => new Promise((res, rej) => {
  const d = indexedDB.deleteDatabase('ExhibitionFormDB');
  d.onerror = () => rej(d.error); d.onsuccess = d.onblocked = () => res();
}));

// Opens the first event and selects the first staff member plus the first date,
// leaving the page on the event home with both form entries enabled.
async function enterEvent(page, { staffIndex = 0 } = {}) {
  await page.locator('[data-event-card] button').first().click();
  await page.waitForTimeout(500);
  await page.locator('[data-staff-picker] button').nth(staffIndex).click();
  await page.waitForTimeout(150);
  const chips = page.locator('[data-date-picker] button');
  if (await chips.count()) { await chips.first().click(); }
  else { await page.locator('input[type="date"]').first().fill('2026-08-06'); }
  await page.waitForTimeout(250);
}

// Loads the app fresh and walks straight into the first event.
async function gotoEvent(page, base, opts) {
  await page.goto(base + '/');
  await page.waitForTimeout(1500);
  await enterEvent(page, opts);
}

// Opens the back office of the event currently open.
async function openAdmin(page, tab) {
  await page.locator('button:has(svg circle)').first().click();
  await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('0000');
  await page.getByRole('button', { name: '登入' }).click();
  await page.waitForTimeout(400);
  if (tab) { await page.getByRole('button', { name: tab }).click(); await page.waitForTimeout(500); }
}

// Unlocks the event-list management controls (add / edit / end / delete).
async function unlockManage(page) {
  await page.locator('button:has(svg circle)').first().click();
  await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('0000');
  await page.getByRole('button', { name: '登入' }).click();
  await page.waitForTimeout(400);
}

// Fills the customer form and walks the rest of the three-form flow to handoff.
// Seeded databases may define fewer customer fields than the built-in default,
// so each one is filled only if the form actually renders it.
async function runFlow(page, { name, company = '測試公司', email = 'a@b.com' }) {
  const fillIf = async (loc, v) => { if (await loc.count()) await loc.first().fill(v); };
  await fillIf(page.locator('input[placeholder^="Enter Name"]'), name);
  await fillIf(page.locator('input[placeholder^="Enter Company"]'), company);
  await fillIf(page.locator('input[placeholder^="Enter Email"]'), email);
  await fillIf(page.locator('label', { hasText: 'Nationality' }).locator('xpath=..').locator('input'), 'TW');
  await page.locator('input[type="checkbox"]').last().check();
  await page.getByRole('button', { name: /Next 下一步/ }).click();   // -> company
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /Next 下一步/ }).click();   // -> needs
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /Finish 完成/ }).click();   // -> handoff
  await page.waitForTimeout(600);
}

const readAll = (page, store) => page.evaluate((s) => new Promise((res) => {
  const r = indexedDB.open('ExhibitionFormDB');
  r.onsuccess = () => {
    const db = r.result;
    const g = db.transaction(s, 'readonly').objectStore(s).getAll();
    g.onsuccess = () => { db.close(); res(g.result); };
  };
}), store);

// Field definitions live under `<eventId>::<group>` as of v3.4. These resolve
// the key for the (single) event a suite has seeded, so tests can keep talking
// in terms of group names.
const readDefs = (page, group) => page.evaluate((g) => new Promise((res) => {
  const r = indexedDB.open('ExhibitionFormDB');
  r.onsuccess = () => {
    const db = r.result;
    const tx = db.transaction(['events', 'fieldDefinitions'], 'readonly');
    const ge = tx.objectStore('events').getAll();
    ge.onsuccess = () => {
      const gd = tx.objectStore('fieldDefinitions').get(ge.result[0].id + '::' + g);
      gd.onsuccess = () => { db.close(); res(gd.result ? gd.result.value : null); };
    };
  };
}), group);

const writeDefs = (page, group, fields) => page.evaluate(([g, v]) => new Promise((res) => {
  const r = indexedDB.open('ExhibitionFormDB');
  r.onsuccess = () => {
    const db = r.result;
    const tx = db.transaction(['events', 'fieldDefinitions'], 'readwrite');
    const ge = tx.objectStore('events').getAll();
    ge.onsuccess = () => {
      const p = tx.objectStore('fieldDefinitions').put({ key: ge.result[0].id + '::' + g, value: v });
      p.onsuccess = () => { db.close(); res(); };
    };
  };
}), [group, fields]);

module.exports = { APP_HTML, launchBrowser, serve, wipeDB, enterEvent, gotoEvent, openAdmin,
  unlockManage, runFlow, readAll, readDefs, writeDefs };
