export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = allowedCorsOrigin(origin);

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
    };

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    if (request.method === 'OPTIONS') {
      if (origin && !allowedOrigin) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { headers: corsHeaders });
    }

    if (origin && !allowedOrigin) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: corsHeaders,
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Bad JSON' }, 400);
    }

    const userKey =
      body.userKey && /^[a-z0-9_-]{1,32}$/i.test(body.userKey)
        ? body.userKey
        : null;

    if (!userKey) {
      return json({ error: 'Missing or invalid userKey' }, 400);
    }

    if (!isAuthorizedRequest(request, env, userKey)) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const limited = await checkRateLimit(request, env, body);
    if (limited) return json(limited.body, limited.status);

    const positionsKey = `positions-${userKey}`;
    const memoryKey = `memory-${userKey}`;
    const memorySummaryKey = `memory-summary-${userKey}`;

    // === KV: Portfolio laden ===
    if (body.action === 'get-positions') {
      const data = await env.KV.get(positionsKey);
      return json({ data });
    }

    // === KV: Portfolio speichern ===
    if (body.action === 'put-positions') {
      if (typeof body.data !== 'string') {
        return json({ error: 'data must be string' }, 400);
      }

      await env.KV.put(positionsKey, body.data);
      return json({ ok: true, key: positionsKey });
    }

    // === KV: Gedächtnis laden ===
    if (body.action === 'get-memory') {
      const raw = await env.KV.get(memoryKey);
      const summary = (await env.KV.get(memorySummaryKey)) || '';

      let memory = [];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) memory = parsed;
        } catch {}
      }

      return json({
        ok: true,
        key: memoryKey,
        summaryKey: memorySummaryKey,
        memoryData: isEncryptedKvBlob(raw) ? raw : null,
        summaryData: isEncryptedKvBlob(summary) ? summary : null,
        memory,
        summary,
      });
    }

    // === KV: Gedächtnis speichern ===
    if (body.action === 'put-memory') {
      if (typeof body.data === 'string' && isEncryptedKvBlob(body.data)) {
        await env.KV.put(memoryKey, body.data);
        return json({
          ok: true,
          key: memoryKey,
          encrypted: true,
        });
      }

      return json({ error: 'encrypted memory data required' }, 400);
    }

    // === KV: Langzeitgedächtnis speichern ===
    if (body.action === 'put-memory-summary') {
      if (typeof body.data === 'string' && isEncryptedKvBlob(body.data)) {
        await env.KV.put(memorySummaryKey, body.data);
        return json({
          ok: true,
          key: memorySummaryKey,
          encrypted: true,
        });
      }

      return json({ error: 'encrypted memory summary data required' }, 400);
    }

    // === KV: Gedächtnis löschen ===
    if (body.action === 'clear-memory') {
      await env.KV.delete(memoryKey);
      await env.KV.delete(memorySummaryKey);

      return json({
        ok: true,
        key: memoryKey,
        summaryKey: memorySummaryKey,
      });
    }

    // === Aktien / ETFs: Livekurse für Depotpositionen ===
    if (body.action === 'get-market-prices') {
      try {
        const result = await getMarketPrices(env, {
          positions: body.positions,
          forceRefresh: body.forceRefresh === true,
        });

        return json(result, 200);
      } catch (e) {
        return json(
          {
            ok: false,
            error: 'Market price fetch failed',
            message: e.message || String(e),
            quotes: {},
          },
          200
        );
      }
    }

    // === Aktien / ETFs: Tageshistorie für Depotverlauf ===
    if (body.action === 'get-market-history') {
      try {
        const result = await getMarketHistory({
          positions: body.positions,
          days: body.days,
        });

        return json(result, 200);
      } catch (e) {
        return json(
          {
            ok: false,
            error: 'Market history fetch failed',
            message: e.message || String(e),
            histories: {},
          },
          200
        );
      }
    }

    // === Aktien / ETFs / Krypto: Kursquelle automatisch aufloesen ===
    if (body.action === 'resolve-market-symbols') {
      try {
        const result = await resolveMarketSymbols({
          positions: body.positions,
        });

        return json(result, 200);
      } catch (e) {
        return json(
          {
            ok: false,
            error: 'Market symbol resolve failed',
            message: e.message || String(e),
            resolutions: {},
          },
          200
        );
      }
    }

    // === Edelmetallpreise: Gold&Co + Fallback + KV-Cache ===
    if (body.action === 'get-metal-prices') {
      try {
        const result = await getMetalPrices(env, {
          forceRefresh: body.forceRefresh === true,
        });

        return json(result, result.ok ? 200 : 502);
      } catch (e) {
        return json(
          {
            ok: false,
            error: 'Metal price fetch failed',
            message: e.message || String(e),
          },
          502
        );
      }
    }

    // === Anthropic API (Single-Turn / Multi-Turn / Vision) ===
    const apiKey = env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return json({ error: 'API key not configured' }, 500);
    }

    let messages;

    if (body.messages && Array.isArray(body.messages)) {
      messages = body.messages;
    } else if (body.image) {
      messages = [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: body.imageMediaType || 'image/png',
                data: body.image,
              },
            },
            {
              type: 'text',
              text: body.prompt || 'Beschreibe das Bild',
            },
          ],
        },
      ];
    } else if (body.prompt) {
      messages = [{ role: 'user', content: body.prompt }];
    } else {
      return json({ error: 'No prompt/messages/image' }, 400);
    }

    const payload = {
      model: 'claude-haiku-4-5',
      max_tokens: body.maxTokens || 1024,
      temperature: body.temperature != null ? body.temperature : 1,
      messages,
    };

    if (body.system) {
      payload.system = body.system;
    }

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    const result = await resp.json();

    if (!resp.ok) {
      return json(
        { error: result.error?.message || 'Anthropic API error' },
        resp.status
      );
    }

    const text = result.content?.[0]?.text || '';

    return json({
      text,
      usage: result.usage,
    });
  },
};

function allowedCorsOrigin(origin) {
  if (!origin) return '*';

  const allowed = new Set([
    'https://mikejb1.github.io',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]);

  return allowed.has(origin) ? origin : '';
}

function isAuthorizedRequest(request, env, userKey) {
  const token = request.headers.get('X-App-Token') || '';
  const configured = parseConfiguredAuthTokens(env);

  if (configured.length === 0) {
    // Ohne konfigurierte Env-Token ist Auth absichtlich geschlossen.
    return false;
  }

  const scope = String(userKey || '').split('-')[0] || '';

  return configured.some((entry) => {
    if (!userKey) return constantTimeEqual(token, entry.token);
    if (entry.scope && entry.scope !== userKey && entry.scope !== scope) return false;
    return constantTimeEqual(token, entry.token);
  });
}

function parseConfiguredAuthTokens(env) {
  const raw = String(
    env.APP_AUTH_TOKEN_HASHES ||
      env.APP_AUTH_TOKEN_HASH ||
      env.APP_AUTH_TOKENS ||
      ''
  ).trim();

  if (!raw) return [];

  return raw
    .split(/[\n,;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const scoped = part.match(/^([a-z0-9_-]{1,32})[:=]([a-f0-9]{64})$/i);
      if (scoped) {
        return {
          scope: scoped[1].toLowerCase(),
          token: scoped[2].toLowerCase(),
        };
      }

      return {
        scope: '',
        token: part.toLowerCase(),
      };
    })
    .filter((entry) => /^[a-f0-9]{64}$/i.test(entry.token));
}

function constantTimeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

function isEncryptedKvBlob(value) {
  if (typeof value !== 'string' || value.length < 20) return false;

  try {
    const parsed = JSON.parse(value);
    return (
      parsed &&
      parsed.v === 1 &&
      typeof parsed.s === 'string' &&
      typeof parsed.i === 'string' &&
      typeof parsed.c === 'string'
    );
  } catch {
    return false;
  }
}

async function checkRateLimit(request, env, body) {
  if (!env.KV) return null;

  const action = String(body?.action || 'ai');
  const group = rateLimitGroup(action, body);
  if (!group) return null;

  const ip =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown';
  const now = Date.now();
  const bucket = Math.floor(now / group.windowMs);
  const userPart = body?.userKey && /^[a-z0-9_-]{1,64}$/i.test(body.userKey)
    ? body.userKey
    : 'nouser';
  const key = `rate:${group.name}:${hashRateLimitPart(userPart)}:${hashRateLimitPart(ip)}:${bucket}`;

  try {
    const current = Number((await env.KV.get(key)) || '0');
    if (current >= group.limit) {
      return {
        status: 429,
        body: {
          error: 'Rate limit exceeded',
          group: group.name,
          retryAfterSeconds: Math.ceil(group.windowMs / 1000),
        },
      };
    }

    await env.KV.put(key, String(current + 1), {
      expirationTtl: Math.ceil(group.windowMs / 1000) + 30,
    });
  } catch {
    // Rate-Limit-Probleme duerfen die App nicht blockieren.
  }

  return null;
}

