// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== HANDELSPLATZ (Venue) =====
// Aktien/ETFs — Yahoo-Suffix Mapping
const VENUE_OPTIONS = [
  { code: 'auto',      label: 'Auto (Hauptbörse)', short: 'AUTO',       yahooSuffix: '' },
  { code: 'tradegate', label: 'Tradegate',         short: 'Tradegate',  yahooSuffix: '.TG' },
  { code: 'lus',       label: 'Lang & Schwarz',    short: 'L&S',        yahooSuffix: '.LU' },
  { code: 'xetra',     label: 'XETRA',             short: 'XETRA',      yahooSuffix: '.DE' },
  { code: 'frankfurt', label: 'Frankfurt',         short: 'Frankfurt',  yahooSuffix: '.F' },
  { code: 'muenchen',  label: 'München',           short: 'München',    yahooSuffix: '.MU' },
  { code: 'stuttgart', label: 'Stuttgart',         short: 'Stuttgart',  yahooSuffix: '.SG' },
  { code: 'duesseldorf', label: 'Düsseldorf',      short: 'Düsseldorf', yahooSuffix: '.DU' }
];
// Krypto — Preisquellen / Handelsplätze
const CRYPTO_VENUE_OPTIONS = [
  { code: 'coingecko', label: 'CoinGecko (Aggregat aller Börsen)', short: 'CoinGecko' },
  { code: 'tradias',   label: 'Tradias',  short: 'Tradias' },
  { code: 'bitpanda',  label: 'Bitpanda', short: 'Bitpanda' },
  { code: 'binance',   label: 'Binance',  short: 'Binance' },
  { code: 'coinbase',  label: 'Coinbase', short: 'Coinbase' },
  { code: 'kraken',    label: 'Kraken',   short: 'Kraken' },
  { code: 'bitstamp',  label: 'Bitstamp', short: 'Bitstamp' }
];
function isCryptoPos(pos) {
  return String(pos?.type || '').toLowerCase() === 'crypto';
}
function venueOptionsFor(pos) {
  return isCryptoPos(pos) ? CRYPTO_VENUE_OPTIONS : VENUE_OPTIONS;
}
function getVenueByCode(code) {
  return VENUE_OPTIONS.find(v => v.code === code)
      || CRYPTO_VENUE_OPTIONS.find(v => v.code === code)
      || VENUE_OPTIONS[0];
}
function venueOf(pos) {
  if (pos && pos.venue) return pos.venue;
  return isCryptoPos(pos) ? 'tradias' : 'auto';
}
function rejectedMarketQuoteIssue(pos, quote) {
  const price = Number(quote?.price);
  if (!Number.isFinite(price) || price <= 0) return 'Kurs fehlt oder ist nicht positiv';
  const currency = String(quote?.currency || 'EUR').toUpperCase();
  if (currency && currency !== 'EUR') return `Kurswährung ${currency} ist nicht EUR`;
  const previousClose = Number(quote?.previousClose);
  if (previousClose > 0) {
    const dailyPct = Math.abs(((price - previousClose) / previousClose) * 100);
    if (dailyPct > 60) return `Tagesabweichung ${fmtNum(dailyPct, 1)} % ist unplausibel`;
  }
  const old = baseLivePrices[pos.id] || currentPrices[pos.id];
  const oldPrice = Number(old?.price);
  if (oldPrice > 0 && old?.live) {
    const ratio = price / oldPrice;
    if (ratio > 3 || ratio < 0.33) return 'Kurs springt gegenüber der letzten Live-Basis unplausibel';
  }
  if (price > 100000) return 'Stückkurs ist unplausibel hoch';
  return '';
}
function rememberRejectedMarketQuote(pos, quote, reason) {
  quoteIssues[pos.id] = {
    message: `Livekurs verworfen: ${reason}. Alter/manueller Kurs bleibt aktiv.`,
    symbol: quote?.symbol || quoteSymbolForPosition(pos),
    suggestion: 'Quelle, Symbol, Handelsplatz und Währung prüfen'
  };
  const existing = currentPrices[pos.id] || baseQuoteForPosition(pos);
  if (existing) currentPrices[pos.id] = effectiveQuoteForPosition(pos, { ...existing, quoteIssue: quoteIssues[pos.id] });
}

async function fetchMarketHistory(days = 370, opts = {}) {
  const candidates = (appData?.positions || [])
    .filter(pos => !isCryptoPos(pos) && !pos.special)
    .filter(pos => {
      const ts = pos.dailyHistoryUpdatedAt ? new Date(pos.dailyHistoryUpdatedAt).getTime() : 0;
      const fresh = Array.isArray(pos.dailyHistory) && pos.dailyHistory.length > 20 && Date.now() - ts < 6 * 60 * 60 * 1000;
      return opts.forceRefresh === true || !fresh;
    })
    .map(pos => ({
      id: pos.id,
      name: pos.name,
      symbol: quoteSymbolForPosition(pos),
      type: pos.type,
      venue: venueOf(pos),
      isin: pos.stammdaten?.isin || pos.isin || (looksLikeIsin(pos.symbol) ? cleanQuoteSymbol(pos.symbol) : ''),
      wkn: pos.stammdaten?.wkn || pos.wkn || ''
    }))
    .filter(pos => pos.symbol || pos.isin || pos.wkn);
  if (candidates.length === 0) return false;
  let changed = false;
  const chunkSize = 8;
  for (let i = 0; i < candidates.length; i += chunkSize) {
    const chunk = candidates.slice(i, i + chunkSize);
    try {
      const res = await fetch(AI_WORKER_URL, {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ action: 'get-market-history', positions: chunk, days, userKey: kvKeyActive() })
      });
      if (!res.ok) throw new Error('Market history HTTP ' + res.status);
      const data = await res.json();
      const histories = data?.histories || {};
      chunk.forEach(item => {
        const history = histories[item.id];
        const pos = (appData.positions || []).find(p => p.id === item.id);
        if (!pos || !Array.isArray(history?.points) || history.points.length < 2) return;
        pos.dailyHistory = history.points
          .filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number(p.price) > 0)
          .slice(-370)
          .map(p => ({ date: p.date, price: Number(p.price) }));
        pos.dailyHistoryUpdatedAt = history.updatedAt || data.updatedAt || new Date().toISOString();
        pos.dailyHistorySource = history.source || data.source || 'Tageshistorie';
        pos.dailyHistoryFxApproximate = history.fxApproximate === true;
        changed = true;
      });
    } catch (e) {
      console.warn('Market history fetch failed:', e);
    }
  }
  if (changed) await savePositionsToKV(1200);
  return changed;
}

async function fetchMarketPrices(opts = {}) {
  const positions = (appData?.positions || [])
    .filter(pos => !isCryptoPos(pos))
    .map(pos => ({
      id: pos.id,
      name: pos.name,
      symbol: quoteSymbolForPosition(pos),
      type: pos.type,
      venue: venueOf(pos),
      isin: pos.stammdaten?.isin || pos.isin || (looksLikeIsin(pos.symbol) ? cleanQuoteSymbol(pos.symbol) : ''),
      wkn: pos.stammdaten?.wkn || pos.wkn || ''
    }))
    .filter(pos => pos.symbol || pos.isin || pos.wkn);
  if (positions.length === 0) return false;
  try {
    const res = await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ action: 'get-market-prices', positions, forceRefresh: opts.forceRefresh === true, userKey: kvKeyActive() })
    });
    if (!res.ok) throw new Error('Market prices HTTP ' + res.status);
    const data = await res.json();
    const quotes = data?.quotes || {};
    quoteIssues = {};
    let quoteMetadataChanged = false;
    (Array.isArray(data?.missing) ? data.missing : []).forEach(item => {
      if (!item?.id) return;
      quoteIssues[item.id] = {
        message: item.reason || 'Keine passende Kursquelle gefunden',
        symbol: item.symbol || '',
        suggestion: item.suggestion || ''
      };
    });
    (appData.positions || []).forEach(pos => {
      const q = quotes[pos.id];
      const price = Number(q?.price);
      const rejectedReason = price > 0 ? rejectedMarketQuoteIssue(pos, q) : '';
      if (price > 0 && !rejectedReason) {
        delete quoteIssues[pos.id];
        const resolvedSymbol = cleanQuoteSymbol(q?.resolvedSymbol || '');
        const marketType = String(pos.type || '').toLowerCase();
        if (resolvedSymbol && (marketType === 'aktie' || marketType === 'etf') && pos.quoteSymbol !== resolvedSymbol) {
          pos.quoteSymbol = resolvedSymbol;
          quoteMetadataChanged = true;
        }
        const previousClose = Number(q?.previousClose);
        const change = Number(q?.change);
        const changePct = Number(q?.changePct);
        const liveQuote = {
          price,
          previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
          change: Number.isFinite(change) ? change : null,
          changePct: Number.isFinite(changePct) ? changePct : null,
          live: true,
          source: q.source || data.source || 'Marktdaten',
          symbol: q.symbol || quoteSymbolForPosition(pos),
          currency: 'EUR',
          venue: q.venue || venueOf(pos),
          venueLabel: q.venueLabel || getVenueByCode(q.venue || venueOf(pos)).short,
          updatedAt: q.updatedAt || data.updatedAt || new Date().toISOString()
        };
        baseLivePrices[pos.id] = liveQuote;
        currentPrices[pos.id] = effectiveQuoteForPosition(pos, liveQuote);
      } else if (rejectedReason) {
        rememberRejectedMarketQuote(pos, q, rejectedReason);
      } else if (quoteIssues[pos.id]) {
        const fallbackPrice = Number(pos.manualPrice ?? currentPrices[pos.id]?.price ?? pos.costPrice);
        const fallbackQuote = {
          price: Number.isFinite(fallbackPrice) && fallbackPrice > 0 ? fallbackPrice : pos.costPrice,
          previousClose: null,
          change: null,
          changePct: null,
          live: false,
          source: 'Kursquelle fehlt',
          symbol: quoteSymbolForPosition(pos),
          currency: 'EUR',
          venue: venueOf(pos),
          venueLabel: getVenueByCode(venueOf(pos)).short,
          quoteIssue: quoteIssues[pos.id],
          updatedAt: data.updatedAt || new Date().toISOString()
        };
        currentPrices[pos.id] = effectiveQuoteForPosition(pos, fallbackQuote);
      }
    });
    if (quoteMetadataChanged) await savePositionsToKV();
    return true;
  } catch (e) {
    console.warn('Market price fetch failed:', e);
    return false;
  }
}

async function fetchMetalPrices(opts = {}) {
  if (opts.showProgress) startMetalsProgress();
  let success = false;
  try {
    const res = await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ action: 'get-metal-prices', forceRefresh: opts.showProgress === true, userKey: kvKeyActive() })
    });
    if (!res.ok) throw new Error('Metal prices HTTP ' + res.status);
    const data = await res.json();
    if (!data?.prices) return;
    const goal = ensureGoal();
    METALS.forEach(metal => {
      const price = Number(data.prices[metal.key]);
      if (price > 0) goal[metal.priceKey] = price;
    });
    goal.metalPriceSource = data.source || 'Edelmetallkurse';
    goal.metalPriceUpdatedAt = data.updatedAt || new Date().toISOString();
    goal.metalPriceSources = data.sources || {};
    goal.metalPriceCache = data.cache || {};
    goal.metalPriceWarnings = Array.isArray(data.warnings) ? data.warnings : [];
    goal.metalPriceChecks = data.checks || {};
    goal.metalPriceSourceUrl = data.sourceUrl || '';
    goal.metalPricePrimarySource = data.primarySource || '';
    goal.metalPriceFallbackSource = data.fallbackSource || '';
    await savePositionsToKV();
    success = true;
    return true;
  } catch (e) {
    console.warn('Metal price fetch failed:', e);
    return false;
  } finally {
    if (opts.showProgress) completeMetalsProgress(success);
  }
}

async function refreshMetalsOnly() {
  if (!appData || metalsProgressState) return;
  const details = document.querySelector('#card-metals details');
  const wasOpen = !!details?.open;
  await fetchMetalPrices({ showProgress: true });
  const totals = renderTotals();
  renderPositions(totals);
  const nextDetails = document.querySelector('#card-metals details');
  if (nextDetails) nextDetails.open = wasOpen || true;
  renderAllocation(totals);
  const goal = renderGoal(totals);
  renderSavingsSim(totals, goal);
  renderHistory();
}

async function fetchCryptoWeekly(cgId) {
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${cgId}/market_chart?vs_currency=eur&days=7`);
    if (!res.ok) return [];
    const data = await res.json();
    const pts = data.prices || [];
    // ~24 stündliche Punkte / Tag, wir nehmen 1 Punkt pro Tag (alle 24h)
    const step = Math.max(1, Math.floor(pts.length / 7));
    const sampled = [];
    for (let i = 0; i < pts.length; i += step) sampled.push(pts[i]);
    if (pts.length && sampled[sampled.length - 1] !== pts[pts.length - 1]) sampled.push(pts[pts.length - 1]);
    return sampled.map(([ts, price]) => { const d = new Date(ts); return { date: String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0'), price }; });
  } catch (e) { return []; }
}

async function fetchAllWeeklyCharts() {
  await Promise.all(appData.positions.filter(p => p.cgId).map(async pos => { const data = await fetchCryptoWeekly(pos.cgId); if (data.length > 1) weeklyData[pos.id] = data; }));
}

async function fetchCryptoDailyHistory(pos, days = 370, forceRefresh = false) {
  const cg = cgIdForCrypto(pos);
  if (!cg) return false;
  const ts = pos.dailyHistoryUpdatedAt ? new Date(pos.dailyHistoryUpdatedAt).getTime() : 0;
  if (!forceRefresh && Array.isArray(pos.dailyHistory) && pos.dailyHistory.length > 20 && Date.now() - ts < 6 * 60 * 60 * 1000) return false;
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(cg)}/market_chart?vs_currency=eur&days=${Math.min(370, days)}`);
    if (!res.ok) return false;
    const pts = (await res.json())?.prices || [];
    const byDate = new Map();
    pts.forEach(([stamp, price]) => {
      const iso = new Date(stamp).toISOString().slice(0, 10);
      if (Number(price) > 0) byDate.set(iso, { date: iso, price: Number(price) });
    });
    const history = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (history.length < 2) return false;
    pos.dailyHistory = history.slice(-370);
    pos.dailyHistoryUpdatedAt = new Date().toISOString();
    pos.dailyHistorySource = `CoinGecko Tageshistorie (${cg})`;
    pos.dailyHistoryFxApproximate = false;
    return true;
  } catch (e) {
    console.warn('Crypto daily history failed:', cg, e);
    return false;
  }
}
async function fetchAllCryptoHistories(days = 370, forceRefresh = false) {
  const changed = await Promise.all((appData.positions || []).filter(pos => isCryptoPos(pos)).map(pos => fetchCryptoDailyHistory(pos, days, forceRefresh)));
  if (changed.some(Boolean)) await savePositionsToKV(1200);
}

function loadManualPrices() {
  appData.positions.forEach(pos => {
    if (!pos.cgId && !currentPrices[pos.id]?.live) {
      const existing = currentPrices[pos.id] || {};
      const baseQuote = baseQuoteForPosition(pos) || {
        price: existing.price ?? pos.manualPrice ?? pos.costPrice,
        previousClose: existing.previousClose ?? null,
        change: existing.change ?? null,
        changePct: existing.changePct ?? null,
        live: false,
        source: existing.source || 'manuell',
        symbol: existing.symbol || quoteSymbolForPosition(pos),
        currency: existing.currency || 'EUR',
        venue: existing.venue || venueOf(pos),
        venueLabel: existing.venueLabel || getVenueByCode(venueOf(pos)).short,
        quoteIssue: existing.quoteIssue || quoteIssues[pos.id] || null,
        updatedAt: existing.updatedAt || null
      };
      currentPrices[pos.id] = effectiveQuoteForPosition(pos, baseQuote);
    } else if (pos.cgId && baseLivePrices[pos.id]) {
      currentPrices[pos.id] = effectiveQuoteForPosition(pos, baseLivePrices[pos.id]);
    }
    if (!pos.cgId && pos.weeklyHistory) weeklyData[pos.id] = pos.weeklyHistory;
  });
}

function clearChartFallback(canvas) {
  const wrap = canvas?.parentElement;
  if (!wrap) return;
  wrap.querySelectorAll('.history-svg-fallback, .history-chart-fallback-note').forEach(el => el.remove());
  canvas.style.display = '';
}

function svgEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderChartFallback(canvas, points, valueKey, opts) {
  const wrap = canvas?.parentElement;
  if (!wrap) return;
  clearChartFallback(canvas);
  const rows = (points || []).map((p, index) => ({ point: p, index }));
  const mainValues = rows.map(row => Number(row.point?.[valueKey])).filter(Number.isFinite);
  if (rows.length < 2 || mainValues.length < 2) return;
  canvas.style.display = 'none';

  const width = 640;
  const height = 180;
  const pad = { left: 58, right: 16, top: 16, bottom: 30 };
  const allSeries = [
    { key: valueKey, label: opts?.mainLabel || 'Depotwert', color: mainValues[mainValues.length - 1] >= mainValues[0] ? '#22c55e' : '#f87171', dashed: !!opts?.mainDashed, fill: true },
    ...(opts?.extraSeries || []).filter(s => !s.hidden)
  ];
  const allValues = allSeries.flatMap(series => rows.map(row => Number(row.point?.[series.key])).filter(Number.isFinite));
  let min = Math.min(...allValues);
  let max = Math.max(...allValues);
  if (min === max) {
    const spread = Math.max(1, Math.abs(max) * 0.01);
    min -= spread;
    max += spread;
  }
  const xFor = (rowIndex) => pad.left + (rowIndex / Math.max(1, rows.length - 1)) * (width - pad.left - pad.right);
  const yFor = (value) => pad.top + ((max - value) / (max - min)) * (height - pad.top - pad.bottom);
  const pathForSeries = (key) => {
    let drawing = false;
    return rows.map((row, i) => {
      const value = Number(row.point?.[key]);
      if (!Number.isFinite(value)) { drawing = false; return ''; }
      const cmd = drawing ? 'L' : 'M';
      drawing = true;
      return `${cmd} ${xFor(i).toFixed(1)} ${yFor(value).toFixed(1)}`;
    }).filter(Boolean).join(' ');
  };
  const mainPath = pathForSeries(valueKey);
  const baseY = height - pad.bottom;
  const mainRows = rows.filter(row => Number.isFinite(Number(row.point?.[valueKey])));
  const areaPath = `${mainRows.map((row, idx) => `${idx ? 'L' : 'M'} ${xFor(row.index).toFixed(1)} ${yFor(Number(row.point[valueKey])).toFixed(1)}`).join(' ')} L ${xFor(mainRows[mainRows.length - 1].index).toFixed(1)} ${baseY} L ${xFor(mainRows[0].index).toFixed(1)} ${baseY} Z`;
  const isUp = mainValues[mainValues.length - 1] >= mainValues[0];
  const color = isUp ? '#22c55e' : '#f87171';
  const grid = [0, 0.5, 1].map(t => {
    const value = max - (max - min) * t;
    const y = pad.top + (height - pad.top - pad.bottom) * t;
    return `<line class="grid" x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}"></line><text x="4" y="${(y + 4).toFixed(1)}">${svgEscape(fmtNoCent.format(value))}</text>`;
  }).join('');
  const labels = [0, Math.floor((rows.length - 1) / 2), rows.length - 1]
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .map(i => `<text x="${xFor(i).toFixed(1)}" y="${height - 8}" text-anchor="${i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle'}">${svgEscape(rows[i].point?.label || '')}</text>`)
    .join('');
  const markers = rows.map((row, i) => {
    const isEdge = i === 0 || i === rows.length - 1;
    const isEvent = !!(row.point?.events && row.point.events.length);
    if (!isEdge && !isEvent && !opts?.bigPoints) return '';
    const value = Number(row.point?.[valueKey]);
    if (!Number.isFinite(value)) return '';
    return `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(value).toFixed(1)}" r="${isEvent ? 3.5 : 2.8}" fill="${isEvent ? '#fbbf24' : color}"></circle>`;
  }).join('');
  const extraPaths = allSeries.slice(1).map(series => {
    const path = pathForSeries(series.key);
    if (!path) return '';
    return `<path class="line extra" d="${path}" stroke="${series.color || '#888'}" ${series.dashed ? 'stroke-dasharray="6 4"' : ''}></path>`;
  }).join('');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'history-svg-fallback');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', opts?.mainLabel || 'Depotchart');
  svg.innerHTML = `
    ${grid}
    <path class="area" d="${areaPath}" fill="${color}"></path>
    ${extraPaths}
    <path class="line main" d="${mainPath}" stroke="${color}" ${opts?.mainDashed ? 'stroke-dasharray="6 4"' : ''}></path>
    ${markers}
    ${labels}
  `;
  const note = document.createElement('div');
  note.className = 'history-chart-fallback-note';
  note.textContent = 'Fallback-Chart aktiv';
  wrap.appendChild(svg);
  wrap.appendChild(note);
  attachFallbackChartHover(wrap, svg, rows, valueKey);
}

function ensureHistoryHoverInfo(wrap) {
  if (!wrap) return null;
  let box = wrap.querySelector('.history-hover-info');
  if (!box) {
    box = document.createElement('div');
    box.className = 'history-hover-info';
    wrap.appendChild(box);
  }
  return box;
}

function chartPointChangeText(points, index, key) {
  const current = Number(points?.[index]?.[key]);
  const previous = Number(points?.[Math.max(0, index - 1)]?.[key]);
  if (!Number.isFinite(current) || !Number.isFinite(previous) || index <= 0) return '';
  const diff = current - previous;
  const pct = previous > 0 ? (diff / previous) * 100 : 0;
  return `${diff >= 0 ? '+' : ''}${fmt.format(diff)} (${diff >= 0 ? '+' : ''}${fmtNum(pct, 2)} %)`;
}

