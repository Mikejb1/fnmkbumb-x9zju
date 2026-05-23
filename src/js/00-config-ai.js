// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== AI-Worker (Cloudflare + Anthropic) =====
const AI_WORKER_URL = 'https://morning-tree-9bb.michael-bummer.workers.dev';
const AI_APP_TOKEN = '';
const USER_KEY = '__USER_KEY__';  // KV-Trennung pro Person
const STORAGE_PREFIX = `portfolio_${USER_KEY}_`;
const AI_DURATION_KEY = STORAGE_PREFIX + 'ai_avg_duration_ms';
const AI_DEFAULT_DURATION = 10000;
const REFRESH_DURATION_KEY = STORAGE_PREFIX + 'refresh_avg_duration_ms';
const REFRESH_DEFAULT_DURATION = 14000;
const REFRESH_MIN_VISIBLE_MS = 1200;
const MANUAL_QUOTE_OVERRIDE_MS = 30 * 60 * 1000;
let aiProgressState = null, aiRegenTimer = null, refreshProgressState = null;

const LAYOUT_STORAGE_KEY = STORAGE_PREFIX + 'layout_v1';
const POSITIONS_PANEL_OPEN_KEY = STORAGE_PREFIX + 'positions_panel_open_v1';
const POSITIONS_HEIGHT_KEY = STORAGE_PREFIX + 'positions_visible_cards_v1';
const POSITIONS_VISIBLE_DEFAULT = 3;
const POSITIONS_VISIBLE_MIN = 2;
const POSITIONS_VISIBLE_MAX = 8;
const LAYOUT_SECTIONS = [
  { key: 'overview', label: 'Depot Stand', meta: 'Gesamtwert, Tageswert, Drawdown, Sparrate', selectors: ['#anchor-top'], nav: 'anchor-top' },
  { key: 'addPosition', label: 'Position hinzufügen', meta: 'Manuell oder per Screenshot & KI', selectors: ['.add-position-section'] },
  { key: 'allocation', label: 'Asset-Allokation', meta: 'Aufteilung und Diversifikation', selectors: ['.alloc-section'] },
  { key: 'riskRules', label: 'Risiko-Regeln', meta: 'Grenzen und Hinweise', selectors: ['#riskRulesSection'] },
  { key: 'quality', label: 'Datenqualität', meta: 'Prüfung der Eingaben', selectors: ['#qualitySection'] },
  { key: 'dailyCheck', label: 'Heute prüfen', meta: 'Tages-Check und To-dos', selectors: ['#dailyCheckSection'] },
  { key: 'alerts', label: 'Hinweise', meta: 'Lokale Warnungen und Aufgaben', selectors: ['#anchor-alerts', '#alertsSection'], nav: 'anchor-alerts' },
  { key: 'news', label: 'Depot-News', meta: 'Aktuelle Meldungen zu Depotpositionen', selectors: ['#anchor-news', '#newsSection'], nav: 'anchor-news' },
  { key: 'positions', label: 'Positionen', meta: 'Aktien, ETF und Krypto', selectors: ['#anchor-positions'], nav: 'anchor-positions' },
  { key: 'metalsCard', label: 'Edelmetalle', meta: 'Karte innerhalb Positionen', selectors: ['#card-metals'] },
  { key: 'cashCard', label: 'Cash', meta: 'Cash-Saldo und Bewegungen', selectors: ['#card-cash'] },
  { key: 'history', label: 'Depot-Entwicklung', meta: 'Chart, Wochen-/Monatsansicht', selectors: ['#anchor-history'], nav: 'anchor-history' },
  { key: 'goal', label: 'Ziel', meta: 'Zielbetrag, Sparrate, Risiko', selectors: ['#anchor-goal'], nav: 'anchor-goal' },
  { key: 'savings', label: 'Sparplan-Simulation', meta: 'Monatsraten und Ziel-Lücke', selectors: ['.savings-sim-section'] },
  { key: 'analysis', label: 'Analyse & Tipps', meta: 'Lokale und KI-Analyse', selectors: ['.analysis-section'] },
  { key: 'usage', label: 'API-Nutzung', meta: 'Kosten und Aufrufe', selectors: ['.usage-section'] },
  { key: 'rebalancing', label: 'Rebalancing-Simulator', meta: 'Soll-/Ist-Abgleich', selectors: ['#anchor-rebalancing', '#rebalSection'], nav: 'anchor-rebalancing' },
  { key: 'scenario', label: 'Szenario-Rechner', meta: 'Was-wäre-wenn Regler', selectors: ['#anchor-scenario', '#scenarioSection'], nav: 'anchor-scenario' },
  { key: 'watchlist', label: 'Watchlist', meta: 'Kandidaten beobachten', selectors: ['#anchor-watchlist', '#watchlistSection'], nav: 'anchor-watchlist' },
  { key: 'journal', label: 'Entscheidungs-Journal', meta: 'Gedanken und Reviews', selectors: ['#anchor-journal', '#journalSection'], nav: 'anchor-journal' },
  { key: 'income', label: 'Erträge', meta: 'Dividenden, Zinsen, Staking', selectors: ['#anchor-income', '#incomeSection'], nav: 'anchor-income' },
  { key: 'taxPerformance', label: 'Steuer & Performance', meta: 'Realisierte Gewinne, Erträge und Gebühren', selectors: ['#anchor-tax', '#taxPerformanceSection'], nav: 'anchor-tax' },
  { key: 'privacy', label: 'Datenschutz', meta: 'Speicherung und Verschlüsselung', selectors: ['.privacy-section'] },
  { key: 'security', label: 'Sicherheitsstatus', meta: 'CSP, KI-Datenschutz und Sitzung', selectors: ['#securitySection'] },
  { key: 'backup', label: 'Backup & Export', meta: 'JSON und CSV', selectors: ['.backup-section'] },
  { key: 'chat', label: 'KI-Chat', meta: 'Fragen und Gedächtnis', selectors: ['#anchor-chat'], nav: 'anchor-chat' },
  { key: 'footer', label: 'Fußzeile', meta: 'Kurzer Hinweis am Ende', selectors: ['.footer'] }
];

