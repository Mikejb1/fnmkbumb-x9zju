// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== KI-EMPFEHLUNG pro Position (heuristisch) =====
function getRecommendation(pos, totals, alloc) {
  if (pos.special === 'cash' || pos.special === 'gold' || pos.special === 'metal') return null;
  const live = currentPrices[pos.id] || { price: pos.costPrice };
  const valuation = getPositionValuation(pos, live);
  const value = valuation.currentValue;
  const pct = totals.totalCur > 0 ? (value / totals.totalCur) * 100 : 0;
  const pnlPct = valuation.pnlPct;
  const risk = deriveRisk(pos);
  // Regeln (Reihenfolge ist wichtig)
  if (pct > 35 && (risk === 'high' || risk === 'very-high')) return { action: 'Teilverkauf', reason: `Klumpenrisiko bei volatilem Asset — ca. 25 % der Position (~${fmt.format(value * 0.25)}) reduzieren.`, kind: 'trim' };
  if (pct > 35) return { action: 'Teilverkauf', reason: `${fmtNum(pct, 0)} % deines Depots in einer Position — Klumpenrisiko reduzieren.`, kind: 'trim' };
  if (pnlPct < -20 && risk === 'low') return { action: 'Nachkaufen', reason: `Position ist ${fmtNum(pnlPct, 1)} % unter Einstand, Risk niedrig — Cost-Averaging-Chance.`, kind: 'buy' };
  if (pnlPct < -15 && (risk === 'high' || risk === 'very-high')) return { action: 'Beobachten', reason: `${fmtNum(pnlPct, 1)} % im Minus bei hohem Risiko — Trend abwarten, nicht emotional verkaufen.`, kind: 'watch' };
  if (pnlPct > 50 && (risk === 'high' || risk === 'very-high')) return { action: 'Teilverkauf', reason: `+${fmtNum(pnlPct, 0)} % Gewinn bei volatilem Asset — Teilgewinn realisieren sinnvoll.`, kind: 'trim' };
  if (pnlPct > 30 && pct < 10) return { action: 'Halten', reason: `Position läuft gut (+${fmtNum(pnlPct, 0)} %) und Allokation moderat — Position belassen.`, kind: 'hold' };
  return { action: 'Halten', reason: `Allokation (${fmtNum(pct, 0)} %) und Performance (${fmtNum(pnlPct, 1)} %) im Rahmen — keine Aktion nötig.`, kind: 'hold' };
}
function recIcon(kind) {
  const icons = {
    hold: '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>',
    buy: '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    trim: '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    watch: '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
  };
  return icons[kind] || icons.hold;
}

