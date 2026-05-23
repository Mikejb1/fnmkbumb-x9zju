// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== SCREENSHOT-EXTRAKTION (Vision via Worker) =====
let ssBase64 = null, ssMime = null;
function openScreenshotModal() {
  ssBase64 = null; ssMime = null;
  document.getElementById('ssFile').value = '';
  document.getElementById('ssPreviewWrap').classList.remove('visible');
  const status = document.getElementById('ssStatus'); status.classList.remove('visible', 'error'); status.textContent = '';
  document.getElementById('ssAnalyze').disabled = true;
  document.getElementById('screenshotModal').classList.add('active');
}
function closeScreenshotModal() { document.getElementById('screenshotModal').classList.remove('active'); }
function handleScreenshotFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    document.getElementById('ssPreviewImg').src = dataUrl;
    document.getElementById('ssPreviewWrap').classList.add('visible');
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      ssMime = match[1]; ssBase64 = match[2];
      document.getElementById('ssAnalyze').disabled = false;
    }
  };
  reader.readAsDataURL(file);
}
async function analyzeScreenshot() {
  if (!ssBase64) return;
  const status = document.getElementById('ssStatus');
  const btn = document.getElementById('ssAnalyze');
  status.classList.remove('error'); status.classList.add('visible');
  status.textContent = 'Haiku liest den Screenshot — kann ~5-10 Sek dauern …';
  btn.disabled = true;
  const prompt = `Du bekommst einen Screenshot aus einer Banking-/Broker-App.
Er kann entweder eine einzelne Depotposition ODER eine Tabelle mit vielen Buchungszeilen enthalten.
Lies die Daten präzise aus.

Gib AUSSCHLIESSLICH ein JSON-Objekt zurück (kein Text drumherum, keine Markdown-Codeblöcke):

Variante A: einzelne Position
{
  "name": "<vollständiger Name des Wertpapiers>",
  "symbol": "<Tickersymbol, ISIN oder WKN, falls sichtbar>",
  "type": "<ETF | Aktie | Crypto>",
  "shares": <Stückzahl als Zahl>,
  "costPrice": <Einstandspreis pro Stück in EUR als Zahl>,
  "manualPrice": <aktueller Kurs pro Stück in EUR als Zahl, falls sichtbar>
}

Variante B: Buchungstabelle mit mehreren Titeln
{
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "name": "<Bezeichnung>",
      "isin": "<ISIN falls sichtbar>",
      "symbol": "<Ticker/WKN/ISIN falls sichtbar>",
      "type": "<ETF | Aktie | Crypto>",
      "quantity": <Nominal/Stück als Zahl, Vorzeichen aus Tabelle übernehmen>,
      "amount": <Betrag in EUR als Zahl, Vorzeichen aus Tabelle übernehmen>,
      "price": <Kurs pro Stück in EUR als Zahl>,
      "txType": "<buy | sell | fusion | distribution | ignore>",
      "note": "<Buchungsinformation kurz>"
    }
  ]
}

Wichtig:
- Stückzahl, Einstand und Kurs als reine Zahlen (z.B. 12.59 nicht "12,59 €")
- Bei deutschem Format (Komma als Dezimaltrennzeichen) in Punkt konvertieren
- Wenn ein Feld nicht erkennbar ist: ganz weglassen (NICHT null oder "")
- Typ: ETF bei ETF/Fonds, Aktie bei Einzelaktien, Crypto bei Kryptowährungen
- Tabellenzeilen "Ausführung ORDER Kauf" sind txType "buy"
- Tabellenzeilen "Ausführung ORDER Verkauf" sind txType "sell"
- Tabellenzeilen "Fusion" sind txType "fusion" und behalten das Mengen-Vorzeichen
- Tabellenzeilen "Thesaurierung", Steuer, Gebühren oder reine Buchungs-/Informationszeilen sind txType "ignore" oder "distribution", nicht als normaler Kauf/Verkauf markieren

NUR JSON, sonst nichts.`;
  try {
    const res = await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ image: ssBase64, imageMediaType: ssMime, prompt, maxTokens: 5000, temperature: 0, userKey: kvKeyActive() })
    });
    if (!res.ok) throw new Error('Worker HTTP ' + res.status);
    const result = await res.json();
    if (result.usage) recordUsage(result.usage);
    if (result.error) throw new Error(result.error);
    const text = (result.text || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Keine JSON-Daten erkannt — bitte manuell eingeben');
    const data = JSON.parse(jsonMatch[0]);
    const batchRows = normalizeScreenshotTransactions(data);
    if (batchRows.length === 0 && (!data.name || !data.shares || !data.costPrice)) throw new Error('Wichtige Felder fehlen (Name/Stück/Einstand) — bitte manuell ergänzen');
    closeScreenshotModal();
    if (batchRows.length > 0) openScreenshotBatchPreviewModal(batchRows);
    else openScreenshotPreviewModal(data);
  } catch (e) {
    status.classList.add('error');
    status.textContent = 'Fehler: ' + e.message;
    btn.disabled = false;
  }
}