function rateLimitGroup(action, body) {
  if (action === 'get-market-prices') return { name: 'quotes', limit: 50, windowMs: 5 * 60 * 1000 };
  if (action === 'get-market-history') return { name: 'history', limit: 18, windowMs: 10 * 60 * 1000 };
  if (action === 'get-metal-prices') return { name: 'metals', limit: 30, windowMs: 10 * 60 * 1000 };
  if (action === 'resolve-market-symbols') return { name: 'resolve', limit: 20, windowMs: 10 * 60 * 1000 };

  if (action === 'get-positions' || action === 'get-memory') {
    return { name: 'kv-read', limit: 240, windowMs: 10 * 60 * 1000 };
  }

  if (action === 'put-positions' || action === 'put-memory' || action === 'put-memory-summary') {
    return { name: 'kv-write', limit: 120, windowMs: 10 * 60 * 1000 };
  }

  if (action === 'clear-memory') return { name: 'kv-destructive', limit: 10, windowMs: 10 * 60 * 1000 };

  if (body?.image) return { name: 'ai-vision', limit: 12, windowMs: 10 * 60 * 1000 };
  if (body?.messages || body?.prompt) return { name: 'ai-text', limit: 30, windowMs: 10 * 60 * 1000 };

  return { name: 'misc', limit: 100, windowMs: 10 * 60 * 1000 };
}

