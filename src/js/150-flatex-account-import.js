// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== FLATEX KONTOUMSAETZE CSV — Cash-Verlauf + Orderabgleich =====
const FLATEX_ACCOUNT_SOURCE = 'flatex-account-csv';
function accountOrderParts(info) {
  const raw = String(info || '').toUpperCase();
  const isin = raw.match(/\b([A-Z]{2}[A-Z0-9]{10})\b/)?.[1] || '';
  const number = raw.match(/\bORDER\s+(?:KAUF|VERKAUF)\s+[A-Z0-9]{12}\s+(\d{6,})\b/)?.[1] || '';
  return { isin, number };
}
function flatexAccountKind(recipient, info, amount) {
  const text = normalizeText(`${recipient || ''} ${info || ''}`).replace(/�/g, '');
  if (text.includes('einzahlung auf das verrechnungskonto')) return 'deposit';
  if (text.includes('order kauf')) return 'order-buy';
  if (text.includes('order verkauf')) return 'order-sell';
  if (text.includes('dividendenzahlung') || text.includes('dividende')) return 'dividend';
  if (text.includes('zinsabschluss')) return amount > 0 ? 'interest' : amount < 0 ? 'interest-fee' : 'zero';
  if (text.includes('storno') && text.includes('thesaur')) return 'refund';
  if (text.includes('thesaur')) return 'tax';
  if (!amount) return 'zero';
  return amount > 0 ? 'other-credit' : 'other-debit';
}
function accountKindLabel(kind) {
  return ({
    deposit: 'Einzahlung',
    'order-buy': 'Order Kauf',
    'order-sell': 'Order Verkauf',
    dividend: 'Dividende',
    interest: 'Zinsen',
    'interest-fee': 'Zinsbelastung',
    tax: 'Thesaurierung/Steuer',
    refund: 'Erstattung/Storno',
    zero: '0-EUR-Zeile',
    'other-credit': 'unbekannter Zufluss',
    'other-debit': 'unbekannter Abfluss'
  })[kind] || kind;
}
function flatexAccountImportKey(entry) {
  return `flatex-account:${[entry.rowIndex, entry.date, entry.valuta, entry.kind, entry.orderNumber || entry.info, entry.amount].join('|')}`;
}
function positionIsinForTransaction(tx) {
  const pos = (appData?.positions || []).find(item => item.id === tx?.assetId);
  return String(metaValueForQuality(pos, 'isin') || pos?.isin || '').trim().toUpperCase();
}
function noteHasFlatexOrderNumber(tx, number) {
  if (!number) return false;
  return String(tx?.flatexTaNumber || '') === number || String(tx?.note || '').includes(number);
}
function findFlatexAccountOrderTransaction(entry) {
  if (!entry?.orderNumber && !entry?.isin) return null;
  const txType = entry.kind === 'order-sell' ? 'sell' : 'buy';
  const orderDate = entry.valuta || entry.date;
  const candidates = (appData?.transactions || []).filter(tx => {
    if (!tx || tx.assetType === 'cash' || tx.assetType === 'metal' || tx.txType !== txType) return false;
    return true;
  });
  const exactOrder = candidates.find(tx => noteHasFlatexOrderNumber(tx, entry.orderNumber));
  if (exactOrder) return exactOrder;
  return candidates.find(tx => {
    const sameIsin = entry.isin && positionIsinForTransaction(tx) === entry.isin;
    const sameDate = orderDate && (tx.valuta === orderDate || tx.date === orderDate);
    return sameIsin && sameDate && /CSV/.test(String(tx.note || ''));
  }) || null;
}
function roundImportMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
function analyzeFlatexAccountCsvText(text) {
  const parsed = parseSemicolonCsv(text);
  if (parsed.length < 2) throw new Error('Kontoumsatz-CSV enthält keine Buchungszeilen.');
  const columns = {};
  parsed[0].forEach((header, index) => { columns[flatexHeaderKey(header)] = index; });
  if (columns.buchungstag == null || columns.betragineuro == null) {
    throw new Error('Flatex-Kontospalten nicht erkannt. Erwartet werden Buchungstag und Betrag in Euro.');
  }
  const entries = [];
  const ignored = [];
  parsed.slice(1).forEach((row, rowOffset) => {
    const date = normalizeImportDate(flatexRowValue(row, columns, ['Buchungstag']));
    const valuta = normalizeImportDate(flatexRowValue(row, columns, ['Valuta']));
    // Flatex-Kontoumsaetze koennen den Empfaenger-Header als defektes Sonderzeichen exportieren.
    // Bei diesem CSV-Format ist die Spaltenfolge stabil, daher bleibt Index 2 ein sicherer Fallback.
    const recipient = (flatexRowValue(row, columns, ['Empfänger', 'Empfaenger', 'Empfnger', 'EmpfŠnger']) || row[2] || '').trim();
    const info = (flatexRowValue(row, columns, ['Buchungsinformationen', 'Buchungsinformation']) || row[3] || '').trim();
    const amount = parseImportNumber(flatexRowValue(row, columns, ['Betrag in Euro', 'Betrag']) || row[4]);
    if (!recipient && !info && amount == null) return;
    const kind = flatexAccountKind(recipient, info, Number(amount) || 0);
    const order = accountOrderParts(info);
    const entry = {
      rowIndex: rowOffset + 2,
      date,
      valuta,
      ledgerDate: valuta || date,
      recipient,
      info,
      amount: Number(amount) || 0,
      kind,
      isin: order.isin,
      orderNumber: order.number
    };
    entry.importKey = flatexAccountImportKey(entry);
    if (kind === 'zero') {
      ignored.push({ ...entry, reason: '0-EUR-Zeile' });
      return;
    }
    if (kind === 'other-credit' || kind === 'other-debit') {
      ignored.push({ ...entry, reason: 'Buchungsart nicht automatisch zugeordnet' });
      return;
    }
    if ((kind === 'order-buy' || kind === 'order-sell') && !(entry.orderNumber || entry.isin)) {
      ignored.push({ ...entry, reason: 'Orderkennung fehlt' });
      return;
    }
    entry.matchId = (kind === 'order-buy' || kind === 'order-sell') ? findFlatexAccountOrderTransaction(entry)?.id || '' : '';
    entries.push(entry);
  });
  if (entries.length === 0) throw new Error('Keine importierbaren Flatex-Kontoumsätze erkannt.');
  const counts = entries.reduce((acc, entry) => {
    acc[entry.kind] = (acc[entry.kind] || 0) + 1;
    return acc;
  }, {});
  const totals = entries.reduce((acc, entry) => {
    if (entry.kind === 'deposit') acc.deposits += Math.max(0, entry.amount);
    if (entry.kind === 'dividend' || entry.kind === 'interest') acc.income += Math.max(0, entry.amount);
    if (entry.kind === 'tax' || entry.kind === 'interest-fee') acc.debits += Math.abs(entry.amount);
    if (entry.kind === 'refund') acc.refunds += Math.max(0, entry.amount);
    if (entry.kind === 'order-buy' || entry.kind === 'order-sell') acc.orderCash += Math.abs(entry.amount);
    return acc;
  }, { deposits: 0, income: 0, debits: 0, refunds: 0, orderCash: 0 });
  const orders = entries.filter(entry => entry.kind === 'order-buy' || entry.kind === 'order-sell');
  return { entries, ignored, counts, totals, orders, matchedOrders: orders.filter(entry => entry.matchId), unmatchedOrders: orders.filter(entry => !entry.matchId) };
}
function renderFlatexAccountCsvAnalysis(analysis) {
  flatexAccountCsvAnalysis = analysis;
  const accountImpact = `<div class="import-impact-grid">
    <div class="import-impact-card"><div class="label">Cash-Zeilen</div><div class="value">${analysis.entries.length}</div></div>
    <div class="import-impact-card"><div class="label">Einzahlungen</div><div class="value">${fmt.format(analysis.totals.deposits)}</div></div>
    <div class="import-impact-card"><div class="label">Erträge</div><div class="value">${fmt.format(analysis.totals.income)}</div></div>
    <div class="import-impact-card"><div class="label">Abzüge</div><div class="value">${fmt.format(analysis.totals.debits)}</div></div>
    <div class="import-impact-card"><div class="label">Orders erkannt</div><div class="value">${analysis.orders.length}</div></div>
    <div class="import-impact-card"><div class="label">Orders gepaart</div><div class="value">${analysis.matchedOrders.length}</div></div>
  </div>`;
  const items = [
    { kind: 'info', text: `${analysis.entries.length} Kontobewegungen erkannt · ${analysis.counts.deposit || 0} Einzahlung${analysis.counts.deposit === 1 ? '' : 'en'} (${fmt.format(analysis.totals.deposits)}) · ${analysis.counts.dividend || 0} Dividende${analysis.counts.dividend === 1 ? '' : 'n'} · ${analysis.counts.interest || 0} Zinsgutschrift${analysis.counts.interest === 1 ? '' : 'en'}.` },
    { kind: analysis.unmatchedOrders.length ? 'warn' : 'info', text: `${analysis.matchedOrders.length} von ${analysis.orders.length} Order-Kontobewegungen passen zu vorhandenen CSV-Depotbuchungen. ${analysis.unmatchedOrders.length ? 'Nicht passende Orders bleiben unangetastet; zuerst die Depot-/Positions-CSV importieren oder die Vorschau prüfen.' : 'Die echten Kontobelastungen werden auf diese Wertpapierbuchungen gelegt.'}` },
    { kind: 'info', text: `Sonder-Cash: ${analysis.counts.tax || 0} Thesaurierung/Steuer · ${analysis.counts.refund || 0} Storno/Erstattung · ${analysis.counts['interest-fee'] || 0} Zinsbelastung. Wertpapier-Stückzahlen werden durch diesen Import nicht verändert.` }
  ];
  if (analysis.orders.length && !(analysis.counts.deposit > 0)) {
    items.push({ kind: 'warn', text: 'Es wurden Orders, aber keine Einzahlungen erkannt. Wenn deine Kontoliste Einzahlungen enthält, Import abbrechen und die CSV prüfen; sonst würde der Cash-Saldo zu stark negativ werden.' });
  }
  if (analysis.ignored.length) items.push({ kind: 'warn', text: `${analysis.ignored.length} Zeile${analysis.ignored.length === 1 ? '' : 'n'} werden ausgelassen: 0-EUR-Zeilen oder nicht eindeutig erkannte Kontobewegungen.` });
  items.push({ kind: 'warn', text: 'Importmodus: Frühere Kontoumsatz-Importspuren werden ersetzt. Manuell gepflegte Cash-Bewegungen bleiben erhalten und können zusätzlich wirken.' });
  document.getElementById('flatexAccountCsvSummary').innerHTML = items.map(item => `<div class="ss-conflict-item ${item.kind}">${item.text}</div>`).join('') + accountImpact;
  const previewEntries = analysis.entries.filter(entry => entry.kind !== 'order-buy' && entry.kind !== 'order-sell').slice(0, 24)
    .concat(analysis.orders.slice(0, 24));
  document.getElementById('flatexAccountCsvPreview').innerHTML = previewEntries.map(entry => {
    const isOrder = entry.kind === 'order-buy' || entry.kind === 'order-sell';
    const cls = isOrder ? (entry.matchId ? 'buy' : 'sell') : entry.amount < 0 ? 'sell' : 'buy';
    const detail = isOrder
      ? `${entry.isin || 'ISIN fehlt'} · Order ${entry.orderNumber || 'ohne Nummer'} · ${entry.matchId ? 'Depotumsatz gefunden' : 'kein Depotumsatz gefunden'}`
      : `${accountKindLabel(entry.kind)} · ${entry.info || entry.recipient || 'Kontobewegung'}`;
    return `<div class="ss-batch-row ${cls}">
      <div class="date">${formatDateAT(entry.ledgerDate)}</div>
      <div><div class="name">${accountKindLabel(entry.kind)}</div><div class="meta">${escapeHtml(detail)}</div></div>
      <div class="type">${entry.amount >= 0 ? '+' : '−'}${fmt.format(Math.abs(entry.amount))}</div>
    </div>`;
  }).join('');
  document.getElementById('flatexAccountCsvImport').disabled = false;
  document.getElementById('flatexAccountCsvModal').classList.add('active');
}
async function handleFlatexAccountCsvFile(file) {
  if (!file) return;
  try {
    renderFlatexAccountCsvAnalysis(analyzeFlatexAccountCsvText(await readFlatexCsvFile(file)));
  } catch (e) {
    flatexAccountCsvAnalysis = null;
    alert('Kontoumsätze konnten nicht gelesen werden: ' + (e.message || e));
  }
}
function closeFlatexAccountCsvModal() {
  document.getElementById('flatexAccountCsvModal').classList.remove('active');
  document.getElementById('flatexAccountCsvImport').disabled = true;
  flatexAccountCsvAnalysis = null;
  const input = document.getElementById('flatexAccountCsvFileInput');
  if (input) input.value = '';
}
function clearFlatexAccountCsvImports() {
  const importedIncomeIds = new Set((appData.income || []).filter(entry => entry.accountImportSource === FLATEX_ACCOUNT_SOURCE).map(entry => entry.id));
  appData.income = (appData.income || []).filter(entry => entry.accountImportSource !== FLATEX_ACCOUNT_SOURCE);
  appData.transactions = (appData.transactions || []).filter(tx => {
    if (tx.accountImportSource === FLATEX_ACCOUNT_SOURCE) return false;
    if (importedIncomeIds.has(tx.sourceIncomeId)) return false;
    return !(tx.assetType === 'cash' && String(tx.note || '').startsWith('Automatische Initial-Einzahlung'));
  });
  appData.transactions.forEach(tx => {
    if (tx.accountOrderSource !== FLATEX_ACCOUNT_SOURCE) return;
    if (Object.prototype.hasOwnProperty.call(tx, 'accountOriginalFees')) tx.fees = tx.accountOriginalFees;
    delete tx.accountOriginalFees;
    delete tx.accountCashValue;
    delete tx.accountOrderSource;
    delete tx.accountImportKey;
    delete tx.accountBookingDate;
    delete tx.accountValuta;
    delete tx.accountOrderNumber;
  });
}
function pushFlatexAccountCashTx(entry, txType, value, note) {
  const amount = roundImportMoney(Math.abs(value));
  if (!(amount > 0)) return;
  appData.transactions.push({
    id: makeTxId(),
    date: entry.ledgerDate,
    assetId: 'cash',
    assetType: 'cash',
    txType,
    quantity: amount,
    price: 1,
    value: amount,
    fees: 0,
    accountImportSource: FLATEX_ACCOUNT_SOURCE,
    accountImportKey: entry.importKey,
    note
  });
}
function pushFlatexAccountIncome(entry) {
  const amount = roundImportMoney(Math.abs(entry.amount));
  if (!(amount > 0)) return;
  const kind = entry.kind === 'interest' ? 'interest' : 'dividend';
  const income = {
    id: 'inc_flatex_account_' + String(entry.importKey).replace(/[^a-z0-9]+/gi, '').slice(-36),
    date: entry.ledgerDate,
    kind,
    gross: amount,
    tax: 0,
    net: amount,
    note: `Kontoumsätze CSV · ${entry.info || accountKindLabel(entry.kind)} · Betrag aus Kontoauszug`,
    accountImportSource: FLATEX_ACCOUNT_SOURCE,
    accountImportKey: entry.importKey
  };
  appData.income.push(income);
  upsertIncomeCashTransactions(income);
  (appData.transactions || []).filter(tx => tx.sourceIncomeId === income.id).forEach(tx => {
    tx.accountImportSource = FLATEX_ACCOUNT_SOURCE;
    tx.accountImportKey = entry.importKey;
  });
}
function applyFlatexAccountOrder(entry) {
  const tx = (appData.transactions || []).find(item => item.id === entry.matchId) || findFlatexAccountOrderTransaction(entry);
  if (!tx) return false;
  const actualCash = roundImportMoney(Math.abs(entry.amount));
  if (!(actualCash > 0)) return false;
  if (tx.accountOrderSource !== FLATEX_ACCOUNT_SOURCE) tx.accountOriginalFees = Number(tx.fees) || 0;
  const baseValue = Number(tx.value) || ((Number(tx.quantity) || 0) * (Number(tx.price) || 0));
  const feeEstimate = tx.txType === 'buy' ? actualCash - baseValue : baseValue - actualCash;
  tx.fees = feeEstimate > 0 ? roundImportMoney(feeEstimate) : Number(tx.accountOriginalFees) || 0;
  tx.accountCashValue = actualCash;
  tx.accountOrderSource = FLATEX_ACCOUNT_SOURCE;
  tx.accountImportKey = entry.importKey;
  tx.accountBookingDate = entry.date;
  tx.accountValuta = entry.valuta;
  tx.accountOrderNumber = entry.orderNumber;
  tx.cashNeutral = false;
  return true;
}
async function importFlatexAccountCsvAnalysis() {
  if (!flatexAccountCsvAnalysis) return;
  const matched = flatexAccountCsvAnalysis.matchedOrders.length;
  const ok = confirm(`Kontoumsätze wirklich übernehmen?\n\nEinzahlungen, Erträge und Sonder-Cash-Bewegungen werden in dein Cash-Kassenbuch geschrieben. ${matched} Order-Kontobewegungen werden mit vorhandenen CSV-Depotbuchungen abgeglichen. Vorher wird ein JSON-Sicherheitsbackup heruntergeladen.`);
  if (!ok) return;
  await backupEncryptedJson('vor-flatex-kontoumsaetze');
  const result = await applyFlatexAccountCsvAnalysis(flatexAccountCsvAnalysis, { skipSave: true, skipRefresh: true });
  closeFlatexAccountCsvModal();
  await savePositionsToKV();
  await refreshUI({ skipAI: true });
  alert(`Kontoumsätze übernommen. Cash-Verlauf ergänzt; ${result.orderMatches} Depotumsatz-Order${result.orderMatches === 1 ? '' : 's'} mit echter Kontobelastung abgeglichen.`);
}

