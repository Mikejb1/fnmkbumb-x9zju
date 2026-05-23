// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== STEUER/PERFORMANCE + LOKALE BENACHRICHTIGUNGEN =====
function txYearOf(tx) {
  return Number(String(cashEffectiveDate(tx) || tx?.date || '').slice(0, 4)) || new Date().getFullYear();
}

function calculateRealizedPerformance(year = new Date().getFullYear()) {
  const state = new Map();
  const rows = [];
  const txs = (appData?.transactions || [])
    .filter(tx => tx && tx.assetType !== 'cash' && tx.assetType !== 'metal' && ['buy', 'sell', 'adjust'].includes(tx.txType))
    .slice()
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

  txs.forEach(tx => {
    const key = tx.assetId || '';
    const current = state.get(key) || { shares: 0, costBasis: 0 };
    const qty = Number(tx.quantity) || 0;
    const value = Number(tx.value) || qty * (Number(tx.price) || 0);
    const fees = Number(tx.fees) || 0;
    if (tx.txType === 'adjust') {
      current.shares = qty;
      current.costBasis = value;
    } else if (tx.txType === 'buy') {
      current.shares += qty;
      current.costBasis += value + fees;
    } else if (tx.txType === 'sell') {
      const sold = Math.min(qty, current.shares);
      const avg = current.shares > 0 ? current.costBasis / current.shares : 0;
      const cost = avg * sold;
      const proceeds = Number(tx.accountCashValue) > 0 ? Number(tx.accountCashValue) : value - fees;
      const realized = proceeds - cost;
      if (txYearOf(tx) === year) {
        const pos = (appData?.positions || []).find(p => p.id === tx.assetId);
        rows.push({
          date: tx.date,
          name: pos?.name || tx.note || tx.assetId || 'Verkauf',
          proceeds,
          cost,
          fees,
          realized,
        });
      }
      current.costBasis = Math.max(0, current.costBasis - cost);
      current.shares = Math.max(0, current.shares - sold);
    }
    state.set(key, current);
  });

  const totalRealized = rows.reduce((sum, row) => sum + row.realized, 0);
  const wins = rows.filter(row => row.realized > 0).reduce((sum, row) => sum + row.realized, 0);
  const losses = rows.filter(row => row.realized < 0).reduce((sum, row) => sum + row.realized, 0);
  return { rows, totalRealized, wins, losses };
}

function calculateTaxPerformanceSummary(totals) {
  const year = new Date().getFullYear();
  const realized = calculateRealizedPerformance(year);
  const income = (appData?.income || []).filter(entry => String(entry.date || '').startsWith(String(year)));
  const incomeGross = income.reduce((sum, entry) => sum + (Number(entry.gross) || 0), 0);
  const incomeTax = income.reduce((sum, entry) => sum + (Number(entry.tax) || 0), 0);
  const incomeNet = income.reduce((sum, entry) => sum + (Number(entry.net) || 0), 0);
  const cashTax = (appData?.transactions || [])
    .filter(tx => tx.assetType === 'cash' && tx.txType === 'tax' && txYearOf(tx) === year)
    .reduce((sum, tx) => sum + (Number(tx.value) || 0), 0);
  const cashFees = (appData?.transactions || [])
    .filter(tx => tx.assetType === 'cash' && tx.txType === 'fee' && txYearOf(tx) === year)
    .reduce((sum, tx) => sum + (Number(tx.value) || 0), 0);
  const tradeFees = (appData?.transactions || [])
    .filter(tx => tx.assetType !== 'cash' && txYearOf(tx) === year)
    .reduce((sum, tx) => sum + (Number(tx.fees) || 0), 0);
  const unrealized = (currentPortfolioPositions() || []).reduce((sum, pos) => sum + getPositionValuation(pos).pnlAbs, 0);
  return {
    year,
    realized,
    incomeGross,
    incomeTax,
    incomeNet,
    cashTax,
    cashFees,
    tradeFees,
    totalTaxes: incomeTax + cashTax,
    totalFees: cashFees + tradeFees,
    unrealized,
    totalPnl: Number(totals?.totalPnl) || 0,
  };
}

