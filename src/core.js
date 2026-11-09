/* ICCQR core: ICC display profile <-> compact calibration-marker payload.
   Payload format v1 (big-endian), then deflate-raw, then base32 (RFC 4648, no padding).
   [0] format=1  [1] flags  [2] icc major  [3] icc minor  [4..8] date: yy-2000,mm,dd,hh,mi
   wtpt rXYZ gXYZ bXYZ: 12 x int24 (s15Fixed16 raw)   [chad: 9 x int24]   [lumi Y*10: int24]
   TRC: 1 or 3 curves   [vcgt: formula or 1 or 3 curves]   strings: desc, model, note (u8 len + UTF-8)
   flags: 1 chad, 2 lumi, 4 vcgt, 8 trcShared, 16 vcgtShared, 32 vcgtFormula, 64 bkpt
   extensions, after the strings, in flag order: [bkpt: 3 x int24 (s15Fixed16 raw)]
     Decoders ignore trailing bytes they don't know, so new optional fields go here
     and older decoders still read the rest of the marker.
   curve: u8 kind  0 identity | 1 gamma u16 (u8Fixed8) | 2 para u8 type + int24[n]
          | 3 sampled: u8 K, u16 outCount, u16 gamma*1000, then K zigzag varints: t0, t1-t0, then second differences;
            t = round(y^(1/gamma) * 65535) */
