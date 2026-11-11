// ==UserScript==
// @name         Mondo Convenienza → modello 3D (GLB)
// @namespace    https://github.com/mondoconv-3d
// @version      0.4.1
// @description  Aggiunge un pulsante alle pagine prodotto di mondoconv.it che genera un modello 3D parametrico (.glb) a partire da misure, struttura e colori della scheda prodotto.
// @match        https://www.mondoconv.it/*
// @match        https://mondoconv.it/*
// @require      https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js#sha256=f34446bf875b5fb0dcd93819ffe1d9e182d46634ee855f5d904c6c4ac7cdbc95
// @require      https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/controls/OrbitControls.js#sha256=b4c6e53f98538535b11fd6655627d47fb5877b3ad972568bff0a7026c4b6d5c4
// @require      https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/exporters/GLTFExporter.js#sha256=7ba9cf5888ff8c11768ff805d50081c383a91ae4dbf487750065bbbeccd45077
// @require      https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/environments/RoomEnvironment.js#sha256=251b4e779abb5b432f99a326878fe239747c1fe55f390933085fc3deb20d2cea
// @require      https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/build/pdf.min.js#sha256=1fc294eefda602e591a06c1d5af361cae23756b5a334fc2421d5f9accce038e5
// @require      https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/build/pdf.worker.min.js#sha256=99732130603cd4980f009a29a38a86373b43ffb9ae22c35ec85440f311ceddfc
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      media.mondoconv.it
// @inject-into  content
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Funzionamento in breve
 * 1. Sulle pagine prodotto (URL tipo /sirio-gkpz.html) compare il pulsante "3D".
 * 2. Al clic lo script legge la riga "Descrizione completa" del prodotto, es.
 *      SIRIO ARMADIO 6 ANTE BATTENTI L.274 P.55 H.247 COLORE OLMO
 *    e ne ricava tipo, misure (cm), numero di ante, cassetti, specchi, colori.
 * 3. Un generatore parametrico costruisce il mobile in Three.js (unità: metri,
 *    asse Y verso l'alto, fronte del mobile verso +Z, origine a terra al centro).
 * 4. Anteprima ruotabile, poi export .glb (glTF binario) scaricato dal browser.
 * I tipi non ancora gestiti producono un volume "segnaposto" con misure e colore.
 */

// ===== Analisi schede tecniche =====
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

// ===== Script principale =====
(function () {
  'use strict';

  const VERSION = '0.4.1';
  const PRODUCT_PATH_RE = /^\/[a-z0-9-]+-([a-z0-9]{4})\.html$/i;
  const LOG = [];
  const log = (...a) => {
    const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    LOG.push(line);
    if (LOG.length > 200) LOG.shift();
  };

  // ---------------------------------------------------------------------------
  // 1. LETTURA DATI DALLA PAGINA
  // ---------------------------------------------------------------------------

  const NUM = '(\\d+(?:[.,]\\d+)?)';
  const LPH_RE = new RegExp('^(.*?)\\s*\\bL\\.?\\s*' + NUM + '\\s+P\\.?\\s*' + NUM + '\\s+H\\.?\\s*' + NUM + '(.*)$', 'i');
  const CM_RE = /^cm\.?\s*(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)$/i;
  const toNum = s => parseFloat(String(s).replace(',', '.'));

  function ownText(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** Trova l'elemento più specifico (testo più corto) che soddisfa la regex. */
  function findSmallestMatch(re, maxLen) {
    let best = null;
    const all = document.body.querySelectorAll('*');
    for (const el of all) {
      if (el.id === 'mc3d-host' || el.closest('#mc3d-host')) continue;
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'svg') continue;
      const t = ownText(el);
      if (!t || t.length > maxLen) continue;
      const m = t.match(re);
      if (m && (!best || t.length < best.text.length)) best = { el, text: t, m };
    }
    return best;
  }

  function findAllMatches(re, maxLen) {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('#mc3d-host')) continue;
      if (el.children.length > 0) continue; // solo foglie
      const t = ownText(el);
      if (t && t.length <= maxLen && re.test(t)) out.push(t);
    }
    return out;
  }

  function metaContent(prop) {
    const m = document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`);
    return m ? m.getAttribute('content') || '' : '';
  }

  function readPage() {
    const info = { url: location.href, warnings: [], source: null };
    const pm = location.pathname.match(PRODUCT_PATH_RE);
    info.code = pm ? pm[1].toUpperCase() : null;

    // a) riga "Descrizione completa" (preferita: è unica per il prodotto corrente)
    const desc = findSmallestMatch(LPH_RE, 400);
    if (desc) {
      const m = desc.m;
      info.source = 'descrizione';
      info.rawLine = desc.text;
      info.head = m[1].trim();
      info.W = toNum(m[2]);
      info.D = toNum(m[3]);
      info.H = toNum(m[4]);
      info.tail = m[5].trim();
    } else {
      // b) ripiego: riga "cm. 274 x 55 x 247" + titolo pagina
      const cm = findSmallestMatch(CM_RE, 40);
      if (cm) {
        info.source = 'misure+titolo';
        info.rawLine = cm.text;
        info.W = toNum(cm.m[1]);
        info.D = toNum(cm.m[2]);
        info.H = toNum(cm.m[3]);
        const title = (document.title || metaContent('og:title')).split('|')[0];
        // "Armadio 6 ante battenti olmo: Sirio"
        const [left, coll] = title.split(':');
        info.head = ((coll || '').trim() + ' ' + (left || '').trim()).toUpperCase();
        info.tail = '';
        info.warnings.push('Descrizione completa non trovata: dati ricavati da misure e titolo (meno affidabili).');
      }
    }

    // c) testo generale per caratteristiche (ripiani, maniglie, piedini...)
    const body = (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ');
    info.bodyText = body;

    // d) controllo pagina "vecchia" (sito a pagina singola: il contenuto può arrivare in ritardo)
    const cod = body.match(/codice:\s*([A-Z0-9]{4})\b/);
    info.pageCode = cod ? cod[1] : null;
    if (info.code && info.pageCode && info.code !== info.pageCode) {
      info.warnings.push(`Il codice in pagina (${info.pageCode}) non coincide con l'URL (${info.code}): la pagina potrebbe non essere ancora aggiornata. Se il modello non corrisponde, attendi e riprova.`);
    }

    // e) immagine prodotto (per campionare colori sconosciuti)
    info.imageUrl = findProductImage(info.code);
    return info;
  }

  function findProductImage(code) {
    const imgs = [...document.querySelectorAll('img')]
      .map(i => i.currentSrc || i.src || '')
      .filter(s => /media\.mondoconv\.it\/media\/catalog\/product/.test(s));
    if (code) {
      const hit = imgs.find(s => s.toUpperCase().includes('/' + code + '_') || s.toUpperCase().includes('/' + code + '.'));
      if (hit) return hit;
    }
    const og = metaContent('og:image');
    if (og && (!code || og.toUpperCase().includes(code))) return og;
    return imgs[0] || og || null;
  }

  // ---------------------------------------------------------------------------
  // 2. INTERPRETAZIONE (tipo, struttura, colori)
  // ---------------------------------------------------------------------------

  const NUM_WORDS = { UN: 1, UNO: 1, UNA: 1, DUE: 2, TRE: 3, QUATTRO: 4, CINQUE: 5, SEI: 6, SETTE: 7, OTTO: 8, NOVE: 9, DIECI: 10 };
  const wordNum = s => (/^\d+$/.test(s) ? parseInt(s, 10) : NUM_WORDS[s.toUpperCase()] || null);

  // Tipi gestiti dal generatore "mobile a corpo" (carcassa + frontali)
  const CABINET_TYPES = [
    ['cabina', /\bCABINA ARMADIO\b|\bCABINA\b/],
    ['armadio', /\bARMADI(O|ETTO)\b|\bGUARDAROBA\b|\bTERMINALE\b|\bPONTE\b|\bELEMENTO\b|\bCAMERA\b(?=.*\bANT[EA]\b)/],
    ['scarpiera', /\bSCARPIER/],
    ['madia', /\bMADIA\b|\bCREDENZA\b|\bBUFFET\b/],
    ['vetrina', /\bVETRIN/],
    ['colonna', /\bCOLONNA\b/],
    ['libreria', /\bLIBRERI|\bSCAFFAL|\bBOISERIE\b/],
    ['cassettiera', /\bCASSETTIER|\bSETTIMANALE\b|\bCOM[OÒ]'?\b/],
    ['comodino', /\bCOMODIN/],
    ['pensile', /\bPENSIL/],
    ['mobile', /\bMOBILE\b|\bMOBILETTO\b/],
  ];

  // Tipi gestiti dal generatore "tavolo" (piano + gambe)
  const TABLE_TYPES = [
    ['tavolino', /\bTAVOLIN|\bTAVOLO DA SALOTTO\b|\bCOFFEE\b/],
    ['scrivania', /\bSCRIVANI/],
    ['consolle', /\bCONSOLL/],
    ['tavolo', /\bTAVOL[OI]\b/],
  ];

  // Altre famiglie: [categoria, famiglia, regex]. Verificate per prime.
  const OTHER_TYPES = [
    ['divano', 'sofa', /\bDIVAN|\bPOLTRON|\bCHAISE LONGUE\b|\bSOFA\b/],
    ['letto', 'bed', /\bLETT[OI]\b|\bTESTIER|\bGIROLETTO\b/],
    ['rete', 'rete', /\bRETE\b|\bRETI\b/],
    ['materasso', 'box', /\bMATERASS|\bTOPPER\b|\bPOUF\b/],
    ['cucina', 'kitchen', /\bCUCINA\b|\bCUCINE\b/],
    ['sedia', 'chair', /\bSEDI[AE]\b|\bSGABELL/],
  ];

  function interpret(info) {
    const head = (info.head || '').toUpperCase();
    const spec = {
      W: info.W / 100, D: info.D / 100, H: info.H / 100,
      notes: [], category: null, collection: null, label: '',
    };

    for (const [cat, fam, re] of OTHER_TYPES) {
      const m = head.match(re);
      if (m) {
        spec.category = cat; spec.family = fam;
        spec.collection = head.slice(0, m.index).trim() || null;
        spec.label = head.slice(m.index).trim();
        break;
      }
    }
    if (!spec.category) for (const [cat, re] of TABLE_TYPES.concat(CABINET_TYPES)) {
      const m = head.match(re);
      if (m) {
        spec.category = cat;
        spec.family = TABLE_TYPES.some(x => x[0] === cat) ? 'table' : 'cabinet';
        spec.collection = head.slice(0, m.index).trim() || null;
        spec.label = head.slice(m.index).trim();
        break;
      }
    }
    if (!spec.category && /\b\d+\s+(ANT[EA]|CASSETT)/.test(head)) {
      spec.category = 'mobile'; spec.family = 'cabinet';
      const w = head.split(' ');
      spec.collection = w[0] || null;
      spec.label = w.slice(1).join(' ');
    }
    if (!spec.category) {
      const w = head.split(' ');
      spec.collection = w[0] || null;
      spec.label = w.slice(1).join(' ');
    }

    // --- frontali
    const ante = head.match(/(\d+|UNA|DUE|TRE|QUATTRO|CINQUE|SEI)\s+ANT[EA]\b/);
    spec.doors = ante ? wordNum(ante[1]) : 0;
    const cass = head.match(/(\d+|UN|UNO|DUE|TRE|QUATTRO|CINQUE|SEI)\s+CASSETT/);
    spec.drawers = cass ? wordNum(cass[1]) : 0;
    spec.sliding = /SCORREVOL/.test(head);
    spec.flap = /RIBALT/.test(head);
    spec.longDoors = /ANTE LUNGHE/.test(head);
    spec.openSection = /A GIORNO/.test(head);
    const rip = head.match(/(\d+)\s+RIPIANI/);
    spec.shelvesTotal = rip ? parseInt(rip[1], 10) : null;

    // specchi
    spec.mirror = 'none';
    if (/SPECCHIAT/.test(head)) spec.mirror = 'all';
    else if (/SPECCHIO CENTRALE|SPECCHI CENTRALI/.test(head)) spec.mirror = 'center';
    else if (/SPECCHIO A DESTRA|SPECCHIO DESTR/.test(head)) spec.mirror = 'right';
    else if (/SPECCHIO A SINISTRA|SPECCHIO SINISTR/.test(head)) spec.mirror = 'left';
    else if (/SPECCHIO/.test(head)) spec.mirror = 'center';

    // --- caratteristiche dal testo della pagina
    const body = info.bodyText || '';
    const rip2 = body.match(/(\d+|un|uno|una|due|tre|quattro|cinque|sei|sette|otto)\s+ripian[oi]/i);
    if (spec.shelvesTotal == null && rip2) spec.shelvesTotal = wordNum(rip2[1]);
    const tubi = body.match(/(\d+|un|uno|due|tre|quattro|cinque|sei|sette|otto)\s+tub[oi]\s+appendiabit/i);
    spec.rods = tubi ? wordNum(tubi[1]) : null;
    spec.feet = /piedin/i.test(body) && !/senza piedini/i.test(body);
    const han = body.match(/manigli[ae][^.]{0,80}?(nel colore dell['’ ]anta|cromo|cromat|alluminio|acciaio|nero|nera|oro|ottone|bronzo|legno|bianc)/i);
    spec.handleHint = han ? han[1].toLowerCase() : null;
    spec.pushOpen = /apertura a pressione|push[- ]?pull|tip[- ]?on|senza maniglie|maniglia a gola|apertura a gola|con gola\b/i.test(body);

    // --- colori: "COLORE OLMO", "COLORE TITANIO / BIANCO LUCIDO"
    let colorStr = '';
    const cm = (info.tail || '').match(/COLORE\s+(.+?)(?:\s+-\s+|$)/i);
    if (cm) colorStr = cm[1];
    if (!colorStr) {
      const rv = (info.tail || '').match(/RIVESTIMENTO\s+(.+?)(?:\s+-\s+|$)/i);
      if (rv) colorStr = rv[1];
    }
    if (!colorStr) {
      const t = (metaContent('og:title') || document.title || '').split(':')[0];
      // "Armadio 6 ante battenti olmo" → ultime parole dopo il nome del prodotto: difficile, usiamo la riga H2 del colore se c'è
      colorStr = t;
    }
    spec.colorNames = colorStr.split(/\s*[\/,]\s*/).map(s => s.trim()).filter(Boolean);
    // "BIANCO OPACO MANIGLIA NOCE RIVA": la parte dopo MANIGLIA indica la finitura delle maniglie
    spec.colorNames = spec.colorNames.map(n => {
      const mm = n.match(/^(.*?)\s+MANIGLI[AE]\s+(.+)$/i);
      if (mm) { spec.handleColor = mm[2]; return mm[1]; }
      return n;
    });

    // --- divani
    if (spec.family === 'sofa') {
      const ps = head.match(/(\d)\s*POSTI/);
      spec.seats = ps ? +ps[1] : /POLTRON/.test(head) ? 1 : null;
      if (/DOPPIO ANGOLO/.test(head)) spec.chaise = 'both';
      else if (/PENISOLA|ANGOLAR|CHAISE|POUF CONTENITORE/.test(head)) {
        spec.chaise = /SINISTR/.test(head) ? 'L' : 'R';
        if (/REVERSIBIL/.test(head)) spec.chaiseNote = 'Penisola reversibile: generata a destra (guardando il divano).';
        else if (!/DESTR|SINISTR/.test(head)) spec.chaiseNote = 'Lato della penisola non indicato: generata a destra.';
      } else spec.chaise = 'none';
    }
    // --- letti
    if (spec.family === 'bed') {
      spec.storage = /CONTENITOR/.test(head);
      spec.feet = /PIEDIN/.test(head) || (spec.feet && !/SENZA PIEDINI/.test(head));
    }
    if (spec.family === 'chair') spec.stool = /SGABELL/.test(head);

    // --- tavoli: allungabile, forma, vetro
    if (spec.family === 'table') {
      spec.extendable = /RADDOPPIABIL|ALLUNGABIL|ESTENSIBIL|ALLUNGA\b|\bA LIBRO\b/.test(head);
      const mx = head.match(/MAX\.?\s*(\d+(?:[.,]\d+)?)\s*CM/);
      spec.maxW = mx ? toNum(mx[1]) / 100 : null;
      if (spec.extendable && !spec.maxW && /RADDOPPIABIL/.test(head)) spec.maxW = spec.W * 2;
      spec.round = /ROTOND|\bTOND|CIRCOLAR|OVAL/.test(head);
      spec.oval = /OVAL/.test(head);
      spec.glassTop = /VETRO/.test(head) || spec.colorNames.some(n => /vetro|cristallo/i.test(n));
      spec.lowerShelf = /RIPIANO|CONTENITORE|PORTARIVISTE/.test(head);
      spec.pedestal = /BASAMENTO|CENTRALE|COLONNA/.test(head);
      if (spec.extendable && !spec.maxW) spec.notes.push('Tavolo allungabile: misura da aperto non indicata, generato solo chiuso.');
    }

    // --- coerenza misure
    if (!(spec.W > 0.05 && spec.D > 0.05 && spec.H > 0.05) || spec.W > 8 || spec.D > 8 || spec.H > 4) {
      spec.invalid = true;
    }
    if (spec.family === 'cabinet' && (spec.category === 'cabina' || /ANGOLAR/.test(head))) spec.notes.push('Forma angolare semplificata: generato come mobile rettangolare con le stesse misure di ingombro.');
    if (/\bCAMERA\b/.test(head) && spec.family === 'cabinet') spec.notes.push('Composizione camera: generato l\'armadio (misure indicate); comò, comodini e letto sono prodotti separati.');
    if (/\bPONTE\b/.test(head) && spec.family === 'cabinet') {
      spec.bridge = true;
      // composizione ante: "(1+4+1)"; se assente si stima 1 anta per colonna
      const comp = head.match(/\(\s*(\d+)\s*\+\s*(\d+)\s*\+\s*(\d+)\s*\)/);
      if (comp) spec.bridgeDoors = [+comp[1], +comp[2], +comp[3]];
      else {
        const n = spec.doors || 6;
        spec.bridgeDoors = n >= 3 ? [1, n - 2, 1] : [1, Math.max(1, n - 1), 0];
        spec.notes.push(`Composizione ante non indicata: stimata ${spec.bridgeDoors.join('+')}.`);
      }
    }
    if (spec.openSection) spec.notes.push('Vano a giorno: posizione stimata (colonna a destra).');
    return spec;
  }

  // Finiture note: [chiave (minuscolo), {c: colore, r: rugosità, m: metallicità, kind: wood|stone}]
  // L'ordine conta: le chiavi più specifiche vanno prima.
  const FINISHES = [
    ['rovere grigio', { c: '#9c958a', r: 0.65, kind: 'wood' }],
    ['rovere sbiancato', { c: '#d9cfbd', r: 0.65, kind: 'wood' }],
    ['rovere cadiz', { c: '#a8865d', r: 0.6, kind: 'wood' }],
    ['rovere naturale', { c: '#b9925f', r: 0.6, kind: 'wood' }],
    ['rovere', { c: '#ad8a5f', r: 0.6, kind: 'wood' }],
    ['quercia bianc', { c: '#dbd2c2', r: 0.65, kind: 'wood' }],
    ['quercia', { c: '#ac8a5f', r: 0.6, kind: 'wood' }],
    ['noce oro', { c: '#9c6b3d', r: 0.55, kind: 'wood' }],
    ['noce', { c: '#6e4b33', r: 0.55, kind: 'wood' }],
    ['olmo', { c: '#8e6b4d', r: 0.6, kind: 'wood' }],
    ['ciliegio', { c: '#8d4c2f', r: 0.5, kind: 'wood' }],
    ['frassin', { c: '#b9a588', r: 0.6, kind: 'wood' }],
    ['fiammato', { c: '#efebe3', r: 0.6, kind: 'wood' }],
    ['castagno', { c: '#7b5637', r: 0.6, kind: 'wood' }],
    ['teak', { c: '#8b5b35', r: 0.6, kind: 'wood' }],
    ['wenge', { c: '#3c2b21', r: 0.6, kind: 'wood' }],
    ['wengè', { c: '#3c2b21', r: 0.6, kind: 'wood' }],
    ['acero', { c: '#dbc49c', r: 0.6, kind: 'wood' }],
    ['faggio', { c: '#c99c6c', r: 0.6, kind: 'wood' }],
    ['larice', { c: '#bb9b75', r: 0.6, kind: 'wood' }],
    ['pino', { c: '#caa56d', r: 0.6, kind: 'wood' }],
    ['canapa', { c: '#bba98a', r: 0.65, kind: 'wood' }],
    ['legno', { c: '#a27a52', r: 0.6, kind: 'wood' }],
    ['cemento', { c: '#9b978f', r: 0.9, kind: 'stone' }],
    ['ossido', { c: '#5b4b3f', r: 0.8, kind: 'stone' }],
    ['ardesia', { c: '#4c5053', r: 0.8, kind: 'stone' }],
    ['marmo', { c: '#e6e3de', r: 0.3, kind: 'stone' }],
    ['pietra', { c: '#8f8a82', r: 0.85, kind: 'stone' }],
    ['bianco lucido', { c: '#f5f5f3', r: 0.12 }],
    ['bianco laccato', { c: '#f6f6f3', r: 0.18 }],
    ['bianco opaco', { c: '#f0efeb', r: 0.75 }],
    ['bianco neve', { c: '#f7f7f5', r: 0.6 }],
    ['bianco', { c: '#f1f0ec', r: 0.55 }],
    ['white', { c: '#f1f0ec', r: 0.55 }],
    ['nero lucido', { c: '#151515', r: 0.12 }],
    ['nero', { c: '#1d1d1d', r: 0.5 }],
    ['black', { c: '#1d1d1d', r: 0.5 }],
    ['antracite', { c: '#3b3d3f', r: 0.6 }],
    ['titanio', { c: '#6f6a64', r: 0.55 }],
    ['grigio chiaro', { c: '#b9babb', r: 0.6 }],
    ['grigio', { c: '#8e9091', r: 0.6 }],
    ['grey', { c: '#8e9091', r: 0.6 }],
    ['tortora', { c: '#a49585', r: 0.6 }],
    ['visone', { c: '#8b7b6d', r: 0.6 }],
    ['cashmere', { c: '#cabca9', r: 0.6 }],
    ['sabbia', { c: '#ccbea0', r: 0.6 }],
    ['beige', { c: '#d7c8a9', r: 0.6 }],
    ['crema', { c: '#e9ddc3', r: 0.6 }],
    ['avorio', { c: '#ede5d1', r: 0.6 }],
    ['verde salvia', { c: '#9caf94', r: 0.6 }],
    ['verde', { c: '#5e7b5b', r: 0.6 }],
    ['azzurro', { c: '#90b1ca', r: 0.6 }],
    ['blu', { c: '#2f4b6c', r: 0.6 }],
    ['rosa', { c: '#d9aaa5', r: 0.6 }],
    ['rosso', { c: '#9c2e2b', r: 0.5 }],
    ['bordeaux', { c: '#5e1f24', r: 0.55 }],
    ['senape', { c: '#c49b3b', r: 0.6 }],
    ['giallo', { c: '#dab64b', r: 0.6 }],
    ['marrone', { c: '#5c4131', r: 0.6 }],
    ['bronzo', { c: '#6c5541', r: 0.5 }],
    ['cromo', { c: '#d9d9d9', r: 0.12, m: 1 }],
    ['cromat', { c: '#d9d9d9', r: 0.12, m: 1 }],
    ['acciaio', { c: '#b6b6b6', r: 0.3, m: 1 }],
    ['alluminio', { c: '#c5c7c9', r: 0.35, m: 1 }],
    ['ottone', { c: '#b6923f', r: 0.3, m: 1 }],
    ['oro', { c: '#c9a24a', r: 0.3, m: 1 }],
  ];

  function lookupFinish(name) {
    const n = (name || '').toLowerCase().replace(/^effetto\s+/, '').replace(/\s+manigli[ae].*$/, '');
    let best = null;
    for (const [k, v] of FINISHES) {
      const i = n.indexOf(k);
      if (i < 0) continue;
      // vince la finitura che compare prima nel nome; a parità, la chiave più lunga (più specifica)
      if (!best || i < best.i || (i === best.i && k.length > best.k.length)) best = { i, k, v };
    }
    return best ? Object.assign({ name: name.replace(/\s+MANIGLI[AE].*$/i, ''), key: best.k }, best.v) : null;
  }

  // ---------------------------------------------------------------------------
  // 3. CAMPIONAMENTO COLORE DALL'IMMAGINE (solo se il nome colore è sconosciuto)
  // ---------------------------------------------------------------------------

  function fetchBlob(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('GM_xmlhttpRequest non disponibile'));
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob', timeout: 10000,
        onload: r => (r.status >= 200 && r.status < 300 ? resolve(r.response) : reject(new Error('HTTP ' + r.status))),
        onerror: () => reject(new Error('errore rete')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  async function sampleImageColor(url) {
    const blob = await fetchBlob(url);
    const bmp = await createImageBitmap(blob);
    const S = 96;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, S, S);
    const d = ctx.getImageData(0, 0, S, S).data;
    const rs = [], gs = [], bs = [];
    for (let y = Math.floor(S * 0.2); y < S * 0.8; y++) {
      for (let x = Math.floor(S * 0.2); x < S * 0.8; x++) {
        const i = (y * S + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mn > 225 && mx - mn < 12) continue; // sfondo bianco/grigio chiaro
        rs.push(r); gs.push(g); bs.push(b);
      }
    }
    if (rs.length < 50) throw new Error('pochi pixel utili');
    const med = a => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
    const hex = '#' + [med(rs), med(gs), med(bs)].map(v => v.toString(16).padStart(2, '0')).join('');
    return hex;
  }

  async function resolveFinishes(spec, info) {
    const list = spec.colorNames.map(n => lookupFinish(n) || { name: n, unknown: true });
    for (const f of list) {
      if (!f.unknown) continue;
      f.c = '#b3aa9d'; f.r = 0.6;
      if (info.imageUrl) {
        try {
          f.c = await sampleImageColor(info.imageUrl);
          f.sampled = true;
          spec.notes.push(`Colore "${f.name}" non in tabella: tinta campionata dalla foto (${f.c}).`);
        } catch (e) {
          log('campionamento fallito', String(e));
          spec.notes.push(`Colore "${f.name}" non riconosciuto: usato un neutro.`);
        }
      } else {
        spec.notes.push(`Colore "${f.name}" non riconosciuto: usato un neutro.`);
      }
    }
    if (!list.length) {
      list.push({ name: 'neutro', c: '#b3aa9d', r: 0.6, unknown: true });
      spec.notes.push('Nessun colore trovato: usato un neutro.');
    }
    return list;
  }

  // ---------------------------------------------------------------------------
  // 4. MATERIALI (PBR) E TEXTURE PROCEDURALI
  // ---------------------------------------------------------------------------

  function seededRandom(seedStr) {
    let h = 2166136261;
    for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  function shade(hex, f) {
    const c = new THREE.Color(hex);
    const r = Math.min(255, Math.max(0, Math.round(c.r * 255 * f)));
    const g = Math.min(255, Math.max(0, Math.round(c.g * 255 * f)));
    const b = Math.min(255, Math.max(0, Math.round(c.b * 255 * f)));
    return `rgb(${r},${g},${b})`;
  }

  /** Venatura legno verticale (lungo l'asse V della texture). */
  function woodTexture(hex, seed) {
    const W = 256, H = 512;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const rnd = seededRandom(seed);
    ctx.fillStyle = shade(hex, 1); ctx.fillRect(0, 0, W, H);
    // fibre lunghe
    for (let i = 0; i < 140; i++) {
      const x = rnd() * W;
      const w = 0.5 + rnd() * 2.5;
      const f = 0.86 + rnd() * 0.26;
      ctx.strokeStyle = shade(hex, f);
      ctx.globalAlpha = 0.25 + rnd() * 0.35;
      ctx.lineWidth = w;
      ctx.beginPath();
      const amp = 2 + rnd() * 6, freq = 0.004 + rnd() * 0.01, ph = rnd() * 6.28;
      for (let y = 0; y <= H; y += 8) {
        const xx = x + Math.sin(y * freq + ph) * amp;
        if (y === 0) ctx.moveTo(xx, y); else ctx.lineTo(xx, y);
      }
      ctx.stroke();
    }
    // qualche "fiamma" più scura
    for (let i = 0; i < 6; i++) {
      const x = rnd() * W, y = rnd() * H, w = 6 + rnd() * 14, h = 60 + rnd() * 160;
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = shade(hex, 0.8);
      ctx.beginPath(); ctx.ellipse(x, y, w, h, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    return makeTexture(cv);
  }

  /** Effetto cemento / pietra: macchie morbide. */
  function stoneTexture(hex, seed) {
    const S = 256;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d');
    const rnd = seededRandom(seed);
    ctx.fillStyle = shade(hex, 1); ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 400; i++) {
      const r = 2 + rnd() * 18;
      ctx.globalAlpha = 0.05 + rnd() * 0.08;
      ctx.fillStyle = shade(hex, 0.8 + rnd() * 0.4);
      ctx.beginPath(); ctx.arc(rnd() * S, rnd() * S, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    return makeTexture(cv);
  }

  function makeTexture(canvas) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.encoding = THREE.sRGBEncoding;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.userData.mimeType = 'image/jpeg'; // GLB più leggero
    return tex;
  }

  /** Colore sRGB (come nei cataloghi) → valore lineare usato da Three.js e dal formato glTF. */
  const lin = c => new THREE.Color(c).convertSRGBToLinear();

  function makeMaterial(f, name, opts) {
    opts = opts || {};
    const params = { name, roughness: f.r != null ? f.r : 0.6, metalness: f.m || 0 };
    if (!opts.noTextures && f.kind === 'wood') { params.map = woodTexture(f.c, f.name || name); params.color = 0xffffff; }
    else if (!opts.noTextures && f.kind === 'stone') { params.map = stoneTexture(f.c, f.name || name); params.color = 0xffffff; }
    else params.color = lin(f.c);
    return new THREE.MeshStandardMaterial(params);
  }

  function buildMaterials(spec, finishes, opts) {
    const a = finishes[0];
    const b = finishes[1] || finishes[0];
    const [body, front] = opts.swap ? [b, a] : [a, b];
    const roles = spec.family === 'table' ? ['Piano_', 'Gambe_'] : spec.family === 'sofa' ? ['Struttura_', 'Cuscini_'] : ['Struttura_', 'Frontali_'];
    const mats = {
      body: makeMaterial(body, roles[0] + body.name, opts),
      front: makeMaterial(front, roles[1] + front.name, opts),
      back: new THREE.MeshStandardMaterial({ name: 'Schienale', color: lin(body.kind === 'wood' ? body.c : '#d8d4cc'), roughness: 0.8 }),
      mirror: new THREE.MeshStandardMaterial({ name: 'Specchio', color: lin(0xe8eef2), roughness: 0.04, metalness: 1 }),
      glass: new THREE.MeshStandardMaterial({ name: 'Vetro', color: lin(0xdfeceb), roughness: 0.05, metalness: 0, transparent: true, opacity: 0.3 }),
      rod: new THREE.MeshStandardMaterial({ name: 'Tubo_appendiabiti', color: lin(0xcfcfcf), roughness: 0.25, metalness: 1 }),
    };
    // maniglie
    const h = (spec.handleColor || spec.handleHint || '').toLowerCase();
    if (/colore dell/.test(h)) mats.handle = mats.front;
    else {
      const hf = lookupFinish(h) || (spec.handleColor && finishes.find(f => f.name && h.includes(f.name.toLowerCase()))) || FINISHES.find(x => x[0] === 'alluminio')[1];
      mats.handle = new THREE.MeshStandardMaterial({ name: 'Maniglie', color: lin(hf.c), roughness: hf.r != null ? hf.r : 0.35, metalness: hf.m != null ? hf.m : 0.2 });
    }
    mats.feet = /cromo|cromat/.test(h) ? mats.handle : new THREE.MeshStandardMaterial({ name: 'Piedini', color: lin(0x2a2a2a), roughness: 0.5 });
    return mats;
  }

  // ---------------------------------------------------------------------------
  // 5. GENERATORI GEOMETRIA
  // ---------------------------------------------------------------------------

  function box(group, name, w, h, d, x, y, z, mat) {
    if (w <= 0.0005 || h <= 0.0005 || d <= 0.0005) return null;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.name = name;
    m.position.set(x, y, z);
    group.add(m);
    return m;
  }

  function cyl(group, name, r, len, x, y, z, mat, axis) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 16), mat);
    m.name = name;
    if (axis === 'x') m.rotation.z = Math.PI / 2;
    m.position.set(x, y, z);
    group.add(m);
    return m;
  }

  /**
   * Generatore "mobile a corpo": armadi, madie, colonne, librerie, cassettiere...
   * Sistema di riferimento: X larghezza (centrata), Y altezza (0 = pavimento), Z profondità (fronte = +D/2).
   */
  function buildCabinet(spec, mats) {
    const g = new THREE.Group();
    const { W, D, H } = spec;
    const t = 0.018;                       // spessore pannelli
    const isOpen = spec.category === 'libreria' && spec.doors === 0 && spec.drawers === 0;
    const hasFronts = !isOpen && (spec.doors > 0 || spec.drawers > 0 || spec.flap);
    const doorT = hasFronts ? 0.018 : 0;
    const gapZ = hasFronts ? 0.002 : 0;
    const Dc = D - doorT - gapZ;           // profondità carcassa
    const zBack = -D / 2;
    const zc = zBack + Dc / 2;             // centro carcassa
    const zFrontC = zBack + Dc;            // filo anteriore carcassa
    const tall = H > 1.3;

    // zoccolo o piedini
    const wall = spec.category === 'pensile';
    const base = wall ? 0 : spec.baseOverride != null ? spec.baseOverride : spec.feet ? (tall ? 0.08 : 0.1) : (tall ? 0.07 : 0.05);
    const sidesFromFloor = !wall && !spec.feet;

    // fianchi
    const sideH = sidesFromFloor ? H : H - base;
    const sideY = sidesFromFloor ? H / 2 : base + sideH / 2;
    box(g, 'Fianco_SX', t, sideH, Dc, -W / 2 + t / 2, sideY, zc, mats.body);
    box(g, 'Fianco_DX', t, sideH, Dc, W / 2 - t / 2, sideY, zc, mats.body);
    // cielo e fondo
    const innerW = W - 2 * t;
    box(g, 'Cielo', innerW, t, Dc, 0, H - t / 2, zc, mats.body);
    box(g, 'Fondo', innerW, t, Dc, 0, base + t / 2, zc, mats.body);
    // schienale
    box(g, 'Schienale', innerW, H - base - 2 * t, 0.004, 0, base + (H - base) / 2, zBack + 0.002, mats.back);
    // zoccolo / piedini
    if (!wall) {
      if (spec.feet) {
        const r = 0.014, ix = W / 2 - 0.05, iz = Dc / 2 - 0.05;
        [[-ix, -iz], [ix, -iz], [-ix, iz], [ix, iz]].forEach(([x, z], i) =>
          cyl(g, 'Piedino_' + (i + 1), r, base, x, base / 2, zc + z, mats.feet));
      } else {
        box(g, 'Zoccolo', innerW, base, t, 0, base / 2, zFrontC - 0.02 - t / 2, mats.body);
      }
    }

    // --- layout frontali
    const fy0 = base, fy1 = H;          // area frontale verticale
    const fronts = [];                  // {x0,x1,y0,y1,kind,hinge,mirror,glass}
    let columns = [];                   // moduli interni [{x0,x1,open}]

    let openColW = 0;
    if (spec.openSection && hasFronts) {
      openColW = Math.min(0.4, W * 0.3);
    }
    const fx0 = -W / 2, fx1 = W / 2 - openColW;

    if (isOpen) {
      const nCol = Math.max(1, Math.round(W / 0.8));
      for (let i = 0; i < nCol; i++) columns.push({ x0: -W / 2 + (W * i) / nCol, x1: -W / 2 + (W * (i + 1)) / nCol, open: true });
    } else {
      const nD = spec.doors;
      const nK = spec.longDoors ? 0 : spec.drawers;   // con "ante lunghe" i cassetti sono interni
      if (spec.longDoors && spec.drawers) spec.notes.push(`${spec.drawers} cassetti interni (dietro le ante): non visibili, non modellati.`);
      const onlyDrawers = nD === 0 && nK > 0 && !spec.flap;
      const madiaLayout = nD >= 2 && nK >= 2 && W >= 1.2 && H < 1.3 && !spec.sliding;

      if (onlyDrawers) {
        // cassettiera: cassetti impilati su tutta la larghezza (2 colonne se molto larga)
        const cols = W > 1.0 && nK >= 6 && nK % 2 === 0 ? 2 : 1;
        const rows = nK / cols;
        for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
          fronts.push({ x0: fx0 + ((fx1 - fx0) * c) / cols, x1: fx0 + ((fx1 - fx0) * (c + 1)) / cols, y0: fy0 + ((fy1 - fy0) * r) / rows, y1: fy0 + ((fy1 - fy0) * (r + 1)) / rows, kind: 'drawer' });
        }
        columns.push({ x0: fx0, x1: fx1 });
      } else if (madiaLayout) {
        // madia: ante ai lati, colonna centrale di cassetti
        const colW = Math.min(0.6, (fx1 - fx0) / 3);
        const cx0 = (fx0 + fx1) / 2 - colW / 2, cx1 = cx0 + colW;
        const leftN = Math.ceil(nD / 2), rightN = nD - leftN;
        addDoors(fronts, fx0, cx0, fy0, fy1, leftN, spec);
        addDoors(fronts, cx1, fx1, fy0, fy1, rightN, spec);
        for (let r = 0; r < nK; r++) fronts.push({ x0: cx0, x1: cx1, y0: fy0 + ((fy1 - fy0) * r) / nK, y1: fy0 + ((fy1 - fy0) * (r + 1)) / nK, kind: 'drawer' });
        columns.push({ x0: fx0, x1: cx0 }, { x0: cx0, x1: cx1 }, { x0: cx1, x1: fx1 });
        spec.notes.push('Disposizione madia stimata: ante ai lati, cassetti al centro.');
      } else {
        // cassetti in basso (se presenti), ante sopra
        let dTop = fy0;
        if (nK > 0) {
          const kh = Math.min(0.19, ((fy1 - fy0) * 0.45) / nK);
          for (let r = 0; r < nK; r++) fronts.push({ x0: fx0, x1: fx1, y0: fy0 + kh * r, y1: fy0 + kh * (r + 1), kind: 'drawer' });
          dTop = fy0 + kh * nK;
        }
        if (spec.flap) {
          const nF = Math.max(1, nD || 1);
          for (let i = 0; i < nF; i++) fronts.push({ x0: fx0 + ((fx1 - fx0) * i) / nF, x1: fx0 + ((fx1 - fx0) * (i + 1)) / nF, y0: dTop, y1: fy1, kind: 'flap' });
        } else if (nD > 0) {
          if (spec.sliding) addSliding(fronts, fx0, fx1, dTop, fy1, nD);
          else addDoors(fronts, fx0, fx1, dTop, fy1, nD, spec);
        } else if (nK === 0) {
          spec.notes.push('Numero di ante/cassetti non indicato: generato senza frontali.');
        }
        // moduli interni: uno ogni 2 ante battenti (o per anta scorrevole)
        const nMod = spec.sliding ? Math.max(1, nD) : Math.max(1, Math.ceil(Math.max(nD, 1) / 2));
        for (let i = 0; i < nMod; i++) columns.push({ x0: fx0 + ((fx1 - fx0) * i) / nMod, x1: fx0 + ((fx1 - fx0) * (i + 1)) / nMod });
      }
      if (openColW > 0) columns.push({ x0: fx1, x1: W / 2, open: true });
      applyMirrors(fronts, spec);
      if (spec.category === 'vetrina') fronts.forEach(f => { if (f.kind === 'door') f.glass = true; });
    }

    // --- divisori verticali interni
    for (let i = 1; i < columns.length; i++) {
      const x = columns[i].x0;
      box(g, 'Divisorio_' + i, t, H - base - 2 * t, Dc - 0.004, x, base + (H - base) / 2, zc + 0.002, mats.body);
    }

    // --- interni: ripiani e tubi
    const innerH0 = base + t, innerH1 = H - t;
    const wardrobe = (spec.category === 'armadio' || spec.category === 'cabina') && H > 1.6;
    const nCols = columns.length;
    let shelvesPerCol;
    if (spec.shelvesTotal != null) shelvesPerCol = Math.max(0, Math.round(spec.shelvesTotal / nCols));
    else if (wardrobe) shelvesPerCol = 1;
    else shelvesPerCol = Math.max(0, Math.floor((innerH1 - innerH0) / 0.36) - 1);
    const rodsPerCol = wardrobe ? (spec.rods != null ? Math.max(0, Math.round(spec.rods / nCols)) : 1) : 0;

    columns.forEach((c, ci) => {
      const cx0 = c.x0 + (ci === 0 ? t : t / 2), cx1 = c.x1 - (ci === nCols - 1 ? t : t / 2);
      const w = cx1 - cx0, cx = (cx0 + cx1) / 2;
      const hasDrawersBelow = fronts.some(f => f.kind === 'drawer' && f.x0 < c.x1 - 0.01 && f.x1 > c.x0 + 0.01);
      if (wardrobe && !c.open) {
        // ripiano cappelliera + tubo
        const sy = innerH1 - 0.32;
        if (shelvesPerCol > 0) box(g, `Ripiano_${ci + 1}_1`, w, t, Dc - 0.03, cx, sy, zc + 0.01, mats.body);
        for (let k = 1; k < shelvesPerCol; k++) box(g, `Ripiano_${ci + 1}_${k + 1}`, w, t, Dc - 0.03, cx, sy - 0.35 * k, zc + 0.01, mats.body);
        if (rodsPerCol > 0) cyl(g, `Tubo_${ci + 1}`, 0.0125, w, cx, sy - t / 2 - 0.06, zc, mats.rod, 'x');
      } else if (!hasDrawersBelow || c.open) {
        const n = c.open ? Math.max(1, Math.floor((innerH1 - innerH0) / 0.36)) : shelvesPerCol;
        for (let k = 1; k <= n; k++) {
          const y = innerH0 + ((innerH1 - innerH0) * k) / (n + 1);
          box(g, `Ripiano_${ci + 1}_${k}`, w, t, Dc - 0.03, cx, y, zc + 0.01, mats.body);
        }
      }
    });

    // --- frontali (ante, cassetti, ribalte) + maniglie
    const gap = 0.004;
    const zDoor = D / 2 - doorT / 2;
    fronts.forEach((f, i) => {
      const w = f.x1 - f.x0 - gap, h = f.y1 - f.y0 - gap;
      const cx = (f.x0 + f.x1) / 2, cy = (f.y0 + f.y1) / 2;
      const z = f.track === 1 ? zDoor - doorT - 0.004 : zDoor;
      const label = f.kind === 'drawer' ? 'Cassetto' : f.kind === 'flap' ? 'Ribalta' : 'Anta';
      if (f.glass) {
        // telaio + vetro
        const fr = 0.05;
        box(g, `${label}_${i + 1}_telaio_SX`, fr, h, doorT, f.x0 + gap / 2 + fr / 2, cy, z, mats.front);
        box(g, `${label}_${i + 1}_telaio_DX`, fr, h, doorT, f.x1 - gap / 2 - fr / 2, cy, z, mats.front);
        box(g, `${label}_${i + 1}_telaio_SU`, w - 2 * fr, fr, doorT, cx, f.y1 - gap / 2 - fr / 2, z, mats.front);
        box(g, `${label}_${i + 1}_telaio_GIU`, w - 2 * fr, fr, doorT, cx, f.y0 + gap / 2 + fr / 2, z, mats.front);
        box(g, `${label}_${i + 1}_vetro`, w - 2 * fr, h - 2 * fr, 0.004, cx, cy, z, mats.glass);
      } else {
        box(g, `${label}_${i + 1}`, w, h, doorT, cx, cy, z, mats.front);
      }
      if (f.mirror) box(g, `${label}_${i + 1}_specchio`, w - 0.04, h - 0.04, 0.004, cx, cy, z + doorT / 2 + 0.002, mats.mirror);
      if (!spec.pushOpen) addHandle(g, f, i, z + doorT / 2, mats.handle, spec);
    });

    if (spec.pushOpen) spec.notes.push('Apertura senza maniglie (a pressione/gola): maniglie non generate.');
    return g;
  }

  function addDoors(fronts, x0, x1, y0, y1, n, spec) {
    if (n <= 0) return;
    const w = (x1 - x0) / n;
    for (let i = 0; i < n; i++) {
      // ante accoppiate: la prima di ogni coppia ha cerniera a sinistra, la seconda a destra;
      // un'anta singola rimasta in fondo apre con cerniera a destra (maniglia a sinistra)
      let hinge;
      if (n === 1) hinge = 'L';
      else if (i === n - 1 && n % 2 === 1) hinge = 'R';
      else hinge = i % 2 === 0 ? 'L' : 'R';
      fronts.push({ x0: x0 + w * i, x1: x0 + w * (i + 1), y0, y1, kind: 'door', hinge });
    }
  }

  function addSliding(fronts, x0, x1, y0, y1, n) {
    const ov = 0.03;
    const w = (x1 - x0) / n;
    for (let i = 0; i < n; i++) {
      const a = Math.max(x0, x0 + w * i - (i > 0 ? ov / 2 : 0));
      const b = Math.min(x1, x0 + w * (i + 1) + (i < n - 1 ? ov / 2 : 0));
      fronts.push({ x0: a, x1: b, y0, y1, kind: 'door', sliding: true, track: i % 2, hinge: i % 2 === 0 ? 'L' : 'R' });
    }
  }

  function applyMirrors(fronts, spec) {
    const doors = fronts.filter(f => f.kind === 'door');
    if (!doors.length || spec.mirror === 'none') return;
    if (spec.mirror === 'all') doors.forEach(d => (d.mirror = true));
    else if (spec.mirror === 'right') doors[doors.length - 1].mirror = true;
    else if (spec.mirror === 'left') doors[0].mirror = true;
    else {
      const n = doors.length;
      if (n % 2 === 0 && n >= 4) { doors[n / 2 - 1].mirror = true; doors[n / 2].mirror = true; }
      else doors[Math.floor(n / 2)].mirror = true;
    }
  }

  function addHandle(g, f, i, zFace, mat, spec) {
    const w = f.x1 - f.x0, h = f.y1 - f.y0;
    const off = 0.025, s = 0.012;
    const name = `Maniglia_${i + 1}`;
    if (f.kind === 'drawer') {
      const len = Math.min(0.25, w * 0.4);
      const y = f.y0 + h * 0.62;
      box(g, name, len, s, s, (f.x0 + f.x1) / 2, y, zFace + off, mat);
      box(g, name + '_a', s, s, off, (f.x0 + f.x1) / 2 - len / 2 + s, y, zFace + off / 2, mat);
      box(g, name + '_b', s, s, off, (f.x0 + f.x1) / 2 + len / 2 - s, y, zFace + off / 2, mat);
    } else if (f.kind === 'flap') {
      const len = Math.min(0.25, w * 0.4);
      const y = f.y1 - 0.05;
      box(g, name, len, s, s, (f.x0 + f.x1) / 2, y, zFace + off, mat);
    } else if (f.sliding) {
      // profilo verticale sul bordo di presa
      const x = f.hinge === 'L' ? f.x1 - 0.015 : f.x0 + 0.015;
      box(g, name, 0.02, h - 0.01, 0.02, x, (f.y0 + f.y1) / 2, zFace + 0.01, mat);
    } else {
      const len = Math.min(h > 1.4 ? 0.3 : 0.16, h * 0.4);
      const x = f.hinge === 'L' ? f.x1 - 0.045 : f.x0 + 0.045;
      // altezza maniglia: ~105 cm da terra per ante alte, centro anta altrimenti
      let y = h > 1.4 ? 1.05 : spec.category === 'pensile' ? f.y0 + len / 2 + 0.04 : (f.y0 + f.y1) / 2;
      y = Math.min(f.y1 - len / 2 - 0.03, Math.max(f.y0 + len / 2 + 0.03, y));
      box(g, name, s, len, s, x, y, zFace + off, mat);
      box(g, name + '_a', s, s, off, x, y - len / 2 + s, zFace + off / 2, mat);
      box(g, name + '_b', s, s, off, x, y + len / 2 - s, zFace + off / 2, mat);
    }
  }

  /**
   * Generatore "tavolo": tavoli da pranzo, tavolini, scrivanie, consolle.
   * Colori: il primo nome è il piano, il secondo le gambe/struttura (invertibili dal pannello).
   */
  function buildTable(spec, mats, open) {
    const g = new THREE.Group();
    const W = open && spec.maxW ? spec.maxW : spec.W;
    const D = spec.D, H = spec.H;
    const coffee = spec.category === 'tavolino' || H < 0.6;
    const topT = spec.P && spec.P.topT ? spec.P.topT : spec.glassTop ? 0.012 : (spec.extendable && !open && /RADDOPPIABIL|A LIBRO/.test(spec.label) ? 0.05 : 0.03);
    const topMat = spec.glassTop ? mats.glass : mats.body;
    const legMat = spec.glassTop && mats.body === mats.front ? mats.handle : mats.front;
    const yTop = H - topT / 2;

    // piano
    if (spec.round && !open) {
      const top = new THREE.Mesh(new THREE.CylinderGeometry(W / 2, W / 2, topT, 64), topMat);
      top.name = 'Piano';
      top.scale.z = D / W;
      top.position.y = yTop;
      g.add(top);
    } else {
      box(g, 'Piano', W, topT, D, 0, yTop, 0, topMat);
      if (spec.extendable && !open && /RADDOPPIABIL|A LIBRO/.test(spec.label)) {
        // piano a libro chiuso: due ante sovrapposte, linea di separazione
        box(g, 'Piano_linea', W + 0.001, 0.002, D + 0.001, 0, yTop, 0, mats.back);
      }
    }

    const legH = H - topT;
    if (spec.round && !open) {
      // tavolo tondo: colonna centrale + base
      const r = coffee ? 0.04 : 0.05;
      cyl(g, 'Colonna', r, legH - 0.02, 0, (legH - 0.02) / 2 + 0.02, 0, legMat);
      const baseR = Math.min(W, D) * (coffee ? 0.32 : 0.28);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(baseR, baseR, 0.02, 48), legMat);
      base.name = 'Base';
      base.position.y = 0.01;
      g.add(base);
    } else if (spec.pedestal) {
      // basamento centrale rettangolare
      box(g, 'Basamento', Math.min(0.5, W * 0.4), legH, Math.min(0.4, D * 0.4), 0, legH / 2, 0, legMat);
      box(g, 'Base', W * 0.6, 0.02, D * 0.5, 0, 0.01, 0, legMat);
    } else {
      // 4 gambe quadrate + fascia sottopiano
      const ls = spec.P && spec.P.legW ? spec.P.legW : coffee ? 0.045 : spec.category === 'consolle' ? 0.04 : 0.06;
      const inset = 0.03;
      const lx = W / 2 - inset - ls / 2, lz = D / 2 - inset - ls / 2;
      [[-lx, -lz], [lx, -lz], [-lx, lz], [lx, lz]].forEach(([x, z], i) =>
        box(g, 'Gamba_' + (i + 1), ls, legH, ls, x, legH / 2, z, legMat));
      if (!spec.glassTop) {
        const fh = coffee ? 0.05 : 0.08, ft = 0.02;
        const fy = legH - fh / 2;
        box(g, 'Fascia_fronte', 2 * lx - ls, fh, ft, 0, fy, lz + ls / 2 - ft / 2, legMat);
        box(g, 'Fascia_retro', 2 * lx - ls, fh, ft, 0, fy, -lz - ls / 2 + ft / 2, legMat);
        box(g, 'Fascia_SX', ft, fh, 2 * lz - ls, -lx - ls / 2 + ft / 2, fy, 0, legMat);
        box(g, 'Fascia_DX', ft, fh, 2 * lz - ls, lx + ls / 2 - ft / 2, fy, 0, legMat);
      }
      if (coffee && spec.lowerShelf) box(g, 'Ripiano_inferiore', 2 * lx - ls, 0.02, 2 * lz - ls, 0, 0.12, 0, mats.body);
      if (spec.category === 'scrivania' && spec.drawers > 0) {
        // cassettiera sospesa a destra sotto il piano
        const cw = Math.min(0.42, W * 0.35), ch = Math.min(0.15 * spec.drawers, legH * 0.5);
        const cx = lx - ls / 2 - cw / 2 - 0.005;
        box(g, 'Cassettiera', cw, ch, D - 2 * inset - ls, cx, legH - ch / 2, 0, mats.body);
        for (let k = 0; k < spec.drawers; k++) {
          const y = legH - (ch / spec.drawers) * (k + 0.5);
          box(g, 'Maniglia_cassetto_' + (k + 1), Math.min(0.15, cw * 0.4), 0.012, 0.012, cx, y, D / 2 - inset - ls / 2 + 0.02, mats.handle);
        }
      }
    }
    if (open && spec.maxW) spec.notes.push(`Versione aperta: piano allungato a ${Math.round(spec.maxW * 100)} cm.`);
    if (spec.round && open) spec.notes.push('Tavolo tondo aperto: rappresentato con piano rettangolare arrotondato semplificato.');
    return g;
  }

  /** Armadio a ponte: colonne a terra + pensile sopra il vano letto (misure in cm nei parametri). */
  function buildBridge(spec, mats) {
    const bp = { colL: spec.P.colL * 100, colR: spec.P.colR * 100, bridgeH: spec.P.bridgeH * 100, bridgeD: spec.P.bridgeD * 100 };
    const g = new THREE.Group();
    const W = spec.W, D = spec.D, H = spec.H;
    const colL = bp.colL / 100, colR = bp.colR / 100, bH = bp.bridgeH / 100, bD = Math.min(bp.bridgeD / 100, D);
    const midW = W - colL - colR;
    if (midW < 0.3) throw new Error('Parametri ponte non validi: il vano centrale risulta ' + Math.round(midW * 100) + ' cm');
    const [nl, nm, nr] = spec.bridgeDoors;
    const sub = (w, d, h, doors, cat) => Object.assign({}, spec, {
      W: w, D: d, H: h, doors, drawers: 0, category: cat, bridge: false, notes: [],
      shelvesTotal: null, rods: null, mirror: 'none', openSection: false, flap: false, sliding: false, longDoors: false,
    });
    const place = (obj, name, x, y, z) => { obj.name = name; obj.position.set(x, y, z); g.add(obj); };
    if (colL > 0) place(buildCabinet(sub(colL, D, H, nl, 'armadio'), mats), 'Colonna_SX', -W / 2 + colL / 2, 0, 0);
    if (colR > 0) place(buildCabinet(sub(colR, D, H, nr, 'armadio'), mats), 'Colonna_DX', W / 2 - colR / 2, 0, 0);
    // pensile: appoggiato alla parete (schiena a -D/2), sotto il cielo delle colonne
    place(buildCabinet(sub(midW, bD, bH, nm, 'pensile'), mats), 'Ponte', -W / 2 + colL + midW / 2, H - bH, -D / 2 + bD / 2);
    spec.bridgeInfo = { vanoW: Math.round(midW * 100), luce: Math.round((H - bH) * 100) };
    return g;
  }

  // ---------------------------------------------------------------------------
  // PARAMETRI DI FORMA (cm): origine 'scheda' (misurato sul disegno), 'stima', 'utente'
  // ---------------------------------------------------------------------------

  function defineParams(spec, sheet, saved) {
    const W = spec.W * 100, D = spec.D * 100, H = spec.H * 100;
    const list = [];
    const views = sheet && sheet.views;
    const add = (k, label, v, src) => list.push({ k, label, v: Math.round(v * 10) / 10, src });
    if (spec.bridge) {
      const [nl, , nr] = spec.bridgeDoors;
      const colDef = Math.min(47, W / 4);
      const m = sheet && sheet.bridge;
      add('colL', 'Largh. colonna SX', m ? m.colL : nl ? colDef * nl : 0, m ? 'scheda' : 'stima');
      add('colR', 'Largh. colonna DX', m ? m.colR : nr ? colDef * nr : 0, m ? 'scheda' : 'stima');
      add('bridgeH', 'Altezza ponte', m ? m.bridgeH : Math.min(62, H * 0.4), m ? 'scheda' : 'stima');
      add('bridgeD', 'Profondità ponte', D, 'stima');
    } else if (spec.family === 'cabinet' && spec.category !== 'pensile') {
      const pr = sheet && sheet.profile;
      const tall = H > 130;
      const baseEst = spec.feet ? (tall ? 8 : 10) : (tall ? 7 : 5);
      add('baseH', spec.feet ? 'Altezza piedini' : 'Altezza zoccolo', pr && pr.baseH >= 2 ? pr.baseH : baseEst, pr && pr.baseH >= 2 ? 'scheda' : 'stima');
      add('corniceH', 'Altezza cornice', pr && pr.corniceH >= 1.5 ? pr.corniceH : 0, pr ? 'scheda' : 'stima');
      add('corniceOver', 'Sporgenza cornice', pr && pr.corniceH >= 1.5 ? pr.corniceOver : 0, pr ? 'scheda' : 'stima');
    } else if (spec.family === 'table') {
      const book = spec.extendable && /RADDOPPIABIL|A LIBRO/.test(spec.label);
      add('topT', 'Spessore piano', spec.glassTop ? 1.2 : book ? 5 : 3, 'stima');
      add('legW', 'Lato gamba', spec.category === 'tavolino' || H < 60 ? 4.5 : spec.category === 'consolle' ? 4 : 6, 'stima');
    } else if (spec.family === 'sofa') {
      const ang = spec.chaise !== 'none';
      add('seatH', 'Altezza seduta', 45, 'stima');
      add('armH', 'Altezza braccioli', Math.min(62, H * 0.75), 'stima');
      add('armW', 'Larghezza bracciolo', spec.noArms ? 0 : 15, 'stima');
      add('backD', 'Profondità schienale', 22, 'stima');
      if (ang) {
        add('mainD', 'Profondità seduta (parte lineare)', Math.min(95, D * 0.62), 'stima');
        add('chaiseW', 'Larghezza penisola', Math.max(65, Math.min(100, W * 0.38)), 'stima');
      }
    } else if (spec.family === 'bed') {
      add('frameH', 'Altezza giroletto', spec.storage ? 37 : 30, 'stima');
      add('headT', 'Spessore testiera', 8, 'stima');
      add('feetH', 'Altezza piedini', spec.feet ? 10 : 0, 'stima');
    } else if (spec.family === 'kitchen') {
      add('baseH', 'Altezza basi (con top)', Math.min(90, H), 'stima');
      add('wallH', 'Altezza pensili', H > 150 ? 72 : 0, 'stima');
      add('wallD', 'Profondità pensili', 35, 'stima');
    } else if (spec.family === 'chair') {
      add('seatH', 'Altezza seduta', Math.min(46, H * 0.55), 'stima');
      add('legW', 'Lato gamba', 3.5, 'stima');
    }
    if (saved) list.forEach(p => { if (saved[p.k] != null && isFinite(saved[p.k])) { p.v = saved[p.k]; p.src = 'utente'; } });
    const P = {};
    list.forEach(p => (P[p.k] = p.v / 100));
    return { list, P };
  }

  // ---------------------------------------------------------------------------
  // ALTRI GENERATORI
  // ---------------------------------------------------------------------------

  /** Mobile con eventuale cornice superiore misurata sul disegno. */
  function buildCabinetFull(spec, mats) {
    const P = spec.P || {};
    const cH = P.corniceH || 0, cO = P.corniceOver || 0;
    if (P.baseH != null) spec.baseOverride = P.baseH;
    if (cH < 0.01) return buildCabinet(spec, mats);
    const g = new THREE.Group();
    const body = buildCabinet(Object.assign({}, spec, { W: spec.W - 2 * cO, D: spec.D - cO, H: spec.H - cH, notes: spec.notes }), mats);
    body.position.z = -cO / 2;
    g.add(body);
    box(g, 'Cornice', spec.W, cH, spec.D, 0, spec.H - cH / 2, 0, mats.front);
    return g;
  }

  /** Divano lineare / angolare / doppio angolo / poltrona. */
  function buildSofa(spec, mats) {
    const g = new THREE.Group();
    const { W, D, H } = spec, P = spec.P;
    const z0 = -D / 2;
    const chR = spec.chaise === 'R' || spec.chaise === 'both';
    const chL = spec.chaise === 'L' || spec.chaise === 'both';
    const md = spec.chaise !== 'none' ? Math.min(P.mainD, D) : D;
    const armL = chL ? 0 : P.armW, armR = chR ? 0 : P.armW;
    const cushT = 0.15, baseTop = Math.max(0.1, P.seatH - cushT);
    const xs0 = -W / 2 + armL, xs1 = W / 2 - armR, sw = xs1 - xs0;
    // struttura seduta e schienale
    box(g, 'Base_seduta', sw, baseTop, md, (xs0 + xs1) / 2, baseTop / 2, z0 + md / 2, mats.body);
    box(g, 'Schienale_struttura', sw, H * 0.92, P.backD * 0.5, (xs0 + xs1) / 2, H * 0.46, z0 + P.backD * 0.25, mats.body);
    if (armL > 0) box(g, 'Bracciolo_SX', armL, P.armH, md, -W / 2 + armL / 2, P.armH / 2, z0 + md / 2, mats.body);
    if (armR > 0) box(g, 'Bracciolo_DX', armR, P.armH, md, W / 2 - armR / 2, P.armH / 2, z0 + md / 2, mats.body);
    // cuscini
    const n = Math.max(1, spec.seats || Math.round(sw / 0.65));
    const cw = sw / n, gap = 0.01;
    for (let i = 0; i < n; i++) {
      const cx = xs0 + cw * (i + 0.5);
      box(g, `Cuscino_seduta_${i + 1}`, cw - gap, cushT, md - P.backD - gap, cx, baseTop + cushT / 2, z0 + P.backD + (md - P.backD) / 2, mats.front);
      box(g, `Cuscino_schienale_${i + 1}`, cw - gap, H - P.seatH - 0.03, P.backD * 0.5, cx, P.seatH + (H - P.seatH - 0.03) / 2, z0 + P.backD * 0.75, mats.front);
    }
    // penisole
    const chaise = (side) => {
      const cw2 = Math.min(P.chaiseW, W / (spec.chaise === 'both' ? 2 : 1));
      const x = side === 'R' ? W / 2 - cw2 / 2 : -W / 2 + cw2 / 2;
      const dz = D - md;
      if (dz < 0.05) return;
      box(g, `Penisola_${side === 'R' ? 'DX' : 'SX'}_base`, cw2, baseTop, dz, x, baseTop / 2, z0 + md + dz / 2, mats.body);
      box(g, `Penisola_${side === 'R' ? 'DX' : 'SX'}_cuscino`, cw2 - gap, cushT, dz - gap, x, baseTop + cushT / 2, z0 + md + dz / 2, mats.front);
    };
    if (chR) chaise('R');
    if (chL) chaise('L');
    if (spec.chaiseNote) spec.notes.push(spec.chaiseNote);
    return g;
  }

  /** Letto: testiera + giroletto (contenitore pieno) + eventuali piedini. */
  function buildBed(spec, mats) {
    const g = new THREE.Group();
    const { W, D, H } = spec, P = spec.P;
    const ht = Math.min(P.headT, D * 0.2);
    box(g, 'Testiera', W, H, ht, 0, H / 2, -D / 2 + ht / 2, mats.body);
    const fh = Math.max(0.05, P.frameH - P.feetH);
    const fd = D - ht;
    box(g, spec.storage ? 'Contenitore' : 'Giroletto', W, fh, fd, 0, P.feetH + fh / 2, -D / 2 + ht + fd / 2, mats.body);
    if (P.feetH > 0) {
      const ix = W / 2 - 0.05, z1 = -D / 2 + ht + 0.05, z2 = D / 2 - 0.05;
      [[-ix, z1], [ix, z1], [-ix, z2], [ix, z2]].forEach(([x, z], i) => cyl(g, 'Piedino_' + (i + 1), 0.02, P.feetH, x, P.feetH / 2, z, mats.feet));
    }
    // piano rete (solo visivo, leggermente più chiaro)
    box(g, 'Piano_rete', W - 0.08, 0.01, fd - 0.06, 0, P.frameH + 0.005, -D / 2 + ht + fd / 2, mats.back);
    return g;
  }

  /** Rete a doghe con gambe (senza disegno disponibile). */
  function buildRete(spec, mats) {
    const g = new THREE.Group();
    const { W, D, H } = spec;
    const ft = 0.05, y = H - ft / 2;
    box(g, 'Telaio_SX', 0.04, ft, D, -W / 2 + 0.02, y, 0, mats.feet);
    box(g, 'Telaio_DX', 0.04, ft, D, W / 2 - 0.02, y, 0, mats.feet);
    box(g, 'Telaio_testa', W, ft, 0.04, 0, y, -D / 2 + 0.02, mats.feet);
    box(g, 'Telaio_piedi', W, ft, 0.04, 0, y, D / 2 - 0.02, mats.feet);
    const n = Math.max(6, Math.round(D / 0.12));
    for (let i = 0; i < n; i++) box(g, 'Doga_' + (i + 1), W - 0.08, 0.012, 0.06, 0, H - 0.01, -D / 2 + 0.08 + (D - 0.16) * i / (n - 1), mats.body);
    const legs = [[-1, -1], [1, -1], [-1, 1], [1, 1], [-1, 0], [1, 0]];
    legs.forEach(([sx, sz], i) => box(g, 'Gamba_' + (i + 1), 0.035, H - ft, 0.035, sx * (W / 2 - 0.03), (H - ft) / 2, sz * (D / 2 - 0.03), mats.feet));
    return g;
  }

  /** Cucina lineare: basi con top + pensili. */
  function buildKitchen(spec, mats) {
    const g = new THREE.Group();
    const { W, D, H } = spec, P = spec.P;
    const nMod = Math.max(1, Math.round(W / 0.6));
    const sub = (w, d, h, doors, cat) => Object.assign({}, spec, {
      W: w, D: d, H: h, doors, drawers: 0, category: cat, family: 'cabinet', bridge: false, notes: [], feet: false,
      shelvesTotal: null, rods: null, mirror: 'none', openSection: false, flap: false, sliding: false, longDoors: false, baseOverride: 0.1,
    });
    const top = 0.04;
    const bases = buildCabinet(sub(W, D - 0.02, P.baseH - top, nMod, 'madia'), mats);
    bases.name = 'Basi'; bases.position.z = -0.01; g.add(bases);
    box(g, 'Top', W, top, D, 0, P.baseH - top / 2, 0, mats.body);
    if (P.wallH > 0.05) {
      const wd = Math.min(P.wallD, D);
      const wall = buildCabinet(sub(W, wd, P.wallH, nMod, 'pensile'), mats);
      wall.name = 'Pensili'; wall.position.set(0, H - P.wallH, -D / 2 + wd / 2); g.add(wall);
    }
    spec.notes.push('Cucina: moduli da ~60 cm stimati; elettrodomestici non modellati.');
    return g;
  }

  /** Sedia / sgabello. */
  function buildChair(spec, mats) {
    const g = new THREE.Group();
    const { W, D, H } = spec, P = spec.P;
    const lw = P.legW, st = 0.04;
    box(g, 'Seduta', W, st, D, 0, P.seatH - st / 2, 0, mats.body);
    const lx = W / 2 - lw / 2, lz = D / 2 - lw / 2;
    [[-lx, -lz], [lx, -lz], [-lx, lz], [lx, lz]].forEach(([x, z], i) => box(g, 'Gamba_' + (i + 1), lw, P.seatH - st, lw, x, (P.seatH - st) / 2, z, mats.front));
    if (H - P.seatH > 0.1 && !spec.stool) box(g, 'Schienale', W, H - P.seatH, 0.03, 0, P.seatH + (H - P.seatH) / 2, -D / 2 + 0.015, mats.body);
    return g;
  }

  /** Solido ricostruito dalle viste della scheda tecnica. */
  function buildHull(spec, mats, sheet) {
    const S = MC3D_Sheet;
    const vg = S.hullVoxels(sheet.views, spec.W, spec.D, spec.H, 150);
    const { pos, nor } = S.meshVoxels(vg);
    const p = new Float32Array(pos.length), n = new Float32Array(nor);
    for (let i = 0; i < pos.length; i += 3) {
      p[i] = -spec.W / 2 + pos[i] * vg.cell.x;
      p[i + 1] = pos[i + 1] * vg.cell.y;
      p[i + 2] = -spec.D / 2 + pos[i + 2] * vg.cell.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    const m = new THREE.Mesh(geo, mats.body);
    m.name = 'Solido_da_scheda';
    const g = new THREE.Group();
    g.add(m);
    const used = ['front', 'side', 'top'].filter(k => sheet.views[k]).map(k => ({ front: 'fronte', side: 'fianco', top: 'pianta' }[k]));
    spec.notes.push(`Forma ricostruita dalla scheda tecnica (viste: ${used.join(', ')}); dettagli interni e colori secondari non rappresentati.`);
    return g;
  }

  /** Segnaposto per categorie non ancora gestite: volume d'ingombro con misure e colore reali. */
  function buildPlaceholder(spec, mats) {
    const g = new THREE.Group();
    box(g, 'Volume_ingombro', spec.W, spec.H, spec.D, 0, spec.H / 2, 0, mats.body);
    return g;
  }

  async function buildModel(info, opts) {
    opts = opts || {};
    const spec = interpret(info);
    if (spec.invalid) throw new Error('Misure non valide: ' + [info.W, info.D, info.H].join(' × '));
    const finishes = await resolveFinishes(spec, info);
    const mats = buildMaterials(spec, finishes, opts);
    const sheet = opts.sheet && opts.sheet.status === 'ok' ? opts.sheet : null;
    if (sheet && spec.family === 'cabinet' && sheet.profile && sheet.profile.feet && sheet.profile.baseH >= 2) spec.feet = true;
    const pr = defineParams(spec, sheet, opts.saved);
    spec.params = pr.list; spec.P = pr.P;
    const nViews = sheet ? ['front', 'side', 'top'].filter(k => sheet.views[k]).length : 0;
    const hasGen = ['table', 'cabinet', 'sofa', 'bed', 'kitchen', 'chair', 'rete'].includes(spec.family);
    let group, supported = true;
    spec.method = 'generatore';
    if (spec.family === 'table') group = buildTable(spec, mats, !!opts.open);
    else if (spec.bridge) group = buildBridge(spec, mats);
    else if (spec.family === 'kitchen') group = buildKitchen(spec, mats);
    else if (spec.family === 'cabinet') group = buildCabinetFull(spec, mats);
    else if (sheet && (hasGen ? sheet.views.front && (sheet.views.side || sheet.views.top) : nViews >= 1)) { group = buildHull(spec, mats, sheet); spec.params = []; spec.method = 'scheda'; }
    else if (spec.family === 'sofa') group = buildSofa(spec, mats);
    else if (spec.family === 'bed') group = buildBed(spec, mats);
    else if (spec.family === 'chair') group = buildChair(spec, mats);
    else if (spec.family === 'rete') group = buildRete(spec, mats);
    else if (spec.family === 'box') group = buildPlaceholder(spec, mats);
    else {
      supported = false;
      group = buildPlaceholder(spec, mats);
      spec.notes.unshift('Categoria non riconosciuta e nessuna vista utilizzabile nella scheda tecnica: generato un volume con misure e colore corretti.');
    }
    const root = new THREE.Group();
    root.name = fileBase(info, spec) + (opts.open && spec.maxW ? '_aperto' : '');
    root.add(group);
    root.userData = { fonte: 'mondoconv.it', url: info.url, codice: info.code, misure_cm: [info.W, info.D, info.H], generatore: 'mondoconv-3d ' + VERSION };
    return { root, spec, finishes, supported };
  }

  function fileBase(info, spec) {
    const parts = ['MC', spec.collection, spec.label || 'prodotto', spec.colorNames.join('-'), info.code]
      .filter(Boolean).join('_');
    return parts.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').slice(0, 120);
  }

  // ---------------------------------------------------------------------------
  // 6. EXPORT GLB E DOWNLOAD
  // ---------------------------------------------------------------------------

  function exportGLB(obj) {
    return new Promise((resolve, reject) => {
      const ex = new THREE.GLTFExporter();
      ex.parse(obj, resolve, reject, { binary: true, onlyVisible: true });
    });
  }

  function download(arrayBuffer, name) {
    const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60000);
  }

  // ---------------------------------------------------------------------------
  // 7. INTERFACCIA (pulsante + pannello anteprima) in Shadow DOM
  // ---------------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .fab { position: fixed; right: 16px; bottom: 88px; z-index: 2147483646; width: 60px; height: 60px; border-radius: 50%;
      border: none; background: #1f5fbf; color: #fff; font-size: 15px; font-weight: 700; box-shadow: 0 4px 14px rgba(0,0,0,.3); cursor: pointer; }
    .fab[hidden] { display: none; }
    .ov { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; padding: 10px; }
    .pn { background: #fff; color: #222; width: 100%; max-width: 920px; max-height: 100%; border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; }
    .hd { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid #e5e5e5; }
    .hd b { font-size: 15px; }
    .x { background: none; border: none; font-size: 26px; line-height: 1; cursor: pointer; color: #555; padding: 0 6px; }
    .vw { position: relative; height: 48vh; min-height: 240px; background: linear-gradient(#f4f5f7, #e3e5e8); }
    .vw canvas { width: 100%; height: 100%; display: block; touch-action: none; }
    .vw .msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 20px; color: #555; font-size: 14px; }
    .bd { padding: 12px 14px; overflow: auto; font-size: 14px; line-height: 1.45; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 8px; }
    td { padding: 3px 6px; vertical-align: top; border-bottom: 1px solid #f0f0f0; }
    td:first-child { color: #666; white-space: nowrap; width: 1%; }
    .sw { display: inline-block; width: 14px; height: 14px; border-radius: 3px; border: 1px solid #0003; vertical-align: -2px; margin-right: 4px; }
    .warn { background: #fff4e0; border-left: 3px solid #e69500; padding: 6px 8px; margin: 6px 0; }
    .note { color: #555; margin: 4px 0; padding-left: 14px; }
    .ft { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 14px; border-top: 1px solid #e5e5e5; }
    .btn { border: 1px solid #c8c8c8; background: #fafafa; border-radius: 8px; padding: 10px 14px; font-size: 14px; cursor: pointer; color: #222; }
    .btn.pri { background: #1f5fbf; border-color: #1f5fbf; color: #fff; font-weight: 600; }
    .btn:disabled { opacity: .5; }
    .fg { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 8px 0; }
    .fg label { display: flex; flex-direction: column; font-size: 12px; color: #555; gap: 3px; }
    .fg input { font-size: 16px; padding: 7px 8px; border: 1px solid #bbb; border-radius: 6px; width: 100%; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    .note.ok { background: #eaf6ec; border-left: 3px solid #2e7d32; padding: 6px 8px; margin: 6px 0; color: #222; }
    .src { font-style: normal; font-size: 10px; padding: 1px 5px; border-radius: 8px; margin-left: 2px; }
    .src.scheda { background: #c8e6c9; color: #1b5e20; } .src.stima { background: #ffe0b2; color: #8a4b00; } .src.utente { background: #bbdefb; color: #0d47a1; }
    .sheet { margin: 8px 0; padding: 8px; background: #f3f5f8; border-radius: 8px; }
    .sheet a { display: inline-block; margin-top: 6px; color: #1f5fbf; }
    .thumbs { display: flex; gap: 8px; overflow-x: auto; margin-top: 6px; flex-wrap: wrap; }
    .thumbs img { width: 120px; border: 1px solid #ccc; border-radius: 4px; background: #fff; cursor: zoom-in; }
    .thumbs img.big { width: 100%; cursor: zoom-out; }
    .hint { font-size: 12px; color: #666; margin-top: 4px; }
    details { margin-top: 8px; }
    pre { white-space: pre-wrap; word-break: break-word; font-size: 11px; background: #f6f6f6; padding: 8px; border-radius: 6px; max-height: 200px; overflow: auto; }
  `;

  let host, shadow, fab, state = null;

  function ensureUI() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement('div');
    host.id = 'mc3d-host';
    shadow = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = CSS;
    shadow.appendChild(st);
    fab = document.createElement('button');
    fab.className = 'fab';
    fab.textContent = '3D';
    fab.title = 'Genera modello 3D';
    fab.hidden = true;
    fab.addEventListener('click', () => openPanel().catch(e => showFatal(e)));
    shadow.appendChild(fab);
    document.documentElement.appendChild(host);
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    (children || []).forEach(c => c && e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return e;
  }

  async function openPanel() {
    closePanel();
    LOG.length = 0;
    log('mondoconv-3d', VERSION, navigator.userAgent);
    const info = readPage();
    log('lettura', { source: info.source, rawLine: info.rawLine, code: info.code, pageCode: info.pageCode, img: info.imageUrl });

    const ov = el('div', { class: 'ov' });
    const pn = el('div', { class: 'pn' });
    const closeBtn = el('button', { class: 'x', text: '×', title: 'Chiudi', onclick: closePanel });
    const hd = el('div', { class: 'hd' }, [el('b', { text: 'Modello 3D' }), closeBtn]);
    const vw = el('div', { class: 'vw' });
    const msg = el('div', { class: 'msg', text: 'Generazione in corso…' });
    vw.appendChild(msg);
    const bd = el('div', { class: 'bd' });
    const ft = el('div', { class: 'ft' });
    pn.append(hd, vw, bd, ft);
    ov.appendChild(pn);
    ov.addEventListener('click', e => { if (e.target === ov) closePanel(); });
    shadow.appendChild(ov);
    state = { ov, vw, msg, bd, ft, info, swap: false };
    state.saved = loadParams();

    if (!info.source) {
      msg.textContent = 'Non trovo le misure del prodotto in questa pagina. Attendi il caricamento completo (o apri la sezione "Scheda tecnica") e riprova.';
      renderDiagnostics(null);
      return;
    }
    const st = state;
    st.sheet = await loadSheet(info, t => { if (state === st) st.msg.textContent = t; });
    if (state !== st) return;
    await rebuild();
  }

  async function rebuild() {
    const s = state;
    if (!s) return;
    s.msg.style.display = 'flex';
    s.msg.textContent = 'Generazione in corso…';
    let res;
    try {
      res = await buildModel(s.info, { swap: s.swap, open: s.open, sheet: s.sheet, saved: s.saved });
    } catch (e) {
      log('errore build', String(e && e.stack || e));
      s.msg.textContent = 'Errore nella generazione: ' + (e && e.message || e);
      renderDiagnostics(null);
      return;
    }
    s.res = res;
    renderInfo(res);
    renderDiagnostics(res);
    startPreview(res.root);
  }

  function renderInfo(res) {
    const { spec, finishes } = res;
    const s = state;
    s.bd.textContent = '';
    const rows = [];
    const add = (k, v) => rows.push(el('tr', null, [el('td', { text: k }), typeof v === 'string' ? el('td', { text: v }) : el('td', null, [v])]));
    add('Prodotto', [spec.collection, spec.label].filter(Boolean).join(' – ').toLowerCase() || '—');
    add('Tipo', spec.category || 'non riconosciuto');
    add('Misure', `L ${s.open && spec.maxW ? Math.round(spec.maxW * 100) + ' (aperto)' : s.info.W} × P ${s.info.D} × H ${s.info.H} cm`);
    if (spec.family === 'table') {
      const d = [];
      if (spec.extendable) d.push(spec.maxW ? `allungabile fino a ${Math.round(spec.maxW * 100)} cm` : 'allungabile');
      if (spec.round) d.push('piano tondo');
      if (spec.glassTop) d.push('piano in vetro');
      if (d.length) add('Dettagli', d.join(', '));
    } else if (spec.family === 'cabinet') {
      const fr = [];
      if (spec.doors) fr.push(`${spec.doors} ${spec.doors === 1 ? 'anta' : 'ante'} ${spec.sliding ? 'scorrevoli' : spec.flap ? 'a ribalta' : 'battenti'}`);
      if (spec.drawers) fr.push(`${spec.drawers} cassett${spec.drawers === 1 ? 'o' : 'i'}${spec.longDoors ? ' (interni)' : ''}`);
      if (spec.mirror !== 'none') fr.push('specchio ' + { all: 'su tutte le ante', center: 'centrale', left: 'a sinistra', right: 'a destra' }[spec.mirror]);
      add('Frontali', fr.join(', ') || 'nessuno');
    }
    const a = finishes[0], b = finishes[1] || finishes[0];
    const [bodyF, frontF] = s.swap ? [b, a] : [a, b];
    const sw = f => el('span', null, [el('span', { class: 'sw', style: `background:${f.c}` }), f.name + (f.unknown ? (f.sampled ? ' (da foto)' : ' (?)') : '')]);
    const isTable = spec.family === 'table';
    add(isTable ? 'Piano' : spec.family === 'bed' ? 'Rivestimento' : 'Struttura', sw(bodyF));
    const hasFrontPieces = spec.doors > 0 || spec.drawers > 0 || spec.flap;
    if (isTable ? true : (finishes.length > 1 || hasFrontPieces)) add(isTable ? 'Gambe' : spec.family === 'sofa' ? 'Cuscini' : 'Colore frontali', sw(frontF));
    if (spec.bridge && spec.bridgeInfo) {
      add('Composizione', `colonna SX ${spec.bridgeDoors[0]} anta · ponte ${spec.bridgeDoors[1]} ante · colonna DX ${spec.bridgeDoors[2]} anta`);
      add('Vano letto', `larghezza ${spec.bridgeInfo.vanoW} cm · luce sotto il ponte ${spec.bridgeInfo.luce} cm`);
    }
    add('Forma', spec.method === 'scheda' ? 'ricostruita dal disegno della scheda tecnica' : 'generatore parametrico' + (spec.params && spec.params.some(p => p.src === 'scheda') ? ' con misure dalla scheda' : ''));
    s.bd.appendChild(el('table', null, rows));
    if (spec.params && spec.params.length) renderParamsForm(spec);
    renderSheetBox(s.sheet);
    s.info.warnings.forEach(w => s.bd.appendChild(el('div', { class: 'warn', text: w })));
    spec.notes.forEach(n => s.bd.appendChild(el('div', { class: 'note', text: '• ' + n })));

    s.ft.textContent = '';
    const dl = el('button', { class: 'btn pri', text: 'Scarica .glb' });
    dl.addEventListener('click', async () => {
      dl.disabled = true; dl.textContent = 'Esporto…';
      try {
        const buf = await exportGLB(res.root);
        download(buf, res.root.name + '.glb');
        dl.textContent = `Scaricato (${(buf.byteLength / 1024).toFixed(0)} KB)`;
        log('export ok', buf.byteLength);
      } catch (e) {
        log('errore export', String(e && e.stack || e));
        dl.textContent = 'Errore export';
        alertBox('Errore durante l\'export: ' + (e && e.message || e));
      } finally {
        setTimeout(() => { dl.disabled = false; dl.textContent = 'Scarica .glb'; }, 4000);
      }
    });
    s.ft.appendChild(dl);
    if (finishes.length > 1) {
      s.ft.appendChild(el('button', { class: 'btn', text: 'Inverti colori', onclick: () => { s.swap = !s.swap; rebuild(); } }));
    }
    if (spec.family === 'table' && spec.maxW) {
      const txt = s.open ? 'Mostra chiuso' : `Mostra aperto (${Math.round(spec.maxW * 100)} cm)`;
      s.ft.appendChild(el('button', { class: 'btn', text: txt, onclick: () => { s.open = !s.open; rebuild(); } }));
    }
    s.ft.appendChild(el('button', { class: 'btn', text: 'Chiudi', onclick: closePanel }));
  }

  // ---------------------------------------------------------------------------
  // SCHEDA TECNICA: download, analisi, miniature
  // ---------------------------------------------------------------------------

  const sheetCache = {};

  function sheetUrl(code) {
    const links = [...document.querySelectorAll('a[href]')].map(a => a.href);
    const hit = links.find(h => /SCHEDA_TECNICA[^/]*\.pdf/i.test(h) && (!code || h.toUpperCase().includes('/' + code + '/') || h.toUpperCase().includes(code + '_')));
    if (hit) return hit;
    return code ? `https://media.mondoconv.it/media/catalog/pdf/${code}/${code}_SCHEDA_TECNICA.pdf` : null;
  }

  function fetchArrayBuffer(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('GM_xmlhttpRequest non disponibile'));
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'arraybuffer', timeout: 30000,
        onload: r => (r.status >= 200 && r.status < 300 ? resolve(r.response) : reject(new Error('HTTP ' + r.status))),
        onerror: () => reject(new Error('errore rete')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  const tick0 = () => new Promise(r => setTimeout(r, 0));

  async function loadSheet(info, progress) {
    const key = info.code + ':' + info.W + 'x' + info.D + 'x' + info.H;
    if (sheetCache[key]) return sheetCache[key];
    const res = { url: sheetUrl(info.code), status: 'none', views: {}, thumbs: [], cands: [], error: null };
    if (!res.url) { res.status = 'none'; return res; }
    if (typeof pdfjsLib === 'undefined' || typeof MC3D_Sheet === 'undefined') { res.status = 'error'; res.error = 'pdf.js non caricato'; return res; }
    const S = MC3D_Sheet;
    try {
      progress('Scarico la scheda tecnica…');
      const data = new Uint8Array(await fetchArrayBuffer(res.url));
      if (!(data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46)) throw new Error('la risposta non è un PDF');
      const doc = await S.openDoc(pdfjsLib, data);
      const n = Math.min(doc.numPages, S.MAX_PAGES);
      const canvases = [];
      for (let i = 1; i <= n; i++) {
        progress(`Analizzo la scheda tecnica (pagina ${i}/${n})…`);
        await tick0();
        const cv = await S.renderPage(doc, i);
        res.cands.push(...S.analyzePage(cv, i));
        // tiene solo una miniatura (risparmio memoria sul tablet)
        const t = document.createElement('canvas');
        t.width = 700; t.height = Math.round(cv.height * 700 / cv.width);
        t.getContext('2d').drawImage(cv, 0, 0, t.width, t.height);
        canvases.push({ t, k: 700 / cv.width });
        cv.width = cv.height = 0;
      }
      try { doc.destroy(); } catch (e) { /* ignore */ }
      const v = S.matchViews(res.cands, info.W, info.D, info.H);
      res.views = { front: v.front, side: v.side, top: v.top };
      if (v.front) {
        res.profile = S.frontProfile(v.front, info.W, info.H);
        res.bridge = S.bridgeFromFront(v.front, info.W, info.H);
      }
      // miniature con le viste evidenziate
      const role = c => (c === v.front ? 'fronte' : c === v.side ? 'fianco' : c === v.top ? 'pianta' : '');
      const col = { fronte: '#e53935', fianco: '#1e88e5', pianta: '#fb8c00' };
      canvases.forEach(({ t, k }, i) => {
        const x = t.getContext('2d');
        res.cands.filter(c => c.page === i + 1 && role(c)).forEach(c => {
          const r = role(c);
          x.strokeStyle = col[r]; x.lineWidth = 4;
          x.strokeRect(c.x * k, c.y * k, c.w * k, c.h * k);
          x.fillStyle = col[r]; x.font = 'bold 22px sans-serif';
          x.fillText(r.toUpperCase(), c.x * k + 4, Math.max(22, c.y * k - 6));
        });
        res.thumbs.push(t.toDataURL('image/jpeg', 0.75));
      });
      res.status = 'ok';
      log('scheda', { url: res.url, pagine: n, viste: Object.keys(res.views).filter(k => res.views[k]), profilo: res.profile, ponte: res.bridge });
    } catch (e) {
      res.status = /HTTP 404/.test(String(e)) ? 'none' : 'error';
      res.error = String(e && e.message || e);
      log('scheda tecnica', res.error);
    }
    sheetCache[key] = res;
    return res;
  }

  function renderSheetBox(sheet) {
    const s = state;
    const box = el('div', { class: 'sheet' });
    let txt;
    if (!sheet || sheet.status === 'none') txt = 'Scheda tecnica non disponibile per questo prodotto: misure di forma stimate.';
    else if (sheet.status === 'error') txt = 'Scheda tecnica non leggibile (' + sheet.error + '): misure di forma stimate.';
    else {
      const f = k => (sheet.views[k] ? '✓' : '✗');
      txt = `Scheda tecnica letta – viste riconosciute: fronte ${f('front')} · fianco ${f('side')} · pianta ${f('top')}`;
      if (!sheet.views.front && !sheet.views.side && !sheet.views.top) txt += ' (solo prospettive o istruzioni: misure stimate, verificale sul disegno).';
    }
    box.appendChild(el('div', { text: txt }));
    if (sheet && sheet.thumbs && sheet.thumbs.length) {
      const strip = el('div', { class: 'thumbs' });
      sheet.thumbs.forEach((src, i) => {
        const im = el('img', { src, alt: 'Pagina ' + (i + 1) });
        im.addEventListener('click', () => im.classList.toggle('big'));
        strip.appendChild(im);
      });
      box.appendChild(strip);
      box.appendChild(el('div', { class: 'hint', text: 'Tocca una pagina per ingrandirla (riquadri colorati = viste usate).' }));
    }
    if (sheet && sheet.url && sheet.status === 'ok') box.appendChild(el('a', { href: sheet.url, target: '_blank', rel: 'noopener', text: 'Apri il PDF originale' }));
    s.bd.appendChild(box);
  }

  // --- parametri di forma: modulo generico
  function paramKey() { return 'param:' + (state && state.info.code); }
  function loadParams() {
    try {
      if (typeof GM_getValue !== 'function') return null;
      return GM_getValue(paramKey(), null) || GM_getValue('ponte:' + (state && state.info.code), null);
    } catch (e) { return null; }
  }
  function saveParams(v) {
    try { if (typeof GM_setValue === 'function') GM_setValue(paramKey(), v); } catch (e) { log('salvataggio parametri', String(e)); }
  }

  function renderParamsForm(spec) {
    const s = state;
    const list = spec.params;
    const anyEst = list.some(p => p.src === 'stima');
    const box = el('div', { class: anyEst ? 'warn' : 'note ok' });
    box.appendChild(el('div', { text: anyEst
      ? 'Misure di forma (cm). Quelle "stimata" vanno verificate sul disegno della scheda tecnica:'
      : 'Misure di forma (cm), tutte ricavate dalla scheda tecnica o inserite da te:' }));
    const inputs = {};
    const grid = el('div', { class: 'fg' });
    const tag = { scheda: 'dalla scheda', stima: 'stimata', utente: 'inserita da te' };
    list.forEach(p => {
      const inp = el('input', { type: 'number', inputmode: 'decimal', step: '0.5', min: '0', value: String(p.v) });
      inputs[p.k] = inp;
      grid.appendChild(el('label', null, [el('span', null, [p.label + ' ', el('i', { class: 'src ' + p.src, text: tag[p.src] })]), inp]));
    });
    box.appendChild(grid);
    const apply = el('button', { class: 'btn pri', text: 'Applica e salva' });
    apply.addEventListener('click', () => {
      const v = {};
      list.forEach(p => { const n = toNum(inputs[p.k].value); if (isFinite(n) && Math.abs(n - p.v) > 0.05) v[p.k] = n; else if (p.src === 'utente') v[p.k] = p.v; });
      saveParams(Object.keys(v).length ? v : null); s.saved = Object.keys(v).length ? v : null; rebuild();
    });
    const reset = el('button', { class: 'btn', text: 'Ripristina' });
    reset.addEventListener('click', () => { saveParams(null); try { GM_setValue('ponte:' + s.info.code, null); } catch (e) { /* ignore */ } s.saved = null; rebuild(); });
    box.appendChild(el('div', { class: 'row' }, [apply, reset]));
    s.bd.appendChild(box);
  }

  function alertBox(text) {
    if (state) state.bd.prepend(el('div', { class: 'warn', text }));
  }

  function diagnosticsText(res) {
    const s = state;
    const lines = [
      'mondoconv-3d ' + VERSION,
      'URL: ' + location.href,
      'Fonte: ' + (s && s.info.source),
      'Riga: ' + (s && s.info.rawLine),
      'Testa: ' + (s && s.info.head) + ' | Coda: ' + (s && s.info.tail),
      'Codice URL/pagina: ' + (s && s.info.code) + ' / ' + (s && s.info.pageCode),
      'Immagine: ' + (s && s.info.imageUrl),
    ];
    if (res) {
      const sp = Object.assign({}, res.spec); delete sp.params;
      lines.push('Spec: ' + JSON.stringify(sp));
      lines.push('Colori: ' + JSON.stringify(res.finishes.map(f => ({ n: f.name, k: f.key, c: f.c }))));
    }
    if (s && s.sheet) {
      const sh = s.sheet;
      lines.push('--- scheda tecnica ---', 'URL: ' + sh.url, 'Stato: ' + sh.status + (sh.error ? ' (' + sh.error + ')' : ''));
      const role = c => (c === sh.views.front ? 'FRONTE' : c === sh.views.side ? 'FIANCO' : c === sh.views.top ? 'PIANTA' : '');
      (sh.cands || []).forEach(c => lines.push(`p${c.page} ${c.w}x${c.h} rapp ${(c.w / c.h).toFixed(3)} rett ${c.rect.toFixed(2)} dens ${c.density.toFixed(2)} ${c.usable ? 'utile' : 'scartata'} ${role(c)}`));
      if (sh.profile) lines.push('Profilo fronte: ' + JSON.stringify(sh.profile));
      if (sh.bridge) lines.push('Ponte dal fronte: ' + JSON.stringify(sh.bridge));
    }
    lines.push('--- misure trovate in pagina ---', ...pageMeasures());
    lines.push('--- log ---', ...LOG);
    return lines.join('\n');
  }

  /** Elenca le occorrenze di misure nel testo pagina con un po' di contesto (escluse le varianti "Altre..."). */
  function pageMeasures() {
    const t = (state && state.info.bodyText) || '';
    const re = /(\d{2,3}(?:[.,]\d)?)\s*[x×]\s*(\d{2,3}(?:[.,]\d)?)\s*[x×]\s*(\d{2,3}(?:[.,]\d)?)|L\.?\s*\d{2,3}\s*P\.?\s*\d{2,3}\s*H\.?\s*\d{2,3}|(?:larghezza|altezza|profondit[aà])[^0-9]{0,20}\d{2,3}/gi;
    const out = [];
    let m;
    while ((m = re.exec(t)) && out.length < 40) {
      out.push('…' + t.slice(Math.max(0, m.index - 70), m.index + m[0].length + 30).trim() + '…');
    }
    return out.length ? out : ['(nessuna)'];
  }

  function renderDiagnostics(res) {
    const s = state;
    const txt = diagnosticsText(res);
    const det = el('details', null, [el('summary', { text: 'Diagnostica (da inviare in caso di problemi)' }), el('pre', { text: txt })]);
    const cp = el('button', { class: 'btn', text: 'Copia diagnostica' });
    cp.addEventListener('click', async () => {
      try {
        if (typeof GM_setClipboard === 'function') GM_setClipboard(txt, 'text');
        else await navigator.clipboard.writeText(txt);
        cp.textContent = 'Copiata ✓';
      } catch (e) { cp.textContent = 'Copia non riuscita'; }
    });
    det.appendChild(cp);
    s.bd.appendChild(det);
    if (!s.ft.childElementCount) s.ft.appendChild(el('button', { class: 'btn', text: 'Chiudi', onclick: closePanel }));
  }

  // --- anteprima WebGL
  function startPreview(root) {
    const s = state;
    stopPreview();
    s.vw.querySelectorAll('canvas').forEach(c => c.remove());
    let renderer;
    try {
      const canvas = document.createElement('canvas');
      s.vw.prepend(canvas);
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
    } catch (e) {
      log('WebGL non disponibile', String(e));
      s.msg.textContent = 'Anteprima 3D non disponibile su questo dispositivo, ma puoi comunque scaricare il file .glb.';
      return;
    }
    s.msg.style.display = 'none';
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    scene.background = lin(0xf1f2f4);
    try {
      if (THREE.RoomEnvironment) {
        const pmrem = new THREE.PMREMGenerator(renderer);
        scene.environment = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
        pmrem.dispose();
      }
    } catch (e) { log('environment', String(e)); }
    scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 0.5));
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(2, 4, 3);
    scene.add(dir);
    const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
    const maxD = Math.max(size.x, size.y, size.z);
    const grid = new THREE.GridHelper(Math.ceil(maxD * 2 + 1), Math.ceil(maxD * 2 + 1), 0x9aa0a6, 0xc9ccd0);
    scene.add(grid);
    // solo anteprima: riflessi ambiente attenuati sulle superfici non metalliche (non influisce sul file)
    root.traverse(o => { if (o.isMesh && o.material && o.material.isMeshStandardMaterial) o.material.envMapIntensity = o.material.metalness > 0.5 ? 1 : 0.35; });
    scene.add(root);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    camera.position.set(maxD * 1.1, size.y * 0.7 + maxD * 0.45, maxD * 2.5);
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(0, size.y / 2, 0);
    controls.enableDamping = true;
    controls.update();

    const resize = () => {
      const w = s.vw.clientWidth, h = s.vw.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    let raf = 0, alive = true;
    const loop = () => { if (!alive) return; controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
    loop();
    window.addEventListener('resize', resize);
    s.preview = { stop: () => { alive = false; cancelAnimationFrame(raf); window.removeEventListener('resize', resize); controls.dispose(); scene.remove(root); renderer.dispose(); try { renderer.forceContextLoss(); } catch (e) { /* ignore */ } } };
  }

  function stopPreview() {
    if (state && state.preview) { state.preview.stop(); state.preview = null; }
  }

  function closePanel() {
    if (!state) return;
    stopPreview();
    state.ov.remove();
    state = null;
  }

  function showFatal(e) {
    log('errore', String(e && e.stack || e));
    if (state) { state.msg.style.display = 'flex'; state.msg.textContent = 'Errore: ' + (e && e.message || e); renderDiagnostics(null); }
    else window.alert('Modello 3D – errore: ' + (e && e.message || e));
  }

  // --- visibilità del pulsante (il sito è a pagina singola: controlliamo l'URL periodicamente)
  let lastPath = null;
  function tick() {
    ensureUI();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      fab.hidden = !PRODUCT_PATH_RE.test(location.pathname);
      if (state) closePanel();
    }
  }

  if (typeof THREE === 'undefined' || !THREE.GLTFExporter) {
    console.error('[mondoconv-3d] Librerie Three.js non caricate');
    return;
  }
  tick();
  setInterval(tick, 800);

  // Esposto solo per i test automatici (nessun effetto sul sito).
  if (window.__MC3D_TEST__) window.__MC3D_TEST__.api = { readPage, interpret, buildModel, exportGLB, lookupFinish };
})();
