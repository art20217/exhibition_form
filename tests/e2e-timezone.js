// Date chips must name the event's own calendar days, in the tablet's own
// timezone.
//
// v3.10 and earlier built them with `new Date(str + 'T00:00:00').toISOString()`:
// parsed as local midnight, printed as UTC. East of UTC that rolls back a day,
// so an event starting 09/23 offered 09/22 as its first chip — and that value
// went straight into the record and the export.
//
// The whole suite missed it because CI runs in UTC, where the bug is invisible.
// Every context here therefore pins `timezoneId` explicitly; without that this
// file would pass on broken code.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-timezone');
fs.mkdirSync(SHOT, { recursive: true });

const START = '2026-09-23';
const DAYS = ['2026-09-23', '2026-09-24', '2026-09-25'];

// Pin the app's own default event to a fixed range through the editor, so the
// expected chips do not depend on the day the suite runs — and so the event
// keeps the full set of default field definitions a hand-seeded one would lack.
async function setEventRange(page) {
  await H.unlockManage(page);
  await page.locator('[data-ev-edit]').first().click();
  await page.waitForTimeout(400);
  const d = page.locator('input[type="date"]');
  await d.nth(0).fill(START);
  await d.nth(1).fill(DAYS[DAYS.length - 1]);
  await page.getByRole('button', { name: '儲存活動' }).click();
  await page.waitForTimeout(700);
  await H.lockManage(page);
}

(async () => {
  const server = await H.serve();
  const BASE = server.base;
  const browser = await H.launchBrowser();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  // Run the identical checks on both sides of UTC. East of UTC is where the bug
  // lived; west of UTC proves the fix is "stop converting to UTC" rather than
  // an offset nudged the other way, which would break the other hemisphere.
  for (const tz of ['Asia/Taipei', 'America/New_York']) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 950 }, timezoneId: tz, acceptDownloads: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(BASE + '/seed');
    await H.wipeDB(page);
    await page.goto(BASE + '/');
    await page.waitForTimeout(1600);
    await setEventRange(page);

    // The browser really is in the timezone we asked for — otherwise every
    // assertion below would be vacuous.
    const offset = await page.evaluate(() => new Date('2026-09-23T12:00:00Z').getTimezoneOffset());
    assert(tz === 'Asia/Taipei' ? offset === -480 : offset === 240,
      `${tz}：瀏覽器確實在這個時區（offset ${offset}）`);

    await page.locator('[data-ev-enter]').first().click();
    await page.waitForTimeout(600);

    // ---- 1. the chips are the event's own days ----
    const labels = await page.locator('[data-date-picker] button').allInnerTexts();
    const first = labels[0].split('\n')[0].trim();
    assert(labels.length === DAYS.length,
      `${tz}：日期籤數量等於活動天數 ${DAYS.length}（實際 ${labels.length}）`);
    assert(first === '09/23', `${tz}：第一顆日期籤是 09/23（實際 ${first}）`);
    const shown = labels.map(t => t.split('\n')[1].trim());
    assert(JSON.stringify(shown) === JSON.stringify(DAYS),
      `${tz}：三顆日期籤為 ${DAYS.join(' ')}（實際 ${shown.join(' ')}）`);
    await page.screenshot({ path: path.join(SHOT, `chips_${tz.replace('/', '-')}.png`), fullPage: true });

    // ---- 2. and the chosen day is what the record stores ----
    await page.locator('[data-staff-picker] button').first().click();
    await page.waitForTimeout(150);
    await page.locator('[data-date-picker] button').first().click();
    await page.waitForTimeout(150);
    await H.pickCustomerStatus(page, 'Existing');
    await page.locator('[data-entry-customer]').click();
    await page.waitForTimeout(600);
    // 舊客戶 skips Company Profile, so this is customer → needs → done.
    await page.locator('input[placeholder^="Enter Name"]').fill('時區測試 ' + tz);
    await page.locator('input[placeholder^="Enter Company"]').fill('測試公司');
    await page.locator('input[placeholder^="Enter Email"]').fill('tz@example.com');
    const combo = page.locator('[data-combo] input').first();
    await combo.click();
    await combo.fill('Taiwan');
    await page.locator('input[type="checkbox"]').last().check();
    await page.getByRole('button', { name: /Next 下一步/ }).click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /Finish 完成/ }).click();
    await page.waitForTimeout(800);

    const rec = (await H.readAll(page, 'records'))[0];
    assert(rec && rec.staffFields.visit_date === START,
      `${tz}：紀錄的訪談日期是 ${START}（實際 ${rec && rec.staffFields.visit_date}）`);

    assert(errors.length === 0, `${tz}：無 console error：` + errors.join(' | '));
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log(fails ? `\nTIMEZONE FAILED (${fails})` : '\nTIMEZONE PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