async function applyFlatexAccountCsvAnalysis(analysis, opts = {}) {
  if (!analysis) throw new Error('Keine Kontoumsatz-Analyse vorhanden.');
  if (!Array.isArray(appData.transactions)) appData.transactions = [];
  ensureIncome();
  clearFlatexAccountCsvImports();
  let orderMatches = 0;
  analysis.entries.forEach(entry => {
    if (entry.kind === 'deposit') pushFlatexAccountCashTx(entry, 'deposit', entry.amount, 'Kontoumsätze CSV · Einzahlung Verrechnungskonto');
    else if (entry.kind === 'dividend' || entry.kind === 'interest') pushFlatexAccountIncome(entry);
    else if (entry.kind === 'tax') pushFlatexAccountCashTx(entry, 'tax', entry.amount, `Kontoumsätze CSV · ${entry.info || 'Thesaurierung'}`);
    else if (entry.kind === 'interest-fee') pushFlatexAccountCashTx(entry, 'fee', entry.amount, `Kontoumsätze CSV · ${entry.info || 'Zinsbelastung'}`);
    else if (entry.kind === 'refund') pushFlatexAccountCashTx(entry, 'refund', entry.amount, `Kontoumsätze CSV · ${entry.info || 'Erstattung'}`);
    else if ((entry.kind === 'order-buy' || entry.kind === 'order-sell') && applyFlatexAccountOrder(entry)) orderMatches++;
  });
  appData.transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (!opts.skipSave) await savePositionsToKV();
  if (!opts.skipRefresh) await refreshUI({ skipAI: true });
  return {
    entryCount: analysis.entries.length,
    orderCount: analysis.orders.length,
    orderMatches,
    depositTotal: analysis.totals.deposits,
    incomeTotal: analysis.totals.income,
    debitTotal: analysis.totals.debits
  };
}

function parseImportNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value || '').trim();
  if (!raw) return null;
  let cleaned = raw
    .replace(/\s/g, '')
    .replace(/St(?:ück|k)?\.?/gi, '')
    .replace(/EUR|€/gi, '')
    .replace(/[^\d,.-]/g, '');
  if (!cleaned) return null;
  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');
  if (hasComma && hasDot) cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  else if (hasComma) cleaned = cleaned.replace(',', '.');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function normalizeImportDate(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return toIsoDate(new Date());
}

function inferImportType(row) {
  const explicit = String(row.type || '').trim();
  if (/^etf$/i.test(explicit)) return 'ETF';
  if (/^aktie$/i.test(explicit)) return 'Aktie';
  if (/^crypto$/i.test(explicit)) return 'Crypto';
  const name = normalizeText(row.name || row.bezeichnung || '');
  const isin = String(row.isin || row.symbol || '').toUpperCase();
  const symbol = String(row.symbol || row.ticker || '').trim().toUpperCase();
  if (/bitcoin|ripple|solana|ethereum|crypto|krypto/.test(name) || /^(BTC|XRP|SOL|ETH)$/.test(symbol)) return 'Crypto';
  if (/etf|msci|fonds|fund|acc|dist/.test(name) || /^(IE|LU)/.test(isin)) return 'ETF';
  return 'Aktie';
}

