/* Analisi delle schede tecniche (PDF) di Mondo Convenienza.
 * Indipendente dal formato: lavora sull'immagine renderizzata della pagina.
 *  1. rende ogni pagina su canvas (pdf.js)
 *  2. separa i disegni (componenti connesse dell'"inchiostro", escluse le quote rosse)
 *  3. per ogni disegno ricava la sagoma piena (riempimento dall'esterno + apertura morfologica
 *     per togliere linee di quota e richiami sottili)
 *  4. scarta assonometrie/istruzioni (poche linee orizzontali/verticali) e riquadri pieni
 *  5. riconosce fronte / fianco / pianta confrontando le proporzioni con l'ingombro noto L×P×H
 * Nessuna regola legata al singolo documento: le misure vengono dalla scala del disegno.
 */
const MC3D_Sheet = (() => {
  'use strict';

  const RENDER_W = 1100;          // larghezza di rendering pagina (px)
  const INK_LUM = 200;            // soglia luminanza per "inchiostro"
  const MAX_PAGES = 8;

  // ---------- utilità immagine binaria (Uint8Array 0/1, larghezza w, altezza h) ----------
  function integral(m, w, h) {
    const I = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += m[y * w + x];
        I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
      }
    }
    return I;
  }
  function boxSum(I, w, x0, y0, x1, y1) { // [x0,x1) [y0,y1)
    const W = w + 1;
    return I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
  }
  function dilate(m, w, h, r) {
    if (r <= 0) return m.slice();
    const I = integral(m, w, h), o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        o[y * w + x] = boxSum(I, w, x0, y0, x1, y1) > 0 ? 1 : 0;
      }
    }
    return o;
  }
  function erode(m, w, h, r) {
    if (r <= 0) return m.slice();
    const I = integral(m, w, h), o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = y - r, y1 = y + r + 1;
      for (let x = 0; x < w; x++) {
        const x0 = x - r, x1 = x + r + 1;
        if (x0 < 0 || y0 < 0 || x1 > w || y1 > h) { o[y * w + x] = 0; continue; }
        o[y * w + x] = boxSum(I, w, x0, y0, x1, y1) === (2 * r + 1) * (2 * r + 1) ? 1 : 0;
      }
    }
    return o;
  }
  /** Componenti connesse (4-vicinato). Restituisce {labels, comps:[{id,x0,y0,x1,y1,n}]} */
  function components(m, w, h, minN) {
    const lab = new Int32Array(w * h), comps = [];
    const stack = new Int32Array(w * h);
    let id = 0;
    for (let i = 0; i < w * h; i++) {
      if (!m[i] || lab[i]) continue;
      id++;
      let sp = 0, n = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
      stack[sp++] = i; lab[i] = id;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0;
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && m[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && m[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && m[p - w] && !lab[p - w]) { lab[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && m[p + w] && !lab[p + w]) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      if (n >= (minN || 1)) comps.push({ id, x0, y0, x1: x1 + 1, y1: y1 + 1, n });
    }
    return { labels: lab, comps };
  }
  /** Riempie dall'esterno: restituisce la maschera "dentro" (1 = non raggiungibile dal bordo). */
  function fillInside(m, w, h) {
    const out = new Uint8Array(w * h), stack = new Int32Array(w * h);
    let sp = 0;
    const push = p => { if (!m[p] && !out[p]) { out[p] = 1; stack[sp++] = p; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p / w) | 0;
      if (x > 0) push(p - 1); if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w); if (y < h - 1) push(p + w);
    }
    const ins = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) ins[i] = out[i] ? 0 : 1;
    return ins;
  }
  function crop(m, w, x0, y0, x1, y1) {
    const cw = x1 - x0, ch = y1 - y0, o = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) o.set(m.subarray((y0 + y) * w + x0, (y0 + y) * w + x1), y * cw);
    return o;
  }
  function bboxOf(m, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
  }
  /** Quota di inchiostro su tratti orizzontali/verticali lunghi (assonometrie → valore basso). */
  function rectilinearity(ink, w, h, L) {
    let tot = 0, hv = 0;
    const mark = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      let run = 0;
      for (let x = 0; x <= w; x++) {
        const v = x < w ? ink[y * w + x] : 0;
        if (v) run++;
        else { if (run >= L) for (let k = x - run; k < x; k++) mark[y * w + k] = 1; run = 0; }
      }
    }
    for (let x = 0; x < w; x++) {
      let run = 0;
      for (let y = 0; y <= h; y++) {
        const v = y < h ? ink[y * w + x] : 0;
        if (v) run++;
        else { if (run >= L) for (let k = y - run; k < y; k++) mark[k * w + x] = 1; run = 0; }
      }
    }
    for (let i = 0; i < w * h; i++) if (ink[i]) { tot++; if (mark[i]) hv++; }
    return tot ? hv / tot : 0;
  }

  // ---------- rendering ----------
  async function openDoc(pdfjsLib, data) {
    return pdfjsLib.getDocument({ data, disableFontFace: true, isEvalSupported: false }).promise;
  }
  async function renderPage(doc, i) {
    const page = await doc.getPage(i);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: RENDER_W / vp0.width });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    try { page.cleanup(); } catch (e) { /* ignore */ }
    return cv;
  }
  async function renderPages(pdfjsLib, data) {
    const doc = await openDoc(pdfjsLib, data);
    const pages = [];
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) pages.push({ index: i, canvas: await renderPage(doc, i) });
    try { doc.destroy(); } catch (e) { /* ignore */ }
    return pages;
  }

  // ---------- analisi di una pagina ----------
  function analyzePage(canvas, pageIndex) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const ink = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const red = r > 140 && g < 120 && b < 120 && r - g > 60;   // quote rosse
      ink[i] = lum < INK_LUM && !red ? 1 : 0;
    }
    // unisce tratti vicini dello stesso disegno
    const joined = dilate(ink, w, h, 2);
    const { comps } = components(joined, w, h, 30);
    const pageArea = w * h;
    const cands = [];
    for (const c of comps) {
      const bw = c.x1 - c.x0, bh = c.y1 - c.y0;
      if (bw * bh < pageArea * 0.004) continue;               // troppo piccolo (testo, simboli)
      const touches = c.x0 <= 3 || c.y0 <= 3 || c.x1 >= w - 3 || c.y1 >= h - 3;
      const m = 2;
      const X0 = Math.max(0, c.x0 - m), Y0 = Math.max(0, c.y0 - m), X1 = Math.min(w, c.x1 + m), Y1 = Math.min(h, c.y1 + m);
      const cw = X1 - X0, ch = Y1 - Y0;
      const inkC = crop(ink, w, X0, Y0, X1, Y1);
      const joinC = crop(joined, w, X0, Y0, X1, Y1);
      let inkN = 0; for (let i = 0; i < inkC.length; i++) inkN += inkC[i];
      const density = inkN / (bw * bh);
      // sagoma: chiusura leggera dei tratti, riempimento dall'esterno, apertura per togliere linee sottili
      const closed = dilate(inkC, cw, ch, 2);
      const inside = fillInside(closed, cw, ch);
      const r = Math.max(3, Math.round(Math.min(cw, ch) * 0.012));
      const opened = dilate(erode(inside, cw, ch, r), cw, ch, r);
      const cc = components(opened, cw, ch, 1);
      if (!cc.comps.length) continue;
      // tiene le parti principali della sagoma (>= 3% della maggiore): gambe separate restano incluse
      cc.comps.sort((a, b) => b.n - a.n);
      const keepIds = new Set(cc.comps.filter(k => k.n >= cc.comps[0].n * 0.03).map(k => k.id));
      const sil = new Uint8Array(cw * ch);
      for (let i = 0; i < sil.length; i++) sil[i] = keepIds.has(cc.labels[i]) ? 1 : 0;
      const bb = bboxOf(sil, cw, ch);
      if (!bb) continue;
      const sw = bb.x1 - bb.x0, sh = bb.y1 - bb.y0;
      if (sw < 20 || sh < 20) continue;
      const silC = crop(sil, cw, bb.x0, bb.y0, bb.x1, bb.y1);
      const inkS = crop(inkC, cw, bb.x0, bb.y0, bb.x1, bb.y1);
      let silN = 0; for (let i = 0; i < silC.length; i++) silN += silC[i];
      const rect = rectilinearity(inkS, sw, sh, Math.max(10, Math.round(Math.min(sw, sh) * 0.04)));
      cands.push({
        page: pageIndex,
        x: X0 + bb.x0, y: Y0 + bb.y0, w: sw, h: sh,        // riquadro della sagoma in px pagina
        sil: silC, ink: inkS, fill: silN / (sw * sh), density, rect, touches,
        usable: !touches && density < 0.85 && rect >= 0.6 && sw * sh >= pageArea * 0.025,
      });
    }
    return cands;
  }

  // ---------- riconoscimento viste ----------
  function matchViews(cands, W, D, H) {
    const roles = { front: [W, H], side: [D, H], top: [W, D] };
    const usable = cands.filter(c => c.usable);
    const err = (c, [a, b]) => Math.abs(Math.log((c.w / c.h) / (a / b)));
    const TOL = 0.1;
    const pick = (role, pref) => {
      const list = usable.map(c => ({ c, e: err(c, roles[role]) })).filter(o => o.e < TOL);
      if (!list.length) return null;
      list.sort((p, q) => (pref ? pref(p.c) - pref(q.c) : 0) || p.e - q.e || q.c.w * q.c.h - p.c.w * p.c.h);
      return list[0].c;
    };
    // fronte: la più grande tra quelle compatibili (a parità di errore)
    const frontList = usable.map(c => ({ c, e: err(c, roles.front) })).filter(o => o.e < TOL)
      .sort((p, q) => (q.c.w * q.c.h) - (p.c.w * p.c.h));
    const front = frontList.length ? frontList[0].c : null;
    const near = (a, b) => Math.abs(Math.log(a / b));
    const side = pick('side', front ? c => (c === front ? 9 : 0) + (c.page === front.page ? near(c.h, front.h) : 0.5) : null);
    const top = pick('top', front ? c => (c === front || c === side ? 9 : 0) + (c.page === front.page ? near(c.w, front.w) : 0.5) : null);
    const res = { front, side: side !== front ? side : null, top: top !== front && top !== side ? top : null };
    // con L≈P fronte e fianco possono coincidere: va bene usare la stessa sagoma
    return res;
  }

  // ---------- misure dalla sagoma ----------
  /** Profilo per righe: per ogni riga, segmenti pieni [x0,x1) in px. */
  function rowRuns(v, y) {
    const out = []; let s = -1;
    for (let x = 0; x <= v.w; x++) {
      const on = x < v.w && v.sil[y * v.w + x];
      if (on && s < 0) s = x;
      if (!on && s >= 0) { out.push([s, x]); s = -1; }
    }
    return out;
  }
  /** Linee interne lunghe (inchiostro) verticali/orizzontali: posizioni in px e frazione di lunghezza. */
  function longLines(v, dir, minFrac, span) {
    const res = [];
    const [a0, a1] = span || [0, dir === 'v' ? v.w : v.h];
    const len = dir === 'v' ? v.h : v.w;
    for (let k = a0; k < a1; k++) {
      let best = 0, run = 0;
      for (let t = 0; t < len; t++) {
        const on = dir === 'v' ? v.ink[t * v.w + k] : v.ink[k * v.w + t];
        if (on) { run++; if (run > best) best = run; } else run = 0;
      }
      if (best >= len * minFrac) res.push({ pos: k, frac: best / len });
    }
    // raggruppa linee adiacenti (spessori, doppie linee)
    const groups = [];
    for (const r of res) {
      const g = groups[groups.length - 1];
      if (g && r.pos - g.p1 <= 3) { g.p1 = r.pos; g.frac = Math.max(g.frac, r.frac); }
      else groups.push({ p0: r.pos, p1: r.pos, frac: r.frac });
    }
    return groups;
  }
  function linesInSpan(v, dir, minFrac, from, to) {
    // linee orizzontali (dir 'h') misurate solo tra x=from..to (o verticali tra y)
    const res = [];
    const lenSpan = to - from;
    const n = dir === 'h' ? v.h : v.w;
    for (let k = 0; k < n; k++) {
      let best = 0, run = 0;
      for (let t = from; t < to; t++) {
        const on = dir === 'h' ? v.ink[k * v.w + t] : v.ink[t * v.w + k];
        if (on) { run++; if (run > best) best = run; } else run = 0;
      }
      if (best >= lenSpan * minFrac) res.push(k);
    }
    const groups = [];
    for (const p of res) {
      const g = groups[groups.length - 1];
      if (g && p - g.p1 <= 3) g.p1 = p; else groups.push({ p0: p, p1: p });
    }
    return groups;
  }

  /** Misure generali dal fronte (cm): cornice, base (zoccolo/piedini). */
  function frontProfile(v, W, H) {
    const sx = W / v.w, sy = H / v.h;
    const widths = [], gaps = [];
    for (let y = 0; y < v.h; y++) {
      const runs = rowRuns(v, y);
      widths.push(runs.reduce((s, r) => s + r[1] - r[0], 0));
      gaps.push(runs.length);
    }
    const mid = widths.slice(Math.floor(v.h * 0.3), Math.floor(v.h * 0.7)).sort((a, b) => a - b);
    const body = mid[Math.floor(mid.length / 2)] || v.w;
    let top = 0; while (top < v.h * 0.25 && widths[top] > body * 1.01 + 2) top++;
    let bot = v.h - 1; while (bot > v.h * 0.6 && (widths[bot] < body * 0.97 - 2 || gaps[bot] > 1)) bot--;
    const baseRows = v.h - 1 - bot;
    const feet = baseRows > 0 && gaps.slice(bot + 1).filter(g => g > 1).length > baseRows * 0.5;
    return {
      bodyW: body * sx,
      corniceH: top * sy,
      corniceOver: top ? (v.w - body) / 2 * sx : 0,
      baseH: baseRows * sy,
      feet,
    };
  }

  /** Armadio a ponte dal fronte: larghezza colonne e altezza del ponte (cm). */
  function bridgeFromFront(v, W, H) {
    const sx = W / v.w, sy = H / v.h;
    const vl = longLines(v, 'v', 0.9);
    // escludi i bordi esterni
    const inner = vl.filter(g => g.p0 > v.w * 0.04 && g.p1 < v.w * 0.96);
    const leftG = inner.filter(g => g.p1 < v.w * 0.45);
    const rightG = inner.filter(g => g.p0 > v.w * 0.55);
    if (!leftG.length || !rightG.length) return null;
    const xL = leftG[leftG.length - 1].p1 + 1, xR = rightG[0].p0;
    const hl = linesInSpan(v, 'h', 0.8, xL, xR).filter(g => g.p0 > v.h * 0.06 && g.p1 < v.h * 0.85);
    if (!hl.length) return null;
    const yB = hl[0].p1 + 1;
    return { colL: xL * sx, colR: (v.w - xR) * sx, bridgeH: yB * sy };
  }

  // ---------- solido dalle sagome (visual hull) ----------
  /** Campiona una sagoma in coordinate normalizzate u,v ∈ [0,1] (v=0 in alto nel disegno). */
  function sampler(v, flipX) {
    return (u, t) => {
      if (!v) return 1;
      let x = Math.floor((flipX ? 1 - u : u) * v.w), y = Math.floor(t * v.h);
      if (x < 0) x = 0; if (x >= v.w) x = v.w - 1; if (y < 0) y = 0; if (y >= v.h) y = v.h - 1;
      return v.sil[y * v.w + x];
    };
  }
  /** Lato "alto" del fianco: la metà più alta va verso la parete (dietro). */
  function sideBackIsLeft(v) {
    if (!v) return true;
    const colH = x => { let n = 0; for (let y = 0; y < v.h; y++) n += v.sil[y * v.w + x]; return n; };
    let l = 0, r = 0;
    for (let x = 0; x < v.w; x++) (x < v.w / 2 ? (l += colH(x)) : (r += colH(x)));
    return l >= r;
  }

  /**
   * Voxel: X (larghezza) da sinistra, Y (altezza) dal basso, Z (profondità) dal retro (0) al fronte (D).
   * Restituisce {nx,ny,nz,vox,cell} con cell in metri.
   */
  function hullVoxels(views, W, D, H, maxCells) {
    const cell = Math.max(W, D, H) / (maxCells || 140);
    const nx = Math.max(2, Math.round(W / cell)), ny = Math.max(2, Math.round(H / cell)), nz = Math.max(2, Math.round(D / cell));
    const F = sampler(views.front, false);
    const backLeft = sideBackIsLeft(views.side);
    const S = sampler(views.side, !backLeft);       // u=0 → retro
    const T = sampler(views.top, false);            // pianta: in alto il retro (convenzione di disegno)
    const vox = new Uint8Array(nx * ny * nz);
    for (let z = 0; z < nz; z++) {
      const uz = (z + 0.5) / nz;
      for (let y = 0; y < ny; y++) {
        const ty = 1 - (y + 0.5) / ny;
        if (!S(uz, ty)) continue;
        for (let x = 0; x < nx; x++) {
          const ux = (x + 0.5) / nx;
          if (F(ux, ty) && T(ux, uz)) vox[(z * ny + y) * nx + x] = 1;
        }
      }
    }
    return { nx, ny, nz, vox, cell: { x: W / nx, y: H / ny, z: D / nz } };
  }

  /** Greedy meshing delle facce esposte: restituisce array di posizioni (triangoli) e normali. */
  function meshVoxels(g) {
    const { nx, ny, nz, vox } = g;
    const dims = [nx, ny, nz];
    const at = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) ? 0 : vox[(z * ny + y) * nx + x];
    const pos = [], nor = [];
    for (let d = 0; d < 3; d++) {
      const u = (d + 1) % 3, v = (d + 2) % 3;
      const q = [0, 0, 0]; q[d] = 1;
      const mask = new Int8Array(dims[u] * dims[v]);
      const x = [0, 0, 0];
      for (x[d] = -1; x[d] < dims[d];) {
        let n = 0;
        for (x[v] = 0; x[v] < dims[v]; x[v]++) for (x[u] = 0; x[u] < dims[u]; x[u]++) {
          const a = at(x[0], x[1], x[2]), b = at(x[0] + q[0], x[1] + q[1], x[2] + q[2]);
          mask[n++] = a === b ? 0 : a ? 1 : -1;
        }
        x[d]++;
        n = 0;
        for (let j = 0; j < dims[v]; j++) for (let i = 0; i < dims[u];) {
          const c = mask[n];
          if (!c) { i++; n++; continue; }
          let wdt = 1; while (i + wdt < dims[u] && mask[n + wdt] === c) wdt++;
          let hgt = 1, done = false;
          for (; j + hgt < dims[v]; hgt++) {
            for (let k = 0; k < wdt; k++) if (mask[n + k + hgt * dims[u]] !== c) { done = true; break; }
            if (done) break;
          }
          const b = [0, 0, 0]; b[d] = x[d]; b[u] = i; b[v] = j;
          const du = [0, 0, 0]; du[u] = wdt;
          const dv = [0, 0, 0]; dv[v] = hgt;
          const p0 = b, p1 = [b[0] + du[0], b[1] + du[1], b[2] + du[2]], p2 = [b[0] + du[0] + dv[0], b[1] + du[1] + dv[1], b[2] + du[2] + dv[2]], p3 = [b[0] + dv[0], b[1] + dv[1], b[2] + dv[2]];
          const nn = [0, 0, 0]; nn[d] = c;
          const tri = c > 0 ? [p0, p1, p2, p0, p2, p3] : [p0, p2, p1, p0, p3, p2];
          for (const p of tri) { pos.push(p[0], p[1], p[2]); nor.push(nn[0], nn[1], nn[2]); }
          for (let l = 0; l < hgt; l++) for (let k = 0; k < wdt; k++) mask[n + k + l * dims[u]] = 0;
          i += wdt; n += wdt;
        }
      }
    }
    return { pos, nor };
  }

  return { MAX_PAGES, openDoc, renderPage, renderPages, analyzePage, matchViews, frontProfile, bridgeFromFront, hullVoxels, meshVoxels, sideBackIsLeft };
})();
