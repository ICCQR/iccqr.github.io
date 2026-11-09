#!/usr/bin/env node
// Builds index.html (the whole site, apart from fonts/) from src/.
//
//   1. src/page.html's <style> runs through the Invisible Ink PostCSS plugin, which
//      inlines a placeholder for every @font-face marked `invisible-ink: hollow`.
//   2. The two icons in src/icons/ are inlined as data URLs.
//   3. The QR library (minified), src/core.js and src/app.js (with src/glyphs.json)
//      replace the /*QRLIB*/, /*CORE*/ and /*APP*/ script placeholders.
//
// Usage: npm run build   (or: node scripts/build.js [output path])
'use strict';
const fs = require('fs');
const path = require('path');
const postcss = require('postcss');
const invisibleInk = require('invisible-ink/postcss');
const { minify } = require('terser');

const ROOT = path.resolve(__dirname, '..');
const src = f => path.join(ROOT, 'src', f);
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'index.html'));

function replaceOnce(html, marker, value) {
  const i = html.indexOf(marker);
  if (i < 0 || html.indexOf(marker, i + 1) >= 0) throw new Error(`Expected exactly one ${marker} in src/page.html`);
  return html.slice(0, i) + value + html.slice(i + marker.length);
}

(async () => {
  let html = fs.readFileSync(src('page.html'), 'utf8');

  // 1. Fonts: the stylesheet is processed as if it lived at the repo root,
  //    so url("fonts/…") resolves to ./fonts, the same folder the site serves.
  const a = html.indexOf('<style>') + '<style>'.length, b = html.indexOf('</style>', a);
  const css = await postcss([invisibleInk()]).process(html.slice(a, b), { from: path.join(ROOT, 'index.css') });
  css.warnings().forEach(w => console.warn('invisible-ink:', w.text));
  html = html.slice(0, a) + css.css + html.slice(b);

  // 2. Icons
  for (const name of fs.readdirSync(src('icons')).sort()) {
    html = replaceOnce(html, `/*ICON:${name}*/`, fs.readFileSync(src(path.join('icons', name))).toString('base64'));
  }

  // 3. Scripts
  const qr = await minify(fs.readFileSync(require.resolve('qrcode-generator/qrcode.js'), 'utf8'), { compress: true, mangle: true });
  const scripts = {
    '/*QRLIB*/': '/* qrcode-generator 1.4.4, Copyright (c) 2009 Kazuhiko Arase, MIT license */\n' + qr.code,
    '/*CORE*/': fs.readFileSync(src('core.js'), 'utf8'),
    '/*APP*/': fs.readFileSync(src('app.js'), 'utf8').replace('__GLYPHS__', () => fs.readFileSync(src('glyphs.json'), 'utf8').trim()),
  };
  for (const [marker, code] of Object.entries(scripts)) {
    if (/<\/script/i.test(code)) throw new Error(`${marker} would close its <script> tag early`);
    html = replaceOnce(html, marker, code);
  }

  fs.writeFileSync(OUT, html);
  console.log(`${path.relative(process.cwd(), OUT) || OUT}: ${html.length.toLocaleString()} bytes`);
})().catch(e => { console.error(e.message); process.exit(1); });
