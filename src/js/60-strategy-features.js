// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ============== STRATEGISCHE FEATURES (Rebalancing, Watchlist, Journal) ==
function ensureWatchlist() { if (!Array.isArray(appData.watchlist)) appData.watchlist = []; return appData.watchlist; }
function ensureJournal() { if (!Array.isArray(appData.journal)) appData.journal = []; return appData.journal; }
function getTargetAllocation() {
  return appData?.goal?.targetAllocation || { etf: 40, aktie: 25, crypto: 20, gold: 10, cash: 5 };
}

// ----- Rebalancing -----
function renderRebalancing(totals, alloc) {
  const body = document.getElementById('rebalBody');
  const statusBadge = document.getElementById('rebStatus');
  if (!body || !totals || !alloc) return;
  const target = getTargetAllocation();
  const cats = ['etf', 'aktie', 'crypto', 'gold', 'cash'];
  const labels = { etf: 'ETF', aktie: 'Aktien', crypto: 'Krypto', gold: 'Edelmetalle', cash: 'Cash' };
  let totalDelta = 0;
  const rows = cats.map(cat => {
    const actualPct = alloc.pcts[cat] || 0;
    const targetPct = target[cat] || 0;
    const deltaPct = actualPct - targetPct;
    const deltaEur = (deltaPct / 100) * totals.totalCur;
    totalDelta += Math.abs(deltaEur);
    const cls = Math.abs(deltaPct) < 2 ? 'ok' : (deltaPct > 0 ? 'over' : 'under');
    return `<div class="reb-row">
      <span class="lbl">${labels[cat]}</span>
      <div style="display:flex;align-items:center;gap:6px;">
        <input type="number" step="1" min="0" max="100" data-reb-target="${cat}" value="${targetPct}"> %
        <span style="color:var(--text-muted);font-size:10px;">aktuell ${fmtNum(actualPct, 1)} %</span>
      </div>
      <span class="delta ${cls}">${deltaPct >= 0 ? '+' : ''}${fmtNum(deltaPct, 1)} %<br><span style="font-size:10px;">${deltaEur >= 0 ? '+' : '−'}${fmt.format(Math.abs(deltaEur))}</span></span>
    </div>`;
  }).join('');
  // Sparrate-Hinweis: in welche Klasse fließt sie?
  const savingsRate = appData.goal?.savingsRate || 0;
  const underweight = cats.filter(c => (alloc.pcts[c] || 0) < (target[c] || 0)).map(c => ({ cat: c, gap: (target[c] - (alloc.pcts[c] || 0)) / 100 * totals.totalCur }));
  underweight.sort((a, b) => b.gap - a.gap);
  let savingsHint = '';
  if (savingsRate > 0 && underweight.length > 0) {
    const months = [3, 6, 12].map(m => {
      const u = underweight[0];
      const fill = (savingsRate * m / u.gap) * 100;
      return `${m} Mo → ${labels[u.cat]} ${fill >= 100 ? 'gedeckt' : '+' + fmtNum(fill, 0) + ' % der Lücke'}`;
    });
    savingsHint = `<div class="reb-sum-total">Sparrate ${fmt.format(savingsRate)}/Mo zuerst in <strong>${labels[underweight[0].cat]}</strong> (${fmt.format(underweight[0].gap)} Lücke). ${months.join(' · ')}</div>`;
  }
  body.innerHTML = `
    ${rows}
    <div class="reb-summary">
      Gesamt-Umschichtungsbedarf: <strong>${fmt.format(totalDelta / 2)}</strong>
      <div class="reb-sum-total">Geben die obigen Ziel-Werte ein. Werte werden in deinem Profil gespeichert.</div>
      ${savingsHint}
    </div>`;
  // Status-Badge
  const violations = cats.filter(c => Math.abs((alloc.pcts[c] || 0) - (target[c] || 0)) >= 5).length;
  if (statusBadge) statusBadge.textContent = violations === 0 ? 'im Ziel' : violations + ' abweichend';
  // Event-Listener für Ziel-Inputs
  body.querySelectorAll('[data-reb-target]').forEach(inp => {
    inp.addEventListener('change', async () => {
      const c = inp.dataset.rebTarget;
      const v = Math.max(0, Math.min(100, parseFloat(inp.value) || 0));
      if (!appData.goal) appData.goal = {};
      if (!appData.goal.targetAllocation) appData.goal.targetAllocation = { ...target };
      appData.goal.targetAllocation[c] = v;
      await savePositionsToKV();
      renderRebalancing(totals, alloc);
    });
  });
}

