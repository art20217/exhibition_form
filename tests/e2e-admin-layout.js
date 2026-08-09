// v3.5 admin layout: every tab shares one content width, and the tab strip's
// first label sits exactly on the content's left edge.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-adminlayout');
fs.mkdirSync(SHOT, { recursive: true });
const BASE = 'http://localhost:8954';
const TABS = ['客戶資料欄位', '客戶需求欄位', '公司背景欄位', '資料紀錄', '系統設定'];

(async () => {
  const server = await H.serve(8954);
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
  await H.enterEvent(page);
  // One record, so the Records tab actually renders its table.
  await H.pickCustomerStatus(page);
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(500);
  await H.runFlow(page, { name: '王小明', company: '永盛國際貿易股份有限公司台中分公司' });
  await page.getByRole('button', { name: /完成，返回/ }).click();
  await page.waitForTimeout(500);
  await H.openAdmin(page);

  // ---- 1. the staff tab is gone ----
  const labels = (await page.locator('[data-admin-tabs] button').allInnerTexts()).map(t => t.trim());
  assert(JSON.stringify(labels) === JSON.stringify(TABS),
    '後台恰為五個頁籤，不含「業務備註欄位」：' + labels.join(' | '));

  // ---- 2–4. one width, one left edge, at three viewports ----
  const probe = () => page.evaluate(() => {
    const panel = document.querySelector('[data-admin-panel]');
    const bar = document.querySelector('[data-admin-tabs]');
    const scroll = document.querySelector('[data-admin-scroll]');
    const firstTab = bar.querySelector('button');
    const p = panel.getBoundingClientRect();
    const t = firstTab.getBoundingClientRect();
    return {
      w: Math.round(p.width), left: Math.round(p.left),
      tabLeft: Math.round(t.left),
      // The scroller's content box is what both the tab strip and the panel are
      // centred in, so this is the number that has to match across tabs.
      clientW: scroll.clientWidth,
      scrolls: scroll.scrollHeight > scroll.clientHeight,
      docOverflow: document.body.scrollWidth > window.innerWidth + 1,
    };
  });

  for (const vw of [1280, 1024, 834]) {
    await page.setViewportSize({ width: vw, height: 950 });
    await page.waitForTimeout(300);
    const seen = [];
    for (const tab of TABS) {
      await page.getByRole('button', { name: tab }).click();
      await page.waitForTimeout(350);
      seen.push([tab, await probe()]);
    }
    const widths = seen.map(([, p]) => p.w);
    const lefts = seen.map(([, p]) => p.left);
    assert(Math.max(...widths) - Math.min(...widths) <= 1,
      `${vw}px：五個頁籤內容等寬（${widths.join(' / ')}）`);
    assert(Math.max(...lefts) - Math.min(...lefts) <= 1,
      `${vw}px：五個頁籤內容左緣一致（${lefts.join(' / ')}）`);
    for (const [tab, p] of seen) {
      assert(Math.abs(p.tabLeft - p.left) <= 1,
        `${vw}px ${tab}：頁籤列首項與內容左緣對齊（tab ${p.tabLeft} vs 內容 ${p.left}）`);
    }
    assert(!seen.some(([, p]) => p.docOverflow), `${vw}px：無水平捲動`);

    // The real cause of the reported mismatch: a classic (non-overlay)
    // scrollbar narrows a scroll container's content box, so tabs whose content
    // is tall enough to scroll would sit narrower than the rest. Reserving the
    // gutter makes the content box identical whether the tab scrolls or not.
    const clientWs = seen.map(([, p]) => p.clientW);
    assert(Math.max(...clientWs) - Math.min(...clientWs) === 0,
      `${vw}px：捲動容器的內容寬在會捲動與不會捲動的頁籤上完全一致（${clientWs.join(' / ')}）`);
    assert(seen.some(([, p]) => p.scrolls) && seen.some(([, p]) => !p.scrolls),
      `${vw}px：本輪確實同時涵蓋會捲動與不會捲動的頁籤（否則上一項形同虛設）`);

    if (vw === 1280) {
      assert(widths[0] === 900, `1280px：內容寬度為 900px（實測 ${widths[0]}）`);
      await page.screenshot({ path: path.join(SHOT, '01_1280_records.png'), fullPage: true });
    }
  }

  // ---- the tab strip scrolls with the panel, so a scrollbar can never move
  //      one without the other (this build uses overlay scrollbars, so the
  //      inset is simulated the way a classic scrollbar would apply it) ----
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.waitForTimeout(300);
  for (const tab of TABS) {
    await page.getByRole('button', { name: tab }).click();
    await page.waitForTimeout(350);
    const together = await page.evaluate(() => {
      const sc = document.querySelector('[data-admin-scroll]');
      sc.style.paddingRight = '15px';
      const panel = document.querySelector('[data-admin-panel]').getBoundingClientRect();
      const t = document.querySelector('[data-admin-tabs] button').getBoundingClientRect();
      const out = { panelLeft: Math.round(panel.left), tabLeft: Math.round(t.left) };
      sc.style.paddingRight = '';
      return out;
    });
    assert(together.panelLeft === together.tabLeft,
      `${tab}：捲軸佔用寬度時，頁籤列與內容一起位移、不會拆開（${together.tabLeft} / ${together.panelLeft}）`);
  }

  // ---- the strip stays pinned while a long field list scrolls ----
  await page.getByRole('button', { name: '公司背景欄位' }).click();
  await page.waitForTimeout(350);
  await page.evaluate(() => { const s = document.querySelector('[data-admin-scroll]'); s.scrollTop = s.scrollHeight; });
  await page.waitForTimeout(400);
  const sticky = await page.evaluate(() => {
    const sc = document.querySelector('[data-admin-scroll]');
    const bar = document.querySelector('[data-admin-tabs]');
    return { scrolled: sc.scrollTop > 100,
      barTop: Math.round(bar.getBoundingClientRect().top),
      scTop: Math.round(sc.getBoundingClientRect().top),
      bg: getComputedStyle(bar).backgroundColor };
  });
  assert(sticky.scrolled && sticky.barTop === sticky.scTop,
    `捲動後頁籤列仍固定在捲動區頂端（bar ${sticky.barTop} / 容器 ${sticky.scTop}）`);
  assert(sticky.bg === 'rgb(255, 255, 255)', '頁籤列為不透明底色，捲動的內容不會透出來');
  await page.screenshot({ path: path.join(SHOT, '02_sticky_scrolled.png') });

  // ---- 5. the narrowed Records table divides its columns sensibly ----
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.getByRole('button', { name: '資料紀錄' }).click();
  await page.waitForTimeout(400);
  const cols = await page.evaluate(() => {
    const wrap = document.querySelector('[data-records-table]');
    const ths = [...wrap.querySelectorAll('th')];
    return { widths: ths.map(th => Math.round(th.getBoundingClientRect().width)),
      wrapW: wrap.clientWidth,
      tableW: Math.round(wrap.querySelector('table').getBoundingClientRect().width) };
  });
  assert(cols.widths[0] === 56 && cols.widths[cols.widths.length - 1] === 132,
    '# 與操作維持固定寬：' + cols.widths.join(' / '));
  const mid = cols.widths.slice(2, -1);
  assert(Math.max(...mid) - Math.min(...mid) <= 1 && mid[0] >= 170 && mid[0] <= 190,
    `三個欄位欄等寬且各約 180px：${mid.join(' / ')}`);
  assert(Math.abs(cols.tableW - cols.wrapW) <= 1, '表格寬度等於容器');

  // ---- 6. the field editor still opens from the three remaining field tabs ----
  for (const tab of ['客戶資料欄位', '客戶需求欄位', '公司背景欄位']) {
    await page.getByRole('button', { name: tab }).click();
    await page.waitForTimeout(300);
    assert((await page.locator('[data-field-row]').count()) > 0, `${tab}：欄位清單有內容`);
  }

  if (errors.length) { console.error('CONSOLE ERRORS:'); errors.forEach(e => console.error('  ' + e)); fails++; }
  else console.log('ok: 無 console error');

  await browser.close(); server.close();
  console.log(fails ? `ADMIN LAYOUT FAILED (${fails})` : 'ADMIN LAYOUT PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
