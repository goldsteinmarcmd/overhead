import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { imageryFor, fillLastImage } from './imagery.js';
import { geocode, reverseGeocode, formatLatLon } from './geocode.js';
import { latLonToScene, findOverhead, lookAngleAt, compass, subpointOf } from './sky.js';
import { initAnalytics, track } from './analytics.js';

/** Cloud Run collector — set after deploy; empty disables beacons. */
const ANALYTICS_COLLECT_URL = window.__OVERHEAD_ANALYTICS_URL
  || 'https://overhead-analytics-xytglqjhja-ew.a.run.app';

const EARTH_RADIUS_KM = 6371.0;
const SCENE_EARTH_R = 1.0;
const KM_TO_SCENE = SCENE_EARTH_R / EARTH_RADIUS_KM;
/** Optional visual multiplier — off by default so craft are true scale vs Earth. */
const SIZE_MAGNIFICATION_ENLARGED = 2500;
const PROP_INTERVAL_MS = 750;

const PLACE_COLOR = 0xffb703;
const PLACE_VIEW_DIST = 1.85;   // camera distance, in Earth radii from centre
const FLIGHT_MS = 1200;
const SKY_UPDATE_MS = 1500;     // slower than propagation so rows stay clickable
const SKY_MAX_ROWS = 40;
const SKY_MAX_RAYS = 14;
/** Fraction of the limiting viewport axis that Earth (radius 1) should fill on load. */
const INITIAL_EARTH_FILL = 0.58;

/** Camera distance so Earth frames like the mobile reference zoom on every refresh. */
function initialViewDistance(fovDeg, aspect) {
  const vFov = THREE.MathUtils.degToRad(fovDeg);
  const limitingFov = aspect < 1
    ? 2 * Math.atan(Math.tan(vFov / 2) * aspect)
    : vFov;
  return SCENE_EARTH_R / Math.tan((INITIAL_EARTH_FILL * limitingFov) / 2);
}

const $ = (id) => document.getElementById(id);

const canvas = $('globe');
const statusEl = $('status');
const clockEl = $('clock');
const filtersCatEl = $('filters-cat');
const filtersOwnerEl = $('filters-owner');
const filtersCountryEl = $('filters-country');
const panel = $('panel');
const panelBody = $('panel-body');
const searchInput = $('search');
const searchResults = $('search-results');
const placeInput = $('place');
const placeResults = $('place-results');
const appEl = document.getElementById('app');

initAnalytics({
  collectUrl: ANALYTICS_COLLECT_URL.includes('PLACEHOLDER') ? '' : ANALYTICS_COLLECT_URL,
  siteId: 'overhead',
  productName: 'Overhead',
  privacyUrl: 'privacy.html',
});

const state = {
  meta: null,
  curated: null,
  byOperator: null,
  byCountry: null,
  sats: [],
  satrecs: [],
  noradToIdx: new Map(),
  enabledCat: new Set(),
  enabledOperator: new Set(),
  enabledCountry: new Set(),
  selectedIdx: -1,
  paused: false,
  showOrbit: false,
  /** 1 = true scale vs Earth; SIZE_MAGNIFICATION_ENLARGED when enlarged. */
  sizeMagnification: 1,
  simTime: new Date(),
  lastProp: 0,
  positions: null,
  colors: null,
  baseColors: null,
  sizes: null,
  lengthM: null,
  dimensions: null,
  visible: null,
  browseKind: null, // 'operator' | 'country' — side panel (from sat detail)
  browseId: null,
  browseQuery: '',
  operatorFilterQ: '',
  expandedOperator: null,
  expandedCountry: null,
  expandQuery: '',
  imageryToken: null,
  pictureFilter: 'all', // 'all' | 'yes' | 'no'
  place: null,          // { name, context, lat, lon } — the address pin
  placeCandidates: [],
  skyMode: false,       // panel is showing the overhead list, not a satellite
  skyMinEl: 10,         // degrees above the horizon
  skyRows: [],
  skyAboveHorizon: 0,
  lastSkyAt: 0,
  flight: null,
};

/** Live <li> per satellite index, so the overhead list can re-sort in place. */
const skyRowCache = new Map();

// ----------------------------------------------------------------- three

function createRenderer() {
  // Some Android Chrome / Adreno configs fail antialiased contexts; fall back.
  try {
    const hi = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    if (hi.getContext()) return hi;
  } catch {
    /* try again without AA */
  }
  return new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
}

const renderer = createRenderer();
if (!renderer.getContext()) {
  statusEl.textContent = 'WebGL unavailable in this browser — Overhead can’t render the globe.';
  throw new Error('WebGL unavailable');
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 200);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 1.35;
controls.maxDistance = 12;
controls.enablePan = false;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.22;

/** Keep the reference framing until the user zooms/pans the globe. */
let viewFramingLocked = false;
function applyInitialFraming() {
  if (viewFramingLocked) return;
  const dist = initialViewDistance(camera.fov, camera.aspect);
  camera.position
    .set(0, 0.12, 1)
    .normalize()
    .multiplyScalar(dist);
  controls.target.set(0, 0, 0);
  controls.update();
}
applyInitialFraming();

scene.add(new THREE.AmbientLight(0x6a7a96, 0.55));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.35);
sun.position.set(5, 1.2, 2.5);
scene.add(sun);

const earthGroup = new THREE.Group();
scene.add(earthGroup);

const loader = new THREE.TextureLoader();

// Kick catalog download while Earth textures load — biggest win on phones.
statusEl.textContent = 'Loading Overhead…';
const dataPromise = Promise.all([
  fetchJson('data/meta.json'),
  fetchJson('data/catalog.json'),
  fetchJson('data/curated.json'),
  fetchJson('data/dimensions.json'),
  fetchJson('data/enrichment.json').catch(() => null),
  fetchJson('data/satmeta.json').catch(() => null),
]);

let dayMap;
let nightMap;
let topoMap;
try {
  [dayMap, nightMap, topoMap] = await Promise.all([
    loadTex('assets/earth-day.jpg'),
    loadTex('assets/earth-night.jpg'),
    loadTex('assets/earth-topo.png'),
  ]);
} catch (err) {
  console.error(err);
  statusEl.textContent = 'Couldn’t load Earth textures — refresh to try again.';
  throw err;
}

const earthMat = new THREE.MeshPhongMaterial({
  map: dayMap,
  bumpMap: topoMap,
  bumpScale: 0.014,
  specularMap: topoMap,
  specular: new THREE.Color(0x1a2030),
  shininess: 12,
  // Night lights read through on the unlit hemisphere via emissive map.
  emissiveMap: nightMap,
  emissive: new THREE.Color(0xffc27a),
  emissiveIntensity: 0.55,
});

const earth = new THREE.Mesh(new THREE.SphereGeometry(SCENE_EARTH_R, 96, 96), earthMat);
// ECEF frame: globe texture stays fixed; satellites are converted into the same frame.
earthGroup.add(earth);

const atmos = new THREE.Mesh(
  new THREE.SphereGeometry(SCENE_EARTH_R * 1.018, 64, 64),
  new THREE.MeshBasicMaterial({
    color: 0x4cc9f0,
    transparent: true,
    opacity: 0.07,
    side: THREE.BackSide,
    depthWrite: false,
  }),
);
earthGroup.add(atmos);

const pointsGeom = new THREE.BufferGeometry();
const pointsMat = new THREE.PointsMaterial({
  size: 0.012, // fallback / raycast reference; per-sat size comes from aSize
  sizeAttenuation: true,
  vertexColors: true,
  transparent: true,
  opacity: 0.92,
  depthWrite: false,
});
// PointsMaterial is one uniform size — inject a per-vertex attribute instead.
pointsMat.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace(
      'uniform float size;',
      'attribute float aSize;\nuniform float size;',
    )
    .replace('gl_PointSize = size;', 'gl_PointSize = aSize;');
};
pointsMat.customProgramCacheKey = () => 'sat-relative-size';
const points = new THREE.Points(pointsGeom, pointsMat);
scene.add(points);

const orbitLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }),
);
orbitLine.visible = false;
scene.add(orbitLine);

// --- address pin: a dot on the surface, a tangent ring, and a short mast so
// --- it still reads when the location is near the limb of the globe.
const markerGroup = new THREE.Group();
markerGroup.visible = false;
scene.add(markerGroup);

const markerPos = new THREE.Vector3();

markerGroup.add(new THREE.Mesh(
  new THREE.SphereGeometry(0.011, 16, 16),
  new THREE.MeshBasicMaterial({ color: PLACE_COLOR }),
));