function hashRateLimitPart(value) {
  let hash = 2166136261;
  const text = String(value || 'unknown');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

// ==========================================================
// Aktien / ETFs / Krypto
// Primär: Google Finance Direktseiten
// Reserve: Yahoo Finance Quote API
// Währungsumrechnung: Frankfurter
// Einheit: EUR pro Stück
// ==========================================================

const MARKET_CACHE_KEY = 'market-prices-v3';
const MARKET_CACHE_MAX_AGE_MS = 2 * 60 * 1000;
const MARKET_MAX_POSITIONS = 50;
const MARKET_HISTORY_MAX_POSITIONS = 10;
const MARKET_HISTORY_MAX_DAYS = 370;
const MARKET_MAX_GOOGLE_CANDIDATES = 2;
const currencyRateCache = new Map();

function limitMarketCandidates(candidates) {
  const clean = [...new Set((candidates || []).filter(Boolean))];
  return clean.slice(0, MARKET_MAX_GOOGLE_CANDIDATES);
}

async function resolveMarketSymbols(options = {}) {
  const requested = sanitizeMarketPositions(options.positions).slice(
    0,
    MARKET_MAX_POSITIONS
  );

  const resolutions = {};
  const missing = [];
  const warnings = [];

  for (const pos of requested) {
    let symbol = normalizeMarketSymbol(pos);
    let autoResolved = false;

    if (!symbol) {
      try {
        symbol = await resolveYahooSymbol(pos);
        autoResolved = true;
      } catch (e) {
        missing.push({
          id: pos.id,
          name: pos.name || '',
          reason: e.message || 'Kein brauchbares Symbol',
          suggestion: buildQuoteSuggestion(pos, symbol),
        });
        continue;
      }
    }

    const candidates = limitMarketCandidates(buildGoogleFinanceCandidates(symbol, pos));

    try {
      const quote = await fetchGoogleFinanceQuoteWithFallbacks(pos, symbol, candidates);
      resolutions[pos.id] = {
        id: pos.id,
        name: pos.name || '',
        quoteSymbol: symbol,
        symbol,
        googleSymbol: quote.symbol || candidates[0] || '',
        venue: quote.venue || '',
        venueLabel: quote.venueLabel || '',
        source: quote.source || '',
        price: quote.price,
        currency: quote.currency || 'EUR',
        updatedAt: quote.updatedAt || new Date().toISOString(),
        candidates,
        autoResolved,
      };
    } catch (e) {
      missing.push({
        id: pos.id,
        name: pos.name || '',
        symbol,
        candidates,
        reason: e.message || String(e),
        suggestion: buildQuoteSuggestion(pos, symbol),
      });
    }
  }

  return {
    ok: Object.keys(resolutions).length > 0,
    source: 'Google Finance + Yahoo Search',
    updatedAt: new Date().toISOString(),
    resolutions,
    missing,
    warnings,
  };
}

async function getMarketPrices(env, options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const requested = sanitizeMarketPositions(options.positions).slice(
    0,
    MARKET_MAX_POSITIONS
  );

  const nowIso = new Date().toISOString();
  const cached = await readMarketCache(env);
  const cachedQuotes = cached?.quotes || {};
  const quotes = {};
  const warnings = [];
  const missing = [];
  let cacheHits = 0;
  let fetched = 0;
  const pending = [];

  for (const pos of requested) {
    let symbol = normalizeMarketSymbol(pos);
    let autoResolved = false;

    if (!symbol) {
      try {
        symbol = await resolveYahooSymbol(pos);
        autoResolved = true;
        if (symbol) warnings.push(`${pos.name || pos.isin || pos.symbol}: Symbol automatisch auf ${symbol} aufgeloest`);
      } catch (e) {
        missing.push({ id: pos.id, name: pos.name || '', reason: e.message || 'Kein brauchbares Symbol', suggestion: buildQuoteSuggestion(pos, symbol) });
        continue;
      }
    }

    const candidates = limitMarketCandidates(buildGoogleFinanceCandidates(symbol, pos));
    const cachedQuote = findFreshMarketQuote(cachedQuotes, candidates);

    if (!forceRefresh && isFreshMarketQuote(cachedQuote)) {
      quotes[pos.id] = {
        ...cachedQuote,
        id: pos.id,
        requestedSymbol: pos.symbol || '',
        resolvedSymbol: cachedQuote.resolvedSymbol || symbol,
        googleSymbol: cachedQuote.googleSymbol || cachedQuote.symbol || '',
        cache: true,
      };
      cacheHits++;
      continue;
    }

    pending.push({ pos, symbol, candidates, autoResolved });
  }

  for (const item of pending) {
    let { pos, symbol, candidates, autoResolved } = item;
    const cachedQuote = findAnyMarketQuote(cachedQuotes, candidates);

    try {
      let quote = await fetchGoogleFinanceQuoteWithFallbacks(pos, symbol, candidates);

      if (quote.sourceFallback === 'Yahoo') {
        warnings.push(`${pos.name || symbol}: Google Finance nicht verfuegbar, Yahoo-Reserve verwendet`);
      }

      const requestedVenue = String(pos.venue || '').toLowerCase();
      const returnedVenue = String(quote.venue || '').toLowerCase();
      if (requestedVenue && requestedVenue !== 'auto' && returnedVenue && returnedVenue !== requestedVenue) {
        quote.requestedVenue = requestedVenue;
        quote.venueFallback = true;
        quote.venueLabel = `${quote.venueLabel || returnedVenue} (Fallback)`;
        warnings.push(`${pos.name || symbol}: ${requestedVenue} nicht verfuegbar, ${quote.venueLabel} verwendet`);
      }
      quotes[pos.id] = {
        ...quote,
        id: pos.id,
        requestedSymbol: pos.symbol || '',
        resolvedSymbol: symbol,
        googleSymbol: quote.symbol || '',
        cache: false,
      };
      cachedQuotes[String(quote.symbol || candidates[0] || symbol).toUpperCase()] = {
        ...quote,
        resolvedSymbol: symbol,
        googleSymbol: quote.symbol || '',
        cachedAt: nowIso,
      };
      fetched++;
    } catch (e) {
      if (cachedQuote?.price > 0) {
        quotes[pos.id] = {
          ...cachedQuote,
          id: pos.id,
          requestedSymbol: pos.symbol || '',
          resolvedSymbol: cachedQuote.resolvedSymbol || symbol,
          googleSymbol: cachedQuote.googleSymbol || cachedQuote.symbol || '',
          cache: true,
          stale: true,
        };
        warnings.push(`${pos.name || symbol}: alter Cache verwendet`);
      } else {
        if (!autoResolved) {
          try {
            const fallbackSymbol = await resolveYahooSymbol(pos);
            if (fallbackSymbol && fallbackSymbol !== symbol) {
              const fallbackCandidates = limitMarketCandidates(buildGoogleFinanceCandidates(fallbackSymbol, pos));
              const fallbackQuote = await fetchGoogleFinanceQuoteWithFallbacks(pos, fallbackSymbol, fallbackCandidates);
              quotes[pos.id] = {
                ...fallbackQuote,
                id: pos.id,
                requestedSymbol: pos.symbol || '',
                resolvedSymbol: fallbackSymbol,
                googleSymbol: fallbackQuote.symbol || '',
                cache: false,
              };
              cachedQuotes[String(fallbackQuote.symbol || fallbackCandidates[0] || fallbackSymbol).toUpperCase()] = {
                ...fallbackQuote,
                resolvedSymbol: fallbackSymbol,
                googleSymbol: fallbackQuote.symbol || '',
                cachedAt: nowIso,
              };
              warnings.push(`${pos.name || symbol}: Symbol automatisch auf ${fallbackSymbol} korrigiert`);
              fetched++;
              continue;
            }
          } catch {
            // Die urspruengliche Fehlermeldung unten ist hilfreicher.
          }
        }
        missing.push({
          id: pos.id,
          name: pos.name || '',
          symbol,
          reason: e.message || String(e),
          suggestion: buildQuoteSuggestion(pos, symbol),
        });
      }
    }
  }

  await writeMarketCache(env, {
    updatedAt: nowIso,
    quotes: cachedQuotes,
  });

  return {
    ok: Object.keys(quotes).length > 0,
    source: 'Google Finance + Frankfurter',
    unit: 'EUR/share',
    updatedAt: nowIso,
    quotes,
    missing,
    warnings,
    cache: {
      hitCount: cacheHits,
      fetchedCount: fetched,
      maxAgeMinutes: Math.round(MARKET_CACHE_MAX_AGE_MS / 60000),
    },
  };
}

async function getMarketHistory(options = {}) {
  const days = Math.max(
    7,
    Math.min(MARKET_HISTORY_MAX_DAYS, Number(options.days) || MARKET_HISTORY_MAX_DAYS)
  );
  const requested = sanitizeMarketPositions(options.positions).slice(
    0,
    MARKET_HISTORY_MAX_POSITIONS
  );
  const histories = {};
  const missing = [];
  const warnings = [];

  for (const pos of requested) {
    let symbol = normalizeMarketSymbol(pos);
    if (!symbol) {
      try {
        symbol = await resolveYahooSymbol(pos);
        if (symbol) warnings.push(`${pos.name || pos.isin || pos.symbol}: Historiensymbol automatisch auf ${symbol} aufgeloest`);
      } catch (e) {
        missing.push({
          id: pos.id,
          name: pos.name || '',
          reason: e.message || 'Kein Historiensymbol',
          suggestion: buildQuoteSuggestion(pos, symbol),
        });
        continue;
      }
    }

    const candidates = buildYahooSymbolCandidates(symbol, pos).slice(0, 3);
    let lastError = null;
    for (const candidate of candidates) {
      try {
        const history = await fetchYahooDailyHistoryToEur(candidate, days);
        if (history.points.length < 2) throw new Error(`Yahoo Historie ${candidate} zu kurz`);
        histories[pos.id] = {
          id: pos.id,
          requestedSymbol: pos.symbol || '',
          resolvedSymbol: symbol,
          symbol: candidate,
          source: history.source,
          currency: 'EUR',
          sourceCurrency: history.sourceCurrency,
          fxApproximate: history.fxApproximate,
          updatedAt: new Date().toISOString(),
          points: history.points,
        };
        break;
      } catch (e) {
        lastError = e;
      }
    }

    if (!histories[pos.id]) {
      missing.push({
        id: pos.id,
        name: pos.name || '',
        symbol,
        reason: lastError?.message || 'Keine Tageshistorie gefunden',
        suggestion: buildQuoteSuggestion(pos, symbol),
      });
    }
  }

  return {
    ok: Object.keys(histories).length > 0,
    source: 'Yahoo Finance Tageshistorie + Frankfurter',
    unit: 'EUR/share',
    updatedAt: new Date().toISOString(),
    histories,
    missing,
    warnings,
    limits: {
      maxPositionsPerRequest: MARKET_HISTORY_MAX_POSITIONS,
      maxDays: MARKET_HISTORY_MAX_DAYS,
    },
  };
}

function sanitizeMarketPositions(positions) {
  if (!Array.isArray(positions)) return [];

  return positions
    .filter((pos) => pos && typeof pos === 'object')
    .map((pos, index) => ({
      id: String(pos.id || `pos_${index}`).slice(0, 80),
      name: String(pos.name || '').slice(0, 120),
      symbol: String(pos.symbol || '').slice(0, 40),
      isin: String(pos.isin || '').slice(0, 20),
      wkn: String(pos.wkn || '').slice(0, 20),
      venue: String(pos.venue || '').slice(0, 30),
      type: String(pos.type || '').slice(0, 30),
    }));
}

function buildQuoteSuggestion(pos, symbol) {
  const parts = [];
  if (pos.isin) parts.push(`ISIN ${pos.isin} pruefen`);
  if (pos.wkn) parts.push(`WKN ${pos.wkn} pruefen`);
  if (symbol) parts.push(`Symbol ${symbol} pruefen`);
  parts.push('alternativ Handelsplatz Auto/XETRA/Frankfurt testen');
  return parts.join(' · ');
}

const KNOWN_MARKET_SYMBOLS_BY_ISIN = {
  US00724F1012: 'ADBE',    // Adobe
  US00835Q2021: 'AEVA',    // Aeva Technologies
  US81762P1021: '4S0.DE',  // ServiceNow Xetra
  US5949724083: 'MSTR',    // Strategy / ex MicroStrategy
  US67066G1040: 'NVD.DE',  // NVIDIA Xetra
  US02079K3059: 'ABEA.DE', // Alphabet A Xetra
  DE000PAG9113: 'P911.DE', // Porsche AG Xetra
  US2561631068: 'DOCU',    // DocuSign
  FR0000121014: 'MC.PA',   // LVMH
  DK0062498333: 'NOVO-B.CO', // Novo Nordisk B
  US70450Y1038: 'PYPL',    // PayPal
  US7561091049: 'O',       // Realty Income
  AT0000831706: 'WIE.VI',  // Wienerberger
  IE000BI8OT95: 'MWRD.DE', // Amundi Core MSCI World UCITS ETF Acc
  IE00BLR6Q544: 'H3R0.DE', // Global X Video Games & Esports UCITS ETF
  LU1681045370: 'AEEM.PA', // Amundi MSCI Emerging Markets UCITS ETF
  IE00BG0J4841: 'IS4S.DE', // iShares Digital Security UCITS ETF
};

const KNOWN_MARKET_SYMBOLS_BY_WKN = {
  871981: 'ADBE', // Adobe
  A407ZD: 'AEVA', // Aeva Technologies
  722713: 'MSTR', // Strategy / ex MicroStrategy
  A2JHLZ: 'DOCU', // DocuSign
  853292: 'MC.PA', // LVMH
  A3EU6F: 'NOVO-B.CO', // Novo Nordisk B
  A14R7U: 'PYPL', // PayPal
  899744: 'O', // Realty Income
  852894: 'WIE.VI', // Wienerberger
  ETF146: 'MWRD.DE', // Amundi Core MSCI World UCITS ETF Acc
  A2QKQ5: 'H3R0.DE', // Global X Video Games & Esports UCITS ETF
  A2H58J: 'AEEM.PA', // Amundi MSCI Emerging Markets UCITS ETF
  A2JNYG: 'IS4S.DE', // iShares Digital Security UCITS ETF
};

const KNOWN_MARKET_SYMBOLS_BY_NAME = [
  { pattern: /adobe/i, symbol: 'ADBE' },
  { pattern: /aeva/i, symbol: 'AEVA' },
  { pattern: /servicenow/i, symbol: '4S0.DE' },
  { pattern: /microstrateg|strategy/i, symbol: 'MSTR' },
  { pattern: /nvidia/i, symbol: 'NVD.DE' },
  { pattern: /alphabet/i, symbol: 'ABEA.DE' },
  { pattern: /porsche/i, symbol: 'P911.DE' },
  { pattern: /docusign/i, symbol: 'DOCU' },
  { pattern: /ishares.*digital.*security|digital.*security/i, symbol: 'IS4S.DE' },
  { pattern: /lvmh|mo[eë]t|vuitton/i, symbol: 'MC.PA' },
  { pattern: /novo.*nordisk/i, symbol: 'NOVO-B.CO' },
  { pattern: /paypal/i, symbol: 'PYPL' },
  { pattern: /realty.*income/i, symbol: 'O' },
  { pattern: /wienerberger/i, symbol: 'WIE.VI' },
  { pattern: /bitcoin/i, symbol: 'BTC-EUR' },
  { pattern: /amundi.*core.*msci.*world|amundi.*msci.*world/i, symbol: 'MWRD.DE' },
  { pattern: /amundi.*emerging.*markets|msci.*emerging.*markets/i, symbol: 'AEEM.PA' },
  { pattern: /global.*video.*games|video.*games.*esports/i, symbol: 'H3R0.DE' },
];

const GOOGLE_KNOWN_MARKET_SYMBOLS_BY_ISIN = {
  US00724F1012: ['ADBE:NASDAQ'],
  US00835Q2021: ['AEVA:NYSE'],
  US81762P1021: ['4S0:ETR', 'NOW:NYSE'],
  US5949724083: ['MSTR:NASDAQ'],
  US67066G1040: ['NVD:ETR', 'NVDA:NASDAQ'],
  US02079K3059: ['ABEA:ETR', 'GOOGL:NASDAQ'],
  DE000PAG9113: ['P911:ETR', 'P911:FRA'],
  US2561631068: ['DOCU:NASDAQ'],
  FR0000121014: ['MC:EPA'],
  DK0062498333: ['NOVO-B:CPH'],
  US70450Y1038: ['PYPL:NASDAQ'],
  US7561091049: ['O:NYSE'],
  AT0000831706: ['WIE:VIE'],
  IE000BI8OT95: ['MWRD:EPA'],
  IE00BLR6Q544: ['HERU:LON'],
  LU1681045370: ['AEEM:EPA'],
  IE00BG0J4841: ['IS4S:ETR'],
};

const GOOGLE_KNOWN_MARKET_SYMBOLS_BY_WKN = {
  871981: ['ADBE:NASDAQ'],
  A407ZD: ['AEVA:NYSE'],
  722713: ['MSTR:NASDAQ'],
  A2JHLZ: ['DOCU:NASDAQ'],
  853292: ['MC:EPA'],
  A3EU6F: ['NOVO-B:CPH'],
  A14R7U: ['PYPL:NASDAQ'],
  899744: ['O:NYSE'],
  852894: ['WIE:VIE'],
  ETF146: ['MWRD:EPA'],
  A2QKQ5: ['HERU:LON'],
  A2H58J: ['AEEM:EPA'],
  A2JNYG: ['IS4S:ETR'],
};

const GOOGLE_KNOWN_MARKET_SYMBOLS_BY_NAME = [
  { pattern: /adobe/i, symbols: ['ADBE:NASDAQ'] },
  { pattern: /aeva/i, symbols: ['AEVA:NYSE'] },
  { pattern: /servicenow/i, symbols: ['4S0:ETR', 'NOW:NYSE'] },
  { pattern: /microstrateg|strategy/i, symbols: ['MSTR:NASDAQ'] },
  { pattern: /nvidia/i, symbols: ['NVD:ETR', 'NVDA:NASDAQ'] },
  { pattern: /alphabet/i, symbols: ['ABEA:ETR', 'GOOGL:NASDAQ'] },
  { pattern: /porsche/i, symbols: ['P911:ETR', 'P911:FRA'] },
  { pattern: /docusign/i, symbols: ['DOCU:NASDAQ'] },
  { pattern: /ishares.*digital.*security|digital.*security/i, symbols: ['IS4S:ETR'] },
  { pattern: /lvmh|mo[eë]t|vuitton/i, symbols: ['MC:EPA'] },
  { pattern: /novo.*nordisk/i, symbols: ['NOVO-B:CPH'] },
  { pattern: /paypal/i, symbols: ['PYPL:NASDAQ'] },
  { pattern: /realty.*income/i, symbols: ['O:NYSE'] },
  { pattern: /wienerberger/i, symbols: ['WIE:VIE'] },
  { pattern: /bitcoin/i, symbols: ['BTC-EUR'] },
  { pattern: /amundi.*core.*msci.*world|amundi.*msci.*world/i, symbols: ['MWRD:EPA'] },
  { pattern: /amundi.*emerging.*markets|msci.*emerging.*markets/i, symbols: ['AEEM:EPA'] },
  { pattern: /global.*video.*games|video.*games.*esports/i, symbols: ['HERU:LON'] },
];

const GOOGLE_EXCHANGE_BY_VENUE = {
  xetra: 'ETR',
  frankfurt: 'FRA',
  wien: 'VIE',
  nasdaq: 'NASDAQ',
  nyse: 'NYSE',
};

const GOOGLE_EXCHANGE_BY_YAHOO_SUFFIX = {
  DE: 'ETR',
  F: 'FRA',
  VI: 'VIE',
  PA: 'EPA',
  CO: 'CPH',
};

const GOOGLE_VENUE_BY_EXCHANGE = {
  ETR: 'xetra',
  FRA: 'frankfurt',
  VIE: 'wien',
  EPA: 'paris',
  LON: 'london',
  CPH: 'copenhagen',
  NASDAQ: 'nasdaq',
  NYSE: 'nyse',
};

const GOOGLE_VENUE_LABEL = {
  xetra: 'XETRA',
  frankfurt: 'Frankfurt',
  wien: 'Wien',
  paris: 'Euronext Paris',
  london: 'London',
  copenhagen: 'Kopenhagen',
  nasdaq: 'NASDAQ',
  nyse: 'NYSE',
  google_crypto: 'Google Crypto',
};

function normalizeMarketSymbol(pos) {
  const rawName = String(pos.name || '');
  const name = normalizeText(rawName);
  let symbol = String(pos.symbol || pos.isin || pos.wkn || '')
    .replace(/^([A-Z]{2,10}:)/i, '')
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9.=^_-]/g, '');

  const isin = String(pos.isin || symbol || '').replace(/\s+/g, '').toUpperCase();
  if (KNOWN_MARKET_SYMBOLS_BY_ISIN[isin]) {
    return KNOWN_MARKET_SYMBOLS_BY_ISIN[isin];
  }

  const wkn = String(pos.wkn || symbol || '').replace(/\s+/g, '').toUpperCase();
  if (KNOWN_MARKET_SYMBOLS_BY_WKN[wkn]) {
    return KNOWN_MARKET_SYMBOLS_BY_WKN[wkn];
  }

  // Wenn die App bereits einen konkreten Yahoo-/Handelsplatz-Ticker sendet,
  // diesen nie per Namensregel auf einen anderen Handelsplatz umbiegen.
  if (symbol && !/^[A-Z0-9]{12}$/.test(symbol) && !looksLikeWkn(symbol)) {
    return symbol;
  }

  const knownByName = KNOWN_MARKET_SYMBOLS_BY_NAME.find((entry) => {
    return entry.pattern.test(rawName) || name.includes(entry.symbol.toLowerCase());
  });

  if (knownByName) {
    return knownByName.symbol;
  }

  return '';
}

