#!/usr/bin/env node
// Runs every suite in this directory, one at a time.
//
// Sequential on purpose: each suite starts its own HTTP server on a fixed port
// and wipes the same IndexedDB database, so two running at once would fight
// over both. The whole set takes a couple of minutes, which is fine for a
// pre-merge check.
//
// Exits non-zero if any suite fails, so CI fails the build.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const only = process.argv.slice(2);
const suites = fs.readdirSync(__dirname)
  .filter(f => /^(e2e-.*|artifact-smoke)\.js$/.test(f))
  .filter(f => !only.length || only.some(a => f.includes(a)))
  .sort();

if (!suites.length) {
  console.error(only.length ? `沒有符合的套件：${only.join(' ')}` : '找不到任何套件');
  process.exit(1);
}

const run = (file) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(__dirname, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('close', (code) => {
    resolve({ file, code, out, secs: ((Date.now() - started) / 1000).toFixed(1) });
  });
});

(async () => {
  const results = [];
  for (const file of suites) {
    process.stdout.write(`${file.padEnd(26)}`);
    const r = await run(file);
    results.push(r);
    const summary = (r.out.trim().split('\n').filter(l => /PASSED|FAILED/.test(l)).pop() || '').trim();
    console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'}  ${r.secs}s  ${summary}`);
    // Only the failing suite's output is worth reading; a passing one is noise.
    if (r.code !== 0) {
      console.log(r.out.split('\n').filter(l => l.startsWith('FAIL') || l.includes('Error')).map(l => '    ' + l).join('\n'));
    }
  }

  const failed = results.filter(r => r.code !== 0);
  const total = (results.reduce((a, r) => a + Number(r.secs), 0)).toFixed(1);
  console.log(`\n${results.length - failed.length}/${results.length} 套件通過（${total}s）`);
  if (failed.length) {
    console.log('\n失敗的套件完整輸出：');
    for (const r of failed) console.log(`\n===== ${r.file} =====\n${r.out}`);
    process.exit(1);
  }
})();