const markerRing = new THREE.Mesh(
  new THREE.RingGeometry(0.022, 0.028, 48),
  new THREE.MeshBasicMaterial({
    color: PLACE_COLOR,
    transparent: true,
    opacity: 0.65,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),
);
markerRing.position.z = 0.002; // local +Z points away from Earth's centre
markerGroup.add(markerRing);

markerGroup.add(new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, 0.06),
  ]),
  new THREE.LineBasicMaterial({ color: PLACE_COLOR, transparent: true, opacity: 0.7 }),
));

// Invisible but still raycastable — gives the pin a forgiving click target.
const markerHit = new THREE.Mesh(
  new THREE.SphereGeometry(0.035, 12, 12),
  new THREE.MeshBasicMaterial({ visible: false }),
);
markerGroup.add(markerHit);

const rayPositions = new Float32Array(SKY_MAX_RAYS * 6);
const rayGeom = new THREE.BufferGeometry();
rayGeom.setAttribute('position', new THREE.BufferAttribute(rayPositions, 3));
rayGeom.setDrawRange(0, 0);
const rays = new THREE.LineSegments(
  rayGeom,
  new THREE.LineBasicMaterial({
    color: PLACE_COLOR,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  }),
);
rays.visible = false;
scene.add(rays);

const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.025;
const pointer = new THREE.Vector2();

// ----------------------------------------------------------------- data

statusEl.textContent = 'Fetching catalog…';

let meta;
let catalog;
let curated;
let dimensions;
let enrichment;
let satmeta;
try {
  // Started earlier, in parallel with the Earth textures.
  [meta, catalog, curated, dimensions, enrichment, satmeta] = await dataPromise;
} catch (err) {
  console.error(err);
  statusEl.textContent = 'Couldn’t load the satellite catalog — check your connection and refresh.';
  throw err;
}

state.meta = meta;
state.curated = curated;
state.dimensions = dimensions;
state.enrichment = enrichment;
state.satmeta = satmeta;
// Owner/country expand indexes (~5 MB) load on demand — see ensureBrowseIndex.

const lengthByKey = new Map();
for (const d of dimensions.satellites) {
  lengthByKey.set(String(d.key), d.characteristicLengthM);
}
const categoryLengthM = dimensions.categoryDefaultsM || {};

const fields = catalog.fields;
const fi = Object.fromEntries(fields.map((f, i) => [f, i]));
const cats = meta.categories;
const countries = meta.countries || meta.owners;
const operators = meta.operators || [];
cats.forEach((c) => state.enabledCat.add(c.id));
countries.forEach((c) => state.enabledCountry.add(c.id));
operators.forEach((o) => state.enabledOperator.add(o.id));

const dossierByKey = new Map();
for (const d of curated.satellites) {
  if (d.norad != null) dossierByKey.set(String(d.norad), d);
  if (d.constellation) dossierByKey.set(d.constellation, d);
}

function enrichmentFor(norad) {
  return enrichment?.byNorad?.[String(norad)] || null;
}

function satmetaFor(norad) {
  return satmeta?.byNorad?.[String(norad)] || null;
}

const COVER_UPDATE_MS = 45000;
let coverTimer = null;
let coverAbort = null;

function stopCoverageUpdates() {
  if (coverTimer) { clearInterval(coverTimer); coverTimer = null; }
  if (coverAbort) { coverAbort.abort(); coverAbort = null; }
}

/** Live “currently over …” for LEO fleets; GEO shows the longitude slot. */
async function updateCoverageLine() {
  const el = $('sat-coverage');
  const idx = state.selectedIdx;
  if (!el || idx == null || idx < 0) return;
  const row = state.sats[idx];
  const satrec = state.satrecs[idx];
  const sub = subpointOf(satrec, new Date());
  if (!sub) {
    el.textContent = '';
    return;
  }
  const orbit = row[fi.orbit];
  if (orbit === 'GEO') {
    const lon = sub.lon;
    const hemi = lon >= 0 ? `${Math.abs(lon).toFixed(1)}°E` : `${Math.abs(lon).toFixed(1)}°W`;
    el.textContent = `Geostationary slot ~${hemi} · sub-satellite point ${formatLatLon(sub.lat, sub.lon)}`;
    return;
  }
  el.textContent = `Currently over ${formatLatLon(sub.lat, sub.lon)}…`;
  if (coverAbort) coverAbort.abort();
  coverAbort = new AbortController();
  try {
    const label = await reverseGeocode(sub.lat, sub.lon, { signal: coverAbort.signal });
    if (state.selectedIdx !== idx) return;
    el.textContent = label
      ? `Currently over ${label}`
      : `Currently over ${formatLatLon(sub.lat, sub.lon)}`;
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (state.selectedIdx === idx) {
      el.textContent = `Currently over ${formatLatLon(sub.lat, sub.lon)}`;
    }
  }
}

function startCoverageUpdates() {
  stopCoverageUpdates();
  updateCoverageLine();
  coverTimer = setInterval(updateCoverageLine, COVER_UPDATE_MS);
}

const n = catalog.sats.length;
state.sats = catalog.sats;
state.satrecs = new Array(n);

function lengthMForRow(row) {
  const dossierKey = row[fi.dossier];
  if (dossierKey != null && lengthByKey.has(String(dossierKey))) {
    return lengthByKey.get(String(dossierKey));
  }
  const norad = String(row[fi.norad]);
  if (lengthByKey.has(norad)) return lengthByKey.get(norad);
  const catId = cats[row[fi.cat]]?.id;
  return categoryLengthM[catId] ?? 2;
}

function sceneSizeFromLengthM(lengthM, magnification = state.sizeMagnification) {
  return (lengthM / 1000) * KM_TO_SCENE * magnification;
}

function formatLengthM(m) {
  if (m >= 10) return `${Math.round(m)} m`;
  if (m >= 1) return `${m.toFixed(1)} m`;
  if (m >= 0.1) return `${Math.round(m * 100)} cm`;
  return `${Math.round(m * 1000)} mm`;
}

function sizeScaleNote() {
  if (state.sizeMagnification <= 1) {
    return 'Point size is true scale vs Earth — most craft are smaller than a pixel until you enlarge.';
  }
  return `Point size is physical length × ${SIZE_MAGNIFICATION_ENLARGED.toLocaleString()} so craft stay relative to each other and readable on the globe.`;
}

function sizeFactLabel(lengthM) {
  const base = formatLengthM(lengthM);
  if (state.sizeMagnification <= 1) return `${base} · true scale vs Earth`;
  return `${base} · shown ×${SIZE_MAGNIFICATION_ENLARGED.toLocaleString()} vs Earth`;
}

function applyPointSizes() {
  if (!state.sizes || !state.lengthM) return;
  const mag = state.sizeMagnification;
  for (let i = 0; i < state.lengthM.length; i++) {
    state.sizes[i] = sceneSizeFromLengthM(state.lengthM[i], mag);
  }
  const attr = pointsGeom.getAttribute('aSize');
  if (attr) attr.needsUpdate = true;
}

state.positions = new Float32Array(n * 3);
state.colors = new Float32Array(n * 3);
state.baseColors = new Float32Array(n * 3);
state.sizes = new Float32Array(n);
state.lengthM = new Float32Array(n);
state.visible = new Uint8Array(n);

const tmpColor = new THREE.Color();
const SATREC_CHUNK = 800;
statusEl.textContent = 'Preparing orbits…';
for (let i = 0; i < n; i++) {
  const row = catalog.sats[i];
  state.noradToIdx.set(row[fi.norad], i);
  const cat = cats[row[fi.cat]];
  tmpColor.set(cat?.color || '#8d99ae');
  state.baseColors[i * 3] = tmpColor.r;
  state.baseColors[i * 3 + 1] = tmpColor.g;
  state.baseColors[i * 3 + 2] = tmpColor.b;
  state.visible[i] = 1;
  const lengthM = lengthMForRow(row);
  state.lengthM[i] = lengthM;
  state.sizes[i] = sceneSizeFromLengthM(lengthM);
  try {
    state.satrecs[i] = satellite.twoline2satrec(row[fi.l1], row[fi.l2]);
  } catch {
    state.satrecs[i] = null;
  }
  // Yield so Chrome on phones doesn’t freeze on ~16k TLE parses.
  if (i > 0 && i % SATREC_CHUNK === 0) {
    statusEl.textContent = `Preparing orbits… ${Math.round((i / n) * 100)}%`;
    await new Promise((r) => setTimeout(r, 0));
  }
}

pointsGeom.setAttribute('position', new THREE.BufferAttribute(state.positions, 3));
pointsGeom.setAttribute('color', new THREE.BufferAttribute(state.colors, 3));
pointsGeom.setAttribute('aSize', new THREE.BufferAttribute(state.sizes, 1));
pointsGeom.computeBoundingSphere();

const hasPicture = new Uint8Array(n);
for (let i = 0; i < n; i++) {
  const row = state.sats[i];
  hasPicture[i] = imageryFor(row[fi.norad], row[fi.dossier]) ? 1 : 0;
}

