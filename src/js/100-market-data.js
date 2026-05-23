// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// Mapping Symbol/Name -> CoinGecko-ID (für zuverlässige Live-Kurse)
const CRYPTO_CG_IDS = {
  btc: 'bitcoin', bitcoin: 'bitcoin', xbt: 'bitcoin',
  eth: 'ethereum', ethereum: 'ethereum', ether: 'ethereum',
  sol: 'solana', solana: 'solana',
  xrp: 'ripple', ripple: 'ripple',
  ada: 'cardano', cardano: 'cardano',
  dot: 'polkadot', polkadot: 'polkadot',
  doge: 'dogecoin', dogecoin: 'dogecoin',
  ltc: 'litecoin', litecoin: 'litecoin',
  bnb: 'binancecoin', binancecoin: 'binancecoin',
  matic: 'matic-network', polygon: 'matic-network',
  avax: 'avalanche-2', avalanche: 'avalanche-2',
  link: 'chainlink', chainlink: 'chainlink',
  trx: 'tron', tron: 'tron',
  sui: 'sui',
  atom: 'cosmos', cosmos: 'cosmos',
  uni: 'uniswap', uniswap: 'uniswap',
  xlm: 'stellar', stellar: 'stellar',
  algo: 'algorand', algorand: 'algorand',
  shib: 'shiba-inu',
  pepe: 'pepe',
  near: 'near', apt: 'aptos', aptos: 'aptos', arb: 'arbitrum', op: 'optimism'
};
function cgIdForCrypto(pos) {
  const sym = cleanQuoteSymbol(pos.symbol || '').toLowerCase();
  if (CRYPTO_CG_IDS[sym]) return CRYPTO_CG_IDS[sym];
  const name = normalizeText(pos.name || '').toLowerCase().replace(/\s+/g, '');
  if (CRYPTO_CG_IDS[name]) return CRYPTO_CG_IDS[name];
  // Symbol/Name könnten Teilstrings enthalten (z.B. "Ripple XRP")
  const hay = (sym + ' ' + name);
  for (const key of Object.keys(CRYPTO_CG_IDS)) {
    if (key.length >= 3 && hay.includes(key)) return CRYPTO_CG_IDS[key];
  }
  if (pos.cgId) return String(pos.cgId).toLowerCase();
  return '';
}
function normalizeCryptoMetadata() {
  let changed = false;
  (appData?.positions || []).forEach(pos => {
    if (!isCryptoPos(pos)) return;
    const cg = cgIdForCrypto(pos);
    if (cg && pos.cgId !== cg) { pos.cgId = cg; changed = true; }
    if (pos.quoteSymbol) { delete pos.quoteSymbol; changed = true; }
    if (currentPrices[pos.id] && !String(currentPrices[pos.id].source || '').toLowerCase().includes('crypto') && currentPrices[pos.id].venue !== 'coingecko') {
      delete currentPrices[pos.id];
      delete baseLivePrices[pos.id];
    }
  });
  if (changed) savePositionsToKV(1200);
  return changed;
}

