#!/usr/bin/env node
/**
 * Builds the runtime catalog from raw CelesTrak TLE downloads.
 *
 *   node build.js
 *
 * Reads   data/raw-*.txt, data/supplement.txt, data/curated.json
 *         data/enrichment.json  (optional; UCS purpose + narrative links)
 * Writes  data/catalog.json     (every tracked object + classification)
 *         data/meta.json        (counts, generation time, legend)
 *         data/by-country.json  (country id → satellite list)
 *         data/by-operator.json (operator name → satellite list)
 *
 * Re-run `fetch.sh` first to refresh the TLEs.
 * Purpose enrichment: `node scripts/build-enrichment.js` (or `./fetch.sh --enrichment`).
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');

// ---------------------------------------------------------------- categories

const CATEGORIES = [
  { id: 'station',    label: 'Crewed stations',      color: '#ffffff' },
  { id: 'navigation', label: 'Navigation',           color: '#ffd166' },
  { id: 'comms-leo',  label: 'Comms — LEO broadband', color: '#4cc9f0' },
  { id: 'comms-geo',  label: 'Comms — GEO',          color: '#b388ff' },
  { id: 'earth',      label: 'Earth observation',    color: '#06d6a0' },
  { id: 'weather',    label: 'Weather',              color: '#5ee7df' },
  { id: 'science',    label: 'Science',              color: '#ff9f1c' },
  { id: 'military',   label: 'Military / intel',     color: '#ef476f' },
  { id: 'tech',       label: 'Tech demo / smallsat', color: '#8d99ae' },
  { id: 'derelict',   label: 'Derelict',             color: '#6c757d' },
];

const OWNERS = [
  { id: 'us',      label: 'United States',  flag: '🇺🇸' },
  { id: 'cn',      label: 'China',          flag: '🇨🇳' },
  { id: 'ru',      label: 'Russia',         flag: '🇷🇺' },
  { id: 'eu',      label: 'Europe',         flag: '🇪🇺' },
  { id: 'uk',      label: 'United Kingdom', flag: '🇬🇧' },
  { id: 'jp',      label: 'Japan',          flag: '🇯🇵' },
  { id: 'in',      label: 'India',          flag: '🇮🇳' },
  { id: 'intl',    label: 'Multinational',  flag: '🌐' },
  { id: 'other',   label: 'Other / unknown',flag: '🛰' },
];

/**
 * Ordered rules. First match wins, so put the specific constellations that
 * dominate the catalog (Starlink, OneWeb) at the top — it saves ~16k regex
 * walks and they are unambiguous anyway.
 */