buildFilters();
propagate(true);
statusEl.textContent = `${meta.total.toLocaleString()} objects · generated ${fmtDate(meta.generated)}`;
// ----------------------------------------------------------------- UI

$('pause').addEventListener('change', (e) => {
  state.paused = e.target.checked;
  controls.autoRotate = !state.paused && state.selectedIdx < 0;
});

$('show-orbits').addEventListener('change', (e) => {
  state.showOrbit = e.target.checked;
  updateOrbitLine();
});

$('enlarge-size').addEventListener('change', (e) => {
  state.sizeMagnification = e.target.checked ? SIZE_MAGNIFICATION_ENLARGED : 1;
  applyPointSizes();
  if (state.selectedIdx >= 0 && !state.skyMode && !state.browseKind) {
    const row = state.sats[state.selectedIdx];
    const dossierKey = row[fi.dossier];
    const dossier = dossierKey ? dossierByKey.get(String(dossierKey)) : null;
    renderPanel(row, dossier);
  }
});

// Closing a satellite while a place is pinned steps back to its overhead list.
$('panel-close').addEventListener('click', () => {
  if (state.place && !state.skyMode) showSky();
  else closePanel();
});

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  if (q.length < 2) {
    searchResults.hidden = true;
    searchResults.innerHTML = '';
    return;
  }
  const hits = [];
  for (let i = 0; i < n && hits.length < 12; i++) {
    const row = state.sats[i];
    const name = String(row[fi.name]).toLowerCase();
    const norad = String(row[fi.norad]);
    if (name.includes(q) || norad.includes(q)) hits.push(i);
  }
  if (!hits.length) {
    searchResults.hidden = true;
    return;
  }
  searchResults.innerHTML = hits.map((i) => {
    const row = state.sats[i];
    return `<li data-i="${i}"><span>${escapeHtml(row[fi.name])}</span><span class="norad">${row[fi.norad]}</span></li>`;
  }).join('');
  searchResults.hidden = false;
});

searchResults.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  track('search', { kind: 'sat', q_len: searchInput.value.trim().length });
  selectSat(+li.dataset.i);
  searchResults.hidden = true;
  searchInput.value = state.sats[+li.dataset.i][fi.name];
});

// Hand the camera back the moment they grab or zoom it.
canvas.addEventListener('pointerdown', () => {
  viewFramingLocked = true;
  controls.autoRotate = false;
  state.flight = null;
});
canvas.addEventListener('wheel', () => {
  viewFramingLocked = true;
  state.flight = null;
}, { passive: true });
controls.addEventListener('start', () => { viewFramingLocked = true; });

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  if (state.place) {
    const pin = raycaster.intersectObject(markerHit, false);
    if (pin.length) { showSky(); return; }
  }
  const hits = raycaster.intersectObject(points);
  if (!hits.length) return;
  const idx = hits[0].index;
  if (state.visible[idx]) selectSat(idx);
});

// ------------------------------------------------------------ address lookup

let placeTimer = null;
let placeAbort = null;

placeInput.addEventListener('input', () => {
  clearTimeout(placeTimer);
  const q = placeInput.value.trim();
  if (q.length < 3) {
    placeAbort?.abort();
    hidePlaceResults();
    return;
  }
  placeTimer = setTimeout(() => runGeocode(q, false), 550);
});

placeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hidePlaceResults(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  clearTimeout(placeTimer);
  const q = placeInput.value.trim();
  if (q.length >= 2) runGeocode(q, true);
});

placeResults.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-idx]');
  if (!li) return;
  const place = state.placeCandidates[+li.dataset.idx];
  if (place) choosePlace(place);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-field')) {
    hidePlaceResults();
    searchResults.hidden = true;
  }
});

async function runGeocode(query, applyTop) {
  placeAbort?.abort();
  placeAbort = new AbortController();
  showPlaceStatus('Looking up…');
  try {
    const places = await geocode(query, { signal: placeAbort.signal });
    if (!places.length) {
      showPlaceStatus('No match — try a city, a full address, or “lat, lon”.');
      return;
    }
    if (applyTop) { choosePlace(places[0]); return; }
    state.placeCandidates = places;
    placeResults.innerHTML = places.map((p, idx) => `
      <li data-idx="${idx}">
        <span class="place-name">${escapeHtml(p.name)}</span>
        <span class="place-context">${escapeHtml(p.context || p.kind || '')}</span>
      </li>
    `).join('');
    placeResults.hidden = false;
  } catch (err) {
    if (err?.name === 'AbortError') return;
    showPlaceStatus('Lookup failed — check the connection and try again.');
  }
}

function showPlaceStatus(text) {
  state.placeCandidates = [];
  placeResults.innerHTML = `<li class="drop-status">${escapeHtml(text)}</li>`;
  placeResults.hidden = false;
}

function hidePlaceResults() {
  placeResults.hidden = true;
  placeResults.innerHTML = '';
  state.placeCandidates = [];
}

function choosePlace(place) {
  hidePlaceResults();
  placeInput.value = place.name;
  setPlace(place);
}

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  // Phones often report the wrong size on the first paint; re-frame until touched.
  applyInitialFraming();
});

// ----------------------------------------------------------------- loop

function animate(t) {
  requestAnimationFrame(animate);
  if (!state.paused) {
    state.simTime = new Date();
    if (t - state.lastProp > PROP_INTERVAL_MS) {
      propagate(false);
      state.lastProp = t;
    }
  }
  // Keep the sun roughly over the subsolar point so city lights read on the night side.
  const minutes = state.simTime.getUTCHours() * 60 + state.simTime.getUTCMinutes();
  const sunAngle = ((minutes / (24 * 60)) * Math.PI * 2) - Math.PI / 2;
  sun.position.set(Math.cos(sunAngle) * 5, 0.4, Math.sin(sunAngle) * 5);

  stepFlight(t);
  if (markerGroup.visible) {
    const pulse = 1 + Math.sin(t / 420) * 0.12;
    markerRing.scale.setScalar(pulse);
    markerRing.material.opacity = 0.45 + (1.12 - pulse) * 1.4;
  }

  controls.update();
  renderer.render(scene, camera);
  clockEl.textContent = state.simTime.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}
requestAnimationFrame(animate);

// ----------------------------------------------------------------- core

function propagate(force) {
  const date = state.simTime;
  const gmst = satellite.gstime(date);
  const pos = state.positions;
  const col = state.colors;
  const base = state.baseColors;
  let alive = 0;

  for (let i = 0; i < n; i++) {
    const row = state.sats[i];
    const catId = cats[row[fi.cat]]?.id;
    const countryId = countries[row[fi.owner]]?.id;
    const operatorId = row[fi.operator];
    const pic = state.pictureFilter;
    const hasPic = hasPicture[i] === 1;
    const picOk = pic === 'all' || (pic === 'yes' ? hasPic : !hasPic);
    const on = state.enabledCat.has(catId)
      && state.enabledCountry.has(countryId)
      && state.enabledOperator.has(operatorId)
      && picOk;
    state.visible[i] = on ? 1 : 0;

    if (!on || !state.satrecs[i]) {
      pos[i * 3] = pos[i * 3 + 1] = pos[i * 3 + 2] = 0;
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0;
      continue;
    }

    const pv = satellite.propagate(state.satrecs[i], date);
    if (!pv?.position) {
      pos[i * 3] = 0; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = 0;
      continue;
    }

    // ECI → ECEF so the cloud co-rotates with the textured Earth mesh
    const ecf = satellite.eciToEcf(pv.position, gmst);
    pos[i * 3] = ecf.x * KM_TO_SCENE;
    pos[i * 3 + 1] = ecf.z * KM_TO_SCENE; // three.js Y-up
    pos[i * 3 + 2] = -ecf.y * KM_TO_SCENE;

    const selected = i === state.selectedIdx;
    const boost = selected ? 1.35 : 1;
    col[i * 3] = Math.min(1, base[i * 3] * boost);
    col[i * 3 + 1] = Math.min(1, base[i * 3 + 1] * boost);
    col[i * 3 + 2] = Math.min(1, base[i * 3 + 2] * boost);
    alive++;
  }

  pointsGeom.attributes.position.needsUpdate = true;
  pointsGeom.attributes.color.needsUpdate = true;
  if (force) pointsGeom.computeBoundingSphere();

  if (state.showOrbit) updateOrbitLine();
  if (state.place) updateSky(force);
  statusEl.textContent = `${alive.toLocaleString()} visible · ${meta.total.toLocaleString()} tracked`;
}