function historyHoverHtml(point, points, index, valueKey) {
  if (!point) return '';
  const changeText = chartPointChangeText(points, index, valueKey);
  const rows = [
    ['Depotwert', fmt.format(Number(point[valueKey]) || 0)],
    point.invested != null ? ['Einstand', fmt.format(point.invested)] : null,
    point.cash != null ? ['Cash', fmt.format(point.cash)] : null,
    changeText ? ['Bewegung', changeText] : null,
    point.quality?.label ? ['Kursbasis', point.quality.label] : null
  ].filter(Boolean);
  const events = (point.events || []).slice(0, 3);
  return `
    <strong>${svgEscape(point.labelLong || point.label || 'Chartpunkt')}</strong>
    ${rows.map(([label, value]) => `<span><em>${svgEscape(label)}</em><b>${svgEscape(value)}</b></span>`).join('')}
    ${events.length ? `<small>${svgEscape(events.join(' · '))}</small>` : ''}
  `;
}

function showHistoryHoverInfo(wrap, point, points, index, valueKey, clientX) {
  const box = ensureHistoryHoverInfo(wrap);
  if (!box || !point) return;
  box.innerHTML = historyHoverHtml(point, points, index, valueKey);
  const rect = wrap.getBoundingClientRect();
  const x = Number.isFinite(clientX) ? clientX - rect.left : rect.width / 2;
  box.style.left = `${Math.max(8, Math.min(rect.width - 210, x + 10))}px`;
  box.classList.add('visible');
}

function hideHistoryHoverInfo(wrap) {
  const box = wrap?.querySelector('.history-hover-info');
  if (box) box.classList.remove('visible');
}

function syncHistoryLegendControls(intraday) {
  document.querySelectorAll('.history-legend-toggle').forEach(btn => {
    const key = btn.dataset.series;
    const unavailable = intraday && (key === 'pnl' || key === 'goal');
    btn.disabled = unavailable;
    btn.classList.toggle('unavailable', unavailable);
    btn.classList.toggle('active', !unavailable && !!historyVisibleSeries[key]);
    if (unavailable) btn.title = 'In der Heute-Ansicht nicht sinnvoll, weil es nur um die Tagesbewegung geht.';
    else btn.removeAttribute('title');
  });
}

function attachFallbackChartHover(wrap, svg, rows, valueKey) {
  if (!wrap || !svg || !rows?.length) return;
  svg.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect();
    const pct = rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0;
    const index = Math.max(0, Math.min(rows.length - 1, Math.round(pct * (rows.length - 1))));
    showHistoryHoverInfo(wrap, rows[index].point, rows.map(r => r.point), index, valueKey, event.clientX);
  });
  svg.addEventListener('pointerleave', () => hideHistoryHoverInfo(wrap));
}

function renderChart(canvasId, points, valueKey, opts) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !points || points.length < 2) return;
  chartRegistry[canvasId] = { points, valueKey, opts: opts || {} };
  const values = points.map(p => Number(p[valueKey]));
  if (values.filter(Number.isFinite).length < 2) return;
  if (typeof Chart === 'undefined') {
    renderChartFallback(canvas, points, valueKey, opts || {});
    return;
  }
  clearChartFallback(canvas);
  const wrap = canvas.parentElement;
  canvas.onmouseleave = () => hideHistoryHoverInfo(wrap);
  const existing = Chart.getChart && Chart.getChart(canvas);
  if (existing) existing.destroy();
  const theme = getThemeColors();
  const isUp = values[values.length - 1] >= values[0];
  const color = isUp ? '#22c55e' : '#f87171';
  const fillColor = isUp ? 'rgba(34,197,94,0.10)' : 'rgba(248,113,113,0.10)';
  const useEventMarkers = !!opts?.eventMarkers;
  const markerRadius = useEventMarkers
    ? points.map(p => (p.events && p.events.length) ? 3.5 : (p.quality?.level === 'weak' ? 2 : 0))
    : (opts?.bigPoints ? 3 : opts?.daily ? 0 : 2);
  const markerColors = useEventMarkers
    ? points.map(p => (p.events && p.events.length) ? '#fbbf24' : (p.quality?.level === 'weak' ? '#f87171' : color))
    : color;
  // Hauptserie + optionale Zusatzserien (für Depotchart: Einstand-Linie, P&L)
  const datasets = [{
    label: opts?.mainLabel || 'Depotwert',
    data: values, borderColor: color, backgroundColor: fillColor, borderWidth: 1.8,
    borderDash: opts?.mainDashed ? [6, 4] : undefined,
    fill: true, tension: opts?.daily ? 0.15 : 0.3,
    pointRadius: markerRadius, pointHoverRadius: 5,
    pointBackgroundColor: markerColors, pointBorderColor: document.body.classList.contains('light') ? '#fff' : '#181818', pointBorderWidth: 1
  }];
  (opts?.extraSeries || []).forEach(s => {
    if (s.hidden) return;
    datasets.push({
      label: s.label,
      data: points.map(p => p[s.key]),
      borderColor: s.color,
      backgroundColor: 'transparent',
      borderWidth: 1.4,
      borderDash: s.dashed ? [6, 4] : undefined,
      fill: false,
      tension: 0.15,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointBackgroundColor: s.color
    });
  });
  new Chart(canvas, {
    type: 'line',
    data: { labels: points.map(p => p.label || p.date), datasets },
    options: { responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' }, onHover: (event, active) => {
      const hit = active && active[0];
      if (!hit) { hideHistoryHoverInfo(wrap); return; }
      showHistoryHoverInfo(wrap, points[hit.index], points, hit.index, valueKey, event?.native?.clientX);
    }, plugins: { legend: { display: false }, tooltip: { enabled: false, backgroundColor: theme.tooltipBg, titleColor: theme.tooltipText, bodyColor: theme.tooltipText, borderColor: color, borderWidth: 1, padding: 8, displayColors: datasets.length > 1, titleFont: { size: 11, weight: '500' }, bodyFont: { size: 12 }, callbacks: { title: (items) => points[items[0].dataIndex].labelLong || items[0].label, label: (item) => (item.dataset.label ? item.dataset.label + ': ' : '') + fmt.format(item.parsed.y), afterBody: (items) => {
          const point = points[items[0].dataIndex];
          const lines = [];
          if (point.cash != null) lines.push(`Cash: ${fmt.format(point.cash)}`);
          if (point.invested != null) lines.push(`Einstand: ${fmt.format(point.invested)}`);
          if (point.netContributions != null) lines.push(`Netto eingezahlt: ${fmt.format(point.netContributions)}`);
          if (point.quality?.label) lines.push(`Kursbasis: ${point.quality.label}`);
          return [...lines, ...(point.events || []), ...(point.historyNote ? [point.historyNote] : [])];
        } } } }, scales: { x: { display: true, grid: { display: false }, ticks: { font: { size: 10 }, color: theme.axisText, maxRotation: 0, autoSkipPadding: 8 } }, y: { display: true, grid: { color: theme.gridColor, drawBorder: false }, ticks: { font: { size: 10 }, color: theme.axisText, callback: (v) => opts?.compactY ? fmtNoCent.format(v) : fmtNum(v, 2) + ' €', maxTicksLimit: 4 } } }, elements: { line: { borderJoinStyle: 'round' } } }
  });
}

function reRenderAllCharts() {
  Object.entries(chartRegistry).forEach(([id, entry]) => { if (entry?.points) renderChart(id, entry.points, entry.valueKey, entry.opts); });
}

function getPositionTodayChange(pos, live) {
  const pct = Number(live?.changePct);
  const price = Number(live?.price);
  const previousClose = Number(live?.previousClose);
  const changePerShare = Number(live?.change);
  const shares = Number(getPositionValuation(pos, live).shares || 0);
  if (!Number.isFinite(price) || price <= 0 || shares <= 0) return null;

  if (Number.isFinite(previousClose) && previousClose > 0) {
    const eur = (price - previousClose) * shares;
    const directPct = ((price - previousClose) / previousClose) * 100;
    return { eur, pct: directPct, value: price * shares, previousClose, source: 'previousClose' };
  }

  if (Number.isFinite(changePerShare)) {
    const prev = price - changePerShare;
    if (Number.isFinite(prev) && prev > 0) {
      const directPct = (changePerShare / prev) * 100;
      return { eur: changePerShare * shares, pct: directPct, value: price * shares, previousClose: prev, source: 'change' };
    }
  }

  if (!Number.isFinite(pct) || pct <= -99.9) return null;
  const value = price * shares;
  const prevValue = value / (1 + pct / 100);
  const eur = value - prevValue;
  return { eur, pct, value, previousClose: price / (1 + pct / 100), source: 'changePct' };
}

function formatLiveUpdatedAt(live) {
  if (live?.manualOverride) {
    const expiresAt = live.overrideExpiresAt ? new Date(live.overrideExpiresAt) : null;
    const time = expiresAt && !isNaN(expiresAt.getTime()) ? expiresAt.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }) : '';
    return time ? `manuell bis ${time}` : 'manuell aktiv';
  }
  if (!live?.live) return 'manuell';
  const d = live.updatedAt ? new Date(live.updatedAt) : null;
  if (d && !isNaN(d.getTime())) {
    return `${d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' })}, ${d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return 'gerade geladen';
}
function formatLiveUpdatedShort(live) {
  if (live?.manualOverride) {
    const expiresAt = live.overrideExpiresAt ? new Date(live.overrideExpiresAt) : null;
    const time = expiresAt && !isNaN(expiresAt.getTime()) ? expiresAt.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }) : '';
    return time ? `Manuell bis ${time}` : 'Manuell aktiv';
  }
  if (!live?.live) return 'manuell';
  const d = live.updatedAt ? new Date(live.updatedAt) : null;
  if (!d || isNaN(d.getTime())) return 'gerade geladen';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `Heute / ${time}` : `${d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' })} / ${time}`;
}
function quoteCadenceMinutes(pos, live) {
  const type = String(pos?.type || '').toLowerCase();
  const source = String(live?.source || '').toLowerCase();
  const venue = String(live?.venue || '').toLowerCase();
  if (type === 'crypto' || venue.includes('crypto') || source.includes('crypto')) return 1;
  return 15;
}
function quoteFreshnessInfo(pos, live) {
  if (live?.manualOverride) {
    const remaining = manualQuoteRemainingText(pos);
    const base = live.baseSource ? ` · Live-Basis: ${live.baseSource}` : '';
    const text = `Quelle: Manueller Kurs · ${remaining || 'aktiv'} · Rückfall auf Livekurs nach 30 min${base}`;
    return { className: 'stale', shortText: text, detailText: `${text}. Berechnungen verwenden bis dahin den gespeicherten manuellen Kurs.` };
  }
  const source = live?.source || (live?.live ? 'Marktdaten' : 'manuell');
  const venue = live?.venueLabel || getVenueByCode(venueOf(pos)).short;
  if (!live?.live) {
    return {
      className: 'manual',
      shortText: 'kein Live-Zeitstempel',
      detailText: `Quelle: ${source} · kein Live-Zeitstempel · Wert wird erst durch eine erfolgreiche Kursquelle automatisch aktualisiert.`
    };
  }
  const d = live.updatedAt ? new Date(live.updatedAt) : null;
  if (!d || isNaN(d.getTime())) {
    return {
      className: '',
      shortText: 'Kurszeit: gerade geladen',
      detailText: `Quelle: ${source} · ${venue} · Kurszeit: gerade geladen`
    };
  }
  const now = new Date();
  const ageMs = Math.max(0, now.getTime() - d.getTime());
  const ageMin = Math.floor(ageMs / 60000);
  const cadence = quoteCadenceMinutes(pos, live);
  const cadenceMs = cadence * 60000;
  const elapsedCycles = Math.floor(ageMs / cadenceMs) + 1;
  const nextMs = Math.max(0, d.getTime() + elapsedCycles * cadenceMs - now.getTime());
  const nextMin = Math.ceil(nextMs / 60000);
  const time = d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  const delayedText = ageMin <= 0 ? 'unter 1 min' : `ca. ${ageMin} min`;
  const nextText = nextMin <= 0 ? 'unter 1 min' : `ca. ${nextMin} min`;
  const className = ageMin >= cadence ? 'stale' : '';
  const shortBase = `Kurszeit: ${time} · verzögert ${delayedText} · nächster Wert in ${nextText}`;
  const detailBase = `Quelle: ${source} · ${venue} · ${shortBase}`;
  return { className, shortText: shortBase, detailText: `${detailBase} · angenommener Quellentakt: ${cadence} min` };
}

function buildCard(pos, totals, alloc) {
  const wrap = document.createElement('div');
  wrap.className = 'card';
  wrap.id = `card-${pos.id}`;
  wrap.dataset.posId = pos.id;
  const live = currentPrices[pos.id] || { price: pos.costPrice, previousClose: null, change: null, changePct: null, live: false };
  const valuation = getPositionValuation(pos, live);
  const valueEur = valuation.currentValue;
  const costValue = valuation.costValue;
  const pnlAbs = valuation.pnlAbs;
  const pnlPct = valuation.pnlPct;
  const priceDistance = live.price - valuation.costPrice;
  const pnlClass = pnlAbs >= 0 ? 'positive' : 'negative';
  const pctPortfolio = totals && totals.totalCur > 0 ? (valueEur / totals.totalCur) * 100 : 0;
  const isClump = pctPortfolio > 30;
  const risk = deriveRisk(pos);
  const quoteIssue = live.quoteIssue || quoteIssues[pos.id] || null;
  const liveBadge = live.manualOverride ? `<span class="risk-badge risk-medium">MANUELL 30 MIN</span>` : live.live ? `<span class="risk-badge risk-low">LIVE</span>` : quoteIssue ? `<span class="risk-badge risk-medium">KURS PRÜFEN</span>` : `<span class="risk-badge risk-medium">MANUELL</span>`;
  const todayMove = getPositionTodayChange(pos, live);
  const todayClass = todayMove && todayMove.eur >= 0 ? 'positive' : 'negative';
  const todayEurText = todayMove ? `${todayMove.eur >= 0 ? '+' : ''}${fmt.format(todayMove.eur)}` : '—';
  const todayPctText = todayMove ? `${todayMove.pct >= 0 ? '+' : ''}${fmtNum(todayMove.pct, 2)} %` : '';
  const todayText = todayMove ? `${todayEurText} (${todayPctText})` : '—';
  const updatedText = `${live.source ? escapeHtml(live.source) + ' · ' : ''}${escapeHtml(formatLiveUpdatedAt(live))}`;
  const collapsedUpdatedText = `${escapeHtml(formatLiveUpdatedShort(live))}${live.venueLabel ? ' · ' + escapeHtml(live.venueLabel) : ''}`;
  const freshness = quoteFreshnessInfo(pos, live);
  const portfolioInfo = isClump ? `<span class="pct-portfolio warn">${fmtNum(pctPortfolio, 0)} % Portfolio · Klumpenrisiko</span>` : `<span class="pct-portfolio">${fmtNum(pctPortfolio, 0)} % Portfolio</span>`;
  const warning = isClump ? `<div class="warn-box"><strong>Hinweis:</strong> ${fmtNum(pctPortfolio, 0)} % deines Depots in dieser Position — Klumpenrisiko reduzieren.</div>` : '';
  const rec = getRecommendation(pos, totals, alloc);
  const recBlock = rec ? `<div class="rec-card rec-${rec.kind}"><div class="rec-icon">${recIcon(rec.kind)}</div><div class="rec-body"><div class="rec-label">KI-Empfehlung</div><div class="rec-action">${escapeHtml(rec.action)}</div><div class="rec-reason">${escapeHtml(rec.reason)}</div></div></div>` : '';
  const stammdatenBlock = buildStammdatenSection(pos, live, totals);
  const quoteIssueBlock = quoteIssue ? `<div class="quote-alert"><strong>Kursquelle prüfen:</strong> ${escapeHtml(quoteIssue.message || 'Kein Livekurs gefunden')}${quoteIssue.symbol ? ` · Symbol: ${escapeHtml(quoteIssue.symbol)}` : ''}${quoteIssue.suggestion ? ` · Vorschlag: ${escapeHtml(quoteIssue.suggestion)}` : ''}</div>` : '';
  wrap.innerHTML = `
    <div class="card-collapsed-row">
      <div class="card-collapsed-left">
        <div class="card-name-row">
          <span class="card-name">${escapeHtml(pos.name)}</span>
          <span class="risk-badge risk-${risk}">${riskLabel(risk)}</span>
          ${liveBadge}
        </div>
        <div class="card-meta-line">${escapeHtml(pos.type || '')} · ${escapeHtml(pos.symbol || '')} · ${portfolioInfo}</div>
      </div>
      <div class="card-collapsed-metrics" title="${updatedText}">
        <div class="card-metric total">
          <span class="lbl">Gesamtwert</span>
          <span class="val">${fmt.format(valueEur)}</span>
        </div>
        <div class="card-metric">
          <span class="lbl">Kursdatum</span>
          <span class="val">${collapsedUpdatedText}</span>
        </div>
        <div class="card-metric today">
          <span class="lbl">Veränderung heute</span>
          <span class="val ${todayMove ? todayClass : ''}">${todayMove ? `${todayEurText} (${todayPctText})` : '—'}</span>
        </div>
        <div class="quote-freshness-line ${freshness.className}">${escapeHtml(freshness.shortText)}</div>
      </div>
      <button class="card-quick-edit" data-quickedit-id="${pos.id}" title="Bearbeiten" aria-label="Bearbeiten">
        <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <div class="card-chevron"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></div>
    </div>
    <div class="card-expanded-content">
      <div class="price-grid">
        <div class="price-grid-cell"><div class="lbl">Ø Einstieg</div><div class="val">${fmtPrice(pos, valuation.costPrice)}</div></div>
        <div class="price-grid-cell"><div class="lbl">Aktuell</div><div class="val">${fmtPrice(pos, live.price)}</div></div>
        <div class="price-grid-cell"><div class="lbl">Abstand Ø</div><div class="val ${pnlClass}">${priceDistance >= 0 ? '+' : ''}${fmtNum(priceDistance, 2)} € · ${pnlPct >= 0 ? '+' : ''}${fmtNum(pnlPct, 2)} %</div></div>
        <div class="price-grid-cell"><div class="lbl">Break-Even</div><div class="val">${fmtPrice(pos, valuation.costPrice)}</div></div>
        <div class="price-grid-cell"><div class="lbl">Veränd. heute</div><div class="val ${todayMove ? todayClass : ''}">${todayText}</div></div>
        <div class="price-grid-cell"><div class="lbl">Aktualisiert</div><div class="val" style="font-size:11px;">${updatedText}</div></div>
      </div>
      <div class="quote-freshness-box ${freshness.className}">${escapeHtml(freshness.detailText)}</div>
      ${buildManualQuotePanel(pos, live)}
      ${quoteIssueBlock}
      ${buildVenueRow(pos, live)}
      ${stammdatenBlock}
      <div class="chart-controls-row">
        <div class="chart-label">Kursverlauf</div>
        <div class="chart-tabs" id="chartTabs-${pos.id}">
          <button class="chart-tab" data-period="day">Tag</button>
          <button class="chart-tab active" data-period="week">Woche</button>
          <button class="chart-tab" data-period="month">Monat</button>
        </div>
      </div>
      <div class="chart-wrap" id="chartWrap-${pos.id}" style="height:130px;"></div>
      <div class="chart-stamp" id="chartStamp-${pos.id}">&nbsp;</div>
      ${warning}
      ${buildRealizedSection(pos)}
      ${recBlock}
      <div class="card-action-row">
        <button class="pos-action-btn" data-edit-id="${pos.id}">
          <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          <span>Bearbeiten</span>
        </button>
        <button class="pos-action-btn buy" data-buy-id="${pos.id}">
          <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <span>Nachkauf</span>
        </button>
        <button class="pos-action-btn sell" data-sell-id="${pos.id}">
          <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/></svg>
          <span>Verkauf</span>
        </button>
        <button class="pos-action-btn danger" data-remove-id="${pos.id}">
          <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
          <span>Entfernen</span>
        </button>
      </div>
    </div>`;
  return wrap;
}

function buildManualQuotePanel(pos, live) {
  if (!pos || pos.special) return '';
  const type = String(pos.type || '').toLowerCase();
  if (!['aktie', 'etf', 'crypto'].includes(type)) return '';
  const active = getManualQuoteOverride(pos);
  const remaining = active ? manualQuoteRemainingText(pos) : '';
  const basePrice = baseQuoteForPosition(pos)?.price || (live?.manualOverride ? null : live?.price);
  const displayPrice = basePrice || live?.price || pos.manualPrice || pos.costPrice || 0;
  const placeholder = fmtNum(displayPrice, priceDecimalsForPosition(pos, displayPrice));
  return `<div class="manual-quote-panel" data-manual-quote-panel="${pos.id}">
    <div class="manual-quote-head">
      <div class="manual-quote-title">Kurs manuell überschreiben</div>
      <div class="manual-quote-state ${active ? 'active' : ''}" id="manualQuoteState-${pos.id}">
        ${active ? `Manueller Kurs ${fmtPrice(pos, active.price)} · ${escapeHtml(remaining)}` : 'Inaktiv · Berechnung nutzt Live/Quelle'}
      </div>
    </div>
    <div class="manual-quote-form">
      <input type="text" inputmode="decimal" class="manual-quote-input" id="manualQuoteInput-${pos.id}" data-manual-quote-input="${pos.id}" placeholder="${escapeHtml(placeholder)}" value="">
      <button class="manual-quote-btn save" data-manual-quote-save="${pos.id}" type="button">Speichern</button>
      <button class="manual-quote-btn clear" data-manual-quote-clear="${pos.id}" type="button" ${active ? '' : 'disabled'}>Entfernen</button>
    </div>
    <div class="manual-quote-note">Erst nach „Speichern“ wird neu berechnet. Der manuelle Kurs läuft automatisch nach 30 Minuten ab.</div>
  </div>`;
}

function parseQuoteInput(value) {
  const raw = String(value || '').trim();
  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw;
  const num = Number(normalized);
  return Number.isFinite(num) && num > 0 ? num : null;
}

async function saveManualQuoteOverride(posId) {
  const pos = appData?.positions?.find(p => p.id === posId);
  if (!pos) return;
  const input = document.getElementById(`manualQuoteInput-${posId}`);
  const price = parseQuoteInput(input?.value);
  if (!price) {
    alert('Bitte einen gültigen Kurs eingeben.');
    return;
  }
  const now = new Date();
  const base = baseQuoteForPosition(pos);
  pos.manualQuoteOverride = {
    price,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + MANUAL_QUOTE_OVERRIDE_MS).toISOString(),
    baseQuote: {
      price: Number(base.price) || price,
      previousClose: base.previousClose ?? null,
      change: base.change ?? null,
      changePct: base.changePct ?? null,
      live: !!base.live,
      source: base.source || 'manuell',
      symbol: base.symbol || quoteSymbolForPosition(pos),
      currency: 'EUR',
      venue: base.venue || venueOf(pos),
      venueLabel: base.venueLabel || getVenueByCode(venueOf(pos)).short,
      updatedAt: base.updatedAt || null,
    },
  };
  currentPrices[pos.id] = effectiveQuoteForPosition(pos, base);
  renderExpandedRestore.add(pos.id);
  await savePositionsToKV();
  await refreshUI({ skipAI: true });
}

