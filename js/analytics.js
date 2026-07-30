/**
 * First-party, consent-gated analytics for Overhead.
 * No network beacons until the visitor Accepts.
 */

const CONSENT_KEY = 'overhead_consent';
const CLIENT_KEY = 'overhead_cid';
const SESSION_KEY = 'overhead_sid';
const SESSION_TS_KEY = 'overhead_sid_ts';
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/** Set after Cloud Run deploy; overridable via window.__OVERHEAD_ANALYTICS_URL */
let COLLECT_URL = typeof window !== 'undefined' && window.__OVERHEAD_ANALYTICS_URL
  ? String(window.__OVERHEAD_ANALYTICS_URL)
  : '';

let engaged = false;
let engagementStarted = 0;
let pageEnteredAt = 0;
let utm = {};
let bannerEl = null;

export function setCollectUrl(url) {
  COLLECT_URL = String(url || '');
}

export function getConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY);
  } catch {
    return null;
  }
}

export function setConsent(value) {
  try {
    localStorage.setItem(CONSENT_KEY, value);
  } catch { /* private mode */ }
  if (value === 'granted') {
    hideBanner();
    bootstrapSession();
    track('page_view');
  } else {
    hideBanner();
  }
}

export function initAnalytics({ collectUrl } = {}) {
  if (collectUrl) COLLECT_URL = collectUrl;
  utm = readUtm();
  pageEnteredAt = Date.now();
  engagementStarted = Date.now();

  const consent = getConsent();
  if (consent === 'granted') {
    bootstrapSession();
    track('page_view');
  } else if (consent !== 'denied') {
    showBanner();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushEngagement();
    else if (getConsent() === 'granted') engagementStarted = Date.now();
  });
  window.addEventListener('pagehide', flushEngagement);
}

export function track(eventName, eventParams = {}) {
  if (getConsent() !== 'granted') return;
  if (!COLLECT_URL) return;

  const { clientId, sessionId, isNewSession } = ensureIds();
  if (isNewSession) {
    send('session_start', clientId, sessionId, {});
  }

  send(eventName, clientId, sessionId, eventParams);
}

function bootstrapSession() {
  ensureIds();
}

function ensureIds() {
  let clientId = read(CLIENT_KEY);
  if (!clientId) {
    clientId = uuid();
    write(CLIENT_KEY, clientId);
  }

  const now = Date.now();
  let sessionId = read(SESSION_KEY);
  let ts = Number(read(SESSION_TS_KEY) || 0);
  let isNewSession = false;
  if (!sessionId || !ts || now - ts > SESSION_TIMEOUT_MS) {
    sessionId = uuid();
    isNewSession = true;
  }
  write(SESSION_KEY, sessionId);
  write(SESSION_TS_KEY, String(now));
  return { clientId, sessionId, isNewSession };
}

function send(eventName, clientId, sessionId, eventParams) {
  const payload = {
    event_name: eventName,
    client_id: clientId,
    session_id: sessionId,
    page_location: location.href,
    page_title: document.title,
    page_referrer: document.referrer || '',
    utm_source: utm.source || null,
    utm_medium: utm.medium || null,
    utm_campaign: utm.campaign || null,
    utm_content: utm.content || null,
    utm_term: utm.term || null,
    engaged,
    engagement_ms: Math.max(0, Date.now() - pageEnteredAt),
    event_params: eventParams,
  };

  const body = JSON.stringify(payload);
  const url = COLLECT_URL.replace(/\/$/, '') + '/collect';
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) return;
    }
  } catch { /* fall through */ }

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
    mode: 'cors',
    credentials: 'omit',
  }).catch(() => {});
}

function flushEngagement() {
  if (getConsent() !== 'granted') return;
  const ms = Date.now() - engagementStarted;
  if (ms < 1000) return;
  if (ms >= 10_000 || engaged) engaged = true;
  track('user_engagement', { engagement_ms: Math.round(ms) });
  // Mark engaged after meaningful time on page (GA-like)
  if (ms >= 10_000) engaged = true;
}

function readUtm() {
  const p = new URLSearchParams(location.search);
  return {
    source: p.get('utm_source'),
    medium: p.get('utm_medium'),
    campaign: p.get('utm_campaign'),
    content: p.get('utm_content'),
    term: p.get('utm_term'),
  };
}

function showBanner() {
  if (bannerEl) return;
  bannerEl = document.createElement('div');
  bannerEl.id = 'consent-banner';
  bannerEl.setAttribute('role', 'dialog');
  bannerEl.setAttribute('aria-label', 'Analytics consent');
  bannerEl.innerHTML = `
    <div class="consent-inner">
      <p>
        We use optional first-party analytics (page views, device type, country)
        to understand how Overhead is used. No ads. No sale of data.
        <a href="privacy.html">Privacy</a>
      </p>
      <div class="consent-actions">
        <button type="button" data-consent="denied" class="consent-decline">Decline</button>
        <button type="button" data-consent="granted" class="consent-accept">Accept</button>
      </div>
    </div>
  `;
  bannerEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-consent]');
    if (!btn) return;
    setConsent(btn.getAttribute('data-consent'));
  });
  document.body.appendChild(bannerEl);
}

function hideBanner() {
  bannerEl?.remove();
  bannerEl = null;
}

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