function selectSat(i, opts = {}) {
  // With a place pinned the camera stays put — you're looking at your own sky.
  const keepCamera = opts.keepCamera ?? Boolean(state.place);
  state.selectedIdx = i;
  state.skyMode = false;
  controls.autoRotate = false;
  const row = state.sats[i];
  const dossierKey = row[fi.dossier];
  const dossier = dossierKey ? dossierByKey.get(String(dossierKey)) : null;
  track('select_sat', {
    norad: row[fi.norad],
    name: String(dossier?.shortName || row[fi.name] || '').slice(0, 80),
    category: cats[row[fi.cat]]?.id || '',
    has_dossier: Boolean(dossier),
  });
  renderPanel(row, dossier);
  setPanelOpen(true);
  updateOrbitLine();
  if (!keepCamera) {
    // Nudge camera toward the sat
    const x = state.positions[i * 3];
    const y = state.positions[i * 3 + 1];
    const z = state.positions[i * 3 + 2];
    const target = new THREE.Vector3(x, y, z);
    if (target.lengthSq() > 0.01) {
      const dir = target.clone().normalize();
      const dist = Math.max(2.2, target.length() * 1.8);
      state.flight = null;
      camera.position.copy(dir.multiplyScalar(dist));
      controls.target.set(0, 0, 0);
    }
  }
  propagate(false);
}

function updateOrbitLine() {
  if (!state.showOrbit || state.selectedIdx < 0) {
    orbitLine.visible = false;
    return;
  }
  const satrec = state.satrecs[state.selectedIdx];
  if (!satrec) { orbitLine.visible = false; return; }

  const samples = 180;
  const pts = [];
  const periodMin = (2 * Math.PI) / satrec.no; // satrec.no is rad/min
  const start = state.simTime.getTime();
  for (let s = 0; s <= samples; s++) {
    const t = new Date(start + (s / samples) * periodMin * 60_000);
    const pv = satellite.propagate(satrec, t);
    if (!pv?.position) continue;
    const gmst = satellite.gstime(t);
    const ecf = satellite.eciToEcf(pv.position, gmst);
    pts.push(new THREE.Vector3(
      ecf.x * KM_TO_SCENE,
      ecf.z * KM_TO_SCENE,
      -ecf.y * KM_TO_SCENE,
    ));
  }
  orbitLine.geometry.dispose();
  orbitLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  orbitLine.visible = pts.length > 2;
}

// ------------------------------------------------------------------ place

function setPlace(place) {
  state.place = place;
  track('place_zoom', {
    kind: place.kind || 'place',
    has_coords: Number.isFinite(place.lat) && Number.isFinite(place.lon),
  });
  const p = latLonToScene(place.lat, place.lon, SCENE_EARTH_R);
  markerPos.set(p.x, p.y, p.z);
  markerGroup.position.copy(markerPos);
  // Orient the pin so its local +Z points straight up from the surface.
  markerGroup.lookAt(markerPos.clone().multiplyScalar(2));
  markerGroup.visible = true;
  rays.visible = true;
  flyTo(markerPos, PLACE_VIEW_DIST);
  showSky();
}

function clearPlace() {
  state.place = null;
  state.skyRows = [];
  state.skyAboveHorizon = 0;
  markerGroup.visible = false;
  rays.visible = false;
  rayGeom.setDrawRange(0, 0);
  placeInput.value = '';
  hidePlaceResults();
  closePanel();
}

/** Swing the camera around to sit directly over `target`. */
function flyTo(target, distance, ms = FLIGHT_MS) {
  const to = target.clone().normalize();
  if (!Number.isFinite(to.lengthSq()) || to.lengthSq() === 0) return;
  viewFramingLocked = true;
  state.flight = {
    fromDir: camera.position.clone().normalize(),
    fromDist: camera.position.length(),
    toDir: to,
    toDist: distance,
    t0: performance.now(),
    dur: ms,
  };
  controls.autoRotate = false;
}

function stepFlight(t) {
  const f = state.flight;
  if (!f) return;
  const k = Math.min(1, (t - f.t0) / f.dur);
  const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  // Slerp the direction so the camera arcs over the globe instead of cutting
  // through it, and ease the radius in separately.
  const turn = new THREE.Quaternion().setFromUnitVectors(f.fromDir, f.toDir);
  const step = new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), turn, e);
  const dir = f.fromDir.clone().applyQuaternion(step);
  camera.position.copy(dir.multiplyScalar(f.fromDist + (f.toDist - f.fromDist) * e));
  controls.target.set(0, 0, 0);
  if (k >= 1) state.flight = null;
}

// -------------------------------------------------------------- sky panel

function showSky() {
  if (!state.place) return;
  state.skyMode = true;
  skyRowCache.clear();
  const place = state.place;

  panelBody.innerHTML = `
    <p class="eyebrow place-eyebrow">Overhead now</p>
    <h2>${escapeHtml(place.name)}</h2>
    <p class="sub">${escapeHtml(place.context || place.kind || 'Pinned location')}</p>
    <p class="place-coords">${escapeHtml(formatLatLon(place.lat, place.lon))}</p>

    <div class="sky-el-filter" role="group" aria-label="Minimum elevation">
      <button type="button" class="sky-el-btn" data-minel="0">Horizon</button>
      <button type="button" class="sky-el-btn" data-minel="10">Above 10°</button>
      <button type="button" class="sky-el-btn" data-minel="30">Above 30°</button>
    </div>

    <p class="sky-summary" id="sky-summary">Computing…</p>
    <ul class="sky-list" id="sky-list"></ul>
    <p class="note" id="sky-more"></p>

    <div class="sky-actions">
      <button type="button" class="sky-clear" id="sky-clear">Clear location</button>
    </div>

    <p class="note">
      Elevation is the angle above your horizon — 90° is straight up. Range is
      the slant distance to the satellite. Above the horizon means line of
      sight, not naked-eye visible: most of these are only visible near dawn or
      dusk, if at all. Highlighted names have a hand-researched dossier. The
      list follows your category, owner and country filters.
    </p>
  `;

  panelBody.querySelectorAll('.sky-el-btn').forEach((btn) => {
    btn.classList.toggle('active', +btn.dataset.minel === state.skyMinEl);
    btn.addEventListener('click', () => {
      state.skyMinEl = +btn.dataset.minel;
      panelBody.querySelectorAll('.sky-el-btn').forEach((b) => {
        b.classList.toggle('active', +b.dataset.minel === state.skyMinEl);
      });
      updateSky(true);
    });
  });

  $('sky-clear').addEventListener('click', () => clearPlace());
  $('sky-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) selectSat(+li.dataset.i, { keepCamera: true });
  });

  setPanelOpen(true);
  updateSky(true);
}

function updateSky(force) {
  if (!state.place) return;
  const now = performance.now();
  if (!force && now - state.lastSkyAt < SKY_UPDATE_MS) return;
  state.lastSkyAt = now;

  const { rows, aboveHorizon } = findOverhead({
    observer: { lat: state.place.lat, lon: state.place.lon, altKm: 0 },
    positions: state.positions,
    visible: state.visible,
    count: n,
    kmToScene: KM_TO_SCENE,
    minElevationDeg: state.skyMinEl,
  });
  state.skyRows = rows;
  state.skyAboveHorizon = aboveHorizon;

  updateRays(rows);
  if (state.skyMode) renderSkyRows(rows, aboveHorizon);
}

function updateRays(rows) {
  const count = Math.min(rows.length, SKY_MAX_RAYS);
  for (let k = 0; k < count; k++) {
    const i = rows[k].i;
    rayPositions[k * 6] = markerPos.x;
    rayPositions[k * 6 + 1] = markerPos.y;
    rayPositions[k * 6 + 2] = markerPos.z;
    rayPositions[k * 6 + 3] = state.positions[i * 3];
    rayPositions[k * 6 + 4] = state.positions[i * 3 + 1];
    rayPositions[k * 6 + 5] = state.positions[i * 3 + 2];
  }
  rayGeom.attributes.position.needsUpdate = true;
  rayGeom.setDrawRange(0, count * 2);
}

function renderSkyRows(rows, aboveHorizon) {
  const list = $('sky-list');
  const summary = $('sky-summary');
  if (!list || !summary) return;

  const shown = rows.slice(0, SKY_MAX_ROWS);
  summary.innerHTML = state.skyMinEl > 0
    ? `<b>${rows.length.toLocaleString()}</b> above ${state.skyMinEl}° · ${aboveHorizon.toLocaleString()} above the horizon`
    : `<b>${aboveHorizon.toLocaleString()}</b> above the horizon`;

  if (!shown.length) {
    list.replaceChildren(Object.assign(document.createElement('li'), {
      className: 'sky-empty',
      textContent: aboveHorizon
        ? `Nothing above ${state.skyMinEl}° right now — ${aboveHorizon.toLocaleString()} lower down.`
        : 'Nothing overhead right now with these filters.',
    }));
    skyRowCache.clear();
    $('sky-more').textContent = '';
    return;
  }

  // Keyed reconcile: rows are re-sorted every tick, so reuse the <li> elements
  // and just move them rather than rebuilding (keeps hover and scroll sane).
  let ref = list.firstElementChild;
  for (const r of shown) {
    const li = skyRowCache.get(r.i) || makeSkyRow(r.i);
    li._el.textContent = `${r.elevation.toFixed(0)}°`;
    li._dir.textContent = compass(r.azimuth);
    li._range.textContent = `${Math.round(r.rangeKm).toLocaleString()} km`;
    li.classList.toggle('is-selected', r.i === state.selectedIdx);
    if (li === ref) ref = ref.nextElementSibling;
    else list.insertBefore(li, ref);
  }
  while (ref) {
    const next = ref.nextElementSibling;
    skyRowCache.delete(+ref.dataset.i);
    ref.remove();
    ref = next;
  }

  const hidden = rows.length - shown.length;
  $('sky-more').textContent = hidden > 0
    ? `${hidden.toLocaleString()} more above ${state.skyMinEl}° — raise the threshold or narrow the filters.`
    : '';
}