async function clearManualQuoteOverride(posId) {
  const pos = appData?.positions?.find(p => p.id === posId);
  if (!pos || !pos.manualQuoteOverride) return;
  const base = baseQuoteForPosition(pos);
  delete pos.manualQuoteOverride;
  currentPrices[pos.id] = effectiveQuoteForPosition(pos, base);
  renderExpandedRestore.add(pos.id);
  await savePositionsToKV();
  await refreshUI({ skipAI: true });
}

// Erzeugt die Handelsplatz-Zeile in der ausgeklappten Karte (nur bei Aktien/ETFs, nicht bei Crypto/Special)
function buildVenueRow(pos, live) {
  if (!pos || pos.special || pos.cgId) return '';
  const type = String(pos.type || '').toLowerCase();
  if (type !== 'aktie' && type !== 'etf') return '';
  const code = venueOf(pos);
  const venue = getVenueByCode(code);
  const liveLabel = live && live.venueLabel ? live.venueLabel : venue.short;
  return `<div class="venue-row">
    <span>Handelsplatz</span>
    <button class="venue-pill" data-venue-pick="${pos.id}" type="button" title="Handelsplatz wechseln">
      <span class="name">${escapeHtml(liveLabel)}</span>
      <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
  </div>`;
}

// ===== VENUE-AUSWAHL-MODAL =====
let venuePickingPosId = null;
let venuePendingCode = 'auto';
function openVenueModal(posId) {
  const pos = appData.positions.find(p => p.id === posId);
  if (!pos) return;
  venuePickingPosId = posId;
  venuePendingCode = venueOf(pos);
  document.getElementById('venueModalTitle').textContent = 'Handelsplatz: ' + pos.name;
  renderVenueList(pos);
  updateVenueSaveState(pos);
  document.getElementById('venueModal').classList.add('active');
}
function updateVenueSaveState(pos) {
  const btn = document.getElementById('venueSaveBtn');
  if (!btn || !pos) return;
  const current = venueOf(pos);
  const changed = venuePendingCode !== current;
  btn.disabled = !changed;
  btn.textContent = changed ? `Speichern: ${getVenueByCode(venuePendingCode).short}` : 'Speichern';
}
function renderVenueList(pos) {
  const list = document.getElementById('venueListBody');
  const live = currentPrices[pos.id];
  const currentPrice = live && live.price ? fmtPrice(pos, live.price) : null;
  list.innerHTML = VENUE_OPTIONS.map(v => {
    const isSel = v.code === venuePendingCode;
    const priceLine = isSel && currentPrice ? `<span class="vprice">${currentPrice}</span>` : `<span class="vprice muted">${v.code === 'auto' ? 'Standard-Quelle' : 'Quelle aktivieren'}</span>`;
    return `<div class="venue-item ${isSel ? 'selected' : ''}" data-venue-code="${v.code}">
      <div><div class="vname">${escapeHtml(v.label)}</div></div>
      <div style="display:flex;align-items:center;gap:6px;">
        ${priceLine}
        ${isSel ? '<span class="check"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>' : ''}
      </div>
    </div>`;
  }).join('');
}
function closeVenueModal() { document.getElementById('venueModal').classList.remove('active'); venuePickingPosId = null; venuePendingCode = 'auto'; }
function selectVenue(code) {
  if (!venuePickingPosId) return;
  const pos = appData.positions.find(p => p.id === venuePickingPosId);
  if (!pos) return;
  venuePendingCode = code || 'auto';
  renderVenueList(pos);
  updateVenueSaveState(pos);
}
async function saveVenueSelection() {
  if (!venuePickingPosId) return;
  const pos = appData.positions.find(p => p.id === venuePickingPosId);
  if (!pos) return;
  const code = venuePendingCode || 'auto';
  if (code === 'auto') delete pos.venue; else pos.venue = code;
  delete currentPrices[pos.id];
  closeVenueModal();
  await savePositionsToKV();
  try { await fetchMarketPrices({ forceRefresh: true }); } catch (e) {}
  await refreshUI({ skipAI: true });
}

function buildRealizedSection(pos) {
  if (!pos || !Array.isArray(appData?.transactions)) return '';
  const sells = appData.transactions.filter(t => t.assetId === pos.id && t.txType === 'sell');
  if (sells.length === 0) return '';
  // Realisierte G/V berechnen — vereinfacht (Avg-Cost zum Verkaufszeitpunkt)
  // Wir nehmen die computed-Berechnung von getComputedPosition als Quelle der Wahrheit
  const comp = getComputedPosition(pos.id);
  const totalSoldValue = sells.reduce((s, t) => s + (t.value || 0), 0);
  const totalSoldFees = sells.reduce((s, t) => s + (t.fees || 0), 0);
  const realized = comp.realizedPnl || 0;
  const cls = realized >= 0 ? 'positive' : 'negative';
  return `<div class="realized-section ${realized < 0 ? 'loss' : ''}">
    <div class="title">Realisierte Ergebnisse (${sells.length} Verkauf${sells.length === 1 ? '' : 'e'})<span class="total ${cls}">${realized >= 0 ? '+' : ''}${fmt.format(realized)}</span></div>
    <div class="realized-line"><span class="lbl">Verkauft gesamt</span><span>${fmt.format(totalSoldValue)}</span></div>
    ${totalSoldFees > 0 ? `<div class="realized-line"><span class="lbl">Gebühren</span><span>${fmt.format(totalSoldFees)}</span></div>` : ''}
    <div class="realized-line"><span class="lbl">Realisierter G/V (Avg-Cost)</span><span class="${cls}">${realized >= 0 ? '+' : ''}${fmt.format(realized)}</span></div>
    <div class="realized-line" style="font-size:10px;color:var(--text-muted);margin-top:4px;">Hinweis: Keine Steuerberatung. Realisierungs-Steuern werden hier nicht berechnet.</div>
  </div>`;
}

function buildMetalLotsBlock(metal) {
  const lots = metalLots(metal);
  const grams = metalGrams(metal);
  const currentValue = metalValue(metal);
  const cost = metalCost(metal);
  const avg = metalAvgCost(metal);
  const pnl = lots.length ? currentValue - cost : 0;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
  const pnlClass = pnl >= 0 ? 'positive' : 'negative';
  const rows = lots.map((lot, idx) => {
    const perGram = lot.grams > 0 ? lot.value / lot.grams : 0;
    return `<div class="metal-lot-row"><span>${formatDateAT(lot.date)}</span><span>${fmtNum(lot.grams, lot.grams % 1 ? 3 : 0)} g</span><span>${fmtNum(perGram, 2)} €/g</span><button class="metal-lot-del" data-metal-del="${metal.key}" data-lot-index="${idx}" type="button" title="Kauf löschen" aria-label="Kauf löschen">×</button></div>`;
  }).join('');
  const empty = lots.length ? '' : `<div class="metal-lot-row"><span>—</span><span>Noch keine Käufe</span><span>—</span><span></span></div>`;
  return `<div class="metal-lots">
    <div class="metal-lots-summary">
      <div class="metal-lot-metric">Einstand<strong>${lots.length ? fmt.format(cost) : '—'}</strong></div>
      <div class="metal-lot-metric">Ø Einkauf<strong>${lots.length ? fmtNum(avg, 2) + ' €/g' : '—'}</strong></div>
      <div class="metal-lot-metric">Aktuell<strong>${fmt.format(currentValue)}</strong></div>
      <div class="metal-lot-metric">Entwicklung<strong class="${pnlClass}">${lots.length ? `${pnl >= 0 ? '+' : ''}${fmt.format(pnl)} (${fmtPct(pnlPct)})` : '—'}</strong></div>
    </div>
    ${rows || empty}
    <button class="metal-lot-add" data-metal-add="${metal.key}" type="button">+ ${metal.name}-Kauf hinzufügen</button>
    <div class="metal-meta" style="margin-top:6px;">${lots.length ? `${fmtNum(grams, grams % 1 ? 3 : 0)} g aus Kaufdaten` : 'Ohne Kaufdaten gilt der Regler als Bestand.'}</div>
  </div>`;
}
async function rerenderMetalsOpen() {
  const details = document.querySelector('#card-metals details');
  const wasOpen = !!details?.open;
  const totals = renderTotals();
  renderPositions(totals);
  const nextDetails = document.querySelector('#card-metals details');
  if (nextDetails) nextDetails.open = wasOpen || true;
  renderAllocation(totals);
  const goal = renderGoal(totals);
  renderSavingsSim(totals, goal);
  renderHistory();
  await savePositionsToKV();
}
let pendingMetalKey = null;
function addMetalLot(metalKey) {
  // Öffnet das Modal — eigentliches Speichern in saveMetalLotModal
  const metal = METALS.find(m => m.key === metalKey);
  if (!metal) return;
  pendingMetalKey = metalKey;
  const today = toIsoDate(new Date());
  document.getElementById('metalLotTitle').textContent = `${metal.name}-Kauf hinzufügen`;
  document.getElementById('mlDate').value = today;
  document.getElementById('mlGrams').value = '';
  document.getElementById('mlValue').value = '';
  document.getElementById('mlFees').value = '';
  document.getElementById('mlStorage').value = 'physisch';
  document.getElementById('mlValuation').value = 'spot';
  document.getElementById('metalLotModal').classList.add('active');
  setTimeout(() => document.getElementById('mlGrams').focus(), 50);
}

function closeMetalLotModal() {
  document.getElementById('metalLotModal').classList.remove('active');
  pendingMetalKey = null;
}

