// Test end-to-end: pagine prodotto simulate (testi reali del sito) + userscript in Chromium headless.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const validator = require('/tmp/t/node_modules/gltf-validator');

const THREE_DIR = '/tmp/t/node_modules/three';
const LIBS = ['build/three.min.js', 'examples/js/controls/OrbitControls.js', 'examples/js/exporters/GLTFExporter.js', 'examples/js/environments/RoomEnvironment.js'];
const PDFLIBS = ['/tmp/t/node_modules/pdfjs-dist/build/pdf.min.js', '/tmp/t/node_modules/pdfjs-dist/build/pdf.worker.min.js'];
const PDFDIR = '/home/claude/pdfw/src';
const SCRIPT = path.join(__dirname, '..', 'mondoconv-3d.user.js');
const OUT = process.argv[2] || '/tmp/mc3d-out';
fs.mkdirSync(OUT, { recursive: true });

const CASES = [
  { path: '/sirio-gkpz.html', code: 'GKPZ', h2: 'Armadio 6 ante battenti', cm: 'cm. 274 x 55 x 247',
    desc: 'SIRIO ARMADIO 6 ANTE BATTENTI L.274 P.55 H.247 COLORE OLMO',
    car: 'La collezione Sirio propone un armadio 6 ante battenti che comprende 3 ripiani e 6 tubi appendiabiti. Disponibile anche con anta ammortizzata e specchio centrale. Gli interni sono in finitura tessuto, la maniglia nel colore dell’anta.',
    related: ['Armadio 4 ante battenti 183x55x247 cm 335€', 'Armadio 5 ante battenti 229x55x247 cm 415€'] },
  { path: '/vela-52co.html', code: '52CO', h2: 'Armadio 2 ante battenti', cm: 'cm. 93 x 55 x 247',
    desc: 'VELA ARMADIO 2 ANTE BATTENTI L.93 P.55 H.247 COLORE BRONZO / VISONE',
    car: 'La collezione Vela propone un armadio 2 ante battenti che comprende 1 ripiano e 2 tubi appendiabiti.' },
  { path: '/elena-xx6s.html', code: 'XX6S', h2: 'Armadio 6 ante battenti chiusura rallentata con specchio centrale', cm: 'cm. 274 x 55 x 247',
    desc: 'ELENA ARMADIO 6 ANTE BATTENTI CHIUSURA RALLENTATA CON SPECCHIO CENTRALE L.274 P.55 H.247 COLORE TITANIO / BIANCO LUCIDO',
    car: 'Comprende 3 ripiani e 6 tubi appendiabiti.' },
  { path: '/vela-mx2s.html', code: 'MX2S', h2: 'Armadio 2 ante maxi scorrevoli con specchio a destra', cm: 'cm. 274 x 62 x 240',
    desc: 'VELA ARMADIO 2 ANTE MAXI SCORREVOLI CON SPECCHIO A DESTRA L.274 P.62 H.240 COLORE BRONZO / VISONE', car: '' },
  { path: '/double-56rt.html', code: '56RT', h2: 'Armadio 2 ante battenti 2 cassetti', cm: 'cm. 71 x 41 x 182',
    desc: 'DOUBLE ARMADIO 2 ANTE BATTENTI 2 CASSETTI L.71 P.41 H.182 COLORE CEMENTO',
    car: 'La linea Double propone un armadio 2 ante e 2 cassetti con 4 ripiani di cui 2 piani regolabili e 2 fissi. Maniglie e piedini verniciati cromo satinato' },
  { path: '/quadrante-61lt.html', code: '61LT', h2: 'Armadio 8 ripiani 2 ante battenti', cm: 'cm. 83 x 29 x 190',
    desc: 'QUADRANTE ARMADIO 8 RIPIANI 2 ANTE BATTENTI L.83 P.29 H.190 COLORE BIANCO FIAMMATO', car: '' },
  { path: '/quadrante-md4c.html', code: 'MD4C', h2: 'Madia 2 ante battenti 4 cassetti', cm: 'cm. 136 x 41 x 86',
    desc: 'QUADRANTE MADIA 2 ANTE BATTENTI 4 CASSETTI L.136 P.41 H.86 COLORE BIANCO FIAMMATO', car: '' },
  { path: '/double-cs4c.html', code: 'CS4C', h2: 'Cassettiera 4 cassetti', cm: 'cm. 51 x 41 x 71',
    desc: 'DOUBLE CASSETTIERA 4 CASSETTI L.51 P.41 H.71 COLORE CEMENTO', car: 'Maniglie e piedini verniciati cromo satinato' },
  { path: '/double-lb01.html', code: 'LB01', h2: 'Libreria', cm: 'cm. 38 x 41 x 182',
    desc: 'DOUBLE LIBRERIA L.38 P.41 H.182 COLORE CEMENTO', car: '' },
  { path: '/sani-rmz8.html', code: 'RMZ8', h2: 'Divano letto angolare', cm: 'cm. 225 x 150 x 81',
    desc: 'SANI DIVANO LETTO ANGOLARE CON PENISOLA REVERSIBILE CONTENITORE L.225 P.150 H.81 - MECCANISMO CLIC/CLAC - RIVESTIMENTO TESSUTO LAM GREY', car: '' },
  { path: '/mercurio-4tmv.html', code: '4TMV', h2: 'Tavolo raddoppiabile (max 180 cm)', cm: 'cm. 90 x 90 x 76',
    desc: 'MERCURIO TAVOLO RADDOPPIABILE (MAX 180 CM) L.90 P.90 H.76 COLORE ROVERE CADIZ / BIANCO', car: 'Piedini regolabili.', open: true },
  { path: '/tav-al01.html', code: 'AL01', h2: 'Tavolo allungabile', cm: 'cm. 160 x 90 x 77',
    desc: 'LIVORNO TAVOLO ALLUNGABILE (MAX 220 CM) L.160 P.90 H.77 COLORE NOCE / NERO', car: '', open: true },
  { path: '/tond-rt01.html', code: 'RT01', h2: 'Tavolo rotondo', cm: 'cm. 110 x 110 x 76',
    desc: 'LUNA TAVOLO ROTONDO L.110 P.110 H.76 COLORE BIANCO OPACO', car: '' },
  { path: '/salo-tv01.html', code: 'TV01', h2: 'Tavolino con ripiano', cm: 'cm. 100 x 55 x 42',
    desc: 'ZEN TAVOLINO CON RIPIANO L.100 P.55 H.42 COLORE ROVERE GRIGIO', car: '' },
  { path: '/scri-sc02.html', code: 'SC02', h2: 'Scrivania 2 cassetti', cm: 'cm. 120 x 60 x 75',
    desc: 'STUDIO SCRIVANIA 2 CASSETTI L.120 P.60 H.75 COLORE BIANCO / OLMO', car: '' },
  { path: '/primula-9f9i.html', code: '9F9I', h2: 'Ponte 6 ante chiusura rallentata', cm: 'cm. 319 x 60 x 253',
    desc: 'PRIMULA PONTE 6 ANTE CHIUSURA RALLENTATA L.319 P.60 H.253 COLORE LOTO NERO / LOTO GRIGIO',
    car: 'Comprende 2 ripiani e 4 tubi appendiabiti. Maniglie color bronzo. Misure ponte: 225 x 35 x 60' },
  { path: '/sirio-pzu4.html', code: 'PZU4', h2: 'Ponte 6 ante battenti (1+4+1)', cm: 'cm. 320 x 55 x 247',
    desc: 'SIRIO PONTE 6 ANTE BATTENTI (1+4+1) L.320 P.55 H.247 COLORE QUERCIA BIANCO', car: '' },
  { path: '/cecilia-dc7t.html', code: 'DC7T', h2: 'Armadio 6 ante battenti', cm: 'cm. 272 x 61 x 251',
    desc: 'CECILIA ARMADIO 6 ANTE BATTENTI L.272 P.61 H.251 COLORE PATINATO BEIGE', car: 'Comprende 3 ripiani e 6 tubi appendiabiti.' },
  { path: '/dafne-gig5.html', code: 'GIG5', h2: 'Tavolo allungabile', cm: 'cm. 137 x 90 x 79',
    desc: 'DAFNE TAVOLO ALLUNGABILE (MAX 185 CM) L.137 P.90 H.79 COLORE BIANCO FRASSINATO', car: '' },
  { path: '/varsavia-wfwz.html', code: 'WFWZ', h2: 'Rete matrimoniale fascia larga', cm: 'cm. 160 x 190 x 35',
    desc: 'VARSAVIA RETE MATRIMONIALE FASCIA LARGA L.160 P.190 H.35 COLORE GRIGIO', car: '' },
  { path: '/liberty-93i6.html', code: '93I6', h2: 'Divano angolare con penisola reversibile', cm: 'cm. 231 x 149 x 84',
    desc: 'LIBERTY DIVANO ANGOLARE CON PENISOLA REVERSIBILE L.231 P.149 H.84 RIVESTIMENTO TESSUTO MLK BEIGE', car: '' },
  { path: '/cucina-peaf.html', code: 'PEAF', h2: 'Cucina 180 cm', cm: 'cm. 180 x 60 x 216',
    desc: 'CUCINA 180 CM L.180 P.60 H.216 COLORE BIANCO / ROVERE', car: '' },
  { path: '/sogno-slzm.html', code: 'SLZM', h2: 'Letto contenitore una piazza e mezza con piedini', cm: 'cm. 131 x 204 x 106',
    desc: 'SOGNO LETTO CONTENITORE UNA PIAZZA E MEZZA CON PIEDINI L.131 P.204 H.106 RIVESTIMENTO TESSUTO LOTO DARK GREY', car: '' },
  { path: '/nadia-sd01.html', code: 'SD01', h2: 'Sedia', cm: 'cm. 45 x 52 x 90',
    desc: 'NADIA SEDIA L.45 P.52 H.90 COLORE NERO / ROVERE', car: '' },
  { path: '/pedana-wfwz.html', code: 'WFWZ', h2: 'Pedana', cm: 'cm. 160 x 190 x 35',
    desc: 'VARSAVIA PEDANA L.160 P.190 H.35 COLORE GRIGIO', car: '' },
  { path: '/composizione-dc7t.html', code: 'DC7T', h2: 'Composizione', cm: 'cm. 272 x 61 x 251',
    desc: 'CECILIA COMPOSIZIONE L.272 P.61 H.251 COLORE PATINATO BEIGE', car: '' },
  { path: '/primula-hjbs.html', code: 'HJBS', h2: 'Camera 6 ante con chiusura rallentata con specchio centrale', cm: 'cm. 273 x 60 x 253',
    desc: 'PRIMULA CAMERA 6 ANTE CON CHIUSURA RALLENTATA CON SPECCHIO CENTRALE L.273 P.60 H.253 SENZA LETTO COLORE NOCE RIVA / BIANCO OPACO MANIGLIA NOCE RIVA', car: '' },
  { path: '/strano-zz99.html', code: 'ZZ99', h2: 'Armadio 3 ante battenti', cm: 'cm. 138 x 55 x 247',
    desc: 'STRANO ARMADIO 3 ANTE BATTENTI L.138 P.55 H.247 COLORE VERDE PETROLIO SPECIALE', car: '' },
];