function makeSkyRow(i) {
  const row = state.sats[i];
  const cat = cats[row[fi.cat]];
  const li = document.createElement('li');
  li.className = `sky-row${row[fi.dossier] ? ' has-dossier' : ''}`;
  li.dataset.i = i;
  li.title = row[fi.operator] || '';
  li.innerHTML = `
    <span class="sky-swatch" style="background:${cat?.color || '#8d99ae'}"></span>
    <span class="sky-name">${escapeHtml(row[fi.name])}</span>
    <span class="sky-el"></span>
    <span class="sky-dir"></span>
    <span class="sky-range"></span>
  `;
  li._el = li.querySelector('.sky-el');
  li._dir = li.querySelector('.sky-dir');
  li._range = li.querySelector('.sky-range');
  skyRowCache.set(i, li);
  return li;
}

function setPanelOpen(open) {
  panel.hidden = !open;
  appEl.classList.toggle('panel-open', open);
}

function shortOperator(name) {
  // Prefer the bit before a parenthetical for denser filter rows.
  const m = String(name || '').match(/^(.+?)\s*\(/);
  return (m ? m[1] : name).trim();
}

function buildFilters() {
  const catCounts = state.meta.counts.cat || {};
  const countryCounts = state.meta.counts.owner || {};

  filtersCatEl.innerHTML = cats.map((c) => `
    <button type="button" class="filter-btn" data-cat="${c.id}" style="--c:${c.color}">
      <span class="swatch" style="background:${c.color}"></span>
      <span class="label-text">${escapeHtml(c.label)}</span>
      <span class="count">${(catCounts[c.id] || 0).toLocaleString()}</span>
    </button>
  `).join('');

  renderOperatorFilterList();
  renderCountryFilterList(countryCounts);

  filtersCatEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    toggleSet(state.enabledCat, btn.dataset.cat, btn);
    propagate(true);
  });

  filtersOwnerEl.addEventListener('click', (e) => {
    const sat = e.target.closest('[data-norad]');
    if (sat && sat.closest('.expand-list')) {
      const idx = state.noradToIdx.get(+sat.dataset.norad);
      if (idx != null) selectSat(idx);
      return;
    }
    const chevron = e.target.closest('.chevron-btn');
    if (chevron) {
      e.stopPropagation();
      const card = chevron.closest('[data-operator]');
      if (!card) return;
      const id = card.dataset.operator;
      state.expandedOperator = state.expandedOperator === id ? null : id;
      state.expandQuery = '';
      renderOperatorFilterList();
      return;
    }
    const row = e.target.closest('.filter-card-head, .vis-toggle');
    if (row) {
      const card = row.closest('[data-operator]');
      if (!card) return;
      toggleSet(state.enabledOperator, card.dataset.operator, card);
      // Keep ● in sync if they clicked the name row
      const vis = card.querySelector('.vis-toggle');
      if (vis) vis.textContent = card.classList.contains('off') ? '○' : '●';
      propagate(true);
    }
  });

  filtersOwnerEl.addEventListener('input', (e) => {
    if (e.target.id === 'op-filter-q') {
      state.operatorFilterQ = e.target.value;
      renderOperatorFilterList();
      return;
    }
    if (e.target.classList.contains('expand-q')) {
      state.expandQuery = e.target.value;
      fillExpandBody(e.target.closest('.filter-card-body'), 'operator', state.expandedOperator);
      const el = e.target;
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
    }
  });

  filtersCountryEl.addEventListener('click', (e) => {
    const sat = e.target.closest('[data-norad]');
    if (sat && sat.closest('.expand-list')) {
      const idx = state.noradToIdx.get(+sat.dataset.norad);
      if (idx != null) selectSat(idx);
      return;
    }
    const chevron = e.target.closest('.chevron-btn');
    if (chevron) {
      e.stopPropagation();
      const card = chevron.closest('[data-country]');
      if (!card) return;
      const id = card.dataset.country;
      state.expandedCountry = state.expandedCountry === id ? null : id;
      state.expandQuery = '';
      renderCountryFilterList(state.meta.counts.owner || {});
      return;
    }
    const row = e.target.closest('.filter-card-head, .vis-toggle');
    if (row) {
      const card = row.closest('[data-country]');
      if (!card) return;
      toggleSet(state.enabledCountry, card.dataset.country, card);
      const vis = card.querySelector('.vis-toggle');
      if (vis) vis.textContent = card.classList.contains('off') ? '○' : '●';
      propagate(true);
    }
  });

  filtersCountryEl.addEventListener('input', (e) => {
    if (!e.target.classList.contains('expand-q')) return;
    state.expandQuery = e.target.value;
    fillExpandBody(e.target.closest('.filter-card-body'), 'country', state.expandedCountry);
    const el = e.target;
    el.focus();
    el.selectionStart = el.selectionEnd = el.value.length;
  });

  document.querySelectorAll('.filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      document.querySelectorAll('.filter-tab').forEach((t) => {
        const on = t.dataset.mode === mode;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      filtersCatEl.hidden = mode !== 'cat';
      filtersOwnerEl.hidden = mode !== 'owner';
      filtersCountryEl.hidden = mode !== 'country';
      syncBulkToggleUi();
      syncFilterRollupUi();
    });
  });

  $('filter-rollup')?.addEventListener('click', () => {
    document.querySelector('.filters')?.classList.toggle('is-rolled');
    syncFilterRollupUi();
  });

  const bulkToggle = $('bulk-toggle');
  bulkToggle?.addEventListener('click', () => {
    const mode = document.querySelector('.filter-tab.active')?.dataset.mode || 'cat';
    const allOn = filterGroupFullyEnabled(mode);
    setFilterGroup(mode, !allOn);
  });

  const pictureBtn = $('picture-menu-btn');
  const pictureMenu = $('picture-menu');
  pictureBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = pictureMenu.hidden;
    pictureMenu.hidden = !open;
    pictureBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  pictureMenu?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-picture]');
    if (!btn) return;
    state.pictureFilter = btn.dataset.picture;
    syncPictureFilterUi();
    pictureMenu.hidden = true;
    pictureBtn.setAttribute('aria-expanded', 'false');
    track('filter_change', { kind: 'picture', value: state.pictureFilter });
    propagate(true);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.filter-picture-wrap') && pictureMenu && !pictureMenu.hidden) {
      pictureMenu.hidden = true;
      pictureBtn?.setAttribute('aria-expanded', 'false');
    }
  });

  // Keep Extra menu from fighting the globe on first paint; sync labels.
  syncBulkToggleUi();
  syncPictureFilterUi();
  syncFilterRollupUi();
}

/** Select or clear every item in the active filter header. */
function setFilterGroup(mode, enabled) {
  track('filter_change', { kind: mode, bulk: enabled ? 'all' : 'none' });
  if (mode === 'cat') {
    state.enabledCat.clear();
    if (enabled) cats.forEach((c) => state.enabledCat.add(c.id));
    filtersCatEl.querySelectorAll('.filter-btn').forEach((btn) => {
      btn.classList.toggle('off', !state.enabledCat.has(btn.dataset.cat));
    });
  } else if (mode === 'owner') {
    state.enabledOperator.clear();
    if (enabled) operators.forEach((o) => state.enabledOperator.add(o.id));
    renderOperatorFilterList();
  } else if (mode === 'country') {
    state.enabledCountry.clear();
    if (enabled) countries.forEach((c) => state.enabledCountry.add(c.id));
    renderCountryFilterList(state.meta.counts.owner || {});
  }
  syncBulkToggleUi();
  propagate(true);
}

function filterGroupFullyEnabled(mode) {
  if (mode === 'cat') return cats.every((c) => state.enabledCat.has(c.id));
  if (mode === 'owner') return operators.every((o) => state.enabledOperator.has(o.id));
  if (mode === 'country') return countries.every((c) => state.enabledCountry.has(c.id));
  return true;
}

