// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== RISIKO + KATEGORIEN =====
const SMALLCAP_CRYPTO_IDS = ['sui', 'apex', 'aptos', 'arbitrum', 'optimism', 'celestia', 'sei-network', 'injective-protocol', 'starknet'];
const METALS = [
  { key: 'gold', name: 'Gold', priceKey: 'goldPrice', gramsKey: 'goldGrams', fallbackPrice: 71.40, max: 500, color: '#f59e0b' },
  { key: 'silver', name: 'Silber', priceKey: 'silverPrice', gramsKey: 'silverGrams', fallbackPrice: 0.95, max: 5000, color: '#cbd5e1' },
  { key: 'platinum', name: 'Platin', priceKey: 'platinumPrice', gramsKey: 'platinumGrams', fallbackPrice: 30.50, max: 1000, color: '#93c5fd' },
  { key: 'palladium', name: 'Palladium', priceKey: 'palladiumPrice', gramsKey: 'palladiumGrams', fallbackPrice: 28.00, max: 1000, color: '#a78bfa' }
];
function ensureGoal() { if (!appData.goal) appData.goal = {}; return appData.goal; }
function metalPrice(metal) { return appData?.goal?.[metal.priceKey] || metal.fallbackPrice; }
function metalLots(metal) { return Array.isArray(appData?.goal?.metalLots?.[metal.key]) ? appData.goal.metalLots[metal.key] : []; }
function hasMetalLots(metal) { return metalLots(metal).length > 0; }
function metalGrams(metal) { const lots = metalLots(metal); return lots.length ? lots.reduce((sum, lot) => sum + (Number(lot.grams) || 0), 0) : (appData?.goal?.[metal.gramsKey] || 0); }
function metalCost(metal) { const lots = metalLots(metal); return lots.reduce((sum, lot) => sum + (Number(lot.value) || 0), 0); }
function metalAvgCost(metal) { const grams = metalGrams(metal); return grams > 0 ? metalCost(metal) / grams : 0; }
function metalValue(metal) { return metalGrams(metal) * metalPrice(metal); }
function metalsTotalValue() { return METALS.reduce((sum, metal) => sum + metalValue(metal), 0); }
function metalsTotalCost() { return METALS.reduce((sum, metal) => sum + (hasMetalLots(metal) ? metalCost(metal) : metalValue(metal)), 0); }
function metalGramsAtDate(metal, date) {
  // Primär aus Tx-Modell (berücksichtigt nachträgliche/historische Käufe)
  const assetId = 'metal_' + metal.key;
  if (Array.isArray(appData?.transactions) && appData.transactions.length > 0) {
    const cutoff = date instanceof Date ? toIsoDate(date) : String(date);
    const assetTxs = appData.transactions.filter(t => t.assetId === assetId);
    const txs = assetTxs.filter(t => (t.date || '') <= cutoff);
    if (assetTxs.length > 0) {
      let grams = 0;
      txs.forEach(t => {
        if (t.txType === 'buy') grams += Number(t.quantity) || 0;
        else if (t.txType === 'sell') grams -= Number(t.quantity) || 0;
      });
      return Math.max(0, grams);
    }
  }
  // Fallback: alte metalLots-Daten
  const lots = metalLots(metal);
  if (!lots.length) return metalGrams(metal);
  const cutoff = date instanceof Date ? toIsoDate(date) : String(date);
  return lots.reduce((sum, lot) => lot.date <= cutoff ? sum + (Number(lot.grams) || 0) : sum, 0);
}
// Versucht historischen Preis pro Gramm zum Datum zu finden.
// Bei Gold: Daten aus PAXG-Historie (CoinGecko). Bei anderen Metallen: lineare Interpolation
// zwischen Kauf-Lot-Preisen (date+value/grams) und aktuellem Spotpreis.
function metalPriceAtDate(metal, date) {
  const iso = date instanceof Date ? toIsoDate(date) : String(date);
  // 1) Echte Historie (Gold)
  const hist = appData?.metalHistory?.[metal.key];
  if (hist) {
    const keys = Object.keys(hist).sort();
    let matched = null;
    for (const k of keys) { if (k <= iso) matched = k; else break; }
    if (matched && hist[matched] > 0) return hist[matched];
    if (keys.length > 0 && hist[keys[0]] > 0) return hist[keys[0]];
  }
  // 2) Interpolation aus Kauf-Lots: behandle Lot-Preis als Anker, Spot als heutigen Anker
  const lots = metalLots(metal);
  const spotPrice = metalPrice(metal);
  if (lots.length > 0) {
    // Anker: für jeden Lot ein {date, price/g}, plus heute mit aktuellem Spot
    const anchors = lots
      .filter(l => l.grams > 0 && l.value > 0)
      .map(l => ({ date: l.date, price: l.value / l.grams }))
      .sort((a, b) => a.date.localeCompare(b.date));
    anchors.push({ date: toIsoDate(new Date()), price: spotPrice });
    // Finde den passenden Anker oder interpoliere linear
    let before = null, after = null;
    for (const a of anchors) {
      if (a.date <= iso) before = a;
      else if (a.date > iso && !after) { after = a; break; }
    }
    if (before && after) {
      const t = (new Date(iso).getTime() - new Date(before.date).getTime()) / (new Date(after.date).getTime() - new Date(before.date).getTime() || 1);
      return before.price + (after.price - before.price) * t;
    }
    if (before) return before.price;
    if (after) return after.price;
  }
  return spotPrice;
}
function metalsValueAtDate(date, isToday) {
  return METALS.reduce((sum, metal) => sum + metalGramsAtDate(metal, date) * (isToday ? metalPrice(metal) : metalPriceAtDate(metal, date)), 0);
}
function metalSourceClass(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('cache')) return 'cache';
  if (s.includes('fallback')) return 'fallback';
  if (s.includes('gold&co') || s.includes('gold und co')) return 'primary';
  return '';
}
function metalSourceShort(source) {
  const s = String(source || '').trim();
  if (!s) return 'Quelle offen';
  if (s.includes('Gold&Co')) return 'Gold&Co';
  if (s.includes('Fallback')) return 'Fallback';
  if (s.includes('Cache')) return 'Cache';
  return s;
}
function metalSourceSummary() {
  const goal = appData?.goal || {};
  const cache = goal.metalPriceCache || {};
  const date = goal.metalPriceUpdatedAt ? new Date(goal.metalPriceUpdatedAt) : null;
  const stamp = date && !isNaN(date)
    ? date.toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : 'noch nicht aktualisiert';
  if (cache.hit) return `Cache · ${cache.ageMinutes || 0} min alt · ${stamp}`;
  return `Live-Abfrage · ${stamp}`;
}
function buildMetalSourcePanel() {
  const goal = appData?.goal || {};
  const sources = goal.metalPriceSources || {};
  const warnings = Array.isArray(goal.metalPriceWarnings) ? goal.metalPriceWarnings : [];
  const warningHtml = warnings.length
    ? `<div class="metal-warning-box">${escapeHtml(warnings.slice(0, 3).join(' · '))}</div>`
    : '';
  return `<div class="metal-source-panel">
    <div class="metal-source-head">
      <strong>Preisquellen</strong>
      <span class="stamp">${escapeHtml(metalSourceSummary())}</span>
    </div>
    <div class="metal-source-grid">
      ${METALS.map(metal => {
        const source = sources[metal.key] || goal.metalPriceSource || 'Quelle offen';
        return `<div class="metal-source-pill ${metalSourceClass(source)}">
          <span class="name">${metal.name}</span>
          <span class="src">${escapeHtml(metalSourceShort(source))}</span>
        </div>`;
      }).join('')}
    </div>
    <div class="metal-source-note">Gold und Silber bevorzugt von Gold&Co; Platin und Palladium über Markt-Fallback. Unplausible Werte werden nicht übernommen.</div>
    ${warningHtml}
  </div>`;
}
// Lädt historische Gold-Preise via PAXG (1 PAXG = 1 troy ounce). Resultat: €/Gramm pro Datum.
async function fetchMetalHistory(daysBack = 365) {
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/pax-gold/market_chart?vs_currency=eur&days=${daysBack}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const pts = data.prices || [];
    if (!pts.length) return;
    if (!appData.metalHistory) appData.metalHistory = {};
    const goldHist = {};
    // 1 Tag = 1 Eintrag (CoinGecko gibt bei 90+ Tagen tägliche Punkte)
    const seen = new Set();
    pts.forEach(([ts, ozPrice]) => {
      const d = new Date(ts);
      const iso = d.toISOString().slice(0, 10);
      if (seen.has(iso)) return;
      seen.add(iso);
      goldHist[iso] = ozPrice / 31.1035; // €/g
    });
    appData.metalHistory.gold = goldHist;
    appData.metalHistory.updatedAt = new Date().toISOString();
  } catch (e) { console.warn('Metal-Historie (PAXG) fetch failed:', e); }
}
function startMetalsProgress() {
  const wrap = document.getElementById('metalsProgress'), fill = document.getElementById('metalsProgressFill'), eta = document.getElementById('metalsProgressEta'), text = document.getElementById('metalsProgressText'), btn = document.getElementById('metalsRefreshBtn');
  if (!wrap || !fill) return;
  if (metalsProgressState?.etaInterval) clearInterval(metalsProgressState.etaInterval);
  const duration = 10000, startTime = Date.now();
  wrap.classList.add('active');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  if (text) text.textContent = 'Edelmetallkurse werden aktualisiert…';
  fill.style.transition = 'none';
  fill.style.width = '0%';
  fill.offsetWidth;
  requestAnimationFrame(() => { fill.style.transition = `width ${duration}ms linear`; fill.style.width = '95%'; });
  const update = () => { if (eta) { const remain = Math.max(0, Math.ceil((duration - (Date.now() - startTime)) / 1000)); eta.textContent = remain > 0 ? `Noch ca. ${remain} Sek` : 'Fast fertig…'; } };
  update();
  metalsProgressState = { etaInterval: setInterval(update, 500), startTime };
}
function completeMetalsProgress(success) {
  const wrap = document.getElementById('metalsProgress'), fill = document.getElementById('metalsProgressFill'), eta = document.getElementById('metalsProgressEta'), text = document.getElementById('metalsProgressText'), btn = document.getElementById('metalsRefreshBtn');
  if (metalsProgressState?.etaInterval) clearInterval(metalsProgressState.etaInterval);
  if (fill) { fill.style.transition = 'width 0.35s ease'; fill.style.width = '100%'; }
  if (text) text.textContent = success ? 'Edelmetallkurse aktualisiert' : 'Aktualisierung fehlgeschlagen';
  if (eta) eta.textContent = success ? 'Fertig' : 'Letzte Werte bleiben aktiv';
  if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  setTimeout(() => { if (wrap) wrap.classList.remove('active'); }, 1200);
  metalsProgressState = null;
}
function deriveRisk(pos) {
  if (pos.risk) return pos.risk;
  if (pos.special === 'cash') return 'low';
  if (pos.special === 'gold' || pos.special === 'metal') return 'medium';
  const type = (pos.type || '').toLowerCase();
  if (type === 'etf') {
    const name = (pos.name || '').toLowerCase();
    if (name.includes('msci world') || name.includes('s&p 500') || name.includes('ftse all')) return 'low';
    return 'medium';
  }
  if (type === 'aktie' || type === 'stock') return 'medium';
  if (type === 'crypto') {
    const id = (pos.cgId || '').toLowerCase();
    if (id === 'bitcoin' || id === 'ethereum') return 'medium';
    if (SMALLCAP_CRYPTO_IDS.includes(id)) return 'very-high';
    return 'high';
  }
  return 'medium';
}
function riskLabel(r) { return { 'low': 'NIEDRIG', 'medium': 'MITTEL', 'high': 'HOCH', 'very-high': 'SEHR HOCH' }[r] || 'MITTEL'; }
function categoryOf(pos) {
  if (pos.special === 'cash') return 'cash';
  if (pos.special === 'gold' || pos.special === 'metal') return 'gold';
  const t = (pos.type || '').toLowerCase();
  if (t === 'crypto') return 'crypto';
  if (t === 'etf') return 'etf';
  if (t === 'aktie' || t === 'stock') return 'aktie';
  return 'aktie';
}
