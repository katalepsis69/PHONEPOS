import { S } from './state.js';
import { checkLicenseStatus, clearSession, renderLoginGate } from './auth.js';

// ponytail: one fetch wrapper beats editing ~26 call sites with identical 402 handling.
// Any 402 (trial ended) raises the activation overlay once; the caller's own
// !res.ok branch keeps working underneath it.
// It is also the single place session + elevation tokens attach: every /api/
// request carries the Bearer session, and a still-valid elevation token rides
// the X-Elevation header. A 401 anywhere (PIN changed, staff reset, session
// killed server-side) drops the session and shows the login gate.
const rawFetch = window.fetch.bind(window);
// initialized in state.js: S.licenseCheckInFlight
// initialized in state.js: S.loginGateRendering
window.fetch = async (...args) => {
  let [input, init] = args;
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.startsWith('/api/') && S.sessionToken) {
    // Normalize: init.headers may be a plain object, a Headers instance, or an
    // array of pairs; Request-init already carries its own. Spread would
    // silently drop the non-object shapes (L1).
    const src = init || {};
    const existingHeaders = src.headers instanceof Headers
      ? Object.fromEntries(src.headers.entries())
      : Array.isArray(src.headers)
        ? Object.fromEntries(src.headers)
        : (src.headers || {});
    init = { ...src, headers: { ...existingHeaders } };
    init.headers['Authorization'] = `Bearer ${S.sessionToken}`;
    if (S.elevationToken && Date.now() < S.elevationExpiresAt) {
      init.headers['X-Elevation'] = S.elevationToken;
    }
    args = [input, init];
  }
  const res = await rawFetch(...args);
  const overlay = document.getElementById('license-overlay');
  if (res.status === 402 && overlay?.classList.contains('hidden') && !S.licenseCheckInFlight) {
    S.licenseCheckInFlight = true;
    try { await checkLicenseStatus(true); } finally { S.licenseCheckInFlight = false; }
  }
  // 401 session drop: several in-flight requests can fail together; the guard
  // keeps one login-gate render from trampling another (L4).
  if (res.status === 401 && S.sessionToken && url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
    clearSession();
    if (!S.loginGateRendering) {
      S.loginGateRendering = true;
      try { await renderLoginGate('Your session ended — please log in again'); }
      finally { S.loginGateRendering = false; }
    } else {
      renderLoginGateSoon();
    }
  }
  return res;
};

// Late-arriving 401s after a gate render finished: refresh roster once more.
function renderLoginGateSoon() {
  renderLoginGate('Your session ended — please log in again').catch(() => {});
}
