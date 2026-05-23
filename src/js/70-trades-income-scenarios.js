// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== NACHKÄUFE (auch in der Vergangenheit) =====
let buyingMorePosId = null;
function openBuyMoreModal(posId) {
  const pos = appData.positions.find(p => p.id === posId);
  if (!pos) return;
  buyingMorePosId = posId;
  document.getElementById('buyMoreTitle').textContent = 'Nachkauf: ' + pos.name;
  const live = currentPrices[posId] || { price: pos.costPrice };
  document.getElementById('buyMoreSubtitle').textContent = `Aktuell ${fmtNum(pos.shares, pos.shares % 1 === 0 ? 0 : 4)} Stk @ Ø ${fmtPrice(pos, pos.costPrice)} · letzter Kurs ${fmtPrice(pos, live.price)}`;
  document.getElementById('bmDate').value = new Date().toISOString().slice(0, 10);
  document.getElementById('bmShares').value = '';
  document.getElementById('bmPrice').value = fixedPriceInput(pos, live.price);
  document.getElementById('bmFees').value = '';
  document.getElementById('bmNote').value = '';
  document.getElementById('bmPreview').style.display = 'none';
  document.getElementById('buyMoreModal').classList.add('active');
  setTimeout(() => document.getElementById('bmShares').focus(), 50);
}
function closeBuyMoreModal() { document.getElementById('buyMoreModal').classList.remove('active'); buyingMorePosId = null; }
function updateBuyMorePreview() {
  if (!buyingMorePosId) return;
  const pos = appData.positions.find(p => p.id === buyingMorePosId);
  if (!pos) return;
  const shares = parseFloat(document.getElementById('bmShares').value) || 0;
  const price = parseFloat(document.getElementById('bmPrice').value) || 0;
  const fees = parseFloat(document.getElementById('bmFees').value) || 0;
  const preview = document.getElementById('bmPreview');
  const body = document.getElementById('bmPreviewBody');
  if (shares <= 0 || price <= 0) { preview.style.display = 'none'; return; }
  const newShares = pos.shares + shares;
  const newCostBasis = pos.costPrice * pos.shares + price * shares + fees;
  const newAvg = newShares > 0 ? newCostBasis / newShares : 0;
  body.innerHTML = `
    <div class="realized-line"><span class="lbl">Bestand neu</span><span>${fmtNum(newShares, newShares % 1 === 0 ? 0 : 4)} Stk</span></div>
    <div class="realized-line"><span class="lbl">Ø Einstand neu</span><span>${fmtPrice(pos, newAvg)} (vorher ${fmtPrice(pos, pos.costPrice)})</span></div>
    <div class="realized-line"><span class="lbl">Kaufwert</span><span>${fmt.format(shares * price + fees)}</span></div>
  `;
  preview.style.display = '';
}
async function saveBuyMoreModal() {
  if (!buyingMorePosId) return;
  const pos = appData.positions.find(p => p.id === buyingMorePosId);
  if (!pos) return;
  const date = document.getElementById('bmDate').value;
  const shares = parseFloat(document.getElementById('bmShares').value);
  const price = parseFloat(document.getElementById('bmPrice').value);
  const fees = parseFloat(document.getElementById('bmFees').value || '0');
  const note = document.getElementById('bmNote').value.trim();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { alert('Bitte gültiges Datum.'); return; }
  if (!isFinite(shares) || shares <= 0) { alert('Bitte gültige Stückzahl.'); return; }
  if (!isFinite(price) || price <= 0) { alert('Bitte gültigen Kaufpreis.'); return; }
  const kaufwert = shares * price;
  if (!Array.isArray(appData.transactions)) appData.transactions = [];
  // Buy-Tx anlegen
  appData.transactions.push({
    id: makeTxId(), date, assetId: pos.id, assetType: assetTypeOf(pos),
    txType: 'buy', quantity: shares, price, value: kaufwert, fees: isFinite(fees) ? fees : 0,
    note: note || 'Nachkauf'
  });
  // Position aktualisieren: Avg-Cost neu berechnen
  const newShares = pos.shares + shares;
  const newCostBasis = pos.costPrice * pos.shares + price * shares + (isFinite(fees) ? fees : 0);
  pos.shares = newShares;
  pos.costPrice = newShares > 0 ? newCostBasis / newShares : 0;
  // Cash abbuchen, falls Cash-Tx-Modus aktiv
  const hasCashTx = appData.transactions.some(t => t.assetType === 'cash');
  if (hasCashTx) {
    appData.transactions.push({
      id: makeTxId(), date, assetId: 'cash', assetType: 'cash', txType: 'withdraw',
      quantity: kaufwert + (isFinite(fees) ? fees : 0), price: 1, value: kaufwert + (isFinite(fees) ? fees : 0), fees: 0,
      note: 'Nachkauf ' + pos.name
    });
  }
  appData.transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  closeBuyMoreModal();
  await savePositionsToKV();
  await refreshUI();
}

