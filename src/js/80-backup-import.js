// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== BACKUP · EXPORT · IMPORT =====
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}
function renderBackupStatus() {
  const el = document.getElementById('backupStatus');
  if (!el) return;
  let ts = 0;
  try { ts = parseInt(localStorage.getItem(BACKUP_TS_KEY) || localStorage.getItem(LEGACY_BACKUP_TS_KEY) || '0', 10); } catch (e) {}
  if (!ts) {
    el.textContent = 'Noch kein JSON-Backup für dieses Portfolio in diesem Browser erkannt.';
    el.className = 'backup-status warn';
    return;
  }
  const ageDays = Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
  el.textContent = `Letztes JSON-Backup: ${new Date(ts).toLocaleString('de-AT')} · ${ageDays === 0 ? 'heute' : ageDays + ' Tag' + (ageDays === 1 ? '' : 'e') + ' alt'}.`;
  el.className = 'backup-status' + (ageDays >= 30 ? ' warn' : '');
}
function backupJson(reason = '') {
  if (!appData) return;
  const today = new Date().toISOString().slice(0, 10);
  const payload = {
    exportedAt: new Date().toISOString(),
    schemaVersion: appData.schemaVersion || 1,
    user: typeof USER_KEY !== 'undefined' ? USER_KEY : 'unknown',
    positions: appData.positions || [],
    goal: appData.goal || {},
    transactions: appData.transactions || [],
    metalHistory: appData.metalHistory || null,
    watchlist: appData.watchlist || [],
    journal: appData.journal || [],
    income: appData.income || [],
    layout: appData.layout || null,
    chatMemorySummary: typeof chatMemorySummary === 'string' ? chatMemorySummary : ''
  };
  const account = typeof USER_KEY !== 'undefined' ? USER_KEY : 'portfolio';
  const suffix = reason ? '-' + String(reason).replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() : '';
  downloadBlob(JSON.stringify(payload, null, 2), `portfolio-${account}-backup${suffix}-${today}.json`, 'application/json');
  try { localStorage.setItem(BACKUP_TS_KEY, String(Date.now())); } catch (e) {}
  renderBackupStatus();
  if (typeof renderDataQuality === 'function') {
    try { renderDataQuality(); } catch (e) {}
  }
}
function backupCsv() {
  if (!appData) return;
  const today = new Date().toISOString().slice(0, 10);
  const rows = [['date', 'assetId', 'assetType', 'txType', 'quantity', 'price', 'value', 'fees', 'note']];
  (appData.transactions || []).forEach(t => {
    rows.push([
      t.date || '',
      t.assetId || '',
      t.assetType || '',
      t.txType || '',
      String(t.quantity ?? ''),
      String(t.price ?? ''),
      String(t.value ?? ''),
      String(t.fees ?? 0),
      (t.note || '').replace(/"/g, '""')
    ]);
  });
  const csv = rows.map(row => row.map(cell => /[",\n]/.test(cell) ? `"${cell}"` : cell).join(',')).join('\n');
  downloadBlob(csv, `portfolio-transactions-${today}.csv`, 'text/csv');
}
function validateBackupSchema(data) {
  // Wirft bei Schema-Verletzung einen Error; loggt nicht-kritische Probleme als Warnungen zurück
  const warnings = [];
  if (!data || typeof data !== 'object') throw new Error('Ungültiges JSON-Objekt');
  if (data.schemaVersion != null && (typeof data.schemaVersion !== 'number' || data.schemaVersion < 1 || data.schemaVersion > 99)) throw new Error('Ungültige schemaVersion');
  if (data.positions != null && !Array.isArray(data.positions)) throw new Error('Feld "positions" muss ein Array sein');
  if (data.transactions != null && !Array.isArray(data.transactions)) throw new Error('Feld "transactions" muss ein Array sein');
  if (data.goal != null && typeof data.goal !== 'object') throw new Error('Feld "goal" muss ein Objekt sein');
  if (data.watchlist != null && !Array.isArray(data.watchlist)) throw new Error('Feld "watchlist" muss ein Array sein');
  if (data.journal != null && !Array.isArray(data.journal)) throw new Error('Feld "journal" muss ein Array sein');
  // Positionen prüfen
  if (Array.isArray(data.positions)) {
    data.positions.forEach((p, i) => {
      const posLabel = p?.name || p?.symbol || p?.quoteSymbol || `Unbenannte Position (${i + 1})`;
      if (!p.id || typeof p.id !== 'string') throw new Error(`"${posLabel}": id fehlt oder ungültig`);
      if (!p.name || typeof p.name !== 'string') throw new Error(`"${posLabel}": name fehlt`);
      if (p.shares != null && (typeof p.shares !== 'number' || !isFinite(p.shares))) throw new Error(`"${posLabel}": shares ungültig`);
      if (p.costPrice != null && (typeof p.costPrice !== 'number' || !isFinite(p.costPrice))) throw new Error(`"${posLabel}": costPrice ungültig`);
    });
  }
  // Transaktionen prüfen
  if (Array.isArray(data.transactions)) {
    const validTxTypes = new Set(['buy', 'sell', 'deposit', 'withdraw', 'fee', 'tax', 'dividend', 'distribution', 'interest', 'bonus', 'staking', 'adjust']);
    const validAssetTypes = new Set(['stock', 'etf', 'crypto', 'metal', 'cash']);
    data.transactions.forEach((t, i) => {
      if (!t.id) throw new Error(`Transaktion ${i + 1}: id fehlt`);
      if (!t.assetId) throw new Error(`Transaktion ${i + 1}: assetId fehlt`);
      if (!validTxTypes.has(t.txType)) throw new Error(`Transaktion ${i + 1}: ungültiger txType "${t.txType}"`);
      if (!validAssetTypes.has(t.assetType)) warnings.push(`Transaktion ${i + 1}: unbekannter assetType "${t.assetType}"`);
      if (t.date && !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) warnings.push(`Transaktion ${i + 1}: Datum nicht ISO-Format`);
    });
  }
  return warnings;
}

async function importJson(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    // Schema validieren (wirft bei Fehler)
    const warnings = validateBackupSchema(data);
    // Vorschau + Bestätigung
    const lines = [
      `Schema-Version: ${data.schemaVersion || '?'}`,
      `Exportiert: ${data.exportedAt ? new Date(data.exportedAt).toLocaleString('de-AT') : '—'}`,
      `User: ${data.user || '—'}`,
      `Positionen: ${Array.isArray(data.positions) ? data.positions.length : 0}`,
      `Transaktionen: ${Array.isArray(data.transactions) ? data.transactions.length : 0}`,
      `Ziel: ${data.goal?.amount || '?'} € bis ${data.goal?.year || '?'}`,
      `Cash: ${data.goal?.cash != null ? data.goal.cash + ' €' : '—'}`,
      `Watchlist-Einträge: ${Array.isArray(data.watchlist) ? data.watchlist.length : 0}`,
      `Journal-Einträge: ${Array.isArray(data.journal) ? data.journal.length : 0}`,
      `Gedächtnis: ${data.chatMemorySummary ? data.chatMemorySummary.length + ' Zeichen' : 'leer'}`
    ];
    if (warnings.length > 0) {
      lines.push('', '⚠ Warnungen:');
      warnings.slice(0, 5).forEach(w => lines.push('  · ' + w));
      if (warnings.length > 5) lines.push(`  · ... und ${warnings.length - 5} weitere`);
    }
    if (data.user && typeof USER_KEY !== 'undefined' && data.user !== USER_KEY) {
      const foreign = confirm(`Dieses Backup gehört zu "${data.user}", geöffnet ist aber "${USER_KEY}". Wirklich in dieses Portfolio importieren?`);
      if (!foreign) return;
    }
    const ok = confirm(`Backup importieren? Dies überschreibt deine aktuellen Daten. Vorher wird automatisch ein Sicherheitsbackup des jetzigen Stands heruntergeladen.\n\n${lines.join('\n')}\n\nFortfahren?`);
    if (!ok) return;
    backupJson('vor-import');
    if (Array.isArray(data.positions)) appData.positions = data.positions;
    if (data.goal) appData.goal = data.goal;
    if (Array.isArray(data.transactions)) appData.transactions = data.transactions;
    if (data.metalHistory) appData.metalHistory = data.metalHistory;
    if (Array.isArray(data.watchlist)) appData.watchlist = data.watchlist;
    if (Array.isArray(data.journal)) appData.journal = data.journal;
    if (Array.isArray(data.income)) appData.income = data.income;
    if (data.layout) appData.layout = data.layout;
    if (data.schemaVersion) appData.schemaVersion = data.schemaVersion;
    if (typeof data.chatMemorySummary === 'string') {
      chatMemorySummary = data.chatMemorySummary;
      try { await saveChatMemorySummary(); } catch {}
    }
    await savePositionsToKV();
    await refreshUI();
    alert('Import erfolgreich.');
  } catch (e) {
    alert('Fehler beim Import: ' + (e.message || e));
  }
}

function renderRiskRules(totals, alloc) {
  const section = document.getElementById('riskRulesSection');
  const head = document.getElementById('riskRulesHead');
  const list = document.getElementById('riskRulesList');
  if (!section || !head || !list) return;
  const items = evaluateRiskRules(totals, alloc);
  const violations = items.filter(i => i.violated);
  const hasViolations = violations.length > 0;
  section.classList.toggle('has-violations', hasViolations);
  const headSpan = head.querySelector('span');
  if (headSpan) {
    if (hasViolations) {
      headSpan.innerHTML = `<span class="warn">Risiko-Regeln · ${violations.length} verletzt</span>`;
    } else {
      headSpan.innerHTML = `<span class="ok">Risiko-Regeln · alle eingehalten</span>`;
    }
  }
  if (items.length === 0) {
    list.innerHTML = '<div class="risk-rules-empty">Keine Daten zur Auswertung verfügbar.</div>';
    return;
  }
  list.innerHTML = items.map(item => `
    <div class="risk-rule-item">
      <span class="lbl">${item.label}</span>
      <span class="val ${item.violated ? 'violated' : 'ok'}">${item.value}</span>
    </div>`).join('');
}