// ===== SCREENSHOT-IMPORT — Vorschau + Konflikterkennung + Übernahme als Transaktion =====
let ssPreviewMatchedPosId = null;
let ssBatchRows = null;
let flatexCsvAnalysis = null;
let flatexAccountCsvAnalysis = null;
const FLATEX_QTY_EPSILON = 1e-6;

function parseSemicolonCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i], next = src[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ';') { row.push(field.trim()); field = ''; }
    else if (ch === '\n') {
      row.push(field.trim());
      if (row.some(cell => cell !== '')) rows.push(row);
      row = []; field = '';
    } else if (ch !== '\r') field += ch;
  }
  row.push(field.trim());
  if (row.some(cell => cell !== '')) rows.push(row);
  return rows;
}
function flatexHeaderKey(value) {
  return normalizeText(value).replace(/[^\w]+/g, '');
}
function flatexRowValue(row, columns, aliases) {
  for (const alias of aliases) {
    const index = columns[flatexHeaderKey(alias)];
    if (index != null) return row[index] || '';
  }
  return '';
}
function flatexBookingKind(info) {
  const note = normalizeText(info).replace(/�/g, '');
  // Flatex exports may mix encodings for "Ausfuehrung"; "ORDER Kauf/Verkauf" is stable.
  if (note.includes('order kauf')) return 'order-buy';
  if (note.includes('order verkauf')) return 'order-sell';
  if (note.includes('split')) return 'split';
  if (note.includes('storno')) return 'storno';
  if (note.includes('fusion')) return 'fusion';
  if (note.includes('thesaur')) return 'thesaurierung';
  return 'ignore';
}
function inferFlatexType(name, isin) {
  const cleanName = normalizeText(name);
  const cleanIsin = String(isin || '').toUpperCase();
  if (/^XFC/.test(cleanIsin) || /(^|\s)(ripple|solana|bitcoin)(\s|$)/.test(cleanName)) return 'Crypto';
  return inferImportType({ name, isin: cleanIsin, symbol: cleanIsin });
}
function flatexCryptoSymbol(name) {
  const n = normalizeText(name);
  if (n.includes('ripple')) return 'XRP';
  if (n.includes('solana')) return 'SOL';
  if (n.includes('bitcoin')) return 'BTC';
  return '';
}
function flatexPositionKey(isin, name) {
  return String(isin || normalizeText(name).replace(/[^\w]+/g, '_') || 'unknown').toUpperCase();
}
function cleanFlatexQty(value) {
  const num = Number(value) || 0;
  return Math.abs(num) < FLATEX_QTY_EPSILON ? 0 : num;
}
function positionQuantityForCompare(pos) {
  return pos ? Number(getPositionValuation(pos).shares) || 0 : null;
}
function findFlatexExistingPosition(group) {
  const targetIsin = String(group.isin || '').toUpperCase();
  const byIsin = (appData?.positions || []).find(pos => String(metaValueForQuality(pos, 'isin') || '').toUpperCase() === targetIsin);
  return byIsin || findMatchingPosition(group.name, group.symbol || group.isin);
}
function analyzeFlatexCsvText(text) {
  const parsed = parseSemicolonCsv(text);
  if (parsed.length < 2) throw new Error('CSV enthält keine Buchungszeilen.');
  const columns = {};
  parsed[0].forEach((header, index) => { columns[flatexHeaderKey(header)] = index; });
  if (columns.buchungstag == null || columns.isin == null || columns.buchungsinformation == null) {
    throw new Error('Flatex-Spalten nicht erkannt. Erwartet werden Buchungstag, ISIN und Buchungsinformation.');
  }
  const groups = new Map();
  const entries = [];
  const ignored = [];
  parsed.slice(1).forEach((row, rowOffset) => {
    const name = flatexRowValue(row, columns, ['Bezeichnung']).trim();
    const isin = flatexRowValue(row, columns, ['ISIN']).trim().toUpperCase();
    const info = flatexRowValue(row, columns, ['Buchungsinformation']).trim();
    const bookingKind = flatexBookingKind(info);
    const signedQuantity = parseImportNumber(flatexRowValue(row, columns, ['Nominal (Stk.)', 'Nominal']));
    const amount = parseImportNumber(flatexRowValue(row, columns, ['Betrag']));
    const price = parseImportNumber(flatexRowValue(row, columns, ['Kurs']));
    const taNumber = flatexRowValue(row, columns, ['TA.-Nr.', 'TA Nr', 'TANr']).trim();
    const date = normalizeImportDate(flatexRowValue(row, columns, ['Buchungstag']));
    const valuta = normalizeImportDate(flatexRowValue(row, columns, ['Valuta']));
    if (!name || !isin || !signedQuantity || !price || bookingKind === 'ignore') {
      ignored.push({ rowIndex: rowOffset + 2, name, info, reason: bookingKind === 'ignore' ? 'Buchungsart nicht importiert' : 'Pflichtwert fehlt' });
      return;
    }
    const txType = signedQuantity < 0 || bookingKind === 'order-sell' ? 'sell' : 'buy';
    const groupKey = flatexPositionKey(isin, name);
    const type = inferFlatexType(name, isin);
    const entry = {
      rowIndex: rowOffset + 2,
      groupKey, date, valuta, name, isin, type,
      symbol: type === 'Crypto' ? flatexCryptoSymbol(name) : isin,
      quantity: Math.abs(signedQuantity),
      signedQuantity,
      price: Math.abs(price),
      value: Math.abs(amount || signedQuantity * price),
      txType,
      bookingKind,
      cashNeutral: !bookingKind.startsWith('order-'),
      taNumber,
      importKey: `flatex:${taNumber || [date, isin, signedQuantity, price, rowOffset + 2].join('|')}`,
      note: info
    };
    entries.push(entry);
    if (!groups.has(groupKey)) groups.set(groupKey, { key: groupKey, isin, name, type, symbol: entry.symbol, entries: [], netQuantity: 0 });
    const group = groups.get(groupKey);
    group.entries.push(entry);
    group.netQuantity += txType === 'buy' ? entry.quantity : -entry.quantity;
    group.name = name || group.name;
    if (!group.symbol && entry.symbol) group.symbol = entry.symbol;
  });
  if (entries.length === 0) throw new Error('Keine importierbaren Flatex-Buchungen erkannt.');
  const groupList = [...groups.values()].map(group => {
    group.entries.sort((a, b) => a.date.localeCompare(b.date) || a.rowIndex - b.rowIndex);
    group.netQuantity = cleanFlatexQty(group.netQuantity);
    group.open = group.netQuantity > FLATEX_QTY_EPSILON;
    group.existing = findFlatexExistingPosition(group);
    group.currentQuantity = positionQuantityForCompare(group.existing);
    group.matchesCurrent = group.currentQuantity != null && Math.abs(group.currentQuantity - group.netQuantity) <= FLATEX_QTY_EPSILON * 10;
    group.lastPrice = group.entries[group.entries.length - 1]?.price || 0;
    return group;
  }).sort((a, b) => Number(b.open) - Number(a.open) || a.name.localeCompare(b.name));
  const counts = entries.reduce((acc, entry) => {
    acc[entry.bookingKind] = (acc[entry.bookingKind] || 0) + 1;
    return acc;
  }, {});
  return { entries, ignored, groups: groupList, counts };
}
async function readFlatexCsvFile(file) {
  const bytes = await file.arrayBuffer();
  return new TextDecoder('windows-1252').decode(bytes);
}
function renderFlatexCsvAnalysis(analysis) {
  flatexCsvAnalysis = analysis;
  const open = analysis.groups.filter(group => group.open);
  const archived = analysis.groups.filter(group => !group.open);
  const matches = open.filter(group => group.matchesCurrent).length;
  const mismatches = open.filter(group => group.currentQuantity != null && !group.matchesCurrent);
  const buyValue = analysis.entries.filter(entry => entry.txType === 'buy').reduce((sum, entry) => sum + (Number(entry.value) || 0), 0);
  const sellValue = analysis.entries.filter(entry => entry.txType === 'sell').reduce((sum, entry) => sum + (Number(entry.value) || 0), 0);
  const impactCards = `<div class="import-impact-grid">
    <div class="import-impact-card"><div class="label">Buchungen</div><div class="value">${analysis.entries.length}</div></div>
    <div class="import-impact-card"><div class="label">Aktuelle Titel</div><div class="value">${open.length}</div></div>
    <div class="import-impact-card"><div class="label">Historisch 0</div><div class="value">${archived.length}</div></div>
    <div class="import-impact-card"><div class="label">Stück passt</div><div class="value">${matches}/${open.length}</div></div>
    <div class="import-impact-card"><div class="label">Käufe</div><div class="value">${fmt.format(buyValue)}</div></div>
    <div class="import-impact-card"><div class="label">Verkäufe</div><div class="value">${fmt.format(sellValue)}</div></div>
  </div>`;
  const items = [
    { kind: 'info', text: `${analysis.entries.length} Flatex-Buchungen erkannt · ${open.length} heutige Position${open.length === 1 ? '' : 'en'} · ${archived.length} vollständig verkaufte historische Titel.` },
    { kind: mismatches.length ? 'warn' : 'info', text: `${matches} offene CSV-Bestände passen bereits zur aktuellen App. ${mismatches.length ? mismatches.length + ' Abweichung' + (mismatches.length === 1 ? '' : 'en') + ' bitte in der Vorschau prüfen.' : 'Keine Stückzahl-Abweichung bei erkannten Beständen.'}` },
    { kind: 'info', text: `Sonderbuchungen: ${analysis.counts.split || 0} Split · ${analysis.counts.fusion || 0} Fusion · ${analysis.counts.thesaurierung || 0} Thesaurierung · ${analysis.counts.storno || 0} Storno. Sie werden für Stückhistorie/Einstand cash-neutral eingebucht.` }
  ];
  if (analysis.ignored.length) items.push({ kind: 'warn', text: `${analysis.ignored.length} Zeile${analysis.ignored.length === 1 ? '' : 'n'} wurden nicht importiert, weil Buchungsart oder Werte fehlen.` });
  items.push({ kind: 'warn', text: 'Importmodus: Bestehende Aktien/ETF/Krypto-Positionen und deren Wertpapier-Transaktionen werden nach Sicherheitsbackup aus dieser CSV neu aufgebaut. Cash, Ziele, Edelmetalle, Watchlist, Journal und KI-Gedächtnis bleiben erhalten.' });
  document.getElementById('flatexCsvSummary').innerHTML = items.map(item => `<div class="ss-conflict-item ${item.kind}">${item.text}</div>`).join('') + impactCards;
  document.getElementById('flatexCsvPreview').innerHTML = analysis.groups.map(group => {
    const current = group.currentQuantity == null ? 'nicht in App' : `${fmtNum(group.currentQuantity, group.currentQuantity % 1 ? 6 : 0)} Stk`;
    const result = group.open ? `${fmtNum(group.netQuantity, group.netQuantity % 1 ? 6 : 0)} Stk offen` : 'Endbestand 0 · nur Verlauf';
    const cls = group.open ? (group.currentQuantity != null && !group.matchesCurrent ? 'sell' : 'buy') : 'ignore';
    return `<div class="ss-batch-row ${cls}">
      <div class="date">${group.entries.length} Zeile${group.entries.length === 1 ? '' : 'n'}</div>
      <div>
        <div class="name">${escapeHtml(group.name)}</div>
        <div class="meta">${escapeHtml(group.isin)} · ${escapeHtml(group.type)} · App: ${current}</div>
      </div>
      <div class="type">${result}</div>
    </div>`;
  }).join('');
  document.getElementById('flatexCsvImport').disabled = false;
  document.getElementById('flatexCsvModal').classList.add('active');
}
async function handleFlatexCsvFile(file) {
  if (!file) return;
  try {
    renderFlatexCsvAnalysis(analyzeFlatexCsvText(await readFlatexCsvFile(file)));
  } catch (e) {
    flatexCsvAnalysis = null;
    alert('Flatex CSV konnte nicht gelesen werden: ' + (e.message || e));
  }
}
function closeFlatexCsvModal() {
  document.getElementById('flatexCsvModal').classList.remove('active');
  document.getElementById('flatexCsvImport').disabled = true;
  flatexCsvAnalysis = null;
  const input = document.getElementById('flatexCsvFileInput');
  if (input) input.value = '';
}
function flatexPositionId(group) {
  return 'p_flatex_' + String(group.isin || group.key).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 30);
}
function buildFlatexPositionsAndTransactions(analysis) {
  const positions = [];
  const positionIds = new Map();
  analysis.groups.forEach(group => {
    const existing = group.existing;
    const id = existing?.id || flatexPositionId(group);
    const position = existing ? { ...existing } : { id };
    position.id = id;
    position.name = group.name;
    position.symbol = group.symbol || group.isin;
    position.type = group.type;
    position.shares = Math.max(0, group.netQuantity);
    position.costPrice = group.lastPrice || Number(position.costPrice) || 0;
    position.manualPrice = group.lastPrice || Number(position.manualPrice) || position.costPrice;
    position.archived = !group.open;
    position.flatexImported = true;
    position.stammdaten = { ...(position.stammdaten || {}), isin: group.isin };
    delete position.purchaseLots;
    if (group.type === 'Crypto') {
      const cg = cgIdForCrypto(position);
      if (cg) position.cgId = cg;
    }
    positions.push(position);
    positionIds.set(group.key, id);
  });
  const transactions = analysis.entries.map(entry => ({
    id: makeTxId(),
    date: entry.date,
    valuta: entry.valuta,
    assetId: positionIds.get(entry.groupKey),
    assetType: entry.type === 'Crypto' ? 'crypto' : entry.type === 'ETF' ? 'etf' : 'stock',
    txType: entry.txType,
    quantity: entry.quantity,
    price: entry.price,
    value: entry.value,
    fees: 0,
    cashNeutral: entry.cashNeutral,
    importKey: entry.importKey,
    flatexTaNumber: entry.taNumber,
    note: `Flatex CSV · ${entry.bookingKind}${entry.note ? ' · ' + entry.note : ''}`
  }));
  return { positions, transactions };
}
async function importFlatexCsvAnalysis() {
  if (!flatexCsvAnalysis) return;
  const openCount = flatexCsvAnalysis.groups.filter(group => group.open).length;
  const ok = confirm(`Flatex CSV wirklich übernehmen?\n\n${openCount} heutige Positionen werden aus der CSV neu aufgebaut. Vollständig verkaufte Titel bleiben nur im Verlauf. Vorher wird ein JSON-Sicherheitsbackup heruntergeladen.`);
  if (!ok) return;
  await backupEncryptedJson('vor-flatex-csv');
  const built = buildFlatexPositionsAndTransactions(flatexCsvAnalysis);
  const keepTransactions = (appData.transactions || []).filter(tx => tx.assetType === 'cash' || tx.assetType === 'metal' || String(tx.assetId || '').startsWith('metal_'));
  appData.positions = built.positions;
  appData.transactions = keepTransactions.concat(built.transactions).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  syncPositionsFromLedger();
  closeFlatexCsvModal();
  await savePositionsToKV();
  await Promise.all([fetchCryptoPrices(), fetchAllCryptoHistories(370, true), fetchMarketPrices({ forceRefresh: true }), fetchMarketHistory(370, { forceRefresh: true })]);
  await fetchAllWeeklyCharts();
  await refreshUI({ skipAI: true });
  alert(`Flatex CSV übernommen. ${openCount} aktuelle Positionen und ${built.transactions.length} historische Buchungen sind aktiv.`);
}