const RULES = [
  [/^STARLINK/,                            'comms-leo',  'us',   'SpaceX'],
  [/^ONEWEB/,                              'comms-leo',  'uk',   'Eutelsat OneWeb'],
  [/^(QIANFAN|SPACESAIL|G[6-9]0|CHUTIAN)/, 'comms-leo',  'cn',   'Spacesail / Qianfan'],
  [/^(GUOWANG|SATNET|CENTISPACE)/,         'comms-leo',  'cn',   'China SatNet'],
  [/^KUIPER/,                              'comms-leo',  'us',   'Amazon Kuiper'],
  [/^IRIDIUM/,                             'comms-leo',  'us',   'Iridium Communications'],
  [/^GLOBALSTAR/,                          'comms-leo',  'us',   'Globalstar'],
  [/^ORBCOMM/,                             'comms-leo',  'us',   'ORBCOMM'],
  [/^(SWARM|SPACEBEE)/,                    'comms-leo',  'us',   'Swarm / SpaceX'],
  [/^(LEMUR|SPIRE)/,                       'earth',      'us',   'Spire Global'],
  [/^(FLOCK|SKYSAT|PELICAN|TANAGER|EDDA)/, 'earth',      'us',   'Planet Labs'],

  // Crewed stations
  [/^(ISS|CSS|TIANGONG|ZARYA|NAUKA|PROGRESS|SOYUZ-MS|CREW DRAGON|TIANZHOU|SHENZHOU|CYGNUS|DRAGON)/,
                                           'station',    'intl', 'Human spaceflight'],

  // Navigation
  [/^(GPS|NAVSTAR)/,                       'navigation', 'us',   'US Space Force'],
  [/^GSAT0/,                               'navigation', 'eu',   'EUSPA / Galileo'],
  [/^BEIDOU/,                              'navigation', 'cn',   'China Satellite Navigation Office'],
  [/^(QZS|MICHIBIKI)/,                     'navigation', 'jp',   'Cabinet Office of Japan'],
  [/^(IRNSS|NVS-)/,                        'navigation', 'in',   'ISRO / NavIC'],

  // Weather
  [/^(GOES|NOAA|SUOMI|JPSS|DMSP|POES)/,    'weather',    'us',   'NOAA'],
  [/^(METOP|METEOSAT|MSG-)/,               'weather',    'eu',   'EUMETSAT'],
  [/^HIMAWARI/,                            'weather',    'jp',   'Japan Meteorological Agency'],
  [/^(FENGYUN|FY-)/,                       'weather',    'cn',   'China Meteorological Administration'],
  [/^(ELEKTRO|METEOR-M|METEOR M)/,         'weather',    'ru',   'Roshydromet'],
  [/^INSAT/,                               'weather',    'in',   'ISRO'],
  [/^(ARKTIKA)/,                           'weather',    'ru',   'Roscosmos'],

  // Earth observation
  [/^(LANDSAT|TERRA$|AQUA$|AURA$|ICESAT|SMAP|OCO |GPM|SWOT|GRACE|PACE|NISAR|CALIPSO|CLOUDSAT|SORCE|TEMPO)/,
                                           'earth',      'us',   'NASA / USGS'],
  [/^SENTINEL/,                            'earth',      'eu',   'ESA / Copernicus'],
  [/^(SPOT|PLEIADES|CSO-|HELIOS)/,         'earth',      'eu',   'CNES / Airbus'],
  [/^(TERRASAR|TANDEM|ENMAP|EROS|RAPIDEYE)/,'earth',     'eu',   'DLR / Airbus'],
  [/^(COSMO-SKYMED|PRISMA)/,               'earth',      'eu',   'Italian Space Agency'],
  [/^(WORLDVIEW|GEOEYE|IKONOS|LEGION)/,    'earth',      'us',   'Maxar Technologies'],
  [/^(CAPELLA|BLACKSKY|HAWKEYE|UMBRA|ICEYE|SATELLOGIC|NUSAT)/,
                                           'earth',      'other','Commercial imaging'],
  [/^(GAOFEN|ZIYUAN|HAIYANG|JILIN|TIANHUI|SUPERVIEW|BEIJING-)/,
                                           'earth',      'cn',   'CNSA / commercial'],
  [/^(RESURS|KANOPUS|OBZOR)/,              'earth',      'ru',   'Roscosmos'],
  [/^(CARTOSAT|RESOURCESAT|RISAT|OCEANSAT|EOS-)/, 'earth','in',  'ISRO'],
  [/^(KOMPSAT|ARIRANG)/,                   'earth',      'other','KARI (South Korea)'],
  [/^(ALOS|GOSAT|IGS |ASNARO)/,            'earth',      'jp',   'JAXA'],
  [/^(RADARSAT|SCISAT)/,                   'earth',      'other','Canadian Space Agency'],
  [/^(JASON|SARAL|CRYOSAT|SWARM-|PROBA|AEOLUS|BIOMASS|EARTHCARE|SMOS|GOCE)/,
                                           'earth',      'eu',   'ESA'],
  [/^(PAZ|INGENIO|SEOSAT)/,                'earth',      'eu',   'Spain / Hisdesat'],

  // Science
  [/^(HST|CXO|FGRST|SWIFT|NUSTAR|IXPE|TESS|WISE|NEOWISE|SPITZER|KEPLER|JUNO|MAVEN|LUCY|PSYCHE|IMAP|PUNCH|SPHEREX)/,
                                           'science',    'us',   'NASA'],
  [/^(XMM|INTEGRAL|CHEOPS|GAIA|EUCLID|SOLAR ORBITER|BEPI|JUICE|PLATO|ARIEL)/,
                                           'science',    'eu',   'ESA'],
  [/^(SPEKTR|SPECTR)/,                     'science',    'ru',   'Roscosmos / IKI'],
  [/^(ASTROSAT|ADITYA)/,                   'science',    'in',   'ISRO'],
  [/^(EINSTEIN PROBE|SVOM|DAMPE|HXMT|XPOSAT|MOZI|QUESS)/,
                                           'science',    'cn',   'CAS / CNSA'],
  [/^(HINODE|AKATSUKI|XRISM|HITOMI|SOLAR-)/,'science',   'jp',   'JAXA'],

  // Military / intel
  [/^(USA |NROL|SBIRS|AEHF|WGS |MUOS|GSSAP|MILSTAR|DSCS|ORS-|STPSAT|TACRL|SDA-|TRANCHE)/,
                                           'military',   'us',   'US Department of Defense'],
  [/^(COSMOS|KOSMOS|BARS-M|BLAGOVEST|TUNDRA|RAZDAN)/,
                                           'military',   'ru',   'Russian Aerospace Forces'],
  [/^(YAOGAN|SHIJIAN|SHIYAN|TJS-|LUDI TANCE|CHUANGXIN)/,
                                           'military',   'cn',   'PLA / CASC'],
  [/^(SKYNET|NATO |SICRAL|SYRACUSE|ATHENA-FIDUS|COMSATBW|MILSATCOM)/,
                                           'military',   'eu',   'European MoD'],
  [/^(OFEK|TECSAR|EROS-)/,                 'military',   'other','Israel MoD'],
  [/^(KOMPSAT-5|425 PROJECT|ANASIS)/,      'military',   'other','South Korea'],

  // GEO communications
  [/^(INTELSAT|GALAXY|IS-)/,               'comms-geo',  'us',   'Intelsat / SES'],
  [/^(SES-|ASTRA|O3B|NSS-|AMC-)/,          'comms-geo',  'eu',   'SES S.A.'],
  [/^(EUTELSAT|HOTBIRD|HOT BIRD|W2A|KONNECT)/,'comms-geo','eu',  'Eutelsat'],
  [/^(ECHOSTAR|DIRECTV|SPACEWAY|NIMIQ|ANIK|CIEL)/,'comms-geo','us','EchoStar / DirecTV'],
  [/^(VIASAT|WILDBLUE)/,                   'comms-geo',  'us',   'Viasat'],
  [/^INMARSAT/,                            'comms-geo',  'uk',   'Inmarsat / Viasat'],
  [/^TDRS/,                                'comms-geo',  'us',   'NASA SCaN'],
  [/^(CHINASAT|ZHONGXING|APSTAR|ASIASAT|TIANLIAN|SINOSAT)/,
                                           'comms-geo',  'cn',   'China Satcom'],
  [/^(EXPRESS|YAMAL|LUCH|GONETS|GAZPROM)/, 'comms-geo',  'ru',   'RSCC / Gazprom'],
  [/^(JCSAT|SUPERBIRD|BSAT|HORIZONS)/,     'comms-geo',  'jp',   'SKY Perfect JSAT'],
  [/^(GSAT-|CMS-|HYLAS)/,                  'comms-geo',  'in',   'ISRO / INSAT'],
  [/^(ARABSAT|BADR|NILESAT|ES.HAIL|YAHSAT|AL YAH|TURKSAT|AMOS|THURAYA|PAKSAT|BANGABANDHU|AZERSPACE|HELLAS|HISPASAT|AMAZONAS|STAR ONE|TELKOM|MEASAT|THAICOM|PALAPA|KOREASAT|VINASAT|LAOSAT|OPTUS|NBN|SKY MUSTER|TELSTAR|BRISAT|NUSANTARA)/,
                                           'comms-geo',  'other','National / regional operator'],
];

