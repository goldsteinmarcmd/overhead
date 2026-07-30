/**
 * Overhead first-party analytics — Cloud Run collector + private dashboard.
 * GDPR: no raw IPs stored; country resolved in-memory then IP discarded.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import geoip from 'geoip-lite';
import UAParser from 'ua-parser-js';
import { v4 as uuidv4 } from 'uuid';
import { BigQuery } from '@google-cloud/bigquery';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const PROJECT_ID = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'overhead-analytics-260730';
const BQ_DATASET = process.env.BQ_DATASET || 'overhead';
const BQ_TABLE = process.env.BQ_TABLE || 'events';
const HMAC_SALT = process.env.HMAC_SALT || '';
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || '';

const ALLOWED_ORIGINS = new Set([
  'https://goldsteinmarcmd.github.io',
  'http://127.0.0.1:8877',
  'http://localhost:8877',
  'http://127.0.0.1:8080',
  'http://localhost:8080',
]);

const ALLOWED_EVENTS = new Set([
  'page_view',
  'session_start',
  'user_engagement',
  'select_sat',
  'search',
  'place_zoom',
  'filter_change',
  'event',
]);

const bq = new BigQuery({ projectId: PROJECT_ID });
const table = bq.dataset(BQ_DATASET).table(BQ_TABLE);
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);
// Accept JSON as application/json or text/plain (browser beacon-friendly)
app.use(express.text({ type: ['application/json', 'text/plain'], limit: '16kb' }));
app.use((req, res, next) => {
  if (typeof req.body === 'string' && req.body.length) {
    try {
      req.body = JSON.parse(req.body);
    } catch {
      req.body = {};
    }
  } else if (!req.body || typeof req.body !== 'object') {
    req.body = {};
  }
  next();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Dashboard-Secret');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/', (_req, res) => res.json({ service: 'overhead-analytics', ok: true }));

app.post('/collect', async (req, res) => {
  try {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: 'origin_denied' });
    }

    const body = req.body || {};
    const eventName = String(body.event_name || '').slice(0, 64);
    if (!ALLOWED_EVENTS.has(eventName)) {
      return res.status(400).json({ error: 'bad_event' });
    }

    const ua = String(req.headers['user-agent'] || '').slice(0, 512);
    const ip = clientIp(req);
    // Resolve country, then drop IP — never persist it.
    const country = countryFromIp(ip);
    const visitorId = dailyVisitorId(ip, ua);
    const parsed = new UAParser(ua).getResult();

    const row = {
      event_id: uuidv4(),
      event_name: eventName,
      received_at: bq.timestamp(new Date()),
      client_id: cleanId(body.client_id, 64),
      session_id: cleanId(body.session_id, 64),
      visitor_id: visitorId,
      page_location: cleanUrl(body.page_location),
      page_title: cleanStr(body.page_title, 200),
      page_referrer: cleanReferrer(body.page_referrer),
      utm_source: cleanStr(body.utm_source, 100),
      utm_medium: cleanStr(body.utm_medium, 100),
      utm_campaign: cleanStr(body.utm_campaign, 100),
      utm_content: cleanStr(body.utm_content, 100),
      utm_term: cleanStr(body.utm_term, 100),
      engagement_ms: toInt(body.engagement_ms, 0, 86_400_000),
      engaged: Boolean(body.engaged),
      device: deviceClass(parsed),
      browser: cleanStr(parsed.browser?.name, 40),
      os: cleanStr(parsed.os?.name, 40),
      country: country || null,
      event_params: safeParamsJson(body.event_params),
    };

    await table.insert([row], { ignoreUnknownValues: true, raw: false });
    return res.status(204).end();
  } catch (err) {
    console.error('collect_error', err?.message || err);
    // Still 204 to avoid client retries leaking consent state in UI
    return res.status(204).end();
  }
});

function requireDashboard(req, res, next) {
  if (!DASHBOARD_SECRET) {
    return res.status(503).send('Dashboard secret not configured');
  }
  const header = req.headers['x-dashboard-secret'] || '';
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const query = typeof req.query.secret === 'string' ? req.query.secret : '';
  const cookie = parseCookie(req.headers.cookie).overhead_dash || '';
  const provided = header || bearer || query || cookie;
  if (!provided || !timingSafeEqual(provided, DASHBOARD_SECRET)) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return res.status(401).type('html').send(loginHtml());
  }
  if (query && !cookie) {
    res.setHeader(
      'Set-Cookie',
      `overhead_dash=${encodeURIComponent(DASHBOARD_SECRET)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
    );
  }
  next();
}

app.get('/dashboard', requireDashboard, (_req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'));
});

app.get('/api/summary', requireDashboard, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 28));
    const summary = await querySummary(days);
    res.json(summary);
  } catch (err) {
    console.error('summary_error', err?.message || err);
    res.status(500).json({ error: 'query_failed', message: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`overhead-analytics listening on :${PORT} project=${PROJECT_ID}`);
});

// --- helpers ---

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.ip || '';
}

function countryFromIp(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1') return null;
  try {
    const geo = geoip.lookup(ip);
    return geo?.country || null;
  } catch {
    return null;
  }
}

function dailyVisitorId(ip, ua) {
  if (!HMAC_SALT) return null;
  const day = new Date().toISOString().slice(0, 10);
  return crypto
    .createHmac('sha256', HMAC_SALT)
    .update(`${day}|${ip}|${ua}`)
    .digest('hex')
    .slice(0, 32);
}

function cleanId(v, max) {
  const s = String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, max);
  return s || null;
}

function cleanStr(v, max) {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
  return s || null;
}

function cleanUrl(v) {
  const s = cleanStr(v, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    u.hash = '';
    // Drop common PII query keys
    for (const key of [...u.searchParams.keys()]) {
      if (/email|token|password|secret|phone/i.test(key)) u.searchParams.delete(key);
    }
    return u.toString().slice(0, 500);
  } catch {
    return null;
  }
}

function cleanReferrer(v) {
  const s = cleanStr(v, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    return `${u.origin}${u.pathname}`.slice(0, 500);
  } catch {
    return s.slice(0, 200);
  }
}

function toInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function deviceClass(parsed) {
  const t = parsed.device?.type;
  if (t === 'mobile') return 'mobile';
  if (t === 'tablet') return 'tablet';
  return 'desktop';
}

function safeParamsJson(params) {
  if (!params || typeof params !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(params).slice(0, 20)) {
    const key = String(k).slice(0, 40);
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string') out[key] = v.slice(0, 120);
  }
  try {
    return JSON.stringify(out).slice(0, 2000);
  } catch {
    return null;
  }
}

function parseCookie(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('=') || '');
  }
  return out;
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function loginHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Overhead analytics</title>
<style>
body{font:15px/1.4 system-ui,sans-serif;background:#05080f;color:#e8eef7;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#0b1220;padding:1.5rem;border-radius:12px;border:1px solid rgba(232,238,247,.12);width:min(22rem,92vw)}
input{width:100%;padding:.7rem;border-radius:8px;border:1px solid rgba(232,238,247,.2);background:#05080f;color:inherit}
button{margin-top:.8rem;width:100%;padding:.7rem;border:0;border-radius:8px;background:#4cc9f0;color:#05080f;font-weight:700;cursor:pointer}
p{color:#8b9bb3;font-size:.85rem}
</style></head><body>
<form method="get" action="/dashboard">
  <h1 style="margin:0 0 .5rem;font-size:1.2rem">Overhead analytics</h1>
  <p>Enter the dashboard secret.</p>
  <input type="password" name="secret" autocomplete="current-password" required />
  <button type="submit">Open</button>
</form></body></html>`;
}

async function querySummary(days) {
  const tableRef = `\`${PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\``;
  const [rows] = await bq.query({
    location: 'europe-west1',
    query: `
WITH base AS (
  SELECT *
  FROM ${tableRef}
  WHERE received_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
),
sessions AS (
  SELECT
    session_id,
    LOGICAL_OR(engaged) AS engaged,
    LOGICAL_OR(event_name = 'user_engagement') AS had_engagement,
    COUNTIF(event_name = 'page_view') AS pageviews
  FROM base
  WHERE session_id IS NOT NULL
  GROUP BY session_id
)
SELECT
  (SELECT COUNT(*) FROM base WHERE event_name = 'page_view') AS pageviews,
  (SELECT COUNT(DISTINCT client_id) FROM base WHERE client_id IS NOT NULL) AS users,
  (SELECT COUNT(DISTINCT session_id) FROM base WHERE session_id IS NOT NULL) AS sessions,
  (SELECT COUNTIF(NOT engaged AND NOT had_engagement) FROM sessions) AS bounced_sessions,
  (SELECT COUNT(*) FROM sessions) AS session_rows,
  (SELECT ARRAY_AGG(STRUCT(key AS name, value AS count) ORDER BY value DESC LIMIT 10)
     FROM (SELECT IFNULL(NULLIF(page_referrer, ''), '(direct)') AS key, COUNT(*) AS value
           FROM base WHERE event_name = 'page_view' GROUP BY key)) AS referrers,
  (SELECT ARRAY_AGG(STRUCT(key AS name, value AS count) ORDER BY value DESC LIMIT 10)
     FROM (SELECT IFNULL(country, '(unknown)') AS key, COUNT(*) AS value
           FROM base GROUP BY key)) AS countries,
  (SELECT ARRAY_AGG(STRUCT(key AS name, value AS count) ORDER BY value DESC LIMIT 10)
     FROM (SELECT IFNULL(device, '(unknown)') AS key, COUNT(*) AS value
           FROM base GROUP BY key)) AS devices,
  (SELECT ARRAY_AGG(STRUCT(key AS name, value AS count) ORDER BY value DESC LIMIT 15)
     FROM (SELECT event_name AS key, COUNT(*) AS value FROM base GROUP BY key)) AS events,
  (SELECT ARRAY_AGG(STRUCT(key AS name, value AS count) ORDER BY value DESC LIMIT 10)
     FROM (SELECT CONCAT(IFNULL(utm_source,'(none)'), ' / ', IFNULL(utm_medium,'(none)')) AS key, COUNT(*) AS value
           FROM base WHERE event_name = 'page_view' AND (utm_source IS NOT NULL OR utm_medium IS NOT NULL)
           GROUP BY key)) AS campaigns,
  (SELECT ARRAY_AGG(STRUCT(day, views) ORDER BY day)
     FROM (SELECT FORMAT_DATE('%Y-%m-%d', DATE(received_at)) AS day,
                  COUNTIF(event_name = 'page_view') AS views
           FROM base GROUP BY day)) AS daily,
  (SELECT COUNT(*) FROM base WHERE event_name = 'select_sat') AS sat_clicks,
  (SELECT COUNT(DISTINCT client_id) FROM base
     WHERE event_name = 'select_sat' AND client_id IS NOT NULL) AS sat_click_users,
  (SELECT ARRAY_AGG(STRUCT(norad, name, clicks, unique_users) ORDER BY clicks DESC LIMIT 25)
     FROM (
       SELECT
         IFNULL(JSON_VALUE(event_params, '$.norad'), '(unknown)') AS norad,
         ANY_VALUE(NULLIF(JSON_VALUE(event_params, '$.name'), '')) AS name,
         COUNT(*) AS clicks,
         COUNT(DISTINCT client_id) AS unique_users
       FROM base
       WHERE event_name = 'select_sat'
       GROUP BY norad
     )) AS satellites
    `,
    params: { days },
  });

  const r = rows[0] || {};
  const sessionRows = Number(r.session_rows || 0);
  const bounced = Number(r.bounced_sessions || 0);
  return {
    days,
    pageviews: Number(r.pageviews || 0),
    users: Number(r.users || 0),
    sessions: Number(r.sessions || 0),
    bounce_rate: sessionRows ? bounced / sessionRows : 0,
    sat_clicks: Number(r.sat_clicks || 0),
    sat_click_users: Number(r.sat_click_users || 0),
    referrers: r.referrers || [],
    countries: r.countries || [],
    devices: r.devices || [],
    events: r.events || [],
    campaigns: r.campaigns || [],
    daily: r.daily || [],
    satellites: r.satellites || [],
    refreshed_at: new Date().toISOString(),
  };
}