// ===== VERKÄUFE / REALISIERTE G/V =====
let sellingPosId = null;
function openSellModal(posId) {
  const pos = appData.positions.find(p => p.id === posId);
  if (!pos) return;
  sellingPosId = posId;
  document.getElementById('sellTitle').textContent = 'Verkauf: ' + pos.name;
  const live = currentPrices[posId] || { price: pos.costPrice };
  document.getElementById('sellSubtitle').textContent = `Aktuell ${fmtNum(pos.shares, pos.shares % 1 === 0 ? 0 : 4)} Stk im Bestand · letzter Kurs ${fmtPrice(pos, live.price)}`;
  document.getElementById('sellDate').value = new Date().toISOString().slice(0, 10);
  document.getElementById('sellShares').value = '';
  document.getElementById('sellShares').max = pos.shares;
  document.getElementById('sellPrice').value = fixedPriceInput(pos, live.price);
  document.getElementById('sellFees').value = '';
  document.getElementById('sellNote').value = '';
  document.getElementById('sellPreview').style.display = 'none';
  document.getElementById('sellModal').classList.add('active');
  setTimeout(() => document.getElementById('sellShares').focus(), 50);
}
function closeSellModal() { document.getElementById('sellModal').classList.remove('active'); sellingPosId = null; }
function updateSellPreview() {
  if (!sellingPosId) return;
  const pos = appData.positions.find(p => p.id === sellingPosId);
  if (!pos) return;
  const shares = parseFloat(document.getElementById('sellShares').value) || 0;
  const price = parseFloat(document.getElementById('sellPrice').value) || 0;
  const fees = parseFloat(document.getElementById('sellFees').value) || 0;
  const preview = document.getElementById('sellPreview');
  const body = document.getElementById('sellPreviewBody');
  if (shares <= 0 || price <= 0) { preview.style.display = 'none'; return; }
  const erlös = shares * price;
  const avgBefore = pos.costPrice;
  const costAnteilig = avgBefore * shares;
  const realized = erlös - costAnteilig - fees;
  const cls = realized >= 0 ? 'positive' : 'negative';
  body.innerHTML = `
    <div class="realized-line"><span class="lbl">Verkaufserlös brutto</span><span>${fmt.format(erlös)}</span></div>
    <div class="realized-line"><span class="lbl">Einstand anteilig (Avg ${fmtPrice(pos, avgBefore)}/Stk)</span><span>${fmt.format(costAnteilig)}</span></div>
    ${fees > 0 ? `<div class="realized-line"><span class="lbl">Gebühr</span><span>−${fmt.format(fees)}</span></div>` : ''}
    <div class="realized-line" style="font-weight:600;border-top:1px solid var(--border-light);margin-top:4px;padding-top:4px;"><span class="lbl">Realisierter G/V</span><span class="${cls}">${realized >= 0 ? '+' : ''}${fmt.format(realized)}</span></div>
  `;
  preview.style.display = '';
  preview.classList.toggle('loss', realized < 0);
}
async function saveSellModal() {
  if (!sellingPosId) return;
  const pos = appData.positions.find(p => p.id === sellingPosId);
  if (!pos) return;
  const date = document.getElementById('sellDate').value;
  const shares = parseFloat(document.getElementById('sellShares').value);
  const price = parseFloat(document.getElementById('sellPrice').value);
  const fees = parseFloat(document.getElementById('sellFees').value || '0');
  const note = document.getElementById('sellNote').value.trim();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { alert('Bitte gültiges Datum.'); return; }
  if (!isFinite(shares) || shares <= 0) { alert('Bitte gültige Stückzahl.'); return; }
  if (shares > pos.shares + 1e-6) { alert(`Du hast nur ${pos.shares} Stk im Bestand.`); return; }
  if (!isFinite(price) || price <= 0) { alert('Bitte gültigen Verkaufspreis.'); return; }
  const erlös = shares * price;
  if (!Array.isArray(appData.transactions)) appData.transactions = [];
  // Sell-Transaktion anlegen
  appData.transactions.push({
    id: makeTxId(), date, assetId: pos.id, assetType: assetTypeOf(pos),
    txType: 'sell', quantity: shares, price, value: erlös, fees: isFinite(fees) ? fees : 0,
    note: note || 'Verkauf'
  });
  // pos.shares reduzieren (Avg-Cost bleibt gleich beim sell)
  pos.shares = Math.max(0, pos.shares - shares);
  // Cash gutbuchen, falls Cash-Tx-Modus aktiv
  const hasCashTx = appData.transactions.some(t => t.assetType === 'cash');
  if (hasCashTx) {
    appData.transactions.push({
      id: makeTxId(), date, assetId: 'cash', assetType: 'cash', txType: 'deposit',
      quantity: erlös - (isFinite(fees) ? fees : 0), price: 1, value: erlös - (isFinite(fees) ? fees : 0), fees: 0,
      note: 'Verkaufserlös ' + pos.name
    });
  }
  appData.transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  // Falls Position auf 0 fällt: User fragen ob entfernen
  if (pos.shares < 1e-6 && confirm('Position auf 0 Stück — komplett aus der Liste entfernen? (Verkaufs-Historie bleibt erhalten)')) {
    appData.positions = appData.positions.filter(p => p.id !== pos.id);
    delete currentPrices[pos.id]; delete weeklyData[pos.id];
  }
  closeSellModal();
  await savePositionsToKV();
  await refreshUI();
}

