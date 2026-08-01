#!/usr/bin/env node
/**
 * Build purpose / narrative enrichment from open databases.
 *
 *   node scripts/build-enrichment.js [--excerpts] [--skip-fetch]
 *
 * Sources
 *   UCS Satellite Database  — purpose, users, operator, comments, COSPAR
 *   ESA eoPortal            — mission page links (+ optional meta excerpts)
 *   NASA NSSDCA             — spacecraft page links by COSPAR (+ optional excerpts)
 *   Gunter’s Space Page     — citation links only when already listed in UCS
 *                             sources (no body scrape; site is scrape-hostile)
 *
 * Join order: NORAD id (preferred), then normalized name.
 *
 * Reads   data/raw-ucs.txt (downloaded if missing), data/catalog.json (optional filter)
 * Writes  data/enrichment.json
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const UCS_URL =
  'https://www.ucs.org/sites/default/files/2024-01/UCS-Satellite-Database%205-1-2023%20%28text%29.txt';
const UCS_AS_OF = '2023-05-01';
const UCS_PATH = path.join(DATA, 'raw-ucs.txt');
const OUT_PATH = path.join(DATA, 'enrichment.json');
const UA = 'OverheadSatCatalog/1.0 (+https://github.com/goldsteinmarcmd/overhead; research use)';

const args = new Set(process.argv.slice(2));
const WANT_EXCERPTS = args.has('--excerpts');
const SKIP_FETCH = args.has('--skip-fetch');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function downloadUcs() {
  fs.mkdirSync(DATA, { recursive: true });
  console.log('Fetching UCS Satellite Database…');
  const res = spawnSync(
    'curl',
    ['-fsSL', '--retry', '3', '--retry-delay', '2', '-A', UA, UCS_URL, '-o', UCS_PATH],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    throw new Error(`UCS download failed: ${res.stderr || res.stdout || res.status}`);
  }
  const bytes = fs.statSync(UCS_PATH).size;
  console.log(`  → ${UCS_PATH} (${(bytes / 1024).toFixed(0)} KB)`);
}

/** Minimal TSV parser that respects double-quoted fields. */
function parseTsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === '\t') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' ? 2 : 1;
      continue;
    }
    if (ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normName(s) {
  if (!s) return '';
  return String(s)
    .toUpperCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function parseNorad(raw) {
  if (raw == null || raw === '') return null;
  const n = parseInt(String(raw).replace(/,/g, '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function splitUsers(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\/,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildSummary(purpose, detailed, comments) {
  const bits = [];
  if (purpose) {
    bits.push(detailed && detailed !== purpose ? `${purpose} — ${detailed}` : purpose);
  } else if (detailed) {
    bits.push(detailed);
  }
  if (comments) {
    const c = comments.replace(/\s+/g, ' ').trim();
    if (c && !bits.some((b) => b.includes(c.slice(0, 40)))) bits.push(c);
  }
  return bits.join('. ').replace(/\.\./g, '.').trim();
}

/** Rewrite legacy directory.eoportal.org URLs to the current site. */
function normalizeEoportalUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (!host.includes('eoportal.org')) return null;
    // /web/eoportal/satellite-missions/{letter}/{slug}
    // /web/eoportal/satellite-missions/{slug}
    // /satellite-missions/{slug}
    // Prefer /satellite-missions/{letter}/{slug} or /{group}-missions/{slug}
    let m = u.pathname.match(/\/satellite-missions\/(?:[a-z0-9]+-missions|[a-z])\/([a-z0-9][a-z0-9-]{1,80})/i);
    if (!m) m = u.pathname.match(/\/satellite-missions\/([a-z0-9][a-z0-9-]{1,80})/i);
    if (!m) return null;
    const slug = m[1].toLowerCase();
    // Reject catalogue index stubs and CMS paths.
    if (
      slug === 'content'
      || slug === 'article'
      || /^(?:[a-z]-)+[a-z]$/.test(slug) // v-w-x-y-z style indexes
      || slug.endsWith('-missions')
    ) return null;
    return `https://www.eoportal.org/satellite-missions/${slug}`;
  } catch {
    return null;
  }
}

function normalizeGunterUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (!host.endsWith('skyrocket.de')) return null;
    // www.skyrocket.de/space/doc_sdat/foo.htm → /doc_sdat/foo.htm
    let p = u.pathname.replace(/^\/space/, '');
    if (!/\/doc_sdat\/[^/]+\.htm$/i.test(p)) return null;
    return `https://space.skyrocket.de${p}`;
  } catch {
    return null;
  }
}

