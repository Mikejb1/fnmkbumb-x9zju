#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renderAccount } = require('./build-account-html.js');

const TOOL_ROOT = path.resolve(__dirname, '..');
const CANDIDATE_ROOTS = [
  path.resolve(TOOL_ROOT, '..'),
  path.resolve(TOOL_ROOT, '..', 'portfolio-mobile'),
  '/Users/michael/Desktop/Claude/portfolio-mobile',
];
const APP_ROOT = CANDIDATE_ROOTS.find(root =>
  fs.existsSync(path.join(root, 'index.html')) &&
  fs.existsSync(path.join(root, 'bruder', 'index.html')) &&
  fs.existsSync(path.join(root, 'person1', 'index.html')) &&
  fs.existsSync(path.join(root, 'person2', 'index.html'))
);

if (!APP_ROOT) {
  console.error('Portfolio-App-Ordner nicht gefunden. Erwartet index.html, bruder/index.html, person1/index.html und person2/index.html.');
  process.exit(1);
}

const TEMPLATE_FILE = path.join(APP_ROOT, 'src', 'app.template.html');
const ACCOUNTS_FILE = path.join(APP_ROOT, 'src', 'accounts.json');
const CSS_FILE = path.join(APP_ROOT, 'src', 'app.css');
const JS_FILE = path.join(APP_ROOT, 'src', 'app.js');
const JS_DIR = path.join(APP_ROOT, 'src', 'js');

const ACCOUNTS = [
  {
    name: 'Michael',
    file: path.join(APP_ROOT, 'index.html'),
    userKey: 'michael',
    title: 'Mein Portfolio',
    webAppTitle: 'Portfolio',
    gateTitle: 'Portfolio',
    headerTitle: 'Mein Portfolio',
    output: 'index.html',
  },
  {
    name: 'Bruder',
    file: path.join(APP_ROOT, 'bruder', 'index.html'),
    userKey: 'bruder',
    title: 'Mein Portfolio 1',
    webAppTitle: 'Portfolio 1',
    gateTitle: 'Portfolio',
    headerTitle: 'Mein Portfolio',
    output: 'bruder/index.html',
  },
  {
    name: 'Person1',
    file: path.join(APP_ROOT, 'person1', 'index.html'),
    userKey: 'person1',
    title: 'Person1 Portfolio',
    webAppTitle: 'Person1 Portfolio',
    gateTitle: 'Person1 Portfolio',
    headerTitle: 'Person1 Portfolio',
    output: 'person1/index.html',
  },
  {
    name: 'Person2',
    file: path.join(APP_ROOT, 'person2', 'index.html'),
    userKey: 'person2',
    title: 'Person2 Portfolio',
    webAppTitle: 'Person2 Portfolio',
    gateTitle: 'Person2 Portfolio',
    headerTitle: 'Person2 Portfolio',
    output: 'person2/index.html',
  },
];

const REQUIRED_IDS = [
  'gateScreen',
  'appScreen',
  'refreshBtn',
  'layoutEditBtn',
  'qualitySection',
  'qualityBreakdown',
  'anchor-positions',
  'anchor-history',
  'historyQualityBadge',
  'anchor-goal',
  'goalDetails',
  'goalApplyBtn',
  'savingsSimGrid',
  'analysisText',
  'anchor-chat',
];

const REQUIRED_FUNCTIONS = [
  'renderTotals',
  'renderPositions',
  'renderHistory',
  'renderGoal',
  'renderSavingsSim',
  'computeDataQuality',
  'buildDataQualityScoreParts',
  'refreshUI',
  'fetchMarketPrices',
  'fetchCryptoPrices',
  'fetchMetalPrices',
  'savePositionsToKV',
  'loadPositionsFromKV',
];

function fail(message) {
  return { ok: false, message };
}

function pass(message) {
  return { ok: true, message };
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function sha(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function extractScripts(html) {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
}

function checkSyntax(account, html) {
  const scripts = extractScripts(html);
  if (scripts.length === 0) return fail(`${account.name}: kein eingebettetes Script gefunden`);
  for (let i = 0; i < scripts.length; i++) {
    try {
      new Function(scripts[i]);
    } catch (error) {
      return fail(`${account.name}: Script ${i + 1} Syntaxfehler: ${error.message}`);
    }
  }
  return pass(`${account.name}: JavaScript-Syntax ok (${scripts.length} Script-Block${scripts.length === 1 ? '' : 's'})`);
}

function extractConstString(html, name) {
  const escaped = name.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`const\\s+${escaped}\\s*=\\s*['"]([^'"]*)['"]`));
  return match ? match[1] : null;
}

