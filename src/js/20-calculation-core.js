// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ============== BERECHNUNG · Helpers aus Transaktionsmodell ===========
// =====================================================================
function getTransactionsFor(assetId) {
  return (appData?.transactions || []).filter(t => t.assetId === assetId);
}
// Berechnet aktuelle Stückzahl, Einstandswert, Ø Einkaufspreis aus Transaktionen (Average-Cost-Method)
// Unterstützt 'adjust'-Tx: setzt State zum jeweiligen Zeitpunkt neu (für manuelle Korrekturen via Edit-Modal)
function getComputedPosition(positionId) {
  const txs = getTransactionsFor(positionId).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  let shares = 0, costBasis = 0, realized = 0;
  txs.forEach(t => {
    if (t.txType === 'adjust') {
      // Reset State auf manuell korrigierte Werte
      shares = t.quantity || 0;
      costBasis = t.value || 0;
    } else if (t.txType === 'buy') {
      shares += t.quantity;
      costBasis += t.value + (t.fees || 0);
    } else if (t.txType === 'sell') {
      const avgBeforeSell = shares > 0 ? costBasis / shares : 0;
      const soldQty = Math.min(t.quantity, shares);
      realized += (t.price - avgBeforeSell) * soldQty - (t.fees || 0);
      costBasis -= avgBeforeSell * soldQty;
      shares -= soldQty;
    }
  });
  return {
    shares,
    costBasis,
    avgPrice: shares > 0 ? costBasis / shares : 0,
    realizedPnl: realized,
    txCount: txs.length
  };
}

// ===== SINGLE SOURCE OF TRUTH =====
// Synchronisiert pos.shares + pos.costPrice IMMER aus dem Transaktions-Ledger (das "Kassenbuch").
// So können Merkzettel (pos.shares) und Kassenbuch (Transaktionen) nie auseinanderlaufen.
// Positionen ohne Transaktionen bleiben unangetastet (Fallback auf manuelle Werte).
function syncPositionsFromLedger() {
  if (!appData || !Array.isArray(appData.positions)) return;
  appData.positions.forEach(pos => {
    if (pos.special) return; // Cash/Edelmetalle haben kein Stück-Ledger
    const computed = getComputedPosition(pos.id);
    if (computed.txCount > 0) {
      pos.shares = Math.max(0, computed.shares);
      pos.costPrice = computed.shares > 0 ? (computed.costBasis / computed.shares) : pos.costPrice;
    }
  });
}

function getPositionValuation(pos, liveOverride) {
  const live = liveOverride || currentPrices[pos.id] || { price: pos.manualPrice ?? pos.costPrice };
  const price = Number(live.price) || 0;

  if (pos.special === 'cash') {
    const value = currentCashValue();
    return { shares: 1, price: value, costPrice: value, costValue: value, currentValue: value, pnlAbs: 0, pnlPct: 0 };
  }

  const computed = !pos.special ? getComputedPosition(pos.id) : null;
  const useComputed = computed && computed.txCount > 0;
  const shares = useComputed ? Math.max(0, Number(computed.shares) || 0) : (Number(pos.shares) || 0);
  const costValue = useComputed ? Math.max(0, Number(computed.costBasis) || 0) : (Number(pos.costPrice) || 0) * shares;
  const costPrice = shares > 0 ? costValue / shares : (Number(pos.costPrice) || 0);
  const currentValue = price * shares;
  const pnlAbs = currentValue - costValue;
  const pnlPct = costValue > 0 ? (pnlAbs / costValue) * 100 : 0;

  return { shares, price, costPrice, costValue, currentValue, pnlAbs, pnlPct };
}

function getManualQuoteOverride(pos) {
  const override = pos?.manualQuoteOverride;
  if (!override) return null;
  const price = Number(override.price);
  const expiresAt = override.expiresAt ? new Date(override.expiresAt) : null;
  if (!Number.isFinite(price) || price <= 0 || !expiresAt || isNaN(expiresAt.getTime())) return null;
  if (Date.now() >= expiresAt.getTime()) return null;
  return { ...override, price };
}

function isManualQuoteOverrideActive(pos) {
  return !!getManualQuoteOverride(pos);
}

function fallbackQuoteForPosition(pos) {
  return {
    price: pos.manualPrice ?? pos.costPrice,
    live: false,
    source: 'manuell',
    venue: venueOf(pos),
    venueLabel: getVenueByCode(venueOf(pos)).short,
    updatedAt: null,
  };
}

