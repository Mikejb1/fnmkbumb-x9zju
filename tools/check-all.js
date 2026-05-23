#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const checks = [
  ['Wartungs-Check', ['node', path.join(APP_ROOT, 'tools', 'check-portfolio-maintenance.js')]],
  ['Worker-Check', ['node', path.join(APP_ROOT, 'tools', 'check-worker.js')]],
  ['Smoke-Test', ['node', path.join(APP_ROOT, 'tools', 'smoke-portfolio-pages.js')]],
];

let failed = false;

for (const [label, command] of checks) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: APP_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) failed = true;
}

if (failed) {
  console.error('\nMindestens ein Check ist fehlgeschlagen.');
  process.exit(1);
}

console.log('\nAlle Checks erfolgreich.');