function checkAccount(account, html) {
  const checks = [];

  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  checks.push(titleMatch && titleMatch[1] === account.title
    ? pass(`${account.name}: Titel ok`)
    : fail(`${account.name}: Titel ist ${titleMatch ? titleMatch[1] : 'nicht vorhanden'}, erwartet ${account.title}`));

  const webAppTitleMatch = html.match(/<meta name="apple-mobile-web-app-title" content="([^"]*)">/i);
  checks.push(webAppTitleMatch && webAppTitleMatch[1] === account.webAppTitle
    ? pass(`${account.name}: Web-App-Titel ok`)
    : fail(`${account.name}: Web-App-Titel ist ${webAppTitleMatch ? webAppTitleMatch[1] : 'nicht vorhanden'}, erwartet ${account.webAppTitle}`));

  const gateTitleMatch = html.match(/<div id="gateScreen">[\s\S]*?<h1>([^<]*)<\/h1>/i);
  checks.push(gateTitleMatch && gateTitleMatch[1] === account.gateTitle
    ? pass(`${account.name}: Login-Titel ok`)
    : fail(`${account.name}: Login-Titel ist ${gateTitleMatch ? gateTitleMatch[1] : 'nicht vorhanden'}, erwartet ${account.gateTitle}`));

  const headerTitleMatch = html.match(/<div id="appScreen" class="screen">[\s\S]*?<div class="header">[\s\S]*?<h1>([^<]*)<\/h1>/i);
  checks.push(headerTitleMatch && headerTitleMatch[1] === account.headerTitle
    ? pass(`${account.name}: Header-Titel ok`)
    : fail(`${account.name}: Header-Titel ist ${headerTitleMatch ? headerTitleMatch[1] : 'nicht vorhanden'}, erwartet ${account.headerTitle}`));

  const userKey = extractConstString(html, 'USER_KEY');
  checks.push(userKey === account.userKey
    ? pass(`${account.name}: USER_KEY ok (${userKey})`)
    : fail(`${account.name}: USER_KEY ist ${userKey || 'nicht vorhanden'}, erwartet ${account.userKey}`));

  const appToken = extractConstString(html, 'AI_APP_TOKEN');
  checks.push(appToken === ''
    ? pass(`${account.name}: AI_APP_TOKEN leer`)
    : fail(`${account.name}: AI_APP_TOKEN ist nicht leer`));

  checks.push(/const\s+STORAGE_PREFIX\s*=\s*`portfolio_\$\{USER_KEY\}_`/.test(html)
    ? pass(`${account.name}: Storage-Prefix ist kontoabhaengig`)
    : fail(`${account.name}: Storage-Prefix ist nicht eindeutig kontoabhaengig`));

  const bakedBlob = html.match(/^const\s+BAKED_BLOB\s*=\s*(.+);$/m);
  checks.push(bakedBlob
    ? pass(`${account.name}: BAKED_BLOB vorhanden (${sha(bakedBlob[1])})`)
    : fail(`${account.name}: BAKED_BLOB fehlt`));

  for (const id of REQUIRED_IDS) {
    checks.push(html.includes(`id="${id}"`)
      ? pass(`${account.name}: UI-Anker #${id} vorhanden`)
      : fail(`${account.name}: UI-Anker #${id} fehlt`));
  }

  for (const fn of REQUIRED_FUNCTIONS) {
    checks.push(new RegExp(`function\\s+${fn}\\s*\\(`).test(html)
      ? pass(`${account.name}: Funktion ${fn} vorhanden`)
      : fail(`${account.name}: Funktion ${fn} fehlt`));
  }

  return checks;
}

