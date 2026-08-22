// Motion and interaction feel, against the design-engineering rules from
// github.com/emilkowalski/skills (emil-design-eng, apple-design).
//
// The one that mattered was not a taste question: 94 style-hover attributes
// compiled to ungated `:hover` rules, and a touch device fires hover on tap
// and then LEAVES the element in that state. On the venue iPad every button
// stayed lit after it was used. dc-runtime's createPseudoSheet now wraps hover
// rules in `@media (hover: hover) and (pointer: fine)`, which is what this
// suite's first two checks defend.
//
// The rest are the checklist items: no `transition: all`, custom easing curves
// rather than the weak built-ins, press feedback on buttons, entry animations
// that start from scale(0.95) rather than nothing, and a reduced-motion block.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const APP = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

(async () => {
  const server = await H.serve(8963);
  const base = 'http://localhost:8963';
  const browser = await H.launchBrowser();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  // ---- 1. static guards (cheap, and they read the source rather than a render) ----
  assert(!/transition:\s*all\b/.test(APP),
    '沒有 transition: all（會連版面屬性一起動畫）');
  assert(/--ease-out:\s*cubic-bezier/.test(APP) && /--ease-in-out:\s*cubic-bezier/.test(APP),
    '定義了自訂 easing 曲線');
  assert(!/(transition|animation):[^";]*\bease-in\b(?!-out)/.test(APP),
    '沒有任何 ease-in（起手慢，正是讓介面顯得遲鈍的原因）');
  assert(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(APP),
    '有 prefers-reduced-motion 區塊');
  assert(/@keyframes dcEnter[^}]*scale\(0\.95\)/s.test(APP),
    '彈窗進場從 scale(0.95) 起，而不是無中生有');

  // ---- 2. hover gating, measured in both pointer modes ----
  for (const [touch, label, shouldMatch] of [[true, '觸控（展場 iPad）', false], [false, '滑鼠（桌機）', true]]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: touch });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    await page.goto(base + '/');
    await page.waitForTimeout(1400);

    const r = await page.evaluate(() => {
      let total = 0, gated = 0;
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of rules) {
          const cond = rule.conditionText || (rule.media && rule.media.mediaText) || '';
          if (rule.type === CSSRule.MEDIA_RULE && /hover:\s*hover/.test(cond)) {
            for (const inner of rule.cssRules) {
              if (/:hover/.test(inner.selectorText || '')) { total++; gated++; }
            }
          } else if (/:hover/.test(rule.selectorText || '')) total++;
        }
      }
      return { total, gated, active: matchMedia('(hover: hover) and (pointer: fine)').matches };
    });

    assert(r.total > 0, `${label}：找得到 hover 規則（共 ${r.total} 條，否則以下斷言無意義）`);
    assert(r.gated === r.total,
      `${label}：每一條 hover 規則都有 pointer 閘門（${r.gated}/${r.total}）`);
    assert(r.active === shouldMatch,
      `${label}：閘門${shouldMatch ? '成立，hover 照常' : '不成立，點過的按鈕不會卡在 hover'}`);

    // Press feedback is only asserted where a finger is the input.
    if (touch) {
      await H.enterEvent(page);
      await page.waitForTimeout(300);
      const press = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(e => e.innerText.includes('從客戶資料開始'));
        if (!b) return null;
        const before = getComputedStyle(b).transform;
        b.classList.add('__probe');
        const st = document.createElement('style');
        st.textContent = '.__probe { transform: scale(0.97); }';
        document.head.appendChild(st);
        const after = getComputedStyle(b).transform;
        st.remove(); b.classList.remove('__probe');
        return { before, after, hasRule: before !== after };
      });
      assert(press && press.hasRule, '按鈕可以被 transform 縮放（按壓回饋的前提）');
    }

    assert(errors.length === 0, `${label}：console 無錯誤` + (errors.length ? '：' + errors[0] : ''));
    await ctx.close();
  }

  // ---- 3. the :active rule actually reaches a real button ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(base + '/');
    await page.waitForTimeout(1400);
    const r = await page.evaluate(() => {
      // Find the rule rather than simulating :active — Playwright cannot force
      // a pseudo-class, and a pointer-down probe races the app's own handlers.
      let pressRule = null, chipExempt = null;
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of rules) {
          const sel = rule.selectorText || '';
          if (/^button:active/.test(sel)) pressRule = rule.style.transform;
          if (/data-status-picker\] button:active/.test(sel)) chipExempt = rule.style.transform;
        }
      }
      return { pressRule, chipExempt };
    });
    assert(r.pressRule && /scale\(0\.97\)/.test(r.pressRule),
      '按鈕按壓時縮到 0.97：' + (r.pressRule || '（沒有這條規則）'));
    assert(r.chipExempt === 'none',
      '選項膠囊排除在按壓縮放之外（它們是選擇，不是動作）：' + (r.chipExempt || '（沒有排除）'));
    await ctx.close();
  }

  console.log(fails ? `\nMOTION FAILED (${fails})` : '\nMOTION PASSED');
  await browser.close();
  server.close();
  process.exit(fails ? 1 : 0);
})();
