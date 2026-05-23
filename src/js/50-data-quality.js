// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== DATENQUALITÄTS-SCORE =====
const BACKUP_TS_KEY = STORAGE_PREFIX + 'last_backup_ts';
const LEGACY_BACKUP_TS_KEY = 'portfolio_last_backup_ts';
function looksLikeWkn(value) {
  return /^[A-Z0-9]{6}$/.test(cleanQuoteSymbol(value)) && !looksLikeIsin(value);
}
function metaValueForQuality(pos, field) {
  const sd = pos?.stammdaten || {};
  if (field === 'isin') return sd.isin || pos?.isin || (looksLikeIsin(pos?.symbol) ? cleanQuoteSymbol(pos.symbol) : '');
  if (field === 'wkn') return sd.wkn || pos?.wkn || (looksLikeWkn(pos?.symbol) ? cleanQuoteSymbol(pos.symbol) : '');
  if (field === 'sektor') return sd.sektor || sd.sector || pos?.sektor || pos?.sector || '';
  if (field === 'custodian') return sd.custodian || pos?.custodian || '';
  if (field === 'custodyType') return sd.custodyType || pos?.custodyType || '';
  if (field === 'land') return sd.land || sd.country || pos?.land || pos?.country || '';
  return sd[field] || pos?.[field] || '';
}
function hasAnyQualityMetadata(pos) {
  const fields = ['isin', 'wkn', 'sektor', 'custodian', 'custodyType', 'land'];
  return fields.some(f => String(metaValueForQuality(pos, f) || '').trim())
    || !!cleanQuoteSymbol(pos?.quoteSymbol || pos?.symbol || pos?.cgId || '');
}
function qualityPositionName(pos) {
  return String(pos?.name || pos?.symbol || pos?.quoteSymbol || 'Unbenannte Position').trim();
}
function qualityMetadataFields(pos) {
  // Krypto braucht keine Aktien-WKN, keinen Aktien-Sektor und keine Verwahrart-Pflicht.
  return isCryptoPos(pos) ? ['isin', 'custodian'] : ['isin', 'wkn', 'sektor', 'custodian', 'custodyType', 'land'];
}
function qualityPositionAction(kind, label, title, hint, positions) {
  const posIds = (positions || []).map(pos => pos?.id).filter(Boolean);
  return posIds.length ? { kind, label, title, hint, posIds } : null;
}
function quoteAgeMinutes(live) {
  const ts = live?.updatedAt ? new Date(live.updatedAt).getTime() : NaN;
  return Number.isFinite(ts) ? Math.max(0, Math.round((Date.now() - ts) / 60000)) : null;
}
function historyQualityForPositions() {
  const positions = (appData?.positions || []).filter(p => !p.special);
  const namesWithDailyFxApprox = [];
  const namesWithMonthlyOnly = [];
  const namesWithoutHistory = [];
  positions.forEach(pos => {
    if (isCryptoPos(pos)) {
      if (!Array.isArray(weeklyData[pos.id]) || weeklyData[pos.id].length < 2) namesWithoutHistory.push(qualityPositionName(pos));
      return;
    }
    if (Array.isArray(pos.dailyHistory) && pos.dailyHistory.length > 20) {
      if (pos.dailyHistoryFxApproximate) namesWithDailyFxApprox.push(qualityPositionName(pos));
      return;
    }
    if (Array.isArray(pos.monthlyHistory) && pos.monthlyHistory.length > 0) namesWithMonthlyOnly.push(qualityPositionName(pos));
    else namesWithoutHistory.push(qualityPositionName(pos));
  });
  return { namesWithDailyFxApprox, namesWithMonthlyOnly, namesWithoutHistory };
}
let coreCalculationSelfTestResult = null;
function approxEqual(a, b, epsilon = 0.01) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon;
}
function runCoreCalculationSelfTests() {
  if (coreCalculationSelfTestResult) return coreCalculationSelfTestResult;
  const savedData = appData;
  const savedPrices = currentPrices;
  const failures = [];
  try {
    appData = {
      goal: { cash: 0, month: 12, minSavingsRate: 0, maxSavingsRate: 1000, bufferPct: 10, annualReturnPct: 4, type: 'wealth', priority: 'medium' },
      positions: [{ id: 'self_stock', type: 'Aktie', shares: 5, costPrice: 100 }],
      transactions: [
        { id: 'self_cash', date: '2026-01-01', assetId: 'cash', assetType: 'cash', txType: 'deposit', value: 1000, quantity: 1000, price: 1, fees: 0 },
        { id: 'self_buy', date: '2026-01-02', assetId: 'self_stock', assetType: 'stock', txType: 'buy', value: 500, quantity: 5, price: 100, fees: 0 }
      ]
    };
    currentPrices = { self_stock: { price: 120 } };
    if (!approxEqual(getCashBalance('2026-01-01'), 1000)) failures.push('Cash nach Einzahlung');
    if (!approxEqual(getCashBalance('2026-01-02'), 500)) failures.push('Cash nach Kauf');
    if (!approxEqual(sharesAtDate(appData.positions[0], '2026-01-01'), 0)) failures.push('Stückzahl vor erstem Kauf');
    const v = getPositionValuation(appData.positions[0], currentPrices.self_stock);
    if (!approxEqual(v.currentValue, 600) || !approxEqual(v.pnlAbs, 100)) failures.push('Positionsbewertung');
    if (!approxEqual(getNetExternalContributions('2026-01-02'), 1000)) failures.push('Netto-Cashflow');
  } catch (e) {
    failures.push(e.message || 'Laufzeitfehler');
  } finally {
    appData = savedData;
    currentPrices = savedPrices;
  }
  coreCalculationSelfTestResult = { ok: failures.length === 0, failures };
  if (!coreCalculationSelfTestResult.ok) console.warn('Portfolio calculation self-test failed:', failures);
  return coreCalculationSelfTestResult;
}
function calculationSanityIssues(totals) {
  const issues = [];
  const selfTest = runCoreCalculationSelfTests();
  if (!selfTest.ok) issues.push({ severity: 'error', text: `Interner Berechnungscheck fehlgeschlagen: ${selfTest.failures.join(', ')}.` });
  if (totals && (!Number.isFinite(totals.totalCur) || !Number.isFinite(totals.totalCost))) {
    issues.push({ severity: 'error', text: 'Depotwert oder Einstand ist nicht numerisch belastbar. Bitte Positionen und Kurse prüfen.' });
  }
  const invalidTx = (appData?.transactions || []).filter(t => !t.date || !Number.isFinite(Number(t.value)) || Number(t.value) < 0);
  if (invalidTx.length > 0) issues.push({ severity: 'warn', text: `${invalidTx.length} Transaktion${invalidTx.length === 1 ? '' : 'en'} haben fehlendes Datum oder unplausiblen Betrag.` });
  const cashBalance = currentCashValue();
  if (cashBalance < -0.01) {
    issues.push({ severity: 'warn', text: `Cash-Saldo ist negativ (${fmt.format(cashBalance)}). Prüfe Kontoumsätze, Einzahlungen und Order-Cashwerte.`, action: { kind: 'cash-list', label: 'Bewegungen prüfen' } });
  }
  const negativeShares = (appData?.positions || []).filter(p => !p.special && getPositionValuation(p).shares < -1e-8);
  if (negativeShares.length > 0) issues.push({ severity: 'warn', text: `Negative Stückzahl erkannt bei ${negativeShares.slice(0, 3).map(qualityPositionName).join(', ')}.` });
  return issues;
}
function buildDataQualityScoreParts() {
  const parts = [];
  const add = (label, earned, max, hint) => {
    const safeEarned = Math.max(0, Math.min(max, Number(earned) || 0));
    parts.push({ label, earned: safeEarned, max, hint });
  };
  const positions = currentPortfolioPositions();
  if (positions.length > 0) {
    const complete = positions.filter(p => Number(getPositionValuation(p).shares) > 0 && Number(p.costPrice) > 0).length;
    add('Positionen', (complete / positions.length) * 25, 25, `${complete}/${positions.length} mit Stück + Einstand`);
    const txs = appData?.transactions || [];
    const withBuys = positions.filter(p => txs.some(t => t.assetId === p.id && t.txType === 'buy' && t.date && t.value > 0)).length;
    add('Kaufdaten', (withBuys / positions.length) * 25, 25, `${withBuys}/${positions.length} mit Kaufhistorie`);
    const totalFields = positions.reduce((sum, p) => sum + qualityMetadataFields(p).length, 0);
    const filledFields = positions.reduce((sum, p) => sum + qualityMetadataFields(p).filter(f => String(metaValueForQuality(p, f) || '').trim()).length, 0);
    add('Stammdaten', totalFields > 0 ? (filledFields / totalFields) * 15 : 0, 15, `${filledFields}/${totalFields} Felder gepflegt`);
  } else {
    add('Positionen', 0, 25, 'keine aktuelle Position');
    add('Kaufdaten', 0, 25, 'keine Kaufhistorie');
    add('Stammdaten', 0, 15, 'keine aktuellen Titel');
  }

  const cashAmount = Number(appData?.goal?.cash || 0);
  const hasCashTx = hasCashTransactions();
  add('Cash', hasCashTx ? 15 : (cashAmount > 0 ? 5 : 15), 15, hasCashTx ? 'Bewegungen vorhanden' : (cashAmount > 0 ? 'nur Saldo-Wert' : 'kein Cash offen'));

  const g = appData?.goal || {};
  let goalPts = 0;
  if (g.year && g.year >= 2025) goalPts += 3;
  if (g.amount && g.amount > 0) goalPts += 4;
  if (g.savingsRate != null && g.savingsRate > 0) goalPts += 3;
  add('Ziel', goalPts, 10, goalPts >= 10 ? 'Ziel vollständig' : 'Zieljahr, Betrag, Sparrate');

  let backupTs = 0;
  try { backupTs = parseInt(localStorage.getItem(BACKUP_TS_KEY) || localStorage.getItem(LEGACY_BACKUP_TS_KEY) || '0', 10); } catch (e) {}
  if (backupTs > 0) {
    const ageDays = (Date.now() - backupTs) / (1000 * 60 * 60 * 24);
    add('Backup', ageDays < 30 ? 10 : (ageDays < 90 ? 5 : 2), 10, ageDays < 30 ? 'aktuell' : `${Math.floor(ageDays)} Tage alt`);
  } else {
    add('Backup', 0, 10, 'noch kein Backup');
  }
  return parts;
}
function computeDataQuality(totals) {
  const issues = [];
  const qualityTips = [];
  let score = 0;

  // 1) Positionen mit Stückzahl, Einstand, aktuellem Wert (25 %)
  const positions = currentPortfolioPositions();
  const historicalPositions = (appData?.positions || []).filter(pos => !pos.special && pos.archived);
  if (positions.length === 0) {
    issues.push({ severity: 'info', text: 'Noch keine Positionen erfasst.' });
  } else {
    const incompletePositions = positions.filter(p => !(Number(getPositionValuation(p).shares) > 0 && Number(p.costPrice) > 0));
    const complete = positions.length - incompletePositions.length;
    score += (complete / positions.length) * 25;
    const missing = incompletePositions.length;
    if (missing > 0) issues.push({ severity: 'warn', text: `Bei ${missing} aktueller Position${missing === 1 ? '' : 'en'} fehlen Stückzahl oder Einstandspreis.`, action: qualityPositionAction('core', 'Position bearbeiten', 'Stückzahl und Einstand prüfen', 'Öffne die betroffene aktuelle Position und ergänze Stückzahl oder Einstand.', incompletePositions) });
  }

  // 2) Kauf-Lots mit Datum und Betrag (25 %) — Anzahl Positionen mit ≥ 1 zugeordneter buy-Transaktion
  if (positions.length > 0) {
    const txs = appData?.transactions || [];
    const positionsWithoutBuyTx = positions.filter(p => !txs.some(t => t.assetId === p.id && t.txType === 'buy' && t.date && t.value > 0));
    const posWithTx = positions.length - positionsWithoutBuyTx.length;
    score += (posWithTx / positions.length) * 25;
    const noLot = positionsWithoutBuyTx.length;
    if (noLot > 0) issues.push({ severity: 'warn', text: `Bei ${noLot} aktueller Position${noLot === 1 ? '' : 'en'} fehlen Kaufdaten (Datum + Betrag).`, action: qualityPositionAction('buy', 'Kaufdaten ergänzen', 'Kaufdaten ergänzen', 'Erfasse einen Kauf mit Datum, Stückzahl und Preis oder importiere die vollständigen Flatex-Umsätze.', positionsWithoutBuyTx) });
  }

  // 3) Cash-Bewegungen gepflegt (15 %)
  const cashAmount = Number(appData?.goal?.cash || 0);
  const hasCashTx = (appData?.transactions || []).some(t => t.assetType === 'cash');
  if (hasCashTx) {
    score += 15;
  } else if (cashAmount > 0) {
    score += 5;
    issues.push({ severity: 'info', text: 'Cash-Bewegungen sind nicht einzeln gepflegt (nur Slider-Wert).', action: { kind: 'cash', label: 'Cash-Bewegung erfassen' } });
  } else {
    score += 15;
  }

  // 4) Stammdaten (ISIN/WKN/Sektor/Custodian) (15 %)
  if (positions.length > 0) {
    const fieldLabels = { isin: 'ISIN', wkn: 'WKN', sektor: 'Sektor', custodian: 'Lagerstelle/Broker', custodyType: 'Verwahrart', land: 'Land' };
    const missingByField = {};
    let totalFields = 0, filledFields = 0;
    positions.forEach(p => {
      qualityMetadataFields(p).forEach(f => {
        totalFields++;
        if (String(metaValueForQuality(p, f) || '').trim()) filledFields++;
        else {
          if (!missingByField[f]) missingByField[f] = [];
          missingByField[f].push(qualityPositionName(p));
        }
      });
    });
    const stammRatio = totalFields > 0 ? filledFields / totalFields : 0;
    score += stammRatio * 15;
    const missingMetaHints = Object.entries(missingByField)
      .filter(([, names]) => names.length > 0)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 4)
      .map(([field, names]) => {
        const shown = names.slice(0, 3).join(', ');
        return `${fieldLabels[field] || field} fehlt bei ${shown}${names.length > 3 ? ' …' : ''}`;
      });
    if (missingMetaHints.length > 0) {
      const missingMetaPositions = positions.filter(p => qualityMetadataFields(p).some(f => !String(metaValueForQuality(p, f) || '').trim()));
      qualityTips.push({ text: `Für 100 Punkte fehlen noch optionale Stammdaten bei aktuellen Positionen: ${missingMetaHints.join(', ')}.`, action: qualityPositionAction('meta', 'Stammdaten ergänzen', 'Optionale Stammdaten ergänzen', 'Nur aktuelle Positionen zählen für diese Qualitätswertung. Krypto wird dabei nicht wie eine Aktie nach WKN oder Sektor bewertet.', missingMetaPositions) });
    }
    const positionsWithoutAny = positions.filter(p => !hasAnyQualityMetadata(p));
    if (positionsWithoutAny.length > 0) {
      const names = positionsWithoutAny.slice(0, 3).map(qualityPositionName).filter(Boolean).join(', ');
      const suffix = names ? `: ${names}${positionsWithoutAny.length > 3 ? ' …' : ''}` : '.';
      issues.push({ severity: 'info', text: `Bei ${positionsWithoutAny.length} aktueller Position${positionsWithoutAny.length === 1 ? '' : 'en'} fehlen Stammdaten (ISIN/WKN/Sektor)${suffix}`, action: qualityPositionAction('meta', 'Stammdaten ergänzen', 'Stammdaten ergänzen', 'Öffne die aktuelle Position und ergänze die sichtbaren Stammdaten.', positionsWithoutAny) });
    }
  }

  // Zusatzsignale: Kurs- und Verlaufsqualität offen ausweisen
  const pricePositions = positions.filter(p => !p.special);
  const missingLive = pricePositions.filter(p => !currentPrices[p.id]?.live && !isManualQuoteOverrideActive(p));
  const manualOnly = pricePositions.filter(p => isManualQuoteOverrideActive(p) || (!currentPrices[p.id]?.live && !quoteIssues[p.id]));
  const staleLive = pricePositions.filter(p => {
    const live = currentPrices[p.id];
    const age = quoteAgeMinutes(live);
    return live?.live && age != null && age > Math.max(45, quoteCadenceMinutes(p, live) * 3);
  });
  if (missingLive.length > 0) {
    issues.push({ severity: 'warn', text: `Ohne Livekurs: ${missingLive.slice(0, 3).map(qualityPositionName).join(', ')}${missingLive.length > 3 ? ' ...' : ''}. Gesamtwert nutzt dort manuelle oder alte Kursbasis.`, action: qualityPositionAction('quote', 'Kursquelle prüfen', 'Kursquelle prüfen', 'Prüfe Symbol, ISIN/WKN oder Handelsplatz der betroffenen aktuellen Position.', missingLive) });
  }
  if (manualOnly.length > 0) {
    qualityTips.push(`Kursbasis prüfen bei ${manualOnly.slice(0, 3).map(qualityPositionName).join(', ')}${manualOnly.length > 3 ? ' ...' : ''}.`);
  }
  if (staleLive.length > 0) {
    issues.push({ severity: 'info', text: `Verzögerte Livekurse erkannt bei ${staleLive.slice(0, 3).map(qualityPositionName).join(', ')}${staleLive.length > 3 ? ' ...' : ''}.` });
  }
  const historyQuality = historyQualityForPositions();
  if (historyQuality.namesWithoutHistory.length > 0) {
    issues.push({ severity: 'info', text: `Depot-Verlauf nutzt Ersatzkurse bei ${historyQuality.namesWithoutHistory.slice(0, 3).join(', ')}${historyQuality.namesWithoutHistory.length > 3 ? ' ...' : ''}.` });
  }
  if (historyQuality.namesWithDailyFxApprox.length > 0) {
    issues.push({ severity: 'info', text: `Tageshistorie mit aktueller FX-Näherung bei ${historyQuality.namesWithDailyFxApprox.slice(0, 3).join(', ')}${historyQuality.namesWithDailyFxApprox.length > 3 ? ' ...' : ''}.` });
  }
  if (historyQuality.namesWithMonthlyOnly.length > 0) {
    issues.push({ severity: 'info', text: `Historie nur monatlich bei ${historyQuality.namesWithMonthlyOnly.slice(0, 3).join(', ')}${historyQuality.namesWithMonthlyOnly.length > 3 ? ' ...' : ''}; Tagespunkte sind dazwischen Näherungen.` });
  }
  calculationSanityIssues(totals).forEach(issue => issues.push(issue));

  // 5) Ziel, Sparrate, Zieljahr (10 %)
  const g = appData?.goal || {};
  let goalPts = 0;
  if (g.year && g.year >= 2025) goalPts += 3;
  if (g.amount && g.amount > 0) goalPts += 4;
  if (g.savingsRate != null && g.savingsRate > 0) goalPts += 3;
  score += goalPts;
  if (goalPts < 10) {
    const miss = [];
    if (!g.year) miss.push('Zieljahr');
    if (!g.amount) miss.push('Zielbetrag');
    if (!g.savingsRate) miss.push('Sparrate');
    if (miss.length > 0) issues.push({ severity: 'info', text: `Ziel-Eingaben unvollständig (${miss.join(', ')}).`, action: { kind: 'goal', label: 'Ziel bearbeiten' } });
  }

  // 6) Backup vorhanden / aktuell (10 %)
  let backupTs = 0;
  try { backupTs = parseInt(localStorage.getItem(BACKUP_TS_KEY) || localStorage.getItem(LEGACY_BACKUP_TS_KEY) || '0', 10); } catch (e) {}
  if (backupTs > 0) {
    const ageDays = (Date.now() - backupTs) / (1000 * 60 * 60 * 24);
    if (ageDays < 30) score += 10;
    else if (ageDays < 90) { score += 5; issues.push({ severity: 'warn', text: `Letztes Backup ist ${Math.floor(ageDays)} Tage alt — neues JSON-Backup empfohlen.`, action: { kind: 'backup', label: 'Backup erstellen' } }); }
    else { score += 2; issues.push({ severity: 'warn', text: `Backup älter als 3 Monate — bitte aktuelles JSON-Backup herunterladen.`, action: { kind: 'backup', label: 'Backup erstellen' } }); }
  } else {
    issues.push({ severity: 'warn', text: 'Noch kein lokales Backup heruntergeladen — JSON-Backup im Backup-Bereich nutzen.', action: { kind: 'backup', label: 'Backup erstellen' } });
  }

  // Edelmetall-Hinweis: Lagerart/Gebühren bei vorhandenen Lots
  if (appData?.goal?.metalLots) {
    let totalLots = 0, lotsWithStorage = 0;
    Object.values(appData.goal.metalLots).forEach(lots => {
      if (!Array.isArray(lots)) return;
      lots.forEach(l => { totalLots++; if (l.storage) lotsWithStorage++; });
    });
    if (totalLots > 0 && lotsWithStorage < totalLots) {
      issues.push({ severity: 'info', text: `Bei Edelmetall-Käufen fehlt teilweise Lagerart/Gebühren-Info.` });
      qualityTips.push('Für 100 Punkte Edelmetall-Käufe mit Lagerart und Gebühren vervollständigen.');
    }
  }

  const finalScore = Math.round(Math.min(100, score));
  if (issues.length === 0) {
    issues.push({
      severity: 'good',
      text: finalScore >= 100
        ? 'Alle wichtigen Daten sind vollständig gepflegt — Auswertungen sind sehr belastbar.'
        : 'Alle Pflichtdaten sind gepflegt — Auswertungen sind belastbar.'
    });
  }
  if (historicalPositions.length > 0) {
    issues.push({ severity: 'info', text: `${historicalPositions.length} vollständig verkaufte CSV-Titel bleiben nur für die Depot-Historie erhalten. Ihre optionalen Stammdaten zählen nicht zur aktuellen Datenqualität.` });
  }
  if (finalScore < 100 && qualityTips.length > 0) {
    qualityTips.slice(0, 3).forEach(tip => issues.push({ severity: 'info', text: typeof tip === 'string' ? tip : tip.text, action: typeof tip === 'string' ? null : tip.action }));
  } else if (finalScore < 100 && issues.every(i => i.severity === 'good')) {
    issues.push({ severity: 'info', text: `Für 100 Punkte fehlen noch ${100 - finalScore} Punkte in Detaildaten. Bitte Positionen, Kaufdaten, Cash-Bewegungen, Ziel und Backup prüfen.` });
  }

  return { score: finalScore, issues, parts: buildDataQualityScoreParts() };
}
let qualityRenderIssues = [];
function renderQualityBreakdown(parts) {
  return (parts || []).map(part => {
    const pct = part.max > 0 ? Math.round((part.earned / part.max) * 100) : 0;
    const state = pct >= 95 ? 'full' : pct > 0 ? 'partial' : 'empty';
    return `<div class="quality-breakdown-item ${state}" title="${escapeHtml(part.hint || '')}">
      <div class="top"><span>${escapeHtml(part.label)}</span><span class="pts">${Math.round(part.earned)}/${part.max}</span></div>
      <div class="mini-bar"><div class="mini-fill" style="width:${pct}%"></div></div>
      <div class="hint">${escapeHtml(part.hint || '')}</div>
    </div>`;
  }).join('');
}
function renderDataQuality(totals) {
  const valEl = document.getElementById('qualityScoreVal');
  const barEl = document.getElementById('qualityBarFill');
  const breakdownEl = document.getElementById('qualityBreakdown');
  const issuesEl = document.getElementById('qualityIssues');
  if (!valEl || !barEl || !issuesEl) return;
  const { score, issues, parts } = computeDataQuality(totals);
  const tier = score >= 80 ? 'high' : (score >= 55 ? 'mid' : 'low');
  valEl.innerHTML = `${score}<span class="denom">/100</span>`;
  valEl.className = 'quality-score ' + tier;
  barEl.style.width = score + '%';
  barEl.className = 'quality-bar-fill ' + tier;
  if (breakdownEl) breakdownEl.innerHTML = renderQualityBreakdown(parts);
  qualityRenderIssues = issues;
  issuesEl.innerHTML = issues.map((i, index) => {
    const icoMap = { warn: '⚠', info: 'ℹ', good: '✓', error: '✕' };
    const action = i.action ? `<button type="button" class="quality-action-btn" data-quality-action="${index}">${escapeHtml(i.action.label)}</button>` : '';
    return `<div class="quality-issue ${i.severity}"><span class="ico">${icoMap[i.severity] || '·'}</span><span class="quality-issue-body"><span>${escapeHtml(i.text)}</span>${action}</span></div>`;
  }).join('');
}
let qualityTaskAction = null;
function focusQualityEditField(pos, kind) {
  if (kind === 'meta') {
    const details = document.getElementById('editStammdatenDetails');
    if (details) details.open = true;
    const fieldIds = { isin: 'editIsin', wkn: 'editWkn', sektor: 'editSektor', custodian: 'editCustodian', custodyType: 'editCustodyType', land: 'editLand' };
    const missingField = qualityMetadataFields(pos).find(field => !String(metaValueForQuality(pos, field) || '').trim());
    const target = document.getElementById(fieldIds[missingField] || 'editIsin');
    if (target) setTimeout(() => target.focus(), 60);
    return;
  }
  const fieldId = kind === 'quote' ? 'editQuoteSymbol' : !(Number(pos.shares) > 0) ? 'editShares' : 'editCost';
  const target = document.getElementById(fieldId);
  if (target) setTimeout(() => target.focus(), 60);
}
function openQualityPositionInput(posId, kind) {
  const pos = appData?.positions?.find(p => p.id === posId);
  if (!pos) return;
  closeQualityActionModal();
  if (kind === 'buy') return openBuyMoreModal(posId);
  openEditModal(posId);
  focusQualityEditField(pos, kind);
}
function closeQualityActionModal() {
  const modal = document.getElementById('qualityActionModal');
  if (modal) modal.classList.remove('active');
  qualityTaskAction = null;
}
function openQualityPositionsModal(action) {
  const positions = (action.posIds || []).map(id => appData?.positions?.find(pos => pos.id === id)).filter(Boolean);
  if (positions.length === 1) return openQualityPositionInput(positions[0].id, action.kind);
  qualityTaskAction = action;
  document.getElementById('qualityActionTitle').textContent = action.title || 'Datenqualität verbessern';
  document.getElementById('qualityActionHint').textContent = action.hint || 'Wähle die Position, die du direkt bearbeiten möchtest.';
  document.getElementById('qualityActionList').innerHTML = positions.map(pos => `<div class="quality-task-row">
    <div><div class="name">${escapeHtml(qualityPositionName(pos))}</div><div class="meta">${escapeHtml(pos.type || '')}${pos.symbol ? ' · ' + escapeHtml(pos.symbol) : ''}</div></div>
    <button type="button" class="quality-action-btn" data-quality-pos="${escapeHtml(pos.id)}">${escapeHtml(action.label || 'Öffnen')}</button>
  </div>`).join('');
  document.getElementById('qualityActionModal').classList.add('active');
}
function scrollQualityTarget(target) {
  const el = document.getElementById(target) || document.querySelector(target);
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - 60;
  window.scrollTo({ top, behavior: 'smooth' });
  setTimeout(() => el.focus?.(), 350);
}
function runQualityAction(index) {
  const action = qualityRenderIssues[Number(index)]?.action;
  if (!action) return;
  if (action.posIds?.length) return openQualityPositionsModal(action);
  if (action.kind === 'backup') return backupJson();
  if (action.kind === 'cash') return openCashTxModal('deposit');
  if (action.kind === 'cash-list') return openCashTxList();
  if (action.kind === 'goal') return scrollQualityTarget('anchor-goal');
}