function syncBulkToggleUi() {
  const btn = $('bulk-toggle');
  if (!btn) return;
  const mode = document.querySelector('.filter-tab.active')?.dataset.mode || 'cat';
  const allOn = filterGroupFullyEnabled(mode);
  btn.textContent = allOn ? 'Unselect all' : 'Select all';
  btn.setAttribute('aria-pressed', allOn ? 'true' : 'false');
}

function syncPictureFilterUi() {
  const icon = $('picture-menu-btn');
  document.querySelectorAll('.filter-picture-btn').forEach((b) => {
    const on = b.dataset.picture === state.pictureFilter;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  icon?.classList.toggle('is-filtered', state.pictureFilter !== 'all');
  if (icon) {
    const labels = { all: 'All', yes: 'Has picture', no: 'No picture' };
    icon.title = `Picture filter: ${labels[state.pictureFilter] || 'All'}`;
  }
}

function syncFilterRollupUi() {
  const btn = $('filter-rollup');
  const filters = document.querySelector('.filters');
  if (!btn || !filters) return;
  const rolled = filters.classList.contains('is-rolled');
  const mode = document.querySelector('.filter-tab.active')?.dataset.mode || 'cat';
  const panelId = mode === 'owner' ? 'filters-owner' : mode === 'country' ? 'filters-country' : 'filters-cat';
  const noun = mode === 'owner' ? 'owners' : mode === 'country' ? 'countries' : 'satellite types';
  btn.setAttribute('aria-expanded', rolled ? 'false' : 'true');
  btn.setAttribute('aria-controls', panelId);
  const label = rolled ? `Show ${noun}` : `Hide ${noun}`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function toggleSet(set, id, el) {
  if (set.has(id)) {
    set.delete(id);
    el.classList.add('off');
  } else {
    set.add(id);
    el.classList.remove('off');
  }
  syncBulkToggleUi();
}

function renderOperatorFilterList() {
  const q = state.operatorFilterQ.trim().toLowerCase();
  const list = operators.filter((o) => !q || o.label.toLowerCase().includes(q));
  const prevFocus = document.activeElement?.id === 'op-filter-q';
  const sel = prevFocus ? {
    start: document.activeElement.selectionStart,
    end: document.activeElement.selectionEnd,
  } : null;

  filtersOwnerEl.innerHTML = `
    <input id="op-filter-q" class="filter-mini-search" type="search"
      placeholder="Find owner…" value="${escapeHtml(state.operatorFilterQ)}" />
    ${list.map((o) => {
      const off = state.enabledOperator.has(o.id) ? '' : ' off';
      const open = state.expandedOperator === o.id;
      return `
      <div class="filter-card${off}${open ? ' expanded' : ''}" data-operator="${escapeAttr(o.id)}">
        <div class="filter-card-top">
          <button type="button" class="chevron-btn" title="Show satellites" aria-label="Show satellites" aria-expanded="${open}">
            <span class="chevron" aria-hidden="true">▸</span>
          </button>
          <button type="button" class="filter-card-head" title="${escapeAttr(o.label)}">
            <span class="label-text">${escapeHtml(shortOperator(o.label))}</span>
            <span class="count">${(o.count || 0).toLocaleString()}</span>
          </button>
          <button type="button" class="vis-toggle" title="${off ? 'Show on globe' : 'Hide on globe'}" aria-label="Toggle visibility">${off ? '○' : '●'}</button>
        </div>
        <div class="filter-card-body"></div>
      </div>`;
    }).join('')}
  `;

  if (state.expandedOperator) {
    const card = [...filtersOwnerEl.querySelectorAll('[data-operator]')]
      .find((el) => el.dataset.operator === state.expandedOperator);
    const body = card?.querySelector('.filter-card-body');
    if (body) fillExpandBody(body, 'operator', state.expandedOperator);
  }

  if (prevFocus) {
    const el = $('op-filter-q');
    if (el) {
      el.focus();
      if (sel) el.setSelectionRange(sel.start, sel.end);
    }
  }
}

function renderCountryFilterList(countryCounts) {
  const sorted = [...countries].sort(
    (a, b) => (countryCounts[b.id] || 0) - (countryCounts[a.id] || 0),
  );
  filtersCountryEl.innerHTML = sorted.map((c) => {
    const off = state.enabledCountry.has(c.id) ? '' : ' off';
    const open = state.expandedCountry === c.id;
    return `
    <div class="filter-card${off}${open ? ' expanded' : ''}" data-country="${c.id}">
      <div class="filter-card-top">
        <button type="button" class="chevron-btn" title="Show satellites" aria-label="Show satellites" aria-expanded="${open}">
          <span class="chevron" aria-hidden="true">▸</span>
        </button>
        <button type="button" class="filter-card-head">
          <span class="flag">${c.flag || ''}</span>
          <span class="label-text">${escapeHtml(c.label)}</span>
          <span class="count">${(countryCounts[c.id] || 0).toLocaleString()}</span>
        </button>
        <button type="button" class="vis-toggle" title="${off ? 'Show on globe' : 'Hide on globe'}" aria-label="Toggle visibility">${off ? '○' : '●'}</button>
      </div>
      <div class="filter-card-body"></div>
    </div>`;
  }).join('');

  if (state.expandedCountry) {
    const card = filtersCountryEl.querySelector(`[data-country="${CSS.escape(state.expandedCountry)}"]`);
    const body = card?.querySelector('.filter-card-body');
    if (body) fillExpandBody(body, 'country', state.expandedCountry);
  }
}

async function fillExpandBody(body, kind, id) {
  if (!body || !id) return;
  body.innerHTML = `<p class="expand-more">Loading…</p>`;
  try {
    await ensureBrowseIndex(kind);
  } catch (err) {
    console.error(err);
    body.innerHTML = `<p class="expand-more">Couldn’t load satellite list.</p>`;
    return;
  }
  const bucket = kind === 'operator' ? state.byOperator?.[id] : state.byCountry?.[id];
  if (!bucket) {
    body.innerHTML = `<p class="expand-more">No satellites found.</p>`;
    return;
  }

  const q = state.expandQuery.trim().toLowerCase();
  let rows = bucket.sats;
  if (q) {
    rows = rows.filter((s) =>
      s.name.toLowerCase().includes(q)
      || String(s.norad).includes(q)
      || (s.operator || '').toLowerCase().includes(q));
  }

  const limit = 80;
  const shown = rows.slice(0, limit);
  const catLabel = Object.fromEntries(cats.map((c) => [c.id, c.label]));

  body.innerHTML = `
    <input class="filter-mini-search expand-q" type="search"
      placeholder="Filter satellites…" value="${escapeHtml(state.expandQuery)}" />
    <ul class="expand-list">
      ${shown.map((s) => `
        <li data-norad="${s.norad}">
          <span>${escapeHtml(s.name)}</span>
          <span class="meta-line">${escapeHtml(catLabel[s.cat] || s.cat)} · ${s.norad}</span>
        </li>
      `).join('') || '<li style="cursor:default;color:var(--muted)">No matches</li>'}
    </ul>
    ${rows.length > limit ? `<p class="expand-more">${(rows.length - limit).toLocaleString()} more — narrow the filter</p>` : ''}
  `;
}

async function openBrowse(kind, id) {
  try {
    await ensureBrowseIndex(kind);
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Couldn’t load that satellite list — try again.';
    return;
  }
  const bucket = kind === 'operator' ? state.byOperator?.[id] : state.byCountry?.[id];
  if (!bucket) return;

  state.expandQuery = '';
  if (kind === 'operator') {
    state.expandedOperator = id;
    document.querySelector('.filter-tab[data-mode="owner"]')?.click();
    renderOperatorFilterList();
    queueMicrotask(() => {
      const card = [...filtersOwnerEl.querySelectorAll('[data-operator]')]
        .find((el) => el.dataset.operator === id);
      card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  } else {
    state.expandedCountry = id;
    document.querySelector('.filter-tab[data-mode="country"]')?.click();
    renderCountryFilterList(state.meta.counts.owner || {});
    queueMicrotask(() => {
      filtersCountryEl.querySelector(`[data-country="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
}

function closePanel() {
  setPanelOpen(false);
  stopCoverageUpdates();
  state.selectedIdx = -1;
  state.skyMode = false;
  state.browseKind = null;
  state.browseId = null;
  state.browseQuery = '';
  if (state.imageryToken) state.imageryToken.cancelled = true;
  orbitLine.visible = false;
  // Don't spin a pinned location out of view.
  controls.autoRotate = !state.paused && !state.place;
  propagate(false);
}

function renderPanel(row, dossier) {
  const cat = cats[row[fi.cat]];
  const country = countries[row[fi.owner]];
  const operatorName = row[fi.operator];
  state.browseKind = null;
  state.browseId = null;

  if (state.imageryToken) state.imageryToken.cancelled = true;
  const imageryToken = { cancelled: false };
  state.imageryToken = imageryToken;

  const imgCfg = imageryFor(row[fi.norad], dossier?.constellation);
  const imageSlot = imgCfg ? `<div id="sat-image-slot" class="sat-image-slot"></div>` : '';

  const backBtn = state.place
    ? `<button type="button" class="panel-back" id="panel-back">← Overhead at ${escapeHtml(state.place.name)}</button>`
    : '';
  const look = state.place ? lookAngleAt({
    observer: state.place,
    positions: state.positions,
    index: state.selectedIdx,
    kmToScene: KM_TO_SCENE,
  }) : null;
  const lookLine = look
    ? `<p class="place-coords">${look.elevation > 0
      ? `${look.elevation.toFixed(0)}° above the horizon · ${compass(look.azimuth)} · ${Math.round(look.rangeKm).toLocaleString()} km away`
      : `Below the horizon from ${escapeHtml(state.place.name)} right now`}</p>`
    : '';
  const coverLine = `<p class="place-coords sat-coverage" id="sat-coverage"></p>`;
  const smeta = satmetaFor(row[fi.norad]);

  const opBtn = operatorName
    ? `<button type="button" class="lookup" id="open-op">${escapeHtml(shortOperator(operatorName))}</button>`
    : '';
  const countryBtn = country
    ? `<button type="button" class="lookup" id="open-country">${escapeHtml(country.flag || '')} ${escapeHtml(country.label)}</button>`
    : '';

  if (!dossier) {
    const enrich = enrichmentFor(row[fi.norad]);
    const purposeBlock = enrich
      ? renderEnrichmentPurpose(enrich)
      : `<section class="dossier-block">
          <p class="eyebrow">Purpose</p>
          <p class="dossier-lead">${escapeHtml(cat?.label ? `Catalogued as ${cat.label.toLowerCase()} — no hand-researched mission dossier yet.` : 'No hand-researched mission dossier yet.')}</p>
        </section>`;
    const narrativeBlock = renderNarratives(enrich?.narratives);
    const satnogsBlock = renderSatnogs(smeta?.satnogs);
    const ceosBlock = renderCeos(smeta?.ceos);
    panelBody.innerHTML = `
      ${backBtn}
      <p class="eyebrow">${escapeHtml(cat?.label || 'Satellite')}</p>
      <h2>${escapeHtml(row[fi.name])}</h2>
      <p class="sub">${opBtn} · ${countryBtn}</p>
      ${lookLine}
      ${coverLine}
      ${imageSlot}
      ${purposeBlock}
      ${satnogsBlock}
      ${ceosBlock}
      ${narrativeBlock}
      <div class="cost-grid bare-sat">
        <div class="cost-card"><div class="label">NORAD</div><div class="value">${row[fi.norad]}</div></div>
        <div class="cost-card"><div class="label">Orbit</div><div class="value">${escapeHtml(row[fi.orbit])}</div></div>
        <div class="cost-card"><div class="label">Size</div><div class="value">${escapeHtml(sizeFactLabel(state.lengthM[state.selectedIdx]))}</div></div>
        <div class="cost-card"><div class="label">Perigee</div><div class="value">${row[fi.perigeeKm]} km</div></div>
        <div class="cost-card"><div class="label">Apogee</div><div class="value">${row[fi.apogeeKm]} km</div></div>
        <div class="cost-card wide"><div class="label">Inclination</div><div class="value">${row[fi.incDeg]}°</div></div>
      </div>
      <ul class="facts">
        ${satmetaFactRows(smeta, row)}
      </ul>
      <p class="note">${escapeHtml(sizeScaleNote())} Classification is rule-based from the catalog name.${enrich ? ' Purpose line is from the UCS Satellite Database (auto-joined), not a hand dossier.' : ''} LEO craft move — “currently over” is the live ground track, not a fixed service area.</p>
    `;
    $('open-op')?.addEventListener('click', () => openBrowse('operator', operatorName));
    $('open-country')?.addEventListener('click', () => openBrowse('country', country.id));
    $('panel-back')?.addEventListener('click', () => showSky());
    if (imgCfg) fillLastImage($('sat-image-slot'), imgCfg, { token: imageryToken });
    startCoverageUpdates();
    return;
  }

  const build = dossier.costBuild || {};
  const launch = dossier.costLaunch || {};
  const maint = dossier.maintenance || {};
  const purposeBlock = renderPurpose(dossier.purpose);
  const resultsBlock = renderResults(dossier.results);
  const enrich = enrichmentFor(row[fi.norad]);
  const narrativeBlock = renderNarratives(enrich?.narratives);
  const satnogsBlock = renderSatnogs(smeta?.satnogs);
  const ceosBlock = renderCeos(smeta?.ceos);

  panelBody.innerHTML = `
    ${backBtn}
    <p class="eyebrow">${escapeHtml(dossier.flag || '')} ${escapeHtml(cat?.label || dossier.category)}</p>
    <h2>${escapeHtml(dossier.shortName || dossier.name)}</h2>
    <p class="sub">${opBtn} · ${countryBtn}</p>
    ${lookLine}
    ${coverLine}
    ${imageSlot}

    ${purposeBlock}
    ${resultsBlock}
    ${ceosBlock}
    ${satnogsBlock}
    ${narrativeBlock}

    <p class="eyebrow">Cost</p>
    <div class="cost-grid">
      <div class="cost-card">
        <div class="label">Build</div>
        <div class="value">${escapeHtml(build.display || '—')}</div>
        <div class="conf">${escapeHtml(build.confidence || '')}</div>
      </div>
      <div class="cost-card">
        <div class="label">Launch</div>
        <div class="value">${escapeHtml(launch.display || '—')}</div>
        <div class="conf">${escapeHtml(launch.confidence || '')}</div>
      </div>
      <div class="cost-card wide">
        <div class="label">Upkeep / year</div>
        <div class="value">${escapeHtml(maint.display || '—')}</div>
        <div class="conf">${escapeHtml(maint.confidence || '')}</div>
      </div>
    </div>

    ${build.note ? `<p class="note">${escapeHtml(build.note)}</p>` : ''}
    ${launch.note ? `<p class="note">${escapeHtml(launch.note)}</p>` : ''}
    ${maint.note ? `<p class="note">${escapeHtml(maint.note)}</p>` : ''}

    <ul class="facts">
      <li><span class="k">Built</span><span>${escapeHtml(dossier.built?.text || '—')}</span></li>
      <li><span class="k">Launched</span><span>${escapeHtml((() => { const L = fmtLaunch(dossier.launched); return L !== '—' ? L : (smeta?.launchDate || '—'); })())}</span></li>
      <li><span class="k">Settled</span><span>${escapeHtml(dossier.settled?.text || dossier.settled?.date || '—')}</span></li>
      <li><span class="k">Status</span><span>${escapeHtml(dossier.status || smeta?.opsStatus || '—')}</span></li>
      <li><span class="k">Mass</span><span>${escapeHtml(dossier.mass || '—')}</span></li>
      <li><span class="k">Size</span><span>${escapeHtml(sizeFactLabel(state.lengthM[state.selectedIdx]))}</span></li>
      <li><span class="k">Orbit</span><span>${escapeHtml(dossier.orbitClass || row[fi.orbit])} · ${row[fi.perigeeKm]}–${row[fi.apogeeKm]} km · ${row[fi.incDeg]}°</span></li>
      <li><span class="k">Maker</span><span>${escapeHtml(dossier.manufacturer || '—')}</span></li>
      <li><span class="k">NORAD</span><span>${row[fi.norad]}</span></li>
      <li><span class="k">Owner</span><span>${escapeHtml(operatorName || '—')}</span></li>
      <li><span class="k">Country</span><span>${escapeHtml(country?.flag || '')} ${escapeHtml(country?.label || '—')}</span></li>
      ${satmetaFactRows(smeta, row, { skipLaunchStatus: true })}
    </ul>

    ${dossier.sources?.length ? `
      <p class="eyebrow" style="margin-top:1.25rem">Sources</p>
      <ul class="sources">${dossier.sources.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
    ` : ''}
  `;

  $('open-op')?.addEventListener('click', () => openBrowse('operator', operatorName));
  $('open-country')?.addEventListener('click', () => openBrowse('country', country.id));
  $('panel-back')?.addEventListener('click', () => showSky());
  if (imgCfg) fillLastImage($('sat-image-slot'), imgCfg, { token: imageryToken });
  startCoverageUpdates();
}

function satmetaFactRows(meta, row, { skipLaunchStatus = false } = {}) {
  if (!meta) return '';
  const bits = [];
  if (!skipLaunchStatus && meta.launchDate) {
    bits.push(`<li><span class="k">Launched</span><span>${escapeHtml(meta.launchDate)}${meta.launchSite ? ` · ${escapeHtml(meta.launchSite)}` : ''}</span></li>`);
  } else if (meta.launchSite && !skipLaunchStatus) {
    bits.push(`<li><span class="k">Launch site</span><span>${escapeHtml(meta.launchSite)}</span></li>`);
  }
  if (meta.launchSite && skipLaunchStatus) {
    bits.push(`<li><span class="k">Launch site</span><span>${escapeHtml(meta.launchSite)}</span></li>`);
  }
  if (!skipLaunchStatus && meta.opsStatus) {
    bits.push(`<li><span class="k">Status</span><span>${escapeHtml(meta.opsStatus)}</span></li>`);
  }
  if (meta.objectType) {
    bits.push(`<li><span class="k">Object</span><span>${escapeHtml(meta.objectType)}</span></li>`);
  }
  if (meta.cospar) {
    bits.push(`<li><span class="k">COSPAR</span><span>${escapeHtml(meta.cospar)}</span></li>`);
  }
  if (meta.satcatOwner) {
    bits.push(`<li><span class="k">SATCAT owner</span><span>${escapeHtml(meta.satcatOwner)}</span></li>`);
  }
  if (meta.decayDate) {
    bits.push(`<li><span class="k">Decay</span><span>${escapeHtml(meta.decayDate)}</span></li>`);
  }
  return bits.join('');
}

function renderSatnogs(s) {
  if (!s) return '';
  const chips = [];
  if (s.status) chips.push(`<span class="chip">${escapeHtml(s.status)}</span>`);
  if (s.countries) chips.push(`<span class="chip">${escapeHtml(s.countries)}</span>`);
  const link = s.website
    ? `<div class="dossier-meta"><span class="k">Website</span><span><a class="narrative-link" href="${escapeHtml(s.website)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.website.replace(/^https?:\/\//, '').slice(0, 48))}</a></span></div>`
    : '';
  const names = s.names
    ? `<div class="dossier-meta"><span class="k">Also called</span><span>${escapeHtml(s.names)}</span></div>`
    : '';
  const desc = s.description
    ? `<p class="dossier-lead">${escapeHtml(s.description)}</p>`
    : '';
  if (!desc && !link && !names && !chips.length) return '';
  return `
    <section class="dossier-block">
      <p class="eyebrow">SatNOGS</p>
      ${desc}
      ${chips.length ? `<div class="chip-row">${chips.join('')}</div>` : ''}
      ${names}
      ${link}
    </section>
  `;
}

function renderCeos(c) {
  if (!c?.instruments?.length && !c?.applications) return '';
  const inst = (c.instruments || []).slice(0, 12)
    .map((i) => `<span class="chip">${escapeHtml(i)}</span>`)
    .join('');
  const app = c.applications
    ? `<p class="dossier-lead">${escapeHtml(c.applications)}</p>`
    : '';
  const link = c.url
    ? `<div class="dossier-meta"><span class="k">CEOS MIM</span><span><a class="narrative-link" href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.name || 'Mission page')}</a></span></div>`
    : '';
  return `
    <section class="dossier-block">
      <p class="eyebrow">Instruments</p>
      ${app}
      ${inst ? `<div class="chip-row">${inst}</div>` : ''}
      ${link}
    </section>
  `;
}

function renderPurpose(purpose) {
  if (!purpose?.summary) return '';
  const users = (purpose.users || [])
    .map((u) => `<span class="chip">${escapeHtml(u)}</span>`)
    .join('');
  const metaBits = [];
  if (purpose.instruments?.length) {
    metaBits.push(`<div class="dossier-meta"><span class="k">Instruments</span><span>${escapeHtml(purpose.instruments.join(' · '))}</span></div>`);
  }
  if (purpose.measures?.length) {
    metaBits.push(`<div class="dossier-meta"><span class="k">Measures</span><span>${escapeHtml(purpose.measures.join(' · '))}</span></div>`);
  }
  return `
    <section class="dossier-block">
      <p class="eyebrow">Purpose</p>
      <p class="dossier-lead">${escapeHtml(purpose.summary)}</p>
      ${users ? `<div class="chip-row">${users}</div>` : ''}
      ${metaBits.join('')}
    </section>
`;
}

function renderEnrichmentPurpose(enrich) {
  if (!enrich?.summary) return '';
  const users = (enrich.users || [])
    .map((u) => `<span class="chip">${escapeHtml(u)}</span>`)
    .join('');
  const metaBits = [];
  if (enrich.operator) {
    metaBits.push(`<div class="dossier-meta"><span class="k">UCS operator</span><span>${escapeHtml(enrich.operator)}</span></div>`);
  }
  if (enrich.cospar) {
    metaBits.push(`<div class="dossier-meta"><span class="k">COSPAR</span><span>${escapeHtml(enrich.cospar)}</span></div>`);
  }
  metaBits.push(`<div class="dossier-meta"><span class="k">Source</span><span>UCS Satellite Database (as of ${escapeHtml(enrich.asOf || '2023-05-01')})</span></div>`);
  return `
    <section class="dossier-block">
      <p class="eyebrow">Purpose</p>
      <p class="dossier-lead">${escapeHtml(enrich.summary)}</p>
      ${users ? `<div class="chip-row">${users}</div>` : ''}
      ${metaBits.join('')}
    </section>
  `;
}

function renderNarratives(narratives) {
  if (!narratives?.length) return '';
  const items = narratives.map((n) => {
    const label = n.label || ({
      eoportal: 'ESA eoPortal',
      nssdc: 'NASA NSSDCA',
      gunter: "Gunter’s Space Page",
    }[n.provider] || n.provider);
    const excerpt = n.excerpt
      ? `<p class="narrative-excerpt">${escapeHtml(n.excerpt)}</p>`
      : (n.citeOnly ? `<p class="narrative-excerpt muted">Citation link only — page not scraped.</p>` : '');
    return `<li>
      <a class="narrative-link" href="${escapeHtml(n.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>
      ${excerpt}
    </li>`;
  }).join('');
  return `
    <section class="dossier-block">
      <p class="eyebrow">Mission notes</p>
      <ul class="narrative-list">${items}</ul>
    </section>
  `;
}

function renderResults(results) {
  if (!results) return '';
  const bullets = (results.bullets || []).filter((b) => b?.text);
  const headline = (results.headline || '').trim();
  const stubHeadline = /^results dossier not yet researched/i.test(headline);
  // Hide the section until there is real content — no empty "not yet researched" block.
  if (!bullets.length && (stubHeadline || !headline) && !results.stillDoing) return '';
  const bulletHtml = bullets
    .map((b) => {
      const year = b.year != null ? `<span class="result-year">${b.year}</span>` : '';
      const conf = b.confidence ? `<span class="result-conf">${escapeHtml(b.confidence)}</span>` : '';
      const src = b.source ? `<span class="result-src">${escapeHtml(b.source)}</span>` : '';
      return `<li>
        <div class="result-text">${escapeHtml(b.text)}</div>
        <div class="result-meta">${year}${conf}${src}</div>
      </li>`;
    })
    .join('');
  const still = results.stillDoing
    ? `<p class="note still-doing"><span class="k">Still doing</span> ${escapeHtml(results.stillDoing)}</p>`
    : '';
  const lead = headline && !stubHeadline
    ? `<p class="dossier-lead">${escapeHtml(headline)}</p>`
    : '';
  return `
    <section class="dossier-block">
      <p class="eyebrow">Results</p>
      ${lead}
      ${bulletHtml ? `<ul class="results-list">${bulletHtml}</ul>` : ''}
      ${still}
    </section>
  `;
}

function fmtLaunch(L) {
  if (!L) return '—';
  const bits = [L.date, L.vehicle, L.site].filter(Boolean);
  return bits.join(' · ');
}

function fmtDate(iso) {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll("'", '&#39;');
}

function loadTex(url) {
  return new Promise((resolve, reject) => {
    loader.load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      resolve(t);
    }, undefined, reject);
  });
}

function fetchJson(url) {
  return fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return r.json();
  });
}

/** Owner/country expand indexes are large; fetch only when first needed. */
const browseIndexInflight = { operator: null, country: null };
function ensureBrowseIndex(kind) {
  if (kind === 'operator') {
    if (state.byOperator) return Promise.resolve();
    if (!browseIndexInflight.operator) {
      browseIndexInflight.operator = fetchJson('data/by-operator.json')
        .then((doc) => { state.byOperator = doc.operators; })
        .finally(() => { browseIndexInflight.operator = null; });
    }
    return browseIndexInflight.operator;
  }
  if (state.byCountry) return Promise.resolve();
  if (!browseIndexInflight.country) {
    browseIndexInflight.country = fetchJson('data/by-country.json')
      .then((doc) => { state.byCountry = doc.countries; })
      .finally(() => { browseIndexInflight.country = null; });
  }
  return browseIndexInflight.country;
}
