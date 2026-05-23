// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== Chatbot =====
let chatHistory = [];
let chatBusy = false;
let chatMemorySummary = '';
let memorySummaryBusy = false;

async function decryptChatMemoryBlob(raw) {
  if (!raw || !appPassword) return null;
  try {
    return await ENC.decrypt(JSON.parse(raw), appPassword);
  } catch (e) {
    console.warn('Encrypted memory decrypt failed:', e);
    return null;
  }
}

function hasRemoteMemoryPayload(data) {
  return !!(
    data?.memoryData ||
    data?.summaryData ||
    (Array.isArray(data?.memory) && data.memory.length > 0) ||
    (typeof data?.summary === 'string' && data.summary.trim().length > 0)
  );
}

async function loadChatMemory() {
  try {
    let res = await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ action: 'get-memory', userKey: kvKeyActive() })
    });
    if (!res.ok) throw new Error('Memory get HTTP ' + res.status);
    let data = await res.json();
    // Legacy-Fallback: wenn unter sicherem Key nichts da ist, alten Key probieren
    if (!hasRemoteMemoryPayload(data) && appUserKey && appUserKey !== USER_KEY) {
      const legacyRes = await fetch(AI_WORKER_URL, {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ action: 'get-memory', userKey: USER_KEY })
      });
      if (legacyRes.ok) data = await legacyRes.json();
    }
    const encryptedMemory = await decryptChatMemoryBlob(data.memoryData);
    const encryptedSummary = await decryptChatMemoryBlob(data.summaryData);

    if (Array.isArray(encryptedMemory)) {
      chatHistory = encryptedMemory;
    } else if (encryptedMemory?.messages && Array.isArray(encryptedMemory.messages)) {
      chatHistory = encryptedMemory.messages;
    } else if (Array.isArray(data.memory)) {
      chatHistory = data.memory;
    }

    if (typeof encryptedSummary === 'string') {
      chatMemorySummary = encryptedSummary;
    } else if (encryptedSummary?.summary && typeof encryptedSummary.summary === 'string') {
      chatMemorySummary = encryptedSummary.summary;
    } else if (typeof data.summary === 'string') {
      chatMemorySummary = data.summary;
    }
  } catch (e) {
    console.warn('Memory load failed:', e);
  }
}

async function saveChatMemory() {
  if (!appPassword) return;
  try {
    const blob = await ENC.encrypt(chatHistory.slice(-500), appPassword);
    await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ action: 'put-memory', userKey: kvKeyActive(), data: JSON.stringify(blob), encrypted: true })
    });
  } catch (e) {
    console.warn('Memory save failed:', e);
  }
}

async function saveChatMemorySummary() {
  if (!appPassword) return;
  try {
    const blob = await ENC.encrypt(chatMemorySummary, appPassword);
    await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ action: 'put-memory-summary', userKey: kvKeyActive(), data: JSON.stringify(blob), encrypted: true })
    });
  } catch (e) {
    console.warn('Memory summary save failed:', e);
  }
}

async function clearVisibleChatButKeepMemory() {
  if (chatHistory.length > 0) {
    await updateChatMemorySummary({
      reason: 'Der sichtbare Chatverlauf wurde geloescht. Bewahre die wichtigen Informationen daraus im Langzeitgedaechtnis.'
    });
  }
  chatHistory = [];
  await saveChatMemory();
}

function renderChatHistory() {
  document.getElementById('chatMessages').innerHTML = '';
  chatHistory.forEach(msg => chatAppendMessage(msg.role, msg.content));
}