async function fetchCryptoPrices() {
  normalizeCryptoMetadata();
  const cryptos = (appData?.positions || [])
    .filter(p => isCryptoPos(p))
    .map(pos => ({ pos, cg: cgIdForCrypto(pos) }))
    .filter(x => x.cg);

  if (cryptos.length === 0) return false;

  // Primär: CoinGecko direkt (zuverlässige JSON-API, EUR + 24h-Veränderung)
  const ids = [...new Set(cryptos.map(x => x.cg))].join(',');
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=eur&include_24hr_change=true`);
    if (!res.ok) throw new Error('CoinGecko HTTP ' + res.status);
    const data = await res.json();
    let anySuccess = false;
    cryptos.forEach(({ pos, cg }) => {
      const d = data[cg];
      const price = Number(d?.eur);
      if (price > 0) {
        const changePct = Number(d.eur_24h_change);
        const validPct = Number.isFinite(changePct) ? changePct : 0;
        const previousClose = validPct !== 0 ? price / (1 + validPct / 100) : price;
        const liveQuote = {
          price,
          previousClose: previousClose > 0 ? previousClose : null,
          change: previousClose > 0 ? price - previousClose : null,
          changePct: validPct,
          live: true,
          source: 'CoinGecko EUR (24h)',
          symbol: pos.symbol || cg.toUpperCase(),
          currency: 'EUR',
          venue: 'coingecko',
          venueLabel: 'CoinGecko',
          updatedAt: new Date().toISOString()
        };
        baseLivePrices[pos.id] = liveQuote;
        currentPrices[pos.id] = effectiveQuoteForPosition(pos, liveQuote);
        anySuccess = true;
      }
    });
    if (anySuccess) return true;
    throw new Error('CoinGecko lieferte keine Kurse');
  } catch (e) {
    console.warn('Crypto fetch (CoinGecko) failed, fallback auf Worker:', e);
    return await fetchCryptoPricesViaWorker();
  }
}

// Fallback: Crypto-Kurse über den Worker (Google Finance)
async function fetchCryptoPricesViaWorker() {
  const cryptoPositions = (appData?.positions || [])
    .filter(p => isCryptoPos(p))
    .map(pos => ({
      id: pos.id,
      name: pos.name,
      symbol: cleanQuoteSymbol(pos.symbol || pos.name || ''),
      type: pos.type,
      venue: venueOf(pos),
      isin: '',
      wkn: ''
    }))
    .filter(pos => pos.symbol || pos.name);
  if (cryptoPositions.length === 0) return false;
  try {
    const res = await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        action: 'get-market-prices',
        positions: cryptoPositions,
        forceRefresh: true,
        userKey: kvKeyActive()
      })
    });
    if (!res.ok) throw new Error('Crypto market HTTP ' + res.status);
    const data = await res.json();
    const quotes = data?.quotes || {};
    (appData.positions || []).forEach(pos => {
      if (!isCryptoPos(pos)) return;
      const q = quotes[pos.id];
      const price = Number(q?.price);
      if (price > 0 && isTrustedCryptoQuote(pos, q)) {
        const previousClose = Number(q?.previousClose);
        const change = Number(q?.change);
        const changePct = Number(q?.changePct);
        const liveQuote = {
          price,
          previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
          change: Number.isFinite(change) ? change : null,
          changePct: Number.isFinite(changePct) ? changePct : null,
          live: true,
          source: q.source || 'Krypto EUR Tageskurs',
          symbol: q.symbol || pos.symbol,
          currency: 'EUR',
          venue: q.venue || venueOf(pos),
          venueLabel: q.venueLabel || getVenueByCode(venueOf(pos)).short,
          updatedAt: q.updatedAt || data.updatedAt || new Date().toISOString()
        };
        baseLivePrices[pos.id] = liveQuote;
        currentPrices[pos.id] = effectiveQuoteForPosition(pos, liveQuote);
      }
    });
    return true;
  } catch (e) {
    console.warn('Crypto fetch (Worker) failed:', e);
    return false;
  }
}
function isTrustedCryptoQuote(pos, quote) {
  const source = String(quote?.source || '').toLowerCase();
  const venue = String(quote?.venue || '').toLowerCase();
  const symbol = String(quote?.symbol || '').toLowerCase();
  const cg = cgIdForCrypto(pos);
  if (source.includes('yahoo') || /\.de$|\.f$|\.mu$|\.sg$|\.du$|\.tg$|\.lu$/.test(symbol)) return false;
  if (cg === 'ripple' && Number(quote?.price) > 5) return false;
  const previous = Number(baseLivePrices[pos?.id]?.price || currentPrices[pos?.id]?.price);
  const next = Number(quote?.price);
  if (previous > 0 && next > 0 && (next / previous > 4 || next / previous < 0.25)) return false;
  return source.includes('crypto') || source.includes('coingecko') || venue.includes('crypto') || venue.includes('coingecko') || symbol.includes('-eur') || symbol.includes('eur');
}

const KNOWN_YAHOO_BY_ISIN = {
  US81762P1021: '4S0.DE',     // ServiceNow Xetra
  US67066G1040: 'NVD.DE',     // NVIDIA Xetra
  US02079K3059: 'ABEA.DE',    // Alphabet A Xetra
  DE000PAG9113: 'P911.DE',    // Porsche AG Xetra
};
const KNOWN_YAHOO_BY_NAME = [
  { test: /servicenow/i, symbol: '4S0.DE' },
  { test: /nvidia/i, symbol: 'NVD.DE' },
  { test: /alphabet/i, symbol: 'ABEA.DE' },
  { test: /porsche/i, symbol: 'P911.DE' },
];

function cleanQuoteSymbol(symbol) {
  return String(symbol || '').trim().replace(/\s+/g, '').toUpperCase();
}
function looksLikeIsin(value) {
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(cleanQuoteSymbol(value));
}

function quoteSymbolForPosition(pos) {
  if (!pos || pos.cgId || pos.special) return '';
  const type = String(pos.type || '').toLowerCase();
  if (type !== 'aktie' && type !== 'etf') return '';
  const explicit = cleanQuoteSymbol(pos.quoteSymbol);
  if (explicit) return explicit;
  const raw = cleanQuoteSymbol(pos.symbol);
  const isin = cleanQuoteSymbol(pos.stammdaten?.isin || pos.isin || pos.symbol);
  if (KNOWN_YAHOO_BY_ISIN[isin]) return KNOWN_YAHOO_BY_ISIN[isin];
  const name = normalizeText(pos.name || '');
  const knownByName = KNOWN_YAHOO_BY_NAME.find(entry => entry.test.test(pos.name || '') || name.includes(entry.symbol.toLowerCase()));
  if (knownByName) return knownByName.symbol;
  return raw;
}