function inferImportTxType(row, quantity, amount) {
  const explicit = String(row.txType || row.action || '').toLowerCase();
  const note = normalizeText(row.note || row.bookingInfo || row.buchungsinformation || '');
  if (explicit.includes('buy') || explicit.includes('kauf')) return 'buy';
  if (explicit.includes('sell') || explicit.includes('verkauf')) return 'sell';
  if (explicit.includes('fusion')) return 'fusion';
  if (explicit.includes('distribution') || explicit.includes('thesaur')) return 'ignore';
  if (/thesaur|steuer|gebuhr|gebühr|dividend|ausschutt|ausschütt/.test(note)) return 'ignore';
  if (/fusion|umtausch/.test(note)) return 'fusion';
  if (/verkauf/.test(note) || quantity < 0 || amount < 0) return 'sell';
  if (/kauf/.test(note) || quantity > 0 || amount > 0) return 'buy';
  return 'ignore';
}

function normalizeScreenshotTransactions(data) {
  const rows = Array.isArray(data?.transactions) ? data.transactions : Array.isArray(data?.rows) ? data.rows : Array.isArray(data?.buchungen) ? data.buchungen : [];
  return rows.map((row, idx) => {
    const quantity = parseImportNumber(row.quantity ?? row.shares ?? row.nominal ?? row.stueck ?? row.stück);
    const amount = parseImportNumber(row.amount ?? row.value ?? row.betrag);
    const price = parseImportNumber(row.price ?? row.kurs ?? row.costPrice);
    const name = String(row.name || row.bezeichnung || row.title || '').trim();
    const isin = String(row.isin || '').trim().toUpperCase();
    const symbol = String(row.symbol || row.ticker || row.wkn || isin || '').trim().toUpperCase();
    const date = normalizeImportDate(row.date || row.datum);
    const note = String(row.note || row.bookingInfo || row.buchungsinformation || '').trim();
    const txType = inferImportTxType(row, quantity || 0, amount || 0);
    const qtyAbs = Math.abs(quantity || 0);
    const valueAbs = Math.abs(amount || 0);
    const px = price && price > 0 ? price : (qtyAbs > 0 && valueAbs > 0 ? valueAbs / qtyAbs : null);
    const type = inferImportType({ ...row, name, isin, symbol });
    return {
      rowIndex: idx + 1,
      date, name, isin, symbol, type,
      quantity: qtyAbs,
      signedQuantity: quantity || 0,
      amount: valueAbs,
      signedAmount: amount || 0,
      price: px,
      txType,
      note
    };
  }).filter(row => row.name && row.quantity > 0 && row.price > 0);
}

function screenshotHoldingSourceRows(data) {
  const direct = [
    data?.positions,
    data?.holdings,
    data?.bestand,
    data?.bestaende,
    data?.bestände,
    data?.depotPositions,
    data?.depotpositionen,
    data?.assets
  ].find(Array.isArray);
  if (direct) return direct;
  const rows = Array.isArray(data?.transactions) ? data.transactions : Array.isArray(data?.rows) ? data.rows : [];
  if (!rows.length) return [];
  const looksLikeHoldingList = rows.every(row => {
    const explicit = normalizeText(row.txType || row.action || row.kind || row.category || '');
    const note = normalizeText(row.note || row.bookingInfo || row.buchungsinformation || row.section || '');
    const hasQuantity = parseImportNumber(row.quantity ?? row.shares ?? row.nominal ?? row.stueck ?? row.stück) > 0;
    const hasPriceOrValue = parseImportNumber(row.manualPrice ?? row.currentPrice ?? row.price ?? row.kurs ?? row.costPrice) > 0
      || parseImportNumber(row.marketValue ?? row.currentValue ?? row.kurswert ?? row.amount ?? row.value ?? row.betrag) > 0;
    const hasBookingWords = /kauf|verkauf|order|fusion|split|thesaur|steuer|gebuhr|gebühr|dividend|ausschutt|ausschütt/.test(`${explicit} ${note}`);
    const hasHoldingWords = /position|bestand|holding|wallet|brokerage|depot|kurswert|ignore/.test(`${explicit} ${note}`);
    const hasRawDate = row.date || row.datum || row.bookingDate || row.buchungstag;
    return hasQuantity && hasPriceOrValue && !hasBookingWords && (hasHoldingWords || !hasRawDate);
  });
  return looksLikeHoldingList ? rows : [];
}

function normalizeScreenshotHoldings(data) {
  const rows = screenshotHoldingSourceRows(data);
  return rows.map((row, idx) => {
    const quantity = parseImportNumber(row.shares ?? row.quantity ?? row.nominal ?? row.stueck ?? row.stück);
    const value = parseImportNumber(row.marketValue ?? row.currentValue ?? row.kurswert ?? row.amount ?? row.value ?? row.betrag);
    const price = parseImportNumber(row.manualPrice ?? row.currentPrice ?? row.price ?? row.kurs ?? row.costPrice);
    const px = price && price > 0 ? price : (quantity > 0 && value > 0 ? value / quantity : null);
    const costPrice = parseImportNumber(row.costPrice ?? row.einstand ?? row.einstandspreis) || px;
    const name = String(row.name || row.bezeichnung || row.title || row.wertpapierbezeichnung || '').trim();
    const isin = String(row.isin || '').trim().toUpperCase();
    const rawSymbol = String(row.symbol || row.ticker || row.wkn || '').trim().toUpperCase();
    const type = inferImportType({ ...row, name, isin, symbol: rawSymbol });
    const symbol = type === 'Crypto' ? (flatexCryptoSymbol(name) || rawSymbol || isin) : (rawSymbol || isin);
    const date = normalizeImportDate(row.date || row.datum || data?.date || data?.datum);
    return {
      importKind: 'holding',
      rowIndex: idx + 1,
      date, name, isin, symbol, type,
      quantity: Math.abs(quantity || 0),
      signedQuantity: Math.abs(quantity || 0),
      amount: Math.abs(value || ((quantity || 0) * (px || 0))),
      signedAmount: Math.abs(value || ((quantity || 0) * (px || 0))),
      price: px,
      costPrice,
      txType: 'holding',
      note: String(row.note || row.section || 'Bestand aus Screenshot').trim()
    };
  }).filter(row => row.name && row.quantity > 0 && row.price > 0);
}

