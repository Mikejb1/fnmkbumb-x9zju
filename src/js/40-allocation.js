// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== ASSET-ALLOKATION =====
function buildAllSpecialPositions() {
  // Konstruiert virtuelle Cash + Edelmetall Positionen aus appData.goal
  const list = [];
  if (!appData) return list;
  METALS.forEach(metal => {
    const grams = metalGrams(metal);
    const price = metalPrice(metal);
    if (grams > 0) list.push({ id: `__${metal.key}`, special: 'metal', metalKey: metal.key, name: metal.name, type: 'Edelmetall', symbol: `${price.toFixed(2)} €/g`, shares: grams, costPrice: hasMetalLots(metal) ? metalAvgCost(metal) : price, manualPrice: price });
  });
  const cash = currentCashValue();
  if (cash > 0) list.push({ id: '__cash', special: 'cash', name: 'Cash', type: 'Bargeld', symbol: 'Verrechnungskonto', shares: 1, costPrice: cash, manualPrice: cash });
  return list;
}
function currentPortfolioPositions() {
  return (appData?.positions || []).filter(pos => {
    if (pos.archived) return false;
    const valuation = getPositionValuation(pos);
    return valuation.shares > 1e-9;
  });
}
function getAllPositions() {
  return [...currentPortfolioPositions(), ...buildAllSpecialPositions()];
}
function getCategoryAllocation(totalCur) {
  const cats = { etf: 0, aktie: 0, crypto: 0, gold: 0, cash: 0 };
  getAllPositions().forEach(pos => {
    const live = currentPrices[pos.id] || { price: pos.costPrice };
    const value = getPositionValuation(pos, live).currentValue;
    cats[categoryOf(pos)] += value;
  });
  const result = {};
  for (const k of Object.keys(cats)) result[k] = totalCur > 0 ? (cats[k] / totalCur) * 100 : 0;
  return { pcts: result, abs: cats };
}
function getCryptoBreakdown(totalCur) {
  const arr = [];
  (appData?.positions || []).filter(p => categoryOf(p) === 'crypto').forEach(pos => {
    const live = currentPrices[pos.id] || { price: pos.costPrice };
    const value = getPositionValuation(pos, live).currentValue;
    arr.push({ name: pos.name, pct: totalCur > 0 ? (value / totalCur) * 100 : 0 });
  });
  return arr.sort((a, b) => b.pct - a.pct);
}
function computeDiversificationScore(alloc, totalCur) {
  if (!totalCur || totalCur <= 0) return 0;
  let score = 0;
  // Anzahl Positionen (max 25)
  const count = getAllPositions().length;
  score += Math.min(25, count * 5);
  // Maximale Einzelposition (max 25)
  let maxPct = 0;
  getAllPositions().forEach(pos => {
    const live = currentPrices[pos.id] || { price: pos.costPrice };
    const value = getPositionValuation(pos, live).currentValue;
    const pct = (value / totalCur) * 100;
    if (pct > maxPct) maxPct = pct;
  });
  if (maxPct < 25) score += 25;
  else if (maxPct < 40) score += 15;
  else if (maxPct < 55) score += 5;
  // ETF-Anteil (max 20)
  if (alloc.pcts.etf >= 40) score += 20;
  else if (alloc.pcts.etf >= 20) score += 12;
  else if (alloc.pcts.etf >= 10) score += 6;
  // Cash + Edelmetalle Stabilisator (max 15)
  const stable = alloc.pcts.cash + alloc.pcts.gold;
  if (stable >= 10) score += 15;
  else if (stable >= 5) score += 8;
  else if (stable > 0) score += 3;
  // Krypto-Anteil (max 15) — moderates Risiko erwünscht
  if (alloc.pcts.crypto >= 5 && alloc.pcts.crypto <= 30) score += 15;
  else if (alloc.pcts.crypto < 5) score += 8;
  else if (alloc.pcts.crypto <= 50) score += 5;
  return Math.min(100, Math.round(score));
}
function renderAllocation(totals) {
  if (!totals || totals.totalCur <= 0) return;
  const alloc = getCategoryAllocation(totals.totalCur);
  const bar = document.getElementById('allocBar');
  const legend = document.getElementById('allocLegend');
  if (!bar || !legend) return;
  const segs = [
    { key: 'etf', label: 'ETF', cls: 'alloc-seg-etf', color: '#3b82f6' },
    { key: 'aktie', label: 'Aktie', cls: 'alloc-seg-aktie', color: '#10b981' },
    { key: 'gold', label: 'Au', cls: 'alloc-seg-gold', color: '#f59e0b' },
    { key: 'crypto', label: 'Krypto', cls: 'alloc-seg-crypto', color: '#a855f7' },
    { key: 'cash', label: 'Cash', cls: 'alloc-seg-cash', color: '#6b7280' }
  ];
  bar.innerHTML = segs.filter(s => alloc.pcts[s.key] > 0).map(s => `<div class="alloc-seg ${s.cls}" style="width:${alloc.pcts[s.key]}%">${alloc.pcts[s.key] >= 12 ? s.label + ' ' + Math.round(alloc.pcts[s.key]) + ' %' : ''}</div>`).join('');
  const legendNames = { etf: 'ETF', aktie: 'Aktie', gold: 'Gold', crypto: 'Krypto', cash: 'Cash' };
  legend.innerHTML = segs.filter(s => alloc.pcts[s.key] > 0).map(s => `<div class="alloc-legend-item"><span><span class="alloc-legend-dot" style="background:${s.color}"></span>${legendNames[s.key]}</span><strong>${fmtNum(alloc.pcts[s.key], 1)} %</strong></div>`).join('');
  // Diversifikations-Score
  const score = computeDiversificationScore(alloc, totals.totalCur);
  const scoreEl = document.getElementById('allocScore');
  if (scoreEl) {
    scoreEl.innerHTML = `${score}<span class="denom">/100</span>`;
    scoreEl.className = 'alloc-score-value ' + (score >= 70 ? 'score-high' : score >= 45 ? 'score-mid' : 'score-low');
  }
  // Krypto-Drilldown
  const drill = document.getElementById('allocCryptoDrill');
  const tags = document.getElementById('allocCryptoTags');
  const title = document.getElementById('allocCryptoTitle');
  if (drill && tags && title) {
    const breakdown = getCryptoBreakdown(totals.totalCur);
    if (breakdown.length > 0) {
      title.textContent = `Krypto-Aufteilung (${fmtNum(alloc.pcts.crypto, 0)} %)`;
      tags.innerHTML = breakdown.map(b => `<span class="alloc-crypto-tag">${escapeHtml(b.name)} ${fmtNum(b.pct, 0)} %</span>`).join('');
      drill.style.display = '';
    } else { drill.style.display = 'none'; }
  }
  // Risiko-Regeln + Datenqualität mit aktualisieren
  renderRiskRules(totals, alloc);
  renderDataQuality(totals);
  return alloc;
}
