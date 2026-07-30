/**
 * Last-known Earth browse imagery via NASA GIBS.
 * Config is keyed by NORAD id (string) or constellation id.
 */

const GIBS_DOMAINS =
  'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/wmts.cgi';
const GIBS_WMS =
  'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';

const MIN_BYTES = 8000;
const MAX_TIME_RETRIES = 6;

/** Shared layer presets */
const MODIS_TERRA = {
  layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
  tileMatrixSet: '250m',
  label: 'MODIS true color',
  credit: 'NASA GIBS / LANCE',
  bbox: [-50, -180, 70, 180],
};
const MODIS_AQUA = {
  layer: 'MODIS_Aqua_CorrectedReflectance_TrueColor',
  tileMatrixSet: '250m',
  label: 'MODIS true color',
  credit: 'NASA GIBS / LANCE',
  bbox: [-50, -180, 70, 180],
};
const HLS_LANDSAT = {
  layer: 'HLS_L30_Nadir_BRDF_Adjusted_Reflectance',
  tileMatrixSet: '30m',
  label: 'HLS Landsat reflectance',
  credit: 'NASA HLS / GIBS',
  bbox: [32, -125, 42, -114],
};
const HLS_S2 = {
  layer: 'HLS_S30_Nadir_BRDF_Adjusted_Reflectance',
  tileMatrixSet: '30m',
  label: 'HLS Sentinel-2 reflectance',
  credit: 'NASA HLS / GIBS',
  bbox: [41, 8, 48, 18],
};
const S1_SAR = {
  layer: 'OPERA_L2_Radiometric_Terrain_Corrected_SAR_Sentinel-1',
  tileMatrixSet: '30m',
  label: 'Sentinel-1 SAR (OPERA RTC)',
  credit: 'NASA OPERA / GIBS',
  bbox: [34, -122, 40, -116],
};
const VIIRS_SNPP = {
  layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
  tileMatrixSet: '250m',
  label: 'VIIRS true color',
  credit: 'NASA / NOAA GIBS',
  bbox: [-50, -180, 70, 180],
};
const VIIRS_N20 = {
  layer: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
  tileMatrixSet: '250m',
  label: 'VIIRS true color',
  credit: 'NASA / NOAA GIBS',
  bbox: [-50, -180, 70, 180],
};
const VIIRS_N21 = {
  layer: 'VIIRS_NOAA21_CorrectedReflectance_TrueColor',
  tileMatrixSet: '250m',
  label: 'VIIRS true color',
  credit: 'NASA / NOAA GIBS',
  bbox: [-50, -180, 70, 180],
};
const GOES_EAST = {
  layer: 'GOES-East_ABI_GeoColor',
  tileMatrixSet: '2km',
  label: 'ABI GeoColor',
  credit: 'NOAA / NASA GIBS',
  bbox: [-60, -130, 60, -30],
};
const GOES_WEST = {
  layer: 'GOES-West_ABI_GeoColor',
  tileMatrixSet: '2km',
  label: 'ABI GeoColor',
  credit: 'NOAA / NASA GIBS',
  bbox: [-60, -180, 60, -90],
};
const HIMAWARI = {
  layer: 'Himawari_AHI_Air_Mass',
  tileMatrixSet: '2km',
  label: 'AHI air mass',
  credit: 'JMA / NASA GIBS',
  bbox: [-50, 90, 50, 180],
};
const PACE_OCI = {
  layer: 'OCI_PACE_True_Color',
  tileMatrixSet: '1km',
  label: 'OCI true color',
  credit: 'NASA PACE / GIBS',
  bbox: [-50, -180, 70, 180],
};
const S3A_OLCI = {
  layer: 'S3A_OLCI_Chlorophyll_a',
  tileMatrixSet: '1km',
  label: 'OLCI chlorophyll-a',
  credit: 'ESA / NASA GIBS',
  bbox: [-50, -180, 70, 180],
};
const S3B_OLCI = {
  layer: 'S3B_OLCI_Chlorophyll_a',
  tileMatrixSet: '1km',
  label: 'OLCI chlorophyll-a',
  credit: 'ESA / NASA GIBS',
  bbox: [-50, -180, 70, 180],
};

