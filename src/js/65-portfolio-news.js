// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== DEPOT-NEWS =====
const NEWS_AUTO_REFRESH_MS = 30 * 60 * 1000;
const NEWS_POSITION_LIMIT = 12;
let portfolioNewsState = {
  items: [],
  loading: false,
  error: '',
  filter: 'all',
  updatedAt: '',
  lastFetchAt: 0,
};

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
    status.textContent = `Aktualisiert ${newsTimeAgo(portfolioNewsState.updatedAt)} · Quellen werden pro Position über den Worker gesucht.`;
  } else {
    status.textContent = 'Noch keine News geladen.';
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
    return `<article class="news-card ${item.imageUrl ? 'has-image' : ''}">
      ${image}
      <div class="news-main">
        <div class="news-meta">${impact}<span>${source}</span><span>·</span><span>${escapeHtml(newsDateTime(item.publishedAt) || newsTimeAgo(item.publishedAt))}</span></div>
        <div class="news-title">${escapeHtml(item.title || 'Meldung')}</div>
        <div class="news-summary">${escapeHtml(item.summary || 'Keine Zusammenfassung verfügbar.')}</div>
        <div class="news-footer">
          <div class="news-tags">${positionsHtml}</div>
          <a class="news-source-link" href="${newsEscapeAttr(item.url || '#')}" target="_blank" rel="noopener noreferrer">Quelle öffnen</a>
        </div>
      </div>
    </article>`;
  }).join('');
}

async function fetchPortfolioNews(opts = {}) {
  if (!appData || portfolioNewsState.loading) return;
  const positions = newsPositionsPayload();
  if (!positions.length) {
    portfolioNewsState.items = [];
    renderPortfolioNews();
    return;
  }
  portfolioNewsState.loading = true;
  portfolioNewsState.error = '';
  renderPortfolioNews();
  try {
    const resp = await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        action: 'get-position-news',
        positions,
        forceRefresh: opts.forceRefresh === true,
        userKey: kvKeyActive(),
      }),
    });
    const data = await resp.json();
    if (!resp.ok || data.ok === false) throw new Error(data.error || data.message || 'News konnten nicht geladen werden');
    portfolioNewsState.items = Array.isArray(data.items) ? data.items : [];
    portfolioNewsState.updatedAt = data.updatedAt || new Date().toISOString();
    portfolioNewsState.lastFetchAt = Date.now();
  } catch (e) {
    portfolioNewsState.error = `Newsfeed nicht verfügbar: ${e.message || e}`;
  } finally {
    portfolioNewsState.loading = false;
    renderPortfolioNews();
  }
}

function maybeFetchPortfolioNews() {
  if (!appData || portfolioNewsState.loading) return;
  const age = Date.now() - (portfolioNewsState.lastFetchAt || 0);
  if (!portfolioNewsState.items.length || age > NEWS_AUTO_REFRESH_MS) {
    fetchPortfolioNews({ forceRefresh: false });
  }
}