async function updateChatMemorySummary(opts = {}) {
  if (memorySummaryBusy || chatHistory.length < 2) return;
  memorySummaryBusy = true;
  try {
    const recent = chatHistory.slice(-30).map(msg => `${msg.role}: ${msg.content}`).join('\n');
    const prompt = `Aktualisiere das Langzeitgedaechtnis fuer diesen Portfolio-Chat.

Bestehendes Langzeitgedaechtnis:
${chatMemorySummary || '(leer)'}

Neue Chat-Ausschnitte:
${recent}

Zusatzkontext:
${opts.reason || 'Normale Aktualisierung nach einer Chat-Antwort.'}

Erstelle eine kompakte, robuste Zusammenfassung auf Deutsch. Behalte Fakten, Zahlen, Ziele, Praeferenzen, Entscheidungen, offene Fragen und wiederkehrende Denkweisen des Nutzers. Loesche unwichtige Hoeflichkeit und Dopplungen. Maximal 900 Woerter. Schreibe nur die aktualisierte Zusammenfassung.`;

    const res = await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ prompt, maxTokens: 1200, temperature: 0.2, userKey: kvKeyActive() })
    });
    if (!res.ok) throw new Error('Memory summary HTTP ' + res.status);
    const data = await res.json();
    if (data.usage) recordUsage(data.usage);
    const summary = (data.text || '').trim();
    if (summary) {
      chatMemorySummary = summary;
      await saveChatMemorySummary();
    }
  } catch (e) {
    console.warn('Memory summary update failed:', e);
  } finally {
    memorySummaryBusy = false;
  }
}

function chatAppendMessage(role, content, opts = {}) {
  const container = document.getElementById('chatMessages');
  const wrap = document.createElement('div');
  wrap.className = 'chat-msg chat-msg-' + (role === 'user' ? 'user' : 'ai');
  if (opts.typing) {
    wrap.innerHTML = `<div class="chat-typing" aria-label="Antwort wird erstellt"><span class="chat-typing-dot"></span><span class="chat-typing-dot"></span><span class="chat-typing-dot"></span></div>`;
    wrap.dataset.typing = '1';
  } else {
    const html = markdownLite(content);
    const time = new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
    wrap.innerHTML = `<div class="chat-bubble">${html}</div><div class="chat-msg-time">${role === 'user' ? 'Du' : 'Haiku'} · ${time}</div>`;
  }
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
  return wrap;
}

function chatRemoveTyping() {
  const t = document.querySelector('#chatMessages [data-typing]');
  if (t) t.remove();
}

