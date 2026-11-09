// Run with: npm test   (Node 18.11+, no other dependencies)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const zlib = require('zlib');
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

// Reads an XYZType tag straight from the file, without going through src/core.js.
function readXYZTag(bytes, sig) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < dv.getUint32(128); i++) {
    const e = 132 + i * 12;
    if (String.fromCharCode(...bytes.slice(e, e + 4)) === sig) {
      const off = dv.getUint32(e + 4);
      return [0, 1, 2].map(k => dv.getInt32(off + 8 + k * 4));
    }
  }
  return null;
}

// Adds an XYZType tag to a profile, without going through src/core.js.
function withXYZTag(bytes, sig, xyz) {
  const src = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = src.getUint32(128), body = bytes.length - (132 + n * 12);
  const size = 132 + (n + 1) * 12 + body + 20;
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  out.set(bytes.slice(0, 128));
  dv.setUint32(0, size);
  dv.setUint32(128, n + 1);
  for (let i = 0; i < n; i++) {
    const e = 132 + i * 12;
    out.set(bytes.slice(e, e + 12), e);
    dv.setUint32(e + 4, src.getUint32(e + 4) + 12);
  }
  out.set(bytes.slice(132 + n * 12), 132 + (n + 1) * 12);
  const e = 132 + n * 12, off = size - 20;
  [...sig].forEach((c, i) => { out[e + i] = c.charCodeAt(0); });
  dv.setUint32(e + 4, off); dv.setUint32(e + 8, 20);
  [...'XYZ '].forEach((c, i) => { out[off + i] = c.charCodeAt(0); });
  xyz.forEach((v, k) => dv.setInt32(off + 8 + k * 4, v));
  return out;
}

for (const [name, buf] of profiles) {
  test(`round trip: ${name}`, async () => {
    const parsed = ICCQR.parseICC(buf);
    const marker = ICCQR.compact(parsed, { samples: 33, note: 'Brightness 35' });
    const { text } = await ICCQR.encode(marker);
    assert.match(text, /^[A-Z2-7]+$/, 'payload uses only QR alphanumeric characters');

    const decoded = await ICCQR.decode(text);
    for (const k of ['wtpt', 'r', 'g', 'b', 'chad', 'bkpt']) assert.deepEqual(decoded[k], parsed[k], k);
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

test('carries a measured black point into the rebuilt profile', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'profiles', 'littlecms-srgb.icc'));
  const black = [32, 33, 27]; // about 0.05% of a D50 white
  const parsed = ICCQR.parseICC(ab(withXYZTag(src, 'bkpt', black)));
  assert.deepEqual(parsed.bkpt, black);

  const decoded = await ICCQR.decode((await ICCQR.encode(ICCQR.compact(parsed, {}))).text);
  assert.deepEqual(decoded.bkpt, black);
  const rebuilt = ICCQR.buildICC(decoded);
  assertWellFormed(rebuilt);
  assert.deepEqual(readXYZTag(rebuilt, 'bkpt'), black);

  const level = ICCQR.blackLevel(decoded);
  assert.equal(level.source, 'measured');
  assert.ok(Math.abs(level.contrast - decoded.wtpt[1] / 33) < 1e-6, `contrast ${level.contrast}`);
});

test('works out black from the tone curves when there is no black point', () => {
  const s = ICCQR.parseICC(ab(ICCQR.exampleICC()));
  delete s.bkpt;
  s.lumiY = 100;
  // ICC parametric type 2: Y = (aX + b)^g + c, so the curve starts at c
  const c = 66;
  s.trc = [0, 1, 2].map(() => ({ kind: 'para', type: 2, params: [Math.round(2.2 * 65536), 65536, 0, c] }));
  const level = ICCQR.blackLevel(s);
  assert.equal(level.source, 'curves');
  assert.ok(Math.abs(level.rel - c / 65536) < 1e-9, `relative black ${level.rel}`);
  assert.ok(Math.abs(level.cdm2 - 100 * c / 65536) < 1e-9);
});

test('reports no black level when the profile records none', () => {
  const s = ICCQR.parseICC(ab(fs.readFileSync(path.join(__dirname, 'profiles', 'littlecms-srgb.icc'))));
  assert.equal(s.bkpt, undefined);
  assert.equal(ICCQR.blackLevel(s), null);
});

test('markers without a black point are encoded exactly as before', async () => {
  const text = fs.readFileSync(path.join(__dirname, 'golden-v1.txt'), 'utf8').trim();
  const raw = zlib.inflateRawSync(Buffer.from(ICCQR.b32dec(text)));
  assert.equal(raw[1] & 64, 0);
  assert.deepEqual(Buffer.from(ICCQR.pack(ICCQR.unpack(raw))), raw);
});

test('decoders that predate the black point still read the rest of the marker', () => {
  const src = fs.readFileSync(path.join(__dirname, 'profiles', 'littlecms-srgb.icc'));
  const record = ICCQR.compact(ICCQR.parseICC(ab(withXYZTag(src, 'bkpt', [32, 33, 27]))), { note: 'Brightness 35' });
  const withBlack = ICCQR.pack(record);
  const without = ICCQR.pack({ ...record, bkpt: undefined });
  assert.deepEqual(withBlack.slice(2, -9), without.slice(2), 'the black point is only appended');

  // An older decoder doesn't know flag 64 and stops reading after the note.
  const old = Uint8Array.from(withBlack); old[1] &= ~64;
  const seen = ICCQR.unpack(old);
  assert.equal(seen.note, 'Brightness 35');
  assert.deepEqual(seen.wtpt, record.wtpt);
  assert.equal(seen.bkpt, undefined);
});
