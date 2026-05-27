// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== POSITION-MANAGEMENT =====
function openAddPositionModal(prefill) {
  prefill = prefill || {};
  document.getElementById('apName').value = prefill.name || '';
  document.getElementById('apSymbol').value = prefill.symbol || '';
  const venueField = document.getElementById('apVenue');
  if (venueField) venueField.value = prefill.venue || 'auto';
  document.getElementById('apType').value = prefill.type || 'ETF';
  document.getElementById('apShares').value = prefill.shares != null ? prefill.shares : '';
  document.getElementById('apCost').value = prefill.costPrice != null ? prefill.costPrice : '';
  document.getElementById('apPrice').value = prefill.manualPrice != null ? prefill.manualPrice : '';
  document.getElementById('apCgId').value = prefill.cgId || '';
  const dateField = document.getElementById('apDate');
  if (dateField) dateField.value = prefill.date || new Date().toISOString().slice(0, 10);
  updateAddPosTypeFields();
  document.getElementById('addPosModal').classList.add('active');
}
function closeAddPositionModal() { document.getElementById('addPosModal').classList.remove('active'); }
function updateAddPosTypeFields() {
  const type = document.getElementById('apType').value;
  document.getElementById('apCgIdField').style.display = type === 'Crypto' ? '' : 'none';
}
function ensureExistingPositionLedgerBaseline(pos, date) {
  if (!pos || !Array.isArray(appData.transactions)) return;
  if (getTransactionsFor(pos.id).length > 0) return;
  const shares = Number(pos.shares) || 0;
  const price = Number(pos.costPrice) || 0;
  if (!(shares > 0) || !(price > 0)) return;
  appData.transactions.push({
    id: makeTxId(),
    date: date || new Date().toISOString().slice(0, 10),
    assetId: pos.id,
    assetType: assetTypeOf(pos),
    txType: 'buy',
    quantity: shares,
    price,
    value: shares * price,
    fees: 0,
    cashNeutral: true,
    note: 'Automatische Bestandsbasis vor Nachkauf · Cash unverändert'
  });
}
function applyIdentifierMetadata(pos, symbol) {
  if (!pos || !symbol) return;
  const clean = cleanQuoteSymbol(symbol);
  if (!clean) return;
  if (looksLikeIsin(clean)) {
    pos.stammdaten = { ...(pos.stammdaten || {}), isin: clean };
  } else if (looksLikeWkn(clean)) {
    pos.stammdaten = { ...(pos.stammdaten || {}), wkn: clean };
  }
}
async function saveNewPosition() {
  const name = document.getElementById('apName').value.trim();
  const symbol = document.getElementById('apSymbol').value.trim();
  const venue = document.getElementById('apVenue')?.value || 'auto';
  const type = document.getElementById('apType').value;
  const shares = parseFloat(document.getElementById('apShares').value);
  const costPrice = parseFloat(document.getElementById('apCost').value);
  const priceStr = document.getElementById('apPrice').value;
  const manualPrice = priceStr ? parseFloat(priceStr) : costPrice;
  const cgId = document.getElementById('apCgId').value.trim();
  const dateInput = document.getElementById('apDate').value;
  const buyDate = (dateInput && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) ? dateInput : new Date().toISOString().slice(0, 10);
  if (!name || isNaN(shares) || isNaN(costPrice) || shares <= 0 || costPrice <= 0) {
    alert('Bitte Name, Stück und Einstandspreis korrekt ausfüllen.');
    return;
  }
  if (!Array.isArray(appData.transactions)) appData.transactions = [];
  const matched = findMatchingPosition(name, symbol, { type, cgId });
  if (matched) {
    const ok = confirm(`Diese Position scheint bereits zu existieren:\n\n${matched.name}\n\nAls Nachkauf zur bestehenden Position buchen?\n\nAbbrechen = nichts speichern, damit keine Dublette entsteht.`);
    if (!ok) return;
    ensureExistingPositionLedgerBaseline(matched, buyDate);
    if (!matched.symbol && symbol) matched.symbol = symbol;
    if (!matched.type) matched.type = type;
    if (venue !== 'auto' && (matched.type === 'Aktie' || matched.type === 'ETF')) matched.venue = venue;
    if (type === 'Crypto' && cgId) matched.cgId = cgId;
    else if (!matched.cgId) matched.manualPrice = manualPrice;
    matched.archived = false;
    applyIdentifierMetadata(matched, symbol);
    appData.transactions.push({
      id: makeTxId(), date: buyDate,
      assetId: matched.id, assetType: assetTypeOf(matched), txType: 'buy',
      quantity: shares, price: costPrice, value: shares * costPrice, fees: 0,
      cashNeutral: true,
      note: 'Manuelle Bestandserfassung als Nachkauf · Cash unverändert'
    });
    appData.transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    syncPositionsFromLedger();
    closeAddPositionModal();
    await savePositionsToKV();
    await Promise.all([fetchCryptoPrices(), fetchMarketPrices({ forceRefresh: true })]);
    await fetchAllWeeklyCharts();
    await refreshUI();
    return;
  }
  const id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const newPos = { id, name, symbol, type, shares, costPrice };
  if (venue !== 'auto' && (type === 'Aktie' || type === 'ETF')) newPos.venue = venue;
  if (type === 'Crypto' && cgId) newPos.cgId = cgId;
  else newPos.manualPrice = manualPrice;
  applyIdentifierMetadata(newPos, symbol);
  appData.positions.push(newPos);
  // Transaktion für die neue Position erzeugen (Schema v2) — mit gewähltem Datum
  appData.transactions.push({
    id: makeTxId(), date: buyDate,
    assetId: id, assetType: assetTypeOf(newPos), txType: 'buy',
    quantity: shares, price: costPrice, value: shares * costPrice, fees: 0,
    cashNeutral: true,
    note: 'Manuelle Bestandserfassung · Cash unverändert'
  });
  appData.transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  closeAddPositionModal();
  await savePositionsToKV();
  await Promise.all([fetchCryptoPrices(), fetchMarketPrices({ forceRefresh: true })]);
  await fetchAllWeeklyCharts();
  await refreshUI();
}
async function removePosition(posId) {
  const pos = appData.positions.find(p => p.id === posId);
  if (!pos) return;
  if (!confirm(`Position "${pos.name}" wirklich entfernen?`)) return;
  appData.positions = appData.positions.filter(p => p.id !== posId);
  // Korrespondierende Transaktionen ebenfalls entfernen
  if (Array.isArray(appData.transactions)) {
    appData.transactions = appData.transactions.filter(t => t.assetId !== posId);
  }
  delete currentPrices[posId];
  delete weeklyData[posId];
  await savePositionsToKV();
  await refreshUI();
}
