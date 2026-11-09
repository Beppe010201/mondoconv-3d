// ==UserScript==
// @name         Mondo Convenienza → modello 3D (GLB)
// @namespace    https://github.com/mondoconv-3d
// @version      0.2.0
// @description  Aggiunge un pulsante alle pagine prodotto di mondoconv.it che genera un modello 3D parametrico (.glb) a partire da misure, struttura e colori della scheda prodotto.
// @match        https://www.mondoconv.it/*
// @match        https://mondoconv.it/*
// @require      https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js#sha256=f34446bf875b5fb0dcd93819ffe1d9e182d46634ee855f5d904c6c4ac7cdbc95
// @require      https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/controls/OrbitControls.js#sha256=b4c6e53f98538535b11fd6655627d47fb5877b3ad972568bff0a7026c4b6d5c4
// @require      https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/exporters/GLTFExporter.js#sha256=7ba9cf5888ff8c11768ff805d50081c383a91ae4dbf487750065bbbeccd45077
// @require      https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/environments/RoomEnvironment.js#sha256=251b4e779abb5b432f99a326878fe239747c1fe55f390933085fc3deb20d2cea
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
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

(function () {
  'use strict';

  const VERSION = '0.2.0';
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
    ['armadio', /\bARMADI(O|ETTO)\b|\bGUARDAROBA\b|\bTERMINALE\b|\bPONTE\b|\bELEMENTO\b/],
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

  function interpret(info) {
    const head = (info.head || '').toUpperCase();
    const spec = {
      W: info.W / 100, D: info.D / 100, H: info.H / 100,
      notes: [], category: null, collection: null, label: '',
    };

    for (const [cat, re] of TABLE_TYPES.concat(CABINET_TYPES)) {
      const m = head.match(re);
      if (m) {
        spec.category = cat;
        spec.family = TABLE_TYPES.some(x => x[0] === cat) ? 'table' : 'cabinet';
        spec.collection = head.slice(0, m.index).trim() || null;
        spec.label = head.slice(m.index).trim();
        break;
      }
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
    if (spec.category === 'cabina' || /ANGOLAR/.test(head)) spec.notes.push('Forma angolare semplificata: generato come mobile rettangolare con le stesse misure di ingombro.');
    if (/\bPONTE\b/.test(head)) spec.notes.push('Armadio a ponte semplificato: generato come blocco unico (il vano sopra il letto non è modellato).');
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
    const n = (name || '').toLowerCase().replace(/^effetto\s+/, '');
    for (const [k, v] of FINISHES) if (n.includes(k)) return Object.assign({ name, key: k }, v);
    return null;
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
    const roles = spec.family === 'table' ? ['Piano_', 'Gambe_'] : ['Struttura_', 'Frontali_'];
    const mats = {
      body: makeMaterial(body, roles[0] + body.name, opts),
      front: makeMaterial(front, roles[1] + front.name, opts),
      back: new THREE.MeshStandardMaterial({ name: 'Schienale', color: lin(body.kind === 'wood' ? body.c : '#d8d4cc'), roughness: 0.8 }),
      mirror: new THREE.MeshStandardMaterial({ name: 'Specchio', color: lin(0xe8eef2), roughness: 0.04, metalness: 1 }),
      glass: new THREE.MeshStandardMaterial({ name: 'Vetro', color: lin(0xdfeceb), roughness: 0.05, metalness: 0, transparent: true, opacity: 0.3 }),
      rod: new THREE.MeshStandardMaterial({ name: 'Tubo_appendiabiti', color: lin(0xcfcfcf), roughness: 0.25, metalness: 1 }),
    };
    // maniglie
    const h = spec.handleHint || '';
    if (/colore dell/.test(h)) mats.handle = mats.front;
    else {
      const hf = lookupFinish(h) || FINISHES.find(x => x[0] === 'alluminio')[1];
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
    const base = wall ? 0 : spec.feet ? (tall ? 0.08 : 0.1) : (tall ? 0.07 : 0.05);
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
      let y = h > 1.4 ? 1.05 : (f.y0 + f.y1) / 2;
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
    const topT = spec.glassTop ? 0.012 : (spec.extendable && !open && /RADDOPPIABIL|A LIBRO/.test(spec.label) ? 0.05 : 0.03);
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
      const ls = coffee ? 0.045 : spec.category === 'consolle' ? 0.04 : 0.06;
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
    let group, supported = true;
    if (spec.family === 'table') group = buildTable(spec, mats, !!opts.open);
    else if (spec.category) group = buildCabinet(spec, mats);
    else {
      supported = false;
      group = buildPlaceholder(spec, mats);
      spec.notes.unshift('Categoria non ancora supportata: generato un volume segnaposto con misure e colore corretti.');
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

    if (!info.source) {
      msg.textContent = 'Non trovo le misure del prodotto in questa pagina. Attendi il caricamento completo (o apri la sezione "Scheda tecnica") e riprova.';
      renderDiagnostics(null);
      return;
    }
    await rebuild();
  }

  async function rebuild() {
    const s = state;
    if (!s) return;
    s.msg.style.display = 'flex';
    s.msg.textContent = 'Generazione in corso…';
    let res;
    try {
      res = await buildModel(s.info, { swap: s.swap, open: s.open });
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
    add('Tipo', spec.category ? spec.category + (res.supported ? '' : '') : 'non supportato (segnaposto)');
    add('Misure', `L ${s.open && spec.maxW ? Math.round(spec.maxW * 100) + ' (aperto)' : s.info.W} × P ${s.info.D} × H ${s.info.H} cm`);
    if (spec.family === 'table') {
      const d = [];
      if (spec.extendable) d.push(spec.maxW ? `allungabile fino a ${Math.round(spec.maxW * 100)} cm` : 'allungabile');
      if (spec.round) d.push('piano tondo');
      if (spec.glassTop) d.push('piano in vetro');
      if (d.length) add('Dettagli', d.join(', '));
    } else if (spec.category) {
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
    add(isTable ? 'Piano' : 'Struttura', sw(bodyF));
    const hasFrontPieces = spec.doors > 0 || spec.drawers > 0 || spec.flap;
    if (isTable ? true : (finishes.length > 1 || hasFrontPieces)) add(isTable ? 'Gambe' : 'Colore frontali', sw(frontF));
    s.bd.appendChild(el('table', null, rows));
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
      const sp = Object.assign({}, res.spec);
      lines.push('Spec: ' + JSON.stringify(sp));
      lines.push('Colori: ' + JSON.stringify(res.finishes.map(f => ({ n: f.name, k: f.key, c: f.c }))));
    }
    lines.push('--- log ---', ...LOG);
    return lines.join('\n');
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
    camera.position.set(maxD * 1.0, size.y * 0.7 + maxD * 0.4, maxD * 2.3);
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
