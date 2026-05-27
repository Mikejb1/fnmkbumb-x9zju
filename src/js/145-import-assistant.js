let importAssistantState = null;

function createImportAssistantState() {
  return {
    depotFileName: '',
    accountFileName: '',
    depotText: '',
    accountText: '',
    depotAnalysis: null,
    accountAnalysis: null,
    depotError: '',
    accountError: '',
    busy: false
  };
}

function getImportAssistantState() {
  if (!importAssistantState) importAssistantState = createImportAssistantState();
  return importAssistantState;
}

function openImportAssistantModal() {
  getImportAssistantState();
  renderImportAssistant();
  document.getElementById('importAssistantModal').classList.add('active');
}

function closeImportAssistantModal() {
  document.getElementById('importAssistantModal').classList.remove('active');
}

function resetImportAssistant() {
  importAssistantState = createImportAssistantState();
  ['importAssistantDepotFileInput', 'importAssistantAccountFileInput'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
  renderImportAssistant();
}

async function handleImportAssistantDepotFile(file) {
  if (!file) return;
  const state = getImportAssistantState();
  state.depotFileName = file.name || 'Depot-Positionen.csv';
  state.depotError = '';
  state.depotAnalysis = null;
  renderImportAssistant();
  try {
    state.depotText = await readFlatexCsvFile(file);
    state.depotAnalysis = analyzeFlatexCsvText(state.depotText);
  } catch (e) {
    state.depotError = e.message || String(e);
  }
  renderImportAssistant();
}

async function handleImportAssistantAccountFile(file) {
  if (!file) return;
  const state = getImportAssistantState();
  state.accountFileName = file.name || 'Kontoumsätze.csv';
  state.accountError = '';
  state.accountAnalysis = null;
  renderImportAssistant();
  try {
    state.accountText = await readFlatexCsvFile(file);
    state.accountAnalysis = analyzeFlatexAccountCsvText(state.accountText);
  } catch (e) {
    state.accountError = e.message || String(e);
  }
  renderImportAssistant();
}

function importAssistantStepName(state) {
  if (state.busy) return 'apply';
  if (state.depotError || state.accountError) return 'check';
  if (state.depotAnalysis || state.accountAnalysis) return 'preview';
  return 'files';
}

function updateImportAssistantSteps(state) {
  const order = ['files', 'check', 'preview', 'apply'];
  const active = importAssistantStepName(state);
  const activeIndex = order.indexOf(active);
  document.querySelectorAll('[data-ia-step]').forEach(el => {
    const idx = order.indexOf(el.dataset.iaStep);
    el.classList.toggle('done', idx >= 0 && idx < activeIndex);
    el.classList.toggle('active', el.dataset.iaStep === active);
  });
}

function renderImportAssistantFileCards(state) {
  const depotCard = document.getElementById('importAssistantDepotCard');
  const accountCard = document.getElementById('importAssistantAccountCard');
  if (depotCard) {
    depotCard.classList.toggle('ready', !!state.depotAnalysis);
    depotCard.classList.toggle('error', !!state.depotError);
  }
  if (accountCard) {
    accountCard.classList.toggle('ready', !!state.accountAnalysis);
    accountCard.classList.toggle('error', !!state.accountError);
  }
  const depotName = document.getElementById('importAssistantDepotName');
  const accountName = document.getElementById('importAssistantAccountName');
  if (depotName) depotName.textContent = state.depotError ? `Fehler: ${state.depotError}` : state.depotAnalysis ? `${state.depotFileName} · geprüft` : state.depotFileName || 'Keine Datei gewählt';
  if (accountName) accountName.textContent = state.accountError ? `Fehler: ${state.accountError}` : state.accountAnalysis ? `${state.accountFileName} · geprüft` : state.accountFileName || 'Keine Datei gewählt';
}

function importAssistantImpactCards(state) {
  const depot = state.depotAnalysis;
  const account = state.accountAnalysis;
  const open = depot ? depot.groups.filter(group => group.open).length : 0;
  const archived = depot ? depot.groups.filter(group => !group.open).length : 0;
  const matched = account ? account.matchedOrders.length : 0;
  const orders = account ? account.orders.length : 0;
  return `<div class="import-impact-grid">
    <div class="import-impact-card"><div class="label">Depotbuchungen</div><div class="value">${depot ? depot.entries.length : '—'}</div></div>
    <div class="import-impact-card"><div class="label">Aktuelle Titel</div><div class="value">${depot ? open : '—'}</div></div>
    <div class="import-impact-card"><div class="label">Historisch 0</div><div class="value">${depot ? archived : '—'}</div></div>
    <div class="import-impact-card"><div class="label">Cash-Zeilen</div><div class="value">${account ? account.entries.length : '—'}</div></div>
    <div class="import-impact-card"><div class="label">Order-Abgleich</div><div class="value">${account ? `${matched}/${orders}` : '—'}</div></div>
    <div class="import-impact-card"><div class="label">Einzahlungen</div><div class="value">${account ? fmt.format(account.totals.deposits) : '—'}</div></div>
  </div>`;
}

function renderImportAssistantSummary(state) {
  const items = [];
  if (!state.depotAnalysis && !state.accountAnalysis && !state.depotError && !state.accountError) {
    items.push({ kind: 'info', text: 'Wähle mindestens eine CSV. Am saubersten ist: Depot-/Positions-CSV plus Kontoumsätze CSV gemeinsam importieren.' });
  }
  if (state.depotError) items.push({ kind: 'error', text: `Depot-/Positions-CSV konnte nicht gelesen werden: ${state.depotError}` });
  if (state.accountError) items.push({ kind: 'error', text: `Kontoumsätze konnten nicht gelesen werden: ${state.accountError}` });
  if (state.depotAnalysis) {
    const open = state.depotAnalysis.groups.filter(group => group.open).length;
    const archived = state.depotAnalysis.groups.filter(group => !group.open).length;
    items.push({ kind: 'info', text: `${state.depotAnalysis.sourceLabel || 'CSV'} geprüft: ${state.depotAnalysis.entries.length} Buchungen, ${open} aktuelle Positionen, ${archived} vollständig verkaufte Titel nur für den Verlauf.` });
  }
  if (state.accountAnalysis) {
    items.push({ kind: state.accountAnalysis.unmatchedOrders.length ? 'warn' : 'info', text: `Kontoumsätze geprüft: ${state.accountAnalysis.entries.length} Bewegungen, ${state.accountAnalysis.orders.length} Order-Zeilen, aktuell ${state.accountAnalysis.matchedOrders.length} davon zugeordnet.` });
  }
  if (state.depotAnalysis && state.accountAnalysis) {
    items.push({ kind: 'info', text: 'Beim Übernehmen wird zuerst der Wertpapier-Verlauf cash-neutral aufgebaut. Danach werden die Kontoumsätze erneut dagegen geprüft, damit die echten Order-Cashwerte sauber zugeordnet werden.' });
  } else if (state.accountAnalysis && !state.depotAnalysis) {
    items.push({ kind: 'warn', text: 'Du importierst nur Kontoumsätze. Order-Abgleich funktioniert dann nur mit bereits vorhandenen Depotumsätzen in der App.' });
  } else if (state.depotAnalysis && !state.accountAnalysis) {
    items.push({ kind: 'warn', text: 'Du importierst nur eine Depot-/Positions-CSV. Stückzahlen und Verlauf werden aufgebaut; Cash bleibt unverändert, bis du Kontoumsätze importierst.' });
  }
  if (state.depotAnalysis || state.accountAnalysis) {
    items.push({ kind: 'warn', text: 'Vor der Übernahme erstellt die App automatisch ein verschlüsseltes JSON-Sicherheitsbackup. Michael, Bruder, Person1 und Person2 bleiben weiterhin getrennte Konten.' });
  }
  document.getElementById('importAssistantSummary').innerHTML = items.map(item => `<div class="ss-conflict-item ${item.kind}">${escapeHtml(item.text)}</div>`).join('') + ((state.depotAnalysis || state.accountAnalysis) ? importAssistantImpactCards(state) : '');
}

function renderImportAssistantPreview(state) {
  const rows = [];
  if (state.depotAnalysis) {
    state.depotAnalysis.groups.slice(0, 22).forEach(group => {
      const result = group.open ? `${fmtNum(group.netQuantity, group.netQuantity % 1 ? 6 : 0)} Stk offen` : 'Endbestand 0';
      const cls = group.open ? (group.matchesCurrent ? 'buy' : 'sell') : 'ignore';
      rows.push(`<div class="ss-batch-row ${cls}">
        <div class="date">CSV</div>
        <div><div class="name">${escapeHtml(group.name)}</div><div class="meta">${escapeHtml(group.isin)} · ${escapeHtml(group.type)} · ${group.entries.length} Buchung${group.entries.length === 1 ? '' : 'en'}</div></div>
        <div class="type">${escapeHtml(result)}</div>
      </div>`);
    });
  }
  if (state.accountAnalysis) {
    const cashRows = state.accountAnalysis.entries.filter(entry => entry.kind !== 'order-buy' && entry.kind !== 'order-sell').slice(0, 10);
    cashRows.forEach(entry => {
      rows.push(`<div class="ss-batch-row ${entry.amount < 0 ? 'sell' : 'buy'}">
        <div class="date">Konto</div>
        <div><div class="name">${escapeHtml(accountKindLabel(entry.kind))}</div><div class="meta">${escapeHtml(formatDateAT(entry.ledgerDate))} · ${escapeHtml(entry.info || entry.recipient || 'Kontobewegung')}</div></div>
        <div class="type">${entry.amount >= 0 ? '+' : '−'}${fmt.format(Math.abs(entry.amount))}</div>
      </div>`);
    });
  }
  if (state.depotAnalysis || state.accountAnalysis) {
    rows.push(`<div class="import-assistant-total-row"><span>Übernahme-Reihenfolge</span><strong>${state.depotAnalysis ? 'Depotumsätze' : ''}${state.depotAnalysis && state.accountAnalysis ? ' → ' : ''}${state.accountAnalysis ? 'Kontoumsätze' : ''}</strong></div>`);
  }
  const preview = document.getElementById('importAssistantPreview');
  preview.innerHTML = rows.join('');
  preview.style.display = rows.length ? 'block' : 'none';
}

function renderImportAssistant() {
  const state = getImportAssistantState();
  updateImportAssistantSteps(state);
  renderImportAssistantFileCards(state);
  renderImportAssistantSummary(state);
  renderImportAssistantPreview(state);
  const applyBtn = document.getElementById('importAssistantApply');
  if (applyBtn) {
    const ready = !!(state.depotAnalysis || state.accountAnalysis) && !state.depotError && !state.accountError && !state.busy;
    applyBtn.disabled = !ready;
    applyBtn.textContent = state.busy ? 'Import läuft...' : 'Import übernehmen';
  }
}

async function applyImportAssistant() {
  const state = getImportAssistantState();
  if (state.busy || !(state.depotAnalysis || state.accountAnalysis)) return;
  const parts = [];
  if (state.depotAnalysis) parts.push('Depot-/Positions-CSV');
  if (state.accountAnalysis) parts.push('Kontoumsätze');
  const ok = confirm(`Import-Assistent wirklich übernehmen?\n\n${parts.join(' und ')} werden verarbeitet. Vorher wird ein JSON-Sicherheitsbackup heruntergeladen.`);
  if (!ok) return;
  state.busy = true;
  renderImportAssistant();
  try {
    await backupEncryptedJson('vor-import-assistent');
    const results = [];
    if (state.depotAnalysis) {
      const depotResult = await applyFlatexCsvAnalysis(state.depotAnalysis, { skipSave: true, skipRefresh: true });
      results.push(`${depotResult.openCount} aktuelle Positionen cash-neutral`);
    }
    if (state.accountAnalysis) {
      const accountAnalysis = state.depotAnalysis && state.accountText ? analyzeFlatexAccountCsvText(state.accountText) : state.accountAnalysis;
      const accountResult = await applyFlatexAccountCsvAnalysis(accountAnalysis, { skipSave: true, skipRefresh: true });
      results.push(`${accountResult.orderMatches} Order-Cashwerte abgeglichen`);
    }
    await savePositionsToKV();
    await Promise.all([fetchCryptoPrices(), fetchAllCryptoHistories(370, true), fetchMarketPrices({ forceRefresh: true }), fetchMarketHistory(370, { forceRefresh: true })]);
    await fetchAllWeeklyCharts();
    await refreshUI({ skipAI: true });
    closeImportAssistantModal();
    resetImportAssistant();
    alert(`Import abgeschlossen. ${results.join(' · ') || 'Daten übernommen'}.`);
  } catch (e) {
    state.busy = false;
    renderImportAssistant();
    alert('Import-Assistent konnte nicht abschließen: ' + (e.message || e));
  }
}
