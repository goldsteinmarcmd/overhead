/**
 * First-party, consent-gated analytics client for the shared analytics platform.
 * No network beacons until the visitor Accepts.
 */

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

let SITE_ID = 'overhead';
let PRODUCT_NAME = 'Overhead';
let PRIVACY_URL = 'privacy.html';

/** Set after Cloud Run deploy; overridable via window.__OVERHEAD_ANALYTICS_URL */
let COLLECT_URL = typeof window !== 'undefined' && window.__OVERHEAD_ANALYTICS_URL
  ? String(window.__OVERHEAD_ANALYTICS_URL)
  : '';

let engaged = false;
let engagementStarted = 0;
let pageEnteredAt = 0;
let utm = {};
let bannerEl = null;
let clickTrackingInstalled = false;

function storageKey(suffix) {
  return `analytics_${SITE_ID}_${suffix}`;
}

export function setCollectUrl(url) {
  COLLECT_URL = String(url || '');
}

export function getConsent() {
  try {
    return localStorage.getItem(storageKey('consent'));
  } catch {
    return null;
  }
}

export function setConsent(value) {
  try {
    localStorage.setItem(storageKey('consent'), value);
  } catch { /* private mode */ }
  if (value === 'granted') {
    hideBanner();
    track('page_view');
  } else {
    hideBanner();
  }
  window.dispatchEvent(new CustomEvent('analytics-consent', { detail: { siteId: SITE_ID, value } }));
}

/** Re-open the banner even if the visitor previously chose Decline. */
export function resetConsentPrompt() {
  try {
    localStorage.removeItem(storageKey('consent'));
  } catch { /* ignore */ }
  showBanner();
}

export function initAnalytics({ collectUrl, siteId, productName, privacyUrl } = {}) {
  if (collectUrl) COLLECT_URL = collectUrl;
  if (siteId) SITE_ID = String(siteId);
  if (productName) PRODUCT_NAME = String(productName);
  if (privacyUrl) PRIVACY_URL = String(privacyUrl);
  utm = readUtm();
  pageEnteredAt = Date.now();
  engagementStarted = Date.now();

  const consent = getConsent();
  if (consent === 'granted') {
    track('page_view');
  } else if (consent !== 'denied') {
    showBanner();
  } else {
    showNudge();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushEngagement();
    else if (getConsent() === 'granted') engagementStarted = Date.now();
  });
  window.addEventListener('pagehide', flushEngagement);
  installClickTracking();
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

function ensureIds() {
  let clientId = read(storageKey('cid'));
  if (!clientId) {
    clientId = uuid();
    write(storageKey('cid'), clientId);
  }

  const now = Date.now();
  let sessionId = read(storageKey('sid'));
  let ts = Number(read(storageKey('sid_ts')) || 0);
  let isNewSession = false;
  if (!sessionId || !ts || now - ts > SESSION_TIMEOUT_MS) {
    sessionId = uuid();
    isNewSession = true;
  }
  write(storageKey('sid'), sessionId);
  write(storageKey('sid_ts'), String(now));
  return { clientId, sessionId, isNewSession };
}

function send(eventName, clientId, sessionId, eventParams) {
  const payload = {
    site_id: SITE_ID,
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

  // Prefer fetch: sendBeacon + application/json is unreliable cross-origin (no preflight).
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body,
    keepalive: true,
    mode: 'cors',
    credentials: 'omit',
  }).catch(() => {
    try {
      // text/plain is a "simple" content-type so beacon CORS is more likely to succeed
      const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
      navigator.sendBeacon?.(url, blob);
    } catch { /* ignore */ }
  });
}

function installClickTracking() {
  if (clickTrackingInstalled) return;
  clickTrackingInstalled = true;
  document.addEventListener('click', (event) => {
    const element = event.target instanceof Element
      ? event.target.closest('a, button, input, select, summary, [role="button"]')
      : null;
    if (!element || element.closest('#consent-banner')) return;
    const anchor = element.closest('a');
    let outboundHost = null;
    if (anchor?.href) {
      try {
        const url = new URL(anchor.href, location.href);
        if (url.origin !== location.origin) outboundHost = url.hostname;
      } catch { /* ignore malformed links */ }
    }
    const explicit = element.getAttribute('data-analytics-label');
    const target = explicit || element.id || [element.tagName.toLowerCase(), ...element.classList].slice(0, 3).join('.');
    track('click', { target: target.slice(0, 120), outbound_host: outboundHost || '' });
  });
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
        to understand how ${PRODUCT_NAME} is used. No ads. No sale of data.
        <a href="${PRIVACY_URL}">Privacy</a>
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
  document.getElementById('consent-nudge')?.remove();
}

function showNudge() {
  if (document.getElementById('consent-nudge')) return;
  const nudge = document.createElement('button');
  nudge.type = 'button';
  nudge.id = 'consent-nudge';
  nudge.className = 'consent-nudge';
  nudge.textContent = 'Enable analytics';
  nudge.addEventListener('click', () => {
    nudge.remove();
    resetConsentPrompt();
  });
  document.body.appendChild(nudge);
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
