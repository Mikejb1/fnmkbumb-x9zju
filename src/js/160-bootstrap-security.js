// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== SICHERHEIT · STATUS · AUTO-LOGOUT =====
let autoLogoutTimer = null;
let autoLogoutDeadline = 0;
let autoLogoutCountdownTimer = null;

function securityStatusItem(label, value, state = 'ok') {
  return `
    <div class="security-status-card ${state}">
      <div class="label"><span class="dot"></span>${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(value)}</div>
    </div>`;
}

function renderSecurityStatus() {
  const grid = document.getElementById('securityStatusGrid');
  const scoreEl = document.getElementById('securityScore');
  const privacySelect = document.getElementById('aiPrivacyMode');
  const privacyHint = document.getElementById('aiPrivacyHint');
  const sessionSelect = document.getElementById('sessionTimeoutSelect');
  if (!grid) return;

  const privacyMode = getAIPrivacyMode();
  const timeoutMin = getSessionTimeoutMinutes();
  if (privacySelect) privacySelect.value = privacyMode;
  if (privacyHint) privacyHint.textContent = AI_PRIVACY_MODES[privacyMode].hint;
  if (sessionSelect) sessionSelect.value = String(timeoutMin);

  const cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  const chartScript = [...document.scripts].find(s => String(s.src || '').includes('chart.umd.js'));
  const hasWorkerToken = !!appAuthToken;
  const encryptedKv = !!appPassword;
  const checks = [
    { label: 'Portfolio-Speicher', value: encryptedKv ? 'AES-GCM im Browser aktiv' : 'erst nach Login prüfbar', state: encryptedKv ? 'ok' : 'warn' },
    { label: 'Worker-Zugriff', value: hasWorkerToken ? 'Hash-Token aus Master-Code aktiv' : 'noch nicht angemeldet', state: hasWorkerToken ? 'ok' : 'warn' },
    { label: 'CSP', value: cspMeta ? 'externe Skripte/Frames stark begrenzt' : 'CSP nicht gefunden', state: cspMeta ? 'ok' : 'bad' },
    { label: 'Chart.js', value: chartScript ? 'lokal eingebunden' : 'lokale Chart-Datei nicht erkannt', state: chartScript ? 'ok' : 'warn' },
    { label: 'KI-Modus', value: AI_PRIVACY_MODES[privacyMode].label, state: privacyMode === 'full' ? 'warn' : 'ok' },
    { label: 'Sitzung', value: `Auto-Logout nach ${timeoutMin} Minuten`, state: timeoutMin <= 15 ? 'ok' : 'warn' },
  ];
  const score = Math.round((checks.reduce((sum, item) => sum + (item.state === 'ok' ? 1 : item.state === 'warn' ? 0.55 : 0), 0) / checks.length) * 100);
  if (scoreEl) scoreEl.textContent = `${score}/100`;
  grid.innerHTML = checks.map(item => securityStatusItem(item.label, item.value, item.state)).join('');
  renderSessionCountdown();
}

function renderSessionCountdown() {
  const el = document.getElementById('sessionCountdown');
  if (!el) return;
  if (!appPassword || !autoLogoutDeadline) {
    el.textContent = 'nicht aktiv';
    return;
  }
  const leftMs = Math.max(0, autoLogoutDeadline - Date.now());
  const minutes = Math.floor(leftMs / 60000);
  const seconds = Math.floor((leftMs % 60000) / 1000);
  el.textContent = `noch ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function resetAutoLogout() {
  if (autoLogoutTimer) clearTimeout(autoLogoutTimer);
  // Nur aktiv wenn eingeloggt
  if (!appPassword) return;
  const timeoutMs = getSessionTimeoutMinutes() * 60 * 1000;
  autoLogoutDeadline = Date.now() + timeoutMs;
  renderSessionCountdown();
  autoLogoutTimer = setTimeout(() => {
    if (appPassword) {
      handleLogout();
      const errEl = document.getElementById('gateError');
      if (errEl) { errEl.textContent = `Automatisch abgemeldet (${getSessionTimeoutMinutes()} Min Inaktivität). Bitte erneut anmelden.`; errEl.classList.add('visible'); }
    }
  }, timeoutMs);
}
function initAutoLogout() {
  ['click', 'keydown', 'touchstart', 'scroll', 'input'].forEach(evt => {
    document.addEventListener(evt, resetAutoLogout, { passive: true });
  });
  if (autoLogoutCountdownTimer) clearInterval(autoLogoutCountdownTimer);
  autoLogoutCountdownTimer = setInterval(renderSessionCountdown, 1000);
}

function bootstrap() { initTheme(); initViewMode(); wireEvents(); initAutoLogout(); renderSecurityStatus(); showScreen('gateScreen'); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
else bootstrap();