function defaultLayoutSettings() {
  return { sectionOrder: LAYOUT_SECTIONS.map(s => s.key), hidden: [] };
}

function loadLayoutSettings() {
  const fallback = defaultLayoutSettings();
  try {
    if (appData?.layout) {
      const parsed = appData.layout;
      const validKeys = new Set(LAYOUT_SECTIONS.map(s => s.key));
      const sectionOrder = Array.isArray(parsed.sectionOrder)
        ? parsed.sectionOrder.filter(k => validKeys.has(k))
        : [];
      LAYOUT_SECTIONS.forEach(s => { if (!sectionOrder.includes(s.key)) sectionOrder.push(s.key); });
      const hidden = Array.isArray(parsed.hidden)
        ? parsed.hidden.filter(k => validKeys.has(k))
        : [];
      return { sectionOrder, hidden };
    }
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    const validKeys = new Set(LAYOUT_SECTIONS.map(s => s.key));
    const sectionOrder = Array.isArray(parsed.sectionOrder)
      ? parsed.sectionOrder.filter(k => validKeys.has(k))
      : [];
    LAYOUT_SECTIONS.forEach(s => { if (!sectionOrder.includes(s.key)) sectionOrder.push(s.key); });
    const hidden = Array.isArray(parsed.hidden)
      ? parsed.hidden.filter(k => validKeys.has(k))
      : [];
    return { sectionOrder, hidden };
  } catch (e) {
    return fallback;
  }
}

function saveLayoutSettings(settings) {
  try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
  if (appData) appData.layout = settings;
}

function sectionNodes(section) {
  return section.selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
}

function applyLayoutSettings() {
  const settings = loadLayoutSettings();
  const hidden = new Set(settings.hidden || []);
  const order = settings.sectionOrder || LAYOUT_SECTIONS.map(s => s.key);
  const orderMap = new Map(order.map((key, idx) => [key, idx]));
  LAYOUT_SECTIONS.forEach(section => {
    const baseOrder = (orderMap.has(section.key) ? orderMap.get(section.key) : 999) * 10 + 20;
    sectionNodes(section).forEach((node, idx) => {
      node.style.order = String(baseOrder + idx);
      node.classList.toggle('layout-hidden', hidden.has(section.key));
    });
    if (section.nav) {
      document.querySelectorAll(`.mini-nav-btn[data-jump="${section.nav}"]`).forEach(btn => {
        btn.classList.toggle('layout-hidden', hidden.has(section.key));
        btn.style.order = String(baseOrder);
      });
    }
  });
}

function layoutRowHtml({ key, label, meta }, visible, draggable = true) {
  return `
    <div class="layout-row" draggable="${draggable ? 'true' : 'false'}" data-layout-key="${escapeHtml(key)}">
      <span class="layout-grip" title="Ziehen">⋮⋮</span>
      <span class="layout-name"><span class="layout-title">${escapeHtml(label)}</span><span class="layout-meta">${escapeHtml(meta || '')}</span></span>
      <label class="layout-switch" title="${visible ? 'Angezeigt' : 'Ausgeblendet'}">
        <input type="checkbox" ${visible ? 'checked' : ''} aria-label="${escapeHtml(label)} anzeigen">
        <span></span>
      </label>
      <span class="layout-row-actions">
        <button class="layout-move-btn" type="button" data-layout-move="up" aria-label="Nach oben"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg></button>
        <button class="layout-move-btn" type="button" data-layout-move="down" aria-label="Nach unten"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>
      </span>
    </div>`;
}

function positionLayoutRowHtml(pos) {
  const live = currentPrices[pos.id] || { price: pos.costPrice };
  const value = getPositionValuation(pos, live).currentValue;
  const meta = `${pos.type || 'Position'} · ${pos.symbol || '—'} · ${fmt.format(value)}`;
  return `
    <div class="layout-row" draggable="true" data-pos-key="${escapeHtml(pos.id)}">
      <span class="layout-grip" title="Ziehen">⋮⋮</span>
      <span class="layout-name"><span class="layout-title">${escapeHtml(pos.name || 'Position')}</span><span class="layout-meta">${escapeHtml(meta)}</span></span>
      <span></span>
      <span class="layout-row-actions">
        <button class="layout-move-btn" type="button" data-layout-move="up" aria-label="Nach oben"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg></button>
        <button class="layout-move-btn" type="button" data-layout-move="down" aria-label="Nach unten"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>
      </span>
    </div>`;
}

function wireLayoutListInteractions(list) {
  if (!list || list.dataset.wired === 'true') return;
  list.dataset.wired = 'true';
  let dragged = null;
  list.addEventListener('dragstart', e => {
    const row = e.target.closest('.layout-row');
    if (!row) return;
    dragged = row;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragend', () => {
    if (dragged) dragged.classList.remove('dragging');
    dragged = null;
  });
  list.addEventListener('dragover', e => {
    if (!dragged) return;
    e.preventDefault();
    const target = e.target.closest('.layout-row');
    if (!target || target === dragged || target.parentElement !== list) return;
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    list.insertBefore(dragged, after ? target.nextSibling : target);
  });
  list.addEventListener('click', e => {
    const btn = e.target.closest('[data-layout-move]');
    if (!btn) return;
    const row = btn.closest('.layout-row');
    if (!row) return;
    if (btn.dataset.layoutMove === 'up' && row.previousElementSibling) {
      list.insertBefore(row, row.previousElementSibling);
    } else if (btn.dataset.layoutMove === 'down' && row.nextElementSibling) {
      list.insertBefore(row.nextElementSibling, row);
    }
  });
}

