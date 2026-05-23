// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ============== DATENMODELL · TRANSAKTIONEN + MIGRATION (Schema v2) ==
// =====================================================================
function makeTxId() { return 'tx_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
// Deterministische Tx-ID für Migration (verhindert Doppelmigration bei Save-Fehler)
function makeMigrationTxId(assetId, date, qty, price, txType) {
  const key = `${assetId}|${date}|${qty}|${price}|${txType}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return 'tx_mig_' + Math.abs(hash).toString(36);
}
function assetTypeOf(pos) {
  if (!pos) return 'stock';
  if (pos.special === 'cash') return 'cash';
  if (pos.special === 'metals' || pos.type === 'Edelmetall') return 'metal';
  const t = (pos.type || '').toLowerCase();
  if (t === 'crypto') return 'crypto';
  if (t === 'etf') return 'etf';
  return 'stock';
}
// Einmalige Migration von Schema v1 (Stammdaten im Code) auf v2 (Transaktionsliste)
// Idempotent: deterministische Tx-IDs + Dedup, sodass eine Doppelausführung keine Duplikate erzeugt.
function migrateSchemaIfNeeded() {
  if (!appData) return;
  const current = Number(appData.schemaVersion) || 1;
  if (current >= 2) return;
  if (!Array.isArray(appData.transactions)) appData.transactions = [];
  const seenIds = new Set(appData.transactions.map(t => t.id));
  const addIfNew = tx => { if (!seenIds.has(tx.id)) { appData.transactions.push(tx); seenIds.add(tx.id); } };

  // 1) Aus jedem purchaseLot in Positionen eine buy-Transaktion erzeugen
  (appData.positions || []).forEach(pos => {
    if (!Array.isArray(pos.purchaseLots) || pos.purchaseLots.length === 0) {
      // Keine Lot-Historie: einzelner Buy-Eintrag (geschätzt heute) damit aktuelle shares/costPrice in Tx repräsentiert sind
      if (pos.shares > 0 && pos.costPrice > 0) {
        const date = new Date().toISOString().slice(0, 10);
        addIfNew({
          id: makeMigrationTxId(pos.id, date, pos.shares, pos.costPrice, 'buy'),
          date, assetId: pos.id, assetType: assetTypeOf(pos), txType: 'buy',
          quantity: pos.shares, price: pos.costPrice, value: pos.shares * pos.costPrice,
          fees: 0, note: 'Migration: Einzelposition ohne Lot-Historie'
        });
      }
      return;
    }
    pos.purchaseLots.forEach(lot => {
      const qty = Number(lot.shares) || 0;
      const px = Number(lot.costPrice) || 0;
      const val = Number(lot.value) || qty * px;
      const date = lot.date || new Date().toISOString().slice(0, 10);
      if (qty <= 0) return;
      addIfNew({
        id: makeMigrationTxId(pos.id, date, qty, px, 'buy'),
        date, assetId: pos.id, assetType: assetTypeOf(pos), txType: 'buy',
        quantity: qty, price: px, value: val,
        fees: Number(lot.upfrontTax || 0), note: 'Migration aus Stammdaten'
      });
    });
  });

  // 2) Edelmetall-Lots in Transaktionen überführen
  if (appData.goal?.metalLots) {
    Object.entries(appData.goal.metalLots).forEach(([metalKey, lots]) => {
      if (!Array.isArray(lots)) return;
      lots.forEach(lot => {
        const grams = Number(lot.grams) || 0;
        const val = Number(lot.value) || 0;
        const date = lot.date || new Date().toISOString().slice(0, 10);
        if (grams <= 0) return;
        const assetId = 'metal_' + metalKey;
        const px = grams > 0 ? val / grams : 0;
        addIfNew({
          id: makeMigrationTxId(assetId, date, grams, px, 'buy'),
          date, assetId, assetType: 'metal', txType: 'buy',
          quantity: grams, price: px, value: val,
          fees: Number(lot.fees || 0), note: 'Migration aus metalLots' + (lot.storage ? ' · ' + lot.storage : '')
        });
      });
    });
  }

  // 3) Cash-Initialerfassung als deposit
  const cash = Number(appData.goal?.cash || 0);
  if (cash > 0) {
    const allDates = appData.transactions.map(t => t.date).filter(Boolean).sort();
    const depositDate = allDates.length > 0 ? allDates[0] : new Date().toISOString().slice(0, 10);
    addIfNew({
      id: makeMigrationTxId('cash', depositDate, cash, 1, 'deposit'),
      date: depositDate,
      assetId: 'cash', assetType: 'cash', txType: 'deposit',
      quantity: cash, price: 1, value: cash, fees: 0,
      note: 'Initiale Cash-Erfassung (Migration)'
    });
  }

  // Sort transactions ascending by date
  appData.transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  appData.schemaVersion = 2;
}

// =====================================================================