function looksLikeIsin(value) {
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(String(value || '').replace(/\s+/g, '').toUpperCase());
}

function looksLikeWkn(value) {
  return /^[A-Z0-9]{6}$/.test(String(value || '').replace(/\s+/g, '').toUpperCase());
}

const YAHOO_VENUE_SUFFIX = {
  xetra: '.DE',
  frankfurt: '.F',
  tradegate: '.TG',
  lus: '.LU',
  muenchen: '.MU',
  stuttgart: '.SG',
  duesseldorf: '.DU',
  wien: '.VI',
};

const YAHOO_VENUE_LABEL = {
  auto: 'Auto',
  xetra: 'XETRA',
  frankfurt: 'Frankfurt',
  tradegate: 'Tradegate',
  lus: 'L&S',
  muenchen: 'Muenchen',
  stuttgart: 'Stuttgart',
  duesseldorf: 'Duesseldorf',
  wien: 'Wien',
};

function buildYahooSymbolCandidates(symbol, pos = {}) {
  const clean = String(symbol || '').trim().toUpperCase();
  if (!clean) return [];

  const candidates = [clean];
  const hasSuffix = /[.=^]/.test(clean);
  const venue = String(pos.venue || '').toLowerCase();
  const venueSuffix = YAHOO_VENUE_SUFFIX[venue];

  if (venueSuffix && venue !== 'auto') {
    const base = clean.replace(/\.[A-Z]{1,4}$/i, '');
    candidates.unshift(`${base}${venueSuffix}`);
  }

  if (!hasSuffix && clean.length <= 8) {
    candidates.push(
      `${clean}.DE`,
      `${clean}.F`,
      `${clean}.VI`,
      `${clean}.AS`,
      `${clean}.PA`,
      `${clean}.MI`,
      `${clean}.L`
    );
  }

  return [...new Set(candidates)];
}

