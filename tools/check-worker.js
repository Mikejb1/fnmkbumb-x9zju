#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const WORKER_FILE = path.join(APP_ROOT, 'worker', 'worker.js');

const REQUIRED_ACTIONS = [
  'get-positions',
  'put-positions',
  'get-memory',
  'put-memory',
  'put-memory-summary',
  'clear-memory',
  'get-market-prices',
  'get-market-history',
  'resolve-market-symbols',
  'get-metal-prices',
];

const REQUIRED_FUNCTIONS = [
  'allowedCorsOrigin',
  'isAuthorizedRequest',
  'parseConfiguredAuthTokens',
  'checkRateLimit',
  'getMarketPrices',
  'getMarketHistory',
  'resolveMarketSymbols',
  'getMetalPrices',
];

function result(ok, message) {
  return { ok, message };
}

function checkSyntax(source) {
  try {
    new Function(source.replace(/export\s+default\s+\{/, 'return {'));
    return result(true, 'Worker-Syntax ok');
  } catch (error) {
    return result(false, `Worker-Syntaxfehler: ${error.message}`);
  }
}

function run() {
  const results = [];
  if (!fs.existsSync(WORKER_FILE)) {
    console.error(`Worker-Datei fehlt: ${WORKER_FILE}`);
    process.exit(1);
  }

  const source = fs.readFileSync(WORKER_FILE, 'utf8');
  results.push(checkSyntax(source));

  results.push(source.includes('APP_AUTH_TOKEN_HASHES')
    ? result(true, 'Auth-Secret APP_AUTH_TOKEN_HASHES wird verwendet')
    : result(false, 'APP_AUTH_TOKEN_HASHES fehlt'));

  results.push(source.includes('configured.length === 0')
    ? result(true, 'Worker ist ohne konfigurierte Auth-Tokens geschlossen')
    : result(false, 'Geschlossene Auth ohne Env-Token nicht eindeutig erkennbar'));

  results.push(!/pmtj-[A-Za-z0-9_-]+-portfolio-2026/.test(source)
    ? result(true, 'Kein alter sichtbarer Portfolio-Token im Worker')
    : result(false, 'Alter sichtbarer Portfolio-Token im Worker gefunden'));

  results.push(source.includes('Missing or invalid userKey')
    ? result(true, 'userKey ist Pflicht')
    : result(false, 'userKey-Pflicht nicht gefunden'));

  for (const action of REQUIRED_ACTIONS) {
    results.push(source.includes(`body.action === '${action}'`) || source.includes(`action === '${action}'`)
      ? result(true, `Action ${action} vorhanden`)
      : result(false, `Action ${action} fehlt`));
  }

  for (const fn of REQUIRED_FUNCTIONS) {
    results.push(new RegExp(`function\\s+${fn}\\s*\\(`).test(source) || new RegExp(`async\\s+function\\s+${fn}\\s*\\(`).test(source)
      ? result(true, `Funktion ${fn} vorhanden`)
      : result(false, `Funktion ${fn} fehlt`));
  }

  const failed = results.filter(r => !r.ok);
  console.log('Cloudflare Worker Check');
  console.log(`Datei: ${WORKER_FILE}`);
  console.log(`OK: ${results.length - failed.length} | Fehler: ${failed.length}`);
  console.log('');
  for (const r of results) console.log(`${r.ok ? 'OK ' : 'ERR'} ${r.message}`);

  if (failed.length > 0) {
    console.error('');
    console.error('Bitte Worker-Check reparieren, bevor du den Worker-Code kopierst.');
    process.exit(1);
  }
}

run();
