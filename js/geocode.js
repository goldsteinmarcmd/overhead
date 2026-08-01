/**
 * Address → coordinates, via OpenStreetMap Nominatim.
 *
 * No API key needed, but the usage policy allows ~1 request/second and asks
 * callers to identify themselves. A browser can't set User-Agent, so the page
 * Referer is what identifies us — fine for local/low traffic, but swap in a
 * keyed geocoder (Mapbox / MapTiler / Google) before this sees real volume.
 */

const SEARCH_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const REVERSE_ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
const MIN_GAP_MS = 1100;

const cache = new Map();
const reverseCache = new Map();
let lastRequestAt = 0;

/** "40.7128, -74.006" typed straight into the box — no round trip needed. */
export function parseLatLon(query) {
  const m = String(query || '').trim()
    .match(/^(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;
  return { name: formatLatLon(lat, lon), context: 'Coordinates', lat, lon, kind: 'coords' };
}

export async function geocode(query, { signal, limit = 6 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];

  const direct = parseLatLon(q);
  if (direct) return [direct];

  const key = q.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  await gap(signal);
  const url = `${SEARCH_ENDPOINT}?format=jsonv2&limit=${limit}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Geocoder returned ${res.status}`);

  const places = (await res.json()).map(toPlace).filter(Boolean);
  cache.set(key, places);
  return places;
}

/**
 * Lat/lon → a short place label for “currently over …”.
 * Cached on ~0.5° bins so panel updates don’t hammer Nominatim.
 */
export async function reverseGeocode(lat, lon, { signal } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const key = `${(Math.round(lat * 2) / 2).toFixed(1)},${(Math.round(lon * 2) / 2).toFixed(1)}`;
  if (reverseCache.has(key)) return reverseCache.get(key);

  await gap(signal);
  const url = `${REVERSE_ENDPOINT}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=6`;
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Reverse geocoder returned ${res.status}`);
  const row = await res.json();
  const label = formatReverseLabel(row, lat, lon);
  reverseCache.set(key, label);
  return label;
}

export function formatLatLon(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${ns}, ${Math.abs(lon).toFixed(4)}°${ew}`;
}

function formatReverseLabel(row, lat, lon) {
  const coords = formatLatLon(lat, lon);
  if (!row || row.error) return coords;
  const a = row.address || {};
  const locality = a.city || a.town || a.village || a.municipality
    || a.county || a.state_district || a.region || a.ocean || a.sea;
  const region = a.state || a.province || a.region || a.country;
  const country = a.country;
  const bits = [];
  if (locality) bits.push(locality);
  if (region && region !== locality) bits.push(region);
  if (country && country !== region && !bits.includes(country)) bits.push(country);
  if (!bits.length) {
    const parts = String(row.display_name || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts.slice(0, 3).join(', ');
    return coords;
  }
  // Prefer “County, State” / “Ocean” style over dumping the full address.
  return bits.slice(0, 3).join(', ');
}

function toPlace(row) {
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const parts = String(row.display_name || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    name: row.name || parts[0] || 'Unnamed place',
    context: (row.name ? parts : parts.slice(1)).join(', '),
    lat,
    lon,
    kind: String(row.type || row.category || '').replaceAll('_', ' '),
  };
}

/** Space requests out to stay inside the Nominatim rate limit. */
async function gap(signal) {
  const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait, signal);
  lastRequestAt = Date.now();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