function buildGoogleFinanceCandidates(symbol, pos = {}) {
  const cryptoCandidate = buildGoogleCryptoCandidate(symbol, pos);
  if (cryptoCandidate) return [cryptoCandidate];

  const clean = String(symbol || '').trim().toUpperCase();
  const rawSymbol = String(pos.symbol || '').replace(/\s+/g, '').toUpperCase();
  const name = String(pos.name || '');
  const isin = String(pos.isin || (looksLikeIsin(rawSymbol) ? rawSymbol : '') || clean || '').replace(/\s+/g, '').toUpperCase();
  const wkn = String(pos.wkn || (looksLikeWkn(rawSymbol) ? rawSymbol : '') || clean || '').replace(/\s+/g, '').toUpperCase();
  const candidates = [];
  const add = (value) => {
    const v = String(value || '').trim().toUpperCase();
    if (v && !candidates.includes(v)) candidates.push(v);
  };
  const addMany = (values) => (values || []).forEach(add);
  const requestedExchange = GOOGLE_EXCHANGE_BY_VENUE[String(pos.venue || '').toLowerCase()];
  const yahooMatch = clean.match(/^([A-Z0-9._-]{1,12})\.([A-Z]{1,4})$/);
  const base = yahooMatch
    ? yahooMatch[1]
    : clean.replace(/^([A-Z]{2,10}:)/i, '').replace(/\.[A-Z]{1,4}$/i, '');
  const suffixExchange = yahooMatch
    ? GOOGLE_EXCHANGE_BY_YAHOO_SUFFIX[yahooMatch[2]]
    : null;
  const knownSymbols = [
    ...(GOOGLE_KNOWN_MARKET_SYMBOLS_BY_ISIN[isin] || []),
    ...(GOOGLE_KNOWN_MARKET_SYMBOLS_BY_WKN[wkn] || []),
  ];

  if (requestedExchange) {
    if (base && !base.includes('=') && !base.startsWith('^')) {
      add(`${base}:${requestedExchange}`);
    }
    knownSymbols.forEach((known) => {
      const knownBase = String(known || '').split(':')[0];
      if (knownBase) add(`${knownBase}:${requestedExchange}`);
    });
  }

  addMany(knownSymbols);

  const knownByName = GOOGLE_KNOWN_MARKET_SYMBOLS_BY_NAME.find((entry) =>
    entry.pattern.test(name)
  );
  if (knownByName) {
    if (requestedExchange) {
      knownByName.symbols.forEach((known) => {
        const knownBase = String(known || '').split(':')[0];
        if (knownBase) add(`${knownBase}:${requestedExchange}`);
      });
    }
    addMany(knownByName.symbols);
  }

  if (clean.includes(':')) add(clean);

  if (base && !base.includes('=') && !base.startsWith('^')) {
    if (suffixExchange) add(`${base}:${suffixExchange}`);
    add(`${base}:ETR`);
    add(`${base}:FRA`);
  }

  return candidates;
}

function buildGoogleCryptoCandidate(symbol, pos = {}) {
  if (!isCryptoMarketPosition(pos, symbol)) return '';

  const raw = String(symbol || pos.symbol || pos.name || '').toUpperCase();
  const name = String(pos.name || '').toUpperCase();
  const compact = `${raw} ${name}`;

  const known = [
    ['SOL', /(^|[^A-Z])SOL([^A-Z]|$)|SOLANA/],
    ['XRP', /(^|[^A-Z])XRP([^A-Z]|$)|RIPPLE/],
    ['BTC', /(^|[^A-Z])BTC([^A-Z]|$)|BITCOIN/],
    ['ETH', /(^|[^A-Z])ETH([^A-Z]|$)|ETHER(EUM)?/],
    ['ADA', /(^|[^A-Z])ADA([^A-Z]|$)|CARDANO/],
    ['DOT', /(^|[^A-Z])DOT([^A-Z]|$)|POLKADOT/],
  ];

  const match = known.find(([, pattern]) => pattern.test(compact));
  return match ? `${match[0]}-EUR` : '';
}

function isCryptoMarketPosition(pos = {}, symbol = '') {
  const type = String(pos.type || '').toLowerCase();
  const value = `${symbol || ''} ${pos.symbol || ''} ${pos.name || ''}`.toLowerCase();
  return type === 'crypto' || /\b(sol|xrp|btc|eth|ada|dot|bitcoin|solana|ripple|ethereum)\b/.test(value);
}

async function fetchGoogleFinanceQuoteWithFallbacks(pos, symbol, candidates = []) {
  let lastError = null;

  for (const candidate of candidates) {
    try {
      return await fetchGoogleFinanceQuoteToEur(candidate);
    } catch (e) {
      lastError = e;
    }
  }

  try {
    const yahooQuote = await fetchYahooQuoteWithFallbacks(pos, symbol);
    return {
      ...yahooQuote,
      sourceFallback: 'Yahoo',
    };
  } catch (e) {
    lastError = e || lastError;
  }

  throw lastError || new Error(`Kein Google-Finance-Kurs fuer ${symbol}`);
}

async function fetchGoogleFinanceQuoteToEur(candidate) {
  const quote = await fetchGoogleFinanceQuote(candidate);
  const rate = await fetchCurrencyToEur(quote.currency);
  const priceEur = quote.price * rate;
  const previousCloseEur = quote.previousClose ? quote.previousClose * rate : null;
  const changeEur = Number.isFinite(quote.change)
    ? quote.change * rate
    : previousCloseEur
      ? priceEur - previousCloseEur
      : null;
  const changePct =
    Number.isFinite(quote.changePct)
      ? quote.changePct
      : previousCloseEur && previousCloseEur > 0
        ? ((priceEur - previousCloseEur) / previousCloseEur) * 100
        : null;

  const venue = inferVenueFromGoogleSymbol(candidate);

  return {
    price: roundQuoteValue(priceEur),
    change: Number.isFinite(changeEur) ? roundQuoteValue(changeEur) : null,
    changePct: Number.isFinite(changePct) ? roundMoney(changePct) : null,
    currency: 'EUR',
    previousClose: previousCloseEur ? roundQuoteValue(previousCloseEur) : null,
    symbol: candidate,
    venue,
    venueLabel: GOOGLE_VENUE_LABEL[venue] || quote.exchange || 'Google Finance',
    source: `Google Finance (${candidate})`,
    updatedAt: quote.updatedAt || new Date().toISOString(),
  };
}

async function fetchGoogleFinanceQuote(candidate) {
  const normalized = String(candidate || '').trim().toUpperCase();
  if (!normalized) throw new Error('Google-Finance-Symbol fehlt');

  const url = `https://www.google.com/finance/quote/${encodeURIComponent(
    normalized
  )}?hl=de`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 Portfolio-Google-Finance-Checker/1.0',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'de-AT,de;q=0.9,en;q=0.7',
      'Cache-Control': 'no-cache, no-store, max-age=0',
      Pragma: 'no-cache',
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!resp.ok) {
    throw new Error(`Google Finance ${normalized} HTTP ${resp.status}`);
  }

  const html = await resp.text();
  if (/captcha|unusual traffic|sorry\/index/i.test(html)) {
    throw new Error(`Google Finance ${normalized} blockiert`);
  }

  const quote = normalized.includes('-')
    ? parseGoogleCryptoQuote(html, normalized)
    : parseGoogleExchangeQuote(html, normalized);

  if (!quote?.price || quote.price <= 0) {
    throw new Error(`Google Finance ${normalized} Preis nicht lesbar`);
  }

  return quote;
}

