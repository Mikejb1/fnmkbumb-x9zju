#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_FILE = path.join(APP_ROOT, 'src', 'app.template.html');
const ACCOUNTS_FILE = path.join(APP_ROOT, 'src', 'accounts.json');
const CSS_FILE = path.join(APP_ROOT, 'src', 'app.css');
const JS_FILE = path.join(APP_ROOT, 'src', 'app.js');
const JS_DIR = path.join(APP_ROOT, 'src', 'js');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function replaceAllRequired(source, token, value) {
  if (!source.includes(token)) throw new Error('Template-Token fehlt: ' + token);
  return source.split(token).join(value);
}

function loadAppJsSource() {
  if (fs.existsSync(JS_DIR)) {
    const files = fs.readdirSync(JS_DIR).filter(name => name.endsWith('.js')).sort((a, b) => {
      const na = Number((a.match(/^\d+/) || ['9999'])[0]);
      const nb = Number((b.match(/^\d+/) || ['9999'])[0]);
      return na === nb ? a.localeCompare(b) : na - nb;
    });
    if (files.length > 0) {
      return files.map(file => fs.readFileSync(path.join(JS_DIR, file), 'utf8').replace(/\s*$/, '')).join('\n\n') + '\n';
    }
  }
  return fs.readFileSync(JS_FILE, 'utf8');
}

function loadSourceParts() {
  return {
    css: fs.readFileSync(CSS_FILE, 'utf8').replace(/\s*$/, ''),
    js: loadAppJsSource().replace(/\s*$/, ''),
  };
}

function renderAccount(template, account, sourceParts = loadSourceParts()) {
  let html = template;
  html = replaceAllRequired(html, '__APP_CSS__', sourceParts.css);
  html = replaceAllRequired(html, '__APP_JS__', sourceParts.js);
  html = replaceAllRequired(html, '__WEB_APP_TITLE__', escapeHtml(account.webAppTitle));
  html = replaceAllRequired(html, '__DOCUMENT_TITLE__', escapeHtml(account.documentTitle));
  html = replaceAllRequired(html, '__GATE_TITLE__', escapeHtml(account.gateTitle));
  html = replaceAllRequired(html, '__HEADER_TITLE__', escapeHtml(account.headerTitle));
  html = replaceAllRequired(html, '__USER_KEY__', account.userKey);
  html = replaceAllRequired(html, '__BAKED_BLOB__', JSON.stringify(account.bakedBlob));
  return html;
}

function main() {
  const template = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  const sourceParts = loadSourceParts();
  fs.writeFileSync(JS_FILE, sourceParts.js + '\n');
  const config = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  for (const account of config.accounts || []) {
    if (!account.output || !account.userKey || !Object.prototype.hasOwnProperty.call(account, 'bakedBlob')) {
      throw new Error('Ungueltige Account-Konfiguration: ' + JSON.stringify(account));
    }
    const target = path.join(APP_ROOT, account.output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderAccount(template, account, sourceParts));
    console.log('built ' + account.name + ' -> ' + target);
  }
}

if (require.main === module) main();

module.exports = { renderAccount };
