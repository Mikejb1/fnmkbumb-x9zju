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
  const id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const newPos = { id, name, symbol, type, shares, costPrice };
  if (venue !== 'auto' && (type === 'Aktie' || type === 'ETF')) newPos.venue = venue;
  if (type === 'Crypto' && cgId) newPos.cgId = cgId;
  else newPos.manualPrice = manualPrice;
  appData.positions.push(newPos);
  // Transaktion für die neue Position erzeugen (Schema v2) — mit gewähltem Datum
  if (!Array.isArray(appData.transactions)) appData.transactions = [];
  appData.transactions.push({
    id: makeTxId(), date: buyDate,
    assetId: id, assetType: assetTypeOf(newPos), txType: 'buy',
    quantity: shares, price: costPrice, value: shares * costPrice, fees: 0,
    note: 'Manuell hinzugefügt'
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