// ===== CHART TABS + LADEANIMATION =====
const chartCache = {};   // { posId: { day: pts, week: pts, month: pts } }
const chartTabState = {}; // { posId: 'day'|'week'|'month' }
function showChartLoading(posId, periodLabel) {
  const wrap = document.getElementById(`chartWrap-${posId}`);
  if (!wrap) return;
  const pos = appData.positions.find(p => p.id === posId);
  const live = currentPrices[posId];
  const src = pos?.cgId ? `CoinGecko · ${periodLabel}-Verlauf` : live?.live ? `${live.source || 'Marktdaten'} · aktueller Kurs` : 'Snapshot-Daten';
  wrap.innerHTML = `<div class="chart-loading">
    <div class="chart-loading-row">
      <span class="chart-loading-label">${periodLabel}chart wird geladen…</span>
      <span class="chart-loading-eta" id="chartEta-${posId}">~3 Sek</span>
    </div>
    <div class="chart-loading-bar"><div class="chart-loading-fill" id="chartFill-${posId}"></div></div>
    <div class="chart-loading-source">${src}</div>
  </div>`;
  setTimeout(() => { const f = document.getElementById(`chartFill-${posId}`); if (f) { f.style.transition = 'width 2.5s ease'; f.style.width = '90%'; } }, 30);
}
function showChartNoData(posId, msg) {
  const wrap = document.getElementById(`chartWrap-${posId}`);
  if (wrap) wrap.innerHTML = `<div class="chart-no-data">${msg}</div>`;
}
async function fetchChartData(pos, period) {
  if (!chartCache[pos.id]) chartCache[pos.id] = {};
  if (chartCache[pos.id][period]) return chartCache[pos.id][period];
  if (pos.cgId) {
    const days = period === 'day' ? 1 : period === 'week' ? 7 : 30;
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/coins/${pos.cgId}/market_chart?vs_currency=eur&days=${days}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const pts = data.prices || [];
      const step = Math.max(1, Math.floor(pts.length / (period === 'day' ? 24 : period === 'week' ? 14 : 30)));
      const sampled = [];
      for (let i = 0; i < pts.length; i += step) sampled.push(pts[i]);
      if (pts.length && sampled[sampled.length - 1] !== pts[pts.length - 1]) sampled.push(pts[pts.length - 1]);
      const out = sampled.map(([ts, price]) => { const d = new Date(ts); const label = period === 'day' ? String(d.getHours()).padStart(2, '0') + ':00' : String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0'); return { date: label, price, label }; });
      chartCache[pos.id][period] = out;
      return out;
    } catch (e) { return null; }
  } else {
    // Manuelle Positionen
    if (period === 'day') return 'no-day';
    if (period === 'week' && pos.weeklyHistory) { chartCache[pos.id].week = pos.weeklyHistory.map(p => ({ ...p, label: p.date })); return chartCache[pos.id].week; }
    if (period === 'month' && pos.monthlyHistory) { chartCache[pos.id].month = pos.monthlyHistory.map(p => ({ date: p.date, price: p.price, label: p.date })); return chartCache[pos.id].month; }
    return null;
  }
}
async function loadChartForPosition(pos, period) {
  chartTabState[pos.id] = period;
  const periodLabel = period === 'day' ? 'Tag' : period === 'week' ? 'Wochen' : 'Monats';
  // Tab-Buttons aktivieren
  document.querySelectorAll(`#chartTabs-${pos.id} .chart-tab`).forEach(b => b.classList.toggle('active', b.dataset.period === period));
  showChartLoading(pos.id, periodLabel);
  const data = await fetchChartData(pos, period);
  const wrap = document.getElementById(`chartWrap-${pos.id}`);
  if (!wrap) return;
  if (data === 'no-day') { showChartNoData(pos.id, 'Tagesverlauf nur bei Live-Crypto verfügbar — bitte Woche oder Monat wählen.'); return; }
  if (!data || data.length < 2) { showChartNoData(pos.id, 'Keine Chart-Daten verfügbar.'); return; }
  wrap.innerHTML = `<canvas id="chart-${pos.id}"></canvas>`;
  renderChart(`chart-${pos.id}`, data, 'price', {});
  const stampEl = document.getElementById(`chartStamp-${pos.id}`);
  if (stampEl) {
    const first = data[0].price, last = data[data.length - 1].price;
    const deltaPct = ((last - first) / first) * 100;
    const liveInfo = pos.cgId ? `Live · ${new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}` : currentPrices[pos.id]?.live ? `${currentPrices[pos.id].source || 'Marktdaten'} · aktueller Kurs` : 'manuelle Snapshots';
    stampEl.textContent = `${periodLabel === 'Tag' ? 'Letzte 24h' : periodLabel === 'Wochen' ? 'Letzte 7 Tage' : 'Letzte 30 Tage'} · ${deltaPct >= 0 ? '+' : ''}${fmtNum(deltaPct, 1)} % · ${liveInfo}`;
  }
}

function createEmptyAppData() {
  const nextYear = Math.max(new Date().getFullYear() + 1, 2027);
  return {
    schemaVersion: 2,
    goal: {
      year: nextYear,
      amount: 15000,
      savingsRate: 0,
      pathSavingsPct: 50,
      riskPct: 50,
      type: 'wealth',
      priority: 'medium',
      month: 12,
      minSavingsRate: 0,
      maxSavingsRate: 1000,
      bufferPct: 10,
      annualReturnPct: 4,
      cash: 0,
      targetAllocation: { etf: 40, aktie: 25, crypto: 20, gold: 10, cash: 5 },
      riskRules: {
        low: { min: 0, max: 5 },
        medium: { min: 5, max: 20 },
        high: { min: 20, max: 100 }
      }
    },
    positions: [],
    transactions: [],
    watchlist: [],
    journal: [],
    income: [],
    metalHistory: {},
    layout: null
  };
}

async function handleGate() {
  const code = document.getElementById('gatePw').value;
  const errEl = document.getElementById('gateError');
  errEl.classList.remove('visible');
  if (!code) { showErr(errEl, 'Bitte Code eingeben.'); return; }
  try {
    const hasBakedStartData = BAKED_BLOB && typeof BAKED_BLOB === 'object' && BAKED_BLOB.c;
    appData = hasBakedStartData ? await ENC.decrypt(BAKED_BLOB, code) : createEmptyAppData();
    appPassword = code;
    appUserKey = await deriveUserKey(code);   // unerratbarer KV-Schlüssel aus Master-Code
    appAuthToken = await deriveWorkerAuthToken(code); // Worker-Auth ohne statisches Frontend-Geheimnis
    if (!hasBakedStartData) await kvGetPositions(kvKeyActive()); // prueft den Worker-Hash, bevor ein leerer Zugang oeffnet
    kvLegacyMigrationDone = false;
    resetAutoLogout();                         // Inaktivitäts-Timer starten
    if (!Array.isArray(appData.transactions)) appData.transactions = [];
    if (!appData.schemaVersion) appData.schemaVersion = 1;
    document.getElementById('gatePw').value = '';
    showScreen('appScreen');
    // Falls KV-Daten vorhanden, mit gebakten Daten zusammenführen (KV gewinnt)
    try {
      const kvData = await loadPositionsFromKV();
      if (kvData && kvData.positions && Array.isArray(kvData.positions) && kvData.positions.length > 0) {
        appData.positions = kvData.positions;
        if (kvData.goal) appData.goal = kvData.goal;
        if (Array.isArray(kvData.transactions)) appData.transactions = kvData.transactions;
        if (kvData.schemaVersion) appData.schemaVersion = kvData.schemaVersion;
        if (kvData.metalHistory) appData.metalHistory = kvData.metalHistory;
        if (Array.isArray(kvData.watchlist)) appData.watchlist = kvData.watchlist;
        if (Array.isArray(kvData.journal)) appData.journal = kvData.journal;
        if (Array.isArray(kvData.income)) appData.income = kvData.income;
        if (kvData.layout) appData.layout = kvData.layout;
      }
    } catch (kvErr) { console.warn('KV-Sync beim Login fehlgeschlagen:', kvErr); }
    // Schema-Migration (v1 -> v2: Transaktionsmodell)
    const wasMigrated = !(Number(appData.schemaVersion) >= 2);
    migrateSchemaIfNeeded();
    // KV-Key-Migration: wenn Daten noch unter Legacy-Key liegen, einmal auf sicheren Key speichern
    const needsKeyMigration = !kvLegacyMigrationDone && appUserKey && appUserKey !== USER_KEY && appData.positions && appData.positions.length > 0;
    if (wasMigrated || needsKeyMigration) {
      try { await savePositionsToKV(); console.log('KV/Schema migriert (v' + appData.schemaVersion + ', Key: ' + kvKeyActive() + ')'); }
      catch (e) { console.warn('Migration-Save fehlgeschlagen:', e); }
    }
    await initApp();
  } catch (e) { showErr(errEl, 'Falscher Code.'); }
}
function handleLogout() { appData = null; appPassword = null; appUserKey = null; appAuthToken = null; kvLegacyMigrationDone = false; currentPrices = {}; baseLivePrices = {}; quoteIssues = {}; weeklyData = {}; chartRegistry = {}; if (manualQuoteTimer) { clearInterval(manualQuoteTimer); manualQuoteTimer = null; } if (typeof autoLogoutTimer !== 'undefined' && autoLogoutTimer) { clearTimeout(autoLogoutTimer); autoLogoutTimer = null; } document.getElementById('gatePw').value = ''; showScreen('gateScreen'); }