// ----- Watchlist -----
let editingWatchId = null;
function openWatchModal(id) {
  editingWatchId = id || null;
  const wl = ensureWatchlist();
  const entry = id ? wl.find(w => w.id === id) : null;
  document.getElementById('watchTitle').textContent = entry ? 'Watchlist bearbeiten' : 'Watchlist-Eintrag hinzufügen';
  document.getElementById('wlName').value = entry?.name || '';
  document.getElementById('wlSymbol').value = entry?.symbol || '';
  document.getElementById('wlTarget').value = entry?.targetEntry != null ? entry.targetEntry : '';
  document.getElementById('wlReason').value = entry?.reason || '';
  document.getElementById('wlRisk').value = entry?.risk || 'medium';
  document.getElementById('wlSize').value = entry?.plannedSize != null ? entry.plannedSize : '';
  document.getElementById('watchModal').classList.add('active');
  setTimeout(() => document.getElementById('wlName').focus(), 50);
}
function closeWatchModal() { document.getElementById('watchModal').classList.remove('active'); editingWatchId = null; }
async function saveWatchModal() {
  const name = document.getElementById('wlName').value.trim();
  if (!name) { alert('Bitte einen Namen eingeben.'); return; }
  const entry = {
    name,
    symbol: document.getElementById('wlSymbol').value.trim(),
    targetEntry: parseFloat(document.getElementById('wlTarget').value) || null,
    reason: document.getElementById('wlReason').value.trim(),
    risk: document.getElementById('wlRisk').value || 'medium',
    plannedSize: parseFloat(document.getElementById('wlSize').value) || null
  };
  const wl = ensureWatchlist();
  if (editingWatchId) {
    const idx = wl.findIndex(w => w.id === editingWatchId);
    if (idx >= 0) wl[idx] = { ...wl[idx], ...entry };
  } else {
    entry.id = 'wl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    entry.createdAt = new Date().toISOString();
    wl.push(entry);
  }
  closeWatchModal();
  await savePositionsToKV();
  renderWatchlist();
}
async function deleteWatchEntry(id) {
  if (!confirm('Watchlist-Eintrag wirklich löschen?')) return;
  appData.watchlist = (appData.watchlist || []).filter(w => w.id !== id);
  await savePositionsToKV();
  renderWatchlist();
}
function renderWatchlist() {
  const list = document.getElementById('watchlistList');
  const count = document.getElementById('watchlistCount');
  if (!list) return;
  const wl = ensureWatchlist();
  if (count) count.textContent = String(wl.length);
  if (wl.length === 0) {
    list.innerHTML = '<div class="strat-empty">Noch keine Watchlist-Einträge. Tap "Eintrag hinzufügen".</div>';
    return;
  }
  list.innerHTML = wl.map(w => `
    <div class="strat-item">
      <div class="info">
        <div class="name">${escapeHtml(w.name)}${w.symbol ? ' <span style="color:var(--text-muted);font-weight:400;">· ' + escapeHtml(w.symbol) + '</span>' : ''}<span class="risk-badge risk-${w.risk || 'medium'}" style="margin-left:6px;">${riskLabel(w.risk || 'medium')}</span></div>
        <div class="meta">${w.targetEntry ? 'Einstieg bei ' + fmtNum(w.targetEntry) + ' €' : ''}${w.plannedSize ? ' · Größe ' + fmt.format(w.plannedSize) : ''}</div>
        ${w.reason ? `<div class="reason">${escapeHtml(w.reason)}</div>` : ''}
      </div>
      <div class="actions">
        <button data-watch-edit="${w.id}" title="Bearbeiten" aria-label="Bearbeiten"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="danger" data-watch-del="${w.id}" title="Löschen" aria-label="Löschen"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
      </div>
    </div>`).join('');
}