function baseQuoteForPosition(pos) {
  if (baseLivePrices[pos.id]) return baseLivePrices[pos.id];
  const current = currentPrices[pos.id];
  if (current && !current.manualOverride) return current;
  const stored = pos.manualQuoteOverride?.baseQuote;
  if (stored && Number(stored.price) > 0) return stored;
  return fallbackQuoteForPosition(pos);
}

function effectiveQuoteForPosition(pos, baseQuote) {
  const fallback = baseQuote || baseQuoteForPosition(pos);
  const override = getManualQuoteOverride(pos);
  if (!override) return fallback;
  const price = Number(override.price);
  const previousClose = Number(fallback?.previousClose);
  const change = Number.isFinite(previousClose) && previousClose > 0 ? price - previousClose : null;
  const changePct = Number.isFinite(previousClose) && previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : null;
  return {
    ...fallback,
    price,
    previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
    change: Number.isFinite(change) ? change : null,
    changePct: Number.isFinite(changePct) ? changePct : null,
    live: false,
    manualOverride: true,
    source: 'Manueller Kurs',
    updatedAt: override.createdAt || new Date().toISOString(),
    overrideExpiresAt: override.expiresAt,
    baseSource: fallback?.source || '',
    baseUpdatedAt: fallback?.updatedAt || null,
    venue: fallback?.venue || venueOf(pos),
    venueLabel: fallback?.venueLabel || getVenueByCode(venueOf(pos)).short,
  };
}

function applyManualQuoteOverrides() {
  if (!appData?.positions) return;
  appData.positions.forEach(pos => {
    const base = baseQuoteForPosition(pos);
    currentPrices[pos.id] = effectiveQuoteForPosition(pos, base);
  });
}

function pruneExpiredManualQuoteOverrides() {
  if (!appData?.positions) return false;
  let changed = false;
  const now = Date.now();
  appData.positions.forEach(pos => {
    const expiresAt = pos.manualQuoteOverride?.expiresAt ? new Date(pos.manualQuoteOverride.expiresAt).getTime() : 0;
    if (expiresAt && now >= expiresAt) {
      const base = baseQuoteForPosition(pos);
      delete pos.manualQuoteOverride;
      currentPrices[pos.id] = base;
      changed = true;
    }
  });
  if (changed) applyManualQuoteOverrides();
  return changed;
}

function manualQuoteRemainingText(pos) {
  const override = getManualQuoteOverride(pos);
  if (!override) return '';
  const ms = Math.max(0, new Date(override.expiresAt).getTime() - Date.now());
  const min = Math.ceil(ms / 60000);
  const time = new Date(override.expiresAt).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  return `aktiv bis ${time} · noch ca. ${min} min`;
}

function startManualQuoteExpiryTimer() {
  if (manualQuoteTimer) clearInterval(manualQuoteTimer);
  manualQuoteTimer = setInterval(async () => {
    if (!appData) return;
    if (pruneExpiredManualQuoteOverrides()) {
      await savePositionsToKV(0);
      await refreshUI({ skipAI: true });
    }
  }, 30000);
}