function renderLayoutModal(settingsOverride) {
  const settings = settingsOverride || loadLayoutSettings();
  const hidden = new Set(settings.hidden || []);
  const order = settings.sectionOrder || LAYOUT_SECTIONS.map(s => s.key);
  const sectionByKey = new Map(LAYOUT_SECTIONS.map(s => [s.key, s]));
  const orderedSections = order.map(k => sectionByKey.get(k)).filter(Boolean);
  LAYOUT_SECTIONS.forEach(s => { if (!orderedSections.includes(s)) orderedSections.push(s); });
  const sectionList = document.getElementById('layoutSectionsList');
  const positionList = document.getElementById('layoutPositionsList');
  if (sectionList) {
    sectionList.innerHTML = orderedSections.map(section => layoutRowHtml(section, !hidden.has(section.key))).join('');
    wireLayoutListInteractions(sectionList);
  }
  if (positionList) {
    const positions = currentPortfolioPositions();
    positionList.innerHTML = positions.length
      ? positions.map(positionLayoutRowHtml).join('')
      : '<div class="layout-meta" style="padding:8px;">Noch keine aktuellen Titel vorhanden.</div>';
    wireLayoutListInteractions(positionList);
  }
}

function openLayoutModal() {
  renderLayoutModal();
  document.getElementById('layoutModal').classList.add('active');
  document.getElementById('layoutEditBtn')?.classList.add('active');
}

function closeLayoutModal() {
  document.getElementById('layoutModal').classList.remove('active');
  document.getElementById('layoutEditBtn')?.classList.remove('active');
}

async function saveLayoutModal() {
  const sectionRows = [...document.querySelectorAll('#layoutSectionsList .layout-row')];
  const sectionOrder = sectionRows.map(row => row.dataset.layoutKey).filter(Boolean);
  const hidden = sectionRows
    .filter(row => !row.querySelector('input[type="checkbox"]')?.checked)
    .map(row => row.dataset.layoutKey)
    .filter(Boolean);
  saveLayoutSettings({ sectionOrder, hidden });

  const posRows = [...document.querySelectorAll('#layoutPositionsList .layout-row')];
  const posOrder = posRows.map(row => row.dataset.posKey).filter(Boolean);
  if (appData?.positions && posOrder.length) {
    const posById = new Map(appData.positions.map(pos => [pos.id, pos]));
    const ordered = posOrder.map(id => posById.get(id)).filter(Boolean);
    appData.positions.forEach(pos => { if (!posOrder.includes(pos.id)) ordered.push(pos); });
    appData.positions = ordered;
    const totals = renderTotals();
    renderPositions(totals);
  }

  applyLayoutSettings();
  if (appData) await savePositionsToKV(0);
  closeLayoutModal();
}

function resetLayoutModal() {
  renderLayoutModal(defaultLayoutSettings());
}

function getEstimatedAIDuration() { try { const v = parseInt(localStorage.getItem(AI_DURATION_KEY), 10); if (v > 1000 && v < 60000) return v; } catch (e) {} return AI_DEFAULT_DURATION; }
function saveEstimatedAIDuration(ms) { try { const prev = getEstimatedAIDuration(); localStorage.setItem(AI_DURATION_KEY, String(Math.round(prev * 0.6 + ms * 0.4))); } catch (e) {} }

function getEstimatedRefreshDuration() {
  try {
    const v = parseInt(localStorage.getItem(REFRESH_DURATION_KEY), 10);
    if (v >= 3000 && v <= 90000) return v;
  } catch (e) {}
  return REFRESH_DEFAULT_DURATION;
}
function saveEstimatedRefreshDuration(ms) {
  try {
    const clean = Math.max(3000, Math.min(90000, Number(ms) || REFRESH_DEFAULT_DURATION));
    const prev = getEstimatedRefreshDuration();
    localStorage.setItem(REFRESH_DURATION_KEY, String(Math.round(prev * 0.65 + clean * 0.35)));
  } catch (e) {}
}
function startRefreshProgress() {
  const p = document.getElementById('refreshProgress'), f = document.getElementById('refreshProgressFill'), eta = document.getElementById('refreshProgressEta'), tx = document.getElementById('refreshProgressText'), btn = document.getElementById('refreshBtn');
  if (!p || !f || !eta || !tx) return;
  if (refreshProgressState?.etaInterval) clearInterval(refreshProgressState.etaInterval);
  if (refreshProgressState?.finishTimer) clearTimeout(refreshProgressState.finishTimer);
  const duration = getEstimatedRefreshDuration(), startTime = Date.now();
  p.classList.add('active'); p.classList.remove('done', 'failed');
  f.style.transition = 'width 0.18s ease'; f.style.width = '3%';
  tx.textContent = 'Live-Kurse und Edelmetalle werden aktualisiert…';
  if (btn) { btn.disabled = true; btn.classList.add('refreshing'); }
  const update = () => {
    const elapsed = Date.now() - startTime;
    const remain = Math.max(0, Math.ceil((duration - elapsed) / 1000));
    const ratio = Math.min(0.92, elapsed / duration);
    const pct = Math.round((3 + ratio * 89) * 10) / 10;
    f.style.width = `${pct}%`;
    eta.textContent = remain > 0 ? `Noch ca. ${remain} Sek` : 'Fast fertig…';
  };
  update();
  const etaInterval = setInterval(update, 180);
  refreshProgressState = { startTime, etaInterval, duration };
}
function completeRefreshProgress(success) {
  const p = document.getElementById('refreshProgress'), f = document.getElementById('refreshProgressFill'), eta = document.getElementById('refreshProgressEta'), tx = document.getElementById('refreshProgressText'), btn = document.getElementById('refreshBtn');
  if (!p || !f || !eta || !tx || !refreshProgressState) return;
  clearInterval(refreshProgressState.etaInterval);
  const ms = Date.now() - refreshProgressState.startTime;
  const finish = () => {
    f.style.transition = 'width 0.3s ease'; f.style.width = '100%';
    if (success) {
      saveEstimatedRefreshDuration(ms);
      p.classList.add('done');
      tx.textContent = 'Alle Live-Werte sind aktualisiert.';
      eta.textContent = `Fertig in ${(ms / 1000).toFixed(1)} Sek`;
    } else {
      p.classList.add('failed');
      tx.textContent = 'Aktualisierung konnte nicht vollständig abgeschlossen werden.';
      eta.textContent = 'Bitte erneut versuchen';
    }
    if (btn) { btn.disabled = false; btn.classList.remove('refreshing'); }
    refreshProgressState.finishTimer = setTimeout(() => {
      p.classList.remove('active', 'done', 'failed');
      f.style.transition = 'none';
      f.style.width = '0%';
      refreshProgressState = null;
    }, success ? 1600 : 2800);
  };
  const waitMs = Math.max(0, REFRESH_MIN_VISIBLE_MS - ms);
  if (waitMs > 0) {
    f.style.width = '78%';
    eta.textContent = 'Fast fertig…';
    refreshProgressState.finishTimer = setTimeout(finish, waitMs);
  } else {
    finish();
  }
}