function classify(name, group) {
  const n = name.toUpperCase().trim();
  for (const [re, cat, owner, operator] of RULES) {
    if (re.test(n)) return { cat, owner, operator };
  }
  // Fall back on the CelesTrak group the object was listed under.
  if (group === 'glo-ops')  return { cat: 'navigation', owner: 'ru', operator: 'Roscosmos / GLONASS' };
  if (group === 'military') return { cat: 'military',   owner: 'other', operator: 'Undisclosed' };
  if (group === 'geo')      return { cat: 'comms-geo',  owner: 'other', operator: 'Undisclosed' };
  if (group === 'science')  return { cat: 'science',    owner: 'other', operator: 'Undisclosed' };
  if (group === 'weather')  return { cat: 'weather',    owner: 'other', operator: 'Undisclosed' };
  if (group === 'resource') return { cat: 'earth',      owner: 'other', operator: 'Undisclosed' };
  return { cat: 'tech', owner: 'other', operator: 'Undisclosed' };
}

// ------------------------------------------------------------------ parsing

function parseTle(text, group, sink) {
  const L = text.split(/\r?\n/);
  for (let i = 0; i + 2 < L.length; i++) {
    const name = L[i].trim();
    const l1 = L[i + 1], l2 = L[i + 2];
    if (!name || !l1 || !l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
    const norad = parseInt(l1.slice(2, 7), 10);
    if (!Number.isFinite(norad)) continue;
    if (!sink.has(norad)) sink.set(norad, { norad, name, l1, l2, group });
    i += 2;
  }
}

const sats = new Map();

// Group files first so each object keeps its most specific group label,
// then the full active catalog to sweep up everything else.
const files = fs.readdirSync(DATA)
  .filter((f) => f.startsWith('raw-') && f.endsWith('.txt'))
  .sort((a, b) => (a === 'raw-active.txt' ? 1 : b === 'raw-active.txt' ? -1 : 0));

for (const f of files) {
  parseTle(fs.readFileSync(path.join(DATA, f), 'utf8'), f.slice(4, -4), sats);
}
if (fs.existsSync(path.join(DATA, 'supplement.txt'))) {
  parseTle(fs.readFileSync(path.join(DATA, 'supplement.txt'), 'utf8'), 'supplement', sats);
}

// ------------------------------------------------------ orbit class + output

const MU = 398600.4418; // km^3/s^2
const RE = 6378.137;    // km

/** Semi-major axis and eccentricity straight out of the TLE, for binning. */
function orbitOf(l2) {
  const meanMotion = parseFloat(l2.slice(52, 63));       // rev/day
  const ecc = parseFloat('0.' + l2.slice(26, 33).trim());
  const inc = parseFloat(l2.slice(8, 16));
  if (!meanMotion) return null;
  const n = (meanMotion * 2 * Math.PI) / 86400;          // rad/s
  const a = Math.cbrt(MU / (n * n));                     // km
  const apogee = a * (1 + ecc) - RE;
  const perigee = a * (1 - ecc) - RE;
  let cls = 'LEO';
  if (ecc > 0.25) cls = 'HEO';
  else if (apogee > 34000) cls = 'GEO';
  else if (apogee > 2000) cls = 'MEO';
  return { a, ecc, inc, apogee, perigee, cls };
}

const curated = JSON.parse(fs.readFileSync(path.join(DATA, 'curated.json'), 'utf8'));

let enrichment = null;
const enrichmentPath = path.join(DATA, 'enrichment.json');
if (fs.existsSync(enrichmentPath)) {
  enrichment = JSON.parse(fs.readFileSync(enrichmentPath, 'utf8'));
}

// Bind each dossier to a NORAD id, or to a constellation prefix.
const dossierByNorad = new Map();
const dossierByPrefix = [];
for (const d of curated.satellites) {
  if (d.norad != null) dossierByNorad.set(d.norad, d);
  else if (d.matchPrefix) dossierByPrefix.push(d);
}

const catIdx = Object.fromEntries(CATEGORIES.map((c, i) => [c.id, i]));
const ownIdx = Object.fromEntries(OWNERS.map((o, i) => [o.id, i]));

const out = [];
const counts = { cat: {}, owner: {}, orbit: {}, operator: {} };
let skipped = 0;
let enrichmentHits = 0;
let enrichmentBareHits = 0;

for (const s of sats.values()) {
  const orb = orbitOf(s.l2);
  if (!orb) { skipped++; continue; }

  const c = classify(s.name, s.group);
  const dossier = dossierByNorad.get(s.norad)
    || dossierByPrefix.find((d) => s.name.toUpperCase().startsWith(d.matchPrefix)
        && (!d.matchGroup || d.matchGroup === s.group));

  // A dossier is authoritative — it was researched by hand.
  const cat = dossier ? dossier.category : c.cat;
  const operator = dossier ? dossier.operator : c.operator;

  const enriched = enrichment?.byNorad?.[String(s.norad)];
  if (enriched) {
    enrichmentHits++;
    if (!dossier) enrichmentBareHits++;
  }

  counts.cat[cat] = (counts.cat[cat] || 0) + 1;
  counts.owner[c.owner] = (counts.owner[c.owner] || 0) + 1;
  counts.orbit[orb.cls] = (counts.orbit[orb.cls] || 0) + 1;
  counts.operator[operator] = (counts.operator[operator] || 0) + 1;

  out.push([
    s.norad,
    s.name,
    s.l1,
    s.l2,
    catIdx[cat] ?? catIdx.tech,
    ownIdx[c.owner] ?? ownIdx.other,
    orb.cls,
    Math.round(orb.perigee),
    Math.round(orb.apogee),
    +orb.inc.toFixed(2),
    dossier ? (dossier.norad != null ? String(dossier.norad) : dossier.constellation) : null,
    operator,
  ]);
}

out.sort((a, b) => a[0] - b[0]);

fs.writeFileSync(path.join(DATA, 'catalog.json'), JSON.stringify({
  fields: ['norad', 'name', 'l1', 'l2', 'cat', 'owner', 'orbit', 'perigeeKm', 'apogeeKm', 'incDeg', 'dossier', 'operator'],
  sats: out,
}));

const topOperators = Object.entries(counts.operator)
  .sort((a, b) => b[1] - a[1]);

const operators = topOperators.map(([id, count]) => ({ id, label: id, count }));

fs.writeFileSync(path.join(DATA, 'meta.json'), JSON.stringify({
  generated: new Date().toISOString(),
  source: 'CelesTrak GP element sets (celestrak.org), general perturbations catalog',
  total: out.length,
  categories: CATEGORIES,
  // `owners` = country / flag of registration (legacy field name in catalog rows).
  countries: OWNERS,
  owners: OWNERS,
  operators,
  counts,
  topOperators: topOperators.slice(0, 25),
  enrichment: enrichment ? {
    generated: enrichment.generated,
    ucsAsOf: enrichment.sources?.ucs?.asOf || null,
    matched: enrichmentHits,
    bareMatched: enrichmentBareHits,
    sources: Object.keys(enrichment.sources || {}),
  } : null,
}, null, 2));

const satEntry = (row) => ({
  norad: row[0],
  name: row[1],
  cat: CATEGORIES[row[4]]?.id || 'tech',
  orbit: row[6],
  operator: row[11],
  country: OWNERS[row[5]]?.id || 'other',
  dossier: row[10],
});

// Country → satellites
const byCountry = Object.fromEntries(OWNERS.map((o) => [o.id, {
  id: o.id,
  label: o.label,
  flag: o.flag,
  count: counts.owner[o.id] || 0,
  sats: [],
}]));

// Operator (SpaceX, Planet Labs, …) → satellites
const byOperator = Object.fromEntries(operators.map((o) => [o.id, {
  id: o.id,
  label: o.label,
  count: o.count,
  sats: [],
}]));

for (const row of out) {
  const entry = satEntry(row);
  const countryId = entry.country;
  (byCountry[countryId] || byCountry.other).sats.push(entry);
  if (!byOperator[entry.operator]) {
    byOperator[entry.operator] = {
      id: entry.operator,
      label: entry.operator,
      count: counts.operator[entry.operator] || 0,
      sats: [],
    };
  }
  byOperator[entry.operator].sats.push(entry);
}

for (const bucket of Object.values(byCountry)) {
  bucket.sats.sort((a, b) => a.name.localeCompare(b.name));
}
for (const bucket of Object.values(byOperator)) {
  bucket.sats.sort((a, b) => a.name.localeCompare(b.name));
}

fs.writeFileSync(path.join(DATA, 'by-country.json'), JSON.stringify({
  generated: new Date().toISOString(),
  fields: ['norad', 'name', 'cat', 'orbit', 'operator', 'country', 'dossier'],
  countries: byCountry,
}));

fs.writeFileSync(path.join(DATA, 'by-operator.json'), JSON.stringify({
  generated: new Date().toISOString(),
  fields: ['norad', 'name', 'cat', 'orbit', 'operator', 'country', 'dossier'],
  operators: byOperator,
}));

// Remove legacy filename if present
const legacy = path.join(DATA, 'by-owner.json');
if (fs.existsSync(legacy)) fs.unlinkSync(legacy);

console.log(`catalog.json      ${out.length} objects (${skipped} skipped, no usable elements)`);
console.log(`by-country.json   ${OWNERS.length} countries`);
console.log(`by-operator.json  ${Object.keys(byOperator).length} operators`);
console.log(`orbit classes ${Object.entries(counts.orbit).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`countries     ${Object.entries(counts.owner).sort((a,b)=>b[1]-a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`categories    ${Object.entries(counts.cat).sort((a,b)=>b[1]-a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`dossiers      ${out.filter((r) => r[10]).length} objects matched to ${curated.satellites.length} researched entries`);
if (enrichment) {
  console.log(`enrichment    ${enrichmentHits} UCS/narrative joins (${enrichmentBareHits} without hand dossier)`);
} else {
  console.log('enrichment    none — run: node scripts/build-enrichment.js');
}
console.log('\ntop operators by object count:');
for (const [op, n] of topOperators.slice(0, 12)) console.log(`  ${String(n).padStart(6)}  ${op}`);
