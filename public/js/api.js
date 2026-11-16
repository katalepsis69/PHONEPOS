import { S } from './state.js';
import { checkLicenseStatus, clearSession, renderLoginGate } from './auth.js';

// Pre-Edge 92 and plain HTTP LAN access lack crypto.randomUUID().
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function' && typeof crypto.getRandomValues === 'function') {
  crypto.randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
  };
}

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
  // 401 session drop or unauthenticated access: show the login gate once
  // (without disturbing an active setup/license/login overlay).
  if (res.status === 401 && url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
    const hadSession = !!S.sessionToken;
    if (hadSession) clearSession();
    const anyGateVisible = ['server-down-overlay', 'license-overlay', 'pin-setup-overlay', 'login-gate']
      .some(id => {
        const el = document.getElementById(id);
        return el && !el.classList.contains('hidden');
      });
    const msg = hadSession
      ? 'Your session ended — please log in again'
      : 'Login required — select your role and enter PIN';
    if (!S.loginGateRendering && (!anyGateVisible || hadSession)) {
      S.loginGateRendering = true;
      try { await renderLoginGate(msg); }
      finally { S.loginGateRendering = false; }
    } else if (hadSession) {
      renderLoginGateSoon();
    }
  }
  return res;
};

// Late-arriving 401s after a gate render finished: refresh roster once more.
function renderLoginGateSoon() {
  renderLoginGate('Your session ended — please log in again').catch(() => {});
}