function startAIProgress() {
  const p = document.getElementById('aiProgress'), f = document.getElementById('aiProgressFill'), eta = document.getElementById('aiProgressEta'), tx = document.getElementById('aiProgressText'), summary = document.getElementById('analysisText');
  if (aiProgressState?.etaInterval) clearInterval(aiProgressState.etaInterval);
  summary.classList.add('fading');
  p.classList.add('active'); p.classList.remove('ai-progress-done');
  f.style.transition = 'none'; f.style.width = '0%';
  const duration = getEstimatedAIDuration(), startTime = Date.now();
  tx.textContent = 'KI-Analyse wird erstellt…';
  f.offsetWidth;
  requestAnimationFrame(() => { f.style.transition = `width ${duration}ms linear`; f.style.width = '95%'; });
  const update = () => { const elapsed = Date.now() - startTime; const remain = Math.max(0, Math.ceil((duration - elapsed) / 1000)); eta.textContent = remain > 0 ? `Noch ca. ${remain} Sek` : 'Fast fertig…'; };
  update(); const etaInterval = setInterval(update, 500);
  aiProgressState = { startTime, etaInterval, duration };
}
function completeAIProgress(success) {
  const p = document.getElementById('aiProgress'), f = document.getElementById('aiProgressFill'), eta = document.getElementById('aiProgressEta'), summary = document.getElementById('analysisText');
  if (!aiProgressState) return;
  clearInterval(aiProgressState.etaInterval);
  if (success) { const ms = Date.now() - aiProgressState.startTime; saveEstimatedAIDuration(ms); eta.textContent = `Fertig in ${(ms / 1000).toFixed(1)} Sek`; }
  else eta.textContent = 'Fallback: lokale Analyse';
  f.style.transition = 'width 0.35s ease'; f.style.width = '100%';
  p.classList.add('ai-progress-done'); summary.classList.remove('fading');
  setTimeout(() => p.classList.remove('active'), 1200);
  aiProgressState = null;
}

async function callAIWorker(prompt) {
  try {
    const res = await fetch(AI_WORKER_URL, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ prompt, userKey: kvKeyActive() }) });
    if (!res.ok) throw new Error('Worker HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.usage) recordUsage(data.usage);
    return data.text;
  } catch (e) { console.warn('AI Worker failed:', e); return null; }
}

