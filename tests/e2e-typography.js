// Page header must survive narrow screens, and the customer-facing forms must
// use one type scale: field label = Markdown H2, group heading = H3.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-typography');
fs.mkdirSync(SHOT, { recursive: true });


(async () => {
  const server = await H.serve(8946);
  const browser = await H.launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  const fillCustomerAndAdvance = async () => {
    await page.locator('input[placeholder^="Enter Name"]').fill('王小明');
    await page.locator('input[placeholder^="Enter Company"]').fill('測試公司');
    await page.locator('input[placeholder^="Enter Email"]').fill('t@t.com');
    await page.locator('label', { hasText: 'Nationality' }).locator('xpath=..').locator('input').first().fill('Japan');
    await page.locator('input[type="checkbox"]').last().check();
    await page.getByRole('button', { name: /Next 下一步/ }).click();
    await page.waitForTimeout(450);
  };

  // ---------- header integrity across screens and widths ----------
  const headerProbe = () => page.locator('[data-page-header]').first().evaluate(bar => {
    const r = bar.getBoundingClientRect();
    const title = bar.querySelector('[data-page-title]');
    const spans = title ? [...title.children] : [];
    const chip = [...bar.querySelectorAll('span')].find(el => /^\d+\s*\/\s*\d+$/.test(el.textContent.trim()));
    // Only free-flowing text buttons can wrap. The gear buttons gained a text
    // label in v3.8, so "has text" no longer identifies them — but they are a
    // fixed-height icon+label pill (and the label is display:none on narrow
    // screens, where textContent still reports it), so measuring their height
    // against a line height means nothing. Skip them by name.
    const btn = [...bar.querySelectorAll('button')]
      .filter(b => !b.hasAttribute('data-gear-events') && !b.hasAttribute('data-gear-admin'))
      .find(b => b.textContent.trim()) || null;
    const oneLine = (el) => {
      if (!el) return true;
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      return el.getBoundingClientRect().height <= lh + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 2;
    };
    return {
      barRight: r.right, barW: Math.round(r.width),
      enText: spans[0] ? spans[0].textContent.trim() : '',
      zhText: spans[1] ? spans[1].textContent.trim() : '',
      enBottom: spans[0] ? spans[0].getBoundingClientRect().bottom : 0,
      zhTop: spans[1] ? spans[1].getBoundingClientRect().top : 0,
      chipOneLine: oneLine(chip), chipText: chip ? chip.textContent.trim() : null,
      btnOneLine: oneLine(btn), btnRight: btn ? btn.getBoundingClientRect().right : 0,
      btnText: btn ? btn.textContent.trim() : '',
    };
  });

  for (const [w, h] of [[390, 850], [360, 780]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('http://localhost:8946/');
    await page.waitForTimeout(1200);

    const screens = [];
    // v3.4 adds two screens ahead of the forms; both carry the same header.
    screens.push(['活動首頁', await headerProbe()]);
    await page.screenshot({ path: path.join(SHOT, `hdr_${w}_events.png`) });
    await H.enterEvent(page);
    screens.push(['活動內頁', await headerProbe()]);
    await page.screenshot({ path: path.join(SHOT, `hdr_${w}_eventhome.png`) });

    await page.locator('[data-entry-customer]').click();
    await page.waitForTimeout(450);
    screens.push(['客戶資料', await headerProbe()]);
    await page.screenshot({ path: path.join(SHOT, `hdr_${w}_customer.png`) });
    await fillCustomerAndAdvance();
    screens.push(['公司背景', await headerProbe()]);
    await page.screenshot({ path: path.join(SHOT, `hdr_${w}_company.png`) });
    await page.getByRole('button', { name: /Next 下一步/ }).click();
    await page.waitForTimeout(450);
    screens.push(['客戶需求', await headerProbe()]);
    await page.getByRole('button', { name: /Finish 完成/ }).click();
    await page.waitForTimeout(450);

    for (const [name, p] of screens) {
      assert(p.zhText && p.zhTop >= p.enBottom - 0.5,
        `${w}px ${name}：頁首標題中英分行（${p.enText} / ${p.zhText}）`);
      assert(p.chipText === null || p.chipOneLine, `${w}px ${name}：步驟膠囊未被拆行（${p.chipText}）`);
      assert(p.btnOneLine, `${w}px ${name}：返回鈕未被拆行（${p.btnText}）`);
      assert(p.btnRight <= p.barRight + 0.5, `${w}px ${name}：返回鈕未超出頁首列`);
    }
    const noScroll = await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1);
    assert(noScroll, `${w}px：無水平捲動`);
  }

  // ---------- type scale ----------
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('http://localhost:8946/');
  await page.waitForTimeout(1200);
  await H.enterEvent(page);
  await page.locator('[data-entry-needs]').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOT, 'scale_needs.png'), fullPage: true });

  const px = (loc) => loc.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  // Direct children only — dc-runtime nests an <span class="sc-interp"> per {{ }}.
  const lbl = page.locator('label', { hasText: 'Inquiry Type' }).locator(':scope > span');
  const labelEn = await px(lbl.first());
  const labelZh = await px(lbl.nth(1));
  const grpH3 = await px(page.locator('div', { hasText: /^Gentrex Series$/ }).last());
  const chipEn = await px(page.locator('[data-cb-wrap] > label').first().locator('span > span').first());

  assert(labelEn === 24, `欄位標籤 = Markdown H2 24px（實測 ${labelEn}）`);
  assert(grpH3 === 20, `分組子標題 = Markdown H3 20px（實測 ${grpH3}）`);
  assert(labelZh === 16, `欄位標籤中文行 = 16px（實測 ${labelZh}）`);
  assert(chipEn === 16, `選項英文行 = 16px（實測 ${chipEn}）`);
  assert(labelEn / grpH3 === 1.2 && labelEn / chipEn === 1.5,
    `H2 : H3 : body 比例為 1.5 : 1.25 : 1（${labelEn}/${grpH3}/${chipEn}）`);

  // ---------- convergence: no stray one-off sizes left in the form body ----------
  const sizes = await page.evaluate(() => {
    const body = document.querySelector('[data-mobile-pad]');
    const out = new Set();
    for (const el of body.querySelectorAll('*')) {
      if (!el.textContent.trim() || el.children.length) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height) out.add(parseFloat(getComputedStyle(el).fontSize));
    }
    return [...out].sort((a, b) => a - b);
  });
  const allowed = [12, 14, 16, 20, 24, 32];
  assert(sizes.every(v => allowed.includes(v)) && sizes.length <= 6,
    `表單內文字級全部落在級距內且不超過 6 種：${sizes.join(', ')}px`);

  // ---------- admin deliberately untouched ----------
  await page.goto('http://localhost:8946/');
  await page.waitForTimeout(1200);
  await H.enterEvent(page);
  await page.locator('button:has(svg circle)').first().click();
  await page.locator('#pin-input').click();
  await page.locator('#pin-input').pressSequentially('0000');
  await page.getByRole('button', { name: '登入' }).click();
  await page.waitForTimeout(500);
  const adminTitle = await px(page.locator('div', { hasText: /^客戶資料欄位$/ }).last());
  assert(adminTitle === 18, `後台區塊標題維持原本 18px（實測 ${adminTitle}）`);

  if (errors.length) { console.error('CONSOLE ERRORS:'); errors.forEach(e => console.error('  ' + e)); fails++; }
  else console.log('ok: 無 console error');

  await browser.close(); server.close();
  console.log(fails ? `TYPOGRAPHY FAILED (${fails})` : 'TYPOGRAPHY PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
