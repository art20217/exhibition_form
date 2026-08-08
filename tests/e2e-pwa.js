// PWA shell: offline caching, the update banner, standalone metadata, and the
// ?sw=off escape hatch.
//
// The rules being checked here all come from where the app runs — a tablet
// handed to customers at a trade show:
//   * a new version must never reload the page by itself, and the banner that
//     offers it must never appear while someone is filling a form;
//   * a bad cached version must be recoverable without devtools or a cable.
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-pwa');
fs.mkdirSync(SHOT, { recursive: true });

(async () => {
  const server = await H.serve(8960);
  const BASE = server.base;
  const browser = await H.launchBrowser();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  // Each context gets its own worker registration and cache storage.
  const fresh = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 850 },
      hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    return { ctx, page, errors };
  };

  const activeWorker = (page) => page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(reg && reg.active);
  });

  // ---- 1. the shell is served and the worker takes control ----
  {
    const { ctx, page, errors } = await fresh();
    await page.goto(BASE + '/');
    await page.waitForTimeout(2500);

    assert(await activeWorker(page), 'Service Worker 註冊並啟用');
    assert(errors.length === 0, '註冊過程沒有 console error：' + errors.join(' | '));

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const c = await caches.open(names[0]);
      const keys = await c.keys();
      return { names, urls: keys.map(r => new URL(r.url).pathname).sort() };
    });
    assert(cached.names.length === 1 && /^exhibition-form-v/.test(cached.names[0]),
      '快取名稱帶版本：' + cached.names.join(','));
    for (const want of ['/index.html', '/manifest.webmanifest', '/icons/icon-192.png']) {
      assert(cached.urls.includes(want), `precache 含 ${want}`);
    }
    await ctx.close();
  }

  // ---- 2. it actually works offline ----
  {
    const { ctx, page } = await fresh();
    await page.goto(BASE + '/');
    await page.waitForTimeout(2500);
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForTimeout(2000);
    const text = await page.locator('body').innerText();
    assert(text.includes('Exhibitions') || text.includes('活動'),
      '離線重新載入仍拿得到 app：' + text.split('\n').slice(0, 3).join(' | '));
    assert((await page.locator('[data-event-card]').count()) >= 1, '離線時活動列表照常渲染');
    await page.screenshot({ path: path.join(SHOT, '01_offline.png'), fullPage: true });
    await ctx.setOffline(false);
    await ctx.close();
  }

  // ---- 2b. the worker only claims the app's own entry point ----
  // It first answered *every* navigation under scope with the cached shell.
  // The app has one entry point and no client-side routes, so that was a lie —
  // and it hung the migration suites, whose blank /seed page came back as the
  // whole app booting on top of the fixtures they were about to plant.
  {
    const { ctx, page } = await fresh();
    await page.goto(BASE + '/');
    await page.waitForTimeout(2500);

    await page.goto(BASE + '/seed');
    await page.waitForTimeout(600);
    const seedText = await page.locator('body').innerText();
    assert(!seedText.includes('Exhibitions') && !seedText.includes('活動'),
      '非入口路徑不會被回傳 app 外殼：' + JSON.stringify(seedText.slice(0, 60)));
    assert((await page.locator('[data-event-card]').count()) === 0,
      '/seed 仍是空白頁，不會自己啟動 app');

    // ...while the entry point itself still comes from cache.
    await page.goto(BASE + '/');
    await page.waitForTimeout(800);
    assert((await page.locator('[data-event-card]').count()) >= 1, '入口路徑照常由快取供應');
    await ctx.close();
  }

  // ---- 3. manifest + iOS standalone metadata ----
  {
    const { ctx, page } = await fresh();
    await page.goto(BASE + '/');
    await page.waitForTimeout(1200);
    const head = await page.evaluate(() => ({
      manifest: document.querySelector('link[rel=manifest]')?.getAttribute('href'),
      appleCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
      statusBar: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content,
      touchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
      theme: document.querySelector('meta[name="theme-color"]')?.content,
    }));
    assert(head.manifest === 'manifest.webmanifest', 'manifest 已連結');
    assert(head.appleCapable === 'yes', 'iOS standalone 已開啟');
    assert(head.statusBar === 'default',
      `狀態列維持不透明（black-translucent 會讓白字疊在淺色安全區上）：${head.statusBar}`);
    assert(head.touchIcon && head.theme === '#0055B8', 'apple-touch-icon 與 theme-color 已設定');

    const mf = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
    assert(mf.display === 'standalone', `manifest display 為 standalone：${mf.display}`);
    assert(mf.start_url === '.' && mf.scope === '.', 'start_url／scope 為相對路徑（Pages 子路徑也能用）');
    assert(mf.icons.some(i => i.purpose === 'maskable'), 'manifest 含 maskable icon');
    for (const icon of mf.icons) {
      const ok = await page.evaluate(async (src) => (await fetch(src)).ok, icon.src);
      assert(ok, `icon 取得成功：${icon.src}`);
    }
    await ctx.close();
  }

  // ---- 4. version strings stay in lockstep ----
  // sw.js has no build step, so nothing but this stops a release from shipping
  // new HTML under the previous cache name — which would leave every tablet on
  // the old version with no way to notice.
  {
    const html = fs.readFileSync(H.APP_HTML, 'utf8');
    const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
    const appV = (html.match(/(v\d+\.\d+\.\d+) — Offline Exhibition Form/) || [])[1];
    const swV = (sw.match(/const VERSION = '(v[\d.]+)'/) || [])[1];
    assert(appV && swV && appV === swV, `index.html 與 sw.js 的版本一致：${appV} vs ${swV}`);
  }

  // ---- 5. an update waits for a human, and only offers itself on the event list ----
  {
    const { ctx, page } = await fresh();
    await page.goto(BASE + '/');
    await page.waitForTimeout(2500);

    assert((await page.locator('[data-sw-banner]').count()) === 0, '沒有更新時不顯示橫幅');

    // Simulate what the registration script does when a new worker parks.
    const bannerOnScreen = async (screen) => {
      await page.evaluate(() => {
        window.__swWaiting = { postMessage() {} };
        window.dispatchEvent(new CustomEvent('sw-update-ready'));
      });
      await page.waitForTimeout(400);
      return page.locator('[data-sw-banner]').count();
    };

    assert((await bannerOnScreen()) === 1, '活動首頁會顯示更新橫幅');
    await page.screenshot({ path: path.join(SHOT, '02_banner.png'), fullPage: true });

    const urlBefore = page.url();
    await page.waitForTimeout(800);
    assert(page.url() === urlBefore && (await page.locator('[data-sw-banner]').count()) === 1,
      '橫幅出現後頁面不會自動重新載入');

    // Walk into a form; the banner must not follow.
    await H.enterEvent(page);
    await page.getByRole('button', { name: /客戶資料/ }).first().click();
    await page.waitForTimeout(600);
    assert((await page.locator('[data-sw-banner]').count()) === 0,
      '進入表單後橫幅不出現（客戶填到一半不會被打斷）');
    await page.screenshot({ path: path.join(SHOT, '03_form_no_banner.png'), fullPage: true });

    assert((await page.locator('[data-sw-apply]').count()) === 0, '表單頁沒有「立即更新」按鈕');
    await ctx.close();
  }

  // ---- 6. ?sw=off recovers a tablet stuck on a bad version, and stays off ----
  {
    const { ctx, page } = await fresh();
    await page.goto(BASE + '/');
    await page.waitForTimeout(2500);
    assert(await activeWorker(page), '前置：worker 已啟用');

    await page.goto(BASE + '/?sw=off');
    await page.waitForTimeout(2500);
    const state = async () => page.evaluate(async () => ({
      regs: (await navigator.serviceWorker.getRegistrations()).length,
      caches: (await caches.keys()).length,
      url: location.href,
    }));
    let after = await state();
    assert(after.regs === 0, `?sw=off 解除所有註冊：剩 ${after.regs}`);
    assert(after.caches === 0, `?sw=off 清空所有快取：剩 ${after.caches}`);
    assert(!after.url.includes('sw=off'), '結束後導回乾淨網址：' + after.url);
    assert((await page.locator('[data-event-card]').count()) >= 1, '解除後 app 仍正常運作');
    assert((await page.locator('[data-sw-disabled]').count()) === 1,
      '活動首頁標示離線快取已停用（避免平板悄悄停在只能連線的狀態）');
    await page.screenshot({ path: path.join(SHOT, '04_sw_off.png'), fullPage: true });

    // The whole point of persisting it: a plain reload must not undo the rescue.
    await page.goto(BASE + '/');
    await page.waitForTimeout(2000);
    after = await state();
    assert(after.regs === 0 && after.caches === 0,
      `重新載入不會自己再註冊回去：regs ${after.regs} caches ${after.caches}`);

    // ...and it is reversible without devtools.
    await page.goto(BASE + '/?sw=on');
    await page.waitForTimeout(2500);
    assert(await activeWorker(page), '?sw=on 重新啟用 worker');
    assert((await page.locator('[data-sw-disabled]').count()) === 0, '重新啟用後停用提示消失');
    await ctx.close();
  }

  // ---- 7. records survive the escape hatch ----
  // ?sw=off clears caches, never IndexedDB. Losing a day of leads to fix a
  // caching problem would be a far worse outcome than the problem.
  {
    const { ctx, page } = await fresh();
    await page.goto(BASE + '/');
    await page.waitForTimeout(2000);
    await H.enterEvent(page);
    await page.getByRole('button', { name: /客戶資料/ }).first().click();
    await page.waitForTimeout(500);
    await H.runFlow(page, { name: '王小明', company: '宏昌實業' });
    const before = (await H.readAll(page, 'records')).length;
    assert(before === 1, `前置：已存入 ${before} 筆紀錄`);

    await page.goto(BASE + '/?sw=off');
    await page.waitForTimeout(2500);
    const kept = await H.readAll(page, 'records');
    assert(kept.length === 1 && kept[0].customerFields.name === '王小明',
      '?sw=off 之後紀錄完好：' + JSON.stringify(kept.map(r => r.customerFields.name)));
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nPWA PASSED');
  process.exit(fails ? 1 : 0);
})();