// Erzeugt ein kompaktes Faktenblatt für KI-Aufrufe (Analyse + Chat)
function buildFactSheet(totals, goal) {
  if (!totals || !goal) return '';
  const alloc = getCategoryAllocation(totals.totalCur);
  const rules = evaluateRiskRules(totals, alloc);
  const violations = rules.filter(r => r.violated);
  // Größte Position
  let largest = null, largestPct = 0;
  getAllPositions().forEach(pos => {
    const live = currentPrices[pos.id] || { price: pos.manualPrice ?? pos.costPrice };
    const value = getPositionValuation(pos, live).currentValue;
    const pct = totals.totalCur > 0 ? (value / totals.totalCur) * 100 : 0;
    if (pct > largestPct) { largestPct = pct; largest = pos; }
  });
  // Käufe letzte 30 Tage
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const recentBuys = (appData?.transactions || []).filter(t => t.txType === 'buy' && t.date > cutoff);
  const totalDeposits = getTotalDeposits();
  const investedCap = getInvestedCapital();
  const unrealizedPnl = totals.totalCur - investedCap;
  const monthlyNeeded = goal.monthlyNeeded || 0;
  // Zielpfad-Status
  let goalStatus = '—';
  const targetAmount = goal.planAmount || goal.amount;
  if (targetAmount && goal.year) {
    const startOfYear = new Date(new Date().getFullYear(), 0, 1).getTime();
    const endOfGoal = endOfGoalMonth(goal.year, goal.month || 12).getTime();
    const now = Date.now();
    const elapsed = (now - startOfYear) / (endOfGoal - startOfYear);
    const expectedProgress = targetAmount * elapsed;
    if (totals.totalCur >= expectedProgress * 1.05) goalStatus = 'vor Plan';
    else if (totals.totalCur >= expectedProgress * 0.95) goalStatus = 'auf Plan';
    else goalStatus = 'hinter Plan';
  }
  return `=== FAKTENBLATT (Stand: ${new Date().toLocaleDateString('de-AT')}) ===
- Gesamtwert: ${fmt.format(totals.totalCur)}
- Einstand (investiertes Kapital): ${fmt.format(investedCap)}
- Unrealisierter G/V: ${unrealizedPnl >= 0 ? '+' : ''}${fmt.format(unrealizedPnl)}
- Einzahlungen gesamt (Cash-Deposits): ${fmt.format(totalDeposits)}
- Allokation: ETF ${fmtNum(alloc.pcts.etf, 0)} % · Aktien ${fmtNum(alloc.pcts.aktie, 0)} % · Krypto ${fmtNum(alloc.pcts.crypto, 0)} % · Gold ${fmtNum(alloc.pcts.gold, 0)} % · Cash ${fmtNum(alloc.pcts.cash, 0)} %
- Größte Position: ${largest ? `${largest.name} (${fmtNum(largestPct, 1)} %)` : '—'}
- Ziel: ${fmt.format(goal.amount)} bis ${monthNameAT(goal.month || 12)} ${goal.year} · Planbetrag ${fmt.format(targetAmount)} · Status: ${goalStatus}
- Benötigte monatliche Sparrate: ${fmt.format(monthlyNeeded)}
- Aktuelle Sparrate: ${fmt.format(goal.savingsRate || 0)} €/Monat
- Sparraten-Korridor: ${fmt.format(goal.minSavingsRate || 0)} bis ${fmt.format(goal.maxSavingsRate || 0)} €/Monat
- Rendite-Szenario: ${fmtNum(goal.annualReturnPct || 0, 1)} % p.a. · Zielart: ${goal.typeLabel || GOAL_TYPE_LABELS[goal.type] || 'Vermögen'} · Priorität: ${goal.priorityLabel || GOAL_PRIORITY_LABELS[goal.priority] || 'Mittel'}
- Strategie-Zielweg: ${fmtNum(goal.savingsPct ?? goal.pathSavingsPct ?? 50, 0)} % Sparrate / ${fmtNum(goal.returnPct ?? (100 - (goal.pathSavingsPct ?? 50)), 0)} % Rendite
- Risikoprofil: ${goal.riskLabel || ((goal.riskPct ?? 50) < 34 ? 'Defensiv' : (goal.riskPct ?? 50) < 67 ? 'Ausgewogen' : 'Offensiv')} (${fmtNum(goal.riskPct ?? 50, 0)} %)
- Käufe letzte 30 Tage: ${recentBuys.length} Stk${recentBuys.length > 0 ? ', gesamt ' + fmt.format(recentBuys.reduce((s, t) => s + t.value, 0)) : ''}
- Verletzte Regeln (${violations.length}): ${violations.length > 0 ? violations.map(v => v.label + ' (' + v.value + ')').join(', ') : 'keine'}
- Watchlist-Kandidaten: ${(appData?.watchlist || []).length}
- Offene Journal-Einträge: ${(appData?.journal || []).filter(e => e.status !== 'done').length}
- Erträge ${new Date().getFullYear()} (Netto): ${fmt.format((appData?.income || []).filter(e => e.date && e.date.startsWith(String(new Date().getFullYear()))).reduce((s, e) => s + (e.net || 0), 0))}
- Realisierte G/V gesamt: ${fmt.format((appData?.positions || []).reduce((s, p) => s + (getComputedPosition(p.id).realizedPnl || 0), 0))}
=== /FAKTENBLATT ===`;
}

function buildPrivacyAwareFactSheet(totals, goal) {
  const mode = getAIPrivacyMode();
  if (mode === 'full') return buildFactSheet(totals, goal);
  const alloc = getCategoryAllocation(totals.totalCur);
  const investedCap = getInvestedCapital();
  const unrealizedPnl = totals.totalCur - investedCap;
  const targetAmount = goal?.planAmount || goal?.amount || 0;
  const risk = goal?.riskPct ?? 50;
  const pathSavings = goal?.savingsPct ?? goal?.pathSavingsPct ?? 50;
  const cash = currentCashValue();
  const lines = [
    `=== FAKTENBLATT (${mode === 'minimal' ? 'MINIMALER KI-MODUS' : 'ZUSAMMENFASSUNGS-MODUS'}, Stand: ${new Date().toLocaleDateString('de-AT')}) ===`,
    `- Gesamtwert: ${fmt.format(totals.totalCur)}`,
    `- Einstand / Kapitalbasis: ${fmt.format(investedCap)}`,
    `- Unrealisierter G/V: ${unrealizedPnl >= 0 ? '+' : ''}${fmt.format(unrealizedPnl)}`,
    `- Ziel: ${fmt.format(goal?.amount || 0)} bis ${monthNameAT(goal?.month || 12)} ${goal?.year || '—'} · Planbetrag ${fmt.format(targetAmount)}`,
    `- Aktuelle Sparrate: ${fmt.format(goal?.savingsRate || 0)} €/Monat`,
    `- Strategie: ${fmtNum(pathSavings, 0)} % Sparrate / ${fmtNum(100 - pathSavings, 0)} % Rendite · Risiko ${fmtNum(risk, 0)} %`,
    `- Allokation grob: ETF ${fmtNum(alloc.pcts.etf, 0)} % · Aktien ${fmtNum(alloc.pcts.aktie, 0)} % · Krypto ${fmtNum(alloc.pcts.crypto, 0)} % · Edelmetalle ${fmtNum(alloc.pcts.gold, 0)} % · Cash ${fmtNum(alloc.pcts.cash, 0)} %`,
  ];
  if (mode === 'summary') {
    const rules = evaluateRiskRules(totals, alloc);
    const violations = rules.filter(r => r.violated).map(r => r.label + ' (' + r.value + ')');
    lines.push(`- Anzahl aktueller Positionen: ${getAllPositions().length}`);
    lines.push(`- Cash: ${fmt.format(cash)}`);
    lines.push(`- Verletzte Regeln: ${violations.length ? violations.join(', ') : 'keine'}`);
  } else {
    lines.push('- Einzelpositionen, Namen, ISIN/WKN und Chat-Gedächtnis werden in diesem Modus nicht an die KI gegeben.');
  }
  lines.push('=== /FAKTENBLATT ===');
  return lines.join('\n');
}

