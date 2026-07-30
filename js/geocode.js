/**
 * Address → coordinates, via OpenStreetMap Nominatim.
 *
 * No API key needed, but the usage policy allows ~1 request/second and asks
 * callers to identify themselves. A browser can't set User-Agent, so the page
 * Referer is what identifies us — fine for local/low traffic, but swap in a
 * keyed geocoder (Mapbox / MapTiler / Google) before this sees real volume.
 */

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const MIN_GAP_MS = 1100;

const cache = new Map();
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
  const url = `${ENDPOINT}?format=jsonv2&limit=${limit}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Geocoder returned ${res.status}`);

  const places = (await res.json()).map(toPlace).filter(Boolean);
  cache.set(key, places);
  return places;
}

export function formatLatLon(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${ns}, ${Math.abs(lon).toFixed(4)}°${ew}`;
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
