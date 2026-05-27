// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== DEPOT-NEWS =====
const NEWS_POSITION_LIMIT = 12;
const NEWS_REFRESH_DURATION_KEY = STORAGE_PREFIX + 'news_refresh_avg_duration_ms';
const NEWS_SUMMARY_DURATION_KEY = STORAGE_PREFIX + 'news_summary_avg_duration_ms';
const NEWS_REFRESH_DEFAULT_DURATION = 12000;
const NEWS_SUMMARY_DEFAULT_DURATION = 16000;
let portfolioNewsState = {
  items: [],
  loading: false,
  error: '',
  filter: 'all',
  updatedAt: '',
  checkedAt: '',
  nextRefreshAt: '',
  addedCount: 0,
  warnings: [],
  lastFetchAt: 0,
  summarizing: {},
  reportOpen: {},
};
let newsRefreshProgressTimer = null;
let newsRefreshProgressStart = 0;
let newsRefreshProgressDuration = NEWS_REFRESH_DEFAULT_DURATION;
let newsSummaryProgressTimers = {};

function newsClamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function defaultNewsSettings() {
  return {
    aiSummaries: true,
    perPositionLimit: 8,
    retentionDays: 14,
    refreshMinutes: 60,
  };
}

function getNewsSettings() {
  const defaults = defaultNewsSettings();
  const raw = appData?.newsSettings || {};
  return {
    aiSummaries: raw.aiSummaries !== false,
    perPositionLimit: newsClamp(raw.perPositionLimit, 1, 8, defaults.perPositionLimit),
    retentionDays: newsClamp(raw.retentionDays, 1, 14, defaults.retentionDays),
    refreshMinutes: newsClamp(raw.refreshMinutes, 30, 360, defaults.refreshMinutes),
  };
}

function renderNewsSettingsPanel() {
  const settings = getNewsSettings();
  const ai = document.getElementById('newsAiEnabled');
  const per = document.getElementById('newsPerPositionLimit');
  const perNumber = document.getElementById('newsPerPositionNumber');
  const retention = document.getElementById('newsRetentionDays');
  const retentionNumber = document.getElementById('newsRetentionNumber');
  const refresh = document.getElementById('newsRefreshMinutes');
  const refreshNumber = document.getElementById('newsRefreshNumber');
  if (ai) ai.checked = settings.aiSummaries;
  if (per) per.value = String(settings.perPositionLimit);
  if (perNumber) perNumber.value = String(settings.perPositionLimit);
  if (retention) retention.value = String(settings.retentionDays);
  if (retentionNumber) retentionNumber.value = String(settings.retentionDays);
  if (refresh) refresh.value = String(settings.refreshMinutes);
  if (refreshNumber) refreshNumber.value = String(settings.refreshMinutes);
}

function bindNewsRangePair(rangeId, numberId, min, max) {
  const range = document.getElementById(rangeId);
  const number = document.getElementById(numberId);
  if (!range || !number || range.dataset.bound === '1') return;
  range.dataset.bound = '1';
  const syncFromRange = () => { number.value = String(newsClamp(range.value, min, max, min)); };
  const syncFromNumber = () => {
    const value = newsClamp(number.value, min, max, min);
    number.value = String(value);
    range.value = String(value);
  };
  range.addEventListener('input', syncFromRange);
  number.addEventListener('input', syncFromNumber);
  number.addEventListener('blur', syncFromNumber);
}

function bindNewsSettingsInputs() {
  bindNewsRangePair('newsPerPositionLimit', 'newsPerPositionNumber', 1, 8);
  bindNewsRangePair('newsRetentionDays', 'newsRetentionNumber', 1, 14);
  bindNewsRangePair('newsRefreshMinutes', 'newsRefreshNumber', 30, 360);
}