function importRowKey(row) {
  return [row.date, row.symbol || row.isin, row.name, row.txType, row.signedQuantity, row.signedAmount, row.price].join('|');
}

function securityTokenVariants(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const clean = cleanQuoteSymbol(raw).replace(/[^A-Z0-9.:_-]/g, '');
  const compact = clean.replace(/[^A-Z0-9]/g, '');
  const variants = [clean, compact];
  clean.split(/[.:_-]/).forEach(part => {
    if (part && part.length >= 2) variants.push(part.replace(/[^A-Z0-9]/g, ''));
  });
  return [...new Set(variants.filter(Boolean))];
}

function positionIdentityTokens(pos) {
  const tokens = new Set();
  [
    pos?.symbol,
    pos?.quoteSymbol,
    pos?.isin,
    pos?.wkn,
    pos?.cgId,
    metaValueForQuality(pos, 'isin'),
    metaValueForQuality(pos, 'wkn')
  ].forEach(value => securityTokenVariants(value).forEach(token => tokens.add(token)));
  return tokens;
}

function simplifiedSecurityName(value) {
  return normalizeText(value)
    .replace(/&/g, ' und ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(inc|incorporated|corp|corporation|company|co|ag|se|sa|plc|ltd|limited|holdings|holding|hldg|rg|vz|ordinary|shares|class|aktie|etf|fonds|fund|acc|dist|usd|eur)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameImportType(pos, wantedType) {
  if (!wantedType) return true;
  const a = String(pos?.type || '').toLowerCase();
  const b = String(wantedType || '').toLowerCase();
  if (!a || !b) return true;
  return a === b || (a === 'aktie' && b === 'stock') || (a === 'stock' && b === 'aktie');
}

function findMatchingPosition(name, symbol, opts = {}) {
  if (!Array.isArray(appData?.positions)) return null;
  const wantedType = opts.type || '';
  const wantedCg = cleanQuoteSymbol(opts.cgId || '');
  const candidates = appData.positions.filter(pos => !pos.special && sameImportType(pos, wantedType));
  const inputTokens = new Set();
  [symbol, opts.isin, opts.wkn, opts.cgId].forEach(value => securityTokenVariants(value).forEach(token => inputTokens.add(token)));
  if (wantedCg) inputTokens.add(wantedCg);
  if (inputTokens.size) {
    const byToken = candidates.find(pos => {
      const posTokens = positionIdentityTokens(pos);
      return [...inputTokens].some(token => posTokens.has(token));
    });
    if (byToken) return byToken;
  }
  const nName = simplifiedSecurityName(name);
  if (!nName || nName.length < 4) return null;
  const byName = candidates.find(pos => {
    const pn = simplifiedSecurityName(pos.name);
    if (!pn || pn.length < 4) return false;
    if (pn === nName) return true;
    const minLen = Math.min(pn.length, nName.length);
    return minLen >= 8 && (pn.includes(nName) || nName.includes(pn));
  });
  if (byName) return byName;
  if (opts.allowLooseSymbol && inputTokens.size) {
    const bySym = appData.positions.find(pos => {
      const posTokens = positionIdentityTokens(pos);
      return [...inputTokens].some(token => posTokens.has(token));
    });
    if (bySym) return bySym;
  }
  return null;
}

function summarizeBatchImportImpact(rows) {
  const importable = (rows || []).filter(r => r.txType === 'buy' || r.txType === 'sell' || r.txType === 'fusion');
  const byKey = new Map();
  importable.forEach(row => {
    const key = row.symbol || row.isin || row.name;
    if (!byKey.has(key)) byKey.set(key, { name: row.name, buys: 0, sells: 0, buyValue: 0, sellValue: 0 });
    const item = byKey.get(key);
    const qty = Number(row.quantity) || 0;
    const value = Number(row.amount) || qty * (Number(row.price) || 0);
    const isSell = row.txType === 'sell' || (row.txType === 'fusion' && Number(row.signedQuantity) < 0);
    if (isSell) {
      item.sells += qty;
      item.sellValue += value;
    } else {
      item.buys += qty;
      item.buyValue += value;
    }
  });
  const closing = [...byKey.values()].filter(item => item.buys > 0 && item.sells >= item.buys - 1e-8);
  const netNew = [...byKey.values()].filter(item => item.buys > item.sells + 1e-8);
  const buyValue = importable.reduce((sum, row) => {
    const isBuy = row.txType === 'buy' || (row.txType === 'fusion' && Number(row.signedQuantity) > 0);
    return sum + (isBuy ? (Number(row.amount) || (Number(row.quantity) || 0) * (Number(row.price) || 0)) : 0);
  }, 0);
  const sellValue = importable.reduce((sum, row) => {
    const isSell = row.txType === 'sell' || (row.txType === 'fusion' && Number(row.signedQuantity) < 0);
    return sum + (isSell ? (Number(row.amount) || (Number(row.quantity) || 0) * (Number(row.price) || 0)) : 0);
  }, 0);
  return { importable: importable.length, titles: byKey.size, netNew: netNew.length, closing: closing.length, buyValue, sellValue };
}

function summarizeHoldingImportImpact(rows) {
  const holdings = (rows || []).filter(row => row.importKind === 'holding');
  const totalValue = holdings.reduce((sum, row) => sum + (Number(row.amount) || (Number(row.quantity) || 0) * (Number(row.price) || 0)), 0);
  const existing = holdings.filter(row => findMatchingPosition(row.name, row.symbol || row.isin, { isin: row.isin, type: row.type, allowLooseSymbol: true })).length;
  const cryptos = holdings.filter(row => String(row.type || '').toLowerCase() === 'crypto').length;
  return { holdings: holdings.length, totalValue, existing, newPositions: holdings.length - existing, cryptos };
}

function renderImportImpactCards(summary) {
  if (!summary) return '';
  return `<div class="import-impact-grid">
    <div class="import-impact-card"><div class="label">Buchungen</div><div class="value">${summary.importable}</div></div>
    <div class="import-impact-card"><div class="label">Titel</div><div class="value">${summary.titles}</div></div>
    <div class="import-impact-card"><div class="label">Netto offen</div><div class="value">${summary.netNew}</div></div>
    <div class="import-impact-card"><div class="label">geschlossen</div><div class="value">${summary.closing}</div></div>
    <div class="import-impact-card"><div class="label">Käufe</div><div class="value">${fmt.format(summary.buyValue)}</div></div>
    <div class="import-impact-card"><div class="label">Verkäufe</div><div class="value">${fmt.format(summary.sellValue)}</div></div>
  </div>`;
}

function openScreenshotPreviewModal(data) {
  ssBatchRows = null;
  ssPreviewMatchedPosId = null;
  document.getElementById('ssSingleFields').style.display = '';
  document.getElementById('ssBatchPreview').style.display = 'none';
  document.getElementById('ssBatchPreview').innerHTML = '';
  document.getElementById('sspSave').textContent = 'Übernehmen';
  document.getElementById('sspName').value = data.name || '';
  document.getElementById('sspSymbol').value = data.symbol || '';
  document.getElementById('sspType').value = data.type || 'Aktie';
  document.getElementById('sspShares').value = data.shares != null ? data.shares : '';
  document.getElementById('sspCost').value = data.costPrice != null ? data.costPrice : '';
  document.getElementById('sspPrice').value = data.manualPrice != null ? data.manualPrice : '';
  document.getElementById('sspDate').value = new Date().toISOString().slice(0, 10);
  // Konflikterkennung
  const conflictsEl = document.getElementById('ssConflicts');
  const existingWrap = document.getElementById('sspExistingWrap');
  const items = [];
  const matched = findMatchingPosition(data.name, data.symbol);
  if (matched) {
    ssPreviewMatchedPosId = matched.id;
    items.push({ kind: 'warn', text: `Position <strong>${escapeHtml(matched.name)}</strong> existiert bereits (${matched.shares} Stk @ ${fmtNum(matched.costPrice)} €). Standard: als Bestand/Nachkauf hinzufügen, ohne Cash zu verändern.` });
    existingWrap.style.display = '';
    document.getElementById('sspMergeMode').value = 'addTx';
  } else {
    existingWrap.style.display = 'none';
  }
  // Plausibilitäts-Checks
  if (data.manualPrice && data.costPrice) {
    const diffPct = ((data.manualPrice - data.costPrice) / data.costPrice) * 100;
    if (Math.abs(diffPct) > 80) {
      items.push({ kind: 'warn', text: `Großer Unterschied zwischen Kurs (${fmtPrice(data, data.manualPrice)}) und Einstand (${fmtPrice(data, data.costPrice)}) — ${fmtNum(diffPct, 0)} %. Bitte verifizieren.` });
    }
  }
  if (data.shares && data.shares > 100000) {
    items.push({ kind: 'warn', text: `Sehr hohe Stückzahl erkannt (${data.shares}). Bitte verifizieren.` });
  }
  if (data.costPrice && data.costPrice > 100000) {
    items.push({ kind: 'warn', text: `Sehr hoher Einstandspreis (${fmtPrice(data, data.costPrice)}). Bitte verifizieren.` });
  }
  if (items.length === 0) {
    items.push({ kind: 'info', text: 'Alle Werte plausibel. Beim Speichern wird der Bestand erfasst; Cash bleibt unverändert.' });
  }
  conflictsEl.innerHTML = items.map(i => `<div class="ss-conflict-item ${i.kind}">${i.text}</div>`).join('');
  document.getElementById('ssPreviewModal').classList.add('active');
}

function openScreenshotBatchPreviewModal(rows) {
  ssPreviewMatchedPosId = null;
  ssBatchRows = rows;
  const holdingRows = rows.filter(row => row.importKind === 'holding');
  if (holdingRows.length === rows.length) {
    const summary = summarizeHoldingImportImpact(holdingRows);
    const conflictsEl = document.getElementById('ssConflicts');
    const batchEl = document.getElementById('ssBatchPreview');
    document.getElementById('ssSingleFields').style.display = 'none';
    batchEl.style.display = 'block';
    document.getElementById('sspSave').textContent = `${holdingRows.length} Position${holdingRows.length === 1 ? '' : 'en'} übernehmen`;
    const items = [
      { kind: 'info', text: `${holdingRows.length} aktuelle Bestand${holdingRows.length === 1 ? '' : 's'}position${holdingRows.length === 1 ? '' : 'en'} erkannt. Diese werden als cash-neutrale Bestände gespeichert, nicht als echte Käufe.` },
      { kind: 'info', text: `Vorschau: ${summary.existing} bestehend, ${summary.newPositions} neu, Kurswert zusammen ${fmt.format(summary.totalValue)}.` }
    ];
    conflictsEl.innerHTML = items.map(i => `<div class="ss-conflict-item ${i.kind}">${i.text}</div>`).join('') + `<div class="import-impact-grid">
      <div class="import-impact-card"><div class="label">Positionen</div><div class="value">${summary.holdings}</div></div>
      <div class="import-impact-card"><div class="label">neu</div><div class="value">${summary.newPositions}</div></div>
      <div class="import-impact-card"><div class="label">bestehend</div><div class="value">${summary.existing}</div></div>
      <div class="import-impact-card"><div class="label">Krypto</div><div class="value">${summary.cryptos}</div></div>
      <div class="import-impact-card"><div class="label">Kurswert</div><div class="value">${fmt.format(summary.totalValue)}</div></div>
    </div>`;
    batchEl.innerHTML = holdingRows.map(row => {
      const matched = findMatchingPosition(row.name, row.symbol || row.isin, { isin: row.isin, type: row.type, allowLooseSymbol: true });
      return `<div class="ss-batch-row buy">
        <div class="date">${formatDateAT(row.date)}</div>
        <div>
          <div class="name">${escapeHtml(row.name)}</div>
          <div class="meta">${escapeHtml(row.symbol || row.isin || '')} · ${escapeHtml(row.type)} · ${fmtNum(row.quantity, row.quantity % 1 ? 6 : 0)} Stk · ${fmtPrice(row, row.price)} · ${fmt.format(row.amount || row.quantity * row.price)}</div>
          <div class="meta">${matched ? `wird mit bestehender Position "${escapeHtml(matched.name)}" abgeglichen` : 'wird als neue Position angelegt'} · Cash unverändert</div>
        </div>
        <div class="type">POSITION</div>
      </div>`;
    }).join('');
    document.getElementById('ssPreviewModal').classList.add('active');
    return;
  }
  const importable = rows.filter(r => r.txType === 'buy' || r.txType === 'sell' || r.txType === 'fusion');
  const ignored = rows.length - importable.length;
  const conflictsEl = document.getElementById('ssConflicts');
  const batchEl = document.getElementById('ssBatchPreview');
  document.getElementById('ssSingleFields').style.display = 'none';
  batchEl.style.display = 'block';
  document.getElementById('sspSave').textContent = `${importable.length} Buchungen übernehmen`;
  const items = [
    { kind: 'info', text: `${importable.length} echte Depotbuchungen erkannt. Käufe/Verkäufe werden als Transaktionen gebucht und Positionen zusammengeführt.` }
  ];
  const impact = summarizeBatchImportImpact(rows);
  items.push({ kind: 'info', text: `Import-Vorschau: ${impact.titles} Titel, davon voraussichtlich ${impact.netNew} mit offenem Bestand und ${impact.closing} vollständig geschlossene Historienpositionen.` });
  if (ignored > 0) items.push({ kind: 'warn', text: `${ignored} Thesaurierungs-/Steuer-/Infozeilen werden bewusst ignoriert, damit keine künstlichen Käufe oder Verkäufe entstehen.` });
  const unmatchedSells = importable.filter(r => (r.txType === 'sell' || (r.txType === 'fusion' && r.signedQuantity < 0)) && !findMatchingPosition(r.name, r.symbol || r.isin));
  if (unmatchedSells.length > 0) items.push({ kind: 'warn', text: `${unmatchedSells.length} Verkauf/Abgang ohne bestehende Position erkannt. Diese Zeilen werden beim Speichern übersprungen.` });
  conflictsEl.innerHTML = items.map(i => `<div class="ss-conflict-item ${i.kind}">${i.text}</div>`).join('') + renderImportImpactCards(impact);
  batchEl.innerHTML = rows.map(row => {
    const action = row.txType === 'ignore' ? 'IGNOR' : row.txType === 'sell' || (row.txType === 'fusion' && row.signedQuantity < 0) ? 'VERK.' : row.txType === 'fusion' ? 'FUSION' : 'KAUF';
    return `<div class="ss-batch-row ${row.txType === 'ignore' ? 'ignore' : (action === 'VERK.' ? 'sell' : 'buy')}">
      <div class="date">${formatDateAT(row.date)}</div>
      <div>
        <div class="name">${escapeHtml(row.name)}</div>
        <div class="meta">${escapeHtml(row.symbol || row.isin || '')} · ${fmtNum(row.quantity, row.quantity % 1 ? 6 : 0)} Stk · ${fmtPrice(row, row.price)} · ${fmt.format(row.amount || row.quantity * row.price)}</div>
        ${row.note ? `<div class="meta">${escapeHtml(row.note.slice(0, 90))}</div>` : ''}
      </div>
      <div class="type">${action}</div>
    </div>`;
  }).join('');
  document.getElementById('ssPreviewModal').classList.add('active');
}

function closeScreenshotPreviewModal() {
  document.getElementById('ssPreviewModal').classList.remove('active');
  ssPreviewMatchedPosId = null;
  ssBatchRows = null;
  document.getElementById('sspSave').textContent = 'Übernehmen';
}
async function saveScreenshotPreview() {
  if (Array.isArray(ssBatchRows) && ssBatchRows.length > 0) {
    await saveScreenshotBatchPreview();
    return;
  }
  const name = document.getElementById('sspName').value.trim();
  const symbol = document.getElementById('sspSymbol').value.trim();
  const type = document.getElementById('sspType').value;
  const shares = parseFloat(document.getElementById('sspShares').value);
  const costPrice = parseFloat(document.getElementById('sspCost').value);
  const priceStr = document.getElementById('sspPrice').value;
  const manualPrice = priceStr ? parseFloat(priceStr) : costPrice;
  const date = document.getElementById('sspDate').value || new Date().toISOString().slice(0, 10);
  const mergeMode = ssPreviewMatchedPosId ? document.getElementById('sspMergeMode').value : 'newPos';
  if (!name || !isFinite(shares) || !isFinite(costPrice) || shares <= 0 || costPrice <= 0) {
    alert('Bitte Name, Stück und Einstand korrekt prüfen.');
    return;
  }
  if (!Array.isArray(appData.transactions)) appData.transactions = [];
  if (ssPreviewMatchedPosId && mergeMode === 'addTx') {
    // Nachkauf zu existierender Position: avg-Cost neu berechnen, Tx anlegen
    const pos = appData.positions.find(p => p.id === ssPreviewMatchedPosId);
    if (!pos) { alert('Position nicht mehr gefunden.'); return; }
    const newTotalShares = pos.shares + shares;
    const newCostBasis = pos.costPrice * pos.shares + costPrice * shares;
    pos.shares = newTotalShares;
    pos.costPrice = newCostBasis / newTotalShares;
    if (!pos.cgId) pos.manualPrice = manualPrice;
    appData.transactions.push({
      id: makeTxId(), date, assetId: pos.id, assetType: assetTypeOf(pos),
      txType: 'buy', quantity: shares, price: costPrice, value: shares * costPrice, fees: 0,
      cashNeutral: true,
      note: 'Per Screenshot-Bestandserfassung · Cash unverändert'
    });
  } else {
    // Neue Position + Tx
    const id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const newPos = { id, name, symbol, type, shares, costPrice };
    if (type !== 'Crypto') newPos.manualPrice = manualPrice;
    appData.positions.push(newPos);
    appData.transactions.push({
      id: makeTxId(), date, assetId: id, assetType: assetTypeOf(newPos),
      txType: 'buy', quantity: shares, price: costPrice, value: shares * costPrice, fees: 0,
      cashNeutral: true,
      note: 'Per Screenshot-Bestandserfassung (neue Position) · Cash unverändert'
    });
  }
  appData.transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  closeScreenshotPreviewModal();
  await savePositionsToKV();
  await Promise.all([fetchCryptoPrices(), fetchMarketPrices({ forceRefresh: true })]);
  await fetchAllWeeklyCharts();
  await refreshUI();
}

function upsertImportedPosition(row, asBuy) {
  let pos = findMatchingPosition(row.name, row.symbol || row.isin);
  if (!pos && asBuy) {
    pos = {
      id: 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      name: row.name,
      symbol: row.symbol || row.isin || '',
      type: row.type,
      shares: 0,
      costPrice: row.price,
      manualPrice: row.price
    };
    if (row.isin) pos.stammdaten = { isin: row.isin };
    appData.positions.push(pos);
  }
  return pos;
}

function holdingImportKey(row) {
  return ['holding', row.date, row.symbol || row.isin, row.name, row.quantity, row.price].join('|');
}

function ensurePositionMetadataFromHolding(pos, row) {
  if (!pos) return;
  if (!pos.symbol && (row.symbol || row.isin)) pos.symbol = row.symbol || row.isin;
  if (!pos.type && row.type) pos.type = row.type;
  if (row.isin) applyIdentifierMetadata(pos, row.isin);
  else if (row.symbol) applyIdentifierMetadata(pos, row.symbol);
  if (row.type === 'Crypto') {
    const cg = cgIdForCrypto(pos);
    if (cg) pos.cgId = cg;
  }
  if (!pos.cgId && row.price > 0) pos.manualPrice = row.price;
  pos.archived = false;
}

function upsertScreenshotHolding(row, existingKeys) {
  const key = holdingImportKey(row);
  if (existingKeys.has(key)) return 'skipped';
  let pos = findMatchingPosition(row.name, row.symbol || row.isin, { isin: row.isin, type: row.type, allowLooseSymbol: true });
  const date = row.date || toIsoDate(new Date());
  if (!pos) {
    pos = {
      id: 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      name: row.name,
      symbol: row.symbol || row.isin || '',
      type: row.type,
      shares: 0,
      costPrice: row.costPrice || row.price,
      manualPrice: row.price
    };
    ensurePositionMetadataFromHolding(pos, row);
    appData.positions.push(pos);
  } else {
    ensureExistingPositionLedgerBaseline(pos, date);
    ensurePositionMetadataFromHolding(pos, row);
  }
  const currentQty = Number(getPositionValuation(pos).shares) || 0;
  const delta = row.quantity - currentQty;
  if (Math.abs(delta) <= 1e-9) {
    existingKeys.add(key);
    return 'updated';
  }
  const txType = delta >= 0 ? 'buy' : 'sell';
  const quantity = Math.abs(delta);
  appData.transactions.push({
    id: makeTxId(),
    date,
    assetId: pos.id,
    assetType: assetTypeOf(pos),
    txType,
    quantity,
    price: row.costPrice || row.price,
    value: quantity * (row.costPrice || row.price),
    fees: 0,
    importKey: key,
    cashNeutral: true,
    note: `Per Screenshot-Bestandsabgleich · Zielbestand ${fmtNum(row.quantity, row.quantity % 1 ? 6 : 0)} Stk · Cash unverändert`
  });
  existingKeys.add(key);
  return txType === 'buy' && currentQty === 0 ? 'created' : 'updated';
}

async function saveScreenshotHoldingsPreview(rows) {
  if (!Array.isArray(appData.positions)) appData.positions = [];
  if (!Array.isArray(appData.transactions)) appData.transactions = [];
  const existingKeys = new Set(appData.transactions.map(t => t.importKey).filter(Boolean));
  let created = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    if (row.importKind !== 'holding') { skipped++; continue; }
    const result = upsertScreenshotHolding(row, existingKeys);
    if (result === 'created') created++;
    else if (result === 'updated') updated++;
    else skipped++;
  }
  appData.transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  syncPositionsFromLedger();
  closeScreenshotPreviewModal();
  await savePositionsToKV();
  await Promise.all([fetchCryptoPrices(), fetchMarketPrices({ forceRefresh: true })]);
  await fetchAllWeeklyCharts();
  await refreshUI({ skipAI: true });
  alert(`${created + updated} Positionen übernommen.${created ? ` ${created} neu.` : ''}${updated ? ` ${updated} abgeglichen.` : ''}${skipped ? ` ${skipped} Zeilen übersprungen/ignoriert.` : ''}`);
}

