# mondoconv-3d — userscript modelli 3D Mondo Convenienza

Rispondere in italiano, procedere a passi con conferma, spiegare il perché,
priorità a correttezza e sicurezza.

## Cosa fa
Userscript (Tampermonkey su Chrome PC, Violentmonkey su Firefox Android) per www.mondoconv.it.
Sulle pagine prodotto (/nome-xxxx.html) mostra un pulsante "3D" che genera un modello .glb
(metri, Y su, fronte +Z, origine a terra al centro) da importare in un planner di planimetrie.

## File
- mondoconv-3d.user.js — lo script distribuito (UNICO file da caricare su GitHub)
- sheet-analyzer.js — analisi schede tecniche PDF; viene INCORPORATO nello userscript con `python3 build.py`
  (tra i marcatori "// ===== Analisi schede tecniche =====" e "// ===== Script principale =====").
  Modificare sheet-analyzer.js e poi rieseguire build.py, non modificare la copia incorporata.
- test/run.js — test end-to-end Playwright: pagine prodotto simulate + schede vere, valida i .glb (gltf-validator)
- test/sheets.js — test del solo analizzatore sulle schede in test/schede/
- test/schede/*.pdf — schede tecniche reali (9F9I Primula ponte, DC7T Cecilia armadio, GIG5 Dafne tavolo,
  WFWZ Varsavia rete, 93I6 Liberty divano, PEAF cucina 180)
NB: i test hanno percorsi assoluti da adattare (node_modules di three@0.147.0, pdfjs-dist@2.16.105,
gltf-validator, cartella schede). Servono: npm i three@0.147.0 pdfjs-dist@2.16.105 gltf-validator playwright

## Pipeline (versione 0.4.1)
1. Lettura riga "Descrizione completa": "SIRIO ARMADIO 6 ANTE BATTENTI L.274 P.55 H.247 COLORE OLMO"
   → tipo, L×P×H, ante, cassetti, specchi, scorrevoli, colori ("A / B": struttura / frontali;
   "… MANIGLIA X" = colore maniglie). Caratteristiche dal testo pagina (ripiani, tubi, piedini, maniglie).
2. Scheda tecnica PDF: https://media.mondoconv.it/media/catalog/pdf/CODICE/CODICE_SCHEDA_TECNICA.pdf
   (o link "Scheda tecnica" in pagina), scaricata con GM_xmlhttpRequest, renderizzata con pdf.js (fake worker).
   Analisi su immagine: componenti connesse, sagome (riempimento dall'esterno + apertura), scarto
   assonometrie (rettilineità < 0.6), riconoscimento fronte/fianco/pianta per proporzioni vs L×P×H (tol. 10%).
   Scala dall'ingombro noto (le quote spesso NON sono testo: numeri disegnati come curve, a volte in mm).
   Misure: profilo fronte (cornice, zoccolo/piedini), ponte (larghezza colonne, altezza ponte).
3. Generatori per famiglia: armadi/mobili (carcassa, ante, maniglie, cassetti, specchi, cornice),
   ponte (colonne + pensile), tavoli (anche aperti/allungabili), divani (lineari, angolari, doppio angolo),
   letti, reti, cucine, sedie; "visual hull" dalle viste per categorie sconosciute (o divani/letti con fronte + altra vista);
   segnaposto come ultima risorsa.
4. Parametri di forma con origine: "dalla scheda" / "stimata" / "inserita da te" (salvati con GM_setValue
   per codice prodotto, per dispositivo). Pannello con anteprima Three.js, miniature scheda con viste evidenziate,
   diagnostica copiabile.
Librerie via @require (versioni bloccate + sha256): three 0.147.0 (+OrbitControls, GLTFExporter, RoomEnvironment),
pdfjs-dist 2.16.105 (pdf.min.js + pdf.worker.min.js). Colori: sRGB → lineare (convertSRGBToLinear).

## Distribuzione
Repository GitHub pubblico dell'utente "mondoconv-3d", file in radice. Installazione/aggiornamento dal link raw;
il gestore aggiorna se @version cresce. Alzare SEMPRE @version e VERSION insieme.
Chrome: Tampermonkey richiede "Consenti script utente" e Accesso ai siti = tutti i siti (o mondoconv.it).

## Stato e aperti
- Verificato su sito reale: armadi, tavoli, ponte Primula (misure dal disegno coerenti con le quote), camera Primula.
- Schede solo in prospettiva (divano Liberty, tavolo Dafne): misure stimate, correzione manuale.
  Proposta in sospeso, l'utente deve scegliere: (1) lettura disegno con IA via API Claude (chiave personale,
  pochi centesimi/prodotto) — raccomandata; (2) OCR nel browser — sconsigliata; (3) solo correzione manuale.
- Profondità ponte non misurata (resta = P). Composizione ante del ponte stimata se manca "(1+4+1)".
- Da fare: verificare import .glb nel planner scelto (scala/orientamento, anche vs modelli IKEA).
- IKEA: usare lo script pubblico "IKEA 3D Model Download Button" (apinanaivot, GitHub), non riscritto.