function parseGoogleExchangeQuote(html, candidate) {
  const [symbol, exchange] = String(candidate || '').toUpperCase().split(':');
  if (!symbol || !exchange) return null;

  const pattern = new RegExp(
    '\\["([^"\\\\]*(?:\\\\.[^"\\\\]*)*)",\\["' +
      escapeRegex(symbol) +
      '","' +
      escapeRegex(exchange) +
      '"\\],"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)",[0-9]+,(null|"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"),\\[(-?[0-9]+(?:\\.[0-9]+)?),(-?[0-9]+(?:\\.[0-9]+)?),(-?[0-9]+(?:\\.[0-9]+)?),[^\\]]*\\],null,(-?[0-9]+(?:\\.[0-9]+)?|null)[\\s\\S]{0,700}?\\[([0-9]{10})\\]',
    'i'
  );

  const match = String(html || '').match(pattern);
  if (!match) return null;

  return {
    name: decodeGoogleString(match[2]),
    symbol,
    exchange,
    currency: match[3] === 'null' ? 'EUR' : decodeGoogleString(match[3].slice(1, -1)),
    price: Number(match[4]),
    change: Number(match[5]),
    changePct: Number(match[6]),
    previousClose: match[7] === 'null' ? null : Number(match[7]),
    updatedAt: new Date(Number(match[8]) * 1000).toISOString(),
  };
}

function parseGoogleCryptoQuote(html, candidate) {
  const [base, quoteCurrency = 'EUR'] = String(candidate || '').toUpperCase().split('-');
  if (!base || !quoteCurrency) return null;

  const pattern = new RegExp(
    '\\["([^"\\\\]*(?:\\\\.[^"\\\\]*)*)",null,"([^"\\\\]*(?:\\\\.[^"\\\\]*)*' +
      escapeRegex(base) +
      ' \\/ ' +
      escapeRegex(quoteCurrency) +
      '[^"\\\\]*(?:\\\\.[^"\\\\]*)*)",[0-9]+,null,\\[(-?[0-9]+(?:\\.[0-9]+)?),(-?[0-9]+(?:\\.[0-9]+)?),(-?[0-9]+(?:\\.[0-9]+)?),[^\\]]*\\],null,(-?[0-9]+(?:\\.[0-9]+)?|null)[\\s\\S]{0,700}?"' +
      escapeRegex(candidate) +
      '"',
    'i'
  );

  const match = String(html || '').match(pattern);
  if (!match) return null;
  const timestampMatch = String(html || '').slice(match.index, match.index + 800).match(/\[([0-9]{10})\]/);

  return {
    name: decodeGoogleString(match[2]),
    symbol: base,
    exchange: quoteCurrency,
    currency: quoteCurrency,
    price: Number(match[3]),
    change: Number(match[4]),
    changePct: Number(match[5]),
    previousClose: match[6] === 'null' ? null : Number(match[6]),
    updatedAt: timestampMatch
      ? new Date(Number(timestampMatch[1]) * 1000).toISOString()
      : new Date().toISOString(),
  };
}

function inferVenueFromGoogleSymbol(candidate) {
  const value = String(candidate || '').toUpperCase();
  if (value.includes('-EUR')) return 'google_crypto';
  const exchange = value.split(':')[1] || '';
  return GOOGLE_VENUE_BY_EXCHANGE[exchange] || 'auto';
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeGoogleString(value) {
  const raw = String(value || '');
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw.replace(/\\u0026/g, '&');
  }
}

async function fetchYahooQuoteWithFallbacks(pos, symbol) {
  const candidates = buildYahooSymbolCandidates(symbol, pos);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      return await fetchYahooQuoteToEur(candidate);
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error(`Kein Kurs fuer ${symbol}`);
}

async function fetchYahooQuoteToEur(symbol) {
  const quote = await fetchYahooLiveQuote(symbol);
  return await normalizeYahooQuoteToEur(symbol, quote);
}

async function normalizeYahooQuoteToEur(symbol, quote) {
  const rate = await fetchCurrencyToEur(quote.currency);
  const priceEur = quote.price * rate;
  const previousCloseEur = quote.previousClose ? quote.previousClose * rate : null;
  const changeEur = Number.isFinite(quote.change)
    ? quote.change * rate
    : previousCloseEur
      ? priceEur - previousCloseEur
      : null;
  const changePct =
    Number.isFinite(quote.changePct)
      ? quote.changePct
      : previousCloseEur && previousCloseEur > 0
        ? ((priceEur - previousCloseEur) / previousCloseEur) * 100
        : null;

  return {
    price: roundQuoteValue(priceEur),
    change: Number.isFinite(changeEur) ? roundQuoteValue(changeEur) : null,
    changePct: Number.isFinite(changePct) ? roundMoney(changePct) : null,
    currency: 'EUR',
    previousClose: previousCloseEur ? roundQuoteValue(previousCloseEur) : null,
    symbol,
    venue: inferVenueFromYahooSymbol(symbol),
    venueLabel: YAHOO_VENUE_LABEL[inferVenueFromYahooSymbol(symbol)] || 'Yahoo',
    source: `Yahoo Finance (${symbol})`,
    updatedAt: quote.marketTime || new Date().toISOString(),
  };
}

async function fetchYahooQuotesBatchToEur(symbols) {
  const rawQuotes = await fetchYahooQuoteApiBatch(symbols);
  const result = new Map();

  for (const [symbol, quote] of rawQuotes.entries()) {
    try {
      result.set(symbol, await normalizeYahooQuoteToEur(symbol, quote));
    } catch {
      // Einzelne defekte Waehrungsumrechnungen duerfen den Batch nicht stoppen.
    }
  }

  return result;
}

async function fetchYahooQuoteApiBatch(symbols) {
  const uniqueSymbols = [...new Set(
    (symbols || [])
      .map((symbol) => String(symbol || '').trim().toUpperCase())
      .filter(Boolean)
  )];
  const result = new Map();
  const chunkSize = 25;

  for (let i = 0; i < uniqueSymbols.length; i += chunkSize) {
    const chunk = uniqueSymbols.slice(i, i + chunkSize);
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${chunk
      .map((symbol) => encodeURIComponent(symbol))
      .join(',')}`;

    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 Portfolio-Market-Price-Checker/1.0',
        Accept: 'application/json',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache',
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    if (!resp.ok) continue;

    const data = await resp.json();
    const rows = Array.isArray(data?.quoteResponse?.result)
      ? data.quoteResponse.result
      : [];

    for (const row of rows) {
      const parsed = parseYahooQuoteRow(row);
      if (parsed) result.set(parsed.symbol.toUpperCase(), parsed.quote);
    }
  }

  return result;
}

function inferVenueFromYahooSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s.endsWith('.DE')) return 'xetra';
  if (s.endsWith('.F')) return 'frankfurt';
  if (s.endsWith('.TG')) return 'tradegate';
  if (s.endsWith('.LU')) return 'lus';
  if (s.endsWith('.MU')) return 'muenchen';
  if (s.endsWith('.SG')) return 'stuttgart';
  if (s.endsWith('.DU')) return 'duesseldorf';
  if (s.endsWith('.VI')) return 'wien';
  return 'auto';
}

async function resolveYahooSymbol(pos) {
  const symbolAsIsin = looksLikeIsin(pos.symbol) ? pos.symbol : '';
  const symbolAsWkn = looksLikeWkn(pos.symbol) ? pos.symbol : '';
  const queries = [pos.isin, symbolAsIsin, pos.wkn, symbolAsWkn, pos.name].filter(Boolean);
  let best = null;

  for (const query of queries) {
    const resp = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 Portfolio-Market-Resolver/1.0',
          Accept: 'application/json',
        },
      }
    );
    if (!resp.ok) continue;
    const data = await resp.json();
    const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
    for (const q of quotes) {
      const symbol = String(q.symbol || '').toUpperCase();
      if (!symbol || symbol.includes('=') || symbol.startsWith('^')) continue;
      const type = String(q.quoteType || '').toUpperCase();
      if (type && !['EQUITY', 'ETF', 'MUTUALFUND'].includes(type)) continue;
      const score = scoreYahooSearchResult(pos, q);
      if (!best || score > best.score) best = { symbol, score };
    }
  }

  if (!best?.symbol) throw new Error('Kein Yahoo-Symbol gefunden');
  return best.symbol;
}

function scoreYahooSearchResult(pos, q) {
  const symbol = String(q.symbol || '').toUpperCase();
  const currency = String(q.currency || '').toUpperCase();
  const exchange = normalizeText(`${q.exchange || ''} ${q.exchDisp || ''}`);
  const name = normalizeText(`${q.shortname || ''} ${q.longname || ''}`);
  const posName = normalizeText(pos.name || '');
  let score = 0;
  if (currency === 'EUR') score += 60;
  if (/\.(DE|F|VI|TG|MU|SG|DU|LU)$/.test(symbol)) score += 45;
  if (exchange.includes('xetra') || exchange.includes('frankfurt') || exchange.includes('vienna') || exchange.includes('germany')) score += 25;
  if (String(q.quoteType || '').toUpperCase() === 'ETF') score += String(pos.type || '').toLowerCase() === 'etf' ? 30 : 0;
  if (String(q.quoteType || '').toUpperCase() === 'EQUITY') score += String(pos.type || '').toLowerCase() === 'aktie' ? 30 : 0;
  const importantWords = posName.split(/[^a-z0-9]+/).filter(w => w.length >= 4).slice(0, 4);
  score += importantWords.filter(w => name.includes(w)).length * 10;
  if (currency === 'USD') score -= 10;
  return score;
}

async function fetchYahooLiveQuote(symbol) {
  try {
    return await fetchYahooQuoteApi(symbol);
  } catch (e) {
    return await fetchYahooChartQuote(symbol);
  }
}

async function fetchYahooQuoteApi(symbol) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 Portfolio-Market-Price-Checker/1.0',
      Accept: 'application/json',
    },
  });

  if (!resp.ok) {
    throw new Error(`Yahoo Quote ${symbol} HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const q = data?.quoteResponse?.result?.[0];
  if (!q) throw new Error(`Yahoo Quote ${symbol} leer`);
  const parsed = parseYahooQuoteRow(q);
  if (!parsed) throw new Error(`Yahoo Quote ${symbol} Preis nicht lesbar`);
  return parsed.quote;
}

function parseYahooQuoteRow(q) {
  if (!q) return null;

  const symbol = String(q.symbol || '').toUpperCase();
  if (!symbol) return null;

  const price = firstPositiveNumber([
    q.regularMarketPrice,
    q.postMarketPrice,
    q.preMarketPrice,
  ]);
  const previousClose = firstPositiveNumber([
    q.regularMarketPreviousClose,
    q.previousClose,
  ]);

  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }

  const change = Number(q.regularMarketChange);
  const changePct = Number(q.regularMarketChangePercent);
  const marketTime = Number(q.regularMarketTime);

  return {
    symbol,
    quote: {
      price,
      previousClose,
      change: Number.isFinite(change)
        ? change
        : Number.isFinite(previousClose) && previousClose > 0
          ? price - previousClose
          : null,
      changePct: Number.isFinite(changePct)
        ? changePct
        : Number.isFinite(previousClose) && previousClose > 0
          ? ((price - previousClose) / previousClose) * 100
          : null,
      currency: String(q.currency || 'USD').toUpperCase(),
      marketTime: Number.isFinite(marketTime) && marketTime > 0
        ? new Date(marketTime * 1000).toISOString()
        : null,
    },
  };
}