function buildChatSystemPrompt() {
  if (!appData) return 'Du bist ein intelligenter, hilfreicher KI-Chat fuer komplexe Fragen. Antworte auf Deutsch, klar, tiefgehend und praktisch. Nutze vorhandenes Gedaechtnis, wenn es relevant ist.';
  let totalCur = 0, totalCost = 0;
  getAllPositions().forEach(pos => {
    const live = currentPrices[pos.id] || { price: pos.manualPrice ?? pos.costPrice };
    const valuation = getPositionValuation(pos, live);
    totalCur += valuation.currentValue;
    totalCost += valuation.costValue;
  });
  const totalPnl = totalCur - totalCost;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
  const positions = getAllPositions().map(pos => {
    const live = currentPrices[pos.id] || { price: pos.costPrice };
    const valuation = getPositionValuation(pos, live);
    const value = valuation.currentValue;
    const pct = totalCur > 0 ? (value / totalCur) * 100 : 0;
    const pnlPct = valuation.pnlPct;
    return `- ${pos.name} (${pos.type}, ${pos.symbol || ''}): ${valuation.shares} Stk × ${fmtNum(live.price, priceDecimalsForPosition(pos, live.price))} € = ${value.toFixed(2)} € (${pct.toFixed(1)}% Allokation, P&L ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`;
  }).join('\n');
  const goal = appData.goal || { year: 2026, month: 12, amount: 15000, bufferPct: 0, minSavingsRate: 0, maxSavingsRate: 0, annualReturnPct: 0, type: 'wealth', priority: 'medium' };
  const strategy = getGoalStrategy(goal);
  // Faktenblatt + abgeleitete Goal-Daten für Tiefe
  const today = new Date();
  const endDate = endOfGoalMonth(goal.year, goal.month || 12);
  const monthsToGoal = Math.max(1, Math.round((endDate - today) / (1000 * 60 * 60 * 24 * 30.44)));
  const planAmount = goalPlanAmount(goal.amount, goal.bufferPct || 0);
  const goalEnriched = { ...goal, ...strategy, planAmount, typeLabel: GOAL_TYPE_LABELS[goal.type] || 'Vermögen', priorityLabel: GOAL_PRIORITY_LABELS[goal.priority] || 'Mittel', monthsToGoal, gap: planAmount - totalCur, monthlyNeeded: (planAmount - totalCur) / monthsToGoal, requiredReturnPct: totalCur > 0 ? ((planAmount / totalCur) - 1) * 100 : 0, projectedWithReturn: futureValueWithMonthlySavings(totalCur, goal.savingsRate || 0, monthsToGoal, goal.annualReturnPct || 0) };
  const factSheet = buildFactSheet({ totalCur, totalCost, totalPnl, totalPnlPct }, goalEnriched);
  return `Du bist ein intelligenter KI-Chat fuer dieses Portfolio und fuer komplexe Fragen des Nutzers. Sprache: Deutsch.

${factSheet}

Arbeitsweise:
- Antworte nicht kuenstlich knapp. Wenn die Frage komplex ist, gib eine strukturierte, gruendlich durchdachte Antwort.
- Nutze Zahlen, Annahmen, Szenarien und konkrete Optionen, wenn sie helfen.
- Du darfst ueber Portfolio, Strategie, Risiko, Planung, Psychologie, Organisation und allgemeine Fragen sprechen.
- Sei direkt und ehrlich, aber nicht abweisend. Wenn etwas unklar ist, nenne deine Annahmen und arbeite damit.
- Wenn der Nutzer nach frueheren Aussagen fragt, pruefe zuerst das Langzeitgedaechtnis und den Chatverlauf. Sage nicht vorschnell, dass du keinen Zugriff hast.
- Bei Anlageentscheidungen gib keine verbindliche Finanzberatung, sondern Optionen, Risiken und Rechenwege.

LANGZEITGEDAECHTNIS:
${chatMemorySummary || '(Noch keine dauerhafte Zusammenfassung vorhanden.)'}

AKTUELLES PORTFOLIO:
${positions}

Gesamtwert: ${totalCur.toFixed(2)} €
Einstand: ${totalCost.toFixed(2)} €
P&L: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} € (${totalPnlPct.toFixed(1)}%)

ZIEL des Nutzers: ${goal.amount} € bis ${monthNameAT(goal.month || 12)} ${goal.year}; Planbetrag inkl. Puffer: ${planAmount.toFixed(2)} €
SPARRATE des Nutzers: ${goal.savingsRate || 0} €/Monat (regelmäßige Einzahlung)
SPARRATEN-KORRIDOR: ${goal.minSavingsRate || 0}–${goal.maxSavingsRate || 0} €/Monat; Rendite-Szenario: ${fmtNum(goal.annualReturnPct || 0, 1)}% p.a.; Zielart/Priorität: ${GOAL_TYPE_LABELS[goal.type] || 'Vermögen'} / ${GOAL_PRIORITY_LABELS[goal.priority] || 'Mittel'}
STRATEGIE des Nutzers: ${fmtNum(strategy.savingsPct, 0)}% Sparrate / ${fmtNum(strategy.returnPct, 0)}% Rendite (${strategy.pathLabel}); Risiko ${strategy.riskLabel} (${fmtNum(strategy.riskPct, 0)}%).
Diese Strategie ist wichtig: Antworten sollen dazu passen, ob der Nutzer sein Ziel eher über Sparrate oder Rendite erreichen will.

Beantworte die aktuelle Frage mit Bezug auf Portfolio, Langzeitgedaechtnis und Chatverlauf. Erinnere am Ende NICHT bei jeder Antwort an Disclaimer - nur wenn die Frage konkrete Anlageempfehlungen verlangt.`;
}