// ----- Entscheidungsjournal -----
let editingJournalId = null;
function openJournalModal(id) {
  editingJournalId = id || null;
  const j = ensureJournal();
  const entry = id ? j.find(e => e.id === id) : null;
  document.getElementById('journalTitle').textContent = entry ? 'Journal bearbeiten' : 'Journal-Eintrag hinzufügen';
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('jrDate').value = entry?.date || today;
  document.getElementById('jrDecision').value = entry?.decision || '';
  document.getElementById('jrReason').value = entry?.reason || '';
  document.getElementById('jrExpect').value = entry?.expectation || '';
  document.getElementById('jrReview').value = entry?.reviewDate || '';
  document.getElementById('journalModal').classList.add('active');
  setTimeout(() => document.getElementById('jrDecision').focus(), 50);
}
function closeJournalModal() { document.getElementById('journalModal').classList.remove('active'); editingJournalId = null; }
async function saveJournalModal() {
  const decision = document.getElementById('jrDecision').value.trim();
  if (!decision) { alert('Bitte eine Entscheidung eingeben.'); return; }
  const entry = {
    date: document.getElementById('jrDate').value || new Date().toISOString().slice(0, 10),
    decision,
    reason: document.getElementById('jrReason').value.trim(),
    expectation: document.getElementById('jrExpect').value.trim(),
    reviewDate: document.getElementById('jrReview').value || null,
    status: 'open'
  };
  const j = ensureJournal();
  if (editingJournalId) {
    const idx = j.findIndex(e => e.id === editingJournalId);
    if (idx >= 0) j[idx] = { ...j[idx], ...entry };
  } else {
    entry.id = 'jr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    j.push(entry);
  }
  j.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  closeJournalModal();
  await savePositionsToKV();
  renderJournal();
}
async function deleteJournalEntry(id) {
  if (!confirm('Journal-Eintrag wirklich löschen?')) return;
  appData.journal = (appData.journal || []).filter(e => e.id !== id);
  await savePositionsToKV();
  renderJournal();
}
async function toggleJournalDone(id) {
  const j = ensureJournal();
  const entry = j.find(e => e.id === id);
  if (!entry) return;
  entry.status = entry.status === 'done' ? 'open' : 'done';
  await savePositionsToKV();
  renderJournal();
}
function renderJournal() {
  const list = document.getElementById('journalList');
  const count = document.getElementById('journalCount');
  if (!list) return;
  const j = ensureJournal();
  if (count) count.textContent = String(j.length);
  if (j.length === 0) {
    list.innerHTML = '<div class="strat-empty">Noch keine Journal-Einträge. Halte Entscheidungen mit Begründung und Review-Datum fest.</div>';
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  list.innerHTML = j.map(e => {
    let statusCls = 'open', statusLabel = 'OFFEN';
    if (e.status === 'done') { statusCls = 'done'; statusLabel = 'ERLEDIGT'; }
    else if (e.reviewDate && e.reviewDate <= today) { statusCls = 'due'; statusLabel = 'REVIEW FÄLLIG'; }
    return `<div class="strat-item">
      <div class="info">
        <div class="name">${escapeHtml(e.decision)} <span class="journal-status ${statusCls}">${statusLabel}</span></div>
        <div class="meta">${formatDateAT(e.date)}${e.reviewDate ? ' · Review: ' + formatDateAT(e.reviewDate) : ''}</div>
        ${e.reason ? `<div class="reason"><strong>Grund:</strong> ${escapeHtml(e.reason)}</div>` : ''}
        ${e.expectation ? `<div class="reason"><strong>Erwartung:</strong> ${escapeHtml(e.expectation)}</div>` : ''}
      </div>
      <div class="actions">
        <button data-journal-toggle="${e.id}" title="Erledigt umschalten" aria-label="Status umschalten"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>
        <button data-journal-edit="${e.id}" title="Bearbeiten" aria-label="Bearbeiten"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="danger" data-journal-del="${e.id}" title="Löschen" aria-label="Löschen"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
      </div>
    </div>`;
  }).join('');
}
