// v3.6: the built-in reception roster was replaced outright, so every existing
// event's staff list is overwritten — including rosters the admin edited, which
// is what makes this different from the v3.5 option top-up. Seeds two events
// (one still on the old built-in roster, one customized) plus a record filled in
// under the old roster, then checks the overwrite, that records keep the names
// they were saved with, and that the flag stops a second pass from undoing a
// roster edited after the migration.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-mig-v36');
fs.mkdirSync(SHOT, { recursive: true });
const BASE = 'http://localhost:8959';
// v3.6 introduced the overwrite; v3.8 runs straight after it with the real
// team, so the end state a seeded database lands on is v3.8's roster.
const NEW_ROSTER = [{ en: 'Charlene', zh: '蘇秋菊' }, { en: 'Will', zh: '黃柏儒' },
     { en: 'Steve', zh: '陳誌翔' }, { en: 'Nadia', zh: '鄭淑卿' },
     { en: 'Eric', zh: '顏耀中' }, { en: 'Alen', zh: '黃世仰' },
     { en: 'Wing', zh: '張詩穎' }, { en: 'Rick', zh: '張瑞育' }];

(async () => {
  const server = await H.serve(8959);
  const browser = await H.launchBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  await page.goto(BASE + '/seed');
  await H.wipeDB(page);
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('ExhibitionFormDB', 2);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      db.createObjectStore('config', { keyPath: 'key' });
      db.createObjectStore('records', { keyPath: 'id' });
      db.createObjectStore('fieldDefinitions', { keyPath: 'key' });
      db.createObjectStore('events', { keyPath: 'id' });
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['events', 'fieldDefinitions', 'records', 'config'], 'readwrite');
      const ev = tx.objectStore('events');
      // A v3.5 event still carrying the old built-in roster.
      ev.put({ id: 'ev-old', name: '2026 美國展', startDate: '2026-08-05', endDate: '2026-08-06',
        staff: [{ en: 'Su Chiu-Chu', zh: '蘇秋菊' }, { en: 'Chang Shih-Ying', zh: '張詩穎' },
                { en: 'Chien Yin-Ting', zh: '簡吟庭' }],
        status: 'active', createdAt: '2026-08-01T00:00:00.000Z' });
      // A second event whose roster the admin had customized — overwritten too,
      // which is the behaviour that was explicitly chosen over a safer merge.
      ev.put({ id: 'ev-custom', name: '2027 德國展', startDate: '2027-03-01', endDate: '2027-03-02',
        staff: [{ en: 'Admin Person', zh: '後台自訂人員' }],
        status: 'active', createdAt: '2026-09-01T00:00:00.000Z' });
      const fd = tx.objectStore('fieldDefinitions');
      for (const id of ['ev-old', 'ev-custom']) {
        fd.put({ key: id + '::customerFields', value: [
          { id: 'name', nameEn: 'Name', nameZh: '姓名', type: 'text', required: true, isCore: true, order: 0, options: [] },
          { id: 'company', nameEn: 'Company', nameZh: '公司', type: 'text', required: true, isCore: true, order: 1, options: [] },
        ]});
        fd.put({ key: id + '::needsFields', value: [] });
        fd.put({ key: id + '::companyFields', value: [] });
        fd.put({ key: id + '::staffFields', value: [
          { id: 'greeter', nameEn: 'Greeter', nameZh: '接待人員', type: 'checkbox-group', source: 'event', required: false, isCore: true, order: 0, allowOther: false, options: [] },
          { id: 'visit_date', nameEn: 'Visit Date', nameZh: '訪談日期', type: 'date', source: 'event', required: false, isCore: true, order: 1, allowOther: false, options: [] },
        ]});
      }
      // Filled in under the old roster: the names live in the record itself.
      tx.objectStore('records').put({
        id: 'r-old', eventId: 'ev-old', timestamp: '2026-08-05T09:00:00.000Z', device: 'Tablet-1',
        customerFields: { name: '王小明', company: '宏昌實業' },
        needsFields: {}, companyFields: {},
        staffFields: { greeter: ['Su Chiu-Chu', 'Chang Shih-Ying'], visit_date: '2026-08-05' },
        gdprConsent: true, cardPhoto: null,
      });
      tx.objectStore('config').put({ key: 'migratedTo35', value: true });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));

  await page.goto(BASE + '/');
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(SHOT, '01_event_list.png'), fullPage: true });

  const byId = async () => Object.fromEntries((await H.readAll(page, 'events')).map(e => [e.id, e]));

  // 1. both rosters replaced, customized one included
  let evs = await byId();
  assert(JSON.stringify(evs['ev-old'].staff) === JSON.stringify(NEW_ROSTER),
    '舊內建名單被換成目前的預設團隊：' + JSON.stringify(evs['ev-old'].staff.map(s => s.zh)));
  assert(JSON.stringify(evs['ev-custom'].staff) === JSON.stringify(NEW_ROSTER),
    '後台自訂過的名單也一併覆蓋（這是刻意選的行為）：' + JSON.stringify(evs['ev-custom'].staff));
  assert(errors.length === 0, '載入沒有 JS 例外：' + errors.join(' | '));

  // 2. the card count follows, and the picker offers the new names
  const listText = await page.locator('body').innerText();
  assert(listText.includes('8 位接待人員'), '卡片人數改為 8：' + listText.split('\n').slice(0, 6).join(' | '));
  // Cards sort newest startDate first, so the 2027 event leads — address the
  // one that actually owns the seeded record by name.
  await page.locator('[data-event-card]').filter({ hasText: '2026 美國展' })
    .locator('button').first().click();
  await page.waitForTimeout(500);
  const picker = await page.locator('[data-staff-picker]').innerText();
  assert(picker.includes('Charlene') && picker.includes('蘇秋菊')
    && picker.includes('Rick') && picker.includes('張瑞育'),
    '活動頁的人員選單顯示新名單：' + picker.replace(/\n/g, ' | '));
  // 蘇秋菊 and 張詩穎 appear in both the seeded roster and today's, under
  // different English names — so they prove nothing. 簡吟庭 was dropped
  // outright, and 蘇秋菊's old English name changed, which do.
  assert(!picker.includes('簡吟庭') && !picker.includes('Chien Yin-Ting'),
    '被移除的舊人員不再出現在選單');
  assert(!picker.includes('Su Chiu-Chu'), '舊的英文名已換成新名冊的版本');
  await page.screenshot({ path: path.join(SHOT, '02_staff_picker.png'), fullPage: true });

  // 3. the old record keeps the names it was saved with
  const recs = await H.readAll(page, 'records');
  assert(JSON.stringify(recs[0].staffFields.greeter) === JSON.stringify(['Su Chiu-Chu', 'Chang Shih-Ying']),
    '舊紀錄仍保有當初填的接待人員：' + JSON.stringify(recs[0].staffFields.greeter));
  await H.openAdmin(page, '資料紀錄');
  const table = await page.locator('body').innerText();
  assert(table.includes('Su Chiu-Chu'), '舊紀錄在資料紀錄仍正常顯示原本的名字');

  // 4. flag-gated: a roster edited after the migration survives a reload
  await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('ExhibitionFormDB');
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction('events', 'readwrite');
      const g = tx.objectStore('events').get('ev-old');
      g.onsuccess = () => {
        const ev = g.result;
        ev.staff = [{ en: 'Later Edit', zh: '事後改的人員' }];
        tx.objectStore('events').put(ev);
      };
      tx.oncomplete = () => { db.close(); res(); };
    };
  }));
  await page.goto(BASE + '/');
  await page.waitForTimeout(1600);
  evs = await byId();
  assert(JSON.stringify(evs['ev-old'].staff) === JSON.stringify([{ en: 'Later Edit', zh: '事後改的人員' }]),
    '遷移後才改的名單，重新載入不會被打回預設：' + JSON.stringify(evs['ev-old'].staff));

  await browser.close();
  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nMIGRATION v3.6 PASSED');
  process.exit(fails ? 1 : 0);
})();