function html(c) {
  // struttura simile al sito: descrizione in un accordion nascosto (display:none) come può accadere sul sito reale
  return `<!doctype html><html><head><title>${c.h2}: ${c.code} | Mondo Convenienza</title>
<meta property="og:image" content="https://media.mondoconv.it/media/catalog/product/X/X/${c.code}_VARIANT.jpg"></head>
<body><div id="app"><h1>${c.desc.split(' ')[0]}</h1><h2>${c.h2}</h2><p>${c.cm}</p><p>Scheda tecnica</p><p>codice: ${c.code}</p>
<a href="https://media.mondoconv.it/media/catalog/pdf/${c.code}/${c.code}_SCHEDA_TECNICA.pdf">Scheda tecnica</a>
<img src="https://media.mondoconv.it/media/catalog/product/X/X/${c.code}_VARIANT.jpg" width="200">
<ul>${(c.related || []).map(r => `<li>${r}</li>`).join('')}</ul>
<div class="acc" style="display:none"><h3>Descrizione completa</h3><p><strong>${c.desc.split(' ')[0]}</strong> ${c.desc.split(' ').slice(1).join(' ')}</p>
<h3>Caratteristiche</h3><p>${c.car}</p></div></div></body></html>`;
}

// immagine finta: sfondo bianco con mobile verde-petrolio al centro
function fakeJpegPng() {
  const { PNG } = (() => { try { return require('/tmp/t/node_modules/pngjs'); } catch (e) { return {}; } })();
  return null;
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 412, height: 860 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const results = [];
  for (const c of CASES) {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('https://www.mondoconv.it/**', r => {
      const u = r.request().url();
      if (u.includes('/__pdf/')) {
        const f = path.join(PDFDIR, u.split('/__pdf/')[1].replace('_SCHEDA_TECNICA.pdf', '.pdf'));
        return fs.existsSync(f) ? r.fulfill({ contentType: 'application/pdf', body: fs.readFileSync(f) }) : r.fulfill({ status: 404, body: 'no' });
      }
      return r.fulfill({ contentType: 'text/html', body: html(c) });
    });
    await page.goto('https://www.mondoconv.it' + c.path);
    // shim API del gestore userscript
    await page.evaluate(() => {
      window.__MC3D_TEST__ = {};
      window.GM_setClipboard = () => {};
      const store = {}; window.GM_getValue = (k, d) => (k in store ? store[k] : d); window.GM_setValue = (k, v) => { store[k] = v; };
      window.GM_xmlhttpRequest = (o) => {
        if (/\.pdf$/i.test(o.url)) {
          fetch('/__pdf/' + o.url.split('/').pop()).then(async r => o.onload({ status: r.status, response: r.status === 200 ? await r.arrayBuffer() : null }));
          return;
        }
        // immagine sintetica: bordo bianco + centro colore petrolio
        const cv = document.createElement('canvas'); cv.width = 100; cv.height = 100;
        const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 100, 100); x.fillStyle = '#1f5560'; x.fillRect(25, 15, 50, 75);
        cv.toBlob(b => o.onload({ status: 200, response: b }));
      };
    });
    for (const l of LIBS) await page.addScriptTag({ path: path.join(THREE_DIR, l) });
    for (const l of PDFLIBS) await page.addScriptTag({ path: l });
    await page.addScriptTag({ path: SCRIPT });
    await page.waitForTimeout(300);
    const fabVisible = await page.locator('#mc3d-host .fab').isVisible();
    await page.locator('#mc3d-host .fab').click();
    await page.waitForSelector('#mc3d-host .ft .btn.pri', { timeout: 60000 });
    await page.waitForTimeout(700);
    const name = c.path.slice(1, -5);
    if (c.bridge) {
      await page.screenshot({ path: `${OUT}/${name}-stima.png` });
      const inputs = page.locator('#mc3d-host .fg input');
      const vals = [c.bridge.colL, c.bridge.colR, c.bridge.bridgeH, c.bridge.bridgeD];
      for (let k = 0; k < 4; k++) await inputs.nth(k).fill(String(vals[k]));
      await page.locator('#mc3d-host .btn', { hasText: 'Applica e salva' }).click();
      await page.waitForTimeout(900);
    }
    if (c.open) {
      await page.locator('#mc3d-host .btn', { hasText: 'Mostra aperto' }).click();
      await page.waitForTimeout(900);
    }
    await page.screenshot({ path: `${OUT}/${name}.png` });
    const panelText = await page.locator('#mc3d-host .bd').innerText();
    await page.locator('#mc3d-host .bd').screenshot({ path: `${OUT}/${name}-pannello.png` }).catch(() => {});
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#mc3d-host .ft .btn.pri').click()]);
    const file = `${OUT}/${await dl.suggestedFilename()}`;
    await dl.saveAs(file);
    const buf = fs.readFileSync(file);
    const rep = await validator.validateBytes(new Uint8Array(buf));
    results.push({ case: name, fabVisible, file: path.basename(file), kb: Math.round(buf.length / 1024),
      gltfErrors: rep.issues.numErrors, gltfWarnings: rep.issues.numWarnings, jsErrors: errors,
      panel: panelText.split('\n').filter(l => !/^Diagnostica|^Copia/.test(l)).slice(0, 30).join(' | ') });
    await page.close();
  }
  // pagina categoria: il pulsante NON deve comparire
  const page = await ctx.newPage();
  await page.route('https://www.mondoconv.it/**', r => r.fulfill({ contentType: 'text/html', body: '<html><body>categoria</body></html>' }));
  await page.goto('https://www.mondoconv.it/divani/angolari-letto.html');
  await page.evaluate(() => { window.GM_setClipboard = () => {}; });
  for (const l of LIBS) await page.addScriptTag({ path: path.join(THREE_DIR, l) });
  await page.addScriptTag({ path: SCRIPT });
  await page.waitForTimeout(300);
  results.push({ case: 'pagina-categoria', fabVisible: await page.locator('#mc3d-host .fab').isVisible() });
  await browser.close();
  console.log(JSON.stringify(results, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