async function chatSend() {
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('chatSendBtn');
  const text = input.value.trim();
  if (!text || chatBusy) return;
  chatBusy = true;
  sendBtn.disabled = true;
  input.value = '';
  chatHistory.push({ role: 'user', content: text });
  chatAppendMessage('user', text);
  chatAppendMessage('ai', '', { typing: true });
  try {
    const system = buildChatSystemPrompt();
    const messages = chatHistory.slice(-500);
    const res = await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ messages, system, maxTokens: 4000, userKey: kvKeyActive() })
    });
    chatRemoveTyping();
    if (!res.ok) throw new Error('Worker HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.usage) recordUsage(data.usage);
    const reply = (data.text || '(leere Antwort)').trim();
    chatHistory.push({ role: 'assistant', content: reply });
    chatAppendMessage('ai', reply);
    await saveChatMemory();
    renderChatMemoryStatus();
    setTimeout(() => updateChatMemorySummary(), 0);
  } catch (e) {
    chatRemoveTyping();
    const errWrap = document.createElement('div');
    errWrap.className = 'chat-msg chat-msg-ai';
    errWrap.innerHTML = `<div class="chat-error">Fehler: ${escapeHtml(e.message)}. Bitte nochmal versuchen.</div>`;
    document.getElementById('chatMessages').appendChild(errWrap);
    chatHistory.pop();
  } finally {
    chatBusy = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

async function chatClear() {
  if (chatHistory.length > 0 && !confirm('Sichtbaren Chat leeren? Das Gedächtnis bleibt erhalten.')) return;
  // Letzten Stand noch ins Gedächtnis übernehmen, dann sichtbaren Verlauf leeren
  await clearVisibleChatButKeepMemory();
  document.getElementById('chatMessages').innerHTML = '';
  chatShowWelcome();
  renderChatMemoryStatus();
}

async function chatWipeMemory() {
  if (!confirm('Möchtest du das Langzeit-Gedächtnis WIRKLICH unwiderruflich löschen?')) return;
  if (!confirm('Wirklich sicher? Alle gespeicherten Fakten, Ziele und Präferenzen aus früheren Chats gehen verloren.')) return;
  chatMemorySummary = '';
  chatHistory = [];
  await saveChatMemorySummary();
  await saveChatMemory();
  document.getElementById('chatMessages').innerHTML = '';
  chatShowWelcome();
  renderChatMemoryStatus();
  alert('Gedächtnis gelöscht.');
}

function renderChatMemoryStatus() {
  const el = document.getElementById('chatMemoryStatus');
  if (!el) return;
  const msgCount = chatHistory.length;
  const hasSummary = (chatMemorySummary || '').trim().length > 0;
  el.textContent = `Gedächtnis aktiv · ${msgCount} Nachricht${msgCount === 1 ? '' : 'en'} · ${hasSummary ? 'Zusammenfassung gespeichert' : 'keine Zusammenfassung'}`;
}

// ===== PORTFOLIO ZURÜCKSETZEN (Gefahrenzone) =====
let resetCountdownTimer = null;
function openResetModal() {
  document.getElementById('resetMasterCode').value = '';
  const errEl = document.getElementById('resetError');
  errEl.classList.remove('visible'); errEl.textContent = '';
  const confirmBtn = document.getElementById('resetConfirm');
  confirmBtn.disabled = true;
  // 10-Sekunden-Countdown starten
  let remaining = 10;
  const numEl = document.getElementById('resetCountdownNum');
  const cdEl = document.getElementById('resetCountdown');
  numEl.textContent = remaining;
  cdEl.style.display = '';
  if (resetCountdownTimer) clearInterval(resetCountdownTimer);
  resetCountdownTimer = setInterval(() => {
    remaining--;
    numEl.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(resetCountdownTimer);
      resetCountdownTimer = null;
      cdEl.style.display = 'none';
      confirmBtn.disabled = false;
    }
  }, 1000);
  document.getElementById('resetModal').classList.add('active');
}
function closeResetModal() {
  if (resetCountdownTimer) { clearInterval(resetCountdownTimer); resetCountdownTimer = null; }
  document.getElementById('resetModal').classList.remove('active');
}
async function confirmResetPortfolio() {
  const errEl = document.getElementById('resetError');
  const code = document.getElementById('resetMasterCode').value;
  errEl.classList.remove('visible');
  if (!code) { errEl.textContent = 'Bitte Master-Code eingeben.'; errEl.classList.add('visible'); return; }
  if (code !== appPassword) { errEl.textContent = 'Falscher Master-Code — Zurücksetzen abgebrochen.'; errEl.classList.add('visible'); return; }
  const btn = document.getElementById('resetConfirm');
  btn.disabled = true; btn.textContent = 'Lösche …';
  try {
    // 1) Alle Portfolio-Daten auf Null setzen
    appData.positions = [];
    appData.transactions = [];
    appData.watchlist = [];
    appData.journal = [];
    appData.income = [];
    appData.metalHistory = null;
    appData.layout = null;
    appData.goal = {
      year: new Date().getFullYear() + 1,
      month: 12,
      amount: 15000,
      savingsRate: 0,
      minSavingsRate: 0,
      maxSavingsRate: 1000,
      bufferPct: 10,
      annualReturnPct: 4,
      type: 'wealth',
      priority: 'medium',
      cash: 0,
      goldGrams: 0, silverGrams: 0, platinumGrams: 0, palladiumGrams: 0,
      metalLots: {},
      ath: 0, athDate: null,
      targetAllocation: null,
      riskRules: null
    };
    appData.schemaVersion = 2;
    // Laufende Kurse/Caches leeren
    currentPrices = {}; weeklyData = {}; quoteIssues = {};
    // 2) KI-Gedächtnis lokal + serverseitig löschen
    chatHistory = [];
    chatMemorySummary = '';
    try {
      await fetch(AI_WORKER_URL, {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ action: 'clear-memory', userKey: kvKeyActive() })
      });
      // Legacy-Key ebenfalls leeren (falls noch alte Daten existieren)
      if (appUserKey && appUserKey !== USER_KEY) {
        await fetch(AI_WORKER_URL, {
          method: 'POST',
          headers: apiHeaders(),
          body: JSON.stringify({ action: 'clear-memory', userKey: USER_KEY })
        });
      }
    } catch (e) { console.warn('clear-memory fehlgeschlagen:', e); }
    // 3) Geleerten Stand verschlüsselt in KV speichern (überschreibt die alten Daten)
    await savePositionsToKV();
    // 4) UI zurücksetzen
    document.getElementById('chatMessages').innerHTML = '';
    closeResetModal();
    await initApp();
    alert('Portfolio wurde vollständig zurückgesetzt.');
  } catch (e) {
    errEl.textContent = 'Fehler beim Zurücksetzen: ' + (e.message || e);
    errEl.classList.add('visible');
  } finally {
    btn.textContent = 'Endgültig löschen';
  }
}

