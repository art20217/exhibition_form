// The PIN field, typed the way a person types it.
//
// v3.5 added #pin-input::-webkit-textfield-decoration-container { display:none }
// to hide password-manager icons. That pseudo-element is not a decoration: in
// WebKit it is the container holding the field's *inner editor*, so hiding it
// left the field focusable (iOS opened the keyboard) but unusable — nothing
// rendered and nothing could be typed. Reported from a phone; the desktop suite
// never saw it for two independent reasons, both fixed here:
//
//   1. Blink does not implement that pseudo-element, so headless Chromium
//      cannot reproduce the damage at all. Hence the static guard below, which
//      asserts on the rule rather than on its effect.
//   2. Every suite drove the field with locator.fill(), which assigns .value
//      and dispatches one input event without ever going through the inner
//      editor. This file — and now helpers.js — type real keys instead.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-pin');
fs.mkdirSync(SHOT, { recursive: true });
const BASE = 'http://localhost:8957';

(async () => {
  const server = await H.serve(8957);
  const browser = await H.launchBrowser();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  for (const vp of [{ width: 390, height: 850, label: '手機 390' },
                    { width: 360, height: 740, label: '窄手機 360' },
                    { width: 1280, height: 900, label: '桌機 1280' }]) {
    const mobile = vp.width < 500;
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height },
      hasTouch: mobile, isMobile: mobile });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(BASE + '/seed');
    await H.wipeDB(page);
    await page.goto(BASE + '/');
    await page.waitForTimeout(1500);

    // --- typing the PIN one key at a time actually reaches the field ---
    await page.locator('button:has(svg circle)').first().click();
    await page.waitForTimeout(400);
    await page.locator('#pin-input').click();
    await page.locator('#pin-input').pressSequentially('0000');
    await page.waitForTimeout(150);
    const typed = await page.evaluate(() => {
      const el = document.querySelector('#pin-input');
      return { value: el.value, focused: document.activeElement === el,
               w: Math.round(el.getBoundingClientRect().width),
               h: Math.round(el.getBoundingClientRect().height),
               scrollW: el.scrollWidth, clientW: el.clientWidth };
    });
    assert(typed.value === '0000', `${vp.label}：逐鍵輸入四碼有進到欄位（value="${typed.value}"）`);
    assert(typed.focused, `${vp.label}：輸入過程焦點沒有掉`);
    assert(typed.w > 0 && typed.h > 0, `${vp.label}：輸入框本身有被渲染（${typed.w}×${typed.h}）`);
    assert(typed.scrollW <= typed.clientW,
      `${vp.label}：四碼沒有把框撐爆（scrollW ${typed.scrollW} ≤ clientW ${typed.clientW}）`);
    await page.screenshot({ path: path.join(SHOT, `pin-${vp.width}.png`) });

    // --- and it actually unlocks ---
    await page.getByRole('button', { name: '登入' }).click();
    await page.waitForTimeout(500);
    assert((await page.locator('[data-add-event]').count()) === 1,
      `${vp.label}：輸入 PIN 後解鎖成功（出現「＋ 新增活動」）`);

    // --- the same typing path works for the admin panel, not just unlock ---
    await page.locator('[data-event-card] button').first().click();
    await page.waitForTimeout(500);
    await H.openAdmin(page);
    assert((await page.locator('body').innerText()).includes('客戶資料欄位'),
      `${vp.label}：後台也能用同樣的輸入方式進入`);

    assert(errors.length === 0, `${vp.label}：無 console error：` + errors.join(' | '));
    await ctx.close();
  }

  // --- static guard: never hide the inner editor's container ---
  // Blink cannot reproduce the iOS breakage, so assert on the rule itself.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE + '/');
  await page.waitForTimeout(800);
  const pinRules = await page.evaluate(() => {
    const out = [];
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        if (r.selectorText && r.selectorText.includes('pin-input')) {
          out.push({ sel: r.selectorText, css: r.style.cssText });
        }
      }
    }
    return out;
  });
  assert(pinRules.length > 0, '有抓到 #pin-input 的規則（否則下面的防護等於空轉）：' + pinRules.length);
  assert(!pinRules.some(r => r.sel.includes('textfield-decoration-container')),
    '沒有任何規則指向 ::-webkit-textfield-decoration-container（那是 inner editor 的容器，不是圖示）：'
      + pinRules.map(r => r.sel).join(' | '));
  assert(pinRules.every(r => /auto-fill-button|-ms-reveal|-ms-clear/.test(r.sel) || !r.sel.includes('::')),
    '只針對已知的裝飾按鈕，沒有動到其他 shadow DOM 內部結構：' + pinRules.map(r => r.sel).join(' | '));
  await ctx.close();

  await browser.close();
  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nPIN MOBILE PASSED');
  process.exit(fails ? 1 : 0);
})();