function buildPrivacyAwarePositionContext(totals) {
  const mode = getAIPrivacyMode();
  if (mode === 'minimal') {
    return 'Einzelpositionen werden im minimalen KI-Datenschutzmodus nicht freigegeben.';
  }
  if (mode === 'summary') {
    const alloc = getCategoryAllocation(totals.totalCur);
    return `Einzelpositionen werden nicht vollständig freigegeben. Grobe Allokation: ETF ${fmtNum(alloc.pcts.etf, 0)} %, Aktien ${fmtNum(alloc.pcts.aktie, 0)} %, Krypto ${fmtNum(alloc.pcts.crypto, 0)} %, Edelmetalle ${fmtNum(alloc.pcts.gold, 0)} %, Cash ${fmtNum(alloc.pcts.cash, 0)} %.`;
  }
  return getAllPositions().map(pos => {
    const live = currentPrices[pos.id] || { price: pos.costPrice };
    const valuation = getPositionValuation(pos, live);
    const value = valuation.currentValue;
    const pct = totals.totalCur > 0 ? (value / totals.totalCur) * 100 : 0;
    const pnlPct = valuation.pnlPct;
    return `- ${pos.name} (${pos.type}): ${fmt.format(value)} = ${pct.toFixed(1)}% Allokation, P&L ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
  }).join('\n');
}

function buildAIPrompt(totals, goal) {
  const positions = buildPrivacyAwarePositionContext(totals);
  const today = new Date().toLocaleDateString('de-AT');

  const focuses = [
    'Fokussiere auf Konzentrationsrisiken und schlage konkrete Reduktionen vor.',
    'Beleuchte den Zeithorizont — ist das Ziel realistisch? Welche Sparrate macht den Unterschied?',
    'Bewerte die Diversifikation zwischen ETF, Aktie und Krypto und schlage Umschichtungen vor.',
    'Konzentriere dich auf Sparplan-Optionen: welche monatlichen ETF-Sparpläne würden helfen?',
    'Hinterfrage die Allokation: welche Position ist überproportional? Welche Trim/Aufstockung wäre sinnvoll?',
    'Vergleiche die Positionen untereinander — Performance, Volatilität, Trend.',
    'Berücksichtige Krypto-Volatilität: ist der Krypto-Anteil angemessen für den Zeithorizont?',
    'Spiele Szenarien durch: Was wenn der Markt 10% fällt? Was wenn er 20% steigt?',
    'Denke an Steuern und Realisierung: gibt es Positionen die man für Verlustverrechnung verkaufen könnte?',
    'Bewerte ob Nachkauf bei schwachen Positionen sinnvoll wäre (Cost-Averaging) oder eher Stop-Loss.'
  ];
  const focus = focuses[Math.floor(Math.random() * focuses.length)];
  const nonce = Math.random().toString(36).slice(2, 8);

  const factSheet = buildPrivacyAwareFactSheet(totals, goal);
  const privacyMode = AI_PRIVACY_MODES[getAIPrivacyMode()].label;

  return `Du bist ein nüchterner Portfolio-Analyst (KEIN Finanzberater). Sprache: Deutsch. Antworte direkt, ohne Floskeln, mit konkreten Zahlen und Beträgen.

${factSheet}

KI-DATENSCHUTZMODUS: ${privacyMode}. Nutze nur die Daten, die in diesem Prompt freigegeben sind, und erfinde keine ausgeblendeten Positionen.

PORTFOLIO HEUTE (${today}):
${positions}
Gesamtwert: ${fmt.format(totals.totalCur)}
Einstand gesamt: ${fmt.format(totals.totalCost)}
P&L gesamt: ${totals.totalPnl >= 0 ? '+' : ''}${fmt.format(totals.totalPnl)} (${totals.totalPnlPct.toFixed(1)}%)

ZIEL: ${fmt.format(goal.amount)} bis ${monthNameAT(goal.month || 12)} ${goal.year}
PLANBETRAG inkl. Puffer: ${fmt.format(goal.planAmount || goal.amount)} (${fmtNum(goal.bufferPct || 0, 0)}% Puffer)
GAP zum Ziel: ${fmt.format(goal.gap)}
Zeit bis Zieldatum: ~${goal.monthsToGoal} Monate
Benötigte Gesamt-Rendite: ${goal.requiredReturnPct.toFixed(1)}% in ${goal.monthsToGoal} Monaten
Bei reinem Sparen ohne Rendite: ${fmt.format(goal.monthlyNeeded)}/Monat
Aktuelle Sparrate (vom Nutzer gesetzt): ${fmt.format(goal.savingsRate || 0)}/Monat → ergibt ohne Rendite ${fmt.format(totals.totalCur + (goal.savingsRate || 0) * goal.monthsToGoal)} bis Zieldatum
Sparraten-Korridor: min. ${fmt.format(goal.minSavingsRate || 0)}/Monat, max. ${fmt.format(goal.maxSavingsRate || 0)}/Monat
Rendite-Szenario des Nutzers: ${fmtNum(goal.annualReturnPct || 0, 1)}% p.a. → Projektion mit aktueller Rate: ${fmt.format(goal.projectedWithReturn || 0)}
Zielart/Priorität: ${goal.typeLabel || 'Vermögen'} · ${goal.priorityLabel || 'Mittel'}
STRATEGIEVORGABE DES NUTZERS:
- Zielweg: ${fmtNum(goal.savingsPct, 0)}% Sparrate / ${fmtNum(goal.returnPct, 0)}% Rendite (${goal.pathLabel})
- Risikobereitschaft: ${goal.riskLabel} (${fmtNum(goal.riskPct, 0)}%)
- Interpretation: ${goal.pathText} ${goal.riskText}
- Deine Analyse MUSS diese Vorgabe respektieren: bei Sparrate-dominiert nicht unnötig Rendite erzwingen; bei Rendite-dominiert Chancen analysieren, aber Verlustrisiken konkret benennen.

AKZENT FÜR DIESE ANALYSE (variiert pro Aufruf): ${focus}
Session-Nonce (für Variabilität, ignorieren): ${nonce}

Strukturiere die Antwort so (Markdown-fähig, fette Begriffe, Listen):

**Lage heute:** [1 Satz]

**Allokation:** [1-2 Sätze: größte Konzentrationsrisiken]

**Ziel-Realität:** [1-2 Sätze mit konkreten Zahlen]

**3 konkrete Optionen (keine Empfehlung):**
1. [Option mit Betrag/Aktion — variiert je nach AKZENT oben]
2. [Option mit Betrag/Aktion]
3. [Option mit Betrag/Aktion]

**Hinweis:** Keine Finanzberatung. Eigenrecherche oder Fachberatung empfohlen.

Max 220 Wörter. Sei direkt und zahlenorientiert. Variiere die Formulierung im Vergleich zu früheren Antworten.`;
}

function markdownLite(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');
}

async function generateAIAnalysis(totals, goal) {
  const btn = document.getElementById('aiRefreshBtn');
  const badge = document.getElementById('aiSourceBadge');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  startAIProgress();
  const prompt = buildAIPrompt(totals, goal);
  const text = await callAIWorker(prompt);
  if (text) {
    document.getElementById('analysisText').innerHTML = '<p>' + markdownLite(text.trim()) + '</p>';
    badge.textContent = 'Haiku live';
    badge.className = 'ai-source-badge ai-source-live';
    completeAIProgress(true);
  } else {
    renderAnalysisLocal(totals, goal);
    badge.textContent = 'lokal (Worker offline)';
    badge.className = 'ai-source-badge ai-source-local';
    completeAIProgress(false);
  }
  if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
}

const BAKED_BLOB =__BAKED_BLOB__;

const ENC = {
  async deriveKey(password, salt) { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']); return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); },
  async decrypt(enc, password) { const salt = this._fromB64(enc.s); const iv = this._fromB64(enc.i); const ct = this._fromB64(enc.c); const key = await this.deriveKey(password, salt); const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct); return JSON.parse(new TextDecoder().decode(pt)); },
  async encrypt(obj, password) { const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12)); const key = await this.deriveKey(password, salt); const pt = new TextEncoder().encode(JSON.stringify(obj)); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt); return { v: 1, s: this._toB64(salt), i: this._toB64(iv), c: this._toB64(new Uint8Array(ct)) }; },
  _fromB64(str) { const s = atob(str); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; },
  _toB64(buf) { let s = ''; const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
};
const AI_PRIVACY_MODES = {
  full: {
    label: 'Vollständig',
    hint: 'Beste KI-Antworten: Positionen, Ziel, Gedächtnis und Kennzahlen werden für die Anfrage verwendet.',
  },
  summary: {
    label: 'Zusammenfassung',
    hint: 'Guter Mittelweg: Die KI bekommt Gesamtwerte, Allokation und Ziel, aber keine komplette Positionsliste.',
  },
  minimal: {
    label: 'Minimal',
    hint: 'Maximal sparsam: Die KI bekommt nur grobe Depotwerte und Zielinfos. Antworten werden weniger konkret.',
  },
};
const SESSION_TIMEOUT_OPTIONS = [5, 15, 30, 60];
const APP_THEMES = [
  { key: 'classic', label: 'Classic Dark', meta: 'Aktuelles Design' },
  { key: 'light', label: 'Clean Light', meta: 'Hell und ruhig' },
  { key: 'graphite', label: 'Graphite Pro', meta: 'Broker-Look' },
  { key: 'aurum', label: 'Gold Premium', meta: 'Warme Akzente' },
  { key: 'emerald', label: 'Emerald Focus', meta: 'Konzentriert grün' }
];

const STORE = {
  THEME_KEY: STORAGE_PREFIX + 'theme',
  VIEW_MODE_KEY: STORAGE_PREFIX + 'view_mode',
  AI_PRIVACY_KEY: STORAGE_PREFIX + 'ai_privacy_mode',
  SESSION_TIMEOUT_KEY: STORAGE_PREFIX + 'session_timeout_min',
  getTheme() { try { return localStorage.getItem(this.THEME_KEY); } catch (e) { return null; } },
  setTheme(t) { try { localStorage.setItem(this.THEME_KEY, t); } catch (e) {} },
  getViewMode() { try { return localStorage.getItem(this.VIEW_MODE_KEY); } catch (e) { return null; } },
  setViewMode(mode) { try { localStorage.setItem(this.VIEW_MODE_KEY, mode); } catch (e) {} },
  getAIPrivacyMode() { try { return localStorage.getItem(this.AI_PRIVACY_KEY); } catch (e) { return null; } },
  setAIPrivacyMode(mode) { try { localStorage.setItem(this.AI_PRIVACY_KEY, mode); } catch (e) {} },
  getSessionTimeoutMinutes() { try { return Number(localStorage.getItem(this.SESSION_TIMEOUT_KEY)); } catch (e) { return 0; } },
  setSessionTimeoutMinutes(minutes) { try { localStorage.setItem(this.SESSION_TIMEOUT_KEY, String(minutes)); } catch (e) {} }
};
let appData = null, appPassword = null, currentPrices = {}, baseLivePrices = {}, quoteIssues = {}, weeklyData = {}, chartRegistry = {}, currentHistoryPeriod = '12M';
let manualQuoteTimer = null;
// Sicherheit: KV-Schlüssel wird aus dem Master-Code abgeleitet (unerratbar) statt fest 'michael'/'bruder'.
let appUserKey = null;          // wird beim Login gesetzt
let appAuthToken = null; // wird beim Login aus dem Master-Code abgeleitet
let kvLegacyMigrationDone = false;
async function deriveUserKey(masterCode) {
  try {
    const enc = new TextEncoder().encode('pmtuk-v1-' + USER_KEY + '-' + masterCode);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    const bytes = new Uint8Array(buf);
    let hex = '';
    for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return USER_KEY + '-' + hex;  // z.B. "michael-a3f9b2c1d4e5f6a7" — zuordenbar, aber ohne Code nicht erratbar
  } catch (e) {
    return USER_KEY; // Fallback (sollte nie passieren)
  }
}
function kvKeyActive() { return appUserKey || USER_KEY; }
async function deriveWorkerAuthToken(masterCode) {
  const enc = new TextEncoder().encode('pmt-auth-v2-' + USER_KEY + '-' + masterCode);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function apiHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-App-Token': appAuthToken || '',
    ...extra
  };
}
let historyVisibleSeries = { value: true, invested: true, pnl: false, goal: false };
let metalsProgressState = null;
const fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const fmtNoCent = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fmtNum = (v, d = 2) => v == null || isNaN(v) ? '—' : new Intl.NumberFormat('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
function priceDecimalsForPosition(pos, price) {
  const type = String(pos?.type || '').toLowerCase();
  if (type === 'crypto') return 4;
  return Number(price) > 0 && Number(price) < 10 ? 4 : 2;
}
function fmtPrice(pos, price) { return fmtNum(price, priceDecimalsForPosition(pos, price)) + ' €'; }
function fixedPriceInput(pos, price) { return Number(price || 0).toFixed(priceDecimalsForPosition(pos, price)); }
const fmtPct = (v) => v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + fmtNum(v) + ' %';
const MONTHS_SHORT = ['Jän', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const MONTHS_LONG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function normalizeTheme(theme) {
  if (theme === 'dark') return 'classic';
  return APP_THEMES.some(t => t.key === theme) ? theme : 'classic';
}
function applyTheme(theme) {
  const selected = normalizeTheme(theme);
  document.body.classList.remove('light', 'theme-graphite', 'theme-aurum', 'theme-emerald');
  if (selected === 'light') document.body.classList.add('light');
  if (selected === 'graphite') document.body.classList.add('theme-graphite');
  if (selected === 'aurum') document.body.classList.add('theme-aurum');
  if (selected === 'emerald') document.body.classList.add('theme-emerald');
  document.querySelectorAll('[data-theme-choice]').forEach(btn => btn.classList.toggle('active', btn.dataset.themeChoice === selected));
  const picker = document.getElementById('themePickerBtn');
  const label = APP_THEMES.find(t => t.key === selected)?.label || 'Classic Dark';
  if (picker) {
    picker.classList.toggle('active', selected !== 'classic');
    picker.title = `Theme wählen · aktuell: ${label}`;
    picker.setAttribute('aria-label', `Theme wählen, aktuell ${label}`);
  }
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', selected === 'light' ? '#f5f5f7' : selected === 'graphite' ? '#0f1217' : selected === 'aurum' ? '#11100d' : selected === 'emerald' ? '#07110f' : '#0d0d0d');
  reRenderAllCharts();
}
function setTheme(theme) {
  const selected = normalizeTheme(theme);
  STORE.setTheme(selected);
  applyTheme(selected);
}
function toggleTheme() { setTheme(document.body.classList.contains('light') ? 'classic' : 'light'); }
function openThemeModal() {
  applyTheme(STORE.getTheme());
  document.getElementById('themeModal')?.classList.add('active');
}
function closeThemeModal() {
  document.getElementById('themeModal')?.classList.remove('active');
}
function initTheme() { applyTheme(normalizeTheme(STORE.getTheme())); }
function applyViewMode(mode) {
  const simple = mode !== 'expert';
  document.body.classList.toggle('simple-mode', simple);
  const btn = document.getElementById('modeToggleBtn');
  if (btn) {
    btn.classList.toggle('active', simple);
    btn.title = simple ? 'Einfach-Modus aktiv' : 'Experte-Modus aktiv';
    btn.setAttribute('aria-label', simple ? 'Einfach-Modus aktiv, zu Experte wechseln' : 'Experte-Modus aktiv, zu Einfach wechseln');
  }
}
function toggleViewMode() {
  const next = document.body.classList.contains('simple-mode') ? 'expert' : 'simple';
  STORE.setViewMode(next);
  applyViewMode(next);
  requestAnimationFrame(updatePositionsScrollLimit);
}
function initViewMode() { applyViewMode(STORE.getViewMode() === 'expert' ? 'expert' : 'simple'); }
function getAIPrivacyMode() {
  const mode = STORE.getAIPrivacyMode();
  return AI_PRIVACY_MODES[mode] ? mode : 'summary';
}
function setAIPrivacyMode(mode) {
  STORE.setAIPrivacyMode(AI_PRIVACY_MODES[mode] ? mode : 'summary');
}
function getSessionTimeoutMinutes() {
  const minutes = STORE.getSessionTimeoutMinutes();
  return SESSION_TIMEOUT_OPTIONS.includes(minutes) ? minutes : 15;
}
function setSessionTimeoutMinutes(minutes) {
  const clean = SESSION_TIMEOUT_OPTIONS.includes(Number(minutes)) ? Number(minutes) : 15;
  STORE.setSessionTimeoutMinutes(clean);
}
function showScreen(id) { ['gateScreen', 'appScreen'].forEach(s => { const el = document.getElementById(s); if (s === id) el.classList.add('active'); else el.classList.remove('active'); }); }
function showErr(el, msg) { el.textContent = msg; el.classList.add('visible'); }
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function getThemeColors() { const cs = getComputedStyle(document.body); return { tooltipBg: cs.getPropertyValue('--tooltip-bg').trim(), tooltipText: cs.getPropertyValue('--tooltip-text').trim(), gridColor: cs.getPropertyValue('--chart-grid').trim(), axisText: cs.getPropertyValue('--chart-axis').trim() }; }
function normalizeText(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

// =====================================================================