/** @type {Record<string, ImageryConfig>} */
export const IMAGERY_BY_KEY = {
  // EOS / Landsat
  '25994': MODIS_TERRA, // Terra
  '27424': MODIS_AQUA, // Aqua
  '39084': HLS_LANDSAT, // Landsat 8
  '49260': HLS_LANDSAT, // Landsat 9

  // Sentinel-1 / 2 / 3
  '39634': S1_SAR, // Sentinel-1A
  '62261': S1_SAR, // Sentinel-1C
  '40697': HLS_S2, // Sentinel-2A
  '42063': HLS_S2, // Sentinel-2B
  '60989': HLS_S2, // Sentinel-2C
  '41335': S3A_OLCI, // Sentinel-3A
  '43437': S3B_OLCI, // Sentinel-3B

  // JPSS
  '37849': VIIRS_SNPP, // Suomi NPP
  '43013': VIIRS_N20, // NOAA-20
  '54234': VIIRS_N21, // NOAA-21

  // GOES-R series (East / West disks)
  '60133': GOES_EAST, // GOES-19 East
  '41866': GOES_WEST, // GOES-16 spare ~105°W
  '51850': GOES_WEST, // GOES-18 West
  '43226': GOES_WEST, // GOES-17 (storage; West disk product)

  // Himawari
  '40267': HIMAWARI, // Himawari-8
  '41836': HIMAWARI, // Himawari-9

  // PACE
  '58928': PACE_OCI,
};

/**
 * @typedef {{
 *   layer: string,
 *   tileMatrixSet: string,
 *   label: string,
 *   credit: string,
 *   bbox: [number, number, number, number],
 * }} ImageryConfig
 */

const timeCache = new Map();

/**
 * @param {string|number|null|undefined} norad
 * @param {string|null|undefined} constellation
 * @returns {ImageryConfig|null}
 */
export function imageryFor(norad, constellation) {
  if (norad != null && IMAGERY_BY_KEY[String(norad)]) {
    return IMAGERY_BY_KEY[String(norad)];
  }
  if (constellation && IMAGERY_BY_KEY[constellation]) {
    return IMAGERY_BY_KEY[constellation];
  }
  return null;
}

/**
 * Parse the latest available time from a GIBS DescribeDomains Domain string.
 * @param {string} domain
 * @returns {string|null}
 */
export function parseLatestDomainTime(domain) {
  if (!domain) return null;
  const periods = domain.split(',');
  const last = periods[periods.length - 1]?.trim();
  if (!last) return null;

  const bits = last.split('/');
  if (bits.length >= 2 && !bits[1].startsWith('P') && !bits[1].startsWith('PT')) {
    return bits[1];
  }
  return bits[0] || null;
}

/**
 * @param {ImageryConfig} cfg
 * @returns {Promise<string|null>}
 */
export async function fetchLatestTime(cfg) {
  const cacheKey = `${cfg.layer}|${cfg.tileMatrixSet}`;
  const cached = timeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 15 * 60 * 1000) {
    return cached.time;
  }

  const url =
    `${GIBS_DOMAINS}?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0` +
    `&LAYER=${encodeURIComponent(cfg.layer)}` +
    `&TILEMATRIXSET=${encodeURIComponent(cfg.tileMatrixSet)}`;

  const xml = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`DescribeDomains ${r.status}`);
    return r.text();
  });

  const m = xml.match(/<Domain>([^<]*)<\/Domain>/);
  const time = m ? parseLatestDomainTime(m[1]) : null;
  if (time) timeCache.set(cacheKey, { time, at: Date.now() });
  return time;
}

/**
 * Step one interval earlier when the newest mosaic is still empty / incomplete.
 * @param {string} time
 */
