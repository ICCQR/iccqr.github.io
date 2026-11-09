// Feeds the decoder and the profile reader damaged and random input.
// Anyone can make a link, and people drop all sorts of files on the page, so every
// failure must be a plain Error with a message for people (never a TypeError or
// RangeError from deep inside), nothing may hang, and whatever does decode must
// rebuild into a well-formed profile.
//
// Runs are reproducible: FUZZ_SEED=<n> picks the seed, FUZZ_RUNS=<n> the cases per target.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ICCQR = require('../src/core.js');

const SEED = Number(process.env.FUZZ_SEED || 20261109);
const RUNS = Number(process.env.FUZZ_RUNS || 400);
const SLOW_MS = 500;

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ab = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const golden = fs.readFileSync(path.join(__dirname, 'golden-v1.txt'), 'utf8').trim();
const goldenRaw = new Uint8Array(zlib.inflateRawSync(Buffer.from(ICCQR.b32dec(golden))));
const iccSeeds = [
  ICCQR.exampleICC(),
  new Uint8Array(fs.readFileSync(path.join(__dirname, 'profiles', 'littlecms-srgb.icc'))),
];

function mutate(bytes, r) {
  let b = Uint8Array.from(bytes);
  const n = 1 + Math.floor(r() * 6);
  for (let i = 0; i < n; i++) {
    const op = r(), at = Math.floor(r() * b.length);
    if (op < 0.5) b[at] = Math.floor(r() * 256);                       // overwrite a byte
    else if (op < 0.65) b[at] ^= 1 << Math.floor(r() * 8);             // flip a bit
    else if (op < 0.75) b = b.slice(0, at);                            // truncate
    else if (op < 0.85) { const junk = Uint8Array.from({ length: 1 + Math.floor(r() * 16) }, () => Math.floor(r() * 256)); const c = new Uint8Array(b.length + junk.length); c.set(b.slice(0, at)); c.set(junk, at); c.set(b.slice(at), at + junk.length); b = c; } // insert
    else { const v = [0, 0xff, 0x7f, 0x80][Math.floor(r() * 4)]; for (let k = 0; k < 4 && at + k < b.length; k++) b[at + k] = v; } // extreme 32-bit value
  }
  return b;
}

function assertFriendly(e, what) {
  assert.ok(e instanceof Error, `${what}: threw a non-Error ${String(e)}`);
  assert.equal(e.constructor, Error, `${what}: ${e.constructor.name}: ${e.message}`);
  assert.ok(e.message.length > 10, `${what}: unhelpful message "${e.message}"`);
}

function assertWellFormed(bytes, what) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(dv.getUint32(0), bytes.length, `${what}: header size`);
  const n = dv.getUint32(128), end = 132 + n * 12;
  for (let i = 0; i < n; i++) {
    const off = dv.getUint32(136 + i * 12), size = dv.getUint32(140 + i * 12);
    assert.ok(off % 4 === 0 && off >= end && off + size <= bytes.length, `${what}: tag ${i} out of place`);
  }
}

// What the page does with a decoded marker. Our own output must always read back.
function useRecord(s, what) {
  let icc;
  try { icc = ICCQR.buildICC(s); } catch (e) { assertFriendly(e, `${what} buildICC`); return; }
  assertWellFormed(icc, what);
  ICCQR.parseICC(ab(icc));
  ICCQR.chromaticities(s);
  ICCQR.blackLevel(s);
}

async function timed(what, fn) {
  const t = Date.now();
  await fn();
  assert.ok(Date.now() - t < SLOW_MS, `${what}: took ${Date.now() - t} ms`);
}

test(`decode: random and damaged links (seed ${SEED})`, async () => {
  const r = rng(SEED);
  for (let i = 0; i < RUNS; i++) {
    let text;
    if (r() < 0.4) text = Array.from({ length: Math.floor(r() * 800) }, () => B32[Math.floor(r() * 32)]).join('');
    else { const c = [...golden]; for (let k = 0, n = 1 + Math.floor(r() * 5); k < n; k++) c[Math.floor(r() * c.length)] = B32[Math.floor(r() * 32)]; text = c.join('').slice(0, r() < 0.2 ? Math.floor(r() * c.length) : undefined); }
    const what = `decode case ${i}`;
    await timed(what, async () => {
      let s;
      try { s = await ICCQR.decode(text); } catch (e) { assertFriendly(e, what); return; }
      useRecord(s, what);
    });
  }
});

test(`unpack: damaged marker bytes (seed ${SEED + 1})`, async () => {
  const r = rng(SEED + 1);
  for (let i = 0; i < RUNS * 4; i++) {
    const raw = mutate(goldenRaw, r), what = `unpack case ${i}`;
    await timed(what, () => {
      let s;
      try { s = ICCQR.unpack(raw); } catch (e) { assertFriendly(e, what); return; }
      useRecord(s, what);
    });
  }
});

test(`parseICC: damaged profile files (seed ${SEED + 2})`, async () => {
  const r = rng(SEED + 2);
  for (let i = 0; i < RUNS * 4; i++) {
    const bytes = mutate(iccSeeds[i % iccSeeds.length], r), what = `parseICC case ${i}`;
    await timed(what, async () => {
      let p;
      try { p = ICCQR.parseICC(ab(bytes)); } catch (e) { assertFriendly(e, what); return; }
      let enc;
      try { enc = await ICCQR.encode(ICCQR.compact(p, { samples: 33 })); } catch (e) { assertFriendly(e, `${what} encode`); return; }
      useRecord(await ICCQR.decode(enc.text), what);
    });
  }
});

test(`profile names and notes survive in any script (seed ${SEED + 3})`, async () => {
  const r = rng(SEED + 3);
  const ranges = [[0x21, 0x7e], [0xa1, 0x24f], [0x370, 0x3ff], [0x400, 0x4ff], [0x5d0, 0x5ea], [0x3040, 0x30ff], [0x4e00, 0x9fff], [0xac00, 0xd7a3], [0x1f300, 0x1f6ff], [0x20000, 0x2a6df]];
  const word = () => Array.from({ length: 1 + Math.floor(r() * 8) }, () => { const [a, b] = ranges[Math.floor(r() * ranges.length)]; return String.fromCodePoint(a + Math.floor(r() * (b - a + 1))); }).join('');
  const base = ICCQR.parseICC(ab(ICCQR.exampleICC()));
  for (let i = 0; i < RUNS; i++) {
    const desc = Array.from({ length: 1 + Math.floor(r() * 3) }, word).join(' ');
    const note = Array.from({ length: 1 + Math.floor(r() * 3) }, word).join(' ');
    for (const major of [2, 4]) {
      const what = `names case ${i}, ICC v${major}: ${JSON.stringify(desc)}`;
      const s = await ICCQR.decode((await ICCQR.encode(ICCQR.compact({ ...base, major }, { desc, note }))).text);
      assert.equal(s.desc, desc, what);
      assert.equal(s.note, note, what);
      const icc = ICCQR.buildICC(s);
      assertWellFormed(icc, what);
      assert.equal(ICCQR.parseICC(ab(icc)).desc, desc, `${what}: name in the rebuilt profile`);
    }
  }
});