function renderTaxPerformance(totals) {
  const body = document.getElementById('taxPerformanceBody');
  const status = document.getElementById('taxPerformanceStatus');
  if (!body) return;
  const s = calculateTaxPerformanceSummary(totals);
  const realizedClass = s.realized.totalRealized >= 0 ? 'positive' : 'negative';
  if (status) status.textContent = s.realized.rows.length ? `${s.realized.rows.length} Verkäufe` : String(s.year);
  const topRows = s.realized.rows
    .slice()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 5);
  body.innerHTML = `
    <div class="tax-perf-grid">
      <div class="tax-perf-card"><div class="label">Realisierter G/V ${s.year}</div><div class="value ${realizedClass}">${s.realized.totalRealized >= 0 ? '+' : ''}${fmt.format(s.realized.totalRealized)}</div></div>
      <div class="tax-perf-card"><div class="label">Offener G/V aktuell</div><div class="value ${s.unrealized >= 0 ? 'positive' : 'negative'}">${s.unrealized >= 0 ? '+' : ''}${fmt.format(s.unrealized)}</div></div>
      <div class="tax-perf-card"><div class="label">Erträge netto ${s.year}</div><div class="value positive">${fmt.format(s.incomeNet)}</div></div>
      <div class="tax-perf-card"><div class="label">Steuern & Gebühren</div><div class="value negative">${fmt.format(s.totalTaxes + s.totalFees)}</div></div>
    </div>
    <div class="tax-perf-table">
      <div class="tax-perf-row"><span>Gewinne aus Verkäufen</span><span class="amount positive">${fmt.format(s.realized.wins)}</span></div>
      <div class="tax-perf-row"><span>Verluste aus Verkäufen</span><span class="amount negative">${fmt.format(s.realized.losses)}</span></div>
      <div class="tax-perf-row"><span>Erträge brutto / Steuer</span><span class="amount">${fmt.format(s.incomeGross)} / ${fmt.format(s.incomeTax)}</span></div>
      <div class="tax-perf-row"><span>Order- und Cash-Gebühren</span><span class="amount">${fmt.format(s.totalFees)}</span></div>
    </div>
    ${topRows.length ? `<div class="tax-perf-table">${topRows.map(row => `<div class="tax-perf-row"><span>${escapeHtml(formatDateAT(row.date))} · ${escapeHtml(row.name)}</span><span class="amount ${row.realized >= 0 ? 'positive' : 'negative'}">${row.realized >= 0 ? '+' : ''}${fmt.format(row.realized)}</span></div>`).join('')}</div>` : ''}
    <div class="tax-perf-note">Hinweis: Das ist eine Portfolio-Auswertung, keine Steuerberatung. Realisierte Gewinne/Verluste werden aus deinen Buchungen mit Average-Cost berechnet; Broker-Steuerlogik kann davon abweichen.</div>
  `;
}

function backupAgeDays() {
  try {
    const ts = parseInt(localStorage.getItem(BACKUP_TS_KEY) || localStorage.getItem(LEGACY_BACKUP_TS_KEY) || '0', 10);
    return ts > 0 ? (Date.now() - ts) / 86400000 : null;
  } catch (e) {
    return null;
  }
}

function buildPortfolioAlerts(totals, goal, alloc) {
  const alerts = [];
  const quality = computeDataQuality(totals);
  if (quality.score < 80) alerts.push({ level: 'warn', title: `Datenqualität ${quality.score}/100`, text: 'Einige Berechnungen nutzen Ersatzwerte. Öffne die Datenqualität, um die konkreten Punkte direkt zu verbessern.' });
  else if (quality.score < 100) alerts.push({ level: 'info', title: `Datenqualität ${quality.score}/100`, text: 'Die Auswertungen sind nutzbar, aber für volle Genauigkeit fehlen noch Detaildaten wie Historie, Backup oder Stammdaten.' });

  const cash = currentCashValue();
  if (cash < -0.01) alerts.push({ level: 'critical', title: 'Cash ist negativ', text: `${fmt.format(cash)} Cash-Saldo. Prüfe Kontoumsätze, Einzahlungen und Order-Cashwerte.` });

  const marketValue = Number(totals?.marketValue) || 0;
  const biggest = currentPortfolioPositions()
    .map(pos => ({ pos, value: getPositionValuation(pos).currentValue }))
    .sort((a, b) => b.value - a.value)[0];
  if (biggest && marketValue > 0) {
    const pct = (biggest.value / marketValue) * 100;
    if (pct >= 35) alerts.push({ level: pct >= 50 ? 'critical' : 'warn', title: 'Klumpenrisiko', text: `${biggest.pos.name} macht ${fmtNum(pct, 1)} % vom Börsenwert aus.` });
  }

  const missingLive = currentPortfolioPositions().filter(pos => !currentPrices[pos.id]?.live && !isManualQuoteOverrideActive(pos));
  if (missingLive.length) alerts.push({ level: 'warn', title: 'Livekurse prüfen', text: `${missingLive.slice(0, 3).map(p => p.name).join(', ')}${missingLive.length > 3 ? ' …' : ''} nutzt manuelle oder alte Kursbasis.` });

  if (goal?.amount && goal?.monthsToGoal) {
    const projected = futureValueWithMonthlySavings(totals.totalCur, goal.savingsRate || 0, goal.monthsToGoal, goal.annualReturnPct || 0);
    const gap = (goal.planAmount || goal.amount) - projected;
    if (gap > 0) alerts.push({ level: 'info', title: 'Zielpfad beobachten', text: `Im aktuellen Spar-/Rendite-Szenario fehlen rechnerisch ${fmt.format(gap)} bis zum Planziel.` });
  }

  const age = backupAgeDays();
  if (age == null) alerts.push({ level: 'warn', title: 'Backup fehlt', text: 'Lade ein JSON-Backup herunter, bevor du größere Importe oder Änderungen machst.' });
  else if (age > 30) alerts.push({ level: 'info', title: 'Backup auffrischen', text: `Das letzte erkannte Backup ist ca. ${Math.floor(age)} Tage alt.` });

  if (!alerts.length) alerts.push({ level: 'good', title: 'Alles ruhig', text: 'Keine wichtigen lokalen Warnungen erkannt. Kurse, Ziel und Datenqualität wirken aktuell plausibel.' });
  return alerts;
}

