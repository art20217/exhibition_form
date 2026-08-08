// Two chrome-level fixes: the event list's version line stays pinned to the
// bottom however few events there are, and the PIN box fits its 4 digits on
// every screen width without the browser's own password icons squeezing them.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-chrome');
fs.mkdirSync(SHOT, { recursive: true });
const BASE = 'http://localhost:8955';

(async () => {
  const server = await H.serve(8955);
  const browser = await H.launchBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  await page.goto(BASE + '/seed');
  await H.wipeDB(page);
  await page.goto(BASE + '/');
  await page.waitForTimeout(1600);

  // ---- 1. version line pinned to the bottom with a single event ----
  const versionProbe = () => page.evaluate(() => {
    const v = document.querySelector('[data-version-line]');
    const scroll = v.closest('[data-mobile-pad]');
    const vr = v.getBoundingClientRect();
    const sr = scroll.getBoundingClientRect();
    const lastCard = [...document.querySelectorAll('[data-event-card]')].pop();
    return {
      gapToBottom: Math.round(sr.bottom - vr.bottom),
      belowLastCard: lastCard ? vr.top > lastCard.getBoundingClientRect().bottom : true,
      scrolls: scroll.scrollHeight > scroll.clientHeight + 1,
      cards: document.querySelectorAll('[data-event-card]').length,
    };
  });

  let v = await versionProbe();
  await page.screenshot({ path: path.join(SHOT, '01_one_event.png'), fullPage: true });
  assert(v.cards === 1, '起始狀態只有一個活動（內容遠短於視窗）');
  assert(v.gapToBottom <= 40,
    `只有一個活動時版本號仍貼在底部（距底 ${v.gapToBottom}px）`);
  assert(v.belowLastCard, '版本號在最後一張卡片下方，沒有浮到上面');
  assert(!v.scrolls, '內容短於視窗時不會產生多餘捲軸');

  // ---- 2. still bottom-anchored once the list is long enough to scroll ----
  await H.unlockManage(page);
  for (const [name, s, e] of [['活動 B', '2026-09-01', '2026-09-03'], ['活動 C', '2026-10-01', '2026-10-03'],
                              ['活動 D', '2026-11-01', '2026-11-03'], ['活動 E', '2026-12-01', '2026-12-03']]) {
    await page.locator('[data-add-event]').click();
    await page.waitForTimeout(300);
    await page.locator('input[placeholder="例如 2026 美國展"]').fill(name);
    const d = page.locator('input[type="date"]');
    await d.nth(0).fill(s); await d.nth(1).fill(e);
    await page.getByRole('button', { name: '儲存活動' }).click();
    await page.waitForTimeout(400);
  }
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const s = document.querySelector('[data-mobile-pad]'); s.scrollTop = s.scrollHeight; });
  await page.waitForTimeout(250);
  v = await versionProbe();
  await page.screenshot({ path: path.join(SHOT, '02_many_events.png'), fullPage: true });
  assert(v.cards === 5 && v.scrolls, '五個活動時清單會捲動');
  assert(v.belowLastCard && v.gapToBottom <= 40,
    `捲到底時版本號仍在最後一張卡片之下、貼齊底部（距底 ${v.gapToBottom}px）`);

  // ---- 3. the PIN box fits its four digits at every width ----
  // Manage mode swaps the gear for the lock button, so lock it back first.
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /管理中/ }).click();
  await page.waitForTimeout(300);
  const pinProbe = async (w) => {
    await page.setViewportSize({ width: w, height: 850 });
    await page.waitForTimeout(300);
    await page.locator('button:has(svg circle)').first().click();
    await page.waitForTimeout(300);
    await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('8888');
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const el = document.querySelector('#pin-input');
      const cs = getComputedStyle(el);
      const dialog = el.closest('div[style*="border-radius: 16px"]');
      return {
        clipped: el.scrollWidth > el.clientWidth + 1,
        boxW: Math.round(el.getBoundingClientRect().width),
        dialogW: Math.round(dialog.getBoundingClientRect().width),
        fitsDialog: el.getBoundingClientRect().right <= dialog.getBoundingClientRect().right + 0.5
                 && el.getBoundingClientRect().left >= dialog.getBoundingClientRect().left - 0.5,
        indent: cs.textIndent, spacing: cs.letterSpacing,
      };
    });
    await page.screenshot({ path: path.join(SHOT, `03_pin_${w}.png`) });
    await page.getByRole('button', { name: '取消' }).click();
    await page.waitForTimeout(250);
    return r;
  };

  for (const w of [1280, 390, 360, 320]) {
    const p = await pinProbe(w);
    assert(!p.clipped, `${w}px：四位數字沒有把輸入框塞爆（scrollWidth 未超出）`);
    assert(p.fitsDialog, `${w}px：輸入框未超出對話框（框寬 ${p.boxW} / 對話框 ${p.dialogW}）`);
    assert(p.boxW <= 220, `${w}px：輸入框不超過 220px 上限（實測 ${p.boxW}）`);
  }

  // ---- 4. the trailing letter-space is compensated, so digits look centred ----
  await page.locator('button:has(svg circle)').first().click();
  await page.waitForTimeout(300);
  await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('8888');
  await page.waitForTimeout(200);
  const centring = await page.evaluate(() => {
    const el = document.querySelector('#pin-input');
    const cs = getComputedStyle(el);
    const half = parseFloat(cs.letterSpacing) / 2;
    return { indent: parseFloat(cs.textIndent), half, fontSize: cs.fontSize };
  });
  assert(Math.abs(centring.indent - centring.half) <= 1,
    `text-indent 補正為字距的一半（indent ${centring.indent} vs 半字距 ${centring.half}）`);

  // ---- 5. the icon-hiding rules survive parsing ----
  // An unknown pseudo-element invalidates the whole selector list it sits in,
  // so these must be written one per rule — otherwise a browser missing
  // ::-ms-reveal silently drops the ::-webkit- rules too. Chromium doesn't
  // implement the pseudo-elements themselves (getComputedStyle on them just
  // echoes defaults), so assert on what actually breaks: rule survival.
  const kept = await page.evaluate(() => {
    const out = [];
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) if (r.selectorText && r.selectorText.includes('pin-input')) out.push(r.selectorText);
    }
    return out;
  });
  assert(kept.some(s => s.includes('credentials-auto-fill-button'))
      && kept.some(s => s.includes('strong-password-auto-fill-button')),
    'WebKit 的密碼管理圖示規則未被同組的 -ms- 選擇器連累而失效：' + kept.join(' | '));
  assert(kept.every(s => s.split(',').length === 1),
    '每條規則只有一個選擇器（避免無效選擇器拖垮整組）：' + kept.join(' | '));
  // Survival is not the same as safety: v3.5 also hid
  // ::-webkit-textfield-decoration-container, which in WebKit wraps the field's
  // inner editor rather than any icon, and that made the PIN unusable on phones.
  assert(!kept.some(s => s.includes('textfield-decoration-container')),
    '沒有隱藏 inner editor 的容器（那不是圖示，隱藏它手機就打不了字）：' + kept.join(' | '));
  assert((await page.locator('#pin-input').getAttribute('autocomplete')) === 'off',
    '輸入框關閉自動填入，避免密碼管理員插入圖示');

  if (errors.length) { console.error('CONSOLE ERRORS:'); errors.forEach(e => console.error('  ' + e)); fails++; }
  else console.log('ok: 無 console error');

  await browser.close(); server.close();
  console.log(fails ? `CHROME FIXES FAILED (${fails})` : 'CHROME FIXES PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