function normalizeForDrift(html) {
  return html
    .replace(/<meta name="apple-mobile-web-app-title" content="[^"]*">/g, '<meta name="apple-mobile-web-app-title" content="__APP_TITLE__">')
    .replace(/<title>[^<]*<\/title>/g, '<title>__TITLE__</title>')
    .replace(/(<div id="gateScreen">[\s\S]*?<h1>)[^<]*(<\/h1>)/i, '$1__GATE_TITLE__$2')
    .replace(/(<div id="appScreen" class="screen">[\s\S]*?<div class="header">[\s\S]*?<h1>)[^<]*(<\/h1>)/i, '$1__HEADER_TITLE__$2')
    .replace(/const\s+USER_KEY\s*=\s*['"][^'"]*['"];\s*\/\/ KV-Trennung pro Person/g, "const USER_KEY = '__USER_KEY__';  // KV-Trennung pro Person")
    .replace(/^const\s+BAKED_BLOB\s*=.*;$/m, 'const BAKED_BLOB =__BAKED_BLOB__;')
    .replace(/\r\n/g, '\n');
}

function firstDiffLine(a, b) {
  const aa = a.split('\n');
  const bb = b.split('\n');
  const max = Math.max(aa.length, bb.length);
  for (let i = 0; i < max; i++) {
    if (aa[i] !== bb[i]) {
      return {
        line: i + 1,
        left: aa[i] || '',
        right: bb[i] || '',
      };
    }
  }
  return null;
}

function checkNoLegacySecrets(htmlByAccount) {
  const checks = [];
  for (const [account, html] of htmlByAccount) {
    if (/pmtj-[A-Za-z0-9_-]+-portfolio-2026/.test(html)) {
      checks.push(fail(`${account.name}: alter sichtbarer App-Token gefunden`));
    } else {
      checks.push(pass(`${account.name}: kein alter sichtbarer App-Token`));
    }
  }
  return checks;
}

function checkDrift(htmlByAccount) {
  const baseAccount = ACCOUNTS[0];
  const base = normalizeForDrift(htmlByAccount.get(baseAccount));
  const checks = [];
  for (const account of ACCOUNTS.slice(1)) {
    const normalized = normalizeForDrift(htmlByAccount.get(account));
    if (base === normalized) {
      checks.push(pass(`${baseAccount.name}/${account.name}: normalisierte Dateien sind synchron (${sha(base)})`));
    } else {
      const diff = firstDiffLine(base, normalized);
      checks.push(fail(`${baseAccount.name}/${account.name}: Dateien laufen auseinander. Erste Abweichung nach Normalisierung in Zeile ${diff.line}: "${diff.left.slice(0, 120)}" vs "${diff.right.slice(0, 120)}"`));
    }
  }
  return checks;
}

function readAppJsSourceForCheck() {
  if (fs.existsSync(JS_DIR)) {
    const files = fs.readdirSync(JS_DIR).filter(name => name.endsWith('.js')).sort((a, b) => {
      const na = Number((a.match(/^\d+/) || ['9999'])[0]);
      const nb = Number((b.match(/^\d+/) || ['9999'])[0]);
      return na === nb ? a.localeCompare(b) : na - nb;
    });
    if (files.length > 0) {
      return files.map(file => read(path.join(JS_DIR, file))).join('\n');
    }
  }
  return read(JS_FILE);
}

function readSourceConfig() {
  if (!fs.existsSync(TEMPLATE_FILE)) return { error: 'src/app.template.html fehlt' };
  if (!fs.existsSync(CSS_FILE)) return { error: 'src/app.css fehlt' };
  if (!fs.existsSync(JS_FILE)) return { error: 'src/app.js fehlt' };
  if (!fs.existsSync(ACCOUNTS_FILE)) return { error: 'src/accounts.json fehlt' };
  try {
    return {
      template: read(TEMPLATE_FILE),
      config: JSON.parse(read(ACCOUNTS_FILE)),
    };
  } catch (error) {
    return { error: error.message };
  }
}

