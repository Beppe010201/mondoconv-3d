// Prova dell'analizzatore sulle schede tecniche reali (Chromium headless).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = '/home/claude/mc3d/out/sheets';
fs.mkdirSync(OUT, { recursive: true });
const SRC = '/home/claude/pdfw/src';
// ingombri L×P×H (cm) come da descrizione prodotto (stimati dove non noti)
const PRODUCTS = {
  '9F9I': [319, 60, 253],
  'DC7T': [272, 61, 251],
  'GIG5': [137, 90, 79],
  'WFWZ': [160, 190, 35],
  '93I6': [231, 149, 84],
  'PEAF': [180, 60, 216],
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ path: '/tmp/t/node_modules/pdfjs-dist/build/pdf.min.js' });
  await page.addScriptTag({ path: '/tmp/t/node_modules/pdfjs-dist/build/pdf.worker.min.js' });
  await page.addScriptTag({ path: path.join(__dirname, '..', 'sheet-analyzer.js') });
  await page.evaluate(() => { window.MC3D_Sheet = MC3D_Sheet; });
  const only = process.argv[2];
  for (const [code, dims] of Object.entries(PRODUCTS)) {
    if (only && only !== code) continue;
    const b64 = fs.readFileSync(path.join(SRC, code + '.pdf')).toString('base64');
    const t0 = Date.now();
    const res = await page.evaluate(async ({ b64, dims }) => {
      const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const [W, D, H] = dims;
      const pages = await MC3D_Sheet.renderPages(window.pdfjsLib, bin);
      let cands = [];
      pages.forEach(p => { cands = cands.concat(MC3D_Sheet.analyzePage(p.canvas, p.index)); });
      const views = MC3D_Sheet.matchViews(cands, W, D, H);
      const role = c => (c === views.front ? 'front' : c === views.side ? 'side' : c === views.top ? 'top' : '');
      // overlay
      const imgs = pages.map(p => {
        const cv = document.createElement('canvas');
        cv.width = p.canvas.width / 2; cv.height = p.canvas.height / 2;
        const x = cv.getContext('2d');
        x.drawImage(p.canvas, 0, 0, cv.width, cv.height);
        cands.filter(c => c.page === p.index).forEach(c => {
          const r = role(c);
          x.strokeStyle = r === 'front' ? '#e00' : r === 'side' ? '#06f' : r === 'top' ? '#f90' : c.usable ? '#0a0' : '#bbb';
          x.lineWidth = r ? 4 : 2;
          x.strokeRect(c.x / 2, c.y / 2, c.w / 2, c.h / 2);
          x.fillStyle = x.strokeStyle; x.font = '14px sans-serif';
          x.fillText(`${r || ''} r${c.rect.toFixed(2)} ${(c.w / c.h).toFixed(2)}`, c.x / 2 + 2, c.y / 2 + 14);
          if (r) { // sagoma in trasparenza
            const id = x.getImageData(c.x / 2, c.y / 2, c.w / 2, c.h / 2);
            for (let yy = 0; yy < id.height; yy++) for (let xx = 0; xx < id.width; xx++) {
              if (c.sil[(yy * 2) * c.w + xx * 2]) { const q = (yy * id.width + xx) * 4; id.data[q] = (id.data[q] + (r === 'front' ? 255 : 0)) / 2; id.data[q + 1] = (id.data[q + 1] + 120) / 2; id.data[q + 2] = (id.data[q + 2] + (r === 'side' ? 255 : 0)) / 2; }
            }
            x.putImageData(id, c.x / 2, c.y / 2);
          }
        });
        return cv.toDataURL('image/png');
      });
      const out = { pages: pages.length, cands: cands.map(c => ({ p: c.page, w: c.w, h: c.h, ratio: +(c.w / c.h).toFixed(3), rect: +c.rect.toFixed(2), dens: +c.density.toFixed(2), fill: +c.fill.toFixed(2), usable: c.usable, role: role(c) })) };
      out.targets = { front: +(W / H).toFixed(3), side: +(D / H).toFixed(3), top: +(W / D).toFixed(3) };
      if (views.front) {
        out.profile = MC3D_Sheet.frontProfile(views.front, W, H);
        out.bridge = MC3D_Sheet.bridgeFromFront(views.front, W, H);
      }
      return { out, imgs };
    }, { b64, dims });
    res.imgs.forEach((d, i) => fs.writeFileSync(`${OUT}/${code}-p${i + 1}.png`, Buffer.from(d.split(',')[1], 'base64')));
    console.log('====', code, dims.join('x'), (Date.now() - t0) + 'ms');
    console.log(JSON.stringify(res.out, null, 0));
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