// ===== CASH-TRANSAKTIONEN =====
let pendingCashTxType = 'deposit';
function openCashTxModal(type) {
  pendingCashTxType = ['deposit', 'withdraw', 'fee', 'tax', 'reconcile'].includes(type) ? type : 'deposit';
  document.getElementById('cashTxTitle').textContent = ({
    deposit: 'Cash-Einzahlung', withdraw: 'Cash-Auszahlung', fee: 'Cash-Gebühr', tax: 'Cash-Steuer', reconcile: 'Cash-Saldo korrigieren'
  })[pendingCashTxType];
  const amountLabel = document.getElementById('ctxAmountLabel');
  const amountInput = document.getElementById('ctxAmount');
  if (amountLabel) amountLabel.textContent = pendingCashTxType === 'reconcile' ? 'Zielsaldo laut Konto (EUR)' : 'Betrag (EUR)';
  if (amountInput) {
    amountInput.min = pendingCashTxType === 'reconcile' ? '' : '0';
    amountInput.placeholder = pendingCashTxType === 'reconcile' ? 'z.B. 12.40' : 'z.B. 500.00';
  }
  document.getElementById('ctxDate').value = new Date().toISOString().slice(0, 10);
  document.getElementById('ctxAmount').value = '';
  document.getElementById('ctxNote').value = '';
  document.getElementById('cashTxModal').classList.add('active');
  setTimeout(() => document.getElementById('ctxAmount').focus(), 50);
}
function closeCashTxModal() { document.getElementById('cashTxModal').classList.remove('active'); }
async function saveCashTxModal() {
  const date = document.getElementById('ctxDate').value;
  const amount = parseFloat(String(document.getElementById('ctxAmount').value).replace(',', '.'));
  const note = document.getElementById('ctxNote').value.trim();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { alert('Bitte gültiges Datum.'); return; }
  if (!isFinite(amount) || (pendingCashTxType !== 'reconcile' && amount <= 0)) { alert(pendingCashTxType === 'reconcile' ? 'Bitte gültigen Zielsaldo eingeben.' : 'Bitte gültigen Betrag eingeben.'); return; }
  if (!Array.isArray(appData.transactions)) appData.transactions = [];
  // Erste Cash-Tx startet mit automatischer Anfangsbasis, damit alte Käufe den Cashsaldo nicht plötzlich negativ machen.
  ensureCashLedgerStart(date);
  if (pendingCashTxType === 'reconcile') {
    const before = getCashBalance(date);
    const delta = Math.round((amount - before) * 100) / 100;
    if (Math.abs(delta) < 0.005) {
      closeCashTxModal();
      return alert('Cash-Saldo ist bereits passend. Es wurde keine Korrekturbuchung angelegt.');
    }
    appData.transactions.push({
      id: makeTxId(), date, assetId: 'cash', assetType: 'cash', txType: delta > 0 ? 'adjust-credit' : 'adjust-debit',
      quantity: Math.abs(delta), price: 1, value: Math.abs(delta), fees: 0,
      note: note || `Saldo-Korrektur auf ${fmt.format(amount)}`
    });
    appData.transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    closeCashTxModal();
    await savePositionsToKV();
    await refreshUI({ skipAI: true });
    return;
  }
  appData.transactions.push({
    id: makeTxId(), date, assetId: 'cash', assetType: 'cash', txType: pendingCashTxType,
    quantity: amount, price: 1, value: amount, fees: 0,
    note: note || cashTxLabel(pendingCashTxType)
  });
  appData.transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  closeCashTxModal();
  await savePositionsToKV();
  await refreshUI({ skipAI: true });
}
function openCashTxList() {
  const wrap = document.getElementById('cashTxListWrap');
  const txs = (appData?.transactions || []).filter(t => t.assetType === 'cash').slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (txs.length === 0) { wrap.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;font-size:12px;">Noch keine Cash-Bewegungen erfasst.</div>'; }
  else {
    wrap.innerHTML = txs.map(t => `
      <div class="cash-tx-item">
        <div class="cash-tx-meta">
          <div>${cashTxLabel(t.txType)}${t.accountImportSource === FLATEX_ACCOUNT_SOURCE ? ' · aus Kontoumsätze CSV' : ''}${t.sourceIncomeId ? ' · aus Erträge' : ''}${t.note ? ' · ' + escapeHtml(t.note) : ''}</div>
          <div class="cash-tx-date">${formatDateAT(t.date)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="cash-tx-val ${t.txType}">${isCashDebitType(t.txType) ? '−' : '+'}${fmt.format(t.value)}</span>
          <button class="cash-tx-del" data-cash-del="${t.id}" title="Löschen">×</button>
        </div>
      </div>`).join('');
  }
  document.getElementById('cashTxListModal').classList.add('active');
}
function closeCashTxList() { document.getElementById('cashTxListModal').classList.remove('active'); }
async function deleteCashTx(txId) {
  const tx = (appData.transactions || []).find(t => t.id === txId);
  if (tx?.sourceIncomeId) { alert('Diese Cash-Buchung gehört zu einem Ertrag. Bitte den Ertrag bearbeiten oder löschen.'); return; }
  if (!confirm('Diese Cash-Bewegung wirklich löschen?')) return;
  appData.transactions = (appData.transactions || []).filter(t => t.id !== txId);
  await savePositionsToKV();
  openCashTxList();
  await refreshUI({ skipAI: true });
}

async function saveMetalLotModal() {
  if (!pendingMetalKey) return;
  const metal = METALS.find(m => m.key === pendingMetalKey);
  if (!metal) return closeMetalLotModal();
  const date = document.getElementById('mlDate').value;
  const grams = parseFloat(String(document.getElementById('mlGrams').value).replace(',', '.'));
  const value = parseFloat(String(document.getElementById('mlValue').value).replace(',', '.'));
  const fees = parseFloat(String(document.getElementById('mlFees').value || '0').replace(',', '.'));
  const storage = document.getElementById('mlStorage').value;
  const valuation = document.getElementById('mlValuation').value;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { alert('Bitte gültiges Datum wählen.'); return; }
  if (!isFinite(grams) || grams <= 0) { alert('Bitte gültige Gramm-Zahl eingeben.'); return; }
  if (!isFinite(value) || value <= 0) { alert('Bitte gültigen Kaufwert eingeben.'); return; }
  const goalState = ensureGoal();
  if (!goalState.metalLots) goalState.metalLots = {};
  if (!Array.isArray(goalState.metalLots[metal.key])) goalState.metalLots[metal.key] = [];
  const lot = { date, grams, value };
  if (isFinite(fees) && fees > 0) lot.fees = fees;
  if (storage) lot.storage = storage;
  if (valuation) lot.valuation = valuation;
  goalState.metalLots[metal.key].push(lot);
  goalState.metalLots[metal.key].sort((a, b) => a.date.localeCompare(b.date));
  goalState[metal.gramsKey] = metalGrams(metal);
  // Transaktion ins zentrale Modell schreiben (Schema v2)
  if (!Array.isArray(appData.transactions)) appData.transactions = [];
  appData.transactions.push({
    id: makeTxId(), date, assetId: 'metal_' + metal.key, assetType: 'metal', txType: 'buy',
    quantity: grams, price: grams > 0 ? value / grams : 0, value, fees: fees > 0 ? fees : 0,
    note: storage ? ('Lager: ' + storage) : ''
  });
  appData.transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  closeMetalLotModal();
  await rerenderMetalsOpen();
}
async function deleteMetalLot(metalKey, index) {
  const metal = METALS.find(m => m.key === metalKey);
  const lots = metal ? metalLots(metal) : [];
  if (!metal || !lots[index]) return;
  if (!confirm(`${metal.name}-Kauf vom ${formatDateAT(lots[index].date)} löschen?`)) return;
  const lot = lots[index];
  ensureGoal().metalLots[metal.key].splice(index, 1);
  ensureGoal()[metal.gramsKey] = metalGrams(metal);
  // Auch korrespondierende Transaktion entfernen (Match per Datum + Gramm + Wert)
  if (Array.isArray(appData.transactions)) {
    const assetId = 'metal_' + metal.key;
    const idx = appData.transactions.findIndex(t =>
      t.assetId === assetId && t.txType === 'buy' && t.date === lot.date &&
      Math.abs(t.quantity - (lot.grams || 0)) < 1e-6 && Math.abs(t.value - (lot.value || 0)) < 0.01
    );
    if (idx >= 0) appData.transactions.splice(idx, 1);
  }
  await rerenderMetalsOpen();
}

function buildSpecialCard(kind, totals) {
  const wrap = document.createElement('div');
  wrap.className = 'card special';
  if (kind === 'metals') {
    const value = metalsTotalValue();
    const pct = totals && totals.totalCur > 0 ? (value / totals.totalCur) * 100 : 0;
    const gramsTotal = METALS.reduce((sum, metal) => sum + metalGrams(metal), 0);
    const sourceText = metalSourceSummary();
    const cacheHit = !!appData.goal?.metalPriceCache?.hit;
    const sourceBadge = appData.goal?.metalPriceUpdatedAt
      ? `<span class="risk-badge ${cacheHit ? 'risk-medium' : 'risk-low'}">${cacheHit ? 'CACHE' : 'LIVE'}</span>`
      : '<span class="risk-badge risk-medium">OFFEN</span>';
    wrap.id = 'card-metals';
    wrap.className = 'card special metals-details';
    wrap.innerHTML = `
      <details>
        <summary class="metals-summary">
          <div class="special-card-row">
            <div class="card-collapsed-left">
              <div class="card-name-row"><span class="card-name">Edelmetalle</span><span class="risk-badge risk-medium">MITTEL</span><span class="risk-badge risk-medium">SPOT</span>${sourceBadge}</div>
              <div class="card-meta-line">Gold · Silber · Platin · Palladium · <span class="pct-portfolio">${fmtNum(pct, 0)} % Portfolio</span></div>
              <div class="card-meta-line">${escapeHtml(sourceText)}</div>
            </div>
            <div class="card-pnl-mini">
              <div class="val" id="metalsTotalVal">${fmt.format(value)}</div>
              <div class="pct" id="metalsTotalGrams" style="color:#fbbf24;">${fmtNum(gramsTotal, 0)} g gesamt</div>
            </div>
            <div class="card-chevron"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></div>
          </div>
        </summary>
        <div class="metals-body">
          <div class="metals-toolbar">
            <div class="metal-meta">Aktualisiert nur Edelmetallkurse und Depot-Entwicklung</div>
            <button class="metals-refresh-btn" id="metalsRefreshBtn" type="button" title="Edelmetallkurse aktualisieren" aria-label="Edelmetallkurse aktualisieren">
              <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 14.85-6.85L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-14.85 6.85L3 16"/><path d="M3 21v-5h5"/></svg>
            </button>
          </div>
          ${buildMetalSourcePanel()}
          <div class="metals-progress" id="metalsProgress">
            <div class="metals-progress-row"><span id="metalsProgressText">Edelmetallkurse werden aktualisiert…</span><span id="metalsProgressEta">Noch ca. 10 Sek</span></div>
            <div class="metals-progress-bar"><div class="metals-progress-fill" id="metalsProgressFill"></div></div>
          </div>
          ${METALS.map(metal => {
            const grams = metalGrams(metal);
            const price = metalPrice(metal);
            const metalVal = grams * price;
            const locked = hasMetalLots(metal);
            return `
              <div class="metal-control" data-metal="${metal.key}">
                <div class="metal-control-head">
                  <div><span class="metal-title">${metal.name}</span><span class="metal-meta"> · ${fmtNum(price, 2)} €/g · ${escapeHtml(metalSourceShort(appData.goal?.metalPriceSources?.[metal.key]))} · <span id="${metal.key}Value">${fmt.format(metalVal)}</span></span></div>
                  <input type="number" class="metal-gram-input" id="${metal.key}GramsInput" min="0" max="${metal.max}" step="1" value="${fmtNum(grams, grams % 1 ? 3 : 0).replace(/\./g, '').replace(',', '.')}" aria-label="${metal.name} Gramm" ${locked ? 'disabled' : ''}>
                </div>
                <div class="special-slider-wrap ${metal.key}">
                  <span class="special-slider-min">0 g</span>
                  <input type="range" class="metal-slider" id="${metal.key}Slider" data-metal="${metal.key}" min="0" max="${metal.max}" step="1" value="${Math.min(metal.max, Math.round(grams))}" ${locked ? 'disabled' : ''}>
                  <span class="special-slider-val" id="${metal.key}SliderVal">${fmtNum(grams, grams % 1 ? 3 : 0)} g</span>
                </div>
                ${buildMetalLotsBlock(metal)}
              </div>`;
          }).join('')}
        </div>
      </details>`;
  } else {
    const hasCashTx = Array.isArray(appData.transactions) && appData.transactions.some(t => t.assetType === 'cash');
    const computed = hasCashTx ? getCashBalance() : null;
    const cash = hasCashTx ? computed : (appData.goal?.cash || 0);
    const accountStats = hasCashTx ? accountImportCashStats() : { cashRows: 0, depositRows: 0, orderRows: 0, latest: '' };
    const pct = totals && totals.totalCur > 0 ? (cash / totals.totalCur) * 100 : 0;
    wrap.id = 'card-cash';
    const lastCashMove = latestCashMovementDate();
    const cashBasisText = hasCashTx
      ? `Cash-Kassenbuch aktiv${lastCashMove ? ' · letzte Bewegung ' + formatDateAT(lastCashMove) : ''}`
      : 'Noch keine Cash-Bewegung erfasst · Saldo-Korrektur startet das Kassenbuch';
    const cashStatusText = hasCashTx
      ? `Berechnet aus Bewegungen, Erträgen und Orderabgleich${cash < 0 ? ' · negativer Saldo zieht den Depotwert ab' : ''}`
      : 'Legacy-Startwert wird bis zur ersten Bewegung weiter berücksichtigt';
    const balanceHtml = `
      <div class="cash-balance-panel">
        <div>
          <div class="cash-balance-kicker">Cash-Saldo</div>
          <div class="cash-balance-value">${fmt.format(cash)}</div>
          <div class="cash-balance-meta">${escapeHtml(cashBasisText)}<br>${escapeHtml(cashStatusText)}</div>
        </div>
        <button class="cash-tx-btn cash-reconcile-btn" id="cashReconcileBtn" type="button">Saldo korrigieren</button>
      </div>`;
    wrap.innerHTML = `
      <div class="special-card-row">
        <div class="card-collapsed-left">
          <div class="card-name-row"><span class="card-name">Cash</span><span class="risk-badge risk-low">NIEDRIG</span>${hasCashTx ? '<span class="risk-badge risk-low">AUS TX</span>' : ''}</div>
          <div class="card-meta-line">Bargeld · Verrechnungskonto · <span class="pct-portfolio">${fmtNum(pct, 0)} % Portfolio</span></div>
        </div>
        <div class="card-pnl-mini">
          <div class="val">${fmt.format(cash)}</div>
          <div class="pct" style="color:#666;">Reserve</div>
        </div>
        <div class="card-chevron"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></div>
      </div>
      ${balanceHtml}
      <div class="cash-tx-toolbar">
        <button class="cash-tx-btn" id="cashAddDepositBtn" type="button">+ Einzahlung</button>
        <button class="cash-tx-btn" id="cashAddWithdrawBtn" type="button">− Auszahlung</button>
        <button class="cash-tx-btn" id="cashAddFeeBtn" type="button">− Gebühr</button>
        <button class="cash-tx-btn" id="cashAddTaxBtn" type="button">− Steuer</button>
        <button class="cash-tx-btn cash-tx-list" id="cashShowTxBtn" type="button">Bewegungen</button>
      </div>
      <div class="cash-tx-hint">Dividenden, Ausschüttungen, Zinsen und Staking werden im Erträge-Bereich erfasst und automatisch ins Cash-Kassenbuch gespiegelt.</div>`;
    if (accountStats.cashRows || accountStats.orderRows) {
      wrap.innerHTML += `<div class="cash-tx-hint">Kontoumsätze CSV aktiv: ${accountStats.cashRows} Cash-Bewegung${accountStats.cashRows === 1 ? '' : 'en'} sichtbar unter „Bewegungen“ · davon ${accountStats.depositRows} Einzahlung${accountStats.depositRows === 1 ? '' : 'en'} · ${accountStats.orderRows} Order${accountStats.orderRows === 1 ? '' : 's'} mit echtem Konto-Cash abgeglichen${accountStats.latest ? ' · letzter Kontotag ' + formatDateAT(accountStats.latest) : ''}.</div>`;
      if (accountStats.orderRows && !accountStats.depositRows) {
        wrap.innerHTML += '<div class="cash-tx-hint" style="color:var(--negative);">Kontoumsatz-Import unvollständig: Es sind Orders abgeglichen, aber keine Einzahlungen importiert. Bitte „Kontoumsätze CSV“ erneut übernehmen.</div>';
      }
    }
  }
  return wrap;
}

let renderExpandedRestore = new Set();
function getPositionsVisibleCards() {
  try {
    const saved = Number(localStorage.getItem(POSITIONS_HEIGHT_KEY));
    if (Number.isFinite(saved)) return Math.max(POSITIONS_VISIBLE_MIN, Math.min(POSITIONS_VISIBLE_MAX, Math.round(saved)));
  } catch (e) {}
  return POSITIONS_VISIBLE_DEFAULT;
}
function setPositionsVisibleCards(value) {
  const next = Math.max(POSITIONS_VISIBLE_MIN, Math.min(POSITIONS_VISIBLE_MAX, Math.round(value)));
  try { localStorage.setItem(POSITIONS_HEIGHT_KEY, String(next)); } catch (e) {}
  updatePositionsSizeControls();
  requestAnimationFrame(updatePositionsScrollLimit);
}
function updatePositionsSizeControls() {
  const visibleCards = getPositionsVisibleCards();
  const label = document.getElementById('positionsSizeLabel');
  if (label) label.textContent = `${visibleCards} Karte${visibleCards === 1 ? '' : 'n'}`;
  document.querySelectorAll('[data-pos-size="down"]').forEach(btn => { btn.disabled = visibleCards <= POSITIONS_VISIBLE_MIN; });
  document.querySelectorAll('[data-pos-size="up"]').forEach(btn => { btn.disabled = visibleCards >= POSITIONS_VISIBLE_MAX; });
}
function collapsedCardHeight(card) {
  const row = card?.querySelector?.('.card-collapsed-row, .special-card-row, .metals-summary');
  if (!row) return card?.getBoundingClientRect?.().height || 0;
  const cardStyle = getComputedStyle(card);
  const paddingY = (parseFloat(cardStyle.paddingTop) || 0) + (parseFloat(cardStyle.paddingBottom) || 0);
  return row.getBoundingClientRect().height + paddingY;
}
function updatePositionsScrollLimit() {
  const container = document.getElementById('positions');
  if (!container) return;
  const cards = [...container.children].filter(el => el.classList?.contains('card'));
  const visibleCards = getPositionsVisibleCards();
  updatePositionsSizeControls();
  if (cards.length <= visibleCards) {
    container.classList.remove('positions-list-scroll');
    container.style.maxHeight = '';
    return;
  }
  const styles = getComputedStyle(container);
  const gap = parseFloat(styles.rowGap || styles.gap || '10') || 10;
  const visibleHeight = cards.slice(0, visibleCards).reduce((sum, card) => sum + collapsedCardHeight(card), 0) + gap * Math.max(0, visibleCards - 1) + 8;
  container.classList.add('positions-list-scroll');
  container.style.maxHeight = `${Math.ceil(Math.max(280, visibleHeight))}px`;
}
function renderPositions(totals) {
  const container = document.getElementById('positions');
  // Expand-State der bisherigen Karten merken
  const wasExpanded = new Set([...renderExpandedRestore]);
  const metalsWasOpen = !!container.querySelector('#card-metals details[open]');
  container.querySelectorAll('.card.expanded').forEach(c => { if (c.dataset.posId) wasExpanded.add(c.dataset.posId); });
  renderExpandedRestore = new Set();
  container.innerHTML = '';
  // Wenn totals nicht übergeben, berechnen
  if (!totals) {
    let totalCur = 0;
    getAllPositions().forEach(pos => {
      const live = currentPrices[pos.id] || { price: pos.manualPrice ?? pos.costPrice };
      totalCur += getPositionValuation(pos, live).currentValue;
    });
    totals = { totalCur };
  }
  const alloc = getCategoryAllocation(totals.totalCur);
  const current = currentPortfolioPositions();
  if (current.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state positions-empty-state';
    empty.innerHTML = `
      <strong>Noch keine Wertpapier-Positionen</strong>
      <p>Starte mit einer manuellen Position, einem Screenshot oder einer Flatex-Depotumsatz-CSV. Edelmetalle und Cash bleiben darunter separat verfügbar.</p>
      <div class="empty-actions">
        <button type="button" class="empty-action-btn" data-empty-action="manual">Manuell eingeben</button>
        <button type="button" class="empty-action-btn primary" data-empty-action="screenshot">Screenshot &amp; KI</button>
        <button type="button" class="empty-action-btn" data-empty-action="depotCsv">Depotumsätze CSV</button>
      </div>`;
    container.appendChild(empty);
  }
  current.forEach(pos => container.appendChild(buildCard(pos, totals, alloc)));
  // Edelmetalle + Cash immer als Karten unten (auch bei 0, damit Slider verfügbar sind)
  container.appendChild(buildSpecialCard('metals', totals));
  container.appendChild(buildSpecialCard('cash', totals));
  const positionsSummary = document.getElementById('positionsSummaryMeta');
  if (positionsSummary) {
    positionsSummary.textContent = `${current.length} Titel · ${fmt.format(totals.marketValue || totals.totalCur || 0)} an der Börse`;
  }
  requestAnimationFrame(updatePositionsScrollLimit);
  if (metalsWasOpen) {
    const metalsDetails = container.querySelector('#card-metals details');
    if (metalsDetails) metalsDetails.open = true;
  }
  // Expand-State wiederherstellen + Charts ggf. neu laden
  wasExpanded.forEach(id => {
    const c = container.querySelector(`.card[data-pos-id="${id}"]`);
    if (c) {
      c.classList.add('expanded');
      const pos = appData.positions.find(p => p.id === id);
      if (pos) loadChartForPosition(pos, chartTabState[id] || 'week');
    }
  });
  applyLayoutSettings();
}

function renderTotals() {
  pruneExpiredManualQuoteOverrides();
  let totalCur = 0, totalCost = 0, todayChangeEur = 0, hasChangeData = false;
  currentPortfolioPositions().forEach(pos => {
    const live = currentPrices[pos.id] || { price: pos.costPrice };
    const valuation = getPositionValuation(pos, live);
    totalCur += valuation.currentValue;
    totalCost += valuation.costValue;
    const todayMove = getPositionTodayChange(pos, live);
    if (todayMove) {
      todayChangeEur += todayMove.eur;
      hasChangeData = true;
    }
  });
  // Börsenwert separat ausweisen; Gesamtwert bleibt inklusive Edelmetalle und Cash.
  const marketValue = totalCur;
  const marketCost = totalCost;
  const marketPnl = marketValue - marketCost;
  const marketPnlPct = marketCost > 0 ? (marketPnl / marketCost) * 100 : 0;
  const metalValueTotal = metalsTotalValue();
  const metalCostTotal = metalsTotalCost();
  const cashValue = currentCashValue();

  totalCur += metalValueTotal + cashValue;
  totalCost += metalCostTotal + cashValue;
  const totalPnl = totalCur - totalCost;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

  const marketValueEl = document.getElementById('marketValue');
  const marketPnlEl = document.getElementById('marketPnl');
  if (marketValueEl) marketValueEl.textContent = fmt.format(marketValue);
  if (marketPnlEl) {
    marketPnlEl.textContent = `${marketPnl >= 0 ? '+' : ''}${fmt.format(marketPnl)} (${fmtNum(marketPnlPct)} %)`;
    marketPnlEl.className = 'market-pnl ' + (marketPnl >= 0 ? 'positive' : 'negative');
  }

  document.getElementById('totalValue').textContent = fmt.format(totalCur);
  const pnlEl = document.getElementById('totalPnl');
  pnlEl.textContent = `${totalPnl >= 0 ? '+' : ''}${fmt.format(totalPnl)} (${fmtNum(totalPnlPct)} %)`;
  pnlEl.className = 'total-pnl ' + (totalPnl >= 0 ? 'positive' : 'negative');
  document.getElementById('costSummary').textContent = `Einstand: ${fmt.format(totalCost)} · Edelmetalle: ${fmt.format(metalValueTotal)}`;
  document.getElementById('lastUpdate').textContent = `Stand: ${new Date().toLocaleString('de-AT')}`;

  // === Stat-Kacheln: Heute ===
  const todayTile = document.getElementById('statToday');
  const todayVal = document.getElementById('statTodayValue');
  const todaySub = document.getElementById('statTodaySub');
  if (hasChangeData) {
    const todayPct = marketValue > 0 ? (todayChangeEur / (marketValue - todayChangeEur)) * 100 : 0;
    const cls = todayChangeEur >= 0 ? 'pos' : 'neg';
    const color = todayChangeEur >= 0 ? 'var(--positive)' : 'var(--negative)';
    todayTile.className = 'stat-tile ' + cls;
    todayVal.style.color = color;
    todayVal.textContent = `${todayChangeEur >= 0 ? '+' : ''}${fmt.format(todayChangeEur)}`;
    todaySub.style.color = color;
    todaySub.textContent = `${todayChangeEur >= 0 ? '+' : ''}${fmtNum(todayPct, 2)} %`;
  } else {
    todayTile.className = 'stat-tile neutral';
    todayVal.style.color = 'var(--text-primary)';
    todayVal.textContent = '—';
    todaySub.style.color = 'var(--text-tertiary)';
    todaySub.textContent = 'keine 24h-Daten';
  }

  // === Stat-Kacheln: Drawdown vom ATH ===
  if (!appData.goal) appData.goal = {};
  const prevAth = appData.goal.athTotal || 0;
  let athUpdated = false;
  if (totalCur > prevAth) {
    appData.goal.athTotal = totalCur;
    appData.goal.athTotalDate = new Date().toISOString().slice(0, 10);
    athUpdated = true;
  }
  const ath = appData.goal.athTotal || totalCur;
  const athDate = appData.goal.athTotalDate ? new Date(appData.goal.athTotalDate) : new Date();
  const drawdownPct = ath > 0 ? ((totalCur - ath) / ath) * 100 : 0;
  const ddTile = document.getElementById('statDrawdown');
  const ddVal = document.getElementById('statDrawdownValue');
  const ddSub = document.getElementById('statDrawdownSub');
  if (drawdownPct >= -0.05) {
    ddTile.className = 'stat-tile pos';
    ddVal.style.color = 'var(--positive)';
    ddVal.textContent = 'ATH';
    ddSub.style.color = 'var(--positive)';
    ddSub.textContent = `${fmt.format(ath)} · jetzt`;
  } else {
    ddTile.className = 'stat-tile neg';
    ddVal.style.color = 'var(--negative)';
    ddVal.textContent = `${fmtNum(drawdownPct, 1)} %`;
    ddSub.style.color = 'var(--text-tertiary)';
    ddSub.textContent = `ATH ${fmt.format(ath)} · ${athDate.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' })}`;
  }
  if (athUpdated) savePositionsToKV(2000);

  // === Stat-Kachel: Sparrate (gespiegelt vom Slider) ===
  const savingsRate = appData.goal && appData.goal.savingsRate != null ? appData.goal.savingsRate : 0;
  const savingsEl = document.getElementById('statSavingsValue');
  if (savingsEl) savingsEl.textContent = savingsRate > 0 ? fmtNoCent.format(savingsRate) : '0 €';

  return { totalCur, totalCost, totalPnl, totalPnlPct, marketValue, marketCost, marketPnl, marketPnlPct, todayChangeEur, hasChangeData, ath, drawdownPct, savingsRate };
}

async function refreshLiveValuesOnly() {
  if (!appData || refreshProgressState) return;
  startRefreshProgress();
  try {
    await Promise.all([
      fetchCryptoPrices(),
      fetchAllCryptoHistories(370),
      fetchMarketPrices({ forceRefresh: true }),
      fetchMarketHistory(370),
      fetchMetalPrices({ showProgress: true }),
      fetchMetalHistory(365)
    ]);
    await fetchAllWeeklyCharts();
    const totals = renderTotals();
    renderPositions(totals);
    renderHistory();
    const alloc = renderAllocation(totals);
    const goal = renderGoal(totals);
    renderPortfolioAlerts(totals, goal, alloc);
    renderTaxPerformance(totals);
    applyLayoutSettings();
    await savePositionsToKV(800);
    completeRefreshProgress(true);
  } catch (e) {
    console.warn('Live refresh failed:', e);
    completeRefreshProgress(false);
  }
}

function toIsoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function addDays(d, days) {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}
function historyStartDate(period, today) {
  const start = new Date(today);
  if (period === '1W') start.setDate(today.getDate() - 6);
  else if (period === '6M') start.setMonth(today.getMonth() - 6);
  else start.setMonth(today.getMonth() - 12);
  return start;
}
function isTodayHistoryPeriod(period) { return period === 'TODAY'; }
function isFutureHistoryPeriod(period) { return period === '+1W' || period === '+1M' || period === '+1J'; }
function currentPortfolioHistoryTotal() {
  let total = 0;
  currentPortfolioPositions().forEach(pos => {
    const live = currentPrices[pos.id] || { price: pos.costPrice };
    total += getPositionValuation(pos, live).currentValue;
  });
  return total + metalsTotalValue() + currentCashValue();
}
function buildPortfolioProjection(period) {
  const today = new Date();
  const end = new Date(today);
  if (period === '+1W') end.setDate(today.getDate() + 7);
  else if (period === '+1M') end.setMonth(today.getMonth() + 1);
  else end.setFullYear(today.getFullYear() + 1);
  const startValue = currentPortfolioHistoryTotal();
  const startInvested = getInvestedCapital();
  const startNet = getNetExternalContributions();
  const cash = currentCashValue();
  const savingsRate = Number(appData?.goal?.savingsRate || 0);
  const annualReturnPct = Number(appData?.goal?.annualReturnPct || 0);
  const points = [];
  const totalDays = Math.max(1, Math.round((end - today) / 86400000));
  for (let step = 0; step <= totalDays; step += 1) {
    const date = addDays(today, step);
    const monthsAhead = step / 30.44;
    const contribution = savingsRate * monthsAhead;
    const projectedValue = futureValueWithMonthlySavings(startValue, savingsRate, monthsAhead, annualReturnPct);
    const projectedInvested = startInvested + contribution;
    const label = period === '+1W' || period === '+1M'
      ? String(date.getDate()).padStart(2, '0') + '.'
      : MONTHS_SHORT[date.getMonth()];
    const labelLong = `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
    points.push({
      date,
      label,
      labelLong: step === 0 ? `${labelLong} (heute)` : `${labelLong} (Projektion)`,
      value: projectedValue,
      invested: projectedInvested,
      netContributions: startNet + contribution,
      cash,
      pnl: projectedValue - projectedInvested,
      quality: historyDataQualityForDate(date, step === 0, true),
      events: step === 0 ? ['Start der Projektion'] : [],
      historyNote: `Sparpfad-Projektion mit ${fmt.format(savingsRate)}/Monat und ${fmtNum(annualReturnPct, 1)}% p.a. Zielannahme`
    });
  }
  return points;
}
function quoteUpdateDateForToday(live, fallbackDate) {
  const todayIso = toIsoDate(new Date());
  const parsed = live?.updatedAt ? new Date(live.updatedAt) : null;
  if (parsed && !isNaN(parsed.getTime()) && toIsoDate(parsed) === todayIso) return parsed;
  return fallbackDate || new Date();
}
function buildTodayPortfolioHistory() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const invested = getInvestedCapital(now);
  const netContributions = getNetExternalContributions(now);
  const cash = currentCashValue();
  let baseValue = metalsTotalValue() + cash;
  const changes = [];
  currentPortfolioPositions().forEach(pos => {
    const live = currentPrices[pos.id] || { price: pos.manualPrice ?? pos.costPrice };
    const valuation = getPositionValuation(pos, live);
    const move = getPositionTodayChange(pos, live);
    if (move && Number.isFinite(move.eur)) {
      baseValue += valuation.currentValue - move.eur;
      changes.push({
        time: quoteUpdateDateForToday(live, now),
        eur: move.eur,
        name: pos.name,
        pct: move.pct,
      });
    } else {
      baseValue += valuation.currentValue;
    }
  });

  const quality = {
    level: 'exact',
    label: 'Heute',
    score: 1,
    note: 'Tagesbewegung aus aktuellem Kurs und Previous-Close/24h-Wert',
  };
  const points = [{
    date: start,
    label: 'Start',
    labelLong: 'Heute Start / Vortagswert',
    value: baseValue,
    invested,
    netContributions,
    cash,
    pnl: baseValue - invested,
    quality,
    events: [],
    intraday: true,
    historyNote: 'Startwert aus Vortagsschluss beziehungsweise 24h-Ausgangswert'
  }];

  changes
    .sort((a, b) => a.time.getTime() - b.time.getTime())
    .reduce((groups, item) => {
      const key = `${String(item.time.getHours()).padStart(2, '0')}:${String(item.time.getMinutes()).padStart(2, '0')}`;
      if (!groups.has(key)) groups.set(key, { time: item.time, items: [] });
      groups.get(key).items.push(item);
      return groups;
    }, new Map())
    .forEach(group => {
      const delta = group.items.reduce((sum, item) => sum + item.eur, 0);
      baseValue += delta;
      const label = `${String(group.time.getHours()).padStart(2, '0')}:${String(group.time.getMinutes()).padStart(2, '0')}`;
      const shown = group.items
        .sort((a, b) => Math.abs(b.eur) - Math.abs(a.eur))
        .slice(0, 3)
        .map(item => `${item.name}: ${item.eur >= 0 ? '+' : ''}${fmt.format(item.eur)}`);
      points.push({
        date: new Date(group.time),
        label,
        labelLong: `Heute ${label}`,
        value: baseValue,
        invested,
        netContributions,
        cash,
        pnl: baseValue - invested,
        quality,
        events: shown,
        intraday: true,
        historyNote: `${group.items.length} Kursbewegung${group.items.length === 1 ? '' : 'en'} eingerechnet`
      });
    });

  if (points.length === 1 || points[points.length - 1].date.getTime() !== now.getTime()) {
    points.push({
      date: now,
      label: 'Jetzt',
      labelLong: `Heute ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} (jetzt)`,
      value: currentPortfolioHistoryTotal(),
      invested,
      netContributions,
      cash,
      pnl: currentPortfolioHistoryTotal() - invested,
      quality,
      events: [],
      intraday: true,
      historyNote: 'Aktueller Depotstand'
    });
  }
  return points;
}
function historyApproximationForPosition(pos) {
  if (!pos || pos.special) return '';
  if (Array.isArray(pos.dailyHistory) && pos.dailyHistory.length > 20) return pos.dailyHistoryFxApproximate ? 'Tageskurs mit aktueller FX-Näherung' : '';
  if (isCryptoPos(pos)) return Array.isArray(weeklyData[pos.id]) && weeklyData[pos.id].length > 1 ? 'Krypto-Historie nur im Wochenbereich verfügbar' : 'aktueller oder Einstandskurs';
  if (Array.isArray(pos.monthlyHistory) && pos.monthlyHistory.length > 0) return 'Monatskurs';
  return 'aktueller oder Einstandskurs';
}
function historyApproximationNote(date, isToday) {
  if (isToday) return '';
  const approx = (appData?.positions || [])
    .filter(pos => !pos.special)
    .map(pos => ({ name: qualityPositionName(pos), basis: historyApproximationForPosition(pos) }))
    .filter(item => item.basis);
  if (approx.length === 0) return '';
  const shown = approx.slice(0, 3).map(item => `${item.name}: ${item.basis}`).join(', ');
  return `Kursbasis teils angenähert: ${shown}${approx.length > 3 ? ' ...' : ''}`;
}
function dailyHistoryPriceAtDate(pos, date) {
  if (!Array.isArray(pos?.dailyHistory) || pos.dailyHistory.length === 0) return null;
  const iso = toIsoDate(date);
  let matched = null;
  for (const point of pos.dailyHistory) {
    if (!point?.date || Number(point.price) <= 0) continue;
    if (point.date <= iso) matched = point;
    else break;
  }
  return matched ? Number(matched.price) : null;
}
function priceForHistoryDate(pos, date, isToday) {
  if (isToday) return (currentPrices[pos.id] || { price: pos.costPrice }).price;
  const daily = dailyHistoryPriceAtDate(pos, date);
  if (daily > 0) return daily;
  if (pos.monthlyHistory) {
    const ym = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
    const sorted = pos.monthlyHistory.slice().sort((a, b) => a.date.localeCompare(b.date));
    let matched = null;
    for (const e of sorted) { if (e.date <= ym) matched = e; }
    if (!matched && sorted.length > 0) matched = sorted[0];
    return matched ? matched.price : pos.costPrice;
  }
  return (currentPrices[pos.id] || { price: pos.costPrice }).price;
}
function historyDataQualityForDate(date, isToday, futureProjection = false) {
  if (futureProjection) return { level: 'projection', label: 'Projektion', note: 'Sparpfad mit Ziel-Renditeannahme' };
  const active = (appData?.positions || []).filter(pos => !pos.special && sharesAtDate(pos, date) > 0);
  if (active.length === 0) return { level: 'exact', label: 'Keine aktiven Titel', note: 'Keine aktiven Titel an diesem Tag' };
  if (isToday) return { level: 'exact', label: 'Aktuelle Live-/Quellwerte', note: 'Aktuelle Bewertung aus Live-/Quellwerten' };
  let exact = 0, dailyFx = 0, monthly = 0, weak = 0, scoreTotal = 0;
  const causes = { dailyFx: [], monthly: [], weak: [] };
  const addCause = (key, name) => {
    if (!causes[key].includes(name)) causes[key].push(name);
  };
  active.forEach(pos => {
    const name = qualityPositionName(pos);
    if (dailyHistoryPriceAtDate(pos, date) > 0) {
      if (pos.dailyHistoryFxApproximate) {
        dailyFx++;
        scoreTotal += 0.9;
        addCause('dailyFx', name);
      } else {
        exact++;
        scoreTotal += 1;
      }
    } else if (Array.isArray(pos.monthlyHistory) && pos.monthlyHistory.length > 0) {
      monthly++;
      scoreTotal += 0.7;
      addCause('monthly', name);
    } else {
      weak++;
      scoreTotal += 0.25;
      addCause('weak', name);
    }
  });
  const approx = dailyFx + monthly;
  const level = weak > 0 ? 'weak' : approx > 0 ? 'approx' : 'exact';
  const label = level === 'weak'
    ? 'Ersatzkurse aktiv'
    : level === 'approx'
      ? 'Näherungen aktiv'
      : 'Tageskurse';
  const causeParts = [];
  if (causes.dailyFx.length) causeParts.push(`FX-Näherung: ${causes.dailyFx.slice(0, 3).join(', ')}${causes.dailyFx.length > 3 ? ' ...' : ''}`);
  if (causes.monthly.length) causeParts.push(`Monatskurs: ${causes.monthly.slice(0, 3).join(', ')}${causes.monthly.length > 3 ? ' ...' : ''}`);
  if (causes.weak.length) causeParts.push(`Ersatzkurs: ${causes.weak.slice(0, 3).join(', ')}${causes.weak.length > 3 ? ' ...' : ''}`);
  const note = causeParts.length
    ? `${label}: ${causeParts.join(' · ')}`
    : `${label}: ${exact} von ${active.length} aktiven Titeln mit Tageskursen`;
  return { level, label, note, exact, approx, dailyFx, monthly, weak, total: active.length, score: scoreTotal / active.length, causes };
}
function summarizeHistoryQuality(points, futureProjection) {
  if (!points || points.length === 0) return { level: 'weak', pct: 0, text: 'Datenqualität: —', basis: 'Keine Verlaufspunkte verfügbar', events: 0 };
  if (points[0]?.intraday) {
    return {
      level: 'exact',
      pct: 100,
      text: 'Heute',
      basis: 'Tagesbewegung aus aktuellen Kursen und Previous-Close/24h-Werten',
      events: points.reduce((s, p) => s + ((p.events || []).length), 0)
    };
  }
  if (futureProjection) {
    return {
      level: 'projection',
      pct: null,
      text: 'Projektion',
      basis: 'Sparpfad mit aktueller Sparrate und Ziel-Renditeannahme, keine echte Kursprognose',
      events: points.reduce((s, p) => s + ((p.events || []).length), 0)
    };
  }
  let score = 0, exactDays = 0, approxDays = 0, weakDays = 0;
  points.forEach(p => {
    const level = p.quality?.level || 'weak';
    if (level === 'exact') exactDays++;
    else if (level === 'approx') approxDays++;
    else weakDays++;
    score += Number.isFinite(p.quality?.score)
      ? p.quality.score
      : level === 'exact'
        ? 1
        : level === 'approx'
          ? 0.7
          : 0.25;
  });
  const pct = Math.round((score / points.length) * 100);
  const level = weakDays > 0 ? 'weak' : approxDays > 0 ? 'approx' : 'exact';
  const text = `Datenqualität: ${pct}/100`;
  const basis = `${exactDays} Tage mit Tagesdaten · ${approxDays} Tage mit Näherung · ${weakDays} Tage mit Ersatzkursen`;
  const events = points.reduce((s, p) => s + ((p.events || []).length), 0);
  return { level, pct, text, basis, events };
}
function buildHistoryQualityRows(points, summary, futureProjection) {
  if (points?.[0]?.intraday) {
    return [
      { title: 'Heute-Ansicht', text: 'Die App nimmt den Vortags- beziehungsweise 24h-Ausgangswert als Start und rechnet danach die heute bekannten Kursbewegungen der aktuellen Positionen in den Depotwert ein.' },
      { title: 'Wichtig zur Genauigkeit', text: 'Das ist keine tickgenaue Intraday-Kurve vom Broker. Sie zeigt die heute bekannte Depotbewegung anhand der Livequelle, Previous-Close-Werte und Aktualisierungszeitpunkte.' }
    ];
  }
  if (futureProjection) {
    return [
      { title: 'Zukunftsansicht', text: 'Diese Ansicht ist eine Sparpfad-Projektion. Sie nutzt deine aktuelle Sparrate und die Renditeannahme aus dem Zielbereich. Das ist ein Planungsszenario, keine Kursvorhersage.' },
      { title: 'Warum kein 100/100?', text: 'Bei Projektionen bewertet die App nicht die historische Datenqualität, sondern zeigt, wie sich dein Depot bei gleichbleibenden Annahmen rechnerisch entwickeln würde.' }
    ];
  }
  if (!points || points.length === 0) {
    return [{ title: 'Keine Verlaufspunkte', text: 'Für den gewählten Zeitraum konnte kein Verlauf aufgebaut werden.' }];
  }

  const exactDays = points.filter(p => p.quality?.level === 'exact').length;
  const approxDays = points.filter(p => p.quality?.level === 'approx').length;
  const weakDays = points.filter(p => p.quality?.level === 'weak').length;
  const causeStats = {
    dailyFx: { days: 0, names: new Set() },
    monthly: { days: 0, names: new Set() },
    weak: { days: 0, names: new Set() }
  };
  points.forEach(p => {
    ['dailyFx', 'monthly', 'weak'].forEach(key => {
      const names = p.quality?.causes?.[key] || [];
      if (names.length > 0) {
        causeStats[key].days++;
        names.forEach(name => causeStats[key].names.add(name));
      }
    });
  });
  const listNames = set => {
    const names = Array.from(set).filter(Boolean);
    return `${names.slice(0, 6).join(', ')}${names.length > 6 ? ' ...' : ''}`;
  };
  const rows = [
    { title: 'So wird der Score berechnet', text: `Der Zeitraum enthält ${points.length} Tagespunkte: ${exactDays} vollständig, ${approxDays} mit Näherung und ${weakDays} mit Ersatzkursen. Die App bewertet jeden Tag nach den betroffenen Positionen: echte Tagesdaten zählen voll, FX-Näherungen fast voll, Monatskurse teilweise und Ersatzkurse deutlich schwächer.` }
  ];

  if (summary.pct >= 100) {
    rows.push({ title: 'Alles sauber', text: 'Für den gewählten Zeitraum liegen genügend Tagesdaten vor. Die Depot-Entwicklung ist dadurch besonders belastbar.' });
    return rows;
  }

  if (causeStats.dailyFx.days > 0) {
    rows.push({ title: 'Tageskurse mit Währungs-Näherung', text: `An ${causeStats.dailyFx.days} Tagen gibt es echte Tageskurse, aber die EUR-Umrechnung ist angenähert. Das ist meist nahe am Verlauf und wird nur leicht abgezogen. Betroffen: ${listNames(causeStats.dailyFx.names)}.` });
  }
  if (causeStats.monthly.days > 0) {
    rows.push({ title: 'Monatskurse statt Tageskurse', text: `An ${causeStats.monthly.days} Tagen fehlen für mindestens eine Position echte Tageskurse. Die App nutzt dann Monatswerte. Betroffen: ${listNames(causeStats.monthly.names)}.` });
  }
  if (causeStats.weak.days > 0) {
    rows.push({ title: 'Ersatzkurse drücken den Score stark', text: `An ${causeStats.weak.days} Tagen fehlen für mindestens eine Position historische Tages- und Monatskurse. Dann nutzt die App ersatzweise aktuelle, manuelle oder ältere Kursbasen. Betroffen: ${listNames(causeStats.weak.names)}.` });
  }

  rows.push({ title: 'Wie kommst du näher an 100/100?', text: 'Am meisten hilft eine vollständige CSV-Historie mit Käufen/Verkäufen und möglichst vielen historischen Kursdaten. Zusätzlich sollten Symbol, ISIN/WKN und Kursquelle je aktueller Position stimmen.' });
  return rows;
}
function closeHistoryQualityModal() {
  document.getElementById('historyQualityModal')?.classList.remove('active');
}
function openHistoryQualityModal() {
  if (!appData) return;
  const points = buildPortfolioHistory(currentHistoryPeriod);
  const futureProjection = isFutureHistoryPeriod(currentHistoryPeriod);
  const summary = summarizeHistoryQuality(points, futureProjection);
  const intro = document.getElementById('historyQualityIntro');
  const details = document.getElementById('historyQualityDetails');
  if (intro) {
    intro.textContent = futureProjection
      ? 'Diese Erklärung bezieht sich auf die aktive Zukunftsansicht.'
      : summary.pct >= 100
        ? 'Der Verlauf erreicht 100/100. Hier siehst du trotzdem, warum die Bewertung so gut ist.'
        : `Der Verlauf erreicht ${summary.pct}/100. Hier siehst du, was den Score im gewählten Zeitraum senkt.`;
  }
  if (details) {
    details.innerHTML = buildHistoryQualityRows(points, summary, futureProjection)
      .map(row => `<div class="history-quality-detail"><strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.text)}</span></div>`)
      .join('');
  }
  document.getElementById('historyQualityModal')?.classList.add('active');
}
function purchaseEventsForDate(date) {
  const iso = toIsoDate(date);
  const events = [];
  // Primär aus Transaktionsmodell (Schema v2) — zeigt Buys, Sells und Cash-Bewegungen
  if (Array.isArray(appData?.transactions) && appData.transactions.length > 0) {
    const dayTxs = appData.transactions.filter(t => (t.assetType === 'cash' ? cashEffectiveDate(t) : t.date) === iso);
    dayTxs.forEach(t => {
      const pos = appData.positions.find(p => p.id === t.assetId);
      const metalKey = t.assetId && t.assetId.startsWith('metal_') ? t.assetId.slice(6) : null;
      const metal = metalKey ? METALS.find(m => m.key === metalKey) : null;
      const name = pos ? pos.name : (metal ? metal.name : (t.assetId === 'cash' ? 'Cash' : t.assetId));
      const unit = metal ? 'g' : 'Stk';
      const qty = fmtNum(t.quantity, t.quantity % 1 ? (metal ? 3 : 6) : 0);
      if (t.txType === 'buy') events.push(`Kauf: ${name} · ${qty} ${unit} · ${fmt.format(t.value)}`);
      else if (t.txType === 'sell') events.push(`Verkauf: ${name} · ${qty} ${unit} · ${fmt.format(t.value)}`);
      else if (t.txType === 'deposit' && t.assetType === 'cash') events.push(`Einzahlung: ${fmt.format(t.value)}`);
      else if (t.txType === 'withdraw' && t.assetType === 'cash') events.push(`Auszahlung: ${fmt.format(t.value)}`);
      else if (t.assetType === 'cash' && isCashCreditType(t.txType)) events.push(`${cashTxLabel(t.txType)}: ${fmt.format(t.value)}`);
      else if (t.assetType === 'cash' && isCashDebitType(t.txType)) events.push(`${cashTxLabel(t.txType)}: −${fmt.format(t.value)}`);
    });
    if (events.length > 0) return events;
  }
  // Fallback auf alte Lots
  appData.positions.forEach(pos => {
    (pos.purchaseLots || []).forEach(lot => {
      if (lot.date === iso) events.push(`Kauf: ${pos.name} · ${fmtNum(lot.shares, lot.shares % 1 ? 6 : 0)} Stk · ${fmt.format(lot.value || lot.shares * lot.costPrice)}`);
    });
  });
  METALS.forEach(metal => {
    metalLots(metal).forEach(lot => {
      if (lot.date === iso) events.push(`Kauf: ${metal.name} · ${fmtNum(lot.grams, lot.grams % 1 ? 3 : 0)} g · ${fmt.format(lot.value)}`);
    });
  });
  return events;
}
function buildPortfolioHistory(period) {
  if (isTodayHistoryPeriod(period)) return buildTodayPortfolioHistory();
  if (isFutureHistoryPeriod(period)) return buildPortfolioProjection(period);
  const today = new Date();
  const start = historyStartDate(period, today);
  const currentTotals = currentPortfolioHistoryTotal();
  const points = [];
  for (let d = new Date(start); d <= today; d = addDays(d, 1)) {
    const isToday = toIsoDate(d) === toIsoDate(today);
    let dayTotal = 0;
    appData.positions.forEach(pos => {
      dayTotal += priceForHistoryDate(pos, d, isToday) * sharesAtDate(pos, d);
    });
    const cashForDay = hasCashTransactions() ? getCashBalance(d) : Number(appData.goal?.cash || 0);
    dayTotal += metalsValueAtDate(d, isToday) + cashForDay;
    const invested = getInvestedCapital(d);
    const netContributions = getNetExternalContributions(d);
    const value = isToday ? currentTotals : dayTotal;
    const pnl = value - invested;
    const label = period === '1W' ? String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') : MONTHS_SHORT[d.getMonth()];
    const labelLong = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
    const events = purchaseEventsForDate(d);
    const quality = historyDataQualityForDate(d, isToday);
    points.push({ date: new Date(d), label, labelLong: isToday ? `${labelLong} (heute)` : labelLong, value, invested, netContributions, cash: cashForDay, pnl, quality, events, historyNote: quality.level === 'exact' ? '' : quality.note });
  }
  return points;
}

function renderHistory() {
  const points = buildPortfolioHistory(currentHistoryPeriod);
  if (points.length < 2) return;
  const futureProjection = isFutureHistoryPeriod(currentHistoryPeriod);
  const intraday = points[0]?.intraday === true;
  syncHistoryLegendControls(intraday);
  // Zielpfad: linear interpolation vom Startpunkt bis zum Ziel-Enddatum
  if (!intraday && historyVisibleSeries.goal && appData.goal?.amount && appData.goal?.year) {
    const goalEnd = endOfGoalMonth(appData.goal.year, appData.goal.month || 12);
    const startVal = points[0].value;
    const goalVal = goalPlanAmount(appData.goal.amount, appData.goal.bufferPct || 0);
    const startMs = points[0].date.getTime();
    const goalMs = goalEnd.getTime();
    const span = goalMs - startMs;
    points.forEach(p => {
      if (span > 0) {
        const pct = Math.max(0, Math.min(1, (p.date.getTime() - startMs) / span));
        p.goal = startVal + (goalVal - startVal) * pct;
      } else { p.goal = goalVal; }
    });
  }
  const extraSeries = [];
  if (historyVisibleSeries.invested) extraSeries.push({ key: 'invested', label: 'Einstand', color: '#888', dashed: false });
  if (!intraday && historyVisibleSeries.pnl) extraSeries.push({ key: 'pnl', label: 'G/V', color: '#3b82f6', dashed: false });
  if (!intraday && historyVisibleSeries.goal) extraSeries.push({ key: 'goal', label: 'Zielpfad', color: '#fbbf24', dashed: true });
  // Wenn Hauptlinie ausgeblendet, erste sichtbare Zusatzlinie als Hauptlinie nutzen
  if (!historyVisibleSeries.value && !extraSeries.length) {
    historyVisibleSeries.value = true;
    syncHistoryLegendControls(intraday);
  }
  const mainKey = historyVisibleSeries.value ? 'value' : (extraSeries[0]?.key || 'value');
  renderChart('historyChart', points, mainKey, { compactY: true, daily: true, bigPoints: intraday, eventMarkers: !intraday, mainDashed: futureProjection, mainLabel: mainKey === 'value' ? (futureProjection ? 'Sparpfad' : intraday ? 'Depotwert heute' : 'Depotwert') : extraSeries[0]?.label, extraSeries: extraSeries.filter(s => s.key !== mainKey) });
  const qualitySummary = summarizeHistoryQuality(points, futureProjection);
  const qualityBadge = document.getElementById('historyQualityBadge');
  if (qualityBadge) {
    qualityBadge.textContent = qualitySummary.text;
    qualityBadge.className = `history-quality-badge ${qualitySummary.level}`;
  }
  const eventBadge = document.getElementById('historyEventBadge');
  if (eventBadge) eventBadge.textContent = `Ereignisse: ${qualitySummary.events}`;
  const basisText = document.getElementById('historyBasisText');
  if (basisText) basisText.textContent = qualitySummary.basis;
  const first = points[0], last = points[points.length - 1];
  const delta = last.value - first.value;
  const deltaPct = first.value > 0 ? (delta / first.value) * 100 : 0;
  document.getElementById('historyPeriodLabel').textContent = intraday
    ? `Heute · ${first.labelLong} – ${last.labelLong.replace(' (jetzt)', '')}`
    : `${futureProjection ? 'Projektion: ' : ''}${first.labelLong.replace(' (heute)', '')} – ${last.labelLong.replace(' (heute)', '').replace(' (Projektion)', '')}`;
  const deltaEl = document.getElementById('historyDelta');
  deltaEl.textContent = `${delta >= 0 ? '+' : ''}${fmt.format(delta)} (${delta >= 0 ? '+' : ''}${fmtNum(deltaPct, 1)} %)`;
  deltaEl.className = 'history-delta ' + (delta >= 0 ? 'positive' : 'negative');
  document.getElementById('historyStartLabel').textContent = intraday ? 'Startwert heute' : `Depot Stand ${first.labelLong.replace(' (heute)', '')}`;
  document.getElementById('historyStartValue').textContent = fmt.format(first.value);
  document.getElementById('historyEndLabel').textContent = intraday ? `Depot Stand aktuell (${String(last.date.getHours()).padStart(2, '0')}:${String(last.date.getMinutes()).padStart(2, '0')})` : futureProjection ? `Sparpfad am ${last.labelLong.replace(' (Projektion)', '')}` : last.labelLong.includes('heute') ? `Depot Stand aktuell (${String(last.date.getDate()).padStart(2, '0')}.${String(last.date.getMonth() + 1).padStart(2, '0')}.${last.date.getFullYear()})` : `Depot Stand ${last.labelLong}`;
  document.getElementById('historyEndValue').textContent = fmt.format(last.value);
  // Performance-Kennzahlen
  const invested = last.invested;
  const netContributions = getNetExternalContributions();
  const grossEl = document.getElementById('historyReturnGross');
  const basisLabelEl = document.getElementById('historyCapitalBasisLabel');
  if (grossEl) {
    const base = netContributions > 0 ? netContributions : invested;
    if (basisLabelEl) basisLabelEl.textContent = intraday ? 'Veränderung heute' : netContributions > 0 ? 'Wert ggü. Netto-Einzahlungen' : 'Wert ggü. Einstand';
    if (intraday) {
      grossEl.textContent = `${delta >= 0 ? '+' : ''}${fmtNum(deltaPct, 2)} % · ${delta >= 0 ? '+' : ''}${fmt.format(delta)}`;
      grossEl.className = delta >= 0 ? 'positive' : 'negative';
    } else if (futureProjection) {
      grossEl.textContent = 'Zukunftsansicht';
      grossEl.className = '';
    } else if (base > 0) {
      const grossPct = ((last.value - base) / base) * 100;
      grossEl.textContent = `${grossPct >= 0 ? '+' : ''}${fmtNum(grossPct, 1)} % · ${fmt.format(last.value - base)}`;
      grossEl.className = grossPct >= 0 ? 'positive' : 'negative';
    } else { grossEl.textContent = '—'; grossEl.className = ''; }
  }
  const mwrEl = document.getElementById('historyReturnMwr');
  if (mwrEl) {
    const mwrPct = (futureProjection || intraday) ? null : plausiblePerformancePct(computeMWR(last.value));
    if (intraday) {
      mwrEl.textContent = 'nicht für Intraday';
      mwrEl.className = '';
    } else if (futureProjection) {
      mwrEl.textContent = 'keine Renditeprognose';
      mwrEl.className = '';
    } else if (mwrPct != null) {
      mwrEl.textContent = `${mwrPct >= 0 ? '+' : ''}${fmtNum(mwrPct, 1)} % p.a.`;
      mwrEl.className = mwrPct >= 0 ? 'positive' : 'negative';
    } else {
      mwrEl.textContent = hasCashTransactions() ? 'nicht belastbar' : 'Cashflows fehlen';
      mwrEl.className = '';
    }
  }
  const twrEl = document.getElementById('historyReturnTwr');
  if (twrEl) {
    const twrPct = (futureProjection || intraday) ? null : plausiblePerformancePct(computeTWR(points));
    if (intraday) {
      twrEl.textContent = 'nicht für Intraday';
      twrEl.className = '';
    } else if (futureProjection) {
      twrEl.textContent = 'keine Renditeprognose';
      twrEl.className = '';
    } else if (twrPct != null) {
      twrEl.textContent = `${twrPct >= 0 ? '+' : ''}${fmtNum(twrPct, 1)} % p.a.`;
      twrEl.className = twrPct >= 0 ? 'positive' : 'negative';
    } else {
      twrEl.textContent = 'nicht belastbar';
      twrEl.className = '';
    }
  }
  // Datenqualitaets-Hinweis fuer Depot-Entwicklung
  const cashNoteEl = document.getElementById('cashHistoryNote');
  if (cashNoteEl) {
    const notes = [];
    const hasCash = currentCashValue() > 0 || getNetExternalContributions() !== 0;
    const hasCashTx = hasCashTransactions();
    const hasFallbackHistory = (appData.positions || []).some(pos => !pos.cgId && !Array.isArray(pos.monthlyHistory));
    if (intraday) notes.push('Heute-Ansicht: zeigt die bekannte Tagesbewegung aus aktuellen Kursen und Previous-Close/24h-Werten; keine tickgenaue Broker-Intraday-Historie.');
    if (futureProjection) notes.push('Zukunftsansicht: gestrichelter Sparpfad mit aktueller Sparrate, ohne Renditeannahme und ohne künftige Kursprognose. Den Zielpfad kannst du über die Legende einblenden.');
    if (!futureProjection && !intraday && hasCash && !hasCashTx) notes.push('Cash wird aktuell als konstanter Wert über die Historie gerechnet. Sobald du Cash-Bewegungen erfasst, wird die Historie genauer.');
    if (!futureProjection && !intraday && !hasCashTx) notes.push('MWR wird erst belastbar, wenn Einzahlungen und Auszahlungen als Cash-Bewegungen erfasst sind.');
    const accountStats = accountImportCashStats();
    if (accountStats.cashRows || accountStats.orderRows) notes.push(`Kontoumsätze CSV fließen ein: ${accountStats.cashRows} Cash-Bewegungen und ${accountStats.orderRows} echte Order-Cashwerte sind im Verlauf berücksichtigt.`);
    if (!futureProjection && !intraday && hasFallbackHistory) notes.push('Bei Titeln ohne historische Kursreihe verwendet die App ersatzweise aktuelle oder monatliche Kurse.');
    cashNoteEl.textContent = notes.join(' ');
    cashNoteEl.style.display = notes.length ? '' : 'none';
  }

}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

const GOAL_TYPE_LABELS = { wealth: 'Vermögen', reserve: 'Reserve', purchase: 'Kaufziel', retirement: 'Langfristig', free: 'Freies Ziel' };
const GOAL_PRIORITY_LABELS = { low: 'Niedrig', medium: 'Mittel', high: 'Hoch', critical: 'Sehr wichtig' };
function monthNameAT(month) {
  return ['Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'][Math.max(0, Math.min(11, (Number(month) || 12) - 1))];
}
function endOfGoalMonth(year, month) {
  return new Date(year, month, 0, 23, 59, 59);
}
function futureValueWithMonthlySavings(startValue, monthlySavings, months, annualReturnPct) {
  const m = Math.max(0, Number(months) || 0);
  const pmt = Math.max(0, Number(monthlySavings) || 0);
  const monthlyR = (Number(annualReturnPct) || 0) / 100 / 12;
  if (Math.abs(monthlyR) < 0.0000001) return startValue + pmt * m;
  return startValue * Math.pow(1 + monthlyR, m) + pmt * ((Math.pow(1 + monthlyR, m) - 1) / monthlyR);
}
function goalPlanAmount(amount, bufferPct) {
  return (Number(amount) || 0) * (1 + (Number(bufferPct) || 0) / 100);
}

function getGoalStrategy(goalOverride) {
  const source = goalOverride || appData?.goal || {};
  const pathEl = document.getElementById('goalPath');
  const riskEl = document.getElementById('goalRisk');
  const savingsPct = clampNumber(pathEl ? pathEl.value : source.pathSavingsPct ?? 50, 0, 100);
  const returnPct = 100 - savingsPct;
  const riskPct = clampNumber(riskEl ? riskEl.value : source.riskPct ?? 50, 0, 100);
  const riskLabel = riskPct < 34 ? 'Defensiv' : riskPct < 67 ? 'Ausgewogen' : 'Offensiv';
  const pathLabel = savingsPct > 66 ? 'Sparrate dominiert' : savingsPct < 34 ? 'Rendite dominiert' : 'Mischweg';
  const riskText = riskPct < 34
    ? 'Kapitalerhalt, breite Streuung, Cash/Edelmetalle und planbare Sparrate haben Vorrang.'
    : riskPct < 67
      ? 'Wachstum ja, aber mit kontrollierten Klumpenrisiken und nachvollziehbarer Allokation.'
      : 'Höhere Schwankungen sind akzeptiert, Chancen dürfen stärker gewichtet werden, Risiken müssen klar benannt bleiben.';
  const pathText = savingsPct > 66
    ? 'Das Ziel soll überwiegend durch regelmäßige Einzahlungen erreicht werden; Rendite ist Zusatz, nicht Rettungsanker.'
    : savingsPct < 34
      ? 'Das Ziel soll stärker über Portfolio-Rendite erreicht werden; Sparrate hilft, aber Wachstum trägt den Hauptteil.'
      : 'Sparrate und Rendite sollen gemeinsam tragen; Empfehlungen sollen beide Hebel vergleichen.';
  return { savingsPct, returnPct, riskPct, riskLabel, pathLabel, riskText, pathText };
}

function renderGoal(totals) {
  const year = parseInt(document.getElementById('goalYear').value, 10);
  const amount = parseInt(document.getElementById('goalAmount').value, 10);
  const savingsRate = parseInt(document.getElementById('goalSavings').value, 10) || 0;
  const goalType = document.getElementById('goalType')?.value || appData?.goal?.type || 'wealth';
  const goalPriority = document.getElementById('goalPriority')?.value || appData?.goal?.priority || 'medium';
  const goalMonth = parseInt(document.getElementById('goalMonth')?.value || appData?.goal?.month || 12, 10);
  const minSavingsRate = parseInt(document.getElementById('goalMinSavings')?.value || appData?.goal?.minSavingsRate || 0, 10) || 0;
  const maxSavingsRateRaw = parseInt(document.getElementById('goalMaxSavings')?.value || appData?.goal?.maxSavingsRate || 1000, 10) || 0;
  const maxSavingsRate = Math.max(minSavingsRate, maxSavingsRateRaw);
  if (document.getElementById('goalMaxSavings') && maxSavingsRate !== maxSavingsRateRaw) document.getElementById('goalMaxSavings').value = String(maxSavingsRate);
  const bufferPct = parseInt(document.getElementById('goalBuffer')?.value || appData?.goal?.bufferPct || 0, 10) || 0;
  const annualReturnPct = parseFloat(document.getElementById('goalReturn')?.value || appData?.goal?.annualReturnPct || 0) || 0;
  const planAmount = goalPlanAmount(amount, bufferPct);
  const strategy = getGoalStrategy();
  document.getElementById('goalYearVal').textContent = String(year);
  document.getElementById('goalAmountVal').textContent = fmtNoCent.format(amount);
  document.getElementById('goalSavingsVal').textContent = fmtNoCent.format(savingsRate);
  document.getElementById('goalPathVal').textContent = `${fmtNum(strategy.savingsPct, 0)}% Sparrate / ${fmtNum(strategy.returnPct, 0)}% Rendite`;
  document.getElementById('goalRiskVal').textContent = `${strategy.riskLabel} · ${fmtNum(strategy.riskPct, 0)}%`;
  const setGoalText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  setGoalText('goalTypeVal', GOAL_TYPE_LABELS[goalType] || 'Vermögen');
  setGoalText('goalPriorityVal', GOAL_PRIORITY_LABELS[goalPriority] || 'Mittel');
  setGoalText('goalMonthVal', monthNameAT(goalMonth));
  setGoalText('goalMinSavingsVal', fmtNoCent.format(minSavingsRate));
  setGoalText('goalMaxSavingsVal', fmtNoCent.format(maxSavingsRate));
  setGoalText('goalBufferVal', `${fmtNum(bufferPct, 0)} %`);
  setGoalText('goalReturnVal', `${fmtNum(annualReturnPct, 1)} % p.a.`);
  document.getElementById('goalTitle').textContent = `Ziel: ${fmtNoCent.format(amount)} bis ${monthNameAT(goalMonth)} ${year}`;
  const today = new Date();
  const endDate = endOfGoalMonth(year, goalMonth);
  const monthsToGoal = Math.max(1, Math.round((endDate - today) / (1000 * 60 * 60 * 24 * 30.44)));
  const gap = planAmount - totals.totalCur;
  const requiredReturnPct = totals.totalCur > 0 ? ((planAmount / totals.totalCur) - 1) * 100 : 0;
  const monthlyNeeded = gap / monthsToGoal;
  const projectedWithReturn = futureValueWithMonthlySavings(totals.totalCur, savingsRate, monthsToGoal, annualReturnPct);
  const projectedMin = futureValueWithMonthlySavings(totals.totalCur, minSavingsRate, monthsToGoal, annualReturnPct);
  const projectedMax = futureValueWithMonthlySavings(totals.totalCur, maxSavingsRate, monthsToGoal, annualReturnPct);
  const progress = Math.min(100, Math.max(0, (totals.totalCur / planAmount) * 100));
  document.getElementById('goalPct').textContent = `${fmtNum(progress, 1)}%`;
  document.getElementById('goalFill').style.width = `${progress}%`;

  // Sparrate-Mirror auf Stat-Kachel oben
  const savingsTileEl = document.getElementById('statSavingsValue');
  if (savingsTileEl) savingsTileEl.textContent = savingsRate > 0 ? fmtNoCent.format(savingsRate) : '0 €';

  let meta;
  const planHint = bufferPct > 0 ? ` · Planbetrag inkl. ${fmtNum(bufferPct, 0)}% Puffer: <strong>${fmt.format(planAmount)}</strong>` : '';
  if (gap <= 0) {
    meta = `Aktuell: <strong>${fmt.format(totals.totalCur)}</strong> · Ziel bereits erreicht (Puffer: <strong>${fmt.format(-gap)}</strong>) · ${monthsToGoal} Monate verbleibend${planHint}`;
  } else if (savingsRate > 0) {
    const sparEnd = totals.totalCur + savingsRate * monthsToGoal;
    const restGap = amount - sparEnd;
    // Nötige Rendite p.a. damit Endwert = amount
    // FV = PV*(1+r)^t + PMT*((1+r)^t - 1)/r   — wir lösen näherungsweise nach r
    const tYears = monthsToGoal / 12;
    let rEst = 0;
    for (let r = 0; r <= 0.5; r += 0.001) {
      const monthlyR = r / 12;
      const months = monthsToGoal;
      const fv = monthlyR === 0 ? totals.totalCur + savingsRate * months : totals.totalCur * Math.pow(1 + monthlyR, months) + savingsRate * ((Math.pow(1 + monthlyR, months) - 1) / monthlyR);
      if (fv >= planAmount) { rEst = r; break; }
    }
    const returnGap = planAmount - projectedWithReturn;
    if (returnGap <= 0) {
      meta = `Bei <strong>${fmt.format(savingsRate)}/Mo</strong> und <strong>${fmtNum(annualReturnPct, 1)}% p.a.</strong> Szenario erreichst du <strong>${fmt.format(projectedWithReturn)}</strong> in ${monthsToGoal} Monaten — Plan erfüllt (Puffer <strong>${fmt.format(-returnGap)}</strong>).${planHint}`;
    } else {
      const renditeText = rEst > 0 && rEst < 0.5 ? `<strong>${fmtNum(rEst * 100, 1)}% p.a.</strong> Rendite` : `keine realistische Rendite`;
      const sparAlt = gap / monthsToGoal;
      meta = `Bei <strong>${fmt.format(savingsRate)}/Mo</strong> und <strong>${fmtNum(annualReturnPct, 1)}% p.a.</strong>: <strong>${fmt.format(projectedWithReturn)}</strong> in ${monthsToGoal} Monaten (Lücke <strong>${fmt.format(returnGap)}</strong>). Zusätzlich nötig: ${renditeText} — oder Sparrate auf <strong>${fmt.format(sparAlt)}/Mo</strong> erhöhen.${planHint}`;
    }
  } else {
    meta = `Aktuell: <strong>${fmt.format(totals.totalCur)}</strong> · Lücke: <strong>${fmt.format(gap)}</strong> · Noch ${monthsToGoal} Monate · <strong>${fmt.format(monthlyNeeded)}/Monat</strong> ohne Rendite oder <strong>${fmtNum(requiredReturnPct, 0)}%</strong> Rendite nötig${planHint}`;
  }
  document.getElementById('goalMeta').innerHTML = meta;
  const strategyEl = document.getElementById('strategyNote');
  if (strategyEl) {
    const corridor = `Korridor ${fmtNoCent.format(minSavingsRate)}–${fmtNoCent.format(maxSavingsRate)}/Mo`;
    const status = projectedMax < planAmount
      ? `selbst Maximalrate bleibt unter Plan`
      : projectedMin >= planAmount
        ? `Mindest-Sparrate reicht im Szenario`
        : `aktuelle Rate entscheidet`;
    strategyEl.innerHTML = `<strong>Strategie:</strong> ${strategy.pathLabel} (${fmtNum(strategy.savingsPct, 0)}% Sparrate / ${fmtNum(strategy.returnPct, 0)}% Rendite) · Risiko <strong>${strategy.riskLabel}</strong> (${fmtNum(strategy.riskPct, 0)}%) · ${GOAL_PRIORITY_LABELS[goalPriority] || 'Mittel'} · ${corridor}. ${strategy.pathText} <strong>Planstatus:</strong> ${status}.`;
  }
  if (appData.goal) {
    appData.goal.year = year;
    appData.goal.amount = amount;
    appData.goal.savingsRate = savingsRate;
    appData.goal.pathSavingsPct = strategy.savingsPct;
    appData.goal.riskPct = strategy.riskPct;
    appData.goal.type = goalType;
    appData.goal.priority = goalPriority;
    appData.goal.month = goalMonth;
    appData.goal.minSavingsRate = minSavingsRate;
    appData.goal.maxSavingsRate = maxSavingsRate;
    appData.goal.bufferPct = bufferPct;
    appData.goal.annualReturnPct = annualReturnPct;
  }
  return { year, month: goalMonth, amount, planAmount, bufferPct, gap, monthsToGoal, monthlyNeeded, requiredReturnPct, progress, savingsRate, minSavingsRate, maxSavingsRate, annualReturnPct, projectedWithReturn, projectedMin, projectedMax, type: goalType, typeLabel: GOAL_TYPE_LABELS[goalType] || 'Vermögen', priority: goalPriority, priorityLabel: GOAL_PRIORITY_LABELS[goalPriority] || 'Mittel', ...strategy };
}

function renderAnalysisLocal(totals, goal) {
  // Nutze getAllPositions() — bezieht Edelmetalle und Cash mit ein
  const allocations = getAllPositions().map(pos => {
    const live = currentPrices[pos.id] || { price: pos.costPrice };
    const valuation = getPositionValuation(pos, live);
    const value = valuation.currentValue;
    const pnlPct = pos.special || pos.type === 'Edelmetall' ? 0 : valuation.pnlPct;
    return { name: pos.name, type: pos.type || '?', special: pos.special, value, pct: totals.totalCur > 0 ? (value / totals.totalCur) * 100 : 0, pnlPct };
  }).sort((a, b) => b.pct - a.pct);
  const cryptoShare = allocations.filter(a => a.type === 'Crypto').reduce((s, a) => s + a.pct, 0);
  const stockShare = allocations.filter(a => a.type === 'Aktie').reduce((s, a) => s + a.pct, 0);
  const etfShare = allocations.filter(a => a.type === 'ETF').reduce((s, a) => s + a.pct, 0);
  const metalShare = allocations.filter(a => a.special === 'metals' || a.type === 'Edelmetall').reduce((s, a) => s + a.pct, 0);
  const cashShare = allocations.filter(a => a.special === 'cash').reduce((s, a) => s + a.pct, 0);
  const largestPos = allocations[0];
  const obs = [];
  if (cryptoShare > 30) obs.push(`Krypto-Anteil ${fmtNum(cryptoShare, 0)}% — hoher Volatilitätsanteil.`);
  if (stockShare > 35) obs.push(`Einzelaktien-Anteil ${fmtNum(stockShare, 0)}% — Einzelwert-Konzentration prüfen.`);
  if (etfShare < 30) obs.push(`ETF-Anteil nur ${fmtNum(etfShare, 0)}% — breit gestreute Kernpositionen sind klassischer Stabilisator.`);
  if (cashShare < 5) obs.push(`Cash-Anteil nur ${fmtNum(cashShare, 0)}% — Reserve für Marktrücksetzer fehlt.`);
  if (metalShare > 25) obs.push(`Edelmetall-Anteil ${fmtNum(metalShare, 0)}% — hoher Sachwertanteil.`);
  if (largestPos.pct > 40) obs.push(`Größte Position (${largestPos.name}): ${fmtNum(largestPos.pct, 0)}% — überproportionales Klumpenrisiko.`);
  if (obs.length === 0) obs.push('Allokation wirkt ausgewogen.');
  const allocLines = allocations.map(a => `<div>• ${escapeHtml(a.name)} (${a.type}): <strong>${fmtNum(a.pct, 1)}%</strong> · ${fmt.format(a.value)} · ${fmtPct(a.pnlPct)}</div>`).join('');
  const strategy = getGoalStrategy(goal);
  let goalRealityText;
  if (goal.gap <= 0) goalRealityText = `Ziel bereits übertroffen (<strong>${fmt.format(-goal.gap)}</strong> Puffer). Optionen: Ziel anheben oder Strategie auf Erhalt umstellen.`;
  else if (strategy.savingsPct >= 67) goalRealityText = `Deine Vorgabe ist sparratenorientiert: Ziel primär über Einzahlungen erreichen. Ohne Rendite wären rechnerisch <strong>${fmt.format(goal.monthlyNeeded)}/Monat</strong> nötig; Rendite sollte hier eher Sicherheitsreserve sein.`;
  else if (strategy.savingsPct <= 33) goalRealityText = `Deine Vorgabe ist renditeorientiert: Die Lücke von <strong>${fmt.format(goal.gap)}</strong> soll stärker durch Kursentwicklung geschlossen werden. Dafür sind Schwankungen bewusst einzuplanen.`;
  else if (goal.monthsToGoal <= 12 && goal.requiredReturnPct > 30) goalRealityText = `Ziel mit reiner Marktentwicklung schwer erreichbar (${fmtNum(goal.requiredReturnPct, 0)}% in ${goal.monthsToGoal} Monaten). Realistisch ist Sparrate von <strong>${fmt.format(goal.monthlyNeeded)}/Monat</strong>.`;
  else goalRealityText = `Ziel mit moderater Rendite (~${fmtNum(goal.requiredReturnPct, 0)}% über ${goal.monthsToGoal} Monate) oder Sparrate von <strong>${fmt.format(goal.monthlyNeeded)}/Monat</strong> erreichbar.`;
  const options = [];
  if (strategy.savingsPct >= 67 && goal.gap > 0) options.push(`Sparrate als Haupthebel prüfen: Ziel-Lücke über <strong>${fmt.format(goal.monthlyNeeded)}/Mo</strong> schließen oder Zielzeitraum verlängern.`);
  if (strategy.riskPct < 34 && (cryptoShare > 20 || stockShare > 35)) options.push(`Defensives Profil respektieren: Krypto/Einzelaktien-Anteil reduzieren und mehr Gewicht auf ETF, Cash oder Edelmetalle legen.`);
  if (strategy.savingsPct <= 33 && strategy.riskPct >= 67) options.push(`Renditefokus bewusst testen: Szenario mit -20% Krypto/Aktien prüfen und nur Positionsgrößen wählen, deren Rückschlag du aushältst.`);
  if (etfShare < 30) { const targetEtfAdd = Math.max(500, totals.totalCur * 0.1); options.push(`ETF-Sparplan ~<strong>${fmt.format(targetEtfAdd / 6)}/Monat</strong> auf einen Welt-ETF (z.B. MSCI World) — würde ETF-Anteil über 6 Monate auf ~${fmtNum(etfShare + 10, 0)}% heben.`); }
  if (cryptoShare > (strategy.riskPct >= 67 ? 45 : 35)) { const reduceAmount = totals.totalCur * (cryptoShare - (strategy.riskPct >= 67 ? 40 : 30)) / 100; options.push(`Krypto-Position um ~<strong>${fmt.format(Math.max(0, reduceAmount))}</strong> reduzieren — Volatilität sinkt deutlich.`); }
  if (largestPos.pct > 40 && largestPos.type === 'Aktie') { const trimAmount = largestPos.value * 0.25; options.push(`Größte Einzelposition <strong>${escapeHtml(largestPos.name)}</strong> teilweise abbauen (~<strong>${fmt.format(trimAmount)}</strong>) und in breiter gestreute Instrumente umschichten.`); }
  if (goal.gap > 0 && goal.monthlyNeeded < 1500) options.push(`Monatlicher Sparplan von <strong>${fmt.format(goal.monthlyNeeded)}</strong> reicht ohne Marktrendite — z.B. ETF-Sparplan bei Flatex/Trade Republic einrichten.`);
  if (options.length === 0) options.push('Bei aktueller Allokation und Zielsetzung: laufender Kurs beibehalten und regelmäßig prüfen.');
  document.getElementById('analysisText').innerHTML = `
    <div class="block"><strong>Lage heute:</strong> Gesamtwert ${fmt.format(totals.totalCur)}, Performance gegenüber Einstand: <span class="${totals.totalPnl >= 0 ? 'positive' : 'negative'}">${totals.totalPnl >= 0 ? '+' : ''}${fmt.format(totals.totalPnl)} (${fmtNum(totals.totalPnlPct, 1)}%)</span>.</div>
    <div class="block"><strong>Allokation:</strong><div style="margin-top:6px;font-size:12px;">${allocLines}</div></div>
    <div class="block"><strong>Strategie:</strong> ${strategy.pathLabel}: <strong>${fmtNum(strategy.savingsPct, 0)}% Sparrate / ${fmtNum(strategy.returnPct, 0)}% Rendite</strong>. Risiko: <strong>${strategy.riskLabel}</strong> (${fmtNum(strategy.riskPct, 0)}%). Zielart: <strong>${goal.typeLabel || 'Vermögen'}</strong>, Priorität: <strong>${goal.priorityLabel || 'Mittel'}</strong>, Rendite-Szenario: <strong>${fmtNum(goal.annualReturnPct || 0, 1)}% p.a.</strong>.</div>
    <div class="block"><strong>Auffälligkeiten:</strong><div style="margin-top:6px;">${obs.map(o => `<div>• ${o}</div>`).join('')}</div></div>
    <div class="block"><strong>Ziel-Realität:</strong> ${goalRealityText}</div>
    <div class="block"><strong>Konkrete Optionen (keine Empfehlung):</strong><div style="margin-top:6px;">${options.map((o, i) => `<div>${i + 1}. ${o}</div>`).join('')}</div></div>`;
}

let editingId = null;
function openEditModal(posId) {
  const pos = appData.positions.find(p => p.id === posId);
  if (!pos) return;
  editingId = posId;
  document.getElementById('editTitle').textContent = pos.name;
  const live = currentPrices[posId] || { price: pos.costPrice };
  document.getElementById('editPrice').value = fixedPriceInput(pos, live.price);
  document.getElementById('editQuoteSymbol').value = pos.quoteSymbol || quoteSymbolForPosition(pos) || '';
  const venueField = document.getElementById('editVenue');
  if (venueField) venueField.value = venueOf(pos);
  document.getElementById('editShares').value = pos.shares;
  document.getElementById('editCost').value = pos.costPrice;
  const riskSel = document.getElementById('editRisk');
  if (riskSel) riskSel.value = pos.risk || '';
  // Stammdaten-Felder vorausfüllen
  const sd = pos.stammdaten || {};
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  setVal('editCustodian', sd.custodian);
  setVal('editCustodyType', sd.custodyType);
  setVal('editIsin', sd.isin);
  setVal('editWkn', sd.wkn);
  setVal('editLand', sd.land);
  setVal('editSektor', sd.sektor);
  document.getElementById('editModal').classList.add('active');
}
async function saveEditModal() {
  if (!editingId) return;
  const pos = appData.positions.find(p => p.id === editingId);
  if (!pos) return;
  const newPrice = parseFloat(document.getElementById('editPrice').value);
  const newQuoteSymbol = cleanQuoteSymbol(document.getElementById('editQuoteSymbol')?.value || '');
  const newVenue = document.getElementById('editVenue')?.value || 'auto';
  const newShares = parseFloat(document.getElementById('editShares').value);
  const newCost = parseFloat(document.getElementById('editCost').value);
  const newRisk = document.getElementById('editRisk')?.value || '';
  if (isNaN(newPrice) || isNaN(newShares) || isNaN(newCost)) { alert('Bitte gültige Zahlen eingeben.'); return; }
  // Vor dem Überschreiben: prüfen ob shares/costPrice geändert wurden — wenn ja, Adjust-Tx anlegen
  const sharesDiff = Math.abs(newShares - pos.shares) > 1e-9;
  const costDiff = Math.abs(newCost - pos.costPrice) > 1e-6;
  if (sharesDiff || costDiff) {
    if (!Array.isArray(appData.transactions)) appData.transactions = [];
    const today = new Date().toISOString().slice(0, 10);
    appData.transactions.push({
      id: makeTxId(), date: today,
      assetId: pos.id, assetType: assetTypeOf(pos), txType: 'adjust',
      quantity: newShares, price: newCost, value: newShares * newCost, fees: 0,
      note: 'Manuelle Korrektur via Edit-Modal' + (sharesDiff ? ` · Stück ${pos.shares} → ${newShares}` : '') + (costDiff ? ` · Ø ${fmtPrice(pos, pos.costPrice)} → ${fmtPrice(pos, newCost)}` : '')
    });
    appData.transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  }
  pos.shares = newShares;
  pos.costPrice = newCost;
  if (newQuoteSymbol) pos.quoteSymbol = newQuoteSymbol; else delete pos.quoteSymbol;
  if (newVenue === 'auto') delete pos.venue; else pos.venue = newVenue;
  if (!pos.cgId) pos.manualPrice = newPrice;
  if (newRisk) pos.risk = newRisk; else delete pos.risk;
  // Stammdaten übernehmen
  const getVal = id => (document.getElementById(id)?.value || '').trim();
  const stammdaten = { ...(pos.stammdaten || {}) };
  const fields = { custodian: 'editCustodian', custodyType: 'editCustodyType', isin: 'editIsin', wkn: 'editWkn', land: 'editLand', sektor: 'editSektor' };
  Object.entries(fields).forEach(([key, id]) => {
    const v = getVal(id);
    if (v) stammdaten[key] = v; else delete stammdaten[key];
  });
  if (Object.keys(stammdaten).length > 0) pos.stammdaten = stammdaten;
  else delete pos.stammdaten;
  const needsMarketQuote = !pos.cgId && !pos.special && ['aktie', 'etf'].includes(String(pos.type || '').toLowerCase());
  if (needsMarketQuote && (quoteSymbolForPosition(pos) || pos.stammdaten?.isin || pos.stammdaten?.wkn)) {
    delete currentPrices[editingId];
  } else {
    currentPrices[editingId] = {
      price: newPrice,
      previousClose: currentPrices[editingId]?.previousClose ?? null,
      change: currentPrices[editingId]?.change ?? null,
      changePct: currentPrices[editingId]?.changePct ?? null,
      live: !!pos.cgId,
      source: currentPrices[editingId]?.source || (pos.cgId ? 'CoinGecko' : 'manuell'),
      updatedAt: currentPrices[editingId]?.updatedAt || new Date().toISOString()
    };
  }
  closeEditModal();
  await savePositionsToKV();
  if (needsMarketQuote) {
    try { await fetchMarketPrices({ forceRefresh: true }); } catch (e) {}
  }
  await refreshUI();
}
function closeEditModal() { editingId = null; document.getElementById('editModal').classList.remove('active'); }

function renderSavingsSim(totals, goal) {
  const sub = document.getElementById('savingsSimSub');
  const grid = document.getElementById('savingsSimGrid');
  const note = document.getElementById('savingsSimNote');
  if (!sub || !grid || !note) return;
  const target = goal.planAmount || goal.amount;
  const gap = target - totals.totalCur;
  const months = Math.max(1, goal.monthsToGoal);
  if (gap <= 0) {
    sub.textContent = `Ziel bereits erreicht — Puffer ${fmt.format(-gap)}`;
    grid.innerHTML = '';
    note.innerHTML = `Du bist über dem Ziel. Sparrate kannst du frei wählen oder Ziel anheben.`;
    return;
  }
  sub.textContent = `Planziel: ${fmt.format(target)} bis ${monthNameAT(goal.month || 12)} ${goal.year} · Lücke ${fmt.format(gap)} · ${months} Mo · Rendite-Szenario ${fmtNum(goal.annualReturnPct || 0, 1)}% p.a.`;
  const current = goal.savingsRate || 0;
  const required = gap / months;
  const roundedRequired = Math.max(0, Math.ceil(required / 20) * 20);
  const halfRequired = Math.max(0, Math.ceil((required / 2) / 20) * 20);
  const rates = [...new Set([
    0,
    goal.minSavingsRate || 0,
    current,
    goal.maxSavingsRate || 0,
    halfRequired,
    roundedRequired,
    roundedRequired + 100,
    100,
    200,
    300,
    500,
    1000,
  ].filter(rate => Number.isFinite(rate) && rate >= 0))]
    .sort((a, b) => a - b);
  const rows = rates.map(rate => {
    const projected = futureValueWithMonthlySavings(totals.totalCur, rate, months, goal.annualReturnPct || 0);
    const pct = Math.min(100, (projected / target) * 100);
    const diff = projected - target;
    let cls, tag;
    if (projected < target * 0.85) { cls = 'late'; tag = `fehlt ${fmtNoCent.format(Math.abs(diff))}`; }
    else if (projected < target) { cls = 'tight'; tag = `fehlt ${fmtNoCent.format(Math.abs(diff))}`; }
    else if (projected < target * 1.1) { cls = 'fit'; tag = `Puffer ${fmtNoCent.format(diff)}`; }
    else { cls = 'early'; tag = `Puffer ${fmtNoCent.format(diff)}`; }
    const isCurrent = Math.abs(rate - current) < 1;
    const isRequired = Math.abs(rate - roundedRequired) < 1;
    const label = `${fmtNoCent.format(rate)}${isCurrent ? ' aktuell' : isRequired ? ' nötig' : ''}`;
    return `<span class="savings-sim-rate ${isCurrent ? 'current' : ''}">${fmtNoCent.format(rate)}</span>
      <div class="savings-sim-bar"><div class="savings-sim-fill ${cls}" style="width:${pct}%"></div></div>
      <span class="savings-sim-tag ${cls}" title="${label}">${tag}</span>`;
  }).join('');
  grid.innerHTML = rows;
  const currentProjected = futureValueWithMonthlySavings(totals.totalCur, current, months, goal.annualReturnPct || 0);
  const currentGap = target - currentProjected;
  if (currentGap <= 0) {
    note.innerHTML = `Aktuell eingestellt: <strong>${fmtNoCent.format(current)}/Mo</strong>. Mit ${fmtNum(goal.annualReturnPct || 0, 1)}% p.a. Szenario landest du bei <strong>${fmt.format(currentProjected)}</strong> und hast einen Puffer von <strong style="color:var(--positive);">${fmt.format(-currentGap)}</strong>.`;
  } else {
    const maxProjected = futureValueWithMonthlySavings(totals.totalCur, goal.maxSavingsRate || current, months, goal.annualReturnPct || 0);
    const corridorText = maxProjected >= target ? `Deine Maximalrate könnte die Lücke schließen.` : `Selbst die Maximalrate bleibt im Szenario unter dem Plan.`;
    note.innerHTML = `Aktuell eingestellt: <strong>${fmtNoCent.format(current)}/Mo</strong>. Mit ${fmtNum(goal.annualReturnPct || 0, 1)}% p.a. Szenario würdest du <strong>${fmt.format(currentProjected)}</strong> erreichen; offen bleiben <strong style="color:var(--negative);">${fmt.format(currentGap)}</strong>. Ohne Rendite wären etwa <strong>${fmt.format(required)}/Mo</strong> nötig. ${corridorText}`;
  }
}

async function refreshUI(opts = {}) {
  syncPositionsFromLedger(); // Single Source of Truth: shares/costPrice immer aus dem Kassenbuch
  const hadExpiredManualQuote = pruneExpiredManualQuoteOverrides();
  if (hadExpiredManualQuote) savePositionsToKV(1000);
  loadManualPrices();
  applyManualQuoteOverrides();
  const totals = renderTotals();
  renderPositions(totals);
  const alloc = renderAllocation(totals);
  renderHistory();
  const goal = renderGoal(totals);
  renderPortfolioAlerts(totals, goal, alloc);
  renderDailyCheck(totals, goal, alloc);
  renderSavingsSim(totals, goal);
  if (alloc) renderRebalancing(totals, alloc);
  if (alloc) renderScenario(totals, alloc);
  renderPortfolioNews();
  renderWatchlist();
  renderJournal();
  renderIncome();
  renderTaxPerformance(totals);
  renderBackupStatus();
  if (typeof renderSecurityStatus === 'function') renderSecurityStatus();
  applyLayoutSettings();
  if (opts.skipAI) {
    renderAnalysisLocal(totals, goal);
  } else {
    renderAnalysisLocal(totals, goal);
    await generateAIAnalysis(totals, goal);
  }
}

function scheduleAIRefresh() {
  if (aiRegenTimer) clearTimeout(aiRegenTimer);
  aiRegenTimer = setTimeout(async () => {
    if (!appData) return;
    const totals = renderTotals();
    const goal = renderGoal(totals);
    await generateAIAnalysis(totals, goal);
  }, 1500);
}

let goalSettingsDirty = false;
function markGoalSettingsDirty(dirty) {
  goalSettingsDirty = dirty;
  const status = document.getElementById('goalApplyStatus');
  const btn = document.getElementById('goalApplyBtn');
  if (status) {
    status.textContent = dirty ? 'Änderungen offen' : 'Aktuell';
    status.classList.toggle('dirty', !!dirty);
  }
  if (btn && !btn.classList.contains('loading')) btn.disabled = false;
}

async function applyGoalSettingsUpdate() {
  if (!appData) return;
  const btn = document.getElementById('goalApplyBtn');
  const status = document.getElementById('goalApplyStatus');
  if (aiRegenTimer) clearTimeout(aiRegenTimer);
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }
  if (status) { status.textContent = 'Aktualisiert alles…'; status.classList.remove('dirty'); }
  try {
    if (status) status.textContent = 'Lädt aktuelle Kurse…';
    await Promise.all([fetchCryptoPrices(), fetchAllCryptoHistories(370), fetchMarketPrices({ forceRefresh: true }), fetchMarketHistory(370), fetchMetalPrices(), fetchMetalHistory(365)]);
    await fetchAllWeeklyCharts();
    if (status) status.textContent = 'Berechnet Simulationen…';
    await refreshUI({ skipAI: true });
    const totals = renderTotals();
    const goal = renderGoal(totals);
    await savePositionsToKV();
    if (status) status.textContent = 'Erstellt KI-Analyse…';
    await generateAIAnalysis(totals, goal);
    markGoalSettingsDirty(false);
    if (status) status.textContent = `Aktualisiert · ${new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}`;
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
  }
}

let usageRefreshTimer = null;
async function initApp() {
  if (appData.goal) {
    document.getElementById('goalYear').value = String(appData.goal.year);
    document.getElementById('goalAmount').value = String(appData.goal.amount);
    document.getElementById('goalSavings').value = String(appData.goal.savingsRate || 0);
    document.getElementById('goalPath').value = String(appData.goal.pathSavingsPct ?? 50);
    document.getElementById('goalRisk').value = String(appData.goal.riskPct ?? 50);
    const setGoalInput = (id, value) => { const el = document.getElementById(id); if (el && value != null) el.value = String(value); };
    setGoalInput('goalType', appData.goal.type || 'wealth');
    setGoalInput('goalPriority', appData.goal.priority || 'medium');
    setGoalInput('goalMonth', appData.goal.month || 12);
    setGoalInput('goalMinSavings', appData.goal.minSavingsRate || 0);
    setGoalInput('goalMaxSavings', appData.goal.maxSavingsRate || Math.max(1000, appData.goal.savingsRate || 0));
    setGoalInput('goalBuffer', appData.goal.bufferPct ?? 10);
    setGoalInput('goalReturn', appData.goal.annualReturnPct ?? 4);
  }
  loadManualPrices();
  chatHistory = [];
  await loadChatMemory();
  renderChatHistory();
  chatShowWelcome();
  renderChatMemoryStatus();
  renderUsage();
  if (usageRefreshTimer) clearInterval(usageRefreshTimer);
  usageRefreshTimer = setInterval(renderUsage, 60000);
  startManualQuoteExpiryTimer();
  await refreshUI({ skipAI: true });
  await Promise.all([fetchCryptoPrices(), fetchAllCryptoHistories(370), fetchMarketPrices(), fetchMarketHistory(370), fetchMetalPrices(), fetchMetalHistory(365)]);
  await fetchAllWeeklyCharts();
  await refreshUI();
  maybeFetchPortfolioNews();
}

function wireEvents() {
  document.getElementById('gateBtn').addEventListener('click', handleGate);
  document.getElementById('gatePw').addEventListener('keydown', e => { if (e.key === 'Enter') handleGate(); });
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);
  document.getElementById('themeToggleBtn').addEventListener('click', toggleTheme);
  document.getElementById('themePickerBtn')?.addEventListener('click', openThemeModal);
  document.getElementById('themeCloseBtn')?.addEventListener('click', closeThemeModal);
  document.getElementById('themeModal')?.addEventListener('click', e => { if (e.target.id === 'themeModal') closeThemeModal(); });
  document.querySelectorAll('[data-theme-choice]').forEach(btn => {
    btn.addEventListener('click', () => {
      setTheme(btn.dataset.themeChoice || 'classic');
      closeThemeModal();
    });
  });
  document.getElementById('modeToggleBtn').addEventListener('click', toggleViewMode);
  document.getElementById('aiPrivacyMode')?.addEventListener('change', e => {
    setAIPrivacyMode(e.target.value);
    renderSecurityStatus();
    if (appData) refreshUI({ skipAI: true });
  });
  document.getElementById('sessionTimeoutSelect')?.addEventListener('change', e => {
    setSessionTimeoutMinutes(e.target.value);
    resetAutoLogout();
    renderSecurityStatus();
  });
  document.getElementById('sessionExtendBtn')?.addEventListener('click', resetAutoLogout);
  document.getElementById('refreshBtn').addEventListener('click', refreshLiveValuesOnly);
  document.getElementById('layoutEditBtn').addEventListener('click', openLayoutModal);
  document.getElementById('layoutCancelBtn').addEventListener('click', closeLayoutModal);
  document.getElementById('layoutSaveBtn').addEventListener('click', saveLayoutModal);
  document.getElementById('layoutResetBtn').addEventListener('click', resetLayoutModal);
  document.getElementById('layoutModal').addEventListener('click', e => { if (e.target.id === 'layoutModal') closeLayoutModal(); });
  document.getElementById('aiRefreshBtn').addEventListener('click', async () => { if (!appData) return; const totals = renderTotals(); const goal = renderGoal(totals); await generateAIAnalysis(totals, goal); });
  document.getElementById('newsRefreshBtn')?.addEventListener('click', () => fetchPortfolioNews({ forceRefresh: true }));
  document.querySelectorAll('[data-news-filter]').forEach(btn => {
    btn.addEventListener('click', () => setNewsFilter(btn.dataset.newsFilter || 'all'));
  });
  document.getElementById('goalApplyBtn').addEventListener('click', applyGoalSettingsUpdate);
  ['goalYear', 'goalAmount', 'goalSavings', 'goalPath', 'goalRisk', 'goalType', 'goalPriority', 'goalMonth', 'goalMinSavings', 'goalMaxSavings', 'goalBuffer', 'goalReturn'].forEach(id => {
    const goalInputEl = document.getElementById(id);
    if (!goalInputEl) return;
    const handleGoalInput = async () => {
      if (!appData) return;
      const year = parseInt(document.getElementById('goalYear').value, 10);
      const amount = parseInt(document.getElementById('goalAmount').value, 10);
      const savingsRate = parseInt(document.getElementById('goalSavings').value, 10) || 0;
      const pathSavingsPct = parseInt(document.getElementById('goalPath').value, 10) || 0;
      const riskPct = parseInt(document.getElementById('goalRisk').value, 10) || 0;
      const minSavingsRate = parseInt(document.getElementById('goalMinSavings')?.value || 0, 10) || 0;
      const maxSavingsRate = Math.max(minSavingsRate, parseInt(document.getElementById('goalMaxSavings')?.value || 0, 10) || 0);
      if (appData.goal) {
        appData.goal.year = year;
        appData.goal.amount = amount;
        appData.goal.savingsRate = savingsRate;
        appData.goal.pathSavingsPct = pathSavingsPct;
        appData.goal.riskPct = riskPct;
        appData.goal.type = document.getElementById('goalType')?.value || 'wealth';
        appData.goal.priority = document.getElementById('goalPriority')?.value || 'medium';
        appData.goal.month = parseInt(document.getElementById('goalMonth')?.value || 12, 10);
        appData.goal.minSavingsRate = minSavingsRate;
        appData.goal.maxSavingsRate = maxSavingsRate;
        appData.goal.bufferPct = parseInt(document.getElementById('goalBuffer')?.value || 0, 10) || 0;
        appData.goal.annualReturnPct = parseFloat(document.getElementById('goalReturn')?.value || 0) || 0;
      }
      const totals = renderTotals();
      const goal = renderGoal(totals);
      markGoalSettingsDirty(true);
    };
    goalInputEl.addEventListener('input', handleGoalInput);
    goalInputEl.addEventListener('change', handleGoalInput);
  });
  document.getElementById('statSavings').addEventListener('click', () => { const slider = document.getElementById('goalSavings'); if (slider) { slider.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => slider.focus(), 400); } });
  document.querySelectorAll('.history-tab').forEach(tab => { tab.addEventListener('click', () => { document.querySelectorAll('.history-tab').forEach(t => t.classList.remove('active')); tab.classList.add('active'); currentHistoryPeriod = tab.dataset.history || '12M'; if (appData) renderHistory(); }); });
  // Legenden-Toggles für Depotchart-Serien
  document.querySelectorAll('.history-legend-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const key = btn.dataset.series;
      if (!key) return;
      historyVisibleSeries[key] = !historyVisibleSeries[key];
      btn.classList.toggle('active', historyVisibleSeries[key]);
      if (appData) renderHistory();
    });
  });
  const positionsPanel = document.getElementById('anchor-positions');
  if (positionsPanel) {
    try {
      if (localStorage.getItem(POSITIONS_PANEL_OPEN_KEY) === '0') positionsPanel.removeAttribute('open');
    } catch (e) {}
    positionsPanel.addEventListener('toggle', () => {
      try { localStorage.setItem(POSITIONS_PANEL_OPEN_KEY, positionsPanel.open ? '1' : '0'); } catch (e) {}
    });
  }
  document.getElementById('positions').addEventListener('click', e => {
    if (e.target.id === 'cashAddDepositBtn') { e.stopPropagation(); openCashTxModal('deposit'); return; }
    if (e.target.id === 'cashAddWithdrawBtn') { e.stopPropagation(); openCashTxModal('withdraw'); return; }
    if (e.target.id === 'cashAddFeeBtn') { e.stopPropagation(); openCashTxModal('fee'); return; }
    if (e.target.id === 'cashAddTaxBtn') { e.stopPropagation(); openCashTxModal('tax'); return; }
    if (e.target.id === 'cashReconcileBtn') { e.stopPropagation(); openCashTxModal('reconcile'); return; }
    if (e.target.id === 'cashShowTxBtn') { e.stopPropagation(); openCashTxList(); return; }
    const metalAdd = e.target.closest('[data-metal-add]');
    if (metalAdd) { e.preventDefault(); e.stopPropagation(); addMetalLot(metalAdd.dataset.metalAdd); return; }
    const metalDel = e.target.closest('[data-metal-del]');
    if (metalDel) { e.preventDefault(); e.stopPropagation(); deleteMetalLot(metalDel.dataset.metalDel, parseInt(metalDel.dataset.lotIndex, 10)); return; }
    const quickEdit = e.target.closest('[data-quickedit-id]');
    if (quickEdit) { e.stopPropagation(); openEditModal(quickEdit.dataset.quickeditId); return; }
    const manualQuoteSave = e.target.closest('[data-manual-quote-save]');
    if (manualQuoteSave) { e.preventDefault(); e.stopPropagation(); saveManualQuoteOverride(manualQuoteSave.dataset.manualQuoteSave); return; }
    const manualQuoteClear = e.target.closest('[data-manual-quote-clear]');
    if (manualQuoteClear) { e.preventDefault(); e.stopPropagation(); clearManualQuoteOverride(manualQuoteClear.dataset.manualQuoteClear); return; }
    if (e.target.closest('[data-manual-quote-input]')) { e.stopPropagation(); return; }
    const editBtn = e.target.closest('[data-edit-id]');
    if (editBtn) { e.stopPropagation(); openEditModal(editBtn.dataset.editId); return; }
    const venueBtn = e.target.closest('[data-venue-pick]');
    if (venueBtn) { e.stopPropagation(); openVenueModal(venueBtn.dataset.venuePick); return; }
    const buyBtn = e.target.closest('[data-buy-id]');
    if (buyBtn) { e.stopPropagation(); openBuyMoreModal(buyBtn.dataset.buyId); return; }
    const sellBtn = e.target.closest('[data-sell-id]');
    if (sellBtn) { e.stopPropagation(); openSellModal(sellBtn.dataset.sellId); return; }
    const removeBtn = e.target.closest('[data-remove-id]');
    if (removeBtn) { e.stopPropagation(); removePosition(removeBtn.dataset.removeId); return; }
    const tabBtn = e.target.closest('.chart-tab');
    if (tabBtn) {
      e.stopPropagation();
      const card = tabBtn.closest('.card');
      const posId = card?.dataset.posId;
      const pos = appData.positions.find(p => p.id === posId);
      if (pos) loadChartForPosition(pos, tabBtn.dataset.period);
      return;
    }
    if (e.target.closest('#metalsRefreshBtn')) {
      e.preventDefault();
      e.stopPropagation();
      refreshMetalsOnly();
      return;
    }
    if (e.target.closest('.metals-summary')) {
      requestAnimationFrame(() => requestAnimationFrame(updatePositionsScrollLimit));
    }
    // Eingaben und echte Bedienelemente nicht als Klapp-Trigger werten.
    // Kein "details" hier: der gesamte Positionen-Bereich ist selbst ein details-Element.
    if (e.target.closest('input, button, a, select, textarea, summary, [contenteditable="true"]')) return;
    const specialCard = e.target.closest('.card.special');
    if (specialCard) {
      if (specialCard.id === 'card-cash') {
        specialCard.classList.toggle('expanded');
        requestAnimationFrame(updatePositionsScrollLimit);
      }
      return;
    }
    const card = e.target.closest('.card');
    if (!card) return;
    const wasExpanded = card.classList.contains('expanded');
    card.classList.toggle('expanded');
    requestAnimationFrame(updatePositionsScrollLimit);
    if (!wasExpanded) {
      // Erst-Öffnung: Chart laden (Wochen-Tab default)
      const posId = card.dataset.posId;
      const pos = appData.positions.find(p => p.id === posId);
      if (pos) loadChartForPosition(pos, chartTabState[posId] || 'week');
    }
  });
  document.getElementById('positions').addEventListener('keydown', e => {
    const input = e.target.closest?.('[data-manual-quote-input]');
    if (!input) return;
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      saveManualQuoteOverride(input.dataset.manualQuoteInput);
    }
  });
  // Cash + Edelmetall Slider via Delegation auf positions Container
  // input = live während des Ziehens (in-place updates, KEIN renderPositions damit Slider erhalten bleibt)
  // change = nach loslassen (volles Re-Render damit % Portfolio in allen Karten aktuell ist)
  document.getElementById('positions').addEventListener('input', e => {
    if (!appData) return;
    const metalInput = e.target.closest('.metal-slider, .metal-gram-input');
    if (metalInput) {
      const metalKey = metalInput.dataset.metal || metalInput.id.replace(/(Slider|GramsInput)$/, '');
      const metal = METALS.find(m => m.key === metalKey);
      if (!metal) return;
      const grams = Math.max(0, Math.min(metal.max, parseInt(metalInput.value, 10) || 0));
      const goalState = ensureGoal();
      goalState[metal.gramsKey] = grams;
      const slider = document.getElementById(`${metal.key}Slider`);
      const input = document.getElementById(`${metal.key}GramsInput`);
      const valEl = document.getElementById(`${metal.key}SliderVal`);
      const valueEl = document.getElementById(`${metal.key}Value`);
      if (slider && slider !== metalInput) slider.value = String(grams);
      if (input && input !== metalInput) input.value = String(grams);
      if (valEl) valEl.textContent = fmtNum(grams, 0) + ' g';
      if (valueEl) valueEl.textContent = fmt.format(grams * metalPrice(metal));
      const totalVal = document.getElementById('metalsTotalVal');
      const totalGrams = document.getElementById('metalsTotalGrams');
      if (totalVal) totalVal.textContent = fmt.format(metalsTotalValue());
      if (totalGrams) totalGrams.textContent = fmtNum(METALS.reduce((sum, m) => sum + metalGrams(m), 0), 0) + ' g gesamt';
      const totals = renderTotals();
      renderAllocation(totals);
      const goal = renderGoal(totals);
      renderSavingsSim(totals, goal);
      savePositionsToKV(1500);
    } else if (e.target.id === 'cashSlider') {
      const cash = parseInt(e.target.value, 10);
      if (!appData.goal) appData.goal = {};
      appData.goal.cash = cash;
      const valEl = document.getElementById('cashSliderVal');
      if (valEl) valEl.textContent = fmt.format(cash);
      const card = e.target.closest('.card');
      if (card) { const pnlVal = card.querySelector('.card-pnl-mini .val'); if (pnlVal) pnlVal.textContent = fmt.format(cash); }
      const totals = renderTotals();
      renderAllocation(totals);
      const goal = renderGoal(totals);
      renderSavingsSim(totals, goal);
      savePositionsToKV(1500);
    }
  });
  document.getElementById('positions').addEventListener('change', e => {
    if (!appData) return;
    if (e.target.closest('.metal-slider, .metal-gram-input') || e.target.id === 'cashSlider') {
      const totals = renderTotals();
      renderPositions(totals); // % Portfolio in allen Karten aktualisieren
      renderAllocation(totals);
    }
  });
  document.getElementById('editCancel').addEventListener('click', closeEditModal);
  document.getElementById('editSave').addEventListener('click', saveEditModal);
  document.getElementById('editModal').addEventListener('click', e => { if (e.target.id === 'editModal') closeEditModal(); });
  document.getElementById('qualityIssues').addEventListener('click', e => {
    const actionBtn = e.target.closest('[data-quality-action]');
    if (actionBtn) runQualityAction(actionBtn.dataset.qualityAction);
  });
  document.getElementById('dailyTaskList')?.addEventListener('click', e => {
    const actionBtn = e.target.closest('[data-daily-action]');
    if (actionBtn) runDailyAction(actionBtn.dataset.dailyAction);
  });
  document.getElementById('qualityActionClose').addEventListener('click', closeQualityActionModal);
  document.getElementById('qualityActionModal').addEventListener('click', e => {
    if (e.target.id === 'qualityActionModal') return closeQualityActionModal();
    const posBtn = e.target.closest('[data-quality-pos]');
    if (posBtn && qualityTaskAction) openQualityPositionInput(posBtn.dataset.qualityPos, qualityTaskAction.kind);
  });
  const historyQualityBadge = document.getElementById('historyQualityBadge');
  if (historyQualityBadge) {
    historyQualityBadge.addEventListener('click', openHistoryQualityModal);
    historyQualityBadge.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openHistoryQualityModal();
      }
    });
  }
  document.getElementById('historyQualityClose')?.addEventListener('click', closeHistoryQualityModal);
  document.getElementById('historyQualityModal')?.addEventListener('click', e => {
    if (e.target.id === 'historyQualityModal') closeHistoryQualityModal();
  });
  document.getElementById('chatSendBtn').addEventListener('click', chatSend);
  document.getElementById('chatClearBtn').addEventListener('click', chatClear);
  document.getElementById('chatWipeBtn').addEventListener('click', chatWipeMemory);
  // Positionen-Ansichts-Toggle (Details / Kompakt)
  const POSVIEW_KEY = STORAGE_PREFIX + 'positions_view';
  const applyPosView = view => {
    const container = document.getElementById('positions');
    if (!container) return;
    container.classList.toggle('compact', view === 'compact');
    document.querySelectorAll('.positions-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    requestAnimationFrame(updatePositionsScrollLimit);
    try { localStorage.setItem(POSVIEW_KEY, view); } catch (e) {}
  };
  document.querySelectorAll('.positions-toggle-btn').forEach(b => b.addEventListener('click', () => applyPosView(b.dataset.view)));
  document.querySelectorAll('.positions-size-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const action = btn.dataset.posSize;
      const current = getPositionsVisibleCards();
      if (action === 'down') setPositionsVisibleCards(current - 1);
      else if (action === 'up') setPositionsVisibleCards(current + 1);
      else setPositionsVisibleCards(POSITIONS_VISIBLE_DEFAULT);
    });
  });
  updatePositionsSizeControls();
  try {
    const savedView = localStorage.getItem(POSVIEW_KEY);
    if (savedView === 'compact') applyPosView('compact');
  } catch (e) {}
  // Mini-Navigation
  document.querySelectorAll('.mini-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.jump);
      if (!target) return;
      // Für details-Element: öffnen
      const det = target.closest && target.closest('details');
      if (det && !det.open) det.open = true;
      const top = target.getBoundingClientRect().top + window.scrollY - 60;
      window.scrollTo({ top, behavior: 'smooth' });
    });
  });
  // Backup / Export / Import
  document.getElementById('backupEncryptedBtn')?.addEventListener('click', () => backupEncryptedJson());
  document.getElementById('backupJsonBtn').addEventListener('click', backupJson);
  document.getElementById('backupCsvBtn').addEventListener('click', backupCsv);
  document.getElementById('backupImportBtn').addEventListener('click', () => document.getElementById('backupFileInput').click());
  document.getElementById('backupFileInput').addEventListener('change', e => { const f = e.target.files?.[0]; if (f) { importJson(f); e.target.value = ''; } });
  // Portfolio zurücksetzen (Gefahrenzone)
  document.getElementById('resetPortfolioBtn').addEventListener('click', openResetModal);
  document.getElementById('resetCancel').addEventListener('click', closeResetModal);
  document.getElementById('resetConfirm').addEventListener('click', confirmResetPortfolio);
  document.getElementById('resetBackupBtn').addEventListener('click', () => backupEncryptedJson('vor-reset'));
  document.getElementById('resetModal').addEventListener('click', e => { if (e.target.id === 'resetModal') closeResetModal(); });
  document.getElementById('resetMasterCode').addEventListener('keydown', e => { if (e.key === 'Enter' && !document.getElementById('resetConfirm').disabled) confirmResetPortfolio(); });
  // Szenario-Rechner
  document.querySelectorAll('[data-scenario]').forEach(inp => {
    inp.addEventListener('input', () => {
      if (!appData) return;
      const totals = renderTotals();
      const alloc = getCategoryAllocation(totals.totalCur);
      renderScenario({ totalCur: totals.totalCur }, alloc);
    });
  });
  const scenResetBtn = document.getElementById('scenarioResetBtn');
  if (scenResetBtn) scenResetBtn.addEventListener('click', () => {
    document.querySelectorAll('[data-scenario]').forEach(inp => { inp.value = 0; });
    if (!appData) return;
    const totals = renderTotals();
    const alloc = getCategoryAllocation(totals.totalCur);
    renderScenario({ totalCur: totals.totalCur }, alloc);
  });
  // Watchlist
  document.getElementById('watchAddBtn').addEventListener('click', () => openWatchModal());
  document.getElementById('wlCancel').addEventListener('click', closeWatchModal);
  document.getElementById('wlSave').addEventListener('click', saveWatchModal);
  document.getElementById('watchModal').addEventListener('click', e => { if (e.target.id === 'watchModal') closeWatchModal(); });
  document.getElementById('watchlistList').addEventListener('click', e => {
    const edit = e.target.closest('[data-watch-edit]'); if (edit) { openWatchModal(edit.dataset.watchEdit); return; }
    const del = e.target.closest('[data-watch-del]'); if (del) { deleteWatchEntry(del.dataset.watchDel); return; }
  });
  // Venue-Auswahl-Modal
  document.getElementById('venueCloseBtn').addEventListener('click', closeVenueModal);
  document.getElementById('venueSaveBtn').addEventListener('click', saveVenueSelection);
  document.getElementById('venueModal').addEventListener('click', e => {
    if (e.target.id === 'venueModal') return closeVenueModal();
    const item = e.target.closest('[data-venue-code]');
    if (item) selectVenue(item.dataset.venueCode);
  });
  // Nachkauf-Modal
  document.getElementById('bmCancel').addEventListener('click', closeBuyMoreModal);
  document.getElementById('bmSave').addEventListener('click', saveBuyMoreModal);
  document.getElementById('buyMoreModal').addEventListener('click', e => { if (e.target.id === 'buyMoreModal') closeBuyMoreModal(); });
  ['bmShares', 'bmPrice', 'bmFees'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateBuyMorePreview);
  });
  // Verkauf-Modal
  document.getElementById('sellCancel').addEventListener('click', closeSellModal);
  document.getElementById('sellSave').addEventListener('click', saveSellModal);
  document.getElementById('sellModal').addEventListener('click', e => { if (e.target.id === 'sellModal') closeSellModal(); });
  ['sellShares', 'sellPrice', 'sellFees'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateSellPreview);
  });
  // Erträge
  document.getElementById('incomeAddBtn').addEventListener('click', () => openIncomeModal());
  document.getElementById('incCancel').addEventListener('click', closeIncomeModal);
  document.getElementById('incSave').addEventListener('click', saveIncomeModal);
  document.getElementById('incGross').addEventListener('input', updateIncomeNet);
  document.getElementById('incTax').addEventListener('input', updateIncomeNet);
  document.getElementById('incomeModal').addEventListener('click', e => { if (e.target.id === 'incomeModal') closeIncomeModal(); });
  document.getElementById('incomeList').addEventListener('click', e => {
    const edit = e.target.closest('[data-income-edit]'); if (edit) { openIncomeModal(edit.dataset.incomeEdit); return; }
    const del = e.target.closest('[data-income-del]'); if (del) { deleteIncome(del.dataset.incomeDel); return; }
  });
  // Journal
  document.getElementById('journalAddBtn').addEventListener('click', () => openJournalModal());
  document.getElementById('jrCancel').addEventListener('click', closeJournalModal);
  document.getElementById('jrSave').addEventListener('click', saveJournalModal);
  document.getElementById('journalModal').addEventListener('click', e => { if (e.target.id === 'journalModal') closeJournalModal(); });
  document.getElementById('journalList').addEventListener('click', e => {
    const edit = e.target.closest('[data-journal-edit]'); if (edit) { openJournalModal(edit.dataset.journalEdit); return; }
    const del = e.target.closest('[data-journal-del]'); if (del) { deleteJournalEntry(del.dataset.journalDel); return; }
    const tog = e.target.closest('[data-journal-toggle]'); if (tog) { toggleJournalDone(tog.dataset.journalToggle); return; }
  });
  document.getElementById('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); chatSend(); } });
  // Position-Management
  document.getElementById('addPosManualBtn').addEventListener('click', () => openAddPositionModal());
  document.getElementById('addPosScreenshotBtn').addEventListener('click', openScreenshotModal);
  document.getElementById('addPosFlatexCsvBtn').addEventListener('click', () => document.getElementById('flatexCsvFileInput').click());
  document.getElementById('flatexCsvFileInput').addEventListener('change', e => handleFlatexCsvFile(e.target.files && e.target.files[0]));
  document.getElementById('flatexCsvCancel').addEventListener('click', closeFlatexCsvModal);
  document.getElementById('flatexCsvImport').addEventListener('click', importFlatexCsvAnalysis);
  document.getElementById('flatexCsvModal').addEventListener('click', e => { if (e.target.id === 'flatexCsvModal') closeFlatexCsvModal(); });
  document.getElementById('flatexAccountCsvBtn').addEventListener('click', () => document.getElementById('flatexAccountCsvFileInput').click());
  document.getElementById('flatexAccountCsvFileInput').addEventListener('change', e => handleFlatexAccountCsvFile(e.target.files && e.target.files[0]));
  document.getElementById('flatexAccountCsvCancel').addEventListener('click', closeFlatexAccountCsvModal);
  document.getElementById('flatexAccountCsvImport').addEventListener('click', importFlatexAccountCsvAnalysis);
  document.getElementById('flatexAccountCsvModal').addEventListener('click', e => { if (e.target.id === 'flatexAccountCsvModal') closeFlatexAccountCsvModal(); });
  document.addEventListener('click', e => {
    const emptyAction = e.target.closest('[data-empty-action]');
    if (!emptyAction) return;
    const action = emptyAction.dataset.emptyAction;
    if (action === 'manual') document.getElementById('addPosManualBtn')?.click();
    if (action === 'screenshot') document.getElementById('addPosScreenshotBtn')?.click();
    if (action === 'depotCsv') document.getElementById('addPosFlatexCsvBtn')?.click();
    if (action === 'watch') document.getElementById('watchAddBtn')?.click();
    if (action === 'journal') document.getElementById('journalAddBtn')?.click();
    if (action === 'income') document.getElementById('incomeAddBtn')?.click();
  });
  document.getElementById('apType').addEventListener('change', updateAddPosTypeFields);
  document.getElementById('apCancel').addEventListener('click', closeAddPositionModal);
  document.getElementById('apSave').addEventListener('click', saveNewPosition);
  document.getElementById('addPosModal').addEventListener('click', e => { if (e.target.id === 'addPosModal') closeAddPositionModal(); });
  // Edelmetall-Kauf Modal
  document.getElementById('mlCancel').addEventListener('click', closeMetalLotModal);
  document.getElementById('mlSave').addEventListener('click', saveMetalLotModal);
  document.getElementById('metalLotModal').addEventListener('click', e => { if (e.target.id === 'metalLotModal') closeMetalLotModal(); });
  // Cash-Transaktions-Modal
  document.getElementById('ctxCancel').addEventListener('click', closeCashTxModal);
  document.getElementById('ctxSave').addEventListener('click', saveCashTxModal);
  document.getElementById('cashTxModal').addEventListener('click', e => { if (e.target.id === 'cashTxModal') closeCashTxModal(); });
  document.getElementById('ctxListClose').addEventListener('click', closeCashTxList);
  document.getElementById('cashTxListModal').addEventListener('click', e => {
    if (e.target.id === 'cashTxListModal') return closeCashTxList();
    const del = e.target.closest('[data-cash-del]');
    if (del) deleteCashTx(del.dataset.cashDel);
  });
  // Screenshot-Modal
  document.getElementById('ssFile').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) handleScreenshotFile(f); });
  // Screenshot-Vorschau-Modal
  document.getElementById('sspCancel').addEventListener('click', closeScreenshotPreviewModal);
  document.getElementById('sspSave').addEventListener('click', saveScreenshotPreview);
  document.getElementById('ssPreviewModal').addEventListener('click', e => { if (e.target.id === 'ssPreviewModal') closeScreenshotPreviewModal(); });
  document.getElementById('ssCancel').addEventListener('click', closeScreenshotModal);
  document.getElementById('ssAnalyze').addEventListener('click', analyzeScreenshot);
  document.getElementById('screenshotModal').addEventListener('click', e => { if (e.target.id === 'screenshotModal') closeScreenshotModal(); });
}