function nssdcUrl(cospar) {
  if (!cospar || !/^\d{4}-\d{3}[A-Z]{1,3}$/i.test(cospar.trim())) return null;
  return `https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=${cospar.trim().toUpperCase()}`;
}

function collectUrls(row, startCol) {
  const urls = [];
  for (let i = startCol; i < row.length; i++) {
    const cell = (row[i] || '').trim();
    if (!cell) continue;
    for (const part of cell.split(/\s+/)) {
      if (/^https?:\/\//i.test(part)) urls.push(part.replace(/[),.;]+$/, ''));
    }
  }
  return urls;
}

function decodeHtml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url) {
  const res = spawnSync(
    'curl',
    ['-fsSL', '--max-time', '25', '-A', UA, url],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  if (res.status !== 0) return null;
  return res.stdout || '';
}

async function excerptEoportal(url) {
  const html = await fetchText(url);
  if (!html) return null;
  const meta = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  if (meta) {
    const t = decodeHtml(meta[1]);
    if (t.length > 40) return t.slice(0, 420);
  }
  const p = html.match(/<p[^>]*>([^<]{80,500})<\/p>/i);
  return p ? decodeHtml(p[1]).slice(0, 420) : null;
}

async function excerptNssdc(url) {
  const html = await fetchText(url);
  if (!html) return null;
  if (/temporarily offline for maintenance/i.test(html)) return null;
  // Prefer the description block used on classic NMC pages.
  const desc = html.match(/Description<\/h2>\s*<p[^>]*>([\s\S]*?)<\/p>/i)
    || html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  if (!desc) return null;
  const t = decodeHtml(desc[1]);
  if (/temporarily offline/i.test(t) || t.length < 40) return null;
  return t.slice(0, 420);
}

function loadCatalogNoradsAndNames() {
  const catalogPath = path.join(DATA, 'catalog.json');
  if (!fs.existsSync(catalogPath)) return null;
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const fi = Object.fromEntries(catalog.fields.map((f, i) => [f, i]));
  const norads = new Set();
  const nameToNorad = new Map();
  for (const row of catalog.sats) {
    const norad = row[fi.norad];
    const name = row[fi.name];
    norads.add(norad);
    const nn = normName(name);
    if (nn && !nameToNorad.has(nn)) nameToNorad.set(nn, norad);
  }
  return { norads, nameToNorad, total: catalog.sats.length };
}

async function main() {
  if (!SKIP_FETCH || !fs.existsSync(UCS_PATH)) downloadUcs();
  else console.log(`Using existing ${UCS_PATH}`);

  const raw = fs.readFileSync(UCS_PATH, 'latin1');
  const rows = parseTsv(raw);
  if (rows.length < 2) throw new Error('UCS file empty or unreadable');
  const header = rows[0].map((h) => h.replace(/^"|"$/g, '').trim());
  const col = (name) => {
    const i = header.findIndex((h) => h === name || h.toLowerCase() === name.toLowerCase());
    if (i < 0) throw new Error(`UCS column missing: ${name}`);
    return i;
  };

  const C = {
    alt: 0,
    name: col('Current Official Name of Satellite'),
    operator: col('Operator/Owner'),
    users: col('Users'),
    purpose: col('Purpose'),
    detailed: col('Detailed Purpose'),
    cospar: col('COSPAR Number'),
    norad: col('NORAD Number'),
    comments: col('Comments'),
    sourceStart: header.findIndex((h) => /^Source Used for Orbital Data$/i.test(h)),
  };
  if (C.sourceStart < 0) C.sourceStart = C.comments + 1;

  const catalog = loadCatalogNoradsAndNames();
  const byNorad = new Map();
  const byName = new Map();
  let parsed = 0;

  for (const row of rows.slice(1)) {
    if (!row.length || row.every((c) => !c)) continue;
    const norad = parseNorad(row[C.norad]);
    if (norad == null) continue;
    parsed++;

    const name = (row[C.name] || '').trim();
    const alt = (row[C.alt] || '').trim();
    const purpose = (row[C.purpose] || '').trim();
    const detailed = (row[C.detailed] || '').trim();
    const comments = (row[C.comments] || '').trim();
    const cospar = (row[C.cospar] || '').trim().toUpperCase();
    const operator = (row[C.operator] || '').trim();
    const users = splitUsers(row[C.users]);
    const summary = buildSummary(purpose, detailed, comments);

    const narratives = [];
    const seen = new Set();
    const addNarrative = (provider, url, extra = {}) => {
      if (!url || seen.has(`${provider}|${url}`)) return;
      seen.add(`${provider}|${url}`);
      narratives.push({ provider, url, ...extra });
    };

    for (const url of collectUrls(row, C.sourceStart)) {
      const eo = normalizeEoportalUrl(url);
      if (eo) addNarrative('eoportal', eo, { label: 'ESA eoPortal' });
      const g = normalizeGunterUrl(url);
      if (g) addNarrative('gunter', g, { label: "Gunter’s Space Page", citeOnly: true });
      if (/nssdc\.gsfc\.nasa\.gov\/nmc\/spacecraft\/display\.action/i.test(url)) {
        addNarrative('nssdc', url.split('#')[0], { label: 'NASA NSSDCA' });
      }
    }

    const nss = nssdcUrl(cospar);
    if (nss) addNarrative('nssdc', nss, { label: 'NASA NSSDCA' });

    const entry = {
      norad,
      name,
      purpose,
      detailedPurpose: detailed || undefined,
      users,
      operator: operator || undefined,
      cospar: cospar || undefined,
      comments: comments || undefined,
      summary,
      confidence: 'ucs',
      source: 'UCS Satellite Database',
      asOf: UCS_AS_OF,
      narratives,
      match: 'norad',
    };

    // Prefer denser narratives / comments if duplicates appear.
    const prev = byNorad.get(norad);
    if (!prev || (entry.narratives.length > prev.narratives.length)
      || ((entry.comments || '').length > (prev.comments || '').length)) {
      byNorad.set(norad, entry);
    }

    for (const label of [name, alt]) {
      const nn = normName(label);
      if (nn && !byName.has(nn)) byName.set(nn, norad);
    }
  }

  console.log(`Parsed ${parsed} UCS rows → ${byNorad.size} unique NORAD ids`);

  // Restrict client payload to objects in our catalog when available.
  const outByNorad = {};
  let noradHits = 0;
  let nameHits = 0;

  if (catalog) {
    for (const norad of catalog.norads) {
      const e = byNorad.get(norad);
      if (!e) continue;
      outByNorad[String(norad)] = { ...e, match: 'norad' };
      noradHits++;
    }
    // Name fallback for catalog sats missing a NORAD hit.
    for (const [nn, catNorad] of catalog.nameToNorad) {
      if (outByNorad[String(catNorad)]) continue;
      const ucsNorad = byName.get(nn);
      if (ucsNorad == null) continue;
      const e = byNorad.get(ucsNorad);
      if (!e) continue;
      outByNorad[String(catNorad)] = {
        ...e,
        norad: catNorad,
        match: 'name',
        ucsNorad,
      };
      nameHits++;
    }
    console.log(
      `Catalog join: ${noradHits} by NORAD, ${nameHits} by name `
      + `(of ${catalog.total} catalog objects; UCS has ${byNorad.size})`,
    );
  } else {
    for (const [norad, e] of byNorad) outByNorad[String(norad)] = e;
    console.log('No catalog.json yet — writing full UCS index');
  }

  // Optional narrative excerpts (eoPortal + NSSDCA). Gunter is link-only.
  let excerptCount = 0;
  if (WANT_EXCERPTS) {
    const eoUrls = new Map(); // url → [norad keys]
    const nssUrls = new Map();
    for (const [key, e] of Object.entries(outByNorad)) {
      for (const n of e.narratives || []) {
        if (n.provider === 'eoportal') {
          if (!eoUrls.has(n.url)) eoUrls.set(n.url, []);
          eoUrls.get(n.url).push(key);
        }
        if (n.provider === 'nssdc' && e.purpose && /science|earth|meteorolog/i.test(e.purpose)) {
          if (!nssUrls.has(n.url)) nssUrls.set(n.url, []);
          nssUrls.get(n.url).push(key);
        }
      }
    }
    /** Only attach an eoPortal blurb when the URL slug overlaps the sat name. */
    function slugMatchesSat(url, entry) {
      let slug = '';
      try { slug = new URL(url).pathname.split('/').pop() || ''; } catch { return false; }
      const slugToks = new Set(normName(slug.replace(/-/g, ' ')).split(' ').filter((t) => t.length > 2));
      if (!slugToks.size) return false;
      const nameToks = new Set([
        ...normName(entry.name).split(' '),
        ...normName(entry.summary || '').split(' ').slice(0, 8),
      ].filter((t) => t.length > 2));
      let hits = 0;
      for (const t of slugToks) if (nameToks.has(t)) hits++;
      // Strong single token (landsat, kompsat, pleiades) or ≥2 overlaps.
      if (hits >= 2) return true;
      if (hits === 1 && slugToks.size <= 2) return true;
      return false;
    }

    console.log(`Fetching excerpts: ${eoUrls.size} eoPortal, ${nssUrls.size} NSSDCA…`);
    for (const [url, keys] of eoUrls) {
      const excerpt = await excerptEoportal(url);
      await sleep(350);
      if (!excerpt) continue;
      let attached = false;
      for (const key of keys) {
        const entry = outByNorad[key];
        if (!slugMatchesSat(url, entry)) continue;
        for (const n of entry.narratives) {
          if (n.provider === 'eoportal' && n.url === url) {
            n.excerpt = excerpt;
            attached = true;
          }
        }
      }
      if (attached) excerptCount++;
    }
    let nssdcOffline = false;
    for (const [url, keys] of nssUrls) {
      if (nssdcOffline) break;
      const excerpt = await excerptNssdc(url);
      await sleep(350);
      if (!excerpt) {
        // One maintenance page is enough — don't hammer NSSDCA while it's down.
        const probe = await fetchText(url);
        if (probe && /temporarily offline for maintenance/i.test(probe)) {
          console.log('  NSSDCA appears offline for maintenance — skipping remaining excerpts');
          nssdcOffline = true;
        }
        continue;
      }
      excerptCount++;
      for (const key of keys) {
        for (const n of outByNorad[key].narratives) {
          if (n.provider === 'nssdc' && n.url === url) n.excerpt = excerpt;
        }
      }
    }
    console.log(`  excerpts attached: ${excerptCount}`);
  }

  const payload = {
    generated: new Date().toISOString(),
    sources: {
      ucs: {
        name: 'UCS Satellite Database',
        url: 'https://www.ucs.org/resources/satellite-database',
        file: UCS_URL,
        asOf: UCS_AS_OF,
        note: 'UCS paused updates after the 5/1/2023 release. Purpose/users are operator-reported.',
      },
      eoportal: {
        name: 'ESA eoPortal',
        url: 'https://www.eoportal.org/satellite-missions',
        note: 'Mission narrative pages; joined via UCS source links and slug normalization.',
      },
      nssdc: {
        name: 'NASA NSSDCA Master Catalog',
        url: 'https://nssdc.gsfc.nasa.gov/nmc/',
        note: 'Spacecraft pages keyed by COSPAR id. Site may be intermittently offline.',
      },
      gunter: {
        name: "Gunter’s Space Page",
        url: 'https://space.skyrocket.de/',
        note: 'Citation links only when present in UCS sources — no body scrape.',
      },
    },
    stats: {
      ucsRows: parsed,
      ucsUniqueNorad: byNorad.size,
      catalogNoradHits: noradHits,
      catalogNameHits: nameHits,
      emitted: Object.keys(outByNorad).length,
      excerpts: excerptCount,
    },
    byNorad: outByNorad,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(payload));
  const mb = (fs.statSync(OUT_PATH).size / (1024 * 1024)).toFixed(2);
  console.log(`Wrote ${OUT_PATH} (${mb} MB, ${payload.stats.emitted} sats)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