const ICCQR = (() => {
  const PARA_N = [1, 3, 4, 5, 7];
  const D50 = [0.9642, 1.0, 0.8249];
  const fx = v => v / 65536;
  const tagSig = s => s.split('').reduce((a, c) => (a << 8) | c.charCodeAt(0), 0) >>> 0;
  const sigStr = n => String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

  // ---------- parsing ----------
  // Damaged files must fail with a message for people, not a RangeError from a DataView.
  function parseICC(buf) {
    try { return readProfile(buf); }
    catch (e) {
      if (e instanceof RangeError || e instanceof TypeError) throw new Error('This profile file is damaged or incomplete, so it can\u2019t be read.');
      throw e;
    }
  }
  function readProfile(buf) {
    const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (dv.byteLength < 132 || sigStr(dv.getUint32(36)) !== 'acsp') throw new Error('This file is not an ICC profile (no "acsp" signature).');
    if (sigStr(dv.getUint32(16)) !== 'RGB ') throw new Error('Only RGB display profiles can go on a marker. This profile uses the ' + sigStr(dv.getUint32(16)).trim() + ' color space.');
    const p = { major: dv.getUint8(8), minor: dv.getUint8(9), cls: sigStr(dv.getUint32(12)) };
    const y = dv.getUint16(24);
    p.date = y ? { y, mo: dv.getUint16(26), d: dv.getUint16(28), h: dv.getUint16(30), mi: dv.getUint16(32) } : null;
    const tags = {};
    const n = dv.getUint32(128);
    for (let i = 0; i < n; i++) {
      const o = 132 + i * 12;
      tags[sigStr(dv.getUint32(o))] = { off: dv.getUint32(o + 4), size: dv.getUint32(o + 8) };
    }
    const type = t => sigStr(dv.getUint32(tags[t].off));
    const xyz = t => { const o = tags[t].off + 8; return [dv.getInt32(o), dv.getInt32(o + 4), dv.getInt32(o + 8)]; };
    for (const t of ['rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC', 'wtpt'])
      if (!tags[t]) throw new Error(tags.A2B0 ? 'This is a LUT-only profile (no matrix/shaper tags). A marker can carry matrix/shaper profiles, which most calibration tools can produce.' : 'The profile is missing the ' + t + ' tag.');
    p.wtpt = xyz('wtpt'); p.r = xyz('rXYZ'); p.g = xyz('gXYZ'); p.b = xyz('bXYZ');
    if (tags.chad && type('chad') === 'sf32') { const o = tags.chad.off + 8; p.chad = Array.from({ length: 9 }, (_, i) => dv.getInt32(o + i * 4)); }
    if (tags.lumi) p.lumiY = fx(xyz('lumi')[1]);
    if (tags.bkpt && type('bkpt') === 'XYZ ') { const k = xyz('bkpt'); if (k.some(v => v !== 0)) p.bkpt = k; }
    p.trc = ['rTRC', 'gTRC', 'bTRC'].map(t => readCurve(dv, tags[t].off));
    if (tags.vcgt) p.vcgt = readVcgt(dv, tags.vcgt.off);
    p.desc = readText(dv, tags.desc) || '';
    p.model = readText(dv, tags.dmdd) || readText(dv, tags.dmnd);
    p.hasLUT = !!(tags.A2B0 || tags.B2A0 || tags.A2B1);
    return p;
  }
  function readCurve(dv, off) {
    const t = sigStr(dv.getUint32(off));
    if (t === 'curv') {
      const c = dv.getUint32(off + 8);
      if (c === 0) return { kind: 'identity' };
      if (c === 1) return { kind: 'gamma', raw: dv.getUint16(off + 12) };
      if (off + 12 + c * 2 > dv.byteLength) throw new RangeError('curve runs past the end');
      const d = new Float64Array(c);
      for (let i = 0; i < c; i++) d[i] = dv.getUint16(off + 12 + i * 2) / 65535;
      return { kind: 'table', data: d };
    }
    if (t === 'para') {
      const ft = dv.getUint16(off + 8);
      if (ft > 4) throw new Error('Unknown parametric curve type ' + ft + '.');
      return { kind: 'para', type: ft, params: Array.from({ length: PARA_N[ft] }, (_, i) => dv.getInt32(off + 12 + i * 4)) };
    }
    throw new Error('Unsupported tone curve type "' + t + '".');
  }
  function readVcgt(dv, off) {
    const k = dv.getUint32(off + 8);
    if (k === 1) return { kind: 'formula', vals: Array.from({ length: 9 }, (_, i) => dv.getInt32(off + 12 + i * 4)) };
    const ch = dv.getUint16(off + 12), cnt = dv.getUint16(off + 14), sz = dv.getUint16(off + 16);
    if ((ch !== 1 && ch !== 3) || (sz !== 1 && sz !== 2) || cnt < 2 || off + 18 + ch * cnt * sz > dv.byteLength)
      throw new Error('The video card curves (vcgt) in this profile are damaged or in a layout that isn\u2019t supported.');
    const max = sz === 1 ? 255 : 65535;
    const chans = [];
    for (let c = 0; c < ch; c++) {
      const d = new Float64Array(cnt);
      for (let i = 0; i < cnt; i++) { const o = off + 18 + (c * cnt + i) * sz; d[i] = (sz === 1 ? dv.getUint8(o) : dv.getUint16(o)) / max; }
      chans.push({ kind: 'table', data: d });
    }
    while (chans.length < 3) chans.push(chans[0]);
    return { kind: 'table', ch: chans };
  }
  function readText(dv, tag) {
    if (!tag) return '';
    const o = tag.off, t = sigStr(dv.getUint32(o));
    try {
      if (t === 'desc') {
        const c = dv.getUint32(o + 8); let s = ''; for (let i = 0; i < c; i++) { const b = dv.getUint8(o + 12 + i); if (!b) break; s += String.fromCharCode(b); }
        try { const uo = o + 12 + c, uc = dv.getUint32(uo + 4); if (uc > 1) { let u = ''; for (let i = 0; i < uc; i++) { const ch = dv.getUint16(uo + 8 + i * 2); if (!ch) break; u += String.fromCharCode(ch); } if (u.trim()) return u.trim(); } } catch (e) { /* no unicode part */ }
        return s.trim();
      }
      if (t === 'text') { let s = ''; for (let i = 8; i < tag.size; i++) { const b = dv.getUint8(o + i); if (!b) break; s += String.fromCharCode(b); } return s.trim(); }
      if (t === 'mluc') {
        const nrec = dv.getUint32(o + 8), rs = dv.getUint32(o + 12);
        if (rs < 12 || nrec < 1 || 16 + nrec * rs > tag.size) return '';
        let pick = 0;
        for (let i = 0; i < nrec; i++) if (dv.getUint16(o + 16 + i * rs) === 0x656e) { pick = i; break; }
        const r = o + 16 + pick * rs, len = dv.getUint32(r + 4), so = dv.getUint32(r + 8);
        let s = ''; for (let i = 0; i < len; i += 2) s += String.fromCharCode(dv.getUint16(o + so + i));
        return s.replace(/\0+$/, '').trim();
      }
    } catch (e) { /* unreadable text tag */ }
    return '';
  }

  // ---------- curves ----------
  function evalTable(d, x) { const p = x * (d.length - 1), i = Math.min(d.length - 2, Math.floor(p)); return d[i] + (d[i + 1] - d[i]) * (p - i); }
  function evalPara(type, P, x) {
    const [g, a, b, c, d, e, f] = P.map(fx);
    const pw = v => (v > 0 ? Math.pow(v, g) : 0);
    switch (type) {
      case 0: return pw(x);
      case 1: return x >= -b / a ? pw(a * x + b) : 0;
      case 2: return x >= -b / a ? pw(a * x + b) + c : c;
      case 3: return x >= d ? pw(a * x + b) : c * x;
      default: return x >= d ? pw(a * x + b) + e : c * x + f;
    }
  }
  function evalCurve(c, x) {
    switch (c.kind) {
      case 'identity': return x;
      case 'gamma': return Math.pow(x, c.raw / 256);
      case 'para': return evalPara(c.type, c.params, x);
      case 'table': return evalTable(c.data, x);
      case 'samples': return monotone(c.s, x);
    }
  }
  // Fritsch-Carlson monotone cubic over a uniform grid on [0,1]
  function monotone(y, x) {
    const n = y.length; if (n === 1) return y[0];
    const h = 1 / (n - 1), p = Math.max(0, Math.min(1, x)) / h, i = Math.min(n - 2, Math.floor(p)), t = p - i;
    const m = monotoneTangents(y);
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * y[i + 1] + (t3 - t2) * h * m[i + 1];
  }
  const tanCache = new WeakMap();
  function monotoneTangents(y) {
    if (tanCache.has(y)) return tanCache.get(y);
    const n = y.length, h = 1 / (n - 1), dl = [], m = new Float64Array(n);
    for (let i = 0; i < n - 1; i++) dl.push((y[i + 1] - y[i]) / h);
    m[0] = dl[0]; m[n - 1] = dl[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = dl[i - 1] * dl[i] <= 0 ? 0 : (dl[i - 1] + dl[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (dl[i] === 0) { m[i] = m[i + 1] = 0; continue; }
      const a = m[i] / dl[i], b = m[i + 1] / dl[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * dl[i]; m[i + 1] = t * b * dl[i]; }
    }
    tanCache.set(y, m);
    return m;
  }
  // Compact a curve for the marker; table curves are resampled to K points.
  function compactCurve(c, K, lin) {
    if (c.kind !== 'table') return c;
    const d = c.data, isId = d.every((v, i) => Math.abs(v - i / (d.length - 1)) < 1 / 65535 * 1.5);
    if (isId) return { kind: 'identity', srcN: d.length };
    const k = d.length <= K ? d.length : K;
    let g = 1;
    if (lin) { const y = evalTable(d, 0.5); if (y > 0 && y < 1) g = Math.min(4, Math.max(0.5, Math.log(y) / Math.log(0.5))); }
    const g1000 = Math.round(g * 1000); g = g1000 / 1000;
    const t = Array.from({ length: k }, (_, i) => Math.round(Math.pow(Math.max(0, Math.min(1, evalTable(d, i / (k - 1)))), 1 / g) * 65535));
    const s = Float64Array.from(t, q => Math.pow(q / 65535, g));
    return { kind: 'samples', s, outN: d.length, t, g1000 };
  }
  // Largest difference between the original and the marker's curve, in 8-bit code values.
  function curveError(orig, comp) {
    if (orig.kind !== 'table') return 0;
    let e = 0; const d = orig.data;
    for (let i = 0; i < d.length; i++) e = Math.max(e, Math.abs(d[i] - evalCurve(comp, i / (d.length - 1))));
    return e * 255;
  }
  const sameCurve = (a, b) => JSON.stringify(curveKey(a)) === JSON.stringify(curveKey(b));
  const curveKey = c => c.kind === 'samples' ? [c.kind, Array.from(c.s), c.outN] : c.kind === 'table' ? [c.kind, Array.from(c.data)] : c;

  // ---------- payload ----------
  class W {
    constructor() { this.a = []; }
    u8(v) { this.a.push(v & 255); } u16(v) { this.u8(v >> 8); this.u8(v); }
    i24(v) { if (v < -8388608 || v > 8388607) throw new Error('A profile value is out of range for the marker format.'); this.u8(v >> 16); this.u8(v >> 8); this.u8(v); }
    vz(v) { let z = ((v << 1) ^ (v >> 31)) >>> 0; while (z > 127) { this.u8((z & 127) | 128); z >>>= 7; } this.u8(z); }
    str(s) { let b = new TextEncoder().encode(s || ''); if (b.length > 255) { b = b.slice(0, 255); while (b.length && (b[b.length - 1] & 0xc0) === 0x80) b = b.slice(0, -1); } this.u8(b.length); for (const x of b) this.u8(x); }
    bytes() { return Uint8Array.from(this.a); }
  }
  class R {
    constructor(b) { this.b = b; this.p = 0; }
    u8() { if (this.p >= this.b.length) throw new Error('The marker data is cut short.'); return this.b[this.p++]; }
    u16() { return (this.u8() << 8) | this.u8(); }
    i24() { const v = (this.u8() << 16) | (this.u8() << 8) | this.u8(); return v & 0x800000 ? v - 0x1000000 : v; }
    vz() { let z = 0, sh = 0, b; do { b = this.u8(); z |= (b & 127) << sh; sh += 7; } while (b & 128 && sh < 35); return (z >>> 1) ^ -(z & 1); }
    str() { const n = this.u8(); const s = this.b.slice(this.p, this.p + n); this.p += n; return new TextDecoder().decode(s); }
  }
  function writeCurve(w, c) {
    if (c.kind === 'identity') return w.u8(0);
    if (c.kind === 'gamma') { w.u8(1); return w.u16(c.raw); }
    if (c.kind === 'para') { w.u8(2); w.u8(c.type); return c.params.forEach(v => w.i24(v)); }
    // sampled: values in a gamma-linearized domain, sent as zigzag varint second differences
    w.u8(3); w.u8(c.t.length); w.u16(c.outN); w.u16(c.g1000);
    let p1 = 0, d1 = 0;
    c.t.forEach((q, i) => { const d = q - p1, dd = i === 0 ? q : i === 1 ? d : d - d1; w.vz(dd); d1 = d; p1 = q; });
  }
  function readCurveP(r) {
    const k = r.u8();
    if (k === 0) return { kind: 'identity' };
    if (k === 1) return { kind: 'gamma', raw: r.u16() };
    if (k === 2) { const type = r.u8(); if (type > 4) throw new Error('Bad curve in marker data.'); return { kind: 'para', type, params: Array.from({ length: PARA_N[type] }, () => r.i24()) }; }
    if (k !== 3) throw new Error('Bad curve in marker data.');
    const K = r.u8(), outN = r.u16(), g1000 = r.u16(), t = [];
    let p1 = 0, d1 = 0;
    for (let i = 0; i < K; i++) { const dd = r.vz(); const d = i === 0 ? 0 : i === 1 ? dd : d1 + dd; const q = i === 0 ? dd : p1 + d; t.push(q); d1 = d; p1 = q; }
    const s = Float64Array.from(t, q => Math.pow(Math.max(0, q) / 65535, g1000 / 1000));
    return { kind: 'samples', s, outN, t, g1000 };
  }

  // Build the marker record from a parsed profile plus user fields.
  function compact(p, opts) {
    const K = opts.samples || 33;
    const trc = p.trc.map(c => compactCurve(c, K, true));
    let vcgt = null;
    if (p.vcgt) vcgt = p.vcgt.kind === 'formula' ? p.vcgt : { kind: 'table', ch: p.vcgt.ch.map(c => compactCurve(c, K, false)) };
    if (vcgt && vcgt.kind === 'table' && vcgt.ch.every(c => c.kind === 'identity')) vcgt = null; // uncalibrated: nothing to load
    const err = {
      trc: p.trc.map((c, i) => curveError(c, trc[i])),
      vcgt: vcgt && vcgt.kind === 'table' ? p.vcgt.ch.map((c, i) => curveError(c, vcgt.ch[i])) : [0, 0, 0],
    };
    return {
      major: p.major, minor: p.minor, date: opts.date || p.date, wtpt: p.wtpt, r: p.r, g: p.g, b: p.b, chad: p.chad, lumiY: p.lumiY, bkpt: p.bkpt,
      trc, vcgt, desc: opts.desc ?? p.desc, model: opts.model ?? p.model, note: opts.note || '', err,
    };
  }
  function pack(s) {
    const w = new W();
    const trcShared = sameCurve(s.trc[0], s.trc[1]) && sameCurve(s.trc[0], s.trc[2]);
    const vF = s.vcgt && s.vcgt.kind === 'formula';
    const vShared = s.vcgt && !vF && sameCurve(s.vcgt.ch[0], s.vcgt.ch[1]) && sameCurve(s.vcgt.ch[0], s.vcgt.ch[2]);
    w.u8(1);
    w.u8((s.chad ? 1 : 0) | (s.lumiY ? 2 : 0) | (s.vcgt ? 4 : 0) | (trcShared ? 8 : 0) | (vShared ? 16 : 0) | (vF ? 32 : 0) | (s.bkpt ? 64 : 0));
    w.u8(s.major); w.u8(s.minor);
    const d = s.date || { y: 2000, mo: 1, d: 1, h: 0, mi: 0 };
    [d.y - 2000, d.mo, d.d, d.h, d.mi].forEach(v => w.u8(v));
    [...s.wtpt, ...s.r, ...s.g, ...s.b].forEach(v => w.i24(v));
    if (s.chad) s.chad.forEach(v => w.i24(v));
    if (s.lumiY) w.i24(Math.round(s.lumiY * 10));
    (trcShared ? [s.trc[0]] : s.trc).forEach(c => writeCurve(w, c));
    if (vF) s.vcgt.vals.forEach(v => w.i24(v));
    else if (s.vcgt) (vShared ? [s.vcgt.ch[0]] : s.vcgt.ch).forEach(c => writeCurve(w, c));
    w.str(s.desc); w.str(s.model); w.str(s.note);
    if (s.bkpt) s.bkpt.forEach(v => w.i24(v));
    return w.bytes();
  }
  function unpack(bytes) {
    const r = new R(bytes);
    if (r.u8() !== 1) throw new Error('This marker was made by a newer version of the app.');
    const f = r.u8(), s = { major: r.u8(), minor: r.u8() };
    s.date = { y: 2000 + r.u8(), mo: r.u8(), d: r.u8(), h: r.u8(), mi: r.u8() };
    const v = Array.from({ length: 12 }, () => r.i24());
    s.wtpt = v.slice(0, 3); s.r = v.slice(3, 6); s.g = v.slice(6, 9); s.b = v.slice(9, 12);
    if (f & 1) s.chad = Array.from({ length: 9 }, () => r.i24());
    if (f & 2) s.lumiY = r.i24() / 10;
    if (f & 8) { const c = readCurveP(r); s.trc = [c, c, c]; } else s.trc = [readCurveP(r), readCurveP(r), readCurveP(r)];
    if (f & 32) s.vcgt = { kind: 'formula', vals: Array.from({ length: 9 }, () => r.i24()) };
    else if (f & 4) { if (f & 16) { const c = readCurveP(r); s.vcgt = { kind: 'table', ch: [c, c, c] }; } else s.vcgt = { kind: 'table', ch: [readCurveP(r), readCurveP(r), readCurveP(r)] }; }
    s.desc = r.str(); s.model = r.str(); s.note = r.str();
    if (f & 64) s.bkpt = Array.from({ length: 3 }, () => r.i24());
    return s;
  }

  // ---------- transport: deflate-raw + base32 ----------
  async function stream(bytes, T) {
    const s = new Blob([bytes]).stream().pipeThrough(new T('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function b32enc(b) {
    let out = '', bits = 0, val = 0;
    for (const x of b) { val = (val << 8) | x; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits) out += B32[(val << (5 - bits)) & 31];
    return out;
  }
  function b32dec(s) {
    const out = []; let bits = 0, val = 0;
    for (const ch of s.toUpperCase().replace(/[^A-Z2-7]/g, '')) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
    return Uint8Array.from(out);
  }
  async function encode(s) { const raw = pack(s); const z = await stream(raw, CompressionStream); return { raw, z, text: b32enc(z) }; }
  async function decode(text) {
    let z;
    try { z = b32dec(text); var raw = await stream(z, DecompressionStream); }
    catch (e) { throw new Error('The link is damaged or incomplete. Try scanning the marker again.'); }
    return unpack(raw);
  }

  // ---------- ICC writer ----------
  function buildICC(s) {
    const v4 = s.major >= 4;
    const parts = [];
    const B = () => { const a = []; const o = { a, u8: v => a.push(v & 255), u16: v => { o.u8(v >> 8); o.u8(v); }, u32: v => { o.u16(v >>> 16); o.u16(v & 0xffff); }, sig: t => [...t].forEach(c => o.u8(c.charCodeAt(0))) }; return o; };
    const xyzTag = v => { const o = B(); o.sig('XYZ '); o.u32(0); v.forEach(x => o.u32(x >>> 0)); return o.a; };
    const textTag = str => {
      const o = B();
      if (v4) {
        o.sig('mluc'); o.u32(0); o.u32(1); o.u32(12); o.sig('en'); o.sig('US'); o.u32(str.length * 2); o.u32(28);
        for (let i = 0; i < str.length; i++) o.u16(str.charCodeAt(i)); // UTF-16BE, surrogate pairs intact
      } else {
        const ascii = str.replace(/[^\x20-\x7e]/g, '?');
        o.sig('desc'); o.u32(0); o.u32(ascii.length + 1); [...ascii].forEach(c => o.u8(c.charCodeAt(0))); o.u8(0);
        o.u32(0); o.u32(str.length + 1); for (let i = 0; i < str.length; i++) o.u16(str.charCodeAt(i)); o.u16(0);
        o.u16(0); o.u8(0); for (let i = 0; i < 67; i++) o.u8(0);
      }
      return o.a;
    };
    const cprtTag = str => { if (v4) return textTag(str); const o = B(); o.sig('text'); o.u32(0); [...str].forEach(c => o.u8(c.charCodeAt(0))); o.u8(0); return o.a; };
    const curveTag = c => {
      const o = B();
      if (c.kind === 'para') { o.sig('para'); o.u32(0); o.u16(c.type); o.u16(0); c.params.forEach(x => o.u32(x >>> 0)); return o.a; }
      o.sig('curv'); o.u32(0);
      if (c.kind === 'identity') { o.u32(0); return o.a; }
      if (c.kind === 'gamma') { o.u32(1); o.u16(c.raw); o.u16(0); return o.a; }
      const n = c.outN >= 2 ? c.outN : 1024;
      o.u32(n);
      for (let i = 0; i < n; i++) o.u16(Math.round(Math.max(0, Math.min(1, evalCurve(c, i / (n - 1)))) * 65535));
      if (n % 2) o.u16(0);
      return o.a;
    };
    const vcgtTag = v => {
      const o = B(); o.sig('vcgt'); o.u32(0);
      if (v.kind === 'formula') { o.u32(1); v.vals.forEach(x => o.u32(x >>> 0)); return o.a; }
      const n = Math.max(...v.ch.map(c => c.outN || 256), 256) > 1024 ? 1024 : Math.max(...v.ch.map(c => c.outN || 256), 256);
      o.u32(0); o.u16(3); o.u16(n); o.u16(2);
      v.ch.forEach(c => { for (let i = 0; i < n; i++) o.u16(Math.round(Math.max(0, Math.min(1, evalCurve(c, i / (n - 1)))) * 65535)); });
      return o.a;
    };
    const dateStr = s.date ? `${s.date.y}-${String(s.date.mo).padStart(2, '0')}-${String(s.date.d).padStart(2, '0')}` : '';
    const tags = [
      ['desc', textTag(s.desc || ('Display ' + dateStr).trim())],
      ['cprt', cprtTag('No copyright. Rebuilt from an ICCQR calibration marker.')],
      ['wtpt', xyzTag(s.wtpt)],
      ['rXYZ', xyzTag(s.r)], ['gXYZ', xyzTag(s.g)], ['bXYZ', xyzTag(s.b)],
    ];
    const t0 = curveTag(s.trc[0]);
    const shared = JSON.stringify(curveKey(s.trc[0])) === JSON.stringify(curveKey(s.trc[1])) && JSON.stringify(curveKey(s.trc[0])) === JSON.stringify(curveKey(s.trc[2]));
    tags.push(['rTRC', t0], ['gTRC', shared ? 'rTRC' : curveTag(s.trc[1])], ['bTRC', shared ? 'rTRC' : curveTag(s.trc[2])]);
    if (s.chad) { const o = B(); o.sig('sf32'); o.u32(0); s.chad.forEach(x => o.u32(x >>> 0)); tags.push(['chad', o.a]); }
    if (s.bkpt) tags.push(['bkpt', xyzTag(s.bkpt)]);
    if (s.lumiY) { const k = s.lumiY / fx(s.wtpt[1]); tags.push(['lumi', xyzTag(s.wtpt.map(x => Math.round(fx(x) * k * 65536)))]); }
    if (s.vcgt) tags.push(['vcgt', vcgtTag(s.vcgt)]);
    if (s.model) tags.push(['dmdd', textTag(s.model)]);

    const headerLen = 128 + 4 + tags.length * 12;
    let off = headerLen; const placed = {}; const table = [];
    for (const [sig, data] of tags) {
      if (typeof data === 'string') { table.push([sig, placed[data].off, placed[data].size]); continue; }
      while (off % 4) off++;
      placed[sig] = { off, size: data.length, data }; table.push([sig, off, data.length]); off += data.length;
    }
    while (off % 4) off++;
    const out = new Uint8Array(off), dv = new DataView(out.buffer);
    dv.setUint32(0, off);
    dv.setUint8(8, s.major); dv.setUint8(9, s.minor);
    dv.setUint32(12, tagSig('mntr')); dv.setUint32(16, tagSig('RGB ')); dv.setUint32(20, tagSig('XYZ '));
    const d = s.date || { y: 2000, mo: 1, d: 1, h: 0, mi: 0 };
    [d.y, d.mo, d.d, d.h, d.mi, 0].forEach((v, i) => dv.setUint16(24 + i * 2, v));
    dv.setUint32(36, tagSig('acsp'));
    D50.forEach((v, i) => dv.setInt32(68 + i * 4, Math.round(v * 65536)));
    dv.setUint32(128, table.length);
    table.forEach(([sig, o, z], i) => { dv.setUint32(132 + i * 12, tagSig(sig)); dv.setUint32(136 + i * 12, o); dv.setUint32(140 + i * 12, z); });
    for (const k in placed) out.set(placed[k].data, placed[k].off);
    return out;
  }

  // ---------- colorimetry helpers (for display) ----------
  const mul = (A, v) => [0, 1, 2].map(i => A[i * 3] * v[0] + A[i * 3 + 1] * v[1] + A[i * 3 + 2] * v[2]);
  const mmul = (A, B) => Array.from({ length: 9 }, (_, k) => { const i = (k / 3) | 0, j = k % 3; return A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]; });
  function inv(m) {
    const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, Bv = -(d * i - f * g), C = d * h - e * g, det = a * A + b * Bv + c * C;
    return [A, -(b * i - c * h), b * f - c * e, Bv, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(x => x / det);
  }
  const BFD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
  function bradford(src, dst) { const s = mul(BFD, src), t = mul(BFD, dst); return mmul(inv(BFD), mmul([t[0] / s[0], 0, 0, 0, t[1] / s[1], 0, 0, 0, t[2] / s[2]], BFD)); }
  const xy = v => { const S = v[0] + v[1] + v[2]; return [v[0] / S, v[1] / S]; };
  // Chromaticities of the display itself (adaptation to D50 undone).
  function chromaticities(s) {
    const W = s.wtpt.map(fx);
    let undo;
    if (s.chad) undo = inv(s.chad.map(fx));
    else if (s.major < 4) undo = bradford(D50, W);
    else undo = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const white = s.chad || s.major >= 4 ? mul(undo, D50) : W;
    return { w: xy(white), r: xy(mul(undo, s.r.map(fx))), g: xy(mul(undo, s.g.map(fx))), b: xy(mul(undo, s.b.map(fx))) };
  }
  function cct([x, y]) { const n = (x - 0.332) / (0.1858 - y); return 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33; }
  function describeCurve(c) {
    if (!c) return 'none';
    switch (c.kind) {
      case 'identity': return 'linear';
      case 'gamma': return 'gamma ' + (c.raw / 256).toFixed(2);
      case 'para': return 'parametric, gamma ' + fx(c.params[0]).toFixed(2);
      case 'samples': return `${c.s.length} points (rebuilt to ${c.outN})`;
      case 'table': return `${c.data.length}-entry table`;
      case 'formula': return 'formula';
    }
  }
  // Black relative to white. The measured black point wins; otherwise the tone curves'
  // output at input 0. Returns null when the profile records no black above zero.
  function blackLevel(s) {
    let rel = 0, source = null;
    if (s.bkpt && s.bkpt[1] > 0 && s.wtpt[1] > 0) { rel = s.bkpt[1] / s.wtpt[1]; source = 'measured'; }
    else {
      const Y = [s.r, s.g, s.b].map(v => fx(v[1])), white = Y[0] + Y[1] + Y[2];
      const black = Y.reduce((a, y, i) => a + y * evalCurve(s.trc[i], 0), 0);
      if (black > 0 && white > 0) { rel = black / white; source = 'curves'; }
    }
    if (!(rel > 0 && rel < 0.5)) return null;
    return { rel, source, cdm2: s.lumiY ? s.lumiY * rel : null, contrast: 1 / rel };
  }
  function effectiveGamma(c) { const y = evalCurve(c, 0.5); return y > 0 && y < 1 ? Math.log(y) / Math.log(0.5) : null; }

  // ---------- example profile (shown before a file is chosen) ----------
  function exampleICC() {
    const toFix = v => Math.round(v * 65536);
    const prim = { r: [0.6795, 0.3098], g: [0.2654, 0.6912], b: [0.1502, 0.0597] }, wxy = [0.3134, 0.3297];
    const XYZ = ([x, y]) => [x / y, 1, (1 - x - y) / y];
    const Wn = XYZ(wxy), P = [XYZ(prim.r), XYZ(prim.g), XYZ(prim.b)];
    const M = [P[0][0], P[1][0], P[2][0], P[0][1], P[1][1], P[2][1], P[0][2], P[1][2], P[2][2]];
    const S = mul(inv(M), Wn), A = bradford(Wn, D50);
    const col = k => mul(A, [M[k] * S[k], M[3 + k] * S[k], M[6 + k] * S[k]]).map(toFix);
    const tbl = (n, f) => ({ kind: 'samples', s: Float64Array.from({ length: n }, (_, i) => f(i / (n - 1))), outN: n });
    const s = {
      major: 2, minor: 0x40, date: { y: 2026, mo: 11, d: 8, h: 9, mi: 42 },
      wtpt: D50.map(toFix), r: col(0), g: col(1), b: col(2), chad: A.map(toFix), lumiY: 119.6, bkpt: D50.map(v => toFix(v * 0.00109)),
      trc: [2.214, 2.196, 2.231].map((g, k) => tbl(1024, x => Math.pow(x, g) * (1 - 0.0012) + 0.0012 * x * (1 + 0.15 * Math.sin(k + x * 3)))),
      vcgt: { kind: 'table', ch: [[0.982, 0.006], [0.994, -0.004], [0.971, 0.011]].map(([m, w]) => tbl(256, x => Math.min(1, x * m + w * Math.sin(Math.PI * x) * x))) },
      desc: 'Studio left', model: '',
    };
    return buildICC(s);
  }

  return { parseICC, compact, encode, decode, buildICC, chromaticities, blackLevel, cct, describeCurve, effectiveGamma, evalCurve, exampleICC, fx, b32enc, b32dec, pack, unpack };
})();
if (typeof module !== 'undefined') module.exports = ICCQR;
