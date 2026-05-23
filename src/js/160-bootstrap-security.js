// Auto-split from src/app.js. Edit this file, then run tools/build-account-html.js.
// ===== AUTO-LOGOUT bei Inaktivität (Sicherheit) =====
const AUTO_LOGOUT_MS = 15 * 60 * 1000; // 15 Minuten
let autoLogoutTimer = null;
function resetAutoLogout() {
  if (autoLogoutTimer) clearTimeout(autoLogoutTimer);
  // Nur aktiv wenn eingeloggt
  if (!appPassword) return;
  autoLogoutTimer = setTimeout(() => {
    if (appPassword) {
      handleLogout();
      const errEl = document.getElementById('gateError');
      if (errEl) { errEl.textContent = 'Automatisch abgemeldet (15 Min Inaktivität). Bitte erneut anmelden.'; errEl.classList.add('visible'); }
    }
  }, AUTO_LOGOUT_MS);
}
function initAutoLogout() {
  ['click', 'keydown', 'touchstart', 'scroll', 'input'].forEach(evt => {
    document.addEventListener(evt, resetAutoLogout, { passive: true });
  });
}

function bootstrap() { initTheme(); wireEvents(); initAutoLogout(); showScreen('gateScreen'); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
else bootstrap();