// ===== ERTRÄGE (Dividenden, Zinsen, Staking) =====
function ensureIncome() { if (!Array.isArray(appData.income)) appData.income = []; return appData.income; }
function ensureCashLedgerStart(date) {
  if (!Array.isArray(appData.transactions)) appData.transactions = [];
  if (appData.transactions.some(t => t.assetType === 'cash')) return false;
  const allBuys = appData.transactions.filter(t => t.assetType !== 'cash' && t.txType === 'buy').reduce((sum, t) => sum + (Number(t.value) || 0) + (Number(t.fees) || 0), 0);
  const allSells = appData.transactions.filter(t => t.assetType !== 'cash' && t.txType === 'sell').reduce((sum, t) => sum + (Number(t.value) || 0) - (Number(t.fees) || 0), 0);
  const initialDeposit = allBuys - allSells + Number(appData.goal?.cash || 0);
  if (initialDeposit <= 0) return false;
  const earliest = appData.transactions.filter(t => t.date).map(t => t.date).sort()[0] || date || new Date().toISOString().slice(0, 10);
  appData.transactions.push({
    id: makeTxId(), date: earliest, assetId: 'cash', assetType: 'cash', txType: 'deposit',
    quantity: initialDeposit, price: 1, value: initialDeposit, fees: 0,
    note: 'Automatische Initial-Einzahlung (deckt bisherige Käufe + Slider-Cash)'
  });
  return true;
}
function removeIncomeCashTransactions(incomeId) {
  const before = (appData.transactions || []).length;
  appData.transactions = (appData.transactions || []).filter(t => t.sourceIncomeId !== incomeId);
  return before !== appData.transactions.length;
}
function upsertIncomeCashTransactions(entry) {
  if (!entry?.id || !entry.date || !(Number(entry.gross) > 0)) return false;
  if (!Array.isArray(appData.transactions)) appData.transactions = [];
  ensureCashLedgerStart(entry.date);
  removeIncomeCashTransactions(entry.id);
  const name = INCOME_KIND_LABELS[entry.kind] || 'Ertrag';
  appData.transactions.push({
    id: makeTxId(), date: entry.date, assetId: 'cash', assetType: 'cash', txType: entry.kind || 'dividend',
    quantity: entry.gross, price: 1, value: entry.gross, fees: 0, sourceIncomeId: entry.id,
    note: `${name} brutto${entry.note ? ' · ' + entry.note : ''}`
  });
  if (Number(entry.tax) > 0) appData.transactions.push({
    id: makeTxId(), date: entry.date, assetId: 'cash', assetType: 'cash', txType: 'tax',
    quantity: entry.tax, price: 1, value: entry.tax, fees: 0, sourceIncomeId: entry.id,
    note: `Steuer/Abzug zu ${name}`
  });
  appData.transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return true;
}
function syncIncomeCashTransactions() {
  const list = ensureIncome();
  if (list.length === 0) return false;
  if (!Array.isArray(appData.transactions)) appData.transactions = [];
  let changed = false;
  list.forEach(entry => {
    const expected = entry.tax > 0 ? 2 : 1;
    const existing = appData.transactions.filter(t => t.sourceIncomeId === entry.id);
    if (existing.length !== expected) changed = upsertIncomeCashTransactions(entry) || changed;
  });
  return changed;
}
let editingIncomeId = null;
const INCOME_KIND_LABELS = { dividend: 'Dividende', distribution: 'Ausschüttung', interest: 'Zinsen', bonus: 'Bonus', staking: 'Staking' };
function openIncomeModal(id) {
  editingIncomeId = id || null;
  const list = ensureIncome();
  const entry = id ? list.find(e => e.id === id) : null;
  document.getElementById('incomeTitle').textContent = entry ? 'Ertrag bearbeiten' : 'Ertrag erfassen';
  document.getElementById('incDate').value = entry?.date || new Date().toISOString().slice(0, 10);
  // Position-Dropdown füllen
  const sel = document.getElementById('incPositionId');
  sel.innerHTML = '<option value="">— allgemein —</option>';
  (appData?.positions || []).forEach(p => {
    const o = document.createElement('option'); o.value = p.id; o.textContent = p.name + (p.symbol ? ' (' + p.symbol + ')' : '');
    sel.appendChild(o);
  });
  sel.value = entry?.positionId || '';
  document.getElementById('incKind').value = entry?.kind || 'dividend';
  document.getElementById('incGross').value = entry?.gross != null ? entry.gross : '';
  document.getElementById('incTax').value = entry?.tax != null ? entry.tax : '';
  document.getElementById('incNet').value = entry?.net != null ? entry.net : (entry?.gross || 0);
  document.getElementById('incNote').value = entry?.note || '';
  document.getElementById('incomeModal').classList.add('active');
  setTimeout(() => document.getElementById('incGross').focus(), 50);
}
function closeIncomeModal() { document.getElementById('incomeModal').classList.remove('active'); editingIncomeId = null; }
function updateIncomeNet() {
  const gross = parseFloat(document.getElementById('incGross').value) || 0;
  const tax = parseFloat(document.getElementById('incTax').value) || 0;
  const net = Math.max(0, gross - tax);
  document.getElementById('incNet').value = net.toFixed(2);
}
async function saveIncomeModal() {
  const date = document.getElementById('incDate').value;
  const gross = parseFloat(String(document.getElementById('incGross').value).replace(',', '.'));
  const tax = parseFloat(String(document.getElementById('incTax').value || '0').replace(',', '.'));
  const positionId = document.getElementById('incPositionId').value || null;
  const kind = document.getElementById('incKind').value || 'dividend';
  const note = document.getElementById('incNote').value.trim();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { alert('Bitte gültiges Datum.'); return; }
  if (!isFinite(gross) || gross <= 0) { alert('Bitte gültigen Brutto-Betrag eingeben.'); return; }
  const net = Math.max(0, gross - (isFinite(tax) ? tax : 0));
  const list = ensureIncome();
  let savedEntry = null;
  if (editingIncomeId) {
    const idx = list.findIndex(e => e.id === editingIncomeId);
    if (idx >= 0) {
      savedEntry = { ...list[idx], date, positionId, kind, gross, tax: tax || 0, net, note };
      list[idx] = savedEntry;
    }
  } else {
    savedEntry = { id: 'inc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6), date, positionId, kind, gross, tax: tax || 0, net, note };
    list.push(savedEntry);
  }
  if (savedEntry) upsertIncomeCashTransactions(savedEntry);
  list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  closeIncomeModal();
  await savePositionsToKV();
  renderIncome();
}
async function deleteIncome(id) {
  if (!confirm('Ertrag wirklich löschen?')) return;
  appData.income = (appData.income || []).filter(e => e.id !== id);
  removeIncomeCashTransactions(id);
  await savePositionsToKV();
  renderIncome();
}
function renderIncome() {
  const list = ensureIncome();
  if (syncIncomeCashTransactions()) savePositionsToKV(1200);
  const countEl = document.getElementById('incomeCount');
  if (countEl) countEl.textContent = String(list.length);
  const summaryEl = document.getElementById('incomeSummary');
  const listEl = document.getElementById('incomeList');
  if (!summaryEl || !listEl) return;
  const thisYear = new Date().getFullYear();
  const yearItems = list.filter(e => e.date && e.date.startsWith(String(thisYear)));
  const totalYear = yearItems.reduce((s, e) => s + (e.net || 0), 0);
  const byKind = {};
  yearItems.forEach(e => { byKind[e.kind] = (byKind[e.kind] || 0) + (e.net || 0); });
  const breakdown = Object.entries(byKind).map(([k, v]) => `${INCOME_KIND_LABELS[k] || k}: ${fmt.format(v)}`).join(' · ');
  summaryEl.innerHTML = `<div>Erträge ${thisYear}</div><div class="big">${fmt.format(totalYear)}</div>${breakdown ? `<div class="breakdown">${breakdown}</div>` : ''}`;
  if (list.length === 0) {
    listEl.innerHTML = '<div class="empty-state"><strong>Noch keine Erträge erfasst</strong><p>Erfasse Dividenden, Zinsen oder Staking-Erträge. Importierte Kontoumsätze können hier ebenfalls landen.</p><div class="empty-actions"><button type="button" class="empty-action-btn primary" data-empty-action="income">Ertrag erfassen</button></div></div>';
    return;
  }
  const newestFirst = list.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  listEl.classList.toggle('income-list-scroll', newestFirst.length > 3);
  listEl.style.maxHeight = '';
  listEl.innerHTML = newestFirst.map(e => {
    const posName = e.positionId ? (appData.positions.find(p => p.id === e.positionId)?.name || 'gelöschte Position') : 'allgemein';
    return `<div class="strat-item">
      <div class="info">
        <div class="name"><span class="income-kind-badge income-kind-${e.kind}">${INCOME_KIND_LABELS[e.kind] || e.kind}</span>${escapeHtml(posName)}</div>
        <div class="meta">${formatDateAT(e.date)}${e.note ? ' · ' + escapeHtml(e.note) : ''}</div>
        <div class="reason">Brutto ${fmt.format(e.gross)}${e.tax > 0 ? ' · Steuer −' + fmt.format(e.tax) : ''} · <strong>Netto ${fmt.format(e.net)}</strong></div>
      </div>
      <div class="actions">
        <button data-income-edit="${e.id}" title="Bearbeiten"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="danger" data-income-del="${e.id}" title="Löschen"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
      </div>
    </div>`;
  }).join('');
  if (newestFirst.length > 3) {
    requestAnimationFrame(() => {
      const firstThree = [...listEl.children].slice(0, 3);
      const height = firstThree.reduce((sum, node) => sum + node.getBoundingClientRect().height, 0) + 18;
      listEl.style.maxHeight = `${Math.ceil(height)}px`;
    });
  }
}

// ===== SZENARIO-RECHNER =====
function getScenarioDeltas() {
  const d = { etf: 0, aktie: 0, crypto: 0, gold: 0, savings: 0, return: 0 };
  document.querySelectorAll('[data-scenario]').forEach(inp => {
    const k = inp.dataset.scenario;
    if (k in d) d[k] = parseFloat(inp.value) || 0;
  });
  return d;
}
function applyScenario(totals, alloc, deltas) {
  // Berechne neue Werte je Kategorie: aktueller €-Wert × (1 + delta/100)
  if (!totals || !alloc || totals.totalCur <= 0) return null;
  const cats = ['etf', 'aktie', 'crypto', 'gold', 'cash'];
  const oldEur = {};
  cats.forEach(c => { oldEur[c] = alloc.abs[c] || 0; });
  const newEur = {
    etf: oldEur.etf * (1 + (deltas.etf || 0) / 100),
    aktie: oldEur.aktie * (1 + (deltas.aktie || 0) / 100),
    crypto: oldEur.crypto * (1 + (deltas.crypto || 0) / 100),
    gold: oldEur.gold * (1 + (deltas.gold || 0) / 100),
    cash: oldEur.cash
  };
  const newTotal = cats.reduce((s, c) => s + newEur[c], 0);
  const change = newTotal - totals.totalCur;
  const newAlloc = {};
  cats.forEach(c => { newAlloc[c] = newTotal > 0 ? (newEur[c] / newTotal) * 100 : 0; });
  return { newEur, newTotal, change, changePct: totals.totalCur > 0 ? (change / totals.totalCur) * 100 : 0, newAlloc };
}
function renderScenario(totals, alloc) {
  if (!totals || !alloc) return;
  const deltas = getScenarioDeltas();
  // Live-Labels in den Slidern
  document.querySelectorAll('[data-pct]').forEach(el => {
    const k = el.dataset.pct;
    const v = deltas[k] || 0;
    if (k === 'savings') el.textContent = `${v >= 0 ? '+' : ''}${fmtNoCent.format(v)}/Mo`;
    else if (k === 'return') el.textContent = `${v >= 0 ? '+' : ''}${fmtNum(v, 1)} % p.a.`;
    else el.textContent = (v >= 0 ? '+' : '') + v + ' %';
    el.classList.toggle('up', v > 0);
    el.classList.toggle('down', v < 0);
  });
  // Status-Badge im Sektions-Header
  const statusEl = document.getElementById('scenarioStatus');
  const marketAbsSum = Math.abs(deltas.etf) + Math.abs(deltas.aktie) + Math.abs(deltas.crypto) + Math.abs(deltas.gold);
  const planAbsSum = Math.abs(deltas.savings) + Math.abs(deltas.return);
  const absSum = marketAbsSum + planAbsSum;
  if (statusEl) statusEl.textContent = absSum === 0 ? '±0' : `Δ ${absSum}`;
  const result = applyScenario(totals, alloc, deltas);
  const resEl = document.getElementById('scenarioResult');
  if (!resEl) return;
  if (!result || absSum === 0) {
    resEl.innerHTML = '<div style="font-size:12px;color:var(--text-tertiary);text-align:center;padding:8px;">Verschiebe einen Regler, um ein Szenario zu simulieren.</div>';
    return;
  }
  // Neue Allokation: Risiko-Regeln neu prüfen
  const fakeTotals = { totalCur: result.newTotal };
  const fakeAlloc = { pcts: result.newAlloc, abs: result.newEur };
  const newRules = evaluateRiskRules(fakeTotals, fakeAlloc);
  const violations = newRules.filter(r => r.violated);
  // Ziel-Berechnung mit optionalem Sparraten- und Rendite-Hebel
  const goal = appData?.goal || {};
  let goalText = '';
  let projectionText = '';
  if (goal.amount && goal.year) {
    const scenarioSavings = Math.max(0, (Number(goal.savingsRate) || 0) + (Number(deltas.savings) || 0));
    const scenarioReturn = (Number(goal.annualReturnPct) || 0) + (Number(deltas.return) || 0);
    const today = new Date();
    const endDate = new Date(goal.year, (goal.month || 12) - 1, 28);
    const monthsToGoal = Math.max(1, Math.round((endDate - today) / (1000 * 60 * 60 * 24 * 30.44)));
    const projected = futureValueWithMonthlySavings(result.newTotal, scenarioSavings, monthsToGoal, scenarioReturn);
    const gap = goal.amount - projected;
    projectionText = `Mit ${fmtNoCent.format(scenarioSavings)}/Mo und ${fmtNum(scenarioReturn, 1)}% p.a.: <strong>${fmt.format(projected)}</strong>`;
    if (gap <= 0) {
      goalText = `Ziel <strong>bereits übertroffen</strong> (Puffer ${fmt.format(-gap)})`;
    } else {
      const requiredPerMo = gap / monthsToGoal;
      goalText = `Lücke zum Ziel: <strong>${fmt.format(gap)}</strong> in ${monthsToGoal} Monaten · ${fmt.format(requiredPerMo)}/Mo ohne Rendite`;
    }
  }
  const cls = result.change >= 0 ? 'positive' : 'negative';
  resEl.innerHTML = `
    <div class="scenario-result-row"><span class="lbl">Neuer Depotwert</span><span class="val">${fmt.format(result.newTotal)}</span></div>
    <div class="scenario-result-row"><span class="lbl">Veränderung</span><span class="val ${cls}">${result.change >= 0 ? '+' : ''}${fmt.format(result.change)} (${result.changePct >= 0 ? '+' : ''}${fmtNum(result.changePct, 1)} %)</span></div>
    <div class="scenario-result-row"><span class="lbl">Allokation neu</span><span class="val" style="font-size:11px;font-weight:400;color:var(--text-secondary);">ETF ${fmtNum(result.newAlloc.etf, 0)} % · Aktie ${fmtNum(result.newAlloc.aktie, 0)} % · Krypto ${fmtNum(result.newAlloc.crypto, 0)} % · Gold ${fmtNum(result.newAlloc.gold, 0)} % · Cash ${fmtNum(result.newAlloc.cash, 0)} %</span></div>
    ${projectionText ? `<div class="scenario-result-row"><span class="lbl">Ziel-Projektion</span><span class="val" style="font-weight:400;font-size:12px;">${projectionText}</span></div>` : ''}
    ${goalText ? `<div class="scenario-result-row"><span class="lbl">Ziel-Status</span><span class="val" style="font-weight:400;font-size:12px;">${goalText}</span></div>` : ''}
    ${violations.length > 0 ? `<div class="scenario-violations"><strong>Neue Regel-Verletzungen:</strong><br>${violations.map(v => '· ' + v.label + ': ' + v.value).join('<br>')}</div>` : ''}
  `;
}
