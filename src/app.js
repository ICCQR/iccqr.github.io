(() => {
  const $ = id => document.getElementById(id);
  const fx = ICCQR.fx;
  const dateText = ICCQR.formatDate;
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage off */ } } };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const hosted = /^https?:$/.test(location.protocol) && !/claude\.ai|claudeusercontent/.test(location.hostname);
  const here = hosted ? location.origin + location.pathname : '';

  function saveFile(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  async function copy(text, statusEl, box) {
    try { await navigator.clipboard.writeText(text); statusEl.textContent = 'Link copied.'; }
    catch (e) { if (box) { box.hidden = false; box.value = text; box.select(); } statusEl.textContent = 'Copy was blocked. The link is selected below; copy it yourself.'; }
  }

  // ---------- plots ----------
  // CIE 1931 2° spectral locus, 400–700 nm in 5 nm steps
  const LOCUS = '0.1733,0.0048 0.1730,0.0048 0.1726,0.0048 0.1721,0.0048 0.1714,0.0051 0.1703,0.0058 0.1689,0.0069 0.1669,0.0086 0.1644,0.0109 0.1611,0.0138 0.1566,0.0177 0.1510,0.0227 0.1440,0.0297 0.1355,0.0399 0.1241,0.0578 0.1096,0.0868 0.0913,0.1327 0.0687,0.2007 0.0454,0.2950 0.0235,0.4127 0.0082,0.5384 0.0039,0.6548 0.0139,0.7502 0.0389,0.8120 0.0743,0.8338 0.1142,0.8262 0.1547,0.8059 0.1929,0.7816 0.2296,0.7543 0.2658,0.7243 0.3016,0.6923 0.3374,0.6588 0.3731,0.6245 0.4087,0.5896 0.4441,0.5547 0.4788,0.5202 0.5125,0.4866 0.5448,0.4544 0.5752,0.4242 0.6029,0.3965 0.6270,0.3725 0.6482,0.3514 0.6658,0.3340 0.6801,0.3197 0.6915,0.3083 0.7006,0.2993 0.7079,0.2920 0.7140,0.2859 0.7190,0.2809 0.7230,0.2769 0.7260,0.2740 0.7283,0.2717 0.7300,0.2700 0.7311,0.2689 0.7320,0.2680 0.7327,0.2673 0.7334,0.2666 0.7340,0.2660 0.7344,0.2656 0.7346,0.2654 0.7347,0.2653'.split(' ').map(p => p.split(',').map(Number));
  function gamutSVG(c) {
    const W = 340, H = 330, L = 34, B = 24, T = 8, R = 8, sx = (W - L - R) / 0.8, sy = (H - T - B) / 0.9;
    const X = x => (L + x * sx).toFixed(1), Y = y => (H - B - y * sy).toFixed(1);
    let g = '';
    for (let i = 0; i <= 8; i++) g += `<line class="axis" x1="${X(i / 10)}" x2="${X(i / 10)}" y1="${Y(0)}" y2="${Y(0.9)}" stroke-opacity=".5"/><text x="${X(i / 10)}" y="${H - 8}" text-anchor="middle">${(i / 10).toFixed(1)}</text>`;
    for (let i = 0; i <= 9; i++) g += `<line class="axis" x1="${X(0)}" x2="${X(0.8)}" y1="${Y(i / 10)}" y2="${Y(i / 10)}" stroke-opacity=".5"/><text x="${L - 6}" y="${+Y(i / 10) + 3}" text-anchor="end">${(i / 10).toFixed(1)}</text>`;
    // Catmull-Rom spline through the locus, closed by the straight line of purples
    const P = LOCUS.map(([x, y]) => [+X(x), +Y(y)]);
    let locus = `M${P[0][0]} ${P[0][1]}`;
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      locus += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0]} ${p2[1]}`;
    }
    locus += 'Z';
    const tri = pts => pts.map(([x, y]) => `${X(x)},${Y(y)}`).join(' ');
    const srgb = [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]];
    const lab = (p, t, dx, dy) => `<text x="${+X(p[0]) + dx}" y="${+Y(p[1]) + dy}" style="fill:var(--ink)">${t}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="CIE 1931 xy chromaticity diagram with this display's gamut">
      ${g}<path d="${locus}" fill="none" stroke="var(--ink)" stroke-width="1.2" stroke-linejoin="round"/>
      <polygon points="${tri(srgb)}" fill="none" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>
      <polygon points="${tri([c.r, c.g, c.b])}" fill="var(--accent)" fill-opacity=".12" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round"/>
      <circle cx="${X(c.w[0])}" cy="${Y(c.w[1])}" r="3.5" fill="var(--surface)" stroke="var(--ink)" stroke-width="1.5"/>
      ${lab(c.r, 'R', 6, 4)}${lab(c.g, 'G', 6, -4)}${lab(c.b, 'B', -14, 12)}${lab(c.w, 'W', 7, -6)}
      <text x="${X(0.8)}" y="${T + 10}" text-anchor="end">CIE 1931 xy</text></svg>`;
  }
  function vcgtSVG(v) {
    if (!v) return '<p class="status">No video card curves. This profile describes the display but doesn’t change what the graphics card sends to it.</p>';
    const W = 340, H = 230, L = 34, B = 24, T = 10, R = 8;
    const ch = v.kind === 'formula'
      ? [0, 1, 2].map(k => ({ kind: 'f', g: fx(v.vals[k * 3]), mn: fx(v.vals[k * 3 + 1]), mx: fx(v.vals[k * 3 + 2]) }))
      : v.ch;
    const ev = (c, x) => c.kind === 'f' ? c.mn + (c.mx - c.mn) * Math.pow(x, c.g) : ICCQR.evalCurve(c, x);
    const N = 128, dev = ch.map(c => Array.from({ length: N + 1 }, (_, i) => (ev(c, i / N) - i / N) * 255));
    let m = Math.max(2, ...dev.flat().map(Math.abs)); m = Math.ceil(m / 2) * 2;
    const X = x => (L + x * (W - L - R)).toFixed(1), Y = d => (T + (1 - (d + m) / (2 * m)) * (H - T - B)).toFixed(1);
    let g = '';
    for (const t of [-m, -m / 2, 0, m / 2, m]) g += `<line class="axis" x1="${X(0)}" x2="${X(1)}" y1="${Y(t)}" y2="${Y(t)}" ${t ? 'stroke-opacity=".5"' : ''}/><text x="${L - 6}" y="${+Y(t) + 3}" text-anchor="end">${t > 0 ? '+' : ''}${t}</text>`;
    for (const t of [0, 64, 128, 192, 255]) g += `<text x="${X(t / 255)}" y="${H - 8}" text-anchor="middle">${t}</text>`;
    const cols = ['var(--ch-r)', 'var(--ch-g)', 'var(--ch-b)'];
    const lines = dev.map((d, k) => `<polyline fill="none" stroke="${cols[k]}" stroke-width="1.8" stroke-linejoin="round" points="${d.map((y, i) => `${X(i / N)},${Y(y)}`).join(' ')}"/>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Video card correction per channel, in 8-bit steps">${g}${lines}
      <text x="${X(1)}" y="${T + 8}" text-anchor="end">output − input, 8-bit steps</text></svg>`;
  }
  function specRows(s, extra) {
    return [...ICCQR.summarize(s), ...(extra || [])].map(([k, val]) => `<tr><th>${esc(k)}</th><td>${esc(val)}</td></tr>`).join('');
  }
  function showDetails(s, extra) {
    $('gamut').innerHTML = gamutSVG(ICCQR.chromaticities(s));
    $('vcgtPlot').innerHTML = vcgtSVG(s.vcgt);
    $('vcgtLegend').hidden = !s.vcgt;
    $('spec').innerHTML = specRows(s, extra);
  }

  const NOTE_MAX = ICCQR.NOTE_MAX;

  // ---------- maker ----------
  const M = { p: null, buf: null, name: '', example: true, svg: '', url: '', fileName: '' };
  const val = name => document.querySelector(`input[name=${name}]:checked`).value;

  function loadProfile(buf, name, example) {
    let p;
    try { p = ICCQR.parseICC(buf); }
    catch (e) { $('fileMsg').textContent = e.message; return false; }
    Object.assign(M, { p, buf, name, example });
    $('fileName').innerHTML = example ? 'Example profile <span class="tag">not yours</span>' : esc(name);
    $('fileMsg').textContent = p.hasLUT ? 'This profile also has LUT tables. The marker carries its matrix/shaper part, which is what most systems use for a display.' : '';
    $('desc').value = p.desc || '';
    if (example) $('note').value = 'Brightness 35 · Contrast 75 · Custom';
    else $('note').value = '';
    $('date').value = p.date ? dateText(p.date) : new Date().toISOString().slice(0, 10);
    render();
    return true;
  }

  let seq = 0, timer;
  const soon = () => { clearTimeout(timer); timer = setTimeout(render, 120); };
  async function render() {
    if (!M.p) return;
    const my = ++seq;
    let m;
    try {
      m = await ICCQR.makeMarker(M.p, {
        note: $('note').value.trim(),
        name: $('desc').value,
        date: $('date').value, // empty: the profile's own date
        samples: +val('samples'),
        ecc: val('ecc'),
        moduleMm: Math.min(2, Math.max(0.3, +$('mm').value || 0.5)),
        base: $('base').value.trim() || here || ICCQR.DEFAULT_BASE,
      });
    } catch (e) { if (my === seq) showErr(e.message); return; }
    if (my !== seq) return;
    Object.assign(M, { url: m.url, svg: m.svg, fileName: m.fileName });
    $('marker').innerHTML = m.svg;
    $('rSize').textContent = `${m.size.widthMm.toFixed(0)} × ${m.size.heightMm.toFixed(0)} mm`;
    $('rMod').textContent = `version ${m.qr.version}, ${m.qr.modules}×${m.qr.modules} modules at ${Math.min(2, Math.max(0.3, +$('mm').value || 0.5))} mm`;
    $('rData').textContent = `${m.dataBytes} bytes`;
    $('rDataSub').textContent = `${m.payload.length} characters, level ${m.qr.ecc}`;
    $('rAcc').textContent = m.match < 0.0005 ? 'exact' : `${m.match.toFixed(2)} step${m.match >= 1.995 ? 's' : ''}`;
    $('openLink').href = m.url;
    $('mStatus').textContent = '';
    showDetails(m.record, [['Source file', M.example ? 'built-in example' : M.name]]);
  }
  function showErr(msg) {
    $('marker').innerHTML = `<div class="err">${esc(msg)}</div>`;
    M.svg = ''; M.url = '';
    ['rSize', 'rData', 'rAcc'].forEach(id => $(id).textContent = '–');
    $('rMod').textContent = $('rDataSub').textContent = '';
    $('openLink').removeAttribute('href');
  }

  function initMaker() {
    if (hosted) $('base').placeholder = here;
    $('base').value = store.get('iccqr.base') || '';
    $('hostNote').hidden = hosted || !!$('base').value;
    const ex = ICCQR.exampleICC();
    loadProfile(ex.buffer, 'example.icc', true);

    const file = $('file'), drop = $('drop');
    const take = f => { if (!f) return; f.arrayBuffer().then(b => { if (loadProfile(b, f.name, false) && !M.p.date) $('date').value = new Date(f.lastModified).toISOString().slice(0, 10); }); };
    file.addEventListener('change', () => { take(file.files[0]); file.value = ''; });
    ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => take(e.dataTransfer.files[0]));
    $('form').addEventListener('submit', e => e.preventDefault());
    $('form').addEventListener('input', e => {
      if (e.target.id === 'base') { store.set('iccqr.base', e.target.value.trim()); $('hostNote').hidden = hosted || !!e.target.value.trim(); }
      if (e.target.id === 'note') noteCount();
      soon();
    });
    const noteCount = () => { $('noteCount').textContent = `${$('note').value.length} / ${NOTE_MAX}`; };
    $('note').maxLength = NOTE_MAX;
    noteCount();
    $('dlSvg').addEventListener('click', () => { if (M.svg) saveFile(M.svg, M.fileName, 'image/svg+xml'); });
    $('copyLink').addEventListener('click', () => { if (M.url) copy(M.url, $('mStatus')); });
  }

  // ---------- decoder ----------
  async function initDecoder(text) {
    let r;
    try { r = await ICCQR.readMarker(text); }
    catch (e) { $('decodeError').hidden = false; $('decodeError').textContent = e.message; return false; }
    const { icc, fileName: name, record: s } = r;
    $('decodeView').hidden = false; $('makerView').hidden = true;
    $('lede').textContent = 'This link holds a display calibration. Save it as an .icc file on the computer the display is connected to.';
    $('dDate').textContent = dateText(s.date);
    $('dWho').innerHTML = [s.desc && esc(s.desc), s.note && `<span>${esc(s.note)}</span>`].filter(Boolean).join('<br>');
    $('dSave').onclick = () => saveFile(icc, name, 'application/vnd.iccprofile');
    const file = typeof File === 'function' ? new File([icc], name, { type: 'application/vnd.iccprofile' }) : null;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      $('dShare').hidden = false;
      $('dShare').onclick = () => navigator.share({ files: [file], title: name }).catch(() => {});
    }
    $('howto').classList.toggle('no-vc', !s.vcgt);
    $('dCopy').onclick = () => copy(location.href, $('dStatus'), $('dLink'));
    showDetails(s, [['File size', `${icc.length.toLocaleString()} bytes`]]);
    document.title = `Calibration ${dateText(s.date)} · ICCQR`;
    return true;
  }

  async function boot() {
    const h = decodeURIComponent(location.hash.slice(1));
    $('decodeError').hidden = true;
    if (h && /^[A-Za-z2-7]{8,}$/.test(h) && await initDecoder(h)) return;
    $('decodeView').hidden = true; $('makerView').hidden = false;
    if (!M.p) initMaker(); else render();
  }
  $('toMaker').addEventListener('click', e => { e.preventDefault(); history.pushState(null, '', location.pathname + location.search); document.title = 'ICCQR Calibration Markers'; $('lede').textContent = 'Drop in your display’s ICC profile to get a printable QR calibration marker.'; boot(); });
  window.addEventListener('hashchange', boot);
  boot();
})();
