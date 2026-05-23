#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const PAGES = [
  { path: '/', title: 'Mein Portfolio', gate: 'Portfolio', userKey: 'michael' },
  { path: '/bruder/', title: 'Mein Portfolio 1', gate: 'Portfolio', userKey: 'bruder' },
  { path: '/person1/', title: 'Person1 Portfolio', gate: 'Person1 Portfolio', userKey: 'person1' },
  { path: '/person2/', title: 'Person2 Portfolio', gate: 'Person2 Portfolio', userKey: 'person2' },
];

function tryRequirePlaywright() {
  const candidates = [
    'playwright',
    '/Users/michael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {}
  }
  return null;
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let requested = decodeURIComponent(url.pathname);
    if (requested.endsWith('/')) requested += 'index.html';
    const target = path.resolve(APP_ROOT, requested.replace(/^\/+/, ''));
    if (!target.startsWith(APP_ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(target, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType(target) });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function runBrowserSmoke(playwright) {
  const server = await startServer();
  const port = server.address().port;
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const results = [];

  try {
    for (const expected of PAGES) {
      const errors = [];
      page.removeAllListeners('console');
      page.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      await page.goto(`http://127.0.0.1:${port}${expected.path}`, { waitUntil: 'domcontentloaded' });
      const actual = await page.evaluate(() => ({
        title: document.title,
        gate: document.querySelector('#gateScreen h1')?.textContent?.trim() || '',
        hasGate: !!document.querySelector('#gateScreen'),
        hasApp: !!document.querySelector('#appScreen'),
        hasPassword: !!document.querySelector('#gatePw'),
        userKey: (document.documentElement.textContent.match(/const\s+USER_KEY\s*=\s*'([^']+)'/) || [])[1] || '',
        templateLeak: document.documentElement.innerHTML.includes('__APP_JS__') ||
          document.documentElement.innerHTML.includes('__APP_CSS__') ||
          document.documentElement.innerHTML.includes('__USER_KEY__') ||
          document.documentElement.innerHTML.includes('__BAKED_BLOB__'),
      }));
      const ok =
        actual.title === expected.title &&
        actual.gate === expected.gate &&
        actual.hasGate &&
        actual.hasApp &&
        actual.hasPassword &&
        actual.userKey === expected.userKey &&
        !actual.templateLeak &&
        errors.length === 0;
      results.push({ ok, expected, actual, errors });
    }
  } finally {
    await browser.close();
    server.close();
  }

  return results;
}

function runStaticSmoke() {
  return PAGES.map(expected => {
    const file = path.join(APP_ROOT, expected.path, 'index.html').replace('/./', '/');
    const html = fs.readFileSync(file, 'utf8');
    const title = (html.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
    const gate = (html.match(/<div id="gateScreen">[\s\S]*?<h1>([^<]+)<\/h1>/) || [])[1] || '';
    const userKey = (html.match(/const\s+USER_KEY\s*=\s*'([^']+)'/) || [])[1] || '';
    const templateLeak = /__(APP_JS|APP_CSS|USER_KEY|BAKED_BLOB)__/.test(html);
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    let syntaxError = '';
    for (const script of scripts) {
      try {
        new Function(script);
      } catch (error) {
        syntaxError = error.message;
        break;
      }
    }
    const actual = {
      title,
      gate,
      hasGate: html.includes('id="gateScreen"'),
      hasApp: html.includes('id="appScreen"'),
      hasPassword: html.includes('id="gatePw"'),
      userKey,
      templateLeak,
    };
    const ok =
      actual.title === expected.title &&
      actual.gate === expected.gate &&
      actual.hasGate &&
      actual.hasApp &&
      actual.hasPassword &&
      actual.userKey === expected.userKey &&
      !actual.templateLeak &&
      !syntaxError;
    return { ok, expected, actual, errors: syntaxError ? [syntaxError] : [] };
  });
}

async function main() {
  const playwright = tryRequirePlaywright();
  let mode = playwright ? 'browser' : 'static';
  let results;
  try {
    results = playwright ? await runBrowserSmoke(playwright) : runStaticSmoke();
  } catch (error) {
    mode = `static (Browser-Smoke nicht moeglich: ${error.code || error.message})`;
    results = runStaticSmoke();
  }
  const failed = results.filter(r => !r.ok);

  console.log('Portfolio Smoke-Test');
  console.log(`Modus: ${mode}`);
  console.log(`OK: ${results.length - failed.length} | Fehler: ${failed.length}`);
  console.log('');

  for (const r of results) {
    console.log(`${r.ok ? 'OK ' : 'ERR'} ${r.expected.path} title="${r.actual.title}" gate="${r.actual.gate}" userKey="${r.actual.userKey}"`);
    for (const error of r.errors) console.log(`    console/error: ${error}`);
  }

  if (failed.length > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