function checkTemplateSource(htmlByAccount) {
  const checks = [];
  const source = readSourceConfig();
  if (source.error) return [fail(`Build-Quelle: ${source.error}`)];
  const { template, config } = source;
  const css = read(CSS_FILE);
  const js = readAppJsSourceForCheck();
  const jsModuleCount = fs.existsSync(JS_DIR) ? fs.readdirSync(JS_DIR).filter(name => name.endsWith('.js')).length : 0;
  const combinedSource = `${template}\n${css}\n${js}`;
  checks.push(pass(`Build-Quelle: app.css/app.js vorhanden${jsModuleCount ? ' · ' + jsModuleCount + ' JS-Module' : ''}`));

  for (const token of ['__APP_CSS__', '__APP_JS__', '__WEB_APP_TITLE__', '__DOCUMENT_TITLE__', '__GATE_TITLE__', '__HEADER_TITLE__', '__USER_KEY__', '__BAKED_BLOB__']) {
    checks.push(combinedSource.includes(token)
      ? pass(`Build-Quelle: Token ${token} vorhanden`)
      : fail(`Build-Quelle: Token ${token} fehlt`));
  }

  const sourceAccounts = Array.isArray(config.accounts) ? config.accounts : [];
  for (const expected of ACCOUNTS) {
    const account = sourceAccounts.find(a => a.output === expected.output);
    if (!account) {
      checks.push(fail(`Build-Config: Account fuer ${expected.output} fehlt`));
      continue;
    }
    checks.push(account.userKey === expected.userKey
      ? pass(`Build-Config: ${expected.name} USER_KEY ok`)
      : fail(`Build-Config: ${expected.name} USER_KEY ist ${account.userKey}, erwartet ${expected.userKey}`));
    checks.push(account.documentTitle === expected.title
      ? pass(`Build-Config: ${expected.name} Titel ok`)
      : fail(`Build-Config: ${expected.name} Titel ist ${account.documentTitle}, erwartet ${expected.title}`));
    checks.push(account.webAppTitle === expected.webAppTitle
      ? pass(`Build-Config: ${expected.name} Web-App-Titel ok`)
      : fail(`Build-Config: ${expected.name} Web-App-Titel ist ${account.webAppTitle}, erwartet ${expected.webAppTitle}`));
    checks.push(account.gateTitle === expected.gateTitle
      ? pass(`Build-Config: ${expected.name} Login-Titel ok`)
      : fail(`Build-Config: ${expected.name} Login-Titel ist ${account.gateTitle}, erwartet ${expected.gateTitle}`));
    checks.push(account.headerTitle === expected.headerTitle
      ? pass(`Build-Config: ${expected.name} Header-Titel ok`)
      : fail(`Build-Config: ${expected.name} Header-Titel ist ${account.headerTitle}, erwartet ${expected.headerTitle}`));
    const built = renderAccount(template, account);
    const current = htmlByAccount.get(expected);
    if (built === current) {
      checks.push(pass(`Build-Reproduzierbarkeit: ${expected.name} exakt reproduzierbar (${sha(built)})`));
    } else {
      const diff = firstDiffLine(built, current);
      checks.push(fail(`Build-Reproduzierbarkeit: ${expected.name} weicht ab Zeile ${diff.line} ab`));
    }
  }

  return checks;
}

function run() {
  const results = [];
  const htmlByAccount = new Map();

  for (const account of ACCOUNTS) {
    if (!fs.existsSync(account.file)) {
      results.push(fail(`${account.name}: Datei fehlt: ${account.file}`));
      continue;
    }
    const html = read(account.file);
    htmlByAccount.set(account, html);
    results.push(checkSyntax(account, html));
    results.push(...checkAccount(account, html));
  }

  if (htmlByAccount.size === ACCOUNTS.length) {
    results.push(...checkNoLegacySecrets(htmlByAccount));
    results.push(...checkDrift(htmlByAccount));
    results.push(...checkTemplateSource(htmlByAccount));
  }

  const failed = results.filter(r => !r.ok);
  const passed = results.length - failed.length;

  console.log('Portfolio Wartungs-Check');
  console.log(`Projekt: ${APP_ROOT}`);
  console.log(`OK: ${passed} | Fehler: ${failed.length}`);
  console.log('');

  for (const r of results) {
    const icon = r.ok ? 'OK ' : 'ERR';
    console.log(`${icon} ${r.message}`);
  }

  if (failed.length > 0) {
    console.error('');
    console.error('Bitte Fehler beheben, bevor du die Dateien hochlaedst.');
    process.exit(1);
  }
}

run();
