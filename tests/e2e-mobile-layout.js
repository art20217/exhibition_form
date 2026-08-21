// Touch layout: tap targets and structural fit on the hardware this app runs on.
//
// The venue device is an iPad. Every other layout suite runs at 1280 with the
// default mouse pointer, so nothing measured what a finger actually gets —
// v3.17.0 found the header back buttons at 34px, the event-card actions
// (including 刪除) at 36px, and one submit at 32px, at EVERY width including
// the 1280 the tablet runs at in landscape.
//
// The fix is keyed on `pointer: coarse`, not on a width breakpoint, so this
// suite drives contexts with hasTouch:true. It also checks the mouse case at
// 1280 stays untouched — that scoping is what keeps the six desktop layout
// suites measuring the same geometry they always did.
//
// Structural checks ride along at each width: portrait iPad was measured as
// fitting fine (no overflow, no clipping) and this is what keeps it that way.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-mobile-layout');
fs.mkdirSync(SHOT, { recursive: true });

// Effective tap target = the control, or the <label> wrapping it. Measuring the
// raw <input> is wrong and reports false failures: the GDPR consent box is
// 20px, but it sits inside a label carrying the whole consent paragraph, so the
// real target is 316x163. File inputs are hidden inside styled labels entirely.
const TAP_PROBE = () => {
  const bad = [];
  document.querySelectorAll('button, input, select, a[href], label[for]').forEach(e => {
    if (e.type === 'file') return;
    const t = e.closest('label') || e;
    const r = t.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (getComputedStyle(t).display === 'none') return;
    if (r.height < 44) {
      const name = (e.innerText || t.innerText || e.type || e.tagName).trim().slice(0, 20) || e.tagName;
      bad.push(name + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
    }
  });
  return [...new Set(bad)];
};

// Nothing may sit past the right edge or be cut off inside its own box. body is
// overflow:hidden, so over-wide content is clipped rather than scrollable —
// scrollWidth on the document would report 0 and see nothing.
const FIT_PROBE = () => {
  const vw = document.documentElement.clientWidth;
  const over = [], clipped = [];
  // A deliberate scroller is not a defect, and neither is anything inside one.
  // The admin tab strip ([data-admin-tabs]) is exactly this: four tabs total
  // 380px and it scrolls horizontally below ~400px wide. Checking only the
  // element's own overflow missed that — the strip scrolls, but its inner flex
  // row and the fourth tab were still reported as overflowing.
  const inScroller = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const o = getComputedStyle(n);
      if (/auto|scroll/.test(o.overflowX) || /auto|scroll/.test(o.overflowY)) return true;
    }
    return false;
  };
  document.querySelectorAll('button, input, select, td, th, span, div, label').forEach(e => {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (inScroller(e)) return;
    if (r.right > vw + 1) over.push((e.innerText || e.tagName).trim().slice(0, 18) + ' →' + Math.round(r.right));
    if (e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0) {
      const t = (e.innerText || '').trim().slice(0, 18);
      if (t) clipped.push(t + ' (' + e.clientWidth + '<' + e.scrollWidth + ')');
    }
  });
  return { over: [...new Set(over)].slice(0, 5), clipped: [...new Set(clipped)].slice(0, 5) };
};