function renderPortfolioAlerts(totals, goal, alloc) {
  const list = document.getElementById('alertsList');
  const count = document.getElementById('alertsCount');
  if (!list) return;
  const alerts = buildPortfolioAlerts(totals, goal, alloc);
  if (count) count.textContent = String(alerts.filter(a => a.level !== 'good').length);
  list.innerHTML = alerts.map(item => `<div class="alert-item ${item.level}">
    <span class="meta">${item.level === 'critical' ? 'Wichtig' : item.level === 'warn' ? 'Prüfen' : item.level === 'good' ? 'Status' : 'Hinweis'}</span>
    <strong>${escapeHtml(item.title)}</strong>
    <p>${escapeHtml(item.text)}</p>
  </div>`).join('');
}

function buildDailyCheck(totals, goal, alloc) {
  const positions = currentPortfolioPositions();
  const quality = computeDataQuality(totals);
  const liveCount = positions.filter(pos => currentPrices[pos.id]?.live || isManualQuoteOverrideActive(pos)).length;
  const missingLive = positions.filter(pos => !currentPrices[pos.id]?.live && !isManualQuoteOverrideActive(pos));
  const staleLive = positions.filter(pos => {
    const live = currentPrices[pos.id];
    const age = quoteAgeMinutes(live);
    return live?.live && age != null && age > Math.max(45, quoteCadenceMinutes(pos, live) * 3);
  });
  const suspiciousMoves = positions.filter(pos => {
    const live = currentPrices[pos.id];
    const move = getPositionTodayChange(pos, live);
    if (!move || !Number.isFinite(move.pct)) return false;
    const limit = isCryptoPos(pos) ? 25 : 12;
    return Math.abs(move.pct) >= limit;
  });
  const dueJournal = ensureJournal().filter(entry => entry.status !== 'done' && entry.reviewDate && entry.reviewDate <= new Date().toISOString().slice(0, 10));
  const cash = currentCashValue();
  const backupAge = backupAgeDays();
  const tasks = [];

  if (positions.length === 0) {
    tasks.push({ level: 'warn', title: 'Portfolio starten', text: 'Lege Positionen manuell an oder importiere deine Depotumsätze.', action: 'import', label: 'Import öffnen' });
  }
  if (missingLive.length) {
    tasks.push({ level: 'warn', title: 'Kursquellen prüfen', text: `${missingLive.slice(0, 3).map(p => p.name).join(', ')}${missingLive.length > 3 ? ' …' : ''} nutzt keine Live-Daten.`, action: 'quality', label: 'Datenqualität' });
  } else if (staleLive.length) {
    tasks.push({ level: 'warn', title: 'Kurse wirken alt', text: `${staleLive.slice(0, 3).map(p => p.name).join(', ')}${staleLive.length > 3 ? ' …' : ''} ist deutlich verzögert.`, action: 'refresh', label: 'Aktualisieren' });
  }
  if (suspiciousMoves.length) {
    tasks.push({ level: 'warn', title: 'Tagesbewegung plausibilisieren', text: `${suspiciousMoves.slice(0, 3).map(p => p.name).join(', ')} hat heute eine ungewöhnlich starke Bewegung.`, action: 'positions', label: 'Positionen' });
  }
  if (quality.score < 100) {
    tasks.push({ level: quality.score < 80 ? 'warn' : 'info', title: `Datenqualität ${quality.score}/100`, text: quality.score < 80 ? 'Einige Auswertungen nutzen Ersatzwerte oder unvollständige Eingaben.' : 'Die App ist nutzbar, aber ein paar optionale Details fehlen noch.', action: 'quality', label: 'Verbessern' });
  }
  if (cash < -0.01) {
    tasks.push({ level: 'critical', title: 'Cash-Saldo negativ', text: `${fmt.format(cash)}. Prüfe Kontoumsätze, Order-Cashwerte oder Einzahlungen.`, action: 'cash', label: 'Bewegungen' });
  }
  if (goal?.amount && goal?.monthsToGoal) {
    const projected = futureValueWithMonthlySavings(totals.totalCur, goal.savingsRate || 0, goal.monthsToGoal, goal.annualReturnPct || 0);
    const gap = (goal.planAmount || goal.amount) - projected;
    if (gap > 0) {
      tasks.push({ level: 'info', title: 'Zielpfad prüfen', text: `Zum Planziel fehlen rechnerisch ${fmt.format(gap)}.`, action: 'goal', label: 'Ziel öffnen' });
    }
  }
  if (dueJournal.length) {
    tasks.push({ level: 'info', title: 'Journal-Review fällig', text: `${dueJournal.length} Entscheidung${dueJournal.length === 1 ? '' : 'en'} sollte überprüft werden.`, action: 'journal', label: 'Journal' });
  }
  if (backupAge == null) {
    tasks.push({ level: 'warn', title: 'Backup fehlt', text: 'Erstelle vor größeren Änderungen ein JSON-Backup.', action: 'backup', label: 'Backup' });
  } else if (backupAge > 30) {
    tasks.push({ level: 'info', title: 'Backup auffrischen', text: `Das letzte erkannte Backup ist ca. ${Math.floor(backupAge)} Tage alt.`, action: 'backup', label: 'Backup' });
  }

  const statuses = [
    { label: 'Kurse', value: positions.length ? `${liveCount}/${positions.length} aktuell` : 'keine Titel', level: missingLive.length ? 'warn' : 'good' },
    { label: 'Daten', value: `${quality.score}/100`, level: quality.score >= 90 ? 'good' : (quality.score >= 70 ? 'warn' : 'critical') },
    { label: 'Cash', value: fmt.format(cash), level: cash < -0.01 ? 'critical' : 'good' },
    { label: 'Backup', value: backupAge == null ? 'fehlt' : (backupAge < 1 ? 'heute' : `${Math.floor(backupAge)} Tage`), level: backupAge == null || backupAge > 30 ? 'warn' : 'good' }
  ];

  if (!tasks.length) {
    tasks.push({ level: 'good', title: 'Alles erledigt', text: 'Für den heutigen Kurzcheck gibt es keine offenen Punkte.', action: '', label: '' });
  }

  const openTasks = tasks.filter(task => task.level !== 'good').length;
  const worst = tasks.some(t => t.level === 'critical') ? 'critical' : (tasks.some(t => t.level === 'warn') ? 'warn' : 'good');
  return { statuses, tasks: tasks.slice(0, 6), openTasks, worst };
}