async function saveScreenshotBatchPreview() {
  if (!Array.isArray(ssBatchRows) || ssBatchRows.length === 0) return;
  if (ssBatchRows.every(row => row.importKind === 'holding')) {
    await saveScreenshotHoldingsPreview(ssBatchRows);
    return;
  }
  if (!Array.isArray(appData.transactions)) appData.transactions = [];
  const existingKeys = new Set(appData.transactions.map(t => t.importKey).filter(Boolean));
  let booked = 0, skipped = 0;
  for (const row of ssBatchRows) {
    if (row.txType === 'ignore') { skipped++; continue; }
    const isSell = row.txType === 'sell' || (row.txType === 'fusion' && row.signedQuantity < 0);
    const isBuy = row.txType === 'buy' || (row.txType === 'fusion' && row.signedQuantity > 0);
    if (!isSell && !isBuy) { skipped++; continue; }
    const key = importRowKey(row);
    if (existingKeys.has(key)) { skipped++; continue; }
    const pos = upsertImportedPosition(row, isBuy);
    if (!pos) { skipped++; continue; }
    const value = row.amount || row.quantity * row.price;
    if (isBuy) {
      const newShares = pos.shares + row.quantity;
      const newCostBasis = pos.costPrice * pos.shares + value;
      pos.shares = newShares;
      pos.costPrice = newShares > 0 ? newCostBasis / newShares : row.price;
      if (!pos.cgId) pos.manualPrice = row.price;
      appData.transactions.push({
        id: makeTxId(), date: row.date, assetId: pos.id, assetType: assetTypeOf(pos),
        txType: 'buy', quantity: row.quantity, price: row.price, value, fees: 0,
        importKey: key,
        cashNeutral: true,
        note: `${row.txType === 'fusion' ? 'Fusion/Umtausch' : 'Per Screenshot-Tabellenimport'}${row.note ? ' · ' + row.note : ''}`
      });
      booked++;
    } else if (isSell) {
      const sellQty = Math.min(row.quantity, pos.shares);
      if (sellQty <= 0) { skipped++; continue; }
      pos.shares = Math.max(0, pos.shares - sellQty);
      if (!pos.cgId) pos.manualPrice = row.price;
      appData.transactions.push({
        id: makeTxId(), date: row.date, assetId: pos.id, assetType: assetTypeOf(pos),
        txType: 'sell', quantity: sellQty, price: row.price, value: sellQty * row.price, fees: 0,
        importKey: key,
        cashNeutral: true,
        note: `${row.txType === 'fusion' ? 'Fusion/Umtausch' : 'Per Screenshot-Tabellenimport'}${row.note ? ' · ' + row.note : ''}`
      });
      if (pos.shares <= 1e-9) appData.positions = appData.positions.filter(p => p.id !== pos.id);
      booked++;
    }
    existingKeys.add(key);
  }
  appData.transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  closeScreenshotPreviewModal();
  await savePositionsToKV();
  await Promise.all([fetchCryptoPrices(), fetchMarketPrices({ forceRefresh: true })]);
  await fetchAllWeeklyCharts();
  await refreshUI();
  alert(`${booked} Buchungen übernommen.${skipped ? ` ${skipped} Zeilen übersprungen/ignoriert.` : ''}`);
}
