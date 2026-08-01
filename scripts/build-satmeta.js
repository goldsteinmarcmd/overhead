#!/usr/bin/env node
/**
 * Build per-NORAD satellite metadata for profiles:
 *   - CelesTrak SATCAT (launch date/site, ops status, object type, owner)
 *   - SatNOGS DB (status, website, names, image) for smallsat descriptions
 *   - CEOS EO Handbook (instruments + applications) for EO/weather matches
 *
 *   node scripts/build-satmeta.js [--skip-fetch] [--ceos-limit=80]
 *
 * Reads   data/catalog.json (optional filter)
 * Writes  data/satmeta.json, data/raw-satcat.csv, data/raw-satnogs.json
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const UA = 'OverheadSatCatalog/1.0 (+https://github.com/goldsteinmarcmd/overhead; research use)';

const SATCAT_URL = 'https://celestrak.org/satcat/records.php?GROUP=active&FORMAT=CSV';
const SATNOGS_URL = 'https://db.satnogs.org/api/satellites/?format=json';
const CEOS_INDEX = 'https://database.eohandbook.com/database/missionindex.aspx';
const CEOS_MISSION = (id) => `https://database.eohandbook.com/database/missionsummary.aspx?missionID=${id}`;

const args = process.argv.slice(2);
const SKIP_FETCH = args.includes('--skip-fetch');
const ceosLimitArg = args.find((a) => a.startsWith('--ceos-limit='));
const CEOS_LIMIT = ceosLimitArg ? parseInt(ceosLimitArg.split('=')[1], 10) : 80;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function curlTo(url, outPath) {
  const res = spawnSync(
    'curl',
    ['-fsSL', '--retry', '3', '--retry-delay', '2', '--max-time', '120', '-A', UA, url, '-o', outPath],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`curl failed ${url}: ${res.stderr || res.status}`);
}

function curlText(url, maxTime = 40) {
  const res = spawnSync(
    'curl',
    ['-fsSL', '--max-time', String(maxTime), '-A', UA, url],
    { encoding: 'utf8', maxBuffer: 6 * 1024 * 1024 },
  );
  if (res.status !== 0) return null;
  return res.stdout || '';
}

function normName(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const OPS_LABEL = {
  '+': 'Operational',
  '-': 'Nonoperational',
  P: 'Partially operational',
  B: 'Backup / standby',
  S: 'Stable',
  X: 'Extended mission',
  D: 'Decayed',
  '?': 'Unknown',
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
      row.push(field); rows.push(row); row = []; field = '';
      i += ch === '\r' ? 2 : 1; continue;
    }
    if (ch === '\r') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function loadCatalog() {
  const p = path.join(DATA, 'catalog.json');
  if (!fs.existsSync(p)) return null;
  const catalog = JSON.parse(fs.readFileSync(p, 'utf8'));
  const fi = Object.fromEntries(catalog.fields.map((f, i) => [f, i]));
  const byNorad = new Map();
  const byName = new Map();
  const eoNorads = new Set();
  for (const row of catalog.sats) {
    const norad = row[fi.norad];
    const name = row[fi.name];
    const cat = catalog.fields && row[fi.cat];
    // cat is index into meta categories — we don't have meta here; use name heuristics too
    byNorad.set(norad, { norad, name, orbit: row[fi.orbit] });
    const nn = normName(name);
    if (nn && !byName.has(nn)) byName.set(nn, norad);
    // rough EO/weather/science filter from name tokens for CEOS targeting
    if (/LANDSAT|SENTINEL|TERRA|AQUA|AURA|NOAA|GOES|METOP|HIMAWARI|MODIS|ICEYE|FLOCK|SKYSAT|WORLDVIEW|SPOT|PLEIADES|GAOFEN|RESOURCESAT|CARTOSAT|KOMPSAT|ALOS|RADARSAT|SMAP|SWOT|GPM|JASON|CRYOSAT|SMOS|ENMAP|PRISMA|CAPELLA|BLACKSKY|NUSAT|TANDEM|TERRASAR/.test(nn)) {
      eoNorads.add(norad);
    }
  }
  return { byNorad, byName, eoNorads, total: catalog.sats.length };
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const satcatPath = path.join(DATA, 'raw-satcat.csv');
  const satnogsPath = path.join(DATA, 'raw-satnogs.json');

  if (!SKIP_FETCH || !fs.existsSync(satcatPath)) {
    console.log('Fetching CelesTrak SATCAT (active)…');
    curlTo(SATCAT_URL, satcatPath);
  }
  if (!SKIP_FETCH || !fs.existsSync(satnogsPath)) {
    console.log('Fetching SatNOGS satellite list…');
    curlTo(SATNOGS_URL, satnogsPath);
  }

  const catalog = loadCatalog();
  const byNorad = {};

  // ---- SATCAT ----
  const satcatRows = parseCsv(fs.readFileSync(satcatPath, 'latin1'));
  const header = satcatRows[0].map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  let satcatHits = 0;
  for (const row of satcatRows.slice(1)) {
    const norad = parseInt(row[idx.NORAD_CAT_ID], 10);
    if (!Number.isFinite(norad)) continue;
    if (catalog && !catalog.byNorad.has(norad)) continue;
    const code = (row[idx.OPS_STATUS_CODE] || '').trim();
    byNorad[String(norad)] = {
      ...(byNorad[String(norad)] || {}),
      norad,
      launchDate: (row[idx.LAUNCH_DATE] || '').trim() || undefined,
      launchSite: (row[idx.LAUNCH_SITE] || '').trim() || undefined,
      decayDate: (row[idx.DECAY_DATE] || '').trim() || undefined,
      opsStatusCode: code || undefined,
      opsStatus: OPS_LABEL[code] || (code ? `Status ${code}` : undefined),
      objectType: (row[idx.OBJECT_TYPE] || '').trim() || undefined,
      satcatOwner: (row[idx.OWNER] || '').trim() || undefined,
      cospar: (row[idx.OBJECT_ID] || '').trim() || undefined,
      objectName: (row[idx.OBJECT_NAME] || '').trim() || undefined,
    };
    satcatHits++;
  }
  console.log(`SATCAT joined: ${satcatHits}`);

  // ---- SatNOGS ----
  const satnogs = JSON.parse(fs.readFileSync(satnogsPath, 'utf8'));
  let satnogsHits = 0;
  for (const s of satnogs) {
    const norad = s.norad_cat_id ?? s.norad_follow_id;
    if (!norad || (catalog && !catalog.byNorad.has(norad))) continue;
    const key = String(norad);
    const website = (s.website || '').trim();
    const citation = (s.citation || '').trim();
    const descBits = [];
    if (s.names) descBits.push(`Also known as ${s.names}`);
    if (website) descBits.push(`Project site: ${website}`);
    else if (/^https?:\/\//i.test(citation)) descBits.push(citation);

    const entry = byNorad[key] || { norad };
    entry.satnogs = {
      satId: s.sat_id,
      name: s.name,
      names: s.names || undefined,
      status: s.status || undefined,
      launched: s.launched || undefined,
      website: website || undefined,
      image: s.image ? `https://db-satnogs.freetls.fastly.net/media/${s.image}` : undefined,
      countries: s.countries || undefined,
      description: descBits.join('. ') || undefined,
    };
    if (!entry.launchDate && s.launched) {
      entry.launchDate = String(s.launched).slice(0, 10);
    }
    if (!entry.opsStatus && s.status) {
      entry.opsStatus = s.status === 'alive' ? 'Operational' : s.status;
    }
    byNorad[key] = entry;
    satnogsHits++;
  }
  console.log(`SatNOGS joined: ${satnogsHits}`);

  // ---- CEOS EO Handbook (mission index → summaries) ----
  let ceosHits = 0;
  if (CEOS_LIMIT > 0) {
    console.log('Fetching CEOS mission index…');
    const indexHtml = curlText(CEOS_INDEX, 45) || '';
    const missions = [];
    const re = /data-mission-id="(\d+)"\s+title="([^"]+)"/gi;
    let m;
    while ((m = re.exec(indexHtml))) {
      missions.push({ id: m[1], name: m[2].trim() });
    }
    console.log(`  ${missions.length} missions in index`);

    // Prefer NORAD join from handbook pages for EO-ish catalog names.
    const candidates = [];
    for (const mission of missions) {
      const nn = normName(mission.name);
      if (!nn || nn.startsWith('SEE ')) continue;
      let norad = catalog?.byName.get(nn);
      if (!norad && catalog) {
        for (const [cn, n] of catalog.byName) {
          if (cn === nn || cn.startsWith(`${nn} `) || nn.startsWith(`${cn} `)
            || cn.startsWith(nn) || nn.startsWith(cn)) {
            // Prefer EO heuristic names when ambiguous
            if (catalog.eoNorads.has(n) || cn.length >= 4) { norad = n; break; }
          }
        }
      }
      if (norad) candidates.push({ ...mission, norad });
    }
    // De-dupe by norad (first mission name wins)
    const seen = new Set();
    const unique = [];
    for (const c of candidates) {
      if (seen.has(c.norad)) continue;
      seen.add(c.norad);
      unique.push(c);
    }
    const toFetch = unique.slice(0, CEOS_LIMIT);
    console.log(`  name-matched ${unique.length}; fetching ${toFetch.length} summaries…`);

    for (const mission of toFetch) {
      const html = curlText(CEOS_MISSION(mission.id), 25);
      await sleep(250);
      if (!html) continue;

      let norad = mission.norad;
      const noradM = html.match(/lblNoradNumberLink[\s\S]*?CATNR=(\d+)/i)
        || html.match(/NORAD Catalog[^0-9]*(\d{3,6})/i);
      if (noradM) {
        const n = parseInt(noradM[1], 10);
        if (Number.isFinite(n) && (!catalog || catalog.byNorad.has(n))) norad = n;
      }

      const key = String(norad);
      const entry = byNorad[key] || { norad };
      const ceos = {
        missionId: mission.id,
        name: mission.name,
        url: CEOS_MISSION(mission.id),
        instruments: [],
      };
      const metaDesc = html.match(/<meta name="description" content="([^"]+)"/i);
      if (metaDesc) {
        const desc = metaDesc[1]
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"');
        const inst = desc.match(/Instruments:\s*([^.]+)/i);
        if (inst) ceos.instruments = inst[1].split(',').map((s) => s.trim()).filter(Boolean);
        const app2 = desc.match(/Instruments:[^.]+\.\s*Measurements:[^.]+\.\s*(.+)$/i)
          || desc.match(/Instruments:[^.]+\.\s*(.+)$/i);
        if (app2) ceos.applications = app2[1].trim().slice(0, 320);
      }
      const titles = [...html.matchAll(/data-instrument-id="\d+"\s+title="([^"]+)"/g)].map((x) => x[1]);
      if (titles.length) ceos.instruments = [...new Set(titles)];
      if (!ceos.instruments.length && !ceos.applications) continue;
      entry.ceos = ceos;
      byNorad[key] = entry;
      ceosHits++;
    }
    console.log(`CEOS joined: ${ceosHits}`);
  }

  const payload = {
    generated: new Date().toISOString(),
    sources: {
      satcat: { name: 'CelesTrak SATCAT', url: 'https://celestrak.org/satcat/satcat-format.php', query: SATCAT_URL },
      satnogs: { name: 'SatNOGS DB', url: 'https://db.satnogs.org/', license: 'CC BY-SA 4.0' },
      ceos: { name: 'CEOS EO Handbook (MIM)', url: 'https://database.eohandbook.com/' },
    },
    stats: {
      satcatHits,
      satnogsHits,
      ceosHits,
      emitted: Object.keys(byNorad).length,
    },
    byNorad,
  };

  const out = path.join(DATA, 'satmeta.json');
  fs.writeFileSync(out, JSON.stringify(payload));
  console.log(`Wrote ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB, ${payload.stats.emitted} sats)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