async function fetchYahooChartQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=5d&interval=1d`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 Portfolio-Market-Price-Checker/1.0',
      Accept: 'application/json',
    },
  });

  if (!resp.ok) {
    throw new Error(`Yahoo ${symbol} HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;

  if (!meta) {
    throw new Error(`Yahoo ${symbol} ohne Meta-Daten`);
  }

  const closes = (result?.indicators?.quote?.[0]?.close || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  const price = firstPositiveNumber([
    meta.regularMarketPrice,
    closes[closes.length - 1],
    meta.chartPreviousClose,
  ]);

  const previousClose = firstPositiveNumber([
    meta.chartPreviousClose,
    closes.length >= 2 ? closes[closes.length - 2] : null,
  ]);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Yahoo ${symbol} Preis nicht lesbar`);
  }

  const changePct =
    Number.isFinite(previousClose) && previousClose > 0
      ? ((price - previousClose) / previousClose) * 100
      : null;

  return {
    price,
    previousClose,
    change: Number.isFinite(previousClose) && previousClose > 0 ? price - previousClose : null,
    changePct,
    currency: String(meta.currency || 'USD').toUpperCase(),
    marketTime: Number(meta.regularMarketTime) > 0
      ? new Date(Number(meta.regularMarketTime) * 1000).toISOString()
      : null,
  };
}

async function fetchYahooDailyHistoryToEur(symbol, days) {
  const range = days <= 35 ? '1mo' : days <= 190 ? '6mo' : '1y';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${range}&interval=1d&includePrePost=false`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 Portfolio-Market-History-Checker/1.0',
      Accept: 'application/json',
      'Cache-Control': 'no-cache, no-store, max-age=0',
      Pragma: 'no-cache',
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!resp.ok) {
    throw new Error(`Yahoo Historie ${symbol} HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const result = data?.chart?.result?.[0];
  const meta = result?.meta || {};
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const closes = Array.isArray(result?.indicators?.quote?.[0]?.close)
    ? result.indicators.quote[0].close
    : [];
  const sourceCurrency = String(meta.currency || 'EUR').toUpperCase();
  const rate = await fetchCurrencyToEur(sourceCurrency);
  const cutoff = Date.now() - Math.max(7, days) * 24 * 60 * 60 * 1000;
  const byDay = new Map();

  for (let i = 0; i < timestamps.length; i++) {
    const ts = Number(timestamps[i]) * 1000;
    const close = Number(closes[i]);
    if (!Number.isFinite(ts) || ts < cutoff || !Number.isFinite(close) || close <= 0) continue;
    const date = new Date(ts).toISOString().slice(0, 10);
    byDay.set(date, {
      date,
      price: roundQuoteValue(close * rate),
    });
  }

  const points = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (points.length < 2) throw new Error(`Yahoo Historie ${symbol} leer`);

  return {
    points,
    sourceCurrency,
    fxApproximate: sourceCurrency !== 'EUR',
    source: sourceCurrency === 'EUR'
      ? `Yahoo Finance Tageshistorie (${symbol})`
      : `Yahoo Finance Tageshistorie (${symbol}) · FX heute`,
  };
}

function firstPositiveNumber(values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

async function fetchCurrencyToEur(currency) {
  const ccy = String(currency || 'EUR').toUpperCase();

  if (ccy === 'EUR') return 1;

  if (ccy === 'GBX' || ccy === 'GBP' || ccy === 'GBPENCE') {
    const gbpToEur = await fetchCurrencyToEurRaw('GBP');
    return ccy === 'GBP' ? gbpToEur : gbpToEur / 100;
  }

  if (ccy === 'GBp'.toUpperCase()) {
    const gbpToEur = await fetchCurrencyToEurRaw('GBP');
    return gbpToEur / 100;
  }

  return await fetchCurrencyToEurRaw(ccy);
}

async function fetchCurrencyToEurRaw(currency) {
  if (currency === 'EUR') return 1;
  const key = String(currency || '').toUpperCase();
  if (currencyRateCache.has(key)) return currencyRateCache.get(key);

  const resp = await fetch(
    `https://api.frankfurter.app/latest?from=${encodeURIComponent(
      key
    )}&to=EUR`,
    {
      headers: {
        Accept: 'application/json',
      },
    }
  );

  if (!resp.ok) {
    throw new Error(`Frankfurter ${currency}/EUR HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const rate = Number(data?.rates?.EUR);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`${key}/EUR nicht lesbar`);
  }

  currencyRateCache.set(key, rate);
  return rate;
}

function isFreshMarketQuote(quote) {
  if (!quote?.cachedAt || !quote?.price) return false;
  const ageMs = Date.now() - new Date(quote.cachedAt).getTime();
  return ageMs >= 0 && ageMs < MARKET_CACHE_MAX_AGE_MS;
}

function findFreshMarketQuote(cache, symbols) {
  const quote = findAnyMarketQuote(cache, symbols);
  return isFreshMarketQuote(quote) ? quote : null;
}

function findAnyMarketQuote(cache, symbols) {
  if (!cache || !Array.isArray(symbols)) return null;

  for (const symbol of symbols) {
    const quote = cache[String(symbol || '').toUpperCase()];
    if (quote?.price > 0) return quote;
  }

  return null;
}

