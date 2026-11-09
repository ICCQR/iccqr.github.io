// Run with: npm test   (Node 18.11+, no other dependencies)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ICCQR = require('../src/core.js');

const ab = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const profiles = [['built-in example', ab(ICCQR.exampleICC())]];
for (const f of fs.readdirSync(path.join(__dirname, 'profiles')).filter(f => /\.ic[cm]$/i.test(f)).sort()) {
  profiles.push([f, ab(fs.readFileSync(path.join(__dirname, 'profiles', f)))]);
}

// The checks a strict ICC reader makes before trusting a file.
function assertWellFormed(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(dv.getUint32(0), bytes.length, 'header size matches file length');
  assert.equal(String.fromCharCode(...bytes.slice(36, 40)), 'acsp');
  const n = dv.getUint32(128), tableEnd = 132 + n * 12;
  for (let i = 0; i < n; i++) {
    const off = dv.getUint32(136 + i * 12), size = dv.getUint32(140 + i * 12);
    assert.equal(off % 4, 0, 'tag offset is 4-byte aligned');
    assert.ok(off >= tableEnd, 'tag does not overlap the tag table');
    assert.ok(off + size <= bytes.length, 'tag ends inside the file');
  }
}

for (const [name, buf] of profiles) {
  test(`round trip: ${name}`, async () => {
    const parsed = ICCQR.parseICC(buf);
    const marker = ICCQR.compact(parsed, { samples: 33, note: 'Brightness 35' });
    const { text } = await ICCQR.encode(marker);
    assert.match(text, /^[A-Z2-7]+$/, 'payload uses only QR alphanumeric characters');

    const decoded = await ICCQR.decode(text);
    for (const k of ['wtpt', 'r', 'g', 'b', 'chad']) assert.deepEqual(decoded[k], parsed[k], k);
    assert.equal(decoded.note, 'Brightness 35');
    assert.equal(decoded.desc, parsed.desc);

    const rebuilt = ICCQR.buildICC(decoded);
    assertWellFormed(rebuilt);
    const again = ICCQR.parseICC(ab(rebuilt));
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i <= 255; i++) {
        const x = i / 255;
        const diff = Math.abs(ICCQR.evalCurve(again.trc[c], x) - ICCQR.evalCurve(parsed.trc[c], x)) * 255;
        assert.ok(diff < 0.5, `tone curve ${c} at ${i} is off by ${diff.toFixed(3)} steps`);
      }
    }
  });
}

// Printed markers must keep working. This payload was made by the first release;
// if this test fails, the change breaks every marker already stuck on a screen.
test('decodes a v1 marker from the first release', async () => {
  const text = fs.readFileSync(path.join(__dirname, 'golden-v1.txt'), 'utf8').trim();
  const s = await ICCQR.decode(text);
  assert.deepEqual(s.date, { y: 2026, mo: 11, d: 8, h: 9, mi: 42 });
  assert.equal(s.desc, 'Studio left');
  assert.equal(s.note, 'Brightness 35 · Contrast 75 · Custom');
  assert.equal(s.lumiY, 119.6);
  assert.ok(s.vcgt && s.vcgt.kind === 'table');
  const w = ICCQR.chromaticities(s).w;
  assert.ok(Math.abs(w[0] - 0.3134) < 5e-4 && Math.abs(w[1] - 0.3297) < 5e-4, `white point ${w}`);
  assertWellFormed(ICCQR.buildICC(s));
});

test('rejects files that are not ICC profiles', () => {
  assert.throws(() => ICCQR.parseICC(new ArrayBuffer(200)), /not an ICC profile/);
});

test('reports a damaged link instead of crashing', async () => {
  await assert.rejects(ICCQR.decode('AAAAAAAAAAAA'), /damaged or incomplete/);
});