async function saveNewsSettingsFromUI() {
  if (!appData) return;
  const settings = {
    aiSummaries: document.getElementById('newsAiEnabled')?.checked !== false,
    perPositionLimit: newsClamp(document.getElementById('newsPerPositionNumber')?.value || document.getElementById('newsPerPositionLimit')?.value, 1, 8, 8),
    retentionDays: newsClamp(document.getElementById('newsRetentionNumber')?.value || document.getElementById('newsRetentionDays')?.value, 1, 14, 14),
    refreshMinutes: newsClamp(document.getElementById('newsRefreshNumber')?.value || document.getElementById('newsRefreshMinutes')?.value, 30, 360, 60),
  };
  appData.newsSettings = settings;
  await savePositionsToKV(0);
  renderPortfolioNews();
  fetchPortfolioNews({ forceRefresh: true });
}

function newsEscapeAttr(value) {
  return escapeHtml(value == null ? '' : value).replace(/"/g, '&quot;');
}

function newsPositionName(pos) {
  return String(pos?.name || pos?.symbol || 'Position').trim();
}

function newsPositionsPayload() {
  if (!appData) return [];
  return currentPortfolioPositions()
    .filter(pos => pos && !pos.special)
    .slice()
    .sort((a, b) => getPositionValuation(b).currentValue - getPositionValuation(a).currentValue)
    .slice(0, NEWS_POSITION_LIMIT)
    .map(pos => ({
      id: pos.id,
      name: newsPositionName(pos),
      symbol: pos.symbol || '',
      isin: pos.isin || '',
      wkn: pos.wkn || '',
      type: pos.type || '',
      sector: pos.sector || '',
      isCrypto: String(pos.type || '').toLowerCase().includes('crypto') || !!pos.cgId,
    }));
}

function newsTimeAgo(iso) {
  if (!iso) return 'Zeit unbekannt';
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return 'Zeit unbekannt';
  const diff = Date.now() - ts;
  const minutes = Math.max(0, Math.round(diff / 60000));
  if (minutes < 2) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.round(hours / 24);
  return `vor ${days} Tg.`;
}

function newsTimeUntil(iso) {
  if (!iso) return '';
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '';
  const diff = Math.max(0, ts - Date.now());
  const minutes = Math.ceil(diff / 60000);
  if (minutes < 2) return 'in ca. 1 min';
  if (minutes < 60) return `in ca. ${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `in ca. ${hours} Std.`;
  return `in ca. ${Math.ceil(hours / 24)} Tg.`;
}

function newsDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString('de-AT', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function newsEstimate(key, fallback) {
  try {
    const value = Number(localStorage.getItem(key));
    if (value >= 3000 && value <= 120000) return value;
  } catch (e) {}
  return fallback;
}

function saveNewsEstimate(key, fallback, measuredMs) {
  try {
    const clean = Math.max(3000, Math.min(120000, Number(measuredMs) || fallback));
    const prev = newsEstimate(key, fallback);
    localStorage.setItem(key, String(Math.round(prev * 0.65 + clean * 0.35)));
  } catch (e) {}
}

function startNewsRefreshTimer() {
  const el = document.getElementById('newsRefreshTimer');
  if (!el) return;
  if (newsRefreshProgressTimer) clearInterval(newsRefreshProgressTimer);
  newsRefreshProgressStart = Date.now();
  newsRefreshProgressDuration = newsEstimate(NEWS_REFRESH_DURATION_KEY, NEWS_REFRESH_DEFAULT_DURATION);
  el.classList.add('active');
  const update = () => {
    const elapsed = Date.now() - newsRefreshProgressStart;
    const remain = Math.max(0, Math.ceil((newsRefreshProgressDuration - elapsed) / 1000));
    const pct = Math.min(92, Math.max(8, Math.round((elapsed / newsRefreshProgressDuration) * 92)));
    el.style.setProperty('--news-refresh-pct', `${pct}%`);
    el.textContent = remain > 0 ? `Noch ca. ${remain} Sek` : 'Fast fertig…';
  };
  update();
  newsRefreshProgressTimer = setInterval(update, 180);
}

function completeNewsRefreshTimer(success) {
  const el = document.getElementById('newsRefreshTimer');
  if (!el) return;
  if (newsRefreshProgressTimer) clearInterval(newsRefreshProgressTimer);
  newsRefreshProgressTimer = null;
  const measured = Date.now() - newsRefreshProgressStart;
  if (success) saveNewsEstimate(NEWS_REFRESH_DURATION_KEY, NEWS_REFRESH_DEFAULT_DURATION, measured);
  el.style.setProperty('--news-refresh-pct', '100%');
  el.textContent = success ? `Fertig in ${(measured / 1000).toFixed(1)} Sek` : 'News nicht vollständig geladen';
  setTimeout(() => {
    el.classList.remove('active');
    el.textContent = '';
    el.style.setProperty('--news-refresh-pct', '8%');
  }, success ? 1600 : 2800);
}

function startNewsSummaryTimer(newsId) {
  if (newsSummaryProgressTimers[newsId]) clearInterval(newsSummaryProgressTimers[newsId]);
  const start = Date.now();
  const duration = newsEstimate(NEWS_SUMMARY_DURATION_KEY, NEWS_SUMMARY_DEFAULT_DURATION);
  portfolioNewsState.summarizing[newsId] = { start, duration, remaining: Math.ceil(duration / 1000) };
  const tick = () => {
    const elapsed = Date.now() - start;
    const remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));
    portfolioNewsState.summarizing[newsId] = { start, duration, remaining };
    const btn = document.querySelector(`[data-news-summary="${CSS.escape(newsId)}"]`);
    if (btn) btn.textContent = remaining > 0 ? `Noch ca. ${remaining} Sek` : 'Fast fertig…';
  };
  tick();
  newsSummaryProgressTimers[newsId] = setInterval(tick, 250);
}

function completeNewsSummaryTimer(newsId, success) {
  const state = portfolioNewsState.summarizing[newsId];
  if (newsSummaryProgressTimers[newsId]) clearInterval(newsSummaryProgressTimers[newsId]);
  delete newsSummaryProgressTimers[newsId];
  if (state?.start && success) saveNewsEstimate(NEWS_SUMMARY_DURATION_KEY, NEWS_SUMMARY_DEFAULT_DURATION, Date.now() - state.start);
  delete portfolioNewsState.summarizing[newsId];
}

function setNewsFilter(filter) {
  portfolioNewsState.filter = filter || 'all';
  document.querySelectorAll('[data-news-filter]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.newsFilter === portfolioNewsState.filter);
  });
  renderPortfolioNews();
}

function filteredPortfolioNews() {
  const filter = portfolioNewsState.filter || 'all';
  return (portfolioNewsState.items || []).filter(item => {
    if (filter === 'all') return true;
    if (filter === 'important') return item.impact === 'hoch' || item.impact === 'mittel';
    if (filter === 'crypto') return (item.positions || []).some(pos => pos.isCrypto);
    if (filter === 'securities') return !(item.positions || []).every(pos => pos.isCrypto);
    return true;
  });
}

function renderPortfolioNews() {
  const list = document.getElementById('newsList');
  const status = document.getElementById('newsStatus');
  const count = document.getElementById('newsCount');
  const btn = document.getElementById('newsRefreshBtn');
  if (!list || !status || !count) return;

  const positions = newsPositionsPayload();
  const items = filteredPortfolioNews();
  const settings = getNewsSettings();
  bindNewsSettingsInputs();
  renderNewsSettingsPanel();
  count.textContent = String((portfolioNewsState.items || []).length);
  if (btn) {
    btn.disabled = portfolioNewsState.loading;
    btn.classList.toggle('loading', portfolioNewsState.loading);
  }

  if (!positions.length) {
    status.textContent = 'Keine aktuellen Depotpositionen vorhanden.';
    list.innerHTML = '<div class="news-empty">Sobald Positionen im Depot liegen, erscheinen hier passende Meldungen.</div>';
    return;
  }

  if (portfolioNewsState.loading) {
    status.textContent = 'Depot-News werden geladen und auf Deutsch verdichtet…';
  } else if (portfolioNewsState.error) {
    status.textContent = portfolioNewsState.error;
  } else if (portfolioNewsState.updatedAt) {
    const added = Number(portfolioNewsState.addedCount || 0);
    const next = portfolioNewsState.nextRefreshAt ? ` · nächste automatische Suche ${newsTimeUntil(portfolioNewsState.nextRefreshAt)}` : '';
    const warningText = portfolioNewsState.warnings?.length ? ` · Hinweise: ${portfolioNewsState.warnings.slice(0, 2).join(' · ')}` : '';
    status.textContent = `Aktualisiert ${newsTimeAgo(portfolioNewsState.updatedAt)} · ${added > 0 ? `${added} neue Meldung${added === 1 ? '' : 'en'} ergänzt` : 'keine neuen Meldungen'} · Historie: max. ${settings.perPositionLimit} News je Titel, ${settings.retentionDays} Tage · KI ${settings.aiSummaries ? 'an' : 'aus'}${next}${warningText}`;
  } else {
    status.textContent = 'Noch keine News geladen.';
  }

  if (portfolioNewsState.loading && !items.length) {
    list.innerHTML = '<div class="news-empty">Meldungen werden gesucht, gefiltert und vorbereitet…</div>';
    return;
  }

  if (!items.length) {
    list.innerHTML = '<div class="news-empty">Für den aktuellen Filter wurden keine passenden Meldungen gefunden.</div>';
    return;
  }

  list.innerHTML = items.map(item => {
    const positionsHtml = (item.positions || []).slice(0, 4).map(pos =>
      `<span class="news-tag">${escapeHtml(pos.name || pos.symbol || 'Position')}</span>`
    ).join('');
    const source = item.source ? escapeHtml(item.source) : 'Quelle';
    const impact = item.impact && item.impact !== 'normal'
      ? `<span class="news-impact">${escapeHtml(item.impact)}</span><span>·</span>`
      : '';
    const image = item.imageUrl
      ? `<img class="news-image" src="${newsEscapeAttr(item.imageUrl)}" alt="">`
      : '';
    const report = item.aiReport?.text || item.aiSummary || '';
    const reportOpen = !!portfolioNewsState.reportOpen[item.id];
    const busy = portfolioNewsState.summarizing[item.id];
    const summaryButtonText = busy
      ? `Noch ca. ${Math.max(0, Number(busy.remaining || 0))} Sek`
      : report ? 'Bericht anzeigen' : 'KI Zusammengefasst';
    const summaryButtonClass = [
      'news-ai-btn',
      report ? 'ready' : '',
      busy ? 'busy' : '',
    ].filter(Boolean).join(' ');
    const summaryButton = (settings.aiSummaries || report)
      ? `<button class="${summaryButtonClass}" data-news-summary="${newsEscapeAttr(item.id)}" type="button" ${busy ? 'disabled' : ''}>${escapeHtml(summaryButtonText)}</button>`
      : '';
    const reportHtml = report
      ? `<div class="news-ai-report ${reportOpen ? 'open' : ''}" id="news-report-${newsEscapeAttr(item.id)}"><div class="title">KI-Zusammenfassung</div>${escapeHtml(report)}<div class="meta">Erstellt ${escapeHtml(newsTimeAgo(item.aiReport?.createdAt || item.aiSummaryAt))}</div></div>`
      : '';
    return `<article class="news-card ${item.imageUrl ? 'has-image' : ''}">
      ${image}
      <div class="news-main">
        <div class="news-meta">${impact}<span>${source}</span><span>·</span><span>${escapeHtml(newsDateTime(item.publishedAt) || newsTimeAgo(item.publishedAt))}</span></div>
        <div class="news-title">${escapeHtml(item.title || 'Meldung')}</div>
        <div class="news-summary">${escapeHtml(item.summary || 'Keine Zusammenfassung verfügbar.')}</div>
        <div class="news-footer">
          <div class="news-tags">${positionsHtml}</div>
          <div class="news-actions">
            ${summaryButton}
            <a class="news-source-link" href="${newsEscapeAttr(item.url || '#')}" target="_blank" rel="noopener noreferrer">Quelle öffnen</a>
          </div>
        </div>
        ${reportHtml}
      </div>
    </article>`;
  }).join('');
}

async function fetchPortfolioNews(opts = {}) {
  if (!appData || portfolioNewsState.loading) return;
  const positions = newsPositionsPayload();
  const settings = getNewsSettings();
  if (!positions.length) {
    portfolioNewsState.items = [];
    renderPortfolioNews();
    return;
  }
  portfolioNewsState.loading = true;
  portfolioNewsState.error = '';
  startNewsRefreshTimer();
  renderPortfolioNews();
  let success = false;
  try {
    const resp = await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        action: 'get-position-news',
        positions,
        forceRefresh: opts.forceRefresh === true,
        perPositionLimit: settings.perPositionLimit,
        retentionDays: settings.retentionDays,
        refreshMinutes: settings.refreshMinutes,
        userKey: kvKeyActive(),
      }),
    });
    const data = await resp.json();
    if (!resp.ok || data.ok === false) throw new Error(data.error || data.message || 'News konnten nicht geladen werden');
    portfolioNewsState.items = Array.isArray(data.items) ? data.items : [];
    portfolioNewsState.updatedAt = data.updatedAt || new Date().toISOString();
    portfolioNewsState.checkedAt = data.checkedAt || data.lastCheckedAt || portfolioNewsState.updatedAt;
    portfolioNewsState.nextRefreshAt = data.nextRefreshAt || '';
    portfolioNewsState.addedCount = Number(data.addedCount || 0);
    portfolioNewsState.warnings = Array.isArray(data.warnings) ? data.warnings : [];
    portfolioNewsState.lastFetchAt = Date.now();
    success = true;
  } catch (e) {
    portfolioNewsState.error = `Newsfeed nicht verfügbar: ${e.message || e}`;
  } finally {
    portfolioNewsState.loading = false;
    completeNewsRefreshTimer(success);
    renderPortfolioNews();
  }
}

async function summarizePortfolioNewsItem(newsId) {
  const item = (portfolioNewsState.items || []).find(entry => entry.id === newsId);
  if (!item || portfolioNewsState.summarizing[newsId]) return;
  if (!getNewsSettings().aiSummaries && !(item.aiReport?.text || item.aiSummary)) return;
  if (item.aiReport?.text || item.aiSummary) {
    portfolioNewsState.reportOpen[newsId] = !portfolioNewsState.reportOpen[newsId];
    renderPortfolioNews();
    return;
  }
  startNewsSummaryTimer(newsId);
  renderPortfolioNews();
  let success = false;
  try {
    const resp = await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        action: 'summarize-position-news',
        userKey: kvKeyActive(),
        newsId,
        item,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || data.ok === false) throw new Error(data.error || data.message || 'KI-Zusammenfassung nicht verfügbar');
    const idx = portfolioNewsState.items.findIndex(entry => entry.id === newsId);
    if (idx >= 0) {
      portfolioNewsState.items[idx] = {
        ...portfolioNewsState.items[idx],
        aiReport: data.aiReport || {
          text: data.report || '',
          createdAt: data.createdAt || new Date().toISOString(),
        },
      };
    }
    portfolioNewsState.reportOpen[newsId] = true;
    success = true;
  } catch (e) {
    alert('KI-Zusammenfassung konnte nicht erstellt werden: ' + (e.message || e));
  } finally {
    completeNewsSummaryTimer(newsId, success);
    renderPortfolioNews();
  }
}

function maybeFetchPortfolioNews() {
  if (!appData || portfolioNewsState.loading) return;
  const settings = getNewsSettings();
  const age = Date.now() - (portfolioNewsState.lastFetchAt || 0);
  if (!portfolioNewsState.items.length || age > settings.refreshMinutes * 60 * 1000) {
    fetchPortfolioNews({ forceRefresh: false });
  }
}