async function readMarketCache(env) {
  if (!env.KV) return null;

  try {
    const raw = await env.KV.get(MARKET_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeMarketCache(env, data) {
  if (!env.KV) return;

  try {
    await env.KV.put(MARKET_CACHE_KEY, JSON.stringify(data));
  } catch {
    // Cache-Fehler soll die App nicht blockieren.
  }
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// ==========================================================
// Edelmetallpreise
// Primär: Gold&Co für Gold/Silber
// Fallback: Yahoo Finance Futures + Frankfurter USD/EUR
// Einheit: EUR/g
// ==========================================================

const METAL_CACHE_KEY = 'metal-prices-v3';
const METAL_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
const TROY_OUNCE_GRAMS = 31.1034768;

const METAL_RANGES = {
  gold: [50, 220],
  silver: [0.3, 6],
  platinum: [10, 100],
  palladium: [5, 160],
};

async function getMetalPrices(env, options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const now = Date.now();

  const cached = await readMetalCache(env);

  if (!forceRefresh && cached?.updatedAt && cached?.prices) {
    const ageMs = now - new Date(cached.updatedAt).getTime();

    if (ageMs >= 0 && ageMs < METAL_CACHE_MAX_AGE_MS) {
      return {
        ...cached,
        ok: true,
        cache: {
          hit: true,
          ageMinutes: Math.round(ageMs / 60000),
        },
      };
    }
  }

  const warnings = [];
  let goldCo = null;
  let fallback = null;

  try {
    goldCo = await fetchGoldUndCoSpotPrices();
  } catch (e) {
    warnings.push(`Gold&Co nicht lesbar: ${e.message || String(e)}`);
  }

  try {
    fallback = await fetchMarketFallbackPrices();
  } catch (e) {
    warnings.push(`Fallback nicht lesbar: ${e.message || String(e)}`);
  }

  const prices = {};
  const sources = {};

  // Gold und Silber bevorzugt von Gold&Co.
  for (const metal of ['gold', 'silver']) {
    const primaryValue = goldCo?.prices?.[metal];
    const fallbackValue = fallback?.prices?.[metal];

    if (isPlausibleMetalPrice(metal, primaryValue)) {
      prices[metal] = roundMoney(primaryValue);
      sources[metal] = 'Gold&Co Spot';
    } else if (isPlausibleMetalPrice(metal, fallbackValue)) {
      prices[metal] = roundMoney(fallbackValue);
      sources[metal] = 'Fallback Market';
      warnings.push(`${metal}: Gold&Co fehlt/unplausibel, Fallback verwendet`);
    }
  }

  // Platin und Palladium kommen aus Fallback, weil Gold&Co dort keinen klaren Spotpreis pro g liefert.
  for (const metal of ['platinum', 'palladium']) {
    const fallbackValue = fallback?.prices?.[metal];

    if (isPlausibleMetalPrice(metal, fallbackValue)) {
      prices[metal] = roundMoney(fallbackValue);
      sources[metal] = 'Fallback Market';
    } else {
      warnings.push(`${metal}: kein plausibler Fallback-Wert gefunden`);
    }
  }

  // Wenn etwas fehlt, aber alter Cache plausibel ist, alten Wert behalten.
  if (cached?.prices) {
    for (const metal of ['gold', 'silver', 'platinum', 'palladium']) {
      if (
        !isPlausibleMetalPrice(metal, prices[metal]) &&
        isPlausibleMetalPrice(metal, cached.prices[metal])
      ) {
        prices[metal] = cached.prices[metal];
        sources[metal] = 'Letzter KV-Cache';
        warnings.push(`${metal}: letzter gespeicherter Wert verwendet`);
      }
    }
  }

  const missing = ['gold', 'silver', 'platinum', 'palladium'].filter(
    (metal) => !isPlausibleMetalPrice(metal, prices[metal])
  );

  const baseResult = {
    unit: 'EUR/g',
    updatedAt: new Date().toISOString(),
    prices,
    sources,
    source: 'Gold&Co + Fallback',
    sourceUrl: 'https://www.goldundco.at/preise/edelmetallpreise/',
    primarySource: 'Gold&Co',
    fallbackSource: 'Yahoo Finance + Frankfurter',
    warnings,
    checks: buildMetalChecks(prices, goldCo, fallback),
    cache: {
      hit: false,
    },
  };

  if (missing.length > 0) {
    return {
      ok: false,
      ...baseResult,
      error: 'Nicht alle Edelmetallpreise konnten plausibel ermittelt werden',
      missing,
      cachedFallbackAvailable: !!cached,
    };
  }

  const result = {
    ok: true,
    ...baseResult,
  };

  await writeMetalCache(env, result);
  return result;
}

async function fetchGoldUndCoSpotPrices() {
  const url = 'https://www.goldundco.at/preise/edelmetallpreise/';

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 Portfolio-Metal-Price-Checker/1.0',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'de-AT,de;q=0.9,en;q=0.7',
    },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const html = await resp.text();
  const text = htmlToText(html);

  const goldKg = extractEuroPerKg(text, 'Gold');
  const silverKg = extractEuroPerKg(text, 'Silber');

  const prices = {};

  if (goldKg) prices.gold = goldKg / 1000;
  if (silverKg) prices.silver = silverKg / 1000;

  if (!prices.gold && !prices.silver) {
    throw new Error('Keine Gold/Silber-Spotpreise gefunden');
  }

  return {
    source: 'Gold&Co',
    url,
    fetchedAt: new Date().toISOString(),
    prices,
  };
}

function extractEuroPerKg(text, label) {
  const pattern = new RegExp(
    `${label}\\s+([0-9]{1,3}(?:[\\.\\s][0-9]{3})*(?:,[0-9]+)?)\\s*€\\s*\\/\\s*kg`,
    'i'
  );

  const match = text.match(pattern);
  if (!match) return null;

  return parseEuroNumber(match[1]);
}

async function fetchMarketFallbackPrices() {
  const usdToEur = await fetchUsdToEur();

  const symbols = {
    gold: 'GC=F',
    silver: 'SI=F',
    platinum: 'PL=F',
    palladium: 'PA=F',
  };

  const entries = await Promise.all(
    Object.entries(symbols).map(async ([metal, symbol]) => {
      const usdPerOz = await fetchYahooRegularMarketPrice(symbol);
      const eurPerGram = (usdPerOz * usdToEur) / TROY_OUNCE_GRAMS;
      return [metal, eurPerGram];
    })
  );

  return {
    source: 'Yahoo Finance + Frankfurter',
    fetchedAt: new Date().toISOString(),
    usdToEur,
    prices: Object.fromEntries(entries),
  };
}

async function fetchUsdToEur() {
  const resp = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR', {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!resp.ok) {
    throw new Error(`Frankfurter HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const rate = Number(data?.rates?.EUR);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('USD/EUR nicht lesbar');
  }

  return rate;
}

async function fetchYahooRegularMarketPrice(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=1d&interval=1d`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 Portfolio-Metal-Price-Checker/1.0',
      Accept: 'application/json',
    },
  });

  if (!resp.ok) {
    throw new Error(`Yahoo ${symbol} HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const price = Number(data?.chart?.result?.[0]?.meta?.regularMarketPrice);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Yahoo ${symbol} Preis nicht lesbar`);
  }

  return price;
}

function buildMetalChecks(prices, goldCo, fallback) {
  const checks = {};

  for (const metal of ['gold', 'silver', 'platinum', 'palladium']) {
    const main = prices?.[metal];
    const fallbackValue = fallback?.prices?.[metal];

    checks[metal] = {
      value: Number.isFinite(main) ? roundMoney(main) : null,
      plausible: isPlausibleMetalPrice(metal, main),
    };

    if (Number.isFinite(fallbackValue) && Number.isFinite(main)) {
      const diffPct = ((main - fallbackValue) / fallbackValue) * 100;
      checks[metal].fallbackValue = roundMoney(fallbackValue);
      checks[metal].diffToFallbackPct = roundMoney(diffPct);
    }

    if (goldCo?.prices?.[metal]) {
      checks[metal].goldCoValue = roundMoney(goldCo.prices[metal]);
    }
  }

  return checks;
}

function isPlausibleMetalPrice(metal, value) {
  const range = METAL_RANGES[metal];
  if (!range) return false;

  return Number.isFinite(value) && value >= range[0] && value <= range[1];
}

async function readMetalCache(env) {
  if (!env.KV) return null;

  try {
    const raw = await env.KV.get(METAL_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeMetalCache(env, data) {
  if (!env.KV) return;

  try {
    await env.KV.put(METAL_CACHE_KEY, JSON.stringify(data));
  } catch {
    // Cache-Fehler soll die App nicht blockieren.
  }
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&euro;/g, '€')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEuroNumber(value) {
  const cleaned = String(value || '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/[^\d.-]/g, '');

  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function roundQuoteValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;

  const abs = Math.abs(number);
  const decimals = abs < 1 ? 6 : abs < 10 ? 5 : abs < 100 ? 4 : 2;
  const factor = 10 ** decimals;
  return Math.round(number * factor) / factor;
}