function chatShowWelcome() {
  const c = document.getElementById('chatMessages');
  if (c && c.children.length === 0) {
    chatAppendMessage('ai', 'Hi! Ich kenne dein Portfolio. Frag mich zu Allokation, Risiken, Sparplänen oder Marktbewegungen.');
  }
}

// ===== KV-SYNC (Cloudflare KV via Worker) =====
async function kvGetPositions(userKey) {
  const res = await fetch(AI_WORKER_URL, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ action: 'get-positions', userKey })
  });
  if (!res.ok) throw new Error('KV get HTTP ' + res.status);
  const result = await res.json();
  return result.data || null;
}
async function loadPositionsFromKV() {
  if (!appPassword) return null;
  try {
    // 1) Versuch mit abgeleitetem (sicherem) Key
    let raw = await kvGetPositions(kvKeyActive());
    // 2) Fallback: Legacy-Key ('michael'/'bruder') — alte Daten migrieren
    if (!raw && appUserKey && appUserKey !== USER_KEY) {
      raw = await kvGetPositions(USER_KEY);
      if (raw) kvLegacyMigrationDone = false; // markiert: nach Decrypt sofort auf neuen Key speichern
    }
    if (!raw) return null;
    const blob = JSON.parse(raw);
    const decrypted = await ENC.decrypt(blob, appPassword);
    return decrypted;
  } catch (e) { console.warn('KV load failed:', e); return null; }
}

let kvSaveTimer = null;
async function savePositionsToKV(debounceMs = 0) {
  if (!appPassword || !appData) return false;
  if (debounceMs > 0) {
    if (kvSaveTimer) clearTimeout(kvSaveTimer);
    kvSaveTimer = setTimeout(() => savePositionsToKV(0), debounceMs);
    return true;
  }
  try {
    const dataToStore = {
      positions: appData.positions,
      goal: appData.goal,
      transactions: appData.transactions || [],
      metalHistory: appData.metalHistory || null,
      watchlist: appData.watchlist || [],
      journal: appData.journal || [],
      income: appData.income || [],
      layout: appData.layout || null,
      schemaVersion: appData.schemaVersion || 1,
      version: 2 // Blob-Versionsmarker (kompatibel mit alten Decoder-Versionen)
    };
    const blob = await ENC.encrypt(dataToStore, appPassword);
    const res = await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ action: 'put-positions', data: JSON.stringify(blob), userKey: kvKeyActive() })
    });
    kvLegacyMigrationDone = true; // Daten liegen jetzt unter dem sicheren Key
    return res.ok;
  } catch (e) { console.warn('KV save failed:', e); return false; }
}

