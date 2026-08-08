#!/usr/bin/env node
// Generates the PWA icons from the calendar glyph the event-list header already
// uses, so the home-screen icon matches the app's own chrome.
//
// There is no build step in this project and the icons change roughly never, so
// the PNGs are committed. Re-run this only when the mark itself changes:
//   node tools/make-icons.js
const path = require('path');
const fs = require('fs');
const H = require('../tests/helpers');

const BRAND = '#0055B8';
const OUT = path.join(__dirname, '..', 'icons');

// The same 24×24 stroke glyph as the 活動首頁 header.
const glyph = (stroke) => `
  <svg viewBox="0 0 24 24" fill="none" stroke="#FFF" stroke-width="${stroke}"
       stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
    <line x1="16" y1="2" x2="16" y2="6"></line>
    <line x1="8" y1="2" x2="8" y2="6"></line>
    <line x1="3" y1="10" x2="21" y2="10"></line>
  </svg>`;

// `inset` is the share of the canvas left as padding around the glyph.
// Maskable icons get more: launchers may crop to a circle, and anything outside
// the central 80% can be cut off.
const page = (size, inset, radius) => `<!DOCTYPE html><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; }
  #icon {
    width: ${size}px; height: ${size}px; background: ${BRAND};
    border-radius: ${radius}px; display: flex; align-items: center; justify-content: center;
  }
  #glyph { width: ${Math.round(size * (1 - inset * 2))}px; height: ${Math.round(size * (1 - inset * 2))}px; }
</style>
<div id="icon"><div id="glyph">${glyph(1.6)}</div></div>`;

const ICONS = [
  // name,                  size, inset, corner radius
  ['icon-192.png',           192, 0.24, 34],
  ['icon-512.png',           512, 0.24, 90],
  // Full bleed square: iOS rounds the corners itself and dislikes transparency.
  ['apple-touch-icon.png',   180, 0.24, 0],
  // Extra padding so a circular mask cannot clip the glyph.
  ['icon-maskable-512.png',  512, 0.30, 0],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await H.launchBrowser();
  for (const [name, size, inset, radius] of ICONS) {
    const ctx = await browser.newContext({ viewport: { width: size, height: size },
      deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.setContent(page(size, inset, radius));
    await p.locator('#icon').screenshot({ path: path.join(OUT, name), omitBackground: radius > 0 });
    await ctx.close();
    console.log('寫入 icons/' + name + '  ' + size + '×' + size);
  }
  await browser.close();
})();