export function stepBackTime(time) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(time)) {
    const d = new Date(`${time}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  const d = new Date(time.endsWith('Z') || time.includes('+') ? time : `${time}Z`);
  if (Number.isNaN(d.getTime())) return time;
  d.setUTCHours(d.getUTCHours() - 1);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Resolve a browse frame with enough bytes (skips incomplete “latest” days).
 * @param {ImageryConfig} cfg
 * @returns {Promise<{ time: string, url: string, objectUrl: string }>}
 */
export async function resolveBrowse(cfg) {
  let time = await fetchLatestTime(cfg);
  if (!time) throw new Error('No time domain');

  let lastErr;
  for (let i = 0; i < MAX_TIME_RETRIES; i++) {
    const url = browseUrl(cfg, time);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GetMap ${res.status}`);
      const blob = await res.blob();
      if (blob.size >= MIN_BYTES) {
        return { time, url, objectUrl: URL.createObjectURL(blob) };
      }
    } catch (err) {
      lastErr = err;
    }
    time = stepBackTime(time);
  }
  throw lastErr || new Error('No usable browse frame');
}

/**
 * WMS 1.3.0 GetMap URL (EPSG:4326 bbox is lat_min,lon_min,lat_max,lon_max).
 * @param {ImageryConfig} cfg
 * @param {string} time
 */
export function browseUrl(cfg, time) {
  const [miny, minx, maxy, maxx] = cfg.bbox;
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: cfg.layer,
    CRS: 'EPSG:4326',
    BBOX: `${miny},${minx},${maxy},${maxx}`,
    WIDTH: '720',
    HEIGHT: '405',
    FORMAT: 'image/jpeg',
    TIME: time,
  });
  return `${GIBS_WMS}?${params.toString()}`;
}

/**
 * @param {string} time
 */
export function formatCaptureTime(time) {
  if (!time) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(time)) {
    return `${time} 00:00 UTC`;
  }
  const d = new Date(time.endsWith('Z') || time.includes('+') ? time : `${time}Z`);
  if (Number.isNaN(d.getTime())) return time;
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

/**
 * @param {HTMLElement} host
 * @param {ImageryConfig} cfg
 * @param {{ token?: { cancelled?: boolean } }} [opts]
 */
export async function fillLastImage(host, cfg, opts = {}) {
  const token = opts.token || {};
  host.innerHTML = `
    <p class="eyebrow">Last known image</p>
    <div class="sat-image is-loading">
      <div class="sat-image-frame">
        <span class="sat-image-status">Fetching latest frame…</span>
      </div>
    </div>
  `;

  let objectUrl = null;
  try {
    const browse = await resolveBrowse(cfg);
    if (token.cancelled) {
      URL.revokeObjectURL(browse.objectUrl);
      return;
    }
    objectUrl = browse.objectUrl;
    const stamp = formatCaptureTime(browse.time);

    host.innerHTML = `
      <p class="eyebrow">Last known image</p>
      <figure class="sat-image">
        <div class="sat-image-frame">
          <img alt="${escapeAttr(cfg.label)}" />
          <span class="sat-image-status">Loading image…</span>
        </div>
        <figcaption>
          <span class="sat-image-when">${escapeHtml(stamp)}</span>
          <span class="sat-image-meta">${escapeHtml(cfg.label)} · ${escapeHtml(cfg.credit)}</span>
        </figcaption>
      </figure>
    `;

    const img = host.querySelector('img');
    const status = host.querySelector('.sat-image-status');
    const frame = host.querySelector('.sat-image-frame');

    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Image failed'));
      img.src = objectUrl;
    });

    if (token.cancelled) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    status?.remove();
    frame?.classList.add('is-ready');
  } catch (err) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (token.cancelled) return;
    host.innerHTML = `
      <p class="eyebrow">Last known image</p>
      <div class="sat-image sat-image-error">
        <p class="note">Couldn’t load the latest browse frame from NASA GIBS.</p>
      </div>
    `;
    console.warn('imagery', cfg.layer, err);
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