// ===== USAGE-TRACKING (lokaler Zähler) =====
const USAGE_KEY = STORAGE_PREFIX + 'usage_v1';
const USAGE_BUDGET = 5.00;
const HAIKU_INPUT_COST = 0.80 / 1000000;
const HAIKU_OUTPUT_COST = 4.00 / 1000000;

function loadUsageState() {
  try { const raw = localStorage.getItem(USAGE_KEY); if (raw) return JSON.parse(raw); } catch (e) {}
  return { totalCalls: 0, totalCost: 0, callsToday: 0, callsThisWeek: 0, lastDay: '', lastWeek: '' };
}
function saveUsageState(state) { try { localStorage.setItem(USAGE_KEY, JSON.stringify(state)); } catch (e) {} }
function getWeekKey(date) {
  const d = new Date(date); d.setHours(0,0,0,0); d.setDate(d.getDate()+3-(d.getDay()+6)%7);
  const yStart = new Date(d.getFullYear(), 0, 1);
  return d.getFullYear() + '-W' + String(Math.ceil(((d-yStart)/86400000+1)/7)).padStart(2,'0');
}
function recordUsage(usage) {
  let cost = 0.002;
  if (usage && usage.input_tokens != null && usage.output_tokens != null) {
    cost = usage.input_tokens * HAIKU_INPUT_COST + usage.output_tokens * HAIKU_OUTPUT_COST;
  }
  const state = loadUsageState();
  const today = new Date().toISOString().slice(0,10);
  if (state.lastDay !== today) { state.callsToday = 0; state.lastDay = today; }
  const week = getWeekKey(new Date());
  if (state.lastWeek !== week) { state.callsThisWeek = 0; state.lastWeek = week; }
  state.callsToday++; state.callsThisWeek++; state.totalCalls++; state.totalCost += cost;
  saveUsageState(state);
  renderUsage();
}
function formatTimeUntil(targetDate) {
  const now = new Date();
  const diffMs = targetDate - now;
  if (diffMs <= 0) return 'jetzt';
  const totalMin = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `in ${days}T ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}min`;
  return `in ${mins}min`;
}
function getNextMidnight() { const d = new Date(); d.setHours(24, 0, 0, 0); return d; }
function getNextMonday() { const d = new Date(); d.setHours(0, 0, 0, 0); const day = d.getDay(); const daysUntilMonday = day === 0 ? 1 : (8 - day); d.setDate(d.getDate() + daysUntilMonday); return d; }

function renderUsage() {
  const state = loadUsageState();
  const spent = state.totalCost;
  const remaining = Math.max(0, USAGE_BUDGET - spent);
  const pct = Math.min(100, (spent / USAGE_BUDGET) * 100);
  const avg = state.totalCalls > 0 ? (state.totalCost / state.totalCalls) : 0;
  const elS = document.getElementById('usageSpent'); if (elS) elS.textContent = `~${spent.toFixed(2)} € verbraucht`;
  const elP = document.getElementById('usagePct'); if (elP) elP.textContent = `${(100 - pct).toFixed(1)} % verfügbar`;
  const elB = document.getElementById('usageBarFill'); if (elB) elB.style.width = pct + '%';
  const elR = document.getElementById('usageRemaining');
  if (elR) {
    elR.textContent = `${remaining.toFixed(2)} € von ${USAGE_BUDGET.toFixed(2)} €`;
    elR.classList.toggle('low', remaining < USAGE_BUDGET * 0.2);
  }
  const elT = document.getElementById('usageToday'); if (elT) elT.textContent = state.callsToday;
  const elW = document.getElementById('usageWeek'); if (elW) elW.textContent = state.callsThisWeek;
  const elA = document.getElementById('usageAvg'); if (elA) elA.textContent = avg > 0 ? avg.toFixed(4) : '—';
  const elTR = document.getElementById('usageTodayReset');
  if (elTR) { const span = elTR.querySelector('span'); if (span) span.textContent = `Reset ${formatTimeUntil(getNextMidnight())}`; }
  const elWR = document.getElementById('usageWeekReset');
  if (elWR) { const span = elWR.querySelector('span'); if (span) span.textContent = `Reset ${formatTimeUntil(getNextMonday())}`; }
}