// ===== RISIKO-REGELN =====
function getRiskRules() {
  return (appData?.goal?.riskRules) || {
    maxSinglePosition: 25,  // % vom Depot
    maxCryptoTotal: 30,      // %
    minEtf: 25,              // %
    minCash: 5               // %
  };
}
function evaluateRiskRules(totals, alloc) {
  const rules = getRiskRules();
  const items = [];
  if (!totals || totals.totalCur <= 0 || !alloc) return items;
  // Größte Einzelposition
  let largest = null, largestPct = 0;
  getAllPositions().forEach(pos => {
    const live = currentPrices[pos.id] || { price: pos.manualPrice ?? pos.costPrice };
    const value = getPositionValuation(pos, live).currentValue;
    const pct = totals.totalCur > 0 ? (value / totals.totalCur) * 100 : 0;
    if (pct > largestPct) { largestPct = pct; largest = pos; }
  });
  items.push({
    label: `Max. Einzelposition (Ziel ≤ ${rules.maxSinglePosition} %)`,
    value: largest ? `${escapeHtml(largest.name)}: ${fmtNum(largestPct, 1)} %` : '—',
    violated: largestPct > rules.maxSinglePosition,
    rawPct: largestPct
  });
  items.push({
    label: `Krypto-Anteil (Ziel ≤ ${rules.maxCryptoTotal} %)`,
    value: `${fmtNum(alloc.pcts.crypto, 1)} %`,
    violated: alloc.pcts.crypto > rules.maxCryptoTotal,
    rawPct: alloc.pcts.crypto
  });
  items.push({
    label: `ETF-Anteil (Ziel ≥ ${rules.minEtf} %)`,
    value: `${fmtNum(alloc.pcts.etf, 1)} %`,
    violated: alloc.pcts.etf < rules.minEtf,
    rawPct: alloc.pcts.etf
  });
  items.push({
    label: `Cash-Anteil (Ziel ≥ ${rules.minCash} %)`,
    value: `${fmtNum(alloc.pcts.cash, 1)} %`,
    violated: alloc.pcts.cash < rules.minCash,
    rawPct: alloc.pcts.cash
  });
  return items;
}