// Cashbestand zu einem Datum (oder heute) — bezieht Käufe/Verkäufe als Abflüsse/Zuflüsse mit ein
function isCashCreditType(type) { return ['deposit', 'dividend', 'distribution', 'interest', 'bonus', 'staking', 'refund', 'adjust-credit'].includes(type); }
function isCashDebitType(type) { return ['withdraw', 'fee', 'tax', 'adjust-debit'].includes(type); }
function cashTxLabel(type) {
  return ({ deposit: 'Einzahlung', withdraw: 'Auszahlung', fee: 'Gebühr', tax: 'Steuer', dividend: 'Dividende', distribution: 'Ausschüttung', interest: 'Zinsen', bonus: 'Bonus', staking: 'Staking', refund: 'Erstattung', 'adjust-credit': 'Saldo-Korrektur', 'adjust-debit': 'Saldo-Korrektur' })[type] || type;
}
function cashEffectiveDate(t) {
  if (!t) return '';
  return t.assetType === 'cash' ? (t.date || '') : (t.accountValuta || t.date || '');
}
function getCashBalance(asOfDate) {
  if (!Array.isArray(appData?.transactions)) return Number(appData?.goal?.cash || 0);
  const cutoff = asOfDate ? (asOfDate instanceof Date ? asOfDate.toISOString().slice(0, 10) : String(asOfDate)) : null;
  let bal = 0;
  let hasCashTx = false;
  appData.transactions.forEach(t => {
    if (cutoff && cashEffectiveDate(t) > cutoff) return;
    if (t.assetType === 'cash') {
      hasCashTx = true;
      if (isCashCreditType(t.txType)) bal += t.value;
      else if (isCashDebitType(t.txType)) bal -= t.value;
    } else {
      // Käufe ziehen Cash ab, Verkäufe schreiben Cash gut (Gegenbuchung)
      const accountCashValue = Number(t.accountCashValue);
      if (!t.cashNeutral && t.txType === 'buy') bal -= accountCashValue > 0 ? accountCashValue : (t.value + (t.fees || 0));
      else if (!t.cashNeutral && t.txType === 'sell') bal += accountCashValue > 0 ? accountCashValue : (t.value - (t.fees || 0));
    }
  });
  // Wenn keine Cash-Transaktionen vorhanden, fällt der Slider-Wert zurück
  if (!hasCashTx) return Number(appData?.goal?.cash || 0);
  return bal;
}
// Investiertes Kapital (Käufe minus Verkäufe) zu einem Datum
function getInvestedCapital(asOfDate) {
  if (!Array.isArray(appData?.transactions)) return 0;
  const cutoff = asOfDate ? (asOfDate instanceof Date ? asOfDate.toISOString().slice(0, 10) : String(asOfDate)) : null;
  let invested = 0;
  appData.transactions.forEach(t => {
    if (cutoff && (t.date || '') > cutoff) return;
    if (t.assetType === 'cash' || t.cashNeutral) return;
    const accountCashValue = Number(t.accountCashValue);
    if (t.txType === 'buy') invested += accountCashValue > 0 ? accountCashValue : t.value + (t.fees || 0);
    else if (t.txType === 'sell') invested -= accountCashValue > 0 ? accountCashValue : t.value;
  });
  return Math.max(0, invested);
}
function getTotalDeposits() {
  return (appData?.transactions || []).filter(t => t.assetType === 'cash' && t.txType === 'deposit').reduce((s, t) => s + t.value, 0);
}
function getTotalWithdrawals() {
  return (appData?.transactions || []).filter(t => t.assetType === 'cash' && t.txType === 'withdraw').reduce((s, t) => s + t.value, 0);
}
function hasCashTransactions() {
  return Array.isArray(appData?.transactions) && appData.transactions.some(t => t.assetType === 'cash');
}
function latestCashMovementDate() {
  return (appData?.transactions || [])
    .filter(t => t.assetType === 'cash')
    .map(t => cashEffectiveDate(t))
    .filter(Boolean)
    .sort()
    .pop() || '';
}
function currentCashValue() {
  return hasCashTransactions() ? getCashBalance() : Number(appData?.goal?.cash || 0);
}
function externalCashflowAmount(t) {
  if (!t || t.assetType !== 'cash') return 0;
  if (t.txType === 'deposit') return Number(t.value) || 0;
  if (t.txType === 'withdraw') return -(Number(t.value) || 0);
  return 0;
}
function getNetExternalContributions(asOfDate) {
  if (!Array.isArray(appData?.transactions)) return 0;
  const cutoff = asOfDate ? (asOfDate instanceof Date ? toIsoDate(asOfDate) : String(asOfDate)) : null;
  return appData.transactions.reduce((sum, t) => {
    const effectiveDate = cashEffectiveDate(t) || t.date || '';
    if (cutoff && effectiveDate > cutoff) return sum;
    return sum + externalCashflowAmount(t);
  }, 0);
}
function accountImportCashStats() {
  const txs = appData?.transactions || [];
  const cashRows = txs.filter(tx => tx.assetType === 'cash' && tx.accountImportSource === FLATEX_ACCOUNT_SOURCE);
  const depositRows = cashRows.filter(tx => tx.txType === 'deposit');
  const orderRows = txs.filter(tx => tx.assetType !== 'cash' && tx.accountOrderSource === FLATEX_ACCOUNT_SOURCE);
  const latest = cashRows.concat(orderRows).map(tx => cashEffectiveDate(tx)).filter(Boolean).sort().pop() || '';
  return { cashRows: cashRows.length, depositRows: depositRows.length, orderRows: orderRows.length, latest };
}
// Zeitgewichtete Rendite (TWR): Depotentwicklung bereinigt um externe Ein-/Auszahlungen.
// Käufe/Verkäufe innerhalb des Depots sind interne Umschichtungen und werden hier nicht als Cashflow abgezogen.
function computeTWR(points) {
  if (!points || points.length < 2) return null;
  const cashflowsByDate = {};
  (appData?.transactions || []).forEach(t => {
    const k = cashEffectiveDate(t) || t.date;
    if (!k) return;
    const flow = externalCashflowAmount(t);
    if (flow) cashflowsByDate[k] = (cashflowsByDate[k] || 0) + flow;
  });
  let product = 1;
  let validSegments = 0;
  for (let i = 1; i < points.length; i++) {
    const dateKey = toIsoDate(points[i].date);
    const cf = cashflowsByDate[dateKey] || 0;
    const prev = points[i - 1].value;
    const cur = points[i].value;
    if (prev <= 0) continue;
    const factor = (cur - cf) / prev;
    if (!isFinite(factor) || factor <= 0) continue;
    product *= factor;
    validSegments++;
  }
  if (validSegments === 0) return null;
  const firstMs = points[0].date.getTime();
  const lastMs = points[points.length - 1].date.getTime();
  const years = (lastMs - firstMs) / (365.25 * 24 * 3600 * 1000);
  const totalReturn = product - 1;
  if (years <= 0) return totalReturn;
  return Math.pow(product, 1 / years) - 1;
}
// Geldgewichtete Rendite (MWR/XIRR): nutzt echte externe Cash-Einzahlungen/-Auszahlungen.
// Deposit = Geld kommt von außen ins Depot (negativer Investor-Cashflow), Withdraw = Geld geht raus (positiv).
function computeMWR(currentValue) {
  if (!Array.isArray(appData?.transactions) || appData.transactions.length === 0) return null;
  const flows = [];
  appData.transactions.forEach(t => {
    const external = externalCashflowAmount(t);
    const flowDate = cashEffectiveDate(t) || t.date;
    if (!external || !flowDate) return;
    const dateMs = new Date(flowDate + 'T00:00:00').getTime();
    flows.push({ ms: dateMs, amount: -external });
  });
  if (!flows.some(f => f.amount < 0)) return null;
  flows.push({ ms: Date.now(), amount: currentValue });
  flows.sort((a, b) => a.ms - b.ms);
  if (!flows.some(f => f.amount > 0)) return null;

  const firstMs = flows[0].ms;
  const npv = (rate) => flows.reduce((s, f) => {
    const years = (f.ms - firstMs) / (365.25 * 24 * 3600 * 1000);
    return s + f.amount / Math.pow(1 + rate, years);
  }, 0);

  let low = -0.9999;
  let high = 10;
  let fLow = npv(low);
  let fHigh = npv(high);
  for (const candidate of [20, 50, 100]) {
    if (isFinite(fLow) && isFinite(fHigh) && fLow * fHigh <= 0) break;
    high = candidate;
    fHigh = npv(high);
  }
  if (!isFinite(fLow) || !isFinite(fHigh) || fLow * fHigh > 0) return null;

  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2;
    const fMid = npv(mid);
    if (!isFinite(fMid)) return null;
    if (Math.abs(fMid) < 0.01) return mid;
    if (fLow * fMid <= 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }
  return (low + high) / 2;
}
function plausiblePerformancePct(rate) {
  if (rate == null || !isFinite(rate)) return null;
  const pct = rate * 100;
  if (!isFinite(pct) || pct <= -95 || Math.abs(pct) > 500) return null;
  return pct;
}
function formatDateAT(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).split('-');
  return y && m && d ? `${d}.${m}.${y}` : String(iso);
}
function getPositionLots(pos) {
  const txLots = (appData?.transactions || [])
    .filter(t => t.assetId === pos.id && t.txType === 'buy' && Number(t.quantity) > 0)
    .map(t => ({
      date: t.date,
      shares: Number(t.quantity) || 0,
      costPrice: Number(t.price) || 0,
      value: Number(t.value) || (Number(t.quantity) || 0) * (Number(t.price) || 0)
    }));
  const legacyLots = (pos.purchaseLots || []).map(lot => ({
    date: lot.date,
    shares: Number(lot.shares) || 0,
    costPrice: Number(lot.costPrice) || 0,
    value: Number(lot.value) || (Number(lot.shares) || 0) * (Number(lot.costPrice) || 0)
  }));
  return (txLots.length ? txLots : legacyLots)
    .filter(lot => lot.date && lot.shares > 0)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
function sharesAtDate(pos, date) {
  // Wenn Transaktionen vorhanden, primär aus Tx-Modell rechnen (berücksichtigt Käufe + Verkäufe + Adjust in der Vergangenheit)
  if (Array.isArray(appData?.transactions) && appData.transactions.length > 0) {
    const cutoff = date instanceof Date ? date.toISOString().slice(0, 10) : String(date);
    const assetTxs = appData.transactions.filter(t => t.assetId === pos.id);
    const txs = assetTxs.filter(t => (t.date || '') <= cutoff);
    if (assetTxs.length > 0) {
      let shares = 0;
      txs.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')).forEach(t => {
        if (t.txType === 'buy') shares += Number(t.quantity) || 0;
        else if (t.txType === 'sell') shares -= Number(t.quantity) || 0;
        else if (t.txType === 'adjust') shares = Number(t.quantity) || 0;
      });
      return Math.max(0, shares);
    }
  }
  // Fallback: alte Lot-Daten
  if (!pos.purchaseLots || !pos.purchaseLots.length) return pos.shares;
  const cutoff = date instanceof Date ? date.toISOString().slice(0, 10) : String(date);
  return pos.purchaseLots.reduce((sum, lot) => lot.date <= cutoff ? sum + (Number(lot.shares) || 0) : sum, 0);
}
function buildStammdatenSection(pos, live, totals) {
  const meta = pos.stammdaten;
  const lots = getPositionLots(pos);
  if (!meta && !lots.length) return '';
  const valuation = getPositionValuation(pos, live);
  const valueEur = valuation.currentValue;
  const costValue = valuation.costValue;
  const pnlAbs = valuation.pnlAbs;
  const pnlPct = valuation.pnlPct;
  const pctPortfolio = totals && totals.totalCur > 0 ? (valueEur / totals.totalCur) * 100 : 0;
  const row = (label, value, cls = '') => value == null || value === '' ? '' : `<div class="stammdaten-row"><span class="lbl">${label}</span><span class="val ${cls}">${value}</span></div>`;
  const pnlClass = pnlAbs >= 0 ? 'positive' : 'negative';
  const rows = [
    row('Stück', fmtNum(valuation.shares, valuation.shares % 1 ? 6 : 0)),
    row('Kurs', fmtPrice(pos, live.price)),
    row('Gesamtwert', fmt.format(valueEur)),
    row('Einstandskurs', fmtPrice(pos, valuation.costPrice)),
    row('Einstandswert', fmt.format(costValue)),
    row('Entwicklung', `${pnlAbs >= 0 ? '+' : ''}${fmt.format(pnlAbs)}`, pnlClass),
    row('Entwicklung %', fmtPct(pnlPct), pnlClass),
    row('Anteil Portfolio', `${fmtNum(meta?.portfolioSharePct ?? pctPortfolio, 2)} %`),
    row('Anteil ETFs/Fonds', meta?.fundSharePct != null ? `${fmtNum(meta.fundSharePct, 2)} %` : null),
    row('Lagerstelle', meta?.custodian),
    row('Verwahrart', meta?.custodyType)
  ].join('');
  const lotRows = lots.length ? `<details class="lot-details">
    <summary><span>Käufe / Buchungen anzeigen</span><span>${lots.length} Eintrag${lots.length === 1 ? '' : 'e'}</span></summary>
    <div class="lot-table">
      <div class="lot-row head"><span>Datum</span><span>Stück</span><span>Einstand</span><span>Wert</span></div>
      ${lots.map(lot => `<div class="lot-row"><span>${formatDateAT(lot.date)}</span><span>${fmtNum(lot.shares, lot.shares % 1 ? 6 : 0)}</span><span>${fmtPrice(pos, lot.costPrice)}</span><span>${fmt.format(lot.value)}</span></div>`).join('')}
    </div>
  </details>` : '';
  return `<div class="stammdaten-box"><div class="stammdaten-title">Depot-Stammdaten</div><div class="stammdaten-grid">${rows}</div>${lotRows}</div>`;
}