(async () => {
  const server = await H.serve(8962);
  const base = 'http://localhost:8962';
  const browser = await H.launchBrowser();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  // 1280 is in the list because that is the venue iPad in landscape: the width
  // every other suite already covers, but with a finger instead of a mouse.
  const VIEWPORTS = [
    [1280, 900, 'iPad 橫向 1280'],
    [834, 1112, 'iPad Pro 11 直向 834'],
    [820, 1180, 'iPad Air 直向 820'],
    [768, 1024, 'iPad Mini 直向 768'],
    [390, 844, 'iPhone 390'],
    [360, 740, '窄手機 360'],
  ];

  for (const [width, height, label] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(base + '/');
    await page.waitForTimeout(1400);

    // Without this the whole suite could pass vacuously: if the context did not
    // actually report a coarse pointer, the rule under test never applies and
    // every "≥44px" assertion below would be measuring the unfixed layout.
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    assert(coarse, label + '：pointer: coarse 生效（否則以下斷言全是假性通過）');

    const seen = [];
    const check = async (screen) => {
      const cur = await page.evaluate(() => window.__app.state.screen);
      const tap = await page.evaluate(TAP_PROBE);
      const fit = await page.evaluate(FIT_PROBE);
      seen.push(screen + '(' + cur + ')');
      assert(tap.length === 0, `${label} / ${screen}：觸控目標皆 ≥44px` + (tap.length ? ' — ' + tap.join(' | ') : ''));
      assert(fit.over.length === 0, `${label} / ${screen}：無元素超出右緣` + (fit.over.length ? ' — ' + fit.over.join(' | ') : ''));
      assert(fit.clipped.length === 0, `${label} / ${screen}：無文字被自身容器截斷` + (fit.clipped.length ? ' — ' + fit.clipped.join(' | ') : ''));
    };

    await check('活動列表');
    await H.unlockManage(page);
    await page.waitForTimeout(400);
    await check('管理模式');           // 編輯／查看紀錄／結束活動／刪除 live here
    await H.openSettings(page);
    await check('系統設定');

    await page.goto(base + '/');
    await page.waitForTimeout(1400);
    await H.enterEvent(page);
    await page.waitForTimeout(300);
    await check('活動內頁');

    // enterEvent() stops on the event page; the entry point is a separate
    // choice and is what sets firstChoice.
    await page.getByRole('button', { name: /從客戶資料開始/ }).click();
    await page.waitForTimeout(500);
    await check('客戶資料');

    await page.screenshot({ path: path.join(SHOT, `${width}_customer.png`), fullPage: true });

    const fillIf = async (loc, v) => { if (await loc.count()) await loc.first().fill(v); };
    await fillIf(page.locator('input[placeholder^="Enter Name"]'), '王小明');
    await fillIf(page.locator('input[placeholder^="Enter Company"]'), '宏昌實業股份有限公司');
    await fillIf(page.locator('input[placeholder^="Enter Email"]'), 'a@b.com');
    await fillIf(page.locator('label', { hasText: 'Nationality' }).locator('xpath=..').locator('input'), 'TW');
    await page.locator('input[type="checkbox"]').last().check();

    await page.getByRole('button', { name: /Next 下一步/ }).click();
    await page.waitForTimeout(500);
    await check('公司背景');
    await page.getByRole('button', { name: /Next 下一步/ }).click();
    await page.waitForTimeout(500);
    await check('客戶需求');
    await page.getByRole('button', { name: /Finish 完成/ }).click();
    await page.waitForTimeout(700);
    await check('完成頁');

    // Back office, with a record now present so the records list actually renders.
    await page.goto(base + '/');
    await page.waitForTimeout(1400);
    await H.enterEvent(page);
    await H.openAdmin(page);
    await page.waitForTimeout(400);
    await check('後台欄位');
    await page.getByRole('button', { name: '資料紀錄' }).first().click();
    await page.waitForTimeout(700);
    await check('後台紀錄');
    await page.screenshot({ path: path.join(SHOT, `${width}_records.png`), fullPage: true });

    // The records table keeps its columns down to 810 and only becomes cards at
    // 768 — measured, not assumed: at 810 the field columns are 124px and the
    // container needs no horizontal scroll.
    const rec = await page.evaluate(() => {
      const t = document.querySelector('[data-records-table]');
      const c = document.querySelector('[data-records-cards]');
      const vis = e => e && getComputedStyle(e).display !== 'none';
      return { table: vis(t), cards: vis(c), hscroll: t ? t.scrollWidth - t.clientWidth : null };
    });
    if (width > 768) {
      assert(rec.table && !rec.cards, `${label} / 紀錄：維持表格`);
      assert(rec.hscroll === 0, `${label} / 紀錄：表格不需橫向捲動（實測 ${rec.hscroll}px）`);
    } else {
      assert(rec.cards && !rec.table, `${label} / 紀錄：改用手機卡片`);
    }

    assert(errors.length === 0, label + '：console 無錯誤' + (errors.length ? '：' + errors[0] : ''));
    await ctx.close();
  }

  // The scoping half. With a mouse the rule must NOT apply, because that is
  // what keeps the six 1280 desktop suites measuring the geometry they assert
  // on. If this ever goes green-by-growing, those suites are about to churn.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: false });
    const page = await ctx.newPage();
    await page.goto(base + '/');
    await page.waitForTimeout(1400);
    const fine = await page.evaluate(() => matchMedia('(pointer: fine)').matches);
    assert(fine, '滑鼠情境：pointer: fine 生效');
    await H.enterEvent(page);
    await page.waitForTimeout(300);
    const backH = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(e => e.innerText.includes('活動列表'));
      return b ? Math.round(b.getBoundingClientRect().height) : null;
    });
    assert(backH !== null && backH < 44,
      `滑鼠情境：返回鈕維持原本尺寸 ${backH}px（觸控規則未外溢到桌機）`);
    await ctx.close();
  }

  console.log(fails ? `\nMOBILE LAYOUT FAILED (${fails})` : '\nMOBILE LAYOUT PASSED');
  await browser.close();
  server.close();
  process.exit(fails ? 1 : 0);
})();
