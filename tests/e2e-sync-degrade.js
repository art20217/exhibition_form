// v3.16.1: what happens when the server is older than the app (issue #25).
//
// The company's real server will be built in stages — records first, events
// later — and a tablet updates itself from GitHub Pages the moment a PR merges,
// while the machine running the server updates only when somebody pulls. So
// "app newer than server" is not an exotic case; it is the normal state of
// affairs for a while.
//
// Before this version that combination was silently fatal: `syncPushEvents()`
// runs first in `syncNow()`, a 404 there threw, and the records — the actual
// data — never left the tablet. The status bar said 「伺服器錯誤（404）」 with no
// hint of which request, and 「測試連線」 said 連線成功 because it only ever
// probed `GET /records`.
//
// The old server is simulated with a forwarding proxy rather than a flag on the
// reference implementation: that file is the spec handed to whoever builds the
// real thing, and it should not grow switches that exist only for tests.
const fs = require('fs');
const http = require('http');
const path = require('path');
const H = require('./helpers');

const SHOT = path.join(__dirname, 'shots-sync-degrade');
fs.mkdirSync(SHOT, { recursive: true });

// Everything reaches the real server except /v1/events, which 404s exactly as a
// pre-contract-v2 server would.
//
// `OPTIONS` is deliberately passed through rather than 404'd. Every server in
// this project answers the CORS preflight *before* it routes, so an unknown
// path still gets its 204 — and it has to: a 404'd preflight is blocked by the
// browser as a CORS failure, which reaches the client as a plain network error
// with no status attached. The client then cannot tell "this endpoint does not
// exist" from "the Wi-Fi died", and none of the degradation below can trigger.
// (Found by getting this wrong here first.)
function startOldServerProxy(target) {
  const upstream = new URL(target);
  let eventHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/events') && req.method !== 'OPTIONS') {
      eventHits++;
      const body = JSON.stringify({ error: 'not found' });
      res.writeHead(404, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      });
      res.end(body);
      return;
    }
    const proxied = http.request({
      hostname: upstream.hostname, port: upstream.port,
      path: req.url, method: req.method, headers: req.headers,
    }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
    proxied.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(proxied);
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      server.base = 'http://localhost:' + server.address().port + '/v1';
      server.eventHits = () => eventHits;
      resolve(server);
    });
  });
}

(async () => {
  const app = await H.serve();
  const BASE = app.base;
  const sync = await H.startSyncServer();
  const old = await startOldServerProxy(sync.base.replace(/\/v1$/, ''));
  const browser = await H.launchBrowser();
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok: ' + m); };

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;   // the 404 is the point
    errors.push(m.text());
  });

  const syncAndWait = async () => {
    await page.evaluate(() => window.__app.syncNow('test'));
    await page.waitForFunction(() => window.__app.state.syncStatus !== 'running', { timeout: 20000 })
      .catch(() => {});
    return page.evaluate(() => ({
      status: window.__app.state.syncStatus,
      error: window.__app.state.syncError,
      degraded: window.__app.state.syncEventsUnsupported,
    }));
  };

  await page.goto(BASE + '/seed');
  await H.wipeDB(page);
  await page.goto(BASE + '/');
  await page.waitForTimeout(1600);
  await H.configureSync(page, old.base);
  await page.reload();
  await page.waitForTimeout(1600);

  // ---- 1. 測試連線 names the endpoint that is missing ----
  // The whole reason this issue cost an evening: the one self-service
  // diagnostic in the field reported success while every sync failed.
  await H.openSettings(page);
  await page.getByRole('button', { name: '測試連線' }).click();
  await page.waitForTimeout(900);
  const testResult = await page.locator('[data-sync-test-result]').innerText().catch(async () =>
    await page.locator('body').innerText());
  assert(!/^連線成功$/m.test(testResult),
    '不再只說「連線成功」——舊版就是這樣把人指向錯誤的方向');
  assert(testResult.includes('活動') && testResult.includes('404'),
    '測試連線指名道姓：缺的是活動端點，回的是 404：' + testResult.replace(/\s+/g, ' ').slice(0, 120));
  assert(testResult.includes('紀錄'), '同時說明紀錄端點是通的——問題不在網路');
  await page.screenshot({ path: path.join(SHOT, '01_test_connection.png'), fullPage: true });
  await page.locator('[data-settings-back]').click();
  await page.waitForTimeout(400);
  await H.lockManage(page);

  // ---- 2. records still reach the server ----
  // The point of the whole change. Events are metadata; records are the data.
  await H.enterEvent(page);
  await page.locator('[data-entry-customer]').click();
  await page.waitForTimeout(500);
  await H.runFlow(page, { name: '王小明', company: '宏昌實業' });
  await page.getByRole('button', { name: /完成，返回|Done/ }).first().click().catch(() => {});
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '← 活動列表' }).click();
  await page.waitForTimeout(600);

  const st = await syncAndWait();
  assert(st.status === 'idle',
    `同步整體視為成功，不是失敗（${st.status} ${st.error}）——紀錄已經送達，報成失敗會讓人去找不存在的問題`);
  assert(st.degraded === true, '客戶端記下了這台伺服器沒有活動端點');

  const onServer = await H.serverRecords(sync);
  assert(onServer.length === 1 && onServer[0].customerFields?.name === '王小明',
    `紀錄仍然送到伺服器（實際 ${onServer.length} 筆）——這是這次修正的重點`);

  // ---- 3. …and the status bar says why, without crying wolf ----
  const bar = await page.locator('body').innerText();
  assert(bar.includes('此伺服器不支援活動同步'),
    '狀態列說明降級了：降級可以，靜靜降級不行');
  assert(!bar.includes('同步失敗'), '但不是紅色的「同步失敗」——資料確實送出去了');
  await page.screenshot({ path: path.join(SHOT, '02_degraded_bar.png'), fullPage: true });

  // ---- 4. it does not keep retrying the endpoint it knows is missing ----
  // Counted at the proxy, not inferred from client state: the cursor would sit
  // still whether or not the request went out, so asserting on it would pass
  // no matter what the code did.
  const hitsBefore = old.eventHits();
  await syncAndWait();
  await syncAndWait();
  const hitsAfter = old.eventHits();
  assert(hitsBefore > 0, `第一次確實試過活動端點（${hitsBefore} 次），否則下面那條沒有意義`);
  assert(hitsAfter === hitsBefore,
    `後續同步不再敲那個端點（${hitsBefore} → ${hitsAfter}）——每次都重試等於每次都多等一個逾時`);

  // ---- 5. an unrelated server error still fails loudly, with the endpoint ----
  // 404 is special because it means "not implemented". A 500 is a broken
  // server and must not be swallowed.
  await page.evaluate(() => { window.__app.setState({ syncUrl: window.__app.state.syncUrl + '/nope' }); });
  await page.waitForTimeout(200);
  const broken = await syncAndWait();
  assert(broken.status === 'error', '真的壞掉時仍然報錯');
  assert(/POST \/records|GET \/records/.test(broken.error),
    '錯誤訊息帶出方法與路徑，不再是無從定位的「伺服器錯誤（404）」：' + broken.error);

  assert(errors.length === 0, '無 console error：' + errors.join(' | '));
  await ctx.close();
  await browser.close();
  app.close();
  await new Promise(r => old.close(r));
  await new Promise(r => sync.close(r));
  fs.rmSync(sync.dataDir, { recursive: true, force: true });
  console.log(fails ? `\nSYNC DEGRADE FAILED (${fails})` : '\nSYNC DEGRADE PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(1); });