function renderDailyCheck(totals, goal, alloc) {
  const section = document.getElementById('dailyCheckSection');
  const statusGrid = document.getElementById('dailyStatusGrid');
  const taskList = document.getElementById('dailyTaskList');
  const sub = document.getElementById('dailyCheckSub');
  const score = document.getElementById('dailyCheckScore');
  if (!section || !statusGrid || !taskList) return;
  const check = buildDailyCheck(totals, goal, alloc);
  if (sub) sub.textContent = check.openTasks ? `${check.openTasks} Punkt${check.openTasks === 1 ? '' : 'e'} brauchen Aufmerksamkeit.` : 'Alles Wichtige wirkt heute plausibel.';
  if (score) {
    score.textContent = check.openTasks ? `${check.openTasks} offen` : 'OK';
    score.className = `daily-check-score ${check.worst}`;
  }
  section.classList.toggle('has-open-tasks', check.openTasks > 0);
  statusGrid.innerHTML = check.statuses.map(item => `<div class="daily-status-card ${item.level}">
    <div class="label">${escapeHtml(item.label)}</div>
    <div class="value">${escapeHtml(item.value)}</div>
  </div>`).join('');
  taskList.innerHTML = check.tasks.map(task => `<div class="daily-task ${task.level}">
    <span class="ico">${task.level === 'good' ? '✓' : task.level === 'critical' ? '!' : 'i'}</span>
    <div><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.text)}</span></div>
    ${task.action ? `<button type="button" class="daily-action-btn" data-daily-action="${escapeHtml(task.action)}">${escapeHtml(task.label || 'Öffnen')}</button>` : ''}
  </div>`).join('');
}

function runDailyAction(action) {
  if (action === 'refresh') return refreshLiveValuesOnly();
  if (action === 'quality') return scrollQualityTarget('qualitySection');
  if (action === 'backup') return backupJson();
  if (action === 'cash') return openCashTxList();
  if (action === 'goal') return scrollQualityTarget('anchor-goal');
  if (action === 'journal') return scrollQualityTarget('anchor-journal');
  if (action === 'positions') return scrollQualityTarget('anchor-positions');
  if (action === 'import') return scrollQualityTarget('.add-position-section');
}
